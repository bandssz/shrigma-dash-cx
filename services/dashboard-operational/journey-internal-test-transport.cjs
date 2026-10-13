'use strict';
// Original Listmonk v6.1.0 contract: /api/tx supports external ephemeral email.
// https://github.com/knadh/listmonk/blob/v6.1.0/cmd/tx.go
const {createHash}=require('node:crypto');
const TARGET='https://email.shrigma.com.br';
function createTransport({privateApi,fetchImpl=fetch}={}){
 if(typeof privateApi!=='function'||typeof fetchImpl!=='function')throw Error('TEST_TX_CONFIG');
 return async function send({binding,recipient,subject,text,signal,preSend}){
  if(typeof preSend!=='function')return {state:'refused',code:'TEST_PRESEND_REQUIRED'};
  if(binding?.purpose!=='crm.journey-internal-test'||binding.active!==true||binding.txSend!==true||!['fish','aristo'].includes(binding.brand)||!Number.isSafeInteger(binding.templateId)||binding.templateId<1||typeof subject!=='string'||!subject.startsWith('[TESTE] ')||subject.length>250||/[\r\n]/.test(subject)||typeof text!=='string'||text.length>5000||typeof recipient!=='string'||!/^[^@\s]+@(shrigma\.com\.br|oaristocrata\.com|fishermans\.com\.br)$/i.test(recipient))return {state:'refused',code:'TEST_TX_FIELDS_REFUSED'};
  const p=privateApi(binding);if(!p||p.purpose!=='crm.journey-internal-test'||p.revision!==binding.revision||typeof p.username!=='string'||!/^[A-Za-z0-9_.@-]{1,100}$/.test(p.username)||typeof p.token!=='string'||!p.token||typeof p.fromEmail!=='string'||/[\r\n]/.test(p.fromEmail))return {state:'refused',code:'TEST_TX_PRIVATE_BINDING_REFUSED'};
  const headers={Authorization:'Basic '+Buffer.from(p.username+':'+p.token).toString('base64'),Accept:'application/json'},guard=()=>{const current=privateApi(binding);if(!current||current.revision!==p.revision||current.username!==p.username||current.token!==p.token)throw Error('TEST_BINDING_CHANGED');};
  const options={credentials:'omit',redirect:'error',cache:'no-store',signal};
  const response=await fetchImpl(TARGET+'/api/templates/'+binding.templateId,{...options,method:'GET',headers});
  if(response.url&&response.url!==TARGET+'/api/templates/'+binding.templateId)return {state:'refused',code:'TEST_TEMPLATE_DESTINATION_REFUSED'};
  if(!response.ok)return {state:'refused',code:'TEST_TEMPLATE_READ_REFUSED'};
  const parsed=await response.json(),tpl=parsed?.data;
  if(tpl?.id!==binding.templateId||tpl.type!=='tx'||typeof tpl.body!=='string'||!tpl.body.includes('.Tx.Data.test_text')||! /^[a-f0-9]{64}$/.test(p.templateSha256||'')||createHash('sha256').update(tpl.body).digest('hex')!==p.templateSha256)return {state:'refused',code:'TEST_TEMPLATE_CONTRACT_REFUSED'};
  try{guard();if(signal?.aborted)return {state:'not_sent',code:'TEST_ATTEMPT_CHANGED'};if(preSend()!==true)return {state:'not_sent',code:'TEST_ATTEMPT_CHANGED'};}catch(e){return {state:'not_sent',code:['TEST_PAUSED_BEFORE_SEND','TEST_EXCLUDED_BEFORE_SEND','TEST_BINDING_CHANGED','TEST_ATTEMPT_CHANGED'].includes(e?.code)?e.code:'TEST_BINDING_CHANGED'};}
  const sent=await fetchImpl(TARGET+'/api/tx',{...options,method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({subscriber_emails:[recipient],subscriber_mode:'external',template_id:binding.templateId,from_email:p.fromEmail,subject,data:{test_text:text,test_brand:binding.brand},messenger:'email'})});
  // No automatic retries. HTTP5xx/network or malformed receipt may have accepted
  // mail already, so absence of the exact receipt is always uncertain.
  if(sent.url&&sent.url!==TARGET+'/api/tx')return {state:'uncertain'};
  if([400,401,403,404,405,415,422,429].includes(sent.status))return {state:'refused',code:'TEST_TX_HTTP_'+sent.status};
  if(sent.status!==200)return {state:'uncertain'};
  let receipt;try{receipt=await sent.json();}catch{return {state:'uncertain'};}
  return receipt&&Object.keys(receipt).length===1&&receipt.data===true?{state:'accepted'}:{state:'uncertain'};
 };
}
module.exports={createTransport,TARGET};
