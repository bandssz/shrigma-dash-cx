'use strict';
// PRIVATE candidate (agente N, 2026-10-03). Carregar ou construir este módulo
// não faz I/O. Ponte READ individual para a biblioteca Growth de templates, no
// mesmo padrão de crm-audience-read-bridge.cjs (#219) e
// crm-manager-read-bridge.cjs (#214): principal crm-panel-read atestado,
// vínculo/expiração re-checados antes e depois do corpo, destino único fixo
// (PROPOSTO, host a confirmar), GET apenas, marca fish|aristo obrigatória e
// validação estrita: qualquer item de outra marca ou sem marca recusa a
// resposta inteira. Autocontido: auth, fetch e relógio são injetados.
//
// Pedido do painel (rota pública 'templates', vocabulário do cliente GTA):
//   acao=listar&marca=<m>[&canal=email][&offset][&limit]
//   acao=historico&marca=<m>&draft_id=<id>      (por key de template: fora)
//   acao=submissao&marca=<m>&submission_id=<id>
// Pedido ao destino (contrato crm-template-read-v1, §9 do documento):
//   acao=listar&brand&channel=email&offset&limit | acao=historico&brand&draft_id | acao=submissao&brand&submission_id
const CAPS=Object.freeze(['read_content','list_history','submission']);
const DESTINATIONS=Object.freeze({'template-read':'https://comunicacao-crm-template-read.tazdb8.easypanel.host/template-read'});
const ACTIONS=Object.freeze({templates:Object.freeze({
 listar:Object.freeze({required:Object.freeze(['marca']),optional:Object.freeze(['canal','offset','limit'])}),
 historico:Object.freeze({required:Object.freeze(['marca','draft_id']),optional:Object.freeze([])}),
 submissao:Object.freeze({required:Object.freeze(['marca','submission_id']),optional:Object.freeze([])})
})});
// Corpo de e-mail chega a 400 000 caracteres: página pequena e teto de 8 MiB.
const MAX_RESPONSE=8*1024*1024,MAX_QUERY=512,TIMEOUT_MS=25000,EXPIRY_MARGIN_MS=5000,MAX_LIMIT=20,MAX_OFFSET=100000,MAX_TOTAL=100000,MAX_EVENTS=200;
const MAX_BODY_HTML=400000,MAX_SUBJECT=1000;
const UUID4=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,HASH=/^[a-f0-9]{64}$/,REF=/^[A-Za-z0-9_-]{1,64}$/;
const BINDING_KEYS=['userId','owner','lifecycleId','lifecycleVersion','principalId','generation','expiresAt','credentialMac','slot','caps'];
const LIST_KEYS=['contract','brand','channel','templates','offset','limit','total','next_offset','coverage','consultado_em','schedule_proof'];
const ITEM_KEYS=['key','brand','channel','id','name','type','draft_id','components','content_available','content_hash','updated_at'];
const HISTORY_KEYS=['contract','brand','draft_id','events','truncated','read_at'],EVENT_KEYS=['at','who','action','from_version','to_version','result','detail'];
const SUBMISSION_KEYS=['contract','brand','submission_id','draft_id','draft_version','provider','estado','provider_status','rejected_reason','checked_at','read_at','provider_polled'];
class TemplateReadError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=403,code='TEMPLATE_READ_DENIED')=>{throw new TemplateReadError(status,code);};
const deny=()=>fail(502,'TEMPLATE_READ_RESPONSE_DENIED');
function plain(v){return !!v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;}
function record(v,keys){return plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&Object.hasOwn(d,'value')&&d.enumerable;});}
function sync(v){if(v&&typeof v.then==='function'){Promise.resolve(v).catch(()=>{});fail();}return v;}
const int=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max,bool=v=>typeof v==='boolean',str=(v,max)=>typeof v==='string'&&v.length<=max,date=v=>typeof v==='string'&&v.length<=64&&Number.isFinite(Date.parse(v));
const text=(v,max)=>str(v,max)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v),nullable=(v,f)=>v===null||f(v);
function binding(v,now){
 if(!record(v,BINDING_KEYS)||!UUID4.test(v.userId)||!UUID4.test(v.lifecycleId)||!/^dcrm-[a-f0-9]{32}$/.test(v.principalId)||
  !Number.isSafeInteger(v.lifecycleVersion)||v.lifecycleVersion<1||!Number.isSafeInteger(v.generation)||v.generation<1||
  !Number.isSafeInteger(v.expiresAt)||v.expiresAt<1||typeof v.owner!=='string'||!/^[-a-z0-9.!#$%&'*+/=?^_`{|}~]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v.owner)||
  v.slot!=='crm-panel-read'||!HASH.test(v.credentialMac)||!Array.isArray(v.caps)||Reflect.ownKeys(v.caps).length!==4||v.caps.length!==3||
  CAPS.some((c,i)=>{const d=Object.getOwnPropertyDescriptor(v.caps,String(i));return !d||!Object.hasOwn(d,'value')||d.value!==c;}))fail(503,'TEMPLATE_READ_NOT_READY');
 if(v.expiresAt<=now+EXPIRY_MARGIN_MS)fail(503,'TEMPLATE_READ_NOT_READY');
 return JSON.stringify(BINDING_KEYS.map(k=>[k,v[k]]));
}
function decision(route,method,query){
 if(method!=='GET'||!(query instanceof URLSearchParams)||typeof route!=='string'||!Object.hasOwn(ACTIONS,route))fail();
 let raw;try{raw=URLSearchParams.prototype.toString.call(query);}catch{fail();}
 if(raw.length>MAX_QUERY)fail(413,'TEMPLATE_READ_QUERY_TOO_LARGE');
 const q=new URLSearchParams(raw),keys=[...q.keys()],action=q.get('acao');
 if(new Set(keys).size!==keys.length||typeof action!=='string'||!Object.hasOwn(ACTIONS[route],action))fail();
 const spec=ACTIONS[route][action],allowed=new Set(['acao',...spec.required,...spec.optional]);
 if(keys.some(k=>!allowed.has(k))||spec.required.some(k=>!q.has(k)))fail();
 // Marca obrigatória: 'todas', vazia, olivas ou ausente nunca saem daqui.
 const brand=q.get('marca');if(!['fish','aristo'].includes(brand))fail();
 let out;
 if(action==='listar'){
  // Só e-mail tem marca derivável dos dados versionados (§9); WhatsApp fica fora.
  if(q.has('canal')&&q.get('canal')!=='email')fail();
  const offset=q.has('offset')?q.get('offset'):'0',limit=q.has('limit')?q.get('limit'):String(MAX_LIMIT);
  if(!/^(0|[1-9][0-9]{0,5})$/.test(offset)||Number(offset)>MAX_OFFSET||!/^[1-9][0-9]?$/.test(limit)||Number(limit)>MAX_LIMIT)fail();
  out=new URLSearchParams([['acao','listar'],['brand',brand],['channel','email'],['offset',offset],['limit',limit]]);
 }else{
  const field=action==='historico'?'draft_id':'submission_id',ref=q.get(field);if(!REF.test(ref))fail();
  out=new URLSearchParams([['acao',action],['brand',brand],[field,ref]]);
 }
 return Object.freeze({route,action,brand,query:out});
}
function validateReadUpstreams(upstreams){
 if(!upstreams||typeof upstreams!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(upstreams)))fail();
 const keys=Reflect.ownKeys(upstreams);if(keys.length!==1||keys[0]!=='template-read')fail();
 const d=Object.getOwnPropertyDescriptor(upstreams,'template-read');
 if(!d||!Object.hasOwn(d,'value')||!d.enumerable||!(d.value instanceof URL)||d.value.href!==DESTINATIONS['template-read'])fail();
 return Object.freeze({'template-read':new URL(d.value.href)});
}
function item(t,brand){
 if(!record(t,ITEM_KEYS)||t.brand!==brand||t.channel!=='email'||typeof t.id!=='string'||!/^[1-9][0-9]{0,9}$/.test(t.id)||t.key!=='email.template.'+t.id||
  !text(t.name,160)||!t.name.length||!['campaign','tx'].includes(t.type)||!nullable(t.draft_id,v=>typeof v==='string'&&REF.test(v))||!bool(t.content_available)||
  typeof t.content_hash!=='string'||!HASH.test(t.content_hash)||!nullable(t.updated_at,date))return false;
 if(!t.content_available)return t.components===null;
 return record(t.components,['subject','body_html','altbody'])&&str(t.components.subject,MAX_SUBJECT)&&str(t.components.body_html,MAX_BODY_HTML)&&t.components.altbody===null;
}
function event(e){
 return record(e,EVENT_KEYS)&&nullable(e.at,date)&&nullable(e.who,v=>text(v,200))&&text(e.action,64)&&e.action.length>0&&
  nullable(e.from_version,v=>int(v,0,999999999))&&nullable(e.to_version,v=>int(v,0,999999999))&&nullable(e.result,v=>text(v,64))&&nullable(e.detail,v=>text(v,2000));
}
function responseShape(d,v){
 const brand=d.brand,q=d.query;if(!plain(v))deny();
 if(d.action==='listar'){
  const offset=Number(q.get('offset')),limit=Number(q.get('limit'));
  if(!record(v,LIST_KEYS)||v.contract!=='crm-template-read-v1'||v.brand!==brand||v.channel!=='email'||v.offset!==offset||v.limit!==limit||!int(v.total,0,MAX_TOTAL)||
   !Array.isArray(v.templates)||v.templates.length!==Math.min(limit,Math.max(0,v.total-offset))||v.next_offset!==(offset+limit<v.total?offset+limit:null)||
   v.coverage!=='registered_email_only'||!date(v.consultado_em)||v.schedule_proof!==false)deny();
  // Item de outra marca, sem marca ou fora de ordem recusa a página inteira.
  let last=0;for(const t of v.templates){if(!item(t,brand)||Number(t.id)<=last)deny();last=Number(t.id);}
 }else if(d.action==='historico'){
  if(!record(v,HISTORY_KEYS)||v.contract!=='crm-template-history-read-v1'||v.brand!==brand||v.draft_id!==q.get('draft_id')||!Array.isArray(v.events)||v.events.length>MAX_EVENTS||
   !bool(v.truncated)||v.truncated&&v.events.length!==MAX_EVENTS||!date(v.read_at)||!v.events.every(event))deny();
 }else{
  if(!record(v,SUBMISSION_KEYS)||v.contract!=='crm-template-submission-read-v1'||v.brand!==brand||v.submission_id!==q.get('submission_id')||
   typeof v.draft_id!=='string'||!REF.test(v.draft_id)||!nullable(v.draft_version,x=>int(x,1,999999999))||!['meta','listmonk'].includes(v.provider)||
   !['submetido','publicado','rejeitado'].includes(v.estado)||!nullable(v.provider_status,x=>typeof x==='string'&&/^[A-Z_]{1,32}$/.test(x))||
   !nullable(v.rejected_reason,x=>text(x,2000))||!nullable(v.checked_at,date)||!date(v.read_at)||v.provider_polled!==false)deny();
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
function createTemplateReadBridge(config,{fetchImpl=globalThis.fetch,now=()=>Date.now()}={}){
 if(!record(config,['auth','upstreams','enabled'])||typeof config.enabled!=='boolean'||typeof fetchImpl!=='function'||typeof now!=='function'||
  typeof config.auth?.managedCrmReadAuthorization!=='function'||typeof config.auth?.getUpstreamCredential!=='function')fail();
 const auth=config.auth,upstreams=validateReadUpstreams(config.upstreams),enabled=config.enabled;
 async function read(value,onSettled){
  if(onSettled!==undefined&&typeof onSettled!=='function')fail();
  // Desligada: recusa antes de qualquer autorização, credencial ou fetch.
  if(!enabled)fail(503,'TEMPLATE_READ_DISABLED');
  if(!record(value,['context','route','method','query','origin']))fail();
  const {context,route,method,origin,query}=value;
  if(!(query instanceof URLSearchParams))fail();
  const d=decision(route,method,query),target=upstreams['template-read'];
  if(context?.method!=='GET'||typeof context.host!=='string'||origin!=='https://'+context.host)fail();
  const ctx={...context,method:'GET',area:'growth',edit:false};
  let credential,initial;
  try{
   initial=binding(sync(auth.managedCrmReadAuthorization(ctx)),now());
   credential=sync(auth.getUpstreamCredential({...ctx,slot:'crm-panel-read'}));
   if(typeof credential!=='string'||!HASH.test(credential)||initial!==binding(sync(auth.managedCrmReadAuthorization(ctx)),now()))fail();
  }catch{fail(503,'TEMPLATE_READ_NOT_READY');}
  const url=new URL(target.href);url.search=d.query.toString();const controller=new AbortController();let reader,timer;
  const cancel=()=>{try{const v=reader?.cancel();Promise.resolve(v).catch(()=>{});}catch{}};
  const work=async()=>{
   const r=await fetchImpl(url,{method:'GET',redirect:'manual',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json','Accept-Encoding':'identity',Authorization:'Bearer '+credential}});
   // 401/403/404 não leem o corpo remoto e não repetem a consulta.
   if(r?.status===404&&r.redirected!==true)fail(404,'TEMPLATE_READ_NOT_FOUND');
   if(r?.status===401||r?.status===403)fail(403,'TEMPLATE_READ_UPSTREAM_DENIED');
   if(r?.status!==200||r.redirected===true||r.url&&r.url!==url.href||['opaque','opaqueredirect','error'].includes(r.type))fail(502,'TEMPLATE_READ_UPSTREAM_UNAVAILABLE');
   const header=name=>sync(r.headers.get(name));
   if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header('content-type')||'')||!['',null,'identity'].includes(header('content-encoding')))deny();
   const length=header('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>MAX_RESPONSE))deny();
   reader=sync(r.body?.getReader());if(typeof reader?.read!=='function')deny();
   let bytes=0;const chunks=[];for(;;){const v=await reader.read();if(!v||typeof v.done!=='boolean')deny();if(v.done)break;if(!(v.value instanceof Uint8Array))deny();bytes+=v.value.byteLength;if(bytes>MAX_RESPONSE)deny();chunks.push(Buffer.from(v.value));}
   if(length!==null&&Number(length)!==bytes)deny();
   const raw=(()=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{return deny();}})();
   if(raw.includes(credential))deny();
   let body;try{body=JSON.parse(raw);}catch{deny();}
   if(echoes(body,credential))deny();
   responseShape(d,body);
   try{if(initial!==binding(sync(auth.managedCrmReadAuthorization(ctx)),now()))fail();}catch{fail(503,'TEMPLATE_READ_NOT_READY');}
   return {status:200,body};
  };
  const active=work(),settled=active.then(()=>undefined,()=>undefined);
  try{if(onSettled)sync(onSettled(settled));return await Promise.race([active,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel();reject(new TemplateReadError(502,'TEMPLATE_READ_UPSTREAM_UNAVAILABLE'));},TIMEOUT_MS);})]);}
  catch(e){if(e instanceof TemplateReadError)throw e;fail(502,'TEMPLATE_READ_UPSTREAM_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.abort();cancel();try{Promise.resolve(reader?.releaseLock()).catch(()=>{});}catch{}}
 }
 return Object.freeze({read});
}
module.exports={createTemplateReadBridge,validateReadUpstreams,decision,responseShape,TemplateReadError,DESTINATIONS,ACTIONS,CAPS,MAX_RESPONSE,MAX_LIMIT};
