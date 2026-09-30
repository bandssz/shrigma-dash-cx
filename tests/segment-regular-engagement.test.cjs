'use strict';
// Synthetic PGlite parity proof only. No worker, HTTP, transport or real contacts.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const A=require('../n8n/growth/segment-audience-contract.js'),S=require('../n8n/growth/segment-audience-store.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const {setupRegularPostgres}=require('./segment-listmonk-selection-regular-postgres-fixture.cjs');
const root=path.resolve(__dirname,'..'),sha=file=>createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const condition=(field,operator,value)=>({op:'condition',field,operator,value}),leaf=list_id=>({op:'in_list',list_id});
const rules={
 fish:{op:'and',rules:[leaf(22),condition('email.opened','within_last_days',7)]},
 aristo:{op:'or',rules:[leaf(31),condition('email.clicked','not_within_last_days',7)]}
};
const rawCatalog=brand=>({currency:null,timezone:null,shop_id:null,fields:['email.opened','email.clicked'].map(key=>({key,available:true,source_hash:Counter.engagementSourceHash(brand,key)})),products:[],origins:[]});

async function setup(t,rulesByBrand=rules){
 const db=new PGlite();t.after(()=>db.close());
 const catalogByBrand={fish:rawCatalog('fish'),aristo:rawCatalog('aristo')};
 const fixture=await setupRegularPostgres(db,{subscribersPerBrand:12,rulesByBrand,catalogByBrand});
 await db.exec(`INSERT INTO campaigns(id,name,attribs,messenger,type,status) VALUES
  (110,'Fish scoped','{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','email','regular','finished'),
  (210,'Aristo scoped','{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','email','regular','finished'),
  (310,'Fish legacy','{"crm":{"policy":"legacy","brand":"fish"}}','email','regular','finished'),
  (410,'Aristo legacy','{"crm":{"policy":"legacy","brand":"aristo"}}','email','regular','finished'),
  (510,'Fish channel','{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','whatsapp','regular','finished'),
  (610,'Aristo channel','{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','whatsapp','regular','finished'),
  (710,'Fish type','{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','email','tx','finished'),
  (810,'Aristo type','{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','email','tx','finished');
 INSERT INTO campaign_views VALUES
  (110,1,statement_timestamp()-interval '6 days 23 hours 59 minutes 59 seconds'),
  (110,2,statement_timestamp()-interval '1 day'),(110,3,statement_timestamp()-interval '1 day'),
  (110,4,statement_timestamp()-interval '6 days 23 hours 59 minutes 59 seconds'),
  (110,4,statement_timestamp()-interval '7 days 1 second'),
  (110,5,statement_timestamp()+interval '1 day'),(110,6,statement_timestamp()-interval '1 day'),(110,12,statement_timestamp()-interval '1 day'),
  (210,7,statement_timestamp()-interval '1 day'),(310,9,statement_timestamp()-interval '1 day'),
  (710,10,statement_timestamp()-interval '1 day'),(510,11,statement_timestamp()-interval '1 day'),
  (210,13,statement_timestamp()-interval '6 days 23 hours 59 minutes 59 seconds'),
  (210,14,statement_timestamp()-interval '1 day'),(210,15,statement_timestamp()-interval '1 day'),
  (210,16,statement_timestamp()-interval '7 days 1 second'),(210,17,statement_timestamp()+interval '1 day'),
  (210,18,statement_timestamp()-interval '1 day'),(210,24,statement_timestamp()-interval '1 day'),
  (110,19,statement_timestamp()-interval '1 day'),(410,21,statement_timestamp()-interval '1 day'),
  (810,22,statement_timestamp()-interval '1 day'),(610,23,statement_timestamp()-interval '1 day');
 INSERT INTO link_clicks VALUES
  (110,1,statement_timestamp()-interval '6 days 23 hours 59 minutes 59 seconds'),
  (110,2,statement_timestamp()-interval '1 day'),(110,3,statement_timestamp()-interval '1 day'),
  (110,4,statement_timestamp()-interval '7 days 1 second'),(110,5,statement_timestamp()+interval '1 day'),
  (110,6,statement_timestamp()-interval '1 day'),(110,12,statement_timestamp()-interval '1 day'),
  (210,7,statement_timestamp()-interval '1 day'),(310,9,statement_timestamp()-interval '1 day'),
  (710,10,statement_timestamp()-interval '1 day'),(510,11,statement_timestamp()-interval '1 day'),
  (210,13,statement_timestamp()-interval '6 days 23 hours 59 minutes 59 seconds'),
  (210,14,statement_timestamp()-interval '1 day'),(210,15,statement_timestamp()-interval '1 day'),
  (210,16,statement_timestamp()-interval '7 days 1 second'),(210,17,statement_timestamp()+interval '1 day'),
  (210,18,statement_timestamp()-interval '1 day'),(210,24,statement_timestamp()-interval '1 day'),
  (110,19,statement_timestamp()-interval '1 day'),(410,21,statement_timestamp()-interval '1 day'),
  (810,22,statement_timestamp()-interval '1 day'),(610,23,statement_timestamp()-interval '1 day');`);
 return {db,fixture,catalogByBrand};
}
const ids=rows=>rows.map(r=>r.id);
const unavailable=e=>e?.code==='55000'&&/SEGMENT_SELECTION_UNAVAILABLE/.test(e.message);

test('regular selector matches the published engagement counter for both brands and exact native scope',async t=>{
 let reportedHashes=false;
 for(const field of ['email.opened','email.clicked'])for(const operator of ['within_last_days','not_within_last_days']){
  const matrixRules={fish:{op:'and',rules:[leaf(22),condition(field,operator,7)]},aristo:{op:'or',rules:[leaf(31),condition(field,operator,7)]}};
  const {db,fixture}=await setup(t,matrixRules);
  if(!reportedHashes){assert.equal(fixture.regular.patched_sha256,'7abbff0c76a874e233f8cd6ae99c15b33632e34d1ac93b0b3ca337ed08868d9a');
   t.diagnostic(JSON.stringify({query_sha256:fixture.regular.patched_sha256,selection_sql_sha256:sha('n8n/growth/segment-listmonk-selection.sql'),readiness_sql_sha256:sha('n8n/growth/segment-regular-readiness.sql')}));reportedHashes=true;}
  for(const brand of ['fish','aristo'])for(const sourceField of ['email.opened','email.clicked']){
   const sql=(await db.query('SELECT crm_audience_v2.selection_engagement_source_hash($1,$2) AS value',[brand,sourceField])).rows[0].value;
   assert.equal(sql,Counter.engagementSourceHash(brand,sourceField));
  }
  const aggregate={};
  for(const [brand,base]of [['fish',17],['aristo',16]]){
   const current=await S.readCatalog(db.query.bind(db),brand),compiled=Counter.compileCount({definition:fixture.definitions[brand],baseListId:base,catalog:current.catalog});
   const row=(await db.query(compiled.text,compiled.values)).rows[0];assert.equal(row.source_confirmed,true);aggregate[brand]=Number(row.eligible_count);
  }
  await fixture.count();
  const selected={fish:ids((await fixture.batch(100)).rows),aristo:ids((await fixture.batch(200)).rows)};
  assert.deepEqual(selected.fish,operator==='within_last_days'?[12]:[9],field+' '+operator+' Fish AND');
  assert.deepEqual(selected.aristo,operator==='within_last_days'?[13,16,18,20,22,24]:[16,17,19,20,21,22,23,24],field+' '+operator+' Aristo OR');
  assert.deepEqual({fish:selected.fish.length,aristo:selected.aristo.length},aggregate,field+' '+operator+' counter parity');
  const native=(await db.query('SELECT id,to_send FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows;
  assert.deepEqual(native,[{id:100,to_send:aggregate.fish},{id:200,to_send:aggregate.aristo}]);
 }
});

test('engagement source drift and unavailable fields raise 55000 even for an empty batch',async t=>{
 const {db,fixture,catalogByBrand}=await setup(t);await fixture.count();
 const brokenFish=structuredClone(catalogByBrand.fish);brokenFish.fields.find(x=>x.key==='email.opened').source_hash='0'.repeat(64);
 await db.query('UPDATE crm_audience_v2.config SET catalog=$2::jsonb WHERE brand=$1',['fish',JSON.stringify(brokenFish)]);
 await assert.rejects(fixture.count(),unavailable);
 await assert.rejects(fixture.batch(100,{cursor:999999,max:999999}),unavailable);
 await db.query('UPDATE crm_audience_v2.config SET catalog=$2::jsonb WHERE brand=$1',['fish',JSON.stringify(catalogByBrand.fish)]);
 const brokenAristo=structuredClone(catalogByBrand.aristo);brokenAristo.fields.find(x=>x.key==='email.clicked').available=false;
 await db.query('UPDATE crm_audience_v2.config SET catalog=$2::jsonb WHERE brand=$1',['aristo',JSON.stringify(brokenAristo)]);
 await assert.rejects(fixture.count(),unavailable);
 await assert.rejects(fixture.batch(200,{cursor:999999,max:999999}),unavailable);
});

test('engagement SQL rejects null, wrong types and values outside the published day limits',async t=>{
 const {db}=await setup(t),match=async(rule,brand='fish')=>(await db.query(
  'SELECT crm_audience_v2.selection_engagement_match($1::jsonb,1,$2::text) AS value',[JSON.stringify(rule),brand])).rows[0].value;
 for(const value of [1,3650])assert.equal(typeof await match(condition('email.opened','within_last_days',value)),'boolean');
 for(const rule of [
  {op:'condition',field:null,operator:'within_last_days',value:7},
  {op:'condition',field:'email.opened',operator:null,value:7},
  {op:'condition',field:'email.opened',operator:'within_last_days',value:null},
  {op:'condition',field:'email.opened',operator:'within_last_days',value:'7'},
  {op:'condition',field:'email.opened',operator:'within_last_days',value:0},
  {op:'condition',field:'email.opened',operator:'within_last_days',value:3651},
  {op:'condition',field:'email.opened',operator:'within_last_days',value:1.5},
  {op:'condition',field:'email.unknown',operator:'within_last_days',value:7},
  {op:'condition',field:'email.opened',operator:'unknown',value:7},
  {op:'condition',field:'email.opened',value:7}
 ])assert.equal(await match(rule),null,JSON.stringify(rule));
 for(const brand of [null,'Fish','unknown'])assert.equal(await match(condition('email.opened','within_last_days',7),brand),null,String(brand));
 const hashes=(await db.query("SELECT crm_audience_v2.selection_engagement_source_hash(NULL,'email.opened') AS null_brand,crm_audience_v2.selection_engagement_source_hash('fish',NULL) AS null_field,crm_audience_v2.selection_engagement_source_hash('fish','email.unknown') AS unknown")).rows[0];
 assert.deepEqual(hashes,{null_brand:null,null_field:null,unknown:null});
});
