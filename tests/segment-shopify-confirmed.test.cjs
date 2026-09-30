'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const F=require('./segment-shopify-products-fixture.cjs'),Store=require('../n8n/growth/segment-audience-store.cjs'),C=require('../n8n/growth/segment-audience-listmonk.cjs'),A=require('../n8n/growth/segment-audience-contract.js');
const leaf=(field,operator,value)=>({op:'condition',field,operator,value}),confirmed=rule=>({op:'confirmed',rule});
const definition=(rule,brand='fish')=>({schema_version:'crm-audience-v2',brand,name:'Dados confirmados',rule});
async function setup(t){const db=new PGlite();t.after(()=>db.close());const x=await F.setupProducts(db);await db.exec("INSERT INTO subscribers(id,status,email) VALUES(6,'enabled','absent@example.test');INSERT INTO subscriber_lists VALUES(6,17,'confirmed'),(6,16,'confirmed')");return x;}
async function count(x,b,r){const c=await Store.readCatalog(x.db.query.bind(x.db),b);return C.countAudience({definition:definition(r,b),baseListId:b==='fish'?17:16,catalog:c.catalog,query:x.db.query.bind(x.db)});}
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
test('bulk helper agrees with the established strict matcher for every scalar/product operator and native identity change',async t=>{
 const x=await setup(t);await x.ingestProducts(F.productEvidence('fish',[{id:1,products:[101,null]},{id:2,products:[202]}]));await x.enableProducts('fish');
 const rules=[...['eq','gt','gte','lt','lte'].flatMap(op=>[leaf('purchase.count',op,1),leaf('purchase.amount',op,'50.00')]),...['eq','before','on_or_before','after','on_or_after'].map(op=>leaf('purchase.last_date',op,'2026-09-01')),...['purchased','not_purchased'].flatMap(op=>[leaf('purchase.product',op,'gid://shopify/Product/101'),leaf('purchase.product',op,'gid://shopify/Product/202')])];
 for(const changed of [false,true]){
  if(changed)await x.db.exec('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=1');
  for(const r of rules){const c=(await Store.readCatalog(x.db.query.bind(x.db),'fish')).catalog,pin=c.fields.find(f=>f.key===r.field).source_hash;
   const rows=(await x.db.query('SELECT s.id,m.matched,crm_audience_v2.shopify_customer_match($1,s.id,$2,$3) established FROM subscribers s LEFT JOIN crm_audience_v2.shopify_matches_for_rule($1,$2,$3) m ON m.subscriber_id=s.id ORDER BY s.id',[JSON.stringify(r),'fish',pin])).rows;
   for(const row of rows)assert.equal(row.matched,row.established,JSON.stringify({r,id:row.id,changed}));
  }
 }
 const privileges=(await x.db.query("SELECT has_table_privilege('crm_audience_api','crm_audience_v2.shopify_customer_fact','SELECT') AS private,has_function_privilege('crm_audience_api','crm_audience_v2.shopify_matches_for_rule(jsonb,text,text)','EXECUTE') AS helper,has_function_privilege('crm_audience_api','crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)','EXECUTE') AS aggregate")).rows[0];
 assert.deepEqual(privileges,{private:false,helper:false,aggregate:true});
});
