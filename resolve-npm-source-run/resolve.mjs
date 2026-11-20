import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseBatch} from '../promote-npm/batch.mjs';
import {INSIDER,validatePackageName} from '../promote-npm/engine.mjs';

const api = 'https://api.github.com';
const receiptLimit = 64 * 1024;
const safeID = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u;
const sha = /^[a-f0-9]{40}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const hash = data => 'sha256:' + createHash('sha256').update(data).digest('hex');
const require = (ok, message) => { if (!ok) throw Error(message); };
const keysAre = (value, keys) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

async function body(response, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    require(bytes <= limit,'GitHub response is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readReceipt(zip) {
  const child = spawnSync('python3', ['-I',fileURLToPath(new URL('./read-receipt.py',import.meta.url))], {
    input:zip, encoding:'utf8', maxBuffer:receiptLimit, timeout:5000, stdio:['pipe','pipe','ignore'],
    env:{PATH:process.env.PATH},
  });
  require(child.status === 0,'Invalid receipt ZIP');
  try { return JSON.parse(child.stdout); } catch { throw Error('Invalid receipt JSON'); }
}

export async function resolveRun({repository, runId, producer, token}, {fetcher=fetch, now=Date.now()}={}) {
  require(typeof repository === 'string' && repositoryPattern.test(repository) && !/\/(?:\.|\.\.)$/u.test(repository) && repository.length <= 150 &&
    typeof runId === 'string' && /^[1-9][0-9]*$/u.test(runId) && safeID(Number(runId)), 'Invalid source repository or run ID');
  require(typeof producer === 'string' && Buffer.byteLength(producer) <= 32 * 1024,'Invalid producer policy');
  let p;
  try { p = JSON.parse(producer); } catch { throw Error('Invalid producer policy JSON'); }
  require(keysAre(p,['repository','repositoryId','workflow','event','ref','publishJob','packages']) &&
    p.repository === repository && safeID(p.repositoryId) &&
    typeof p.workflow === 'string' && /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u.test(p.workflow) &&
    ['workflow_dispatch','push','release'].includes(p.event) &&
    typeof p.ref === 'string' && /^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/u.test(p.ref) &&
    typeof p.publishJob === 'string' && p.publishJob.length > 0 && p.publishJob.length <= 128 &&
    Array.isArray(p.packages) && p.packages.length >= 1 && p.packages.length <= 100,
    'Source repository is not allowed by caller policy');
  const packages = new Map();
  for (const entry of p.packages) {
    require(keysAre(entry,['name','tag']) && !packages.has(entry.name) &&
      ['latest','beta','rc','promoted'].includes(entry.tag), 'Invalid producer package policy');
    validatePackageName(entry.name);
    packages.set(entry.name,entry.tag);
  }
  const base = '/repos/' + repository + '/actions/runs/' + runId;
  const headers = {accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',
    ...(token ? {authorization:'Bearer '+token} : {})};
  async function request(url, options) {
    try { return await fetcher(url,{...options,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10000)}); }
    catch { throw Error('GitHub source request failed'); }
  }
  async function json(path) {
    const result = await request(api + path,{headers});
    require(result.status === 200,'GitHub source API did not return the requested record');
    const bytes = await body(result,1024*1024);
    try { return JSON.parse(bytes); } catch { throw Error('Invalid GitHub source metadata'); }
  }
  function identity(run) {
    require(run?.id === Number(runId) && safeID(run.run_attempt) &&
      run.repository?.id === p.repositoryId && run.repository.full_name === repository &&
      run.head_repository?.id === p.repositoryId && run.head_repository.full_name === repository &&
      run.path === p.workflow && run.event === p.event &&
      run.head_branch === p.ref.replace(/^refs\/(heads|tags)\//u,'') &&
      typeof run.head_sha === 'string' && sha.test(run.head_sha),
      'Source run does not match the trusted producer');
    require(run.status === 'completed' && run.conclusion === 'success','Latest source attempt is not completed successfully');
    return run;
  }
  const latest = identity(await json(base));
  const attempt = latest.run_attempt;
  const exact = identity(await json(base+'/attempts/'+attempt));
  require(exact.run_attempt === attempt && exact.head_sha === latest.head_sha,'Source attempt changed');
  const jobs = await json(base+'/attempts/'+attempt+'/jobs?per_page=100');
  require(Array.isArray(jobs?.jobs) && jobs.jobs.length === jobs.total_count,'Source job list is incomplete');
  const matches = jobs.jobs.filter(j => j.name === p.publishJob);
  require(matches.length === 1 && matches[0].run_attempt === attempt && matches[0].status === 'completed' &&
    matches[0].conclusion === 'success' && validDate(matches[0].started_at) && validDate(matches[0].completed_at),
    'Source publish job is not confirmed successful in the latest attempt');
  const job = matches[0];
  const name = 'insider-release-v1-' + attempt;
  const result = await json(base+'/artifacts?per_page=100&name='+name);
  const artifact = result?.artifacts?.[0];
  require(result?.total_count === 1 && Array.isArray(result.artifacts) && result.artifacts.length === 1 &&
    artifact?.name === name && safeID(artifact.id) && artifact.expired === false &&
    validDate(artifact.expires_at) && Date.parse(artifact.expires_at) > now &&
    validDate(artifact.created_at) && Date.parse(artifact.created_at) >= Date.parse(job.started_at) &&
    Date.parse(artifact.created_at) <= Date.parse(job.completed_at) &&
    safeID(artifact.size_in_bytes) && artifact.size_in_bytes <= receiptLimit &&
    typeof artifact.digest === 'string' && digestPattern.test(artifact.digest) &&
    artifact.workflow_run?.id === Number(runId) && artifact.workflow_run.repository_id === p.repositoryId &&
    artifact.workflow_run.head_repository_id === p.repositoryId && artifact.workflow_run.head_sha === exact.head_sha &&
    artifact.workflow_run.head_branch === exact.head_branch,
    'Expected one current source receipt with verified artifact identity');
  const response = await request(api+'/repos/'+repository+'/actions/artifacts/'+artifact.id+'/zip',{headers});
  require(response.status === 302,'GitHub did not return a receipt download URL');
  let location;
  try { location = new URL(response.headers.get('location')); } catch { throw Error('Invalid receipt download URL'); }
  require(location.protocol === 'https:' && !location.username && !location.password && !location.hash && !location.port &&
    /^(?:[a-z0-9]+\.blob\.core\.windows\.net|[a-z0-9-]+\.actions\.githubusercontent\.com)$/u.test(location.hostname),
    'Untrusted receipt storage origin');
  // GitHub's signed storage URL needs neither the API token nor any npm credential.
  const download = await request(location.href,{});
  require(download.status === 200,'Receipt download failed');
  const zip = await body(download,receiptLimit);
  require(zip.length === artifact.size_in_bytes && hash(zip) === artifact.digest,'Receipt archive digest mismatch');
  const receipt = readReceipt(zip);
  require(keysAre(receipt,['schema','repo','runId','attempt','ref','commit','packages']) &&
    receipt.schema === 1 && receipt.repo === repository && receipt.runId === Number(runId) &&
    receipt.attempt === attempt && receipt.ref === p.ref && receipt.commit === exact.head_sha &&
    Array.isArray(receipt.packages) && receipt.packages.length > 0 && receipt.packages.length <= packages.size,
    'Receipt does not match the latest successful source attempt');
  const batch = parseBatch(JSON.stringify({schema:1,batchId:`gh-${p.repositoryId}-${runId}-${attempt}`,sourceRegistry:INSIDER,
    packages:receipt.packages.map(item => {
      require(keysAre(item,['name','version','integrity']) && packages.has(item.name),'Receipt contains an unapproved package');
      require(typeof item.version === 'string' && typeof item.integrity === 'string','Invalid receipt package version or integrity');
      return {...item,tag:packages.get(item.name)};
    })}));
  const current = identity(await json(base));
  require(current.run_attempt === attempt && current.head_sha === exact.head_sha,'Source attempt changed during verification');
  return {batch,attempt};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {batch,attempt} = await resolveRun({repository:process.env.SOURCE_REPOSITORY,runId:process.env.SOURCE_RUN_ID,
      producer:process.env.SOURCE_PRODUCER,token:process.env.SOURCE_ACTIONS_TOKEN});
    await appendFile(process.env.GITHUB_OUTPUT,'batch='+JSON.stringify(batch)+'\nattempt='+attempt+'\n');
  } catch (error) {
    // HTTP headers, bodies and signed download URLs are never emitted.
    console.error(error.message);
    process.exitCode = 1;
  }
}
