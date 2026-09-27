'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs'),{store,migration,bridge,readDispatch,receiptFixture,id,faultPool}=require('./fixtures/journey-graph-dispatch-receipt.cjs');
async function setup(t,brand='fish'){
 const db=new PGlite();t.after(()=>db.close());await db.exec(store);await db.exec(bridge);await db.exec(migration);
 const pool={async connect(){return {query:db.query.bind(db),release(){}};}};return {...receiptFixture(pool,brand),db,pool};
}
test('accepted applies one edge and due time on both brands, including global OFF and paused journey',async t=>{
 for(const brand of ['fish','aristo']){
  const f=await setup(t,brand),j=await f.ready(),e=await f.pending(j),did=await f.bind(e);
  await f.api.pause(f.request({journey_id:j.journey_id,expected_version:j.version,paused:true,confirm:'pausar'}));await f.query('UPDATE crm_graph_candidate.control SET enabled=false');
  let sourceReads=0;const api=createGraphRuntime({...f.settings,readSource:async()=>{sourceReads++;throw Error('Receipt must not re-read consent as permission to record history');}});
  const req=f.req(e),out=await api.applyDispatch(req);assert.equal(out.kind,'advance');assert.equal(out.node_id,'end');assert.equal(out.next_due_at,f.now());assert.equal(out.transport_state,'accepted');assert.equal(out.dispatch_id,did);assert.equal(out.authorizes_send,false);assert.equal(sourceReads,0);
  assert.equal(await f.count('dispatch_receipt_v1'),1);assert.equal(await f.count('intent'),1);assert.deepEqual(await api.applyDispatch(req),out);assert.deepEqual(await api.due({brand}),[]);assert.equal((await f.step(out)).kind,'paused');
  const same=await api.applyDispatch(f.req({...out,intent_id:e.intent_id}));assert.equal(same.kind,'receipt_already_applied');assert.equal(same.version,out.version);assert.equal(await f.count('dispatch_receipt_v1'),1);
 }
});
test('in-flight and unknown cannot advance or create another intent; trusted final accepted/rejected may resolve unknown',async t=>{
 for(const final of ['accepted','rejected']){
  const f=await setup(t),j=await f.ready(),e=await f.pending(j),did=await f.bind(e,'in_flight');let out=await f.api.applyDispatch(f.req(e));assert.equal(out.kind,'await_receipt');assert.equal(out.state,'waiting_message');assert.equal(out.next_due_at,null);
  await f.query('UPDATE public.shrigma_email_dispatch SET transport_state=$2 WHERE dispatch_id=$1',[did,'outcome_unknown']);out=await f.api.applyDispatch(f.req(out));assert.equal(out.kind,'unknown');assert.equal(out.state,'unknown');assert.equal((await f.step(out)).kind,'await_transport');assert.deepEqual(await f.api.due({brand:'fish'}),[]);
  const duplicate=await f.api.applyDispatch(f.req(out));assert.equal(duplicate.version,out.version);assert.equal(duplicate.kind,'receipt_already_applied');assert.equal(await f.count('intent'),1);
  await f.query('UPDATE public.shrigma_email_dispatch SET transport_state=$2 WHERE dispatch_id=$1',[did,final]);out=await f.api.applyDispatch(f.req(out));assert.equal(out.kind,final==='accepted'?'advance':'failed');assert.equal(out.state,final==='accepted'?'ready':'failed');assert.equal(await f.count('dispatch_receipt_v1'),3);
  await f.query('UPDATE public.shrigma_email_dispatch SET transport_state=$2 WHERE dispatch_id=$1',[did,final==='accepted'?'rejected':'accepted']);await assert.rejects(f.api.applyDispatch(f.req(out)),{code:'GRAPH_DISPATCH_REGRESSION'});
 }
});
test('input cannot choose dispatch/outcome; identities and trusted join are checked before applying',async t=>{
 const f=await setup(t),j=await f.ready(),e=await f.pending(j),req=f.req(e);await assert.rejects(f.api.applyDispatch(req),{code:'GRAPH_DISPATCH_UNCONFIRMED'});await f.bind(e);
 for(const extra of [{transport_state:'accepted'},{dispatch_id:id(40)},{messageReceipt:{status:'accepted'}}])await assert.rejects(f.api.applyDispatch({...req,...extra}),{code:'GRAPH_INPUT_SHAPE'});
 await assert.rejects(f.api.applyDispatch({...req,brand:'aristo'}),{code:'GRAPH_NOT_FOUND'});await assert.rejects(f.api.applyDispatch({...req,intent_id:id(49)}),{code:'GRAPH_DISPATCH_IDENTITY'});
 for(const delta of [{brand:'aristo'},{entry_id:id(48)},{revision:2},{node_id:'other'},{attempt_key:'other'},{intent_id:id(47)},{contract:'other'},{transport_state:'delivered'}]){
  const api=createGraphRuntime({...f.settings,readDispatch:async x=>({...await readDispatch(x),...delta})});await assert.rejects(api.applyDispatch(req),{code:'GRAPH_DISPATCH_IDENTITY'});
 }
 assert.equal(await f.count('dispatch_receipt_v1'),0);assert.equal((await f.row(e)).version,e.version);
});
test('version, pinned revision, prior intent and terminal result cannot be reinterpreted',async t=>{
 const f=await setup(t),j=await f.ready(),e=await f.pending(j);await f.bind(e,'accepted');
 const changed=f.copy(f.graph);changed.edges.find(x=>x.from==='message').to='paid';changed.edges.find(x=>x.from==='condition'&&x.port==='yes').to='end';let next=await f.api.save(f.request({journey_id:j.journey_id,expected_version:j.version,definition:changed}));next=await f.api.publish(f.request({journey_id:j.journey_id,expected_version:next.version,confirm:'publicar'}));
 const out=await f.api.applyDispatch(f.req(e));assert.equal(out.revision,1);assert.equal(out.kind,'advance');assert.equal(out.node_id,'end');
 await assert.rejects(f.api.applyDispatch(f.req(e)),{code:'GRAPH_VERSION_CONFLICT'});assert.equal((await f.row(e)).state.status,'ready');assert.equal(await f.count('dispatch_receipt_v1'),1);
});
test('lost COMMIT reply replays exactly, with authorization checked again before the durable receipt',async t=>{
 const f=await setup(t),j=await f.ready(),e=await f.pending(j);await f.bind(e);const req=f.req(e);let lose=true,allowed=true,checks=0;
 const beforeCommand=async({action,brand,actor})=>{assert.equal(action,'apply_dispatch');assert.equal(brand,'fish');assert.equal(actor,req.actor);checks++;if(!allowed)throw Object.assign(Error('GRAPH_ACCESS'),{code:'GRAPH_ACCESS'});};
 const api=createGraphRuntime({...f.settings,beforeCommand,pool:faultPool(f.pool,{after:q=>q==='COMMIT'&&lose?(lose=false,true):false})});await assert.rejects(api.applyDispatch(req),{code:'GRAPH_OUTCOME_UNKNOWN'});
 allowed=false;await assert.rejects(api.applyDispatch(req),{code:'GRAPH_ACCESS'});allowed=true;const out=await api.applyDispatch(req);assert.equal(out.kind,'advance');assert.equal(checks,3);assert.equal(await f.count('dispatch_receipt_v1'),1);
 await assert.rejects(api.applyDispatch({...req,expected_version:req.expected_version+1}),{code:'GRAPH_REPLAY_MISMATCH'});
});
test('receipt insertion failure rolls back state/transition/operation and preserves a same-operation retry',async t=>{
 const f=await setup(t),j=await f.ready(),e=await f.pending(j);await f.bind(e);const req=f.req(e),before=await f.count('transition');
 const control={before:q=>q.startsWith('INSERT INTO crm_graph_candidate.dispatch_receipt_v1')},api=createGraphRuntime({...f.settings,pool:faultPool(f.pool,control)});await assert.rejects(api.applyDispatch(req),/synthetic pre-commit failure/);
 assert.equal((await f.row(e)).version,e.version);assert.equal(await f.count('transition'),before);assert.equal(await f.count('dispatch_receipt_v1'),0);control.before=null;assert.equal((await api.applyDispatch(req)).kind,'advance');assert.equal(await f.count('intent'),1);
 await assert.rejects(f.query('DELETE FROM crm_graph_candidate.dispatch_receipt_v1'),/GRAPH_IMMUTABLE/);
});
test('migration is additive, rejects drift/collision, has no grants, activation or native dispatch writes',async t=>{
 const f=await setup(t);await assert.rejects(f.db.exec(migration),/GRAPH_RECEIPT_COLLISION/);await f.db.exec('ROLLBACK');assert.equal((await f.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
 const db=new PGlite();t.after(()=>db.close());await db.exec(store);await db.exec(bridge);await db.exec("ALTER TABLE crm_graph_candidate.operation DROP CONSTRAINT operation_action_check;ALTER TABLE crm_graph_candidate.operation ADD CONSTRAINT operation_action_check CHECK(action IN ('create','save'));" );await assert.rejects(db.exec(migration),/GRAPH_RECEIPT_SCHEMA_CHANGED/);await db.exec('ROLLBACK');assert.equal((await db.query("SELECT to_regclass('crm_graph_candidate.dispatch_receipt_v1') t")).rows[0].t,null);
 assert.ok(!/GRANT |UPDATE public\.|INSERT INTO public\.|UPDATE crm_graph_candidate.control/.test(migration));
 const grants=(await f.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='crm_graph_candidate' AND table_name='dispatch_receipt_v1' AND grantee='PUBLIC'")).rows;assert.deepEqual(grants,[]);
});
