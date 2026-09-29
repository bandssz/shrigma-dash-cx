'use strict';
// Opt-in disposable PostgreSQL 17.10 cost proof. It accepts loopback /listmonk only.
const assert=require('node:assert/strict'),{performance}=require('node:perf_hooks'),{Pool}=require('pg');
const {setupRegularPostgres}=require('./segment-listmonk-selection-regular-postgres-fixture.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const size=Number(process.env.REGULAR_SELECTION_SUBSCRIBERS_PER_BRAND||2000);
if(![2000,100000].includes(size))throw Error('COST_SIZE_NOT_ALLOWED');
const pool=new Pool({connectionString:uri,max:2,statement_timeout:10000});
const ms=async fn=>{const t=performance.now(),value=await fn();return {value,ms:+(performance.now()-t).toFixed(3)}};
const planSummary=raw=>{const p=raw[0].Plan,nodes=[];!function walk(x){nodes.push({node:x['Node Type'],relation:x['Relation Name']||null,join:x['Join Type']||null,rows:x['Plan Rows'],cost:x['Total Cost']});for(const y of x.Plans||[])walk(y);}(p);return {planning_ms:raw[0]['Planning Time']??null,total_cost:p['Total Cost'],nodes:nodes.slice(0,40),truncated:nodes.length>40};};
(async()=>{try{
 const version=(await pool.query("SELECT current_setting('server_version_num') AS n,current_database() AS db")).rows[0];assert.deepEqual(version,{n:'170010',db:'listmonk'});
 const f=await setupRegularPostgres(pool,{subscribersPerBrand:size});
 const absent=(await pool.query("SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE 'crm_ab_%'")).rows[0].n;assert.equal(absent,0);
 await f.reset();const countPlan=planSummary((await pool.query('EXPLAIN (FORMAT JSON) '+f.countSQL,[[],[]])).rows[0]['QUERY PLAN']);
 const counted=await ms(f.count);const state=(await pool.query('SELECT id,to_send,max_subscriber_id,last_subscriber_id FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows;
 assert.equal(state[0].to_send,f.expected.fish);assert.equal(state[1].to_send,f.expected.aristo);
 assert.equal(state[0].last_subscriber_id,0);assert.equal(state[1].last_subscriber_id,0);
 const batchPlan=planSummary((await pool.query('EXPLAIN (FORMAT JSON) '+f.batchSQL,[100,'regular',0,size*2,[17],1000])).rows[0]['QUERY PLAN']);
 const fishBatch=await ms(()=>f.batch(100));const aristoBatch=await ms(()=>f.batch(200));
 assert.ok(fishBatch.value.rows.length>0&&fishBatch.value.rows.length<=1000);assert.ok(aristoBatch.value.rows.length>0&&aristoBatch.value.rows.length<=1000);
 assert.equal(fishBatch.value.rows.some(r=>r.id===6),false,'double-optout excluded from Fish AND');
 assert.equal(aristoBatch.value.rows.some(r=>r.id===size+2||r.id===size+3),false,'base optout and blocklist excluded from Aristo OR');
 // Reproduce the two-statement manager-store race with two retained connections:
 // metadata says running, then another connection pauses/cancels before batch SQL.
 const metadataSQL=`SELECT campaigns.id AS campaign_id,campaigns.type AS campaign_type,last_subscriber_id,max_subscriber_id,lists.id AS list_id
  FROM campaigns JOIN campaign_lists ON campaign_lists.campaign_id=campaigns.id JOIN lists ON lists.id=campaign_lists.list_id
  WHERE campaigns.id=$1 AND campaigns.status='running'`;
 const first=await pool.connect(),second=await pool.connect();
 try{
  for(const stoppedStatus of ['paused','cancelled']){
   await second.query("UPDATE campaigns SET status='running',last_subscriber_id=0 WHERE id=100");
   const metadata=(await first.query(metadataSQL,[100])).rows;assert.equal(metadata.length,1);assert.equal(metadata[0].last_subscriber_id,0);
   await second.query('UPDATE campaigns SET status=$2 WHERE id=$1',[100,stoppedStatus]);
   const rows=(await first.query(f.batchSQL,[metadata[0].campaign_id,metadata[0].campaign_type,metadata[0].last_subscriber_id,metadata[0].max_subscriber_id,metadata.map(x=>x.list_id),1000])).rows;
   assert.deepEqual(rows,[],stoppedStatus+' campaign must not yield a stale batch');
   const after=(await first.query('SELECT status,last_subscriber_id FROM campaigns WHERE id=100')).rows[0];assert.deepEqual(after,{status:stoppedStatus,last_subscriber_id:0});
  }
 }finally{first.release();second.release();}
 await pool.query("UPDATE campaigns SET status='running' WHERE id=100");
 // OFF is unavailable, never an empty audience, and both statements roll back their state changes.
 const beforeOff=(await pool.query('SELECT id,status,sent,to_send,max_subscriber_id,last_subscriber_id,started_at,updated_at FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows;
 await pool.query('UPDATE crm_audience_v2.selection_runtime SET enabled=false');
 await assert.rejects(f.count(),e=>e.code==='55000'&&/SEGMENT_SELECTION_UNAVAILABLE/.test(e.message));
 await assert.rejects(f.batch(100),e=>e.code==='55000'&&/SEGMENT_SELECTION_UNAVAILABLE/.test(e.message));
 assert.deepEqual((await pool.query('SELECT id,status,sent,to_send,max_subscriber_id,last_subscriber_id,started_at,updated_at FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows,beforeOff);
 await pool.query('UPDATE crm_audience_v2.selection_runtime SET enabled=true,verified_at=clock_timestamp()');
 // A legitimate empty bound audience writes explicit zero and leaves its cursor unchanged.
 await pool.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=22");await f.reset();
 const cursorBefore=(await pool.query('SELECT last_subscriber_id FROM campaigns WHERE id=100')).rows[0].last_subscriber_id;await f.count();
 const zero=(await pool.query('SELECT to_send,max_subscriber_id,last_subscriber_id FROM campaigns WHERE id=100')).rows[0];assert.deepEqual(zero,{to_send:0,max_subscriber_id:0,last_subscriber_id:cursorBefore});
 assert.equal((await f.batch(100)).rows.length,0);assert.equal((await pool.query('SELECT last_subscriber_id FROM campaigns WHERE id=100')).rows[0].last_subscriber_id,cursorBefore);
 console.log(JSON.stringify({postgres:'17.10',subscribers_per_brand:size,total_subscribers:size*2,query_timeout_ms:10000,regular_sha256:f.regular.patched_sha256,
  count_ms:counted.ms,batch_ms:{fish:fishBatch.ms,aristo:aristoBatch.ms},eligible:f.expected,batch_rows:{fish:fishBatch.value.rows.length,aristo:aristoBatch.value.rows.length},
  plans:{count:countPlan,batch:batchPlan},invariants:{no_ab_schema:true,off_raises_55000:true,off_state_unchanged:true,bound_empty_zero:true,cursor_unchanged_on_empty:true,optout_and_blocklist_excluded:true,
   two_connection_pause_cancel_zero_rows:true,two_connection_pause_cancel_cursor_unchanged:true},sends:0,remote_hosts:0}));
}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
