'use strict';
// Opt-in PostgreSQL 17.10 proof. The database must be disposable, loopback-only
// and use a non-default port. No Shopify, SMTP or other remote connection occurs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Pool}=require('pg'),{createHash}=require('node:crypto');
const {setupProducts,productEvidence}=require('./segment-shopify-products-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),API=require('../n8n/growth/segment-audience-api.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs'),Facts=require('../n8n/growth/segment-shopify-facts.cjs');
const {createTransaction}=require('../services/crm-audience/transaction.cjs');

const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:8,statement_timeout:30000,connectionTimeoutMillis:5000,application_name:'shopify-products-proof-owner'});
const db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q),transaction:async work=>{const c=await owner.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const product=(id=1,operator='purchased')=>({op:'condition',field:'purchase.product',operator,value:'gid://shopify/Product/'+id});
const sha=file=>createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',file))).digest('hex');
const rows=(start,count)=>Array.from({length:count},(_,i)=>{const id=start+i;return {id,products:[id%2?1:2]};});
async function ingestPart(e,part){const {customers,...meta}=e;return (await db.query('SELECT crm_audience_v2.shopify_ingest_product_chunk($1,$2,$3) receipt',[JSON.stringify(meta),part,JSON.stringify(customers.slice(part*5000,(part+1)*5000))])).rows[0].receipt;}
async function roleCount(api,pool,brand,r){const c=await Store.readCatalog(pool.query.bind(pool),brand),response=await api.handle({method:'POST',request:{headers:{Authorization:'Bearer synthetic-manager-key'},body:{acao:'segmento_contar',brand,definition:{schema_version:'crm-audience-v2',brand,name:'Produtos '+brand,rule:r},expected_catalog_hash:c.catalog.catalog_hash}}});assert.equal(response.status,200,JSON.stringify(response));assert.equal(Object.hasOwn(response.body,'subscribers'),false);return {catalog:c.catalog,response:response.body};}

(async()=>{let rolePool,roleTransaction;const metrics={},race={};try{
 assert.equal((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v,'170010');
 const x=await setupProducts(db);
 await db.exec(`UPDATE crm_audience_v2.shopify_source SET enabled=false,current_operation=NULL;
  TRUNCATE crm_audience_v2.shopify_customer_product,crm_audience_v2.shopify_product_chunk,crm_audience_v2.shopify_product_batch,
   crm_audience_v2.shopify_identity,crm_audience_v2.shopify_customer_fact,crm_audience_v2.shopify_chunk,crm_audience_v2.shopify_batch;
  INSERT INTO subscribers(id,status,uuid,email,created_at,updated_at)
   SELECT n,'enabled',gen_random_uuid(),'person'||n||'@example.test',clock_timestamp(),clock_timestamp() FROM generate_series(6,20000)n;
  UPDATE subscribers SET status='enabled';
  DELETE FROM subscriber_lists WHERE (list_id=17 AND subscriber_id NOT BETWEEN 1 AND 10000) OR (list_id=16 AND subscriber_id NOT BETWEEN 10001 AND 20000);
  INSERT INTO subscriber_lists(subscriber_id,list_id,status) SELECT n,17,'confirmed' FROM generate_series(1,10000)n
   ON CONFLICT(subscriber_id,list_id) DO UPDATE SET status='confirmed';
  INSERT INTO subscriber_lists(subscriber_id,list_id,status) SELECT n,16,'confirmed' FROM generate_series(10001,20000)n
   ON CONFLICT(subscriber_id,list_id) DO UPDATE SET status='confirmed';
  ANALYZE public.subscribers;`);
 assert.deepEqual((await db.query('SELECT id,email FROM subscribers WHERE id BETWEEN 1 AND 5 ORDER BY id')).rows.map(r=>r.id),[1,2,3,4,5]);

 await db.query('ALTER ROLE crm_audience_api LOGIN');const roleURL=new URL(uri);roleURL.username='crm_audience_api';
 rolePool=new Pool({connectionString:roleURL.href,max:4,statement_timeout:10000,connectionTimeoutMillis:5000,application_name:'shopify-products-proof-api'});
 roleTransaction=createTransaction({pool:rolePool});const roleStore=Store.createAudienceStore({transaction:roleTransaction,countProvider:Counter.countAudience,timeoutMs:10000}),roleAPI=API.createAudienceAPI({store:roleStore});

 const evidence={fish:productEvidence('fish',rows(1,10000),'701'),aristo:productEvidence('aristo',rows(10001,10000),'702')};
 assert.equal(evidence.fish.query_sha256,Facts.PRODUCT_QUERY_SHA256);assert.equal(evidence.aristo.query_sha256,Facts.PRODUCT_QUERY_SHA256);
 for(const brand of ['fish','aristo']){
  const e=evidence[brand],before=(await db.query('SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand=$1',[brand])).rows[0].current_operation,t0=performance.now();
  const first=await ingestPart(e,0);assert.equal(first.status,'staging');assert.equal(first.replayed,false);assert.equal((await db.query('SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand=$1',[brand])).rows[0].current_operation,before);
  assert.equal((await db.query('SELECT ready FROM crm_audience_v2.shopify_product_batch WHERE brand=$1 AND operation_id=$2',[brand,e.operation_id])).rows[0].ready,false);
  const raced=await Promise.allSettled([ingestPart(e,1),ingestPart(e,1)]),ready=raced.filter(v=>v.status==='fulfilled'&&v.value.status==='ready'&&v.value.replayed===false),replayed=raced.filter(v=>v.status==='fulfilled'&&v.value.replayed===true),locked=raced.filter(v=>v.status==='rejected'&&v.reason.code==='55P03');
  assert.equal(ready.length,1);assert.equal(replayed.length+locked.length,1);const finalReplay=await ingestPart(e,1);assert.equal(finalReplay.status,'ready');assert.equal(finalReplay.replayed,true);
  race[brand]=locked.length?'55P03_then_replay':'serialized_replay';metrics[brand]={ingest_ms:+(performance.now()-t0).toFixed(3)};
  assert.equal((await db.query('SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand=$1',[brand])).rows[0].current_operation,e.operation_id);
  const totals=(await db.query('SELECT count(*)::int customers,count(*) FILTER(WHERE history_complete)::int complete,coalesce(sum(unresolved_items),0)::int unresolved FROM crm_audience_v2.shopify_customer_product WHERE brand=$1 AND operation_id=$2',[brand,e.operation_id])).rows[0];assert.deepEqual(totals,{customers:10000,complete:10000,unresolved:0});
  await x.enableProducts(brand);const current=await Store.readCatalog(rolePool.query.bind(rolePool),brand),pin=(await db.query("SELECT crm_audience_v2.shopify_source_hash($1,'purchase.product',$2) pin",[brand,JSON.stringify(current.catalog)])).rows[0].pin;
  assert.equal(pin,Facts.sourceHash(brand,'purchase.product',current.catalog));assert.deepEqual(current.catalog.products.map(p=>p.id),['gid://shopify/Product/1','gid://shopify/Product/2']);
 }

 // The same scalar projection with changed product evidence must not replay or
 // move either current pointer.
 const conflict=structuredClone(evidence.fish);conflict.customers[0].products=[{id:'gid://shopify/Product/2',name:'Produto 2'}];
 const pointersBefore=(await db.query('SELECT brand,current_operation FROM crm_audience_v2.shopify_source ORDER BY brand')).rows;
 await assert.rejects(()=>ingestPart(conflict,0),/SHOPIFY_PRODUCT_REPLAY_CONFLICT/);assert.deepEqual((await db.query('SELECT brand,current_operation FROM crm_audience_v2.shopify_source ORDER BY brand')).rows,pointersBefore);
 assert.deepEqual((await db.query("SELECT products FROM crm_audience_v2.shopify_customer_product WHERE brand='fish' AND operation_id=$1 AND customer_gid='gid://shopify/Customer/1'",[evidence.fish.operation_id])).rows[0].products,[{id:'gid://shopify/Product/1',name:'Produto 1'}]);

 // A divergent unresolved total rolls back both the scalar and product layers.
 const invalid=productEvidence('fish',[{id:1,products:[1,null]},{id:2,products:[2]}],'703');invalid.counts.product_missing++;
 await assert.rejects(()=>ingestPart(invalid,0),/SHOPIFY_PRODUCT/);assert.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.shopify_batch WHERE operation_id='gid://shopify/BulkOperation/703'")).rows[0].n,0);assert.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.shopify_product_batch WHERE operation_id='gid://shopify/BulkOperation/703'")).rows[0].n,0);

 for(const [brand,yes,no] of [['fish',1,2],['aristo',10001,10002]]){
  const t0=performance.now(),counted=await roleCount(roleAPI,rolePool,brand,product(1));metrics[brand].count_ms=+(performance.now()-t0).toFixed(3);metrics[brand].eligible=counted.response.eligible_count;
  if(!counted.response.source_confirmed){const pin=Facts.sourceHash(brand,'purchase.product',counted.catalog),summary=(await db.query(`SELECT count(*) FILTER(WHERE matched IS TRUE)::int yes,count(*) FILTER(WHERE matched IS FALSE)::int no,count(*) FILTER(WHERE matched IS NULL)::int unknown FROM (SELECT crm_audience_v2.shopify_customer_match($1,s.id,$2,$3) matched FROM subscribers s JOIN subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$4 WHERE s.status='enabled' AND sl.status='confirmed') q`,[JSON.stringify(product(1)),brand,pin,brand==='fish'?17:16])).rows[0];console.log(JSON.stringify({stage:'count_unknown',brand,catalog_current:counted.catalog.current,field:counted.catalog.fields.find(f=>f.key==='purchase.product'),summary}));}
  assert.equal(counted.response.source_confirmed,true);assert.equal(counted.response.eligible_count,5000);assert.ok(metrics[brand].count_ms<10000);
  await x.rebind(brand,product(1));await x.f.approve();assert.equal(await x.match(brand,yes),true);assert.equal(await x.match(brand,no),false);
  await db.query('UPDATE subscriber_lists SET status=$3 WHERE subscriber_id=$1 AND list_id=$2',[yes,brand==='fish'?17:16,'unsubscribed']);assert.equal(await x.match(brand,yes),false);
  const afterOptout=await roleCount(roleAPI,rolePool,brand,product(1));assert.equal(afterOptout.response.source_confirmed,true);assert.equal(afterOptout.response.eligible_count,4999);
 }

 // A changed native UUID is unknown, and an expired product source is not a
 // negative purchase fact.
 await db.query('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=3');const fishCatalog=await Store.readCatalog(rolePool.query.bind(rolePool),'fish'),fishPin=Facts.sourceHash('fish','purchase.product',fishCatalog.catalog);
 assert.equal((await db.query('SELECT crm_audience_v2.shopify_customer_match($1,3,$2,$3) matched',[JSON.stringify(product(2,'not_purchased')),'fish',fishPin])).rows[0].matched,null);
 const unknown=await roleCount(roleAPI,rolePool,'fish',product(2,'not_purchased'));assert.equal(unknown.response.source_confirmed,false);assert.equal(unknown.response.eligible_count,null);
 await db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours' WHERE brand='aristo' AND operation_id=(SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand='aristo')");await db.query("SELECT crm_audience_v2.refresh_native_catalog('aristo')");
 const expired=await Store.readCatalog(rolePool.query.bind(rolePool),'aristo');assert.equal(expired.catalog.fields.find(f=>f.key==='purchase.product').available,false);assert.deepEqual(expired.catalog.products,[]);
 const expiredPin=Facts.sourceHash('aristo','purchase.product',expired.catalog);assert.equal((await db.query('SELECT crm_audience_v2.shopify_customer_match($1,10002,$2,$3) matched',[JSON.stringify(product(1,'not_purchased')),'aristo',expiredPin])).rows[0].matched,null);

 for(const sql of ['SELECT * FROM crm_audience_v2.shopify_product_batch','SELECT * FROM crm_audience_v2.shopify_customer_product','SELECT * FROM crm_audience_v2.shopify_product_chunk','SELECT email FROM subscribers',"SELECT crm_audience_v2.shopify_ingest_product_chunk('{}',0,'[]')",'GRANT SELECT ON crm_audience_v2.shopify_product_batch TO crm_audience_api'])await assert.rejects(rolePool.query(sql),e=>e.code==='42501');
 assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 const proof={postgres:'17.10',brands:['fish','aristo'],customers_per_brand:10000,chunks_per_brand:2,query_sha256:Facts.PRODUCT_QUERY_SHA256,source_sha256:{products_sql:sha('n8n/growth/segment-shopify-products.sql'),products_query:sha('n8n/growth/segment-shopify-customer-products-bulk.graphql'),product_evidence:sha('n8n/growth/segment-shopify-product-evidence.cjs'),counter:sha('n8n/growth/segment-audience-listmonk.cjs')},metrics,race,partial_did_not_advance:true,conflicting_products_rolled_back:true,unresolved_mismatch_rolled_back:true,product_count_native_match_parity:true,identity_drift_unknown:true,expiry_unknown:true,optout_false:true,api_pool_max:4,statement_timeout_ms:10000,api_aggregate_only:true,private_product_tables_denied:true,email_denied:true,ingest_denied:true,grant_denied:true,sends:0,remote_hosts:0};
 console.log(JSON.stringify(proof));
}finally{if(roleTransaction)await roleTransaction.drain();if(rolePool)await rolePool.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
