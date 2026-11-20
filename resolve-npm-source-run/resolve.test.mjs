import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolveRun} from './resolve.mjs';

const repository='example/producer', runId='42', commit='a'.repeat(40);
const ref='refs/heads/main', workflow='.github/workflows/release.yml';
const home='https://api.github.com/repos/'+repository+'/actions';
const token='fixture-private-read-token', attempt=2;
const hash='sha512-'+Buffer.alloc(64,1).toString('base64');
const producer=JSON.stringify({repository,repositoryId:3,workflow,event:'workflow_dispatch',ref,publishJob:'publish',
  packages:[{name:'example-cli',tag:'promoted'}]});
const receipt={schema:1,repo:repository,runId:42,attempt,ref,commit,
  packages:[{name:'example-cli',version:'1.2.3',integrity:hash}]};
const repo={id:3,full_name:repository};
const run={id:42,run_attempt:attempt,head_sha:commit,head_branch:'main',repository:repo,head_repository:repo,
  path:workflow,event:'workflow_dispatch',status:'completed',conclusion:'success'};
const job={name:'publish',run_attempt:attempt,status:'completed',conclusion:'success',
  started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:10:00Z'};
const target='https://productionresultssa2.blob.core.windows.net/archive/path?example=signed';
const options={repository,runId,producer,token};

function fixture(overrides={}) {
  const archive=spawnSync('python3',['-I','-c',`import sys,zipfile,io
b=io.BytesIO()
with zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:
 z.writestr(sys.argv[1],sys.stdin.buffer.read())
sys.stdout.buffer.write(b.getvalue())
`,overrides.filename??'insider-receipt.json'],{input:JSON.stringify({...receipt,...overrides.receipt})});
  assert.equal(archive.status,0);
  const zip=archive.stdout;
  const artifact={id:51,name:'insider-release-v1-2',expired:false,expires_at:'2026-01-02T00:00:00Z',
    created_at:'2026-01-01T00:09:00Z',size_in_bytes:zip.length,
    digest:'sha256:'+createHash('sha256').update(zip).digest('hex'),
    workflow_run:{id:42,repository_id:3,head_repository_id:3,head_sha:commit,head_branch:'main'},...overrides.artifact};
  const calls=[];
  const json=value=>Response.json(value);
  const fetcher=async(url,init)=>{
    calls.push(url);
    assert.equal(init.redirect,'manual');
    if(url.startsWith(home)) assert.equal(init.headers.authorization,'Bearer '+token);
    switch(url){
      case home+'/runs/42':
        return json({...run,...overrides.latest,...(calls.length>1?overrides.race:{})});
      case home+'/runs/42/attempts/2':
        return json({...run,...overrides.attempt});
      case home+'/runs/42/attempts/2/jobs?per_page=100':
        return json({jobs:[{...job,...overrides.job}],total_count:1});
      case home+'/runs/42/artifacts?per_page=100&name=insider-release-v1-2':
        return json(overrides.list??{artifacts:[artifact],total_count:1});
      case home+'/artifacts/51/zip':
        return new Response(null,{status:302,headers:{location:overrides.target??target}});
      case target:
        assert.equal(init.headers,undefined);
        return new Response(overrides.corrupt?Buffer.alloc(zip.length):zip);
      default:
        throw Error('Unexpected request');
    }
  };
  return {calls, run:(args=options)=>resolveRun(args,{fetcher,now:Date.parse('2026-01-01T01:00:00Z')})};
}

test('reads only the newest verified attempt and emits exact batch; API token does not reach storage',async()=>{
  const {run,calls}=fixture();
  const result=await run();
  assert.equal(result.attempt,2);
  assert.deepEqual(result.batch.packages,[{...receipt.packages[0],tag:'promoted'}]);
  assert.equal(calls.at(-1),home+'/runs/42');
  assert.equal(calls.length,7);
});

for(const [label, latest] of Object.entries({failed:{conclusion:'failure'}, cancelled:{conclusion:'cancelled'},
  waiting:{status:'queued',conclusion:null}, running:{status:'in_progress',conclusion:null}})){
  test('rejects '+label+' latest attempt without searching for earlier success',async()=>{
    const f=fixture({latest});
    await assert.rejects(f.run(),/not completed successfully/);
    assert.deepEqual(f.calls,[home+'/runs/42']);
  });
}

for(const [name,overrides,error] of [
  ['untrusted workflow', {latest:{path:'.github/workflows/other.yml'}}, /trusted producer/],
  ['wrong head repository', {latest:{head_repository:{id:4,full_name:repository}}}, /trusted producer/],
  ['wrong revision', {attempt:{head_sha:'b'.repeat(40)}}, /attempt changed/],
  ['skipped producer job', {job:{conclusion:'skipped'}}, /publish job/],
  ['job not run in this attempt', {job:{run_attempt:1}}, /publish job/],
  ['missing receipt', {list:{artifacts:[],total_count:0}}, /one current source receipt/],
  ['nonunique receipt', {list:{artifacts:[],total_count:2}}, /one current source receipt/],
  ['expired receipt', {artifact:{expired:true}}, /one current source receipt/],
  ['receipt from earlier job time', {artifact:{created_at:'2025-01-01T00:00:00Z'}}, /one current source receipt/],
  ['mismatched artifact provenance', {artifact:{workflow_run:{id:41}}}, /one current source receipt/],
  ['untrusted alternate storage', {target:'https://example.com/zip'}, /storage origin/],
  ['modified ZIP', {corrupt:true}, /archive digest mismatch/],
  ['wrong ZIP entry', {filename:'../insider-receipt.json'}, /Invalid receipt ZIP/],
  ['earlier receipt inside matching archive', {receipt:{attempt:1}}, /Receipt does not match/],
  ['unapproved package', {receipt:{packages:[{name:'other-cli',version:'1.2.3',integrity:hash}]}}, /unapproved package/],
  ['invalid package digest', {receipt:{packages:[{name:'example-cli',version:'1.2.3',integrity:'sha512-nope'}]}}, /invalid integrity/],
  ['coerced digest array', {receipt:{packages:[{name:'example-cli',version:'1.2.3',integrity:[hash]}]}}, /Invalid receipt package/],
  ['new attempt during resolution', {race:{run_attempt:3}}, /attempt changed during verification/],
]){
  test('rejects '+name,async()=>await assert.rejects(fixture(overrides).run(),error));
}

test('does not send a token to a repository absent from the reviewed policy',async()=>{
  const f=fixture();
  await assert.rejects(f.run({...options,repository:'example/other'}),/not allowed/);
  assert.deepEqual(f.calls,[]);
});
