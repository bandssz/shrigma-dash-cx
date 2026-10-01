'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createAuth}=require('./auth.cjs');
const {createBackup}=require('./backup-identity.cjs');
const {configValid,exportBackup,restoreBackup,readReceipt}=require('./backup-s3.cjs');

const config={bucket:'backup-shrigma-test',prefix:'dashboard/identity',endpoint:'https://s3.synthetic.invalid',region:'us-east-1'};
function dir(parent,name){const target=path.join(parent,name);fs.mkdirSync(target,{mode:0o700});return target;}
function temporary(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-backup-s3-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function privateDbFiles(file){for(const name of [file,file+'-wal',file+'-shm'])if(fs.existsSync(name))fs.chmodSync(name,0o600);}
function param(args,name){const index=args.indexOf(name);return index<0?undefined:args[index+1];}
function fakeS3({versioning='Enabled',encryption='AES256'}={}){
 const objects=new Map(),commands=[];let version=0;
 const aws=async args=>{
  commands.push(args);
  const action=args[0];
  if(action==='get-bucket-versioning')return {Status:versioning};
  if(action==='put-object'){
   assert.equal(param(args,'--server-side-encryption'),'AES256');
   const key=param(args,'--key'),value=fs.readFileSync(param(args,'--body')),id='v'+(++version);
   objects.set(key+'@'+id,Buffer.from(value));
   return {VersionId:id,ServerSideEncryption:encryption};
  }
  if(action==='get-object'){
   const key=param(args,'--key'),id=param(args,'--version-id'),value=objects.get(key+'@'+id);
   if(!value)throw Error('FAKE_MISSING_OBJECT');
   fs.writeFileSync(args.at(-1),value);
   return {VersionId:id};
  }
  throw Error('FAKE_COMMAND_INVALID');
 };
 return {aws,objects,commands};
}
function syntheticOptions(dbPath){
 const token=crypto.randomBytes(32).toString('hex');
 return {token,options:{dbPath,managerHost:'manager.synthetic.invalid',areaHosts:{growth:'growth.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(token).digest('hex'),encryptionKey:crypto.randomBytes(32)}};
}

test('exports an active synthetic identity to versioned encrypted objects and restores exact versions',async t=>{
 const root=temporary(t),live=dir(root,'live'),receipts=dir(root,'receipts'),restores=dir(root,'restores');
 const {token,options}=syntheticOptions(path.join(live,'dashboard.sqlite'));
 const auth=createAuth(options),context={email:options.bootstrapAdminEmail,token,host:options.managerHost,origin:'https://'+options.managerHost};
 let secret;
 try{
  secret=auth.beginBootstrap(context).totpSecret;
  privateDbFiles(options.dbPath);
  await createBackup(options.dbPath,path.join(root,'source-snapshot'));
 }finally{auth.close();}
 const remote=fakeS3(),receiptPath=path.join(receipts,'receipt.json');
 assert.deepEqual(await exportBackup(path.join(root,'source-snapshot'),receiptPath,config,remote.aws),{verified:true,receiptPath});
 const receipt=readReceipt(receiptPath,config);
 assert.equal(fs.statSync(receiptPath).mode&0o777,0o600);
 assert.equal(remote.commands.filter(args=>args[0]==='put-object').length,3);
 assert.equal(remote.commands.filter(args=>args[0]==='get-object').length,3);
 assert.notEqual(receipt.objects['identity.sqlite'].versionId,'null');
 assert.ok(!JSON.stringify(receipt).includes(token));
 const remoteReceiptKey=[...remote.objects.keys()].find(key=>key.startsWith(receipt.receiptKey+'@'));
 assert.ok(remoteReceiptKey);
 const recoveredReceipt=path.join(receipts,'recovered.json');
 fs.writeFileSync(recoveredReceipt,remote.objects.get(remoteReceiptKey),{mode:0o600});
 fs.rmSync(receiptPath);
 assert.deepEqual(readReceipt(recoveredReceipt,config),receipt);
 const restoredDir=path.join(restores,'new-snapshot');
 assert.deepEqual(await restoreBackup(recoveredReceipt,restoredDir,config,remote.aws),{verified:true,targetDir:restoredDir});
 assert.deepEqual(fs.readdirSync(restoredDir).sort(),['identity.sqlite','manifest.json']);
 const recovered=createAuth({...options,dbPath:path.join(restoredDir,'identity.sqlite')});
 try{assert.equal(recovered.beginBootstrap(context).totpSecret,secret);}finally{recovered.close();}
 assert.equal(fs.statSync(restoredDir).mode&0o777,0o700);
 for(const file of fs.readdirSync(restoredDir))assert.equal(fs.statSync(path.join(restoredDir,file)).mode&0o777,0o600);
});

test('refuses unversioned or unencrypted buckets before writing a receipt',async t=>{
 const root=temporary(t),source=dir(root,'source'),receipts=dir(root,'receipts'),dbFile=path.join(source,'dashboard.sqlite');
 const db=new DatabaseSync(dbFile);db.exec('CREATE TABLE t (value TEXT); INSERT INTO t VALUES (\'synthetic\')');db.close();privateDbFiles(dbFile);
 await createBackup(dbFile,path.join(root,'snapshot'));
 const noVersion=fakeS3({versioning:'Suspended'}),first=path.join(receipts,'first.json');
 await assert.rejects(exportBackup(path.join(root,'snapshot'),first,config,noVersion.aws),/S3_VERSIONING_REQUIRED/);
 assert.equal(noVersion.commands.filter(args=>args[0]==='put-object').length,0);
 assert.equal(fs.existsSync(first),false);
 const noEncryption=fakeS3({encryption:null}),second=path.join(receipts,'second.json');
 await assert.rejects(exportBackup(path.join(root,'snapshot'),second,config,noEncryption.aws),/S3_ENCRYPTION_REQUIRED/);
 assert.equal(fs.existsSync(second),false);
 assert.equal(fs.readdirSync(receipts).length,0);
});

test('restoration rejects altered exact version and preserves an occupied destination',async t=>{
 const root=temporary(t),source=dir(root,'source'),receipts=dir(root,'receipts'),restores=dir(root,'restores'),dbFile=path.join(source,'dashboard.sqlite');
 const db=new DatabaseSync(dbFile);db.exec('CREATE TABLE t (value TEXT); INSERT INTO t VALUES (\'synthetic\')');db.close();privateDbFiles(dbFile);
 await createBackup(dbFile,path.join(root,'snapshot'));
 const remote=fakeS3(),receiptPath=path.join(receipts,'receipt.json');
 await exportBackup(path.join(root,'snapshot'),receiptPath,config,remote.aws);
 const occupied=dir(restores,'occupied');fs.writeFileSync(path.join(occupied,'sentinel'),'untouched',{mode:0o600});
 await assert.rejects(restoreBackup(receiptPath,occupied,config,remote.aws),/S3_TARGET_EXISTS/);
 assert.equal(fs.readFileSync(path.join(occupied,'sentinel'),'utf8'),'untouched');
 const receipt=readReceipt(receiptPath,config),object=receipt.objects['identity.sqlite'];
 remote.objects.set(object.key+'@'+object.versionId,Buffer.from('tampered'));
 const destination=path.join(restores,'tampered');
 await assert.rejects(restoreBackup(receiptPath,destination,config,remote.aws),/S3_DOWNLOAD_MISMATCH/);
 assert.equal(fs.existsSync(destination),false);
});

test('transport requires a private HTTPS endpoint and valid, isolated key prefix',()=>{
 assert.throws(()=>configValid({...config,endpoint:'http://s3.synthetic.invalid'}),/S3_ENDPOINT_INVALID/);
 assert.throws(()=>configValid({...config,endpoint:'https://user:pass@s3.synthetic.invalid'}),/S3_ENDPOINT_INVALID/);
 assert.throws(()=>configValid({...config,endpoint:'https://s3.synthetic.invalid/bucket'}),/S3_ENDPOINT_INVALID/);
 assert.throws(()=>configValid({...config,prefix:'../identity'}),/S3_PREFIX_INVALID/);
 assert.throws(()=>configValid({...config,prefix:'identity/'}),/S3_PREFIX_INVALID/);
 assert.deepEqual(configValid(config),config);
});
