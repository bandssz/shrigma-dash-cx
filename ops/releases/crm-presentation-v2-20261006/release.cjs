'use strict';
// V2 explicitly replaces thirteen of the original thirty public files.
// Seven existing presentation payloads are preserved; six panel files are added
// to this closed replacement list. The artifact remains 58 files (30 public/28 runtime).
// The admitted image, runtime pack, Auth, native controller and identity volumes
// remain authoritative. This module has no environment, network or SQL access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const BASE_IMAGE='e1729ca3a6d064244c82a8df3d13bd1f3323797d5cfb8a80e1d6d0cf12345e32';
const BASE_SOURCE='c3f0ac329d04903078fc0a558ed89aa9f50696c9';
const BASE_PACK='c80ee2a8f2611b9cb17a5d24b9b1668a7fe4218a2a95e73cb706e5b6682980da';
const READY='/tmp/crm-presentation-ready-v1.json';
const FILES=Object.freeze(["assets/panels/growth.js","assets/panels/influs.css","assets/panels/influs.js","assets/panels/organico.css","assets/panels/organico.js","creators/index.html","crm/index.html","entry.js","gestao/index.html","growth.html","influs.html","organico.html","organico/index.html"]);
const IMAGE_FILES=Object.freeze({
 'artifact-policy.cjs':'430f53eb5b542c47db54b2576ac5bf99018f2f70f70121c9e16e75fff9d1011f',
 'bootstrap.cjs':'6f3bff53826eff2788be17181fbae2a619ec42a482092cf25924ad0864c6dde0',
 'canary-image.cjs':'195a7e24ab74e795cdf451190042c1d2bd0b5e7aa00ae0ece8f6069fbfa445cc',
 'canary-start.cjs':'0d47603282a95af89d1dd4534b316b1c1df5157e0b93c3d6b0a5792edc794000',
 'image-pin.json':'e6832dbbbb02dab8da4089678b865fb303bd4bebfb22bedb237737d6a3f70cc3',
 'runtime-pack.json':'3b7ffcb0095a723402bc37ed3187ccab1e05f27b1e27cff8d1a9699011972be4'
});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const same=(a,b)=>['dev','ino','size','nlink','uid','gid','mode','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
const deny=()=>{throw Error('PRESENTATION_RELEASE_REFUSED');};
function createApplier({imageDir='/app',releaseDir=__dirname,uid=1000,gid=1000,immutableUid=0,immutableGid=0,fsImpl=fs}={}){
 const stat=(file,dir=false,image=false)=>{const s=fsImpl.lstatSync(file);if(fsImpl.realpathSync(file)!==file||s.isSymbolicLink()||(dir?!s.isDirectory():!s.isFile())||(image?s.uid!==immutableUid||s.gid!==immutableGid:s.uid!==uid||s.gid!==gid)||!dir&&s.nlink!==1||(dir?image?![0o555,0o755].includes(s.mode&0o777):(s.mode&0o777)!==0o700:(s.mode&0o777)!==(image?0o444:0o600)))deny();return s;};
 const read=(file,max=2*1024*1024,image=false)=>{const before=stat(file,false,image);if(before.size<1||before.size>max)deny();let fd;try{fd=fsImpl.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);if(!same(before,fsImpl.fstatSync(fd)))deny();const b=fsImpl.readFileSync(fd);if(b.length!==before.size||!same(before,fsImpl.fstatSync(fd))||!same(before,stat(file,false,image)))deny();return b;}finally{if(fd!==undefined)fsImpl.closeSync(fd);}};
 const within=(root,file,image=false)=>{const target=path.resolve(root,file);if(!target.startsWith(root+path.sep))deny();const directory=p=>{const s=stat(p,true,image);if(image&&(s.mode&0o777)!==0o555)deny();};directory(root);for(let p=path.dirname(target);p!==root;p=path.dirname(p))directory(p);return target;};
 function inputs(){
  if(process.getuid?.()!==uid||process.getgid?.()!==gid||!path.isAbsolute(imageDir)||!path.isAbsolute(releaseDir))deny();
  if((stat(imageDir,true,true).mode&0o777)!==0o755||(stat(releaseDir,true,true).mode&0o777)!==0o555)deny();
  for(const [file,pin]of Object.entries(IMAGE_FILES))if(sha(read(path.join(imageDir,file),2*1024*1024,true))!==pin)deny();
  const policy=require(path.join(imageDir,'artifact-policy.cjs'));
  const original=policy.decodePack(read(path.join(imageDir,'runtime-pack.json'),2*1024*1024,true).toString('utf8'),BASE_PACK);
  const raw=read(path.join(releaseDir,'manifest.json'),16384,true),manifest=JSON.parse(raw.toString('utf8'));
  if(!exact(manifest,['schema','baseImageDigest','baseSourceRevision','basePackSha256','files'])||manifest.schema!=='crm-presentation-release-v2'||manifest.baseImageDigest!==BASE_IMAGE||manifest.baseSourceRevision!==BASE_SOURCE||manifest.basePackSha256!==BASE_PACK||!Array.isArray(manifest.files)||manifest.files.length!==FILES.length)deny();
  const originalByPath=new Map(original.files.map(f=>[f.path,Buffer.from(f.content,f.encoding)]));
  const changed=new Map();
  for(let i=0;i<FILES.length;i++){
   const f=manifest.files[i],name=FILES[i],before=originalByPath.get('public/'+name);
   if(!exact(f,['path','beforeSha256','beforeBytes','afterSha256','afterBytes'])||f.path!==name||!hex(f.beforeSha256)||!hex(f.afterSha256)||f.beforeSha256===f.afterSha256||!before||sha(before)!==f.beforeSha256||before.length!==f.beforeBytes||!Number.isSafeInteger(f.afterBytes)||f.afterBytes<1||f.afterBytes>2*1024*1024)deny();
   const after=read(within(path.join(releaseDir,'public'),name,true),2*1024*1024,true);
   if(sha(after)!==f.afterSha256||after.length!==f.afterBytes)deny();
   changed.set('public/'+name,{...f,before,after});
  }
  const payloadFiles=[];
  const scan=(dir,prefix='')=>{if((stat(dir,true,true).mode&0o777)!==0o555)deny();for(const name of fsImpl.readdirSync(dir)){const relative=prefix+name,file=path.join(dir,name),s=fsImpl.lstatSync(file);if(s.isDirectory())scan(file,relative+'/');else{stat(file,false,true);payloadFiles.push(relative);}}};
  scan(path.join(releaseDir,'public'));
  if(JSON.stringify(payloadFiles.sort())!==JSON.stringify(FILES))deny();
  return {manifest,manifestSha256:sha(raw),original,originalByPath,changed};
 }
 function artifactRoot(artifact){
  if(!exact(artifact,['files','publicFiles','runtimeFiles','bytes','publicBytes','runtimeBytes','sha256','root','publicDir','runtimeDir'])||artifact.sha256!==BASE_PACK||artifact.files!==58||artifact.publicFiles!==30||artifact.runtimeFiles!==28||typeof artifact.root!=='string'||artifact.root!==path.resolve(artifact.root)||artifact.publicDir!==artifact.root+'/public'||artifact.runtimeDir!==artifact.root+'/runtime')deny();
  const parent=path.dirname(artifact.root);if(path.basename(artifact.root)!=='artifact'||!/^shrigma-operational-[A-Za-z0-9]+$/.test(path.basename(parent))||path.dirname(parent)!==fsImpl.realpathSync('/tmp'))deny();
  for(const dir of [parent,artifact.root,artifact.publicDir,artifact.runtimeDir]){const s=stat(dir,true);if((s.mode&0o777)!==0o700)deny();}
 }
 function verifyTree(artifact,input,after=false){
  artifactRoot(artifact);
  const expected=new Set(input.original.files.map(f=>f.path));
  const actual=[];
  const walk=(dir,prefix='')=>{for(const name of fsImpl.readdirSync(dir)){const relative=prefix+name,file=path.join(dir,name),s=fsImpl.lstatSync(file);if(s.isDirectory()){stat(file,true);walk(file,relative+'/');}else{stat(file);actual.push(relative);}}};
  walk(artifact.root);
  if(actual.length!==expected.size||actual.some(f=>!expected.has(f)))deny();
  for(const [name,before]of input.originalByPath){const bytes=read(within(artifact.root,name)),s=stat(path.join(artifact.root,name));if((s.mode&0o777)!==0o600)deny();const wanted=after&&input.changed.has(name)?input.changed.get(name).after:before;if(!bytes.equals(wanted))deny();}
 }
 function apply(artifact){
  const input=inputs();verifyTree(artifact,input,false);
  const staged=[];
  try{
   // All payloads and every unpacked file are verified before any replacement.
   for(const [name,value]of input.changed){
    const target=within(artifact.root,name),stage=target+'.presentation-'+crypto.randomBytes(12).toString('hex');
    const fd=fsImpl.openSync(stage,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{fsImpl.writeFileSync(fd,value.after);fsImpl.fsyncSync(fd);}finally{fsImpl.closeSync(fd);}
    staged.push({stage,target,value});if(sha(read(stage))!==value.afterSha256)deny();
   }
   for(const file of staged){if(!read(file.target).equals(file.value.before))deny();fsImpl.renameSync(file.stage,file.target);}
   verifyTree(artifact,input,true);
   return Object.freeze({schema:'crm-presentation-release-result-v2',baseImageDigest:BASE_IMAGE,basePackSha256:BASE_PACK,manifestSha256:input.manifestSha256,publicFilesChanged:FILES.length,runtimeFilesUnchanged:28,identityAccess:false,operational:false});
  }finally{for(const file of staged)try{fsImpl.unlinkSync(file.stage);}catch(e){if(e.code!=='ENOENT')throw Error('PRESENTATION_RELEASE_CLEANUP_REFUSED');}}
 }
 function verify(artifact){const input=inputs();verifyTree(artifact,input,true);return {schema:'crm-presentation-release-verified-v2',manifestSha256:input.manifestSha256,publicFilesChanged:FILES.length,runtimeFilesUnchanged:28,identityAccess:false};}
 return {apply,verify};
}
function applyPresentationSync(artifact){return createApplier().apply(artifact);}
function locator(){
 const s=fs.lstatSync(READY);if(fs.realpathSync(READY)!==READY||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==1000||s.gid!==1000||(s.mode&0o777)!==0o600||s.size<1||s.size>2048)deny();
 let fd;try{fd=fs.openSync(READY,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);if(!same(s,fs.fstatSync(fd)))deny();const b=fs.readFileSync(fd);if(b.length!==s.size||!same(s,fs.fstatSync(fd))||!same(s,fs.lstatSync(READY)))deny();const value=JSON.parse(b.toString('utf8'));if(!exact(value,['schema','artifact','manifestSha256'])||value.schema!=='crm-presentation-locator-v1'||!hex(value.manifestSha256))deny();return {value,stat:s,bytesSha256:sha(b)};}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function writeLocator(artifact,manifestSha256){
 if(process.getuid?.()!==1000||process.getgid?.()!==1000)deny();
 let previous,present=false;try{fs.lstatSync(READY);present=true;}catch(e){if(e.code!=='ENOENT')throw e;}if(present)previous=locator();
 const bytes=Buffer.from(JSON.stringify({schema:'crm-presentation-locator-v1',artifact,manifestSha256})+'\n');if(bytes.length<1||bytes.length>2048)deny();
 const stage=READY+'.'+crypto.randomBytes(12).toString('hex');let fd;
 const owned=s=>s.isFile()&&s.nlink===1&&s.uid===1000&&s.gid===1000&&(s.mode&0o777)===0o600;
 try{fd=fs.openSync(stage,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);const before=fs.fstatSync(fd);if(!owned(before)||before.size!==0)deny();fs.writeFileSync(fd,bytes);const written=fs.fstatSync(fd);if(!owned(written)||written.size!==bytes.length||written.dev!==before.dev||written.ino!==before.ino)deny();fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;if(previous&&!same(previous.stat,fs.lstatSync(READY)))deny();if(!previous&&fs.existsSync(READY))deny();fs.renameSync(stage,READY);const dir=fs.openSync(path.dirname(READY),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}if(locator().bytesSha256!==sha(bytes))deny();}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(stage);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function verifyReady(){const ready=locator(),verified=createApplier().verify(ready.value.artifact);if(verified.manifestSha256!==ready.value.manifestSha256||!same(ready.stat,fs.lstatSync(READY)))deny();return verified;}
// This is synchronous: there is no await, promise or timer between startup and
// publication. On refusal, the original server's error handler closes its socket
// and drains Auth before any request can observe a partially changed directory.
function createStarter(applier){return function startWithPresentation(start){
 const started=start();try{const result=applier.apply(started.artifact);return {...started,presentation:result};}
 catch{started.server.emit('error',Error('PRESENTATION_RELEASE_REFUSED'));throw Error('PRESENTATION_RELEASE_REFUSED');}
};
}
function startWithPresentation(start){const applier=createApplier();return createStarter({apply:artifact=>{const result=applier.apply(artifact);writeLocator(artifact,result.manifestSha256);return result;}})(start);}
module.exports={applyPresentationSync,startWithPresentation,createStarter,createApplier,verifyReady,BASE_IMAGE,BASE_SOURCE,BASE_PACK,FILES,IMAGE_FILES};
