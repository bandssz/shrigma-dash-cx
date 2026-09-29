'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const {setupShopifySelection}=require('./segment-shopify-selection-fixture.cjs');
const {evidence,rule}=require('./segment-shopify-facts-fixture.cjs'),Facts=require('../n8n/growth/segment-shopify-facts.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
async function setup(t){const db=new PGlite();t.after(()=>db.close());return setupShopifySelection(db);}
test('nightly facts -> persisted audience -> bound native campaign -> review agree for both brands without sends',async t=>{
 const {db,f,rebind,match}=await setup(t);
 for(const brand of ['fish','aristo']){
  const audience=await rebind(brand,rule());await f.approve();
  const row=(await db.query('SELECT definition,context FROM crm_audience_v2.revision WHERE audience_id=$1 AND version=$2',[audience.id,audience.version])).rows[0];
  const current=await Store.readCatalog(db.query.bind(db),brand);
  assert.deepEqual(Store.pins(row.definition,current),row.context);assert.equal(current.catalog.shopify_snapshot.current,true);
  for(const field of Facts.FIELDS)assert.equal((await db.query('SELECT crm_audience_v2.shopify_source_hash($1,$2,$3) AS hash',[brand,field,JSON.stringify(current.catalog)])).rows[0].hash,Facts.sourceHash(brand,field,current.catalog));
  assert.equal(await match(brand,1),true);assert.equal(await match(brand,2),false);assert.equal(await match(brand,3),false);
  const result=await f.call(await f.prepareRequest(brand));assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM shrigma_email_dispatch')).rows[0].n,0);
 }
});
test('complete source with unresolved customers retains the counter/native three-valued AND/OR semantics',async t=>{
 const {db,f,ingest,rebind,match}=await setup(t);
 await ingest(evidence('fish',[{id:1,orders:'0'}],'2'));
 for(const op of ['and','or']){
  // Contact 2 has no Shopify fact; a false AND or true OR can still be decided.
  const list={op:'in_list',list_id:op==='and'?101:17};
  const audience=await rebind('fish',{op,rules:[rule(),list]});await f.approve();
  assert.equal(await match('fish',2),op==='or');
  const c=await Store.readCatalog(db.query.bind(db),'fish');const result=await Counter.countAudience({definition:audience.definition,baseListId:17,catalog:c.catalog,query:db.query.bind(db)});assert.equal(result.source_confirmed,true);
 }
 await rebind('aristo',rule());await f.approve();
 await db.exec("UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=1");
 await assert.rejects(()=>match('aristo',1),/SEGMENT_SELECTION_UNAVAILABLE/);
});
test('expired Shopify blocks its campaign while lists/engagement catalog and existing native functions remain usable',async t=>{
 const {db,f,rebind,match}=await setup(t);await rebind('fish',rule());await f.approve();
 await db.exec("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours' WHERE brand='fish'");
 await db.query("SELECT crm_audience_v2.refresh_native_catalog('fish')");
 const c=await Store.readCatalog(db.query.bind(db),'fish');assert.equal(c.ready,true);assert.equal(c.catalog.shopify_snapshot.current,false);assert.ok(c.catalog.fields.find(x=>x.key==='email.opened').available);assert.equal(c.catalog.fields.find(x=>x.key==='purchase.count').available,false);
 await assert.rejects(()=>match('fish',1),/SEGMENT_SELECTION_UNAVAILABLE/);
 assert.equal((await db.query("SELECT has_function_privilege('crm_audience_api','crm_audience_v2.shopify_snapshot(text)','EXECUTE') AS allowed,has_table_privilege('crm_audience_api','crm_audience_v2.shopify_customer_fact','SELECT') AS private")).rows[0].allowed,true);
 assert.equal((await db.query("SELECT has_table_privilege('crm_audience_api','crm_audience_v2.shopify_customer_fact','SELECT') AS private")).rows[0].private,false);
});
test('turning Shopify OFF demotes only its fields and leaves native catalog refresh available',async t=>{
 const {db}=await setup(t);await db.query("UPDATE crm_audience_v2.shopify_source SET enabled=false WHERE brand='fish'");
 await db.query("SELECT crm_audience_v2.refresh_native_catalog('fish')");const c=await Store.readCatalog(db.query.bind(db),'fish');
 assert.equal(c.ready,true);assert.ok(c.catalog.lists.every(x=>x.available));
 for(const k of Facts.FIELDS)assert.equal(c.catalog.fields.find(x=>x.key===k).available,false);
 assert.equal(c.catalog.fields.find(x=>x.key==='email.opened').available,true);
});
test('a real durable claim is bounded by Shopify expiry and an expired source cannot reserve a receipt',async t=>{
 const {db,f,rebind}=await setup(t);
 for(const brand of ['fish','aristo']){
  const p={campaign_id:brand==='fish'?100:200};
  // Seed an already-approved past schedule in this disposable fixture, without
  // weakening the installed lifecycle guard or waiting fifteen real minutes.
  await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(p.campaign_id)]);await tx.query("UPDATE campaigns SET send_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[p.campaign_id]);});
  await rebind(brand,rule());await f.approve();
  await db.query("INSERT INTO crm_audience_v2.regular_delivery_campaign(campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,envelope_from,account_id,region,configuration_set,enabled) SELECT b.campaign_id,b.binding_version,b.binding_hash,crm_audience_v2.regular_delivery_material(b.campaign_id),repeat('a',64),repeat('b',64),s.envelope_from,s.account_id,s.region,s.configuration_set,true FROM crm_audience_v2.campaign_binding b JOIN crm_audience_v2.regular_sender_policy s ON s.brand=b.brand WHERE b.campaign_id=$1",[p.campaign_id]);
  await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(p.campaign_id)]);await tx.query("UPDATE campaigns SET status='scheduled' WHERE id=$1",[p.campaign_id]);});
  await db.query("UPDATE campaigns SET status='running',max_subscriber_id=5 WHERE id=$1",[p.campaign_id]);
  await db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '26 hours'+interval '90 seconds' WHERE brand=$1",[brand]);
  const snap=(await db.query('SELECT to_jsonb(s) AS v FROM subscribers s WHERE id=1')).rows[0].v;
  const did=require('node:crypto').randomUUID(),args=[p.campaign_id,1,did,'a'.repeat(64),'b'.repeat(64),'contato@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),snap.email,'c'.repeat(64),JSON.stringify(snap)];
  const claim=await db.query('SELECT crm_audience_v2.regular_delivery_claim($1,$2,$3,$4,$5,$6,$7,$8,$9) AS v',args);
  assert.equal(claim.rows[0].v.should_send,true);const expires=(await db.query('SELECT crm_audience_v2.shopify_snapshot($1) AS s',[brand])).rows[0].s.expires_at;
  assert.equal(new Date(claim.rows[0].v.valid_until).toISOString(),new Date(expires).toISOString());
  assert.equal((await db.query('SELECT sent FROM campaigns WHERE id=$1',[p.campaign_id])).rows[0].sent,0);
  await db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours' WHERE brand=$1",[brand]);
  args[2]=require('node:crypto').randomUUID();await assert.rejects(()=>db.query('SELECT crm_audience_v2.regular_delivery_claim($1,$2,$3,$4,$5,$6,$7,$8,$9) AS v',args),/SEGMENT_SELECTION_UNAVAILABLE/);
 }
 assert.equal((await db.query("SELECT count(*)::integer AS n FROM shrigma_email_dispatch WHERE transport_state='in_flight'")).rows[0].n,2);
});
