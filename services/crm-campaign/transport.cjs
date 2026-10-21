'use strict';
const {createRuntime}=require('../../n8n/growth/campaign-runtime');
const {randomUUID}=require('node:crypto');
const AUTH_SQL='SELECT public.shrigma_crm_campaign_auth_v1($1::text) AS auth';
const CONTENT_AUTHORITY_SQL='SELECT public.shrigma_crm_campaign_content_authority_v1($1::text,$2::text) AS result';
const EFFECT_SQL='SELECT public.shrigma_crm_campaign_effect_v1($1::text,$2::jsonb,$3::jsonb) AS result';
const DB_ERRORS=new Set(['AB_V2_CAMPAIGN_FROZEN','AB_V2_SCHEDULE_REQUIRED','RECOVERY_UNAVAILABLE','RECOVERY_ALREADY_CLAIMED','RECOVERY_INVALID','AUDIENCE_REVIEW_REQUIRED','AUDIENCE_STALE','AUDIENCE_CHANGED','AUDIENCE_EMPTY','AUDIENCE_DISABLED','CAMPAIGN_RECEIPT_MISMATCH','CAMPAIGN_OPERATION_INVALID','CAMPAIGN_NOT_FOUND','CAMPAIGN_SCOPE','VERSION_CONFLICT','CAMPAIGN_LOCKED','LIST_SCOPE','TEMPLATE_SCOPE','TEMPLATE_CHANGED','INITIATIVE_INVALID','INITIATIVE_CONFLICT','VALIDATION_STALE','SCHEDULE_TOO_SOON','INITIATIVE_MISSING','CONTENT_UNVALIDATED','CONTENT_EMPTY','CAMPAIGN_EDITOR_REQUIRED','CAMPAIGN_REVIEW_REQUIRED','CAMPAIGN_DEPENDENCY_IN_USE','CAMPAIGN_CREATE_DRAFT_ONLY','CAMPAIGN_ADOPTION_REQUIRED','SEGMENT_CAMPAIGN_SELECTOR_REQUIRED']);
const unavailable=()=>({status:503,body:{error:'RUNTIME_RECONCILIATION_REQUIRED',message:'Resultado não confirmado. Consulte a operação antes de tentar novamente; não use outra chave.'}});
function safeError(e){
 if(['55P03','40P01','40001'].includes(e?.code))return {code:e.code,message:'DATABASE_ROLLBACK'};
 if(e?.code==='P0001'&&DB_ERRORS.has(e.message))return {code:e.code,message:e.message};
 return {message:'Resultado do serviço não confirmado.'};
}
function nativeTransport({origin,username,token,fetchFn=fetch,timeoutMs=20000,maxResponseBytes=2*1024*1024}){
 const base=new URL(origin);
 if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!username||!token)throw Error('NATIVE_CONFIGURATION');
 const authorization='Basic '+Buffer.from(username+':'+token).toString('base64');
 return async effect=>{
  let pathname,body,contentType;
  if(effect.kind==='nativeCreate'&&effect.payload?.type==='regular'&&effect.payload.send_at===null){pathname='/api/campaigns';body=JSON.stringify(effect.payload);contentType='application/json';}
  else if(effect.kind==='preview'&&Number.isSafeInteger(effect.idCampaign)&&effect.idCampaign>0&&effect.payload&&Object.keys(effect.payload).every(k=>['content_type','template_id','body'].includes(k))){pathname=`/api/campaigns/${effect.idCampaign}/preview`;body=new URLSearchParams(effect.payload).toString();contentType='application/x-www-form-urlencoded';}
  else throw Error('NATIVE_EFFECT_INVALID');
  // No retries, redirects, scheduling endpoint or caller-controlled URL.
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const r=await fetchFn(base.origin+pathname,{method:'POST',headers:{Authorization:authorization,'Content-Type':contentType},body,redirect:'manual',signal:controller.signal});
   if(!Number.isInteger(r.status)||r.status<200||r.status>599||!r.body)throw Error('NATIVE_RESPONSE_INVALID');
   if(Number(r.headers.get('content-length'))>maxResponseBytes)throw Error('NATIVE_RESPONSE_LARGE');
   const chunks=[];let size=0;
   for await(const chunk of r.body){size+=chunk.length;if(size>maxResponseBytes)throw Error('NATIVE_RESPONSE_LARGE');chunks.push(chunk);}
   const text=Buffer.concat(chunks).toString('utf8');
   return {status:r.status,body:effect.kind==='nativeCreate'?JSON.parse(text):text};
  }finally{clearTimeout(timer);controller.abort();}
 };
}
function createExecutor({pool,native,runtimeFactory=createRuntime,executionId=randomUUID}){
 return async({key,command,interrupted=()=>false})=>{
  const verified=(await pool.query(AUTH_SQL,[key]))?.rows;
  if(verified?.length!==1)throw Error('AUTH_RESPONSE_INVALID');
  const auth=verified[0].auth;
  if(!auth||typeof auth.actor!=='string'||!auth.actor.trim()||!Array.isArray(auth.caps)||auth.caps.some(c=>typeof c!=='string'))return {status:401,body:{error:'UNAUTHORIZED',message:'Autenticação necessária.'}};
  if(Object.hasOwn(auth,'brand')&&(!['fish','aristo'].includes(auth.brand)||auth.brand!==command.brand))return {status:403,body:{error:'BRAND_DENIED',message:'Acesso não autorizado para esta marca.'}};
  if(command.acao==='campanha_acesso'){
   if(Object.keys(command).sort().join(',')!=='acao,brand'||!['fish','aristo'].includes(command.brand)||interrupted())return unavailable();
   try{const result=await pool.query(CONTENT_AUTHORITY_SQL,[key,command.brand]);return result?.rows?.length===1&&result.rows[0].result?{status:200,body:result.rows[0].result}:{status:503,body:{error:'CONTENT_AUTHORITY_NOT_READY'}};}catch{return {status:503,body:{error:'CONTENT_AUTHORITY_NOT_READY'}};}
  }
  if(interrupted())return unavailable();
  const runtime=runtimeFactory(),id=executionId();let operation=null,step=await runtime.start({actor:auth.actor,caps:auth.caps},command,{executionId:id});
  for(let index=0;step.kind==='effect'&&index<64;index++){
   const {effect,context}=step;let receipt;
   try{
    // A disconnect/deadline never starts another business effect. A finish may
    // still preserve the outcome of an effect already sent. Keep the HTTP slot
    // occupied until this entire reconciliation settles.
    if(interrupted()&&!(effect.kind==='store'&&effect.action==='finish'&&operation))throw Error('REQUEST_ENDED');
    const {id:effectId,...descriptor}=effect;
    const envelope={command,actor:auth.actor,operation};
    const r=await pool.query(EFFECT_SQL,[key,JSON.stringify(envelope),JSON.stringify(descriptor)]);
    if(r?.rows?.length!==1||!Object.hasOwn(r.rows[0],'result'))throw Error('EFFECT_RESPONSE_INVALID');
    let value;
    if(['nativeCreate','preview'].includes(effect.kind)){
     if(r.rows[0].result?.ok!==true||interrupted())throw Error('NATIVE_AUTHORIZATION_UNCONFIRMED');
     value=await native(descriptor);
    }else{
     value={rows:r.rows};
     const claim=r.rows[0].result;
     if(effect.kind==='store'&&effect.action==='claim'&&claim?.acquired===true){
      if(typeof claim.id!=='string'||typeof claim.lease!=='string')throw Error('CLAIM_RESPONSE_INVALID');
      operation={id:claim.id,lease:claim.lease};
     }
    }
    receipt={effect_id:effectId,ok:true,value};
   }catch(e){receipt={effect_id:effect.id,ok:false,error:safeError(e)};}
   step=await runtime.resume(context,receipt,{executionId:id});
  }
  return step.kind==='response'?step.response:unavailable();
 };
}
module.exports={AUTH_SQL,CONTENT_AUTHORITY_SQL,EFFECT_SQL,DB_ERRORS,safeError,nativeTransport,createExecutor,unavailable};
