'use strict';
const H=require('./segment-audience-review.cjs');
const VERSION='shopify-customer-bulk-facts-v1';
const QUERY_SHA256='1ca989e8c1e9f00478e3e069f70a8fe3f0a20d1fb730022cdb766bf738a65b48';
const FIELDS=Object.freeze(['purchase.count','purchase.amount','purchase.last_date']);
const SEMANTICS=Object.freeze({version:VERSION,api:'2026-07',query_sha256:QUERY_SHA256,
 identity:'unique Customer GID and native subscriber UUID; no automatic reassignment',
 coverage:'completed reconciled customer export; missing and ambiguous identities unknown',
 count:'Customer.numberOfOrders',amount:'Customer.amountSpent in shop currency',
 last_date:'Customer.lastOrder.createdAt in shop timezone',
 freshness:'snapshot observed during export; expires 26 hours after export start',
 negative:'explicit Customer aggregate only; no claim about another Customer identity'});
function sourceHash(brand,field,catalog){
 if(!['fish','aristo'].includes(brand)||!FIELDS.includes(field)||!catalog||
  !/^gid:\/\/shopify\/Shop\/[1-9][0-9]{0,19}$/.test(catalog.shop_id||'')||
  !/^[A-Z]{3}$/.test(catalog.currency||'')||catalog.timezone!=='America/Sao_Paulo')return null;
 return H.digest({semantics:SEMANTICS,brand,field,shop_id:catalog.shop_id,currency:catalog.currency,timezone:catalog.timezone});
}
function sourceReady(brand,field,catalog){
 const pin=sourceHash(brand,field,catalog);if(!pin)return false;
 const rows=catalog.fields?.filter(x=>x?.key===field);
 return rows?.length===1&&rows[0].available===true&&rows[0].source_hash===pin;
}
module.exports={VERSION,QUERY_SHA256,FIELDS,SEMANTICS,sourceHash,sourceReady};
