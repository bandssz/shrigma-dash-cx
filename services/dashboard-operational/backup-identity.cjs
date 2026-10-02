'use strict';
/**
 * Offline operator utility. This file is deliberately outside the runtime pack.
 *
 *   node backup-identity.cjs backup /dashboard-data/dashboard.sqlite /private/backup-parent/new-backup
 *   node backup-identity.cjs verify /private/backup-parent/new-backup
 *
 * The parent of a new backup must already be owned by the caller and mode 0700.
 * The utility never reads or stores DASHBOARD_ENCRYPTION_KEY. Keep the unchanged
 * key separately in the secret manager for recovery of encrypted credentials.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');

const SCHEMA='dashboard_identity_backup_v1';
const DATABASE='identity.sqlite';
const MANIFEST='manifest.json';
const uid=process.getuid?.();

function fail(code){throw Error(code);}
function fileStat(file){
 try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function absolute(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)fail('BACKUP_PATH_INVALID');
 return file;
}
function privateDirectory(dir){
 absolute(dir);
 const stat=fileStat(dir);
 if(!stat?.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o777)!==0o700||fs.realpathSync(dir)!==dir)fail('BACKUP_DIRECTORY_INVALID');
 return stat;
}
function privateFile(file){
 absolute(file);
 const stat=fileStat(file);
 if(!stat?.isFile()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o777)!==0o600||fs.realpathSync(file)!==file)fail('BACKUP_FILE_INVALID');
 return stat;
}
function sourceFiles(file){
 privateDirectory(path.dirname(file));
 const main=privateFile(file);
 for(const sidecar of [file+'-wal',file+'-shm'])if(fileStat(sidecar))privateFile(sidecar);
 return main;
}
function integrity(file,{writable=false}={}){
 const db=new DatabaseSync(file,{readOnly:!writable});
 try{
  if(writable){
   // The snapshot is otherwise a WAL-mode file. Convert it to a single-file
   // archive before hashing so restore needs only identity.sqlite.
   db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
   const mode=db.prepare('PRAGMA journal_mode=DELETE').get();
   if(mode.journal_mode!=='delete')fail('BACKUP_JOURNAL_INVALID');
  }
  const result=db.prepare('PRAGMA integrity_check').all();
  if(result.length!==1||result[0].integrity_check!=='ok')fail('BACKUP_INTEGRITY_INVALID');
  if(db.prepare('PRAGMA foreign_key_check').all().length)fail('BACKUP_FOREIGN_KEYS_INVALID');
 }finally{db.close();}
}
async function digest(file){
 const hash=crypto.createHash('sha256');
 for await(const chunk of fs.createReadStream(file))hash.update(chunk);
 return hash.digest('hex');
}
function manifestValid(data){
 return data&&typeof data==='object'&&!Array.isArray(data)&&
  Object.keys(data).sort().join(',')==='bytes,createdAt,schema,sha256'&&
  data.schema===SCHEMA&&Number.isSafeInteger(data.bytes)&&data.bytes>0&&
  typeof data.sha256==='string'&&/^[a-f0-9]{64}$/.test(data.sha256)&&
  typeof data.createdAt==='string'&&!Number.isNaN(Date.parse(data.createdAt));
}
async function verifyBackup(backupDir){
 privateDirectory(absolute(backupDir));
 const names=fs.readdirSync(backupDir).sort();
 if(names.join(',')!==[DATABASE,MANIFEST].sort().join(','))fail('BACKUP_CONTENTS_INVALID');
 const database=path.join(backupDir,DATABASE),manifest=path.join(backupDir,MANIFEST);
 const dbStat=privateFile(database),manifestStat=privateFile(manifest);
 if(manifestStat.size>4096)fail('BACKUP_MANIFEST_INVALID');
 let data;try{data=JSON.parse(fs.readFileSync(manifest,'utf8'));}catch{fail('BACKUP_MANIFEST_INVALID');}
 if(!manifestValid(data)||data.bytes!==dbStat.size||data.sha256!==await digest(database))fail('BACKUP_MANIFEST_INVALID');
 integrity(database);
 return {database,manifest,bytes:data.bytes,sha256:data.sha256};
}
async function createBackup(sourceDbPath,backupDir){
 if(typeof backup!=='function')fail('BACKUP_UNAVAILABLE');
 absolute(sourceDbPath);absolute(backupDir);
 const original=sourceFiles(sourceDbPath);
 privateDirectory(path.dirname(backupDir));
 if(fileStat(backupDir))fail('BACKUP_TARGET_EXISTS');
 fs.mkdirSync(backupDir,{mode:0o700});
 try{
  privateDirectory(backupDir);
  const database=path.join(backupDir,DATABASE),manifest=path.join(backupDir,MANIFEST);
  const fd=fs.openSync(database,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  fs.closeSync(fd);
  const source=new DatabaseSync(sourceDbPath,{readOnly:true});
  try{source.exec('PRAGMA busy_timeout=5000');await backup(source,database);}finally{source.close();}
  const after=sourceFiles(sourceDbPath);
  if(after.dev!==original.dev||after.ino!==original.ino)fail('BACKUP_SOURCE_CHANGED');
  privateFile(database);
  integrity(database,{writable:true});
  privateFile(database);
  for(const sidecar of [database+'-wal',database+'-shm'])if(fileStat(sidecar))fail('BACKUP_CONTENTS_INVALID');
  const data={schema:SCHEMA,createdAt:new Date().toISOString(),bytes:fs.statSync(database).size,sha256:await digest(database)};
  fs.writeFileSync(manifest,JSON.stringify(data)+'\n',{flag:'wx',mode:0o600});
  return await verifyBackup(backupDir);
 }catch(error){fs.rmSync(backupDir,{recursive:true,force:true});throw error;}
}

if(require.main===module){
 const [action,...args]=process.argv.slice(2);
 const run=action==='backup'&&args.length===2?createBackup(...args):action==='verify'&&args.length===1?verifyBackup(args[0]):Promise.reject(Error('BACKUP_USAGE_INVALID'));
 run.then(()=>console.log('Identity backup verified.')).catch(()=>{console.error('Identity backup refused.');process.exitCode=1;});
}
module.exports={SCHEMA,DATABASE,MANIFEST,createBackup,verifyBackup};
