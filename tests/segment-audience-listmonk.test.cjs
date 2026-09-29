'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const A=require('../n8n/growth/segment-audience-contract.js'),R=require('../n8n/growth/segment-audience-review.cjs'),M=require('../n8n/growth/segment-audience-listmonk.cjs');
const leaf=list_id=>({op:'in_list',list_id});
const def=(brand='fish',rule=leaf(brand==='fish'?101:201))=>({schema_version:A.VERSION,brand,name:'Público sintético',rule});
const catalog=brand=>({brand,current:true,lists:(brand==='fish'?[17,101,102]:[16,201,202]).map(id=>({id,brand,available:true})),fields:[],products:[],origins:[]});
const engagementCatalog=brand=>({...catalog(brand),fields:['email.opened','email.clicked'].map(key=>({key,available:true,source_hash:M.engagementSourceHash(brand,key)}))});
const args=(brand='fish',rule)=>({definition:def(brand,rule),baseListId:brand==='fish'?17:16,catalog:catalog(brand)});
async function setup(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE lists(id integer PRIMARY KEY,tags varchar[],status text,optin text);
 CREATE TABLE subscribers(id integer PRIMARY KEY,status text);
	 CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer,status text,PRIMARY KEY(subscriber_id,list_id));
	 CREATE TABLE campaigns(id integer PRIMARY KEY,attribs jsonb NOT NULL,messenger text NOT NULL,type text NOT NULL);
	 CREATE TABLE campaign_views(campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);
	 CREATE TABLE link_clicks(campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);
 INSERT INTO lists VALUES (17,ARRAY['fish'],'active','single'),(101,ARRAY['fish'],'active','single'),(102,ARRAY['fish'],'active','double'),(16,ARRAY['aristo'],'active','single'),(201,ARRAY['aristo'],'active','single'),(202,ARRAY['aristo'],'active','double');
 INSERT INTO subscribers SELECT n,CASE n WHEN 4 THEN 'blocklisted' WHEN 5 THEN 'disabled' ELSE 'enabled' END FROM generate_series(1,8)n;
 INSERT INTO subscriber_lists SELECT n,l,'confirmed' FROM generate_series(1,6)n CROSS JOIN unnest(ARRAY[17,101,102])l;
 UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=2 AND list_id=102;
 UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=3 AND list_id=101 OR subscriber_id=6 AND list_id=17;
	 INSERT INTO subscriber_lists SELECT n,l,CASE WHEN n=8 AND l=202 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(7,8)n CROSS JOIN unnest(ARRAY[16,201,202])l;
	 INSERT INTO campaigns VALUES
	  (100,'{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','email','regular'),
	  (200,'{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','email','regular'),
	  (300,'{"crm":{"policy":"legacy","brand":"fish"}}','email','regular'),
	  (400,'{"crm":{"policy":"crm-campaign-v1","brand":"aristo"}}','email','regular'),
	  (500,'{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','email','tx'),
	  (600,'{"crm":{"policy":"crm-campaign-v1","brand":"fish"}}','whatsapp','regular');
	 INSERT INTO campaign_views VALUES
	  (100,1,now()-interval '2 days'),(100,2,now()-interval '40 days'),
	  (400,3,now()-interval '1 day'),(100,3,now()+interval '1 day'),
	  (500,2,now()-interval '1 day'),(600,3,now()-interval '1 day'),
	  (100,4,now()-interval '1 day'),(100,6,now()-interval '1 day'),
	  (200,7,now()-interval '3 days');
	 INSERT INTO link_clicks VALUES
	  (100,1,now()-interval '40 days'),(100,2,now()-interval '1 day'),
	  (300,3,now()-interval '1 day'),(200,8,now()-interval '2 days');`);
 const source=fs.readFileSync(path.join(__dirname,'../n8n/growth/campaign-provider.sql'),'utf8');
 await db.exec(source.slice(source.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_list_brand'),source.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_catalog')));
 const query=(text,values)=>db.query(text,values);
 return{db,query,count:p=>M.countAudience({...p,query})};
}
test('both brands: SQL respects nested E/OU, dedupe, confirmation, base opt-out and global suppression',async t=>{
 const {count}=await setup(t);
 for(const brand of ['fish','aristo']){
  const [a,b]=brand==='fish'?[101,102]:[201,202];
  for(const [op,expected]of [['and',1],['or',brand==='fish'?3:2]]){
   const r=await count(args(brand,{op,rules:[leaf(b),leaf(a),leaf(a)]}));
   assert.equal(r.eligible_count,expected);assert.equal(r.source_confirmed,true);assert.equal(r.unknown_reason,null);assert.equal(r.definition_hash,R.digest(A.normalize(r.definition)));assert.equal(r.transport_supported,false);
   assert.doesNotMatch(JSON.stringify(r),/subscriber_id|subject_ref|email|Bearer/);
  }
  const nested={op:'and',rules:[leaf(b),{op:'or',rules:[leaf(a),leaf(b)]}]};
  assert.equal((await count(args(brand,nested))).eligible_count,brand==='fish'?2:1);
 }
});
test('fresh source status overrides a stale catalog; changed base/leaf ownership is unknown, not zero',async t=>{
 const {db,count}=await setup(t);
 const p=args();assert.equal((await count(p)).eligible_count,2);
 await db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=17");
 assert.equal((await count(p)).eligible_count,1);
 for(const change of ["UPDATE lists SET tags=ARRAY['aristo'] WHERE id=101","UPDATE lists SET status='archived' WHERE id=17"]){
  await db.exec(change);const r=await count(p);assert.equal(r.source_confirmed,false);assert.equal(r.eligible_count,null);assert.equal(r.unknown_reason,'list_source_unavailable');
 }
});
test('native single/double transitions recheck current consent, absence remains a proven nonmember for lists only',async t=>{
 const {db,count}=await setup(t);const p=args('fish',leaf(102));
 assert.equal((await count(p)).eligible_count,2);
 await db.exec("UPDATE lists SET optin='single' WHERE id=102");assert.equal((await count(p)).eligible_count,3);
 await db.exec("UPDATE subscriber_lists SET status='unconfirmed' WHERE list_id=17;UPDATE lists SET optin='double' WHERE id=17");
 const empty=await count(p);assert.equal(empty.eligible_count,0);assert.equal(empty.source_confirmed,true);
});
test('Shopify/origin/engagement fields cannot acquire a false count, even with forged available flags or mixed OR',async t=>{
 const {count}=await setup(t);
 for(const condition of [
  {op:'condition',field:'purchase.count',operator:'eq',value:0},
  {op:'condition',field:'purchase.amount',operator:'gte',value:'100'},
  {op:'condition',field:'purchase.last_date',operator:'before',value:'2026-01-01'},
  {op:'condition',field:'purchase.product',operator:'not_purchased',value:'gid://shopify/Product/1'},
  {op:'condition',field:'signup.origin',operator:'is',value:'popup'},
  {op:'condition',field:'email.opened',operator:'not_within_last_days',value:30}
 ]){
  const p=args('fish',{op:'or',rules:[leaf(101),condition]});p.catalog.fields=Object.keys(A.FIELDS).map(key=>({key,available:true}));
  const r=await count(p);assert.equal(r.eligible_count,null);assert.equal(r.source_confirmed,false);assert.equal(r.unknown_reason,'external_source_unavailable');
 }
});
test('registered opens and clicks use the trailing window and only panel campaigns of the selected brand',async t=>{
 const {count}=await setup(t),condition=(field,operator,value)=>({op:'condition',field,operator,value});
 for(const [brand,field,operator,days,expected]of [
  ['fish','email.opened','within_last_days',30,1],['fish','email.opened','not_within_last_days',30,2],
  ['fish','email.clicked','within_last_days',7,1],['aristo','email.opened','within_last_days',7,1],
  ['aristo','email.clicked','within_last_days',7,1]
 ]){
  const p=args(brand,condition(field,operator,days));p.catalog=engagementCatalog(brand);
  const r=await count(p);assert.equal(r.source_confirmed,true);assert.equal(r.eligible_count,expected);assert.equal(r.unknown_reason,null);
 }
});
test('engagement composes with lists in three values; unsupported leaves only block unresolved subjects',async t=>{
 const {count}=await setup(t),clicked={op:'condition',field:'email.clicked',operator:'within_last_days',value:7},purchase={op:'condition',field:'purchase.count',operator:'gt',value:0};
 const mixed=args('fish',{op:'or',rules:[leaf(101),clicked]});mixed.catalog=engagementCatalog('fish');
 assert.equal((await count(mixed)).eligible_count,2);
 const unresolved=args('fish',{op:'or',rules:[leaf(101),purchase]});unresolved.catalog=engagementCatalog('fish');
 const unknown=await count(unresolved);assert.equal(unknown.source_confirmed,false);assert.equal(unknown.eligible_count,null);assert.equal(unknown.unknown_reason,'external_source_unavailable');
 const determined=args('fish',{op:'or',rules:[leaf(17),purchase]});determined.catalog=engagementCatalog('fish');
 const known=await count(determined);assert.equal(known.source_confirmed,true);assert.equal(known.eligible_count,3);assert.equal(known.unknown_reason,null);
});
test('engagement requires the exact exported source semantics hash',async t=>{
 const {count}=await setup(t),p=args('fish',{op:'condition',field:'email.clicked',operator:'within_last_days',value:7});p.catalog=engagementCatalog('fish');
 assert.match(M.engagementSourceHash('fish','email.clicked'),/^[a-f0-9]{64}$/);assert.notEqual(M.engagementSourceHash('fish','email.clicked'),M.engagementSourceHash('aristo','email.clicked'));assert.ok(Object.isFrozen(M.ENGAGEMENT_SOURCE_SEMANTICS));assert.ok(Object.isFrozen(M.ENGAGEMENT_SOURCE_SEMANTICS.events));assert.throws(()=>M.engagementSourceHash('fish','purchase.count'),{code:'AUDIENCE_COUNT_SOURCE'});p.catalog.fields[1].source_hash='0'.repeat(64);
 const r=await count(p);assert.equal(r.source_confirmed,false);assert.equal(r.eligible_count,null);assert.equal(r.unknown_reason,'external_source_unavailable');
});
test('engagement window is an exact duration and does not depend on the database session timezone',async t=>{
 const {db,count}=await setup(t),p=args('fish',{op:'condition',field:'email.opened',operator:'within_last_days',value:30});p.catalog=engagementCatalog('fish');
 const compiled=M.compileCount(p);assert.match(compiled.text,/86400\*interval '1 second'/);assert.doesNotMatch(compiled.text,/make_interval|interval '24 hours'/);
 await db.exec("SET TIME ZONE 'America/New_York'");const west=await count(p);
 await db.exec("SET TIME ZONE 'Asia/Tokyo'");const east=await count(p);
 assert.equal(west.eligible_count,1);assert.equal(east.eligible_count,1);
});
test('compiler is bounded and parameterized; cross-brand catalog and injected definitions fail before SQL',()=>{
 const p=args();const compiled=M.compileCount({...p,definition:{...p.definition,name:"Robert'); DROP TABLE subscribers;--"}});
 assert.doesNotMatch(compiled.text,/Robert|DROP TABLE/);assert.equal(compiled.values[0],'fish');assert.equal(M.ENABLED,false);
 for(const bad of [{...p,baseListId:'17 OR true'},{...p,catalog:catalog('aristo')},{...p,definition:{...p.definition,rule:leaf('101 OR true')}}])assert.throws(()=>M.compileCount(bad));
 for(const change of [c=>c.current=false,c=>c.lists.push({...c.lists[0]}),c=>c.lists[1].available=false]){const q=args();change(q.catalog);assert.equal(M.compileCount(q).unknown_reason,'list_source_unavailable');}
});
test('malformed, stale, unsafe-sized or contradictory SQL results are rejected without leaking raw errors',async()=>{
 const valid={source_confirmed:true,eligible_count:'2',checked_at:new Date().toISOString()};
 for(const row of [{...valid,eligible_count:'9007199254740992'},{...valid,eligible_count:'-1'},{...valid,eligible_count:NaN},{...valid,source_confirmed:false},{...valid,checked_at:'2001-01-01'},{...valid,secret:'private'}, {...valid,source_confirmed:'true'}]){
  let calls=0;await assert.rejects(M.countAudience({...args(),query:async()=>{calls++;return {rows:[row]};}}),{code:'AUDIENCE_COUNT_UNCONFIRMED'});assert.equal(calls,1);
 }
 await assert.rejects(M.countAudience({...args(),query:async()=>{throw Error('private password subscriber payload');}}),e=>e.code==='AUDIENCE_COUNT_UNCONFIRMED'&&!e.message.includes('private'));
 const unavailable=args();unavailable.catalog.current=false;await assert.rejects(M.countAudience({...unavailable,query:async()=>({rows:[valid]})}),{code:'AUDIENCE_COUNT_UNCONFIRMED'});
});
test('abort and deadline signal query cancellation, never retry and reject late successes',async()=>{
 for(const external of [false,true]){
  const controller=new AbortController();let calls=0,seen,finish;
  const pending=M.countAudience({...args(),signal:controller.signal,timeoutMs:20,query:(_t,_v,{signal})=>{calls++;seen=signal;return new Promise(resolve=>finish=resolve);}});
  if(external)setTimeout(()=>controller.abort(),5);
  await assert.rejects(pending,{code:external?'AUDIENCE_COUNT_ABORTED':'AUDIENCE_COUNT_TIMEOUT'});assert.equal(calls,1);assert.equal(seen.aborted,true);
  finish({rows:[{source_confirmed:true,eligible_count:1,checked_at:new Date().toISOString()}]});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 }
 const controller=new AbortController();controller.abort();await assert.rejects(M.countAudience({...args(),signal:controller.signal,query:()=>{throw Error('must not query');}}),{code:'AUDIENCE_COUNT_ABORTED'});
});
