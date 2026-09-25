'use strict';
// Extended templates only. Keeps the CRM05 journal/once identity and fixed recipient.
const ENTP=(()=>{
 const POLICY='crm_email_native_preview_v1',CONTRACT='crm_email_test_v1';
 const RECIPIENT='felipebandeira@oaristocrata.com',PREFIX='✅ FINAL — ';
 function request(p){
  const keys=['draft_id','expected_version','idempotency_key','confirm','preview_token'];
  if(!p||typeof p!=='object'||Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))||typeof p.draft_id!=='string'||!/^d_[A-Za-z0-9_-]{1,96}$/.test(p.draft_id)||!Number.isSafeInteger(p.expected_version)||p.expected_version<1||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(p.idempotency_key||'')||p.confirm!=='enviar_teste'||!/^[a-f0-9]{64}$/.test(p.preview_token||''))throw Error('EMAIL_TEST_REQUEST_INVALID');
  return {...p};
 }
 function prepare(envelope,nativeResponse,{ENP,GEC,GEE,digest}={}){
  if(envelope?.eligible!==true)return {eligible:false,code:envelope?.code||'snapshot_unavailable',render_policy:POLICY};
  const s=envelope.snapshot,r=s?.rascunho,t=s?.native;
  if(s?.eligible!==true||!ENP||!t||envelope.profile!==ENP.PROFILE||!/^[a-f0-9]{64}$/.test(envelope.preview_token||''))return {eligible:false,code:'snapshot_unavailable',render_policy:POLICY};
  const current=nativeResponse?.body?.data;
  if(nativeResponse?.statusCode!==200||!current||current.id!==t.id||current.type!=='tx'||current.body!==t.body||current.subject!==t.subject)return {eligible:false,code:'published_content_mismatch',render_policy:POLICY};
  let payload;try{payload=GEC.payload(r);}catch{return {eligible:false,code:'email_envelope_required',render_policy:POLICY};}
  if(payload.body!==t.body||payload.subject!==t.subject||s.components?.body_html!==t.body||s.components?.subject!==t.subject)return {eligible:false,code:'published_content_mismatch',render_policy:POLICY};
  const p=ENP.prepare(r,{GEC,GEE,digest},{purpose:'test',subscriber:envelope.recipient});
  if(!p.eligible)return {...p,render_policy:POLICY};
  if(typeof t.subject!=='string'||!t.subject.trim()||t.subject.length>250||/[\r\n\u0000-\u001f\u007f]/.test(t.subject))return {eligible:false,code:'subject_invalid',render_policy:POLICY};
  return {...p,snapshot:envelope,native_verified:true,render_policy:POLICY,preview_token:envelope.preview_token,recipient:RECIPIENT,brand:r.marca,draft_id:s.draft_id,version:s.version,template_id:t.id,subject:PREFIX+t.subject.replace(/^(?:✅ FINAL — )+/u,''),rendered_subject:PREFIX+p.subject.replace(/^(?:✅ FINAL — )+/u,''),from_email:r.from_email,reply_to:r.reply_to,subscriber_mode:p.requires_subscriber?'default':'external'};
 }
 function rendered(prepared,response,{ENP,GEC}={}){
  if(!prepared?.eligible)return prepared;
  const result=ENP.accept(prepared,response,{GEC});
  if(!result.eligible)return {...result,render_policy:POLICY};
  return {...prepared,body_html:result.body_html,native_render_verified:true,variables:Object.keys(prepared.data),differences:['Assunto com prefixo ✅ FINAL — .','Dados transacionais são fictícios. Nenhuma compra, cobrança ou avaliação real é criada.',...(prepared.subscriber_mode==='default'?['Os links de assinante usam somente a identidade do destinatário fixo.']:[])]};
 }
 function preview(p){
  return {contract:CONTRACT,render_policy:POLICY,eligible:p?.eligible===true&&p.native_render_verified===true,code:p?.eligible&&!p.native_render_verified?'native_preview_unconfirmed':p?.code||'preview_unavailable',...(p?.eligible&&p.native_render_verified?Object.fromEntries(['recipient','brand','draft_id','version','template_id','subject','rendered_subject','from_email','reply_to','data','variables','body_html','differences','preview_token','source_hash','subscriber_context'].map(k=>[k,p[k]])):{} )};
 }
 return {POLICY,CONTRACT,RECIPIENT,PREFIX,request,prepare,rendered,preview};
})();
module.exports=ENTP;
