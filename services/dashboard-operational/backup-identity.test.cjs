'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {createAuth}=require('./auth.cjs');
const {DATABASE,MANIFEST,createBackup,verifyBackup}=require('./backup-identity.cjs');

function temporary(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-backup-test-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}
function privateDir(parent,name){const dir=path.join(parent,name);fs.mkdirSync(dir,{mode:0o700});return dir;}
function privateDbFiles(file){
 for(const name of [file,file+'-wal',file+'-shm'])if(fs.existsSync(name))fs.chmodSync(name,0o600);
}

test('backup captures active WAL and restores from its single SQLite file',async t=>{
 const root=temporary(t),live=privateDir(root,'live'),source=path.join(live,'dashboard.sqlite');
 const writer=new DatabaseSync(source);
 try{
  writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE events(value TEXT NOT NULL); INSERT INTO events VALUES (\'base\'); PRAGMA wal_checkpoint(TRUNCATE)');
  writer.prepare('INSERT INTO events(value) VALUES (?)').run('committed while WAL is active');
  privateDbFiles(source);
  assert.ok(fs.statSync(source+'-wal').size>0);
  const raw=path.join(root,'raw-main.sqlite');fs.copyFileSync(source,raw);
  const target=path.join(root,'backup');
  const result=await createBackup(source,target);
  assert.equal(result.database,path.join(target,DATABASE));
  assert.equal(fs.statSync(target).mode&0o777,0o700);
  assert.equal(fs.statSync(result.database).mode&0o777,0o600);
  assert.equal(fs.statSync(path.join(target,MANIFEST)).mode&0o777,0o600);
  assert.deepEqual(fs.readdirSync(target).sort(),[DATABASE,MANIFEST].sort());
  assert.deepEqual(await verifyBackup(target),result);
  const rawDb=new DatabaseSync(raw,{readOnly:true});
  try{assert.equal(rawDb.prepare('SELECT count(*) n FROM events').get().n,1);}finally{rawDb.close();}
  const restore=privateDir(root,'restore'),restored=path.join(restore,'dashboard.sqlite');
  fs.copyFileSync(result.database,restored);fs.chmodSync(restored,0o600);
  const db=new DatabaseSync(restored,{readOnly:true});
  try{
   assert.deepEqual(db.prepare('SELECT value FROM events ORDER BY rowid').all().map(row=>row.value),['base','committed while WAL is active']);
   assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
 }finally{writer.close();}
});

test('a copied identity opens with the same synthetic encryption key',async t=>{
 const root=temporary(t),live=privateDir(root,'live'),source=path.join(live,'dashboard.sqlite');
 const token=crypto.randomBytes(32).toString('hex');
 const options={dbPath:source,managerHost:'manager.synthetic.invalid',areaHosts:{growth:'growth.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(token).digest('hex'),encryptionKey:crypto.randomBytes(32)};
 const auth=createAuth(options);
 try{
  privateDbFiles(source);
  assert.ok(fs.statSync(source+'-wal').size>0);
  const context={email:options.bootstrapAdminEmail,token,host:options.managerHost,origin:'https://'+options.managerHost};
  const activation=auth.beginBootstrap(context);
  const backupResult=await createBackup(source,path.join(root,'backup'));
  const restore=privateDir(root,'restore'),restored=path.join(restore,'dashboard.sqlite');
  fs.copyFileSync(backupResult.database,restored);fs.chmodSync(restored,0o600);
  const recovered=createAuth({...options,dbPath:restored});
  try{
   assert.deepEqual(recovered.beginBootstrap(context),activation);
  }finally{recovered.close();}
 }finally{auth.close();}
});

test('backup refuses symlinks, permissive storage and an existing destination',async t=>{
 const root=temporary(t),live=privateDir(root,'live'),source=path.join(live,'dashboard.sqlite');
 const db=new DatabaseSync(source);db.exec('CREATE TABLE t(x)');db.close();privateDbFiles(source);
 const sourceLink=path.join(live,'linked.sqlite');fs.symlinkSync(source,sourceLink);
 await assert.rejects(createBackup(sourceLink,path.join(root,'from-link')),/BACKUP_FILE_INVALID/);
 const wal=source+'-wal';fs.symlinkSync(source,wal);
 await assert.rejects(createBackup(source,path.join(root,'from-wal')),/BACKUP_FILE_INVALID/);
 fs.unlinkSync(wal);
 const link=path.join(root,'parent-link');fs.symlinkSync(root,link);
 await assert.rejects(createBackup(source,path.join(link,'new')),/BACKUP_DIRECTORY_INVALID/);
 fs.chmodSync(live,0o755);
 await assert.rejects(createBackup(source,path.join(root,'from-open-dir')),/BACKUP_DIRECTORY_INVALID/);
 fs.chmodSync(live,0o700);
 fs.chmodSync(source,0o644);
 await assert.rejects(createBackup(source,path.join(root,'from-open-file')),/BACKUP_FILE_INVALID/);
 fs.chmodSync(source,0o600);
 const target=privateDir(root,'existing');fs.writeFileSync(path.join(target,'sentinel'),'untouched');
 await assert.rejects(createBackup(source,target),/BACKUP_TARGET_EXISTS/);
 assert.equal(fs.readFileSync(path.join(target,'sentinel'),'utf8'),'untouched');
});

test('verification detects changed bytes and CLI reports no source content',async t=>{
 const root=temporary(t),live=privateDir(root,'live'),source=path.join(live,'dashboard.sqlite');
 const db=new DatabaseSync(source);db.exec('CREATE TABLE t(value TEXT); INSERT INTO t VALUES (\'synthetic secret marker\')');db.close();privateDbFiles(source);
 const target=path.join(root,'backup');
 const cli=spawnSync(process.execPath,[path.join(__dirname,'backup-identity.cjs'),'backup',source,target],{encoding:'utf8'});
 assert.equal(cli.status,0);
 assert.equal(cli.stdout.trim(),'Identity backup verified.');
 assert.ok(!cli.stdout.includes('synthetic secret marker')&&!cli.stderr.includes('synthetic secret marker'));
 const verify=spawnSync(process.execPath,[path.join(__dirname,'backup-identity.cjs'),'verify',target],{encoding:'utf8'});
 assert.equal(verify.status,0);
 const file=path.join(target,DATABASE);
 const manifest=path.join(target,MANIFEST),moved=path.join(root,'manifest-private.json');
 fs.renameSync(manifest,moved);fs.symlinkSync(moved,manifest);
 await assert.rejects(verifyBackup(target),/BACKUP_FILE_INVALID/);
 fs.unlinkSync(manifest);fs.renameSync(moved,manifest);
 fs.appendFileSync(file,'corruption');
 await assert.rejects(verifyBackup(target),/BACKUP_MANIFEST_INVALID/);
 const failed=spawnSync(process.execPath,[path.join(__dirname,'backup-identity.cjs'),'verify',target],{encoding:'utf8'});
 assert.equal(failed.status,1);
 assert.match(failed.stderr,/Identity backup refused\.\s*$/);
 assert.ok(!failed.stderr.includes('synthetic secret marker'));
});
