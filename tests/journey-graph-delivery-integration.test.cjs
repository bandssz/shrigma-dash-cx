'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {install,id}=require('./journey-graph-cart-fixture.cjs');
const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs');
const {createCartBridge}=require('../n8n/growth/journey-graph-cart.cjs');
const {createMessageClaim}=require('../n8n/growth/journey-graph-message.cjs');
const {createDelivery}=require('../n8n/growth/journey-graph-delivery.cjs');
async function setup(t,brand='fish'){
 const x=await install(t),f=await x.prepare(brand);
 await x.db.exec(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-dispatch-receipt.sql'),'utf8'));
 const runtime=createGraphRuntime({...f.settings,catalogFor:async()=>f.catalog,readDispatch:({query,brand,intent_id})=>createCartBridge({query,cacheTarget:f.settings.cacheTarget}).dispatch(brand,intent_id)});
 let seq=70000,posts=0;const journal=new Map(),settings={claim:p=>f.claim.claim(p),inspect:({brand,intent_id})=>f.bridge.dispatch(brand,intent_id),
  finish:({dispatch_id,claim_token,outcome,context})=>f.finish({dispatch_id,claim_token,context},outcome),
  applyReceipt:async(p,identity)=>{
   const key=JSON.stringify([p.intent_id,identity.dispatch_id,identity.transport_state]);
   if(!journal.has(key))journal.set(key,{request_id:id(seq++),actor:'worker:synthetic',...p});
   return runtime.applyDispatch(journal.get(key));
  },
  sendTx:async(payload,options)=>{posts++;assert.equal(payload.template_id,f.preparedClone.clone_template_id);assert.equal(options.retry,false);return {statusCode:200,body:{data:true}};}};
 return {x,f,runtime,settings,journal,posts:()=>posts,delivery:createDelivery(settings)};
}
test('source, pinned clone, original reservation, transport result and graph receipt integrate in both brands',async t=>{
 for(const brand of ['fish','aristo']){
  const a=await setup(t,brand),before=a.f.intent.version,result=await a.delivery.deliver(a.f.request);
  assert.equal(result.state,'accepted');assert.equal(result.receipt_applied,true);assert.equal(a.posts(),1);
  const e=(await a.x.query('SELECT * FROM crm_graph_candidate.entry WHERE id=$1',[a.f.entry.id])).rows[0];assert.equal(e.version,before+1);assert.equal(e.state.node_id,'end');assert.equal(e.state.status,'ready');
  assert.equal((await a.x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,1);assert.equal((await a.x.query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,1);
  assert.equal((await a.x.query('SELECT count(*)::int n FROM crm_graph_candidate.dispatch_receipt_v1')).rows[0].n,1);
  assert.equal((await a.delivery.reconcile(a.f.request)).receipt_applied,true);assert.equal(a.posts(),1);assert.equal((await a.x.query('SELECT version FROM crm_graph_candidate.entry WHERE id=$1',[a.f.entry.id])).rows[0].version,e.version);
  assert.equal((await a.x.query("SELECT md5(pg_get_functiondef('shrigma_email_finish_cart(uuid,uuid,text,jsonb)'::regprocedure)) hash")).rows[0].hash,a.x.originalFinish);
 }
});
test('lost COMMIT acknowledgement leaves one closed native reservation and cannot reach transport',async t=>{
 const a=await setup(t);let lose=true;
 const claim=createMessageClaim({...a.f.settings,pool:{async connect(){const c=await a.f.settings.pool.connect();return {query:async(q,p)=>{const r=await c.query(q,p);if(q==='COMMIT'&&lose){lose=false;throw Error('Synthetic commit response lost');}return r;},release:e=>c.release(e)};}}});
 const delivery=createDelivery({...a.settings,claim:p=>claim.claim(p)});await assert.rejects(delivery.deliver(a.f.request),{code:'GRAPH_MESSAGE_OUTCOME_UNKNOWN'});assert.equal(a.posts(),0);
 const d=await a.f.bridge.dispatch('fish',a.f.request.intent_id);assert.equal(d.transport_state,'in_flight');assert.equal((await delivery.reconcile(a.f.request)).state,'in_flight');assert.equal(a.posts(),0);
 assert.equal((await a.x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,1);assert.equal((await a.x.query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,0);
});
test('lost native response is retained as unknown in original dispatch and graph, with no second POST',async t=>{
 const a=await setup(t);let posts=0;const delivery=createDelivery({...a.settings,sendTx:async()=>{posts++;throw Error('Synthetic native response lost');}});
 const r=await delivery.deliver(a.f.request);assert.equal(r.state,'outcome_unknown');assert.equal(r.receipt_applied,true);assert.equal((await a.x.query('SELECT state FROM crm_graph_candidate.entry')).rows[0].state.status,'unknown');assert.deepEqual(await a.runtime.due({brand:'fish'}),[]);
 await delivery.reconcile(a.f.request);assert.equal(posts,1);assert.equal((await a.x.query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,0);
});
test('finish commit with lost response still advances from its durable receipt; preflight CAS rejects stale requests',async t=>{
 const a=await setup(t);await assert.rejects(a.f.claim.claim({...a.f.request,expected_entry_version:a.f.request.expected_entry_version+1}),{code:'GRAPH_MESSAGE_VERSION_CONFLICT'});assert.equal(a.posts(),0);
 let finishes=0;const delivery=createDelivery({...a.settings,finish:async p=>{finishes++;await a.settings.finish(p);throw Error('Synthetic finish reply lost');}});
 const r=await delivery.deliver(a.f.request);assert.equal(r.state,'accepted');assert.equal(r.receipt_applied,true);await delivery.reconcile(a.f.request);assert.equal(a.posts(),1);assert.equal(finishes,1);
});
