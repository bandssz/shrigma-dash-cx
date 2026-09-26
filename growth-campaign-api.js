/* Campaign client: capability-gated, durable local operation journal, no retries.
   Availability flags are not personal authorization; the server checks each key. */
'use strict';
const GCA=(()=>{
 const VERSION='crm-campaign-v1',JOURNAL='shrigma_campaign_operation_v1:',RECOVERY_POLICY='crm-campaign-recovery-v1';
 const copy=v=>JSON.parse(JSON.stringify(v));
 const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
 const sameJSON=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
 const error=(code,message)=>Object.assign(new Error(message),{code});
 function caps(api){
  const c=api?.capabilities?.campaigns,e=api?.capabilities?.endpoints?.campaigns;
  let endpoint=null;try{const u=new URL(e);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash)endpoint=u.href;}catch{}
  const valid=c?.contract_version===VERSION&&Array.isArray(c.brands)&&!!endpoint,audience=valid&&c.audience_review===CampaignContract.AUDIENCE_POLICY;
  const recovery=valid&&c.recovery_policy===RECOVERY_POLICY&&c.recover===true&&c.save===true&&c.operation===true;
  return {recovery_policy:recovery?RECOVERY_POLICY:null,recover:recovery,audience_review:audience?c.audience_review:null,endpoint:valid?endpoint:null,brands:valid?c.brands.filter(b=>['aristo','fish'].includes(b)):[],
   ...Object.fromEntries(['read','save','validate','schedule','cancel','operation'].map(k=>[k,valid&&c[k]===true&&(!['validate','schedule'].includes(k)||audience)]))};
 }
 async function fingerprint(key){
  if(typeof crypto==='undefined'||!crypto.subtle||typeof TextEncoder==='undefined')throw error('IDENTITY_UNAVAILABLE','Este navegador não conseguiu proteger a identificação da tentativa.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 }
 function createClient({capabilities,brand,storage=localStorage,fetch:fetchFn=fetch,readKey,writeKey,now=()=>Date.now(),uuid=()=>crypto.randomUUID(),keyFingerprint=fingerprint,locks=typeof navigator!=='undefined'?navigator.locks:null}={}){
  let availability=capabilities,catalog=null,busy=false;
  // The brand slot survives endpoint changes; a changed endpoint must not hide
  // an unresolved operation and silently start a second creation.
  const endpoint=capabilities?.endpoint,slot=JOURNAL+brand;
  let state={version:1,brand,endpoint,campaign:null,validation:null,operation:null};
  const validState=saved=>saved?.version===1&&saved.brand===brand&&saved.endpoint===endpoint&&(!saved.campaign||validCampaign(saved.campaign))&&(!saved.operation||(typeof saved.operation.actorFingerprint==='string'&&typeof saved.operation.key==='string'&&saved.operation.request?.idempotency_key===saved.operation.key&&saved.operation.request?.brand===brand&&['pending','uncertain','succeeded','rejected'].includes(saved.operation.phase)))&&(saved.operation?.request?.acao!=='campanha_recuperar'||validRecoverySource(saved.sourceOperation,saved.operation));
  try{const saved=JSON.parse(storage.getItem(slot)||'null');if(saved){if(!validState(saved))throw Error();state=saved;}}
  catch{throw error('JOURNAL_INVALID','O registro desta operação não pôde ser lido. Preserve os dados deste navegador e concilie a operação antes de continuar.');}
  const snapshot=()=>copy(state),locked=()=>['pending','uncertain'].includes(state.operation?.phase)||!!state.recoveryId;
  const persist=next=>{const json=JSON.stringify(next);try{storage.setItem(slot,json);if(storage.getItem(slot)!==json)throw Error();state=copy(next);}catch{throw error('JOURNAL_UNAVAILABLE','Não foi possível guardar o registro da tentativa. Nenhuma nova operação será enviada.');}};
  function gate(flag){if(!availability?.endpoint||availability.endpoint!==endpoint||!availability.brands?.includes(brand)||availability[flag]!==true)throw error('CAPABILITY_UNAVAILABLE','Esta ação ainda não está disponível para esta marca.');}
  const refreshJournal=()=>{const saved=JSON.parse(storage.getItem(slot)||'null');if(saved){if(!validState(saved))throw error('JOURNAL_INVALID','Registro da tentativa não confirmado.');state=saved;}};
  const writable=()=>{refreshJournal();if(busy||locked())throw error('OPERATION_PENDING','Há uma operação sem confirmação. Consulte a tentativa existente; não use outra chave.');};
  const key=fn=>{const k=typeof fn==='function'?fn():fn;if(typeof k!=='string'||!k)throw error('KEY_REQUIRED','Informe a chave de escrita para continuar.');return k;};
  async function call(method,request,k){
   try{
    // A measured save exceeded 30s during queue load. Give writes time to return
    // their durable receipt; a lost response still preserves the same journal.
    const url=new URL(endpoint),init={method,cache:'no-store',credentials:'omit',redirect:'error',signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(method==='POST'?90000:20000):undefined};
    if(method==='GET'){url.search=new URLSearchParams(request).toString();init.headers={Authorization:'Bearer '+k};}
    else{init.headers={'Content-Type':'application/json'};init.body=JSON.stringify({k,...request});}
    const res=await fetchFn(url.href,init);let body=null;try{body=await res.json();}catch{}
    return {status:res.status,body,ok:res.status>=200&&res.status<300};
   }catch{return {status:0,body:null,ok:false};}
  }
  const responseError=res=>error(res.body?.error||'RESPONSE_UNCONFIRMED',res.status===401?'Chave inválida. Informe a chave correta; a tentativa existente será preservada.':res.status===403?'Esta chave não tem permissão para a ação.':res.body?.message||'Resultado não confirmado. Consulte a operação antes de repetir.');
  function validCampaign(c){
   if(!c||!Number.isSafeInteger(c.id)||c.id<=0||typeof c.version!=='string'||!c.version||typeof c.status!=='string'||!Number.isSafeInteger(c.sent)||c.sent<0||!Object.hasOwn(c,'started_at')||!Object.hasOwn(c,'send_at')||(c.send_at!==null&&!Number.isFinite(Date.parse(c.send_at)))||c.definition?.brand!==brand)return false;
   try{CampaignContract.normalize(c.definition);return true;}catch{return false;}
  }
  function uuidValue(v){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);}
  function validRecovery(proof,saved,op){
   return !!proof&&proof.policy===RECOVERY_POLICY&&proof.frozen===false&&uuidValue(proof.source_operation_id)&&
    op?.request?.acao==='campanha_salvar'&&!op.request.id&&op.request.brand===brand&&['pending','uncertain'].includes(op.phase)&&
    saved?.id===proof.source_operation_id&&saved.operation_key===op.key&&saved.action==='salvar'&&saved.state==='outcome_unknown'&&saved.brand===brand&&
    validCampaign(proof.campaign)&&saved.providerId===proof.campaign.id&&proof.campaign.status==='draft'&&proof.campaign.sent===0&&proof.campaign.started_at===null;
  }
  function validRecoverySource(source,op){
   try{if(CampaignContract.normalize(source?.request?.definition).brand!==brand)return false;}catch{return false;}
   return !!source&&source.key!==op.key&&source.key===source.request?.idempotency_key&&['pending','uncertain'].includes(source.phase)&&source.actorFingerprint===op.actorFingerprint&&source.request?.brand===brand&&source.request?.acao==='campanha_salvar'&&!source.request.id&&
    uuidValue(op.request?.source_operation_id)&&source.serverRecord?.id===op.request.source_operation_id&&source.serverRecord.operation_key===source.key&&source.serverRecord.brand===brand&&source.serverRecord.action==='salvar'&&source.serverRecord.state==='outcome_unknown'&&source.serverRecord.providerId===op.request.id;
  }
  const canRecover=()=>availability?.recover===true&&availability.recovery_policy===RECOVERY_POLICY&&!busy&&!state.recoveryId&&state.operation?.phase==='uncertain'&&validRecovery(state.recoveryProof,state.recoveryRecord,state.operation);
  function applyResponse(res,operation,{historical=false}={}){
   const c=res.body?.campaign;
   if(!res.ok||!validCampaign(c)||(operation.request.id&&c.id!==operation.request.id))return false;
   const action=operation.request.acao;
   if(action==='campanha_recuperar'&&(!validRecoverySource(state.sourceOperation,operation)||res.body.recovery_policy!==RECOVERY_POLICY||res.body.source_operation_id!==operation.request.source_operation_id||(!uuidValue(res.body.operation_id)||res.body.operation_id===operation.request.source_operation_id)||c.version!==operation.request.expected_version))return false;
   if(action==='campanha_agendar'&&(c.status!=='scheduled'||c.send_at!==state.campaign?.send_at))return false;
   if(action==='campanha_cancelar'&&(c.status!=='cancelled'||c.sent!==0||c.started_at!==null||c.version===operation.request.expected_version))return false;
   if(!['campanha_agendar','campanha_cancelar'].includes(action)&&(c.status!=='draft'||c.sent!==0||c.started_at))return false;
   const validation=res.body.validation;
   if(action==='campanha_validar'&&(validation?.ok!==true||validation.policy!==VERSION||validation.version!==c.version))return false;
   try{
    if(action==='campanha_validar'&&(!historical||validation.audience))CampaignContract.audienceReview(validation.audience,c,{now:Date.parse(validation.audience?.checked_at),allowBlocked:true});
    // Old persisted receipts remain readable; all new scheduling requests carry a review ID.
    if(action==='campanha_agendar'&&operation.request.audience_review_id){
     const a=res.body.audience;CampaignContract.audienceReview(a,{...c,version:operation.request.expected_version},{now:Date.parse(a?.checked_at)});
     const checked=Date.parse(a.rechecked_at);if(a.review_id!==operation.request.audience_review_id||!Number.isFinite(checked)||checked<Date.parse(a.checked_at)||checked>=Date.parse(a.expires_at))return false;
    }
   }catch{return false;}
   persist({...state,campaign:copy(c),validation:action==='campanha_validar'?copy(validation):null,recoveryId:action==='campanha_recuperar'?c.id:null,recoveryProof:null,recoveryRecord:null,
    operation:{...operation,phase:'succeeded',response:{status:res.status,body:copy(res.body)}}});return true;
  }
  const canWrite=()=>typeof locks?.request==='function';
  async function exclusive(work){
   if(!canWrite())throw error('WRITE_LOCK_UNAVAILABLE','Este navegador não oferece proteção entre abas. A consulta continua disponível. A escrita depende da proteção do navegador entre abas.');
   return locks.request(slot,{mode:'exclusive',ifAvailable:true},lock=>{
    if(!lock)throw error('OPERATION_PENDING','Outra aba está operando esta campanha. Consulte a tentativa existente.');
    return work();
   });
  }
  const mutate=(action,input)=>exclusive(()=>performMutation(action,input));
  async function recover(proof,confirm){return exclusive(async()=>{
   gate('recover');refreshJournal();
   if(confirm!=='recuperar')throw error('CONFIRM_REQUIRED','Confirme a recuperação deste rascunho existente.');
   if(!canRecover()||!sameJSON(proof,state.recoveryProof))throw error('RECOVERY_UNCONFIRMED','Consulte a tentativa original e confira o rascunho existente antes de recuperar.');
   const op=copy(state.operation),k=key(writeKey);
   if(await keyFingerprint(k)!==op.actorFingerprint)throw error('OPERATION_ACTOR_CHANGED','Use a mesma chave de escrita da tentativa original.');
   busy=true;
   try{
    const readback=await call('GET',CampaignContract.request('operacao',{brand,idempotency_key:op.key}),k),record=readback.body?.operation,fresh=readback.body?.recovery;
    gate('recover');refreshJournal();
    if(!readback.ok||!validRecovery(fresh,record,op)||!sameJSON(fresh,proof)||!sameJSON(state.operation,op)||!sameJSON(state.recoveryProof,proof))throw error('RECOVERY_CHANGED','O rascunho ou a tentativa mudou. Consulte novamente antes de recuperar.');
    const request=CampaignContract.request('recuperar',{brand,id:proof.campaign.id,expected_version:proof.campaign.version,source_operation_id:proof.source_operation_id,confirm},{idempotencyKey:uuid()});
    if(request.idempotency_key===op.key)throw error('RECOVERY_IDENTITY_INVALID','A nova tentativa de recuperação não pôde ser identificada. O registro original foi preservado.');
    const operation={phase:'pending',actorFingerprint:op.actorFingerprint,key:request.idempotency_key,request,created_at:new Date(now()).toISOString()};
    persist({...state,sourceOperation:{...op,serverRecord:copy(record)},recoveryProof:null,recoveryRecord:null,operation});
    const res=await call('POST',request,k);
    if(!applyResponse(res,operation)){
     persist({...state,operation:{...operation,phase:'uncertain',last_error:res.body?.error||'RESPONSE_UNCONFIRMED'}});
     throw responseError(res);
    }
    await consult(true);return snapshot();
   }finally{busy=false;}
  });}
  async function readCurrent(id,k){
   const latest=await call('GET',CampaignContract.request('obter',{brand,id}),k);
   if(!latest.ok||!validCampaign(latest.body?.campaign)||latest.body.campaign.id!==id)throw error('READBACK_UNCONFIRMED','A operação foi confirmada, mas o estado atual da campanha ainda não. Consulte novamente.');
   const c=latest.body.campaign;persist({...state,campaign:copy(c),validation:state.validation?.version===c.version?state.validation:null,recoveryId:null});
  }
  async function performMutation(action,input){
   gate({salvar:'save',validar:'validate',agendar:'schedule',cancelar:'cancel'}[action]);writable();
   // The editor's selected revision must still own this shared journal. A stale
   // tab must not create again or silently update the campaign another tab opened.
   if((state.campaign?.id??null)!==(input.id??null)||(state.campaign?.version??null)!==(input.expected_version??null))throw error('CAMPAIGN_CHANGED','Outra aba mudou a campanha selecionada. Reabra a versão atual antes de continuar.');
   if(action==='salvar'&&state.campaign&&(state.campaign.status!=='draft'||state.campaign.sent!==0||state.campaign.started_at))throw error('CAMPAIGN_LOCKED','Reabra um rascunho disponível para edição.');
   if(action==='agendar'&&availability.audience_review!==CampaignContract.AUDIENCE_POLICY)throw error('CAPABILITY_UNAVAILABLE','A conferência do público ainda não está disponível.');
   if(action==='agendar')CampaignContract.schedule(input,{...state.campaign,validation:state.validation},{now:now(),canPublish:availability.schedule===true});
   if(action==='cancelar')CampaignContract.cancel(input,state.campaign,{now:now(),canPublish:availability.cancel===true});
   const k=key(writeKey),actorFingerprint=await keyFingerprint(k);writable();
   const request=CampaignContract.request(action,{brand,...input},{idempotencyKey:uuid()});
   const operation={phase:'pending',actorFingerprint,key:request.idempotency_key,request,created_at:new Date(now()).toISOString()};
   persist({...state,operation});busy=true;
   try{
    const res=await call('POST',request,k);
    if(applyResponse(res,operation))return snapshot();
    const denied=(res.status===401&&res.body?.error==='UNAUTHORIZED')||(res.status===403&&res.body?.error==='CAPABILITY_MISSING'&&res.body?.operation_id===null);
    persist({...state,operation:{...operation,phase:denied?'rejected':'uncertain',last_error:res.body?.error||'RESPONSE_UNCONFIRMED'}});
    throw responseError(res);
   }finally{busy=false;}
  }
  const clean=d=>{if(!state.campaign)return false;try{return JSON.stringify(CampaignContract.normalize(d))===JSON.stringify(CampaignContract.normalize(state.campaign.definition));}catch{return false;}};
  function reviewed(d){if(busy||locked())throw error('OPERATION_PENDING','Consulte a tentativa pendente.');if(!clean(d))throw error('UNSAVED_CHANGES','Salve as alterações desta campanha antes de validar ou agendar.');const c=state.campaign;if(c.status!=='draft'||c.sent!==0||c.started_at)throw error('CAMPAIGN_LOCKED','Esta campanha não é um rascunho disponível para edição.');return c;}
  async function read(action,input={},k){gate('read');const res=await call('GET',CampaignContract.request(action,{brand,...input}),k||key(readKey));if(!res.ok)throw responseError(res);return res.body;}
  return {
   snapshot,locked,clean,canWrite,canRecover,recover,updateCapabilities:c=>{availability=c;},
   async catalog(){const c=await read('catalogo');if(c?.brand!==brand||c.current!==true||!Array.isArray(c.lists)||!Array.isArray(c.templates))throw error('CATALOG_UNAVAILABLE','Catálogo da marca não confirmado.');catalog=c;return copy(c);},
   async list(){const b=await read('listar');if(!Array.isArray(b?.campaigns)||!b.campaigns.every(validCampaign))throw error('CAMPAIGNS_UNCONFIRMED','A lista de campanhas não foi confirmada.');return copy(b.campaigns);},
   async reopen(id){const work=async()=>{writable();const b=await read('obter',{id});if(!validCampaign(b?.campaign)||b.campaign.id!==id)throw error('CAMPAIGN_UNCONFIRMED','Campanha não confirmada.');const next={...state,campaign:b.campaign,validation:null,recoveryId:null};if(canWrite())persist(next);else state=copy(next);return snapshot();};return canWrite()?exclusive(work):work();},
   async newDraft(){return exclusive(()=>{writable();persist({...state,campaign:null,validation:null,operation:null,recoveryId:null});return snapshot();});},
   async save(input){const d=CampaignContract.normalize(input);if(d.brand!==brand)throw error('BRAND_CONFLICT','Marca do conteúdo difere da solicitação.');CampaignContract.checkCatalog(d,catalog);if(typeof CampaignContract.preflight!=='function')throw error('CONTENT_CHECK_UNAVAILABLE','Atualize o painel para conferir os links antes de salvar.');CampaignContract.preflight(d,{catalog,tracking:typeof CampaignTracking!=='undefined'?CampaignTracking:null});const c=state.campaign;if(c&&(c.status!=='draft'||c.sent!==0||c.started_at))throw error('CAMPAIGN_LOCKED','Reabra um rascunho disponível para edição.');return mutate('salvar',{definition:d,...(c?{id:c.id,expected_version:c.version}:{})});},
   async validate(d){const c=reviewed(d);return mutate('validar',{id:c.id,expected_version:c.version});},
   async schedule(d,confirm,audienceReviewId){const c=reviewed(d),input={id:c.id,expected_version:c.version,confirm,audience_review_id:audienceReviewId};CampaignContract.schedule(input,{...c,validation:state.validation},{now:now(),canPublish:availability.schedule===true});return mutate('agendar',input);},
   async cancel(confirm){const c=state.campaign;CampaignContract.cancel({confirm,expected_version:c?.version},c,{now:now(),canPublish:availability.cancel===true});return mutate('cancelar',{id:c.id,expected_version:c.version,confirm});},
   async consult(){return canWrite()?exclusive(()=>consult(true)):consult(false);}
  };
  async function consult(writeJournal){
    gate('operation');refreshJournal();const op=state.operation;if(!op)throw error('OPERATION_MISSING','Não há tentativa registrada neste navegador.');
    const k=key(writeKey);if(await keyFingerprint(k)!==op.actorFingerprint)throw error('OPERATION_ACTOR_CHANGED','Use a mesma chave de escrita da tentativa. Outra autoria não pode consultar esta operação.');
    const res=await call('GET',CampaignContract.request('operacao',{brand,idempotency_key:op.key}),k),saved=res.body?.operation;
    if(!res.ok||!saved||saved.brand!==brand)throw responseError(res);
    if(op.request.acao==='campanha_recuperar'&&(saved.operation_key!==op.key||saved.action!=='recuperar'||!uuidValue(saved.id)||(saved.state==='succeeded'&&(saved.providerId!==op.request.id||saved.response?.body?.operation_id!==saved.id||(op.phase==='succeeded'&&!sameJSON(saved.response,op.response))))))throw error('RESPONSE_UNCONFIRMED','A resposta não confirmou a mesma recuperação. O registro original foi preservado; consulte novamente.');
    if(!writeJournal)return {...snapshot(),consultation:{state:saved.state},readOnly:true};
    if(saved.state==='succeeded'){
     const r=saved.response;if(!r||!applyResponse({status:r.status,body:r.body,ok:r.status>=200&&r.status<300},op,{historical:true}))throw error('RESPONSE_UNCONFIRMED','A operação respondeu, mas a campanha ainda não foi confirmada.');
     // The durable receipt is historical: a later cancellation or worker may
     // have changed the campaign. Confirm its current revision before unlocking.
     const id=state.campaign.id;persist({...state,recoveryId:id});
     await readCurrent(id,k);
    }else if(saved.state==='rejected'){
     if(op.request.acao==='campanha_recuperar'){
      persist({...state,recoveryId:op.request.id,operation:{...op,phase:'rejected',response:saved.response||null}});
      throw error('RECOVERY_REJECTED','A recuperação foi recusada. O rascunho existente e a tentativa original continuam preservados; peça a conferência desta campanha antes de criar outra.');
     }
     // Rejection after native creation still owns a real draft. Read it back
     // before unlocking; never turn a rejected post-create step into new create.
     const id=saved.providerId??saved.response?.body?.provider_id;
     if(Number.isSafeInteger(id)&&id>0){
      persist({...state,recoveryId:id,operation:{...op,phase:'rejected',response:saved.response||null}});
      const readback=await call('GET',CampaignContract.request('obter',{brand,id}),k);
      if(!readback.ok||!validCampaign(readback.body?.campaign)||readback.body.campaign.id!==id)throw error('READBACK_UNCONFIRMED','Existe um rascunho vinculado à tentativa. A leitura não foi confirmada; consulte novamente.');
      persist({...state,campaign:readback.body.campaign,validation:null,recoveryId:null});
     }else persist({...state,operation:{...op,phase:'rejected',response:saved.response||null},recoveryId:null});
    }else if(['pending','outcome_unknown'].includes(saved.state)){
     const candidate={...op,phase:'uncertain',remote_state:saved.state},proof=res.body.recovery;
     persist({...state,operation:candidate,recoveryProof:validRecovery(proof,saved,candidate)?copy(proof):null,recoveryRecord:validRecovery(proof,saved,candidate)?copy(saved):null});
    }
    else throw error('RESPONSE_UNCONFIRMED','Estado de operação não reconhecido; a tentativa permanece preservada.');
    return snapshot();
  }
 }
 return {caps,createClient,VERSION,JOURNAL,RECOVERY_POLICY};
})();
if(typeof module!=='undefined')module.exports=GCA;
