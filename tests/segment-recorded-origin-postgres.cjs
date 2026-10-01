'use strict';
process.env.CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS='v2';
// Disposable PG17 only: true logins/connections, bounded contention and recovery.
const assert=require('node:assert/strict'),{Client,Pool}=require('pg'),{randomUUID}=require('node:crypto');
const {setupRecordedNativeV2,rule}=require('./segment-recorded-origin-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const url=new URL(process.env.TEST_DATABASE_URL||'http://invalid');
if(process.env.RECORDED_ORIGIN_TEST_ISOLATED!=='1'||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432'||url.pathname!=='/listmonk')throw Error('ISOLATED_DATABASE_REQUIRED');
async function main(){
 const admin=new Client({connectionString:url.href});await admin.connect();let api,producer,lock;
 const db={query:(sql,values)=>admin.query(sql,values),exec:sql=>admin.query(sql),transaction:async work=>{await admin.query('BEGIN');try{const out=await work({query:(sql,values)=>admin.query(sql,values)});await admin.query('COMMIT');return out;}catch(e){await admin.query('ROLLBACK');throw e;}}};
 try{
  assert.match((await admin.query('SHOW server_version')).rows[0].server_version,/^17[.]/);
  const x=await setupRecordedNativeV2(db);assert.equal(x.tier,'native-postgres17-v2-guarded-install');assert.equal(x.count_body_before_recorded,'4adcbdd47bcb8d731c2d35bd60ea0ff9');
  const attested=(await db.query("SELECT brand,crm_audience_v2.shopify_product_history_attested(brand) ok FROM crm_audience_v2.shopify_source ORDER BY brand")).rows;assert.deepEqual(attested,[{brand:'aristo',ok:true},{brand:'fish',ok:true}]);
  await db.exec("ALTER ROLE crm_audience_api LOGIN;CREATE ROLE recorded_origin_producer LOGIN NOINHERIT;GRANT USAGE ON SCHEMA crm_audience_v2 TO recorded_origin_producer;GRANT EXECUTE ON FUNCTION crm_audience_v2.recorded_origin_subscribe_v2(text,text,boolean,text,uuid,text),crm_audience_v2.recorded_origin_operation_v2(text,uuid) TO recorded_origin_producer;");
  const connect=role=>{const u=new URL(url);u.username=role;return u.href;};
  api=new Pool({connectionString:connect('crm_audience_api'),max:4,options:'-c statement_timeout=10000 -c lock_timeout=500'});
  producer=new Pool({connectionString:connect('recorded_origin_producer'),max:4,options:'-c statement_timeout=10000 -c lock_timeout=500'});
  const event=randomUUID(),args=['person1@example.test','synthetic-form',false,'alma',event,'a'.repeat(64)];
  const sql='SELECT * FROM crm_audience_v2.recorded_origin_subscribe_v2($1,$2,$3,$4,$5,$6)';
  const races=await Promise.all([producer.query(sql,args),producer.query(sql,args)]);assert.equal(races.filter(r=>r.rows[0].eligible).length,1);assert.equal(races.filter(r=>r.rows[0].reason==='replayed').length,1);assert.equal(races[0].rows[0].receipt_hash,races[1].rows[0].receipt_hash);
  await db.exec("INSERT INTO subscribers(id,uuid,email,name,status,attribs) VALUES(6,gen_random_uuid(),'person6@example.test','Synthetic','enabled','{}');INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(6,16,'confirmed')");
  const count=async r=>{const c=await Store.readCatalog((sql,values)=>api.query(sql,values),'aristo');return Counter.countAudience({definition:{schema_version:'crm-audience-v2',brand:'aristo',name:'Recorded native v2',rule:r},catalog:c.catalog,baseListId:16,query:(sql,values)=>api.query(sql,values)});};
  const purchase=(operator,value)=>({op:'condition',field:'purchase.count',operator,value}),confirmed=r=>({op:'confirmed',rule:r});
  const pure=await count(rule()),mixedOr=await count({op:'or',rules:[rule(),confirmed(purchase('gt',0))]}),mixedAnd=await count({op:'and',rules:[rule(),confirmed(purchase('gt',0))]}),knownNever=await count(confirmed(purchase('eq',0))),strictNever=await count(purchase('eq',0));
  assert.deepEqual([pure.source_confirmed,pure.eligible_count],[true,1]);assert.deepEqual([mixedOr.source_confirmed,mixedOr.eligible_count],[true,1]);assert.deepEqual([mixedAnd.source_confirmed,mixedAnd.eligible_count],[true,1]);assert.deepEqual([knownNever.source_confirmed,knownNever.eligible_count],[true,1]);assert.deepEqual([strictNever.source_confirmed,strictNever.eligible_count],[false,null]);
  // Lost COMMIT acknowledgement is reconciled with SELECT only, no new POST.
  const uncertain=randomUUID(),conn=await producer.connect();try{await conn.query('BEGIN');await conn.query(sql,['person2@example.test','synthetic-form',false,'desodorante',uncertain,'a'.repeat(64)]);await conn.query('COMMIT');}finally{conn.release();}
  const recovered=(await producer.query('SELECT * FROM crm_audience_v2.recorded_origin_operation_v2($1,$2)',['ywJDsgBDhZOBgoxb',uncertain])).rows[0];assert.equal(recovered.found,true);assert.equal(recovered.eligible,undefined);assert.equal(recovered.subscriber_uuid,undefined);
  await assert.rejects(api.query('SELECT * FROM crm_audience_v2.recorded_origin_receipt'),e=>e.code==='42501');await assert.rejects(api.query('SELECT * FROM crm_audience_v2.shopify_product_history_attestation'),e=>e.code==='42501');await assert.rejects(api.query('SELECT * FROM crm_audience_v2.shopify_customer_fact'),e=>e.code==='42501');await assert.rejects(api.query(sql,args),e=>e.code==='42501');await assert.rejects(producer.query('SELECT * FROM subscribers'),e=>e.code==='42501');
  // Native opt-out wins while the producer waits; failed form leaves no receipt.
  lock=new Client({connectionString:url.href});await lock.connect();await lock.query('BEGIN');await lock.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=2 AND list_id=16");
  const busy=(await producer.query(sql,['person2@example.test','synthetic-form',false,'alma',randomUUID(),'a'.repeat(64)])).rows[0];assert.equal(busy.eligible,false);assert.equal(busy.reason,'consent_busy');await lock.query('COMMIT');
  const rejected=(await producer.query(sql,['person2@example.test','synthetic-form',false,'alma',randomUUID(),'a'.repeat(64)])).rows[0];assert.equal(rejected.reason,'list_unsubscribed');
  await db.exec("INSERT INTO subscribers(id,uuid,email,name,status,attribs) SELECT 100000+n,gen_random_uuid(),'scale'||n||'@example.invalid','Synthetic','enabled','{}'::jsonb FROM generate_series(1,10000)n;INSERT INTO subscriber_lists(subscriber_id,list_id,status) SELECT 100000+n,16,'confirmed' FROM generate_series(1,10000)n");
  const consent=(await db.query('SELECT status FROM subscriber_lists WHERE subscriber_id=2 AND list_id=16')).rows[0];assert.deepEqual(consent,{status:'unsubscribed'});
  const scaleStart=performance.now(),scale=await x.count();const scaleMs=Math.round(performance.now()-scaleStart);assert.equal(scale.source_confirmed,true);assert.equal(scale.eligible_count,1);assert.ok(scaleMs<10000,'Count exceeded service budget');const scaleStrict=await count(purchase('eq',0)),scaleConfirmed=await count(confirmed(purchase('eq',0)));assert.deepEqual([scaleStrict.source_confirmed,scaleStrict.eligible_count],[false,null]);assert.deepEqual([scaleConfirmed.source_confirmed,scaleConfirmed.eligible_count],[true,0]);
  await x.rebind('aristo',rule());await x.f.approve();assert.equal(await x.match('aristo',1),true);assert.equal(await x.match('aristo',2),false);
  await db.exec("UPDATE crm_audience_v2.recorded_origin_source SET enabled=false WHERE canonical_origin='vip_alma'");await assert.rejects(x.match('aristo',1),/SEGMENT_SELECTION_UNAVAILABLE/);
  assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.recorded_origin_receipt')).rows[0].n,2);assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
  console.log(JSON.stringify({postgres:'17.10',tier:x.tier,product_semantics:'v2',count_body_before_recorded:x.count_body_before_recorded,both_brands_attested:true,real_logins:['crm_audience_api','recorded_origin_producer'],pool_max:4,single_winner:true,get_only_commit_recovery:true,optout_contention:true,pure_recorded:true,mixed_confirmed_and_or:true,strict_unknown_not_never:true,confirmed_never_before_optout:true,confirmed_never_after_optout_excluded:true,count_binding_selection:true,source_off_blocks:true,private_acl:true,receipts:2,scale_customers:10000,scale_count_ms:scaleMs,sends:0,production_changed:false}));
 }finally{if(lock)await lock.end();if(api)await api.end();if(producer)await producer.end();await admin.end();}
}
main().catch(e=>{console.error({code:e.code,message:e.message,stack:e.stack});process.exitCode=1;});
