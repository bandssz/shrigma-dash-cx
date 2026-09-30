'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Facts=require('../n8n/growth/segment-shopify-facts.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs'),H=require('../n8n/growth/segment-audience-review.cjs');
const def=(brand,rule)=>({schema_version:'crm-audience-v2',brand,name:'Compat',rule});
const leaf=(field,operator,value)=>({op:'condition',field,operator,value});
function catalog(brand,forward=false){const c={brand,current:true,shop_id:'gid://shopify/Shop/'+(brand==='fish'?1:2),currency:'BRL',timezone:'America/Sao_Paulo',lists:[{id:17,brand,available:true},{id:101,brand,available:true}],fields:[],products:[]};
 for(const key of Facts.FIELDS)c.fields.push({key,available:key!=='purchase.product'||!forward,source_hash:Facts.sourceHash(brand,key,c)});
 if(forward)c.fields.find(x=>x.key==='purchase.product').source_hash=H.digest({semantics:{...Facts.PRODUCT_SEMANTICS,version:'shopify-customer-products-v2',coverage:Facts.PRODUCT_SEMANTICS.coverage+'; each Customer Order-node count equals Customer.numberOfOrders'},brand,field:'purchase.product',shop_id:c.shop_id,currency:c.currency,timezone:c.timezone});return c;}
for(const brand of ['fish','aristo'])test(brand+': scalar aggregate dispatch accepts only known v1/v2 product pins, without enabling v2 products',()=>{
 for(const forward of [false,true]){const c=catalog(brand,forward);assert.equal(Facts.aggregateSourceReady(brand,c),true);assert.equal(Facts.sourceReady(brand,'purchase.product',c),!forward);
  for(const rule of [leaf('purchase.count','gt',0),{op:'confirmed',rule:leaf('purchase.amount','gt','10.00')},leaf('purchase.last_date','before','2026-09-01')])assert.match(Counter.compileCount({definition:def(brand,rule),baseListId:17,catalog:c}).text,/FROM crm_audience_v2\.shopify_count_for_rule/);
 }
 for(const bad of [null,'f'.repeat(64),'',17]){const c=catalog(brand);c.fields.find(x=>x.key==='purchase.product').source_hash=bad;assert.equal(Facts.aggregateSourceReady(brand,c),false);}
 const duplicated=catalog(brand);duplicated.fields.push({...duplicated.fields.find(x=>x.key==='purchase.product')});assert.equal(Facts.aggregateSourceReady(brand,duplicated),false);
 const wrong=catalog(brand);wrong.brand=brand==='fish'?'aristo':'fish';assert.equal(Facts.aggregateSourceReady(wrong.brand,wrong),false);
});
test('a v2 product leaf retains the established NULL/E/OU path under v1 semantics',()=>{
 const c=catalog('fish',true),unknown=leaf('purchase.product','not_purchased','gid://shopify/Product/101');
 for(const rule of [{op:'and',rules:[unknown,{op:'in_list',list_id:101}]},{op:'or',rules:[unknown,{op:'in_list',list_id:17}]}]){const p=Counter.compileCount({definition:def('fish',rule),baseListId:17,catalog:c});assert.doesNotMatch(p.text,/shopify_count_for_rule/);assert.match(p.text,/NULL::boolean/);assert.match(p.text,/matched IS NULL/);}
});
