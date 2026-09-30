'use strict';
// Disposable, local PostgreSQL scale probe. No remote hosts, delivery, or production state.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Pool}=require('pg');
const F=require('./segment-shopify-products-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs');
const migration=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-count-performance.sql'),'utf8');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const db=new Pool({connectionString:uri,max:2,statement_timeout:300000,connectionTimeoutMillis:5000});
const leaf=(field,operator,value)=>({op:'condition',field,operator,value}),confirmed=rule=>({op:'confirmed',rule});
const operation='gid://shopify/BulkOperation/10330489225378';
const n=159900,mapped=159876,total=252809;
const provenance={query_sha256:'bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086',workflow_id:'fixture-aristo',workflow_version:'shopify-products-fixture-v2',shop:'aristo-fixture.myshopify.com',bulk:{shop_gid:'gid://shopify/Shop/2',shop_currency:'BRL',shop_timezone:'America/Sao_Paulo'}};
async function timed(rule,catalog){const start=performance.now();const row=(await db.query('SELECT * FROM crm_audience_v2.shopify_count_for_rule($1,$2,$3,$4)',[JSON.stringify(rule),'aristo',16,JSON.stringify(catalog)])).rows[0];return{ms:+(performance.now()-start).toFixed(3),source_confirmed:row.source_confirmed,eligible_count:row.eligible_count===null?null:Number(row.eligible_count)}}
(async()=>{try{
 await F.setupProducts({query:(q,p)=>db.query(q,p),exec:q=>db.query(q),transaction:async work=>{const c=await db.connect();try{await c.query('BEGIN');const v=await work(c);await c.query('COMMIT');return v}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}});
 await db.query(migration);
 await db.query(`TRUNCATE crm_audience_v2.shopify_customer_product,crm_audience_v2.shopify_product_chunk,crm_audience_v2.shopify_product_batch,crm_audience_v2.shopify_identity,crm_audience_v2.shopify_customer_fact,crm_audience_v2.shopify_chunk,crm_audience_v2.shopify_batch;
  UPDATE crm_audience_v2.shopify_source SET enabled=false,current_operation=NULL;
  TRUNCATE public.subscriber_lists,public.subscribers RESTART IDENTITY`);
 await db.query(`INSERT INTO public.subscribers(id,status,uuid,email,created_at,updated_at)
   SELECT i,'enabled',gen_random_uuid(),'person'||i||'@example.test',clock_timestamp(),clock_timestamp() FROM generate_series(1,$1) i`,[total]);
 await db.query("INSERT INTO public.subscriber_lists(subscriber_id,list_id,status) SELECT i,16,'confirmed' FROM generate_series(1,$1) i",[n]);
 await db.query(`INSERT INTO crm_audience_v2.shopify_batch(brand,operation_id,provenance,provenance_sha256,expected_customers,expected_chunks,started_at,completed_at,observed_at,status,finalized_at,mapped_customers,unresolved_customers)
  VALUES('aristo',$1,$2,$3,$4,32,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '55 minutes',clock_timestamp()-interval '54 minutes','ready',clock_timestamp()-interval '53 minutes',$5,$4::integer-$5::integer)`,[operation,JSON.stringify(provenance),'a'.repeat(64),n,mapped]);
 await db.query(`INSERT INTO crm_audience_v2.shopify_customer_fact(brand,operation_id,customer_gid,email,orders_count,amount_spent,currency,last_order_at,customer_created_at,customer_updated_at,identity_ambiguous,identity_resolvable,subscriber_id,subscriber_uuid,identity_state)
  SELECT 'aristo',$1,'gid://shopify/Customer/'||s.id,lower(btrim(s.email)),CASE WHEN s.id%2=0 THEN 0 ELSE 1 END,CASE WHEN s.id%2=0 THEN 0 ELSE 50 END,'BRL',CASE WHEN s.id%2=0 THEN NULL ELSE clock_timestamp()-interval '10 days' END,clock_timestamp()-interval '2 years',clock_timestamp()-interval '1 hour',false,s.id<=$3,CASE WHEN s.id<=$3 THEN s.id END,CASE WHEN s.id<=$3 THEN s.uuid END,CASE WHEN s.id<=$3 THEN 'resolved' ELSE 'missing_contact' END FROM public.subscribers s WHERE s.id<=$2`,[operation,n,mapped]);
 await db.query(`INSERT INTO crm_audience_v2.shopify_identity(brand,customer_gid,subscriber_id,subscriber_uuid,email,first_operation)
  SELECT brand,customer_gid,subscriber_id,subscriber_uuid,email,operation_id FROM crm_audience_v2.shopify_customer_fact WHERE brand='aristo' AND operation_id=$1 AND identity_state='resolved'`,[operation]);
 await db.query('ALTER TABLE crm_audience_v2.shopify_customer_product DISABLE TRIGGER ALL');
 await db.query(`INSERT INTO crm_audience_v2.shopify_customer_product(brand,operation_id,customer_gid,products,history_complete,unresolved_items)
  SELECT brand,operation_id,customer_gid,CASE WHEN subscriber_id%2=0 THEN '[]'::jsonb ELSE '[{"id":"gid://shopify/Product/101","name":"Produto 101"}]'::jsonb END,true,0 FROM crm_audience_v2.shopify_customer_fact WHERE brand='aristo' AND operation_id=$1`,[operation]);
 await db.query('ALTER TABLE crm_audience_v2.shopify_customer_product ENABLE TRIGGER ALL');
 await db.query(`INSERT INTO crm_audience_v2.shopify_product_batch(brand,operation_id,provenance,provenance_sha256,ready,catalog_products)
  VALUES('aristo',$1,$2,$3,true,'[{"id":"gid://shopify/Product/101","brand":"aristo","name":"Produto 101","available":true}]')`,[operation,JSON.stringify(provenance),'b'.repeat(64)]);
 await db.query("UPDATE crm_audience_v2.shopify_source SET enabled=true,current_operation=$1 WHERE brand='aristo'",[operation]);
 await db.query("ANALYZE public.subscribers;ANALYZE public.subscriber_lists;ANALYZE crm_audience_v2.shopify_customer_fact;ANALYZE crm_audience_v2.shopify_identity;ANALYZE crm_audience_v2.shopify_customer_product;ANALYZE crm_audience_v2.shopify_product_batch");
 await db.query("SELECT crm_audience_v2.refresh_native_catalog('aristo')");
 await db.query("SET statement_timeout='60s'");
 const catalog=(await Store.readCatalog(db.query.bind(db),'aristo')).catalog;
 assert.equal(catalog.current,true);assert.equal(catalog.products.length,1);
 const functionMd5=(await db.query("SELECT proname,md5(prosrc) md5,pg_get_userbyid(proowner) owner,prosecdef security_definer,provolatile volatility,proconfig,has_function_privilege('crm_audience_api',oid,'EXECUTE') api_execute FROM pg_proc WHERE oid IN(to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)'),to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')) ORDER BY proname")).rows;
 assert.deepEqual(functionMd5,[
  {proname:'shopify_count_for_rule',md5:'3f037e001887923c953521334697ba9e',owner:'postgres',security_definer:true,volatility:'s',proconfig:['search_path=pg_catalog'],api_execute:true},
  {proname:'shopify_count_rule_sql',md5:'3d8b7d13f82477ce803a27dc7db9b74e',owner:'postgres',security_definer:true,volatility:'i',proconfig:['search_path=pg_catalog'],api_execute:false}
 ]);
 const rules={strict_zero:leaf('purchase.count','eq',0),confirmed_orders:confirmed(leaf('purchase.count','gt',0)),confirmed_noorders:confirmed(leaf('purchase.count','eq',0)),confirmed_product:confirmed(leaf('purchase.product','purchased','gid://shopify/Product/101'))};
 const warm={};for(const[k,r]of Object.entries(rules))warm[k]=await timed(r,catalog);
 const measured={};for(const[k,r]of Object.entries(rules))measured[k]=await timed(r,catalog);
 assert.deepEqual({source_confirmed:measured.strict_zero.source_confirmed,eligible_count:measured.strict_zero.eligible_count},{source_confirmed:false,eligible_count:null});
 for(const k of ['confirmed_orders','confirmed_noorders','confirmed_product'])assert.deepEqual({source_confirmed:measured[k].source_confirmed,eligible_count:measured[k].eligible_count},{source_confirmed:true,eligible_count:79938},k);
 const notPurchased=confirmed(leaf('purchase.product','not_purchased','gid://shopify/Product/101'));
 assert.equal((await timed(notPurchased,catalog)).eligible_count,79938);
 await db.query("UPDATE crm_audience_v2.shopify_customer_product SET history_complete=false,unresolved_items=1 WHERE brand='aristo' AND operation_id=$1 AND customer_gid='gid://shopify/Customer/2'",[operation]);
 assert.equal((await timed(notPurchased,catalog)).eligible_count,79937);
 await db.query("UPDATE crm_audience_v2.shopify_customer_product SET history_complete=true,unresolved_items=0 WHERE brand='aristo' AND operation_id=$1 AND customer_gid='gid://shopify/Customer/2'",[operation]);
 await db.query("UPDATE public.subscribers SET email='changed@example.test' WHERE id=1");assert.equal((await timed(rules.confirmed_orders,catalog)).eligible_count,79937);
 await db.query("UPDATE public.subscribers SET email='person1@example.test' WHERE id=1");
 const uuid=(await db.query('SELECT uuid FROM public.subscribers WHERE id=2')).rows[0].uuid;
 await db.query('UPDATE public.subscribers SET uuid=gen_random_uuid() WHERE id=2');assert.equal((await timed(rules.confirmed_noorders,catalog)).eligible_count,79937);
 await db.query('UPDATE public.subscribers SET uuid=$1 WHERE id=2',[uuid]);
 await db.query("UPDATE public.subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=16");assert.equal((await timed(rules.confirmed_orders,catalog)).eligible_count,79937);
 await db.query("UPDATE public.subscriber_lists SET status='confirmed' WHERE subscriber_id=1 AND list_id=16");
 await db.query("UPDATE crm_audience_v2.shopify_source SET enabled=false WHERE brand='aristo'");const disabled=await timed(rules.confirmed_orders,catalog);assert.deepEqual({source_confirmed:disabled.source_confirmed,eligible_count:disabled.eligible_count},{source_confirmed:false,eligible_count:null});
 await db.query("UPDATE crm_audience_v2.shopify_source SET enabled=true WHERE brand='aristo'");
 const started=(await db.query("SELECT started_at FROM crm_audience_v2.shopify_batch WHERE brand='aristo' AND operation_id=$1",[operation])).rows[0].started_at;
 await db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours' WHERE brand='aristo' AND operation_id=$1",[operation]);const expired=await timed(rules.confirmed_orders,catalog);assert.deepEqual({source_confirmed:expired.source_confirmed,eligible_count:expired.eligible_count},{source_confirmed:false,eligible_count:null});
 await db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=$2 WHERE brand='aristo' AND operation_id=$1",[operation,started]);
 console.log(JSON.stringify({postgres:'17.10',function_md5:functionMd5,subscribers:total,aristo_facts:n,mapped,unresolved:n-mapped,consented:n,warm,measured,fixed_expected_counts:true,product_incomplete_excluded:true,email_drift_excluded:true,uuid_drift_excluded:true,optout_rechecked:true,source_off_blocks:true,expired_blocks:true,production_changed:false,remote_hosts:0,sends:0}));
 }finally{await db.end()}})().catch(e=>{console.error(e);process.exitCode=1});
