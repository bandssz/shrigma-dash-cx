'use strict';
const {createRuntime}=require('../../n8n/growth/campaign-runtime');
const {randomUUID}=require('node:crypto');
const AUTH_SQL='SELECT public.shrigma_crm_campaign_auth_v1($1::text) AS auth';
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
  let pathname,body,contentType,method='POST';
  if(effect.kind==='nativeCreate'&&effect.payload?.type==='regular'&&effect.payload.send_at===null){pathname='/api/campaigns';body=JSON.stringify(effect.payload);contentType='application/json';}
  else if(effect.kind==='preview'&&Number.isSafeInteger(effect.idCampaign)&&effect.idCampaign>0&&effect.payload&&Object.keys(effect.payload).every(k=>['content_type','template_id','body'].includes(k))){pathname=`/api/campaigns/${effect.idCampaign}/preview`;body=new URLSearchParams(effect.payload).toString();contentType='application/x-www-form-urlencoded';}
  else if(['nativeRead','nativeStatus','nativeClear'].includes(effect.kind)&&Number.isSafeInteger(effect.idCampaign)&&effect.idCampaign>0){
   const p=effect.payload;if(!p||Object.getPrototypeOf(p)!==Object.prototype)throw Error('NATIVE_EFFECT_INVALID');
   pathname='/api/campaigns/'+effect.idCampaign;
   if(effect.kind==='nativeRead'){if(Object.keys(p).length)throw Error('NATIVE_EFFECT_INVALID');method='GET';}
   else{method='PUT';contentType='application/json';
    if(effect.kind==='nativeStatus'){if(Object.keys(p).join(',')!=='status'||!['draft','scheduled'].includes(p.status))throw Error('NATIVE_EFFECT_INVALID');pathname+='/status';}
    else if(Object.keys(p).sort().join(',')!=='attribs,lists,send_at'||p.send_at!==null||!Array.isArray(p.lists)||p.lists.length!==1||!Number.isSafeInteger(p.lists[0])||p.lists[0]<1||!p.attribs||Object.getPrototypeOf(p.attribs)!==Object.prototype)throw Error('NATIVE_EFFECT_INVALID');
    body=JSON.stringify(p);
   }
  }else throw Error('NATIVE_EFFECT_INVALID');
  // No retries, redirects, scheduling endpoint or caller-controlled URL.
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const r=await fetchFn(base.origin+pathname,{method,headers:{Authorization:authorization,...(contentType?{'Content-Type':contentType}:{})},...(body===undefined?{}:{body}),redirect:'manual',signal:controller.signal});
   if(!Number.isInteger(r.status)||r.status<200||r.status>599||!r.body)throw Error('NATIVE_RESPONSE_INVALID');
   if(Number(r.headers.get('content-length'))>maxResponseBytes)throw Error('NATIVE_RESPONSE_LARGE');
   const chunks=[];let size=0;
   for await(const chunk of r.body){size+=chunk.length;if(size>maxResponseBytes)throw Error('NATIVE_RESPONSE_LARGE');chunks.push(chunk);}
   const text=Buffer.concat(chunks).toString('utf8');
   return {status:r.status,body:effect.kind==='preview'?text:JSON.parse(text)};
  }finally{clearTimeout(timer);controller.abort();}
 };
}
function createExecutor({pool,native,runtimeFactory=createRuntime,executionId=randomUUID,nativeInternalEnabled=false,now=Date.now}){
 let recentDiagnostic=null;
 return async({key,command,interrupted=()=>false})=>{
  const verified=(await pool.query(AUTH_SQL,[key]))?.rows;
  if(verified?.length!==1)throw Error('AUTH_RESPONSE_INVALID');
  const auth=verified[0].auth;let observedThisCommand=false;
  // Temporary QA-only, single bounded observation. No payload/body/key/history.
  const observe=(descriptor,result,error)=>{if(command.id!==207||!['campanha_cancelar','campanha_reconciliar_cancelamento'].includes(command.acao)||descriptor.kind==='nativeCancelRecovery'&&observedThisCommand)return;const text=String(error?.message||result?.body?.message||result?.body?.error||''),token=/\bNATIVE_[A-Z0-9_]{1,90}\b/.exec(text)?.[0],sqlstate=/^[A-Z0-9]{5}$/.test(error?.code||'')?error.code:null;if(!error&&!(result?.status>=400))return;observedThisCommand=true;const crypto=require('node:crypto'),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),ciphertext=Buffer.concat([cipher.update(JSON.stringify({message:text.slice(0,2048)})),cipher.final()]),wrappedKey=crypto.publicEncrypt({key:"-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA7nJmedxKJsJNKtzp6ETq\nnrGIAjibq7HQdugQli9Vv/NeGoL5pLB0Gn8eK9pHu5Fn7ucCTzY3t43DwUALt7gC\nfEtHx7v4xmP1TxRTFE+VsRLKDQo3kJa9U1ZhWXzw96zRfvWbDEG46rBl2WnUyW7h\nPNtn4SqET8lNBJPfIbsfvyAyhU3W3E4WwEji9kDJRoVFKidEpYte9pUg2gE66rd8\nL3sVLJTK9G54JCNeBaw6fwmcDh1OMtNPg32zzwoMxynK8xO7DLDdrD4qVdHJ7fel\nNw8/cyKZTBVTWVgdwoUDDcz00HDS3NIDjoEI1nccCuQIjTjA8MwDD9hKxH5hwfxt\nDQANZvnGaGgXNzcrmIZtM7L1s1EmoJd95/S1qjn7v9emN+hVGqXznG/Lzw88zS1V\nYNtOC7uhK4LPYKYVf46sRiNHtsq4LarC9qtDUeGW3767qiaZxFKC/pC0ETPsvMuV\najmIlC4EeDu4iv/XKzvaXFNA+v4X9OjT0LZgB+IyjqKbAgMBAAE=\n-----END PUBLIC KEY-----\n",oaepHash:'sha256'},key);key.fill(0);const encryptedDetail={schema:'shrigma-rsa-private-diagnostic-v1',algorithm:'RSA-OAEP-SHA256/AES-256-GCM',wrappedKey:wrappedKey.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};recentDiagnostic=Object.freeze({encrypted_detail:encryptedDetail,campaign_id:207,brand:command.brand,kind:descriptor.kind,code:token||((result?.status>=400)?'NATIVE_HTTP_'+result.status:'NATIVE_EFFECT_UNCONFIRMED'),http:Number.isInteger(result?.status)?result.status:null,sqlstate,at_utc:new Date(now()).toISOString(),expires_at:new Date(now()+600000).toISOString()});};
  const observedNative=async descriptor=>{try{const result=await native(descriptor);observe(descriptor,result,null);return result;}catch(error){observe(descriptor,null,error);throw error;}};
  if(!auth||typeof auth.actor!=='string'||!auth.actor.trim()||!Array.isArray(auth.caps)||auth.caps.some(c=>typeof c!=='string'))return {status:401,body:{error:'UNAUTHORIZED',message:'Autenticação necessária.'}};
  if(Object.hasOwn(auth,'brand')&&(!['fish','aristo'].includes(auth.brand)||auth.brand!==command.brand))return {status:403,body:{error:'BRAND_DENIED',message:'Acesso não autorizado para esta marca.'}};
  if(interrupted())return unavailable();
  if(command.acao==='campanha_reconciliar_cancelamento'){
   if(!nativeInternalEnabled||!['read_content','draft','validate','submit'].every(c=>auth.caps.includes(c)))return {status:403,body:{error:'NATIVE_INTERNAL_DISABLED'}};
   return recoverNativeCancel({pool,native:observedNative,key,command,auth,interrupted,EFFECT_SQL,onDiagnostic:(descriptor,error)=>observe(descriptor,null,error)});
  }
  if(command.acao==='campanha_nativa_contexto'){
   if(!nativeInternalEnabled||Object.keys(command).sort().join(',')!=='acao,brand,id'||!['fish','aristo'].includes(command.brand)||!Number.isSafeInteger(command.id)||command.id<1)return {status:403,body:{error:'NATIVE_INTERNAL_DISABLED'}};
   try{const r=await pool.query(EFFECT_SQL,[key,JSON.stringify({command,actor:auth.actor,operation:null}),JSON.stringify({kind:'nativeContext',payload:{id:command.id}})]);return r.rows?.length===1?{status:200,body:{...r.rows[0].result,...(command.id===207&&recentDiagnostic?.campaign_id===207&&recentDiagnostic.brand===command.brand&&Date.parse(recentDiagnostic.expires_at)>now()?{native_cancel_diagnostic:recentDiagnostic}:{})}}:unavailable();}catch{return {status:403,body:{error:'NATIVE_INTERNAL_REFUSED'}};}
  }
  const runtime=runtimeFactory({nativeInternalEnabled}),id=executionId();let operation=null,step=await runtime.start({actor:auth.actor,caps:auth.caps},command,{executionId:id});
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
    if(['nativeCreate','preview','nativeRead','nativeStatus','nativeClear'].includes(effect.kind)){
     if(r.rows[0].result?.ok!==true||interrupted())throw Error('NATIVE_AUTHORIZATION_UNCONFIRMED');
     value=await observedNative(descriptor);
    }else{
     value={rows:r.rows};
     const claim=r.rows[0].result;
     if(effect.kind==='store'&&effect.action==='claim'&&claim?.acquired===true){
      if(typeof claim.id!=='string'||typeof claim.lease!=='string')throw Error('CLAIM_RESPONSE_INVALID');
      operation={id:claim.id,lease:claim.lease};
     }
    }
    receipt={effect_id:effectId,ok:true,value};
   }catch(e){observe(effect,null,e);receipt={effect_id:effect.id,ok:false,error:safeError(e)};}
   step=await runtime.resume(context,receipt,{executionId:id});
  }
  return step.kind==='response'?step.response:unavailable();
 };
}
module.exports={AUTH_SQL,EFFECT_SQL,DB_ERRORS,safeError,nativeTransport,createExecutor,unavailable};

'use strict';
// One explicit continuation. Native status is never rewritten or scheduled.
const a=require('node:assert/strict'),{createHash}=require('node:crypto');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
async function recoverNativeCancel({pool,native,key,command:input,auth,interrupted,EFFECT_SQL,onDiagnostic=()=>{}}){
 const command={...input,acao:'campanha_cancelar'};let operation=null,stage='input';
 const effect=async descriptor=>{a(!interrupted());try{const r=await pool.query(EFFECT_SQL,[key,JSON.stringify({command,actor:auth.actor,operation}),JSON.stringify(descriptor)]);a.equal(r.rows?.length,1);return r.rows[0].result;}catch(error){onDiagnostic(descriptor,error);throw error;}};
 try{
  a.equal(Object.keys(command).sort().join(','),'acao,brand,confirm,expected_version,id,idempotency_key');a.equal(command.confirm,'cancelar');
  const readOperation=async()=>{a(!interrupted());const envelope={command:{acao:'campanha_operacao',brand:command.brand,idempotency_key:command.idempotency_key},actor:auth.actor,operation:null};const r=await pool.query(EFFECT_SQL,[key,JSON.stringify(envelope),JSON.stringify({kind:'store',action:'get',payload:{actor:auth.actor,key:command.idempotency_key}})]);a.equal(r.rows?.length,1);return r.rows[0].result;};
  stage='read-operation';const recorded=await readOperation(),chain=recorded?.response?.body?.reconciliation;
  if(recorded?.state==='succeeded'&&recorded.action==='cancelar'&&recorded.brand===command.brand&&recorded.operation_key===command.idempotency_key&&recorded.providerId===command.id&&recorded.response.status===200&&recorded.response.body.native_internal===true&&chain?.contract==='crm-native-cancel-recovery-v1'&&chain.operation_id===recorded.id&&chain.request_hash===hash(command)&&chain.previous_operation?.state==='outcome_unknown'&&chain.previous_operation.id===recorded.id){return {status:200,body:{schema:'crm-native-cancel-reconciliation-v1',prior_receipt_sha256:hash(chain.previous_operation),operation:recorded}};}
  stage='plan';const p=await effect({kind:'nativeCancelRecovery',payload:{id:command.id}});a.equal(p.contract,'crm-native-internal-plan-v1');a.equal(p.campaign_id,command.id);operation=p.operation;
  async function request(kind,payload={}){const d={kind,idCampaign:p.campaign_id,payload};a.equal((await effect(d)).ok,true);a(!interrupted());return native(d);}
  async function read(expectedDate){stage=expectedDate===null?'read-cleared':'read-dated';const r=await request('nativeRead');a.equal(r.status,200);const c=r.body?.data;a.equal(c?.id,p.campaign_id);a.equal(c.uuid,p.campaign_uuid);a.equal(c.status,'draft');a.equal(c.sent,0);a.equal(c.started_at??null,null);a.deepEqual(c.lists?.map(l=>l.id),[p.list_id]);a.equal(c.send_at===null?null:Date.parse(c.send_at),expectedDate===null?null:Date.parse(expectedDate));return c;}
  if(!p.completed){const c=await read(p.send_at);a(c.attribs&&Object.getPrototypeOf(c.attribs)===Object.prototype);stage='native-clear';const r=await request('nativeClear',{send_at:null,lists:[p.list_id],attribs:c.attribs});a.equal(r.status,200);}
  await read(null);
  stage='finish';await effect({kind:'provider',action:'native_result',payload:{id:p.campaign_id,operationId:operation.id}});
  const saved=await readOperation();a.equal(saved.id,operation.id);a.equal(saved.state,'succeeded');a.equal(saved.response.body.native_internal,true);a.equal(saved.response.body.campaign.send_at,null);
  return {status:200,body:{schema:'crm-native-cancel-reconciliation-v1',prior_receipt_sha256:hash(p.previous_operation),operation:saved}};
 }catch(error){onDiagnostic({kind:'nativeCancelRecovery',stage},error);return {status:503,body:{error:'NATIVE_CANCEL_RECONCILIATION_UNCONFIRMED',message:'Cancelamento ainda sem confirmação. Consulte a mesma tentativa.'}};}
}

