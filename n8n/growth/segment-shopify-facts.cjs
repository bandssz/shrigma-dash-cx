'use strict';
const H=require('./segment-audience-review.cjs');
const VERSION='shopify-customer-bulk-facts-v1';
const QUERY_SHA256='1ca989e8c1e9f00478e3e069f70a8fe3f0a20d1fb730022cdb766bf738a65b48';
const AGGREGATE_FIELDS=Object.freeze(['purchase.count','purchase.amount','purchase.last_date']);
const FIELDS=Object.freeze([...AGGREGATE_FIELDS,'purchase.product']);
const PRODUCT_QUERY_SHA256='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086';
const PRODUCT_SEMANTICS_MODE=process.env.CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS??'v1';
if(!['v1','v2'].includes(PRODUCT_SEMANTICS_MODE))throw Error('SHOPIFY_PRODUCT_SEMANTICS_MODE');
const PRODUCT_SEMANTICS_V1=Object.freeze({version:'shopify-customer-products-v1',api:'2026-07',query_sha256:PRODUCT_QUERY_SHA256,
 identity:'unique Customer GID and native subscriber UUID; no automatic reassignment',
 coverage:'complete Customer export with all accessible orders and line items; read_all_orders required',
 positive:'Product GID in an Order line item with quantity greater than zero',
 negative:'no matching Product GID only when every line item has a resolved product',
 history:'no payment filter; quantity includes refunded and removed items; no claim about deleted orders or another Customer identity',
 freshness:'snapshot observed during export; expires 26 hours after export start'});
const PRODUCT_SEMANTICS_V2=Object.freeze({...PRODUCT_SEMANTICS_V1,
 version:'shopify-customer-products-v2',
 coverage:PRODUCT_SEMANTICS_V1.coverage+'; each Customer Order-node count equals Customer.numberOfOrders'});
const PRODUCT_SEMANTICS=PRODUCT_SEMANTICS_MODE==='v2'?PRODUCT_SEMANTICS_V2:PRODUCT_SEMANTICS_V1;
const SEMANTICS=Object.freeze({version:VERSION,api:'2026-07',query_sha256:QUERY_SHA256,
 identity:'unique Customer GID and native subscriber UUID; no automatic reassignment',
 coverage:'completed reconciled customer export; missing and ambiguous identities unknown',
 count:'Customer.numberOfOrders',amount:'Customer.amountSpent in shop currency',
 last_date:'Customer.lastOrder.createdAt in shop timezone',
 freshness:'snapshot observed during export; expires 26 hours after export start',
 negative:'explicit Customer aggregate only; no claim about another Customer identity'});
// Aggregate pins retain the original Customer projection and meaning. The
// actual full export query is independently pinned in shopify_source/batch;
// adding child connections does not reinterpret an already saved scalar rule.
function sourceHash(brand,field,catalog){
 if(!['fish','aristo'].includes(brand)||!FIELDS.includes(field)||!catalog||
  !/^gid:\/\/shopify\/Shop\/[1-9][0-9]{0,19}$/.test(catalog.shop_id||'')||
  !/^[A-Z]{3}$/.test(catalog.currency||'')||catalog.timezone!=='America/Sao_Paulo')return null;
 return H.digest({semantics:field==='purchase.product'?PRODUCT_SEMANTICS:SEMANTICS,brand,field,shop_id:catalog.shop_id,currency:catalog.currency,timezone:catalog.timezone});
}
function sourceReady(brand,field,catalog){
 const pin=sourceHash(brand,field,catalog);if(!pin)return false;
 const rows=catalog.fields?.filter(x=>x?.key===field);
 return rows?.length===1&&rows[0].available===true&&rows[0].source_hash===pin;
}
// Forward compatibility is restricted to aggregate dispatch. Product readiness
// continues to require the currently active semantic pin via sourceReady().
function aggregateSourceReady(brand,catalog){
 const current=sourceHash(brand,'purchase.product',catalog);if(!current)return false;
 const rows=catalog.fields?.filter(x=>x?.key==='purchase.product');
 if(rows?.length!==1||typeof rows[0].source_hash!=='string')return false;
 const compatible=[PRODUCT_SEMANTICS_V1,PRODUCT_SEMANTICS_V2].map(semantics=>H.digest({semantics,brand,field:'purchase.product',shop_id:catalog.shop_id,currency:catalog.currency,timezone:catalog.timezone}));
 return compatible.includes(rows[0].source_hash);
}
module.exports={VERSION,QUERY_SHA256,PRODUCT_QUERY_SHA256,PRODUCT_SEMANTICS_MODE,AGGREGATE_FIELDS,FIELDS,SEMANTICS,PRODUCT_SEMANTICS_V1,PRODUCT_SEMANTICS_V2,PRODUCT_SEMANTICS,sourceHash,sourceReady,aggregateSourceReady};
