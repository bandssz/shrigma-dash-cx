/* Disposable PostgreSQL only. Real SHA-256, two database sessions, no transport. */
'use strict';
const assert=require('node:assert/strict'),{Client}=require('pg');
const {setup,seed,one,recover}=require('./ses-popup-recovery-fixture.cjs');
(async()=>{
 if(process.env.POPUP_RECOVERY_TEST_DATABASE_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('Explicit isolated popup recovery database required');
 const a=new Client({connectionString:process.env.TEST_DATABASE_URL}),b=new Client({connectionString:process.env.TEST_DATABASE_URL});
 a.exec=q=>a.query(q);b.exec=q=>b.query(q);let pending,waits=0;
 const queue=fn=>{assert.equal(pending,undefined);pending=fn().then(value=>({value}),error=>({error}));};
 const receive=async()=>{const r=await pending;pending=undefined;return r;};
 const wait=async(observer,pid)=>{for(let i=0;i<100;i++){await observer.query('SELECT pg_stat_clear_snapshot()');if((await one(observer,'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).wait_event_type==='Lock'){waits++;return;}await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected an actual independent-session lock wait');};
 const finish=(c,s,outcome='accepted')=>one(c,'SELECT * FROM shrigma_email_finish_engagement($1,$2,$3,$4::jsonb)',[s.id,s.claim.claim_token,outcome,JSON.stringify(s.claim.context)]);
 const claim=(c,s)=>one(c,'SELECT * FROM shrigma_email_claim_engagement($1::jsonb)',[JSON.stringify(s.payload)]);
 try{
  await a.connect();await b.connect();
  for(const c of [a,b])await c.query("SET statement_timeout='8s';SET lock_timeout='4s';SET timezone='UTC'");
  assert.match((await one(a,'SELECT current_database() AS name')).name,/^popup_recovery_test(?:_[a-z0-9]+)?$/);
  assert.equal((await one(a,"SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).n,0);
  const pidA=(await one(a,'SELECT pg_backend_pid() AS pid')).pid,pidB=(await one(b,'SELECT pg_backend_pid() AS pid')).pid;assert.notEqual(pidA,pidB);
  await setup(a,true);
  assert.equal((await one(a,"SELECT encode(digest(convert_to('synthetic','UTF8'),'sha256'),'hex') AS hash")).hash.length,64);
  // Default dry run performs no committed finalization.
  const dry=await seed(a);assert.equal((await recover(a,dry)).result,'would_reconcile');assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_send_log')).n,0);
  // Two recoveries of the same evidence: second waits, then returns same log.
  const s=await seed(a);await a.query('BEGIN');const first=await recover(a,s,false);queue(()=>recover(b,s,false));await wait(a,pidB);await a.query('COMMIT');
  const second=await receive();assert.ifError(second.error);assert.equal(second.value.result,'already_applied');assert.equal(second.value.send_log_id,first.send_log_id);
  // Production reservation's two advisory locks have the same order as repair.
  const held=await seed(a);await a.query('BEGIN');assert.equal((await claim(a,held)).should_send,false);queue(()=>recover(b,held,false));await wait(a,pidB);await a.query('COMMIT');assert.equal((await receive()).value.result,'reconciled');
  // While repair owns the reservation, a claim cannot issue a second send.
  const fence=await seed(a);await a.query('BEGIN');await recover(a,fence,false);queue(()=>claim(b,fence));await wait(a,pidB);await a.query('COMMIT');const declined=await receive();assert.ifError(declined.error);assert.equal(declined.value.should_send,false);assert.equal(declined.value.reason,'accepted');
  // Original finalization wins: recovery must not overwrite its known template.
  const known=await seed(a);await a.query('BEGIN');const native=await finish(a,known);queue(()=>recover(b,known,false));await wait(a,pidB);await a.query('COMMIT');const rejected=await receive();assert.match(rejected.error?.message||'',/POPUP_RECOVERY_STATE_INVALID/);
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_email_popup_recovery_v1 WHERE dispatch_id=$1',[known.id])).n,0);assert.equal((await one(a,'SELECT template_id FROM shrigma_send_log WHERE id=$1',[native.send_log_id])).template_id,22);
  // Recovery wins: original finalizer waits then recognizes the same accepted log.
  const race=await seed(a);await a.query('BEGIN');const repaired=await recover(a,race,false);queue(()=>finish(b,race));await wait(a,pidB);await a.query('COMMIT');const converged=await receive();assert.ifError(converged.error);assert.equal(converged.value.send_log_id,repaired.send_log_id);
  // An uncertain native result does not authorize a resend; archived SES can reconcile it.
  const uncertain=await seed(a);await a.query('BEGIN');await finish(a,uncertain,'outcome_unknown');queue(()=>recover(b,uncertain,false));await wait(a,pidB);await a.query('COMMIT');assert.equal((await receive()).value.result,'reconciled');
  // An ingestion/archive writer must not deadlock behind the held dispatch.
  for(const table of ['shrigma_email_event_ingest','shrigma_email_queue_receipt','shrigma_email_message_link']){
   const busy=await seed(a);await a.query('BEGIN');await a.query('SELECT * FROM '+table+(table==='shrigma_email_message_link'?' WHERE dispatch_id=$1':' WHERE ingest_id IN (SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)')+' FOR UPDATE',[busy.id]);
   await assert.rejects(recover(b,busy,false),e=>e.code==='55P03');await a.query('COMMIT');
   assert.equal((await one(a,'SELECT send_log_id FROM shrigma_email_dispatch WHERE dispatch_id=$1',[busy.id])).send_log_id,null);assert.equal((await recover(b,busy,false)).result,'reconciled');
  }
  assert.equal((await one(a,"SELECT count(*)::int n FROM (SELECT ref,count(*) FROM shrigma_send_log GROUP BY ref HAVING count(*)>1) x")).n,0);
  assert.equal((await one(a,"SELECT count(*)::int n FROM subscribers WHERE attribs<>'{\"marker\":\"preserved\"}'::jsonb")).n,0);
  console.log(`PASS popup recovery PostgreSQL: ${waits} real lock waits; dry-run rollback, once-only recovery, reservation and native-finalization races. No HTTP or production data.`);
 }finally{await Promise.allSettled([a.query('ROLLBACK'),b.query('ROLLBACK')]);if(pending)await pending;await Promise.allSettled([a.end(),b.end()]);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
