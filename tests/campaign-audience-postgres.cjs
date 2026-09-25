'use strict';
// Synthetic SQL only. No network, people, mail transport or production objects.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
async function run(db){
 for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await db.exec(read(f));
 await db.exec("INSERT INTO crm_familia_campanha VALUES('fish','week','week');INSERT INTO subscribers SELECT i,CASE i WHEN 6 THEN 'blocklisted' WHEN 7 THEN 'disabled' ELSE 'enabled' END FROM generate_series(3,13)i;UPDATE lists SET optin='double' WHERE id=17;INSERT INTO subscriber_lists VALUES(1,17,'confirmed'),(3,3,'unconfirmed'),(4,17,'unconfirmed'),(5,3,'unsubscribed'),(5,17,'confirmed'),(6,3,'confirmed'),(7,3,'confirmed'),(8,17,'confirmed'),(9,3,'unsubscribed'),(10,3,'unsubscribed'),(10,17,'unconfirmed');");
 await db.exec("BEGIN;SELECT set_config('shrigma.campaign_writer','100',true);INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(100,17,'Fish double');COMMIT;");
 const query=async(sql,p=[])=>(await db.query(sql,p)).rows[0];
 const current=async()=> (await query('SELECT shrigma_campaign_current(100) AS c')).c;
 const review=async()=> (await query('SELECT fixture_audience_review(100) AS v')).v;
 const count=async()=> (await query('SELECT shrigma_campaign_audience(100) AS a')).a;
 let seq=0;
 const claim=async()=> (await query("SELECT shrigma_campaign_store('claim',$1::jsonb) AS o",[JSON.stringify({actor:'audience-test',key:'audience-schedule-'+(++seq).toString().padStart(8,'0'),hash:'b'.repeat(64),brand:'fish',action:'agendar'})])).o;
 const schedule=async(v,extra={})=>{const c=await current(),op=await claim();return (await query("SELECT shrigma_campaign_provider('schedule',$1::jsonb) AS c",[JSON.stringify({id:100,expectedVersion:c.version,operationId:op.id,audienceReviewId:v?.audience?.review_id,...extra})])).c;};
 const a=await count();assert.equal(a.unique_members_count,9);assert.equal(a.eligible_count,5);assert.equal(a.excluded_blocklisted_count,1);assert.equal(a.excluded_subscription_count,3);assert.equal(a.native_disabled_count,1);assert.match(a._fingerprint,/^[a-f0-9]{64}$/);
 let v=await review();assert.equal(v.audience.eligible_count,5);assert.equal(v.audience.frozen,false);assert.equal(Date.parse(v.audience.expires_at)-Date.parse(v.audience.checked_at),300000);
 assert.ok(!JSON.stringify(v).includes('_fingerprint'));assert.ok(!JSON.stringify(v).includes('subscriber_id'));
 await assert.rejects(schedule(v),/AUDIENCE_DISABLED/);
 await db.exec("UPDATE subscribers SET status='blocklisted' WHERE id=7");v=await review();assert.equal(v.audience.eligible_count,4);
 await assert.rejects(schedule(v,{audienceReviewId:undefined}),/AUDIENCE_REVIEW_REQUIRED/);
 await assert.rejects(schedule(v,{audienceReviewId:'wrong'}),/AUDIENCE_REVIEW_REQUIRED/);
 await assert.rejects(query("SELECT shrigma_campaign_store('validation_set',$1::jsonb)",[JSON.stringify({providerId:100,validation:v})]),/CAMPAIGN_STORE_VALIDATION/);
 // Same eligible count, different members: count-only checks would miss this.
 await db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=8;INSERT INTO subscriber_lists VALUES(11,17,'confirmed')");
 assert.equal((await count()).eligible_count,4);await assert.rejects(schedule(v),/AUDIENCE_CHANGED/);
 v=await review();await db.exec("UPDATE shrigma_campaign_validation SET validation=jsonb_set(jsonb_set(validation,'{audience,checked_at}',to_jsonb(to_char((clock_timestamp()-interval '6 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))),'{audience,expires_at}',to_jsonb(to_char((clock_timestamp()-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE provider_id=100");
 await assert.rejects(schedule(v),/AUDIENCE_STALE/);
 v=await review();await db.exec("UPDATE shrigma_campaign_validation SET validation=jsonb_set(validation,'{audience,checked_at}','\"2026-09-24T12:00:00\"') WHERE provider_id=100");await assert.rejects(schedule(v),/AUDIENCE_REVIEW_REQUIRED/);
 v=await review();const c=await current();await db.query("SELECT shrigma_campaign_store('validation_set',$1::jsonb)",[JSON.stringify({providerId:100,validation:{policy:'crm-campaign-v1',version:c.version,ok:true,validated_at:new Date().toISOString()}})]);await assert.rejects(schedule(v),/AUDIENCE_REVIEW_REQUIRED/);
 v=await review();await db.exec("UPDATE subscribers SET status='blocklisted' WHERE id IN (1,3,5,11)");await assert.rejects(schedule(v),/AUDIENCE_EMPTY/);
 // A fresh valid review is transactionally reflected in the schedule receipt.
 await db.exec("UPDATE subscribers SET status='enabled' WHERE id=1");v=await review();const scheduled=await schedule(v);assert.equal(scheduled.status,'scheduled');assert.equal(scheduled.audience.eligible_count,1);assert.ok(scheduled.audience.rechecked_at);
 const receipt=(await query("SELECT response FROM shrigma_campaign_operation WHERE actor='audience-test' AND state='succeeded'")).response;
 const {audience,...campaign}=scheduled;assert.deepEqual(receipt.body.campaign,campaign);assert.deepEqual(receipt.body.audience,audience);
 assert.equal((await query('SELECT count(*)::int n FROM subscribers')).n,13);
 // Cross the 1,024-member hash chunk boundary without exporting membership.
 await db.exec("INSERT INTO subscribers SELECT i,'enabled' FROM generate_series(1000,3050)i;INSERT INTO subscriber_lists SELECT i,3,'confirmed' FROM generate_series(1000,3049)i");
 const large=await count();assert.equal(large.eligible_count,2051);assert.equal((await count())._fingerprint,large._fingerprint);
 await db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=3049;INSERT INTO subscriber_lists VALUES(3050,3,'confirmed')");
 const swapped=await count();assert.equal(swapped.eligible_count,large.eligible_count);assert.notEqual(swapped._fingerprint,large._fingerprint);
 console.log('PASS audience SQL: union/opt-in/blocklist/disabled, no PII, composition swap, TTL/timezone, forged+legacy validation, zero and atomic receipt.');
}
module.exports={run};
if(require.main===module)(async()=>{const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();try{await run(db);}finally{await db.close();}})().catch(e=>{console.error(e.message,e.where||'');process.exitCode=1;});
