'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const D=require('../tools/graph-acl-migration/deploy.cjs'),F=require('./graph-acl-fixture.cjs');
const ROOT=path.join(__dirname,'..'),clone=x=>JSON.parse(JSON.stringify(x));
async function fake(t){
 const base=await F.setup(t),metadata=clone(base.before);metadata.database='listmonk';metadata.graph_state.database='listmonk';
 const identity={database_service:'synthetic-only',runtime_reference_sha256:D.sha('synthetic configuration'),isolated_session:'synthetic-session'};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-acl-protocol-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new D.FileStore(dir),state={metadata,identity,writes:0,mode:'success',receipt:null};
 const io={metadata:async()=>clone(state.metadata),identity:async()=>clone(state.identity),receipt:async()=>clone(state.receipt),sql:async sql=>{
  state.writes++;assert.equal(store.has('install-intent'),true);const p=store.read('plan');assert.equal(sql,p.migration.sql);
  assert.equal(fs.statSync(path.join(dir,'install-intent.json')).mode&0o777,0o600);
  if(state.mode==='lost-no-effect')throw Error('synthetic response lost');
  state.metadata=D.expectedAfter(p.migration.before,D.sha('synthetic after graph shape').slice(0,32),String(BigInt(p.migration.before.graph_state.control_xmin)+1n));
  state.receipt={contract:D.CONTRACT,nonce:p.migration.nonce,retired:p.migration.retired,before_state:clone(p.migration.before),after_state:clone(state.metadata),completed_at:'synthetic'};
  if(state.mode==='lost-applied')throw Error('synthetic response lost');return null;
 }};
 const installer=new D.Installer({root:ROOT,io,store});
 const prepare=async()=>installer.prepare({snapshot_sha256:D.sha(await installer.snapshot()),retired:base.retired});
 return {installer,state,store,prepare};
}
test('fresh guards run before durable intent; approval and role, transport or ACL drift never write',async t=>{
 for(const change of [x=>x.state.metadata.roles[0].name+='-changed',x=>x.state.identity.isolated_session+='-changed',x=>x.state.metadata.public_schema.acl[0].grantable=true]){
  const x=await fake(t),p=await x.prepare();await assert.rejects(x.installer.install('0'.repeat(64)),/PLAN_APPROVAL/);
  change(x);await assert.rejects(x.installer.install(p.plan_hash),/PREFLIGHT_DRIFT/);assert.equal(x.state.writes,0);assert.equal(x.store.has('install-intent'),false);
 }
});
test('null HTTP payload is accepted only after exact authoritative state and durable receipt readback',async t=>{
 const x=await fake(t),p=await x.prepare(),r=await x.installer.install(p.plan_hash);
 assert.equal(r.installed,true);assert.equal(r.public_create,false);assert.deepEqual(r.retired,x.store.read('plan').migration.retired);
 assert.equal(x.state.writes,1);assert.equal(x.store.has('install-verified'),true);
 await assert.rejects(x.installer.install(p.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(x.state.writes,1);
});
test('lost response after application reconciles through reads only and preserves one write',async t=>{
 const x=await fake(t),p=await x.prepare();x.state.mode='lost-applied';
 await assert.rejects(x.installer.install(p.plan_hash),/response lost/);assert.equal(x.store.has('install-intent'),true);assert.equal(x.store.has('install-verified'),false);
 await assert.rejects(x.installer.install(p.plan_hash),/UNCERTAIN_RECONCILE/);
 assert.equal((await x.installer.reconcile()).readback_verified,true);assert.equal(x.state.writes,1);
});
test('lost response without effect remains unresolved and can never retry automatically',async t=>{
 const x=await fake(t),p=await x.prepare();x.state.mode='lost-no-effect';
 await assert.rejects(x.installer.install(p.plan_hash),/response lost/);
 await assert.rejects(x.installer.reconcile(),/RETIREMENT_ROW_VERSION/);
 await assert.rejects(x.installer.install(p.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(x.state.writes,1);assert.equal(x.store.has('install-verified'),false);
});
test('readback refuses receipt tampering and any extra privilege or graph structure change',async t=>{
 for(const change of [x=>x.state.receipt=null,x=>x.state.receipt.retired.sql_hash='f'.repeat(64),x=>x.state.metadata.capabilities[0].usage=false,x=>x.state.metadata.graph_state.shape_without_barrier='f'.repeat(32)]){
  const x=await fake(t),p=await x.prepare();x.state.mode='lost-applied';await assert.rejects(x.installer.install(p.plan_hash),/response lost/);change(x);
  await assert.rejects(x.installer.reconcile(),/UNCONFIRMED/);assert.equal(x.state.writes,1);assert.equal(x.store.has('install-verified'),false);
 }
});
test('preparation refuses zero timeout and does not create an intent or submit SQL',async t=>{
 const x=await fake(t);x.state.metadata.statement_timeout_ms=0;
 await assert.rejects(x.prepare(),/STATEMENT_TIMEOUT/);assert.equal(x.state.writes,0);assert.equal(x.store.has('install-intent'),false);assert.equal(x.store.has('plan'),false);
});
