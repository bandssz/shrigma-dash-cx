'use strict';
// Additive, encrypted per-campaign metadata on the existing CREATE record.
// Original request, receipt, input hashes and campaign data are not changed.
const crypto=require('node:crypto');
const TABLE='crm_campaign_create_v1',SCHEMA='crm-consent-campaign-state-v1';
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
const fail=code=>{throw Object.assign(Error(code),{code});};
const canonical=o=>Array.isArray(o)?'['+o.map(canonical).join(',')+']':plain(o)?'{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}':JSON.stringify(o);
const hash=o=>crypto.createHash('sha256').update(canonical(o)).digest('hex');
function privateCipher(value){if(typeof value!=='string')return false;const p=value.split('.');return p.length===4&&p[0]==='v1'&&p.slice(1).every(x=>/^[A-Za-z0-9_-]+$/.test(x)&&Buffer.from(x,'base64url').toString('base64url')===x)&&Buffer.from(p[1],'base64url').length===12&&Buffer.from(p[2],'base64url').length===16;}
function createStore({db,encrypt,decrypt,now=Date.now,enabledSince}){
 if(!db||typeof db.isTransaction!=='boolean'||![encrypt,decrypt,now].every(f=>typeof f==='function')||!Number.isSafeInteger(enabledSince)||enabledSince<0)throw Error('CONSENT_STORE_CONFIG');
 const columns=db.prepare('PRAGMA table_info('+TABLE+')').all();if(!columns.length)throw Error('CONSENT_ORIGINAL_CREATE_REQUIRED');
 if(!columns.some(x=>x.name==='consent_job_ciphertext'))db.exec('ALTER TABLE '+TABLE+' ADD COLUMN consent_job_ciphertext TEXT');
 if(!columns.some(x=>x.name==='consent_job_version'))db.exec('ALTER TABLE '+TABLE+' ADD COLUMN consent_job_version INTEGER NOT NULL DEFAULT 0');
 const row=r=>db.prepare('SELECT * FROM '+TABLE+' WHERE user_id=? AND client_key=?').get(r.userId,r.clientKey);
 const same=(r,s)=>r&&r.phase==='succeeded'&&r.campaign_id===s.campaignId&&r.brand===s.brand&&r.user_id===s.userId&&r.client_key===s.clientKey&&r.remote_key===s.createKey;
 function open(r){
  let s;try{if(!privateCipher(r.consent_job_ciphertext))fail('CONSENT_METADATA_UNCONFIRMED');s=JSON.parse(decrypt(r.consent_job_ciphertext));}catch{fail('CONSENT_METADATA_UNCONFIRMED');}
  if(!plain(s)||s.schema!==SCHEMA||!same(r,s)||s.createdOperationId!==r.remote_operation_id||!plain(s.provenance)||!plain(s.backups)||!plain(s.confirmations)||!plain(s.history)||s.authoritySince!==enabledSince)fail('CONSENT_METADATA_UNCONFIRMED');
  return s;
 }
 function write(r,s){const raw=JSON.stringify(s);if(Buffer.byteLength(raw)>2*1024*1024)fail('CONSENT_METADATA_CAPACITY');const ciphertext=encrypt(raw);if(!privateCipher(ciphertext))fail('CONSENT_METADATA_UNCONFIRMED');if(db.prepare('UPDATE '+TABLE+" SET consent_job_ciphertext=?,consent_job_version=consent_job_version+1 WHERE user_id=? AND client_key=? AND phase='succeeded' AND campaign_id=? AND consent_job_version=?").run(ciphertext,r.user_id,r.client_key,r.campaign_id,r.consent_job_version).changes!==1)fail('CONSENT_METADATA_CHANGED');}
 function atomic(record,fn){if(db.isTransaction)fail('CONSENT_METADATA_TRANSACTION');db.exec('BEGIN IMMEDIATE');try{const r=row(record);if(!r||!r.consent_job_ciphertext)fail('CONSENT_METADATA_UNCONFIRMED');const s=open(r);if(record.brand!==s.brand||record.campaignId!==s.campaignId)fail('CONSENT_METADATA_UNCONFIRMED');const result=fn(s,r);db.exec('COMMIT');return result;}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}}
 function register(record,p){
  if(db.isTransaction)fail('CONSENT_METADATA_TRANSACTION');db.exec('BEGIN IMMEDIATE');try{
   const r=row(record);if(!r||r.phase!=='succeeded'||r.created_at<enabledSince||!plain(p)||p.schema!=='crm-consent-provenance-v1'||p.brand!==r.brand||p.campaignId!==r.campaign_id||p.createdOperationId!==r.remote_operation_id||p.createKey!==r.remote_key||!plain(p.freeze)||!plain(p.audience)||p.freeze.audience_id!==p.audience.id||p.freeze.audience_version!==p.audience.version||p.freeze.definition_hash!==p.audience.definition_hash||p.freeze.brand!==r.brand||!Array.isArray(p.origins)||!p.origins.length)fail('CONSENT_REGISTRATION_UNCONFIRMED');
   const definition=JSON.parse(decrypt(r.normalized_ciphertext));if(p.originalReceiptSha256!==r.receipt_sha256||r.receipt_state!=='succeeded'||hash(definition)!==r.normalized_sha256||definition.brand!==r.brand||!Array.isArray(definition.list_ids)||definition.list_ids.length!==1||definition.list_ids[0]!==p.freeze.list_id)fail('CONSENT_REGISTRATION_UNCONFIRMED');
   if(r.consent_job_ciphertext){const prior=open(r);if(hash(prior.provenance)!==hash(p))fail('CONSENT_REGISTRATION_CHANGED');db.exec('COMMIT');return true;}
   const state={schema:SCHEMA,userId:r.user_id,clientKey:r.client_key,brand:r.brand,campaignId:r.campaign_id,createKey:r.remote_key,createdOperationId:r.remote_operation_id,authoritySince:enabledSince,provenance:JSON.parse(JSON.stringify(p)),registeredAt:now(),backups:{},confirmations:{},history:{},pending:null};
   write(r,state);db.exec('COMMIT');return true;
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
 }
 const store={
  register,
  list(){const rows=db.prepare('SELECT * FROM '+TABLE+" WHERE phase='succeeded' AND consent_job_ciphertext IS NOT NULL ORDER BY created_at,campaign_id LIMIT 1001").all();if(rows.length>1000)fail('CONSENT_METADATA_CAPACITY');return rows.map(r=>{const s=open(r);return{userId:s.userId,clientKey:s.clientKey,brand:s.brand,campaignId:s.campaignId,createKey:s.createKey,provenance:JSON.parse(JSON.stringify(s.provenance))};});},
  prior(record,key){return atomic(record,s=>s.confirmations[key]?null:s.backups[key]?JSON.parse(JSON.stringify(s.backups[key])):null);},
  backup(record,b){return atomic(record,(s,r)=>{if(b.brand!==s.brand||b.campaignId!==s.campaignId||!/^[a-f0-9]{64}$/.test(b.key||''))fail('CONSENT_BACKUP_UNCONFIRMED');const prior=s.backups[b.key];if(prior){for(const key of ['scope','subscriberId','subscriberUuid','originId','originUuid','campaignUuid','frozenId','frozenUuid','plannedStatus'])if(prior[key]!==b[key])fail('CONSENT_BACKUP_UNCONFIRMED');if(!s.confirmations[b.key]&&prior.beforeStatus===b.beforeStatus)return true;const history=s.history[b.key]||[];if(history.length>=1000)fail('CONSENT_METADATA_CAPACITY');s.history[b.key]=history.concat([{backup:prior,confirmation:s.confirmations[b.key]||null,observedAgainAt:b.capturedAt,reason:s.confirmations[b.key]?'origin-subscribed-again':'origin-status-changed'}]);delete s.confirmations[b.key];}s.backups[b.key]=JSON.parse(JSON.stringify(b));s.pending=null;write(r,s);return true;});},
  confirm(record,c){return atomic(record,(s,r)=>{const b=s.backups[c.key];if(!b||b.scope!==c.scope||c.status!=='unsubscribed')fail('CONSENT_RECORD_UNCONFIRMED');if(s.confirmations[c.key])return true;s.confirmations[c.key]={confirmedAt:c.confirmedAt,status:'unsubscribed'};s.pending=null;write(r,s);return true;});},
  pending(record,p){return atomic(record,(s,r)=>{s.pending={code:/^CONSENT_[A-Z_]{1,70}$/.test(p.code||'')?p.code:'CONSENT_PENDING',at:p.at};write(r,s);return true;});}
 };
 return Object.freeze(store);
}
module.exports={createStore,SCHEMA};
