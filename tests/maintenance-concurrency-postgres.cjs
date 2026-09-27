'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixtureSQL,store,cart,tx,popup,api}=require('./maintenance-fixture.cjs');
const {createMaintenanceAdapter}=require('../n8n/growth/maintenance-adapter.cjs');
async function run(){
 const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');
 assert.equal(process.env.MAINTENANCE_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
 assert.equal(url.pathname,'/maintenance_retention_test');assert.equal(url.username,'synthetic');assert.equal(url.password,'');assert.equal(url.port,'5432');assert.equal(url.search,'');assert.equal(url.hash,'');
 const {Pool}=require('pg'),pool=new Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'maintenance-synthetic-proof'});
 let blocker=null,waiter=null,pending=null;
 async function waiting(call){waiter=await pool.connect();const pid=(await waiter.query('SELECT pg_backend_pid() id')).rows[0].id;pending=call(api(waiter)).then(value=>({value}),error=>({error}));
  let locked=false;for(let i=0;i<80&&!locked;i++){locked=(await pool.query("SELECT wait_event_type='Lock' locked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.locked===true;if(!locked)await new Promise(r=>setTimeout(r,20));}assert.equal(locked,true,'must observe an actual PostgreSQL lock wait');
 }
 async function settle(){const r=await pending;pending=null;waiter.release();waiter=null;if(r.error)throw r.error;return r.value;}
 async function releaseBlock(commit=true){await blocker.query(commit?'COMMIT':'ROLLBACK');blocker.release();blocker=null;}
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await pool.query("SELECT to_regnamespace('crm_maintenance_candidate') s,to_regclass('public.shrigma_email_dispatch') d")).rows[0].s,null);
  assert.equal((await pool.query("SELECT to_regclass('public.shrigma_email_dispatch') d")).rows[0].d,null,'isolated empty database only');
  await pool.query(fixtureSQL);await pool.query(store);const a=api(pool);const adapter=createMaintenanceAdapter(pool);
  const b=tx(),receipts=await Promise.all([adapter.admit('fish','transactional',b),adapter.admit('fish','transactional',b)]);
  assert.deepEqual(receipts[0],receipts[1]);assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_maintenance_candidate.event')).rows[0].n),1);
  assert.equal((await adapter.claim(receipts[0].event_id)).reason,'retained');await a.control(1,true,'open');
  const claims=await Promise.all([adapter.claim(receipts[0].event_id),adapter.claim(receipts[0].event_id)]);
  assert.equal(claims.filter(c=>c.should_send).length,1);assert.equal(claims.filter(c=>c.claim_token!==null).length,1);assert.equal(claims[0].dispatch_id,claims[1].dispatch_id);
  console.log('PASS concurrent admission and claim: one immutable receipt, one original dispatch/token.');

  // Existing claim holds the shared gate until COMMIT. Close cannot cross it.
  const e=await a.admit('aristo','popup',popup('aristo'));
  blocker=await pool.connect();await blocker.query('BEGIN');const beforeClose=await api(blocker).claim(e.event_id);assert.equal(beforeClose.should_send,true);
  await waiting(w=>w.control(2,true,'closed'));await releaseBlock();const closed=await settle();
  assert.equal(closed.version,3);assert.equal(closed.mode,'closed');assert.equal(closed.reserved_unconfirmed,2);assert.equal(closed.drained,false);
  const late=await a.admit('fish','transactional',tx());assert.equal((await a.claim(late.event_id)).reason,'retained');
  console.log('PASS cutoff waits for outstanding claim transaction; preceding grants remain tracked, late events retained.');

  // Inverse order: the close row lock makes an already waiting claim see CLOSED.
  await a.control(3,true,'open');blocker=await pool.connect();await blocker.query('BEGIN');await api(blocker).control(4,true,'closed');
  await waiting(w=>w.claim(late.event_id));await releaseBlock();assert.equal((await settle()).reason,'retained');
  assert.equal((await a.row(late.event_id)).dispatch_id,null);await a.control(5,true,'open');assert.equal((await a.claim(late.event_id)).should_send,true);
  console.log('PASS close-first race: blocked writer observes CLOSED after commit, resumes same identity once.');

  // A committed receipt whose response is lost must reconcile, not create a new ID.
  const lostBody=tx();let once=true;
  const lost=createMaintenanceAdapter({async query(q,p){const r=await pool.query(q,p);if(once){once=false;throw Error('synthetic response lost');}return r;}});
  await assert.rejects(lost.admit('fish','transactional',lostBody),{code:'MAINTENANCE_UNCONFIRMED'});
  const restored=await adapter.admit('fish','transactional',lostBody);assert.deepEqual(await adapter.admit('fish','transactional',lostBody),restored);
  once=true;await assert.rejects(lost.claim(restored.event_id),{code:'MAINTENANCE_UNCONFIRMED'});
  const noRetry=await adapter.claim(restored.event_id);assert.equal(noRetry.should_send,false);assert.equal(noRetry.claim_token,null);
  await pool.query("UPDATE public.shrigma_email_dispatch SET transport_state='outcome_unknown' WHERE dispatch_id=$1",[noRetry.dispatch_id]);
  assert.equal((await adapter.reconcile(restored.event_id)).state,'outcome_unknown');assert.equal((await adapter.claim(restored.event_id)).should_send,false);
  const lostCloseId=randomUUID();once=true;await assert.rejects(lost.control(lostCloseId,6,true,'closed'),{code:'MAINTENANCE_UNCONFIRMED'});
  const controlReplay=await adapter.control(lostCloseId,6,true,'closed');assert.equal(controlReplay.version,7);assert.deepEqual(await adapter.control(lostCloseId,6,true,'closed'),controlReplay);await a.control(7,true,'open');
  console.log('PASS lost admission/claim/control responses: receipt reconciliation, no second transport grant, original cutoff replay.');

  // Abort BEFORE commit rolls back both dispatch and attachment. Only then may the
  // same identity be claimed again; nobody acknowledges a transaction-local result.
  const abortEvent=await a.admit('aristo','transactional',tx());blocker=await pool.connect();await blocker.query('BEGIN');
  const undone=await api(blocker).claim(abortEvent.event_id);assert.equal(undone.should_send,true);await releaseBlock(false);
  assert.equal((await a.row(abortEvent.event_id)).state,'queued');assert.equal(Number((await pool.query('SELECT count(*) n FROM public.shrigma_email_dispatch WHERE dispatch_id=$1',[undone.dispatch_id])).rows[0].n),0);
  assert.equal((await a.claim(abortEvent.event_id)).should_send,true);
  await pool.query('UPDATE public.maintenance_fixture_policy SET crash=true');const bad=await a.admit('fish','transactional',tx());await assert.rejects(a.claim(bad.event_id),/synthetic original failure/);
  assert.equal((await a.row(bad.event_id)).state,'queued');await pool.query('UPDATE public.maintenance_fixture_policy SET crash=false');assert.equal((await a.claim(bad.event_id)).should_send,true);
  console.log('PASS explicit abort and original function failure leave no partial reservation.');

  // Hold the ORIGINAL dedupe lock beyond the cart's real deadline. The inner
  // reservation must be undone, including any original subscriber side effects.
  const ref=(await pool.query("SELECT to_char((clock_timestamp()-interval '1 hour'+interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') ref")).rows[0].ref;
  const exp=await a.admit('fish','cart',cart('fish',{ref,subscriber_id:98}));
  blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('synthetic-original:'||brand||flow||piece||dedupe_key,0)) FROM crm_maintenance_candidate.event WHERE id=$1",[exp.event_id]);
  await waiting(w=>w.claim(exp.event_id));
  let expired=false;for(let i=0;i<90&&!expired;i++){expired=(await pool.query('SELECT clock_timestamp()>=expires_at elapsed FROM crm_maintenance_candidate.event WHERE id=$1',[exp.event_id])).rows[0].elapsed;if(!expired)await new Promise(r=>setTimeout(r,20));}
  assert.equal(expired,true);await releaseBlock();const expiredResult=await settle();assert.equal(expiredResult.reason,'expired');assert.equal(expiredResult.claim_token,null);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM public.shrigma_email_dispatch WHERE flow='carrinho'")).rows[0].n),0);assert.equal((await a.row(exp.event_id)).state,'expired');
  console.log('PASS deadline elapsed behind original lock: reservation rolled back, no token or window extension.');

  // Transient eligibility can recover, unknown refusal cannot auto-retry.
  const held=await a.admit('aristo','transactional',tx());await pool.query("UPDATE public.maintenance_fixture_policy SET refusal='not_due'");assert.equal((await a.claim(held.event_id)).reason,'retained_not_due');
  await pool.query('UPDATE public.maintenance_fixture_policy SET refusal=NULL');assert.equal((await a.claim(held.event_id)).should_send,true);
  const review=await a.admit('fish','popup',popup('fish',{ref:'popup-execution:987654'}));await pool.query("UPDATE public.maintenance_fixture_policy SET refusal='unrecognized'");assert.equal((await a.claim(review.event_id)).reason,'review_required');
  await pool.query('UPDATE public.maintenance_fixture_policy SET refusal=NULL');assert.equal((await a.claim(review.event_id)).should_send,false);
  const final=await a.control(8,false,'closed');assert.equal(final.enabled,false);assert.equal(final.drained,false);
  console.log('PASS final OFF: no artificial popup/transactional TTL, review-required is preserved, no transport exists in fixture.');
 }finally{
  if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}
  if(pending)await pending;
  if(waiter)waiter.release();await pool.end();
 }
}
run().catch(e=>{console.error('FAIL maintenance proof:',e.code||'',e.message);process.exitCode=1;});
