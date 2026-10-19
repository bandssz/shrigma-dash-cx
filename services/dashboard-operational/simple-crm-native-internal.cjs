'use strict';
// Stateless admission for the single authorized internal QA account. All
// durable intentions remain in the original audience request / BFF delivery.
const P=require('./proxy.cjs');
const EMAIL='felipebandeira+codex@oaristocrata.com';
const allowedOperator=author=>[EMAIL,'felipebandeira@oaristocrata.com'].includes(author?.email?.toLowerCase())&&author?.permissions?.growth?.edit===true;
const allowedEditor=author=>author?.permissions?.growth?.edit===true;
const IDS=Object.freeze({aristo:'23b3132a-a00b-41d3-ac31-0216a37f6100',fish:'6b034a75-a02f-4a0e-9b18-43c4be87881b'});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const error=(status,code)=>Object.assign(Error(code),{status,code});
function requireCouponDestinations(definition,brand){
 const pending=require('./campaign-write-tracking.js').review({body:definition.html,altbody:definition.text},{brand,campaign:definition.utm_campaign}).issues.some(x=>x.code.startsWith('COUPON_'));
 if(pending)throw error(409,'COUPON_DESTINATION_REQUIRED');
}
const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
function create({binding,remoteKey,delivery,fetchImpl=fetch,enabled=false,editorsEnabled=false,frozenAudienceV3=false,scheduleReady=()=>false}){
 if(typeof binding!=='function'||typeof remoteKey!=='function'||!delivery)throw Error('NATIVE_INTERNAL_CONFIG');
 const identity=async(context,brand)=>{if(!enabled||!['fish','aristo'].includes(brand))throw error(403,'NATIVE_INTERNAL_DISABLED');const p=await binding(context,{brand,write:true,fetchImpl});if(!allowedEditor(p.author))throw error(403,'NATIVE_INTERNAL_EDITOR_REQUIRED');return p;};
 async function transport(context,{route='campaigns',method,command}){
  const p=await identity(context,command.brand),action=command.acao;
  const allowed=route==='segments'?(method==='GET'?['segmento_contexto_revisao','segmento_congelamento_nativo_obter']:['segmento_congelar_nativo_interno']):(method==='GET'?['campanha_nativa_contexto','campanha_obter','campanha_catalogo','campanha_operacao']:['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar','campanha_reconciliar_cancelamento']);
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
  if(action==='campanha_nativa_contexto'&&method==='GET'&&exact(q,['acao','brand','id'])){const r=await transport(context,{method,command:q});if(r.status===200&&r.body?.eligible===true){const b=await eligible(context,brand,q.id);return{status:200,body:{...b,can_schedule:canStart(who,b),can_cancel:true}};}return r;}
  if(action==='campanha_nativa_congelar'&&method==='POST'&&exact(q,['acao','brand','id','expected_version','expected_definition_hash','expected_context_hash','expected_catalog_hash','idempotency_key'])){
   if(!UUID.test(q.id||'')||!Number.isSafeInteger(q.expected_version)||q.expected_version<1||![q.expected_definition_hash,q.expected_context_hash,q.expected_catalog_hash].every(x=>HASH.test(x))||!UUID.test(q.idempotency_key))throw error(400,'NATIVE_INTERNAL_INPUT');
   const key=remoteKey(context,{brand,key:q.idempotency_key});
   // Source request owns replay/commit. A caller repeats this SAME intention;
   // an unconfirmed response is recovered with GET, never a new freeze key.
   return transport(context,{route:'segments',method:'POST',command:{...q,acao:'segmento_congelar_nativo_interno',idempotency_key:key}});
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
   const date=Date.parse(q.send_at);if(typeof q.send_at!=='string'||!Number.isFinite(date)||date<Date.now()+20*60000||date>Date.now()+2*3600000)throw error(400,'NATIVE_INTERNAL_DATE');
   const current=await transport(context,{method:'GET',command:{acao:'campanha_obter',brand,id:q.id}}),c=current.body.campaign;
   if(current.status!==200||c?.id!==q.id||c.version!==q.expected_version||c.status!=='draft'||c.sent!==0||c.started_at!==null||c.definition?.brand!==brand)throw error(409,'NATIVE_INTERNAL_CHANGED');
   requireCouponDestinations(c.definition,brand);
   command={acao:'campanha_salvar',brand,id:q.id,expected_version:q.expected_version,idempotency_key:q.idempotency_key,definition:{...c.definition,send_at:q.send_at}};
  }else if(action==='campanha_nativa_validar'&&exact(q,['acao','brand','id','expected_version','idempotency_key']))command={...q,acao:'campanha_validar'};
  else if(action==='campanha_nativa_agendar'&&exact(q,['acao','brand','id','expected_version','idempotency_key','confirm','audience_review_id'])&&q.confirm==='agendar')command={...q,acao:'campanha_agendar'};
  else if(action==='campanha_nativa_cancelar'&&exact(q,['acao','brand','id','expected_version','idempotency_key','confirm'])&&q.confirm==='cancelar')command={...q,acao:'campanha_cancelar'};
  else throw error(400,'NATIVE_INTERNAL_INPUT');
  if(action==='campanha_nativa_agendar'&&!canStart(who,nativeContext))throw error(409,'CONSENT_REGISTRATION_REQUIRED');
  deliveryStarted=true;return await delivery.submit(context,command);
  }catch(e){if(!deliveryStarted&&method==='POST'&&['campanha_nativa_data','campanha_nativa_validar','campanha_nativa_agendar','campanha_nativa_cancelar'].includes(q?.acao))e.nativeNotReserved=true;throw e;}
 }
 return Object.freeze({handle,transport});
}
module.exports={allowedOperator,allowedEditor,create,requireCouponDestinations,EMAIL,IDS};
