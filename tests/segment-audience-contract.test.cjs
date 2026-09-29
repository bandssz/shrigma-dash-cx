'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../n8n/growth/segment-audience-contract');
const condition=(field,operator,value)=>({op:'condition',field,operator,value});
const bought=condition('purchase.count','gt',0),popup=condition('signup.origin','is','popup'),clicked=condition('email.clicked','within_last_days',30);
const definition=(rule=bought,brand='fish')=>({schema_version:A.VERSION,brand,name:'Público de teste',rule});
const now='2026-09-28T12:00:00.000Z';
const ev=(rule,value,extra={})=>({rule_key:JSON.stringify(rule),brand:'fish',subject_ref:'synthetic:1',revision:3,value,complete:true,observed_at:'2026-09-28T11:59:30.000Z',expires_at:'2026-09-28T12:04:00.000Z',...extra});
const evaluate=(rule,evidence)=>A.evaluate(definition(rule),{subject_ref:'synthetic:1',revision:3,evidence,now});
const catalog=(brand='fish')=>({brand,current:true,currency:'BRL',fields:Object.keys(A.FIELDS).map(key=>({key,available:true})),lists:[{id:17,brand,available:true}],products:[{id:'gid://shopify/Product/123',brand,available:true}],origins:['popup','vip_alma','vip_desodorante'].map(key=>({key,brand,available:true}))});

test('canonical definition preserves nested E/OU, money precision and distinct source rules',()=>{
 const money=condition('purchase.amount','gte','125.5'),group={op:'and',rules:[clicked,bought]},input=definition({op:'or',rules:[money,group,money]});
 const before=JSON.stringify(input),n=A.normalize(input);
 assert.equal(JSON.stringify(input),before);assert.equal(n.rule.op,'or');assert.equal(n.rule.rules.length,2);
 assert.equal(A.leaves(n).find(x=>x.rule.field==='purchase.amount').rule.value,'125.50');
 assert.deepEqual(n,A.normalize(definition({op:'or',rules:[group,condition('purchase.amount','gte','125.50')]})));
 assert.equal(A.ENABLED,false);
});

test('field values and operators cannot inject a Shopify query or arbitrary predicate',()=>{
 const bad=[condition('purchase.count','gt','0 OR TRUE'),condition('purchase.count','gt',0.5),condition('purchase.count','eq',-1),condition('purchase.amount','gte',125.50),condition('purchase.amount','gte','1,00'),condition('purchase.amount','gte','1e3'),condition('purchase.amount','gte','00.1'),condition('purchase.amount','gte','0.001'),condition('purchase.product','purchased','123'),condition('purchase.product','purchased','gid://shopify/Customer/123'),condition('signup.origin','is','newsletter'),condition('email.opened','within_last_days',0),condition('email.clicked','within_last_days',3651),condition('constructor','eq',0),condition('purchase.count','sql',0)];
 for(const rule of bad)assert.throws(()=>A.normalize(definition(rule)),undefined,JSON.stringify(rule));
 assert.throws(()=>A.normalize({...definition(),sql:'SELECT *'}));assert.throws(()=>A.normalize(definition(bought,'olivas')));
 assert.throws(()=>A.normalize(definition({...bought,source:'client'})));
 const coercion={toString(){throw Error('coercion executed');}};
 assert.throws(()=>A.normalize(definition(condition(coercion,'eq',0))),{code:'AUDIENCE_CONDITION'});
});

test('calendar dates reject nonexistent days and preserve the store-local date expression',()=>{
 for(const value of ['2026-02-29','2026-09-31','2026-13-01','2026-00-01','2026-09-28T00:00:00Z','2026-9-1','1999-12-31'])assert.throws(()=>A.shopifyQuery(condition('purchase.last_date','after',value)),{code:'AUDIENCE_DATE'});
 assert.equal(A.shopifyQuery(condition('purchase.last_date','on_or_after','2024-02-29')),'last_order_date >= 2024-02-29');
});

test('every purchase operator compiles one allowlisted Shopify leaf; CRM and engagement never become Shopify email facts',()=>{
 assert.equal(A.shopifyQuery(condition('purchase.count','eq',0)),'number_of_orders = 0');
 assert.equal(A.shopifyQuery(condition('purchase.amount','lte','150')),'amount_spent <= 150.00');
 assert.equal(A.shopifyQuery(condition('purchase.product','not_purchased','gid://shopify/Product/123')),'products_purchased NOT_MATCHES (id = 123)');
 assert.equal(A.shopifyQuery(condition('purchase.product','purchased','gid://shopify/Product/123')),'products_purchased MATCHES (id = 123)');
 for(const rule of [popup,clicked,condition('email.opened','within_last_days',30)])assert.throws(()=>A.shopifyQuery(rule),{code:'AUDIENCE_SHOPIFY_FIELD'});
 assert.throws(()=>A.shopifyQuery({op:'or',rules:[bought,popup]}));
});

test('unproven origins, products of another brand, missing currency and unavailable fields block review',()=>{
 const rule={op:'and',rules:[{op:'in_list',list_id:17},popup,condition('purchase.amount','gte','10'),condition('purchase.product','purchased','gid://shopify/Product/123')]},d=definition(rule);
 assert.deepEqual(A.checkCatalog(d,catalog()),{ok:true,blocked:[],authorizes_send:false});
 for(const mutate of [c=>c.origins=[],c=>c.products[0].brand='aristo',c=>c.currency='',c=>c.fields[0].available=false,c=>c.lists[0].brand='aristo',c=>c.origins.push({...c.origins[0]})]){
  const c=catalog();mutate(c);const check=A.checkCatalog(d,c);
  // purchase.count is not part of this definition; unrelated field loss is allowed.
  assert.equal(check.ok,c.fields[0].available===false);assert.equal(check.authorizes_send,false);
 }
 assert.throws(()=>A.checkCatalog(d,catalog('aristo')),{code:'AUDIENCE_CATALOG'});
 assert.throws(()=>A.checkCatalog(d,{...catalog(),current:false}),{code:'AUDIENCE_CATALOG'});
});

test('complete truth table keeps unknown distinct from false across E/OU',()=>{
 for(const left of [true,false,null])for(const right of [true,false,null])for(const op of ['and','or']){
  const evidence=[...(left===null?[]:[ev(bought,left)]),...(right===null?[]:[ev(popup,right)])];
  const actual=evaluate({op,rules:[bought,popup]},evidence);
  const expected=op==='and'?(left===false||right===false?false:left===null||right===null?null:true):(left===true||right===true?true:left===null||right===null?null:false);
  assert.equal(actual.match,expected,`${left} ${op} ${right}`);assert.equal(actual.authorizes_send,false);
  assert.equal(actual.unknown_rules.length,Number(left===null)+Number(right===null));
 }
});

test('mixed Shopify OR origin stays a union rather than silently becoming a purchase intersection',()=>{
 const rule={op:'and',rules:[clicked,{op:'or',rules:[bought,popup]}]};
 assert.equal(evaluate(rule,[ev(clicked,true),ev(bought,false),ev(popup,true)]).match,true);
 assert.equal(evaluate(rule,[ev(clicked,true),ev(bought,true)]).match,true);
 assert.equal(evaluate(rule,[ev(clicked,true),ev(bought,false)]).match,null);
 assert.equal(evaluate(rule,[ev(clicked,false),ev(bought,true),ev(popup,true)]).match,false);
});

test('missing, partial, stale, future or differently scoped facts never prove a negative',()=>{
 const never=condition('purchase.count','eq',0);
 assert.equal(evaluate(never,[]).match,null);
 for(const extra of [{complete:false},{brand:'aristo'},{subject_ref:'synthetic:2'},{revision:2},{value:null},{observed_at:'2026-09-28T12:00:01.000Z'},{expires_at:now},{expires_at:'2026-09-28T12:10:00.000Z'},{observed_at:'not-a-date'}])assert.equal(evaluate(never,[ev(never,false,extra)]).match,null,JSON.stringify(extra));
 assert.equal(evaluate(never,[ev(never,true)]).match,true);
 assert.equal(evaluate(never,[ev(never,false)]).match,false);
});

test('duplicate evidence, unrelated facts, cycles, accessors and excessive trees are rejected',()=>{
 assert.throws(()=>evaluate(bought,[ev(bought,true),ev(bought,false)]),{code:'AUDIENCE_EVIDENCE'});
 assert.throws(()=>evaluate(bought,[ev(popup,true)]),{code:'AUDIENCE_EVIDENCE'});
 const cyclic={op:'and',rules:[]};cyclic.rules=[cyclic];assert.throws(()=>A.normalize(definition(cyclic)));
 let deep=bought;for(let i=0;i<5;i++)deep={op:'and',rules:[deep]};assert.throws(()=>A.normalize(definition(deep)),{code:'AUDIENCE_LIMIT'});
 const input=definition();Object.defineProperty(input,'name',{enumerable:true,get(){throw Error('unexpected getter');}});assert.throws(()=>A.normalize(input),{code:'AUDIENCE_FIELDS'});
 assert.throws(()=>A.normalize(definition({op:'or',rules:Array(17).fill(bought)})));
});
