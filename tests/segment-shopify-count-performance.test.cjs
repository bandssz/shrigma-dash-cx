'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const F=require('./segment-shopify-products-fixture.cjs'),Store=require('../n8n/growth/segment-audience-store.cjs'),C=require('../n8n/growth/segment-audience-listmonk.cjs'),A=require('../n8n/growth/segment-audience-contract.js');
const migration=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-count-performance.sql'),'utf8');
const leaf=(field,operator,value)=>({op:'condition',field,operator,value}),confirmed=rule=>({op:'confirmed',rule});
const definition=(rule,brand='fish')=>({schema_version:'crm-audience-v2',brand,name:'Dados confirmados',rule});
async function setup(t){const db=new PGlite();t.after(()=>db.close());const x=await F.setupProducts(db);await db.exec(migration);await db.exec("INSERT INTO subscribers(id,status,email) VALUES(6,'enabled','absent@example.test');INSERT INTO subscriber_lists VALUES(6,17,'confirmed'),(6,16,'confirmed')");return x;}
async function count(x,b,r){const c=await Store.readCatalog(x.db.query.bind(x.db),b);return C.countAudience({definition:definition(r,b),baseListId:b==='fish'?17:16,catalog:c.catalog,query:x.db.query.bind(x.db)});}
async function oracle(x,b,r,isConfirmed){
 const c=await Store.readCatalog(x.db.query.bind(x.db),b),pin=c.catalog.fields.find(f=>f.key===r.field).source_hash,listId=b==='fish'?17:16;
 const row=(await x.db.query(`WITH eligible AS MATERIALIZED (
  SELECT s.id FROM subscribers s JOIN subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$4
  JOIN lists l ON l.id=sl.list_id AND l.status::text='active' AND shrigma_campaign_list_brand(l)=$2
  WHERE s.status::text='enabled' AND ((l.optin::text='double' AND sl.status::text='confirmed') OR (l.optin::text='single' AND sl.status::text IN('confirmed','unconfirmed')))
 ), evaluated AS (SELECT e.id,m.matched FROM eligible e LEFT JOIN crm_audience_v2.shopify_matches_for_rule($1,$2,$3) m ON m.subscriber_id=e.id),
 summary AS (SELECT count(*) FILTER(WHERE matched IS TRUE)::bigint matched_count,count(*) FILTER(WHERE matched IS NULL)::bigint unknown_count FROM evaluated)
 SELECT CASE WHEN $5 THEN true ELSE unknown_count=0 END source_confirmed,CASE WHEN $5 THEN matched_count WHEN unknown_count=0 THEN matched_count ELSE NULL::bigint END eligible_count FROM summary`,[JSON.stringify(r),b,pin,listId,isConfirmed])).rows[0];
 return{source_confirmed:row.source_confirmed,eligible_count:row.eligible_count===null?null:Number(row.eligible_count)};
}
test('confirmed is an explicit Shopify-only choice; old definitions and leaf pins retain their exact shape',()=>{
 const r=leaf('purchase.count','eq',0);assert.deepEqual(A.normalize(definition(r)).rule,r);assert.deepEqual(A.leaves(definition(confirmed(r))),A.leaves(definition(r)));
 for(const bad of [{op:'in_list',list_id:17},leaf('email.clicked','within_last_days',30),leaf('signup.origin','is','popup'),{op:'and',rules:[r]}])assert.throws(()=>A.normalize(definition(confirmed(bad))),{code:'AUDIENCE_CONFIRMED_RULE'});
 assert.throws(()=>A.normalize(definition({op:'confirmed',rule:r,scope:'invented'})),{code:'AUDIENCE_FIELDS'});
});
for(const brand of ['fish','aristo'])test(brand+': unknown identity stays unknown in strict rules and is excluded only in an explicitly confirmed rule',async t=>{
 const x=await setup(t);await x.ingestProducts(F.productEvidence(brand,[{id:1,products:[]},{id:2,products:[101]}]));await x.enableProducts(brand);
 const never=leaf('purchase.count','eq',0);assert.equal((await count(x,brand,never)).source_confirmed,false);
 const safe=await count(x,brand,confirmed(never));assert.equal(safe.source_confirmed,true);assert.equal(safe.eligible_count,1);
 await x.rebind(brand,confirmed(never));await x.f.approve();assert.equal(await x.match(brand,1),true);assert.equal(await x.match(brand,2),false);assert.equal(await x.match(brand,6),false);
 await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[brand==='fish'?17:16]);assert.equal((await count(x,brand,confirmed(never))).eligible_count,0);assert.equal(await x.match(brand,1),false);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
test('incomplete product history cannot enter a confirmed negative audience; recorded positive proof still matches',async t=>{
 const x=await setup(t);await x.ingestProducts(F.productEvidence('fish',[{id:1,products:[101,null]},{id:2,products:[202]}]));await x.enableProducts('fish');
 const product=(n,op='purchased')=>leaf('purchase.product',op,'gid://shopify/Product/'+n);
 assert.equal((await count(x,'fish',product(202,'not_purchased'))).eligible_count,null);
 assert.equal((await count(x,'fish',confirmed(product(202,'not_purchased')))).eligible_count,0);
 assert.equal((await count(x,'fish',confirmed(product(101)))).eligible_count,1);
 await x.rebind('fish',confirmed(product(202,'not_purchased')));await x.f.approve();assert.equal(await x.match('fish',1),false);assert.equal(await x.match('fish',6),false);
});
test('expired or disabled whole source still blocks confirmed rules, including an empty or OR-list base',async t=>{
 const x=await setup(t);await x.ingestProducts(F.productEvidence());await x.enableProducts('fish');const r=confirmed(leaf('purchase.count','gt',0));
 await x.rebind('fish',r);await x.f.approve();await x.db.exec("UPDATE crm_audience_v2.shopify_source SET enabled=false WHERE brand='fish'");
 assert.equal((await count(x,'fish',r)).source_confirmed,false);await assert.rejects(()=>x.match('fish',1),/SEGMENT_SELECTION_UNAVAILABLE/);
 const mixed={op:'or',rules:[r,{op:'in_list',list_id:17}]};assert.equal((await count(x,'fish',mixed)).source_confirmed,false);
 await x.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");assert.equal((await count(x,'fish',r)).source_confirmed,false);
});
test('aggregate wrapper preserves mixed list/email/Shopify three-value truth tables and leaves pure email on its established path',async t=>{
 const x=await setup(t);await x.ingestProducts(F.productEvidence('fish',[{id:1,products:[]},{id:2,products:[101]}]));await x.enableProducts('fish');await x.db.exec("UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=2 AND list_id=101");
 await x.db.exec("INSERT INTO campaign_views(campaign_id,subscriber_id,created_at) VALUES(100,1,statement_timestamp()-interval '1 day')");
 const buyers=leaf('purchase.count','gt',0),opened=leaf('email.opened','within_last_days',7),base={op:'in_list',list_id:17},other={op:'in_list',list_id:101};
 const falseAndUnknown={op:'and',rules:[buyers,other]},trueOrUnknown={op:'or',rules:[buyers,base]};
 const a=await count(x,'fish',falseAndUnknown),o=await count(x,'fish',trueOrUnknown),mixed=await count(x,'fish',{op:'or',rules:[{op:'and',rules:[confirmed(buyers),opened]},other]});
 assert.deepEqual([a.source_confirmed,a.eligible_count],[true,1]);assert.deepEqual([o.source_confirmed,o.eligible_count],[true,3]);assert.deepEqual([mixed.source_confirmed,mixed.eligible_count],[true,2]);
 const catalog=(await Store.readCatalog(x.db.query.bind(x.db),'fish')).catalog,pure=C.compileCount({definition:definition(opened),baseListId:17,catalog});assert.doesNotMatch(pure.text,/shopify_count_for_rule/);
});
test('aggregate agrees with the established matcher for every strict and confirmed scalar/product operator',async t=>{
 const x=await setup(t);await x.ingestProducts(F.productEvidence('fish',[{id:1,products:[101,null]},{id:2,products:[202]}]));await x.enableProducts('fish');
 // 01:00Z is 22:00 on the previous calendar day in America/Sao_Paulo.
 const rules=[...['eq','gt','gte','lt','lte'].flatMap(op=>[leaf('purchase.count',op,1),leaf('purchase.amount',op,'50.00')]),...['eq','before','on_or_before','after','on_or_after'].map(op=>leaf('purchase.last_date',op,'2026-08-31')),...['purchased','not_purchased'].flatMap(op=>[leaf('purchase.product',op,'gid://shopify/Product/101'),leaf('purchase.product',op,'gid://shopify/Product/202')])];
 for(const changed of [false,true]){
  if(changed)await x.db.exec('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=1');
  for(const r of rules){
   for(const isConfirmed of [false,true]){
    const actual=await count(x,'fish',isConfirmed?confirmed(r):r),expected=await oracle(x,'fish',r,isConfirmed);
    assert.deepEqual({source_confirmed:actual.source_confirmed,eligible_count:actual.eligible_count},expected,JSON.stringify({r,isConfirmed,changed}));
   }
  }
 }
 await x.db.exec("UPDATE crm_audience_v2.shopify_customer_fact SET orders_count=0,amount_spent=50,last_order_at='2026-09-01T01:00:00Z' WHERE brand='fish' AND subscriber_id=2");
 for(const r of [leaf('purchase.count','eq',0),leaf('purchase.amount','gt','0'),leaf('purchase.last_date','eq','2026-08-31')])for(const isConfirmed of [false,true]){
  const actual=await count(x,'fish',isConfirmed?confirmed(r):r),expected=await oracle(x,'fish',r,isConfirmed);
  assert.deepEqual({source_confirmed:actual.source_confirmed,eligible_count:actual.eligible_count},expected,JSON.stringify({inconsistentZero:true,r,isConfirmed}));
 }
 const privileges=(await x.db.query("SELECT has_table_privilege('crm_audience_api','crm_audience_v2.shopify_customer_fact','SELECT') AS private,has_function_privilege('crm_audience_api','crm_audience_v2.shopify_matches_for_rule(jsonb,text,text)','EXECUTE') AS helper,has_function_privilege('crm_audience_api','crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)','EXECUTE') AS aggregate")).rows[0];
 assert.deepEqual(privileges,{private:false,helper:false,aggregate:true});
});

test('guarded upgrade is data-neutral, preserves ACL and refuses reapplication',async t=>{
 const db=new PGlite();t.after(()=>db.close());await F.setupProducts(db);
 const before=(await db.query("SELECT jsonb_agg(to_jsonb(s) ORDER BY brand) sources,(SELECT count(*) FROM crm_audience_v2.shopify_customer_fact) facts,(SELECT count(*) FROM crm_audience_v2.shopify_identity) identities FROM crm_audience_v2.shopify_source s")).rows[0];
 await db.exec(migration);
 const after=(await db.query("SELECT jsonb_agg(to_jsonb(s) ORDER BY brand) sources,(SELECT count(*) FROM crm_audience_v2.shopify_customer_fact) facts,(SELECT count(*) FROM crm_audience_v2.shopify_identity) identities FROM crm_audience_v2.shopify_source s")).rows[0];
 assert.deepEqual(after,before);
 const metadata=(await db.query("SELECT proname,md5(prosrc) md5,prosecdef,provolatile,proconfig,has_function_privilege('crm_audience_api',oid,'EXECUTE') api_execute FROM pg_proc WHERE oid IN(to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)'),to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')) ORDER BY proname")).rows;
 assert.deepEqual(metadata,[
  {proname:'shopify_count_for_rule',md5:'3f037e001887923c953521334697ba9e',prosecdef:true,provolatile:'s',proconfig:['search_path=pg_catalog'],api_execute:true},
  {proname:'shopify_count_rule_sql',md5:'3d8b7d13f82477ce803a27dc7db9b74e',prosecdef:true,provolatile:'i',proconfig:['search_path=pg_catalog'],api_execute:false}
 ]);
 await assert.rejects(()=>db.exec(migration),/SHOPIFY_COUNT_PERFORMANCE_BASE_DRIFT/);
});

test('guarded upgrade rejects function drift and enabled selection runtime before replacement',async t=>{
 const drift=new PGlite();t.after(()=>drift.close());await F.setupProducts(drift);
 const aggregate=(await drift.query("SELECT md5(prosrc) md5 FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')")).rows[0].md5;
 await drift.exec("CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_count_rule_sql(rule jsonb,ready_leaves jsonb,depth integer DEFAULT 1) RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT NULL::text'");
 await assert.rejects(()=>drift.exec(migration),/SHOPIFY_COUNT_PERFORMANCE_BASE_DRIFT/);
 assert.equal((await drift.query("SELECT md5(prosrc) md5 FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')")).rows[0].md5,aggregate);
 const active=new PGlite();t.after(()=>active.close());await F.setupProducts(active);await active.exec('UPDATE crm_audience_v2.selection_runtime SET enabled=true');
 await assert.rejects(()=>active.exec(migration),/SHOPIFY_COUNT_PERFORMANCE_REQUIRES_WORKER_OFF/);
 assert.equal((await active.query("SELECT md5(prosrc) md5 FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')")).rows[0].md5,'9c84c481046870b19c2603901168fe3c');
});
