/* PostgreSQL 17 isolated concurrency proof. Synthetic only; no HTTP or transport. */
'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg'),{install}=require('./journey-graph-cart-fixture.cjs'),{createCartBridge}=require('../n8n/growth/journey-graph-cart.cjs');
const sleep=n=>new Promise(r=>setTimeout(r,n));
(async()=>{
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.pathname,'/journey_graph_cart_test');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.search,'');assert.equal(u.hash,'');
 const pool=new Pool({connectionString:u.toString(),max:6,statement_timeout:10000,connectionTimeoutMillis:3000,application_name:'graph-cart-synthetic-proof'});
 const db={exec:q=>pool.query(q),query:(q,a)=>pool.query(q,a),close:async()=>{}};
 const count=async table=>(await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n;
 async function reset(){await pool.query('DROP SCHEMA IF EXISTS crm_maintenance_candidate CASCADE;DROP SCHEMA IF EXISTS crm_graph_candidate CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public');}
 async function setup(brand='fish'){const x=await install({after(){}},db,pool);return {x,f:await x.prepare(brand)};}
 async function waitBlocked(pid){for(let n=0;n<60;n++){if((await pool.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked)return;await sleep(20);}throw Error('synthetic lock was not reached');}
 try{
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','crm_graph_candidate') AND c.relkind IN ('r','p','v')")).rows[0].n,0);
  for(const brand of ['fish','aristo']){
   const {x,f}=await setup(brand),proof=await f.proof(),legacy=(await f.legacy()).body;
   const [a,b,l]=await Promise.all([x.bridge.claim({...f.request,preflight:proof}),x.bridge.claim({...f.request,preflight:proof}),pool.query('SELECT * FROM shrigma_email_claim_cart($1)',[legacy])]);
   assert.equal([a,b].filter(r=>r.should_send).length,1);assert.equal([a,b].find(r=>!r.should_send).claim_token,null);assert.equal(l.rows[0].reason,'graph_owned');assert.equal(await count('shrigma_email_dispatch'),1);assert.equal(await count('crm_graph_candidate.cart_delivery_v1'),1);assert.equal(await count('crm_graph_candidate.cart_permit_v1'),0);
   const grant=[a,b].find(r=>r.should_send),reader=await pool.connect(),finisher=await pool.connect();try{
    await reader.query('BEGIN');const seen=(await reader.query('SELECT crm_graph_candidate.cart_dispatch_v1($1,$2) r',[brand,f.intent.intent_id])).rows[0].r;assert.equal(seen.transport_state,'in_flight');
    const pid=(await finisher.query('SELECT pg_backend_pid() pid')).rows[0].pid;const pending=finisher.query('SELECT * FROM shrigma_email_finish_cart($1,$2,$3,$4)',[grant.dispatch_id,grant.claim_token,'accepted',grant.context]);await waitBlocked(pid);await reader.query('COMMIT');assert.equal((await pending).rows[0].transport_state,'accepted');
   }finally{await reader.query('ROLLBACK');reader.release();finisher.release();}
   assert.equal((await x.bridge.dispatch(brand,f.intent.intent_id)).transport_state,'accepted');assert.equal(await count('shrigma_send_log'),1);
   await x.bridge.closeEpoch(brand,f.epoch);await pool.query('UPDATE crm_graph_candidate.cart_control_v1 SET enabled=false');assert.equal((await pool.query('SELECT * FROM shrigma_email_claim_cart($1)',[legacy])).rows[0].reason,'graph_owned');
   console.log('PASS '+brand+': concurrent graph/legacy claims reserve once; exact clone/key; lost response has no second token; dispatch SHARE serializes original finish; pause retains ownership.');await reset();
  }

  {
   const {x,f}=await setup(),blocker=await pool.connect(),opener=await pool.connect(),requester=await pool.connect();try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM crm_graph_candidate.journey WHERE id=$1 FOR UPDATE',[f.entry.journey_id]);
    const j=(await pool.query('SELECT version FROM crm_graph_candidate.journey WHERE id=$1',[f.entry.journey_id])).rows[0];
    const openPid=(await opener.query('SELECT pg_backend_pid() pid')).rows[0].pid,claimPid=(await requester.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const open=createCartBridge({query:opener.query.bind(opener),cacheTarget:x.cacheTarget}).openEpoch('panel:synthetic',{brand:'fish',journey_id:f.entry.journey_id,expected_version:j.version});await waitBlocked(openPid);
    const {createMessageClaim}=require('../n8n/growth/journey-graph-message.cjs');const api=createMessageClaim({...f.settings,pool:{connect:async()=>({query:requester.query.bind(requester),release(){}})}});
    const claim=api.claim(f.request);await waitBlocked(claimPid);await blocker.query('COMMIT');await open;assert.equal((await claim).should_send,true);
   }finally{await blocker.query('ROLLBACK');blocker.release();opener.release();requester.release();}
   console.log('PASS epoch-open versus full message claim: maintenance/control/journey order completes without inversion.');await reset();
  }
  {
   const {x,f}=await setup(),proof=await f.proof(),gate=await pool.connect(),requester=await pool.connect();try{
    await gate.query('BEGIN');await gate.query("UPDATE crm_maintenance_candidate.control SET mode='closed'");
    const pid=(await requester.query('SELECT pg_backend_pid() pid')).rows[0].pid,bridge=createCartBridge({query:requester.query.bind(requester),cacheTarget:x.cacheTarget});const pending=bridge.claim({...f.request,preflight:proof}).then(value=>({value}),error=>({error}));await waitBlocked(pid);await gate.query('COMMIT');assert.match((await pending).error?.code||'',/MAINTENANCE_CLOSED/);assert.equal(await count('shrigma_email_dispatch'),0);
   }finally{await gate.query('ROLLBACK');gate.release();requester.release();}
   console.log('PASS concurrent maintenance close: gate is acquired before graph locks and prevents native reservation.');await reset();
  }
  {
   const {x,f}=await setup(),proof=await f.proof(),blocker=await pool.connect(),requester=await pool.connect();try{
    proof.expires_at=new Date(Date.now()+500).toISOString();await blocker.query('BEGIN');await blocker.query('SELECT id FROM subscribers WHERE id=1 FOR UPDATE');
    const pid=(await requester.query('SELECT pg_backend_pid() pid')).rows[0].pid,bridge=createCartBridge({query:requester.query.bind(requester),cacheTarget:x.cacheTarget});const pending=bridge.claim({...f.request,preflight:proof}).then(value=>({value}),error=>({error}));await waitBlocked(pid);await sleep(550);await blocker.query('COMMIT');const result=await pending;assert.match(result.error?.code||'',/PROOF_EXPIRED/);assert.equal(await count('shrigma_email_dispatch'),0);
   }finally{await blocker.query('ROLLBACK');blocker.release();requester.release();}
   console.log('PASS proof expiry while waiting for subscriber: no dispatch, no token.');await reset();
  }
  {
   const {x,f}=await setup(),proof=await f.proof();proof.expires_at=new Date(Date.now()+500).toISOString();
   await pool.query("CREATE FUNCTION synthetic_slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.6);RETURN NEW;END$$;CREATE TRIGGER synthetic_slow BEFORE INSERT ON shrigma_email_dispatch FOR EACH ROW EXECUTE FUNCTION synthetic_slow_claim()");
   const result=await x.bridge.claim({...f.request,preflight:proof});assert.equal(result.reason,'graph_proof_expired');assert.equal(result.should_send,false);assert.equal(await count('shrigma_email_dispatch'),0);assert.equal(await count('crm_graph_candidate.cart_delivery_v1'),0);assert.equal(await count('crm_graph_candidate.cart_permit_v1'),0);
   await pool.query('DROP TRIGGER synthetic_slow ON shrigma_email_dispatch');assert.equal((await f.claim.claim(f.request)).should_send,true);
   console.log('PASS proof expiry inside original reservation: subtransaction rolls back dispatch/link/permit; fresh guarded retry remains single.');await reset();
  }
  {
   const {x,f}=await setup(),proof=await f.proof(),blocker=await pool.connect(),requester=await pool.connect();try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM subscribers WHERE id=1 FOR UPDATE');
    const pid=(await requester.query('SELECT pg_backend_pid() pid')).rows[0].pid,bridge=createCartBridge({query:requester.query.bind(requester),cacheTarget:x.cacheTarget});const pending=bridge.claim({...f.request,preflight:proof}).then(value=>({value}),error=>({error}));await waitBlocked(pid);
    await blocker.query("UPDATE subscribers SET status='blocklisted' WHERE id=1");await blocker.query('COMMIT');assert.match((await pending).error?.code||'',/SOURCE_CHANGED/);assert.equal(await count('shrigma_email_dispatch'),0);
   }finally{await blocker.query('ROLLBACK');blocker.release();requester.release();}
   console.log('PASS optout committed during claim wait: fresh locked identity recheck refuses reservation.');
  }
 }finally{await pool.end();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
