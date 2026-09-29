'use strict';
const A=require('./segment-audience-store-fixture.cjs');
const {setupShopifySelection}=require('./segment-shopify-selection-fixture.cjs');
const Facts=require('../n8n/growth/segment-shopify-facts.cjs');
const E=require('../n8n/growth/segment-shopify-product-evidence.cjs');
function productEvidence(brand='fish',records=[{id:1,products:[101]},{id:2,products:[202]}],operation='21'){
 const end=new Date(Date.now()-1000).toISOString(),start=new Date(Date.now()-3000).toISOString(),rows=[];
 for(const r of records){
  const items=r.products??[],email=r.email===undefined?'person'+r.id+'@example.test':r.email;
  rows.push({id:'gid://shopify/Customer/'+r.id,email,defaultEmailAddress:email===null?null:{emailAddress:email},firstName:'Fixture',numberOfOrders:items.length?'1':'0',amountSpent:{amount:items.length?'50.00':'0.00',currencyCode:'BRL'},lastOrder:items.length?{createdAt:'2026-09-01T01:00:00Z'}:null,createdAt:'2020-01-01T00:00:00Z',updatedAt:end});
  if(items.length){rows.push({id:'gid://shopify/Order/'+r.id,__parentId:'gid://shopify/Customer/'+r.id});
   for(const [n,p] of items.entries())rows.push({id:'gid://shopify/LineItem/'+r.id+String(n).padStart(4,'0'),quantity:1,product:p===null?null:{id:'gid://shopify/Product/'+p,title:'Produto '+p},__parentId:'gid://shopify/Order/'+r.id});
  }
 }
 const jsonl=rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':'');
 return E.buildCustomerProductEvidence({brand,shop:brand+'-fixture.myshopify.com',jsonl,observedAt:new Date().toISOString(),querySha256:Facts.PRODUCT_QUERY_SHA256,workflowId:'fixture-'+brand,workflowVersion:'shopify-products-fixture-v2',operation:{data:{shop:{id:'gid://shopify/Shop/'+(brand==='fish'?1:2),myshopifyDomain:brand+'-fixture.myshopify.com',currencyCode:'BRL',ianaTimezone:'America/Sao_Paulo'},currentAppInstallation:{accessScopes:['read_customers','read_orders','read_all_orders','read_products'].map(handle=>({handle}))},node:{id:'gid://shopify/BulkOperation/'+operation,status:'COMPLETED',errorCode:null,objectCount:String(rows.length),rootObjectCount:String(records.length),createdAt:start,completedAt:end,fileSize:String(Buffer.byteLength(jsonl)),url:jsonl?'https://example.test/synthetic':null,partialDataUrl:null}}}});
}
async function setupProducts(db){
 const f=await setupShopifySelection(db);
 await db.exec("UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=2 AND list_id IN(16,17)");
 await db.exec('UPDATE crm_audience_v2.shopify_source SET enabled=false');
 await db.exec(A.read('n8n/growth/segment-shopify-products.sql'));
 for(const brand of ['fish','aristo']){
  const hashes=Object.fromEntries(Facts.FIELDS.map(k=>[k,Facts.sourceHash(brand,k,A.source(brand))]));
  await db.query('UPDATE crm_audience_v2.shopify_source SET query_sha256=$2,producer_revision=$3,field_hashes=$4 WHERE brand=$1',[brand,Facts.PRODUCT_QUERY_SHA256,'shopify-products-fixture-v2',JSON.stringify(hashes)]);
 }
 const ingest=async(e,part=0)=>{const {customers,...meta}=e;return (await db.query('SELECT crm_audience_v2.shopify_ingest_product_chunk($1,$2,$3) receipt',[JSON.stringify(meta),part,JSON.stringify(customers.slice(part*5000,(part+1)*5000))])).rows[0].receipt;};
 const enable=async brand=>{await db.query('UPDATE crm_audience_v2.shopify_source SET enabled=true WHERE brand=$1',[brand]);await db.query('SELECT crm_audience_v2.refresh_native_catalog($1)',[brand]);};
 return {...f,ingestProducts:ingest,enableProducts:enable};
}
module.exports={productEvidence,setupProducts};
