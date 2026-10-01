'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,L,A,D,F,ROOT,copy}=require('./graph-runtime-lineage-fixture.cjs');
const operational=m=>({...m.graph,worker_role_identity:m.worker_identity});
test('explicit adoption preserves historical pins and adds a reviewed extension without credentials or activation',async t=>{
 const x=fixture(t),before=x.c.metadata(),old=L.state(before),historic=A.validateHistoricalState({metadata:operational(before),...x.inputs.predecessor});
 assert.equal(historic.structural_valid,false);assert.equal(historic.login_authorized,false);
 assert.throws(()=>A.validateOperational({metadata:operational(before),...x.inputs.predecessor}),/CURRENT_DRIFT/);
 const p=await x.prepare(),r=await x.adopter.adopt(p.plan_hash),after=x.c.metadata(),extension=after.graph.graph_seal.runtime_lineage_extension;
 assert.equal(r.lineage_adopted,true);assert.equal(r.worker_login,false);assert.equal(r.credential_prepared,false);assert.equal(r.execution_enabled,false);assert.equal(x.writes(),1);
 const {runtime_lineage_extension,...preserved}=after.graph.graph_seal;assert.deepEqual(preserved,old.graph_seal);assert.deepEqual(after.auth,before.auth);assert.deepEqual(after.off,before.off);
 assert.equal(extension.previous_graph_seal_hash,D.sha(old.graph_seal));assert.equal(extension.graph_shape,before.graph.graph_shape);
 const lineage=x.store.read('plan').migration.predecessor,result=A.validateOperational({metadata:operational(after),...lineage});assert.deepEqual(result.order,['base','runtime']);assert.equal(result.policy_valid,false);
 assert.doesNotMatch(x.store.read('plan').migration.runtimePlan.migration.sql,/ALTER ROLE|GRANT |CREATE (?:ROLE|SCHEMA|TABLE)/);
 await assert.rejects(()=>x.adopter.adopt(p.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(x.writes(),1);
});
test('independent source, migration receipt, metadata and historical chain pins are mandatory',async t=>{
 const mutations=[x=>delete x.inputs.adoptionReview,x=>{x.inputs.adoptionReview.observed_metadata_hash=F.h('f');},x=>{x.inputs.adoptionReview.historical_state_hash=F.h('f');},x=>{x.inputs.adoptionReview.approved_migrations=[];},x=>{x.inputs.adoptionReview.approved_migrations[0].terminal_receipt_hash='pending';},x=>{x.inputs.adoptionReview.sources={'n8n/growth/journey-graph-lifecycle-publication.sql':F.h('f')};},x=>{x.inputs.adoptionReview.catalog_evidence_hash='unknown';},x=>{x.inputs.adoptionReview.extra=true;},x=>{x.inputs.predecessor.baseAnchor.reviewed.receipt_hash=F.h('f');}];
 for(const mutate of mutations){const x=fixture(t);mutate(x);await assert.rejects(()=>x.prepare(),/GRAPH_RUNTIME_LINEAGE_|GRAPH_WORKER_ACCESS_/);assert.equal(x.writes(),0);assert.equal(x.store.has('adopt-intent'),false);}
});
test('fresh role, template controls, workflows, source, metadata or scope drift stops before intent',async t=>{
 const changes=[x=>x.c.change(m=>({...m,worker_identity:{...m.worker_identity,oid:'17002'}})),x=>x.c.change(m=>({...m,graph:{...m.graph,graph_shape:F.m('f')}})),x=>x.c.change(m=>({...m,off:{...m.off,clones:'1'}})),x=>x.c.changeIdentity(i=>({...i,utility:{...i.utility,version:'different'}})),x=>x.scopeChange(s=>({...s,scope_hash:F.h('f')}))];
 for(const change of changes){const x=fixture(t),p=await x.prepare();change(x);await assert.rejects(()=>x.adopter.adopt(p.plan_hash),/PREFLIGHT_DRIFT|LIVE_SCOPE_DRIFT/);assert.equal(x.store.has('adopt-intent'),false);assert.equal(x.writes(),0);}
});
test('uncertain acknowledgment reconciles by independent read only; no-effect failure never writes twice',async t=>{
 for(const hasEffect of [true,false]){const x=fixture(t),p=await x.prepare();x.lose(hasEffect);await assert.rejects(()=>x.adopter.adopt(p.plan_hash),/WRITE_UNCONFIRMED/);assert.equal(x.writes(),1);assert.equal(JSON.stringify(x.store.read('adopt-response')).includes('PRIVATE'),false);
  if(hasEffect)assert.equal((await x.adopter.reconcile()).lineage_adopted,true);else await assert.rejects(()=>x.adopter.reconcile(),/AFTER_DRIFT/);
  await assert.rejects(()=>x.adopter.adopt(p.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(x.writes(),1);
 }
});
test('same-session and changed post-commit role or catalog readbacks cannot qualify adoption',async t=>{
 const x=fixture(t),p=await x.prepare();x.sameSession();await assert.rejects(()=>x.adopter.adopt(p.plan_hash),/INDEPENDENT_READBACK/);assert.equal(x.store.has('adopt-verified'),false);
 const y=fixture(t),q=await y.prepare();y.lose(true);await assert.rejects(()=>y.adopter.adopt(q.plan_hash),/WRITE_UNCONFIRMED/);y.c.change(m=>({...m,graph:{...m.graph,public_shape:F.m('f')}}));await assert.rejects(()=>y.adopter.reconcile(),/AFTER_DRIFT/);assert.equal(y.writes(),1);
});
test('runtime receipt never authorizes a changed original seal, omitted transition or repinned unreviewed adoption',async t=>{
 const x=fixture(t),p=await x.prepare();await x.adopter.adopt(p.plan_hash);const actual=operational(x.c.metadata()),proof=x.store.read('plan').migration.predecessor;
 const mutate=[v=>{v.runtimeReceipt.after.graph_seal.graph_shape=F.m('f');},v=>{v.runtimeReceipt.after.role_identity.oid='17002';},v=>{v.runtimeReview.adoption_review_hash=F.h('f');},v=>{v.runtimePlan.migration.sql+=' unreviewed';},v=>{v.runtimeReceipt.after.graph_seal.runtime_lineage_extension.observed_metadata_hash=F.h('f');},v=>{v.runtimeReceipt=null;v.runtimePlan=null;v.runtimeReview=null;}];
 for(const fn of mutate){const v=copy(proof);fn(v);assert.throws(()=>A.validateOperational({metadata:actual,...v}),/GRAPH_WORKER_ACCESS_/);}
 for(const k of ['graph_shape','public_shape','maintenance_shape']){const m=copy(actual);m[k]=F.m('f');assert.throws(()=>A.validateOperational({metadata:m,...proof}),/CURRENT_DRIFT/);}
});
test('credential preparation accepts only the complete, verified runtime predecessor without replacing its keys',async t=>{
 const x=fixture(t),p=await x.prepare();await x.adopter.adopt(p.plan_hash);const runtime=x.store.read('plan').migration.predecessor;
 x.c.inputs.predecessor=copy(runtime);const prepared=await x.c.prepare();assert.equal(prepared.worker_login,false);assert.equal(prepared.credential_prepared,false);
 const result=await x.c.preparer.provision(prepared.plan_hash);assert.equal(result.credential_prepared,true);assert.equal(result.worker_login,false);assert.equal(x.c.writes(),1);
 const bad=copy(x.c.inputs.predecessor);delete bad.runtimeReview;assert.throws(()=>D.preflight(x.c.store.read('before').metadata,{...x.c.inputs,predecessor:bad}),/PREDECESSOR/);
});
test('a directly supplied extension cannot bypass required review pins or claim a current structure',()=>{
 const input=F.inputs('base');assert.throws(()=>A.validateOperational({...input,runtimePlan:{},runtimeReview:{}}),/RUNTIME_UNEXPECTED/);
 const g=JSON.parse(input.metadata.graph_seal);g.runtime_lineage_extension={contract:L.CONTRACT};input.metadata.graph_seal=JSON.stringify(g);assert.throws(()=>A.validateOperational(input),/RUNTIME_EXTENSION/);
});
test('separate finalization keeps the complete runtime predecessor in the explicit access receipt',async t=>{
 const X=require('../tools/graph-worker-access/finalize.cjs'),x=fixture(t),p=await x.prepare();await x.adopter.adopt(p.plan_hash);
 x.c.inputs.predecessor=copy(x.store.read('plan').migration.predecessor);const prepared=await x.c.prepare(),verified=await x.c.preparer.provision(prepared.plan_hash),plan=x.c.store.read('plan'),receipt=x.c.receipt();
 const preparedProof={plan,verified,receipt,reviewed:{plan_hash:plan.hash,verified_hash:D.sha(verified),receipt_hash:D.sha(receipt),sources:copy(plan.sources)}};
 const recovery={contract:'crm-graph-worker-recovery-v1',role:'crm_graph_worker',database:'listmonk',nonce:receipt.nonce,key_sha256:receipt.key_sha256,key_fingerprint:receipt.key_fingerprint,validation_receipt_hash:receipt.validation_receipt_hash,ciphertext_sha256:receipt.ciphertext_sha256,receipt_hash:D.sha(receipt),recovered_in_memory:true};
 const result=X.atomicFinalize({root:ROOT,before:await x.c.io.snapshot(),preparedProof,scopeReview:x.c.inputs.scopeReview,recovery,nonce:F.id(88)});
 const proof={...x.c.inputs.predecessor,accessReceipt:result.accessReceipt,accessPlan:result.accessPlan,accessReview:result.accessReview};
 const actual=A.validateOperational({metadata:operational(result.expected_metadata),...proof});assert.deepEqual(actual.order,['base','runtime','access']);assert.equal(actual.login_authorized,false);assert.equal(actual.execution_authorized,false);
 assert.deepEqual(result.accessReceipt.after.graph_seal.runtime_lineage_extension,result.accessReceipt.before.graph_seal.runtime_lineage_extension);
 assert.deepEqual(result.expected_metadata.auth,x.c.metadata().auth);assert.equal(x.c.writes(),1);
});
