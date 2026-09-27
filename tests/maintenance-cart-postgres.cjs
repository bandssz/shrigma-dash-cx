'use strict';
const assert=require('node:assert/strict');
const {fixtureSQL,store,cartSQL,cart,cartAPI}=require('./maintenance-cart-fixture.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.MAINTENANCE_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/maintenance_cart_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Pool}=require('pg'),pool=new Pool({connectionString:u.toString(),max:8,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'maintenance-cart-synthetic'});let blocker,worker,pending;
 async function waitForLock(call){worker=await pool.connect();const pid=(await worker.query('SELECT pg_backend_pid() id')).rows[0].id;pending=call(cartAPI(worker)).then(value=>({value}),error=>({error}));let seen=false;for(let n=0;n<80&&!seen;n++){seen=(await pool.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;if(!seen)await new Promise(r=>setTimeout(r,20));}assert.equal(seen,true,'actual worker lock must be observed');}
 async function release(){await blocker.query('COMMIT');blocker.release();blocker=null;}
 async function settle(){const r=await pending;pending=null;worker.release();worker=null;if(r.error)throw r.error;return r.value;}
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');assert.equal((await pool.query("SELECT to_regnamespace('crm_maintenance_candidate') s")).rows[0].s,null);await pool.query(fixtureSQL);await pool.query(store);await pool.query(cartSQL);const a=cartAPI(pool);
  const b=cart(),same=await Promise.all([a.ingest(b),a.ingest(b)]);assert.equal(same[0].event_id,same[1].event_id);assert.equal(same[0].should_send,false);await a.control(1,true,'open');
  const race=await Promise.all([a.ingest(b),a.next('fish')]);const results=[race[0],...race[1]];assert.equal(results.filter(r=>r.should_send).length,1);assert.equal(Number((await pool.query('SELECT count(*) n FROM public.shrigma_email_dispatch')).rows[0].n),1);
  console.log('PASS original producer versus resume worker: one retained event, one dispatch/token.');

  // Close first. An ingest already waiting on the gate must commit admission,
  // with no claim, after it observes the newly closed mode.
  blocker=await pool.connect();await blocker.query('BEGIN');await cartAPI(blocker).control(2,true,'closed');const lateBody=cart('aristo',{subscriber_id:88});
  await waitForLock(w=>w.ingest(lateBody));await release();const late=await settle();assert.equal(late.reason,'retained');assert.equal((await a.row(late.event_id)).state,'queued');
  await a.control(3,true,'open');assert.equal((await a.next('aristo'))[0].event_id,late.event_id);
  console.log('PASS close commits before delayed producer: original identity persists, no escape through old claim.');

  // Fairness under two independent consumers and more than one ten-item turn.
  await a.control(4,true,'closed');const held=[];
  for(let id=100;id<123;id++)held.push(await a.ingest(cart('fish',{subscriber_id:id,fixture_pause:true})));
  const ready=await a.ingest(cart('fish',{subscriber_id:999}));await a.control(5,true,'open');
  const observed=[];for(let n=0;n<12;n++){const pair=await Promise.all([a.next('fish'),a.next('fish')]);observed.push(...pair.flat());}
  assert.equal(new Set(observed.map(r=>r.event_id)).size,24);assert.equal(observed.filter(r=>r.should_send).length,1);assert.equal(observed.find(r=>r.should_send).event_id,ready.event_id);
  assert.ok(held.some(e=>e.event_id===observed.find(r=>!r.should_send).event_id));
  const oldest=(await pool.query("SELECT a.event_id FROM crm_maintenance_candidate.cart_attempt a JOIN crm_maintenance_candidate.event e ON e.id=a.event_id WHERE e.brand='fish' AND e.state='queued' ORDER BY a.last_turn LIMIT 1")).rows[0].event_id;assert.equal((await a.next('fish'))[0].event_id,oldest);
  console.log('PASS two workers rotate past 23 paused carts to a ready cart, without same-turn claim duplication.');

  // Response loss after autocommit: never retry the transport or mint a token.
  const lostBody=cart('aristo',{subscriber_id:501});let once=true;const lost=cartAPI({async query(q,p){const r=await pool.query(q,p);if(once){once=false;throw Error('synthetic committed response lost');}return r;}});
  await assert.rejects(lost.ingest(lostBody),/synthetic committed response lost/);const recovered=await a.ingest(lostBody);assert.equal(recovered.should_send,false);assert.equal(recovered.claim_token,null);
  await pool.query("UPDATE public.shrigma_email_dispatch SET transport_state='outcome_unknown' WHERE dispatch_id=$1",[recovered.dispatch_id]);assert.equal((await a.reconcile(recovered.event_id)).state,'outcome_unknown');assert.equal((await a.ingest(lostBody)).claim_token,null);
  console.log('PASS committed response lost: same identity reconciles, unknown dispatch never reissues payload/token.');
  for(const [subscriber_id,outcome] of [[601,'accepted'],[602,'rejected'],[603,'outcome_unknown']]){
   const c=await a.ingest(cart('aristo',{subscriber_id}));const sameFinish=await Promise.all([a.finish({...c,outcome}),a.finish({...c,outcome})]);assert.deepEqual(sameFinish[0],sameFinish[1]);assert.equal((await a.row(c.event_id)).state,outcome);assert.equal((await a.ingest((await a.row(c.event_id)).payload)).should_send,false);
  }
  const finishFail=await a.ingest(cart('aristo',{subscriber_id:604}));await pool.query("CREATE FUNCTION maintenance_finish_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='accepted' THEN RAISE EXCEPTION 'synthetic reconcile failure';END IF;RETURN NEW;END $$;CREATE TRIGGER maintenance_finish_fail BEFORE UPDATE ON crm_maintenance_candidate.event FOR EACH ROW EXECUTE FUNCTION maintenance_finish_fail();");
  await assert.rejects(a.finish({...finishFail,outcome:'accepted'}),/synthetic reconcile failure/);assert.equal((await a.row(finishFail.event_id)).state,'claimed');assert.equal((await pool.query('SELECT transport_state FROM public.shrigma_email_dispatch WHERE dispatch_id=$1',[finishFail.dispatch_id])).rows[0].transport_state,'in_flight');assert.equal((await a.claim(finishFail.event_id)).should_send,false);await pool.query('DROP TRIGGER maintenance_finish_fail ON crm_maintenance_candidate.event');assert.equal((await a.finish({...finishFail,outcome:'accepted'})).transport_state,'accepted');
  console.log('PASS concurrent native finish/reconcile preserves outcomes and context; failed reconciliation rolls back SQL, never resends.');


  // The original reservation waits across the actual cart deadline. Nothing is
  // committed in that original claim; retained evidence becomes expired.
  const ref=(await pool.query("SELECT to_char((clock_timestamp()-interval '1 hour'+interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') ref")).rows[0].ref;
  await a.control(6,true,'closed');const exp=await a.ingest(cart('aristo',{subscriber_id:777,ref}));await a.control(7,true,'open');
  blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('synthetic-original:'||brand||flow||piece||dedupe_key,0)) FROM crm_maintenance_candidate.event WHERE id=$1",[exp.event_id]);
  await waitForLock(w=>w.next('aristo'));let expired=false;for(let n=0;n<90&&!expired;n++){expired=(await pool.query('SELECT clock_timestamp()>=expires_at elapsed FROM crm_maintenance_candidate.event WHERE id=$1',[exp.event_id])).rows[0].elapsed;if(!expired)await new Promise(r=>setTimeout(r,20));}assert.equal(expired,true);await release();const [end]=await settle();assert.equal(end.reason,'expired');assert.equal(end.claim_token,null);assert.equal((await a.row(exp.event_id)).dispatch_id,null);
  console.log('PASS actual deadline crossed behind original lock: no surviving claim/token or marketing-window extension.');

  // An original SQL error cannot repeatedly occupy the earliest queue position.
  const broken=await a.ingest(cart('aristo',{subscriber_id:778,fixture_pause:true}));await pool.query('UPDATE public.maintenance_fixture_policy SET crash=true');
  // Direct original failure is tested with a new unpaused item; admission survives.
  const failure=await a.ingest(cart('aristo',{subscriber_id:779}));assert.equal(failure.reason,'review_required');assert.equal((await a.row(failure.event_id)).dispatch_id,null);await pool.query('UPDATE public.maintenance_fixture_policy SET crash=false');assert.equal((await a.ingest(cart('aristo',{subscriber_id:779,ref:(await a.row(failure.event_id)).payload.ref}))).should_send,false);
  assert.equal((await a.row(broken.event_id)).state,'queued');const close=await a.control(8,false,'closed');assert.equal(close.enabled,false);assert.equal(close.drained,false);assert.deepEqual(await a.next('fish'),[]);
  console.log('PASS SQL failure remains review-blocked, temporary pauses retained, final OFF without any transport.');
 }finally{if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}if(pending)await pending;if(worker)worker.release();await pool.end();}
}
run().catch(e=>{console.error('FAIL maintenance cart:',e.code||'',e.message);process.exitCode=1;});
