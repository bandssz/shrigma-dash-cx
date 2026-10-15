'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const S=require('../n8n/growth/segment-audience-store.cjs');
const F=require('./segment-audience-store-fixture.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const Shopify=require('../n8n/growth/segment-shopify-facts.cjs');
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture(brand){
 const at=Date.parse('2026-10-15T23:00:00Z'),base=brand==='fish'?17:16,catalog=F.source(brand);
 for(const field of catalog.fields)if(['email.opened','email.clicked'].includes(field.key))field.source_hash=Counter.engagementSourceHash(brand,field.key);
 const original={brand,enabled:true,base_list_id:base,revision:7,catalog,checked_at:new Date(at-600000).toISOString(),expires_at:new Date(at-360000).toISOString()};
 const source={current:true,started_at:new Date(at-3600000).toISOString(),observed_at:new Date(at).toISOString(),expires_at:new Date(at-3600000+93600000).toISOString(),customers:0,mapped:0,unresolved:0};
 const controls={current:true,readAt:at+1000,source,throwPin:false},trace=[];
 const query=async(text,values)=>{
  trace.push({text,values});
  if(text===S.SQL.config)return {rows:[{...clone(original),read_at:new Date(controls.readAt).toISOString(),catalog_observed_at:new Date(at).toISOString(),catalog_valid_until:new Date(at+240000).toISOString()}]};
  if(text===S.SQL.lists)return {rows:[{id:base,name:'Synthetic '+brand,status:'active',optin:'single'}]};
  if(text===S.SQL.shopifyCurrent){if(controls.throwPin)throw Error('PRIVATE_DATABASE_CAUSE');return {rows:[{current:controls.current}]};}
  if(text===S.SQL.shopify)return {rows:[{source:clone(controls.source)}]};
  throw Error('UNEXPECTED_CATALOG_QUERY');
 };
 return {at,base,original,controls,trace,query};
}
for(const brand of ['fish','aristo']){
 test(brand+': expired cache is observed without UPDATE; original metadata and 26h source are preserved',async()=>{
  const f=fixture(brand),saved=clone(f.original),first=await S.readCatalog(f.query,brand);f.controls.readAt+=3000;
  const second=await S.readCatalog(f.query,brand);
  assert.equal(first.ready,true);assert.equal(second.ready,true);assert.equal(first.expires_at,second.expires_at);
  assert.equal(first.expires_at,new Date(f.at+240000).toISOString());assert.equal(first.metadataSnapshot,second.metadataSnapshot);
  assert.deepEqual(f.original,saved);assert.ok(Date.parse(f.original.expires_at)<f.controls.readAt);
  assert.equal(first.catalog.shopify_snapshot.expires_at,f.controls.source.expires_at);
  assert.equal(first.catalog.checked_at,new Date(f.at+1000).toISOString());
  assert.ok(f.trace.every(x=>/^SELECT /.test(x.text)));assert.ok(f.trace.every(x=>!x.text.includes('refresh_native_catalog')));
  assert.equal(f.trace.filter(x=>x.text===S.SQL.shopifyCurrent).length,Shopify.FIELDS.length*2);
 });
 test(brand+': current pin and real Shopify expiry override retained available flags, including negative conditions',async()=>{
  for(const current of [false,null]){
   const f=fixture(brand);f.controls.current=current;f.controls.source.current=false;
   const read=await S.readCatalog(f.query,brand);assert.equal(read.ready,true);
   assert.ok(read.catalog.fields.filter(x=>Shopify.FIELDS.includes(x.key)).every(x=>x.available===false));
   assert.equal(read.catalog.shopify_snapshot.current,false);
   const d=F.definition(brand,{op:'condition',field:'purchase.product',operator:'not_purchased',value:f.original.catalog.products[0].id});
   const plan=Counter.compileCount({definition:d,baseListId:f.base,catalog:read.catalog});
   assert.equal(plan.unknown_reason,'external_source_unavailable');
   assert.equal(require('../n8n/growth/segment-audience-contract.js').checkCatalog(d,read.catalog).ok,false);
  }
 });
 test(brand+': email pin mismatch and unavailable source are never enabled by observation',async()=>{
  const f=fixture(brand);f.original.catalog.fields.find(x=>x.key==='email.opened').source_hash='a'.repeat(64);
  f.original.catalog.fields.find(x=>x.key==='email.clicked').available=false;
  const read=await S.readCatalog(f.query,brand);
  assert.equal(read.catalog.fields.find(x=>x.key==='email.opened').available,false);
  assert.equal(read.catalog.fields.find(x=>x.key==='email.clicked').available,false);
 });
 test(brand+': malformed metadata and elapsed observation fail closed; metadata fence is distinct from semantic hash',async()=>{
  const f=fixture(brand),first=await S.readCatalog(f.query,brand);
  f.original.checked_at=new Date(f.at-660000).toISOString();f.original.expires_at=new Date(f.at-420000).toISOString();
  const changed=await S.readCatalog(f.query,brand);assert.equal(first.catalog.catalog_hash,changed.catalog.catalog_hash);assert.notEqual(first.metadataSnapshot,changed.metadataSnapshot);
  f.original.expires_at=f.original.checked_at;assert.equal((await S.readCatalog(f.query,brand)).ready,false);
  f.original.expires_at=new Date(f.at-420000).toISOString();f.controls.readAt=f.at+240001;assert.equal((await S.readCatalog(f.query,brand)).ready,false);
  f.controls.readAt=f.at+1000;f.controls.throwPin=true;await assert.rejects(S.readCatalog(f.query,brand),/PRIVATE_DATABASE_CAUSE/);
 });
}
test('application does not wire a metadata refresher into audience, binding or regular admission',()=>{
 const fs=require('node:fs'),path=require('node:path'),s=fs.readFileSync(path.join(__dirname,'../services/crm-audience/main.cjs'),'utf8');
 assert.doesNotMatch(s,/refresh_native_catalog|refreshCatalog/);
});
