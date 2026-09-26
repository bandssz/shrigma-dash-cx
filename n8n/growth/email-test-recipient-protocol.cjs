'use strict';
// Opt-in template tests only. Trusted snapshots select recipients; no transport here.
const ETR=(()=>{
 const POLICY='crm_email_test_recipient_v2',PREFIX='[TESTE] ',TOKEN=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
 function normalize(value){if(typeof value!=='string'||value.length>254)return null;const v=value.trim().toLowerCase();return /^[a-z0-9][a-z0-9._+\-]*@[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)+$/.test(v)&&!v.includes('..')?v:null;}
 function request(p,{preview=false}={}){const keys=['draft_id','expected_version','recipient',...(preview?[]:['preview_token','idempotency_key','confirm'])];if(!p||Array.isArray(p)||Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))||!/^d_[A-Za-z0-9_-]{1,96}$/.test(p.draft_id||'')||!Number.isSafeInteger(p.expected_version)||p.expected_version<1||p.expected_version>999999999||!normalize(p.recipient)||!preview&&(!TOKEN.test(p.preview_token||'')||!UUID.test(p.idempotency_key||'')||p.confirm!=='enviar_teste'))throw Error('EMAIL_TEST_REQUEST_INVALID');return {...p,recipient:normalize(p.recipient)};}
 function prepare(envelope,response,{ENP,GEC,GEE,digest}={}){
  if(envelope?.eligible!==true)return {eligible:false,code:envelope?.code||'snapshot_unavailable'};
  const s=envelope.snapshot,t=s?.native,actual=response?.body?.data;
  if(!t||response?.statusCode!==200||actual?.id!==t.id||actual?.type!=='tx'||actual.subject!==t.subject||actual.body!==t.body)return {eligible:false,code:'published_content_mismatch'};
  let parsed;try{parsed=ENP.parseDraft(s.rascunho,{GEC,GEE});}catch(e){return {eligible:false,code:e.code||'preview_unavailable'};}
  if(parsed.requires_subscriber&&!s.subscriber)return {eligible:false,code:'recipient_identity_required'};
  if(s.recipient!==normalize(s.recipient)||s.brand!==s.rascunho.marca||parsed.payload.body!==t.body||parsed.payload.subject!==t.subject)return {eligible:false,code:'plan_changed'};
  const p=ENP.prepare(s.rascunho,{GEC,GEE,digest},{purpose:'test',subscriber:s.subscriber,recipientEmail:s.subscriber?.email||s.recipient});if(!p.eligible)return p;
  if(typeof t.subject!=='string'||!t.subject.trim()||t.subject.length>250||/[\r\n\u0000-\u001f\u007f]/.test(t.subject))return {eligible:false,code:'subject_invalid'};
  return {...p,snapshot:s,recipient:s.recipient,draft_id:s.draft_id,version:s.version,template_id:t.id,brand:s.brand,from_email:s.rascunho.from_email,reply_to:s.rascunho.reply_to,preview_token:envelope.preview_token,expires_at:envelope.expires_at,subject:PREFIX+t.subject.replace(/^(?:(?:✅ FINAL — )|(?:\[TESTE\] ))+/u,''),rendered_subject:PREFIX+p.subject.replace(/^(?:(?:✅ FINAL — )|(?:\[TESTE\] ))+/u,''),subscriber_mode:parsed.requires_subscriber?'default':'external',subscriber_context:parsed.requires_subscriber?'selected_recipient':'external',native_verified:true};
 }
 function rendered(p,response,{ENP,GEC}={}){if(!p?.eligible)return p;const r=ENP.accept(p,response,{GEC});return r.eligible?{...p,body_html:r.body_html,native_render_verified:true}:{eligible:false,code:r.code};}
 function preview(p){return {contract:POLICY,eligible:p?.eligible===true&&p.native_render_verified===true,code:p?.eligible&&!p.native_render_verified?'native_preview_unconfirmed':p?.code||'preview_unavailable',...(p?.eligible&&p.native_render_verified?Object.fromEntries(['recipient','brand','draft_id','version','template_id','rendered_subject','from_email','reply_to','data','body_html','preview_token','source_hash','expires_at','subscriber_context'].map(k=>[k,p[k]])):{} )};}
 return {POLICY,PREFIX,normalize,request,prepare,rendered,preview};
})();
module.exports=ETR;
