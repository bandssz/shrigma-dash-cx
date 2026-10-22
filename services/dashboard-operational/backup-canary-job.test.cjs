'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {DatabaseSync}=require('node:sqlite');
const {createAuth}=require('./auth.cjs');
const policy=require('./artifact-policy.cjs');
const image=require('./canary-image.cjs');
const canary=require('./canary-start.cjs');
const {ADMIN,preflightCanary,backupCanary,verifySnapshot,restoreCanary,restoreShadowCanary}=require('./backup-canary-job.cjs');

function temporary(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-canary-backup-test-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function directory(root,name){const result=path.join(root,name);fs.mkdirSync(result,{mode:0o700});return result;}
function fakePack(file,marker='synthetic'){
 const files=policy.FILES.map(name=>({path:name,encoding:policy.isText(name)?'utf8':'base64',content:policy.isText(name)?marker:'AQID'}));
 const raw=Buffer.from(JSON.stringify(files)),sha256=crypto.createHash('sha256').update(raw).digest('hex');
 fs.writeFileSync(file,JSON.stringify({schema:policy.SCHEMA,sha256,gzipBase64:zlib.gzipSync(raw).toString('base64')}),{mode:0o600});
 return sha256;
}
function seedNewPack(root,targetDir){
 const imageDir=directory(root,'new-image'),sha256=fakePack(path.join(imageDir,'runtime-pack.json'),'new-image-pack');
 fs.writeFileSync(path.join(imageDir,'image-pin.json'),JSON.stringify({schema:image.IMAGE_SCHEMA,baseImage:image.IMAGE,sourceRevision:'a'.repeat(40),packSha256:sha256}),{mode:0o600});
 const result=canary.seedVolume({dataDir:targetDir,imageDir,expectedUid:process.getuid(),expectedGid:process.getgid()});
 assert.equal(result.seeded,true);
 assert.deepEqual(fs.readdirSync(targetDir),['runtime-pack.json']);
 return sha256;
}
function syntheticAuth(dbPath,email=ADMIN){
 const token=crypto.randomBytes(32).toString('hex');
 const options={dbPath,managerHost:'manager.synthetic.invalid',areaHosts:{growth:'growth.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'},allowedEmailDomains:['shrigma.com.br','synthetic.invalid'],bootstrapAdminEmail:email,bootstrapTokenSha256:crypto.createHash('sha256').update(token).digest('hex'),encryptionKey:crypto.randomBytes(32)};
 const context={email,token,host:options.managerHost,origin:'https://'+options.managerHost};
 return {auth:createAuth(options),options,context};
}
function storage(root){return {sourceDir:directory(root,'source'),backupRoot:directory(root,'backups'),restoreDir:directory(root,'restore')};}

test('job snapshots a live synthetic identity and restores a fresh volume with matching key',async t=>{
 const root=temporary(t),paths=storage(root),dbPath=path.join(paths.sourceDir,'dashboard.sqlite');
 fakePack(path.join(paths.sourceDir,'runtime-pack.json'));
 const {auth,options,context}=syntheticAuth(dbPath);
 try{
  assert.ok(fs.statSync(dbPath+'-wal').size>0);
  assert.deepEqual(preflightCanary(paths),{ready:true});
  const original=auth.beginBootstrap(context);
  const snapshot=await backupCanary('snapshot-01',paths);
  assert.equal(snapshot.snapshot,path.join(paths.backupRoot,'snapshot-01'));
  assert.deepEqual(fs.readdirSync(snapshot.snapshot).sort(),['identity','runtime-pack.json','snapshot.json'].sort());
  await assert.rejects(backupCanary('snapshot-04',paths),/CANARY_CONTENTS_INVALID/);
  await verifySnapshot('snapshot-01',paths);
  fs.chmodSync(paths.restoreDir,0o755);
  assert.deepEqual(await restoreCanary('snapshot-01',paths),{restored:true});
  assert.equal(fs.statSync(paths.restoreDir).mode&0o777,0o700);
  assert.deepEqual(fs.readdirSync(paths.restoreDir).sort(),['dashboard.sqlite','runtime-pack.json']);
  for(const file of fs.readdirSync(paths.restoreDir))assert.equal(fs.statSync(path.join(paths.restoreDir,file)).mode&0o777,0o600);
  const restored=createAuth({...options,dbPath:path.join(paths.restoreDir,'dashboard.sqlite')});
  try{assert.deepEqual(restored.beginBootstrap(context),original);}finally{restored.close();}
 }finally{auth.close();}
});

test('job refuses a different identity, symlink package and occupied restore volume',async t=>{
 const root=temporary(t),paths=storage(root),dbPath=path.join(paths.sourceDir,'dashboard.sqlite'),pack=path.join(paths.sourceDir,'runtime-pack.json');
 fakePack(pack);
 const {auth}=syntheticAuth(dbPath,'other@synthetic.invalid');
 try{
  assert.throws(()=>preflightCanary(paths),/CANARY_IDENTITY_INVALID/);
  await assert.rejects(backupCanary('wrong-identity',paths),/CANARY_IDENTITY_INVALID/);
  assert.equal(fs.existsSync(path.join(paths.backupRoot,'wrong-identity')),false);
 }finally{auth.close();}
 const db=new DatabaseSync(dbPath);
 db.prepare("UPDATE users SET email=? WHERE role='superadmin'").run(ADMIN);db.close();
 fs.renameSync(pack,path.join(paths.sourceDir,'pack-real.json'));
 fs.symlinkSync(path.join(paths.sourceDir,'pack-real.json'),pack);
 await assert.rejects(backupCanary('linked-pack',paths),/CANARY_FILE_INVALID/);
 fs.unlinkSync(pack);fs.renameSync(path.join(paths.sourceDir,'pack-real.json'),pack);
 await backupCanary('snapshot-02',paths);
 fs.writeFileSync(path.join(paths.restoreDir,'sentinel'),'preserve',{mode:0o600});
 await assert.rejects(restoreCanary('snapshot-02',paths),/CANARY_RESTORE_NOT_EMPTY/);
 assert.equal(fs.readFileSync(path.join(paths.restoreDir,'sentinel'),'utf8'),'preserve');
});

test('job rejects a changed backup before touching a fresh restore volume',async t=>{
 const root=temporary(t),paths=storage(root),dbPath=path.join(paths.sourceDir,'dashboard.sqlite');
 fakePack(path.join(paths.sourceDir,'runtime-pack.json'));
 const {auth}=syntheticAuth(dbPath);
 try{await backupCanary('snapshot-03',paths);}finally{auth.close();}
 fs.appendFileSync(path.join(paths.backupRoot,'snapshot-03','identity','identity.sqlite'),'corruption');
 await assert.rejects(restoreCanary('snapshot-03',paths),/BACKUP_MANIFEST_INVALID/);
 assert.deepEqual(fs.readdirSync(paths.restoreDir),[]);
});

test('shadow update seeds the new pack without a database and restores only a WAL-consistent synthetic identity',async t=>{
 const root=temporary(t),paths=storage(root),dbPath=path.join(paths.sourceDir,'dashboard.sqlite');
 const oldSha=fakePack(path.join(paths.sourceDir,'runtime-pack.json'),'old-image-pack');
 const newSha=seedNewPack(root,paths.restoreDir);
 assert.notEqual(newSha,oldSha);
 const seededPack=path.join(paths.restoreDir,'runtime-pack.json'),seededBytes=fs.readFileSync(seededPack),seededInode=fs.statSync(seededPack).ino;
 const {auth,options,context}=syntheticAuth(dbPath);
 try{
  assert.ok(fs.statSync(dbPath+'-wal').size>0);
  const original=auth.beginBootstrap(context);
  await backupCanary('shadow-snapshot',paths);
  assert.deepEqual(await restoreShadowCanary('shadow-snapshot',newSha,paths),{restored:true,packSha256:newSha});
  assert.deepEqual(fs.readdirSync(paths.restoreDir).sort(),['dashboard.sqlite','runtime-pack.json']);
  assert.deepEqual(fs.readFileSync(seededPack),seededBytes);
  assert.equal(fs.statSync(seededPack).ino,seededInode);
  const restoredPath=path.join(paths.restoreDir,'dashboard.sqlite');
  assert.throws(()=>createAuth({...options,dbPath:restoredPath,encryptionKey:crypto.randomBytes(32)}),/CREDENTIAL_UNAVAILABLE/);
  const restored=createAuth({...options,dbPath:restoredPath});
  try{assert.deepEqual(restored.beginBootstrap(context),original);}finally{restored.close();}
  assert.equal(fs.statSync(dbPath+'-wal').isFile(),true);
 }finally{auth.close();}
});

test('shadow restore refuses a wrong pack pin, occupied target, preexisting database and symlink without changing them',async t=>{
 const root=temporary(t),paths=storage(root),dbPath=path.join(paths.sourceDir,'dashboard.sqlite');
 const oldSha=fakePack(path.join(paths.sourceDir,'runtime-pack.json'),'old-image-pack');
 const newSha=seedNewPack(root,paths.restoreDir);
 const {auth}=syntheticAuth(dbPath);
 try{await backupCanary('shadow-denials',paths);}finally{auth.close();}
 const pack=path.join(paths.restoreDir,'runtime-pack.json'),seeded=fs.readFileSync(pack);
 await assert.rejects(restoreShadowCanary('shadow-denials',oldSha,paths),/CANARY_SHADOW_PACK_MISMATCH/);
 await assert.rejects(restoreShadowCanary('shadow-denials','invalid',paths),/CANARY_SHADOW_PIN_INVALID/);
 assert.deepEqual(fs.readdirSync(paths.restoreDir),['runtime-pack.json']);
 const sentinel=path.join(paths.restoreDir,'sentinel');fs.writeFileSync(sentinel,'preserve',{mode:0o600});
 await assert.rejects(restoreShadowCanary('shadow-denials',newSha,paths),/CANARY_CONTENTS_INVALID/);
 assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve');fs.unlinkSync(sentinel);
 const occupied=path.join(paths.restoreDir,'dashboard.sqlite');fs.writeFileSync(occupied,'preserve',{mode:0o600});
 await assert.rejects(restoreShadowCanary('shadow-denials',newSha,paths),/CANARY_CONTENTS_INVALID/);
 assert.equal(fs.readFileSync(occupied,'utf8'),'preserve');fs.unlinkSync(occupied);
 fs.renameSync(pack,path.join(paths.restoreDir,'real-pack.json'));
 fs.symlinkSync(path.join(paths.restoreDir,'real-pack.json'),pack);
 await assert.rejects(restoreShadowCanary('shadow-denials',newSha,paths),/CANARY_CONTENTS_INVALID/);
 assert.equal(fs.readFileSync(path.join(paths.restoreDir,'real-pack.json')).equals(seeded),true);
});
