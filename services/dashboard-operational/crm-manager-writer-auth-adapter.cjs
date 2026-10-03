'use strict';
// Private, dormant sandbox adapter. Identity and journal share one SQLite
// connection; no network, environment, timer, HTTP route or implicit approval.
const crypto=require('node:crypto');
const {createWriterJournal}=require('./crm-manager-writer-journal.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,PRINCIPAL=/^dcrmw-[a-f0-9]{32}$/;
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable&&Object.hasOwn(d,'value');});
function fail(){const e=new Error('CRM_WRITER_AUTH_REFUSED');e.code='CRM_WRITER_AUTH_REFUSED';throw e;}
function sync(f){const v=f();let promise=false;try{Promise.prototype.then.call(v,()=>{},()=>{});promise=true;}catch{}if(promise)fail();if(v&&['object','function'].includes(typeof v)&&'then'in v){Promise.resolve(v).catch(()=>{});fail();}return v;}
function createWriterAuthAdapter(c){
 const corporate=c?.profile==='corporate-read-writer-v1';
 const keys=['db','enabled','profile','issuerId','namespaceId','allowedEmailDomains','encrypt','decrypt','digest','now',...(corporate?['readReady']:[])];
 if(!exact(c,keys)||c.enabled!==true||c.profile!=='crm-sandbox'&&!corporate||!c.db||typeof c.db.isTransaction!=='boolean'||c.db.isTransaction||!UUID.test(c.issuerId||'')||!UUID.test(c.namespaceId||'')||!Array.isArray(c.allowedEmailDomains)||c.allowedEmailDomains.length!==1||c.allowedEmailDomains[0]!== (corporate?'oaristocrata.com':'synthetic.invalid')||corporate&&typeof c.readReady!=='function'||!['encrypt','decrypt','digest','now'].every(k=>typeof c[k]==='function'))fail();
 const {db}=c;
 const clock=()=>{const n=sync(c.now);if(!Number.isSafeInteger(n)||n<0||n>8640000000000000-1209600000)fail();return n;};
 const mac=v=>{const m=sync(()=>c.digest(v));if(typeof m!=='string'||!HASH.test(m))fail();return m;};
 const transaction=()=>{if(!db.isTransaction)fail();};
 db.exec(`CREATE TABLE IF NOT EXISTS crm_writer_auth_config_v1(singleton INTEGER PRIMARY KEY CHECK(singleton=1),issuer_id TEXT NOT NULL,namespace_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_writer_auth_admission_v1(user_id TEXT PRIMARY KEY REFERENCES users(id),lifecycle_id TEXT NOT NULL UNIQUE,version INTEGER NOT NULL CHECK(version>0),owner TEXT NOT NULL,issuer_id TEXT NOT NULL,namespace_id TEXT NOT NULL,approved INTEGER NOT NULL CHECK(approved IN(0,1)));
 CREATE TABLE IF NOT EXISTS crm_writer_auth_binding_v1(user_id TEXT PRIMARY KEY REFERENCES users(id),lifecycle_id TEXT NOT NULL,version INTEGER NOT NULL,owner TEXT NOT NULL,issuer_id TEXT NOT NULL,namespace_id TEXT NOT NULL,principal_id TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL CHECK(generation>0),expires_at INTEGER NOT NULL,credential_mac TEXT NOT NULL);`);
 if(corporate)db.exec('CREATE TABLE IF NOT EXISTS crm_writer_retired_binding_v1(user_id TEXT NOT NULL,lifecycle_id TEXT NOT NULL,version INTEGER NOT NULL,namespace_id TEXT NOT NULL,owner TEXT NOT NULL,principal_id TEXT NOT NULL,generation INTEGER NOT NULL,credential_mac TEXT NOT NULL,encrypted_key TEXT NOT NULL,retired_at INTEGER NOT NULL,PRIMARY KEY(user_id,lifecycle_id,generation))');
 const config=db.prepare('SELECT issuer_id,namespace_id FROM crm_writer_auth_config_v1 WHERE singleton=1').get();
 if(config&&(config.issuer_id!==c.issuerId||config.namespace_id!==c.namespaceId))fail();
 if(!config)db.prepare('INSERT INTO crm_writer_auth_config_v1 VALUES(1,?,?)').run(c.issuerId,c.namespaceId);
 const admission=id=>db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id);
 const binding=id=>db.prepare('SELECT * FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(id);
 const user=id=>db.prepare('SELECT id,email,role,state FROM users WHERE id=?').get(id);
 const identity=id=>{const u=user(id),g=db.prepare('SELECT area,can_read,can_edit FROM grants WHERE user_id=? ORDER BY area').all(id);return{u,g};};
 const exclusive=g=>g.length===1&&g[0].area==='growth'&&g[0].can_read===1;
 const tableExists=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 function hasPendingCampaigns(id){
  if(db.prepare("SELECT 1 FROM campaign_draft_operations WHERE user_id=? AND phase IN('pending','uncertain') LIMIT 1").get(id))return true;
  for(const table of ['crm_campaign_delivery_v1','crm_campaign_create_v1'])if(tableExists(table)&&db.prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND phase IN('queued','uncertain','confirmed') LIMIT 1`).get(id))return true;
  return false;
 }
 function getSubject(id){
  if(typeof id!=='string'||!UUID.test(id))fail();
  const a=admission(id),{u,g}=identity(id);if(!a||!u||!UUID.test(a.lifecycle_id)||!Number.isSafeInteger(a.version)||a.version<1)fail();
  return Object.freeze({userId:id,owner:u.email,lifecycleId:a.lifecycle_id,version:a.version,role:u.role,state:u.state,area:g.length===1?g[0].area:null,exclusive:exclusive(g),canRead:exclusive(g),canEdit:exclusive(g)&&g[0].can_edit===1,writeApproved:a.approved===1&&a.owner===u.email&&a.issuer_id===c.issuerId&&a.namespace_id===c.namespaceId,hasPendingCampaigns:hasPendingCampaigns(id)});
 }
 const eligible=s=>s.role==='manager'&&s.state==='active'&&s.area==='growth'&&s.exclusive&&s.canRead&&s.writeApproved;
 function createLifecycle(id){
  transaction();const {u,g}=identity(id);if(!u||u.role!=='manager'||u.state!=='invited'||!exclusive(g)||g[0].can_edit!==0)fail();
  if(db.prepare("SELECT 1 FROM crm_writer_bridge_life_v1 WHERE user_id=? AND state<>'revoked'").get(id)||binding(id))fail();
  const previous=admission(id),version=(previous?.version??0)+1;if(!Number.isSafeInteger(version))fail();
  db.prepare('INSERT INTO crm_writer_auth_admission_v1 VALUES(?,?,?,?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET lifecycle_id=excluded.lifecycle_id,version=excluded.version,owner=excluded.owner,issuer_id=excluded.issuer_id,namespace_id=excluded.namespace_id,approved=0').run(id,crypto.randomUUID(),version,u.email,c.issuerId,c.namespaceId);return Object.freeze({ok:true});
 }
 function approve(id){
  transaction();const s=getSubject(id);if(s.role!=='manager'||s.state!=='active'||!s.exclusive||!s.canRead||s.canEdit||s.hasPendingCampaigns||binding(id)||db.prepare("SELECT 1 FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(id)||db.prepare("SELECT 1 FROM campaign_writer_attestation_v1 WHERE user_id=?").get(id)||db.prepare("SELECT 1 FROM audience_draft_operations WHERE user_id=? AND phase IN('pending','uncertain')").get(id))fail();
  if(db.prepare("SELECT 1 FROM crm_writer_bridge_life_v1 WHERE user_id=? AND state<>'revoked'").get(id))fail();
  const a=admission(id);if(a.owner!==s.owner||a.issuer_id!==c.issuerId||a.namespace_id!==c.namespaceId)fail();
  // A failed enqueue can be resumed with this same durable admission. No
  // in-flight or previously promoted lifecycle can be approved a second time.
  const retired=db.prepare("SELECT 1 FROM crm_writer_bridge_life_v1 WHERE lifecycle_id=? AND state='revoked'").get(a.lifecycle_id);
  if(retired){const version=a.version+1;if(!Number.isSafeInteger(version))fail();db.prepare('UPDATE crm_writer_auth_admission_v1 SET approved=1,lifecycle_id=?,version=? WHERE user_id=?').run(crypto.randomUUID(),version,id);}
  else if(a.approved!==1){const version=a.version+1;if(!Number.isSafeInteger(version))fail();db.prepare('UPDATE crm_writer_auth_admission_v1 SET approved=1,version=? WHERE user_id=?').run(version,id);}
  db.prepare('UPDATE grants SET can_edit=0 WHERE user_id=? AND area=\'growth\'').run(id);
  return Object.freeze({ok:true});
 }
 function shape(p,keys){if(!exact(p,keys)||!UUID.test(p.userId||'')||!UUID.test(p.lifecycleId||'')||!UUID.test(p.namespaceId||'')||p.namespaceId!==c.namespaceId||!Number.isSafeInteger(p.version)||p.version<1)fail();}
 const owned=(b,p)=>b&&b.lifecycle_id===p.lifecycleId&&b.version===p.version&&b.namespace_id===p.namespaceId&&b.issuer_id===c.issuerId;
 function fullBinding(b,{promotionReadback=false}={}){
  if(!b)return false;
  const a=admission(b.user_id),s=getSubject(b.user_id);
  if(!eligible(s)||!s.canEdit||!owned(b,{lifecycleId:s.lifecycleId,version:s.version,namespaceId:c.namespaceId})||a.owner!==b.owner||b.owner!==s.owner||b.expires_at<=clock())return false;
  const life=db.prepare('SELECT * FROM crm_writer_bridge_life_v1 WHERE lifecycle_id=? AND user_id=?').get(b.lifecycle_id,b.user_id);
  if(!life||life.owner!==b.owner||life.version!==b.version||life.state!=='active')return false;
  const advancing=life.active_generation!==b.generation;
  // Only the private journal readback may see the not-yet-committed promotion.
  // Public authorization always requires the already promoted generation.
  if(advancing&&(!promotionReadback||!db.isTransaction||b.generation!==life.active_generation+1))return false;
  const op=db.prepare("SELECT * FROM crm_writer_bridge_op_v1 WHERE lifecycle_id=? AND kind<>'revoke' AND phase=? ORDER BY rowid DESC LIMIT 1").get(b.lifecycle_id,advancing?'attested':'promoted');
  if(!op||op.request_mac!==mac('request:'+op.request_json)||op.committed_mac!==mac('committed:'+op.committed_json))return false;
  let request,receipt;try{request=JSON.parse(op.request_json);receipt=JSON.parse(op.committed_json);}catch{return false;}
  if(request.issuerId!==c.issuerId||request.namespaceId!==c.namespaceId||request.userId!==b.user_id||request.lifecycleId!==b.lifecycle_id||request.owner!==b.owner||request.principalId!==b.principal_id||request.generation!==b.generation||request.expectedGeneration!==b.generation-1||advancing&&request.expectedGeneration!==life.active_generation||receipt.state!=='committed'||receipt.issuerId!==c.issuerId||receipt.namespaceId!==c.namespaceId||receipt.userId!==b.user_id||receipt.lifecycleId!==b.lifecycle_id||receipt.owner!==b.owner||receipt.principalId!==b.principal_id||receipt.generation!==b.generation||receipt.prepareOperationId!==op.operation_id||receipt.expiresAt!==b.expires_at)return false;
  const slot=db.prepare("SELECT encrypted_key,key_digest FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(b.user_id),att=db.prepare('SELECT * FROM campaign_writer_attestation_v1 WHERE user_id=?').get(b.user_id);
  if(!slot||!att||att.owner!==b.owner||att.principal_id!==b.principal_id||att.credential_mac!==b.credential_mac||slot.key_digest!==b.credential_mac||att.expires_at!==b.expires_at)return false;
  try{const bearer=sync(()=>c.decrypt(slot.encrypted_key));return typeof bearer==='string'&&HASH.test(bearer)&&mac(bearer)===b.credential_mac&&crypto.createHash('sha256').update(bearer).digest('hex')===request.keySha256;}catch{return false;}
 }
 function bindingReady(p){
  try{shape(p,['userId','lifecycleId','version','namespaceId','principalId','generation','expiresAt']);const b=binding(p.userId);return !!b&&owned(b,p)&&b.principal_id===p.principalId&&b.generation===p.generation&&b.expires_at===p.expiresAt&&fullBinding(b,{promotionReadback:db.isTransaction});}catch{return false;}
 }
 function promoteBinding(p){
  transaction();shape(p,['userId','lifecycleId','version','namespaceId','owner','principalId','generation','expectedGeneration','expiresAt','encryptedKey','credentialMac']);
  const s=getSubject(p.userId);if(!eligible(s)||s.canEdit||s.hasPendingCampaigns||s.owner!==p.owner||s.lifecycleId!==p.lifecycleId||s.version!==p.version||!PRINCIPAL.test(p.principalId||'')||!Number.isSafeInteger(p.generation)||!Number.isSafeInteger(p.expectedGeneration)||p.expectedGeneration<0||p.generation!==p.expectedGeneration+1||p.generation>999999999||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=clock()||p.expiresAt>clock()+1209600000||typeof p.encryptedKey!=='string'||p.encryptedKey.length>2048||!HASH.test(p.credentialMac||''))fail();
  // The journal is the only promoter. Its frozen request, committed receipt
  // and candidate must still describe this exact attested operation.
  const o=db.prepare("SELECT o.*,l.owner,l.version,l.active_generation,l.state AS life_state FROM crm_writer_bridge_op_v1 o JOIN crm_writer_bridge_life_v1 l USING(lifecycle_id) WHERE l.user_id=? AND l.lifecycle_id=? AND o.phase='attested' AND o.kind<>'revoke'").get(p.userId,p.lifecycleId);
  if(!o||o.life_state!=='active'||o.version!==p.version||o.owner!==p.owner||o.active_generation!==p.expectedGeneration||o.ciphertext!==p.encryptedKey||o.bearer_mac!==p.credentialMac||o.cipher_mac!==mac('cipher:'+p.encryptedKey)||o.request_mac!==mac('request:'+o.request_json)||o.committed_mac!==mac('committed:'+o.committed_json))fail();
  let q,r;try{q=JSON.parse(o.request_json);r=JSON.parse(o.committed_json);}catch{fail();}
  if(q.namespaceId!==c.namespaceId||q.issuerId!==c.issuerId||q.owner!==p.owner||q.principalId!==p.principalId||q.generation!==p.generation||q.expectedGeneration!==p.expectedGeneration||r.principalId!==p.principalId||r.generation!==p.generation||r.expiresAt!==p.expiresAt)fail();
  const bearer=sync(()=>c.decrypt(p.encryptedKey));if(typeof bearer!=='string'||!HASH.test(bearer)||mac(bearer)!==p.credentialMac||crypto.createHash('sha256').update(bearer).digest('hex')!==q.keySha256)fail();
  if(db.prepare("SELECT 1 FROM upstream_credentials WHERE key_digest=? AND (user_id<>? OR slot<>'growth-campaign') LIMIT 1").get(p.credentialMac,p.userId))fail();
  const old=binding(p.userId),slot=db.prepare("SELECT key_digest FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(p.userId),att=db.prepare('SELECT * FROM campaign_writer_attestation_v1 WHERE user_id=?').get(p.userId);
  if(p.expectedGeneration===0){if(old||slot||att)fail();}
  else if(!owned(old,p)||old.generation!==p.expectedGeneration||old.expires_at<=clock()||old.owner!==p.owner||!slot||slot.key_digest!==old.credential_mac||!att||att.credential_mac!==old.credential_mac||att.owner!==old.owner||att.principal_id!==old.principal_id||att.expires_at!==old.expires_at)fail();
  // This specific dependency loss is compensatable only after all identity,
  // proof and reservation checks have passed, before any edit grant is written.
  if(corporate&&sync(()=>c.readReady(p.userId))!==true){const error=new Error('CRM_WRITER_READ_DEPENDENCY_LOST');error.code='CRM_WRITER_READ_DEPENDENCY_LOST';throw error;}
  db.prepare("INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,'growth-campaign',?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_digest=excluded.key_digest,updated_at=excluded.updated_at").run(p.userId,p.encryptedKey,p.credentialMac,clock());
  db.prepare('INSERT INTO campaign_writer_attestation_v1(user_id,owner,principal_id,credential_mac,expires_at,attested_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET owner=excluded.owner,principal_id=excluded.principal_id,credential_mac=excluded.credential_mac,expires_at=excluded.expires_at,attested_at=excluded.attested_at').run(p.userId,p.owner,p.principalId,p.credentialMac,p.expiresAt,clock());
  db.prepare('INSERT INTO crm_writer_auth_binding_v1 VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET lifecycle_id=excluded.lifecycle_id,version=excluded.version,owner=excluded.owner,issuer_id=excluded.issuer_id,namespace_id=excluded.namespace_id,principal_id=excluded.principal_id,generation=excluded.generation,expires_at=excluded.expires_at,credential_mac=excluded.credential_mac').run(p.userId,p.lifecycleId,p.version,p.owner,c.issuerId,c.namespaceId,p.principalId,p.generation,p.expiresAt,p.credentialMac);
  const changed=db.prepare("UPDATE grants SET can_edit=1 WHERE user_id=? AND area='growth' AND can_read=1 AND can_edit=0").run(p.userId);if(changed.changes!==1)fail();
  return Object.freeze({ok:true});
 }
 function disableBinding(p){
  transaction();shape(p,['userId','lifecycleId','version','namespaceId']);const b=binding(p.userId),a=admission(p.userId);
  if(owned(b,p)){
   if(corporate){const old=db.prepare("SELECT encrypted_key FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign' AND key_digest=?").get(p.userId,b.credential_mac);if(old)db.prepare('INSERT OR IGNORE INTO crm_writer_retired_binding_v1 VALUES(?,?,?,?,?,?,?,?,?,?)').run(p.userId,b.lifecycle_id,b.version,b.namespace_id,b.owner,b.principal_id,b.generation,b.credential_mac,old.encrypted_key,clock());}
   // A stale revoke never removes a new lifecycle's slot or an unrelated key.
   db.prepare("DELETE FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign' AND key_digest=?").run(p.userId,b.credential_mac);
   db.prepare('DELETE FROM campaign_writer_attestation_v1 WHERE user_id=? AND principal_id=? AND credential_mac=?').run(p.userId,b.principal_id,b.credential_mac);
   db.prepare('DELETE FROM crm_writer_auth_binding_v1 WHERE user_id=? AND lifecycle_id=? AND version=? AND namespace_id=?').run(p.userId,p.lifecycleId,p.version,p.namespaceId);
  }
  if(a&&a.lifecycle_id===p.lifecycleId&&a.version===p.version&&a.namespace_id===p.namespaceId&&a.issuer_id===c.issuerId)db.prepare("UPDATE grants SET can_edit=0 WHERE user_id=? AND area='growth'").run(p.userId);
  return Object.freeze({ok:true});
 }
 const journal=createWriterJournal({db,enabled:true,profile:c.profile,issuerId:c.issuerId,namespaceId:c.namespaceId,allowedEmailDomains:c.allowedEmailDomains,encrypt:c.encrypt,decrypt:c.decrypt,digest:c.digest,getSubject,promoteBinding,disableBinding,bindingReady,now:c.now});
 function stageRevoke(id){
  transaction();const a=admission(id);if(!a)return Object.freeze({managed:false});
  const outcome=journal.stageRevoke(id),version=a.version+1;if(!Number.isSafeInteger(version))fail();
  db.prepare('UPDATE crm_writer_auth_admission_v1 SET approved=0,version=? WHERE user_id=?').run(version,id);
  db.prepare("UPDATE grants SET can_edit=0 WHERE user_id=? AND area='growth'").run(id);return outcome;
 }
 function quiesce(id){
  transaction();const s=getSubject(id),b=binding(id);if(!eligible(s)||s.hasPendingCampaigns||!b||!fullBinding(b))fail();
  db.prepare("UPDATE grants SET can_edit=0 WHERE user_id=? AND area='growth'").run(id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);return Object.freeze({ok:true});
 }
 function bindingForUser(id){try{const b=binding(id);return fullBinding(b)?db.prepare('SELECT * FROM campaign_writer_attestation_v1 WHERE user_id=?').get(id):null;}catch{return null;}}
 function publicState(id){
  const a=admission(id);if(!a)return null;const {u,g}=identity(id),b=binding(id),life=db.prepare('SELECT state FROM crm_writer_bridge_life_v1 WHERE user_id=? AND lifecycle_id=?').get(id,a.lifecycle_id);
  const ready=bindingForUser(id)!==null&&(!corporate||sync(()=>c.readReady(id))===true),expired=!!b&&b.expires_at<=clock();
  const state=ready?'ready':life?.state==='revoking'?'revoking':life?.state==='revoked'?'revoked':b?'blocked':a.approved===1?'provisioning':'requested';
  return Object.freeze({state,ready,expired,canApprove:u?.role==='manager'&&u.state==='active'&&exclusive(g)&&g[0].can_edit===0&&!hasPendingCampaigns(id)&&!b&&(!life||life.state==='revoked')});
 }
 return Object.freeze({journal,createLifecycle,approve,stageRevoke,quiesce,getSubject,bindingForUser,publicState});
}
module.exports={createWriterAuthAdapter};
