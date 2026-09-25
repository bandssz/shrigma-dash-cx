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
  await a.query("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256=repeat('a',64),verified_at=now();UPDATE crm_ab_experiment_v2 SET state='scheduled',transport_bound=true,tracking_continuous=true,window_start=now(),window_end=now()+interval '1 day'");
  const assigned=(await b.query(query,[100])).rows,one=assigned[0].id;
  await a.query('BEGIN');await a.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id IN(3,17)",[one]);await a.query('COMMIT');
  const after=(await b.query(query,[100])).rows;assert.equal(after.length,assigned.length-1);assert.equal(after.some(r=>r.id===one),false);
  // Parallel edits cannot bypass preparation's ownership guard, even with the
  // marker used by the ordinary campaign editor.
  await assert.rejects(b.query("SELECT set_config('shrigma.campaign_writer','100',false);UPDATE campaigns SET status='scheduled' WHERE id=100"),/AB_V2_SCHEDULE_REQUIRED/);
  console.log('PASS independent PostgreSQL sessions: same identity one cohort, optout-before-allocation honored after lock wait, next native selection excludes committed optout, ordinary scheduler cannot bypass A/B ownership. No transport.');
 }finally{await a.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});await Promise.allSettled([a.end(),b.end()]);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
