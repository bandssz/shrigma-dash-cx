import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const inventory=JSON.parse(fs.readFileSync(path.join(root,'installed-source-inventory.private.json'),'utf8'));
const baseline=JSON.parse(fs.readFileSync(path.join(root,'baseline-compile.safe.json'),'utf8'));
if(!baseline.byteExact||baseline.baselineCompiledPrefixSha256!=='2ed409125aedd9f829bf851119561cbd05d1be0e80b019fc983b9784c1f794e9')throw Error('EXACT_BASELINE_REQUIRED');
const target=path.join(root,'candidate-source');if(fs.existsSync(target))throw Error('FRESH_CANDIDATE_REQUIRED');
fs.mkdirSync(target,{mode:0o700});
for(const [name,hash] of Object.entries(inventory.files)){
 const original=path.join(root,'installed-source',name),bytes=fs.readFileSync(original);if(sha(bytes)!==hash)throw Error('INSTALLED_SOURCE_DRIFT');
 const out=path.join(target,name);fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});fs.writeFileSync(out,bytes,{flag:'wx',mode:0o600});
}
const pool=fs.readFileSync(path.join(root,'../package/pool.go'));if(sha(pool)!=='ffe979909222c1d37bd8ae385cee13e97d38983445e5babf7e1e0036a0f04d8e')throw Error('TESTED_POOL_BINDING_REFUSED');
fs.writeFileSync(path.join(target,'smtppool/pool.go'),pool,{mode:0o600});
const changes=Object.entries(inventory.files).filter(([name,hash])=>sha(fs.readFileSync(path.join(target,name)))!==hash).map(([name])=>name);
if(changes.join()!=='smtppool/pool.go')throw Error('NON_SMTP_SOURCE_CHANGED');
for(const name of ['candidate-build','candidate-context'])fs.mkdirSync(path.join(root,name),{mode:0o700});
const report={schema:'smtp-only-candidate-source-v1',baselineFileCount:inventory.count,changes,poolSha256:sha(pool),allOtherFilesByteExact:true,batchProfileByteExact:true,productionCalls:0};
fs.writeFileSync(path.join(root,'candidate-source.safe.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
