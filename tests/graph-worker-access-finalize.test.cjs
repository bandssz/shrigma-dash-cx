'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fixture,ROOT,D,F,copy}=require('./graph-worker-credential-fixture.cjs');
const X=require('../tools/graph-worker-access/finalize.cjs');
async function setup(t){
 const f=fixture(t),prepared=await f.prepare(),verified=await f.preparer.provision(prepared.plan_hash),plan=f.store.read('plan'),receipt=f.receipt();
 const proof={plan,verified,receipt,reviewed:{plan_hash:plan.hash,verified_hash:D.sha(verified),receipt_hash:D.sha(receipt),sources:copy(plan.sources)}};
 const recovery={contract:'crm-graph-worker-recovery-v1',role:'crm_graph_worker',database:'listmonk',nonce:receipt.nonce,key_sha256:receipt.key_sha256,key_fingerprint:receipt.key_fingerprint,validation_receipt_hash:receipt.validation_receipt_hash,ciphertext_sha256:receipt.ciphertext_sha256,receipt_hash:D.sha(receipt),recovered_in_memory:true};
 let metadata=f.metadata(),identity=f.identity(),currentReceipt=copy(receipt),currentScope=copy(f.inputs.scopeReview),audits=0,writes=0,lose=false,effect=true,pid=7001,readPid=7002;
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'crm-worker-finalize-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const store=new D.FileStore(directory);
 const io={snapshot:async()=>copy({metadata,identity,receipt:currentReceipt,session_pid:pid}),independentReadback:async()=>copy({metadata,identity,receipt:currentReceipt,session_pid:readPid}),sql:async sql=>{writes++;const p=store.read('plan');assert.equal(store.has('finalize-intent'),true);assert.equal(sql,p.migration.accessPlan.migration.sql);if(effect){metadata=copy(p.migration.expected_metadata);metadata.graph.graph_seal=JSON.stringify(metadata.graph.graph_seal);metadata.graph.maintenance_seal=JSON.stringify(metadata.graph.maintenance_seal);}if(lose)throw Error('PRIVATE SQL ERROR MUST NOT BE STORED');return {private:'RAW MUST NOT BE STORED'};}};
 io.scopeAudit=async({worker_login})=>{audits++;assert.equal(metadata.worker_identity.role.login,worker_login);return copy(currentScope);};
 const finalizer=new X.Finalizer({root:ROOT,io,store});
 const guard={preparedProof:proof,scopeReview:copy(f.inputs.scopeReview),recovery};
 return {f,guard,proof,io,store,finalizer,directory,metadata:()=>copy(metadata),receipt:()=>copy(currentReceipt),writes:()=>writes,audits:()=>audits,changeScope:fn=>{currentScope=fn(currentScope);},change:fn=>{metadata=fn(metadata);},changeReceipt:fn=>{currentReceipt=fn(currentReceipt);},changeIdentity:fn=>{identity=fn(identity);},samePid:()=>{readPid=pid;},lose:(hasEffect=true)=>{lose=true;effect=hasEffect;},prepare:async()=>finalizer.prepare({snapshot_sha256:D.sha(await io.snapshot()),...guard})};
}
test('finalization binds committed preparation, recovered-key attestation and current audited scope without credential SQL',async t=>{
 const f=await setup(t),p=await f.prepare(),plan=f.store.read('plan'),sql=plan.migration.accessPlan.migration.sql;
 assert.match(sql,/^DO \$worker_access\$/);assert.match(sql,/ALTER ROLE crm_graph_worker LOGIN;/);assert.doesNotMatch(sql,/\bPASSWORD\s|CREATE\s+ROLE|GRANT\s|BEGIN;|COMMIT;/);assert.ok(!sql.includes(f.receipt().ciphertext));
 assert.match(sql,/pg_catalog\.format\('COMMENT ON SCHEMA/);
 assert.ok(sql.includes('pg_catalog.to_char(r.completed_at'));assert.ok(sql.includes(f.receipt().completed_at));
 const r=await f.finalizer.finalize(p.plan_hash);assert.equal(f.writes(),1);assert.equal(r.login_enabled,true);assert.equal(r.online_auth_verified,false);assert.equal(r.execution_enabled,false);assert.equal(r.service_created,false);assert.equal(r.independent_commit_verified,true);
 assert.deepEqual(f.metadata().off,f.f.metadata().off);assert.deepEqual(f.metadata().auth,f.f.metadata().auth);assert.deepEqual(f.metadata().graph.maintenance_control,f.f.metadata().graph.maintenance_control);
 assert.deepEqual(f.store.read('access-receipt'),plan.migration.accessReceipt);await assert.rejects(f.finalizer.finalize(p.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(f.writes(),1);
 assert.equal(f.audits(),3);
});
test('new privileges in another database stop LOGIN before intent, and post-commit scope drift is not accepted',async t=>{
 const f=await setup(t),p=await f.prepare();f.changeScope(s=>{s.connection_scope.database_audits[0].non_system_read=true;s.connection_scope.database_audits[0].catalog_hash=F.h(9);s.scope_hash=D.sha(s.connection_scope);return s;});
 await assert.rejects(f.finalizer.finalize(p.plan_hash),/LIVE_SCOPE_DRIFT/);assert.equal(f.writes(),0);assert.equal(f.store.has('finalize-intent'),false);
 const g=await setup(t),q=await g.prepare();await g.finalizer.finalize(q.plan_hash);g.changeScope(s=>{s.connection_scope.database_audits[0].catalog_hash=F.h(9);s.scope_hash=D.sha(s.connection_scope);return s;});await assert.rejects(g.finalizer.verify(),/LIVE_SCOPE_DRIFT/);assert.equal(g.writes(),1);
 const h=await setup(t);delete h.io.scopeAudit;await assert.rejects(h.prepare(),/LIVE_SCOPE_REQUIRED/);assert.equal(h.writes(),0);
});
test('missing or changed committed receipt, recovery, source and complete database pins cannot prepare LOGIN',async t=>{
 const changes=[f=>{f.guard.preparedProof.reviewed.verified_hash=F.h(9);},f=>{f.guard.preparedProof.verified.independent_commit_verified=false;},f=>{f.guard.preparedProof.plan.migration.sql+=' changed';},f=>{f.guard.preparedProof.receipt.ciphertext='YmFk';},f=>{f.guard.recovery.recovered_in_memory=false;},f=>{f.guard.recovery.nonce=F.id(99);},f=>{f.guard.scopeReview.scope_hash=F.h(9);},f=>{f.guard.scopeReview.connection_scope.database_audits.shift();},f=>{f.guard.scopeReview.database_inventory.shift();}];
 for(const change of changes){const f=await setup(t);change(f);await assert.rejects(f.prepare(),/GRAPH_/);assert.equal(f.writes(),0);assert.equal(f.store.has('plan'),false);assert.equal(f.store.has('finalize-intent'),false);}
});
test('fresh role, verifier, control, workflow or encrypted receipt drift stops before intent',async t=>{
 for(const change of [f=>f.change(m=>({...m,worker_identity:{...m.worker_identity,oid:'17002'}})),f=>f.change(m=>({...m,auth:{...m.auth,auth_proof_hash:F.h(8)}})),f=>f.change(m=>({...m,graph:{...m.graph,graph_control:{singleton:true,enabled:true}}})),f=>f.changeIdentity(i=>({...i,utility:{...i.utility,version:'changed'}})),f=>f.changeReceipt(r=>({...r,ciphertext:'YmFk'}))]){
  const f=await setup(t),p=await f.prepare();change(f);await assert.rejects(f.finalizer.finalize(p.plan_hash),/PREFLIGHT_DRIFT/);assert.equal(f.writes(),0);assert.equal(f.store.has('finalize-intent'),false);
 }
});
test('uncertain LOGIN response is reconciled by independent read only, never by ALTER again',async t=>{
 for(const committed of [true,false]){const f=await setup(t),p=await f.prepare();f.lose(committed);await assert.rejects(f.finalizer.finalize(p.plan_hash),{message:'GRAPH_WORKER_FINALIZE_WRITE_UNCONFIRMED'});await assert.rejects(f.finalizer.finalize(p.plan_hash),/UNCERTAIN_RECONCILE/);
  if(committed)assert.equal((await f.finalizer.reconcile()).login_enabled,true);else await assert.rejects(f.finalizer.reconcile(),/AFTER_DRIFT/);assert.equal(f.writes(),1);
  assert.doesNotMatch(fs.readdirSync(f.directory).map(n=>fs.readFileSync(path.join(f.directory,n),'utf8')).join(''),/PRIVATE SQL ERROR|RAW MUST/);
 }
});
test('same-session readback cannot prove commit; existing identical partial local receipts are resumed safely',async t=>{
 const f=await setup(t),p=await f.prepare();f.samePid();await assert.rejects(f.finalizer.finalize(p.plan_hash),/INDEPENDENT_READBACK/);assert.equal(f.store.has('finalize-verified'),false);assert.equal(f.writes(),1);
 const g=await setup(t),q=await g.prepare();g.lose();await assert.rejects(g.finalizer.finalize(q.plan_hash),/WRITE_UNCONFIRMED/);g.store.put('access-receipt',g.store.read('plan').migration.accessReceipt);assert.equal((await g.finalizer.reconcile()).login_enabled,true);assert.equal(g.writes(),1);
});
test('unrelated grants, original seals and OFF counts cannot change in final readback',async t=>{
 for(const mutate of [m=>{m.worker_identity.role.superuser=true;},m=>{m.graph.public_shape=F.m(9);},m=>{m.off.sources='1';},m=>{m.graph.maintenance_control.mode='closed';},m=>{m.receipt_schema.unexpected_acl=1;}]){
  const f=await setup(t),p=await f.prepare();await f.finalizer.finalize(p.plan_hash);f.change(m=>{mutate(m);return m;});await assert.rejects(f.finalizer.verify(),/AFTER_DRIFT/);assert.equal(f.writes(),1);
 }
});
