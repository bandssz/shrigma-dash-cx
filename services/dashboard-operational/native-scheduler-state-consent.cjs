'use strict';
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const {PURPOSE,queryHash,resourceHash,canonical}=require('./native-scheduler-state.cjs');
const H=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEYS=Object.freeze(['ownerId','ownerRevision','connectionHash','crmBindingHash','profileRevision','credentialBindingHash','resourceHash','queryHash']);
const own=new WeakSet();function fail(code,status=403){const e=Object.assign(Error(code),{code,status});own.add(e);throw e;}
function exact(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)||{},'value')||!Object.getOwnPropertyDescriptor(v,k).enumerable))fail('SCHEDULER_STATE_ARGUMENTS_REFUSED',400);return v;}
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&H.test(a)&&H.test(b)&&crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
function createSchedulerStateConsent({db,current,mac,now=Date.now}={}){
 if(!db?.prepare||!db?.exec||[current,mac,now].some(f=>typeof f!=='function'))fail('SCHEDULER_STATE_CONSENT_CONFIG_REFUSED',500);
 // The caller supplies the existing identity SQLite handle. No connection,
 // scope, health consent or scheduler-diagnostic table is modified.
 db.exec(`CREATE TABLE IF NOT EXISTS crm_scheduler_state_consent_v1(
 id INTEGER PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),
 connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),purpose TEXT NOT NULL,
 authority_hash TEXT NOT NULL,happened_at INTEGER NOT NULL,revoked_at INTEGER,consent_mac TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS crm_scheduler_state_consent_connection_v1 ON crm_scheduler_state_consent_v1(owner_id,connection_id,id);`);
 const time=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('SCHEDULER_STATE_CLOCK_REFUSED',500);return t;};
 const digest=x=>{let v;try{v=mac(canonical(x));}catch{fail('SCHEDULER_STATE_CONSENT_INTEGRITY',409);}if(!H.test(v||''))fail('SCHEDULER_STATE_CONSENT_INTEGRITY',409);return v;};
 const seal=r=>digest(['scheduler-state-consent-record-v1',r.id,r.owner_id,r.connection_id,r.purpose,r.authority_hash,r.happened_at,r.revoked_at]);
 const authority=a=>digest(['scheduler-state-current-v1',PURPOSE,a]);
 function snapshot(context,connectionId,browser=false){
  if(!UUID.test(connectionId||'')||browser&&(context?.nativeBearer!==undefined||context?.method!=='POST'))fail('SCHEDULER_STATE_BROWSER_CONSENT_REQUIRED');
  let a;try{a=exact(current(context,connectionId,browser),KEYS);}catch(e){if(own.has(e))throw e;fail('SCHEDULER_STATE_CURRENT_REFUSED');}
  if(typeof a.ownerId!=='string'||!a.ownerId||a.ownerId.length>256||/[\x00-\x1f\x7f]/.test(a.ownerId)||KEYS.slice(1).some(k=>typeof a[k]!=='string'||!H.test(a[k]))||a.resourceHash!==resourceHash||a.queryHash!==queryHash)fail('SCHEDULER_STATE_CURRENT_REFUSED');
  return Object.freeze(Object.fromEntries(KEYS.map(k=>[k,a[k]])));
 }
 function latest(a,id){let r;try{r=db.prepare('SELECT * FROM crm_scheduler_state_consent_v1 WHERE owner_id=? AND connection_id=? ORDER BY id DESC LIMIT 1').get(a.ownerId,id);}catch{fail('SCHEDULER_STATE_CONSENT_STORE_REFUSED',503);}if(r&&!same(r.consent_mac,seal(r)))fail('SCHEDULER_STATE_CONSENT_INTEGRITY',409);return r;}
 function validate(r,a){if(!r||r.purpose!==PURPOSE||r.revoked_at!==null||!same(r.authority_hash,authority(a)))fail('SCHEDULER_STATE_SEPARATE_CONSENT_REQUIRED');}
 function requireConsent(args={}){exact(args,['context','connectionId']);const {context,connectionId}=args,a=snapshot(context,connectionId,false),r=latest(a,connectionId);validate(r,a);const fresh=snapshot(context,connectionId,false);if(!same(authority(a),authority(fresh)))fail('SCHEDULER_STATE_BINDING_CHANGED',409);return fresh;}
 function status(args={}){exact(args,['context','connectionId']);const {context,connectionId}=args,a=snapshot(context,connectionId,false),r=latest(a,connectionId);let consented=false;try{validate(r,a);consented=true;}catch(e){if(e?.code!=='SCHEDULER_STATE_SEPARATE_CONSENT_REQUIRED')throw e;}if(!same(authority(a),authority(snapshot(context,connectionId,false))))fail('SCHEDULER_STATE_BINDING_CHANGED',409);return Object.freeze({schema:'shrigma-scheduler-state-consent-v1',connectionId,purpose:PURPOSE,consented,operational:false});}
 function authorize(args={}){
  exact(args,['context','connectionId','consent']);const {context,connectionId,consent}=args;if(consent!==true)fail('SCHEDULER_STATE_BROWSER_CONSENT_REQUIRED');const a=snapshot(context,connectionId,true),prior=latest(a,connectionId);
  if(prior&&same(prior.authority_hash,authority(a))){if(prior.revoked_at!==null||prior.purpose!==PURPOSE)fail('SCHEDULER_STATE_CONSENT_REVOKED');requireConsent({context,connectionId});return Object.freeze({authorized:true,purpose:PURPOSE,connectionId,operational:false});}
  const t=time();let committed=false;
  try{db.exec('BEGIN IMMEDIATE');if(!same(authority(a),authority(snapshot(context,connectionId,true))))fail('SCHEDULER_STATE_BINDING_CHANGED',409);
   const r={owner_id:a.ownerId,connection_id:connectionId,purpose:PURPOSE,authority_hash:authority(a),happened_at:t,revoked_at:null};
   // Allocate the record id inside the same identity transaction; the MAC
   // includes it to prevent record substitution or cross-purpose copying.
   const id=Number(db.prepare('INSERT INTO crm_scheduler_state_consent_v1(owner_id,connection_id,purpose,authority_hash,happened_at,revoked_at,consent_mac) VALUES(?,?,?,?,?,NULL,?)').run(r.owner_id,r.connection_id,r.purpose,r.authority_hash,t,'').lastInsertRowid);if(!Number.isSafeInteger(id)||id<1)fail('SCHEDULER_STATE_CONSENT_STORE_REFUSED',503);r.id=id;
   db.prepare('UPDATE crm_scheduler_state_consent_v1 SET consent_mac=? WHERE id=?').run(seal(r),id);
   if(!same(authority(a),authority(snapshot(context,connectionId,true))))fail('SCHEDULER_STATE_BINDING_CHANGED',409);db.exec('COMMIT');committed=true;requireConsent({context,connectionId});
   return Object.freeze({authorized:true,purpose:PURPOSE,connectionId,operational:false});
  }catch(e){if(!committed)try{db.exec('ROLLBACK');}catch{}if(own.has(e))throw e;fail('SCHEDULER_STATE_CONSENT_STORE_REFUSED',503);}
 }
 function invalidate(args={}){
  exact(args,['context','connectionId']);const {context,connectionId}=args,a=snapshot(context,connectionId,true),r=latest(a,connectionId);if(!r)return Object.freeze({invalidated:true,purpose:PURPOSE,operational:false});if(r.revoked_at!==null)return Object.freeze({invalidated:true,purpose:PURPOSE,operational:false});
  let committed=false;try{db.exec('BEGIN IMMEDIATE');if(!same(authority(a),authority(snapshot(context,connectionId,true))))fail('SCHEDULER_STATE_BINDING_CHANGED',409);const next={...r,revoked_at:time()};if(db.prepare('UPDATE crm_scheduler_state_consent_v1 SET revoked_at=?,consent_mac=? WHERE id=? AND consent_mac=? AND revoked_at IS NULL').run(next.revoked_at,seal(next),r.id,r.consent_mac).changes!==1)fail('SCHEDULER_STATE_BINDING_CHANGED',409);if(!same(authority(a),authority(snapshot(context,connectionId,true))))fail('SCHEDULER_STATE_BINDING_CHANGED',409);db.exec('COMMIT');committed=true;return Object.freeze({invalidated:true,purpose:PURPOSE,operational:false});}catch(e){if(!committed)try{db.exec('ROLLBACK');}catch{}if(own.has(e))throw e;fail('SCHEDULER_STATE_CONSENT_STORE_REFUSED',503);}
 }
 return Object.freeze({authorize,status,require:requireConsent,invalidate});
}
module.exports=Object.freeze({createSchedulerStateConsent,PURPOSE,CURRENT_KEYS:KEYS});
