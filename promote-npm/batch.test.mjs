import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INSIDER} from './engine.mjs';
import {parseBatch,runBatch} from './batch.mjs';

const h=(x)=>'sha512-'+createHash('sha512').update(x).digest('base64');
const manifest={schema:1,batchId:'sdk-cohort-1',sourceRegistry:INSIDER,packages:[
  {name:'@synthetic/cli',version:'1.0.0-rc.1',integrity:h('cli'),tag:'rc'},
  {name:'@synthetic/collab',version:'2.0.0-rc.1',integrity:h('collab'),tag:'rc'}
]};
const env={BASE_BRANCH:'main',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'example/example',
  GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'example/example/.github/workflows/promote-cli-public.yml@refs/heads/main',
  ACTIONS_ID_TOKEN_REQUEST_URL:'https://example.invalid',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic'};
const raw=JSON.stringify(manifest);
const entries=manifest.packages.toReversed().map(({name,version})=>({name,version,publicVersion:'publish'}));
const exact={status:'completed',dryRun:true,publicRegistryWriteVerified:false,packageCount:2,packages:entries};
async function setup(t) {
  const directory=await mkdtemp(join(tmpdir(),'batch-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const steps=[], saved=[];
  return {directory,steps,saved,deps:{
    plan:async ({packages})=>{steps.push('plan');assert.deepEqual(packages,manifest.packages.map(({name,version})=>({name,version})));return exact;},
    prepare:async ({packageName,batchPlan,targetTag})=>{steps.push('prepare '+packageName);assert.equal(targetTag,'rc');
      assert.equal(batchPlan.packages[0].name,packageName);return {integrity:manifest.packages.find(x=>x.name===packageName).integrity};},
    publish:async ({packageName})=>{steps.push('submit '+packageName);return {action:'submitted'};},
    save:async r=>saved.push(structuredClone(r))
  }};
}
test('single cohort plans and validates both artifacts before dependency-order writes',async t=>{
  const f=await setup(t);
  const report=await runBatch({...f,raw,mode:'submit',env});
  assert.deepEqual(f.steps,['plan','prepare @synthetic/collab','prepare @synthetic/cli','submit @synthetic/collab','submit @synthetic/cli']);
  assert.equal(report.phase,'submission_complete');assert.ok(report.packages.every(p=>p.status==='submitted'));
});
test('missing admission and wrong second digest cause zero submissions',async t=>{
  const f=await setup(t);
  await assert.rejects(runBatch({...f,raw,mode:'submit',env:{}}),/manual dispatch/);
  assert.deepEqual(f.steps,[]);
  const prepare=f.deps.prepare;
  f.deps.prepare=async opts=>{const r=await prepare(opts);return opts.packageName.endsWith('/cli')?{integrity:h('wrong')}:r;};
  await assert.rejects(runBatch({...f,raw,mode:'submit',env}),/digest|integrity/);
  assert.deepEqual(f.steps,['plan','prepare @synthetic/collab','prepare @synthetic/cli']);
  assert.equal(f.saved.at(-1).phase,'validation_failed');
});
test('submit failure preserves prior outcomes; validation-only does not submit',async t=>{
  const f=await setup(t);
  assert.equal((await runBatch({...f,raw})).phase,'validated');
  assert.equal(f.steps.filter(x=>x.startsWith('submit')).length,0);
  const publish=f.deps.publish;
  f.deps.publish=async opts=>{if(opts.packageName.endsWith('/cli'))throw Error('uncertain');return publish(opts);};
  await assert.rejects(runBatch({...f,raw,mode:'submit',env}),/uncertain/);
  assert.equal(f.saved.at(-1).phase,'incomplete');
  assert.deepEqual(f.saved.at(-1).packages.map(p=>p.status),['failed_or_unknown','submitted']);
});
test('rejects duplicate package, extra member, and wrong source registry',async t=>{
  assert.throws(()=>parseBatch(JSON.stringify({...manifest,packages:[manifest.packages[0],manifest.packages[0]]})),/Duplicate/);
  assert.throws(()=>parseBatch(JSON.stringify({...manifest,sourceRegistry:'https://example.com/'})),/Invalid/);
  const f=await setup(t);f.deps.plan=async()=>({...exact,packages:[entries[0],{...entries[1],name:'unexpected'}]});
  await assert.rejects(runBatch({...f,raw,mode:'submit',env}),/plan mismatch/);
  assert.equal(f.steps.length,0);
});
test('selection needs names and versions only, records both computed digests, and submits the prepared paths',async t=>{
  const f=await setup(t);
  const selection=JSON.stringify({packages:manifest.packages.map(({name,version,tag})=>({name,version,tag}))});
  const prepared=new Map();
  const prepare=f.deps.prepare, publish=f.deps.publish;
  f.deps.prepare=async opts=>{prepared.set(opts.packageName,opts.directory);return prepare(opts);};
  f.deps.publish=async opts=>{assert.equal(opts.directory,prepared.get(opts.packageName));return publish(opts);};
  await assert.rejects(runBatch({...f,raw:selection,selection:true,allowedPackages:'@synthetic/cli',mode:'submit',env}),/caller scope/);
  assert.equal(f.steps.length,0);
  const out=await runBatch({...f,raw:selection,selection:true,allowedPackages:'@synthetic/cli,@synthetic/collab',mode:'submit',env});
  assert.deepEqual(out.packages.map(p=>p.integrity),manifest.packages.map(p=>p.integrity));
  assert.deepEqual(f.steps,['plan','prepare @synthetic/collab','prepare @synthetic/cli','submit @synthetic/collab','submit @synthetic/cli']);
  assert.equal(parseBatch('{"packages":[{"name":"workspace-demo","version":"1.0.0"}]}',{selection:true}).packages[0].tag,'latest');
});
