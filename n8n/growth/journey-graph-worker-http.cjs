/* Node-only transports. Fixed installation bindings; no URL or credential in jobs. */
'use strict';
const {QUERY}=require('./journey-graph-refresh.cjs');
const {API_VERSION,IDENTITY_QUERY,ORDERS_QUERY}=require('./journey-graph-purchase.cjs');
const fail=code=>Object.assign(Error(code),{code}),queries=new Set([QUERY,IDENTITY_QUERY,ORDERS_QUERY]);
function createWorkerPool({connectionString,Pool,onError=()=>{}}={}){
 if(typeof Pool!=='function'||typeof onError!=='function'||typeof connectionString!=='string')throw fail('GRAPH_WORKER_POOL_CONFIG');
 let u;try{u=new URL(connectionString);}catch{throw fail('GRAPH_WORKER_POOL_CONFIG');}
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.hostname||u.hash||!u.pathname||u.pathname==='/')throw fail('GRAPH_WORKER_POOL_CONFIG');
 const pool=new Pool({connectionString,max:4,idleTimeoutMillis:10000,connectionTimeoutMillis:3000,statement_timeout:8000,query_timeout:10000,application_name:'crm-graph-worker-v1',allowExitOnIdle:false});
 pool.on('error',()=>onError('GRAPH_WORKER_DATABASE_UNAVAILABLE'));return pool;
}
function createWorkerHttp({listmonkOrigin,listmonkAuthorization,cacheTarget,shops,shopifyTokenFor,fetchImpl=globalThis.fetch}={}){
 let origin;try{origin=new URL(listmonkOrigin);}catch{throw fail('GRAPH_WORKER_HTTP_CONFIG');}
 // Use reviewed HTTPS origin of the single Listmonk backend. Internal plaintext
 // is deliberately not inferred from a service name or allowed via a job input.
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||origin.port||typeof listmonkAuthorization!=='string'||!/^Basic [A-Za-z0-9+/]+=*$/.test(listmonkAuthorization)||listmonkAuthorization.length>8192||typeof cacheTarget!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cacheTarget)||typeof shopifyTokenFor!=='function'||typeof fetchImpl!=='function')throw fail('GRAPH_WORKER_HTTP_CONFIG');
 const stores={};for(const brand of ['fish','aristo']){const s=shops?.[brand];if(!s||!/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(s.id||'')||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s.myshopifyDomain||''))throw fail('GRAPH_WORKER_HTTP_CONFIG');stores[brand]={...s};}
 if(stores.fish.myshopifyDomain===stores.aristo.myshopifyDomain)throw fail('GRAPH_WORKER_HTTP_CONFIG');
 async function readJSON(response,cap,signal){
  const length=response.headers?.get('content-length');if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>cap))throw fail('GRAPH_WORKER_HTTP_LIMIT');
  if(!Number.isInteger(response.status)||response.status<100||response.status>599||!response.body?.getReader)throw fail('GRAPH_WORKER_HTTP_UNCONFIRMED');
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){if(signal.aborted)throw fail('GRAPH_WORKER_HTTP_ABORTED');const r=await reader.read();if(r.done)break;if(!(r.value instanceof Uint8Array)||(bytes+=r.value.byteLength)>cap)throw fail('GRAPH_WORKER_HTTP_LIMIT');chunks.push(Buffer.from(r.value));}
   let body;try{body=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch{body=null;}return {status:response.status,body};
  }finally{reader.cancel().catch(()=>{});}
 }
 async function call(url,{method='POST',body,headers,signal,timeoutMs,cap}){
  if(signal!==undefined&&!(signal instanceof AbortSignal)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>40000||!Number.isSafeInteger(cap)||cap<1||cap>350000)throw fail('GRAPH_WORKER_HTTP_INPUT');
  const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)throw fail('GRAPH_WORKER_HTTP_ABORTED');signal?.addEventListener('abort',abort,{once:true});let timer;
  try{return await Promise.race([(async()=>{
   const resolved=typeof headers==='function'?await headers(controller.signal):headers;if(controller.signal.aborted)throw fail('GRAPH_WORKER_HTTP_ABORTED');
   const response=await fetchImpl(url,{method,headers:{Accept:'application/json',...(method==='POST'?{'Content-Type':'application/json'}:{}),...resolved},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal,redirect:'error'});
   return readJSON(response,cap,controller.signal);
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('GRAPH_WORKER_HTTP_TIMEOUT'));},timeoutMs);controller.signal.addEventListener('abort',()=>reject(fail('GRAPH_WORKER_HTTP_ABORTED')),{once:true});})]);}
  catch(e){throw /^GRAPH_WORKER_HTTP_[A-Z_]+$/.test(e?.code||'')?e:fail('GRAPH_WORKER_HTTP_UNCONFIRMED');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
 }
 const native=(path,body,o={},method='POST')=>{
  if(o.cacheTarget!==undefined&&o.cacheTarget!==cacheTarget||o.retry===true||o.redirect!==undefined&&o.redirect!=='error')throw fail('GRAPH_WORKER_HTTP_INPUT');
  if(body!==undefined&&Buffer.byteLength(JSON.stringify(body))>350000)throw fail('GRAPH_WORKER_HTTP_LIMIT');
  return call(origin.origin+path,{method,body,headers:{Authorization:listmonkAuthorization},signal:o.signal,timeoutMs:o.timeoutMs??10000,cap:Math.min(o.maxResponseBytes??350000,350000)});
 };
 return Object.freeze({
  async shopifyRequest({brand,shop,apiVersion,document,variables,signal,maxResponseBytes=262144,...extra}={}){
   if(Object.keys(extra).length||!stores[brand]||shop!==stores[brand].myshopifyDomain||apiVersion!==API_VERSION||!queries.has(document)||!variables||typeof variables!=='object'||Array.isArray(variables)||Buffer.byteLength(JSON.stringify(variables))>4096||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>262144)throw fail('GRAPH_WORKER_HTTP_INPUT');
   return call('https://'+shop+'/admin/api/'+API_VERSION+'/graphql.json',{body:{query:document,variables},signal,timeoutMs:4500,cap:maxResponseBytes,headers:async innerSignal=>{const token=await shopifyTokenFor(brand,{shop,signal:innerSignal});if(typeof token!=='string'||!token||token.length>4096||/[\r\n]/.test(token))throw fail('GRAPH_WORKER_HTTP_AUTH');return {'X-Shopify-Access-Token':token};}});
  },
  async sendTx(payload,options={}){const r=await native('/api/tx',payload,{...options,maxResponseBytes:Math.min(options.maxResponseBytes??65536,65536)});return {statusCode:r.status,body:r.body};},
  nativeCreate:(body,options)=>native('/api/templates',body,options),
  nativeRead:(id,options)=>{if(!Number.isSafeInteger(id)||id<1)throw fail('GRAPH_WORKER_HTTP_INPUT');return native('/api/templates/'+id,undefined,options,'GET');}
 });
}
module.exports={ENABLED:false,createWorkerPool,createWorkerHttp};
