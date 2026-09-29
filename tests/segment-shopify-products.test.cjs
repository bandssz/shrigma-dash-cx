'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const {setupProducts,productEvidence}=require('./segment-shopify-products-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs'),Facts=require('../n8n/growth/segment-shopify-facts.cjs');
const product=(id=101,operator='purchased')=>({op:'condition',field:'purchase.product',operator,value:'gid://shopify/Product/'+id});
async function setup(t){const db=new PGlite();t.after(()=>db.close());return setupProducts(db);}
async function count(x,brand,rule){const c=await Store.readCatalog(x.db.query.bind(x.db),brand);return Counter.countAudience({definition:{schema_version:'crm-audience-v2',brand,name:'Produtos',rule},baseListId:brand==='fish'?17:16,catalog:c.catalog,query:x.db.query.bind(x.db)});}
test('complete product export is available through the same count, saved audience, binding and native selector in both brands',async t=>{
 const x=await setup(t);
 for(const brand of ['fish','aristo']){
  const e=productEvidence(brand);assert.equal((await x.ingestProducts(e)).status,'ready');await x.enableProducts(brand);
  const c=await Store.readCatalog(x.db.query.bind(x.db),brand);assert.equal(c.catalog.fields.find(f=>f.key==='purchase.product').available,true);
  assert.deepEqual(c.catalog.products.map(p=>p.name),['Produto 101','Produto 202']);
  for(const field of Facts.FIELDS)assert.equal((await x.db.query('SELECT crm_audience_v2.shopify_source_hash($1,$2,$3) pin',[brand,field,JSON.stringify(c.catalog)])).rows[0].pin,Facts.sourceHash(brand,field,c.catalog));
  for(const [operator,yes,no] of [['purchased',1,2],['not_purchased',2,1]]){
   const audience=await x.rebind(brand,product(101,operator));await x.f.approve();
   assert.equal(await x.match(brand,yes),true);assert.equal(await x.match(brand,no),false);
   const counted=await count(x,brand,product(101,operator));assert.equal(counted.source_confirmed,true);assert.equal(counted.eligible_count,1);
   const current=await Store.readCatalog(x.db.query.bind(x.db),brand);const persisted=(await x.db.query('SELECT definition,context FROM crm_audience_v2.revision WHERE audience_id=$1 AND version=$2',[audience.id,audience.version])).rows[0];assert.deepEqual(Store.pins(persisted.definition,current),persisted.context);
  }
  assert.equal((await x.ingestProducts(e)).replayed,true);
 }
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
test('unmapped line items preserve positive proof and unknown absence, including AND/OR decisions',async t=>{
 const x=await setup(t);await x.ingestProducts(productEvidence('fish',[{id:1,products:[101,null]},{id:2,products:[202]}]));await x.enableProducts('fish');
 assert.equal((await count(x,'fish',product(101))).eligible_count,1);
 const absent=await count(x,'fish',product(202,'not_purchased'));assert.equal(absent.source_confirmed,false);assert.equal(absent.eligible_count,null);
 await x.rebind('fish',product(202,'not_purchased'));await x.f.approve();await assert.rejects(()=>x.match('fish',1),/SEGMENT_SELECTION_UNAVAILABLE/);
 const c=await Store.readCatalog(x.db.query.bind(x.db),'fish'),pin=Facts.sourceHash('fish','purchase.product',c.catalog);
 assert.equal((await x.db.query('SELECT crm_audience_v2.shopify_customer_match($1,1,$2,$3) v',[JSON.stringify(product(101,'not_purchased')),'fish',pin])).rows[0].v,false);
 await x.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=101");
 for(const op of ['and','or']){const rule={op,rules:[product(202,'not_purchased'),{op:'in_list',list_id:op==='and'?101:17}]};await x.rebind('fish',rule);await x.f.approve();assert.equal(await x.match('fish',1),op==='or');assert.equal((await count(x,'fish',rule)).source_confirmed,true);}
});
test('changed products on a replay roll back without changing the current source or native contacts',async t=>{
 const x=await setup(t),e=productEvidence();await x.ingestProducts(e);await x.enableProducts('fish');const altered=structuredClone(e);altered.customers[0].products[0].id='gid://shopify/Product/999';
 await assert.rejects(()=>x.ingestProducts(altered),/SHOPIFY_PRODUCT_REPLAY_CONFLICT/);
 assert.equal((await count(x,'fish',product())).eligible_count,1);
 for(const table of ['shopify_customer_product','shopify_product_batch','shopify_product_chunk'])assert.equal((await x.db.query("SELECT has_table_privilege('crm_audience_api',$1,'SELECT') allowed",['crm_audience_v2.'+table])).rows[0].allowed,false);
 assert.equal((await x.db.query("SELECT has_function_privilege('crm_audience_api','crm_audience_v2.shopify_ingest_product_chunk(jsonb,integer,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
});
test('invalid product metadata cannot ingest scalar facts or advance a pointer',async t=>{
 const x=await setup(t);for(const mutate of [e=>e.counts.object_count='2',e=>e.bulk.required_scopes.pop(),e=>e.customers[0].products.push(e.customers[0].products[0]),e=>e.customers[0].products[0].name='bad\nname']){
  const e=productEvidence();mutate(e);await assert.rejects(()=>x.ingestProducts(e),/SHOPIFY_PRODUCT/);
 }
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.shopify_product_batch')).rows[0].n,0);
 assert.equal((await x.db.query("SELECT count(*)::int n FROM crm_audience_v2.shopify_batch WHERE operation_id='gid://shopify/BulkOperation/21'")).rows[0].n,0);
});
test('source expiry and changed identity cannot become a product absence',async t=>{
 const x=await setup(t);await x.ingestProducts(productEvidence());await x.enableProducts('fish');
 await x.db.exec('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=1');assert.equal((await count(x,'fish',product(202,'not_purchased'))).source_confirmed,false);
 await x.db.exec("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours' WHERE brand='fish'");await x.db.query("SELECT crm_audience_v2.refresh_native_catalog('fish')");
 const c=await Store.readCatalog(x.db.query.bind(x.db),'fish');assert.equal(c.ready,true);assert.equal(c.catalog.fields.find(f=>f.key==='purchase.product').available,false);assert.equal(c.catalog.fields.find(f=>f.key==='email.opened').available,true);assert.deepEqual(c.catalog.products,[]);
});
test('nightly catalog changes require retained complete evidence and cannot replace unrelated source rules',async t=>{
 const x=await setup(t);await x.ingestProducts(productEvidence());await x.enableProducts('fish');
 const before=(await Store.readCatalog(x.db.query.bind(x.db),'fish')).catalog;
 await x.ingestProducts(productEvidence('fish',[{id:1,products:[303]},{id:2,products:[404]}],'22'));await x.db.query("SELECT crm_audience_v2.refresh_native_catalog('fish')");
 const after=(await Store.readCatalog(x.db.query.bind(x.db),'fish')).catalog;assert.deepEqual(after.products.map(p=>p.name),['Produto 303','Produto 404']);assert.notEqual(after.catalog_hash,before.catalog_hash);
 await x.db.exec("UPDATE crm_audience_v2.config SET catalog=jsonb_set(catalog,'{products,0,name}','\"Invented\"') WHERE brand='fish'");await assert.rejects(()=>x.db.query("SELECT crm_audience_v2.refresh_native_catalog('fish')"),/SEGMENT_RUNTIME_SOURCE/);
});
test('unresolved item totals and incomplete Customer totals reconcile exactly before either pointer can commit',async t=>{
 const x=await setup(t);for(const mutate of [e=>e.customers[0].unresolved_product_items=0,e=>e.counts.product_missing++,e=>e.counts.product_history_incomplete=1]){
  const e=productEvidence('fish',[{id:1,products:[101,null,null]},{id:2,products:[202,null]}]);mutate(e);await assert.rejects(()=>x.ingestProducts(e),/SHOPIFY_PRODUCT/);
 }
 assert.equal((await x.db.query("SELECT count(*)::int n FROM crm_audience_v2.shopify_batch WHERE operation_id='gid://shopify/BulkOperation/21'")).rows[0].n,0);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.shopify_customer_product')).rows[0].n,0);
});
test('native opt-out and double opt-in remain mandatory for product matches',async t=>{
 const x=await setup(t);await x.ingestProducts(productEvidence('aristo'));await x.enableProducts('aristo');await x.rebind('aristo',product());await x.f.approve();assert.equal(await x.match('aristo',1),true);
 await x.db.exec("UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=1 AND list_id=16");assert.equal(await x.match('aristo',1),false);assert.equal((await count(x,'aristo',product())).eligible_count,0);
 await x.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=16");assert.equal(await x.match('aristo',1),false);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
