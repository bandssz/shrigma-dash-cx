'use strict';
// Pure construction only. No HTTP, SQL, credentials or recipient selection.
const RECIPIENT='felipebandeira@oaristocrata.com',PREFIX='✅ FINAL — ',CONTRACT='crm_email_test_v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function request(p){
 const keys=['draft_id','expected_version','idempotency_key','confirm'];
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))||typeof p.draft_id!=='string'||!/^d_[A-Za-z0-9_-]{1,96}$/.test(p.draft_id)||!Number.isSafeInteger(p.expected_version)||p.expected_version<1||!UUID.test(p.idempotency_key)||p.confirm!=='enviar_teste')throw Error('EMAIL_TEST_REQUEST_INVALID');
 return {...p};
}
function plan(snapshot,GEC){
 if(!snapshot?.eligible)return {eligible:false,code:snapshot?.code||'snapshot_unavailable'};
 const r=snapshot.rascunho,t=snapshot.native;
 if(!GEC||!GEC.hasEnvelope(r)||GEC.envelopeErrors(r).length||GEC.documentErrors(r).length)return {eligible:false,code:'email_envelope_required'};
 const rendered=GEC.payload(r);
 if(t.type!=='tx'||t.subject!==rendered.subject||t.body!==rendered.body||snapshot.components?.subject!==rendered.subject||snapshot.components?.body_html!==rendered.body)return {eligible:false,code:'published_content_mismatch'};
 const domain=GEC.BRANDS[r.marca]?.domain;if(!domain)return {eligible:false,code:'brand_unavailable'};
 const samples={first_name:'Felipe',name:'Felipe',nome:'Felipe',brand:GEC.BRANDS[r.marca].name,brand_name:GEC.BRANDS[r.marca].name,store_url:'https://'+domain,shop_url:'https://'+domain};
 if(typeof t.subject!=='string'||!t.subject.trim()||t.subject.length>250||/[\r\n\u0000-\u001f\u007f]/.test(t.subject))return {eligible:false,code:'subject_invalid'};
 const used=new Set();
 for(const source of [t.subject,t.body]){
  const remainder=source.replace(/\{\{\s*\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,(all,key)=>{used.add(key);return '';});
  // Arbitrary Go expressions/functions and Subscriber fields are not fabricated or executed.
  if(remainder.includes('{{')||remainder.includes('}}'))return {eligible:false,code:'unsupported_template_expression'};
 }
 if([...used].some(k=>!Object.hasOwn(samples,k)))return {eligible:false,code:'unsupported_test_variable'};
 if(used.size&&(/<(?:script|style)(?:\s|>)/i.test(t.body)||[...t.body.matchAll(/\{\{[\s\S]*?\}\}/g)].some(m=>t.body.lastIndexOf('<',m.index)>t.body.lastIndexOf('>',m.index))))return {eligible:false,code:'unsupported_variable_context'};
 const data=Object.fromEntries([...used].sort().map(k=>[k,samples[k]]));
 const subject=PREFIX+t.subject.replace(/^(?:✅ FINAL — )+/u,'');
 const substitute=(value,html=false)=>value.replace(/\{\{\s*\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,(_,key)=>html?GEC.esc(data[key]):data[key]);
 return {eligible:true,code:'ready',snapshot,recipient:RECIPIENT,brand:r.marca,draft_id:snapshot.draft_id,version:snapshot.version,template_id:t.id,subject,rendered_subject:substitute(subject),from_email:r.from_email,reply_to:r.reply_to,data,variables:Object.keys(data),body_html:substitute(t.body,true),
  differences:['Assunto com prefixo ✅ FINAL — .','Variáveis exibidas abaixo usam dados fictícios; o destinatário é fixo.']};
}
function preview(p){return {contract:CONTRACT,eligible:p.eligible,code:p.code,...(p.eligible?Object.fromEntries(['recipient','brand','draft_id','version','template_id','subject','rendered_subject','from_email','reply_to','data','variables','body_html','differences'].map(k=>[k,p[k]])):{} )};}
function transportOutcome(response){return response?.statusCode===200&&response?.body?.data===true?'accepted':'outcome_unknown';}
module.exports={RECIPIENT,PREFIX,CONTRACT,UUID,request,plan,preview,transportOutcome};
