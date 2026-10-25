'use strict';
// Stateless admission for the single authorized internal QA account. All
// durable intentions remain in the original audience request / BFF delivery.
const P=require('./proxy.cjs');
const {restrictedUser}=require('./crm-ui-features.cjs');
const EMAIL='felipebandeira+codex@oaristocrata.com';
const allowedOperator=author=>[EMAIL,'felipebandeira@oaristocrata.com'].includes(author?.email?.toLowerCase())&&author?.permissions?.growth?.edit===true;
const allowedEditor=author=>author?.permissions?.growth?.edit===true;
const IDS=Object.freeze({aristo:'23b3132a-a00b-41d3-ac31-0216a37f6100',fish:'6b034a75-a02f-4a0e-9b18-43c4be87881b'});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const error=(status,code)=>Object.assign(Error(code),{status,code});
function requireRenderedTest(definition){
 const {templateEnd}=require('./campaign-write-tracking.js');
 for(const field of ['subject','html','text']){
  const source=typeof definition?.[field]==='string'?definition[field]:'';
  for(let start=source.indexOf('{{');start!==-1;){
   const end=templateEnd(source,start);let action=source.slice(start+2,end).replace(/\}\}$/,'').replace(/^-?\s*/,'').replace(/\s*-?$/,'');
   while(action.startsWith('/*')){const close=action.indexOf('*/',2);if(close<0)break;action=action.slice(close+2).trimStart();}
   if(/^(?:if|range|with|else|end|define|block|template|break|continue)\b/.test(action))throw error(400,'CAMPAIGN_TEST_UNRENDERED_CONTROL');
   start=source.indexOf('{{',Math.max(start+2,end));
  }
 }
}
function requireCouponDestinations(definition,brand){
 const pending=require('./campaign-write-tracking.js').review({body:definition.html,altbody:definition.text},{brand,campaign:definition.utm_campaign}).issues.some(x=>x.code.startsWith('COUPON_'));
 if(pending)throw error(409,'COUPON_DESTINATION_REQUIRED');
}
const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
function create({binding,remoteKey,delivery,fetchImpl=fetch,enabled=false,editorsEnabled=false,frozenAudienceV3=false,scheduleReady=()=>false,scheduleReleased=(_context,_brand,author)=>restrictedUser(author)}){
 if(typeof binding!=='function'||typeof remoteKey!=='function'||!delivery)throw Error('NATIVE_INTERNAL_CONFIG');
 const identity=async(context,brand)=>{if(!enabled||!['fish','aristo'].includes(brand))throw error(403,'NATIVE_INTERNAL_DISABLED');const p=await binding(context,{brand,write:true,fetchImpl});if(!allowedEditor(p.author))throw error(403,'NATIVE_INTERNAL_EDITOR_REQUIRED');return p;};
 async function transport(context,{route='campaigns',method,command}){
  const p=await identity(context,command.brand),action=command.acao;
  const allowed=route==='segments'?(method==='GET'?['segmento_contexto_revisao','segmento_congelamento_nativo_obter']:['segmento_congelar_nativo_interno','segmento_reconciliar_congelamento_nativo']):(method==='GET'?['campanha_nativa_contexto','campanha_obter','campanha_catalogo','campanha_operacao']:['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar','campanha_reconciliar_cancelamento']);
  if(!allowed.includes(action)||!['GET','POST'].includes(method))throw error(403,'NATIVE_INTERNAL_SCOPE');
  if(route==='segments'&&command.id!==undefined){if(!UUID.test(command.id||''))throw error(403,'NATIVE_INTERNAL_AUDIENCE');if(command.id===IDS[command.brand]){if(!allowedOperator(p.author))throw error(403,'NATIVE_INTERNAL_QA_ONLY');}else if(!frozenAudienceV3||!editorsEnabled&&!allowedOperator(p.author))throw error(403,'NATIVE_NEW_SCHEDULE_CLOSED');}
  const url=new URL(P.REVIEWED_DYNAMIC.routes[route]);
  if(method==='GET')for(const [k,v]of Object.entries(command))url.searchParams.set(k,String(v));
  const r=await fetchImpl(url.href,{method,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(method==='POST'?85000:25000),headers:{Accept:'application/json',Origin:'https://bandssz.github.io',...(method==='GET'||route==='segments'?{Authorization:'Bearer '+p.credential}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(route==='segments'?command:{...command,k:p.credential})}:{})});
  let body;const bytes=[];let size=0;if(!r.body)throw error(502,'NATIVE_INTERNAL_RESPONSE');for await(const b of r.body){size+=b.length;if(size>4*1024*1024)throw error(502,'NATIVE_INTERNAL_RESPONSE');bytes.push(b);}try{body=JSON.parse(Buffer.concat(bytes).toString());}catch{throw error(502,'NATIVE_INTERNAL_RESPONSE');}
  const after=await identity(context,command.brand);if(after.binding!==p.binding||after.snapshot!==p.snapshot)throw error(403,'CRM_SERVICE_DRAFT_ACCESS_CHANGED');
  if(JSON.stringify(body).toLowerCase().includes(p.credential.toLowerCase()))throw error(502,'NATIVE_INTERNAL_RESPONSE');
  return {status:r.status,body};
 }
 const idOk=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
 const generalContext=b=>b.freeze_contract==='crm-native-frozen-list-v3'&&b.internal_test===false&&b.commercial===true&&idOk(b.list_id)&&Number.isSafeInteger(b.eligible_count)&&b.eligible_count>0&&UUID.test(b.audience_id||'')&&Number.isSafeInteger(b.audience_version)&&b.audience_version>0&&exact(b.base,['id','uuid','optin','status'])&&b.base.id===(b.brand==='aristo'?16:17)&&UUID.test(b.base.uuid||'')&&['single','double'].includes(b.base.optin)&&b.base.status==='active'&&Array.isArray(b.origins)&&b.origins.length>0&&b.origins.every(o=>exact(o,['id','uuid','optin','status'])&&idOk(o.id)&&UUID.test(o.uuid||'')&&['single','double'].includes(o.optin)&&o.status==='active')&&new Set(b.origins.map(o=>o.id)).size===b.origins.length&&b.origins.some(o=>["id","uuid","optin","status"].every(k=>o[k]===b.base[k]));
 const eligible=async(context,brand,id)=>{const who=await identity(context,brand),r=await transport(context,{method:'GET',command:{acao:'campanha_nativa_contexto',brand,id}}),b=r.body;if(r.status!==200||b.schema!=='crm-native-internal-context-v1'||b.brand!==brand||b.campaign_id!==id||b.eligible!==true||!idOk(b.list_id)||!(generalContext(b)||b.freeze_contract===undefined&&b.internal_test===true&&b.commercial===false&&allowedOperator(who.author)))throw error(409,'NATIVE_INTERNAL_NOT_ELIGIBLE');return b;};
 const canStart=(who,b)=>b.freeze_contract==='crm-native-frozen-list-v3'?(frozenAudienceV3&&(editorsEnabled||allowedOperator(who.author))&&scheduleReady({userId:who.author.id,brand:b.brand,campaignId:b.campaign_id})===true):allowedOperator(who.author);
 async function handle(context,method,q){
  let deliveryStarted=false;try{
  const who=await identity(context,q.brand);const brand=q.brand,action=q.acao;
  if(action==='campanha_nativa_capacidade'&&method==='GET'&&exact(q,['acao','brand'])){
   const probe=await transport(context,{method:'GET',command:{acao:'campanha_nativa_contexto',brand,id:1}});
   const available=probe.status===200&&probe.body.schema==='crm-native-internal-context-v1',legacy=allowedOperator(who.author),newAllowed=legacy||editorsEnabled&&frozenAudienceV3;return {status:200,body:{schema:'crm-native-internal-capability-v1',brand,enabled:newAllowed&&available&&probe.body.acceptance_proved===true,homologation_available:newAllowed&&available,internal_test:legacy,commercial:!legacy&&newAllowed,frozen_audiences_v3:frozenAudienceV3&&newAllowed,audience_id:legacy&&!frozenAudienceV3?IDS[brand]:null}};
  }
  if(action==='campanha_nativa_contexto'&&method==='GET'&&exact(q,['acao','brand','id'])){const r=await transport(context,{method,command:q});if(r.status===200&&r.body?.eligible===true){const b=await eligible(context,brand,q.id),restricted=scheduleReleased(context,brand,who.author);return{status:200,body:{...b,can_schedule:canStart(who,b)&&(restricted||!(b.eligible_count>10000)),can_cancel:true,real_schedule:restricted,schedule_max_minutes:restricted?10080:120,schedule_rate_per_hour:restricted?60000:null}};}return r;}
  if(action==='campanha_nativa_congelar'&&method==='POST'&&exact(q,['acao','brand','id','expected_version','expected_definition_hash','expected_context_hash','expected_catalog_hash','idempotency_key'])){
   if(!UUID.test(q.id||'')||!Number.isSafeInteger(q.expected_version)||q.expected_version<1||![q.expected_definition_hash,q.expected_context_hash,q.expected_catalog_hash].every(x=>HASH.test(x))||!UUID.test(q.idempotency_key))throw error(400,'NATIVE_INTERNAL_INPUT');
   const key=remoteKey(context,{brand,key:q.idempotency_key});
   // Source request owns replay/commit. A caller repeats this SAME intention;
   // an unconfirmed response is recovered with GET, never a new freeze key.
   return transport(context,{route:'segments',method:'POST',command:{...q,acao:'segmento_congelar_nativo_interno',idempotency_key:key}});
  }
  if(action==='campanha_nativa_reconciliar_congelamento'&&method==='POST'&&exact(q,['acao','brand','id','expected_version','expected_definition_hash','expected_context_hash','expected_catalog_hash','idempotency_key','confirm'])){
   if(!restrictedUser(who.author))throw error(403,'NATIVE_INTERNAL_QA_ONLY');
   if(!UUID.test(q.id||'')||!Number.isSafeInteger(q.expected_version)||q.expected_version<1||![q.expected_definition_hash,q.expected_context_hash,q.expected_catalog_hash].every(x=>HASH.test(x))||!UUID.test(q.idempotency_key)||q.confirm!=='reconciliar_intencao_original')throw error(400,'NATIVE_INTERNAL_INPUT');
   return transport(context,{route:'segments',method:'POST',command:{...q,acao:'segmento_reconciliar_congelamento_nativo',idempotency_key:remoteKey(context,{brand,key:q.idempotency_key})}});
  }
  if(action==='campanha_nativa_congelamento_obter'&&method==='GET'&&exact(q,['acao','brand','idempotency_key'])){
   if(!UUID.test(q.idempotency_key))throw error(400,'NATIVE_INTERNAL_INPUT');return transport(context,{route:'segments',method,command:{acao:'segmento_congelamento_nativo_obter',brand,idempotency_key:remoteKey(context,{brand,key:q.idempotency_key})}});
  }
  if(action==='campanha_nativa_revisar_publico'&&method==='GET'&&exact(q,['acao','brand','id','expected_version','expected_catalog_hash'])){
   if(!UUID.test(q.id||'')||!Number.isSafeInteger(q.expected_version)||!HASH.test(q.expected_catalog_hash))throw error(400,'NATIVE_INTERNAL_INPUT');return transport(context,{route:'segments',method,command:{...q,acao:'segmento_contexto_revisao'}});
  }
  if(action==='campanha_nativa_reconciliar_cancelamento'&&method==='POST'&&exact(q,['acao','brand','idempotency_key']))return delivery.recoverNativeCancel(context,{brand,idempotency_key:q.idempotency_key});
  if(action==='campanha_nativa_operacao'&&method==='GET'&&exact(q,['acao','brand','idempotency_key']))return delivery.reconcile(context,{brand,idempotency_key:q.idempotency_key});
  if(method!=='POST'||!Number.isSafeInteger(q.id)||q.id<1||!UUID.test(q.idempotency_key)||!/^[a-f0-9]{32}$/.test(q.expected_version||''))throw error(400,'NATIVE_INTERNAL_INPUT');
  const nativeContext=await eligible(context,brand,q.id);
  let command;
  if(action==='campanha_nativa_data'&&exact(q,['acao','brand','id','expected_version','idempotency_key','send_at'])){
   const date=Date.parse(q.send_at);if(typeof q.send_at!=='string'||!Number.isFinite(date)||date<Date.now()+20*60000||date>Date.now()+(scheduleReleased(context,brand,who.author)?7*24:2)*3600000)throw error(400,'NATIVE_INTERNAL_DATE');
   const current=await transport(context,{method:'GET',command:{acao:'campanha_obter',brand,id:q.id}}),c=current.body.campaign;
   if(current.status!==200||c?.id!==q.id||c.version!==q.expected_version||c.status!=='draft'||c.sent!==0||c.started_at!==null||c.definition?.brand!==brand)throw error(409,'NATIVE_INTERNAL_CHANGED');
   if(!restrictedUser(who.author))requireCouponDestinations(c.definition,brand);
   command={acao:'campanha_salvar',brand,id:q.id,expected_version:q.expected_version,idempotency_key:q.idempotency_key,definition:{...c.definition,send_at:q.send_at}};
  }else if(action==='campanha_nativa_validar'&&exact(q,['acao','brand','id','expected_version','idempotency_key']))command={...q,acao:'campanha_validar'};
  else if(action==='campanha_nativa_agendar'&&exact(q,['acao','brand','id','expected_version','idempotency_key','confirm','audience_review_id'])&&q.confirm==='agendar')command={...q,acao:'campanha_agendar'};
  else if(action==='campanha_nativa_cancelar'&&exact(q,['acao','brand','id','expected_version','idempotency_key','confirm'])&&q.confirm==='cancelar')command={...q,acao:'campanha_cancelar'};
  else throw error(400,'NATIVE_INTERNAL_INPUT');
  if(action==='campanha_nativa_agendar'&&(!canStart(who,nativeContext)||!scheduleReleased(context,brand,who.author)&&nativeContext.eligible_count>10000))throw error(409,'CONSENT_REGISTRATION_REQUIRED');
  if(action==='campanha_nativa_agendar'){
   const current=await transport(context,{method:'GET',command:{acao:'campanha_obter',brand,id:q.id}}),c=current.body.campaign,date=Date.parse(c?.send_at),time=Date.now();
   if(current.status!==200||c?.id!==q.id||c.version!==q.expected_version||c.status!=='draft'||c.sent!==0||c.started_at!==null)throw error(409,'NATIVE_INTERNAL_CHANGED');
   if(!Number.isFinite(date)||date<time+20*60000||date>time+(scheduleReleased(context,brand,who.author)?7*24:2)*3600000)throw error(400,'NATIVE_INTERNAL_DATE');
  }

  deliveryStarted=true;return await delivery.submit(context,command);
  }catch(e){if(!deliveryStarted&&method==='POST'&&['campanha_nativa_data','campanha_nativa_validar','campanha_nativa_agendar','campanha_nativa_cancelar'].includes(q?.acao))e.nativeNotReserved=true;throw e;}
 }
 return Object.freeze({handle,transport});
}
module.exports={allowedOperator,allowedEditor,create,requireCouponDestinations,requireRenderedTest,EMAIL,IDS};

// Current campaign operator. Listmonk owns the campaign and its state. Each
// action makes one native write. Existing campaign reads preserve brand authorization; no local attempt is reserved.
function nativeListBrand(list){
 const aliases={__proto__:null,fish:'fish',fishermans:'fish',aristo:'aristo',aristocrata:'aristo',olivas:'olivas'};
 if(list?.tags!==undefined&&list.tags!==null&&!Array.isArray(list.tags))return null;
 const brands=new Set((list?.tags||[]).filter(t=>typeof t==='string').map(t=>aliases[t.trim().toLowerCase()]).filter(Boolean));
 // Original structured tags are authoritative. "cross" describes a campaign,
 // not another brand; names are a fallback only when no brand tag exists.
 if(brands.size)return brands.size===1&&!brands.has('olivas')?[...brands][0]:null;
 const name=typeof list?.name==='string'?list.name.trim():'';
 const namedBrands=new Set((name.match(/\b(?:FISH|FISHERMANS|ARISTO|ARISTOCRATA|OLIVAS)\b/gi)||[]).map(t=>aliases[t.toLowerCase()]));
 if(namedBrands.size!==1||namedBrands.has('olivas'))return null;
 if(/^(?:BASE\s+)?(?:FISH|FISHERMANS)\s*[—–:·|\-]\s*\S/i.test(name))return 'fish';
 if(/^(?:BASE\s+)?(?:ARISTO|(?:O\s+)?ARISTOCRATA)\s*[—–:·|\-]\s*\S/i.test(name))return 'aristo';
 return null;
}
function createDirect({authorize,admitted,credentials,fetchImpl=fetch,now=Date.now,dynamicAudience}){
 const bases={aristo:16,fish:17},domains={aristo:'oaristocrata.com',fish:'fishermans.com.br'};
 const actions=new Set(['campanha_capacidade','campanha_catalogo','campanha_lista_contagem','campanha_listar','campanha_obter','campanha_criar','campanha_salvar','campanha_teste','campanha_agendar','campanha_cancelar']);
 const writing=action=>['campanha_criar','campanha_salvar','campanha_teste','campanha_agendar','campanha_cancelar'].includes(action);
 const future=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)>=now()+20*60000&&Date.parse(value)<=now()+7*86400000;
 const address=value=>String(value||'').match(/<([^<>]+)>$/)?.[1]||String(value||'');
 const ids=c=>(c.lists||c.list_ids||[]).map(x=>typeof x==='object'?x.id:x);
 const binding=brand=>{const value=credentials?.[brand];if(!value||typeof value.username!=='string'||!value.username||typeof value.token!=='string'||!value.token)throw error(503,'LISTMONK_UNAVAILABLE');return value;};
 function requireLists(lists,scope,active=false){
  if(!Array.isArray(lists)||!lists.length||lists.some(id=>!idOk(id)||!scope.has(id)))throw error(403,'CAMPAIGN_BRAND_REFUSED');
  if(active&&lists.some(id=>scope.get(id).status!=='active'))throw error(409,'CAMPAIGN_LIST_UNAVAILABLE');
 }
 function campaign(c,brand,scope,active=false,contentReview=false){
  const lists=ids(c);if(!idOk(c?.id))throw error(403,'CAMPAIGN_BRAND_REFUSED');requireLists(lists,scope,active);
  const meta=c.attribs?.shrigma||{},previous=c.attribs?.crm||{},headers=Array.isArray(c.headers)?Object.assign({},...c.headers):c.headers||{};
  const value={id:c.id,version:c.updated_at||c.created_at,status:c.status,sent:c.sent??0,started_at:c.started_at??null,send_at:c.send_at??null,attribs:c.attribs??{},media:(c.media||[]).map(x=>typeof x==='object'?x.id:x),headers:c.headers||[],content_type:c.content_type,type:c.type,messenger:c.messenger,definition:{schema_version:'crm-campaign-v1',brand,channel:'email',name:c.name,subject:c.subject,from_email:c.from_email,reply_to:headers['Reply-To']||'contato@'+domains[brand],list_ids:lists,template_id:c.template_id,html:c.body||'',text:c.altbody||'',tags:c.tags||[],initiative:meta.initiative||(previous.initiative_key?{key:previous.initiative_key,name:previous.initiative_name||c.name}:{key:'campanha',name:c.name}),utm_campaign:meta.utm_campaign||previous.utm_campaign||'campanha',send_at:c.send_at??null},audience_id:meta.audience_id||null,audience_name:meta.audience_name||null};
  if(contentReview){try{const rows=require('./campaign-editorial-policy.cjs').review({brand,html:c.body||'',text:c.altbody||'',campaign:value.definition.utm_campaign}).diagnostics.filter(x=>x.code==='EXTERNAL_CTA');if(rows.length)value.content_diagnostics=rows;}catch{value.content_diagnostics=[{code:'CONTENT_REVIEW_UNAVAILABLE',severity:'warning',field:'html',line:1,message:'Revisão do conteúdo indisponível.'}];}}
  return value;
 }
 const idOk=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
 function payload(d,brand,q){
  if(!d||d.brand!==brand||typeof d.name!=='string'||!d.name.trim()||typeof d.subject!=='string'||!d.subject.trim()||typeof d.html!=='string'||!d.html.trim()||!Array.isArray(d.list_ids)||!d.list_ids.length||d.list_ids.some(id=>!idOk(id)))throw error(400,'CAMPAIGN_INPUT');
  const sender=address(d.from_email).toLowerCase(),domain=domains[brand];
  if(!['avisos@'+domain,'contato@'+domain].includes(sender)||d.reply_to!=='contato@'+domain)throw error(403,'CAMPAIGN_BRAND_REFUSED');
  if(d.template_id!==null&&(!Number.isSafeInteger(d.template_id)||d.template_id<0))throw error(400,'CAMPAIGN_INPUT');
  if(q.acao!=='campanha_teste'&&d.send_at!==null&&d.send_at!==undefined&&!future(d.send_at))throw error(400,'NATIVE_INTERNAL_DATE');
  if(q.content_type&&q.content_type!=='html'||q.type&&q.type!=='regular'||q.messenger&&q.messenger!=='email')throw error(400,'CAMPAIGN_FORMAT_UNAVAILABLE');
  if(!require('./campaign-editorial-policy.cjs').review({html:d.html,text:d.text||'',brand,campaign:d.utm_campaign}).ok)throw error(400,'CAMPAIGN_CONTENT_INVALID');
  const headers=(q.headers||[]).map(h=>Object.fromEntries(Object.entries(h).filter(([k])=>k.toLowerCase()!=='reply-to'&&(q.acao!=='campanha_teste'||!['to','cc','bcc'].includes(k.toLowerCase()))))).filter(h=>Object.keys(h).length);headers.push({'Reply-To':d.reply_to});
  const tracked=require('./campaign-write-tracking.js').prepareNative({status:'draft',sent:0,started_at:null,content_type:'html',lists:d.list_ids,body:d.html,altbody:d.text||''},{brand,campaign:d.utm_campaign||'campanha'});
  return {name:d.name.trim(),subject:d.subject,from_email:d.from_email,body:tracked.body,altbody:tracked.altbody,content_type:'html',type:'regular',messenger:'email',lists:d.list_ids,...(d.template_id===null?{}:{template_id:d.template_id}),headers,tags:d.tags||[],send_at:d.send_at??null,media:q.media||[],attribs:{...(q.attribs||{}),shrigma:{...(q.attribs?.shrigma||{}),brand,initiative:d.initiative,utm_campaign:d.utm_campaign,audience_id:q.audience_id??q.attribs?.shrigma?.audience_id??null,audience_name:q.audience_name??q.attribs?.shrigma?.audience_name??null,audience_binding:q.serverBinding||null}}};
 }
 async function request(brand,method,path,body){
  const secret=binding(brand);let r;
  try{r=await fetchImpl('https://email.shrigma.com.br/api'+path,{method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(60000),headers:{Accept:'application/json',Authorization:'Basic '+Buffer.from(secret.username+':'+secret.token).toString('base64'),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw error(502,'LISTMONK_RESULT_UNCONFIRMED');}
  if(!r.ok){await r.body?.cancel();throw error(r.status>=400&&r.status<500?r.status:502,'LISTMONK_HTTP_'+r.status);}
  let size=0,parts=[];for await(const b of r.body){size+=b.length;if(size>8*1024*1024)throw error(502,'LISTMONK_RESPONSE_LIMIT');parts.push(b);}
  let data;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');}
  if(!Object.hasOwn(data,'data'))throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');return data.data;
 }
 async function readLists(brand){
  const data=await request(brand,'GET','/lists?minimal=true&per_page=all'),rows=Array.isArray(data)?data:data?.results;
  if(!Array.isArray(rows)||rows.some(list=>!list||!idOk(list.id))||new Set(rows.map(list=>list.id)).size!==rows.length)throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
  if(!Array.isArray(data)&&(!Number.isSafeInteger(data.total)||data.total!==rows.length))throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
  return new Map(rows.filter(list=>nativeListBrand(list)===brand).map(list=>[list.id,list]));
 }
 async function handle(context,method,q){
  if(!q||!actions.has(q.acao)||!Object.hasOwn(bases,q.brand))throw error(400,'CAMPAIGN_INPUT');
  const brand=q.brand,action=q.acao,write=writing(action),user=authorize(context,brand,write),released=admitted(context,brand,user);
  if(write&&(!released||!allowedEditor(user)))throw error(403,'CAMPAIGN_RELEASE_CLOSED');
  if(method!==(write?'POST':'GET'))throw error(405,'METHOD_DENIED');
  // Authorization is derived from original Listmonk metadata on every action,
  // shared only within this request. No manual ID binding or persistent cache.
  let scope;const currentScope=async()=>scope||(scope=await readLists(brand));
  const writeRequest=async(method,path,body)=>{const current=authorize(context,brand,true);if(!admitted(context,brand,current)||!allowedEditor(current))throw error(403,'CAMPAIGN_RELEASE_CLOSED');return request(brand,method,path,body);};
  if(action==='campanha_capacidade')return {status:200,body:{schema:'crm-listmonk-direct-v1',brand,read:true,draft:released&&allowedEditor(user),send:false,native_direct:true}};
  if(action==='campanha_catalogo'){
   const lists=[...(await currentScope()).values()].map(list=>({id:list.id,name:list.name,brand,available:list.status==='active'}));
   // A null layout delegates selection to Listmonk when the campaign is
   // created. The existing campaign role does not read the template catalog.
   const templates=[{id:null,name:'Padrão do Listmonk',brand,type:'campaign',available:true,native_default:true}];
   return {status:200,body:{brand,current:true,read_at:new Date(now()).toISOString(),dynamic_audiences:dynamicAudience?.admitted(context,brand)===true,lists,templates,initiatives:[]}};
  }
  if(action==='campanha_lista_contagem'){
   if(!idOk(q.list_id))throw error(403,'CAMPAIGN_BRAND_REFUSED');
   const list=await request(brand,'GET','/lists/'+q.list_id);if(list?.id!==q.list_id)throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');if(nativeListBrand(list)!==brand)throw error(403,'CAMPAIGN_BRAND_REFUSED');if(list.status!=='active')throw error(409,'CAMPAIGN_LIST_UNAVAILABLE');
   const members=await request(brand,'GET','/subscribers?list_id='+q.list_id+'&per_page=1&page=1');
   if(!Number.isSafeInteger(members?.total)||members.total<0)throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
   return {status:200,body:{brand,list_id:q.list_id,member_count:members.total,checked_at:new Date(now()).toISOString(),source:'listmonk'}};
  }
  if(action==='campanha_listar'){
   await currentScope();
   const data=await request(brand,'GET','/campaigns?no_body=true&per_page=100&page='+Math.max(1,Number(q.page)||1));
   const rows=Array.isArray(data)?data:data.results;if(!Array.isArray(rows))throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
   const campaigns=[];for(const row of rows)try{campaigns.push(campaign(row,brand,scope));}catch(e){if(e.code!=='CAMPAIGN_BRAND_REFUSED')throw e;}
   const page=Math.max(1,Number(q.page)||1),total=Array.isArray(data)?data.length:data.total;
   return {status:200,body:{campaigns:dynamicAudience?await dynamicAudience.decorateMany(context,brand,campaigns):campaigns,total,page,has_more:!Array.isArray(data)&&page*100<total}};
  }
  if(action!=='campanha_criar'&&!idOk(q.id))throw error(400,'CAMPAIGN_INPUT');
  if(action==='campanha_obter'){await currentScope();let value=campaign(await request(brand,'GET','/campaigns/'+q.id),brand,scope,false,true);if(dynamicAudience)value=await dynamicAudience.decorate(context,brand,value);return {status:200,body:{campaign:value}};}
  if(['campanha_salvar','campanha_cancelar'].includes(action)&&(!q.attribs||typeof q.attribs!=='object'||Array.isArray(q.attribs)||!Array.isArray(q.media)||q.acao==='campanha_salvar'&&!Array.isArray(q.headers)))throw error(400,'CAMPAIGN_INPUT');
  let data;
  const existing=async(active=false)=>{await currentScope();return campaign(await request(brand,'GET','/campaigns/'+q.id),brand,scope,active);};
  if(action==='campanha_criar'||action==='campanha_salvar'){
   let selected=q.audience_id;let body=payload(q.definition,brand,{...q,serverBinding:null});requireLists(q.definition.list_ids,await currentScope(),true);
   if(action==='campanha_salvar'){const current=await existing(true);if(q.expected_version!==undefined&&current.version!==q.expected_version)throw error(409,'CAMPAIGN_VERSION_CONFLICT');if(dynamicAudience)await dynamicAudience.assertEditable(context,brand,current);if(typeof current.audience_id==='string'&&current.audience_id.startsWith('purchase:'))selected=current.audience_id;}
   const serverBinding=dynamicAudience?.bind(context,brand,selected)||null;
   if(typeof selected==='string'&&selected.startsWith('purchase:')&&!serverBinding)throw error(503,'PAID_CAMPAIGN_RESOLUTION_UNAVAILABLE');
   if(serverBinding&&(q.definition.list_ids.length!==1||q.definition.list_ids[0]!==serverBinding.baseListId))throw error(403,'CAMPAIGN_BRAND_REFUSED');
   q={...q,serverBinding,audience_id:serverBinding?'purchase:'+serverBinding.id:q.audience_id,audience_name:serverBinding?serverBinding.name:q.audience_name};body=payload(q.definition,brand,q);
   data=await writeRequest(action==='campanha_criar'?'POST':'PUT','/campaigns'+(action==='campanha_criar'?'':'/'+q.id),body);}
  else if(action==='campanha_teste'){
   const target=String(q.recipient||'').trim().toLowerCase();
   if(target.length>254||target.includes('..')||!/^[a-z0-9][a-z0-9._+\-]*@(oaristocrata\.com|fishermans\.com\.br|shrigma\.com\.br)$/.test(target))throw error(400,'CAMPAIGN_TEST_RECIPIENT');
   requireRenderedTest(q.definition);
   const body=payload(q.definition,brand,q);body.subject='[TESTE] '+body.subject.replace(/^(?:\[TESTE\] )+/,'');body.subscribers=[target];delete body.send_at;
   requireLists(q.definition.list_ids,await currentScope(),true);await existing(true);data=await writeRequest('POST','/campaigns/'+q.id+'/test',body);if(data!==true)throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
   return {status:200,body:{accepted:true,brand,campaign_id:q.id,recipient:target,subject:body.subject}};
  }else if(action==='campanha_agendar'){
   if(q.confirm!=='agendar')throw error(400,'CAMPAIGN_INPUT');
   if(!future(q.send_at))throw error(400,'NATIVE_INTERNAL_DATE');
   const current=await existing(true);if(!future(current.send_at)||Date.parse(current.send_at)!==Date.parse(q.send_at))throw error(400,'NATIVE_INTERNAL_DATE');
   if(dynamicAudience?.supported(current)){const queued=await dynamicAudience.schedule(context,brand,current,q.send_at);return {status:200,body:queued};}
   if(typeof current.audience_id==='string'&&current.audience_id.startsWith('purchase:'))throw error(503,'PAID_CAMPAIGN_RESOLUTION_UNAVAILABLE');
   data=await writeRequest('PUT','/campaigns/'+q.id+'/status',{status:'scheduled'});
  }else if(action==='campanha_cancelar'){
   if(q.confirm!=='cancelar'||!Array.isArray(q.list_ids)||!q.list_ids.length||q.list_ids.some(id=>!idOk(id)))throw error(400,'CAMPAIGN_INPUT');
   requireLists(q.list_ids,await currentScope());const original=await existing();if(dynamicAudience?.supported(original)){await dynamicAudience.cancel(context,brand,original);q={...q,attribs:original.attribs};}data=await writeRequest('PUT','/campaigns/'+q.id,{lists:q.list_ids,send_at:null,attribs:q.attribs??{},media:q.media||[]});
  }
  if(!data||typeof data!=='object')throw error(502,'LISTMONK_RESPONSE_UNCONFIRMED');
  return {status:action==='campanha_criar'?201:200,body:{campaign:campaign(data,brand,scope,false,true)}};
 }
 return Object.freeze({handle,actions});
}
module.exports.createDirect=createDirect;
module.exports.nativeListBrand=nativeListBrand;
