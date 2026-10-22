'use strict';
/* Páginas reais do portal corporativo num DOM local (linkedom), sem navegador real.
   - artifact(): artefato construído por services/dashboard-operational/build.cjs (uma vez por processo).
   - transport(app): {get,post} sobre createServer real, sem socket (app.emit('request')).
   - shell(): entrada do portal (<área>/index.html + entry.js, campaign-edit.js, campaign-bff-client.js
     compilados), com cookie de sessão, CSRF e metadados Sec-Fetch como o navegador mandaria.
   - panel(): página do painel servida pelo portal (growth.html com guard.js + bundle publicado), com
     window.parent registrando as mensagens que o painel manda para a entrada.
   Nada sai da máquina: qualquer origem diferente da do portal é recusada pelo próprio teste. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events'),{parseHTML}=require('linkedom');
const {build}=require('../../services/dashboard-operational/build.cjs');
let built;
function artifact(){if(!built){const d=fs.mkdtempSync(path.join(os.tmpdir(),'portal-artifact-'));built=build(path.join(d,'out')).directory;}return built;}
async function until(check,label,ms=8000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)assert.fail('não estabilizou: '+(typeof label==='function'?label():label));await new Promise(r=>setTimeout(r,5));}}
function transport(app){
 const call=(host,pathname,{method='GET',body,cookie,csrf,origin,metadata={}}={})=>new Promise(resolve=>{
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  const headers={host,...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...(origin?{origin}:{}),...(csrf?{'x-csrf-token':csrf}:{})};
  for(const [k,v]of Object.entries(metadata))headers[k.toLowerCase()]=v;
  Object.assign(req,{url:pathname,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  const res=new EventEmitter(),out={};res.statusCode=200;
  res.setHeader=(k,v)=>{out[k.toLowerCase()]=Array.isArray(v)?v:[String(v)];};res.getHeader=k=>out[k.toLowerCase()];res.removeHeader=k=>{delete out[k.toLowerCase()];};
  res.writeHead=(status,h={})=>{res.statusCode=status;for(const [k,v]of Object.entries(h))res.setHeader(k,v);return res;};
  res.write=()=>true;
  res.end=bytes=>{res.writableEnded=true;res.writableFinished=true;res.emit('finish');const text=bytes===undefined?'':String(bytes);let json=null;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:out,text,json});};
  res.destroy=()=>{res.destroyed=true;res.emit('close');resolve({status:500,headers:out,text:'',json:{error:'TEST_DESTROYED'}});};
  app.emit('request',req,res);
 });
 return {get:(host,p,ctx={})=>call(host,p,ctx),post:(host,p,body,ctx={})=>call(host,p,{...ctx,method:'POST',body})};
}
const META={'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'};
function realmOf(sandbox){return v=>{sandbox.__e=JSON.stringify(v);try{return vm.runInContext('JSON.parse(__e)',sandbox);}finally{delete sandbox.__e;}};}
function shell(http,{host,area='crm',hash='',cookie:initialCookie='',values=new Map(),confirm=()=>false,password,loseAck=null}={}){
 const pub=path.join(artifact(),'public'),html=fs.readFileSync(path.join(pub,area,'index.html'),'utf8'),{document,window:w}=parseHTML(html);
 Object.defineProperty(w.HTMLInputElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(v){this.toggleAttribute('checked',Boolean(v));}});
 let focus=document.body;Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focus});w.HTMLElement.prototype.focus=function(){focus=this;};
 Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(v){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(v));}});
 const dialog=document.getElementById('entry-campaign-dialog');if(dialog){Object.defineProperty(dialog,'open',{configurable:true,get:()=>dialog.hasAttribute('open')});dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};}
 const originUrl='https://'+host,calls=[],confirms=[];let cookie=initialCookie;
 const context={document,location:new URL(originUrl+'/'+(hash?'#'+hash:'')),history:{replaceState(){}},navigator:{locks:{request(name,options,cb){if(typeof options==='function')cb=options;return Promise.resolve(cb({name,mode:'exclusive'}));}},clipboard:{writeText:async()=>{}}},
  localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  Date,URL,URLSearchParams,Headers,AbortController,TextEncoder,Event:w.Event,crypto:crypto.webcrypto,setTimeout,clearTimeout,confirm:text=>{confirms.push(text);return confirm(text);},addEventListener:w.addEventListener.bind(w),removeEventListener:w.removeEventListener.bind(w),dispatchEvent:w.dispatchEvent.bind(w),HTMLElement:w.HTMLElement,console};
 context.window=context;context.parent=context;const sandbox=vm.createContext(context),realm=realmOf(sandbox);
 context.fetch=async(value,options={})=>{
  const url=new URL(value,originUrl);assert.equal(url.origin,originUrl);assert.equal(options.credentials,'same-origin');
  const headers=new Headers(options.headers);assert.equal(headers.has('authorization'),false);
  const method=options.method||'GET',body=options.body===undefined?undefined:JSON.parse(options.body);
  const ctx={cookie,csrf:headers.get('x-csrf-token')||undefined,origin:method==='GET'?null:originUrl,metadata:META};
  const r=method==='POST'?await http.post(host,url.pathname+url.search,body,ctx):await http.get(host,url.pathname+url.search,ctx);
  const set=r.headers['set-cookie'];if(set)cookie=set[0].split(';')[0];
  calls.push({method,path:url.pathname+url.search,status:r.status,body,response:r.json});
  // ACK perdido: o servidor respondeu (e gravou); o navegador não recebe a resposta.
  if(loseAck&&loseAck(method,body,r))throw new TypeError('synthetic lost ACK');
  return {status:r.status,ok:r.status>=200&&r.status<300,json:async()=>realm(r.json??{})};
 };
 for(const src of [...document.querySelectorAll('script[src]')].map(n=>n.getAttribute('src')))vm.runInContext(fs.readFileSync(path.join(pub,src.replace(/^\//,'').replace(/\?.*$/,'')),'utf8'),sandbox,{filename:src});
 const el=id=>document.getElementById(id);
 const x={document,window:w,dialog,calls,confirms,values,el,cookie:()=>cookie,
  input(id,v){const e=el(id);e.value=v;e.dispatchEvent(new w.Event('input',{bubbles:true}));},
  check(id){const e=el(id);e.checked=true;e.dispatchEvent(new w.Event('change',{bubbles:true}));},
  select(id,v){const e=el(id);e.value=v;e.dispatchEvent(new w.Event('change',{bubbles:true}));},
  async submit(id){const f=el(id);f.dispatchEvent(new w.Event('submit',{cancelable:true}));},
  async ready(){await until(()=>calls.some(c=>c.path==='/auth/session')||!el('invite-form').hidden,'entrada');},
  async login(email,pass=password){await until(()=>calls.some(c=>c.path==='/auth/session'||c.path==='/auth/invite/accept')&&!el('entry-login').hidden&&!el('login-form').hidden,'tela de entrada');el('login-email').value=email;el('login-password').value=pass;await x.submit('login-form');await until(()=>!el('entry-shell').hidden||calls.some(c=>c.path==='/auth/login'&&c.status!==200),'login');},
  async acceptInvite(pass=password){await until(()=>!el('invite-form').hidden,'formulário de convite');el('invite-password').value=pass;el('invite-confirm').value=pass;await x.submit('invite-form');await until(()=>calls.some(c=>c.path==='/auth/invite/accept')&&!el('login-form').hidden,'aceite');}};
 return x;
}
const GROWTH_GLOBALS=['Image','Blob'];
const SETTLE={
 'growth.html':{area:'growth',done:x=>!x.run('LOADING')&&x.requests.some(r=>r.path?.startsWith('/api/crm-read?action=cache_growth'))},
 'organico.html':{area:'organico',done:x=>!x.run('CARGA_ORGANICO')&&x.requests.some(r=>r.path?.startsWith('/api/cache?painel=organico'))},
 'influs.html':{area:'influs',done:x=>x.run('INFLU_READ===null')&&x.requests.some(r=>r.path==='/api/influ')}
};
async function panel(http,{host,cookie,page='growth.html',hash='',values=new Map()}){
 const pub=path.join(artifact(),'public'),html=fs.readFileSync(path.join(pub,page),'utf8'),{document,window}=parseHTML(html);
 const selectProto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
 window.requestAnimationFrame=cb=>setTimeout(()=>cb(Date.now()),0);window.cancelAnimationFrame=clearTimeout;
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const originUrl='https://'+host,requests=[],messages=[];let jar=cookie;
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
 const parent={postMessage:(data,origin)=>messages.push({data,origin}),location:{href:originUrl+'/'}};
 const context=vm.createContext({document,window:null,URL,URLSearchParams,Date,Intl,AbortSignal,AbortController,TextEncoder,TextDecoder,crypto:crypto.webcrypto,Headers,Request,Response,FormData,
  HTMLFormElement:window.HTMLFormElement,CustomEvent:window.CustomEvent,Event:window.Event,
  navigator:{locks:{request:async(_n,o,fn)=>(typeof o==='function'?o:fn)({})}},console,localStorage:storage,sessionStorage:storage,
  location:new URL(originUrl+'/'+page+'?embed=1'+(hash?'#'+hash:'')),history:{replaceState(){}},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
  Image:class{},Blob:class{},prompt:()=>null,confirm:()=>false,parent,requestAnimationFrame:window.requestAnimationFrame,cancelAnimationFrame:clearTimeout,getComputedStyle:()=>({getPropertyValue:()=>''})});
 context.window=context;context.self=context;
 context.addEventListener=window.addEventListener.bind(window);context.removeEventListener=window.removeEventListener.bind(window);context.dispatchEvent=window.dispatchEvent.bind(window);
 const realm=realmOf(context);
 // fetch nativo do "navegador": só a origem do portal, com cookie de sessão e Sec-Fetch.
 context.fetch=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url,originUrl);if(url.origin!==originUrl){requests.push({url:url.href,blocked:true});throw new TypeError('blocked '+url.origin);}
  const method=String(init.method||'GET').toUpperCase(),headers=new Headers(init.headers||{});
  const ctx={cookie:jar,csrf:headers.get('x-csrf-token')||undefined,origin:method==='GET'?null:originUrl,metadata:META};
  const body=init.body===undefined||init.body===null?undefined:JSON.parse(String(init.body));
  const r=method==='POST'?await http.post(host,url.pathname+url.search,body,ctx):await http.get(host,url.pathname+url.search,ctx);
  const set=r.headers['set-cookie'];if(set)jar=set[0].split(';')[0];
  requests.push({method,path:url.pathname+url.search,status:r.status,error:r.json?.error});
  const text=r.text;return {status:r.status,ok:r.status>=200&&r.status<300,headers:new Headers({'content-type':'application/json'}),json:async()=>realm(JSON.parse(text)),text:async()=>text,clone(){return this;}};
 };
 for(const src of [...document.querySelectorAll('script[src]')].map(n=>n.getAttribute('src')))vm.runInContext(fs.readFileSync(path.join(pub,src.replace(/^\//,'').replace(/\?.*$/,'')),'utf8'),context,{filename:src});
 // A entrada entrega a sessão por postMessage (config.js); aqui o marcador público da sessão é entregue direto.
 vm.runInContext("shrigmaGuardaChave('"+SETTLE[page].area+"','ui-"+'a'.repeat(32)+"');",context);
 for(const script of document.querySelectorAll('script:not([src])'))vm.runInContext(script.textContent,context,{filename:'inline-'+page});
 const x={document,window:context,requests,messages,run:c=>vm.runInContext(c,context),q:s=>document.querySelector(s),qa:s=>[...document.querySelectorAll(s)]};
 await until(()=>SETTLE[page].done(x)||messages.some(m=>m.data?.type==='shrigma:session-expired')&&requests.length>0,()=>'painel carregado '+JSON.stringify(requests)+JSON.stringify(messages),10000);
 return x;
}
module.exports={artifact,until,transport,shell,panel,META};
