'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createBackup,verifyBackup}=require('./backup-identity.cjs');
const {encrypt,decrypt}=require('./identity-envelope.cjs');
const SNAPSHOT_NONCE_HASH=crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
process.env.DASHBOARD_BACKUP_SNAPSHOT_NONCE_SHA256=SNAPSHOT_NONCE_HASH;
function mkdir(parent,name){const p=path.join(parent,name);fs.mkdirSync(p,{mode:0o700});return p;}
function keypair(dir){
 const pair=crypto.generateKeyPairSync('rsa',{modulusLength:3072,publicExponent:0x10001,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const pub=path.join(dir,'public.pem'),priv=path.join(dir,'private.pem');
 fs.writeFileSync(pub,pair.publicKey,{mode:0o600});fs.writeFileSync(priv,pair.privateKey,{mode:0o600});
 return {pub,priv};
}
test('Node22 online SQLite backup -> JSON envelope -> private restore; tamper fails',async t=>{
 process.umask(0o077);
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'identity-envelope-synthetic-')));
 fs.chmodSync(base,0o700);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const live=mkdir(base,'live'),dbfile=path.join(live,'dashboard.sqlite');
 const writer=new DatabaseSync(dbfile);
 try{
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v BLOB NOT NULL); INSERT INTO t VALUES('synthetic secret marker');");
  writer.prepare('INSERT INTO t(v) VALUES(?)').run(crypto.randomBytes(300000));
  for(const p of [dbfile,dbfile+'-wal',dbfile+'-shm'])if(fs.existsSync(p))fs.chmodSync(p,0o600);
  const backup=path.join(base,'backup');await createBackup(dbfile,backup);
  const {pub,priv}=keypair(base);
  const encrypted=path.join(base,'encrypted');await encrypt(backup,pub,encrypted);
  const envEncrypted=path.join(base,'env-encrypted');
  const previous=process.env.DASHBOARD_BACKUP_PUBLIC_KEY_PEM_B64;
  try{
   process.env.DASHBOARD_BACKUP_PUBLIC_KEY_PEM_B64=fs.readFileSync(pub).toString('base64');
   await encrypt(backup,'-',envEncrypted);
   process.env.DASHBOARD_BACKUP_PUBLIC_KEY_PEM_B64=fs.readFileSync(priv).toString('base64');
   const invalid=path.join(base,'private-pem-rejected');
   await assert.rejects(encrypt(backup,'-',invalid),/RSA_KEY_INVALID/);
   assert.equal(fs.existsSync(invalid),false);
  }finally{
   if(previous===undefined)delete process.env.DASHBOARD_BACKUP_PUBLIC_KEY_PEM_B64;
   else process.env.DASHBOARD_BACKUP_PUBLIC_KEY_PEM_B64=previous;
  }
  const envRestored=path.join(base,'env-restored');await decrypt(envEncrypted,priv,envRestored);await verifyBackup(envRestored);
  const otherNonceHash=crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const replayTarget=path.join(base,'replay-rejected');
  await assert.rejects(decrypt(encrypted,priv,replayTarget,otherNonceHash),/SNAPSHOT_NONCE_MISMATCH/);
  assert.equal(fs.existsSync(replayTarget),false);
  assert.deepEqual(fs.readdirSync(base).filter(name=>name.startsWith('.decrypt-')),[]);
  const otherEnvelope=path.join(base,'new-nonce-envelope');await encrypt(backup,pub,otherEnvelope,otherNonceHash);
  const otherRestored=path.join(base,'new-nonce-restored');await decrypt(otherEnvelope,priv,otherRestored,otherNonceHash);await verifyBackup(otherRestored);
  const nonceHeaderTamper=path.join(base,'nonce-header-tamper');fs.cpSync(encrypted,nonceHeaderTamper,{recursive:true});
  const tamperedBlobPath=path.join(nonceHeaderTamper,'cipherblob.json');
  const tamperedLines=fs.readFileSync(tamperedBlobPath,'utf8').split('\n');
  const marker=',"chunks":[';
  const tamperedHead=JSON.parse(tamperedLines[0].slice(0,-marker.length)+'}');
  const tamperedAad=JSON.parse(Buffer.from(tamperedHead.aad,'base64').toString('utf8'));
  tamperedAad.snapshotNonceSha256=otherNonceHash;
  tamperedHead.aad=Buffer.from(JSON.stringify(tamperedAad)).toString('base64');
  tamperedLines[0]=JSON.stringify(tamperedHead).slice(0,-1)+marker;
  const tamperedBlob=tamperedLines.join('\n');fs.writeFileSync(tamperedBlobPath,tamperedBlob,{mode:0o600});
  fs.writeFileSync(path.join(nonceHeaderTamper,'public-manifest.json'),JSON.stringify({schema:'shrigma_identity_envelope_public_manifest_v1',blobBytes:Buffer.byteLength(tamperedBlob),blobSha256:crypto.createHash('sha256').update(tamperedBlob).digest('hex')})+'\n',{mode:0o600});
  const tamperedTarget=path.join(base,'nonce-header-rejected');
  await assert.rejects(decrypt(nonceHeaderTamper,priv,tamperedTarget,otherNonceHash));
  assert.equal(fs.existsSync(tamperedTarget),false);
  assert.deepEqual(fs.readdirSync(encrypted).sort(),['cipherblob.json','public-manifest.json']);
  const blob=fs.readFileSync(path.join(encrypted,'cipherblob.json'),'utf8');
  const manifest=fs.readFileSync(path.join(encrypted,'public-manifest.json'),'utf8');
  assert.doesNotMatch(blob+manifest,/synthetic secret marker|dashboard_identity_backup_v1/);
  assert.equal(JSON.parse(blob).schema,'shrigma_identity_envelope_v1');
  assert.ok(JSON.parse(blob).chunks.length>2);
  const restored=path.join(base,'restored');await decrypt(encrypted,priv,restored);
  await verifyBackup(restored);
  const copied=new DatabaseSync(path.join(restored,'identity.sqlite'),{readOnly:true});
  try{assert.equal(copied.prepare('SELECT v FROM t').get().v,'synthetic secret marker');}finally{copied.close();}
  const lines=blob.split('\n');
  const firstChunk=lines[1];
  const original=firstChunk[1];
  lines[1]=firstChunk.slice(0,1)+(original==='A'?'B':'A')+firstChunk.slice(2);
  const replacement=lines.join('\n');
  fs.writeFileSync(path.join(encrypted,'cipherblob.json'),replacement,{mode:0o600});
  fs.writeFileSync(path.join(encrypted,'public-manifest.json'),JSON.stringify({schema:'shrigma_identity_envelope_public_manifest_v1',blobBytes:Buffer.byteLength(replacement),blobSha256:crypto.createHash('sha256').update(replacement).digest('hex')})+'\n',{mode:0o600});
  const bad=path.join(base,'tampered');
  await assert.rejects(decrypt(encrypted,priv,bad));
  assert.equal(fs.existsSync(bad),false);
 }finally{writer.close();}
});
