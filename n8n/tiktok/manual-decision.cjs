/* Candidate controller. No network, credentials, environment or implicit retries.
 * The caller must authenticate first and derive actor_sha256 from the validated
 * server credential. It identifies a shared credential, not a human identity.
 * createController.toString() is suitable for the n8n Code sandbox (no require).
 */
'use strict';
function createController(){
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
 const digest=/^[a-f0-9]{64}$/;
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const stable=v=>Array.isArray(v)?v.map(stable):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
 function identity(b,principal){
  if(!object(b)||!object(principal)||!UUID.test(b.operation_id||'')||typeof b.operation_id!=='string'
   ||typeof principal.actor_sha256!=='string'||!digest.test(principal.actor_sha256)
   ||!['aristo','fish'].includes(b.marca)||typeof b.application_id!=='string'||!/^[1-9][0-9]{0,79}$/.test(b.application_id))throw Error('TTS_MANUAL_INVALID_IDENTITY');
  return {operation_id:b.operation_id,actor_sha256:principal.actor_sha256,marca:b.marca,application_id:b.application_id};
 }
 function normalize(b,principal){
  const out=identity(b,principal);
  if(b.acao!=='revisar'||!['APPROVE','REJECT'].includes(b.resultado)||typeof b.autor!=='string'||!b.autor.trim()||b.autor!==b.autor.trim()||b.autor.length>40
   ||typeof b.observacao!=='string'||b.observacao.length>200||typeof principal.owner!=='string'||!principal.owner||principal.owner.length>160
   ||b.resultado==='APPROVE'&&b.motivo_rejeicao!==null
   ||b.resultado==='REJECT'&&!['NOT_MATCH','INSUFFICIENT_STOCK','OTHER'].includes(b.motivo_rejeicao))throw Error('TTS_MANUAL_INVALID_PAYLOAD');
  return {...out,owner:principal.owner,request_payload:{marca:out.marca,application_id:out.application_id,resultado:b.resultado,motivo_rejeicao:b.motivo_rejeicao,observacao:b.observacao,autor:b.autor}};
 }
 function query(action,p){
  if(!['claim','dispatch','finish','get'].includes(action))throw Error('TTS_MANUAL_INVALID_ACTION');
  return {sql:'SELECT public.crm_tts_manual_store_v1($1::text,$2::jsonb) AS result',parameters:[action,JSON.stringify(p)]};
 }
 function witness(value,p,state){
  if(!object(value)||value.allowed!==true||value.state!==state||value.code!==(state==='reserved'?'reserved':'in_flight')
   ||!['operation_id','actor_sha256','marca','application_id','owner'].every(k=>value[k]===p[k])
   ||typeof value.claim_token!=='string'||!UUID.test(value.claim_token)||p.claim_token&&p.claim_token!==value.claim_token
   ||!same(value.request_payload,p.request_payload))throw Error('TTS_MANUAL_WITNESS_INVALID');
  return {...p,claim_token:value.claim_token};
 }
 function readReceipt(envelope,p){
  const op=envelope?.operation;
  if(envelope?.contract!=='tts_manual_operation_v1'||!object(op)||!['operation_id','actor_sha256','marca','application_id'].every(k=>op[k]===p[k])
   ||!['missing','reserved','in_flight','accepted','outcome_unknown','blocked'].includes(op.state))throw Error('TTS_MANUAL_RECEIPT_INVALID');
  if(op.state==='missing'){
   if(op.request_payload!==null||op.response!==null)throw Error('TTS_MANUAL_RECEIPT_INVALID');
  }else if(!object(op.request_payload)||p.request_payload&&!same(op.request_payload,p.request_payload))throw Error('TTS_MANUAL_RECEIPT_INVALID');
  if(['accepted','outcome_unknown','blocked'].includes(op.state)){
   const status=op.response?.status,body=op.response?.body;
   if(!object(body)||body.operation_id!==p.operation_id||!Number.isInteger(status)||status<200||status>599)throw Error('TTS_MANUAL_RECEIPT_INVALID');
   if(op.state==='accepted'){
    const line=body.linhas?.[0],decision=op.request_payload.resultado==='APPROVE'?'manual_aprovada':'manual_rejeitada';
    if(status!==200||body.ok!==true||body.linhas?.length!==1||line?.application_id!==p.application_id||line.decisao!==decision||typeof line.status!=='string'||!line.status)throw Error('TTS_MANUAL_RECEIPT_INVALID');
   }else if(body.ok!==false||status<400)throw Error('TTS_MANUAL_RECEIPT_INVALID');
  }else if(op.state!=='missing'&&op.response!==null)throw Error('TTS_MANUAL_RECEIPT_INVALID');
  return envelope;
 }
 const uncertain=p=>({status:503,body:{ok:false,code:'outcome_unknown',operation_id:p.operation_id,mensagem:'Resultado não comprovado. Preserve a mesma operação e consulte o recibo; não repita a decisão.'}});
 function classify(r){
  const body=r?.body;
  const code=Number.isInteger(body?.code)?body.code:null;
  const requestId=typeof body?.request_id==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(body.request_id)?body.request_id:null;
  const accepted=Number.isInteger(r?.statusCode)&&r.statusCode>=200&&r.statusCode<300&&object(body)&&body.code===0&&requestId!==null&&!r.error&&!body.error;
  return {kind:accepted?'accepted':'outcome_unknown',provider_code:code,request_id:requestId,reason:accepted?'provider_accepted':'provider_unconfirmed'};
 }
 async function execute(b,principal,{store,transport,preflight=async()=>false}){
  const p=normalize(b,principal);let owned;
  try{
   const claimed=await store('claim',p);
   if(claimed?.allowed!==true){
    if(claimed?.code==='operation_exists'&&claimed.receipt){const envelope=readReceipt(claimed.receipt,p);return {status:409,body:{ok:false,code:'operation_already_reserved',operation_id:p.operation_id},receipt:envelope};}
    const codes=['disabled','legacy_reconciliation_required','sample_missing','automatic_decisions_not_fenced','sample_not_eligible','idempotency_conflict','resource_reserved'];
    return {status:409,body:{ok:false,code:codes.includes(claimed?.code)?claimed.code:'admission_refused',operation_id:p.operation_id}};
   }
   owned=witness(claimed,p,'reserved');
  }catch{return uncertain(p);}
  let ready=false;
  try{ready=await preflight(owned)===true;}catch{ready=false;}
  if(!ready){
   try{const saved=await store('finish',{...owned,receipt:{kind:'blocked',provider_code:null,request_id:null,reason:'preflight_unavailable'}});if(saved?.recorded!==true)throw Error();return readReceipt(saved.receipt,p).operation.response;}catch{return uncertain(p);}
  }
  try{
   const dispatch=await store('dispatch',owned);
   if(dispatch?.allowed!==true){
    if(dispatch?.receipt){const envelope=readReceipt(dispatch.receipt,p);return envelope.operation.response||uncertain(p);}
    return uncertain(p);
   }
   witness(dispatch,owned,'in_flight');
  }catch{return uncertain(p);}
  let receipt;
  // Exactly one call. Exceptions, redirects, malformed/empty receipts and refusals
  // are uncertain unless a separately proven provider contract says otherwise.
  try{receipt=classify(await transport(owned.request_payload));}catch{receipt={kind:'outcome_unknown',provider_code:null,request_id:null,reason:'transport_uncertain'};}
  try{
   const saved=await store('finish',{...owned,receipt});
   if(saved?.recorded!==true)throw Error();
   const envelope=readReceipt(saved.receipt,p);
   if(envelope.operation.state!==receipt.kind)throw Error();
   return envelope.operation.response;
  }catch{return uncertain(p);}
 }
 async function get(b,principal,store){const p=identity(b,principal);return readReceipt(await store('get',p),p);}
 return {identity,normalize,query,witness,readReceipt,classify,execute,get};
}
module.exports={createController,...createController()};
