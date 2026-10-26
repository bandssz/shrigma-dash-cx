'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const AREAS={growth:'growth',organico:'organico',influs:'influs',afiliados:'influs'};
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
function create({db,dbPath,authorize,revision,now=Date.now}){
 if(!db||typeof authorize!=='function')fail('MAINTENANCE_CONFIG_INVALID',500);
 const migration={created:false,backupCreated:false};
 if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_maintenance_notice'").get()){
  if(dbPath!==':memory:'){
   const dir=path.join(path.dirname(dbPath),'maintenance-backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});
   if(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink())fail('MAINTENANCE_BACKUP_UNAVAILABLE',503);
   fs.chmodSync(dir,0o700);const file=path.join(dir,'before-maintenance-v1-'+crypto.randomUUID()+'.sqlite');
   db.exec("VACUUM INTO '"+file.replaceAll("'","''")+"'");fs.chmodSync(file,0o600);
   if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).size<1)fail('MAINTENANCE_BACKUP_UNAVAILABLE',503);
   migration.backupCreated=true;
  }
  db.exec(`CREATE TABLE product_maintenance_notice (id INTEGER PRIMARY KEY CHECK(id=1),target_revision TEXT NOT NULL,restart_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,audience TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)`);migration.created=true;
 }
 function read(context,q){
  if(!q||Object.keys(q).some(k=>!['brand','front'].includes(k))||!Object.hasOwn(AREAS,q.front)||!['aristo','fish'].includes(q.brand))fail('MAINTENANCE_CONTEXT_INVALID');
  const user=authorize({...context,area:AREAS[q.front],productFront:q.front,brand:q.brand,edit:false}),stamp=now();
  const row=db.prepare('SELECT * FROM product_maintenance_notice WHERE id=1').get();
  const qa=/^editor-qa-(?:aristo|fish)@shrigma\.com\.br$/i.test(user.email||'');
  const editor=user.role==='superadmin'||user.permissions?.[AREAS[q.front]]?.edit===true;
  const active=!!(row&&editor&&stamp<row.expires_at&&row.target_revision!==revision&&(row.audience==='editors'||qa||user.role==='superadmin'));
  return {active,serverTime:new Date(stamp).toISOString(),...(active?{restartAt:new Date(row.restart_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()}:{} )};
 }
 function set(context,q){
  if(context.method!=='POST')fail('METHOD_DENIED',405);const user=authorize({...context,admin:true}),stamp=now();
  if(!q||Object.keys(q).sort().join(',')!=='audience,expiresAt,restartAt,targetRevision'||!['qa','editors'].includes(q.audience)||!/^[a-f0-9]{40}$/.test(q.targetRevision||''))fail('MAINTENANCE_NOTICE_INVALID');
  const restart=Date.parse(q.restartAt),expires=Date.parse(q.expiresAt);
  if(!Number.isSafeInteger(restart)||!Number.isSafeInteger(expires)||restart<stamp+(q.audience==='editors'?600000:0)||restart>stamp+86400000||expires<=restart||expires>restart+900000)fail('MAINTENANCE_WINDOW_INVALID');
  const before=db.prepare('SELECT * FROM product_maintenance_notice WHERE id=1').get()||null;
  db.prepare(`INSERT INTO product_maintenance_notice VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET target_revision=excluded.target_revision,restart_at=excluded.restart_at,expires_at=excluded.expires_at,audience=excluded.audience,created_by=excluded.created_by,created_at=excluded.created_at`).run(q.targetRevision,restart,expires,q.audience,user.id,stamp);
  return {saved:true,programmedAtUtc:new Date(stamp).toISOString(),targetRevision:q.targetRevision,restartAt:new Date(restart).toISOString(),expiresAt:new Date(expires).toISOString(),audience:q.audience,previous:before?{targetRevision:before.target_revision,restartAt:new Date(before.restart_at).toISOString(),expiresAt:new Date(before.expires_at).toISOString(),audience:before.audience}:null};
 }
 return Object.freeze({read,set,migration:Object.freeze(migration)});
}
module.exports={create};
