'use strict';
// Fetches only two fixed encrypted artifacts over verified HTTPS. No redirects.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const https=require('node:https');

const MAX_BLOB=750*1024*1024;
const MAX_MANIFEST=4096;
function fail(code){throw Error(code);}
function stat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function abs(file){if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)fail('PATH_INVALID');return file;}
function privateDir(file){abs(file);const s=stat(file);if(!s?.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700||fs.realpathSync(file)!==file)fail('DIR_INVALID');}
function privateFile(file,max){abs(file);const s=stat(file);if(!s?.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size<1||s.size>max||fs.realpathSync(file)!==file)fail('FILE_INVALID');return s;}
function tokenFromFile(file){
 const original=privateFile(file,128);
 let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch{fail('TOKEN_INVALID');}
 let raw;
 try{
  const s=fs.fstatSync(fd);
  if(s.dev!==original.dev||s.ino!==original.ino||s.size!==original.size||s.nlink!==1||(s.mode&0o777)!==0o600)fail('TOKEN_INVALID');
  const data=Buffer.alloc(s.size);let offset=0;
  while(offset<data.length){const n=fs.readSync(fd,data,offset,data.length-offset,offset);if(n<=0)fail('TOKEN_INVALID');offset+=n;}
  raw=data.toString('utf8');
 }finally{fs.closeSync(fd);}
 const match=/^([A-Za-z0-9_-]{43})\n?$/.exec(raw);
 if(!match)fail('TOKEN_INVALID');
 return match[1];
}
function originValid(value){
 let url;try{url=new URL(value);}catch{fail('ORIGIN_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||url.hostname!==url.hostname.toLowerCase()||!value.startsWith('https://')||!(value==='https://'+url.hostname||value==='https://'+url.hostname+'/'))fail('ORIGIN_INVALID');
 return url.origin;
}
function openHttps(origin,name,token){
 return new Promise((resolve,reject)=>{
  const url=origin+'/'+name;
  const req=https.request(url,{method:'GET',agent:false,rejectUnauthorized:true,signal:AbortSignal.timeout(15*60*1000),headers:{Authorization:'Bearer '+token,Accept:'application/json'}},resolve);
  req.setTimeout(10000,()=>req.destroy(Error('TIMEOUT')));
  req.on('error',()=>reject(Error('HTTPS_FAILED')));
  req.end();
 });
}
function expectedManifest(data){
 let m;try{m=JSON.parse(data);}catch{fail('MANIFEST_INVALID');}
 if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).sort().join(',')!=='blobBytes,blobSha256,schema'||m.schema!=='shrigma_identity_envelope_public_manifest_v1'||!Number.isSafeInteger(m.blobBytes)||m.blobBytes<1||m.blobBytes>MAX_BLOB||typeof m.blobSha256!=='string'||!/^[a-f0-9]{64}$/.test(m.blobSha256))fail('MANIFEST_INVALID');
 return m;
}
async function receiveBody(response,target,limit,expectedBytes=null,expectedSha=null){
 if(response.statusCode!==200||response.headers['content-type']!=='application/json'||response.headers['content-encoding']!==undefined||!/^\d+$/.test(String(response.headers['content-length']||'')))fail('RESPONSE_INVALID');
 const declared=Number(response.headers['content-length']);
 if(!Number.isSafeInteger(declared)||declared<1||declared>limit||expectedBytes!==null&&declared!==expectedBytes)fail('RESPONSE_INVALID');
 const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 const h=crypto.createHash('sha256');let size=0;
 try{
  for await(const chunk of response){
   size+=chunk.length;if(size>declared||size>limit)fail('RESPONSE_TOO_LARGE');
   h.update(chunk);let offset=0;while(offset<chunk.length){const n=fs.writeSync(fd,chunk,offset,chunk.length-offset);if(n<=0)fail('WRITE_INVALID');offset+=n;}
  }
  if(size!==declared)fail('RESPONSE_TRUNCATED');
  const digest=h.digest('hex');if(expectedSha!==null&&digest!==expectedSha)fail('HASH_MISMATCH');
  fs.fsyncSync(fd);
  return {bytes:size,sha256:digest};
 }finally{fs.closeSync(fd);}
}
async function receive(response,target,limit,expectedBytes=null,expectedSha=null){
 try{return await receiveBody(response,target,limit,expectedBytes,expectedSha);}
 catch(e){response.destroy?.();throw e;}
}
async function download({origin,tokenFile,targetDir,expectedManifestSha256,transport=openHttps}){
 if(expectedManifestSha256!==undefined&&(typeof expectedManifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedManifestSha256)))fail('MANIFEST_PIN_INVALID');
 const fixed=originValid(origin),token=tokenFromFile(tokenFile);
 abs(targetDir);privateDir(path.dirname(targetDir));if(stat(targetDir))fail('TARGET_EXISTS');
 fs.mkdirSync(targetDir,{mode:0o700});
 try{
  privateDir(targetDir);
  const manifestFile=path.join(targetDir,'public-manifest.json');
  const manifestReceipt=await receive(await transport(fixed,'public-manifest.json',token),manifestFile,MAX_MANIFEST);
  if(expectedManifestSha256!==undefined&&manifestReceipt.sha256!==expectedManifestSha256)fail('MANIFEST_PIN_MISMATCH');
  privateFile(manifestFile,MAX_MANIFEST);
  const manifest=expectedManifest(fs.readFileSync(manifestFile,'utf8'));
  const blobFile=path.join(targetDir,'cipherblob.json');
  await receive(await transport(fixed,'cipherblob.json',token),blobFile,MAX_BLOB,manifest.blobBytes,manifest.blobSha256);
  privateFile(blobFile,MAX_BLOB);
  if(fs.readdirSync(targetDir).sort().join(',')!=='cipherblob.json,public-manifest.json')fail('CONTENTS_INVALID');
  return {downloaded:true};
 }catch(e){fs.rmSync(targetDir,{recursive:true,force:true});throw e;}
}
if(require.main===module){
 const [origin,tokenFile,targetDir,expectedManifestSha256,...extra]=process.argv.slice(2);
 let work;
 try{work=extra.length===0?download({origin,tokenFile,targetDir,expectedManifestSha256}):Promise.reject(Error('USAGE_INVALID'));}catch(e){work=Promise.reject(e);}
 work.then(()=>console.log('Encrypted backup download verified.')).catch(()=>{console.error('Encrypted backup download refused.');process.exitCode=1;});
}
module.exports={originValid,tokenFromFile,expectedManifest,receive,download};
