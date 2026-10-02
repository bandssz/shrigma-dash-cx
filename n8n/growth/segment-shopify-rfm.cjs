'use strict';
// Candidate relationship source. It is deliberately unavailable until a
// reconciled customer Bulk and a reconciled paid-orders Bulk prove complete
// history. Legacy Listmonk attributes and dashboard card counts are not source
// evidence for an audience.
const H=require('./segment-audience-review.cjs');
const SOURCE_SHA256=require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(__filename)).digest('hex');
const VERSION='shopify-customer-rfm-v4';
const FIELD='relationship.rfm';
const TAGS=Object.freeze(['campeao','leal','um_x','um_x_lapsando','dormant','needs_attention','ex_campeao_at_risk']);
const LABELS=Object.freeze({campeao:'Campeões',leal:'Clientes leais',um_x:'Compraram uma vez',um_x_lapsando:'Compra única · em risco de inatividade',dormant:'Inativos',needs_attention:'Precisam de atenção',ex_campeao_at_risk:'Frequentes ou alto valor · em risco'});
const CUSTOMER_GID=/^gid:\/\/shopify\/Customer\/[1-9][0-9]{0,24}$/;
const BULK_GID=/^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]{0,24}$/;
const SHA=/^[a-f0-9]{64}$/;
const REVISION=/^[a-f0-9]{7,64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.slice().sort().join(','))fail('RFM_PROVENANCE_SHAPE');};
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function upperBound(sorted,value){let lo=0,hi=sorted.length;while(lo<hi){const mid=(lo+hi)>>1;if(sorted[mid]<=value)lo=mid+1;else hi=mid;}return lo;}
function quintile(sorted,value){if(!sorted.length)return 1;return Math.min(5,Math.max(1,Math.ceil(upperBound(sorted,value)/sorted.length*5)));}
function tag({R,M,orders}){
 if(!Number.isInteger(R)||R<1||R>5||!Number.isInteger(M)||M<1||M>5||!Number.isInteger(orders)||orders<1)fail('RFM_SCORE');
 if(orders===1)return R<=2?'um_x_lapsando':'um_x';
 if(R>=4&&orders>=4)return 'campeao';
 if(R>=3)return 'leal';
 if(orders>=4||M>=4)return 'ex_campeao_at_risk';
 if(R<=1)return 'dormant';
 return 'needs_attention';
}
function classify(rows,{brand,now}={}){
 if(!['fish','aristo'].includes(brand)||!Array.isArray(rows)||!stamp(now))fail('RFM_SOURCE');
 const seen=new Set(),at=Date.parse(now),buyers=rows.map(row=>{
  exact(row,['customer_gid','paid_orders','amount_spent','last_paid_order_at']);
  if(!CUSTOMER_GID.test(row.customer_gid)||seen.has(row.customer_gid)||!Number.isSafeInteger(row.paid_orders)||row.paid_orders<1||typeof row.amount_spent!=='number'||!Number.isFinite(row.amount_spent)||row.amount_spent<0||!stamp(row.last_paid_order_at)||Date.parse(row.last_paid_order_at)>at)fail('RFM_SOURCE_INCOMPLETE');
  seen.add(row.customer_gid);return {...row,recency_days:(at-Date.parse(row.last_paid_order_at))/86400000};
 });
 const recency=buyers.map(x=>x.recency_days).sort((a,b)=>a-b),money=buyers.map(x=>x.amount_spent).sort((a,b)=>a-b),p80=money.length?money[Math.floor(money.length*.8)]:Infinity;
 return buyers.map(row=>{const R=6-quintile(recency,row.recency_days),M=quintile(money,row.amount_spent),F=row.paid_orders>=4?5:row.paid_orders===1?1:3;return {brand,customer_gid:row.customer_gid,R,F,M,paid_orders:row.paid_orders,rfm:`${R}${F}${M}`,rfm_tag:tag({R,M,orders:row.paid_orders}),is_vip:row.amount_spent>p80};});
}
const SEMANTICS=Object.freeze({
 version:VERSION,
 algorithm:'published-nightly-rfm-upper-bound-quintiles-v1',
 identity:'unique Customer GID is resolved only when a transient SHA-256 of the normalized Customer email matches the current private identity email; neither email nor digest is persisted or public evidence',
 customers:'one completed reconciled Customer Bulk',
 paid_orders:'one completed reconciled paid-orders Bulk with financial_status:paid and complete historical access',
 money:'sum of currentTotalPriceSet.shopMoney for Customer-GID-linked PAID orders in that same paid-orders Bulk; not Customer.amountSpent or net sales',
 snapshot:'R, F and M use the same paid-orders export; Customer Bulk supplies the reconciled universe, not monetary values; neither export claims a Shopify-wide atomic instant',
 history:'read_all_orders plus a reconciled unbounded paid-order export; sixty-day access is insufficient',
 freshness:'both Bulks belong to the same brand snapshot and expire no later than 26 hours after the earlier start',
 missing:'missing, stale, partial, ambiguous or unresolved evidence is SQL NULL'
});
function validateProvenance(input){
 exact(input,['brand','shop_id','operation_id','customer_bulk','paid_orders_bulk','workflow_id','producer_revision','algorithm_sha256','access_scopes','history_complete','started_at','observed_at','expires_at']);
 if(!['fish','aristo'].includes(input.brand)||!/^gid:\/\/shopify\/Shop\/[1-9][0-9]{0,19}$/.test(input.shop_id)||!UUID.test(input.operation_id)||!REVISION.test(input.producer_revision)||typeof input.workflow_id!=='string'||!input.workflow_id||input.workflow_id.length>128||!SHA.test(input.algorithm_sha256)||!Array.isArray(input.access_scopes)||new Set(input.access_scopes).size!==input.access_scopes.length||!input.access_scopes.every(x=>typeof x==='string'&&/^[a-z_]{1,80}$/.test(x)))fail('RFM_PROVENANCE');
 if(input.history_complete!==true||!input.access_scopes.includes('read_orders')||!input.access_scopes.includes('read_all_orders'))fail('RFM_HISTORY_INCOMPLETE');
 for(const bulk of [input.customer_bulk,input.paid_orders_bulk]){exact(bulk,['gid','query_sha256','payload_sha256','status','object_count']);if(!BULK_GID.test(bulk.gid)||!SHA.test(bulk.query_sha256)||!SHA.test(bulk.payload_sha256)||bulk.status!=='COMPLETED'||!Number.isSafeInteger(bulk.object_count)||bulk.object_count<0)fail('RFM_BULK_INCOMPLETE');}
 if(input.customer_bulk.gid===input.paid_orders_bulk.gid||!stamp(input.started_at)||!stamp(input.observed_at)||!stamp(input.expires_at)||Date.parse(input.started_at)>Date.parse(input.observed_at)||Date.parse(input.observed_at)>=Date.parse(input.expires_at)||Date.parse(input.expires_at)-Date.parse(input.started_at)>26*3600000)fail('RFM_PROVENANCE');
 return JSON.parse(H.canonical(input));
}
function sourceHash(provenance){const p=validateProvenance(provenance);return H.digest({semantics:SEMANTICS,brand:p.brand,shop_id:p.shop_id,customer_query_sha256:p.customer_bulk.query_sha256,paid_orders_query_sha256:p.paid_orders_bulk.query_sha256,workflow_id:p.workflow_id,producer_revision:p.producer_revision,algorithm_sha256:p.algorithm_sha256});}
function sourceReady(brand,catalog){
 const snapshot=catalog?.rfm_snapshot;if(!snapshot||snapshot.brand!==brand||snapshot.current!==true||snapshot.history_complete!==true)return false;
 const hash=snapshot.source_hash;if(typeof hash!=='string'||!SHA.test(hash))return false;
 if(Object.hasOwn(snapshot,'provenance')){try{if(sourceHash(snapshot.provenance)!==hash)return false;}catch{return false;}}
 const rows=catalog.fields?.filter(x=>x?.key===FIELD);return rows?.length===1&&rows[0].available===true&&rows[0].source_hash===hash;
}
module.exports={SOURCE_SHA256,VERSION,FIELD,TAGS,LABELS,SEMANTICS,upperBound,quintile,tag,classify,validateProvenance,sourceHash,sourceReady};
