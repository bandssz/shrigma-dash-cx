/* Server core. Requires durable operation/validation storage and an atomic provider adapter.
   This module does not expose an HTTP endpoint or send messages by itself. */
'use strict';
const C=require('./campaign-contract'),T=require('./campaign-tracking');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>require('node:crypto').createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
function createService({store,provider,now=()=>Date.now(),hashValue=hash}){
 if(!store||!provider)throw Error('Durable store and provider adapter are required');
 if(typeof hashValue!=='function')throw Error('A campaign hash function is required');
 const response=(status,body)=>({status,body});
 const wrap=c=>({id:c.id,version:c.version,status:c.status,sent:c.sent,started_at:c.started_at,send_at:c.send_at,definition:c.definition});
 async function current(id,brand){if(!Number.isSafeInteger(id)||id<=0)throw fail(422,'ID_INVALID','Campanha inválida.');const c=await provider.get(id);if(!c||c.definition?.brand!==brand)throw fail(404,'CAMPAIGN_NOT_FOUND','Campanha não encontrada nesta marca.');return c;}
 return {async handle(auth,request){
  let op=null,mutating=false,providerId=null;
  try{
   if(!auth?.actor||!Array.isArray(auth.caps))throw fail(401,'UNAUTHORIZED','Autenticação necessária.');
   if(!request||typeof request!=='object')throw fail(422,'REQUEST_INVALID','Solicitação inválida.');
   const action=String(request.acao||'').replace(/^campanha_/,'');
   const capability={catalogo:'read_content',listar:'read_content',obter:'read_content',operacao:'read_content',salvar:'draft',validar:'validate',agendar:'submit',cancelar:'submit',recuperar:'draft'}[action];
   if(!capability)throw fail(400,'ACTION_INVALID','Ação desconhecida.');
   if(!auth.caps.includes(capability))throw fail(403,'CAPABILITY_MISSING','Esta chave não permite esta operação.');
   if(!Object.hasOwn(C.BRANDS,request.brand))throw fail(422,'BRAND_INVALID','Marca inválida.');
   if(action==='catalogo')return response(200,await provider.catalog(request.brand));
   if(action==='listar')return response(200,{campaigns:(await provider.list(request.brand)).filter(c=>c.definition?.brand===request.brand).map(wrap)});
   if(action==='obter')return response(200,{campaign:wrap(await current(request.id,request.brand))});
   if(action==='operacao'){
    const saved=await store.getOperation(auth.actor,request.idempotency_key);
    if(!saved||saved.brand!==request.brand)throw fail(404,'OPERATION_NOT_FOUND','Operação não encontrada.');
    const recovery=saved.state==='outcome_unknown'&&saved.action==='salvar'&&auth.caps.includes('draft')?await provider.recovery({sourceOperationId:saved.id,actor:auth.actor}):null;
    return response(200,{operation:saved,...(recovery?{recovery}:{})});
   }
   C.request(action,{}, {idempotencyKey:request.idempotency_key});
   const digest=hashValue(request),claim=await store.claim({actor:auth.actor,key:request.idempotency_key,hash:digest,brand:request.brand,action});
   if(claim.hash!==digest)throw fail(409,'IDEMPOTENCY_CONFLICT','A chave já foi usada com outro conteúdo.');
   if(!claim.acquired){if(claim.response)return claim.response;throw fail(409,'OPERATION_PENDING','Operação em andamento ou incerta. Consulte seu estado antes de repetir.');}
   op=claim;
   let result;
   if(action==='salvar'){
    const d=C.normalize(request.definition);
    if(d.brand!==request.brand)throw fail(422,'BRAND_CONFLICT','Marca do conteúdo difere da solicitação.');
    const catalog=await provider.catalog(d.brand);C.preflight(d,{catalog,tracking:T,now:now()});
    let c;
    if(request.id){
     c=await current(request.id,d.brand);providerId=c.id;
     if(!request.expected_version||c.version!==request.expected_version)throw fail(409,'VERSION_CONFLICT','Campanha alterada; recarregue.');
     if(c.status!=='draft'||c.sent!==0||c.started_at)throw fail(409,'CAMPAIGN_LOCKED','O editor altera somente rascunhos ainda não iniciados.');
    }else{
     mutating=true;
     // Always creates an unscheduled draft. A native ID is needed for deterministic UTMs.
     c=await provider.createDraft(d,{operationId:op.id});providerId=c.id;
     await store.setProviderId(op.id,op.lease,c.id);
     if(c.status!=='draft'||c.sent!==0||c.started_at)throw fail(502,'PROVIDER_STATE','O provedor não confirmou um rascunho sem envio.');
    }
    const prepared=C.prepare(d,{catalog,tracking:T,trackingId:c.id,now:now()});
    mutating=true;
    const updated=await provider.updateDraft(c.id,prepared,{expectedVersion:c.version,operationId:op.id});
    if(updated.status!=='draft'||updated.sent!==0||updated.started_at||hashValue(updated.definition)!==hashValue(prepared.definition))throw fail(502,'READBACK_MISMATCH','Conteúdo salvo não confirmado; consulte o rascunho antes de repetir.');
    await store.invalidateValidation(c.id);
    result=response(request.id?200:201,{campaign:wrap(updated),tracking:prepared.tracking,operation_id:op.id});
   }else if(action==='recuperar'){
    if(request.confirm!=='recuperar')throw fail(422,'CONFIRM_REQUIRED','Confirme a recuperação deste rascunho existente.');
    if(!Number.isSafeInteger(request.id)||request.id<=0||typeof request.expected_version!=='string'||!request.expected_version||!/^[-0-9a-f]{36}$/i.test(request.source_operation_id||''))throw fail(422,'RECOVERY_INVALID','A identidade da recuperação não foi confirmada.');
    providerId=request.id;mutating=true;
    const recovered=await provider.recover(request.id,{expectedVersion:request.expected_version,operationId:op.id,sourceOperationId:request.source_operation_id});
    const c=recovered?.campaign;
    if(recovered?.recovery_policy!=='crm-campaign-recovery-v1'||recovered.source_operation_id!==request.source_operation_id||recovered.operation_id!==op.id||c?.id!==request.id||c.version!==request.expected_version||c.definition?.brand!==request.brand||c.status!=='draft'||c.sent!==0||c.started_at!==null)throw fail(502,'RECOVERY_UNCONFIRMED','A recuperação não foi confirmada. Consulte a mesma tentativa.');
    result=response(200,recovered);
   }else{
    const c=await current(request.id,request.brand);providerId=c.id;
    if(!request.expected_version||c.version!==request.expected_version)throw fail(409,'VERSION_CONFLICT','Campanha alterada; recarregue.');
    if(action==='cancelar'){
     C.cancel(request,c,{now:now(),canPublish:true});
     mutating=true;
     const cancelled=await provider.cancel(c.id,{expectedVersion:c.version,operationId:op.id});
     if(cancelled.id!==c.id||cancelled.status!=='cancelled'||cancelled.sent!==0||cancelled.started_at||cancelled.send_at!==c.send_at||!cancelled.version||cancelled.version===c.version)throw fail(502,'CANCEL_UNCONFIRMED','Cancelamento não confirmado; consulte o estado antes de repetir.');
     result=response(200,{campaign:wrap(cancelled),operation_id:op.id});
    }else if(action==='validar'){
     if(c.status!=='draft'||c.sent!==0||c.started_at)throw fail(409,'CAMPAIGN_LOCKED','Validação de agendamento exige um rascunho não iniciado.');
     const p=C.prepare(c.definition,{catalog:await provider.catalog(request.brand),tracking:T,trackingId:c.id,now:now()});
     if(hashValue(p.definition)!==hashValue(c.definition))throw fail(422,'TRACKING_NOT_PREPARED','Salve a campanha pelo cadastro padronizado antes de validar.');
     mutating=true;
     const reviewed=await provider.reviewAudience(c.id,{expectedVersion:c.version,operationId:op.id});
     if(reviewed?.campaign?.version!==c.version||reviewed.campaign.id!==c.id||reviewed.validation?.version!==c.version||reviewed.validation?.ok!==true)
      throw fail(502,'AUDIENCE_REVIEW_UNCONFIRMED','Revisão de público não confirmada; consulte a operação.');
     C.audienceReview(reviewed.validation.audience,c,{now:Date.parse(reviewed.validation.audience?.checked_at),allowBlocked:true});
     result=response(200,{campaign:wrap(reviewed.campaign),validation:reviewed.validation,tracking:p.tracking});
    }else{
     const validation=await store.getValidation(c.id);
     C.schedule(request,{...c,validation},{now:now(),canPublish:true});
     // Recheck scope and mappings immediately before the atomic provider status change.
     C.checkCatalog(C.normalize(c.definition),await provider.catalog(request.brand));
     mutating=true;
     const scheduled=await provider.schedule(c.id,{expectedVersion:c.version,operationId:op.id,audienceReviewId:request.audience_review_id});
     if(scheduled.status!=='scheduled'||scheduled.send_at!==c.send_at)throw fail(502,'SCHEDULE_UNCONFIRMED','Agendamento não confirmado; consulte o estado antes de repetir.');
     if(scheduled.audience?.review_id!==request.audience_review_id)throw fail(502,'AUDIENCE_REVIEW_UNCONFIRMED','Recibo de público não confirmado; consulte a operação.');
     result=response(200,{campaign:wrap(scheduled),operation_id:op.id,audience:scheduled.audience});
    }
   }
   await store.finish(op.id,op.lease,{state:'succeeded',providerId,response:result});return result;
  }catch(e){
   const explicit=e.nothingChanged===true;
   const uncertain=mutating&&!explicit;
   const status=uncertain?502:(e.status||({CAPABILITY_MISSING:403,VERSION_CONFLICT:409,VALIDATION_STALE:409,AUDIENCE_REVIEW_REQUIRED:409,AUDIENCE_STALE:409,AUDIENCE_CHANGED:409,AUDIENCE_EMPTY:409,AUDIENCE_DISABLED:409}[e.code])||(e.code?422:503));
   const result=response(status,{error:uncertain?'OUTCOME_UNKNOWN':e.code||'REQUEST_FAILED',message:uncertain?'Resultado remoto incerto. Consulte a operação e o rascunho; não repita com outra chave.':e.code?e.message:'Serviço indisponível. Consulte o estado da operação antes de repetir.',provider_id:providerId,operation_id:op?.id||null});
   if(op){try{await store.finish(op.id,op.lease,{state:uncertain?'outcome_unknown':'rejected',providerId,response:result});}catch{return response(502,{...result.body,error:'OUTCOME_UNKNOWN',message:'A gravação do resultado não foi confirmada. Consulte a operação antes de repetir.'});}}
   return result;
  }
 }};
}
module.exports={createService,hash,stable};
