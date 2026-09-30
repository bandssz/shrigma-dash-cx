'use strict';
/** One-shot, secret-free maintenance job for the disposable synthetic canary. */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {decodePack,MAX_PACK_BYTES}=require('./artifact-policy.cjs');
const {createBackup,verifyBackup}=require('./backup-identity.cjs');

const ADMIN='ensaio@shrigma.com.br';
const SNAPSHOT_SCHEMA='dashboard_synthetic_volume_snapshot_v1';
const PACK='runtime-pack.json';
const INDEX='snapshot.json';
const fileFlags=fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code){throw Error(code);}
function stat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function privateDir(dir){
 const s=stat(dir);
 if(!s?.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700||fs.realpathSync(dir)!==dir)fail('CANARY_DIRECTORY_INVALID');
}
function privateFile(file,maxBytes=Number.MAX_SAFE_INTEGER){
 const s=stat(file);
 if(!s?.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>maxBytes||fs.realpathSync(file)!==file)fail('CANARY_FILE_INVALID');
 return s;
}
function packAt(file){
 privateFile(file,MAX_PACK_BYTES);
 const bytes=fs.readFileSync(file);
 if(bytes.length>MAX_PACK_BYTES)fail('CANARY_PACK_INVALID');
 const parsed=JSON.parse(bytes.toString('utf8'));
 const decoded=decodePack(bytes.toString('utf8'),parsed.sha256);
 return {bytes,sha256:decoded.sha256};
}
function canaryIdentity(file){
 privateFile(file);
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const users=db.prepare("SELECT email FROM users WHERE role='superadmin'").all();
  if(users.length!==1||users[0].email!==ADMIN)fail('CANARY_IDENTITY_INVALID');
 }finally{db.close();}
}
function writeExclusive(file,bytes){
 const fd=fs.openSync(file,fileFlags,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 privateFile(file);
}
function copyExclusive(source,target){
 privateFile(source);
 const from=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const to=fs.openSync(target,fileFlags,0o600);
  try{
   const buffer=Buffer.alloc(64*1024);let count;
   while((count=fs.readSync(from,buffer,0,buffer.length,null))>0){
    let offset=0;while(offset<count){const written=fs.writeSync(to,buffer,offset,count-offset);if(written<=0)fail('CANARY_COPY_INVALID');offset+=written;}
   }
   fs.fsyncSync(to);
  }finally{fs.closeSync(to);}
 }finally{fs.closeSync(from);}
 privateFile(target);
}
function snapshotName(name){if(typeof name!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))fail('CANARY_SNAPSHOT_NAME_INVALID');return name;}
function expectedContents(dir,names){
 if(fs.readdirSync(dir).sort().join(',')!==names.slice().sort().join(','))fail('CANARY_CONTENTS_INVALID');
}
function preflightCanary({sourceDir='/source-data'}={}){
 privateDir(sourceDir);
 packAt(path.join(sourceDir,PACK));
 canaryIdentity(path.join(sourceDir,'dashboard.sqlite'));
 return {ready:true};
}
async function verifySnapshot(name,{backupRoot='/backup-data'}={}){
 snapshotName(name);privateDir(backupRoot);
 const snapshot=path.join(backupRoot,name);privateDir(snapshot);
 expectedContents(snapshot,['identity',PACK,INDEX]);
 const packed=packAt(path.join(snapshot,PACK));
 const identity=await verifyBackup(path.join(snapshot,'identity'));
 privateFile(path.join(snapshot,INDEX),4096);
 let index;try{index=JSON.parse(fs.readFileSync(path.join(snapshot,INDEX),'utf8'));}catch{fail('CANARY_INDEX_INVALID');}
 if(!index||typeof index!=='object'||Array.isArray(index)||Object.keys(index).sort().join(',')!=='identitySha256,packSha256,schema'||index.schema!==SNAPSHOT_SCHEMA||index.identitySha256!==identity.sha256||index.packSha256!==packed.sha256)fail('CANARY_INDEX_INVALID');
 return {snapshot,pack:path.join(snapshot,PACK),identity:identity.database,packSha256:packed.sha256,identitySha256:identity.sha256};
}
async function backupCanary(name,{sourceDir='/source-data',backupRoot='/backup-data'}={}){
 snapshotName(name);privateDir(sourceDir);privateDir(backupRoot);
 expectedContents(backupRoot,[]);
 const sourceDb=path.join(sourceDir,'dashboard.sqlite'),sourcePack=path.join(sourceDir,PACK);
 const originalPack=packAt(sourcePack);
 canaryIdentity(sourceDb);
 const snapshot=path.join(backupRoot,name);
 if(stat(snapshot))fail('CANARY_SNAPSHOT_EXISTS');
 fs.mkdirSync(snapshot,{mode:0o700});
 try{
  privateDir(snapshot);
  const identity=await createBackup(sourceDb,path.join(snapshot,'identity'));
  const currentPack=packAt(sourcePack);
  if(sha(currentPack.bytes)!==sha(originalPack.bytes))fail('CANARY_PACK_CHANGED');
  writeExclusive(path.join(snapshot,PACK),currentPack.bytes);
  writeExclusive(path.join(snapshot,INDEX),Buffer.from(JSON.stringify({schema:SNAPSHOT_SCHEMA,packSha256:currentPack.sha256,identitySha256:identity.sha256})+'\n'));
  return await verifySnapshot(name,{backupRoot});
 }catch(e){fs.rmSync(snapshot,{recursive:true,force:true});throw e;}
}
async function restoreCanary(name,{backupRoot='/backup-data',restoreDir='/restore-data'}={}){
 const snapshot=await verifySnapshot(name,{backupRoot});
 const dir=stat(restoreDir);
 if(!dir?.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||fs.realpathSync(restoreDir)!==restoreDir)fail('CANARY_RESTORE_DIR_INVALID');
 if(fs.readdirSync(restoreDir).length)fail('CANARY_RESTORE_NOT_EMPTY');
 // Easypanel may reset mode on a new volume. Only this empty, owned volume
 // can be corrected; the source and snapshot volumes are never chmodded.
 fs.chmodSync(restoreDir,0o700);privateDir(restoreDir);
 const pack=path.join(restoreDir,PACK),database=path.join(restoreDir,'dashboard.sqlite');
 let createdPack=false,createdDb=false;
 try{
  createdPack=true;writeExclusive(pack,fs.readFileSync(snapshot.pack));
  createdDb=true;copyExclusive(snapshot.identity,database);
  if(sha(fs.readFileSync(database))!==snapshot.identitySha256||packAt(pack).sha256!==snapshot.packSha256)fail('CANARY_RESTORE_HASH_INVALID');
  canaryIdentity(database);
  const db=new DatabaseSync(database,{readOnly:true});
  try{
   if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)fail('CANARY_RESTORE_INTEGRITY_INVALID');
  }finally{db.close();}
  expectedContents(restoreDir,[PACK,'dashboard.sqlite']);
  return {restored:true};
 }catch(e){if(createdPack)fs.rmSync(pack,{force:true});if(createdDb)fs.rmSync(database,{force:true});throw e;}
}
if(require.main===module){
 const [action,name,...extra]=process.argv.slice(2);
 const preflight=action==='preflight'&&name===undefined;
 const hold=action==='preflight-hold'&&name===undefined;
 const run=preflight||hold?Promise.resolve().then(()=>preflightCanary()).then(()=>hold?new Promise(resolve=>setTimeout(resolve,90000)):undefined):extra.length===0&&action==='backup'?backupCanary(name):extra.length===0&&action==='verify'?verifySnapshot(name):extra.length===0&&action==='restore'?restoreCanary(name):Promise.reject(Error('CANARY_USAGE_INVALID'));
 run.then(()=>console.log('Synthetic canary maintenance verified.')).catch(()=>{console.error('Synthetic canary maintenance refused.');process.exitCode=1;});
}
module.exports={ADMIN,SNAPSHOT_SCHEMA,preflightCanary,backupCanary,verifySnapshot,restoreCanary};
