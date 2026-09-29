'use strict';
// Actual one-recipient worker SQL against synthetic, disposable PostgreSQL.
// This test performs no SMTP and grants no production authority.
const assert=require('node:assert/strict'),{performance}=require('node:perf_hooks'),{Pool}=require('pg');
const {setupRegularDelivery}=require('./segment-regular-delivery-fixture.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const Selection=require('../n8n/growth/segment-listmonk-selection.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const size=Number(process.env.REGULAR_SELECTION_SUBSCRIBERS_PER_BRAND||2000),mode=process.env.REGULAR_DELIVERY_COST_MODE||'lists';
if(![2000,100000].includes(size)||!['lists','engagement'].includes(mode))throw Error('COST_CASE_NOT_ALLOWED');
const pool=new Pool({connectionString:uri,max:2,statement_timeout:10000});
const timed=async fn=>{const start=performance.now(),value=await fn();return {value,ms:+(performance.now()-start).toFixed(3)};};
const options={subscribersPerBrand:size};
if(mode==='engagement'){
 options.rulesByBrand={};options.catalogByBrand={};
 for(const brand of ['fish','aristo']){
  options.rulesByBrand[brand]={op:'and',rules:[{op:'in_list',list_id:brand==='fish'?22:31},{op:'condition',field:'email.opened',operator:'within_last_days',value:30}]};
  options.catalogByBrand[brand]={currency:null,timezone:null,shop_id:null,fields:[{key:'email.opened',available:true,source_hash:Counter.engagementSourceHash(brand,'email.opened')}],products:[],origins:[]};
 }
}
(async()=>{try{
 assert.equal((await pool.query("SELECT current_setting('server_version_num') AS v")).rows[0].v,'170010');
 const f=await setupRegularDelivery(pool,options);
 if(mode==='engagement'){
  await pool.query(`CREATE INDEX idx_views_subscriber_id ON campaign_views(subscriber_id);
   CREATE INDEX idx_views_camp_id ON campaign_views(campaign_id);
   CREATE INDEX idx_views_date ON campaign_views(created_at);
   INSERT INTO campaigns(id,name,attribs,messenger,type,status) VALUES
    (110,'Synthetic Fish engagement','{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','email','regular','finished'),
    (210,'Synthetic Aristo engagement','{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','email','regular','finished');`);
  await pool.query(`INSERT INTO campaign_views(campaign_id,subscriber_id,created_at)
   SELECT 110,n,clock_timestamp()-interval '1 day' FROM generate_series(1,$1)n WHERE n%5=0
   UNION ALL SELECT 210,$1+n,clock_timestamp()-interval '1 day' FROM generate_series(1,$1)n WHERE n%7=0`,[size]);
 }
 await pool.query('ANALYZE');
 // Engagement is populated after the reusable structural fixture. Recalculate
 // native count/max before measuring, preserving all material and binding pins.
 await pool.query("UPDATE campaigns SET status='scheduled',started_at=NULL WHERE id IN(100,200)");
 await pool.query(Selection.section(f.worker.source,'next-campaigns').text,[[],[]]);
 await f.enable();
 const metrics={};
 for(const [brand,cid] of [['fish',100],['aristo',200]]){
  metrics[brand]=[];
  // Probe beginning and a sparse late cursor without sending to real contacts.
  for(const position of ['beginning','late']){
   if(position==='late'){
    const cursor=(brand==='fish'?0:size)+Math.floor(size*.9);
    await pool.query('UPDATE campaigns SET last_subscriber_id=$2 WHERE id=$1',[cid,cursor]);
    await pool.query('UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_subscriber_id=$2 WHERE campaign_id=$1',[cid,cursor]);
   }
   for(let i=0;i<3;i++){
    const before=await f.state(cid);
    const batch=await timed(()=>f.batch(cid,{cursor:before.last_subscriber_id,limit:1}));
    assert.equal(batch.value.length,1);const sub=batch.value[0];
    assert.deepEqual(await f.state(cid),before,'reading the next batch does not acknowledge delivery');
    const claim=await timed(()=>f.claim(cid,sub.id,{snapshot:sub.crm_delivery_snapshot}));
    assert.equal(claim.value.should_send,true);
    assert.deepEqual(await f.state(cid),before,'claim does not acknowledge delivery');
    const finish=await timed(()=>f.finish(cid,sub.id,claim.value));
    assert.deepEqual(await f.state(cid),{sent:before.sent+1,last_subscriber_id:sub.id});
    metrics[brand].push({position,subscriber_id:sub.id,batch_ms:batch.ms,claim_ms:claim.ms,finish_ms:finish.ms,total_ms:+(batch.ms+claim.ms+finish.ms).toFixed(3)});
   }
  }
 }
 assert.equal((await pool.query("SELECT count(*)::integer AS n FROM shrigma_email_dispatch WHERE transport_state='accepted'")).rows[0].n,12);
 console.log(JSON.stringify({postgres:'17.10',mode,subscribers_per_brand:size,query_timeout_ms:10000,worker_query_sha256:f.worker.patched_sha256,metrics_ms:metrics,sends:0,production_changes:0,authority_proven:false}));
}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
