import assert from 'node:assert/strict';
import test from 'node:test';
import { assemble } from './assemble.mjs';

test('resolve a trusted Insider digest using metadata alone', async () => {
  const name='example-cli', version='1.2.3';
  const integrity='sha512-'+Buffer.alloc(64,1).toString('base64');
  const urls=[];
  const fetcher=async (u)=>{
    urls.push(String(u));
    assert.equal(String(u),'https://insider-npm-registry.univer.work/example-cli');
    return Response.json({name,versions:{[version]:{name,version,
      dist:{integrity,tarball:'https://insider-npm-registry.univer.work/example-cli/-/example-cli-1.2.3.tgz'}}},
      'dist-tags':{latest:version}});
  };
  const batch=await assemble(JSON.stringify({packages:[{name,version}]}),{fetcher});
  assert.deepEqual(batch.packages,[{name,version,integrity,tag:'latest'}]);
  assert.equal(urls.length,1);
});
