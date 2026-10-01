'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupRecordedComponent,rule}=require('./segment-recorded-origin-fixture.cjs');
const {productEvidence}=require('./segment-shopify-products-fixture.cjs');
const product=(id,operator='purchased')=>({op:'condition',field:'purchase.product',operator,value:'gid://shopify/Product/'+id});
async function setup(t,records){const db=new PGlite();t.after(()=>db.close());const x=await setupRecordedComponent(db);assert.equal(x.tier,'component-pglite-no-install-guard');await x.record(1);await x.ingestProducts(productEvidence('aristo',records));await x.enableProducts('aristo');return x;}

test('recorded form and purchased product compose in one saved audience without replacing either source pin',async t=>{
 const x=await setup(t,[{id:1,products:[101]},{id:2,products:[202]}]);
 const c=await x.current('aristo'),origin=c.catalog.recorded_origins.find(o=>o.key==='vip_alma');
 const combined={op:'and',rules:[rule(),product(101)]};
 assert.equal((await x.count(combined)).eligible_count,1);
 const saved=await x.rebind('aristo',combined);await x.f.approve();
 assert.equal(await x.match('aristo',1),true);assert.equal(await x.match('aristo',2),false);
 const context=(await x.db.query('SELECT context FROM crm_audience_v2.revision WHERE audience_id=$1 AND version=$2',[saved.id,saved.version])).rows[0].context;
 assert.equal(context.rules.find(r=>r.recorded_origin_provenance_hash).recorded_origin_provenance_hash,origin.provenance_hash);
 await x.ingestProducts(productEvidence('aristo',[{id:1,products:[303]},{id:2,products:[101]}],'22'));
 await x.db.query("SELECT crm_audience_v2.refresh_native_catalog('aristo')");
 assert.deepEqual((await x.current('aristo')).catalog.recorded_origins,c.catalog.recorded_origins);
 assert.equal((await x.count(combined)).eligible_count,0);
 await x.rebind('aristo',combined);await x.f.approve();assert.equal(await x.match('aristo',1),false);assert.equal(await x.match('aristo',2),false);
 assert.deepEqual((await x.db.query('SELECT context FROM crm_audience_v2.revision WHERE audience_id=$1 AND version=$2',[saved.id,saved.version])).rows[0].context,context);
});

test('an accepted form cannot turn incomplete product history into never purchased; OR and consent keep their meanings',async t=>{
 const x=await setup(t,[{id:1,products:[101,null]},{id:2,products:[202]}]);
 const unknown={op:'and',rules:[rule(),product(202,'not_purchased')]};
 assert.equal((await x.count(unknown)).source_confirmed,false);
 await x.rebind('aristo',unknown);await x.f.approve();await assert.rejects(()=>x.match('aristo',1),/SEGMENT_SELECTION_UNAVAILABLE/);
 const known={op:'or',rules:[rule(),product(202,'not_purchased')]};
 assert.equal((await x.count(known)).eligible_count,1);
 await x.rebind('aristo',known);await x.f.approve();assert.equal(await x.match('aristo',1),true);assert.equal(await x.match('aristo',2),false);
 await x.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=16 AND subscriber_id=1");
 assert.equal((await x.count(known)).eligible_count,0);assert.equal(await x.match('aristo',1),false);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
