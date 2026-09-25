'use strict';
// Run only against the disposable fixture; never accepts a database URL.
// AB_UPSTREAM_SOURCE must be the unmodified SHA-pinned upstream SQL file.
const fs=require('node:fs'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const {fixture,read}=require('./ab-experiment-fixture.cjs');
const {patchSource,section}=require('../n8n/growth/ab-listmonk-cohort-patch.cjs');
async function proof(source){
 const patched=patchSource(source),x=await fixture();
 try{
  await x.db.exec(`ALTER TABLE templates ADD COLUMN is_default boolean DEFAULT true;
   ALTER TABLE campaigns ADD COLUMN to_send integer DEFAULT 0;ALTER TABLE campaigns ADD COLUMN max_subscriber_id integer DEFAULT 0;ALTER TABLE campaigns ADD COLUMN last_subscriber_id integer DEFAULT 0;
   CREATE INDEX synthetic_list_member ON subscriber_lists(list_id,subscriber_id);
   UPDATE campaigns SET status='scheduled',send_at=now()-interval '1 minute';`);
  const count=s=>section(s,'next-campaigns').text,batch=s=>section(s,'next-campaign-subscribers').text;
  await x.db.query(count(source),[[],[]]);
  const baseline=(await x.db.query('SELECT id,to_send FROM campaigns ORDER BY id')).rows;
  await x.db.exec("UPDATE campaigns SET status='draft',started_at=NULL,to_send=0,max_subscriber_id=0,last_subscriber_id=0");
  await x.prepare(await x.protocol());await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  await x.db.exec(`UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='${patched.patched_sha256}',verified_at=now();
   UPDATE crm_ab_experiment_v2 SET state='scheduled',window_start=now()-interval '1 minute',window_end=now()+interval '1 day',transport_bound=true,tracking_continuous=true;
   SELECT set_config('shrigma.ab_schedule_v2',(SELECT test_id::text FROM crm_ab_experiment_v2),false);
   UPDATE campaigns SET status='scheduled';SELECT set_config('shrigma.ab_schedule_v2','',false);`);
  await x.db.query(count(patched.source),[[],[]]);
  const actual=(await x.db.query('SELECT id,to_send,max_subscriber_id FROM campaigns ORDER BY id')).rows;
  assert.deepEqual(actual.filter(r=>r.id<200).map(r=>r.to_send),[500,500]);
  assert.deepEqual(actual.filter(r=>r.id>=200).map(({id,to_send})=>({id,to_send})),baseline.filter(r=>r.id>=200));
  const ids=[];
  for(const cid of [100,101]){
   const seen=[];let cursor=0,max=actual.find(r=>r.id===cid).max_subscriber_id;
   for(;;){const rows=(await x.db.query(batch(patched.source),[cid,'regular',cursor,max,[3,17],37])).rows;if(!rows.length)break;seen.push(...rows.map(r=>r.id));cursor=rows.at(-1).id;
    assert.equal((await x.db.query('SELECT last_subscriber_id FROM campaigns WHERE id=$1',[cid])).rows[0].last_subscriber_id,cursor);}
   assert.equal(seen.length,500);ids.push(seen);
  }
  assert.equal(new Set(ids.flat()).size,1000);
  // Subscription mutations happen only in this synthetic DB. Next native query
  // rechecks original consent, including union of source lists and global status.
  await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id IN(3,17)",[ids[0][0]]);
  await x.db.query("UPDATE subscribers SET status='blocklisted' WHERE id=$1",[ids[0][1]]);
  assert.equal((await x.db.query(batch(patched.source),[100,'regular',0,1000,[3,17],1000])).rows.length,498);
  // Unrelated campaigns have exactly the native rows, including unchanged order.
  const args=[200,'regular',0,1000,[7],1000];assert.deepEqual((await x.db.query(batch(patched.source),args)).rows,(await x.db.query(batch(source),args)).rows);
  await x.db.exec(`INSERT INTO subscribers SELECT n,'enabled' FROM generate_series(1003,100000)n;
   INSERT INTO subscriber_lists SELECT n,7,'confirmed' FROM generate_series(1003,100000)n;ANALYZE;`);
  const time=async(sql,params)=>{const t=performance.now();await x.db.query(sql,params);return performance.now()-t;};
  const baselineMs=[],patchedMs=[],perfArgs=[200,'regular',0,100000,[7],1000];
  for(let i=0;i<10;i++){const b=await time(batch(source),perfArgs),p=await time(batch(patched.source),perfArgs);if(i){baselineMs.push(b);patchedMs.push(p);}}
  const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
  const plan=(await x.db.query('EXPLAIN (ANALYZE,FORMAT JSON) '+batch(patched.source),perfArgs)).rows[0]['QUERY PLAN'][0];
  const result={source_sha256:patched.source_sha256,patched_sha256:patched.patched_sha256,queries:patched.changed_queries,
   allocated:1000,arms:[500,500],overlap:0,after_source_optout_and_blocklist:498,native_checkpoints_preserved:true,non_ab_rows_equal:true,
   synthetic_non_ab_members:99998,fixture_engine:'PGlite PostgreSQL; not production sizing',batch_size:1000,samples:9,
   original_median_ms:+median(baselineMs).toFixed(3),patched_median_ms:+median(patchedMs).toFixed(3),
   non_ab_plan_uses_init_or_hashed_subplan:/InitPlan|hashed SubPlan/.test(JSON.stringify(plan)),native_service_touched:false,real_recipients:0};
  return {result,source:patched.source};
 }finally{await x.db.close();}
}
module.exports={proof};
if(require.main===module)(async()=>{if(!process.env.AB_UPSTREAM_SOURCE)throw Error('Pinned AB_UPSTREAM_SOURCE required');const {result,source}=await proof(fs.readFileSync(process.env.AB_UPSTREAM_SOURCE,'utf8'));if(process.env.AB_PATCHED_SOURCE_OUT)fs.writeFileSync(process.env.AB_PATCHED_SOURCE_OUT,source);console.log(JSON.stringify(result,null,2));})().catch(e=>{console.error(e.message);process.exitCode=1;});
