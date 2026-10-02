'use strict';
// Fixed-file HTTPS-terminator backend. No plaintext, key, or upstream access.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');

const FILES=Object.freeze({'/cipherblob.json':{name:'cipherblob.json',max:750*1024*1024},
                           '/public-manifest.json':{name:'public-manifest.json',max:4096}});
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const HOST=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
function fail(code){throw Error(code);}
function stat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function privateDir(dir){
 if(typeof dir!=='string'||!path.isAbsolute(dir)||path.resolve(dir)!==dir)fail('DIR_INVALID');
 const s=stat(dir);
 if(!s?.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700||fs.realpathSync(dir)!==dir)fail('DIR_INVALID');
}
function fileMeta(file,max){
 const l=stat(file);
 if(!l?.isFile()||l.isSymbolicLink())fail('FILE_INVALID');
 let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch{fail('FILE_INVALID');}
 try{
  const s=fs.fstatSync(fd);
  if(!l?.isFile()||l.isSymbolicLink()||!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.nlink!==1||s.size<1||s.size>max||s.dev!==l.dev||s.ino!==l.ino)fail('FILE_INVALID');
  return {dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs};
 }finally{fs.closeSync(fd);}
}
function readSmall(file,max,expected){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);if(s.dev!==expected.dev||s.ino!==expected.ino||s.size!==expected.size||s.size>max)fail('FILE_CHANGED');const data=Buffer.alloc(s.size);let offset=0;while(offset<data.length){const n=fs.readSync(fd,data,offset,data.length-offset,offset);if(n<=0)fail('FILE_CHANGED');offset+=n;}return data;}
 finally{fs.closeSync(fd);}
}
function sha(file,expected){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),h=crypto.createHash('sha256');
 try{const s=fs.fstatSync(fd);if(s.dev!==expected.dev||s.ino!==expected.ino||s.size!==expected.size)fail('FILE_CHANGED');const buf=Buffer.allocUnsafe(65536);for(;;){const n=fs.readSync(fd,buf,0,buf.length,null);if(!n)break;h.update(buf.subarray(0,n));}}finally{fs.closeSync(fd);}
 return h.digest('hex');
}
function preflight(dir){
 privateDir(dir);
 const names=fs.readdirSync(dir).sort();
 if(names.join(',')!=='cipherblob.json,public-manifest.json')fail('CONTENTS_INVALID');
 const blob=path.join(dir,'cipherblob.json'),manifest=path.join(dir,'public-manifest.json');
 const meta={blob:fileMeta(blob,FILES['/cipherblob.json'].max),manifest:fileMeta(manifest,FILES['/public-manifest.json'].max)};
 let doc;try{doc=JSON.parse(readSmall(manifest,4096,meta.manifest));}catch{fail('MANIFEST_INVALID');}
 if(!doc||typeof doc!=='object'||Array.isArray(doc)||Object.keys(doc).sort().join(',')!=='blobBytes,blobSha256,schema'||doc.schema!=='shrigma_identity_envelope_public_manifest_v1'||doc.blobBytes!==meta.blob.size||typeof doc.blobSha256!=='string'||!/^[a-f0-9]{64}$/.test(doc.blobSha256)||sha(blob,meta.blob)!==doc.blobSha256)fail('MANIFEST_INVALID');
 return meta;
}
function configFromEnv(env=process.env,now=Date.now()){
 const dir=env.BACKUP_READER_DIR||'/cipher-data';
 const host=env.BACKUP_READER_HOST;
 const tokenSha256=env.BACKUP_READER_TOKEN_SHA256;
 const expiresAt=Date.parse(env.BACKUP_READER_EXPIRES_AT||'');
 const port=Number(env.PORT||3000);
 if(typeof host!=='string'||host!==host.toLowerCase()||!HOST.test(host)||host.includes('..')||host.endsWith('.')||typeof tokenSha256!=='string'||!/^[a-f0-9]{64}$/.test(tokenSha256)||!Number.isFinite(expiresAt)||expiresAt<=now+60000||expiresAt>now+30*60000||!Number.isSafeInteger(port)||port<1||port>65535)fail('CONFIG_INVALID');
 return {dir,host,tokenSha256,expiresAt,port};
}
function createReader({dir,host,tokenSha256,expiresAt,now=Date.now}){
 if(typeof host!=='string'||!HOST.test(host)||typeof tokenSha256!=='string'||!/^[a-f0-9]{64}$/.test(tokenSha256)||!Number.isFinite(expiresAt))fail('CONFIG_INVALID');
 const pinned=preflight(dir),expected=Buffer.from(tokenSha256,'hex');
 function deny(res){
  res.statusCode=404;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Length','0');
  res.end();
 }
 async function handle(req,res){
  try{
   const h=req.headers||{};
   if(Array.isArray(req.rawHeaders)){
    const counts={host:0,authorization:0,'x-forwarded-proto':0};
    for(let i=0;i<req.rawHeaders.length;i+=2){const key=String(req.rawHeaders[i]).toLowerCase();if(Object.hasOwn(counts,key))counts[key]++;}
    if(Object.values(counts).some(count=>count!==1)){deny(res);return;}
   }
   const authorization=h.authorization;
   const supplied=typeof authorization==='string'&&authorization.startsWith('Bearer ')?authorization.slice(7):'';
   const digest=crypto.createHash('sha256').update(supplied).digest();
   const validToken=TOKEN.test(supplied)&&crypto.timingSafeEqual(digest,expected);
   if(req.method!=='GET'||!Object.hasOwn(FILES,req.url)||h.host!==host||h['x-forwarded-proto']!=='https'||!validToken||now()>=expiresAt||h.range!==undefined||h['if-range']!==undefined||h['content-length']!==undefined||h['transfer-encoding']!==undefined){
    deny(res);return;
   }
   const kind=FILES[req.url],file=path.join(dir,kind.name),original=kind.name==='cipherblob.json'?pinned.blob:pinned.manifest;
   privateDir(dir);
   if(fs.readdirSync(dir).sort().join(',')!=='cipherblob.json,public-manifest.json'){deny(res);return;}
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   let current;try{current=fs.fstatSync(fd);}catch{fs.closeSync(fd);throw Error('FILE_INVALID');}
   if(!current.isFile()||current.uid!==process.getuid()||(current.mode&0o777)!==0o600||current.nlink!==1||current.size!==original.size||current.size>kind.max||current.dev!==original.dev||current.ino!==original.ino||current.mtimeMs!==original.mtimeMs||current.ctimeMs!==original.ctimeMs){fs.closeSync(fd);deny(res);return;}
   res.statusCode=200;
   res.setHeader('Content-Type','application/json');
   res.setHeader('Content-Length',String(current.size));
   res.setHeader('Cache-Control','private, no-store, max-age=0');
   res.setHeader('X-Content-Type-Options','nosniff');
   res.setHeader('Content-Security-Policy',"default-src 'none'");
   const input=fs.createReadStream(file,{fd,autoClose:true,highWaterMark:65536});
   await pipeline(input,res);
  }catch{
   if(res.headersSent){res.destroy();return;}
   deny(res);
  }
 }
 return handle;
}
function start(env=process.env){
 const cfg=configFromEnv(env);
 const handler=createReader(cfg);
 const server=http.createServer((req,res)=>{void handler(req,res);});
 server.maxConnections=2;
 server.headersTimeout=10000;
 server.requestTimeout=10000;
 server.keepAliveTimeout=1000;
 server.on('error',()=>{console.error('Cipher reader refused.');process.exitCode=1;});
 server.listen(cfg.port,'0.0.0.0');
 return server;
}
if(require.main===module){
 try{start();}catch{console.error('Cipher reader refused.');process.exitCode=1;}
}
module.exports={FILES,configFromEnv,preflight,createReader,start};
