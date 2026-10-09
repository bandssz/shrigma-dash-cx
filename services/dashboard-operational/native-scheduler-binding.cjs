'use strict';
// Existing identity SQLite only. A separate purpose record leaves prior native
// scopes and accepted health consents intact. There is no API-user creation.
const crypto=require('node:crypto');
const {credential,createOriginalApiVerifier}=require('./native-scheduler-api-profile.cjs');
const SCOPE='crm.scheduler-diagnostic',RESOURCE='http://comunicacao_listmonk:9000/api/internal/campaign-scan-diagnostic';
const CANDIDATE_IMAGE='sha256:99df3e03214034646e8d188def12664da72aafec9ff3e6bb23ba95219f4926f2';
const CANDIDATE_BINARY='6c8b92fd87c62f562c81f6aa17253f11a382743a0dfa910d0cf5df2f369d1601';
const plain=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const h=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
function createSchedulerBinding({enabled=false,db,current,encrypt,decrypt,mac,now=Date.now,verify=createOriginalApiVerifier()}={}){
 if(!enabled)return undefined;
 if(!db?.prepare||!db?.exec||[current,encrypt,decrypt,mac,now,verify].some(v=>typeof v!=='function'))fail('SCHEDULER_BINDING_CONFIGURATION_REFUSED',500);
 const time=()=>{const v=now();if(!Number.isSafeInteger(v)||v<0)fail('SCHEDULER_CLOCK_REFUSED',500);return v;};
 db.exec(`CREATE TABLE IF NOT EXISTS crm_scheduler_api_binding_v1(
  id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),
  authority_hash TEXT NOT NULL,profile_hash TEXT NOT NULL,credential_mac TEXT NOT NULL,
  encrypted_json TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER,binding_mac TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_scheduler_read_consent_v1(
  id INTEGER PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),binding_id TEXT NOT NULL REFERENCES crm_scheduler_api_binding_v1(id),
  owner_id TEXT NOT NULL REFERENCES users(id),authority_hash TEXT NOT NULL,purpose TEXT NOT NULL,resource_hash TEXT NOT NULL,
  candidate_image TEXT NOT NULL,candidate_binary TEXT NOT NULL,happened_at INTEGER NOT NULL,consent_mac TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_scheduler_binding_audit_v1(
  id INTEGER PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),
  binding_id TEXT NOT NULL REFERENCES crm_scheduler_api_binding_v1(id),action TEXT NOT NULL CHECK(action IN ('bind','revoke')),happened_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS crm_scheduler_api_owner_v1 ON crm_scheduler_api_binding_v1(owner_id,connection_id,created_at); `);
 const digest=v=>mac(JSON.stringify(v));
 const resourceHash=digest(['scheduler-resource-v1',RESOURCE]);
 const seal=r=>digest(['scheduler-api-binding-v1',r.id,r.owner_id,r.connection_id,r.authority_hash,r.profile_hash,r.credential_mac,r.encrypted_json,r.created_at,r.revoked_at]);
 const consentSeal=r=>digest(['scheduler-consent-v1',r.connection_id,r.binding_id,r.owner_id,r.authority_hash,r.purpose,r.resource_hash,r.candidate_image,r.candidate_binary,r.happened_at]);
 const equal=(x,y)=>h(x)&&h(y)&&crypto.timingSafeEqual(Buffer.from(x,'hex'),Buffer.from(y,'hex'));
 function authority(context,connectionId,browser=false){
  if(!id(connectionId)||browser&&(context?.nativeBearer!==undefined||context?.method!=='POST'))fail('SCHEDULER_BROWSER_CONSENT_REQUIRED');
  const v=current(context,connectionId,browser);
  if(!plain(v)||typeof v.ownerId!=='string'||!h(v.authorityHash)||!h(v.connectionHash)||!h(v.ownerRevision)||!h(v.profileRevision))fail('SCHEDULER_ORIGINAL_OWNER_REFUSED');
  return v;
 }
 const currentHash=a=>digest(['scheduler-authority-v1',a.ownerId,a.ownerRevision,a.profileRevision,a.connectionHash,a.authorityHash]);
 const same=(a,b)=>equal(currentHash(a),currentHash(b));
 function rowFor(a,connectionId){
  const r=db.prepare('SELECT * FROM crm_scheduler_api_binding_v1 WHERE owner_id=? AND connection_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1').get(a.ownerId,connectionId);
  if(!r||r.revoked_at!==null||!equal(r.binding_mac,seal(r))||!equal(r.authority_hash,currentHash(a)))fail('SCHEDULER_API_BINDING_REQUIRED',409);
  const c=db.prepare('SELECT * FROM crm_scheduler_read_consent_v1 WHERE connection_id=? AND binding_id=? ORDER BY id DESC LIMIT 1').get(connectionId,r.id);
  if(!c||!equal(c.consent_mac,consentSeal(c))||c.owner_id!==a.ownerId||c.purpose!==SCOPE||c.resource_hash!==resourceHash||c.candidate_image!==CANDIDATE_IMAGE||c.candidate_binary!==CANDIDATE_BINARY||!equal(c.authority_hash,r.authority_hash))fail('SCHEDULER_SEPARATE_CONSENT_REQUIRED');
  return r;
 }
 const credentialHash=c=>digest(['scheduler-private-api-v1',c.apiUser,c.apiToken]);
 function unseal(r){let c;try{c=credential(JSON.parse(decrypt(r.encrypted_json)));}catch{fail('SCHEDULER_API_BINDING_REFUSED',503);}if(!equal(credentialHash(c),r.credential_mac))fail('SCHEDULER_API_BINDING_REFUSED',503);return c;}
 const safe=r=>Object.freeze({schema:'shrigma-scheduler-private-binding-v1',bindingId:r.id,connectionId:r.connection_id,purpose:SCOPE,linked:true,consented:true,profileHash:r.profile_hash,candidateImage:CANDIDATE_IMAGE,candidateBinary:CANDIDATE_BINARY,authenticationView:'original-api-cache',authorizesSend:false,authorizesRecovery:false,operational:false});
 let bindingBusy=false;const readBusy=new Set();
 async function bind({context,connectionId,apiUser,apiToken,consent}={}){
  if(consent!==true)fail('SCHEDULER_BROWSER_CONSENT_REQUIRED');
  const a=authority(context,connectionId,true),c=credential({apiUser,apiToken});
  if(bindingBusy)fail('SCHEDULER_BINDING_BUSY',409);bindingBusy=true;
  try{
   // Nothing durable changes while the fixed original profile GET is pending.
   const p=await verify(c);
   const fresh=authority(context,connectionId,true);if(!same(a,fresh))fail('SCHEDULER_BINDING_CHANGED',409);
   if(!h(p?.profileHash)||p.settingsReadPermitted!==true||p.authenticationView!=='original-api-cache')fail('SCHEDULER_API_PROFILE_REFUSED',503);
   const encrypted=encrypt(JSON.stringify(c));if(typeof encrypted!=='string'||encrypted.length>8192||encrypted.includes(c.apiToken))fail('SCHEDULER_ENCRYPTION_REFUSED',500);
   const t=time(),r={id:crypto.randomUUID(),owner_id:a.ownerId,connection_id:connectionId,authority_hash:currentHash(a),profile_hash:p.profileHash,credential_mac:credentialHash(c),encrypted_json:encrypted,created_at:t,revoked_at:null};r.binding_mac=seal(r);
   const consentRow={connection_id:connectionId,binding_id:r.id,owner_id:a.ownerId,authority_hash:r.authority_hash,purpose:SCOPE,resource_hash:resourceHash,candidate_image:CANDIDATE_IMAGE,candidate_binary:CANDIDATE_BINARY,happened_at:t};
   db.exec('BEGIN IMMEDIATE');try{
    if(!same(a,authority(context,connectionId,true)))fail('SCHEDULER_BINDING_CHANGED',409);
    const old=db.prepare('SELECT * FROM crm_scheduler_api_binding_v1 WHERE owner_id=? AND connection_id=? AND revoked_at IS NULL').all(a.ownerId,connectionId);
    for(const x of old){if(!equal(x.binding_mac,seal(x)))fail('SCHEDULER_API_BINDING_REFUSED',503);const rev={...x,revoked_at:t};db.prepare('UPDATE crm_scheduler_api_binding_v1 SET revoked_at=?,binding_mac=? WHERE id=?').run(t,seal(rev),x.id);}
    db.prepare('INSERT INTO crm_scheduler_api_binding_v1 VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.id,r.owner_id,r.connection_id,r.authority_hash,r.profile_hash,r.credential_mac,r.encrypted_json,r.created_at,r.revoked_at,r.binding_mac);
    db.prepare('INSERT INTO crm_scheduler_read_consent_v1(connection_id,binding_id,owner_id,authority_hash,purpose,resource_hash,candidate_image,candidate_binary,happened_at,consent_mac) VALUES(?,?,?,?,?,?,?,?,?,?)').run(consentRow.connection_id,consentRow.binding_id,consentRow.owner_id,consentRow.authority_hash,consentRow.purpose,consentRow.resource_hash,consentRow.candidate_image,consentRow.candidate_binary,t,consentSeal(consentRow));
    db.prepare("INSERT INTO crm_scheduler_binding_audit_v1(owner_id,connection_id,binding_id,action,happened_at) VALUES(?,?,?,'bind',?)").run(a.ownerId,connectionId,r.id,t);
    db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   return safe(r);
  }finally{bindingBusy=false;}
 }
 function status({context,connectionId}={}){
  const a=authority(context,connectionId,context?.nativeBearer===undefined);
  try{return safe(rowFor(a,connectionId));}catch(e){if(['SCHEDULER_API_BINDING_REQUIRED','SCHEDULER_SEPARATE_CONSENT_REQUIRED'].includes(e?.code))return {schema:'shrigma-scheduler-private-binding-v1',connectionId,purpose:SCOPE,linked:false,consented:false,candidateImage:CANDIDATE_IMAGE,candidateBinary:CANDIDATE_BINARY,authenticationView:'original-api-cache',authorizesSend:false,authorizesRecovery:false,operational:false};throw e;}
 }
 function revoke({context,connectionId}={}){
  const a=authority(context,connectionId,true),r=rowFor(a,connectionId),t=time(),rev={...r,revoked_at:t};db.exec('BEGIN IMMEDIATE');try{
   const changed=db.prepare('UPDATE crm_scheduler_api_binding_v1 SET revoked_at=?,binding_mac=? WHERE id=? AND binding_mac=? AND revoked_at IS NULL').run(t,seal(rev),r.id,r.binding_mac).changes;if(changed!==1)fail('SCHEDULER_BINDING_CHANGED',409);
   db.prepare("INSERT INTO crm_scheduler_binding_audit_v1(owner_id,connection_id,binding_id,action,happened_at) VALUES(?,?,?,'revoke',?)").run(a.ownerId,connectionId,r.id,t);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return {revoked:true,connectionId,purpose:SCOPE};
 }
 // Private callback boundary. The core transport's own CURRENT checks are
 // additional; no credential or profile leaves this callback to an operator.
 async function withVerifiedCredential({context,connectionId,read}={}){
  if(context?.nativeBearer===undefined||context.method!=='GET'||typeof read!=='function')fail('SCHEDULER_NATIVE_READ_REQUIRED');
  const a=authority(context,connectionId),r=rowFor(a,connectionId),c=unseal(r);
  if(readBusy.has(connectionId))fail('SCHEDULER_READ_BUSY',409);readBusy.add(connectionId);
  function check(){const fresh=authority(context,connectionId),row=rowFor(fresh,connectionId);if(!same(a,fresh)||row.id!==r.id||!equal(row.binding_mac,r.binding_mac))fail('SCHEDULER_BINDING_CHANGED',409);return {ownerId:a.ownerId,connectionId,bindingId:r.id,bindingHash:r.binding_mac,profileHash:r.profile_hash,purpose:SCOPE};}
  try{
   const before=await verify(c);check();if(before.profileHash!==r.profile_hash)fail('SCHEDULER_API_PROFILE_CHANGED',409);
   const value=await read(Object.freeze({...c}),check);
   check();const after=await verify(c);check();if(after.profileHash!==r.profile_hash)fail('SCHEDULER_API_PROFILE_CHANGED',409);
   return value;
  }finally{readBusy.delete(connectionId);}
 }
 return Object.freeze({enabled:true,bind,status,revoke,withVerifiedCredential});
}
module.exports=Object.freeze({createSchedulerBinding,SCOPE,RESOURCE,CANDIDATE_IMAGE,CANDIDATE_BINARY});
