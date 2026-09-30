'use strict';
// Disposable PostgreSQL 17 proof: no remote hosts, Shopify calls, or delivery.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Pool}=require('pg');
const F=require('./segment-shopify-products-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const API=require('../n8n/growth/segment-audience-api.cjs');
const {createTransaction}=require('../services/crm-audience/transaction.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const db=new Pool({connectionString:uri,max:2,statement_timeout:300000,connectionTimeoutMillis:5000});
const performanceSql=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-count-performance.sql'),'utf8');
const inlineSql=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-count-inline.sql'),'utf8');
const operation='gid://shopify/BulkOperation/10330489225378',facts=159900,mapped=159876,total=252809;
const provenance={query_sha256:'bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086',workflow_id:'fixture-aristo',workflow_version:'shopify-products-fixture-v2',shop:'aristo-fixture.myshopify.com',bulk:{shop_gid:'gid://shopify/Shop/2',shop_currency:'BRL',shop_timezone:'America/Sao_Paulo'}};
const leaf=(field,operator,value)=>({op:'condition',field,operator,value}),confirmed=rule=>({op:'confirmed',rule});
const definition=rule=>({schema_version:'crm-audience-v2',brand:'aristo',name:'Inline count proof',rule});
const callSql='SELECT * FROM crm_audience_v2.shopify_count_for_rule($1,$2,$3,$4)';
const adapter={query:(q,p)=>db.query(q,p),exec:q=>db.query(q),transaction:async fn=>{const c=await db.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}};
async function hashes(){return Object.fromEntries((await db.query("SELECT proname,md5(prosrc) md5 FROM pg_proc WHERE oid IN(to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)'),to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')) ORDER BY proname")).rows.map(x=>[x.proname,x.md5]));}
async function countOwner(rule,catalog){const started=performance.now(),r=(await db.query(callSql,[JSON.stringify(rule),'aristo',16,JSON.stringify(catalog)])).rows[0];return{ms:+(performance.now()-started).toFixed(3),source_confirmed:r.source_confirmed,eligible_count:r.eligible_count===null?null:Number(r.eligible_count)}}
async function digest(){return (await db.query(`SELECT jsonb_build_object(
 'source',(SELECT md5(string_agg(md5(to_jsonb(x)::text),'|' ORDER BY brand)) FROM crm_audience_v2.shopify_source x),
 'batch',(SELECT md5(string_agg(md5(to_jsonb(x)::text),'|' ORDER BY brand,operation_id)) FROM crm_audience_v2.shopify_batch x),
 'facts',(SELECT md5(string_agg(md5(to_jsonb(x)::text),'|' ORDER BY customer_gid)) FROM crm_audience_v2.shopify_customer_fact x),
 'identities',(SELECT md5(string_agg(md5(to_jsonb(x)::text),'|' ORDER BY customer_gid)) FROM crm_audience_v2.shopify_identity x),
 'products',(SELECT md5(string_agg(md5(to_jsonb(x)::text),'|' ORDER BY customer_gid)) FROM crm_audience_v2.shopify_customer_product x),
 'lists',(SELECT md5(string_agg(md5(to_jsonb(x)::text),'|' ORDER BY subscriber_id,list_id)) FROM public.subscriber_lists x),
 'subscribers',(SELECT md5(string_agg(md5(to_jsonb(x)::text),'|' ORDER BY id)) FROM public.subscribers x)
) snapshot`)).rows[0].snapshot;}
async function expectInlineError(client,pattern){await assert.rejects(client.query(inlineSql),e=>pattern.test(e.message));}
(async()=>{let apiPool,transaction;try{
 assert.equal((await db.query('SHOW server_version_num')).rows[0].server_version_num,'170010');
 const workMem=(await db.query('SHOW work_mem')).rows[0].work_mem;
 await F.setupProducts(adapter);
 await db.query(`TRUNCATE crm_audience_v2.shopify_customer_product,crm_audience_v2.shopify_product_chunk,crm_audience_v2.shopify_product_batch,crm_audience_v2.shopify_identity,crm_audience_v2.shopify_customer_fact,crm_audience_v2.shopify_chunk,crm_audience_v2.shopify_batch;UPDATE crm_audience_v2.shopify_source SET enabled=false,current_operation=NULL;TRUNCATE public.subscriber_lists,public.subscribers RESTART IDENTITY`);
 await db.query(`INSERT INTO public.subscribers(id,status,uuid,email,created_at,updated_at) SELECT i,'enabled',gen_random_uuid(),'person'||i||'@example.test',clock_timestamp(),clock_timestamp() FROM generate_series(1,$1)i`,[total]);
 await db.query("INSERT INTO public.subscriber_lists(subscriber_id,list_id,status) SELECT i,16,'confirmed' FROM generate_series(1,$1)i",[facts]);
 await db.query(`INSERT INTO crm_audience_v2.shopify_batch(brand,operation_id,provenance,provenance_sha256,expected_customers,expected_chunks,started_at,completed_at,observed_at,status,finalized_at,mapped_customers,unresolved_customers) VALUES('aristo',$1,$2,$3,$4,32,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '55 minutes',clock_timestamp()-interval '54 minutes','ready',clock_timestamp()-interval '53 minutes',$5,$4::integer-$5::integer)`,[operation,JSON.stringify(provenance),'a'.repeat(64),facts,mapped]);
 await db.query(`INSERT INTO crm_audience_v2.shopify_customer_fact(brand,operation_id,customer_gid,email,orders_count,amount_spent,currency,last_order_at,customer_created_at,customer_updated_at,identity_ambiguous,identity_resolvable,subscriber_id,subscriber_uuid,identity_state) SELECT 'aristo',$1,'gid://shopify/Customer/'||s.id,lower(btrim(s.email)),CASE WHEN s.id%2=0 THEN 0 ELSE 1 END,CASE WHEN s.id%2=0 THEN 0 ELSE 50 END,'BRL',CASE WHEN s.id%2=0 THEN NULL ELSE clock_timestamp()-interval '10 days' END,clock_timestamp()-interval '2 years',clock_timestamp()-interval '1 hour',false,s.id<=$3,CASE WHEN s.id<=$3 THEN s.id END,CASE WHEN s.id<=$3 THEN s.uuid END,CASE WHEN s.id<=$3 THEN 'resolved' ELSE 'missing_contact' END FROM public.subscribers s WHERE s.id<=$2`,[operation,facts,mapped]);
 await db.query(`INSERT INTO crm_audience_v2.shopify_identity(brand,customer_gid,subscriber_id,subscriber_uuid,email,first_operation) SELECT brand,customer_gid,subscriber_id,subscriber_uuid,email,operation_id FROM crm_audience_v2.shopify_customer_fact WHERE brand='aristo' AND operation_id=$1 AND identity_state='resolved'`,[operation]);
 await db.query('ALTER TABLE crm_audience_v2.shopify_customer_product DISABLE TRIGGER ALL');
 await db.query(`INSERT INTO crm_audience_v2.shopify_customer_product(brand,operation_id,customer_gid,products,history_complete,unresolved_items)
  SELECT f.brand,f.operation_id,f.customer_gid,coalesce((SELECT jsonb_agg(jsonb_build_object('id','gid://shopify/Product/'||(100+j),'name',left('Produto realista '||j||' '||repeat('nome comercial ',8),80)) ORDER BY j) FROM generate_series(1,(f.subscriber_id%9)::integer)j),'[]'::jsonb),true,0
  FROM crm_audience_v2.shopify_customer_fact f WHERE f.brand='aristo' AND f.operation_id=$1`,[operation]);
 await db.query('ALTER TABLE crm_audience_v2.shopify_customer_product ENABLE TRIGGER ALL');
 const products=Array.from({length:9},(_,i)=>({id:'gid://shopify/Product/'+(101+i),brand:'aristo',name:('Produto realista '+(i+1)+' '+'nome comercial '.repeat(8)).slice(0,80),available:true}));
 await db.query(`INSERT INTO crm_audience_v2.shopify_product_batch(brand,operation_id,provenance,provenance_sha256,ready,catalog_products) VALUES('aristo',$1,$2,$3,true,$4)`,[operation,JSON.stringify(provenance),'b'.repeat(64),JSON.stringify(products)]);
 await db.query("UPDATE crm_audience_v2.shopify_source SET enabled=true,current_operation=$1 WHERE brand='aristo'",[operation]);
 await db.query("ANALYZE public.subscribers;ANALYZE public.subscriber_lists;ANALYZE crm_audience_v2.shopify_customer_fact;ANALYZE crm_audience_v2.shopify_identity;ANALYZE crm_audience_v2.shopify_customer_product;ANALYZE crm_audience_v2.shopify_product_batch;SELECT crm_audience_v2.refresh_native_catalog('aristo')");
 const catalog=(await Store.readCatalog((q,p)=>db.query(q,p),'aristo')).catalog;assert.equal(catalog.products.length,9);
 await db.query(performanceSql);assert.deepEqual(await hashes(),{shopify_count_for_rule:'3f037e001887923c953521334697ba9e',shopify_count_rule_sql:'3d8b7d13f82477ce803a27dc7db9b74e'});
 const rules={purchased_104:confirmed(leaf('purchase.product','purchased','gid://shopify/Product/104')),not_purchased_104:confirmed(leaf('purchase.product','not_purchased','gid://shopify/Product/104')),purchased_108:confirmed(leaf('purchase.product','purchased','gid://shopify/Product/108')),not_purchased_108:confirmed(leaf('purchase.product','not_purchased','gid://shopify/Product/108'))};
 const current={};for(const[k,r]of Object.entries(rules))current[k]=await countOwner(r,catalog);
 const beforeData=await digest();
 const gates=(await db.query(`SELECT
  EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled) worker,
  EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) delivery,
  EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime WHERE enabled) selection`)).rows[0];assert.deepEqual(gates,{worker:false,delivery:false,selection:false});
 const gateClient=await db.connect();try{await gateClient.query('BEGIN');await gateClient.query('UPDATE crm_audience_v2.selection_runtime SET enabled=true');await expectInlineError(gateClient,/SHOPIFY_COUNT_INLINE_REQUIRES_OFF/);await gateClient.query('ROLLBACK')}finally{gateClient.release()}
 const driftClient=await db.connect();try{await driftClient.query('BEGIN');const def=(await driftClient.query("SELECT pg_get_functiondef('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)'::regprocedure) definition")).rows[0].definition;assert.equal((def.match(/depth>4/g)||[]).length,1);await driftClient.query(def.replace('depth>4','depth>3'));await expectInlineError(driftClient,/SHOPIFY_COUNT_INLINE_BASE_DRIFT/);await driftClient.query('ROLLBACK')}finally{driftClient.release()}
 assert.deepEqual(await hashes(),{shopify_count_for_rule:'3f037e001887923c953521334697ba9e',shopify_count_rule_sql:'3d8b7d13f82477ce803a27dc7db9b74e'});
 await db.query(inlineSql);
 const afterHashes=await hashes();assert.deepEqual(afterHashes,{shopify_count_for_rule:'11b415da695e3674c808632e61c25799',shopify_count_rule_sql:'3d8b7d13f82477ce803a27dc7db9b74e'});
 assert.deepEqual(await digest(),beforeData);
 const inline={};for(const[k,r]of Object.entries(rules))inline[k]=await countOwner(r,catalog);
 for(const k of Object.keys(rules))assert.deepEqual({source_confirmed:inline[k].source_confirmed,eligible_count:inline[k].eligible_count},{source_confirmed:current[k].source_confirmed,eligible_count:current[k].eligible_count},k);
 await expectInlineError(db,/SHOPIFY_COUNT_INLINE_BASE_DRIFT/);assert.deepEqual(await hashes(),afterHashes);assert.deepEqual(await digest(),beforeData);
 const metadata=(await db.query("SELECT pg_get_userbyid(proowner) owner,prosecdef security_definer,provolatile volatility,proconfig,has_function_privilege('crm_audience_api',oid,'EXECUTE') api_execute FROM pg_proc WHERE oid='crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)'::regprocedure")).rows[0];assert.deepEqual(metadata,{owner:'postgres',security_definer:true,volatility:'s',proconfig:['search_path=pg_catalog'],api_execute:true});
 const compilerMetadata=(await db.query("SELECT has_function_privilege('crm_audience_api','crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)','EXECUTE') compiler,has_function_privilege('crm_audience_api','crm_audience_v2.shopify_matches_for_rule(jsonb,text,text)','EXECUTE') helper,has_table_privilege('crm_audience_api','crm_audience_v2.shopify_customer_product','SELECT') private_products")).rows[0];assert.deepEqual(compilerMetadata,{compiler:false,helper:false,private_products:false});
 await db.query('ALTER ROLE crm_audience_api LOGIN');const roleUrl=new URL(uri);roleUrl.username='crm_audience_api';apiPool=new Pool({connectionString:roleUrl.href,max:4,statement_timeout:30000,connectionTimeoutMillis:5000});
 transaction=createTransaction({pool:apiPool,statementTimeoutMs:30000});const store=Store.createAudienceStore({transaction,countProvider:Counter.countAudience,timeoutMs:30000}),api=API.createAudienceAPI({store});
 async function apiCount(rule){const started=performance.now(),response=await api.handle({method:'POST',request:{headers:{Authorization:'Bearer synthetic-manager-key'},body:{acao:'segmento_contar',brand:'aristo',definition:definition(rule),expected_catalog_hash:catalog.catalog_hash}}});assert.equal(response.status,200,JSON.stringify(response));assert.equal(Object.hasOwn(response.body,'subscribers'),false);return{ms:+(performance.now()-started).toFixed(3),source_confirmed:response.body.source_confirmed,eligible_count:response.body.eligible_count}}
 for(const sql of ['SELECT * FROM crm_audience_v2.shopify_customer_product',"SELECT * FROM crm_audience_v2.shopify_matches_for_rule('{}','aristo','x')"])await assert.rejects(apiPool.query(sql),e=>e.code==='42501');
 const roleWorkMem=(await apiPool.query('SHOW work_mem')).rows[0].work_mem,rssBefore=process.memoryUsage().rss;
 await db.query('SELECT pg_stat_reset()');
 const concurrentRows=await Promise.all(Object.values(rules).map(apiCount));
 await db.query('SELECT pg_stat_force_next_flush()');
 const temp=(await db.query("SELECT temp_files::text,temp_bytes::text FROM pg_stat_database WHERE datname=current_database()")).rows[0];
 const concurrent=Object.fromEntries(Object.keys(rules).map((k,i)=>[k,concurrentRows[i]]));
 for(const k of Object.keys(rules))assert.deepEqual({source_confirmed:concurrent[k].source_confirmed,eligible_count:concurrent[k].eligible_count},{source_confirmed:inline[k].source_confirmed,eligible_count:inline[k].eligible_count},k);
 assert.equal((await apiPool.query('SHOW work_mem')).rows[0].work_mem,roleWorkMem);assert.equal((await db.query('SHOW work_mem')).rows[0].work_mem,workMem);
 assert.ok(Number(temp.temp_files)>0&&Number(temp.temp_bytes)>0);assert.ok(Number(temp.temp_bytes)<2*1024*1024*1024);
 const sizes=(await db.query("SELECT pg_total_relation_size('crm_audience_v2.shopify_customer_product')::text product_bytes,avg(octet_length(products::text))::numeric(12,1)::text avg_product_json_bytes,max(jsonb_array_length(products)) max_products FROM crm_audience_v2.shopify_customer_product WHERE brand='aristo'")).rows[0];
 console.log(JSON.stringify({success:true,postgres:'17.10',work_mem:workMem,api_work_mem:roleWorkMem,subscribers:total,facts,mapped,unknown:facts-mapped,product_array_min:0,product_array_max:8,product_name_chars:80,sizes,before_md5:{aggregate:'3f037e001887923c953521334697ba9e',compiler:'3d8b7d13f82477ce803a27dc7db9b74e'},after_md5:afterHashes,current,inline,concurrent_four:concurrent,temp_files:Number(temp.temp_files),temp_bytes:Number(temp.temp_bytes),node_rss_before:rssBefore,node_rss_after:process.memoryUsage().rss,data_neutral:true,gate_off_three:true,selection_gate_rejected:true,compiler_drift_rejected:true,replay_rejected:true,metadata_acl_preserved:true,semantic_parity:true,production_changed:false,remote_hosts:0,sends:0}));
}finally{if(transaction)await transaction.drain();if(apiPool)await apiPool.end();await db.end()}})().catch(e=>{console.error(e);process.exitCode=1});
