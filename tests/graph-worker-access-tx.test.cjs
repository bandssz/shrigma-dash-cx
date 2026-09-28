'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const D=require('../tools/maintenance-tx-deploy/deploy.cjs'),A=require('../tools/graph-worker-access/contract.cjs');
const F=require('./graph-worker-access-fixture.cjs'),T=require('./maintenance-tx-deploy-fixture.cjs');
function txMetadata(current,dependencies){return {database:'listmonk',role:'postgres',schema:'crm_maintenance_candidate',shape:current.maintenance_legacy_shape,seal:current.maintenance_seal,dependencies,graph_seal:current.graph_seal,graph_shape:current.graph_shape,graph_maintenance_shape:current.maintenance_shape,graph_public_shape:current.public_shape,graph_worker_role:current.worker_role,graph_worker_identity:current.worker_role_identity};}
function setup(t){
 const f=T.fixture();t.after(()=>fs.rmSync(f.directory,{recursive:true,force:true}));const input=F.inputs('access');
 const proof=Object.fromEntries(['baseAnchor','accessReceipt','accessPlan','accessReview'].map(k=>[k,F.clone(input[k])]));
 let metadata=txMetadata(input.metadata,f.before.dependencies),writes=0,lose=false;
 f.io.metadata=async()=>F.clone(metadata);f.guard.worker_access=proof;
 f.guard.retention={seal_sha256:D.sha(D.previousSeal(metadata,proof)),shape:metadata.shape,control_version:2};
 f.io.sql=async sql=>{
  writes++;assert.equal(f.store.has('install-intent'),true);const p=f.store.read('plan');assert.equal(sql,p.migration.sql);
  // Exercise the protocol/readback with a synthetic receipt. This fixture never
  // executes SQL or provisions LOGIN; the existing PG runner covers TX SQL.
  const tx=F.tx(proof.accessReceipt.after);tx.extension=F.clone(p.migration.graph.extension);tx.after.graph_seal.maintenance_extension=tx.extension;
  tx.after.maintenance_seal={...p.migration.seal,shape:tx.after.maintenance_seal.shape};metadata=txMetadata(F.metadata(tx.after),f.before.dependencies);
  if(lose)throw Error('SYNTHETIC_RESPONSE_LOST');return [];
 };
 return {...f,input,proof,writes:()=>writes,lose:()=>{lose=true;},change:fn=>{metadata=fn(metadata);},metadata:()=>F.clone(metadata)};
}
test('TX refuses an unproven LOGIN before plan/intent and compiles no access provisioning',async t=>{
 const f=setup(t);delete f.guard.worker_access;await assert.rejects(f.installer.prepare(f.guard),/GRAPH_ACCESS_PROOF/);assert.equal(f.writes(),0);assert.equal(f.store.has('plan'),false);assert.equal(f.store.has('install-intent'),false);
 const valid=setup(t),p=await valid.installer.prepare(valid.guard),plan=valid.store.read('plan');assert.deepEqual(plan.migration.graph.access_proof,valid.proof);assert.equal(plan.hash,p.plan_hash);assert.ok(plan.migration.sql.includes(A.ROLE_IDENTITY_SQL));assert.doesNotMatch(plan.migration.sql,/ALTER\s+ROLE|CREATE\s+ROLE|\bPASSWORD\b/);
});
test('TX preparation rejects altered external access pins and omission of database audits without any write',async t=>{
 for(const change of [p=>{p.accessReview.receipt_hash=F.h('f');},p=>{p.accessPlan.migration.sql+=' changed';},p=>{p.accessReceipt.connection_scope.database_audits.shift();},p=>{p.accessReceipt.after.role_identity.oid='17002';}]){
  const f=setup(t);change(f.guard.worker_access);await assert.rejects(f.installer.prepare(f.guard),/GRAPH_WORKER_ACCESS_/);assert.equal(f.writes(),0);assert.equal(f.store.has('plan'),false);assert.equal(f.store.has('install-intent'),false);
 }
});
test('same-name role replacement after prepare fails before TX intent and SQL',async t=>{
 const f=setup(t),p=await f.installer.prepare(f.guard);f.change(m=>({...m,graph_worker_identity:{...m.graph_worker_identity,oid:'17002'}}));
 await assert.rejects(f.installer.phase('install',p.plan_hash),/CURRENT_CHAIN/);assert.equal(f.writes(),0);assert.equal(f.store.has('install-intent'),false);
});
test('TX keeps the reviewed access proof through uncertain response and read-only reconciliation',async t=>{
 const f=setup(t),p=await f.installer.prepare(f.guard);f.lose();await assert.rejects(f.installer.phase('install',p.plan_hash),/RESPONSE_LOST/);assert.equal(f.writes(),1);
 await assert.rejects(f.installer.phase('install',p.plan_hash),/UNCERTAIN_RECONCILE/);const result=await f.installer.reconcile('install');assert.equal(result.installed,true);assert.equal(result.reconciled_read_only,true);assert.equal(f.writes(),1);
 const current=f.metadata(),seal=JSON.parse(current.graph_seal);assert.deepEqual(seal.worker_access_extension,f.proof.accessReceipt.after.graph_seal.worker_access_extension);
 for(const mutate of [m=>{m.graph_worker_identity.oid='17002';},m=>{const g=JSON.parse(m.graph_seal);g.worker_access_extension.auth_proof_hash=F.h('f');m.graph_seal=JSON.stringify(g);}]){
  f.change(()=>F.clone(current));f.change(m=>{mutate(m);return m;});await assert.rejects(f.installer.phase('create',p.plan_hash),/GRAPH_WORKER_ACCESS_|GRAPH_EXTENSION_DRIFT/);assert.equal(f.writes(),1);
 }
});
