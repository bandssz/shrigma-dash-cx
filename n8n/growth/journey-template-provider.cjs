/* Backend-only candidate. The native adapter must target one verified Listmonk
   cache instance. No /api/tx call, source-template update, activation or retry. */
'use strict';
const {isDeepStrictEqual}=require('node:util');
function createTemplateReleaseProvider({query,nativeCreate,cacheTarget}){
 if(typeof query!=='function'||typeof nativeCreate!=='function'||typeof cacheTarget!=='string'||!cacheTarget.trim()||cacheTarget.length>128)throw Error('Bound SQL, native template creation and verified cache target required');
 const uuid=x=>{if(typeof x!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x))throw Error('Release identity required');return x;};
 const one=async(q,args)=>{const r=await query(q,args);if(!r||!Array.isArray(r.rows)||r.rows.length!==1||!r.rows[0].result)throw Error('Release receipt unconfirmed; preserve the reservation');return r.rows[0].result;};
 return {
  prepare(sourceId){
   if(!Number.isSafeInteger(sourceId)||sourceId<=0)throw Error('Source template required');
   return one('SELECT public.shrigma_journey_template_prepare_v1($1::integer,$2::text) AS result',[sourceId,cacheTarget]);
  },
  async create(releaseId){
   const b=await one('SELECT public.shrigma_journey_template_begin_v1($1::uuid,$2::text) AS result',[uuid(releaseId),cacheTarget]);
   const r=b.release;
   if(!r||r.id!==releaseId||r.cache_target!==cacheTarget||r.clone_name!=='__shrigma_journey_tx_v1_'+releaseId||r.snapshot?.type!=='tx')throw Error('Release binding unconfirmed; preserve the reservation');
   if(b.should_create===false)return {state:r.state,release:r,created:false};
   if(b.should_create!==true||r.state!=='creating')throw Error('Release creation unconfirmed');
   uuid(r.claim_token);
   // Claim persists before the call. A timeout, empty receipt or SQL failure must
   // never issue another POST/name; inspect the same reserved release instead.
   const response=await nativeCreate({name:r.clone_name,...r.snapshot}),t=response?.body?.data;
   if(response?.status!==200||!t||!Number.isSafeInteger(t.id)||t.id<=0||t.name!==r.clone_name||t.is_default!==false||
    !isDeepStrictEqual({type:t.type,subject:t.subject,body:t.body,body_source:t.body_source},r.snapshot))throw Error('Native template acknowledgement unconfirmed; reconcile this release, do not create another');
   const ready=await one('SELECT public.shrigma_journey_template_confirm_v1($1::uuid,$2::uuid,$3::integer,$4::text) AS result',[releaseId,r.claim_token,t.id,cacheTarget]);
   if(ready.id!==releaseId||ready.state!=='ready'||ready.clone_template_id!==t.id||ready.cache_target!==cacheTarget)throw Error('Release registration unconfirmed; preserve the native clone');
   return {state:'ready',release:ready,created:true};
  }
 };
}
module.exports={createTemplateReleaseProvider};
