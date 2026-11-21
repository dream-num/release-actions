import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checkPublic} from './check.mjs';

const name='@example/demo', version='1.0.0';
const integrity='sha512-'+createHash('sha512').update('synthetic').digest('base64');
const fixture = (body,status=200) => async(url,init) => {
  assert.equal(url.origin,'https://registry.npmjs.org');
  assert.equal(decodeURIComponent(url.pathname),'/@example/demo/1.0.0');
  assert.equal(init.method,undefined);
  assert.equal(init.headers,undefined);
  assert.equal(init.redirect,'error');
  return Response.json(body,{status});
};
test('public checker is read-only and separates exact visibility, mismatch and HTTP failure',async()=>{
 const input={name,version,integrity};
 assert.equal(await checkPublic({...input,fetcher:fixture({name,version,dist:{integrity}})}),'visible_match');
 assert.equal(await checkPublic({...input,fetcher:fixture({},404)}),'not_visible');
 assert.equal(await checkPublic({...input,fetcher:fixture({name,version,dist:{integrity:'wrong'}})}),'mismatch');
 await assert.rejects(checkPublic({...input,fetcher:fixture({},503)}),/HTTP 503/);
 await assert.rejects(checkPublic({...input,integrity:'malformed',fetcher:()=>assert.fail('network')}),/SHA-512/);
});

test('strict verification independently hashes exact scoped tarball and never follows user-controlled targets',async()=>{
 const inputs={name,version,integrity,verifyTarball:true};
 const archive='https://registry.npmjs.org/@example/demo/-/demo-1.0.0.tgz';
 const mock = (tarball=archive, bytes='synthetic', code=200, metadataIntegrity=integrity) => {
   const urls=[];
   const fetcher=async (url, init)=>{
     urls.push(url.href);
     assert.equal(init.method,undefined);
     assert.equal(init.headers,undefined);
     assert.equal(init.redirect,'error');
     if(urls.length===1)return Response.json({name,version,dist:{integrity:metadataIntegrity,tarball}});
     assert.equal(url.href,archive);
     return new Response(bytes,{status:code});
   };
   return {urls,fetcher};
 };
 const match=mock();
 assert.equal(await checkPublic({...inputs,...match}),'visible_match');
 assert.equal(match.urls.length,2);
 assert.equal(await checkPublic({...inputs,...mock(archive,'modified')}),'mismatch');
 const differentURL=mock('https://registry.npmjs.org/@example/demo/-/demo-2.0.0.tgz');
 assert.equal(await checkPublic({...inputs,...differentURL}),'mismatch');
 assert.equal(differentURL.urls.length,1);
 const external=mock('https://example.invalid/demo-1.0.0.tgz');
 assert.equal(await checkPublic({...inputs,...external}),'mismatch');
 assert.equal(external.urls.length,1);
 const wrongIntegrity=mock(archive,'modified',200,'replacement');
 assert.equal(await checkPublic({...inputs,...wrongIntegrity}),'mismatch');
 assert.equal(wrongIntegrity.urls.length,1);
 await assert.rejects(checkPublic({...inputs,...mock(archive,'modified',302)}),/tarball query failed: HTTP 302/);
});
