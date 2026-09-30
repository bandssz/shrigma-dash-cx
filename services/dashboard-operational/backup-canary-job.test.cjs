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
const {ADMIN,preflightCanary,backupCanary,verifySnapshot,restoreCanary}=require('./backup-canary-job.cjs');

function temporary(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-canary-backup-test-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function directory(root,name){const result=path.join(root,name);fs.mkdirSync(result,{mode:0o700});return result;}
function fakePack(file){
 const files=policy.FILES.map(name=>({path:name,encoding:policy.isText(name)?'utf8':'base64',content:policy.isText(name)?'synthetic':'AQID'}));
 const raw=Buffer.from(JSON.stringify(files)),sha256=crypto.createHash('sha256').update(raw).digest('hex');
 fs.writeFileSync(file,JSON.stringify({schema:policy.SCHEMA,sha256,gzipBase64:zlib.gzipSync(raw).toString('base64')}),{mode:0o600});
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
  const original=auth.beginBootstrap(context).totpSecret;
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
  try{assert.ok(crypto.timingSafeEqual(Buffer.from(restored.beginBootstrap(context).totpSecret),Buffer.from(original)));}finally{restored.close();}
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
