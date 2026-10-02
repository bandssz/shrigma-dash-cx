'use strict';
process.env.CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS='v2';
// PostgreSQL 17.10 only. This installs the guarded Recorded v2 stack and the
// candidate RFM extension in one disposable database; no producer or UI is enabled.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {setupRecordedNativeV2}=require('./segment-recorded-origin-fixture.cjs');
const {installNative}=require('./segment-shopify-rfm-install-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const RFM=require('../n8n/growth/segment-shopify-rfm.cjs');

const ROOT=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.RFM_NATIVE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||!u.port||u.port==='5432'||u.pathname!=='/listmonk')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:6,statement_timeout:30000,connectionTimeoutMillis:5000,application_name:'rfm-native-owner'});
const db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q),transaction:async work=>{const c=await owner.connect();try{await c.query('BEGIN');const out=await work({query:(q,p)=>c.query(q,p)});await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const H={customer:'a'.repeat(64),orders:'b'.repeat(64),customerPayload:'c'.repeat(64),ordersPayload:'d'.repeat(64),algorithm:'e'.repeat(64)};
const operations={fish:'11111111-1111-4111-8111-111111111111',aristo:'22222222-2222-4222-8222-222222222222'};
const rule=(value='leal')=>({op:'condition',field:'relationship.rfm',operator:'is',value});
const emailDigest=id=>crypto.createHash('sha256').update(`person${id}@example.test`).digest('hex');

function evidence(brand){
 const now=Date.now(),suffix=brand==='fish'?'11':'21',meta={brand,operation_id:operations[brand],shop_id:'gid://shopify/Shop/'+(brand==='fish'?1:2),
  customer_bulk_gid:'gid://shopify/BulkOperation/'+suffix,paid_orders_bulk_gid:'gid://shopify/BulkOperation/'+(Number(suffix)+1),
  customer_query_sha256:H.customer,paid_orders_query_sha256:H.orders,customer_payload_sha256:H.customerPayload,paid_orders_payload_sha256:H.ordersPayload,
  workflow_id:'synthetic-rfm-'+brand,producer_revision:'1234567',algorithm_sha256:H.algorithm,
  access_scopes:['read_customers','read_orders','read_all_orders'],history_complete:true,started_at:new Date(now-120000).toISOString(),
  observed_at:new Date(now-60000).toISOString(),expires_at:new Date(now+25*3600000).toISOString(),expected_customers:2};
 const provenance={brand,shop_id:meta.shop_id,operation_id:meta.operation_id,
  customer_bulk:{gid:meta.customer_bulk_gid,query_sha256:meta.customer_query_sha256,payload_sha256:meta.customer_payload_sha256,status:'COMPLETED',object_count:2},
  paid_orders_bulk:{gid:meta.paid_orders_bulk_gid,query_sha256:meta.paid_orders_query_sha256,payload_sha256:meta.paid_orders_payload_sha256,status:'COMPLETED',object_count:2},
  workflow_id:meta.workflow_id,producer_revision:meta.producer_revision,algorithm_sha256:meta.algorithm_sha256,access_scopes:meta.access_scopes,
  history_complete:true,started_at:meta.started_at,observed_at:meta.observed_at,expires_at:meta.expires_at};
 return {meta,pin:RFM.sourceHash(provenance),customers:[
  {customer_gid:'gid://shopify/Customer/1',paid_orders:4,amount_spent:'100.00',last_paid_order_at:new Date(now-3600000).toISOString(),identity_email_sha256:emailDigest(1)},
 {customer_gid:'gid://shopify/Customer/2',paid_orders:1,amount_spent:'10.00',last_paid_order_at:new Date(now-180*86400000).toISOString(),identity_email_sha256:emailDigest(2)},
 ]};
}
function revision(x,brand,n,{stale=false,invalid=false}={}){
 const shift=stale?0:n*15000,hex=brand==='fish'?String(2+n):String(5+n),base=brand==='fish'?30:60;
 const meta={...x.meta,operation_id:`${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-8${hex.repeat(3)}-${hex.repeat(12)}`,
  customer_bulk_gid:`gid://shopify/BulkOperation/${base+n*2}`,paid_orders_bulk_gid:`gid://shopify/BulkOperation/${base+n*2+1}`,
  customer_payload_sha256:String((n+3)%10).repeat(64),paid_orders_payload_sha256:String((n+4)%10).repeat(64),
  started_at:new Date(Date.parse(x.meta.started_at)+shift).toISOString(),observed_at:new Date(Date.parse(x.meta.observed_at)+shift).toISOString(),expires_at:new Date(Date.parse(x.meta.expires_at)+shift).toISOString()};
 const customers=[{customer_gid:'gid://shopify/Customer/1',paid_orders:0,amount_spent:invalid?'-1.00':'0.00',last_paid_order_at:null,identity_email_sha256:emailDigest(1)},{customer_gid:'gid://shopify/Customer/2',paid_orders:0,amount_spent:'0.00',last_paid_order_at:null,identity_email_sha256:emailDigest(2)}];
 return {meta,customers};
}

async function main(){
 let api,sync,holder;
 try{
  assert.equal((await db.query("SELECT current_setting('server_version_num') version")).rows[0].version,'170010');
  const fixture=await setupRecordedNativeV2(db);assert.equal(fixture.tier,'native-postgres17-v2-guarded-install');
  const gates=(await db.query('SELECT NOT EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled) worker_off,NOT EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) delivery_off')).rows[0];
  assert.deepEqual(gates,{worker_off:true,delivery_off:true});
  await installNative(db);
	  const installed=(await db.query("SELECT count(*)::int functions FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'rfm_%'")).rows[0];assert.equal(installed.functions,13);
  const metadata=(await db.query("SELECT proname,prosecdef,provolatile,pg_get_userbyid(proowner) owner,coalesce(array_to_string(proacl,','),'') acl FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'rfm_%' ORDER BY proname")).rows;
  assert.equal(metadata.every(x=>x.owner==='postgres'),true);assert.equal(metadata.find(x=>x.proname==='rfm_ingest_snapshot').prosecdef,true);
  await db.exec('ALTER ROLE crm_audience_api LOGIN;ALTER ROLE crm_shopify_sync LOGIN');
  const roleUrl=role=>{const x=new URL(uri);x.username=role;return x.href;};
  api=new Pool({connectionString:roleUrl('crm_audience_api'),max:3,statement_timeout:10000,connectionTimeoutMillis:5000,application_name:'rfm-native-api'});
  sync=new Pool({connectionString:roleUrl('crm_shopify_sync'),max:2,statement_timeout:10000,connectionTimeoutMillis:5000,application_name:'rfm-native-collector'});
	  const inputs={fish:evidence('fish'),aristo:evidence('aristo')};
	  const originalEmail=(await db.query('SELECT email FROM subscribers WHERE id=1')).rows[0].email;
	  const count=async brand=>{const catalog=(await Store.readCatalog((q,p)=>api.query(q,p),brand)).catalog;return Counter.countAudience({definition:{schema_version:'crm-audience-v2',brand,name:'RFM native',rule:rule()},baseListId:brand==='fish'?17:16,catalog,query:(q,p)=>api.query(q,p),timeoutMs:10000});};
	  const rollback=async work=>{const c=await owner.connect();try{await c.query('BEGIN');return await work(c);}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}};
  for(const [brand,x] of Object.entries(inputs))await db.query(`INSERT INTO crm_audience_v2.rfm_source(brand,shop_id,customer_query_sha256,paid_orders_query_sha256,workflow_id,producer_revision,algorithm_sha256,source_hash,ingestion_enabled)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)`,[brand,x.meta.shop_id,x.meta.customer_query_sha256,x.meta.paid_orders_query_sha256,x.meta.workflow_id,x.meta.producer_revision,x.meta.algorithm_sha256,x.pin]);
  holder=await owner.connect();await holder.query('BEGIN');await holder.query("SELECT 1 FROM crm_audience_v2.rfm_source WHERE brand='fish' FOR UPDATE");
  await assert.rejects(sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb) value',[JSON.stringify(inputs.fish.meta),JSON.stringify(inputs.fish.customers)]),e=>e.code==='55P03');
  await holder.query('ROLLBACK');holder.release();holder=null;
		  for(const [brand,x] of Object.entries(inputs)){
	   if(brand==='aristo')await db.query("UPDATE subscribers SET email='rfm-before@example.invalid' WHERE id=1");
		   const receipt=(await sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb) value',[JSON.stringify(x.meta),JSON.stringify(x.customers)])).rows[0].value;
		   assert.deepEqual({state:receipt.state,customers:receipt.customers,resolved:receipt.resolved,unresolved:receipt.unresolved,sends:receipt.sends},{state:'committed',customers:2,resolved:brand==='fish'?2:1,unresolved:brand==='fish'?0:1,sends:0});
		   await fixture.rebind(brand,rule());await fixture.f.approve();
		   const base=brand==='fish'?17:16,catalog=(await Store.readCatalog((q,p)=>api.query(q,p),brand)).catalog,stalePlan=Counter.compileCount({definition:{schema_version:'crm-audience-v2',brand,name:'RFM native',rule:rule()},baseListId:base,catalog});
			   const invalid=(await api.query('SELECT * FROM crm_audience_v2.rfm_count_for_rule($1::jsonb,$2,$3,$4)',[JSON.stringify(rule('inventado')),brand,base,x.pin])).rows[0],wrongPin=(await api.query('SELECT * FROM crm_audience_v2.rfm_count_for_rule($1::jsonb,$2,$3,$4)',[JSON.stringify(rule()),brand,base,'f'.repeat(64)])).rows[0],missingBase=(await api.query('SELECT * FROM crm_audience_v2.rfm_count_for_rule($1::jsonb,$2,$3,$4)',[JSON.stringify(rule()),brand,990,x.pin])).rows[0];
			   assert.deepEqual([invalid.source_confirmed,invalid.eligible_count],[false,null]);assert.deepEqual([wrongPin.source_confirmed,wrongPin.eligible_count],[false,null]);assert.deepEqual([missingBase.source_confirmed,missingBase.eligible_count],[false,null]);
		   await db.query("UPDATE lists SET status='archived' WHERE id=$1",[base]);const stale=(await api.query(stalePlan.text,stalePlan.values)).rows[0];assert.deepEqual([stale.source_confirmed,stale.eligible_count],[false,null]);await db.query("UPDATE lists SET status='active' WHERE id=$1",[base]);
		   if(brand==='fish'){
	    assert.equal((await api.query('SELECT crm_audience_v2.rfm_match($1::jsonb,1,$2,$3) value',[JSON.stringify(rule()),brand,x.pin])).rows[0].value,true);const initial=await count(brand);assert.deepEqual([initial.source_confirmed,initial.eligible_count],[true,1]);
	    await db.query("UPDATE subscribers SET email='rfm-after@example.invalid' WHERE id=1");assert.equal((await api.query('SELECT crm_audience_v2.rfm_match($1::jsonb,1,$2,$3) value',[JSON.stringify(rule()),brand,x.pin])).rows[0].value,null);await assert.rejects(fixture.match(brand,1),/SEGMENT_SELECTION_UNAVAILABLE/);const drifted=await count(brand);assert.deepEqual([drifted.source_confirmed,drifted.eligible_count],[false,null]);
	    await db.query('UPDATE subscribers SET email=$1 WHERE id=1',[originalEmail]);assert.equal((await api.query('SELECT crm_audience_v2.rfm_match($1::jsonb,1,$2,$3) value',[JSON.stringify(rule()),brand,x.pin])).rows[0].value,true);assert.equal(await fixture.match(brand,1),true);const restored=await count(brand);assert.deepEqual([restored.source_confirmed,restored.eligible_count],[true,1]);
	   }else{
	    assert.deepEqual((await db.query("SELECT subscriber_id,subscriber_uuid FROM crm_audience_v2.rfm_fact WHERE brand='aristo' AND operation_id=$1 AND customer_gid='gid://shopify/Customer/1'",[x.meta.operation_id])).rows[0],{subscriber_id:null,subscriber_uuid:null});assert.equal((await api.query('SELECT crm_audience_v2.rfm_match($1::jsonb,1,$2,$3) value',[JSON.stringify(rule()),brand,x.pin])).rows[0].value,null);await assert.rejects(fixture.match(brand,1),/SEGMENT_SELECTION_UNAVAILABLE/);const unresolved=await count(brand);assert.deepEqual([unresolved.source_confirmed,unresolved.eligible_count],[false,null]);
	    await db.query('UPDATE subscribers SET email=$1 WHERE id=1',[originalEmail]);assert.equal((await api.query('SELECT crm_audience_v2.rfm_match($1::jsonb,1,$2,$3) value',[JSON.stringify(rule()),brand,x.pin])).rows[0].value,null);assert.deepEqual([(await count(brand)).source_confirmed,(await count(brand)).eligible_count],[false,null]);
	   }
	  }
	 for(const [brand,x] of Object.entries(inputs)){
	  const base=brand==='fish'?17:16;
	  await rollback(async c=>{
	   await c.query('UPDATE crm_audience_v2.shopify_source SET enabled=false WHERE brand=$1',[brand]);
	   assert.equal((await c.query('SELECT crm_audience_v2.rfm_source_current($1,$2) value',[brand,x.pin])).rows[0].value,true,'RFM source is independent of the parent enabled gate');
	  });
	  await rollback(async c=>{
	   await c.query("UPDATE crm_audience_v2.shopify_source SET shop_id='gid://shopify/Shop/999' WHERE brand=$1",[brand]);
	   assert.equal((await c.query('SELECT crm_audience_v2.rfm_snapshot($1) value',[brand])).rows[0].value.current,false);
	   assert.equal((await c.query('SELECT crm_audience_v2.rfm_source_current($1,$2) value',[brand,x.pin])).rows[0].value,false);
	   assert.equal((await c.query('SELECT crm_audience_v2.rfm_match($1::jsonb,1,$2,$3) value',[JSON.stringify(rule()),brand,x.pin])).rows[0].value,null);
	   const counted=(await c.query('SELECT * FROM crm_audience_v2.rfm_count_for_rule($1::jsonb,$2,$3,$4)',[JSON.stringify(rule()),brand,base,x.pin])).rows[0];
	   assert.deepEqual([counted.source_confirmed,counted.eligible_count],[false,null]);
	  });
	  await rollback(async c=>{
	   for(const table of ['shopify_product_history_gap','shopify_product_history_attestation','shopify_product_history_transition','shopify_customer_product','shopify_product_chunk','shopify_product_batch','shopify_customer_fact','shopify_chunk','shopify_identity','shopify_batch'])await c.query(`DELETE FROM crm_audience_v2.${table} WHERE brand=$1`,[brand]);
	   await c.query('DELETE FROM crm_audience_v2.shopify_source WHERE brand=$1',[brand]);
	   assert.equal((await c.query('SELECT crm_audience_v2.rfm_snapshot($1) value',[brand])).rows[0].value.current,false);
	   assert.equal((await c.query('SELECT crm_audience_v2.rfm_source_current($1,$2) value',[brand,x.pin])).rows[0].value,false);
	   assert.equal((await c.query('SELECT crm_audience_v2.rfm_match($1::jsonb,1,$2,$3) value',[JSON.stringify(rule()),brand,x.pin])).rows[0].value,null);
	   const counted=(await c.query('SELECT * FROM crm_audience_v2.rfm_count_for_rule($1::jsonb,$2,$3,$4)',[JSON.stringify(rule()),brand,base,x.pin])).rows[0];
	   assert.deepEqual([counted.source_confirmed,counted.eligible_count],[false,null]);
	  });
	  const before=(await db.query('SELECT current_operation,(SELECT count(*)::int FROM crm_audience_v2.rfm_batch WHERE brand=$1) batches,(SELECT count(*)::int FROM crm_audience_v2.rfm_fact WHERE brand=$1) facts FROM crm_audience_v2.rfm_source WHERE brand=$1',[brand])).rows[0];
	  const wrongShop='gid://shopify/Shop/999',mislabel={...revision(x,brand,4).meta,shop_id:wrongShop};
	  await db.query('UPDATE crm_audience_v2.rfm_source SET shop_id=$2 WHERE brand=$1',[brand,wrongShop]);
	  try{await assert.rejects(sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb)',[JSON.stringify(mislabel),JSON.stringify(revision(x,brand,4).customers)]),/RFM_INGEST_GUARD/);}
	  finally{await db.query('UPDATE crm_audience_v2.rfm_source SET shop_id=$2 WHERE brand=$1',[brand,x.meta.shop_id]);}
	  assert.deepEqual((await db.query('SELECT current_operation,(SELECT count(*)::int FROM crm_audience_v2.rfm_batch WHERE brand=$1) batches,(SELECT count(*)::int FROM crm_audience_v2.rfm_fact WHERE brand=$1) facts FROM crm_audience_v2.rfm_source WHERE brand=$1',[brand])).rows[0],before);
	 }
	 const lockCandidate=revision(inputs.fish,'fish',4),observer=await owner.connect();
	 holder=await owner.connect();await holder.query('BEGIN');await holder.query("SELECT 1 FROM crm_audience_v2.shopify_source WHERE brand='fish' FOR UPDATE");
	 const blocked=sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb)',[JSON.stringify(lockCandidate.meta),JSON.stringify(lockCandidate.customers)]);
	 await new Promise(resolve=>setTimeout(resolve,100));
	 try{await observer.query('BEGIN');await observer.query("SELECT 1 FROM crm_audience_v2.rfm_source WHERE brand='fish' FOR UPDATE NOWAIT");}
	 finally{await observer.query('ROLLBACK').catch(()=>{});observer.release();}
	 await assert.rejects(blocked,e=>e.code==='55P03');await holder.query('ROLLBACK');holder.release();holder=null;
	 const refreshed={};
	 const pausedNext=revision(inputs.fish,'fish',1);await db.query("UPDATE crm_audience_v2.rfm_source SET enabled=false WHERE brand='fish'");
	 const pausedState=(await db.query("SELECT to_jsonb(s) source,(SELECT count(*)::int FROM crm_audience_v2.rfm_batch WHERE brand='fish') batches,(SELECT count(*)::int FROM crm_audience_v2.rfm_fact WHERE brand='fish') facts FROM crm_audience_v2.rfm_source s WHERE brand='fish'")).rows[0],pausedCatalog=(await Store.readCatalog((q,p)=>api.query(q,p),'fish')).catalog;
	 assert.equal(pausedCatalog.fields.find(x=>x.key==='relationship.rfm').available,false);assert.deepEqual(pausedCatalog.rfm_snapshot,{brand:'fish',current:false,history_complete:false});
	 await assert.rejects(sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb)',[JSON.stringify(pausedNext.meta),JSON.stringify(pausedNext.customers)]),/RFM_INGEST_DISABLED/);
	 const rejectedState=(await db.query("SELECT to_jsonb(s) source,(SELECT count(*)::int FROM crm_audience_v2.rfm_batch WHERE brand='fish') batches,(SELECT count(*)::int FROM crm_audience_v2.rfm_fact WHERE brand='fish') facts FROM crm_audience_v2.rfm_source s WHERE brand='fish'")).rows[0],rejectedCatalog=(await Store.readCatalog((q,p)=>api.query(q,p),'fish')).catalog;
	 assert.deepEqual(rejectedState,pausedState);assert.deepEqual({...rejectedCatalog,checked_at:null},{...pausedCatalog,checked_at:null});await db.query("UPDATE crm_audience_v2.rfm_source SET enabled=true WHERE brand='fish'");
	 for(const [brand,x] of Object.entries(inputs)){
   const next=revision(x,brand,1);refreshed[brand]=next;
   const receipt=(await sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb) value',[JSON.stringify(next.meta),JSON.stringify(next.customers)])).rows[0].value;
   assert.deepEqual({state:receipt.state,resolved:receipt.resolved,unresolved:receipt.unresolved},{state:'committed',resolved:2,unresolved:0});
   assert.equal((await api.query('SELECT crm_audience_v2.rfm_match($1::jsonb,1,$2,$3) value',[JSON.stringify(rule()),brand,x.pin])).rows[0].value,false);
   const current=await count(brand);assert.deepEqual([current.source_confirmed,current.eligible_count],[true,0]);
  }
  await assert.rejects(sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb)',[JSON.stringify(refreshed.fish.meta),JSON.stringify(refreshed.fish.customers)]),/RFM_INGEST_REPLAY/);
  const stale=revision(inputs.fish,'fish',2,{stale:true});await assert.rejects(sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb)',[JSON.stringify(stale.meta),JSON.stringify(stale.customers)]),/RFM_INGEST_STALE/);
  const failed=revision(inputs.fish,'fish',3);await db.exec(`CREATE FUNCTION public.synthetic_rfm_fact_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'SYNTHETIC_RFM_FACT_FAILURE';END$$;
   CREATE TRIGGER synthetic_rfm_fact_failure BEFORE INSERT ON crm_audience_v2.rfm_fact FOR EACH ROW WHEN(NEW.operation_id='${failed.meta.operation_id}'::uuid) EXECUTE FUNCTION public.synthetic_rfm_fact_failure()`);
  await assert.rejects(sync.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1::jsonb,$2::jsonb)',[JSON.stringify(failed.meta),JSON.stringify(failed.customers)]),/SYNTHETIC_RFM_FACT_FAILURE/);
  assert.equal((await db.query("SELECT current_operation FROM crm_audience_v2.rfm_source WHERE brand='fish'")).rows[0].current_operation,refreshed.fish.meta.operation_id);
  assert.deepEqual((await db.query("SELECT count(*)::int batches,(SELECT count(*)::int FROM crm_audience_v2.rfm_fact WHERE brand='fish') facts FROM crm_audience_v2.rfm_batch WHERE brand='fish'")).rows[0],{batches:2,facts:4});
  const parity={};
	  for(const brand of ['fish','aristo']){
	   const base=brand==='fish'?17:16,ids=(await db.query(`SELECT s.id FROM subscribers s JOIN subscriber_lists sl ON sl.subscriber_id=s.id JOIN lists l ON l.id=sl.list_id WHERE l.id=$1 AND l.status='active' AND s.status='enabled' AND ((l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status IN('confirmed','unconfirmed'))) ORDER BY s.id`,[base])).rows.map(x=>x.id);
   let selected=0;for(const id of ids)if(await fixture.match(brand,id))selected++;
	   const counted=await count(brand);assert.equal(counted.source_confirmed,true);assert.equal(counted.eligible_count,selected);assert.equal(selected,0);
	   const optin=(await db.query('SELECT optin::text FROM lists WHERE id=$1',[base])).rows[0].optin,nativeCtx={bound:true,brand,base_list_id:base,definition:{rule:rule()},list_pins:[{list_id:base,optin}]},nativeCount=(await db.query('SELECT * FROM crm_audience_v2.rfm_native_count($1::jsonb)',[JSON.stringify(nativeCtx)])).rows[0];assert.deepEqual([Number(nativeCount.to_send),nativeCount.max_subscriber_id],[0,0]);
	   assert.equal((await db.query('SELECT crm_audience_v2.rfm_native_context_fast($1::jsonb) value',[JSON.stringify(nativeCtx)])).rows[0].value,true);
	   for(const [key,value] of [['ab_test_id','00000000-0000-4000-8000-000000000099'],['ab_arm','a'],['ab_scope_hash','f'.repeat(64)]]){const abCtx={...nativeCtx,[key]:value};assert.equal((await db.query('SELECT crm_audience_v2.rfm_native_context_fast($1::jsonb) value',[JSON.stringify(abCtx)])).rows[0].value,false);assert.deepEqual((await db.query('SELECT * FROM crm_audience_v2.rfm_native_count($1::jsonb)',[JSON.stringify(abCtx)])).rows,[]);assert.deepEqual((await db.query("SELECT * FROM crm_audience_v2.rfm_native_subscriber_ids($1::jsonb,'regular',$2::integer[],0,999,100)",[JSON.stringify(abCtx),[base]])).rows,[]);await assert.rejects(db.query('SELECT * FROM crm_audience_v2.rfm_native_scope($1::jsonb)',[JSON.stringify(abCtx)]),/SEGMENT_SELECTION_UNAVAILABLE/);}
	   assert.deepEqual((await db.query("SELECT id FROM crm_audience_v2.rfm_native_subscriber_ids($1::jsonb,'regular',$2::integer[],0,999,100)",[JSON.stringify(nativeCtx),[base]])).rows,[]);
   await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[base]);assert.equal(await fixture.match(brand,1),false);
   const opted=await count(brand);assert.deepEqual([opted.source_confirmed,opted.eligible_count],[true,0]);
   await db.query("UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=1 AND list_id=$1",[base]);parity[brand]={eligible_ids:ids,selected};
  }
	  const original=(await db.query('SELECT uuid FROM subscribers WHERE id=1')).rows[0].uuid;await db.query('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=1');
	  await assert.rejects(fixture.match('fish',1),/SEGMENT_SELECTION_UNAVAILABLE/);assert.deepEqual([(await count('fish')).source_confirmed,(await count('fish')).eligible_count],[false,null]);
	  await assert.rejects(db.query('SELECT * FROM crm_audience_v2.rfm_native_count($1::jsonb)',[JSON.stringify({bound:true,brand:'fish',base_list_id:17,definition:{rule:rule()}})]),/SEGMENT_SELECTION_UNAVAILABLE/);
  await db.query('UPDATE subscribers SET uuid=$1 WHERE id=1',[original]);
  await db.query("UPDATE crm_audience_v2.rfm_batch SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE brand='aristo' AND operation_id=$1",[refreshed.aristo.meta.operation_id]);
  await assert.rejects(fixture.match('aristo',1),/SEGMENT_SELECTION_UNAVAILABLE/);const staleCount=await count('aristo');assert.deepEqual([staleCount.source_confirmed,staleCount.eligible_count],[false,null]);
	  const privilegeSql="SELECT has_function_privilege(current_user,'crm_audience_v2.rfm_snapshot(text)','EXECUTE') snapshot,has_function_privilege(current_user,'crm_audience_v2.rfm_source_current(text,text)','EXECUTE') source_current,has_function_privilege(current_user,'crm_audience_v2.rfm_match(jsonb,integer,text,text)','EXECUTE') match,has_function_privilege(current_user,'crm_audience_v2.rfm_count_for_rule(jsonb,text,integer,text)','EXECUTE') aggregate,has_function_privilege(current_user,'crm_audience_v2.rfm_native_context_fast(jsonb)','EXECUTE') native_context_fast,has_function_privilege(current_user,'crm_audience_v2.rfm_native_scope(jsonb)','EXECUTE') native_scope,has_function_privilege(current_user,'crm_audience_v2.rfm_native_count(jsonb)','EXECUTE') native_count,has_function_privilege(current_user,'crm_audience_v2.rfm_native_subscriber_ids(jsonb,text,integer[],integer,integer,integer)','EXECUTE') native_ids,has_function_privilege(current_user,'crm_audience_v2.rfm_ingest_snapshot(jsonb,jsonb)','EXECUTE') ingest";
  const apiPrivileges=(await api.query(privilegeSql)).rows[0],syncPrivileges=(await sync.query(privilegeSql)).rows[0];
	  assert.deepEqual(apiPrivileges,{snapshot:true,source_current:true,match:true,aggregate:true,native_context_fast:false,native_scope:false,native_count:false,native_ids:false,ingest:false});assert.deepEqual(syncPrivileges,{snapshot:false,source_current:false,match:false,aggregate:false,native_context_fast:false,native_scope:false,native_count:false,native_ids:false,ingest:true});
  for(const pool of [api,sync])for(const sql of ['SELECT * FROM crm_audience_v2.rfm_source','SELECT * FROM crm_audience_v2.rfm_batch','SELECT * FROM crm_audience_v2.rfm_fact'])await assert.rejects(pool.query(sql),e=>e.code==='42501');
  assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
	  console.log(JSON.stringify({success:true,postgres:'17.10',tier:fixture.tier,product_semantics:'v2',rfm_semantics:RFM.VERSION,both_brands:true,two_atomic_snapshots_per_brand:true,parent_enabled_independent:true,parent_shop_drift_unknown:true,parent_absent_unknown:true,mislabel_ingest_rejected_preserved:true,parent_before_rfm_lock_order:true,transient_email_digest_required:true,email_drift_after_ingest_unknown_then_restored:true,email_drift_before_ingest_unresolved_and_nonretroactive:true,new_snapshot_restores_identity:true,paused_refresh_rejected:true,paused_source_current_facts_catalog_preserved:true,explicit_reenable_refresh_succeeded:true,replay_rejected:true,stale_rejected:true,failed_refresh_preserved_current:true,count_selection_updated:true,count_selection_parity:parity,optout_rechecked:true,uuid_drift_unknown:true,expired_batch_unknown:true,collector_lock_timeout:true,api_privileges:apiPrivileges,collector_privileges:syncPrivileges,private_tables_denied:true,metadata_functions:metadata.length,sends:0,remote_hosts:0,production_changed:false}));
 }finally{
  if(holder){await holder.query('ROLLBACK').catch(()=>{});holder.release();}
  if(api)await api.end();if(sync)await sync.end();await owner.end();
 }
}
main().catch(e=>{console.error({code:e.code,message:e.message,stack:e.stack});process.exitCode=1;});
