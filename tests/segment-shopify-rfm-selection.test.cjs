'use strict';
// Portable native-selection component proof. The source remains fixture-only;
// this does not activate a producer, filter, worker, UI or production rollout.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupRecordedComponent}=require('./segment-recorded-origin-fixture.cjs');
const {componentSql}=require('./segment-shopify-rfm-install-fixture.cjs');
const RFM=require('../n8n/growth/segment-shopify-rfm.cjs');

const sql=componentSql();
const H={customer:'a'.repeat(64),orders:'b'.repeat(64),customerPayload:'c'.repeat(64),ordersPayload:'d'.repeat(64),algorithm:'e'.repeat(64)};
const op={fish:'11111111-1111-4111-8111-111111111111',aristo:'22222222-2222-4222-8222-222222222222'};
const emailDigest=id=>crypto.createHash('sha256').update(`person${id}@example.test`).digest('hex');

function input(brand){
 const now=Date.now(),suffix=brand==='fish'?'11':'21';
 const meta={brand,operation_id:op[brand],shop_id:'gid://shopify/Shop/'+(brand==='fish'?1:2),
  customer_bulk_gid:'gid://shopify/BulkOperation/'+suffix,paid_orders_bulk_gid:'gid://shopify/BulkOperation/'+(Number(suffix)+1),
  customer_query_sha256:H.customer,paid_orders_query_sha256:H.orders,customer_payload_sha256:H.customerPayload,
  paid_orders_payload_sha256:H.ordersPayload,workflow_id:'synthetic-rfm-'+brand,producer_revision:'1234567',
  algorithm_sha256:H.algorithm,access_scopes:['read_customers','read_orders','read_all_orders'],history_complete:true,
  started_at:new Date(now-120000).toISOString(),observed_at:new Date(now-60000).toISOString(),
  expires_at:new Date(now+25*3600000).toISOString(),expected_customers:2};
 const provenance={brand,shop_id:meta.shop_id,operation_id:meta.operation_id,
  customer_bulk:{gid:meta.customer_bulk_gid,query_sha256:meta.customer_query_sha256,payload_sha256:meta.customer_payload_sha256,status:'COMPLETED',object_count:2},
  paid_orders_bulk:{gid:meta.paid_orders_bulk_gid,query_sha256:meta.paid_orders_query_sha256,payload_sha256:meta.paid_orders_payload_sha256,status:'COMPLETED',object_count:2},
  workflow_id:meta.workflow_id,producer_revision:meta.producer_revision,algorithm_sha256:meta.algorithm_sha256,
  access_scopes:meta.access_scopes,history_complete:true,started_at:meta.started_at,observed_at:meta.observed_at,expires_at:meta.expires_at};
 const customers=[
  {customer_gid:'gid://shopify/Customer/1',paid_orders:4,amount_spent:'100.00',last_paid_order_at:new Date(now-3600000).toISOString(),identity_email_sha256:emailDigest(1)},
  {customer_gid:'gid://shopify/Customer/2',paid_orders:1,amount_spent:'10.00',last_paid_order_at:new Date(now-180*86400000).toISOString(),identity_email_sha256:emailDigest(2)},
 ];
 return {meta,customers,pin:RFM.sourceHash(provenance)};
}

const rule=(value='leal')=>({op:'condition',field:'relationship.rfm',operator:'is',value});

async function setup(t){
 const db=new PGlite();t.after(()=>db.close());
 const fixture=await setupRecordedComponent(db);
 await db.exec('CREATE ROLE crm_shopify_sync NOLOGIN NOINHERIT');
 await db.exec(sql);
 for(const brand of ['fish','aristo']){
  const x=input(brand);
  await db.query(`INSERT INTO crm_audience_v2.rfm_source(brand,shop_id,customer_query_sha256,
   paid_orders_query_sha256,workflow_id,producer_revision,algorithm_sha256,source_hash,ingestion_enabled)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)`,[brand,x.meta.shop_id,x.meta.customer_query_sha256,
   x.meta.paid_orders_query_sha256,x.meta.workflow_id,x.meta.producer_revision,x.meta.algorithm_sha256,x.pin]);
  assert.equal((await db.query('SELECT crm_audience_v2.rfm_snapshot($1) value',[brand])).rows[0].value.current,false);
  const receipt=(await db.query('SELECT crm_audience_v2.rfm_ingest_snapshot($1,$2) value',[x.meta,x.customers])).rows[0].value;
  assert.deepEqual({state:receipt.state,customers:receipt.customers,resolved:receipt.resolved,sends:receipt.sends},{state:'committed',customers:2,resolved:2,sends:0});
 }
 return fixture;
}

async function bind(fixture,brand,r=rule()){
 const audience=await fixture.rebind(brand,r);await fixture.f.approve();
 const current=await fixture.current(brand),field=current.catalog.fields.find(x=>x.key==='relationship.rfm');
 assert.equal(current.catalog.rfm_snapshot.current,true);assert.equal(current.catalog.rfm_snapshot.history_complete,true);
 assert.deepEqual({available:field.available,source_hash:field.source_hash},{available:true,source_hash:input(brand).pin});
 return audience;
}

async function parity(fixture,brand,r=rule()){
 const {db}=fixture,base=brand==='fish'?17:16,ids=(await db.query(`SELECT s.id FROM subscribers s JOIN subscriber_lists sl ON sl.subscriber_id=s.id
  JOIN lists l ON l.id=sl.list_id WHERE l.id=$1 AND l.status='active' AND s.status='enabled'
  AND ((l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status IN('confirmed','unconfirmed'))) ORDER BY s.id`,[base])).rows.map(x=>x.id);
 let selected=0;for(const id of ids)if(await fixture.match(brand,id))selected++;
 const count=await fixture.count(r,brand);
 assert.equal(count.source_confirmed,true,JSON.stringify(count));assert.equal(count.eligible_count,selected);
 return {ids,selected,count};
}

test('RFM count and native regular selection agree for both brands and preserve opt-out',async t=>{
 const fixture=await setup(t);
 for(const brand of ['fish','aristo']){
  await bind(fixture,brand);const initial=await parity(fixture,brand);assert.deepEqual(initial.ids,[1,2]);assert.equal(initial.selected,1);
  const base=brand==='fish'?17:16;
  await fixture.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[base]);
  assert.equal(await fixture.match(brand,1),false);
  const optedOut=await parity(fixture,brand);assert.equal(optedOut.selected,0);assert.equal(optedOut.count.eligible_count,0);
 }
});

test('missing identity and expired batch stay unknown while UUID drift cannot become zero',async t=>{
 const fixture=await setup(t),{db}=fixture;await bind(fixture,'fish');
 const original=(await db.query('SELECT uuid FROM subscribers WHERE id=1')).rows[0].uuid;
 await db.query('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=1');
 await assert.rejects(fixture.match('fish',1),/SEGMENT_SELECTION_UNAVAILABLE/);
 const unknown=await fixture.count(rule(),'fish');assert.equal(unknown.source_confirmed,false);assert.equal(unknown.eligible_count,null);
 await db.query('UPDATE subscribers SET uuid=$1 WHERE id=1',[original]);
 assert.equal(await fixture.match('fish',1),true);
 await db.query("UPDATE crm_audience_v2.rfm_batch SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE brand='fish' AND operation_id=$1",[op.fish]);
 await assert.rejects(fixture.match('fish',1),/SEGMENT_SELECTION_UNAVAILABLE/);
 const stale=await fixture.count(rule(),'fish');assert.equal(stale.source_confirmed,false);assert.equal(stale.eligible_count,null);
});
