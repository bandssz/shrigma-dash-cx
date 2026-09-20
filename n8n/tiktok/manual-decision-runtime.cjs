/* Pure native-node bridge for the existing manual-decision ledger. No I/O or
 * implicit retry. The generated production candidate keeps both readiness gates false. */
'use strict';
function createRuntime(C){
 const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const reply=(status,body)=>({_route:'response',response:{status,body}});
 const uncertain=p=>reply(503,{ok:false,code:'outcome_unknown',operation_id:p?.operation_id||null,mensagem:'Resultado não comprovado. Preserve a mesma operação e consulte o recibo; não repita a decisão.'});
 function bound(p){
  const normalized=C.normalize({acao:'revisar',operation_id:p?.operation_id,...p?.request_payload},{actor_sha256:p?.actor_sha256,owner:p?.owner});
  if(!same(normalized,{operation_id:p.operation_id,actor_sha256:p.actor_sha256,marca:p.marca,application_id:p.application_id,owner:p.owner,request_payload:p.request_payload}))throw Error('TTS_MANUAL_BINDING_INVALID');
  return p;
 }
 const plan=(action,p)=>({...C.query(action,p),operation_id:p.operation_id});
 function claim(p,value){
  bound(p);
  if(value?.allowed===true)return {_route:'tokens',owned:C.witness(value,p,'reserved')};
  if(value?.code==='operation_exists'&&value.receipt){const receipt=C.readReceipt(value.receipt,p);return receipt.operation.response?{_route:'response',response:receipt.operation.response}:reply(409,{ok:false,code:'operation_already_reserved',operation_id:p.operation_id});}
  const known=['disabled','legacy_reconciliation_required','sample_missing','automatic_decisions_not_fenced','sample_not_eligible','idempotency_conflict','resource_reserved'];
  return known.includes(value?.code)?reply(409,{ok:false,code:value.code,operation_id:p.operation_id}):uncertain(p);
 }
 function token(rows,marca){
  const loja={aristo:'aristocrata',fish:'fishermans'}[marca];
  const matches=Array.isArray(rows)?rows.filter(r=>r?.loja===loja):[];
  if(matches.length!==1||typeof matches[0].access_token!=='string'||!matches[0].access_token||matches[0].access_token.length>8192)throw Error('TTS_MANUAL_TOKEN_UNAVAILABLE');
  return matches[0].access_token;
 }
 function preflight(p,rows,readiness={}){
  bound(p);let ready=false;
  try{ready=readiness.cutoverVerified===true&&readiness.admissionVerified===true&&!!token(rows,p.marca);}catch{}
  if(!ready)return {_route:'finish',finish:{...p,receipt:{kind:'blocked',provider_code:null,request_id:null,reason:'preflight_unavailable'}}};
  return {_route:'dispatch',owned:p,...plan('dispatch',p)};
 }
 function dispatch(p,value){
  bound(p);
  if(value?.allowed===true)return {_route:'transport',owned:C.witness(value,p,'in_flight')};
  if(value?.receipt){const receipt=C.readReceipt(value.receipt,p);if(receipt.operation.response)return {_route:'response',response:receipt.operation.response};}
  return uncertain(p);
 }
 function finishPlan(p,receipt){bound(p);return {owned:p,receipt,...plan('finish',{...p,receipt})};}
 function response(p,expectedReceipt,value){
  bound(p);if(value?.recorded!==true)return uncertain(p);
  const receipt=C.readReceipt(value.receipt,p);
  if(receipt.operation.state!==expectedReceipt.kind||!receipt.operation.response)return uncertain(p);
  return {_route:'response',response:receipt.operation.response};
 }
 function providerReceipt(value){
  let body=value?.body;
  if(typeof body==='string')try{body=JSON.parse(body);}catch{body=null;}
  return C.classify({statusCode:value?.statusCode,body,error:value?.error});
 }
 function lookup(identity,value){return reply(200,C.readReceipt(value,identity));}
 function request(p,tokenValue,config){
  bound(p);
  if(typeof p.claim_token!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(p.claim_token)||typeof tokenValue!=='string'||!tokenValue)throw Error('TTS_MANUAL_TRANSPORT_UNBOUND');
  if(config?.base!=='https://open-api.tiktokglobalshop.com'||typeof config.sign!=='function'||typeof config.appKey!=='string'||!config.appKey||typeof config.cipher!=='string'||!config.cipher||!Number.isInteger(config.timestamp))throw Error('TTS_MANUAL_TRANSPORT_CONFIG');
  const path='/affiliate_seller/202409/sample_applications/'+p.application_id+'/review';
  const body={review_result:p.request_payload.resultado};if(body.review_result==='REJECT')body.reject_reason=p.request_payload.motivo_rejeicao;
  const text=JSON.stringify(body),params={app_key:config.appKey,timestamp:String(config.timestamp),shop_cipher:config.cipher};params.sign=config.sign(path,params,text);
  if(typeof params.sign!=='string'||!/^[a-f0-9]{64}$/.test(params.sign))throw Error('TTS_MANUAL_SIGNATURE_INVALID');
  return {url:config.base+path+'?'+Object.keys(params).map(k=>encodeURIComponent(k)+'='+encodeURIComponent(params[k])).join('&'),body:text,headers:{'x-tts-access-token':tokenValue,'content-type':'application/json'}};
 }
 return {bound,plan,claim,preflight,dispatch,finishPlan,response,providerReceipt,lookup,request,token,uncertain};
}
module.exports={createRuntime};
