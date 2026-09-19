/* Backend-only parameterized adapter for the disabled B06.1 candidate.
   No transport, activation, template mutation, new dedupe key or graph syntax. */
'use strict';
function createCartEntryProvider({query,cacheTarget}){
 if(typeof query!=='function')throw Error('Parameterized backend query required');
 const uuid=id=>{if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw Error('Entry identity required');return id;};
 const one=async(sql,args)=>{const result=await query(sql,args);if(!result||!Array.isArray(result.rows)||result.rows.length!==1||!Object.hasOwn(result.rows[0],'result'))throw Error('Journey result unconfirmed');return result.rows[0].result;};
 return {
  enroll(subscriberId,ref){
   if(!Number.isSafeInteger(subscriberId)||subscriberId<=0||typeof ref!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(ref)||!Number.isFinite(Date.parse(ref)))throw Error('Source entry identity required');
   return one('SELECT public.shrigma_journey_cart_enroll_v1($1::integer,$2::timestamptz) AS result',[subscriberId,ref]);
  },
  get(entryId){return one('SELECT public.shrigma_journey_cart_get_v1($1::uuid) AS result',[uuid(entryId)]);},
  check(entryId){return one('SELECT public.shrigma_journey_cart_check_v1($1::uuid) AS result',[uuid(entryId)]);},
  async due(limit=100){
   if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Bounded batch required');
   const result=await query("SELECT id AS entry_id,subscriber_id,ref FROM public.shrigma_journey_cart_entry_v1 WHERE state='waiting' AND due_at<=clock_timestamp() ORDER BY due_at,id LIMIT $1::integer",[limit]);
   if(!result||!Array.isArray(result.rows))throw Error('Journey wait list unavailable');return result.rows;
  },
  async claim(entryId,legacyPayload){
   uuid(entryId);
   if(typeof cacheTarget!=='string'||!cacheTarget.trim()||cacheTarget.length>128)throw Error('Verified transport cache target required before claim');
   if(!legacyPayload||legacyPayload.brand!=='fish'||legacyPayload.toque!=='t05'||legacyPayload.piece!=='carrinho-30min'||Object.hasOwn(legacyPayload,'journey_entry_id'))throw Error('Only the original Fish initial cart payload is supported');
   const result=await query('SELECT * FROM public.shrigma_email_claim_cart($1::jsonb)',[JSON.stringify({...legacyPayload,journey_entry_id:entryId})]);
   if(!result||!Array.isArray(result.rows)||result.rows.length!==1||typeof result.rows[0].should_send!=='boolean')throw Error('Existing SES claim unconfirmed; inspect the entry before another action');
   const row=result.rows[0];
   if(row.should_send){
    uuid(row.dispatch_id);uuid(row.claim_token);
    const entry=await one('SELECT public.shrigma_journey_cart_check_v1($1::uuid) AS result',[entryId]);
    if(!entry||entry.state!=='reserved'||entry.reason!=='claimed'||entry.transport_state!=='in_flight'||entry.dispatch_id!==row.dispatch_id||entry.template_cache_target!==cacheTarget||!Number.isSafeInteger(entry.template_id)||entry.template_id<=0||entry.template_id!==row.payload?.template_id||entry.template_id!==row.context?.template_id)throw Error('Immutable template binding unconfirmed; inspect the existing reservation');
    uuid(entry.template_release_id);
    if(!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||!row.context||row.context.journey_entry_id!==entryId||row.context.brand!=='fish'||row.context.piece!=='carrinho-30min'||row.context.subscriber_id!==legacyPayload.subscriber_id||Date.parse(row.context.ref)!==Date.parse(legacyPayload.ref))throw Error('SES claim binding unconfirmed; inspect the existing reservation');
   }else if(typeof row.reason!=='string')throw Error('SES claim outcome unconfirmed');
   return row;
  }
 };
}
module.exports={createCartEntryProvider};
