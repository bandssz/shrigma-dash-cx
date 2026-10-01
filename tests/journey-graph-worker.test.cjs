'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {install}=require('./journey-graph-cart-fixture.cjs'),{createWorker,ACTOR,operationId}=require('../n8n/growth/journey-graph-worker.cjs');
async function setup(t,brand='fish'){
 const x=await install(t),f=await x.prepare(brand);await x.db.exec(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-dispatch-receipt.sql'),'utf8'));
 const pool={...x.pool,query:x.query},calls=[];let sends=0;
 const options={pool,actor:ACTOR,enabled:true,authorizeWorker:async p=>{calls.push(p.action);return true;},cacheTarget:x.cacheTarget,collectorWorkflowIds:{fish:'syntheticFish',aristo:'syntheticAristo'},readSource:f.settings.readSource,sendTx:async(payload,o)=>{sends++;assert.equal(payload.template_id,f.preparedClone.clone_template_id);assert.equal(o.retry,false);return {statusCode:200,body:{data:true}};}};
 return {x,f,options,calls,sends:()=>sends,worker:createWorker(options)};
}
test('Node worker closes existing Fish and Aristo intents through original claim, synthetic transport and durable receipt',async t=>{
 for(const brand of ['fish','aristo']){
  const a=await setup(t,brand),r=await a.worker.tick({brand,limit:1});assert.equal(r.transport_started,1);assert.equal(r.reconciled,1);assert.equal(r.errors.length,0);assert.equal(a.sends(),1);
  assert.equal((await a.worker.reconcile({brand,intent_id:a.f.intent.intent_id})).receipt_applied,true);assert.equal(a.sends(),1);
  const again=await a.worker.tick({brand,limit:1});assert.equal(again.transport_started,0);assert.equal(a.sends(),1);
  const status=await a.worker.inspect();assert.equal(status.admissions,true);assert.equal(status.panel_activation,false);assert.equal(status.brands[brand].owned_entries,1);assert.ok(!JSON.stringify([r,status]).includes('synthetic@example.invalid'));
  assert.ok(a.calls.includes('claim'));assert.ok(a.calls.includes('apply_dispatch'));assert.equal((await a.x.query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,1);
 }
});
test('worker defaults OFF, role authorization fails closed and maintenance blocks HTTP',async t=>{
 const a=await setup(t),off=createWorker({...a.options,enabled:undefined});assert.equal((await off.tick({brand:'fish'})).state,'disabled');assert.equal(a.sends(),0);
 const denied=createWorker({...a.options,authorizeWorker:async()=>false});await assert.rejects(denied.tick({brand:'fish'}),/UNAUTHORIZED/);
 await a.x.query("UPDATE crm_maintenance_candidate.control SET mode='closed'");assert.equal((await a.worker.tick({brand:'fish'})).state,'blocked');assert.equal(a.sends(),0);
 await assert.rejects(a.worker.tick({brand:'fish',limit:6}),/INPUT/);await assert.rejects(a.worker.tick({brand:'fish',recipient:'x@example.invalid'}),/INPUT/);
});
test('existing reserved/unknown dispatch is reconciled after restart, never re-claimed or transported',async t=>{
 const a=await setup(t),grant=await a.f.claim.claim(a.f.request);assert.equal(grant.should_send,true);
 const r=await a.worker.tick({brand:'fish',limit:1});assert.equal(r.reconciled,1);assert.equal(r.transport_started,0);assert.equal(a.sends(),0);assert.ok(!a.calls.includes('claim'));
 await a.f.finish(grant,'outcome_unknown');const restarted=createWorker(a.options),r2=await restarted.tick({brand:'fish',limit:1});assert.equal(r2.reconciled,1);assert.equal(a.sends(),0);assert.equal((await a.x.query('SELECT state FROM crm_graph_candidate.entry')).rows[0].state.status,'unknown');
 const off=createWorker({...a.options,enabled:false});assert.equal((await off.reconcile({brand:'fish',intent_id:a.f.intent.intent_id})).state,'outcome_unknown');assert.equal(a.sends(),0);
});
test('lost HTTP acknowledgement is sticky and a later worker does no second POST',async t=>{
 const a=await setup(t);let sent=0;const options={...a.options,sendTx:async()=>{sent++;throw Error('synthetic private response lost');}};
 const first=await createWorker(options).tick({brand:'fish',limit:1});assert.equal(first.transport_started,1);assert.equal(first.reconciled,1);await createWorker(options).tick({brand:'fish',limit:1});assert.equal(sent,1);assert.equal((await a.x.query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,0);
});
test('same-brand tick is single-flight, with no queued implicit retry',async t=>{
 const a=await setup(t);let enter,release,posts=0;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);
 const w=createWorker({...a.options,sendTx:async()=>{posts++;enter();await wait;return {statusCode:200,body:{data:true}};}}),pending=w.tick({brand:'fish',limit:1});await entered;assert.equal((await w.tick({brand:'fish',limit:1})).state,'busy');release();await pending;assert.equal(posts,1);
});
test('collector handoff captures source only, enforces allowlisted identity and never enrolls',async t=>{
 const a=await setup(t),receipt=await a.x.receipt('fish');const handoff={version:receipt.version,brand:'fish',reconciled:true,observed_at:receipt.observed_at,items:receipt.items,workflow_id:'syntheticFish',execution_id:'987',batch_index:0,authorizes_enrollment:false,authorizes_send:false};
 const off=createWorker({...a.options,enabled:false}),before=(await a.x.query('SELECT count(*)::int n FROM crm_graph_candidate.entry')).rows[0].n,r=await off.captureHandoff(handoff);assert.equal(r.authorizes_enrollment,false);assert.equal(r.authorizes_send,false);assert.deepEqual(await off.captureHandoff(handoff),r);assert.equal((await a.x.query('SELECT count(*)::int n FROM crm_graph_candidate.entry')).rows[0].n,before);assert.equal(a.sends(),0);
 await assert.rejects(off.captureHandoff({...handoff,workflow_id:'unknownWorkflow'}),/HANDOFF/);
});
test('receipt identity is deterministic across restart and lost COMMIT; no second send or ledger entry',async t=>{
 const a=await setup(t);let commits=0;
 const pool={query:a.x.query,connect:async()=>{const c=await a.options.pool.connect();return {query:async(q,p)=>{const r=await c.query(q,p);if(q==='COMMIT'&&++commits===2)throw Error('synthetic apply commit acknowledgement lost');return r;},release:e=>c.release(e)};}};
 const w=createWorker({...a.options,pool}),r=await w.tick({brand:'fish',limit:1});assert.equal(r.reconciled,1);assert.equal(a.sends(),1);await createWorker(a.options).reconcile({brand:'fish',intent_id:a.f.intent.intent_id});assert.equal(a.sends(),1);assert.equal((await a.x.query('SELECT count(*)::int n FROM crm_graph_candidate.dispatch_receipt_v1')).rows[0].n,1);
 const d=(await a.x.bridge.dispatch('fish',a.f.intent.intent_id)),op=operationId([ACTOR,'fish','apply_dispatch',a.f.intent.intent_id,d.dispatch_id,'accepted']);assert.equal((await a.x.query('SELECT count(*)::int n FROM crm_graph_candidate.operation WHERE request_id=$1',[op])).rows[0].n,1);
});
test('receipt authorization revoked after acceptance preserves dispatch and later reconciliation never resends',async t=>{
 const a=await setup(t);let allow=false;const options={...a.options,authorizeWorker:async({action})=>action!=='apply_dispatch'||allow},w=createWorker(options);
 const first=await w.tick({brand:'fish',limit:1});assert.equal(first.transport_started,1);assert.equal(first.reconciled,0);assert.equal(a.sends(),1);assert.equal((await a.x.bridge.dispatch('fish',a.f.intent.intent_id)).transport_state,'accepted');assert.equal((await a.x.query('SELECT count(*)::int n FROM crm_graph_candidate.dispatch_receipt_v1')).rows[0].n,0);
 allow=true;assert.equal((await w.reconcile({brand:'fish',intent_id:a.f.intent.intent_id})).receipt_applied,true);assert.equal(a.sends(),1);
});
