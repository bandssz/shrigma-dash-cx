'use strict';
// Original Listmonk v6.1.0 contract: /api/tx supports external ephemeral email.
// https://github.com/knadh/listmonk/blob/v6.1.0/cmd/tx.go
const {createHash}=require('node:crypto');
const Identity=require('./campaign-write-contract.js');
const TARGET='https://email.shrigma.com.br';
const HTML_TEMPLATE_BODY='{{ Safe .Tx.Data.test_html }}';
function createTransport({privateApi,fetchImpl=fetch,recordDiagnostic,htmlMode=false,confirmedSenders={}}={}){
 if(typeof privateApi!=='function'||typeof fetchImpl!=='function')throw Error('TEST_TX_CONFIG');
 const senders=Object.freeze(Object.fromEntries(['fish','aristo'].map(b=>[b,Object.freeze(Identity.senderProfile(b,confirmedSenders).from)])));
 return async function send({binding,recipient,subject,text,html,htmlSha256,signal,preSend,diagnosticContext}){
  if(typeof preSend!=='function')return {state:'refused',code:'TEST_PRESEND_REQUIRED'};
  if(binding?.purpose!=='crm.journey-internal-test'||binding.active!==true||binding.txSend!==true||!['fish','aristo'].includes(binding.brand)||!Number.isSafeInteger(binding.templateId)||binding.templateId<1||typeof subject!=='string'||!subject.startsWith('[TESTE] ')||subject.length>250||/[\r\n]/.test(subject)||typeof text!=='string'||text.length>5000||typeof recipient!=='string'||!/^[^@\s]+@(shrigma\.com\.br|oaristocrata\.com|fishermans\.com\.br)$/i.test(recipient))return {state:'refused',code:'TEST_TX_FIELDS_REFUSED'};
  if(htmlMode?(binding.format!=='html'||typeof html!=='string'||!html.trim()||Buffer.byteLength(html)>200000||/[\u0000]/.test(html)||!text.trim()||[html,subject,text].some(s=>s.includes('{{'))||! /^[a-f0-9]{64}$/.test(htmlSha256||'')||createHash('sha256').update(html).digest('hex')!==htmlSha256):(html!==undefined||htmlSha256!==undefined||binding.format!==undefined))return {state:'refused',code:'TEST_HTML_CONTENT_REFUSED'};
  const privateValue=privateApi(binding),p=privateValue?{...privateValue}:null;if(!p||p.purpose!=='crm.journey-internal-test'||p.revision!==binding.revision||typeof p.username!=='string'||!/^[A-Za-z0-9_.@-]{1,100}$/.test(p.username)||typeof p.token!=='string'||!p.token||typeof p.fromEmail!=='string'||/[\r\n]/.test(p.fromEmail))return {state:'refused',code:'TEST_TX_PRIVATE_BINDING_REFUSED'};
  const replyTo=Identity.senderProfile(binding.brand,senders).reply_to;if(!Identity.senderIdentityAllowed(binding.brand,p.fromEmail,replyTo,senders))return {state:'refused',code:'TEST_SENDER_UNVERIFIED'};
  const headers={Authorization:'Basic '+Buffer.from(p.username+':'+p.token).toString('base64'),Accept:'application/json'},guard=()=>{const current=privateApi(binding);if(!current||current.revision!==p.revision||current.username!==p.username||current.token!==p.token||current.fromEmail!==p.fromEmail)throw Error('TEST_BINDING_CHANGED');};
  const log=fields=>recordDiagnostic?.({userId:diagnosticContext?.userId,brand:binding.brand,kind:'journey',action:'tx_send',operationKey:diagnosticContext?.requestId||null,secrets:[p.token,Buffer.from(p.username+':'+p.token).toString('base64')],...fields});
  const read=async r=>{const chunks=[];let size=0;try{for await(const chunk of r.body){chunks.push(Buffer.from(chunk));size+=chunk.length;if(size>2*1024*1024)throw Object.assign(Error('TEST_TX_RESPONSE_TOO_LARGE'),{code:'TEST_TX_RESPONSE_TOO_LARGE'});}return Buffer.concat(chunks).toString('utf8');}catch(e){try{log({phase:'exception',httpStatus:r.status,body:Buffer.concat(chunks),error:e,captureComplete:false,bodyAvailable:chunks.length>0});}catch{}throw e;}};
  const options={credentials:'omit',redirect:'error',cache:'no-store',signal};let started=false,lastStatus=null,lastBody=null;
  try{
  const response=await fetchImpl(TARGET+'/api/templates/'+binding.templateId,{...options,method:'GET',headers});
  lastStatus=response.status;
  if(response.url&&response.url!==TARGET+'/api/templates/'+binding.templateId){log({phase:'response',httpStatus:response.status,bodyAvailable:false,captureComplete:false});return {state:'refused',code:'TEST_TEMPLATE_DESTINATION_REFUSED'};}
  lastBody=await read(response);
  log({phase:'response',httpStatus:response.status,body:lastBody});
  if(!response.ok)return {state:'refused',code:'TEST_TEMPLATE_READ_REFUSED'};
  const parsed=JSON.parse(lastBody),tpl=parsed?.data;
  if(tpl?.id!==binding.templateId||tpl.type!=='tx'||typeof tpl.body!=='string'||!(htmlMode?tpl.body===HTML_TEMPLATE_BODY&&tpl.is_default===false:tpl.body.includes('.Tx.Data.test_text'))||! /^[a-f0-9]{64}$/.test(p.templateSha256||'')||createHash('sha256').update(tpl.body).digest('hex')!==p.templateSha256)return {state:'refused',code:'TEST_TEMPLATE_CONTRACT_REFUSED'};
  log({phase:'before_send',bodyAvailable:false});
  try{guard();if(signal?.aborted)return {state:'not_sent',code:'TEST_ATTEMPT_CHANGED'};if(preSend()!==true)return {state:'not_sent',code:'TEST_ATTEMPT_CHANGED'};}catch(e){return {state:'not_sent',code:['TEST_PAUSED_BEFORE_SEND','TEST_EXCLUDED_BEFORE_SEND','TEST_BINDING_CHANGED','TEST_ATTEMPT_CHANGED','TEST_WINDOW_CLOSED_BEFORE_SEND'].includes(e?.code)?e.code:'TEST_BINDING_CHANGED'};}
  started=true;lastStatus=null;lastBody=null;
  const sent=await fetchImpl(TARGET+'/api/tx',{...options,method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({subscriber_emails:[recipient],subscriber_mode:'external',template_id:binding.templateId,from_email:p.fromEmail,headers:[{'Reply-To':replyTo}],subject,...(htmlMode?{content_type:'html',altbody:text,data:{test_html:html,test_text:text,test_brand:binding.brand}}:{data:{test_text:text,test_brand:binding.brand}}),messenger:'email'})});
  lastStatus=sent.status;
  // No automatic retries. HTTP5xx/network or malformed receipt may have accepted
  // mail already, so absence of the exact receipt is always uncertain.
  if(sent.url&&sent.url!==TARGET+'/api/tx'){log({phase:'response',httpStatus:sent.status,bodyAvailable:false,captureComplete:false});return {state:'uncertain'};}
  lastBody=await read(sent);log({phase:'response',httpStatus:sent.status,body:lastBody});
  if([400,401,403,404,405,415,422,429].includes(sent.status))return {state:'refused',code:'TEST_TX_HTTP_'+sent.status};
  if(sent.status!==200)return {state:'uncertain'};
  let receipt;try{receipt=JSON.parse(lastBody);}catch(e){log({phase:'exception',httpStatus:sent.status,body:lastBody,error:e});return {state:'uncertain'};}
  return receipt&&Object.keys(receipt).length===1&&receipt.data===true?{state:'accepted'}:{state:'uncertain'};
  }catch(e){try{log({phase:'exception',httpStatus:lastStatus,body:lastBody,error:e,bodyAvailable:lastBody!==null,captureComplete:false});}catch{}return started?{state:'uncertain'}:{state:'not_sent',code:e?.code==='TEST_DIAGNOSTIC_UNAVAILABLE'?'TEST_DIAGNOSTIC_UNAVAILABLE':'TEST_TX_BEFORE_SEND_FAILED'};}
 };
}
function createHtmlTransport(options){return createTransport({...options,htmlMode:true});}
module.exports={createTransport,createHtmlTransport,TARGET,HTML_TEMPLATE_BODY};
