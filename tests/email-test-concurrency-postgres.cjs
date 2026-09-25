/* Two real sessions, synthetic data, no HTTP. Requires an empty disposable database. */
'use strict';
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {setup,uuid,P,GEC}=require('./fixtures/email-test-fixture.cjs');
const one=async(c,q,p=[])=>(await c.query(q,p)).rows[0];
(async()=>{
 const connectionString=process.env.TEST_DATABASE_URL;
 if(process.env.EMAIL_TEST_DATABASE_ISOLATED!=='1'||!connectionString)throw Error('Explicit disposable database required');
 const url=new URL(connectionString);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Loopback test service only');
 assert.match(url.pathname,/^\/crm_email_test(?:_[a-z0-9]+)?$/);
 const a=new Client({connectionString}),b=new Client({connectionString});let pending;
 const queue=fn=>{assert.equal(pending,undefined);pending=fn().then(value=>({value}),error=>({error}));};
 async function receive(){const r=await pending;pending=undefined;if(r.error)throw r.error;return r.value;}
 async function locked(observer,pid){for(let i=0;i<75;i++){await observer.query('SELECT pg_stat_clear_snapshot()');if((await one(observer,'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]))?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,20));}assert.fail('Expected actual independent-session lock wait');}
 const request=n=>({draft_id:'d_fixture',expected_version:1,idempotency_key:uuid(n),confirm:'enviar_teste'});
 const claim=(c,n,plan)=>one(c,'SELECT crm_email_test_claim_v1($1,$2,$3) r',['panel:manager',request(n),plan]).then(x=>x.r);
 try{
  await a.connect();await b.connect();
  for(const c of[a,b])await c.query("SET statement_timeout='8s';SET lock_timeout='3s';SET timezone='UTC'");
  assert.match((await one(a,'SELECT current_database() n')).n,/^crm_email_test(?:_[a-z0-9]+)?$/);
  assert.equal((await one(a,"SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).n,0);
  const fixture=await setup({db:{exec:q=>a.query(q),query:(q,p)=>a.query(q,p)}}),pid=(await one(b,'SELECT pg_backend_pid() pid')).pid;
  let plan=P.plan(await fixture.snapshot(),GEC);
  // A reservation remains uncommitted while a second identity targets the same version.
  await a.query('BEGIN');assert.equal((await claim(a,1,plan)).should_send,true);
  queue(()=>claim(b,2,plan));await locked(a,pid);await a.query('COMMIT');
  const lost=await receive();assert.equal(lost.should_send,false);assert.equal(lost.result._body.operation.code,'version_already_attempted');
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_email_dispatch')).n,1);
  assert.equal((await claim(b,1,plan)).should_send,false,'same identity replay cannot obtain transport');
  const denied=await one(b,'SELECT crm_email_test_claim_v1($1,$2,$3) r',['panel:other',request(1),plan]);assert.equal(denied.r.result._http,409);
  // Reset only this disposable fixture. Never used against application databases.
  await a.query('TRUNCATE crm_email_test_operation_v1,shrigma_email_dispatch');
  plan=P.plan(await fixture.snapshot(),GEC);
  await a.query('BEGIN');await a.query("UPDATE subscribers SET status='blocklisted' WHERE id=1");
  queue(()=>claim(b,3,plan));await locked(a,pid);await a.query('COMMIT');
  assert.equal((await receive()).result._body.operation.code,'recipient_disabled');
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_email_dispatch')).n,0);
  await a.query("UPDATE subscribers SET status='enabled';INSERT INTO subscriber_lists VALUES(1,17,'confirmed')");
  plan=P.plan(await fixture.snapshot(),GEC);
  await a.query('BEGIN');await a.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");
  queue(()=>claim(b,4,plan));await locked(a,pid);await a.query('COMMIT');
  assert.equal((await receive()).result._body.operation.code,'recipient_opted_out');
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_email_dispatch')).n,0);
  await a.query("UPDATE subscriber_lists SET status='confirmed' WHERE list_id=17");plan=P.plan(await fixture.snapshot(),GEC);
  await a.query('BEGIN');await a.query("UPDATE templates SET body='different synthetic body' WHERE id=100");
  queue(()=>claim(b,5,plan));await locked(a,pid);await a.query('COMMIT');
  const changed=await pending;pending=undefined;assert.match(changed.error?.message||'',/EMAIL_TEST_SNAPSHOT_CHANGED/);
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_email_dispatch')).n,0);
  console.log('Email test: independent-session once/version, actor replay, global opt-out, brand opt-out and native content contention passed; no transport.');
 }finally{
  await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});
  if(pending)await pending;await a.end();await b.end();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
