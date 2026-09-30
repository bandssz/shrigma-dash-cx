/* Loaded before panel code. Browser requests can reach only the same-origin BFF. */
(function(){'use strict';
 const ROUTES=new Set(['cx','cache','crm-read','ab','influ','tts','tts-action','organico-links','tts-cobranca','candidaturas','aprovacao','escopo','templates','campaigns','segments','campaign_audience','ab_experiment','journey_graph','journey_graph_lifecycle']);
 const nativeFetch=window.fetch.bind(window);
 let csrfPromise=null;
 const uiKey=value=>typeof value==='string'&&/^ui-[a-f0-9]{16,128}$/.test(value);
 function reject(status=403){return new Response(JSON.stringify({erro:'Rota não autorizada pelo painel.'}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
 function notifyExpired(){if(window.parent!==window)window.parent.postMessage({type:'shrigma:session-expired'},location.origin);}
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
 async function csrf(){
  if(!csrfPromise)csrfPromise=(async()=>{
   const response=await nativeFetch('/auth/session',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
   if(!response.ok)throw Error('session_unavailable');
   const state=await response.json();
   if(state?.authenticated!==true||typeof state.csrf!=='string'||!state.csrf){notifyExpired();throw Error('session_expired');}
   return state.csrf;
  })().catch(error=>{csrfPromise=null;throw error;});
  return csrfPromise;
 }
 window.fetch=async function(input,init={}){
  let url;try{url=new URL(input instanceof Request?input.url:input,location.href);}catch(_){return reject();}
  if(url.origin!==location.origin)return reject();
  const route=url.pathname.match(/^\/api\/([a-z][a-z0-9_-]*)\/?$/)?.[1];
  if(!ROUTES.has(route))return reject();
  const method=String(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method))return reject(405);
  cleanUrl(url);
  const headers=new Headers(init.headers||(input instanceof Request?input.headers:{}));cleanHeaders(headers);
  let body;try{body=await cleanBody(input,init,method,headers);}catch(_){return reject(415);}
  if(!['GET','HEAD'].includes(method)){
   try{headers.set('X-CSRF-Token',await csrf());}catch(_){return reject(401);}
  }else headers.delete('X-CSRF-Token');
  try{
   const response=await nativeFetch(url.href,{method,headers,body,credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:init.signal||(input instanceof Request?input.signal:undefined)});
   if(response.status===401)notifyExpired();
   return response;
  }catch(_){return reject(502);}
 };
 window.XMLHttpRequest=class{constructor(){throw Error('Use a rota autenticada do painel.');}};
 window.WebSocket=class{constructor(){throw Error('Conexão externa bloqueada.');}};
 window.EventSource=class{constructor(){throw Error('Conexão externa bloqueada.');}};
 try{navigator.sendBeacon=()=>false;}catch(_){}
 const nativeOpen=window.open?.bind(window);
 window.open=function(destination,...args){try{const url=new URL(destination,location.href);if(url.origin===location.origin)return nativeOpen?.(url.href,...args);}catch(_){}return null;};
 document.addEventListener('click',event=>{
  const link=event.target.closest?.('a[href]');if(!link)return;
  try{const url=new URL(link.href,location.href);if(url.origin===location.origin||['blob:','data:'].includes(url.protocol))return;}catch(_){}
  event.preventDefault();event.stopImmediatePropagation();link.title='Destino externo indisponível neste painel.';
 },true);
 document.addEventListener('submit',event=>{
  const form=event.target;if(!(form instanceof HTMLFormElement))return;
  try{if(new URL(form.action,location.href).origin===location.origin)return;}catch(_){}
  event.preventDefault();event.stopImmediatePropagation();
 },true);
})();
