'use strict';
// Independent synthetic review tests; never accepts corporate source paths.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {createBackup,verifyBackup}=require('./backup-identity.cjs');
const {encrypt,decrypt}=require('./identity-envelope.cjs');
process.env.DASHBOARD_BACKUP_SNAPSHOT_NONCE_SHA256=crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
const ROOT=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'identity-envelope-review-')));
fs.chmodSync(ROOT,0o700);
process.umask(0o077);
let fixture;
function mkdir(name){const p=path.join(ROOT,name);fs.mkdirSync(p,{mode:0o700});return p;}
function keys(name,bits=3072){
 const folder=mkdir(name);
 const pair=crypto.generateKeyPairSync('rsa',{modulusLength:bits,publicExponent:0x10001,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const pub=path.join(folder,'public.pem'),priv=path.join(folder,'private.pem');
 fs.writeFileSync(pub,pair.publicKey,{mode:0o600});fs.writeFileSync(priv,pair.privateKey,{mode:0o600});
 return {pub,priv};
}
function copy(name){const dst=path.join(ROOT,name);fs.cpSync(fixture.encrypted,dst,{recursive:true});fs.chmodSync(dst,0o700);return dst;}
function refresh(folder){
 const blob=path.join(folder,'cipherblob.json'),h=crypto.createHash('sha256');
 const fd=fs.openSync(blob,'r');const b=Buffer.alloc(65536);
 try{for(;;){const n=fs.readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n));}}finally{fs.closeSync(fd);}
 fs.writeFileSync(path.join(folder,'public-manifest.json'),JSON.stringify({schema:'shrigma_identity_envelope_public_manifest_v1',blobBytes:fs.statSync(blob).size,blobSha256:h.digest('hex')})+'\n',{mode:0o600});
}
function mutate(folder,transform){const p=path.join(folder,'cipherblob.json');fs.writeFileSync(p,transform(fs.readFileSync(p,'utf8')),{mode:0o600});refresh(folder);}
function noQuarantine(){return fs.readdirSync(ROOT).filter(n=>n.startsWith('.decrypt-'));}
test.before(async()=>{
 const live=mkdir('live'),dbfile=path.join(live,'dashboard.sqlite');
 const db=new DatabaseSync(dbfile);
 try{
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v BLOB NOT NULL); INSERT INTO t VALUES('review synthetic secret marker');");
  db.prepare('INSERT INTO t(v) VALUES(?)').run(crypto.randomBytes(300000));
  for(const p of [dbfile,dbfile+'-wal',dbfile+'-shm'])if(fs.existsSync(p))fs.chmodSync(p,0o600);
  const backup=path.join(ROOT,'backup');await createBackup(dbfile,backup);
  const key=keys('keys');const encrypted=path.join(ROOT,'encrypted');await encrypt(backup,key.pub,encrypted);
  fixture={backup,encrypted,...key};
 }finally{db.close();}
});
test.after(()=>fs.rmSync(ROOT,{recursive:true,force:true}));
test('successful restore is private, complete and SQLite verified',async()=>{
 const dst=path.join(ROOT,'ok');assert.deepEqual(await decrypt(fixture.encrypted,fixture.priv,dst),{restored:true});await verifyBackup(dst);
 assert.equal(fs.statSync(dst).mode&0o777,0o700);
 for(const name of ['identity.sqlite','manifest.json']){const s=fs.statSync(path.join(dst,name));assert.equal(s.mode&0o777,0o600);assert.equal(s.uid,process.getuid());assert.equal(s.nlink,1);}
 assert.deepEqual(noQuarantine(),[]);
});
test('wrong private key refuses restoration and removes quarantine',async()=>{
 const wrong=keys('wrong'),target=path.join(ROOT,'wrong-restored');
 await assert.rejects(decrypt(fixture.encrypted,wrong.priv,target));assert.equal(fs.existsSync(target),false);assert.deepEqual(noQuarantine(),[]);
});
test('wrong or missing expected nonce refuses before quarantine or AES unwrap',async()=>{
 const original=crypto.privateDecrypt;let unwrapped=false;
 crypto.privateDecrypt=(...args)=>{unwrapped=true;return original(...args);};
 try{
  const wrong=crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  await assert.rejects(decrypt(fixture.encrypted,fixture.priv,path.join(ROOT,'wrong-intent'),wrong),/SNAPSHOT_NONCE_MISMATCH/);
  await assert.rejects(decrypt(fixture.encrypted,fixture.priv,path.join(ROOT,'missing-intent'),null),/SNAPSHOT_NONCE_REQUIRED/);
 }finally{crypto.privateDecrypt=original;}
 assert.equal(unwrapped,false);assert.deepEqual(noQuarantine(),[]);assert.equal(fs.existsSync(path.join(ROOT,'wrong-intent')),false);
});
test('rewriting nonce in replayed AAD cannot reuse the old GCM tag',async()=>{
 const src=copy('rewritten-nonce'),dst=path.join(ROOT,'rewritten-nonce-restored');
 const wanted=crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
 mutate(src,s=>{const a=s.split('\n'),marker=',"chunks":[';const h=JSON.parse(a[0].slice(0,-marker.length)+'}');const aad=JSON.parse(Buffer.from(h.aad,'base64'));aad.snapshotNonceSha256=wanted;h.aad=Buffer.from(JSON.stringify(aad)).toString('base64');a[0]=JSON.stringify(h).slice(0,-1)+marker;return a.join('\n');});
 await assert.rejects(decrypt(src,fixture.priv,dst,wanted));assert.equal(fs.existsSync(dst),false);assert.deepEqual(noQuarantine(),[]);
});
for(const [name,change] of [
 ['missing-footer',s=>s.split('\n').slice(0,-2).join('\n')+'\n'],
 ['reordered-chunks',s=>{const a=s.split('\n');const x=JSON.parse(a[2].slice(1)),y=JSON.parse(a[3].slice(1));a[2]=','+JSON.stringify(y);a[3]=','+JSON.stringify(x);return a.join('\n');}],
 ['removed-chunk',s=>{const a=s.split('\n');a.splice(2,1);return a.join('\n');}],
 ['changed-tag',s=>{const a=s.split('\n');const idx=a.length-2;const footer=JSON.parse('{'+a[idx].slice(2));const b=Buffer.from(footer.tag,'base64');b[0]^=1;a[idx]='],"tag":'+JSON.stringify(b.toString('base64'))+'}';return a.join('\n');}],
 ['changed-aad',s=>{const a=s.split('\n');const marker=',"chunks":[';const h=JSON.parse(a[0].slice(0,-marker.length)+'}');const aad=JSON.parse(Buffer.from(h.aad,'base64'));aad.createdAt='2027-10-02T00:00:00.000Z';h.aad=Buffer.from(JSON.stringify(aad)).toString('base64');a[0]=JSON.stringify(h).slice(0,-1)+marker;return a.join('\n');}],
 ['trailing-data',s=>s+'unexpected\n'],
])test(name+' remains unauthenticated even with recomputed public hash',async()=>{
 const src=copy(name),dst=path.join(ROOT,name+'-restored');mutate(src,change);
 await assert.rejects(decrypt(src,fixture.priv,dst));assert.equal(fs.existsSync(dst),false);assert.deepEqual(noQuarantine(),[]);
});
test('symlink, hardlink, wrong modes and extra file are refused before restore',async()=>{
 for(const name of ['symlink','hardlink','mode','extra']){
  const src=copy(name),blob=path.join(src,'cipherblob.json'),dst=path.join(ROOT,name+'-restored');
  if(name==='symlink'){fs.unlinkSync(blob);fs.symlinkSync(path.join(fixture.encrypted,'cipherblob.json'),blob);}
  if(name==='hardlink'){fs.unlinkSync(blob);fs.linkSync(path.join(fixture.encrypted,'cipherblob.json'),blob);}
  if(name==='mode')fs.chmodSync(blob,0o644);
  if(name==='extra')fs.writeFileSync(path.join(src,'unexpected'),'',{mode:0o600});
  await assert.rejects(decrypt(src,fixture.priv,dst));assert.equal(fs.existsSync(dst),false);assert.deepEqual(noQuarantine(),[]);
  fs.rmSync(src,{recursive:true,force:true});
 }
});
test('RSA modulus above 4096 must be refused before encrypt output creation',async()=>{
 const large=keys('rsa4608',4608),dst=path.join(ROOT,'large-key-envelope');
 await assert.rejects(encrypt(fixture.backup,large.pub,dst));assert.equal(fs.existsSync(dst),false);
});
test('RSA4096 supported profile restores a complete SQLite backup',async()=>{
 const supported=keys('rsa4096',4096),src=path.join(ROOT,'rsa4096-envelope'),dst=path.join(ROOT,'rsa4096-restored');
 await encrypt(fixture.backup,supported.pub,src);await decrypt(src,supported.priv,dst);await verifyBackup(dst);assert.deepEqual(noQuarantine(),[]);
});
test('source larger than 512 MiB is refused before hashing or output creation',async()=>{
 const src=mkdir('oversized-source'),database=path.join(src,'identity.sqlite');
 const fd=fs.openSync(database,'wx',0o600);try{fs.ftruncateSync(fd,512*1024*1024+1);}finally{fs.closeSync(fd);}
 fs.writeFileSync(path.join(src,'manifest.json'),JSON.stringify({schema:'dashboard_identity_backup_v1',bytes:512*1024*1024+1,sha256:'0'.repeat(64),createdAt:new Date().toISOString()})+'\n',{mode:0o600});
 const original=crypto.createHash;let hashed=false;
 crypto.createHash=(...args)=>{hashed=true;return original(...args);};
 const dst=path.join(ROOT,'oversized-envelope');
 try{await assert.rejects(encrypt(src,fixture.pub,dst));}finally{crypto.createHash=original;}
 assert.equal(hashed,false,'oversized input must be rejected before any hashing');assert.equal(fs.existsSync(dst),false);
});
test('writer profile refuses empty chunks even with a valid GCM tag',async()=>{
 const src=copy('empty-chunk'),dst=path.join(ROOT,'empty-chunk-restored');
 mutate(src,s=>{const a=s.split('\n');a.splice(a.length-2,0,',""');return a.join('\n');});
 await assert.rejects(decrypt(src,fixture.priv,dst));assert.equal(fs.existsSync(dst),false);assert.deepEqual(noQuarantine(),[]);
});
test('AES buffer is erased when public wrapping fails',async()=>{
 const original=crypto.publicEncrypt;let captured;
 crypto.publicEncrypt=(options,data)=>{captured=data;throw Error('SYNTHETIC_WRAP_FAILURE');};
 const dst=path.join(ROOT,'wrap-failure');
 try{await assert.rejects(encrypt(fixture.backup,fixture.pub,dst));}finally{crypto.publicEncrypt=original;}
 assert.equal(captured?.length,32);assert.ok(captured.every(b=>b===0),'AES buffer must be erased on wrapping failure');assert.equal(fs.existsSync(dst),false);
});
test('AES buffer is erased when header validation fails after unwrapping',async()=>{
 const src=copy('invalid-iv'),dst=path.join(ROOT,'invalid-iv-restored');
 mutate(src,s=>{const a=s.split('\n'),marker=',"chunks":[';const h=JSON.parse(a[0].slice(0,-marker.length)+'}');h.iv=Buffer.alloc(11).toString('base64');a[0]=JSON.stringify(h).slice(0,-1)+marker;return a.join('\n');});
 const original=crypto.privateDecrypt;let captured;
 crypto.privateDecrypt=(...args)=>{captured=original(...args);return captured;};
 try{await assert.rejects(decrypt(src,fixture.priv,dst));}finally{crypto.privateDecrypt=original;}
 assert.equal(captured?.length,32);assert.ok(captured.every(b=>b===0),'AES buffer must be erased after header failure');assert.equal(fs.existsSync(dst),false);assert.deepEqual(noQuarantine(),[]);
});
test('encrypt refuses source changed after verification but before stream open',async()=>{
 const database=path.join(fixture.backup,'identity.sqlite'),size=fs.statSync(database).size;
 const saved=fs.readFileSync(database),original=fs.openSync;let changed=false;
 fs.openSync=(file,flags,...rest)=>{
  if(file===database&&flags===(fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)&&!changed){
   changed=true;const patch=Buffer.from(saved);patch[size-1]^=1;fs.writeFileSync(database,patch,{mode:0o600});
  }
  return original(file,flags,...rest);
 };
 const dst=path.join(ROOT,'changed-source-envelope');
 try{await assert.rejects(encrypt(fixture.backup,fixture.pub,dst));}finally{fs.openSync=original;fs.writeFileSync(database,saved,{mode:0o600});}
 assert.equal(changed,true,'race fixture must execute after verify');assert.equal(fs.existsSync(dst),false);
});
test('overlong line is refused within 32 MiB heap and removes unauthenticated frame',async()=>{
 const src=copy('overlong'),blob=path.join(src,'cipherblob.json'),lines=fs.readFileSync(blob,'utf8').split('\n');
 const fd=fs.openSync(blob,'w',0o600);
 try{
  fs.writeSync(fd,lines.slice(0,3).join('\n')+'\n');
  const block=Buffer.alloc(65536,0x41);for(let n=0;n<768;n++)fs.writeSync(fd,block);fs.writeSync(fd,'\n');
 }finally{fs.closeSync(fd);}
 refresh(src);
 const dst=path.join(ROOT,'overlong-restored');
 const child=spawnSync(process.execPath,['--max-old-space-size=32','--no-report-on-fatalerror','--no-report-on-signal','-e',`require(${JSON.stringify(path.join(__dirname,'identity-envelope.cjs'))}).decrypt(...process.argv.slice(1)).then(()=>process.exitCode=7).catch(()=>process.exitCode=3)`,src,fixture.priv,dst],{encoding:'utf8',timeout:15000,maxBuffer:4096,env:{...process.env,NODE_OPTIONS:''}});
 assert.equal(child.signal,null,'bounded parser must fail normally, never by fatal heap signal');
 assert.equal(child.status,3,'overlong line must be rejected');assert.equal(fs.existsSync(dst),false);assert.deepEqual(noQuarantine(),[]);
});
