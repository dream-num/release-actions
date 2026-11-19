import {mkdir, writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertPublishContext, INSIDER, planPromotion, preparePromotion, publishPromotion, validatePackageName, validateVersion} from './engine.mjs';

const validHash = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const tags = new Set(['latest','beta','rc','promoted']);
export function parseBatch(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw)>128*1024) throw Error('Batch manifest missing or too large');
  const m=JSON.parse(raw);
  if (m?.schema !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(m.batchId ?? '') || m.sourceRegistry !== INSIDER ||
      !Array.isArray(m.packages) || m.packages.length<1 || m.packages.length>100 ||
      Object.keys(m).some(k=>!['schema','batchId','sourceRegistry','packages'].includes(k))) throw Error('Invalid batch manifest');
  const names=new Set();
  for (const p of m.packages) {
    if (!p || Object.keys(p).some(k=>!['name','version','integrity','tag'].includes(k))) throw Error('Invalid batch package');
    validatePackageName(p.name); validateVersion(p.version);
    if(names.has(p.name) || !validHash.test(p.integrity ?? '') || !tags.has(p.tag) ||
       (p.tag==='latest' && /[-+]/u.test(p.version))) throw Error('Duplicate package, invalid integrity, or invalid tag/version');
    names.add(p.name);
  }
  return m;
}
export async function runBatch({ raw, mode='validate', directory, env=process.env, deps={}, allowedPackages='' }) {
  const m=parseBatch(raw);
  if (allowedPackages) {
    const allowed=new Set(allowedPackages.split(',').map(x=>validatePackageName(x.trim())));
    if (m.packages.some(p=>!allowed.has(p.name))) throw Error('Package outside the configured caller scope');
  }
  if (!['validate','submit'].includes(mode)) throw Error('Invalid batch mode');
  if (mode==='submit') assertPublishContext(env);
  const { plan=planPromotion, prepare=preparePromotion, publish=publishPromotion,
    save=async (report)=>writeFile(join(directory,'batch-result.json'),JSON.stringify(report,null,2)+'\n') }=deps;
  await mkdir(directory,{recursive:true});
  const report={batchId:m.batchId,mode,phase:'validating',packages:m.packages.map(p=>({...p,status:'not_attempted'}))};
  await save(report);
  const options=[];
  try {
    // One registry plan covers the complete dependency cohort; separate one-package dry-runs do not.
    const p=await plan({packages:m.packages.map(({name,version})=>({name,version})),env});
    if(p?.status!=='completed'||p.dryRun!==true||p.publicRegistryWriteVerified!==false||
       p.packageCount!==m.packages.length||!Array.isArray(p.packages)||p.packages.length!==m.packages.length) throw Error('Batch dry-run did not return an exact plan');
    const requested=new Map(m.packages.map((x,i)=>[x.name,{x,i}]));
    const seen=new Set();
    for (let position=0;position<p.packages.length;position++) {
      const entry=p.packages[position], target=requested.get(entry?.name);
      if(!target||seen.has(entry.name)||entry.version!==target.x.version||!['publish','reuse'].includes(entry.publicVersion)) throw Error('Batch dry-run plan mismatch');
      seen.add(entry.name);
      options.push({i:target.i,opts:{packageName:target.x.name,version:target.x.version,latest:target.x.tag==='latest',
        targetTag:target.x.tag,directory:join(directory,'package-'+position),env,
        batchPlan:{...p,packageCount:1,packages:[entry]}}});
    }
    // Every manifest and every tarball is checked before first write; the server order is used to submit.
    for (const {i,opts} of options) {
      const record=await prepare(opts);
      if(record.integrity!==m.packages[i].integrity) throw Error('Batch artifact integrity mismatch');
      report.packages[i].status='validated';
    }
  } catch(error) {
    report.phase='validation_failed'; await save(report); throw error;
  }
  report.phase=mode==='validate'?'validated':'submitting';
  await save(report);
  if (mode==='validate') return report;
  for (const {i,opts} of options) {
    report.packages[i].status='attempting'; await save(report);
    try {
      const result=await publish(opts);
      report.packages[i].status=result.action;
      report.packages[i].tagUpdated=result.tagUpdated;
    } catch(error) {
      report.packages[i].status='failed_or_unknown'; report.phase='incomplete';
      await save(report); throw error;
    }
    await save(report);
  }
  report.phase='submission_complete'; await save(report); return report;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const result=await runBatch({raw:process.env.ACTION_BATCH,allowedPackages:process.env.ACTION_ALLOWED_PACKAGES,mode:process.env.ACTION_MODE,directory:resolve('.promotion','batch')});
    console.log(JSON.stringify(result));
  } catch(error) {console.error(error.message); process.exitCode=1;}
}
