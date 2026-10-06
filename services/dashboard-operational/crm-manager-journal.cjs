'use strict';
// Private durable state only. Not yet wired into the gateway or any scheduler.
// Hook methods require the caller's identity transaction; remote I/O never
// belongs in that transaction. Legacy/admin credentials are outside this store.
const crypto=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPS=Object.freeze(['read_content','list_history','submission']);
const RECEIPT_SCHEMA='crm-manager-provision-receipt-v1';
const BASE=['schema','issuerId','namespaceId','operationId','action','userId','lifecycleId','owner','state'];
const PREPARED=[...BASE,'principalId','generation','expectedGeneration','area','slot','role','caps','issuedAt','candidateExpiresAt','expiresAt'];
const COMMITTED=[...PREPARED,'prepareOperationId','committedAt','revokedGeneration'];
const REVOKED=[...BASE,'revocationMode','allGenerationsRevoked','effectiveAt','revokedCount'];
const fail=(code)=>{const e=new Error(code);e.code=code;throw e;};
const uuid=v=>{if(typeof v!=='string'||!UUID.test(v))fail('MANAGED_ID_INVALID');return v;};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(value,k);return d?.enumerable===true&&Object.hasOwn(d,'value');});
const caps=value=>Array.isArray(value)&&Reflect.ownKeys(value).length===CAPS.length+1&&value.length===CAPS.length&&CAPS.every((cap,i)=>value[i]===cap);
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
function createManagerJournal({db,issuerId,namespaceId,encrypt,decrypt,digest,now=Date.now,writerBindingReady,writerRenewalBindingReady}){
 if(!db||typeof db.isTransaction!=='boolean'||![encrypt,decrypt,digest,now].every(f=>typeof f==='function'))fail('MANAGED_CONFIG_INVALID');
 uuid(issuerId);uuid(namespaceId);if(writerBindingReady!==undefined&&typeof writerBindingReady!=='function'||writerRenewalBindingReady!==undefined&&(typeof writerRenewalBindingReady!=='function'||typeof writerBindingReady!=='function'))fail('MANAGED_CONFIG_INVALID');
 const clock=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('MANAGED_CLOCK_INVALID');return t;};
 db.exec(`CREATE TABLE IF NOT EXISTS crm_manager_configuration_v1 (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),issuer_id TEXT NOT NULL,namespace_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_manager_lifecycles_v1 (
  lifecycle_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),owner TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),state TEXT NOT NULL CHECK(state IN ('awaiting_accept','provisioning','ready','revoking','revoked','failed')),
  active_generation INTEGER NOT NULL DEFAULT 0 CHECK(active_generation>=0),active_principal TEXT,expires_at INTEGER,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_manager_current_v1 (
  user_id TEXT PRIMARY KEY REFERENCES users(id),lifecycle_id TEXT NOT NULL UNIQUE REFERENCES crm_manager_lifecycles_v1(lifecycle_id));
 CREATE TABLE IF NOT EXISTS crm_manager_operations_v1 (
  operation_id TEXT PRIMARY KEY,commit_operation_id TEXT UNIQUE,lifecycle_id TEXT NOT NULL REFERENCES crm_manager_lifecycles_v1(lifecycle_id),
  lifecycle_version INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('issue','renew','revoke')),
  generation INTEGER NOT NULL,expected_generation INTEGER NOT NULL,principal_id TEXT,
  candidate_ciphertext TEXT,candidate_cipher_sha256 TEXT,candidate_digest TEXT UNIQUE,key_sha256 TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('queued','prepared','attested','commit_uncertain','committed','promoted','prepare_uncertain','revoke_pending','revoked','failed','expired')),
  issued_at INTEGER,candidate_expires_at INTEGER,expires_at INTEGER,prepared_proof_mac TEXT,committed_proof_mac TEXT,revoked_proof_mac TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS crm_manager_open_issue_v1 ON crm_manager_operations_v1(lifecycle_id)
  WHERE kind IN ('issue','renew') AND phase NOT IN ('promoted','failed','expired');`);
 const configured=db.prepare('SELECT issuer_id,namespace_id FROM crm_manager_configuration_v1 WHERE singleton=1').get();
 if(configured&&(configured.issuer_id!==issuerId||configured.namespace_id!==namespaceId))fail('MANAGED_CONFIGURATION_DRIFT');
 if(!configured)db.prepare('INSERT INTO crm_manager_configuration_v1 VALUES(1,?,?)').run(issuerId,namespaceId);
 const atomic=fn=>{if(db.isTransaction)fail('MANAGED_TRANSACTION_ALREADY_OPEN');db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const hook=()=>{if(!db.isTransaction)fail('MANAGED_IDENTITY_TRANSACTION_REQUIRED');};
 const manager=(userId,state,allowWriter=false,allowExpiredWriter=false)=>{
  uuid(userId);const u=db.prepare('SELECT id,email,role,state FROM users WHERE id=?').get(userId);
  const g=db.prepare('SELECT area,can_read,can_edit FROM grants WHERE user_id=?').all(userId);
  if(!u||u.role!=='manager'||u.state!==state||g.length!==1||g[0].area!=='growth'||g[0].can_read!==1||g[0].can_edit!==0&&!(allowWriter&&g[0].can_edit===1&&(allowExpiredWriter?writerRenewalBindingReady?.(userId):writerBindingReady?.(userId))===true))fail('MANAGED_MANAGER_DENIED');return u;
 };
 const current=userId=>db.prepare('SELECT l.* FROM crm_manager_current_v1 c JOIN crm_manager_lifecycles_v1 l USING(lifecycle_id) WHERE c.user_id=?').get(uuid(userId));
 const operation=id=>{const o=db.prepare('SELECT o.*,l.user_id,l.owner,l.version AS current_version,l.state AS lifecycle_state FROM crm_manager_operations_v1 o JOIN crm_manager_lifecycles_v1 l USING(lifecycle_id) WHERE o.operation_id=?').get(uuid(id));if(!o)fail('MANAGED_OPERATION_UNKNOWN');return o;};
 const live=o=>{const u=manager(o.user_id,'active');const l=current(o.user_id);if(!l||u.email!==o.owner||l.lifecycle_id!==o.lifecycle_id||l.version!==o.lifecycle_version||['revoking','revoked','failed'].includes(l.state))fail('MANAGED_LIFECYCLE_CHANGED');return l;};
 const publicState=l=>l?Object.freeze({state:l.state,generation:l.active_generation,expiresAt:l.expires_at??null}):null;
 function createLifecycle(userId){
  hook();const u=manager(userId,'invited'),old=current(userId);if(old&&old.state!=='revoked')fail('MANAGED_REVOCATION_REQUIRED');
  const id=crypto.randomUUID(),t=clock();
  db.prepare('INSERT INTO crm_manager_lifecycles_v1(lifecycle_id,user_id,owner,version,state,updated_at) VALUES(?,?,?,1,?,?)').run(id,userId,u.email,'awaiting_accept',t);
  db.prepare('INSERT INTO crm_manager_current_v1(user_id,lifecycle_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET lifecycle_id=excluded.lifecycle_id').run(userId,id);
  return {lifecycleId:id};
 }
 function enqueue(l,kind){
  const pending=db.prepare("SELECT operation_id FROM crm_manager_operations_v1 WHERE lifecycle_id=? AND kind IN ('issue','renew') AND phase NOT IN ('promoted','failed','expired')").get(l.lifecycle_id);
  if(pending)fail('MANAGED_OPERATION_PENDING');
  const id=crypto.randomUUID(),bearer=crypto.randomBytes(32).toString('hex'),cipher=encrypt(bearer),mac=digest(bearer),t=clock();
  if(typeof cipher!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cipher)||typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac))fail('MANAGED_CANDIDATE_INVALID');
  db.prepare('INSERT INTO crm_manager_operations_v1(operation_id,commit_operation_id,lifecycle_id,lifecycle_version,kind,generation,expected_generation,principal_id,candidate_ciphertext,candidate_cipher_sha256,candidate_digest,key_sha256,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,crypto.randomUUID(),l.lifecycle_id,l.version,kind,l.active_generation+1,l.active_generation,'dcrm-'+crypto.randomBytes(16).toString('hex'),cipher,crypto.createHash('sha256').update(cipher).digest('hex'),mac,crypto.createHash('sha256').update(bearer).digest('hex'),'queued',t,t);
  return {operationId:id};
 }
 function activateLifecycle(userId){
  hook();manager(userId,'active');const l=current(userId);if(!l||l.state!=='awaiting_accept')fail('MANAGED_LIFECYCLE_CHANGED');
  db.prepare("UPDATE crm_manager_lifecycles_v1 SET state='provisioning',version=version+1,updated_at=? WHERE lifecycle_id=?").run(clock(),l.lifecycle_id);
  return enqueue(current(userId),'issue');
 }
 // Master-authorized enrollment of an existing active identity. The caller
 // owns the identity transaction and the signed brand binding. This is only
 // the first READ lifecycle: retired/failed history and manual keys cannot
 // be adopted or rearmed. Promotion still needs the original remote proofs.
 function enrollActiveLifecycle(userId){
  hook();const u=manager(userId,'active');
  if(current(userId)||db.prepare('SELECT 1 FROM crm_manager_lifecycles_v1 WHERE user_id=?').get(userId))fail('MANAGED_LIFECYCLE_CHANGED');
  if(db.prepare('SELECT 1 FROM upstream_credentials WHERE user_id=?').get(userId))fail('MANAGED_LEGACY_CREDENTIAL_DENIED');
  const id=crypto.randomUUID(),t=clock();
  db.prepare('INSERT INTO crm_manager_lifecycles_v1(lifecycle_id,user_id,owner,version,state,updated_at) VALUES(?,?,?,2,?,?)').run(id,userId,u.email,'provisioning',t);
  db.prepare('INSERT INTO crm_manager_current_v1(user_id,lifecycle_id) VALUES(?,?)').run(userId,id);
  return {lifecycleId:id,...enqueue(current(userId),'issue')};
 }
 function renew(userId){return atomic(()=>{manager(userId,'active');const l=current(userId);if(!l||l.state!=='ready'||l.expires_at<=clock())fail('MANAGED_NOT_READY');return enqueue(l,'renew');});}
 // Corporate-only private renewal admission. This verifies the retained
 // original identity/generation/slot; it never grants READ or ignores expiry
 // in credentialReady(), readBinding(), attestation or HTTP authorization.
 function renewalReady(userId){
  if(typeof writerRenewalBindingReady!=='function')return false;
  try{const u=manager(userId,'active',true,true),l=current(userId);return !!l&&u.email===l.owner&&l.state==='ready'&&l.active_generation>0&&slotMatches(l)&&!db.prepare("SELECT 1 FROM crm_manager_operations_v1 WHERE lifecycle_id=? AND kind IN('issue','renew') AND phase NOT IN('promoted','failed','expired')").get(l.lifecycle_id);}catch{return false;}
 }
 function renewExpired(userId){return atomic(()=>{
  if(typeof writerRenewalBindingReady!=='function')fail('MANAGED_NOT_READY');
  manager(userId,'active');const l=current(userId);
  if(!l||l.state!=='ready'||l.expires_at>clock()||!renewalReady(userId))fail('MANAGED_NOT_READY');
  return enqueue(l,'renew');
 });}
 function retryIssue(userId){return atomic(()=>{manager(userId,'active');const l=current(userId);if(!l||l.state!=='provisioning'||l.active_generation!==0)fail('MANAGED_NOT_READY');return enqueue(l,'issue');});}
 const proofMac=proof=>digest('manager-receipt:'+canonical(proof));
 function intactCandidate(o){try{if(typeof o.candidate_ciphertext!=='string'||crypto.createHash('sha256').update(o.candidate_ciphertext).digest('hex')!==o.candidate_cipher_sha256)fail('MANAGED_CANDIDATE_INVALID');const bearer=decrypt(o.candidate_ciphertext);if(typeof bearer!=='string'||!/^[a-f0-9]{64}$/.test(bearer)||digest(bearer)!==o.candidate_digest||crypto.createHash('sha256').update(bearer).digest('hex')!==o.key_sha256)fail('MANAGED_CANDIDATE_INVALID');return bearer;}catch{fail('MANAGED_CANDIDATE_INVALID');}}
 // Internal requests contain a digest, never the bearer or ciphertext.
 function request(operationId){
  const o=operation(operationId);if(o.kind==='revoke')return Object.freeze({operationId:o.operation_id,userId:o.user_id,lifecycleId:o.lifecycle_id,owner:o.owner});
  live(o);if(['promoted','failed','expired'].includes(o.phase))fail('MANAGED_OPERATION_CLOSED');
  return Object.freeze({operationId:o.operation_id,userId:o.user_id,lifecycleId:o.lifecycle_id,owner:o.owner,principalId:o.principal_id,keySha256:o.key_sha256,generation:o.generation,expectedGeneration:o.expected_generation});
 }
 function recordPrepared(operationId,proof){return atomic(()=>{
  const o=operation(operationId);live(o);const t=clock();
  if(!['queued','prepare_uncertain','prepared'].includes(o.phase)||!exact(proof,PREPARED)||proof.schema!==RECEIPT_SCHEMA||proof.issuerId!==issuerId||proof.namespaceId!==namespaceId||proof.action!==(o.kind==='issue'?'prepare_read':'renew_read')||proof.state!=='prepared'||proof.operationId!==o.operation_id||proof.userId!==o.user_id||proof.lifecycleId!==o.lifecycle_id||proof.owner!==o.owner||proof.principalId!==o.principal_id||proof.generation!==o.generation||proof.expectedGeneration!==o.expected_generation||proof.area!=='growth'||proof.slot!=='crm-panel-read'||proof.role!=='manager'||!caps(proof.caps)||!Number.isSafeInteger(proof.issuedAt)||proof.issuedAt<0||proof.issuedAt>t+30000||proof.candidateExpiresAt!==proof.issuedAt+600000||proof.expiresAt!==proof.issuedAt+14*86400000)fail('MANAGED_RECEIPT_DENIED');
  if(o.candidate_expires_at!==null&&(o.issued_at!==proof.issuedAt||o.candidate_expires_at!==proof.candidateExpiresAt||o.expires_at!==proof.expiresAt))fail('MANAGED_RECEIPT_DRIFT');
  const mac=proofMac(proof);if(o.prepared_proof_mac!==null&&o.prepared_proof_mac!==mac)fail('MANAGED_RECEIPT_DRIFT');
  db.prepare("UPDATE crm_manager_operations_v1 SET phase='prepared',issued_at=?,candidate_expires_at=?,expires_at=?,prepared_proof_mac=?,updated_at=? WHERE operation_id=?").run(proof.issuedAt,proof.candidateExpiresAt,proof.expiresAt,mac,t,operationId);return {ok:true};
 });}
 function candidateForAttestation(operationId){const o=operation(operationId);live(o);if(o.phase!=='prepared'||o.candidate_expires_at<=clock())fail('MANAGED_CANDIDATE_DENIED');return intactCandidate(o);}
 function recordAttestation(operationId,proof){return atomic(()=>{const o=operation(operationId);live(o);if(o.phase!=='prepared'||o.candidate_expires_at<=clock()||!exact(proof,['owner','principalId','caps'])||proof.owner!==o.owner||proof.principalId!==o.principal_id||!caps(proof.caps))fail('MANAGED_ATTESTATION_DENIED');db.prepare("UPDATE crm_manager_operations_v1 SET phase='attested',updated_at=? WHERE operation_id=?").run(clock(),operationId);return {ok:true};});}
 function beginPrepare(operationId){return atomic(()=>{const o=operation(operationId);live(o);if(!['queued','prepare_uncertain'].includes(o.phase))fail('MANAGED_PREPARE_DENIED');db.prepare("UPDATE crm_manager_operations_v1 SET phase='prepare_uncertain',updated_at=? WHERE operation_id=?").run(clock(),operationId);return request(operationId);});}
 function commitOperationId(operationId){const o=operation(operationId);live(o);if(!['attested','commit_uncertain','committed'].includes(o.phase))fail('MANAGED_COMMIT_DENIED');return o.commit_operation_id;}
 function commitDescriptor(operationId){const o=operation(operationId);live(o);if(!['attested','commit_uncertain','committed'].includes(o.phase))fail('MANAGED_COMMIT_DENIED');return Object.freeze({action:'commit_read',args:Object.freeze({operationId:o.commit_operation_id,prepareOperationId:o.operation_id,userId:o.user_id,lifecycleId:o.lifecycle_id,owner:o.owner,principalId:o.principal_id,keySha256:o.key_sha256,generation:o.generation,expectedGeneration:o.expected_generation,issuedAt:o.issued_at,candidateExpiresAt:o.candidate_expires_at,expiresAt:o.expires_at})});}
 function beginCommit(operationId){return atomic(()=>{const o=operation(operationId);live(o);if(!['attested','commit_uncertain'].includes(o.phase)||o.phase==='attested'&&o.candidate_expires_at<=clock())fail('MANAGED_COMMIT_DENIED');db.prepare("UPDATE crm_manager_operations_v1 SET phase='commit_uncertain',updated_at=? WHERE operation_id=?").run(clock(),operationId);return commitDescriptor(operationId);});}
 function recordCommitted(operationId,proof){return atomic(()=>{const o=operation(operationId);live(o);const t=clock();if(!['commit_uncertain','committed','promoted'].includes(o.phase)||!exact(proof,COMMITTED)||proof.schema!==RECEIPT_SCHEMA||proof.issuerId!==issuerId||proof.namespaceId!==namespaceId||proof.action!=='commit_read'||proof.state!=='committed'||proof.operationId!==o.commit_operation_id||proof.prepareOperationId!==o.operation_id||proof.userId!==o.user_id||proof.lifecycleId!==o.lifecycle_id||proof.owner!==o.owner||proof.principalId!==o.principal_id||proof.generation!==o.generation||proof.expectedGeneration!==o.expected_generation||proof.area!=='growth'||proof.slot!=='crm-panel-read'||proof.role!=='manager'||!caps(proof.caps)||proof.issuedAt!==o.issued_at||proof.candidateExpiresAt!==o.candidate_expires_at||proof.expiresAt!==o.expires_at||proof.expiresAt<=t||!Number.isSafeInteger(proof.committedAt)||proof.committedAt<o.issued_at||proof.committedAt>=o.candidate_expires_at||proof.committedAt>t+30000||proof.revokedGeneration!==(o.expected_generation===0?null:o.expected_generation))fail('MANAGED_COMMIT_DENIED');const mac=proofMac(proof);if(o.committed_proof_mac!==null&&o.committed_proof_mac!==mac)fail('MANAGED_RECEIPT_DRIFT');if(o.phase!=='promoted')db.prepare("UPDATE crm_manager_operations_v1 SET phase='committed',committed_proof_mac=?,updated_at=? WHERE operation_id=?").run(mac,t,operationId);return {ok:true};});}
 // Safe only for a prepared generation for which beginCommit never ran.
 // A potentially sent commit must be reconciled through its persistent ID.
 function expireCandidate(operationId){return atomic(()=>{const o=operation(operationId);live(o);if(!['prepared','attested'].includes(o.phase)||o.candidate_expires_at>clock())fail('MANAGED_EXPIRY_RECONCILIATION_REQUIRED');db.prepare("UPDATE crm_manager_operations_v1 SET phase='expired',candidate_ciphertext=NULL,key_sha256=NULL,updated_at=? WHERE operation_id=?").run(clock(),operationId);return {ok:true};});}
 function promote(operationId){return atomic(()=>{
  const o=operation(operationId);const l=live(o);if(o.phase==='promoted'&&l.active_generation===o.generation)return {ok:true};
  if(o.phase!=='committed'||o.expires_at<=clock()||l.active_generation!==o.expected_generation)fail('MANAGED_PROMOTION_DENIED');
  intactCandidate(o);
  if(db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>?').get(o.candidate_digest,o.user_id))fail('MANAGED_CREDENTIAL_REUSED');
  const prior=db.prepare("SELECT 1 FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(o.user_id);
  if(prior&&l.active_generation===0)fail('MANAGED_LEGACY_CREDENTIAL_DENIED');
  if(l.active_generation>0&&!slotMatches(l))fail('MANAGED_ACTIVE_CREDENTIAL_DRIFT');
  db.prepare("INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,'crm-panel-read',?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_digest=excluded.key_digest,updated_at=excluded.updated_at").run(o.user_id,o.candidate_ciphertext,o.candidate_digest,clock());
  db.prepare("UPDATE crm_manager_lifecycles_v1 SET state='ready',active_generation=?,active_principal=?,expires_at=?,updated_at=? WHERE lifecycle_id=?").run(o.generation,o.principal_id,o.expires_at,clock(),o.lifecycle_id);
  db.prepare("UPDATE crm_manager_operations_v1 SET phase='promoted',candidate_ciphertext=NULL,key_sha256=NULL,updated_at=? WHERE operation_id=?").run(clock(),operationId);return {ok:true};
 });}
 function slotMatches(l){const row=db.prepare("SELECT u.encrypted_key,u.key_digest,o.candidate_digest,o.candidate_cipher_sha256 FROM upstream_credentials u JOIN crm_manager_operations_v1 o ON o.lifecycle_id=? AND o.generation=? AND o.principal_id=? AND o.phase='promoted' WHERE u.user_id=? AND u.slot='crm-panel-read'").get(l.lifecycle_id,l.active_generation,l.active_principal,l.user_id);return !!row&&row.key_digest===row.candidate_digest&&crypto.createHash('sha256').update(row.encrypted_key).digest('hex')===row.candidate_cipher_sha256;}
 function stageRevoke(userId){
  hook();const l=current(userId);if(!l)return {managed:false};
  const prior=db.prepare("SELECT operation_id FROM crm_manager_operations_v1 WHERE lifecycle_id=? AND kind='revoke'").get(l.lifecycle_id);if(prior)return {managed:true,operationId:prior.operation_id};
  const id=crypto.randomUUID(),t=clock();db.prepare("UPDATE crm_manager_lifecycles_v1 SET state='revoking',version=version+1,updated_at=? WHERE lifecycle_id=?").run(t,l.lifecycle_id);
  db.prepare("INSERT INTO crm_manager_operations_v1(operation_id,lifecycle_id,lifecycle_version,kind,generation,expected_generation,phase,created_at,updated_at) VALUES(?,?,?,'revoke',0,0,'revoke_pending',?,?)").run(id,l.lifecycle_id,l.version+1,t,t);
  return {managed:true,operationId:id};
 }
 function confirmRevoked(operationId,proof){return atomic(()=>{const o=operation(operationId);if(o.kind!=='revoke'||!exact(proof,REVOKED)||proof.schema!==RECEIPT_SCHEMA||proof.issuerId!==issuerId||proof.namespaceId!==namespaceId||proof.action!=='revoke_read'||proof.operationId!==o.operation_id||proof.state!=='revoked'||proof.userId!==o.user_id||proof.lifecycleId!==o.lifecycle_id||proof.owner!==o.owner||proof.allGenerationsRevoked!==true||proof.revocationMode!=='lifecycle'||!Number.isSafeInteger(proof.effectiveAt)||proof.effectiveAt<0||proof.effectiveAt>clock()+30000||!Number.isSafeInteger(proof.revokedCount)||proof.revokedCount<0)fail('MANAGED_REVOCATION_DENIED');const mac=proofMac(proof);if(o.revoked_proof_mac!==null&&o.revoked_proof_mac!==mac)fail('MANAGED_RECEIPT_DRIFT');db.prepare('UPDATE crm_manager_operations_v1 SET revoked_proof_mac=? WHERE operation_id=?').run(mac,operationId);db.prepare("UPDATE crm_manager_lifecycles_v1 SET state='revoked',updated_at=? WHERE lifecycle_id=?").run(clock(),o.lifecycle_id);db.prepare("UPDATE crm_manager_operations_v1 SET phase=CASE WHEN kind='revoke' THEN 'revoked' ELSE 'failed' END,candidate_ciphertext=NULL,key_sha256=NULL,updated_at=? WHERE lifecycle_id=? AND phase<>'promoted'").run(clock(),o.lifecycle_id);return {ok:true};});}
 function status(userId){return publicState(current(userId));}
 // Private coordinator projection. Never includes a bearer, digest, ciphertext,
 // receipt, identifier or SQL row; the gateway must not serialize this API.
 function operationState(operationId){
  const o=operation(operationId),l=current(o.user_id);let isCurrent=!!l&&l.lifecycle_id===o.lifecycle_id&&l.version===o.lifecycle_version;
  if(o.kind!=='revoke')try{isCurrent=isCurrent&&manager(o.user_id,'active').email===o.owner&&!['revoking','revoked','failed'].includes(l?.state);}catch{isCurrent=false;}
  if(o.phase==='promoted')isCurrent=isCurrent&&l.active_generation===o.generation&&l.active_principal===o.principal_id&&credentialReady(o.user_id)===true;
  return Object.freeze({kind:o.kind,phase:o.phase,candidateExpiresAt:o.candidate_expires_at??null,lifecycleState:o.lifecycle_state,current:isCurrent});
 }
 // Private bounded intent discovery. No ciphertext, bearer, digest or identity
 // data is projected. TTL is deliberately not filtered: reconciliation owns it.
 function pendingOperations(maximum){
  if(!Number.isInteger(maximum)||maximum<1||maximum>8)fail('MANAGED_PENDING_LIMIT_INVALID');
  if(db.isTransaction)fail('MANAGED_TRANSACTION_ALREADY_OPEN');
  const rows=db.prepare(`SELECT o.operation_id FROM crm_manager_operations_v1 o
   JOIN crm_manager_lifecycles_v1 l ON l.lifecycle_id=o.lifecycle_id
   LEFT JOIN crm_manager_current_v1 c ON c.user_id=l.user_id
   LEFT JOIN users u ON u.id=l.user_id
   WHERE l.state<>'awaiting_accept' AND (
    (o.kind='revoke' AND o.phase='revoke_pending') OR
    (o.kind IN ('issue','renew') AND o.phase IN ('queued','prepare_uncertain','prepared','attested','commit_uncertain','committed')
     AND c.lifecycle_id=o.lifecycle_id AND l.version=o.lifecycle_version AND l.state IN ('provisioning','ready')
     AND u.role='manager' AND u.state='active' AND u.email=l.owner
     AND (SELECT count(*) FROM grants g WHERE g.user_id=u.id)=1
     AND EXISTS(SELECT 1 FROM grants g WHERE g.user_id=u.id AND g.area='growth' AND g.can_read=1 AND g.can_edit=0)))
   ORDER BY CASE WHEN o.kind='revoke' THEN 0 ELSE 1 END,o.created_at,o.operation_id LIMIT ?`).all(maximum);
  return Object.freeze(rows.map(row=>uuid(row.operation_id)));
 }
 function credentialReady(userId){const l=current(userId);if(!l)return null;try{if(manager(userId,'active',true).email!==l.owner)return false;}catch{return false;}if(l.state!=='ready'||l.expires_at<=clock()||!slotMatches(l))return false;return !db.prepare("SELECT 1 FROM crm_manager_operations_v1 WHERE lifecycle_id=? AND phase IN ('commit_uncertain','committed') LIMIT 1").get(l.lifecycle_id);}
 // PRIVATE binding for the reviewed managed-read bridge. Never serialize it.
 function readBinding(userId){
  if(credentialReady(userId)!==true)fail('MANAGED_READ_BINDING_DENIED');
  const l=current(userId);
  return Object.freeze({userId:l.user_id,owner:l.owner,lifecycleId:l.lifecycle_id,lifecycleVersion:l.version,principalId:l.active_principal,generation:l.active_generation,expiresAt:l.expires_at});
 }
 return Object.freeze({createLifecycle,activateLifecycle,enrollActiveLifecycle,renew,renewExpired,renewalReady,retryIssue,request,beginPrepare,recordPrepared,candidateForAttestation,recordAttestation,commitOperationId,commitDescriptor,beginCommit,recordCommitted,promote,expireCandidate,stageRevoke,confirmRevoked,status,operationState,pendingOperations,credentialReady,readBinding});
}
module.exports={createManagerJournal};
