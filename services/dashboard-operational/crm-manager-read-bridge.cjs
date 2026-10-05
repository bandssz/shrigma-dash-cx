'use strict';
// PRIVATE candidate. Loading or constructing this module performs no I/O.
// Only these read actions may use an attested crm-panel-read principal.
const P=require('./proxy.cjs');
const MediaRead=require('./crm-media-read-validator.cjs');
const CAPS=Object.freeze(['read_content','list_history','submission']);
const DESTINATIONS=Object.freeze({
 'crm-read':'https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read',
 campaigns:'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35',
 campaigns_media:'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35/media'
});
// These two baseline routes retain their own credential/method/area policy in
// server/proxy. The managed principal bridge never forwards them.
const PASSTHROUGH_DESTINATIONS=Object.freeze({
 cx:'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d',
 influ:'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-influ-api-7c41e0b93a5d8f26'
});
const PROFILE_DESTINATIONS=Object.freeze({...DESTINATIONS,...PASSTHROUGH_DESTINATIONS});
const ACTIONS=Object.freeze({campaigns:Object.freeze(['campanha_catalogo','campanha_listar','campanha_obter']),campaigns_media:Object.freeze([''])});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING_KEYS=['userId','owner','lifecycleId','lifecycleVersion','principalId','generation','expiresAt','credentialMac','slot','caps'];
class ManagedReadError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=403,code='MANAGED_READ_DENIED')=>{throw new ManagedReadError(status,code);};
function plain(v){return !!v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;}
function record(v,keys){return plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&Object.hasOwn(d,'value')&&d.enumerable;});}
function sync(v){if(v&&typeof v.then==='function'){Promise.resolve(v).catch(()=>{});fail();}return v;}
function binding(v){
 if(!record(v,BINDING_KEYS)||!UUID.test(v.userId)||!UUID.test(v.lifecycleId)||!/^dcrm-[a-f0-9]{32}$/.test(v.principalId)||
  !Number.isSafeInteger(v.lifecycleVersion)||v.lifecycleVersion<1||!Number.isSafeInteger(v.generation)||v.generation<1||
  !Number.isSafeInteger(v.expiresAt)||v.expiresAt<1||typeof v.owner!=='string'||!/^[-a-z0-9.!#$%&'*+/=?^_`{|}~]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v.owner)||
  v.slot!=='crm-panel-read'||!/^([a-f0-9]{64})$/.test(v.credentialMac)||!Array.isArray(v.caps)||Reflect.ownKeys(v.caps).length!==4||v.caps.length!==3||
  CAPS.some((c,i)=>{const d=Object.getOwnPropertyDescriptor(v.caps,String(i));return !d||!Object.hasOwn(d,'value')||d.value!==c;}))fail(503,'MANAGED_READ_NOT_READY');
 return JSON.stringify(BINDING_KEYS.map(k=>[k,v[k]]));
}
function decision(route,method,query){
 if(method!=='GET'||!(query instanceof URLSearchParams)||!Object.hasOwn(ACTIONS,route))fail();
 try{query=new URLSearchParams(URLSearchParams.prototype.toString.call(query));}catch{fail();}
 let d;try{d=P.decide(route,method,query,undefined);}catch{fail();}
 if(d.edit||d.area!=='growth'||!ACTIONS[route].includes(d.action)||!['fish','aristo'].includes(query.get('brand')))fail();
 if(route==='campaigns_media')try{MediaRead.mediaRequest(query);}catch{fail();}
 return Object.freeze({...d,sourceCredentialSlot:'crm-panel-read'});
}
function validateReadUpstreams(upstreams){
 if(!upstreams||typeof upstreams!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(upstreams))||!Object.hasOwn(upstreams,'crm-read')||Reflect.ownKeys(upstreams).some(k=>typeof k!=='string'||!Object.hasOwn(PROFILE_DESTINATIONS,k)))fail();
 for(const k of Reflect.ownKeys(upstreams)){const d=Object.getOwnPropertyDescriptor(upstreams,k);if(!d||!Object.hasOwn(d,'value')||!d.enumerable||!(d.value instanceof URL)||d.value.href!==PROFILE_DESTINATIONS[k])fail();}
 return Object.freeze(Object.fromEntries(Object.entries(upstreams).map(([k,v])=>[k,new URL(v.href)])));
}
function responseShape(d,value,query,credential){
 if(!plain(value))fail(502,'MANAGED_READ_RESPONSE_DENIED');
 const brand=query.get('brand');
 if(d.route==='campaigns_media'){
  const r=MediaRead.mediaRequest(query);
  try{return MediaRead.validateMediaLibraryResponse(value,{brand:r.brand,page:r.page,per_page:r.per_page,secrets:[credential]}).body;}catch{fail(502,'MANAGED_READ_RESPONSE_DENIED');}
 }else if(d.action==='campanha_catalogo'){
  if(value.brand!==brand||!Array.isArray(value.lists)||!Array.isArray(value.templates)||!Array.isArray(value.initiatives)||value.lists.some(x=>!plain(x)||x.brand!==brand))fail(502,'MANAGED_READ_RESPONSE_DENIED');
 }else if(d.action==='campanha_listar'){
  if(!Array.isArray(value.campaigns)||value.campaigns.some(x=>!plain(x)||x.definition?.brand!==brand))fail(502,'MANAGED_READ_RESPONSE_DENIED');
 }else if(!plain(value.campaign)||value.campaign.id!==Number(query.get('id'))||value.campaign.definition?.brand!==brand)fail(502,'MANAGED_READ_RESPONSE_DENIED');
 return value;
}
function createManagedReadBridge(config,{fetchImpl=globalThis.fetch}={}){
 if(!record(config,['auth','upstreams','enabled'])||typeof config.enabled!=='boolean'||typeof fetchImpl!=='function'||
  typeof config.auth?.managedCrmReadAuthorization!=='function'||typeof config.auth?.getUpstreamCredential!=='function')fail();
 const auth=config.auth,upstreams=validateReadUpstreams(config.upstreams),enabled=config.enabled;
 async function read(value,onSettled){
  if(onSettled!==undefined&&typeof onSettled!=='function')fail();
  if(!enabled)fail(503,'MANAGED_READ_DISABLED');
  if(!record(value,['context','route','method','query','origin']))fail();
  let {context,route,method,query,origin}=value;
  if(!(query instanceof URLSearchParams))fail();
  try{query=new URLSearchParams(URLSearchParams.prototype.toString.call(query));}catch{fail();}
  const d=decision(route,method,query),target=upstreams[route];if(!target)fail(503,'MANAGED_READ_NOT_CONFIGURED');
  if(context?.method!=='GET'||typeof context.host!=='string'||origin!=='https://'+context.host)fail();
  const ctx={...context,method:'GET',area:'growth',edit:false};if(ctx.brand!==query.get('brand'))fail();
  let proof,credential,initial;
  try{proof=sync(auth.managedCrmReadAuthorization(ctx));initial=binding(proof);credential=sync(auth.getUpstreamCredential({...ctx,slot:'crm-panel-read'}));if(typeof credential!=='string'||!/^[a-f0-9]{64}$/.test(credential)||initial!==binding(sync(auth.managedCrmReadAuthorization(ctx))))fail();}
  catch{fail(503,'MANAGED_READ_NOT_READY');}
  const url=new URL(target.href);url.search=(d.route==='campaigns_media'?MediaRead.mediaRequest(query).query:query).toString();const controller=new AbortController();let reader,timer;
  const max=d.route==='campaigns_media'?2*1024*1024:4*1024*1024;
  const cancel=()=>{try{const v=reader?.cancel();Promise.resolve(v).catch(()=>{});}catch{}};
  const work=async()=>{
   const r=await fetchImpl(url,{method:'GET',redirect:'manual',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json','Accept-Encoding':'identity',Authorization:'Bearer '+credential}});
   if(r?.status!==200||r.redirected===true||r.url&&r.url!==url.href||['opaque','opaqueredirect','error'].includes(r.type))fail(502,'MANAGED_READ_UPSTREAM_UNAVAILABLE');
   const header=name=>sync(r.headers.get(name));
   if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header('content-type')||'')||!['',null,'identity'].includes(header('content-encoding')))fail(502,'MANAGED_READ_RESPONSE_DENIED');
   const length=header('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>max))fail(502,'MANAGED_READ_RESPONSE_DENIED');
   reader=sync(r.body?.getReader());if(typeof reader?.read!=='function')fail(502,'MANAGED_READ_RESPONSE_DENIED');
   let bytes=0;const chunks=[];for(;;){const v=await reader.read();if(!v||typeof v.done!=='boolean')fail();if(v.done)break;if(!(v.value instanceof Uint8Array))fail();bytes+=v.value.byteLength;if(bytes>max)fail(502,'MANAGED_READ_RESPONSE_DENIED');chunks.push(Buffer.from(v.value));}
   if(length!==null&&Number(length)!==bytes)fail(502,'MANAGED_READ_RESPONSE_DENIED');
   let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail(502,'MANAGED_READ_RESPONSE_DENIED');}
   if(JSON.stringify(value).includes(credential))fail(502,'MANAGED_READ_RESPONSE_DENIED');
   value=responseShape(d,value,query,credential);
   try{if(initial!==binding(sync(auth.managedCrmReadAuthorization(ctx))))fail();}catch{fail(503,'MANAGED_READ_NOT_READY');}
   return {status:200,body:P.rewriteCapabilities(value,upstreams,origin,{route})};
  };
  const active=work(),settled=active.then(()=>undefined,()=>undefined);
  try{if(onSettled)sync(onSettled(settled));return await Promise.race([active,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel();reject(new ManagedReadError(502,'MANAGED_READ_UPSTREAM_UNAVAILABLE'));},25000);})]);}
  catch(e){if(e instanceof ManagedReadError)throw e;fail(502,'MANAGED_READ_UPSTREAM_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.abort();cancel();try{Promise.resolve(reader?.releaseLock()).catch(()=>{});}catch{}}
 }
 return Object.freeze({read});
}
module.exports={createManagedReadBridge,validateReadUpstreams,decision,ManagedReadError,DESTINATIONS,PASSTHROUGH_DESTINATIONS,ACTIONS,CAPS};
