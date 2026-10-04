'use strict';
// Offline inert API. No env, network, SQL, key generation, logger or plaintext CLI.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const A=require('../crm-manager-read-activation-review/activation.cjs');
const C=require('../crm-manager-read-activation-review/compose/build-compose.cjs');
const SCHEMA='crm-manager-read-credential-capsule-v1';
const BINDING='crm-manager-read-credential-custody-binding-v1';
const RESULT='crm-manager-read-credential-custody-v1';
const FILE='credential-capsule.json',MAX=16384;
const LABEL=Buffer.from(SCHEMA,'utf8');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function refuse(){throw Error('READ_CREDENTIAL_CUSTODY_REFUSED');}
function safe(fn){try{return fn();}catch{refuse();}}
function exact(v,keys){
 if(!v||Object.getPrototypeOf(v)!==Object.prototype)refuse();
 const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))refuse();
 for(const k of own){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||d.enumerable!==true||!Object.hasOwn(d,'value'))refuse();}
}
function canonical(v){return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);}
function sha(v){return crypto.createHash('sha256').update(v).digest('hex');}
function admitRuntimeSources(){
 const dir=path.resolve(__dirname,'../crm-manager-read-activation-review/runtime'),directory=fs.lstatSync(dir);
 if(!directory.isDirectory()||directory.isSymbolicLink()||fs.realpathSync(dir)!==dir)refuse();
 const sources={};let total=0;
 for(const name of Object.keys(C.PINS)){
  const file=path.join(dir,name),before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>20000||(total+=before.size)>65536)refuse();
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  function same(s){if(!s.isFile()||s.nlink!==1||s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs)refuse();}
  try{same(fs.fstatSync(fd));const data=fs.readFileSync(fd);same(fs.fstatSync(fd));if(data.length!==before.size||sha(data)!==C.PINS[name])refuse();sources[name]=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}finally{fs.closeSync(fd);}
 }
 C.validateSources(sources);
}
function binding(value){return safe(()=>{
 exact(value,['schema','operationId','credentialIntentId','action','fromPhase']);
 if(value.schema!=='crm-manager-read-runtime-intent-v1'||!UUID.test(value.operationId)||!UUID.test(value.credentialIntentId)||value.action!=='stage'||value.fromPhase!=='empty')refuse();
 A.validateSources();admitRuntimeSources();
 return Object.freeze({schema:BINDING,credentialIntentId:value.credentialIntentId,stageOperationId:value.operationId,spec:A.SPEC,database:'listmonk',sourcePins:A.PINS,runtimeSourcePins:C.PINS,runtimeImage:C.IMAGE});
});}
function rsa(key,type){if(!(key instanceof crypto.KeyObject)||key.type!==type||key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails?.modulusLength!==4096||Number(key.asymmetricKeyDetails?.publicExponent)!==65537)refuse();return key;}
function keySha256(key){return sha(crypto.createPublicKey(key.type==='public'?key.export({type:'spki',format:'pem'}):key).export({type:'spki',format:'der'}));}
function bytes(value,size){if(typeof value!=='string')refuse();const b=Buffer.from(value,'base64');if(b.length!==size||b.toString('base64')!==value)refuse();return b;}
function validateCredential(password,verifier){
 // A single random 256-bit ASCII password avoids SASLprep ambiguity. This API
 // never generates it: the approved operator owns its one-time generation.
 if(typeof password!=='string'||!/^[a-f0-9]{64}$/.test(password))refuse();
 A.validateVerifier(verifier);
 const [,iterationsSalt,keys]=verifier.split('$');
 const salt=bytes(iterationsSalt.slice(5),16),[stored,server]=keys.split(':').map(x=>bytes(x,32));
 const salted=crypto.pbkdf2Sync(password,salt,4096,32,'sha256');
 let client,calculatedStored,calculatedServer;
 try{
  client=crypto.createHmac('sha256',salted).update('Client Key').digest();
  calculatedStored=crypto.createHash('sha256').update(client).digest();
  calculatedServer=crypto.createHmac('sha256',salted).update('Server Key').digest();
  if(!crypto.timingSafeEqual(stored,calculatedStored)||!crypto.timingSafeEqual(server,calculatedServer))refuse();
 }finally{salted.fill(0);client?.fill(0);calculatedStored?.fill(0);calculatedServer?.fill(0);}
}
function privateDirectory(dir){
 if(typeof dir!=='string'||!path.isAbsolute(dir)||path.resolve(dir)!==dir)refuse();
 const s=fs.lstatSync(dir);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700||fs.realpathSync(dir)!==dir)refuse();
 return s;
}
function syncDirectory(dir){
 const expected=privateDirectory(dir),fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);if(s.dev!==expected.dev||s.ino!==expected.ino)refuse();fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function readCipher(dir){
 privateDirectory(dir);if(JSON.stringify(fs.readdirSync(dir))!==JSON.stringify([FILE]))refuse();
 const file=path.join(dir,FILE),expected=fs.lstatSync(file);
 function admit(s){if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o7777)!==0o600||s.size<1||s.size>MAX||s.dev!==expected.dev||s.ino!==expected.ino||s.size!==expected.size||s.mtimeMs!==expected.mtimeMs||s.ctimeMs!==expected.ctimeMs)refuse();}
 admit(expected);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  admit(fs.fstatSync(fd));const data=Buffer.alloc(expected.size);let offset=0;
  while(offset<data.length){const n=fs.readSync(fd,data,offset,data.length-offset,offset);if(n<=0)refuse();offset+=n;}
  admit(fs.fstatSync(fd));fs.fsyncSync(fd);return data;
 }finally{fs.closeSync(fd);}
}
function durableCipher(dir){
 const first=readCipher(dir);syncDirectory(dir);syncDirectory(path.dirname(dir));
 const second=readCipher(dir);if(!first.equals(second))refuse();return second;
}
function loadKey(file,type){return safe(()=>{
 if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)refuse();
 privateDirectory(path.dirname(file));const expected=fs.lstatSync(file);
 function admit(s){if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o7777)!==0o600||s.size<1||s.size>8192||s.dev!==expected.dev||s.ino!==expected.ino||s.size!==expected.size||s.mtimeMs!==expected.mtimeMs||s.ctimeMs!==expected.ctimeMs)refuse();}
 admit(expected);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let data;
 try{
  admit(fs.fstatSync(fd));data=Buffer.alloc(expected.size);let offset=0;
  while(offset<data.length){const n=fs.readSync(fd,data,offset,data.length-offset,offset);if(n<=0)refuse();offset+=n;}
  admit(fs.fstatSync(fd));fs.fsyncSync(fd);syncDirectory(path.dirname(file));
  if(type==='public'&&!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(data.toString('utf8')))refuse();
  return rsa(type==='public'?crypto.createPublicKey(data):crypto.createPrivateKey(data),type);
 }finally{data?.fill(0);fs.closeSync(fd);}
});}
function receipt(bound,data){return Object.freeze({schema:RESULT,credentialIntentId:bound.credentialIntentId,stageOperationId:bound.stageOperationId,cipherBytes:data.length,cipherSha256:sha(data),durabilityBarrier:true});}
function sealNew(input){return safe(()=>{
 exact(input,['directory','intent','password','verifier','publicKey']);
 const {directory,intent,password,verifier,publicKey}=input;
 const bound=binding(intent);rsa(publicKey,'public');validateCredential(password,verifier);
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory)refuse();
 privateDirectory(path.dirname(directory));
 const keySha=keySha256(publicKey),aad=Buffer.from(canonical({schema:SCHEMA,binding:bound,keySha256:keySha}));
 let aes,plain,data;
 try{
  aes=crypto.randomBytes(32);const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',aes,iv,{authTagLength:16});c.setAAD(aad);
  plain=Buffer.from(JSON.stringify({binding:bound,password,verifier}));
  const ciphertext=Buffer.concat([c.update(plain),c.final()]);
  const wrapped=crypto.publicEncrypt({key:publicKey,oaepHash:'sha256',oaepLabel:LABEL},aes);
  data=Buffer.from(JSON.stringify({schema:SCHEMA,binding:bound,keySha256:keySha,keyAlgorithm:'RSA-OAEP-SHA256',cipher:'AES-256-GCM',wrappedKey:wrapped.toString('base64'),iv:iv.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:c.getAuthTag().toString('base64')})+'\n');
  if(data.length>MAX)refuse();
  // Existing/partial state stays untouched. Never replace a credential that
  // could already have reached PostgreSQL, including an unknown outcome.
  fs.mkdirSync(directory,{mode:0o700});privateDirectory(directory);
  const fd=fs.openSync(path.join(directory,FILE),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{let offset=0;while(offset<data.length){const n=fs.writeSync(fd,data,offset,data.length-offset);if(n<=0)refuse();offset+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const recovered=durableCipher(directory);if(!data.equals(recovered))refuse();
  return receipt(bound,recovered);
 }finally{aes?.fill(0);plain?.fill(0);}
});}
function openExisting(input){return safe(()=>{
 exact(input,['directory','intent','privateKey']);const {directory,intent,privateKey}=input;
 const bound=binding(intent);rsa(privateKey,'private');
 const data=durableCipher(directory),e=JSON.parse(data.toString('utf8'));
 exact(e,['schema','binding','keySha256','keyAlgorithm','cipher','wrappedKey','iv','ciphertext','tag']);
 if(e.schema!==SCHEMA||e.keyAlgorithm!=='RSA-OAEP-SHA256'||e.cipher!=='AES-256-GCM'||canonical(e.binding)!==canonical(bound)||e.keySha256!==keySha256(privateKey))refuse();
 const wrapped=bytes(e.wrappedKey,512),iv=bytes(e.iv,12),tag=bytes(e.tag,16);
 if(typeof e.ciphertext!=='string'||e.ciphertext.length>12000)refuse();
 const ciphertext=Buffer.from(e.ciphertext,'base64');if(!ciphertext.length||ciphertext.toString('base64')!==e.ciphertext)refuse();
 let aes,plain;
 try{
  aes=crypto.privateDecrypt({key:privateKey,oaepHash:'sha256',oaepLabel:LABEL},wrapped);if(aes.length!==32)refuse();
  const d=crypto.createDecipheriv('aes-256-gcm',aes,iv,{authTagLength:16});d.setAAD(Buffer.from(canonical({schema:SCHEMA,binding:bound,keySha256:e.keySha256})));d.setAuthTag(tag);
  plain=Buffer.concat([d.update(ciphertext),d.final()]);if(plain.length>8192)refuse();
  const secret=JSON.parse(plain.toString('utf8'));exact(secret,['binding','password','verifier']);
  if(canonical(secret.binding)!==canonical(bound))refuse();validateCredential(secret.password,secret.verifier);
  // Accidental JSON/string/console inspection emits only the closed receipt.
  // The trusted operator alone reads the nonenumerable RAM properties.
  const result={...receipt(bound,data)};
  Object.defineProperties(result,{password:{value:secret.password,enumerable:false},verifier:{value:secret.verifier,enumerable:false}});
  return Object.freeze(result);
 }finally{aes?.fill(0);plain?.fill(0);}
});}
module.exports=Object.freeze({SCHEMA,BINDING,RESULT,FILE,MAX,binding,sealNew,openExisting,loadPublicKey:file=>loadKey(file,'public'),loadPrivateKey:file=>loadKey(file,'private')});
if(require.main===module){process.stderr.write('READ_CREDENTIAL_CUSTODY_API_ONLY\n');process.exitCode=1;}
