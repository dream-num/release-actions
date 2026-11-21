import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolveRun} from './resolve.mjs';

const repository='example/producer', runId='42', commit='a'.repeat(40);
const ref='refs/heads/main', workflow='.github/workflows/release.yml';
const root='https://api.github.com/repos/'+repository;
const home=root+'/actions';
const workflowId=17, workflowUrl=home+'/workflows/release.yml';
const token='fixture-private-read-token', attempt=2;
const hash='sha512-'+Buffer.alloc(64,1).toString('base64');
const producer=JSON.stringify({repository,workflow,event:'workflow_dispatch',ref,publishJob:'publish',
  packages:[{name:'example-cli',tag:'promoted'}]});
const receipt={schema:1,repo:repository,runId:42,attempt,ref,commit,
  packages:[{name:'example-cli',version:'1.2.3',integrity:hash}]};
const repo={id:3,full_name:repository};
const repositoryRecord={...repo,owner:{login:'example',id:9}};
const workflowRecord={id:workflowId,path:workflow};
const run={id:42,run_attempt:attempt,head_sha:commit,head_branch:'main',repository:repo,head_repository:repo,
  path:workflow,workflow_id:workflowId,event:'workflow_dispatch',status:'completed',conclusion:'success'};
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
  const expectedBranch=overrides.headBranch??'main';
  const source={...run,head_branch:expectedBranch};
  const artifact={id:51,name:'insider-release-v1-2',expired:false,expires_at:'2026-01-02T00:00:00Z',
    created_at:'2026-01-01T00:09:00Z',size_in_bytes:zip.length,
    digest:'sha256:'+createHash('sha256').update(zip).digest('hex'),
    workflow_run:{id:42,repository_id:3,head_repository_id:3,head_sha:commit,head_branch:expectedBranch},...overrides.artifact};
  const calls=[];
  let latestReads=0, repositories=0, workflows=0;
  let refs=0, lists=0;
  const json=value=>Response.json(value);
  const fetcher=async(url,init)=>{
    calls.push(url);
    assert.equal(init.redirect,'manual');
    if(url===root || url.startsWith(root+'/')) assert.equal(init.headers.authorization,'Bearer '+token);
    if(url===root) {
      if(overrides.repositoryRedirect) return new Response(null,{status:301,headers:{location:'https://api.github.com/repos/renamed/producer'}});
      return json({...repositoryRecord,...overrides.repository,...(++repositories>1?overrides.repositoryRace:{})});
    }
    if(url===workflowUrl)
      return json({...workflowRecord,...overrides.workflow,...(++workflows>1?overrides.workflowRace:{})});
    if(overrides.tagMode){
      const tag='v1.2.3', tagObject='c'.repeat(40);
      const ref=overrides.lightweight?{type:'commit',sha:commit}:{type:'tag',sha:tagObject};
      const normal={...source,created_at:'2026-01-01T00:00:00Z'};
      const newer={...normal,id:43,created_at:'2026-01-01T00:01:00Z',...overrides.newer};
      if(url===root+'/git/ref/tags/'+tag)
        return json({ref:'refs/tags/'+tag,object:++refs>1&&overrides.retag?{...ref,sha:'d'.repeat(40)}:ref});
      if(url===root+'/git/tags/'+tagObject)
        return json({tag,sha:tagObject,object:{type:'commit',sha:commit}});
      if(url===home+'/workflows/'+workflowId+'/runs?head_sha='+commit+'&event=workflow_dispatch&per_page=100'){
        const branch={...newer,head_branch:'main',id:44};
        const records=overrides.newer?[branch,normal,newer]:[branch,normal];
        if(++lists>1&&overrides.raceTag)records.push({...newer,id:45,created_at:'2026-01-01T00:03:00Z'});
        return json({total_count:overrides.incomplete?101:records.length,workflow_runs:records});
      }
      if(url===home+'/runs/43/attempts/2/jobs?per_page=100'){
        const jobs=overrides.newJobs??[];
        return json({jobs,total_count:jobs.length});
      }
      if(url===home+'/runs/43')return json(newer);
    }
    switch(url){
      case home+'/runs/42':
        return json({...source,...overrides.latest,...(++latestReads>1?overrides.race:{})});
      case home+'/runs/42/attempts/2':
        return json({...source,...overrides.attempt});
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
  return {calls, run:(args=options,context={})=>resolveRun(args,{fetcher,now:Date.parse('2026-01-01T01:00:00Z'),...context})};
}

test('reads only the newest verified attempt and emits exact batch; API token does not reach storage',async()=>{
  const {run,calls}=fixture();
  const result=await run();
  assert.equal(result.attempt,2);
  assert.deepEqual(result.batch.packages,[{...receipt.packages[0],tag:'promoted'}]);
  assert.deepEqual(calls.slice(0,2),[root,workflowUrl]);
  assert.deepEqual(calls.slice(-3),[home+'/runs/42',root,workflowUrl]);
  assert.equal(calls.length,11);
  assert.equal(result.batch.batchId,'gh-3-42-2');
});

for(const [label, latest] of Object.entries({failed:{conclusion:'failure'}, cancelled:{conclusion:'cancelled'},
  waiting:{status:'queued',conclusion:null}, running:{status:'in_progress',conclusion:null}})){
  test('rejects '+label+' latest attempt without searching for earlier success',async()=>{
    const f=fixture({latest});
    await assert.rejects(f.run(),/not completed successfully/);
    assert.deepEqual(f.calls,[root,workflowUrl,home+'/runs/42']);
  });
}

for(const [name,overrides,error] of [
  ['untrusted workflow', {latest:{path:'.github/workflows/other.yml'}}, /trusted producer/],
  ['same-name run from another workflow identity', {latest:{workflow_id:99}}, /trusted producer/],
  ['renamed source repository', {repository:{full_name:'other/producer'}}, /exact source repository and owner/],
  ['wrong source owner', {repository:{owner:{id:10,login:'other'}}}, /exact source repository and owner/],
  ['renamed source workflow', {workflow:{path:'.github/workflows/moved.yml'}}, /exact source workflow/],
  ['source adopted during verification', {repositoryRace:{id:5}}, /identity changed/],
  ['source owner changed during verification', {repositoryRace:{owner:{id:10,login:'example'}}}, /identity changed/],
  ['workflow recreated during verification', {workflowRace:{id:18}}, /identity changed/],
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

test('does not follow a moved repository redirect or send a token to the new location',async()=>{
  const f=fixture({repositoryRedirect:true});
  await assert.rejects(f.run(),/did not return the requested record/);
  assert.deepEqual(f.calls,[root]);
});

test('ordinary same-repository invocation uses GitHub context, not a producer parameter',async()=>{
  assert.equal(JSON.parse(producer).repositoryId,undefined);
  assert.equal((await fixture().run(options,{callerRepository:repository,callerRepositoryId:'3'})).attempt,2);
  const wrong=fixture({repository:{id:5}});
  await assert.rejects(wrong.run(options,{callerRepository:repository,callerRepositoryId:'3'}),/running workflow repository/);
  assert.deepEqual(wrong.calls,[root]);
});

test('legacy machine pin remains optional and rejects a previously pinned slug reused for another repository',async()=>{
  const pinned={...options,producer:JSON.stringify({...JSON.parse(producer),repositoryId:3})};
  assert.equal((await fixture().run(pinned)).attempt,2);
  const replacement=fixture({repository:{id:5}});
  await assert.rejects(replacement.run(pinned),/previous identity pin/);
  assert.deepEqual(replacement.calls,[root]);
});

const tag = 'v1.2.3';
const tagArgs = {repository,workflow:'release.yml',tag,token,producer:JSON.stringify({...JSON.parse(producer),
  ref:'refs/tags/',prepareJob:'prepare'})};
function tagged(override={}){
  return fixture({tagMode:true,headBranch:tag,...override,receipt:{ref:'refs/tags/'+tag,...override.receipt}});
}
const donePrepare={name:'prepare',run_attempt:2,status:'completed',conclusion:'success'};
const skippedPublish={name:'publish',run_attempt:2,status:'completed',conclusion:'skipped'};

for (const lightweight of [false,true]) {
  test('resolves '+(lightweight?'lightweight':'annotated')+' tag commit and verifies exact successful receipt',async()=>{
    const f=tagged({lightweight});
    const result=await f.run(tagArgs);
    assert.equal(result.runId,42);
    assert.equal(result.attempt,2);
    assert.equal(result.batch.packages[0].integrity,hash);
    assert.ok(f.calls.some(url=>url.includes('head_sha='+commit)));
    assert.ok(f.calls.every(url=>!url.includes('status=success')));
  });
}
test('skips newest build-only run only when the reviewed latest jobs prove it',async()=>{
  const f=tagged({newer:{},newJobs:[donePrepare,skippedPublish]});
  assert.equal((await f.run(tagArgs)).runId,42);
  assert.ok(f.calls.some(url=>url.endsWith('/runs/43/attempts/2/jobs?per_page=100')));
});
for (const [name,overrides,error] of [
  ['newest failed release', {newer:{conclusion:'failure'}}, /Latest source attempt/],
  ['newest cancelled run', {newer:{conclusion:'cancelled'}}, /Latest source attempt/],
  ['newest in-progress run', {newer:{status:'in_progress',conclusion:null}}, /not completed/],
  ['inconclusive build-only signature', {newer:{},newJobs:[skippedPublish]}, /Cannot prove/],
  ['unknown newest publish job', {newer:{}}, /no conclusive publish job/],
  ['wrong attempt build-only marker', {newer:{},newJobs:[donePrepare,{...skippedPublish,run_attempt:1}]}, /no conclusive publish job/],
  ['same time ambiguous runs', {newer:{created_at:'2026-01-01T00:00:00Z'}}, /same creation time/],
  ['incomplete search', {incomplete:true}, /run list is incomplete/],
  ['tag moved', {retag:true}, /Git tag moved/],
  ['newer run appeared', {raceTag:true}, /Latest tag run changed/],
  ['same-named branch receipt', {receipt:{ref:'refs/heads/'+tag}}, /does not match/],
]){
  test('tag path rejects '+name,async()=>{
    const f=tagged(overrides);
    await assert.rejects(f.run(tagArgs),error);
    if(overrides.newer) assert.ok(f.calls.every(url=>url!==home+'/runs/42'));
  });
}
test('tag and run ID are mutually exclusive and workflow must match reviewed policy',async()=>{
  const f=tagged();
  await assert.rejects(f.run({...tagArgs,runId}),/either an exact run ID/);
  await assert.rejects(f.run({...tagArgs,workflow:'imposter.yml'}),/not allowed/);
  assert.deepEqual(f.calls,[]);
});

const versionArgs={...tagArgs,tag:undefined,version:'1.2.3',producer:JSON.stringify({
  ...JSON.parse(tagArgs.producer),tagPrefix:'v',versionPackage:'example-cli',
})};
test('exact version derives reviewed tag and returns downstream batch, run, attempt and version',async()=>{
  const f=tagged();
  const result=await f.run(versionArgs);
  assert.equal(result.version,'1.2.3');
  assert.equal(result.runId,42);
  assert.equal(result.attempt,2);
  assert.equal(result.batch.packages[0].version,result.version);
});
test('version cannot be a range or silently switch to an explicit tag or run',async()=>{
  const f=tagged();
  for(const version of ['latest','^1.2.3','1.2','1.2.3-01',' 1.2.3']) {
    await assert.rejects(f.run({...versionArgs,version}),/exact SemVer/u);
  }
  await assert.rejects(f.run({...versionArgs,tag}),/either an exact run ID/);
  await assert.rejects(f.run({...versionArgs,runId}),/either an exact run ID/);
  await assert.rejects(f.run({...versionArgs,producer:tagArgs.producer}),/reviewed tag prefix and version package/);
  assert.deepEqual(f.calls,[]);
});
test('matching tag must still name the exact requested package version in its receipt',async()=>{
  const f=tagged({receipt:{packages:[{...receipt.packages[0],version:'1.2.4'}]}});
  await assert.rejects(f.run(versionArgs),/requested exact package version/);
});
test('latest failure never searches older successes when the operator supplied a version',async()=>{
  const f=tagged({newer:{conclusion:'failure'}});
  await assert.rejects(f.run(versionArgs),/Latest source attempt/);
  assert.ok(f.calls.every(url=>url!==home+'/runs/42'));
});
