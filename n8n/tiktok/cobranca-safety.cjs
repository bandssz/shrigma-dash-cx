/* Isolated orchestration: requires explicit parameterized SQL and transport adapters.
 * No credentials, endpoints, automatic retries or direct network implementation.
 * Existing sender is NOT wired to this module yet. */
'use strict';
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const id=v=>nonempty(v)?v:(typeof v==='number'&&Number.isSafeInteger(v)?String(v):null);
const blocked=reason=>({allowed:false,reason});
function evaluateOpening(open,identity){
 if(!open||open.code!==0||!open.data||typeof open.data!=='object')return blocked('im_abertura_invalida');
 const c=open.data;
 if(!id(c.conversation_id)||!id(c.creator_im_id)||typeof c.is_new!=='boolean')return blocked('im_identidade_incompleta');
 if(!nonempty(c.username)||c.username!==identity.username)return blocked('im_identidade_divergente');
 if(!Number.isInteger(c.unread_count)||c.unread_count<0)return blocked('im_nao_lidas_desconhecido');
 if(c.unread_count>0)return blocked('im_nao_lidas');
 return{allowed:true,conversation_id:id(c.conversation_id)};
}
function evaluateConversation(open,read,identity,now=Date.now()){
 const opening=evaluateOpening(open,identity);
 if(!opening.allowed)return opening;
 const c=open.data;
 if(!read||read.code!==0||!read.data||!Array.isArray(read.data.messages))return blocked('im_leitura_invalida');
 // The server adapter must exhaust the provider's pagination and explicitly
 // bind the completeness evidence to this conversation. Absence is unknown.
 // Raw pagination contradicting that evidence also fails closed.
 if(read.coverage?.complete!==true||id(read.coverage?.conversation_id)!==id(c.conversation_id)
   ||read.data.has_more!==undefined&&read.data.has_more!==false
   ||read.data.next_page_token!==undefined&&read.data.next_page_token!==null&&read.data.next_page_token!=='')return blocked('im_historico_incompleto');
 const messages=read.data.messages;
 if(!messages.length&&!c.is_new)return blocked('im_historico_ausente');
 for(const message of messages){
  const body=message&&message.message_body;
  if(!body||!['TEXT','IMAGE','EMOTICONS'].includes(body.type)||!id(body.sender_id))return blocked('im_mensagem_desconhecida');
  const raw=body.create_time;
  if(typeof raw!=='number'&&(typeof raw!=='string'||!/^\d+(?:\.\d+)?$/.test(raw)))return blocked('im_data_invalida');
  const seconds=Number(raw),stamp=seconds*1000;
  if(!Number.isFinite(seconds)||seconds<=0||!Number.isFinite(now)||stamp>now+60000)return blocked('im_data_invalida');
  // Human replies always require a human review/suppression decision; never infer consent from age.
  if(id(body.sender_id)===id(c.creator_im_id))return blocked('im_resposta_criador');
  if(now-stamp<7*864e5)return blocked('im_conversa_recente');
 }
 return{allowed:true,conversation_id:id(c.conversation_id)};
}
function createPostgresStore(query){
 if(typeof query!=='function')throw Error('Parameterized query adapter required');
 async function call(sql,params){
  const response=await query(sql,params),row=response?.rows?.[0];
  if(!row||!row.result||typeof row.result!=='object')throw Error('Invalid SQL response');
  return row.result;
 }
 return{
  claim:(review,owner)=>call('SELECT crm_tts_cobranca_claim_v2($1,$2::uuid) AS result',[review,owner]),
  dispatch:(review,owner)=>call('SELECT crm_tts_cobranca_dispatch_v2($1,$2::uuid) AS result',[review,owner]),
  finish:(review,owner,state,reason,messageId=null)=>call('SELECT crm_tts_cobranca_finish_v2($1,$2::uuid,$3,$4,$5) AS result',[review,owner,state,reason,messageId]),
  simulate:review=>call('SELECT crm_tts_cobranca_simulate_v2($1) AS result',[review]),
 };
}
async function executeIntent({reviewId,owner,simulate=false},{store,transport,now=()=>Date.now()}){
 if(!nonempty(reviewId)||!store)throw Error('Review and store required');
 if(simulate)return store.simulate(reviewId); // Separate table, no claim, no transport.
 if(!nonempty(owner))throw Error('Stable owner UUID required');
 const claim=await store.claim(reviewId,owner);
 if(claim.allowed!==true)return{state:'nao_reservado',reason:claim.reason};
 async function finish(state,reason,messageId=null){
  try{
   const result=await store.finish(reviewId,owner,state,reason,messageId);
   if(result.recorded!==true)return{state:'incerto',reason:'persistencia_nao_confirmada'};
   return{state,reason};
  }catch{return{state:'incerto',reason:'persistencia_nao_confirmada'};}
 }
 if(claim.review_id!==reviewId||claim.owner!==owner||claim.state!=='reservado'||
    ![claim.brand,claim.username,claim.creator_open_id,claim.reference,claim.text].every(nonempty)||
    !['amostra_sem_video','vitrine_sem_video'].includes(claim.stage)||!Number.isInteger(claim.attempt)||claim.attempt<1)
  return finish('bloqueado','reserva_payload_invalido');
 if(!transport||typeof transport.openConversation!=='function'||typeof transport.readMessages!=='function'||typeof transport.sendMessage!=='function')return finish('bloqueado','adaptador_ausente');
 let open,read;
 try{
  open=await transport.openConversation({brand:claim.brand,creatorOpenId:claim.creator_open_id});
  // Validate opening before any further call, including ambiguous flags and unread counts.
  const opening=evaluateOpening(open,claim);
  if(!opening.allowed)return finish('bloqueado',opening.reason);
  read=await transport.readMessages({brand:claim.brand,conversationId:id(open.data.conversation_id)});
 }catch{return finish('incerto','preflight_resultado_incerto');}
 const decision=evaluateConversation(open,read,claim,now());
 if(!decision.allowed)return finish('bloqueado',decision.reason);
 let dispatch;
 try{dispatch=await store.dispatch(reviewId,owner);}catch{return{state:'incerto',reason:'reserva_preservada_dispatch_sem_confirmacao'};}
 if(!dispatch||typeof dispatch.allowed!=='boolean')return{state:'incerto',reason:'reserva_preservada_dispatch_sem_confirmacao'};
 if(dispatch.allowed!==true)return{state:'bloqueado',reason:dispatch.reason};
 if(dispatch.state!=='em_transporte'||dispatch.review_id!==reviewId||dispatch.owner!==owner)
  return{state:'incerto',reason:'reserva_preservada_dispatch_sem_confirmacao'};
 // em_transporte is committed BEFORE this call. A crash here keeps a non-retryable fence.
 try{
  const response=await transport.sendMessage({brand:claim.brand,conversationId:decision.conversation_id,text:claim.text});
  if(!response||response.code!==0)return finish('incerto','transporte_sem_aceite_confirmado');
  return finish('aceito','api_aceitou',id(response.data?.message_id));
 }catch{return finish('incerto','transporte_resultado_incerto');}
}
module.exports={evaluateConversation,createPostgresStore,executeIntent};
