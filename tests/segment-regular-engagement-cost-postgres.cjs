'use strict';
// Opt-in PostgreSQL 17.10 cost/parity proof with synthetic engagement only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks'),{createHash}=require('node:crypto'),{Pool}=require('pg');
const {setupRegularPostgres}=require('./segment-listmonk-selection-regular-postgres-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8'),sha=s=>createHash('sha256').update(s).digest('hex');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const size=Number(process.env.REGULAR_SELECTION_SUBSCRIBERS_PER_BRAND||2000);
if(![2000,100000].includes(size))throw Error('COST_SIZE_NOT_ALLOWED');
const pool=new Pool({connectionString:uri,max:2,statement_timeout:10000});
const timed=async(label,fn)=>{const started=performance.now();try{return {value:await fn(),ms:+(performance.now()-started).toFixed(3)};}catch(error){error.message=`${label}: ${error.message}`;throw error;}};
const leaf=list_id=>({op:'in_list',list_id}),condition=field=>({op:'condition',field,operator:'within_last_days',value:30});
const rules={
 fish:{op:'and',rules:[leaf(22),condition('email.opened'),condition('email.clicked')]},
 aristo:{op:'or',rules:[leaf(31),condition('email.opened'),condition('email.clicked')]}
};
const catalog=brand=>({currency:null,timezone:null,shop_id:null,fields:['email.opened','email.clicked'].map(key=>({key,available:true,source_hash:Counter.engagementSourceHash(brand,key)})),products:[],origins:[]});
const catalogs={fish:catalog('fish'),aristo:catalog('aristo')};
const nativeIndexMetadata=read('../../runtime/crm-audience-sources-20260928/engagement-schema-safe.json');
const expectedEventIndexes=JSON.parse(nativeIndexMetadata)[0].data.filter(x=>['campaign_views','link_clicks'].includes(x.table)).map(x=>x.definition).sort();
const indexSQL=`ALTER TABLE campaign_views ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;
 CREATE UNIQUE INDEX campaign_views_pkey ON campaign_views(id);
 CREATE INDEX idx_views_camp_id ON campaign_views(campaign_id);
 CREATE INDEX idx_views_subscriber_id ON campaign_views(subscriber_id);
 CREATE INDEX idx_views_date ON campaign_views(created_at);
 ALTER TABLE link_clicks ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;
 ALTER TABLE link_clicks ADD COLUMN link_id integer;
 CREATE UNIQUE INDEX link_clicks_pkey ON link_clicks(id);
 CREATE INDEX idx_clicks_camp_id ON link_clicks(campaign_id);
 CREATE INDEX idx_clicks_link_id ON link_clicks(link_id);
 CREATE INDEX idx_clicks_sub_id ON link_clicks(subscriber_id);
 CREATE INDEX idx_clicks_date ON link_clicks(created_at);`;
const planSummary=raw=>{const top=raw[0],nodes=[];!function walk(x){nodes.push({node:x['Node Type'],relation:x['Relation Name']||null,index:x['Index Name']||null,rows:x['Plan Rows'],cost:x['Total Cost']});for(const child of x.Plans||[])walk(child);}(top.Plan);return {planning_ms:top['Planning Time']??null,total_cost:top.Plan['Total Cost'],nodes:nodes.slice(0,32),truncated:nodes.length>32};};
const unavailable=error=>error?.code==='55000'&&/SEGMENT_SELECTION_UNAVAILABLE/.test(error.message);

(async()=>{try{
 const version=(await pool.query("SELECT current_setting('server_version_num') n,current_database() db")).rows[0];assert.deepEqual(version,{n:'170010',db:'listmonk'});
 const fixture=await setupRegularPostgres(pool,{subscribersPerBrand:size,rulesByBrand:rules,catalogByBrand:catalogs});
 await pool.query(indexSQL);
 const actualEventIndexes=(await pool.query("SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname='public' AND tablename IN ('campaign_views','link_clicks') ORDER BY indexdef")).rows.map(x=>x.indexdef);
 assert.deepEqual(actualEventIndexes,expectedEventIndexes);
 await pool.query(`INSERT INTO campaigns(id,name,attribs,messenger,type,status) VALUES
  (110,'Synthetic Fish engagement','{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','email','regular','finished'),
  (210,'Synthetic Aristo engagement','{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','email','regular','finished')`);
 await pool.query(`INSERT INTO campaign_views(campaign_id,subscriber_id,created_at)
  SELECT 110,n,statement_timestamp()-interval '1 day' FROM generate_series(1,$1)n WHERE n%5=0
  UNION ALL SELECT 210,$1+n,statement_timestamp()-interval '2 days' FROM generate_series(1,$1)n WHERE n%6=0
  UNION ALL SELECT 210,$1+2,statement_timestamp()-interval '1 day'
  UNION ALL SELECT 210,$1+3,statement_timestamp()-interval '1 day'`,[size]);
 await pool.query(`INSERT INTO link_clicks(campaign_id,subscriber_id,created_at,link_id)
  SELECT 110,n,statement_timestamp()-interval '3 days',1 FROM generate_series(1,$1)n WHERE n%10=0
  UNION ALL SELECT 210,$1+n,statement_timestamp()-interval '4 days',1 FROM generate_series(1,$1)n WHERE n%7=0
  UNION ALL SELECT 210,$1+2,statement_timestamp()-interval '1 day',1
  UNION ALL SELECT 210,$1+3,statement_timestamp()-interval '1 day',1`,[size]);
 await pool.query('ANALYZE');

 const compiled={},compiledMetrics={};
 for(const [brand,base] of [['fish',17],['aristo',16]]){
  const current=await Store.readCatalog(pool.query.bind(pool),brand),query=Counter.compileCount({definition:fixture.definitions[brand],baseListId:base,catalog:current.catalog});
  const measured=await timed(`compileCount ${brand}`,()=>pool.query(query.text,query.values));
  assert.equal(measured.value.rows[0].source_confirmed,true);compiled[brand]=Number(measured.value.rows[0].eligible_count);compiledMetrics[brand]=measured.ms;
 }
 await fixture.reset();
 const countPlan=planSummary((await pool.query('EXPLAIN (FORMAT JSON) '+fixture.countSQL,[[],[]])).rows[0]['QUERY PLAN']);
 const counted=await timed('regular count',fixture.count);
 const native=(await pool.query('SELECT id,to_send,last_subscriber_id FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows;
 assert.deepEqual(native.map(x=>x.to_send),[compiled.fish,compiled.aristo]);
 assert.deepEqual(native.map(x=>x.last_subscriber_id),[0,0]);
 const batchPlan=planSummary((await pool.query('EXPLAIN (FORMAT JSON) '+fixture.batchSQL,[100,'regular',0,size*2,[17],1000])).rows[0]['QUERY PLAN']);
 const fishBatch=await timed('regular batch fish',()=>fixture.batch(100));
 const aristoBatch=await timed('regular batch aristo',()=>fixture.batch(200));
 assert.ok(fishBatch.value.rows.length>0&&fishBatch.value.rows.length<=1000);
 assert.ok(aristoBatch.value.rows.length>0&&aristoBatch.value.rows.length<=1000);
 assert.equal(fishBatch.value.rows.some(row=>row.id===6),false,'leaf opt-out must fail Fish AND');
 assert.equal(aristoBatch.value.rows.some(row=>row.id===size+2||row.id===size+3),false,'base opt-out and blocklist must remain excluded');

 const beforeOff=(await pool.query('SELECT id,status,to_send,max_subscriber_id,last_subscriber_id,started_at,updated_at FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows;
 await pool.query('UPDATE crm_audience_v2.selection_runtime SET enabled=false');
 await assert.rejects(fixture.count(),unavailable);await assert.rejects(fixture.batch(100,{cursor:size*3,max:size*3}),unavailable);
 assert.deepEqual((await pool.query('SELECT id,status,to_send,max_subscriber_id,last_subscriber_id,started_at,updated_at FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows,beforeOff);
 await pool.query('UPDATE crm_audience_v2.selection_runtime SET enabled=true,verified_at=clock_timestamp()');
 const sourceOff=structuredClone(catalogs.fish);sourceOff.fields.find(x=>x.key==='email.opened').available=false;
 await pool.query('UPDATE crm_audience_v2.config SET catalog=$2::jsonb WHERE brand=$1',['fish',JSON.stringify(sourceOff)]);
 await assert.rejects(fixture.count(),unavailable);await assert.rejects(fixture.batch(100,{cursor:size*3,max:size*3}),unavailable);
 await pool.query('UPDATE crm_audience_v2.config SET catalog=$2::jsonb WHERE brand=$1',['fish',JSON.stringify(catalogs.fish)]);

 const sourceHashes={};
 for(const brand of ['fish','aristo'])for(const field of ['email.opened','email.clicked']){
  const sql=(await pool.query('SELECT crm_audience_v2.selection_engagement_source_hash($1,$2) value',[brand,field])).rows[0].value;
  assert.equal(sql,Counter.engagementSourceHash(brand,field));sourceHashes[`${brand}:${field}`]=sql;
 }
 console.log(JSON.stringify({postgres:'17.10',subscribers_per_brand:size,total_subscribers:size*2,query_timeout_ms:10000,
  hashes:{regular_query_sha256:fixture.regular.patched_sha256,selection_sql_sha256:sha(read('n8n/growth/segment-listmonk-selection.sql')),readiness_sql_sha256:sha(read('n8n/growth/segment-regular-readiness.sql')),native_index_metadata_sha256:sha(nativeIndexMetadata),engagement_sources:sourceHashes},
  metrics_ms:{compile_count:compiledMetrics,regular_count:counted.ms,regular_batch:{fish:fishBatch.ms,aristo:aristoBatch.ms}},eligible:compiled,
  batch_rows:{fish:fishBatch.value.rows.length,aristo:aristoBatch.value.rows.length},plans:{count:countPlan,batch:batchPlan},
  invariants:{compile_count_parity:true,optout_and_blocklist_excluded:true,runtime_off_raises_55000:true,runtime_off_state_unchanged:true,source_off_raises_55000:true,native_equivalent_event_indexes:true},sends:0,production_changes:0}));
}finally{await pool.end();}})().catch(error=>{console.error(error);process.exitCode=1;});
