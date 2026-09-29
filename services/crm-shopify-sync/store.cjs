'use strict';
const SQL='SELECT crm_audience_v2.shopify_sync_effect($1::text,$2::jsonb) AS result';
const fail=code=>Object.assign(Error(code),{code});
function createStore({pool}={}){
 if(typeof pool?.query!=='function')throw fail('CRM_SHOPIFY_STORE_CONFIG');
 async function effect(action,payload){const r=await pool.query(SQL,[action,JSON.stringify(payload)]);if(r?.rows?.length!==1||!r.rows[0].result||typeof r.rows[0].result!=='object')throw fail('CRM_SHOPIFY_STORE_RESPONSE');return r.rows[0].result;}
 return Object.freeze({
  claim:input=>effect('claim',input),inspect:idempotency_key=>effect('inspect',{idempotency_key}),pending:()=>effect('pending',{}),renew:(operation_id,lease,lease_seconds)=>effect('renew',{operation_id,lease,lease_seconds}),
  startIntent:(operation_id,lease,intent_sha256)=>effect('start_intent',{operation_id,lease,intent_sha256}),startUncertain:(operation_id,lease)=>effect('start_uncertain',{operation_id,lease}),bindBulk:(operation_id,lease,bulk_operation_id)=>effect('bind_bulk',{operation_id,lease,bulk_operation_id}),
  evidence:(operation_id,lease,meta,chunks)=>effect('evidence',{operation_id,lease,meta,chunks}),chunkStatus:(operation_id,lease,part,customers)=>effect('chunk_status',{operation_id,lease,part,customers}),ingest:(operation_id,lease,part,customers)=>effect('ingest',{operation_id,lease,part,customers}),chunkUncertain:(operation_id,lease,part,chunk_sha256)=>effect('chunk_uncertain',{operation_id,lease,part,chunk_sha256}),finish:(operation_id,lease)=>effect('finish',{operation_id,lease}),fail:(operation_id,lease,code)=>effect('fail',{operation_id,lease,code})
 });
}
module.exports={createStore,SQL};
