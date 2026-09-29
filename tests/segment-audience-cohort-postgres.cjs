'use strict';
// Real PG17.10, empty disposable database, loopback only. No credentials lookup.
const assert=require('node:assert/strict'),{Client}=require('pg');
const F=require('./segment-audience-cohort-fixture.cjs'),C=require('../n8n/growth/segment-audience-cohort.cjs'),Count=require('../n8n/growth/segment-audience-listmonk.cjs');
const url=new URL(process.env.TEST_DATABASE_URL||'http://invalid');
if(process.env.AUDIENCE_COHORT_TEST_DATABASE_ISOLATED!=='1'||url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.pathname!=='/audience_cohort_test'||url.username!=='crm_shadow'||url.password||!url.port||url.port==='5432')throw Error('ISOLATED_COHORT_DATABASE_REQUIRED');
const clients=[],connectionString=url.href;let stage='initial';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function client(){const c=new Client({connectionString,statement_timeout:20000,connectionTimeoutMillis:5000});clients.push(c);await c.connect();await c.query("SET lock_timeout='500ms'");return c;}
(async()=>{
 try{
  const admin=await client(),worker=await client(),writer=await client(),observer=await client();
  const info=(await admin.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::int AS version,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','v','m','S')) AS existing")).rows[0];
  assert.equal(info.db,'audience_cohort_test');assert.equal(info.role,'crm_shadow');assert.equal(info.version,170010);assert.equal(info.existing,0);
  const pids=await Promise.all(clients.map(c=>c.query('SELECT pg_backend_pid() AS pid').then(r=>r.rows[0].pid)));assert.equal(new Set(pids).size,4);
  await F.setup({exec:q=>admin.query(q),query:(q,v)=>admin.query(q,v)});
  const reset=async()=>{await admin.query('TRUNCATE subscriber_lists,subscribers');await admin.query(F.schema.slice(F.schema.indexOf('INSERT INTO subscribers')));};
  const aggregate=p=>Count.countAudience({...p,query:(q,v)=>observer.query(q,v)});
  async function waitBlocked(){let waiting=false;const end=Date.now()+350;while(Date.now()<end){const r=(await observer.query("SELECT wait_event_type='Lock' AND $2::integer=ANY(pg_blocking_pids(pid)) AS waiting FROM pg_stat_activity WHERE pid=$1",[pids[1],pids[2]])).rows[0];if(r?.waiting){waiting=true;break;}await sleep(5);}assert.equal(waiting,true,'Expected bounded lock wait');}
  async function beginBlocked(lockSQL,parameters,options){await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');await writer.query(lockSQL,parameters);await worker.query('BEGIN ISOLATION LEVEL READ COMMITTED');const pending=C.resolveCohort({...options,query:(q,v)=>worker.query(q,v)}).then(result=>({result}),error=>({error:error.code}));await waitBlocked();return {pending};}
  async function finishBlocked(pending,expected){await writer.query('COMMIT');const r=await pending;assert.equal(r.error,undefined,'Cohort query unexpectedly failed');assert.equal(r.result.source_confirmed,true);assert.deepEqual(r.result.member_ids,expected);assert.equal(r.result.eligible_count,expected.length);return r.result;}
  async function retainedAndReleased(id,base){
   for(const [sql,params]of [['UPDATE subscribers SET status=status WHERE id=$1',[id]],['UPDATE subscriber_lists SET status=status WHERE subscriber_id=$1 AND list_id=$2',[id,base]]]){
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='50ms'");await assert.rejects(writer.query(sql,params),e=>e.code==='55P03');await writer.query('ROLLBACK');
   }
   await worker.query('COMMIT');
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='50ms'");await writer.query('UPDATE subscribers SET status=status WHERE id=$1',[id]);await writer.query('UPDATE subscriber_lists SET status=status WHERE subscriber_id=$1 AND list_id=$2',[id,base]);await writer.query('COMMIT');
  }
  // The original base relation is captured before these waits. EPQ must return
  // the changed value of the SAME locked row, rather than its old consent.
  for(const [brand,base,a,b,first,next,expected]of [['fish',17,101,102,1,2,[2,3]],['aristo',16,201,202,7,8,[8]]]){
   stage=brand+'_membership_optout';await reset();const args=F.args(brand,{op:'or',rules:[F.leaf(a),F.leaf(b)]});
   const {pending}=await beginBlocked('SELECT * FROM subscriber_lists WHERE subscriber_id=$1 AND list_id=$2 FOR UPDATE',[first,base],args);
   assert.equal((await aggregate(args)).eligible_count,expected.length+1);
   await writer.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=$2",[first,base]);
   await finishBlocked(pending,expected);assert.equal((await aggregate(args)).eligible_count,expected.length);await retainedAndReleased(next,base);

   stage=brand+'_subscriber_status';await reset();
   const {pending:statusPending}=await beginBlocked('SELECT * FROM subscribers WHERE id=$1 FOR UPDATE',[first],args);
   await writer.query("UPDATE subscribers SET status='blocklisted' WHERE id=$1",[first]);await finishBlocked(statusPending,expected);await worker.query('COMMIT');
  }
  // A NEW leaf membership for an existing base candidate must not appear via
  // a later table rescan after the original statement has waited.
  stage='leaf_membership_phantom';await reset();await admin.query('DELETE FROM subscriber_lists WHERE subscriber_id=3 AND list_id=101');
  const both=F.args('fish',{op:'and',rules:[F.leaf(101),F.leaf(102)]});
  const {pending:leafPending}=await beginBlocked('SELECT * FROM subscriber_lists WHERE subscriber_id=1 AND list_id=17 FOR UPDATE',[],both);
  await writer.query("INSERT INTO subscriber_lists VALUES(3,101,'confirmed')");await finishBlocked(leafPending,[1]);assert.equal((await aggregate(both)).eligible_count,2);await worker.query('COMMIT');

  // Both an existing non-base subscriber newly joining the base and an entirely
  // new subscriber/base membership arrive after the candidate snapshot.
  stage='base_and_subscriber_phantoms';await reset();await admin.query("INSERT INTO subscribers VALUES(9,'enabled');INSERT INTO subscriber_lists VALUES(9,101,'confirmed')");
  const either=F.args('fish',{op:'or',rules:[F.leaf(101),F.leaf(102)]});
  const {pending:basePending}=await beginBlocked('SELECT * FROM subscriber_lists WHERE subscriber_id=1 AND list_id=17 FOR UPDATE',[],either);
  await writer.query("INSERT INTO subscriber_lists VALUES(9,17,'confirmed');INSERT INTO subscribers VALUES(10,'enabled');INSERT INTO subscriber_lists VALUES(10,17,'confirmed'),(10,101,'confirmed')");
  await finishBlocked(basePending,[1,2,3]);assert.equal((await aggregate(either)).eligible_count,5);await worker.query('COMMIT');

  stage='server_bounds';const settings=(await worker.query("SELECT current_setting('statement_timeout')='20s' AS statement_bound,current_setting('lock_timeout')='500ms' AS lock_bound,current_setting('transaction_isolation')='read committed' AS read_committed")).rows[0];assert.deepEqual(settings,{statement_bound:true,lock_bound:true,read_committed:true});
  console.log(JSON.stringify({ok:true,postgres_version:info.version,independent_connections:true,membership_optout_rechecked_both_brands:true,subscriber_status_rechecked_both_brands:true,leaf_membership_phantom_excluded:true,new_base_membership_phantom_excluded:true,new_subscriber_phantom_excluded:true,cohort_matches_captured_snapshot:true,locks_retained_until_commit:true,locks_released_after_commit:true,server_bounds_active:true,transport:false}));
 }finally{for(const c of clients){try{await c.query('ROLLBACK');}catch{}try{await c.end();}catch{}}}
})().catch(e=>{console.error(JSON.stringify({ok:false,error:'AUDIENCE_COHORT_POSTGRES_PROOF_FAILED',stage,code:typeof e.code==='string'?e.code:'ASSERTION'}));process.exitCode=1;});
