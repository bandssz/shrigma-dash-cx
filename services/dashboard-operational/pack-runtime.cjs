'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {SCHEMA,MAX_BYTES,MAX_PACK_BYTES,PUBLIC_FILES,RUNTIME_FILES,sha,isText,validateFiles,decodePack}=require('./artifact-policy.cjs');
const IMAGE='node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
function regularFile(file){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error('PACK_SOURCE_INVALID');
 return fs.readFileSync(file);
}
function inventory(root){
 const listed=[];
 const base=fs.lstatSync(root);if(!base.isDirectory()||base.isSymbolicLink())throw Error('PACK_PUBLIC_ROOT_INVALID');
 function visit(dir,prefix=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const rel=prefix+entry.name;
  if(entry.isSymbolicLink())throw Error('PACK_SOURCE_SYMLINK');
  if(entry.isDirectory())visit(path.join(dir,entry.name),rel+'/');else if(entry.isFile())listed.push(rel);else throw Error('PACK_SOURCE_INVALID');
 }}visit(root);
 if(JSON.stringify(listed.sort())!==JSON.stringify(PUBLIC_FILES))throw Error('PACK_PUBLIC_ALLOWLIST_INVALID');
}
function entry(file,bytes){
 const text=isText(file),content=bytes.toString(text?'utf8':'base64');
 if(text&&!Buffer.from(content,'utf8').equals(bytes))throw Error('PACK_SOURCE_UTF8_INVALID');
 return {path:file,encoding:text?'utf8':'base64',content};
}
function pack(dist,output){
 const source=path.resolve(dist),destination=path.resolve(output),publicRoot=path.join(source,'public');inventory(publicRoot);
 if(fs.existsSync(destination)){const s=fs.lstatSync(destination);if(!s.isDirectory()||s.isSymbolicLink()||fs.readdirSync(destination).length)throw Error('PACK_DESTINATION_INVALID');}
 const files=[...PUBLIC_FILES.map(f=>entry('public/'+f,regularFile(path.join(publicRoot,f)))),...RUNTIME_FILES.map(f=>entry('runtime/'+f,regularFile(path.join(__dirname,f))))].sort((a,b)=>a.path.localeCompare(b.path));
 const stats=validateFiles(files),raw=Buffer.from(JSON.stringify(files));if(raw.length>MAX_BYTES)throw Error('PACK_RAW_BYTES_INVALID');
 const wrapper={schema:SCHEMA,sha256:sha(raw),gzipBase64:zlib.gzipSync(raw,{level:9}).toString('base64')};
 const packed=JSON.stringify(wrapper);if(Buffer.byteLength(packed)>MAX_PACK_BYTES)throw Error('PACK_TRANSPORT_TOO_LARGE');decodePack(packed,wrapper.sha256);
 const smallFiles=['bootstrap.cjs','artifact-policy.cjs'];
 const mounts=smallFiles.map(file=>({type:'file',mountPath:'/app/'+file,content:regularFile(path.join(__dirname,file)).toString('utf8')}));
 const seedMounts=[...mounts,{type:'file',mountPath:'/app/runtime-pack.json',content:packed}],seedMountsBytes=Buffer.byteLength(JSON.stringify(seedMounts));
 if(seedMountsBytes>950000)throw Error('PACK_SEED_TRANSPORT_TOO_LARGE');
 fs.mkdirSync(destination,{recursive:true,mode:0o700});
 for(const file of smallFiles)fs.writeFileSync(path.join(destination,file),regularFile(path.join(__dirname,file)),{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(destination,'runtime-pack.json'),packed,{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(destination,'mounts.json'),JSON.stringify(mounts),{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(destination,'seed-mounts.json'),JSON.stringify(seedMounts),{flag:'wx',mode:0o600});
 const metadata={schema:SCHEMA,image:IMAGE,packSha256:wrapper.sha256,...stats,rawBytes:raw.length,packBytes:Buffer.byteLength(packed),seedMountsBytes,steadyMountsBytes:Buffer.byteLength(JSON.stringify(mounts)),runtimeUid:1000,runtimeGid:1000,volume:'/dashboard-data',dbPath:'/dashboard-data/dashboard.sqlite',suggestedLimits:{memoryMiB:512,cpu:0.5,replicas:1},nodeHeapMiB:128};
 fs.writeFileSync(path.join(destination,'deployment-metadata.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});
 return {directory:destination,...metadata};
}
if(require.main===module){if(!process.argv[2]||!process.argv[3])throw Error('Usage: node pack-runtime.cjs build-directory empty-output');console.log(JSON.stringify(pack(process.argv[2],process.argv[3])));}
module.exports={pack,inventory,IMAGE};
