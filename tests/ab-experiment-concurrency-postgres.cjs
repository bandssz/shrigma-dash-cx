'use strict';
const assert=require('node:assert/strict'),{Client}=require('pg');
const {fixture,read,uuid}=require('./ab-experiment-fixture.cjs');
const {insertPredicate}=require('../n8n/growth/ab-listmonk-cohort-patch.cjs');
(async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL||'https://invalid');
 if(process.env.AB_TEST_DATABASE_ISOLATED!=='1'||url.protocol!=='postgres:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/ab_experiment_test')throw Error('Explicit disposable local A/B experiment database required');
 const a=new Client({connectionString:url.href}),b=new Client({connectionString:url.href});let pending;
 try{
  await a.connect();await b.connect();
  assert.equal((await a.query('SELECT current_database() name')).rows[0].name,'ab_experiment_test');
  assert.equal((await a.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows[0].n,0,'empty database required');
  const x=await fixture({query:(...args)=>a.query(...args),exec:q=>a.query(q)});
  const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const wait=async()=>{for(let i=0;i<80;i++){await a.query('SELECT pg_stat_clear_snapshot()');if((await a.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,20));}assert.fail('Second session did not wait');};
  const prepare=(client,p,op)=>client.query('SELECT crm_ab_prepare_v2($1,$2,$3,$4) x',['panel:synthetic','["draft"]',uuid(op),JSON.stringify(p)]).then(r=>r.rows[0].x);
  const p=await x.protocol();await a.query('BEGIN');const first=await prepare(a,p,101);pending=prepare(b,p,101);await wait();await a.query('COMMIT');assert.deepEqual(await pending,first);pending=null;
  assert.equal((await a.query('SELECT count(*)::int n FROM crm_ab_member_v2')).rows[0].n,1000);
  // An opt-out holds its native source row. Preparation waits, then takes the
  // new consent state; it does not copy an older confirmed snapshot after wait.
  let q=await x.protocol('aristo',2);
  await a.query('BEGIN');await a.query("UPDATE lists SET name='Changed during prepare' WHERE id=7");pending=prepare(b,q,102);await wait();await a.query('COMMIT');await assert.rejects(pending,/AB_V2_CAMPAIGN_VERSION/);pending=null;
  q=await x.protocol('aristo',2);await a.query('BEGIN');await a.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=7");
  pending=prepare(b,q,102);await wait();await a.query('COMMIT');const second=await pending;pending=null;
  assert.deepEqual(second.arms.map(r=>r.allocated),[499,500]);
  assert.equal((await a.query('SELECT count(*)::int n FROM crm_ab_member_v2 WHERE test_id=$1 AND subscriber_id=1',[uuid(2)])).rows[0].n,0);
  await a.query(read('n8n/growth/ab-experiment-selection.sql'));
  const query=insertPredicate(`SELECT DISTINCT s.id FROM subscriber_lists sl JOIN subscribers s ON s.id=sl.subscriber_id JOIN lists l ON l.id=sl.list_id JOIN campaign_lists cl ON cl.list_id=l.id WHERE cl.campaign_id=$1 AND s.status != 'blocklisted' AND ((l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status!='unsubscribed')) ORDER BY s.id`,{phase:'batch'});
  await a.query("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817',verified_at=now();UPDATE crm_ab_experiment_v2 SET state='scheduled',transport_bound=true,tracking_continuous=true,window_start=now(),window_end=now()+interval '1 day'");
  const assigned=(await b.query(query,[100])).rows,one=assigned[0].id;
  await a.query('BEGIN');await a.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id IN(3,17)",[one]);await a.query('COMMIT');
  const after=(await b.query(query,[100])).rows;assert.equal(after.length,assigned.length-1);assert.equal(after.some(r=>r.id===one),false);
  // Parallel edits cannot bypass preparation's ownership guard, even with the
  // marker used by the ordinary campaign editor.
  await assert.rejects(b.query("SELECT set_config('shrigma.campaign_writer','100',false);UPDATE campaigns SET status='scheduled' WHERE id=100"),/AB_V2_SCHEDULE_REQUIRED/);
  // Reset only the explicitly isolated disposable database after the allocation proof.
  await a.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const y=await fixture({query:(...args)=>a.query(...args),exec:q=>a.query(q)});
  for(const file of ['n8n/growth/campaign-write-guard.sql','n8n/growth/ab-experiment-selection.sql','n8n/growth/ab-experiment-coordinator.sql'])await a.query(read(file));
  const control=(client,req,op)=>client.query('SELECT crm_ab_control_v2($1,$2,$3,$4) x',['panel:synthetic','["draft","validate","submit"]',uuid(op),JSON.stringify(req)]).then(r=>r.rows[0].x);
  const enable=()=>a.query("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817',verified_at=now()");
  await enable();const cfg=await y.protocol();assert.equal((await control(a,cfg,500)).status,200);
  const reviews=(await a.query('SELECT id,fixture_audience_review(id) v FROM campaigns WHERE id IN(100,101) ORDER BY id')).rows;
  const base={contract:'crm-ab-email-v2',test_id:cfg.test_id,brand:'fish',expected_version:1};
  const review=await control(a,{...base,action:'review',source_reviews:{a:reviews[0].v.audience.review_id,b:reviews[1].v.audience.review_id}},501);
  const schedule={...base,action:'schedule',review_id:review.body.review.review_id,confirm:'schedule_both'};
  await a.query('BEGIN');const scheduled=await control(a,schedule,502);assert.equal(scheduled.status,200);pending=control(b,schedule,502);await wait();await a.query('COMMIT');assert.deepEqual(await pending,scheduled);pending=null;
  assert.equal((await a.query("SELECT count(*)::int n FROM campaigns WHERE id IN(100,101) AND status='scheduled'")).rows[0].n,2);
  assert.equal((await a.query('SELECT count(*)::int n FROM crm_ab_action_v2 WHERE operation_id=$1',[uuid(502)])).rows[0].n,1);
  // Scheduling holds tracking rows before the experiment: a settings update
  // waits, then invalidates the newly scheduled cohort after commit.
  const cfgB=await y.protocol('aristo',2);assert.equal((await control(a,cfgB,510)).status,200);
  const revB=(await a.query('SELECT id,fixture_audience_review(id) v FROM campaigns WHERE id IN(200,201) ORDER BY id')).rows;
  const baseB={...base,test_id:cfgB.test_id,brand:'aristo'};
  const reviewB=await control(a,{...baseB,action:'review',source_reviews:{a:revB[0].v.audience.review_id,b:revB[1].v.audience.review_id}},511);
  await a.query('BEGIN');assert.equal((await control(a,{...baseB,action:'schedule',review_id:reviewB.body.review.review_id,confirm:'schedule_both'},512)).status,200);
  pending=b.query("UPDATE settings SET value='true' WHERE key='privacy.disable_tracking'");await wait();await a.query('COMMIT');await pending;pending=null;
  assert.equal((await y.measure(2)).integrity.tracking_continuous,false);
  await a.query("UPDATE settings SET value='false' WHERE key='privacy.disable_tracking'");
  // Cancel also holds runtime in the same order. OFF afterward permanently
  // invalidates the other active brand, even after ON restores availability.
  await a.query('BEGIN');assert.equal((await control(a,{...base,expected_version:2,action:'cancel',confirm:'cancel_both'},513)).status,200);
  pending=b.query('UPDATE crm_ab_runtime_v2 SET enabled=false');await wait();await a.query('COMMIT');await pending;pending=null;
  assert.equal((await y.measure(2)).integrity.transport_continuous,false);await enable();assert.equal((await y.measure(2)).integrity.transport_continuous,false);
  // Native worker holds one campaign first. Cancel waits and then sees started_at;
  // it must not cancel the other campaign or fabricate a successful receipt.
  await a.query('BEGIN');await a.query('UPDATE campaigns SET started_at=now() WHERE id=200');
  pending=control(b,{...baseB,expected_version:2,action:'cancel',confirm:'cancel_both'},514);await wait();await a.query('COMMIT');
  assert.equal((await pending).body.error,'AB_V2_ALREADY_STARTED');pending=null;
  assert.deepEqual((await a.query('SELECT status FROM campaigns WHERE id IN(200,201) ORDER BY id')).rows.map(r=>r.status),['scheduled','scheduled']);
  console.log('PASS independent PostgreSQL sessions: same identity one cohort, optout-before-allocation honored after lock wait, next native selection excludes committed optout, ordinary scheduler cannot bypass A/B ownership, atomic/replayed schedule, runtime and tracking transitions serialized, native start prevents partial cancel. No transport.');
 }finally{await a.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});await Promise.allSettled([a.end(),b.end()]);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
