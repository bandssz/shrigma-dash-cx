'use strict';
// Disposable PostgreSQL only: no Shopify calls, remote hosts or email delivery.
const assert=require('node:assert/strict'),{Pool}=require('pg');
const F=require('./segment-shopify-products-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),API=require('../n8n/growth/segment-audience-api.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const {createTransaction}=require('../services/crm-audience/transaction.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:4,statement_timeout:30000,connectionTimeoutMillis:5000});
const db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q),transaction:async work=>{const c=await owner.connect();try{await c.query('BEGIN');const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const leaf=(field,operator,value)=>({op:'condition',field,operator,value}),confirmed=rule=>({op:'confirmed',rule});
const definition=(brand,rule)=>({schema_version:'crm-audience-v2',brand,name:'Confirmed synthetic '+brand,rule});
const buyers=leaf('purchase.count','gt',0),never=leaf('purchase.count','eq',0);
async function ingest(e){const{customers,...meta}=e;for(let p=0;p<Math.ceil(customers.length/5000);p++)await db.query('SELECT crm_audience_v2.shopify_ingest_product_chunk($1,$2,$3)',[JSON.stringify(meta),p,JSON.stringify(customers.slice(p*5000,(p+1)*5000))]);}
(async()=>{let rolePool,transaction;const metrics={};try{
 assert.equal((await db.query('show server_version_num')).rows[0].server_version_num,'170010');
 const x=await F.setupProducts(db);
 await db.exec(`UPDATE crm_audience_v2.shopify_source SET enabled=false,current_operation=NULL;
  TRUNCATE crm_audience_v2.shopify_customer_product,crm_audience_v2.shopify_product_chunk,crm_audience_v2.shopify_product_batch,
   crm_audience_v2.shopify_identity,crm_audience_v2.shopify_customer_fact,crm_audience_v2.shopify_chunk,crm_audience_v2.shopify_batch;
  INSERT INTO subscribers(id,status,uuid,email,created_at,updated_at) SELECT n,'enabled',gen_random_uuid(),'person'||n||'@example.test',clock_timestamp(),clock_timestamp() FROM generate_series(6,100000)n;
  UPDATE subscribers SET status='enabled';DELETE FROM subscriber_lists;
  INSERT INTO subscriber_lists SELECT n,17,'confirmed' FROM generate_series(1,79807)n;
  INSERT INTO subscriber_lists SELECT n,16,'confirmed' FROM generate_series(80001,100000)n;
  ANALYZE public.subscribers;ANALYZE public.subscriber_lists;`);
 const records=(start,n)=>Array.from({length:n},(_,i)=>({id:start+i,products:i%2?[101,202]:[]}));
 await ingest(F.productEvidence('fish',records(1,51856),'711'));
 await ingest(F.productEvidence('aristo',records(80001,10000),'712'));
 for(const brand of ['fish','aristo'])await x.enableProducts(brand);
 await db.exec('ANALYZE crm_audience_v2.shopify_customer_fact;ANALYZE crm_audience_v2.shopify_identity;ANALYZE crm_audience_v2.shopify_customer_product');
 await db.query('ALTER ROLE crm_audience_api LOGIN');const roleURL=new URL(uri);roleURL.username='crm_audience_api';
 rolePool=new Pool({connectionString:roleURL.href,max:4,statement_timeout:10000,connectionTimeoutMillis:5000});
 transaction=createTransaction({pool:rolePool});const store=Store.createAudienceStore({transaction,countProvider:Counter.countAudience,timeoutMs:10000}),api=API.createAudienceAPI({store});
 async function count(brand,rule){const c=await Store.readCatalog(rolePool.query.bind(rolePool),brand),t=performance.now();const response=await api.handle({method:'POST',request:{headers:{Authorization:'Bearer synthetic-manager-key'},body:{acao:'segmento_contar',brand,definition:definition(brand,rule),expected_catalog_hash:c.catalog.catalog_hash}}});assert.equal(response.status,200,JSON.stringify(response));assert.equal(Object.hasOwn(response.body,'subscribers'),false);return {body:response.body,ms:+(performance.now()-t).toFixed(3)};}
 for(const [brand,total] of [['fish',25928],['aristo',5000]]){
  const strict=await count(brand,never);assert.equal(strict.body.source_confirmed,false);assert.equal(strict.body.eligible_count,null);
  const scopedNever=await count(brand,confirmed(never)),scopedBuyers=await count(brand,confirmed(buyers));
  assert.equal(scopedNever.body.source_confirmed,true);assert.equal(scopedNever.body.eligible_count,total);
  assert.equal(scopedBuyers.body.source_confirmed,true);assert.equal(scopedBuyers.body.eligible_count,total);
  metrics[brand]={strict_ms:strict.ms,never_ms:scopedNever.ms,buyers_ms:scopedBuyers.ms};
  await x.rebind(brand,confirmed(never));await x.f.approve();const yes=brand==='fish'?1:80001,no=yes+1,unknown=brand==='fish'?60000:95000;
  assert.equal(await x.match(brand,yes),true);assert.equal(await x.match(brand,no),false);assert.equal(await x.match(brand,unknown),false);
  await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=$2",[yes,brand==='fish'?17:16]);assert.equal(await x.match(brand,yes),false);assert.equal((await count(brand,confirmed(never))).body.eligible_count,total-1);
 }
 const nearLimit={op:'or',rules:Array.from({length:15},(_,i)=>confirmed(leaf('purchase.count','eq',i)))};
 const nearLimitCount=await count('fish',nearLimit);assert.equal(nearLimitCount.body.source_confirmed,true);assert.equal(nearLimitCount.body.eligible_count,51855);assert.ok(nearLimitCount.ms<10000);metrics.fish.near_limit_15_leaves_ms=nearLimitCount.ms;
 const concurrent=await Promise.all(Array.from({length:4},()=>count('fish',confirmed(buyers))));
 assert.ok(concurrent.every(r=>r.body.source_confirmed&&r.body.eligible_count===25928));metrics.concurrent_four_ms=concurrent.map(r=>r.ms);assert.ok(concurrent.every(r=>r.ms<10000));
 await db.query('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=3');assert.equal((await count('fish',confirmed(never))).body.eligible_count,25926);
 await db.query("UPDATE crm_audience_v2.shopify_source SET enabled=false WHERE brand='fish'");
 const catalog=(await Store.readCatalog(rolePool.query.bind(rolePool),'fish')).catalog;
 for(const rule of [confirmed(buyers),{op:'or',rules:[confirmed(buyers),{op:'in_list',list_id:17}]}]){
  const r=await Counter.countAudience({definition:definition('fish',rule),baseListId:17,catalog,query:(q,p)=>rolePool.query(q,p)});assert.equal(r.source_confirmed,false);assert.equal(r.eligible_count,null);
 }
 await db.query("UPDATE crm_audience_v2.shopify_source SET enabled=true WHERE brand='fish'");
 await db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours' WHERE brand='aristo'");
 const expired=(await Store.readCatalog(rolePool.query.bind(rolePool),'aristo')).catalog;
 assert.equal((await Counter.countAudience({definition:definition('aristo',confirmed(never)),baseListId:16,catalog:expired,query:(q,p)=>rolePool.query(q,p)})).source_confirmed,false);
 for(const sql of ['SELECT email FROM subscribers','SELECT * FROM crm_audience_v2.shopify_customer_fact','SELECT * FROM crm_audience_v2.shopify_identity',"SELECT crm_audience_v2.shopify_ingest_product_chunk('{}',0,'[]')"])await assert.rejects(rolePool.query(sql),e=>e.code==='42501');
 await assert.rejects(rolePool.query("SELECT * FROM crm_audience_v2.shopify_matches_for_rule('{}','fish','x')"),e=>e.code==='42501');
 await assert.rejects(rolePool.query('SELECT * FROM crm_audience_v2.shopify_count_for_rule($1,$2,$3,$4)',[JSON.stringify({op:'condition',field:'purchase.count);SELECT pg_sleep(1);--',operator:'eq',value:0}),'fish',17,JSON.stringify(catalog)]),/SEGMENT_COUNT_RULE/);
 await assert.rejects(rolePool.query('SELECT * FROM crm_audience_v2.shopify_count_for_rule($1,$2,$3,$4)',[JSON.stringify(buyers),'aristo',16,JSON.stringify(catalog)]),/SEGMENT_COUNT_INPUT/);
 const privileges=(await rolePool.query("SELECT has_function_privilege(current_user,'crm_audience_v2.shopify_matches_for_rule(jsonb,text,text)','EXECUTE') AS helper,has_function_privilege(current_user,'crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)','EXECUTE') AS compiler,has_function_privilege(current_user,'crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)','EXECUTE') AS aggregate")).rows[0];assert.deepEqual(privileges,{helper:false,compiler:false,aggregate:true});
 assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 console.log(JSON.stringify({postgres:'17.10',native_contacts:100000,fish_facts:51856,fish_consent_base:79807,aristo_facts:10000,metrics,strict_unknown_preserved:true,confirmed_unknown_excluded:true,selection_parity:true,optout_rechecked:true,identity_drift_excluded:true,whole_source_off_or_expired_blocks:true,aggregate_wrapper_only:true,direct_match_helper_denied:true,private_tables_denied:true,sends:0,remote_hosts:0}));
}finally{if(transaction)await transaction.drain();if(rolePool)await rolePool.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
