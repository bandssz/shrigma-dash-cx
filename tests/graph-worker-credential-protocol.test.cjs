'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,D,F}=require('./graph-worker-credential-fixture.cjs');
test('reviewed plan persists intent before its single credential attempt and requires independent committed readback',async t=>{
 const f=fixture(t),p=await f.prepare(),result=await f.preparer.provision(p.plan_hash);assert.equal(f.writes(),1);assert.equal(result.credential_prepared,true);assert.equal(result.worker_login,false);assert.equal(result.execution_enabled,false);assert.equal(result.independent_commit_verified,true);
 assert.equal(f.store.read('provision-intent').sql_hash,p.sql_hash);assert.deepEqual(f.store.read('provision-response'),{acknowledged:true});
 assert.ok(fs.readdirSync(f.directory).every(n=>(fs.statSync(path.join(f.directory,n)).mode&0o777)===0o600));
 await assert.rejects(f.preparer.provision(p.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(f.writes(),1);
});
test('lost response reconciles committed ciphertext/hash without generating again; no-effect failure stays blocked',async t=>{
 for(const committed of [true,false]){const f=fixture(t),p=await f.prepare();f.lose(committed);await assert.rejects(f.preparer.provision(p.plan_hash),{message:'GRAPH_CREDENTIAL_WRITE_UNCONFIRMED'});assert.deepEqual(f.store.read('provision-response'),{acknowledged:false,code:'WRITE_UNCONFIRMED'});
  await assert.rejects(f.preparer.provision(p.plan_hash),/UNCERTAIN_RECONCILE/);
  if(committed){const r=f.receipt();assert.equal((await f.preparer.reconcile()).credential_prepared,true);assert.deepEqual(f.receipt(),r);}else await assert.rejects(f.preparer.reconcile(),/AUTH_UNCONFIRMED/);
  assert.equal(f.writes(),1);const evidence=fs.readdirSync(f.directory).map(n=>fs.readFileSync(path.join(f.directory,n),'utf8')).join('');assert.doesNotMatch(evidence,/PRIVATE ERROR|RAW RESPONSE/);
 }
});
test('fresh database, role OID, workflow/utility and scope drift stop before intent or credential SQL',async t=>{
 const changes=[f=>f.change(m=>({...m,auth:{...m.auth,password_null:false}})),f=>f.change(m=>({...m,worker_identity:{...m.worker_identity,oid:'17002'}})),f=>f.change(m=>({...m,default_acls:[{unexpected:true}]})),f=>f.changeIdentity(i=>({...i,workflows:i.workflows.map((w,n)=>n? w:{...w,hash:F.h(9)})})),f=>f.changeIdentity(i=>({...i,utility:{...i.utility,version:'changed'}})),f=>f.change(m=>({...m,graph:{...m.graph,graph_shape:F.m(9)}}))];
 for(const change of changes){const f=fixture(t),p=await f.prepare();change(f);await assert.rejects(f.preparer.provision(p.plan_hash),/PREFLIGHT_DRIFT/);assert.equal(f.writes(),0);assert.equal(f.store.has('provision-intent'),false);}
});
test('missing pins, raw workflow profiles or ambiguous PG references cannot prepare a plan',async t=>{
 for(const change of [f=>{f.inputs.scopeReview.scope_hash=F.h(9);},f=>{f.inputs.publicKey.validation_receipt_hash=F.h(9);},f=>{f.inputs.predecessor.baseAnchor.reviewed.identity_hash=F.h(9);},f=>f.changeIdentity(i=>({...i,workflows:i.workflows.map((w,n)=>n?w:{...w,shared:[{user:{email:'synthetic@example.invalid'}}]})})),f=>f.changeIdentity(i=>({...i,utility:{...i.utility,ids:['one','two']}}))]){
  const f=fixture(t);change(f);await assert.rejects(f.prepare(),/GRAPH_/);assert.equal(f.store.has('plan'),false);assert.equal(f.writes(),0);
 }
});
test('same-session readback cannot qualify a commit and remains reconcile-only',async t=>{
 const f=fixture(t),p=await f.prepare();f.sameReadSession();await assert.rejects(f.preparer.provision(p.plan_hash),/INDEPENDENT_READBACK/);assert.equal(f.store.has('provision-verified'),false);await assert.rejects(f.preparer.provision(p.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(f.writes(),1);
});
test('ciphertext, key, predecessor, credential verifier hash or post-readback privilege drift invalidate the receipt',async t=>{
 for(const change of [r=>({...r,ciphertext:'YmFk'}),r=>({...r,ciphertext_sha256:F.h(9)}),r=>({...r,key_sha256:F.h(9)}),r=>({...r,nonce:F.id(99)}),r=>({...r,predecessor_hash:F.h(9)}),r=>({...r,auth_proof_hash:F.h(9)}),r=>({...r,after_state:{...r.after_state,auth:{...r.after_state.auth,auth_proof_hash:F.h(9)}}})]){
  const f=fixture(t),p=await f.prepare();await f.preparer.provision(p.plan_hash);f.changeReceipt(change);await assert.rejects(f.preparer.verify(),/CIPHERTEXT|RECEIPT/);assert.equal(f.writes(),1);
 }
 const f=fixture(t),p=await f.prepare();await f.preparer.provision(p.plan_hash);f.change(m=>({...m,receipt_schema:{...m.receipt_schema,unexpected_acl:1}}));await assert.rejects(f.preparer.verify(),/RECEIPT_SCHEMA/);
});
test('wrong approval, tampered SQL and unreviewed snapshot cannot write',async t=>{
 const f=fixture(t);await assert.rejects(f.preparer.prepare({snapshot_sha256:F.h(9),...f.inputs}),/UNREVIEWED_SNAPSHOT/);
 const g=fixture(t),p=await g.prepare();await assert.rejects(g.preparer.provision(F.h(9)),/PLAN_APPROVAL/);await assert.rejects(g.preparer.reconcile(),/RECONCILE_STATE/);const plan=g.store.read('plan');plan.migration.sql+=' SELECT 1;';fs.writeFileSync(path.join(g.directory,'plan.json'),JSON.stringify(plan));await assert.rejects(g.preparer.provision(p.plan_hash),/PLAN_HASH/);assert.equal(g.writes(),0);
});
