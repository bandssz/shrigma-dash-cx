'use strict';
// PRIVATE candidate (agente K, 2026-10-03). Carregar ou construir este módulo
// não faz I/O. Ponte READ individual para listas, públicos salvos e vínculo
// de campanha, no mesmo estilo de crm-manager-read-bridge.cjs (#214):
// principal crm-panel-read atestado, vínculo/expiração re-checados antes e
// depois do corpo, destino único fixo, GET apenas, marca fish|aristo e
// validação estrita da resposta. Autocontido: auth e fetch são injetados.
const CAPS=Object.freeze(['read_content','list_history','submission']);
const DESTINATIONS=Object.freeze({'audience-read':'https://comunicacao-crm-audience-read.tazdb8.easypanel.host/audience-read'});
// Rota pública do portal -> ações admitidas. Nenhuma ação de escrita,
// contagem, conferência, operação/recibo ou validação entra aqui.
const ACTIONS=Object.freeze({
 segments:Object.freeze({segmentos_listar:Object.freeze(['brand','offset','limit']),segmento_obter:Object.freeze(['brand','id']),publicos_listas:Object.freeze(['brand'])}),
 campaign_audience:Object.freeze({campanha_publico_obter:Object.freeze(['brand','campaign_id']),campanha_publico_contexto:Object.freeze(['brand','campaign_id'])})
});
const FLAGS=Object.freeze({selector_ready:false,execution_blocked:true,authorizes_selection:false,authorizes_send:false});
const MAX_RESPONSE=2*1024*1024,MAX_QUERY=512,TIMEOUT_MS=25000,EXPIRY_MARGIN_MS=5000;
const UUID4=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEG_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/,CV=/^[a-f0-9]{32}$/;
const BINDING_KEYS=['userId','owner','lifecycleId','lifecycleVersion','principalId','generation','expiresAt','credentialMac','slot','caps'];
class AudienceReadError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=403,code='AUDIENCE_READ_DENIED')=>{throw new AudienceReadError(status,code);};
const deny=()=>fail(502,'AUDIENCE_READ_RESPONSE_DENIED');
function plain(v){return !!v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;}
function record(v,keys){return plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&Object.hasOwn(d,'value')&&d.enumerable;});}
function sync(v){if(v&&typeof v.then==='function'){Promise.resolve(v).catch(()=>{});fail();}return v;}
const pos=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647,bool=v=>typeof v==='boolean',str=(v,max=500)=>typeof v==='string'&&v.length<=max,date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
function binding(v,now){
 if(!record(v,BINDING_KEYS)||!UUID4.test(v.userId)||!UUID4.test(v.lifecycleId)||!/^dcrm-[a-f0-9]{32}$/.test(v.principalId)||
  !Number.isSafeInteger(v.lifecycleVersion)||v.lifecycleVersion<1||!Number.isSafeInteger(v.generation)||v.generation<1||
  !Number.isSafeInteger(v.expiresAt)||v.expiresAt<1||typeof v.owner!=='string'||!/^[-a-z0-9.!#$%&'*+/=?^_`{|}~]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v.owner)||
  v.slot!=='crm-panel-read'||!HASH.test(v.credentialMac)||!Array.isArray(v.caps)||Reflect.ownKeys(v.caps).length!==4||v.caps.length!==3||
  CAPS.some((c,i)=>{const d=Object.getOwnPropertyDescriptor(v.caps,String(i));return !d||!Object.hasOwn(d,'value')||d.value!==c;}))fail(503,'AUDIENCE_READ_NOT_READY');
 // Expiração re-checada aqui, além do emissor: margem evita usar uma chave
 // que expira durante a consulta.
 if(v.expiresAt<=now+EXPIRY_MARGIN_MS)fail(503,'AUDIENCE_READ_NOT_READY');
 return JSON.stringify(BINDING_KEYS.map(k=>[k,v[k]]));
}
function decision(route,method,query){
 if(method!=='GET'||!(query instanceof URLSearchParams)||typeof route!=='string'||!Object.hasOwn(ACTIONS,route))fail();
 let text;try{text=URLSearchParams.prototype.toString.call(query);}catch{fail();}
 if(text.length>MAX_QUERY)fail(413,'AUDIENCE_READ_QUERY_TOO_LARGE');
 const q=new URLSearchParams(text),keys=[...q.keys()],action=q.get('acao');
 if(new Set(keys).size!==keys.length||typeof action!=='string'||!Object.hasOwn(ACTIONS[route],action))fail();
 const fields=ACTIONS[route][action],allowed=new Set(['acao',...fields]);
 if(keys.some(k=>!allowed.has(k))||fields.some(k=>!q.has(k)))fail();
 const brand=q.get('brand');if(!['fish','aristo'].includes(brand))fail();
 if(q.has('offset')&&!/^(0|[1-9][0-9]{0,4})$/.test(q.get('offset'))||q.has('limit')&&!/^([1-9][0-9]?|100)$/.test(q.get('limit')))fail();
 if(q.has('id')&&(!SEG_ID.test(q.get('id'))))fail();
 if(q.has('campaign_id')&&!/^[1-9][0-9]{0,9}$/.test(q.get('campaign_id'))||q.has('campaign_id')&&!pos(Number(q.get('campaign_id'))))fail();
 // Ordem canônica: o que sai é exatamente o que foi decidido.
 const out=new URLSearchParams([['acao',action],...fields.map(k=>[k,q.get(k)])]);
 return Object.freeze({route,action,brand,query:out});
}
function validateReadUpstreams(upstreams){
 if(!upstreams||typeof upstreams!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(upstreams)))fail();
 const keys=Reflect.ownKeys(upstreams);if(keys.length!==1||keys[0]!=='audience-read')fail();
 const d=Object.getOwnPropertyDescriptor(upstreams,'audience-read');
 if(!d||!Object.hasOwn(d,'value')||!d.enumerable||!(d.value instanceof URL)||d.value.href!==DESTINATIONS['audience-read'])fail();
 return Object.freeze({'audience-read':new URL(d.value.href)});
}
function freshness(f){return record(f,['contract','catalog_refreshed_at','catalog_expires_at','catalog_age_seconds','read_at','current','stale','coverage','schedule_proof'])&&f.contract==='crm-audience-read-freshness-v1'&&
 (f.catalog_refreshed_at===null||date(f.catalog_refreshed_at))&&(f.catalog_expires_at===null||date(f.catalog_expires_at))&&(f.catalog_age_seconds===null||Number.isSafeInteger(f.catalog_age_seconds)&&f.catalog_age_seconds>=0)&&
 date(f.read_at)&&bool(f.current)&&bool(f.stale)&&f.current===!f.stale&&f.coverage==='unconfirmed'&&f.schedule_proof===false&&
 (!f.current||f.catalog_expires_at!==null&&Date.parse(f.catalog_expires_at)>Date.parse(f.read_at));}
function list(l,brand){return record(l,['id','brand','name','available'])&&pos(l.id)&&l.brand===brand&&str(l.name)&&bool(l.available);}
function segment(s,brand){
 return record(s,['id','brand','name','definition','version','archived','created_at','updated_at','updated_by','semantic_context'])&&SEG_ID.test(s.id)&&s.brand===brand&&str(s.name,160)&&
  plain(s.definition)&&s.definition.brand===brand&&s.definition.name===s.name&&s.definition.schema_version==='crm-audience-v2'&&pos(s.version)&&bool(s.archived)&&date(s.created_at)&&date(s.updated_at)&&
  typeof s.updated_by==='string'&&/^panel:[A-Za-z0-9_.:-]{1,194}$/.test(s.updated_by)&&record(s.semantic_context,['currency','timezone','current'])&&bool(s.semantic_context.current)&&
  (s.semantic_context.currency===null||typeof s.semantic_context.currency==='string'&&/^[A-Z]{3}$/.test(s.semantic_context.currency))&&(s.semantic_context.timezone===null||str(s.semantic_context.timezone,100));
}
function flags(v){return Object.keys(FLAGS).every(k=>v[k]===FLAGS[k]);}
function view(v,brand,id,stale){
 return record(v,['contract','brand','campaign_id','campaign_version','binding_version','audience_id','audience_revision','definition_hash','context_hash','base_list_id','catalog_hash','binding_hash','campaign_current','semantic_context',...Object.keys(FLAGS)])&&
  v.contract==='crm-audience-campaign-binding-v1'&&v.brand===brand&&v.campaign_id===id&&CV.test(v.campaign_version)&&pos(v.binding_version)&&SEG_ID.test(v.audience_id)&&pos(v.audience_revision)&&
  ['definition_hash','context_hash','catalog_hash','binding_hash'].every(k=>HASH.test(v[k]))&&pos(v.base_list_id)&&bool(v.campaign_current)&&flags(v)&&
  record(v.semantic_context,['currency','timezone','current'])&&bool(v.semantic_context.current)&&(stale!==true||v.semantic_context.current===false);
}
function catalog(c,brand){
 return plain(c)&&c.brand===brand&&bool(c.current)&&c.coverage==='unconfirmed'&&typeof c.catalog_hash==='string'&&HASH.test(c.catalog_hash)&&date(c.checked_at)&&Array.isArray(c.lists)&&c.lists.length<=1000&&
  c.lists.every(l=>list(l,brand))&&new Set(c.lists.map(l=>l.id)).size===c.lists.length&&Array.isArray(c.fields)&&Array.isArray(c.products)&&c.products.every(p=>plain(p)&&p.brand===brand)&&Array.isArray(c.origins)&&c.origins.every(o=>plain(o)&&o.brand===brand)&&
  (!Object.hasOwn(c,'recorded_origins')||Array.isArray(c.recorded_origins)&&c.recorded_origins.every(o=>plain(o)&&o.brand===brand));
}
function responseShape(d,v){
 const brand=d.brand,q=d.query;if(!plain(v))deny();
 if(d.action==='publicos_listas'){
  if(!record(v,['brand','base_list_id','lists','freshness'])||v.brand!==brand||v.base_list_id!==null&&!pos(v.base_list_id)||!Array.isArray(v.lists)||v.lists.length>1000||!v.lists.every(l=>list(l,brand))||!freshness(v.freshness))deny();
 }else if(d.action==='segmentos_listar'){
  const limit=Number(q.get('limit')),offset=Number(q.get('offset'));
  if(!record(v,['segments','limit','offset','catalog','capabilities','freshness'])||v.limit!==limit||v.offset!==offset||!Array.isArray(v.segments)||v.segments.length>limit||!v.segments.every(s=>segment(s,brand))||
   !catalog(v.catalog,brand)||!record(v.capabilities,['draft','count','send'])||v.capabilities.draft!==false||v.capabilities.count!==false||v.capabilities.send!==false||!freshness(v.freshness)||v.catalog.current!==v.freshness.current||
   v.freshness.stale&&v.segments.some(s=>s.semantic_context.current))deny();
 }else if(d.action==='segmento_obter'){
  if(!record(v,['segment','freshness'])||!segment(v.segment,brand)||v.segment.id!==q.get('id')||!freshness(v.freshness)||v.freshness.stale&&v.segment.semantic_context.current)deny();
 }else{
  const id=Number(q.get('campaign_id'));
  if(d.action==='campanha_publico_obter'){
   if(!record(v,['binding','campaign_id','campaign_version',...Object.keys(FLAGS)])||v.campaign_id!==id||!CV.test(v.campaign_version)||!flags(v)||v.binding!==null&&(!view(v.binding,brand,id)||v.binding.campaign_current!==(v.binding.campaign_version===v.campaign_version)))deny();
  }else{
   if(!record(v,['contract','brand','campaign_id','campaign_version','status','list_ids','lists','list_only','binding_state','binding','freshness','schedule_proof',...Object.keys(FLAGS)])||v.contract!=='crm-audience-campaign-read-context-v1'||
    v.brand!==brand||v.campaign_id!==id||!CV.test(v.campaign_version)||v.status!==null&&!str(v.status,32)||!Array.isArray(v.list_ids)||v.list_ids.length>30||!v.list_ids.every(pos)||new Set(v.list_ids).size!==v.list_ids.length||
    !Array.isArray(v.lists)||v.lists.length!==v.list_ids.length||v.lists.some((l,i)=>!record(l,['id','name','available','in_brand'])||l.id!==v.list_ids[i]||!bool(l.in_brand)||!bool(l.available)||(l.in_brand?!str(l.name):l.name!==null||l.available!==false))||
    !['none','released','bound'].includes(v.binding_state)||v.list_only!==(v.binding_state!=='bound')||(v.binding_state==='bound'?!view(v.binding,brand,id,v.freshness?.stale)||v.binding.campaign_current!==(v.binding.campaign_version===v.campaign_version):v.binding!==null)||
    !freshness(v.freshness)||v.schedule_proof!==false||!flags(v))deny();
  }
 }
}
// Eco da credencial: a varredura bruta não basta, porque um escape \uXXXX no
// JSON some no JSON.parse. Por isso toda string e toda chave DECODIFICADA é
// conferida (iterativo, sem recursão; caixa ignorada). O valor nunca sai.
function echoes(value,secret){
 const s=String(secret).toLowerCase(),hit=t=>typeof t==='string'&&t.toLowerCase().includes(s),stack=[value];
 while(stack.length){const v=stack.pop();if(hit(v))return true;if(v&&typeof v==='object')for(const k of Reflect.ownKeys(v)){if(hit(k))return true;stack.push(v[k]);}}
 return false;
}
function createAudienceReadBridge(config,{fetchImpl=globalThis.fetch,now=()=>Date.now()}={}){
 if(!record(config,['auth','upstreams','enabled'])||typeof config.enabled!=='boolean'||typeof fetchImpl!=='function'||typeof now!=='function'||
  typeof config.auth?.managedCrmReadAuthorization!=='function'||typeof config.auth?.getUpstreamCredential!=='function')fail();
 const auth=config.auth,upstreams=validateReadUpstreams(config.upstreams),enabled=config.enabled;
 async function read(value,onSettled){
  if(onSettled!==undefined&&typeof onSettled!=='function')fail();
  // Desligada: recusa antes de qualquer autorização, credencial ou fetch.
  if(!enabled)fail(503,'AUDIENCE_READ_DISABLED');
  if(!record(value,['context','route','method','query','origin']))fail();
  const {context,route,method,origin}=value;let query=value.query;
  if(!(query instanceof URLSearchParams))fail();
  const d=decision(route,method,query),target=upstreams['audience-read'];
  if(context?.method!=='GET'||typeof context.host!=='string'||origin!=='https://'+context.host)fail();
  const ctx={...context,method:'GET',area:'growth',edit:false};
  let credential,initial;
  try{
   initial=binding(sync(auth.managedCrmReadAuthorization(ctx)),now());
   credential=sync(auth.getUpstreamCredential({...ctx,slot:'crm-panel-read'}));
   if(typeof credential!=='string'||!HASH.test(credential)||initial!==binding(sync(auth.managedCrmReadAuthorization(ctx)),now()))fail();
  }catch{fail(503,'AUDIENCE_READ_NOT_READY');}
  const url=new URL(target.href);url.search=d.query.toString();const controller=new AbortController();let reader,timer;
  const cancel=()=>{try{const v=reader?.cancel();Promise.resolve(v).catch(()=>{});}catch{}};
  const work=async()=>{
   const r=await fetchImpl(url,{method:'GET',redirect:'manual',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json','Accept-Encoding':'identity',Authorization:'Bearer '+credential}});
   // 401/403/404 não leem o corpo remoto e não repetem a consulta.
   if(r?.status===404&&r.redirected!==true)fail(404,'AUDIENCE_READ_NOT_FOUND');
   if(r?.status===401||r?.status===403)fail(403,'AUDIENCE_READ_UPSTREAM_DENIED');
   if(r?.status!==200||r.redirected===true||r.url&&r.url!==url.href||['opaque','opaqueredirect','error'].includes(r.type))fail(502,'AUDIENCE_READ_UPSTREAM_UNAVAILABLE');
   const header=name=>sync(r.headers.get(name));
   if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header('content-type')||'')||!['',null,'identity'].includes(header('content-encoding')))deny();
   const length=header('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>MAX_RESPONSE))deny();
   reader=sync(r.body?.getReader());if(typeof reader?.read!=='function')deny();
   let bytes=0;const chunks=[];for(;;){const v=await reader.read();if(!v||typeof v.done!=='boolean')deny();if(v.done)break;if(!(v.value instanceof Uint8Array))deny();bytes+=v.value.byteLength;if(bytes>MAX_RESPONSE)deny();chunks.push(Buffer.from(v.value));}
   if(length!==null&&Number(length)!==bytes)deny();
   const text=(()=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{return deny();}})();
   if(text.includes(credential))deny();
   let body;try{body=JSON.parse(text);}catch{deny();}
   if(echoes(body,credential))deny();
   responseShape(d,body);
   try{if(initial!==binding(sync(auth.managedCrmReadAuthorization(ctx)),now()))fail();}catch{fail(503,'AUDIENCE_READ_NOT_READY');}
   return {status:200,body};
  };
  const active=work(),settled=active.then(()=>undefined,()=>undefined);
  try{if(onSettled)sync(onSettled(settled));return await Promise.race([active,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel();reject(new AudienceReadError(502,'AUDIENCE_READ_UPSTREAM_UNAVAILABLE'));},TIMEOUT_MS);})]);}
  catch(e){if(e instanceof AudienceReadError)throw e;fail(502,'AUDIENCE_READ_UPSTREAM_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.abort();cancel();try{Promise.resolve(reader?.releaseLock()).catch(()=>{});}catch{}}
 }
 return Object.freeze({read});
}
module.exports={createAudienceReadBridge,validateReadUpstreams,decision,responseShape,AudienceReadError,DESTINATIONS,ACTIONS,CAPS,MAX_RESPONSE};
