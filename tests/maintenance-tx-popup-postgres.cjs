'use strict';
// Disposable PostgreSQL only. No HTTP or production credentials accepted.
const assert=require('node:assert/strict');
const {fixtureSQL,store,txSQL,body,txAPI,cart,popup}=require('./maintenance-tx-popup-fixture.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.MAINTENANCE_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/maintenance_tx_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Pool}=require('pg'),pool=new Pool({connectionString:u.toString(),max:8,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'maintenance-tx-synthetic'});let blocker,worker,pending;
 async function waitForLock(call){worker=await pool.connect();const pid=(await worker.query('SELECT pg_backend_pid() id')).rows[0].id;pending=call(txAPI(worker)).then(value=>({value}),error=>({error}));let seen=false;for(let i=0;i<100&&!seen;i++){seen=(await pool.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;if(!seen)await new Promise(r=>setTimeout(r,20));}assert.equal(seen,true,'actual database lock must be observed');}
 async function release(){await blocker.query('COMMIT');blocker.release();blocker=null;}
 async function settle(){const r=await pending;pending=null;worker.release();worker=null;if(r.error)throw r.error;return r.value;}
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');assert.equal((await pool.query("SELECT to_regnamespace('crm_maintenance_candidate') s")).rows[0].s,null);await pool.query(fixtureSQL);await pool.query(store);await pool.query(txSQL);const a=txAPI(pool);
  const same=await Promise.all([a.admitTX('fish',body()),a.admitTX('fish',body())]);assert.deepEqual(same[0],same[1]);assert.equal(same[0].persisted,true);assert.equal(same[0].expires_at,null);assert.equal(Number((await pool.query('SELECT count(*) n FROM shrigma_email_dispatch')).rows[0].n),0);
  // Commit completed, response dropped: retry recovers same immutable receipt.
  let lost=true;const dropped=txAPI({async query(q,p){const r=await pool.query(q,p);if(lost){lost=false;throw Error('SYNTHETIC_ACK_LOST');}return r;}});await assert.rejects(dropped.admitTX('fish',body()),/SYNTHETIC_ACK_LOST/);assert.deepEqual(await a.admitTX('fish',body()),same[0]);
  console.log('PASS concurrent admission and lost ACK: one event, stable durable receipt, zero reservations.');

  await a.control(1,true,'open');await a.subscriber('fish');await a.subscriber('aristo');
  const grants=await Promise.all([a.claimTX(same[0].event_id),a.claimTX(same[0].event_id)]);assert.equal(grants.filter(c=>c.should_send).length,1);const c=grants.find(c=>c.should_send);assert.equal(grants.find(c=>!c.should_send).claim_token,null);
  await a.finishTX(c,{statusCode:200,body:{data:true}});assert.equal((await a.row(same[0].event_id)).state,'accepted');assert.equal((await a.claimTX(same[0].event_id)).claim_token,null);
  console.log('PASS two concurrent claims: exactly one original token/dispatch, native finish reconciles atomically.');

  const delayed=await a.admitTX('aristo',body('aristo',{order_id:'delayed'}));assert.equal((await a.nextTX('aristo'))[0].event_id,delayed.event_id);
  blocker=await pool.connect();await blocker.query('BEGIN');await txAPI(blocker).control(2,true,'closed');await waitForLock(w=>w.claimTX(delayed.event_id));await release();const held=await settle();assert.equal(held.reason,'retained');assert.equal((await a.row(delayed.event_id)).dispatch_id,null);assert.deepEqual(await a.nextTX('aristo'),[]);
  const late=await a.admitTX('aristo',body('aristo',{order_id:'late-closed'}));assert.equal((await a.row(late.event_id)).state,'queued');await a.control(3,true,'open');assert.equal((await a.claimTX(delayed.event_id)).should_send,true);
  console.log('PASS close versus selected work: delayed claim waits for gate then retains; late admission still commits.');

  const opt=await a.admitTX('fish',body('fish',{order_id:'late-optout'}));blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("UPDATE subscribers SET status='blocklisted' WHERE email='synthetic@example.invalid'");await waitForLock(w=>w.claimTX(opt.event_id));await release();const refused=await settle();assert.equal(refused.should_send,false);assert.equal((await a.row(opt.event_id)).reason,'optout');await pool.query("UPDATE subscribers SET status='enabled'");
  console.log('PASS opt-out committed while claim waits: no token, blocked receipt, no implicit re-subscription.');

  // Independent consumers cannot select a stale first page twice. Backoff is
  // retry cadence only; queued event has no deadline and retains its identity.
  for(let i=0;i<24;i++)await a.admitTX('fish',body('fish',{order_id:'fair-'+i}));const selected=[];for(let i=0;i<12;i++)selected.push(...(await Promise.all([a.nextTX('fish'),a.nextTX('fish')])).flat());assert.equal(selected.length,24);assert.equal(new Set(selected.map(r=>r.event_id)).size,24);assert.deepEqual(await a.nextTX('fish'),[]);
  await pool.query('UPDATE maintenance_fixture_policy SET paused=true');for(const n of selected)assert.equal((await a.claimTX(n.event_id)).reason,'retained_flow_paused');await pool.query("UPDATE crm_maintenance_candidate.tx_attempt SET last_attempt_at=clock_timestamp()-interval '31 seconds';UPDATE maintenance_fixture_policy SET paused=false");assert.equal((await a.nextTX('fish'))[0].event_id,selected[0].event_id);
  console.log('PASS two workers rotate 24 queued entries with no same-turn duplicate; pause retains original identity indefinitely.');

  const missing=await a.admitTX('aristo',body('aristo',{order_id:'missing',email:'new@example.invalid'}));assert.equal((await a.claimTX(missing.event_id)).reason,'retained_subscriber_pending');await a.subscriber('aristo','new@example.invalid');const prepared=await a.claimTX(missing.event_id);assert.equal(prepared.should_send,true);
  const finishes=await Promise.all([a.finishTX(prepared,{error:'SYNTHETIC_TIMEOUT'}),a.finishTX(prepared,{error:'SYNTHETIC_TIMEOUT'})]);assert.deepEqual(finishes[0],finishes[1]);assert.equal(finishes[0].transport_state,'outcome_unknown');assert.equal((await a.claimTX(missing.event_id)).claim_token,null);
  console.log('PASS unavailable preparation retains; later exact subscriber enables claim once; unknown finish never retries transport.');

  const fail=await a.admitTX('aristo',body('aristo',{order_id:'finish-fail'})),fc=await a.claimTX(fail.event_id);await pool.query("CREATE FUNCTION reject_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.state='accepted' THEN RAISE EXCEPTION 'SYNTHETIC_RECONCILE';END IF;RETURN NEW;END$$;CREATE TRIGGER reject_reconcile BEFORE UPDATE ON crm_maintenance_candidate.event FOR EACH ROW EXECUTE FUNCTION reject_reconcile()");await assert.rejects(a.finishTX(fc,{statusCode:200,body:{data:true}}),/SYNTHETIC_RECONCILE/);assert.equal((await a.row(fail.event_id)).state,'claimed');assert.equal((await pool.query('SELECT transport_state FROM shrigma_email_dispatch WHERE dispatch_id=$1',[fc.dispatch_id])).rows[0].transport_state,'in_flight');assert.equal((await a.claimTX(fail.event_id)).claim_token,null);await pool.query('DROP TRIGGER reject_reconcile ON crm_maintenance_candidate.event');assert.equal((await a.finishTX(fc,{statusCode:200,body:{data:true}})).transport_state,'accepted');
  console.log('PASS reconciliation exception rolls back finish SQL/log while preserving claimed fence; only same finish can be retried.');

  // Recreate the exact reviewed native claim/selector/finish bodies, retaining
  // advisory/dispatch/subscriber composition instead of relying on the stub.
  await pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'maintenance-tx-popup-native-fixture.sql'),'utf8'));
  const nativeBody=body('fish',{order_id:'native-original-race'}),nativeEvent=await a.admitTX('fish',nativeBody);
  blocker=await pool.connect();await blocker.query('BEGIN');const original=(await blocker.query("SELECT * FROM public.shrigma_flow_email_claim_tx('fish',$1::jsonb)",[JSON.stringify(nativeBody)])).rows[0];assert.equal(original.should_send,true);
  await waitForLock(w=>w.claimTX(nativeEvent.event_id));await release();const nativeRace=await settle();assert.equal(nativeRace.should_send,false);assert.equal(nativeRace.dispatch_id,original.dispatch_id);assert.equal(nativeRace.claim_token,null);
  const nativeFinishes=await Promise.all([a.finishTX(original,{statusCode:200,body:{data:true}}),a.finishTX(original,{statusCode:200,body:{data:true}})]);assert.deepEqual(nativeFinishes[0],nativeFinishes[1]);assert.equal((await a.row(nativeEvent.event_id)).state,'accepted');assert.equal(Number((await pool.query('SELECT count(*) n FROM shrigma_send_log')).rows[0].n),1);
  console.log('PASS actual native advisory/dispatch claim versus retention subscriber/event locks: one identity, concurrent real finish reconciles.');
  const nativeOpt=await a.admitTX('aristo',body('aristo',{order_id:'native-late-optout'}));blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("UPDATE subscribers SET status='blocklisted' WHERE email='synthetic@example.invalid'");await waitForLock(w=>w.claimTX(nativeOpt.event_id));await release();assert.equal((await settle()).should_send,false);assert.equal((await a.row(nativeOpt.event_id)).reason,'optout');await pool.query("UPDATE subscribers SET status='enabled' WHERE email='synthetic@example.invalid'");
  await pool.query("UPDATE shrigma_flow_definition SET enabled=false WHERE brand='aristo'");const nativePaused=await a.admitTX('aristo',body('aristo',{order_id:'native-paused'}));assert.equal((await a.claimTX(nativePaused.event_id)).reason,'retained_flow_paused');await pool.query("UPDATE shrigma_flow_definition SET enabled=true WHERE brand='aristo'");const nativeReady=await a.claimTX(nativePaused.event_id);assert.equal(nativeReady.should_send,true);assert.equal((await a.finishTX(nativeReady,{statusCode:422})).transport_state,'rejected');assert.equal((await a.row(nativePaused.event_id)).state,'rejected');
  console.log('PASS actual published selector pause and committed late opt-out remain fenced; real rejection ends without retry.');

  const cartEvent=await a.admit('fish','cart',cart()),popupEvent=await a.admit('fish','popup',popup());await assert.rejects(a.claimTX(cartEvent.event_id),/MAINTENANCE_TX_SCOPE/);await assert.rejects(a.claimTX(popupEvent.event_id),/MAINTENANCE_TX_SCOPE/);await assert.rejects(a.nextTX('olivas'),/MAINTENANCE_TX_SCOPE/);const control=await a.control(4,true,'closed');assert.equal(control.drained,false);assert.deepEqual(await a.nextTX('fish'),[]);assert.equal((await a.row(cartEvent.event_id)).state,'queued');assert.equal((await a.row(popupEvent.event_id)).state,'queued');
  console.log('PASS final closed gate, other families/brands untouched, no HTTP or external delivery performed.');
 }finally{if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}if(pending)await pending;if(worker)worker.release();await pool.end();}
}
run().catch(e=>{console.error('FAIL maintenance TX:',e.code||'',e.message);process.exitCode=1;});
