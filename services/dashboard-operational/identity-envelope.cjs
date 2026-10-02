'use strict';
// Isolated identity envelope utility. No network or application credentials.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {verifyBackup}=require('./backup-identity.cjs');
const SCHEMA='shrigma_identity_envelope_v1';
const PUBLIC_SCHEMA='shrigma_identity_envelope_public_manifest_v1';
const MAGIC=Buffer.from('SHRIGM01');
const MAX_DB=512*1024*1024;
const MAX_BLOB=750*1024*1024;
const MAX_LINE=100000;
const MAX_FRAME=MAX_DB+4108;
const MAX_CHUNKS=Math.ceil(MAX_DB/65536)+2;
const LABEL=Buffer.from('shrigma-dashboard-identity-backup-v1');
const NONCE_ENV='DASHBOARD_BACKUP_SNAPSHOT_NONCE_SHA256';

function fail(code){throw Error(code);}
function stat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function abs(file){if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)fail('PATH_INVALID');return file;}
function dir(file){abs(file);const s=stat(file);if(!s?.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700||fs.realpathSync(file)!==file)fail('DIR_INVALID');return s;}
function privateFile(file,max){abs(file);const s=stat(file);if(!s?.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size<1||s.size>max||fs.realpathSync(file)!==file)fail('FILE_INVALID');return s;}
function writeAll(fd,buf){let offset=0;while(offset<buf.length){const n=fs.writeSync(fd,buf,offset,buf.length-offset);if(n<=0)fail('WRITE_INVALID');offset+=n;}}
function b64(buf){return buf.toString('base64');}
function unb64(value,max){if(typeof value!=='string'||value.length>Math.ceil(max/3)*4+4||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('BASE64_INVALID');const buf=Buffer.from(value,'base64');if(buf.length>max||b64(buf)!==value)fail('BASE64_INVALID');return buf;}
function readPrivate(file,max){
 const original=privateFile(file,max),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);if(s.dev!==original.dev||s.ino!==original.ino||s.size!==original.size||s.nlink!==1)fail('FILE_CHANGED');const result=Buffer.alloc(s.size);let offset=0;while(offset<result.length){const n=fs.readSync(fd,result,offset,result.length-offset,offset);if(n<=0)fail('FILE_CHANGED');offset+=n;}return result;}
 finally{fs.closeSync(fd);}
}
function sha(file,expected){const h=crypto.createHash('sha256');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(expected&&(s.dev!==expected.dev||s.ino!==expected.ino||s.size!==expected.size||s.mtimeMs!==expected.mtimeMs||s.ctimeMs!==expected.ctimeMs))fail('FILE_CHANGED');const buf=Buffer.allocUnsafe(65536);for(;;){const n=fs.readSync(fd,buf,0,buf.length,null);if(!n)break;h.update(buf.subarray(0,n));}const after=fs.fstatSync(fd);if(expected&&(after.size!==expected.size||after.mtimeMs!==expected.mtimeMs||after.ctimeMs!==expected.ctimeMs))fail('FILE_CHANGED');}finally{fs.closeSync(fd);}return h.digest('hex');}
function rsaBits(key){const bits=key.asymmetricKeyDetails?.modulusLength;if(key.asymmetricKeyType!=='rsa'||![3072,4096].includes(bits)||Number(key.asymmetricKeyDetails?.publicExponent)!==65537)fail('RSA_KEY_INVALID');return bits;}
function publicKey(file){
 let pem;
 if(file==='-'){
  const encoded=process.env.DASHBOARD_BACKUP_PUBLIC_KEY_PEM_B64;
  if(typeof encoded!=='string'||encoded.length<100||encoded.length>12000)fail('RSA_KEY_INVALID');
  pem=unb64(encoded,8192);
 }else pem=readPrivate(file,8192);
 const encodedPem=pem.toString('utf8');
 if(!/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,64}\r?\n)+-----END PUBLIC KEY-----\r?\n?$/.test(encodedPem))fail('RSA_KEY_INVALID');
 const key=crypto.createPublicKey(pem);rsaBits(key);return key;
}
function privateKey(file){const key=crypto.createPrivateKey(readPrivate(file,8192));rsaBits(key);return key;}
async function* boundedLines(file,maxBytes,expected){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 const s=fs.fstatSync(fd);
 if(s.size!==expected.size||s.dev!==expected.dev||s.ino!==expected.ino||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.nlink!==1){fs.closeSync(fd);fail('FILE_CHANGED');}
 const input=fs.createReadStream(file,{fd,autoClose:true,highWaterMark:65536});
 let pending=Buffer.alloc(0),total=0;
 try{
  for await(const chunk of input){
   total+=chunk.length;if(total>maxBytes)fail('ENVELOPE_TOO_LARGE');
   let start=0,index;
   while((index=chunk.indexOf(10,start))!==-1){
    const part=chunk.subarray(start,index);
    if(pending.length+part.length>MAX_LINE)fail('ENVELOPE_LINE_INVALID');
    const line=pending.length?Buffer.concat([pending,part]):part;
    if(line.includes(13))fail('ENVELOPE_LINE_INVALID');
    yield line.toString('utf8');
    pending=Buffer.alloc(0);start=index+1;
   }
   const tail=chunk.subarray(start);
   if(pending.length+tail.length>MAX_LINE)fail('ENVELOPE_LINE_INVALID');
   pending=pending.length?Buffer.concat([pending,tail]):Buffer.from(tail);
  }
  if(pending.length)fail('ENVELOPE_LINE_INVALID');
 }finally{input.destroy();}
}
function createDir(target){abs(target);dir(path.dirname(target));if(stat(target))fail('TARGET_EXISTS');fs.mkdirSync(target,{mode:0o700});dir(target);}
function writeFile(file,bytes){const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{writeAll(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function exactNames(folder,expected){const found=fs.readdirSync(folder).sort();if(found.join(',')!==expected.slice().sort().join(','))fail('CONTENTS_INVALID');}
function validatePublic(m){return m&&typeof m==='object'&&!Array.isArray(m)&&Object.keys(m).sort().join(',')==='blobBytes,blobSha256,schema'&&m.schema===PUBLIC_SCHEMA&&Number.isSafeInteger(m.blobBytes)&&m.blobBytes>0&&m.blobBytes<=MAX_BLOB&&typeof m.blobSha256==='string'&&/^[a-f0-9]{64}$/.test(m.blobSha256);}
function nonceHash(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('SNAPSHOT_NONCE_REQUIRED');return value;}
function parseHead(line){
 const marker=',"chunks":[';
 if(!line.endsWith(marker))fail('ENVELOPE_HEADER_INVALID');
 let h;try{h=JSON.parse(line.slice(0,-marker.length)+'}');}catch{fail('ENVELOPE_HEADER_INVALID');}
 if(Object.keys(h).sort().join(',')!=='aad,cipher,iv,keyAlgorithm,schema,wrappedKey'||h.schema!==SCHEMA||h.cipher!=='AES-256-GCM'||h.keyAlgorithm!=='RSA-OAEP-SHA256')fail('ENVELOPE_HEADER_INVALID');
 const aad=unb64(h.aad,1024);
 let a;try{a=JSON.parse(aad);}catch{fail('ENVELOPE_HEADER_INVALID');}
 if(Object.keys(a).sort().join(',')!=='backupId,createdAt,schema,snapshotNonceSha256'||a.schema!==SCHEMA||typeof a.backupId!=='string'||typeof a.createdAt!=='string'||!/^[a-f0-9]{64}$/.test(a.snapshotNonceSha256))fail('ENVELOPE_HEADER_INVALID');
 return {h,aad,a};
}
async function previewNonce(blob,blobStat,expected){
 for await(const line of boundedLines(blob,MAX_BLOB,blobStat)){
  if(parseHead(line).a.snapshotNonceSha256!==expected)fail('SNAPSHOT_NONCE_MISMATCH');
  return;
 }
 fail('ENVELOPE_HEADER_INVALID');
}
async function encrypt(sourceDir,pubFile,targetDir,expectedNonceHash=process.env[NONCE_ENV]){
 abs(sourceDir);if(pubFile!=='-')abs(pubFile);abs(targetDir);
 nonceHash(expectedNonceHash);
 privateFile(path.join(sourceDir,'identity.sqlite'),MAX_DB);
 const source=await verifyBackup(sourceDir),key=publicKey(pubFile);
 if(source.bytes>MAX_DB)fail('SOURCE_TOO_LARGE');
 createDir(targetDir);
 let aes;
 try{
  const rawManifest=readPrivate(source.manifest,4096);
  if(rawManifest.length>4096)fail('MANIFEST_INVALID');
  const frameHeader=Buffer.alloc(12+rawManifest.length);
  MAGIC.copy(frameHeader,0);frameHeader.writeUInt32BE(rawManifest.length,8);rawManifest.copy(frameHeader,12);
  aes=crypto.randomBytes(32);const iv=crypto.randomBytes(12);
  const wrapped=crypto.publicEncrypt({key,oaepHash:'sha256',oaepLabel:LABEL},aes);
  const aad=Buffer.from(JSON.stringify({schema:SCHEMA,backupId:crypto.randomUUID(),createdAt:new Date().toISOString(),snapshotNonceSha256:expectedNonceHash}));
  const cipher=crypto.createCipheriv('aes-256-gcm',aes,iv,{authTagLength:16});cipher.setAAD(aad);
  const blob=path.join(targetDir,'cipherblob.json');
  const fd=fs.openSync(blob,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{
   const head=JSON.stringify({schema:SCHEMA,keyAlgorithm:'RSA-OAEP-SHA256',cipher:'AES-256-GCM',wrappedKey:b64(wrapped),iv:b64(iv),aad:b64(aad)});
   writeAll(fd,Buffer.from(head.slice(0,-1)+',"chunks":[\n'));
   let chunks=0;
   const add=(data)=>{const encrypted=cipher.update(data);if(!encrypted.length)return;writeAll(fd,Buffer.from((chunks++?',':'')+JSON.stringify(b64(encrypted))+'\n'));};
   add(frameHeader);
   const original=privateFile(source.database,MAX_DB),sourceFd=fs.openSync(source.database,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   const check=fs.fstatSync(sourceFd);
   if(check.dev!==original.dev||check.ino!==original.ino||check.size!==original.size){fs.closeSync(sourceFd);fail('SOURCE_CHANGED');}
   const sourceHash=crypto.createHash('sha256');let sourceBytes=0;
   for await(const chunk of fs.createReadStream(source.database,{fd:sourceFd,autoClose:true,highWaterMark:65536})){
    sourceBytes+=chunk.length;if(sourceBytes>MAX_DB||sourceBytes>source.bytes)fail('SOURCE_CHANGED');
    sourceHash.update(chunk);add(chunk);
   }
   if(sourceBytes!==source.bytes||sourceHash.digest('hex')!==source.sha256)fail('SOURCE_CHANGED');
   const tail=cipher.final();if(tail.length)writeAll(fd,Buffer.from((chunks++?',':'')+JSON.stringify(b64(tail))+'\n'));
   if(!chunks)fail('ENCRYPT_EMPTY');
   writeAll(fd,Buffer.from('],"tag":'+JSON.stringify(b64(cipher.getAuthTag()))+'}\n'));
   fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  const s=privateFile(blob,MAX_BLOB);
  const m={schema:PUBLIC_SCHEMA,blobBytes:s.size,blobSha256:sha(blob)};
  const publicManifest=path.join(targetDir,'public-manifest.json');
  writeFile(publicManifest,Buffer.from(JSON.stringify(m)+'\n'));
  exactNames(targetDir,['cipherblob.json','public-manifest.json']);
  return {encrypted:true,publicManifestSha256:sha(publicManifest)};
 }catch(e){fs.rmSync(targetDir,{recursive:true,force:true});throw e;}
 finally{if(aes)aes.fill(0);}
}
async function decrypt(sourceDir,privFile,targetDir,expectedNonceHash=process.env[NONCE_ENV]){
 abs(sourceDir);abs(privFile);abs(targetDir);dir(sourceDir);exactNames(sourceDir,['cipherblob.json','public-manifest.json']);
 nonceHash(expectedNonceHash);
 const blob=path.join(sourceDir,'cipherblob.json'),manifest=path.join(sourceDir,'public-manifest.json');
 const blobStat=privateFile(blob,MAX_BLOB);privateFile(manifest,4096);
 let pub;try{pub=JSON.parse(readPrivate(manifest,4096));}catch{fail('PUBLIC_MANIFEST_INVALID');}
 if(!validatePublic(pub)||pub.blobBytes!==blobStat.size||pub.blobSha256!==sha(blob,blobStat))fail('PUBLIC_MANIFEST_INVALID');
 await previewNonce(blob,blobStat,expectedNonceHash);
 const key=privateKey(privFile);
 dir(path.dirname(targetDir));if(stat(targetDir))fail('TARGET_EXISTS');
 const temp=path.join(path.dirname(targetDir),'.decrypt-'+crypto.randomUUID());
 createDir(temp);
 try{
  const frame=path.join(temp,'frame');
  const fd=fs.openSync(frame,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{
   let stage='head',decipher=null,chunks=0,footerSeen=false,plainBytes=0;
   const writePlain=(data)=>{if(plainBytes+data.length>MAX_FRAME)fail('FRAME_TOO_LARGE');writeAll(fd,data);plainBytes+=data.length;};
   for await(const line of boundedLines(blob,MAX_BLOB,blobStat)){
    if(stage==='head'){
     const {h,aad,a}=parseHead(line);
     if(a.snapshotNonceSha256!==expectedNonceHash)fail('SNAPSHOT_NONCE_MISMATCH');
     const wrapped=unb64(h.wrappedKey,rsaBits(key)/8);
     if(wrapped.length!==rsaBits(key)/8)fail('ENVELOPE_KEY_INVALID');
     const aes=crypto.privateDecrypt({key,oaepHash:'sha256',oaepLabel:LABEL},wrapped);
     try{
      if(aes.length!==32)fail('ENVELOPE_KEY_INVALID');
      const iv=unb64(h.iv,12);
      if(iv.length!==12)fail('ENVELOPE_HEADER_INVALID');
      decipher=crypto.createDecipheriv('aes-256-gcm',aes,iv,{authTagLength:16});decipher.setAAD(aad);
     }finally{aes.fill(0);}
     stage='chunks';continue;
    }
    if(stage==='end')fail('ENVELOPE_TRAILING_DATA');
    if(line.startsWith('],"tag":')){
     if(chunks<1)fail('ENVELOPE_EMPTY');
     let footer;try{footer=JSON.parse('{'+line.slice(2));}catch{fail('ENVELOPE_FOOTER_INVALID');}
     if(Object.keys(footer).join(',')!=='tag')fail('ENVELOPE_FOOTER_INVALID');
     const tag=unb64(footer.tag,16);if(tag.length!==16)fail('ENVELOPE_FOOTER_INVALID');
     decipher.setAuthTag(tag);writePlain(decipher.final());stage='end';footerSeen=true;continue;
    }
    const chunkString=line.startsWith(',')?line.slice(1):line;
    if((chunks===0&&line.startsWith(','))||(chunks>0&&!line.startsWith(',')))fail('ENVELOPE_CHUNK_INVALID');
    let encoded;try{encoded=JSON.parse(chunkString);}catch{fail('ENVELOPE_CHUNK_INVALID');}
    const data=unb64(encoded,65536);
    if(!data.length||chunks>=MAX_CHUNKS)fail('ENVELOPE_CHUNK_INVALID');
    writePlain(decipher.update(data));chunks++;
   }
   if(!footerSeen)fail('ENVELOPE_FOOTER_MISSING');
   fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  const frameStat=privateFile(frame,MAX_FRAME);
  if(sha(blob,blobStat)!==pub.blobSha256)fail('FILE_CHANGED');
  const frameFd=fs.openSync(frame,'r');
  let rawManifest,dbSize;
  try{
   const head=Buffer.alloc(12);if(fs.readSync(frameFd,head,0,12,0)!==12||!head.subarray(0,8).equals(MAGIC))fail('FRAME_INVALID');
   const n=head.readUInt32BE(8);if(n<1||n>4096||frameStat.size<12+n+1)fail('FRAME_INVALID');
   rawManifest=Buffer.alloc(n);if(fs.readSync(frameFd,rawManifest,0,n,12)!==n)fail('FRAME_INVALID');
   dbSize=frameStat.size-12-n;if(dbSize>MAX_DB)fail('FRAME_INVALID');
   let inside;try{inside=JSON.parse(rawManifest);}catch{fail('FRAME_INVALID');}
   if(!Number.isSafeInteger(inside.bytes)||inside.bytes!==dbSize)fail('FRAME_INVALID');
   createDir(targetDir);
   try{
    writeFile(path.join(targetDir,'manifest.json'),rawManifest);
    const out=fs.openSync(path.join(targetDir,'identity.sqlite'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try{const buf=Buffer.allocUnsafe(65536);let offset=12+n;while(offset<frameStat.size){const count=fs.readSync(frameFd,buf,0,Math.min(buf.length,frameStat.size-offset),offset);if(!count)fail('FRAME_INVALID');writeAll(out,buf.subarray(0,count));offset+=count;}fs.fsyncSync(out);}finally{fs.closeSync(out);}
    await verifyBackup(targetDir);
   }catch(e){fs.rmSync(targetDir,{recursive:true,force:true});throw e;}
  }finally{fs.closeSync(frameFd);}
  return {restored:true};
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
if(require.main===module){
 const [action,...args]=process.argv.slice(2);
 let task;try{task=action==='encrypt'&&args.length===3?encrypt(...args):action==='decrypt'&&args.length===3?decrypt(...args):Promise.reject(Error('USAGE_INVALID'));}catch(e){task=Promise.reject(e);}
 task.then(result=>console.log('Identity envelope verified.'+(action==='encrypt'?' public_manifest_sha256='+result.publicManifestSha256:''))).catch(()=>{console.error('Identity envelope refused.');process.exitCode=1;});
}
module.exports={SCHEMA,PUBLIC_SCHEMA,encrypt,decrypt};
