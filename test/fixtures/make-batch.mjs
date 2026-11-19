import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const base=process.env.FIXTURE_DIRECTORY;
const packages=[];
for (const [i,name] of ['@synthetic/cli-sdk','@synthetic/collab-sdk'].entries()){
 const version='1.0.0-rc.1',tag='rc',dir=join(base,'src'+i);
 await mkdir(join(dir,'package'),{recursive:true});
 await writeFile(join(dir,'package','package.json'),JSON.stringify({name,version}));
 const file=join(base,'pkg'+i+'.tgz');
 execFileSync('tar',['-czf',file,'-C',dir,'package']);
 const integrity='sha512-'+createHash('sha512').update(await readFile(file)).digest('base64');
 packages.push({name,version,tag,integrity});
}
await writeFile(join(base,'entries.json'),JSON.stringify(packages));
const m={schema:1,batchId:'sdk-ci',sourceRegistry:'https://insider-npm-registry.univer.work/',packages};
const bad=structuredClone(m);bad.packages[0].integrity='sha512-'+createHash('sha512').update('mismatch').digest('base64');
await writeFile(process.env.GITHUB_OUTPUT,'batch='+JSON.stringify(m)+'\nbad='+JSON.stringify(bad)+'\n');
