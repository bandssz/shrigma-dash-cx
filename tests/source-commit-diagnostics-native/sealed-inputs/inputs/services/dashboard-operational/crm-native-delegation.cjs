'use strict';
// First-class delegated credentials issued by a real Master consent. They are
// not browser cookies, upstream credentials, or individual brand IAM grants.
const crypto=require('node:crypto');
const SCOPES=Object.freeze(['crm.read','crm.draft','crm.iam','db.inspect','db.install','crm.source-sync']);
const BRANDS=Object.freeze(['fish','aristo']);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
const deny=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
function createDelegationStore({db,managerHost,consent,identity,mac,now=Date.now}){
 if(!db?.prepare||typeof managerHost!=='string'||[consent,identity,mac,now].some(f=>typeof f!=='function'))throw Error('NATIVE_CONFIG_INVALID');
 db.exec(`CREATE TABLE IF NOT EXISTS crm_native_connections_v1 (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
  host TEXT NOT NULL, label TEXT NOT NULL, brands_json TEXT NOT NULL, scopes_json TEXT NOT NULL,
  auth_revision TEXT NOT NULL, source_session_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER, binding_mac TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_native_connection_audit_v1 (
  id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),
  action TEXT NOT NULL CHECK(action IN ('issue','revoke')), actor_id TEXT NOT NULL REFERENCES users(id), happened_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS crm_native_connection_owner_v1 ON crm_native_connections_v1(user_id);
 CREATE TABLE IF NOT EXISTS crm_native_inspection_consent_v1(
 id INTEGER PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),
 actor_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL,prior_scopes_hash TEXT NOT NULL,
 new_scopes_hash TEXT NOT NULL,happened_at INTEGER NOT NULL,binding_mac TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_native_source_sync_consent_v1(
 id INTEGER PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),
 actor_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL,prior_scopes_hash TEXT NOT NULL,
 new_scopes_hash TEXT NOT NULL,happened_at INTEGER NOT NULL,binding_mac TEXT NOT NULL);`);
 const time=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)deny('NATIVE_CLOCK_INVALID',500);return t;};
 const bind=r=>mac(JSON.stringify([r.id,r.token_hash,r.user_id,r.host,r.label,r.brands_json,r.scopes_json,r.auth_revision,r.source_session_hash,r.created_at,r.expires_at,r.revoked_at]));
 const valid=r=>typeof r?.binding_mac==='string'&&/^[a-f0-9]{64}$/.test(r.binding_mac)&&crypto.timingSafeEqual(Buffer.from(r.binding_mac,'hex'),Buffer.from(bind(r),'hex'));
 const project=r=>({id:r.id,label:r.label,brands:JSON.parse(r.brands_json),scopes:JSON.parse(r.scopes_json),createdAt:r.created_at,expiresAt:r.expires_at,revoked:r.revoked_at!==null});
 function issue({context,label='Shrigma — integração',brands,scopes,expiresDays=7}={}){
  const proof=consent(context); // Original browser authentication + CSRF; no delegated self-issuance.
  if(!plain(proof)||typeof proof.userId!=='string'||!/^[a-f0-9]{64}$/.test(proof.sessionHash||''))deny('NATIVE_CONSENT_REQUIRED');
  if(typeof label!=='string'||label.trim().length<1||label.length>80||/[\u0000-\u001f]/.test(label))deny('NATIVE_LABEL_INVALID',400);
  if(!Array.isArray(brands)||!brands.length||new Set(brands).size!==brands.length||brands.some(b=>!BRANDS.includes(b)))deny('NATIVE_BRANDS_INVALID',400);
  if(!Array.isArray(scopes)||!scopes.length||new Set(scopes).size!==scopes.length||scopes.some(s=>!SCOPES.includes(s)))deny('NATIVE_SCOPES_INVALID',400);
  if(!Number.isInteger(expiresDays)||expiresDays<1||expiresDays>30)deny('NATIVE_EXPIRY_INVALID',400);
  const owner=identity(proof.userId);if(!owner||owner.role!=='superadmin'||owner.active!==true||!/^[a-f0-9]{64}$/.test(owner.revision||''))deny('NATIVE_OWNER_REQUIRED');
  if((scopes.includes('crm.draft')||scopes.includes('crm.source-sync'))&&owner.canEditGrowth!==true)deny('GRANT_DENIED');
  const t=time(),token=crypto.randomBytes(32).toString('base64url');
  const row={id:crypto.randomUUID(),token_hash:sha(token),user_id:proof.userId,host:managerHost,label:label.trim(),brands_json:JSON.stringify([...brands].sort()),scopes_json:JSON.stringify([...scopes].sort()),auth_revision:owner.revision,source_session_hash:proof.sessionHash,created_at:t,expires_at:t+expiresDays*86400000,revoked_at:null};
  row.binding_mac=bind(row);
  db.exec('BEGIN IMMEDIATE');try{
   if(db.prepare('SELECT COUNT(*) AS n FROM crm_native_connections_v1 WHERE user_id=? AND revoked_at IS NULL AND expires_at>?').get(proof.userId,t).n>=8)deny('NATIVE_CONNECTION_LIMIT',409);
   db.prepare('INSERT INTO crm_native_connections_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.token_hash,row.user_id,row.host,row.label,row.brands_json,row.scopes_json,row.auth_revision,row.source_session_hash,row.created_at,row.expires_at,row.revoked_at,row.binding_mac);
   db.prepare("INSERT INTO crm_native_connection_audit_v1(connection_id,action,actor_id,happened_at) VALUES(?,'issue',?,?)").run(row.id,proof.userId,t);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {connection:project(row),token}; // Private operator response only, once.
 }
 function authenticate(token,{scope,brand}={}){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))deny('NATIVE_AUTH_REQUIRED',401);
  const row=db.prepare('SELECT * FROM crm_native_connections_v1 WHERE token_hash=?').get(sha(token));
  if(!row||!valid(row)||row.revoked_at!==null||row.expires_at<=time())deny('NATIVE_AUTH_REQUIRED',401);
  const owner=identity(row.user_id);
  if(!owner||owner.role!=='superadmin'||owner.active!==true||owner.revision!==row.auth_revision)deny('NATIVE_AUTH_REQUIRED',401);
  const view=project(row);
  if(scope!==undefined&&!view.scopes.includes(scope))deny('NATIVE_SCOPE_DENIED');
  if(brand!==undefined&&!view.brands.includes(brand))deny('BRAND_DENIED');
  return {...view,userId:row.user_id,host:row.host};
 }
 function context(token,needs={}){
  const proof=authenticate(token,needs);
  return {nativeBearer:token,host:proof.host,method:'GET',origin:'https://'+proof.host,csrf:mac('native-csrf:'+token)};
 }
 function list(context){const proof=consent(context);return db.prepare('SELECT * FROM crm_native_connections_v1 WHERE user_id=? ORDER BY created_at,id').all(proof.userId).filter(valid).map(project);}
 function revoke({context,connectionId}={}){
  const proof=consent(context),row=db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=? AND user_id=?').get(connectionId,proof.userId);
  if(!row||!valid(row))deny('NATIVE_CONNECTION_NOT_FOUND',404);
  db.exec('BEGIN IMMEDIATE');try{
   const revokedAt=time(),updated={...row,revoked_at:revokedAt};
   const changed=db.prepare('UPDATE crm_native_connections_v1 SET revoked_at=?,binding_mac=? WHERE id=? AND revoked_at IS NULL').run(revokedAt,bind(updated),row.id).changes;
   if(changed)db.prepare("INSERT INTO crm_native_connection_audit_v1(connection_id,action,actor_id,happened_at) VALUES(?,'revoke',?,?)").run(row.id,proof.userId,revokedAt);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {id:row.id,revoked:true};
 }
 function permitInspection({context,connectionId}={}){
  const proof=consent(context),owner=identity(proof.userId);
  if(!owner||owner.role!=='superadmin'||owner.active!==true||!/^[a-f0-9]{64}$/.test(proof.sessionHash||''))deny('NATIVE_OWNER_REQUIRED');
  if(typeof connectionId!=='string'||!/^[a-f0-9-]{36}$/.test(connectionId))deny('NATIVE_CONNECTION_NOT_FOUND',404);
  db.exec('BEGIN IMMEDIATE');try{
   const row=db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=? AND user_id=?').get(connectionId,proof.userId);
   if(!row||!valid(row)||row.revoked_at!==null||row.expires_at<=time()||owner.revision!==row.auth_revision)deny('NATIVE_CONNECTION_NOT_FOUND',404);
   const before=project(row);if(before.scopes.includes('db.inspect')){db.exec('COMMIT');return {connection:before,inspectionAuthorized:true,installationAuthorized:before.scopes.includes('db.install')};}
   const next={...row,scopes_json:JSON.stringify([...before.scopes,'db.inspect'].sort())},t=time();next.binding_mac=bind(next);
   const changed=db.prepare('UPDATE crm_native_connections_v1 SET scopes_json=?,binding_mac=? WHERE id=? AND binding_mac=? AND revoked_at IS NULL').run(next.scopes_json,next.binding_mac,row.id,row.binding_mac).changes;
   if(changed!==1)deny('NATIVE_CONNECTION_CHANGED',409);
   const fields=[row.id,proof.userId,proof.sessionHash,sha(row.scopes_json),sha(next.scopes_json),t];
   db.prepare('INSERT INTO crm_native_inspection_consent_v1(connection_id,actor_id,session_hash,prior_scopes_hash,new_scopes_hash,happened_at,binding_mac) VALUES(?,?,?,?,?,?,?)').run(...fields,mac(JSON.stringify(['db-inspection-consent-v1',...fields])));
   db.exec('COMMIT');return {connection:project(next),inspectionAuthorized:true,installationAuthorized:before.scopes.includes('db.install')};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function permitSourceSync({context,connectionId}={}){
  const proof=consent(context),owner=identity(proof.userId);
  if(!owner||owner.role!=='superadmin'||owner.active!==true||owner.canEditGrowth!==true||!/^[a-f0-9]{64}$/.test(owner.revision||'')||!/^[a-f0-9]{64}$/.test(proof.sessionHash||''))deny('NATIVE_OWNER_REQUIRED');
  if(typeof connectionId!=='string'||!/^[a-f0-9-]{36}$/.test(connectionId))deny('NATIVE_CONNECTION_NOT_FOUND',404);
  db.exec('BEGIN IMMEDIATE');try{
   const row=db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=? AND user_id=?').get(connectionId,proof.userId);
   if(!row||!valid(row)||row.revoked_at!==null||row.expires_at<=time()||owner.revision!==row.auth_revision)deny('NATIVE_CONNECTION_NOT_FOUND',404);
   const before=project(row);if(before.scopes.includes('crm.source-sync')){db.exec('COMMIT');return {connection:before,sourceSyncAuthorized:true};}
   const next={...row,scopes_json:JSON.stringify([...before.scopes,'crm.source-sync'].sort())},t=time();next.binding_mac=bind(next);
   const changed=db.prepare('UPDATE crm_native_connections_v1 SET scopes_json=?,binding_mac=? WHERE id=? AND binding_mac=? AND revoked_at IS NULL').run(next.scopes_json,next.binding_mac,row.id,row.binding_mac).changes;
   if(changed!==1)deny('NATIVE_CONNECTION_CHANGED',409);
   const fields=[row.id,proof.userId,proof.sessionHash,sha(row.scopes_json),sha(next.scopes_json),t];
   db.prepare('INSERT INTO crm_native_source_sync_consent_v1(connection_id,actor_id,session_hash,prior_scopes_hash,new_scopes_hash,happened_at,binding_mac) VALUES(?,?,?,?,?,?,?)').run(...fields,mac(JSON.stringify(['source-sync-consent-v1',...fields])));
   db.exec('COMMIT');return {connection:project(next),sourceSyncAuthorized:true};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 return Object.freeze({issue,authenticate,context,list,revoke,permitInspection,permitSourceSync});
}
module.exports={createDelegationStore,SCOPES,BRANDS};
