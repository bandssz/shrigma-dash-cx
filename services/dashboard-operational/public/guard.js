/* Loaded before panel code. API requests use the same-origin BFF; public links are pinned below. */
(function(){'use strict';
 const ROUTES=new Set(['cx','cache','crm-read','ab','influ','tts','affiliate-read','affiliate-own-read','affiliate-own-edit','affiliate-own-operation','tts-action','organico-links','tts-cobranca','candidaturas','aprovacao','escopo','templates','campaigns','campaigns_media','segments','campaign_audience','ab_experiment','journey_graph','journey_graph_lifecycle']);
 const nativeFetch=window.fetch.bind(window);
 let csrfPromise=null,campaignWriter=false,audienceWriter=false,sessionState=null,sessionSequence=0,brandPresentationSignature=null;
 const AffiliateSession=require('./afiliados-session-read.cjs');
 const uiKey=value=>typeof value==='string'&&/^ui-[a-f0-9]{16,128}$/.test(value);
 function reject(status=403){return new Response(JSON.stringify({erro:'Rota não autorizada pelo painel.'}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
 function notifyExpired(){if(window.parent!==window)window.parent.postMessage({type:'shrigma:session-expired'},location.origin);}
 function bindBrandPresentation(user,simpleRead=false){
  window.ShrigmaSimpleRead=simpleRead===true;
  const brands=['fish','aristo','olivas'];let scope;
  if(user?.role==='superadmin'&&user.brandAccess==='all'&&user.brand===null&&Array.isArray(user.brands)&&user.brands.length===2&&['fish','aristo'].every(b=>user.brands.includes(b))){const views=user.viewBrands??user.brands;if(!Array.isArray(views)||new Set(views).size!==views.length||views.some(b=>!brands.includes(b)))throw Error('brand_scope_unavailable');scope={brand:null,brands:[...views],brandAccess:'all'};}
  else if(user?.role==='manager'&&user.brandAccess==='single'&&brands.includes(user.brand)&&Array.isArray(user.brands)&&user.brands.length===1&&user.brands[0]===user.brand)scope={brand:user.brand,brands:[user.brand],brandAccess:'single'};
  else if(user?.role==='manager'&&user.brandAccess==='multiple'&&user.brand===null&&Array.isArray(user.brands)&&user.brands.length>=2&&user.brands.length<=3&&new Set(user.brands).size===user.brands.length&&user.brands.every(b=>brands.includes(b)))scope={brand:null,brands:[...user.brands],brandAccess:'multiple'};
  else throw Error('brand_scope_unavailable');
  const signature=JSON.stringify(scope);if(signature===brandPresentationSignature)return;brandPresentationSignature=signature;
  window.ShrigmaBrandAccess=Object.freeze({...scope,brands:Object.freeze([...scope.brands])});
  if(scope.brandAccess==='single'){
   for(const button of document.querySelectorAll('#seg-marca button[data-marca]')){
    if(button.dataset.marca!==scope.brand){button.remove();continue;}
    button.disabled=true;button.setAttribute('aria-pressed','true');button.classList.add('ativo');
   }
   document.body.dataset.brandAccess='single';document.body.dataset.brand=scope.brand;
  }
  if(scope.brandAccess==='multiple'||simpleRead){
   for(const button of document.querySelectorAll('#seg-marca button[data-marca]'))if(!scope.brands.includes(button.dataset.marca))button.remove();
   document.body.dataset.brandAccess='multiple';
  }
  const active=document.querySelector('#seg-marca button[data-marca].ativo')?.dataset.marca;
  const initialBrand=scope.brands.includes(active)?active:scope.brands[0];
  // The operational build installs this listener in each panel's own lexical
  // scope. The server independently authorizes and projects every response.
  window.dispatchEvent(new CustomEvent('shrigma:brand-access',{detail:scope.brandAccess==='multiple'||simpleRead?{...scope,brandAccess:'single',brand:initialBrand}:window.ShrigmaBrandAccess}));
 }
 function stripObject(value,depth=0){
  if(depth>16)throw Error('body_too_deep');
  if(Array.isArray(value))return value.map(x=>stripObject(x,depth+1));
  if(value&&typeof value==='object'){
   const copy={};for(const [key,item]of Object.entries(value)){
    if(key.toLowerCase()==='k'||/^(?:authorization|api[_-]?key|access[_-]?key|write[_-]?key)$/i.test(key)||uiKey(item))continue;
    copy[key]=stripObject(item,depth+1);
   }return copy;
  }
  return uiKey(value)?'':value;
 }
 function cleanUrl(url){
  for(const [key,value]of [...url.searchParams])if(key.toLowerCase()==='k'||uiKey(value))url.searchParams.delete(key);
 }
 function cleanHeaders(headers){
  for(const key of [...headers.keys()])if(/^(?:authorization|cookie|x-(?:ab-write-key|tts-write-key|template-key|api-key|access-key))$/i.test(key))headers.delete(key);
 }
 async function cleanBody(input,init,method,headers){
  if(method==='GET'||method==='HEAD')return undefined;
  let body=init.body;
  if(body===undefined&&input instanceof Request)body=await input.clone().text();
  if(body===undefined||body===null)return undefined;
  if(body instanceof URLSearchParams){const params=new URLSearchParams(body);for(const [key,value]of [...params])if(key.toLowerCase()==='k'||uiKey(value))params.delete(key);return params;}
  if(typeof FormData!=='undefined'&&body instanceof FormData){const data=new FormData();for(const [key,value]of body.entries())if(key.toLowerCase()!=='k'&&!uiKey(value))data.append(key,value);return data;}
  if(typeof body!=='string')throw Error('unsupported_body');
  try{return JSON.stringify(stripObject(JSON.parse(body)));}
  catch(error){
   if(error.message==='body_too_deep')throw error;
   if(headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')){
    const params=new URLSearchParams(body);for(const [key,value]of [...params])if(key.toLowerCase()==='k'||uiKey(value))params.delete(key);return params.toString();
   }
   throw Error('unsupported_body');
  }
 }
 async function refreshSession({signal}={}){
  const sequence=++sessionSequence;
  const pending=(async()=>{
   const response=await nativeFetch('/auth/session',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal});
   if(!response.ok)throw Error('session_unavailable');
   const state=await response.json();
   if(sequence!==sessionSequence)throw Error('session_replaced');
   if(state?.authenticated!==true||typeof state.csrf!=='string'||!state.csrf){notifyExpired();throw Error('session_expired');}
   bindBrandPresentation(state.user,state.features?.simpleRead===true);sessionState=state;
   audienceWriter=state.features?.audienceDraft===true&&state.user?.permissions?.growth?.edit===true;
   campaignWriter=state.features?.campaignSubmitWrite===true&&state.user?.role==='manager'&&state.user.areas?.length===1&&state.user.areas[0]==='growth'&&state.user.permissions?.growth?.read===true&&state.user.permissions.growth.edit===true;
   return state;
  })();
  csrfPromise=pending.then(state=>state.csrf).catch(error=>{if(sequence===sessionSequence){csrfPromise=null;sessionState=null;campaignWriter=false;audienceWriter=false;}throw error;});
  // csrfPromise is also used by legacy requests; a refresh caller may be the
  // only consumer, so observe rejection without changing its fail-closed value.
  csrfPromise.catch(()=>{});
  try{return await pending;}catch(error){if(sequence===sessionSequence){csrfPromise=null;sessionState=null;campaignWriter=false;audienceWriter=false;}throw error;}
 }
 async function csrf(){
  if(!csrfPromise)refreshSession().catch(()=>{});
  const pending=csrfPromise;
  try{return await pending;}catch(error){
   // A concurrent genuine refresh may replace the cached promise. Follow that
   // one successor before any business request; never replay a POST.
   if(csrfPromise&&csrfPromise!==pending)return csrfPromise;
   throw error;
  }
 }
 // Await the existing session read before a panel captures its first brand.
 window.ShrigmaPrepareRead=async()=>{let timer;try{return await Promise.race([csrf().then(()=>true,()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),8000);})]);}finally{clearTimeout(timer);}};
 window.fetch=async function(input,init={}){
  let url;try{url=new URL(input instanceof Request?input.url:input,location.href);}catch(_){return reject();}
  if(url.origin!==location.origin)return reject();
  const route=url.pathname.match(/^\/api\/([a-z][a-z0-9_-]*)\/?$/)?.[1];
  if(!ROUTES.has(route))return reject();
  const method=String(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method))return reject(405);
  if(route==='campaigns_media'&&method!=='GET')return reject(405);
  // Resolve the authenticated brand before any panel response can be applied.
  // A missing or legacy grant remains closed; hiding controls is presentation.
  try{await csrf();}catch(_){return reject(401);}
  // The new portal DTO must never be mistaken for a legacy Growth receipt.
  // Legacy reads retain their original body; the authenticated writer profile
  // adds CSRF to reads and directs all mutations to the explicit shell editor.
  if(route==='campaigns'){
   try{await csrf();}catch(_){return reject(401);}
   if(campaignWriter&&method!=='GET')return new Response(JSON.stringify({error:'CAMPAIGN_PORTAL_EDITOR_REQUIRED',message:'Use Campanhas no portal para criar rascunhos, salvar, conferir, agendar ou cancelar.'}),{status:403,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
  cleanUrl(url);
  const headers=new Headers(init.headers||(input instanceof Request?input.headers:{}));cleanHeaders(headers);
  if(method==='GET'&&['cx','cache','crm-read'].includes(route)&&window.ShrigmaBrandAccess){
   const scope=window.ShrigmaBrandAccess,selected=document.querySelector('#seg-marca button[data-marca].ativo')?.dataset.marca??scope.brand??scope.brands[0];
   if(scope.brandAccess==='multiple'||selected==='olivas'||sessionState?.features?.simpleRead===true){
   if(!scope.brands.includes(selected))return reject();headers.set('X-Shrigma-View-Brand',selected);
   }
  }
  let body;try{body=await cleanBody(input,init,method,headers);}catch(_){return reject(415);}
  const editReceipt=method==='GET'&&(route==='campaigns'&&url.searchParams.get('acao')==='campanha_operacao'||route==='segments'&&url.searchParams.get('acao')==='segmento_operacao');
  if(!['GET','HEAD'].includes(method)||editReceipt||route==='campaigns'&&campaignWriter||route==='segments'&&audienceWriter){
   try{headers.set('X-CSRF-Token',await csrf());}catch(_){return reject(401);}
  }else headers.delete('X-CSRF-Token');
  try{
   const response=await nativeFetch(url.href,{method,headers,body,credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:init.signal||(input instanceof Request?input.signal:undefined)});
   if(response.status===401)notifyExpired();
   if(response.status===502||response.status===503){
    try{const data=await response.clone().json();if(['BRAND_READ_CONTRACT_NOT_READY','BRAND_RESPONSE_UNSCOPED'].includes(data?.error)&&window.parent!==window)window.parent.postMessage({type:'shrigma:brand-read-unavailable',code:data.error},location.origin);}catch(_){}
   }
   return response;
  }catch(_){return reject(502);}
 };
 window.ShrigmaAffiliateAccess=AffiliateSession.create({fetchImpl:(...args)=>window.fetch(...args),getSession:()=>sessionState,refreshSession});
 window.XMLHttpRequest=class{constructor(){throw Error('Use a rota autenticada do painel.');}};
 window.WebSocket=class{constructor(){throw Error('Conexão externa bloqueada.');}};
 window.EventSource=class{constructor(){throw Error('Conexão externa bloqueada.');}};
 try{navigator.sendBeacon=()=>false;}catch(_){}
 function approvedExternal(url){
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.href.length>8192)return false;
  const path=url.pathname,host=url.hostname;
  if(host==='email.shrigma.com.br')return path==='/admin/campaigns/media'&&!url.search;
  if(host==='admin.shopify.com')return !url.search&&(path==='/'||/^\/store\/(?:gwx20u-vw|c0kfm1-qt)\/orders\/[0-9]+\/?$/.test(path));
  if(host==='fishermans.com.br'||host==='oaristocrata.com')return !url.search&&(path==='/'||path==='/pages/seja-um-influenciador');
  if(host==='instagram.com'||host==='www.instagram.com')return !url.search&&/^\/(?:[A-Za-z0-9._]{1,30}|(?:p|reel|tv)\/[A-Za-z0-9_-]{1,80})\/?$/.test(path);
  if(host==='www.tiktok.com')return !url.search&&/^\/@[A-Za-z0-9._]{2,30}(?:\/video\/[0-9]{6,25})?\/?$/.test(path);
  if(host==='partner.tiktokshop.com')return path==='/'&&!url.search;
  if(host==='services.tiktokshop.com')return path==='/open/authorize'&&url.search==='?service_id=7670181171502434055';
  if(host==='wa.me'&&/^\/[0-9]{12,13}\/?$/.test(path)){
   const params=[...url.searchParams];return !params.length||params.length===1&&params[0][0]==='text'&&params[0][1].length<=2048;
  }
  return false;
 }
 const nativeOpen=window.open?.bind(window);
 window.open=function(destination,...args){try{const url=new URL(destination,location.href);if(url.origin===location.origin)return nativeOpen?.(url.href,...args);if(approvedExternal(url))return nativeOpen?.(url.href,'_blank','noopener,noreferrer');}catch(_){}return null;};
 document.addEventListener('click',event=>{
  const link=event.target.closest?.('a[href]');if(!link)return;
  try{
   const url=new URL(link.href,location.href);
   if(url.origin===location.origin||['blob:','data:'].includes(url.protocol))return;
   if(approvedExternal(url)){
    link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';return;
   }
  }catch(_){}
  event.preventDefault();event.stopImmediatePropagation();link.title='Destino externo indisponível neste painel.';
 },true);
 document.addEventListener('submit',event=>{
  const form=event.target;if(!(form instanceof HTMLFormElement))return;
  try{if(new URL(form.action,location.href).origin===location.origin)return;}catch(_){}
  event.preventDefault();event.stopImmediatePropagation();
 },true);
})();
