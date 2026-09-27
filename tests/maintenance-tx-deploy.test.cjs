'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const D=require('../tools/maintenance-tx-deploy/deploy.cjs'),P=require('../n8n/growth/maintenance-tx-popup-patch.cjs');
const {fixture,copy,until,PHASES}=require('./maintenance-tx-deploy-fixture.cjs');
function setup(t){const f=fixture();t.after(()=>fs.rmSync(f.directory,{recursive:true,force:true}));return f;}
test('additive phase rehearsal keeps v2 gate, CART workflows and existing rows; consumer OFF until separate approval',async t=>{
 const f=setup(t),before=copy(f.state),cart=copy([f.workflows[f.guard.cart.producer.id],f.workflows[f.guard.cart.consumer.id]]),p=await until(f,'publish');
 assert.deepEqual(f.effects,['install','create','patch','publish']);assert.deepEqual(f.state,before);assert.equal(f.workflows.consumer.active,false);
 await assert.rejects(f.installer.phase('activate',p.plan_hash),/ACTIVATION_REVIEW/);
 await f.installer.phase('activate',p.plan_hash,{activationApproval:p.plan_hash+':activate'});const v=await f.installer.verify();assert.equal(v.consumer_active,true);assert.equal(v.cart_preserved,true);assert.equal(v.runtime_acceptance_pending,true);
 await f.installer.phase('halt',p.plan_hash);assert.deepEqual(f.state,before);assert.deepEqual([f.workflows[f.guard.cart.producer.id],f.workflows[f.guard.cart.consumer.id]],cart);
 assert.ok(fs.readdirSync(f.directory).every(n=>(fs.statSync(path.join(f.directory,n)).mode&0o777)===0o600));
});
for(const phase of PHASES)test('lost '+phase+' response retains intent and reconciles only by exact reads',async t=>{
 const f=setup(t),p=await f.installer.prepare(f.guard);for(const s of PHASES){if(s===phase)break;await f.installer.phase(s,p.plan_hash,{activationApproval:p.plan_hash+':activate'});}
 f.lose(phase);await assert.rejects(f.installer.phase(phase,p.plan_hash,{activationApproval:p.plan_hash+':activate'}),/RESPONSE_LOST/);const count=f.effects.length;
 await assert.rejects(f.installer.phase(phase,p.plan_hash,{activationApproval:p.plan_hash+':activate'}),/UNCERTAIN_RECONCILE/);assert.equal(f.effects.length,count);
 if(phase==='create')await assert.rejects(f.installer.reconcile('create'),/CONSUMER_ID/);
 const r=await f.installer.reconcile(phase,{consumerId:'consumer'});assert.equal(r.reconciled_read_only,true);assert.equal(f.effects.length,count);
});
test('unreviewed old seal, missing schema and preexisting extension are never silently adopted',async t=>{
 for(const mutate of [f=>f.guard.retention.seal_sha256='a'.repeat(64),f=>f.setMeta(m=>({...m,schema:null})),f=>f.setMeta(m=>({...m,shape:'c'.repeat(32)})),f=>f.setMeta(m=>({...m,seal:JSON.stringify({...JSON.parse(m.seal),contract:D.CONTRACT})}))]){
  const f=setup(t);mutate(f);await assert.rejects(f.installer.prepare(f.guard),/SEAL|RETENTION/);assert.deepEqual(f.effects,[]);
 }
});
test('fresh producer, protected CART, SQL dependency, gate and credentials drift each stop before any write',async t=>{
 for(const mutate of [f=>f.workflows[P.TARGET].versionId='changed',f=>f.workflows[f.guard.cart.consumer.id].versionId='changed',f=>f.workflows[f.guard.cart.producer.id].nodes[0].parameters={changed:true},f=>f.state.control.version=3,f=>f.state.control.mode='closed',f=>f.setMeta(m=>({...m,dependencies:m.dependencies.map((d,i)=>i?d:{...d,hash:'b'.repeat(32)})})),f=>{f.io.utilityPG=async()=>({ids:['wrong']});}]){
  const f=setup(t),p=await f.installer.prepare(f.guard);mutate(f);await assert.rejects(f.installer.phase('install',p.plan_hash),/DRIFT|NOT_PUBLISHED|GATE/);assert.deepEqual(f.effects,[]);
 }
});
test('SQL drift after install, foreign consumer project and published body mismatch block progress',async t=>{
 const a=setup(t),pa=await until(a,'install');a.setMeta(m=>({...m,shape:'c'.repeat(32)}));await assert.rejects(a.installer.phase('create',pa.plan_hash),/SCHEMA_DRIFT/);
 const b=setup(t),pb=await until(b,'create');b.workflows.consumer.shared=[{projectId:'foreign'}];await assert.rejects(b.installer.phase('patch',pb.plan_hash),/CONSUMER_DRIFT/);
 const c=setup(t),pc=await until(c,'publish');c.workflows[P.TARGET].activeVersion.nodes=[];await assert.rejects(c.installer.phase('activate',pc.plan_hash,{activationApproval:pc.plan_hash+':activate'}),/PUBLISHED_BODY_DRIFT/);
});
test('failed installation without remote effect cannot be retried and absent consumer cannot be recreated',async t=>{
 const f=setup(t),p=await f.installer.prepare(f.guard);f.io.sql=async()=>{throw Error('NETWORK_RESPONSE_LOST');};await assert.rejects(f.installer.phase('install',p.plan_hash),/RESPONSE_LOST/);await assert.rejects(f.installer.reconcile('install'),/SCHEMA_DRIFT/);await assert.rejects(f.installer.phase('install',p.plan_hash),/UNCERTAIN/);assert.deepEqual(f.effects,[]);
 const a=setup(t),pa=await until(a,'install');a.io.createWorkflow=async()=>{throw Error('NETWORK_RESPONSE_LOST');};await assert.rejects(a.installer.phase('create',pa.plan_hash));await assert.rejects(a.installer.reconcile('create'),/CONSUMER_ID/);await assert.rejects(a.installer.phase('create',pa.plan_hash),/UNCERTAIN/);assert.deepEqual(a.effects,['install']);
});
test('PUT can publish immediately; exact readback does not send an unnecessary activate',async t=>{
 const f=setup(t),p=await until(f,'create'),put=f.io.putWorkflow;f.io.putWorkflow=async(...args)=>{const r=await put(...args),w=f.workflows[P.TARGET];w.activeVersionId=w.versionId;w.activeVersion={versionId:w.versionId,nodes:copy(w.nodes),connections:copy(w.connections)};return r;};
 await f.installer.phase('patch',p.plan_hash);await f.installer.phase('publish',p.plan_hash);assert.deepEqual(f.effects,['install','create','patch']);await assert.rejects(f.installer.phase('publish',p.plan_hash),/UNCERTAIN/);
});
test('approval, phase order, plan corruption and modified consumer deny effects',async t=>{
 const f=setup(t),p=await f.installer.prepare(f.guard);for(const phase of [...PHASES,'halt'])await assert.rejects(f.installer.phase(phase),/APPROVAL_REQUIRED/);await assert.rejects(f.installer.phase('activate',p.plan_hash,{activationApproval:p.plan_hash+':activate'}),/PHASE_REQUIRED/);assert.deepEqual(f.effects,[]);
 const location=path.join(f.directory,'plan.json'),plan=JSON.parse(fs.readFileSync(location));plan.consumer.nodes=[];fs.writeFileSync(location,JSON.stringify(plan));await assert.rejects(f.installer.phase('install',p.plan_hash),/PLAN_HASH/);
 const b=setup(t),pb=await until(b,'install');b.lose('create');await assert.rejects(b.installer.phase('create',pb.plan_hash));b.workflows.consumer.nodes=[];await assert.rejects(b.installer.reconcile('create',{consumerId:'consumer'}),/CONSUMER_DRIFT/);assert.deepEqual(b.effects,['install','create']);
});
test('wrong create response, missing version or an active consumer remain uncertain and never unlock producer patch',async t=>{
 for(const mutation of [f=>({id:f.guard.cart.consumer.id}),f=>{delete f.workflows.consumer.versionId;return {id:'consumer'};},f=>{f.workflows.consumer.active=true;return {id:'consumer'};}]){
  const f=setup(t),p=await until(f,'install'),create=f.io.createWorkflow;f.io.createWorkflow=async body=>{await create(body);return mutation(f);};
  await assert.rejects(f.installer.phase('create',p.plan_hash),/CONSUMER_ID|CONSUMER_DRIFT/);await assert.rejects(f.installer.phase('patch',p.plan_hash),/PHASE_REQUIRED/);
  await assert.rejects(f.installer.phase('create',p.plan_hash),/UNCERTAIN/);assert.deepEqual(f.effects,['install','create']);
 }
});
test('producer patch cannot precede OFF creation, and activation rejects CART drift or foreign same-body versions',async t=>{
 const a=setup(t),pa=await until(a,'install');await assert.rejects(a.installer.phase('patch',pa.plan_hash),/PHASE_REQUIRED/);assert.deepEqual(a.effects,['install']);
 const b=setup(t),pb=await until(b,'publish');b.workflows[b.guard.cart.consumer.id].name='changed';await assert.rejects(b.installer.phase('activate',pb.plan_hash,{activationApproval:pb.plan_hash+':activate'}),/CART_DRIFT/);assert.deepEqual(b.effects,['install','create','patch','publish']);
 const c=setup(t),pc=await until(c,'publish');c.workflows.consumer.versionId='foreign-same-body';await assert.rejects(c.installer.phase('activate',pc.plan_hash,{activationApproval:pc.plan_hash+':activate'}),/CONSUMER_VERSION_DRIFT/);assert.deepEqual(c.effects,['install','create','patch','publish']);
});
