'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupRecordedComponent,rule}=require('./segment-recorded-origin-fixture.cjs'),A=require('./segment-audience-store-fixture.cjs');
const C=require('../n8n/growth/segment-audience-contract.js'),R=require('../n8n/growth/segment-recorded-origin.cjs'),Store=require('../n8n/growth/segment-audience-store.cjs');
async function setup(t){const db=new PGlite();t.after(()=>db.close());const x=await setupRecordedComponent(db);assert.equal(x.tier,'component-pglite-no-install-guard');return x;}
test('positive form receipt uses the same count, saved context, binding and native selection; old historical field stays unavailable',async t=>{
 const x=await setup(t);assert.equal((await x.record(1)).eligible,true);
 const c=await x.current('aristo');assert.equal(c.catalog.fields.find(f=>f.key==='signup.origin').available,false);assert.deepEqual(c.catalog.origins,[]);assert.equal(c.catalog.recorded_origins.length,2);
 for(const o of c.catalog.recorded_origins)assert.equal(o.provenance_hash,R.provenance(o));
 assert.equal(c.catalog.fields.find(f=>f.key===R.FIELD).source_hash,R.sourceHash('aristo'));assert.equal((await x.count()).eligible_count,1);
 const audience=await x.rebind('aristo',rule());await x.f.approve();assert.equal(await x.match('aristo',1),true);assert.equal(await x.match('aristo',2),false);
 const p=(await x.db.query('SELECT definition,context FROM crm_audience_v2.revision WHERE audience_id=$1',[audience.id])).rows[0];assert.deepEqual(Store.pins(p.definition,await x.current('aristo')),p.context);
 assert.equal(p.context.rules[0].recorded_origin_provenance_hash,c.catalog.recorded_origins[0].provenance_hash);
 assert.deepEqual((await x.current('fish')).catalog.recorded_origins,[]);assert.equal((await x.count(rule(),'fish')).source_confirmed,false);
 assert.equal((await x.count({op:'condition',field:'signup.origin',operator:'is',value:'vip_alma'})).source_confirmed,false);
 assert.throws(()=>C.normalize(A.definition('aristo',{...rule(),operator:'is_not'})),/AUDIENCE_CONDITION/);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
test('absence means no receipt in this scope; both form choice and current consent are rechecked',async t=>{
 const x=await setup(t);await x.record(1,'alma');await x.record(2,'desodorante');
 assert.equal((await x.count(rule('vip_alma'))).eligible_count,1);assert.equal((await x.count(rule('vip_desodorante'))).eligible_count,1);
 assert.equal((await x.count({op:'or',rules:[rule('vip_alma'),rule('vip_desodorante')]})).eligible_count,2);
 assert.equal((await x.count({op:'and',rules:[rule('vip_alma'),rule('vip_desodorante')]})).eligible_count,0);
 await x.rebind('aristo',rule());await x.f.approve();await x.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=16");
 assert.equal((await x.count()).eligible_count,0);assert.equal(await x.match('aristo',1),false);
 await x.db.exec("UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=2");assert.equal((await x.count(rule('vip_desodorante'))).eligible_count,0);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.recorded_origin_receipt')).rows[0].n,2);
});
test('disabled source is unknown and blocks a bound audience without rewriting its pins or native data',async t=>{
 const x=await setup(t);await x.record(1);const a=await x.rebind('aristo',rule());await x.f.approve();
 const before=(await x.db.query('SELECT context FROM crm_audience_v2.revision WHERE audience_id=$1',[a.id])).rows[0].context;
 await x.db.exec("UPDATE crm_audience_v2.recorded_origin_source SET enabled=false WHERE canonical_origin='vip_alma'");
 const c=await x.current('aristo');assert.equal(c.catalog.recorded_origins.find(o=>o.key==='vip_alma').available,false);assert.equal((await x.count()).source_confirmed,false);
 await assert.rejects(()=>x.match('aristo',1),/SEGMENT_SELECTION_UNAVAILABLE/);
 await x.db.query("SELECT crm_audience_v2.refresh_native_catalog('aristo')");assert.equal((await x.current('aristo')).catalog.recorded_origins.some(o=>o.key==='vip_alma'),false);
 assert.deepEqual((await x.db.query('SELECT context FROM crm_audience_v2.revision WHERE audience_id=$1',[a.id])).rows[0].context,before);
});
test('catalog and SQL agree on provenance tampering, optional old shape, and API cannot inspect private receipts or ingest',async t=>{
 const x=await setup(t),c=await x.current('aristo');
 for(const mutate of [o=>o.provenance_hash='0'.repeat(64),o=>o.producer_revision='b'.repeat(64),o=>o.coverage_started_at='2026-02-30T00:00:00.000Z',o=>o.extra=true]){
  const raw=structuredClone(c.catalog);mutate(raw.recorded_origins[0]);const source=Object.fromEntries(['currency','timezone','shop_id','fields','products','origins','recorded_origins'].map(k=>[k,raw[k]]));
  assert.throws(()=>Store.sourceConfig(source,'aristo'));assert.equal((await x.db.query('SELECT crm_audience_v2.selection_catalog_valid($1,$2) v',[JSON.stringify(source),'aristo'])).rows[0].v,false);
 }
 for(const table of ['recorded_origin_source','recorded_origin_receipt'])assert.equal((await x.db.query("SELECT has_table_privilege('crm_audience_api',$1,'SELECT') allowed",['crm_audience_v2.'+table])).rows[0].allowed,false);
 assert.equal((await x.db.query("SELECT has_function_privilege('crm_audience_api','crm_audience_v2.recorded_origin_subscribe_v2(text,text,boolean,text,uuid,text)','EXECUTE') allowed")).rows[0].allowed,false);
 await x.db.exec('SET ROLE crm_audience_api');try{assert.equal((await x.count()).eligible_count,0);}finally{await x.db.exec('RESET ROLE');}
});
