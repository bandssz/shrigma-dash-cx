/* Server-only effect replay for the existing campaign service. No I/O here.
   Context/receipts belong to one n8n execution; NEVER accept them from a webhook
   body or return them to the browser (the store receipt contains its lease).
   A new HTTP attempt starts fresh and consults the durable claim as usual. */
'use strict';
const {createService,hash}=require('./campaign-service');
const {createStore}=require('./campaign-store');
const {createProvider}=require('./campaign-provider');
const {createNative}=require('./campaign-native');

const VERSION='crm-campaign-runtime-v1';
const REQUEST_KEYS=new Set(['acao','brand','id','definition','expected_version','idempotency_key','confirm','audience_review_id','source_operation_id']);
const STORE_ACTIONS=new Set(['claim','get','provider','finish','validation_get','validation_set','validation_invalidate']);
const PROVIDER_ACTIONS=new Set(['catalog','list','get','update','schedule','cancel','review','recovery_inspect','recover']);
const SQL={store:'SELECT public.shrigma_campaign_store($1::text,$2::jsonb) AS result',
 provider:'SELECT public.shrigma_campaign_provider($1::text,$2::jsonb) AS result'};
const clone=v=>JSON.parse(JSON.stringify(v));
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hasOnly=(v,keys)=>plain(v)&&Object.keys(v).every(k=>keys.includes(k));
const fail=(code,message)=>({kind:'response',response:{status:503,body:{error:code,message}}});
const stateFailure=()=>fail('RUNTIME_RECONCILIATION_REQUIRED','Contexto de execução não confirmado. Consulte a operação antes de tentar novamente; não use outra chave.');

function createRuntime({now=()=>Date.now(),maxSteps=64,maxBytes=8*1024*1024,
 hashValue=hash,serviceFactory=createService,storeFactory=createStore,providerFactory=createProvider,nativeFactory=createNative}={}){
 if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>256||!Number.isSafeInteger(maxBytes)||maxBytes<1024)throw Error('Invalid runtime limits');
 if(![hashValue,serviceFactory,storeFactory,providerFactory,nativeFactory].every(f=>typeof f==='function'))throw Error('Invalid runtime dependencies');
 // JSON is valid Unicode; three UTF-8 bytes per UTF-16 unit is a conservative
 // upper bound (a surrogate pair uses four). No Buffer/browser global required.
 const within=v=>JSON.stringify(v).length*3<=maxBytes;
 const identity=c=>hashValue({version:c.version,executionId:c.executionId,now:c.now,auth:c.auth,request:c.request});
 const effectId=(c,index,fingerprint)=>hashValue({executionId:c.executionId,index,fingerprint});
 const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
 function validContext(c,executionId){
  return hasOnly(c,['version','executionId','now','auth','request','binding','transcript','pending'])&&c.version===VERSION&&validId(c.executionId)&&c.executionId===executionId&&Number.isFinite(c.now)&&plain(c.auth)&&plain(c.request)&&Array.isArray(c.transcript)&&c.transcript.length<=maxSteps&&within(c)&&c.binding===identity(c)&&
   c.transcript.every((r,i)=>hasOnly(r,['id','fingerprint','outcome'])&&/^[0-9a-f]{64}$/.test(r.fingerprint)&&r.id===effectId(c,i,r.fingerprint)&&validOutcome(r.outcome));
 }
 function validOutcome(o){
  if(!plain(o)||typeof o.ok!=='boolean')return false;
  if(o.ok)return hasOnly(o,['ok','value'])&&Object.hasOwn(o,'value')&&o.value!==undefined;
  return hasOnly(o,['ok','error'])&&hasOnly(o.error,['message','code','status','nothingChanged'])&&typeof o.error.message==='string'&&o.error.message.length<=1000&&
   (o.error.code===undefined||/^[A-Za-z0-9_]{1,100}$/.test(o.error.code))&&
   (o.error.status===undefined||(Number.isInteger(o.error.status)&&o.error.status>=400&&o.error.status<=599))&&
   (o.error.nothingChanged===undefined||typeof o.error.nothingChanged==='boolean');
 }
 async function replay(context){
  let cursor=0,signal;
  const next=new Promise(resolve=>{signal=resolve;});
  const suspend=()=>new Promise(()=>{});
  const stop=()=>{signal(stateFailure());return suspend();};
  function dispatch(effect){
   const fingerprint=hashValue(effect),index=cursor++;
   if(index<context.transcript.length){
    const entry=context.transcript[index];
    if(entry.fingerprint!==fingerprint)return stop();
    if(entry.outcome.ok)return Promise.resolve(clone(entry.outcome.value));
    return Promise.reject(Object.assign(new Error(entry.outcome.error.message),entry.outcome.error));
   }
   if(index>=maxSteps)return stop();
   const pending={...effect,id:effectId(context,index,fingerprint)};
   const c={...context,pending};
   if(!within(c))return stop();
   signal({kind:'effect',effect:clone(pending),context:clone(c)});
   return suspend();
  }
  function query(sql,params){
   const kind=Object.keys(SQL).find(k=>SQL[k]===sql);
   if(!kind||!Array.isArray(params)||params.length!==2||!(kind==='store'?STORE_ACTIONS:PROVIDER_ACTIONS).has(params[0]))return stop();
   let payload;try{payload=JSON.parse(params[1]);}catch{return stop();}
   if(!plain(payload))return stop();
   return dispatch({kind,action:params[0],payload});
  }
  function request(r){
   // The native module, not browser data, chooses these transport descriptors.
   if(r.method==='POST'&&r.path==='/api/campaigns'&&r.responseType==='json'&&plain(r.json)&&r.json.send_at===null&&r.json.type==='regular')
    return dispatch({kind:'nativeCreate',payload:r.json});
   const match=/^\/api\/campaigns\/([1-9][0-9]*)\/preview$/.exec(r.path||'');
   if(r.method==='POST'&&match&&Number.isSafeInteger(Number(match[1]))&&r.responseType==='text'&&hasOnly(r.form,['content_type','template_id','body']))
    return dispatch({kind:'preview',idCampaign:Number(match[1]),payload:r.form});
   return stop();
  }
  const native=nativeFactory({request});
  const service=serviceFactory({store:storeFactory({query}),provider:providerFactory({query,
   nativeCreate:native.nativeCreate,validateContent:native.validateContent}),now:()=>context.now,hashValue});
  const terminal=service.handle(clone(context.auth),clone(context.request)).then(response=>cursor===context.transcript.length?
   {kind:'response',response}:stateFailure(),()=>stateFailure());
  return Promise.race([terminal,next]);
 }
 return {
  async start(auth,request,{executionId}={}){
   try{
    // Transport authentication extracts its key BEFORE calling this API. Refuse
    // unexpected top-level fields rather than persisting SQL or credentials.
    if(!validId(executionId)||!plain(request)||Object.keys(request).some(k=>!REQUEST_KEYS.has(k)))return stateFailure();
    if(request.brand!=='aristo'&&request.brand!=='fish')return {kind:'response',response:{status:422,body:{error:'BRAND_UNAVAILABLE',message:'Marca fora desta etapa.'}}};
    const context={version:VERSION,executionId,now:now(),auth:clone({actor:auth?.actor,caps:auth?.caps}),request:clone(request),transcript:[]};
    context.binding=identity(context);
    if(!within(context)||!Number.isFinite(context.now))return stateFailure();
    return await replay(context);
   }catch{return stateFailure();}
  },
  async resume(context,receipt,{executionId}={}){
   try{
    if(!validContext(context,executionId)||!plain(context.pending)||!hasOnly(receipt,['effect_id','ok','value','error'])||receipt.effect_id!==context.pending.id)return stateFailure();
    const {effect_id,...outcome}=receipt;
    if(!validOutcome(outcome))return stateFailure();
    const {id,...effect}=context.pending,fingerprint=hashValue(effect),index=context.transcript.length;
    if(id!==effectId(context,index,fingerprint)||index>=maxSteps)return stateFailure();
    const next={...clone(context),transcript:[...clone(context.transcript),{id,fingerprint,outcome:clone(outcome)}]};
    delete next.pending;
    if(!within(next))return stateFailure();
    return await replay(next);
   }catch{return stateFailure();}
  }
 };
}
module.exports={createRuntime,VERSION};
