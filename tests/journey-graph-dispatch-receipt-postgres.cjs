'use strict';
// Destructive only to a NEW disposable fixture schema on the exact local DB.
// Never connects to production, native HTTP, contacts or real dispatch sources.
const assert=require('node:assert/strict'),{store,migration,bridge,receiptFixture,faultPool}=require('./fixtures/journey-graph-dispatch-receipt.cjs');
const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/journey_graph_receipt_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Pool}=require('pg'),pool=new Pool({connectionString:u.toString(),max:8,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'synthetic-graph-receipt'});let blocker=null,worker=null,pending=null;
 async function waitOn(work){worker=await pool.connect();const pid=(await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid;const held={async connect(){return {query:worker.query.bind(worker),release(){}};}};pending=work(held).then(value=>({value}),error=>({error}));let locked=false;for(let n=0;n<80&&!locked;n++){locked=(await pool.query("SELECT wait_event_type='Lock' locked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.locked===true;if(!locked)await new Promise(r=>setTimeout(r,20));}assert.equal(locked,true,'worker must demonstrably wait on the actual server lock');}
 async function unblock(){await blocker.query('COMMIT');blocker.release();blocker=null;const r=await pending;pending=null;worker.release();worker=null;if(r.error)throw r.error;return r.value;}
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');assert.equal((await pool.query("SELECT to_regnamespace('crm_graph_candidate') s")).rows[0].s,null);await pool.query(store);await pool.query(bridge);await pool.query(migration);
  const f=receiptFixture(pool),j=await f.ready();let e=await f.pending(j);await f.bind(e);const req=f.req(e);let checks=0;const settings={...f.settings,beforeCommand:async()=>{checks++;}};
  const same=await Promise.all([createGraphRuntime(settings).applyDispatch(req),createGraphRuntime(settings).applyDispatch(req)]);assert.deepEqual(same[0],same[1]);assert.equal(checks,2);assert.equal(await f.count('dispatch_receipt_v1'),1);assert.equal(same[0].kind,'advance');
  e=await f.pending(j);await f.bind(e);const raced=await Promise.allSettled([f.api.applyDispatch(f.req(e)),f.api.applyDispatch(f.req(e))]);assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);assert.equal(raced.find(x=>x.status==='rejected').reason.code,'GRAPH_VERSION_CONFLICT');assert.equal(await f.count('dispatch_receipt_v1'),2);
  console.log('PASS real concurrent sessions: same operation replays after reauthorization; competing operations fence one receipt by entry CAS.');

  e=await f.pending(j);await f.bind(e);const pauseReq=f.req(e);blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM crm_graph_candidate.journey WHERE id=$1 FOR UPDATE',[j.journey_id]);
  await waitOn(p=>createGraphRuntime({...f.settings,pool:p}).applyDispatch(pauseReq));await blocker.query('UPDATE crm_graph_candidate.journey SET paused=true,version=version+1 WHERE id=$1',[j.journey_id]);let out=await unblock();assert.equal(out.kind,'advance');assert.deepEqual(await f.api.due({brand:'fish'}),[]);assert.equal((await f.step(out)).kind,'paused');
  await pool.query('UPDATE crm_graph_candidate.journey SET paused=false,version=version+1 WHERE id=$1',[j.journey_id]);
  // Enrollment reads the current journey CAS version; no legacy event is reused.
  j.version=(await pool.query('SELECT version FROM crm_graph_candidate.journey WHERE id=$1',[j.journey_id])).rows[0].version;
  e=await f.pending(j);await f.bind(e,'outcome_unknown');const offReq=f.req(e);blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT enabled FROM crm_graph_candidate.control FOR UPDATE');
  await waitOn(p=>createGraphRuntime({...f.settings,pool:p}).applyDispatch(offReq));await blocker.query('UPDATE crm_graph_candidate.control SET enabled=false');out=await unblock();assert.equal(out.kind,'unknown');assert.equal(out.next_due_at,null);assert.deepEqual(await f.api.due({brand:'fish'}),[]);
  console.log('PASS actual pause and OFF races: original receipt is stored, no execution is released.');

  await pool.query('UPDATE crm_graph_candidate.control SET enabled=true');e=await f.pending(j);const did=await f.bind(e,'in_flight');const finalReq=f.req(e);blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE dispatch_id=$1 FOR UPDATE',[did]);
  await waitOn(p=>createGraphRuntime({...f.settings,pool:p}).applyDispatch(finalReq));await blocker.query("UPDATE public.shrigma_email_dispatch SET transport_state='accepted' WHERE dispatch_id=$1",[did]);out=await unblock();assert.equal(out.transport_state,'accepted');assert.equal(out.kind,'advance');
  console.log('PASS original dispatch lock: receipt waits for the committed outcome, never applies a stale in-flight read.');

  e=await f.pending(j);await f.bind(e);const lostReq=f.req(e);let lose=true;const faulty=createGraphRuntime({...f.settings,pool:faultPool(pool,{after:q=>q==='COMMIT'&&lose?(lose=false,true):false})});await assert.rejects(faulty.applyDispatch(lostReq),{code:'GRAPH_OUTCOME_UNKNOWN'});const recovered=await f.api.applyDispatch(lostReq);assert.equal(recovered.kind,'advance');assert.deepEqual(recovered,(await pool.query('SELECT response FROM crm_graph_candidate.operation WHERE request_id=$1',[lostReq.request_id])).rows[0].response);
  await pool.query('UPDATE crm_graph_candidate.control SET enabled=false');assert.deepEqual(await f.api.due({brand:'fish'}),[]);assert.equal((await pool.query('SELECT bool_and(NOT authorizes_send) safe FROM crm_graph_candidate.intent')).rows[0].safe,true);
  console.log('PASS lost COMMIT reply reconciles one ledger identity; final OFF, zero transport or new intent from receipt handling.');
 }finally{if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}if(pending)await pending;if(worker)worker.release();await pool.end();}
}
run().catch(e=>{console.error('FAIL graph receipt:',e.code||'',e.message);process.exitCode=1;});
