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
