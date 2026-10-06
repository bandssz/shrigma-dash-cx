'use strict';
// Domain read boundary; provider IDs and keys never come from the browser.
// No delivery/claim write method is exposed or called by this candidate.
const crypto=require('node:crypto'),C=require('../../audience-slice-contract.js'),K=require('./kernel.cjs');
const READS=['readDistribution','refreshAudience','readClaims','readCampaign','readSendGuards'];
const closed=reason=>K.projection({state:'unavailable',reason,selected_count:null});
function create({provider,enabled=false,clock=Date.now}={}){
 const reviews=new WeakMap();
 const admitted=enabled===true&&provider&&READS.every(name=>typeof provider[name]==='function')&&typeof clock==='function';
 function request(input){
  C.exact(input,['brand','distribution_id','plan','slice_id','audience_id','audience_revision','campaign_id','campaign_version']);
  if(!C.brand(input.brand)||!C.uuid(input.distribution_id)||!C.uuid(input.slice_id)||!C.uuid(input.audience_id)||!C.positive(input.audience_revision)||!C.positive(input.campaign_id)||!C.positive(input.campaign_version))throw Error('AUDIENCE_SLICE_REQUEST');
  const p=C.normalize(input.plan);
  if(p.brand!==input.brand||p.distribution_id!==input.distribution_id||!p.slices.some(s=>s.id===input.slice_id))throw Error('AUDIENCE_SLICE_REQUEST');
  return {...input,plan:p};
 }
 async function live(r){
  const d=K.distribution(await provider.readDistribution({brand:r.brand,distribution_id:r.distribution_id}));
  K.bind(r.plan,d);
  const [snapshot,claims,campaign]=await Promise.all([
   provider.refreshAudience({brand:r.brand,audience_id:r.audience_id,audience_revision:r.audience_revision}),
   provider.readClaims({brand:r.brand,distribution_id:r.distribution_id}),
   provider.readCampaign({brand:r.brand,campaign_id:r.campaign_id,campaign_version:r.campaign_version})
  ]);
  if(snapshot?.audience_id!==r.audience_id||snapshot?.audience_revision!==r.audience_revision)throw Error('AUDIENCE_SLICE_CONTEXT');
  const selection=K.select({plan:r.plan,distribution:d,slice_id:r.slice_id,snapshot,claims,now:clock()});
  if(selection.state!=='prepared')return {selection};
  const checked=K.campaign(campaign,selection);
  if(checked.campaign_id!==r.campaign_id||checked.campaign_version!==r.campaign_version)throw Error('AUDIENCE_SLICE_CONTEXT');
  return {selection,campaign:checked};
 }
 return Object.freeze({
  async prepare(input){
   if(!admitted)return closed('provider_integration_unavailable');
   try{
    const r=request(input),current=await live(r);
    if(current.selection.state!=='prepared')return K.projection(current.selection);
    const review=Object.freeze({...K.projection(current.selection),review_id:crypto.randomUUID()});
    reviews.set(review,{r,...current});return review;
   }catch{return closed('preparation_unconfirmed');}
  },
  async readmit(review){
   if(!admitted)return closed('provider_integration_unavailable');
   const prior=reviews.get(review);if(!prior)return closed('original_review_required');
   reviews.delete(review);
   try{
    if(Date.parse(prior.selection.expires_at)<=clock()){reviews.delete(review);return closed('review_expired');}
    const current=await live(prior.r);
    if(current.selection.state!=='prepared'){reviews.delete(review);return K.projection(current.selection);}
    const guards=await provider.readSendGuards({brand:prior.r.brand,campaign_id:prior.r.campaign_id,campaign_version:prior.r.campaign_version,content_hash:current.campaign.content_hash,definition_hash:current.selection.definition_hash,members_hash:current.selection.members_hash,subject_ids:current.selection.member_ids.slice()});
    const result=K.readmit({before:prior.selection,current:current.selection,before_campaign:prior.campaign,current_campaign:current.campaign,guards,now:clock()});
    // Even a successful preparation is consumed here. A delivery implementation
    // needs its own durable, atomic claims receipt; this read boundary cannot
    // retry delivery or turn a UI review into a send authorization.
    reviews.delete(review);return result;
   }catch{reviews.delete(review);return closed('readmission_unconfirmed');}
  }
 });
}
module.exports=Object.freeze({ENABLED:false,READS:Object.freeze(READS),create});
