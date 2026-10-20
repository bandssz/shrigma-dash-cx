'use strict';
// Private fixed adapters for the original Campaigns service. API16 is neither
// exported nor transferred to the gateway. No opt-in or global status method.
const crypto=require('node:crypto'),{createSource,canonical}=require('./source.cjs');
const AUDIENCE='https://comunicacao-crm-audience.tazdb8.easypanel.host/segments';
const AUTH_SQL='SELECT public.shrigma_crm_campaign_auth_v1($1::text) AS auth';
const EFFECT_SQL='SELECT public.shrigma_crm_campaign_effect_v1($1::text,$2::jsonb,$3::jsonb) AS result';
const positive=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
const exact=(o,keys)=>plain(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const fail=code=>{throw Object.assign(Error(code),{code});};
async function response(r,maxBytes=2*1024*1024){
 if(!r||r.redirected||!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type')||''))fail('CONSENT_RESPONSE_UNCONFIRMED');
 let bytes=0;const chunks=[];if(!r.body)fail('CONSENT_RESPONSE_UNCONFIRMED');for await(const chunk of r.body){bytes+=chunk.length;if(bytes>maxBytes)fail('CONSENT_RESPONSE_UNCONFIRMED');chunks.push(Buffer.from(chunk));}
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('CONSENT_RESPONSE_UNCONFIRMED');}return{status:r.status,body};
}
function createNativeConsent({origin,username,token,fetchFn=fetch}){
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||typeof username!=='string'||!username||typeof token!=='string'||!token)throw Error('CONSENT_NATIVE_CONFIG');
 const authorization='Basic '+Buffer.from(username+':'+token).toString('base64'),sealKey=crypto.createHmac('sha256',token).update('shrigma-consent-provenance-key-v1\0'+username).digest();
 const sign=value=>crypto.createHmac('sha256',sealKey).update(value).digest('hex');
 const verify=(value,mac)=>typeof mac==='string'&&/^[a-f0-9]{64}$/.test(mac)&&crypto.timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(sign(value),'hex'));
 async function api(q,interrupted=()=>false){
  if(!plain(q))fail('CONSENT_NATIVE_INPUT');let pathname,method='GET',body;
  if(['campaign','list','subscriber'].includes(q.resource)&&exact(q,['resource','id'])&&positive(q.id))pathname='/api/'+{campaign:'campaigns',list:'lists',subscriber:'subscribers'}[q.resource]+'/'+q.id;
  else if(q.resource==='members'&&exact(q,['resource','id','page','perPage',...(q.subscriptionStatus!==undefined?['subscriptionStatus']:[])])&&positive(q.id)&&positive(q.page)&&q.perPage===1000&&(q.subscriptionStatus===undefined||q.subscriptionStatus==='unsubscribed')){const query=new URLSearchParams({list_id:String(q.id),page:String(q.page),per_page:'1000',order_by:'id',order:'asc'});if(q.subscriptionStatus)query.set('subscription_status',q.subscriptionStatus);pathname='/api/subscribers?'+query;}
  else if(q.resource==='unsubscribe'&&exact(q,['resource','subscriberId','originId'])&&positive(q.subscriberId)&&positive(q.originId)){pathname='/api/subscribers/lists';method='PUT';body=JSON.stringify({ids:[q.subscriberId],action:'unsubscribe',target_list_ids:[q.originId]});}
  else fail('CONSENT_NATIVE_INPUT');
  if(interrupted())fail('CONSENT_REQUEST_ENDED');return response(await fetchFn(new URL(pathname,base).href,{method,headers:{Accept:'application/json',Authorization:authorization,...(body?{'Content-Type':'application/json'}:{})},...(body?{body}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)}),q.resource==='members'?8*1024*1024:2*1024*1024);
 }
 return Object.freeze({api,sign,verify});
}
function createConsentExecutor({pool,campaignExecutor,nativeConsent,fetchFn=fetch,enabled=false}){
 if(!pool?.query||typeof campaignExecutor!=='function'||!nativeConsent)throw Error('CONSENT_EXECUTOR_CONFIG');
 async function identity(key,brand){const r=await pool.query(AUTH_SQL,[key]),a=r?.rows?.length===1?r.rows[0].auth:null;if(!a||typeof a.actor!=='string'||!a.actor.startsWith('panel:')||!Array.isArray(a.caps)||!['read_content','draft','validate','submit'].every(x=>a.caps.includes(x))||Object.hasOwn(a,'brand')&&a.brand!==brand)fail('CONSENT_ACCESS_DENIED');return canonical(a);}
 return async({key,command,interrupted=()=>false})=>{
  try{
   if(enabled!==true||!plain(command)||!['aristo','fish'].includes(command.brand))fail('CONSENT_ACCESS_DENIED');
   const {kind,brand}=command,fields={register:['kind','brand','createKey','freezeKey'],plan:['kind','brand','provenance'],member:['kind','brand','provenance','subscriberId'],unsubscribe:['kind','brand','provenance','member']}[kind];if(!fields||!exact(command,fields)||kind!=='register'&&command.provenance?.brand!==brand)fail('CONSENT_REQUEST_INVALID');
   const before=await identity(key,brand),guard=()=>{if(interrupted())fail('CONSENT_REQUEST_ENDED');};
   const audience=async(q,method)=>{guard();const url=new URL(AUDIENCE);if(method==='GET')for(const[k,v]of Object.entries(q))url.searchParams.set(k,String(v));return response(await fetchFn(url.href,{method,headers:{Accept:'application/json',Authorization:'Bearer '+key,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(q)}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25000)}));};
   const scope=async p=>{guard();if(p.brand!==brand)fail('CONSENT_ACCESS_DENIED');const result=await pool.query(EFFECT_SQL,[key,JSON.stringify({command:{acao:'campanha_nativa_contexto',brand,id:p.campaignId},actor:JSON.parse(before).actor,operation:null}),JSON.stringify({kind:'nativeContext',payload:{id:p.campaignId,purpose:'consent_scope',createKey:p.createKey,freezeKey:p.freezeKey,...(p.subscriberId===undefined?{}:{subscriberId:p.subscriberId})}})]);guard();if(result.rows?.length!==1)fail('CONSENT_SCOPE_UNCONFIRMED');return result.rows[0].result;};
   const source=createSource({scope,campaignRead:async q=>{guard();return campaignExecutor({key,command:q,interrupted});},audienceRead:q=>audience(q,'GET'),audienceCount:q=>audience(q,'POST'),api:async q=>{guard();if(q.resource==='unsubscribe'){if(await identity(key,brand)!==before)fail('CONSENT_ACCESS_CHANGED');guard();}return nativeConsent.api(q,interrupted);},sign:nativeConsent.sign,verify:nativeConsent.verify});
   guard();const result=kind==='register'?await source.register(command):kind==='plan'?await source.plan(command.provenance):kind==='member'?await source.member(command.provenance,command.subscriberId):await source.unsubscribe(command.provenance,command.member);
   guard();if(await identity(key,brand)!==before)fail('CONSENT_ACCESS_CHANGED');
   const serialized=JSON.stringify(result);if(serialized.includes(key))fail('CONSENT_RESPONSE_UNCONFIRMED');
   return{status:200,body:{schema:'crm-campaign-consent-private-result-v1',brand,kind,result}};
  }catch(e){return{status:e?.code==='CONSENT_ACCESS_DENIED'?403:503,body:{error:'CONSENT_PENDING',code:/^CONSENT_[A-Z_]{1,70}$/.test(e?.code||'')?e.code:'CONSENT_PENDING'}};}
 };
}
module.exports={createNativeConsent,createConsentExecutor,AUTH_SQL,AUDIENCE};
