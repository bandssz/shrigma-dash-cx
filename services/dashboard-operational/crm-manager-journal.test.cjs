'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createManagerJournal}=require('./crm-manager-journal.cjs');
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,role TEXT,state TEXT);
 CREATE TABLE grants(user_id TEXT,area TEXT,can_read INTEGER,can_edit INTEGER);
 CREATE TABLE upstream_credentials(user_id TEXT,slot TEXT,encrypted_key TEXT,key_digest TEXT,updated_at INTEGER,PRIMARY KEY(user_id,slot));`);
 const key=crypto.randomBytes(32);let time=1770000000000;
 const encrypt=v=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(v),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),b.toString('base64url')].join('.');};
 const decrypt=v=>{const[,i,t,b]=v.split('.'),d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(i,'base64url'));d.setAuthTag(Buffer.from(t,'base64url'));return Buffer.concat([d.update(Buffer.from(b,'base64url')),d.final()]).toString();};
 const issuerId=crypto.randomUUID(),namespaceId=crypto.randomUUID();
 const options={db,issuerId,namespaceId,encrypt,decrypt,digest:v=>crypto.createHmac('sha256',key).update(v).digest('hex'),now:()=>time};let journal=createManagerJournal(options);
 const txn=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const add=(role='manager',area='growth')=>{const id=crypto.randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,id+'@synthetic.invalid',role,'invited');db.prepare('INSERT INTO grants VALUES(?,?,1,0)').run(id,area);return id;};
 const start=id=>txn(()=>{journal.createLifecycle(id);db.prepare("UPDATE users SET state='active' WHERE id=?").run(id);return journal.activateLifecycle(id).operationId;});
 const prepared=id=>{const {keySha256,...r}=journal.request(id);return {...r,schema:'crm-manager-provision-receipt-v1',issuerId,namespaceId,action:r.expectedGeneration===0?'prepare_read':'renew_read',state:'prepared',area:'growth',slot:'crm-panel-read',role:'manager',caps:['read_content','list_history','submission'],issuedAt:time,candidateExpiresAt:time+600000,expiresAt:time+14*86400000};};
 const attest=(id,p)=>journal.recordAttestation(id,{owner:p.owner,principalId:p.principalId,caps:p.caps});
 const committed=(id,p)=>({...p,action:'commit_read',state:'committed',operationId:journal.commitOperationId(id),prepareOperationId:id,committedAt:time,revokedGeneration:p.expectedGeneration===0?null:p.expectedGeneration});
 const complete=id=>{const p=prepared(id);journal.recordPrepared(id,p);attest(id,p);journal.beginCommit(id);journal.recordCommitted(id,committed(id,p));journal.promote(id);return p;};
 return {db,add,start,txn,prepared,attest,committed,complete,issuerId,namespaceId,options,get j(){return journal;},restart(){journal=createManagerJournal(options);},advance(ms){time+=ms;},close(){db.close();}};
}
test('identity hooks roll back with the surrounding transaction and reject admin/other areas',()=>{
 const f=fixture();try{
  const id=f.add();assert.throws(()=>f.j.createLifecycle(id),/TRANSACTION_REQUIRED/);
  assert.throws(()=>f.txn(()=>{f.j.createLifecycle(id);throw Error('fail');}),/fail/);assert.equal(f.j.status(id),null);
  for(const bad of[f.add('superadmin'),f.add('manager','influs')])assert.throws(()=>f.start(bad),/MANAGER_DENIED/);
  f.start(id);assert.equal(f.j.status(id).state,'provisioning');assert.equal(f.j.credentialReady(id),false);
 }finally{f.close();}
});
test('candidate is durably encrypted once; restart and repeat requests preserve its identity',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),request=f.j.request(op),p=f.prepared(op);
  assert.ok(request.keySha256);assert.equal(Object.hasOwn(request,'bearer'),false);assert.equal(Object.hasOwn(request,'candidate_ciphertext'),false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM upstream_credentials').get().n,0);
  f.j.recordPrepared(op,p);const secret=f.j.candidateForAttestation(op);assert.equal(crypto.createHash('sha256').update(secret).digest('hex'),request.keySha256);
  const raw=JSON.stringify(f.db.prepare('SELECT * FROM crm_manager_operations_v1').all());assert.ok(!raw.includes(secret));
  f.restart();assert.deepEqual(f.j.request(op),request);assert.equal(f.j.candidateForAttestation(op),secret);f.j.recordPrepared(op,p);
  assert.throws(()=>createManagerJournal({...f.options,namespaceId:crypto.randomUUID()}),/CONFIGURATION_DRIFT/);
  assert.ok(!JSON.stringify(f.j.status(id)).includes(request.keySha256));
 }finally{f.close();}
});
test('receipt owner, permissions, expiry and principal cannot widen or replace the intended identity',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),p=f.prepared(op);
  for(const patch of[{owner:'other@synthetic.invalid'},{principalId:'legacy'},{caps:['draft']},{caps:['read_content,list_history,submission']},{extra:true},{candidateExpiresAt:p.candidateExpiresAt+1},{expiresAt:p.expiresAt+1},{generation:2},{role:'master'}])assert.throws(()=>f.j.recordPrepared(op,{...p,...patch}),/RECEIPT_DENIED/);
  f.j.recordPrepared(op,p);assert.throws(()=>f.j.recordPrepared(op,{...p,expiresAt:p.expiresAt-1}),/RECEIPT_DENIED/);
  assert.throws(()=>f.j.recordAttestation(op,{owner:p.owner,principalId:'other',caps:p.caps}),/ATTESTATION_DENIED/);
  assert.throws(()=>f.j.promote(op),/PROMOTION_DENIED/);assert.equal(f.j.credentialReady(id),false);
 }finally{f.close();}
});
test('commit requires attestation and its own persistent operation binding; promotion is idempotent',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),p=f.prepared(op);f.j.recordPrepared(op,p);
  assert.throws(()=>f.j.commitOperationId(op),/COMMIT_DENIED/);f.attest(op,p);const proof=f.committed(op,p),commit=proof.operationId;
  const descriptor=f.j.beginCommit(op);f.restart();assert.equal(f.j.commitOperationId(op),commit);assert.deepEqual(f.j.commitDescriptor(op),descriptor);assert.throws(()=>f.j.recordCommitted(op,{...proof,prepareOperationId:crypto.randomUUID()}),/COMMIT_DENIED/);
  f.j.recordCommitted(op,proof);assert.equal(f.j.credentialReady(id),false);f.j.promote(op);f.j.recordCommitted(op,proof);f.j.promote(op);assert.equal(f.j.credentialReady(id),true);
  const row=f.db.prepare('SELECT * FROM crm_manager_operations_v1 WHERE operation_id=?').get(op);assert.equal(row.candidate_ciphertext,null);assert.equal(row.key_sha256,null);
  f.advance(14*86400000);assert.equal(f.j.credentialReady(id),false);
 }finally{f.close();}
});
test('renewal retains the old active credential until confirmed commit and swaps only this manager',()=>{
 const f=fixture();try{
  const a=f.add(),b=f.add();f.complete(f.start(a));f.complete(f.start(b));
  const row=id=>f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(id),oldA=row(a),oldB=row(b);
  const op=f.j.renew(a).operationId,p=f.prepared(op);assert.equal(p.generation,2);assert.equal(p.expectedGeneration,1);
  assert.throws(()=>f.j.renew(a),/OPERATION_PENDING/);f.j.recordPrepared(op,p);f.attest(op,p);assert.deepEqual(row(a),oldA);assert.equal(f.j.credentialReady(a),true);
  f.j.beginCommit(op);assert.equal(f.j.credentialReady(a),false);f.restart();assert.equal(f.j.credentialReady(a),false);
  f.j.recordCommitted(op,f.committed(op,p));assert.equal(f.j.credentialReady(a),false);f.j.promote(op);assert.notEqual(row(a).key_digest,oldA.key_digest);assert.deepEqual(row(b),oldB);assert.equal(f.j.status(a).generation,2);
 }finally{f.close();}
});
test('a revoked lifecycle defeats late attestation/commit and preserves another manager and legacy admin',()=>{
 const f=fixture();try{
  const a=f.add(),b=f.add(),admin=f.add('superadmin');f.db.prepare('INSERT INTO upstream_credentials VALUES(?,?,?,?,?)').run(admin,'crm-panel-read','legacy-admin-cipher','legacy-admin-digest',1);
  f.complete(f.start(b));const untouched=f.db.prepare('SELECT * FROM upstream_credentials ORDER BY user_id').all();
  const op=f.start(a),p=f.prepared(op);f.j.recordPrepared(op,p);f.attest(op,p);f.j.beginCommit(op);const late=f.committed(op,p);
  const revoke=f.txn(()=>{const out=f.j.stageRevoke(a);f.db.prepare("UPDATE users SET state='disabled' WHERE id=?").run(a);return out.operationId;});
  assert.equal(f.j.status(a).state,'revoking');assert.equal(f.j.credentialReady(a),false);assert.throws(()=>f.j.recordCommitted(op,late),/MANAGER_DENIED|LIFECYCLE_CHANGED/);
  const req=f.j.request(revoke);assert.deepEqual(f.j.request(revoke),req);assert.equal(Object.hasOwn(req,'keySha256'),false);
  f.j.confirmRevoked(revoke,{...req,schema:'crm-manager-provision-receipt-v1',issuerId:f.issuerId,namespaceId:f.namespaceId,action:'revoke_read',state:'revoked',allGenerationsRevoked:true,revocationMode:'lifecycle',effectiveAt:0,revokedCount:1});assert.equal(f.j.status(a).state,'revoked');assert.deepEqual(f.db.prepare('SELECT * FROM upstream_credentials ORDER BY user_id').all(),untouched);
  assert.equal(f.db.prepare('SELECT candidate_ciphertext FROM crm_manager_operations_v1 WHERE operation_id=?').get(op).candidate_ciphertext,null);
 }finally{f.close();}
});
test('reinvite requires origin revocation, uses a new lifecycle and rejects old responses',()=>{
 const f=fixture();try{
  const id=f.add(),old=f.start(id);const original=f.j.request(old).lifecycleId;
  const rev=f.txn(()=>f.j.stageRevoke(id)).operationId;f.db.prepare("UPDATE users SET state='invited' WHERE id=?").run(id);
  assert.throws(()=>f.txn(()=>f.j.createLifecycle(id)),/REVOCATION_REQUIRED/);
  const r=f.j.request(rev);f.j.confirmRevoked(rev,{...r,schema:'crm-manager-provision-receipt-v1',issuerId:f.issuerId,namespaceId:f.namespaceId,action:'revoke_read',state:'revoked',allGenerationsRevoked:true,revocationMode:'lifecycle',effectiveAt:0,revokedCount:1});
  const next=f.start(id);assert.notEqual(f.j.request(next).lifecycleId,original);assert.throws(()=>f.j.request(old),/LIFECYCLE_CHANGED/);
  f.j.confirmRevoked(rev,{...r,schema:'crm-manager-provision-receipt-v1',issuerId:f.issuerId,namespaceId:f.namespaceId,action:'revoke_read',state:'revoked',allGenerationsRevoked:true,revocationMode:'lifecycle',effectiveAt:0,revokedCount:1});assert.equal(f.j.status(id).state,'provisioning');
 }finally{f.close();}
});
test('automatic provisioning refuses to adopt a manually installed legacy credential',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),p=f.prepared(op);f.j.recordPrepared(op,p);f.attest(op,p);f.j.beginCommit(op);f.j.recordCommitted(op,f.committed(op,p));
  f.db.prepare('INSERT INTO upstream_credentials VALUES(?,?,?,?,?)').run(id,'crm-panel-read','legacy-cipher','legacy-digest',1);
  assert.throws(()=>f.j.promote(op),/LEGACY_CREDENTIAL_DENIED/);assert.equal(f.db.prepare('SELECT encrypted_key FROM upstream_credentials WHERE user_id=?').get(id).encrypted_key,'legacy-cipher');
 }finally{f.close();}
});
test('expired prepared renewal can be replaced but a potentially sent commit must stay locked',()=>{
 const f=fixture();try{
  const id=f.add();f.complete(f.start(id));const op=f.j.renew(id).operationId,p=f.prepared(op);f.j.recordPrepared(op,p);f.attest(op,p);
  f.advance(600000);assert.equal(f.j.credentialReady(id),true);f.j.expireCandidate(op);const next=f.j.renew(id).operationId;assert.notEqual(next,op);
  const np=f.prepared(next);f.j.recordPrepared(next,np);f.attest(next,np);f.j.beginCommit(next);f.advance(600000);assert.throws(()=>f.j.expireCandidate(next),/RECONCILIATION_REQUIRED/);assert.equal(f.j.credentialReady(id),false);assert.throws(()=>f.j.renew(id),/OPERATION_PENDING/);
 }finally{f.close();}
});
test('a commit made before expiry is recoverable after candidate expiry, and a grant removal blocks reads',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),p=f.prepared(op);f.j.recordPrepared(op,p);f.attest(op,p);f.j.beginCommit(op);const historical=f.committed(op,p);
  f.advance(700000);f.restart();f.j.recordCommitted(op,historical);f.j.promote(op);assert.equal(f.j.credentialReady(id),true);
  f.db.prepare('UPDATE grants SET can_read=0 WHERE user_id=?').run(id);assert.equal(f.j.credentialReady(id),false);
 }finally{f.close();}
});
test('slot deletion or replacement blocks readiness and renewal cannot overwrite the drift',()=>{
 const f=fixture();try{
  const id=f.add();f.complete(f.start(id));const op=f.j.renew(id).operationId,p=f.prepared(op);f.j.recordPrepared(op,p);f.attest(op,p);f.j.beginCommit(op);f.j.recordCommitted(op,f.committed(op,p));
  f.db.prepare("UPDATE upstream_credentials SET encrypted_key='substituted' WHERE user_id=?").run(id);assert.equal(f.j.credentialReady(id),false);assert.throws(()=>f.j.promote(op),/ACTIVE_CREDENTIAL_DRIFT/);
  f.db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(id);assert.equal(f.j.credentialReady(id),false);assert.throws(()=>f.j.promote(op),/ACTIVE_CREDENTIAL_DRIFT/);
 }finally{f.close();}
});
test('candidate tampering cannot be attested or promoted and leaves recoverable intent intact',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),p=f.prepared(op);f.j.recordPrepared(op,p);const original=f.db.prepare('SELECT candidate_ciphertext FROM crm_manager_operations_v1 WHERE operation_id=?').get(op).candidate_ciphertext;
  f.db.prepare("UPDATE crm_manager_operations_v1 SET candidate_ciphertext='tampered' WHERE operation_id=?").run(op);assert.throws(()=>f.j.candidateForAttestation(op),/CANDIDATE_INVALID/);
  f.db.prepare('UPDATE crm_manager_operations_v1 SET candidate_ciphertext=? WHERE operation_id=?').run(original,op);f.attest(op,p);f.j.beginCommit(op);f.j.recordCommitted(op,f.committed(op,p));
  f.db.prepare("UPDATE crm_manager_operations_v1 SET candidate_ciphertext='tampered' WHERE operation_id=?").run(op);assert.throws(()=>f.j.promote(op),/CANDIDATE_INVALID/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM upstream_credentials').get().n,0);
  f.db.prepare('UPDATE crm_manager_operations_v1 SET candidate_ciphertext=? WHERE operation_id=?').run(original,op);f.j.promote(op);assert.equal(f.j.credentialReady(id),true);
 }finally{f.close();}
});
test('terminal commit receipt is immutable after restart and an expired first issue can retry',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),p=f.prepared(op);f.j.recordPrepared(op,p);f.attest(op,p);f.j.beginCommit(op);const committed=f.committed(op,p);f.j.recordCommitted(op,committed);f.restart();assert.throws(()=>f.j.recordCommitted(op,{...committed,committedAt:committed.committedAt+1}),/RECEIPT_DRIFT/);f.j.promote(op);
  const other=f.add(),expired=f.start(other),ep=f.prepared(expired);f.j.recordPrepared(expired,ep);f.advance(600000);f.j.expireCandidate(expired);const retry=f.j.retryIssue(other).operationId;assert.notEqual(retry,expired);assert.equal(f.j.request(retry).generation,1);assert.equal(f.j.credentialReady(other),false);
 }finally{f.close();}
});
test('a lost prepare acknowledgement is reconciled after expiry before a first issue retries',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),historical=f.prepared(op);f.j.beginPrepare(op);f.advance(700000);f.restart();assert.throws(()=>f.j.expireCandidate(op),/RECONCILIATION_REQUIRED/);
  f.j.recordPrepared(op,historical);assert.throws(()=>f.j.candidateForAttestation(op),/CANDIDATE_DENIED/);assert.throws(()=>f.attest(op,historical),/ATTESTATION_DENIED/);f.j.expireCandidate(op);assert.notEqual(f.j.retryIssue(id).operationId,op);
 }finally{f.close();}
});
test('private coordinator state is closed and follows revocation/reinvite without key material',()=>{
 const f=fixture();try{
  const id=f.add(),op=f.start(id),request=f.j.request(op);
  const state=f.j.operationState(op);assert.deepEqual(state,{kind:'issue',phase:'queued',candidateExpiresAt:null,lifecycleState:'provisioning',current:true});assert.ok(Object.isFrozen(state));
  assert.ok(!JSON.stringify(state).includes(request.keySha256)&&!JSON.stringify(state).includes(request.principalId)&&!JSON.stringify(state).includes(id));
  f.j.beginPrepare(op);assert.equal(f.j.operationState(op).phase,'prepare_uncertain');const p=f.prepared(op);f.j.recordPrepared(op,p);assert.equal(f.j.operationState(op).candidateExpiresAt,p.candidateExpiresAt);
  f.db.prepare('UPDATE grants SET can_read=0 WHERE user_id=?').run(id);assert.equal(f.j.operationState(op).current,false);f.db.prepare('UPDATE grants SET can_read=1 WHERE user_id=?').run(id);
  const rev=f.txn(()=>f.j.stageRevoke(id)).operationId;assert.equal(f.j.operationState(op).current,false);assert.equal(f.j.operationState(op).lifecycleState,'revoking');
  f.db.prepare("UPDATE users SET state='disabled' WHERE id=?").run(id);assert.equal(f.j.operationState(rev).current,true);
  const r=f.j.request(rev);f.j.confirmRevoked(rev,{...r,schema:'crm-manager-provision-receipt-v1',issuerId:f.issuerId,namespaceId:f.namespaceId,action:'revoke_read',state:'revoked',allGenerationsRevoked:true,revocationMode:'lifecycle',effectiveAt:0,revokedCount:1});
  f.db.prepare("UPDATE users SET state='invited' WHERE id=?").run(id);const fresh=f.start(id);assert.equal(f.j.operationState(fresh).current,true);assert.equal(f.j.operationState(rev).current,false);assert.equal(f.j.operationState(rev).phase,'revoked');
  assert.throws(()=>f.j.operationState(crypto.randomUUID()),/OPERATION_UNKNOWN/);
 }finally{f.close();}
});
test('promoted coordinator state is no longer current after renewal or final credential expiry',()=>{
 const f=fixture();try{
  const id=f.add(),first=f.start(id);f.complete(first);assert.equal(f.j.operationState(first).current,true);
  const renewal=f.j.renew(id).operationId;f.complete(renewal);assert.equal(f.j.operationState(first).current,false);assert.equal(f.j.operationState(renewal).current,true);
  f.advance(14*86400000);assert.equal(f.j.operationState(renewal).current,false);assert.equal(f.j.credentialReady(id),false);
 }finally{f.close();}
});
test('pending discovery requires an explicit bounded maximum and returns only frozen IDs',()=>{
 const f=fixture();try{const invited=f.add();f.txn(()=>f.j.createLifecycle(invited));assert.deepEqual(f.j.pendingOperations(8),[]);const op=f.start(f.add());for(const invalid of[undefined,null,0,9,-1,1.5,'8',true,NaN,Infinity,{},Symbol('limit')])assert.throws(()=>f.j.pendingOperations(invalid),/PENDING_LIMIT_INVALID/);f.txn(()=>assert.throws(()=>f.j.pendingOperations(8),/TRANSACTION_ALREADY_OPEN/));const value=f.j.pendingOperations(1);assert.deepEqual(value,[op]);assert.ok(Object.isFrozen(value));assert.throws(()=>value.push(crypto.randomUUID()),TypeError);}finally{f.close();}
});
test('all open issue phases remain discoverable across TTL expiry and restart without changing state',()=>{
 const f=fixture();try{
  const operations=[];
  for(const phase of['queued','prepare_uncertain','prepared','attested','commit_uncertain','committed']){f.advance(1);const op=f.start(f.add()),p=f.prepared(op);operations.push(op);if(phase!=='queued')f.j.beginPrepare(op);if(!['queued','prepare_uncertain'].includes(phase))f.j.recordPrepared(op,p);if(['attested','commit_uncertain','committed'].includes(phase))f.attest(op,p);if(['commit_uncertain','committed'].includes(phase))f.j.beginCommit(op);if(phase==='committed')f.j.recordCommitted(op,f.committed(op,p));}
  f.advance(700000);const before=f.db.prepare('SELECT * FROM crm_manager_operations_v1 ORDER BY operation_id').all();assert.deepEqual(f.j.pendingOperations(8),operations);f.restart();assert.deepEqual(f.j.pendingOperations(8),operations);assert.deepEqual(f.db.prepare('SELECT * FROM crm_manager_operations_v1 ORDER BY operation_id').all(),before);
 }finally{f.close();}
});
test('revocations precede an oversized backlog and discovery leaves administrator and legacy slots intact',()=>{
 const f=fixture();try{const ids=[],operations=[];for(let n=0;n<10;n++){f.advance(1);const id=f.add();ids.push(id);operations.push(f.start(id));}f.advance(100);const rev=f.txn(()=>f.j.stageRevoke(ids[0])).operationId;const admin=f.add('superadmin');f.db.prepare('INSERT INTO upstream_credentials VALUES(?,?,?,?,?)').run(admin,'crm-panel-read','SYNTHETIC_ADMIN_CIPHER','SYNTHETIC_ADMIN_DIGEST',1);const baseline=f.db.prepare('SELECT * FROM upstream_credentials').all();assert.deepEqual(f.j.pendingOperations(8),[rev,...operations.slice(1,8)]);assert.deepEqual(f.j.pendingOperations(1),[rev]);assert.deepEqual(f.db.prepare('SELECT * FROM upstream_credentials').all(),baseline);}finally{f.close();}
});
test('discovery excludes changed identities and all closed phases while retaining an open renewal',()=>{
 const f=fixture();try{
  for(const change of['disabled','email','edit','read','extraGrant']){const id=f.add();f.start(id);if(change==='disabled')f.db.prepare("UPDATE users SET state='disabled' WHERE id=?").run(id);if(change==='email')f.db.prepare("UPDATE users SET email='other@synthetic.invalid' WHERE id=?").run(id);if(change==='edit')f.db.prepare('UPDATE grants SET can_edit=1 WHERE user_id=?').run(id);if(change==='read')f.db.prepare('UPDATE grants SET can_read=0 WHERE user_id=?').run(id);if(change==='extraGrant')f.db.prepare("INSERT INTO grants VALUES(?,'influs',1,0)").run(id);}
  const ready=f.add();f.complete(f.start(ready));const renew=f.j.renew(ready).operationId;
  const expired=f.start(f.add()),ep=f.prepared(expired);f.j.recordPrepared(expired,ep);f.advance(600000);f.j.expireCandidate(expired);
  const awaiting=f.start(f.add());f.db.prepare("UPDATE crm_manager_lifecycles_v1 SET state='awaiting_accept' WHERE lifecycle_id=?").run(f.j.request(awaiting).lifecycleId);
  assert.deepEqual(f.j.pendingOperations(8),[renew]);
 }finally{f.close();}
});
test('historical revocation stays discoverable after reinvite without exposing old issue intentions',()=>{
 const f=fixture();try{const id=f.add(),old=f.start(id),rev=f.txn(()=>f.j.stageRevoke(id)).operationId,r=f.j.request(rev);f.j.confirmRevoked(rev,{...r,schema:'crm-manager-provision-receipt-v1',issuerId:f.issuerId,namespaceId:f.namespaceId,action:'revoke_read',state:'revoked',allGenerationsRevoked:true,revocationMode:'lifecycle',effectiveAt:0,revokedCount:1});f.db.prepare("UPDATE users SET state='invited' WHERE id=?").run(id);const fresh=f.start(id);f.db.prepare("UPDATE crm_manager_operations_v1 SET phase='revoke_pending' WHERE operation_id=?").run(rev);assert.equal(f.j.operationState(rev).current,false);assert.deepEqual(f.j.pendingOperations(8),[rev,fresh]);assert.equal(f.j.pendingOperations(8).includes(old),false);}finally{f.close();}
});
