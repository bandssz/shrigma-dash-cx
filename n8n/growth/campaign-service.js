/* Server core. Requires durable operation/validation storage and an atomic provider adapter.
   This module does not expose an HTTP endpoint or send messages by itself. */
'use strict';
const {createHash}=require('node:crypto'),C=require('./campaign-contract'),T=require('./campaign-tracking');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
function createService({store,provider,now=()=>Date.now()}){
 if(!store||!provider)throw Error('Durable store and provider adapter are required');
 const response=(status,body)=>({status,body});
 const wrap=c=>({id:c.id,version:c.version,status:c.status,sent:c.sent,started_at:c.started_at,send_at:c.send_at,definition:c.definition});
 async function current(id,brand){if(!Number.isSafeInteger(id)||id<=0)throw fail(422,'ID_INVALID','Campanha inválida.');const c=await provider.get(id);if(!c||c.definition?.brand!==brand)throw fail(404,'CAMPAIGN_NOT_FOUND','Campanha não encontrada nesta marca.');return c;}
 return {async handle(auth,request){
  let op=null,mutating=false,providerId=null;
  try{
   if(!auth?.actor||!Array.isArray(auth.caps))throw fail(401,'UNAUTHORIZED','Autenticação necessária.');
   if(!request||typeof request!=='object')throw fail(422,'REQUEST_INVALID','Solicitação inválida.');
   const action=String(request.acao||'').replace(/^campanha_/,'');
   const capability={catalogo:'read_content',listar:'read_content',obter:'read_content',operacao:'read_content',salvar:'draft',validar:'validate',agendar:'submit'}[action];
   if(!capability)throw fail(400,'ACTION_INVALID','Ação desconhecida.');
   if(!auth.caps.includes(capability))throw fail(403,'CAPABILITY_MISSING','Esta chave não permite esta operação.');
   if(!Object.hasOwn(C.BRANDS,request.brand))throw fail(422,'BRAND_INVALID','Marca inválida.');
   if(action==='catalogo')return response(200,await provider.catalog(request.brand));
   if(action==='listar')return response(200,{campaigns:(await provider.list(request.brand)).filter(c=>c.definition?.brand===request.brand).map(wrap)});
   if(action==='obter')return response(200,{campaign:wrap(await current(request.id,request.brand))});
   if(action==='operacao'){
    const saved=await store.getOperation(auth.actor,request.idempotency_key);
    if(!saved||saved.brand!==request.brand)throw fail(404,'OPERATION_NOT_FOUND','Operação não encontrada.');
    return response(200,{operation:saved});
   }
   C.request(action,{}, {idempotencyKey:request.idempotency_key});
   const digest=hash(request),claim=await store.claim({actor:auth.actor,key:request.idempotency_key,hash:digest,brand:request.brand,action});
   if(claim.hash!==digest)throw fail(409,'IDEMPOTENCY_CONFLICT','A chave já foi usada com outro conteúdo.');
   if(!claim.acquired){if(claim.response)return claim.response;throw fail(409,'OPERATION_PENDING','Operação em andamento ou incerta. Consulte seu estado antes de repetir.');}
   op=claim;
   let result;
   if(action==='salvar'){
    const d=C.normalize(request.definition);
    if(d.brand!==request.brand)throw fail(422,'BRAND_CONFLICT','Marca do conteúdo difere da solicitação.');
    const catalog=await provider.catalog(d.brand);C.checkCatalog(d,catalog);
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
    if(updated.status!=='draft'||updated.sent!==0||updated.started_at||hash(updated.definition)!==hash(prepared.definition))throw fail(502,'READBACK_MISMATCH','Conteúdo salvo não confirmado; consulte o rascunho antes de repetir.');
    await store.invalidateValidation(c.id);
    result=response(request.id?200:201,{campaign:wrap(updated),tracking:prepared.tracking,operation_id:op.id});
   }else{
    const c=await current(request.id,request.brand);providerId=c.id;
    if(!request.expected_version||c.version!==request.expected_version)throw fail(409,'VERSION_CONFLICT','Campanha alterada; recarregue.');
    if(action==='validar'){
     if(c.status!=='draft'||c.sent!==0||c.started_at)throw fail(409,'CAMPAIGN_LOCKED','Validação de agendamento exige um rascunho não iniciado.');
     const p=C.prepare(c.definition,{catalog:await provider.catalog(request.brand),tracking:T,trackingId:c.id,now:now()});
     if(hash(p.definition)!==hash(c.definition))throw fail(422,'TRACKING_NOT_PREPARED','Salve a campanha pelo cadastro padronizado antes de validar.');
     const validation={policy:C.VERSION,version:c.version,ok:true,validated_at:new Date(now()).toISOString()};
     await store.setValidation(c.id,validation);
     result=response(200,{campaign:wrap(c),validation,tracking:p.tracking});
    }else{
     const validation=await store.getValidation(c.id);
     C.schedule(request,{...c,validation},{now:now(),canPublish:true});
     // Recheck scope and mappings immediately before the atomic provider status change.
     C.checkCatalog(C.normalize(c.definition),await provider.catalog(request.brand));
     mutating=true;
     const scheduled=await provider.schedule(c.id,{expectedVersion:c.version,operationId:op.id});
     if(scheduled.status!=='scheduled'||scheduled.send_at!==c.send_at)throw fail(502,'SCHEDULE_UNCONFIRMED','Agendamento não confirmado; consulte o estado antes de repetir.');
     result=response(200,{campaign:wrap(scheduled),operation_id:op.id});
    }
   }
   await store.finish(op.id,op.lease,{state:'succeeded',providerId,response:result});return result;
  }catch(e){
   const explicit=e.nothingChanged===true;
   const uncertain=mutating&&!explicit;
   const status=uncertain?502:(e.status||({CAPABILITY_MISSING:403,VERSION_CONFLICT:409,VALIDATION_STALE:409}[e.code])||(e.code?422:503));
   const result=response(status,{error:uncertain?'OUTCOME_UNKNOWN':e.code||'REQUEST_FAILED',message:uncertain?'Resultado remoto incerto. Consulte a operação e o rascunho; não repita com outra chave.':e.code?e.message:'Serviço indisponível. Consulte o estado da operação antes de repetir.',provider_id:providerId,operation_id:op?.id||null});
   if(op){try{await store.finish(op.id,op.lease,{state:uncertain?'outcome_unknown':'rejected',providerId,response:result});}catch{return response(502,{...result.body,error:'OUTCOME_UNKNOWN',message:'A gravação do resultado não foi confirmada. Consulte a operação antes de repetir.'});}}
   return result;
  }
 }};
}
module.exports={createService,hash};
