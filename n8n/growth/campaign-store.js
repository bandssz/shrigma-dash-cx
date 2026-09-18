/* Postgres adapter for campaign-service. query must use server-side credentials and
   bind $1/$2 as parameters; never pass a browser-provided SQL string or identity. */
'use strict';
const SQL='SELECT public.shrigma_campaign_store($1::text,$2::jsonb) AS result';
function createStore({query}) {
 if(typeof query!=='function')throw Error('A parameterized Postgres query adapter is required');
 async function call(action,payload) {
  const r=await query(SQL,[action,JSON.stringify(payload)]);
  if(!r||!Array.isArray(r.rows)||r.rows.length!==1||!Object.hasOwn(r.rows[0],'result'))throw Error('Campaign store result unavailable');
  const value=r.rows[0].result;
  if(['provider','finish','validation_set','validation_invalidate'].includes(action)&&value?.ok!==true)throw Error('Campaign store write unconfirmed');
  if(action==='claim'&&(!value||typeof value.acquired!=='boolean'||!value.id||!value.hash||(value.acquired&&!value.lease)))throw Error('Campaign store claim unconfirmed');
  return value;
 }
 return {
  claim: p=>call('claim',p),
  getOperation: (actor,key)=>call('get',{actor,key}),
  setProviderId: (id,lease,providerId)=>call('provider',{id,lease,providerId}),
  finish: (id,lease,result)=>call('finish',{...result,id,lease}),
  setValidation: (providerId,validation)=>call('validation_set',{providerId,validation}),
  getValidation: providerId=>call('validation_get',{providerId}),
  invalidateValidation: providerId=>call('validation_invalidate',{providerId})
 };
}
module.exports={createStore};
