'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const F=require('./segment-audience-store-fixture.cjs'),S=require('../n8n/growth/segment-audience-store.cjs'),Shopify=require('../n8n/growth/segment-shopify-facts.cjs');
const list=brand=>({acao:'segmentos_listar',brand,limit:50,offset:0});
test('public catalog demotes each advertised Shopify field whose semantic pin drifts',async t=>{
 const db=new PGlite();t.after(()=>db.close());const f=await F.setup(db),before=(await f.call(list('fish'))).body.catalog;
 for(const field of Shopify.FIELDS)assert.equal(before.fields.find(x=>x.key===field).available,true);
 await db.query("UPDATE crm_audience_v2.config SET catalog=jsonb_set(catalog,ARRAY['fields','1','source_hash'],to_jsonb($2::text)) WHERE brand=$1",['fish','f'.repeat(64)]);
 const one=(await f.call(list('fish'))).body.catalog;
 assert.equal(one.fields[1].key,'purchase.last_date');assert.equal(one.fields[1].available,false);
 for(const field of Shopify.FIELDS.filter(x=>x!=='purchase.last_date'))assert.equal(one.fields.find(x=>x.key===field).available,true);
 assert.notEqual(one.catalog_hash,before.catalog_hash);
 await db.query("UPDATE crm_audience_v2.config SET catalog=jsonb_set(jsonb_set(jsonb_set(catalog,ARRAY['fields','0','source_hash'],to_jsonb($2::text)),ARRAY['fields','1','source_hash'],to_jsonb($2::text)),ARRAY['fields','2','source_hash'],to_jsonb($2::text)) WHERE brand=$1",['fish','e'.repeat(64)]);
 const all=(await f.call(list('fish'))).body.catalog;
 assert.ok(Shopify.FIELDS.every(field=>all.fields.find(x=>x.key===field).available===false));
 assert.equal(all.current,true);assert.equal(all.shopify_snapshot,undefined);
});
test('the generic fixture uses exact Shopify pins but its match stub never invents an eligible Customer',async t=>{
 const db=new PGlite();t.after(()=>db.close());const f=await F.setup(db),catalog=(await f.call(list('aristo'))).body.catalog;
 for(const field of Shopify.FIELDS)assert.equal(catalog.fields.find(x=>x.key===field).source_hash,Shopify.sourceHash('aristo',field,catalog));
 assert.equal((await db.query("SELECT crm_audience_v2.shopify_customer_match('{\"op\":\"condition\",\"field\":\"purchase.count\",\"operator\":\"eq\",\"value\":0}'::jsonb,1,'aristo',$1) AS matched",[catalog.fields.find(x=>x.key==='purchase.count').source_hash])).rows[0].matched,null);
});
