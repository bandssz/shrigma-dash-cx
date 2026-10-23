'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FILES=['command.cjs','queue.sql'],sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function build(source,nativeRoot,output,revision){
 if(!/^[a-f0-9]{40}$/.test(revision||'')||fs.existsSync(output))throw Error('PREPARED_BUILD_REFUSED');
 const nativeBytes=fs.readFileSync(path.join(nativeRoot,'manifest.json')),native=JSON.parse(nativeBytes);if(native.sourceRevision!==revision||native.sqlInstallerEnabled!==false||!/^[a-f0-9]{64}$/.test(native.pgDriverManifestSha256||''))throw Error('PREPARED_NATIVE_MISMATCH');
 fs.mkdirSync(output,{mode:0o755});const files=FILES.map(name=>{const p=path.join(source,name),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>128*1024)throw Error('PREPARED_FILE_REFUSED');const bytes=fs.readFileSync(p);fs.writeFileSync(path.join(output,name),bytes,{mode:0o444,flag:'wx'});return{path:name,bytes:bytes.length,sha256:sha(bytes)};});
 const manifest={schema:'shrigma-prepared-processes-v1',sourceRevision:revision,nativeManifestSha256:sha(nativeBytes),pgDriverManifestSha256:native.pgDriverManifestSha256,files,worker:{state:'prepared',executionEnabled:false,handlers:0,databaseConnected:false,queueSchemaApplied:false},queue:{schema:'shrigma_worker',table:'tasks',attemptsTable:'attempts',databaseBinding:null,automaticInstallation:false}};
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(output,'manifest.json'),bytes,{mode:0o444,flag:'wx'});fs.chmodSync(output,0o555);return{ok:true,manifestSha256:sha(bytes),nativeManifestSha256:manifest.nativeManifestSha256,sourceRevision:revision,files:files.length,executionEnabled:false,queueSchemaApplied:false};
}
if(require.main===module)console.log(JSON.stringify(build(...process.argv.slice(2))));
module.exports={build,FILES};
