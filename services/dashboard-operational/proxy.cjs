'use strict';
const crypto=require('node:crypto');
const AudienceContract=require('./segment-audience-contract.js');
// Browser-to-upstream contract. Each action has its own exact method, selector,
// fields and credential slot. A receipt lookup is a read, but must use the
// writer's principal; edit:true makes the session grant mandatory as well.
const rule=(required=[],optional=[],options={})=>Object.freeze({required,optional,...options});
const READ=Object.freeze({
  cx:{area:'panel',slot:'growth-read',method:'GET',actions:{'':rule(['painel'],['access'])}},
  cache:{area:'panel',slot:'growth-read',method:'GET',actions:{'':rule(['painel'])}},
  'crm-read':{area:'growth',slot:'crm-panel-read',method:'GET',selector:'action',actions:{identity:rule(['painel']),cache_growth:rule(['painel'])}},
  campaigns:{area:'growth',slot:'growth-campaign-read',method:'GET',selector:'acao',actions:{
    campanha_catalogo:rule(['brand']),campanha_listar:rule(['brand']),campanha_obter:rule(['brand','id']),
    campanha_operacao:rule(['brand','idempotency_key'],[],{slot:'growth-campaign',edit:true}),
    campanha_salvar:rule(['brand','definition','idempotency_key'],['id','expected_version'],{method:'POST',slot:'growth-campaign',edit:true,bodyKey:true}),
    campanha_validar:rule(['brand','id','expected_version','idempotency_key'],[],{method:'POST',slot:'growth-campaign',edit:true,bodyKey:true,submitGate:true}),
    campanha_agendar:rule(['brand','id','expected_version','idempotency_key','confirm','audience_review_id'],[],{method:'POST',slot:'growth-campaign',edit:true,bodyKey:true,submitGate:true}),
    campanha_cancelar:rule(['brand','id','expected_version','idempotency_key','confirm'],[],{method:'POST',slot:'growth-campaign',edit:true,bodyKey:true,submitGate:true})}},
  // Media is an independent, opt-in route. Only the bounded library listing
  // is admitted; upload and recovery remain unavailable through this BFF.
  campaigns_media:{area:'growth',slot:'growth-campaign-read',method:'GET',actions:{'':rule(['brand'],['page','per_page'])}},
  segments:{area:'growth',slot:'growth-audience-read',method:'GET',selector:'acao',actions:{
    segmentos_listar:rule(['brand','offset','limit']),segmento_obter:rule(['brand','id']),
    segmento_contexto_revisao:rule(['brand','id','expected_version','expected_catalog_hash']),
    segmento_contar:rule(['brand','expected_catalog_hash'],['id','expected_version','definition'],{method:'POST',slot:'growth-audience',edit:true}),
    segmento_contexto_v2:rule(['brand'],[],{slot:'growth-audience',edit:true}),
    segmento_operacao:rule(['brand','idempotency_key'],[],{slot:'growth-audience',edit:true}),
    segmento_criar:rule(['brand','definition','expected_catalog_hash','idempotency_key'],[],{method:'POST',slot:'growth-audience',edit:true}),
    segmento_salvar:rule(['brand','id','expected_version','definition','expected_catalog_hash','idempotency_key'],[],{method:'POST',slot:'growth-audience',edit:true}),
    segmento_arquivar:rule(['brand','id','expected_version','idempotency_key'],[],{method:'POST',slot:'growth-audience',edit:true})}},
  campaign_audience:{area:'growth',slot:'growth-audience-read',method:'GET',selector:'acao',actions:{
    campanha_publico_obter:rule(['brand','campaign_id']),
    campanha_publico_operacao:rule(['brand','idempotency_key'],[],{slot:'growth-audience',edit:true}),
    campanha_publico_agendamento_operacao:rule(['brand','idempotency_key'],[],{slot:'growth-audience',edit:true})}},
  templates:{area:'growth',slot:'growth-templates-read',method:'GET',selector:'acao',actions:{
    listar:rule([],['marca','canal']),email_capacidades:rule(),historico:rule([],['key','draft_id']),
    submissao:rule(['submission_id']),fluxos_listar:rule(),
    fluxo_operacao:rule(['idempotency_key','operation_action'],[],{slot:'growth-templates',edit:true}),
    operacao:rule(['idempotency_key','operacao'],[],{slot:'growth-templates',edit:true,header:'X-Template-Key'}),
    email_teste_capacidades_v2:rule([],[],{slot:'growth-templates',edit:true}),
    email_teste_operacao:rule(['idempotency_key'],[],{slot:'growth-templates',edit:true}),
    email_teste_operacao_v2:rule(['idempotency_key'],[],{slot:'growth-templates',edit:true}),
    email_teste_testadores_v2:rule(['brand'],[],{slot:'growth-templates',edit:true})}},
  journey_graph:{area:'growth',slot:'growth-flows-read',method:'GET',selector:'action',actions:{
    capabilities:rule(['brand']),catalog:rule(['brand']),list:rule(['brand'],['after','limit']),
    get:rule(['brand','journey_id']),operation:rule(['brand','request_id'],[],{slot:'growth-flows',edit:true})}},
  journey_graph_lifecycle:{area:'growth',slot:'growth-flows-read',method:'GET',selector:'action',actions:{
    status:rule(['brand','journey_id']),operation:rule(['brand','request_id'],[],{slot:'growth-flows',edit:true})}},
  ab_experiment:{area:'growth',slot:'growth-ab-read',method:'GET',selector:'method',actions:{
    capabilities:rule(['brand']),list:rule(['brand']),campaigns:rule(['brand']),get:rule(['brand','test_id']),
    operation:rule(['brand','operation_id','action'],[],{slot:'growth-ab-write',edit:true})}},
  ab:{area:'growth',slot:'growth-ab-write',method:'GET',selector:'acao',header:'X-AB-Write-Key',actions:{
    capacidades:rule([],[],{edit:true}),registro:rule(['teste_id'],[],{edit:true}),
    operacao:rule(['operation_id','operacao','teste_id'],[],{edit:true})}},
  influ:{area:'influs',slot:'influs-read',method:'POST',selector:'acao',actions:{
    listar:rule(['ini','fim'],['pilot','conciliacao_pedidos','marca']),
    piloto_salvar:rule(['kind','request_id','expected_version','data'],[],{slot:'influs-write',edit:true,bodyKey:true}),
    piloto_operacao:rule(['request_id'],[],{slot:'influs-write',edit:true,bodyKey:true})}},
  tts:{area:'influs',slot:'tts-read',method:'POST',actions:{'':rule(['ini','fim'])}},
  'tts-action':{area:'influs',slot:'tts-write',method:'GET',selector:'acao',header:'X-TTS-Write-Key',actions:{
    capacidades:rule([],[],{edit:true}),operacao:rule(['operation_id','marca','application_id'],[],{edit:true})}},
  'tts-cobranca':{area:'influs',slot:'influs-read',method:'POST',selector:'acao',bodyKey:true,actions:{ler:rule(),produtos:rule()}},
  'organico-links':{area:'organico',slot:'organico-links',method:'POST',selector:'acao',bodyKey:true,actions:{listar:rule()}},
  candidaturas:{area:'influs',slot:'influs-read',method:'POST',selector:'acao',bodyKey:true,actions:{ler:rule(),print:rule(['id'])}},
  aprovacao:{area:'influs',slot:'influs-read',method:'POST',selector:'acao',bodyKey:true,actions:{ler:rule()}},
  escopo:{area:'influs',slot:'influs-read',method:'POST',selector:'acao',bodyKey:true,actions:{ler:rule(['mes'])}}
});
// Keep these exact URLs in sync with build.cjs ENDPOINTS. The runtime pack
// contains proxy.cjs but not build.cjs; the test suite checks that parity.
const FIXED_DESTINATIONS=Object.freeze({
  cx:'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d',
  cache:'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-cache-a91f3c7e2d4b',
  'crm-read':'https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read',
  ab:'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-teste-api-01d240f09eff8e39',
  influ:'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-influ-api-7c41e0b93a5d8f26',
  tts:'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-painel-api-9d3f7a1c',
  'tts-action':'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-acao-api-2c7e9f41',
  'organico-links':'https://n8n-n8n.tazdb8.easypanel.host/webhook/organico-links-utm-8f07a61f3f3c',
  'tts-cobranca':'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-cobranca-painel-a3ac4c25d1e85399',
  candidaturas:'https://n8n-n8n.tazdb8.easypanel.host/webhook/parceiros-candidatura-bc82004eb9363032',
  aprovacao:'https://n8n-n8n.tazdb8.easypanel.host/webhook/parceiros-aprovacao-c58b68db6d3a02f0',
  escopo:'https://n8n-n8n.tazdb8.easypanel.host/webhook/influs-escopo-7d79357c9b85b871'
});
const DYNAMIC_MANIFEST_SCHEMA='shrigma_dashboard_dynamic_upstreams_v1';
// An explicit test profile has a closed destination set. It cannot replace,
// mix with, or redirect any production destination through environment input.
const SANDBOX_HOST='dashboard-crm-sandbox-20261002.tazdb8.easypanel.host';
const SANDBOX_DESTINATIONS=Object.freeze({cx:'https://'+SANDBOX_HOST+'/dashboard',cache:'https://'+SANDBOX_HOST+'/dashboard',segments:'https://'+SANDBOX_HOST+'/segments'});
const SANDBOX_CAMPAIGN_DESTINATION='https://'+SANDBOX_HOST+'/campaigns';
// Candidate destinations reviewed against the source at this commit. The
// campaign URL preserves its published n8n-host path, which Easypanel maps to
// crm-campaign; the direct service alias must not replace that journal origin.
// This pin does not prove live application readiness. Templates and
// journey_graph stay unpinned.
const REVIEWED_DYNAMIC=Object.freeze({
  sourceRevision:'4517cc3d3060a75e9d11c360479054cb0bd4d459',
  sourceSha256:Object.freeze({
    'services/crm-audience/server.cjs':'2c86d8814c58626537286bc86829c4b93364cb0706b7b15b4725ce45614b8480',
    'services/crm-campaign/server.cjs':'fedf25ddd817a6cc7cb9a631da9ba7959190dc5dbb0d23fc9f9e0107846bb721',
    'services/crm-campaign/media.cjs':'ca341115f736c0dae0b0dc7fd1645c583e2ee6bf7eb3c700a90d0859fab21a4f'
  }),
  routes:Object.freeze({
    campaigns:'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35',
    campaigns_media:'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35/media',
    segments:'https://comunicacao-crm-audience.tazdb8.easypanel.host/segments',
    campaign_audience:'https://comunicacao-crm-audience.tazdb8.easypanel.host/campaign-audience',
    ab_experiment:'https://comunicacao-crm-audience.tazdb8.easypanel.host/ab-experiments',
    journey_graph_lifecycle:'https://comunicacao-crm-audience.tazdb8.easypanel.host/journey-graph-lifecycle'
  })
});
const MAX_REQUEST=128*1024,MAX_CAMPAIGN_REQUEST=256*1024,MAX_AUDIENCE_REQUEST=16000,MAX_RESPONSE=4*1024*1024,MAX_CRM_CACHE_RESPONSE=8*1024*1024,MAX_PRINT_RESPONSE=5*1024*1024,MAX_MEDIA_RESPONSE=2*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const AUDIENCE_KEY=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY=/^[A-Za-z0-9_.:-]{8,128}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const BRAND=/^(fish|aristo)$/;
const validDate=s=>DATE.test(s)&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const positive=s=>/^[1-9]\d{0,15}$/.test(s)&&Number.isSafeInteger(Number(s));
const validField=(route,name,value)=>{
  switch(name){
    case 'painel':return ['growth','organico','influs'].includes(value);
    case 'access':return value==='1';
    case 'brand':return BRAND.test(value);
    case 'marca':return route==='influ'?['fish','aristo','todas'].includes(value):BRAND.test(value);
    case 'ini':case 'fim':return validDate(value);
    case 'mes':return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
    case 'pilot':case 'conciliacao_pedidos':return value===true||value===false;
    case 'canal':return ['email','whatsapp'].includes(value);
    case 'offset':return /^\d{1,5}$/.test(value)&&Number(value)<=10000;
    case 'limit':return /^[1-9]\d?$|^100$/.test(value)&&Number(value)<=(route==='journey_graph'?50:100);
    case 'page':return route==='campaigns_media'&&/^[1-9]\d{0,4}$/.test(value)&&Number(value)<=10000;
    case 'per_page':return route==='campaigns_media'&&/^[1-9]\d?$/.test(value)&&Number(value)<=50;
    case 'after':return value===''||UUID.test(value);
    case 'id':return route==='candidaturas'?UUID.test(value):route==='segments'?UUID.test(value)&&value===value.toLowerCase():positive(value);
    case 'campaign_id':return positive(value);
    case 'journey_id':case 'request_id':case 'test_id':case 'operation_id':return UUID.test(value);
    case 'application_id':return /^[1-9]\d{0,79}$/.test(value);
    case 'teste_id':return typeof value==='string'&&value.length>=1&&value.length<=256&&value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value);
    case 'idempotency_key':return route==='campaigns'?/^[A-Za-z0-9_-]{16,100}$/.test(value):route==='segments'?AUDIENCE_KEY.test(value):KEY.test(value);
    case 'expected_catalog_hash':return route==='segments'&&typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    case 'expected_version':return route==='influ'?Number.isSafeInteger(value)&&value>=1&&value<=99999999:route==='segments'?typeof value==='string'&&/^[1-9]\d{0,8}$/.test(value)&&Number(value)<=999999999:route==='campaigns'&&typeof value==='string'&&/^[a-f0-9]{32}$/i.test(value);
    case 'kind':return route==='influ'&&value==='candidato';
    case 'data':return route==='influ'&&value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')==='handle,id,marca,name,note,source,source_reference,state'&&UUID.test(value.id)&&['fish','aristo'].includes(value.marca)&&value.state==='em_analise'&&['manual','formulario_site'].includes(value.source)&&typeof value.name==='string'&&[...value.name.trim()].length>=2&&[...value.name].length<=120&&[['handle',120],['note',1000],['source_reference',100]].every(([k,max])=>typeof value[k]==='string'&&[...value[k]].length<=max);
    case 'audience_review_id':return route==='campaigns'&&typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
    case 'confirm':return route==='campaigns'&&['agendar','cancelar'].includes(value);
    case 'draft_id':return /^d_[A-Za-z0-9_-]{1,96}$/.test(value);
    case 'key':case 'submission_id':return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
    case 'operacao':return route==='ab'?['criar','encerrar'].includes(value):['rascunho','validar','submeter'].includes(value);
    case 'operation_action':return ['fluxo_salvar','fluxo_publicar','fluxo_estado'].includes(value);
    case 'action':return route==='ab_experiment'&&['prepare','review','schedule','cancel','close'].includes(value);
    default:return false;
  }
};
class ProxyError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const audienceRejections=Object.freeze({SEGMENT_SHAPE:422,SEGMENT_BRAND_MISMATCH:422,SEGMENT_LIST_UNAVAILABLE:422,SEGMENT_UNAVAILABLE:503,SEGMENT_NOT_FOUND:404,SEGMENT_VERSION_CONFLICT:409,SEGMENT_ARCHIVED:409,SEGMENT_CATALOG_CHANGED:409});
function validAudienceDefinition(value){try{return !!AudienceContract.normalize(value);}catch{return false;}}
function audiencePayloadHash(value){
 let nodes=0;
 function canonical(item,depth){
  if(++nodes>300000||depth>32)throw new ProxyError(403,'FIELD_DENIED');
  if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return JSON.stringify(item);
  if(typeof item==='string'&&item.length<=32768)return JSON.stringify(item);
  if(Array.isArray(item)){if(Object.keys(item).length!==item.length)throw new ProxyError(403,'FIELD_DENIED');return '['+item.map(v=>canonical(v,depth+1)).join(',')+']';}
  if(!plain(item))throw new ProxyError(403,'FIELD_DENIED');
  const keys=Object.keys(item);
  if(Reflect.ownKeys(item).length!==keys.length||keys.some(k=>{const d=Object.getOwnPropertyDescriptor(item,k);return !d||!Object.hasOwn(d,'value')||!d.enumerable;}))throw new ProxyError(403,'FIELD_DENIED');
  return '{'+keys.sort().map(k=>JSON.stringify(k)+':'+canonical(item[k],depth+1)).join(',')+'}';
 }
 const serialized=canonical(value,0);
 if(Buffer.byteLength(serialized,'utf8')>MAX_AUDIENCE_REQUEST)throw new ProxyError(413,'BODY_TOO_LARGE');
 return crypto.createHash('sha256').update(serialized,'utf8').digest('hex');
}
function verifiedAudienceScope(body,brand){
 const scope=body?.scope;
 if(!exact(body,['scope'])||!exact(scope,['schema','brand','actor_sha256'])||scope.schema!=='crm-audience-writer-scope-v2'||scope.brand!==brand||typeof scope.actor_sha256!=='string'||!/^[a-f0-9]{64}$/.test(scope.actor_sha256))throw new ProxyError(502,'UPSTREAM_SCOPE_UNCONFIRMED');
 return scope.actor_sha256;
}
function verifiedAudienceOperation(body,{brand,key,action,requestId,expectedVersion,payloadMatches,actorMatches,definitionMatches}){
 const op=body?.operation,receipt=op?.receipt,inner=receipt?.body;
 const creating=action==='segmento_criar',saving=action==='segmento_salvar',archiving=action==='segmento_arquivar';
 const invalidMetadata=creating?requestId!==null||expectedVersion!==null:
   typeof requestId!=='string'||!UUID.test(requestId)||requestId!==requestId.toLowerCase()||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>999999999;
 if(!(creating||saving||archiving)||invalidMetadata)
   throw new ProxyError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');
 if(!exact(body,['operation'])||!exact(op,['schema','idempotency_key','brand','action','actor_sha256','payload_sha256','receipt'])||
   op.schema!=='crm-audience-operation-v2'||op.idempotency_key!==key||op.brand!==brand||op.action!==action||
   typeof op.actor_sha256!=='string'||!/^[a-f0-9]{64}$/.test(op.actor_sha256)||!actorMatches(op.actor_sha256)||
   typeof op.payload_sha256!=='string'||!/^[a-f0-9]{64}$/.test(op.payload_sha256)||!payloadMatches(op.payload_sha256)||
   !exact(receipt,['status','body'])||!plain(inner))throw new ProxyError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');
 if(Object.hasOwn(inner,'error')){
  if(audienceRejections[inner.error]!==receipt.status||!exact(inner,['error',...(inner.error==='SEGMENT_VERSION_CONFLICT'?['current_version']:[])])||
    inner.error==='SEGMENT_VERSION_CONFLICT'&&(!Number.isSafeInteger(inner.current_version)||inner.current_version<1||inner.current_version===expectedVersion)||
    creating&&['SEGMENT_NOT_FOUND','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED'].includes(inner.error)||
    archiving&&['SEGMENT_SHAPE','SEGMENT_BRAND_MISMATCH','SEGMENT_LIST_UNAVAILABLE'].includes(inner.error))throw new ProxyError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');
  return {phase:'rejected',status:receipt.status,body:inner,receiptCode:inner.error,segmentId:null,segmentVersion:null};
 }
 const segment=inner.segment;
 if(!exact(inner,['segment','transport_supported'])||inner.transport_supported!==false||!plain(segment)||!UUID.test(segment.id)||segment.brand!==brand||!Number.isSafeInteger(segment.version)||segment.version<1||segment.version>999999999||typeof segment.archived!=='boolean'||
   (creating?(receipt.status!==201||segment.version!==1||segment.archived):
    (receipt.status!==200||segment.id!==requestId||segment.version!==expectedVersion+1||segment.archived!==archiving))||
   !validAudienceDefinition(segment.definition)||segment.definition.brand!==brand||segment.name!==AudienceContract.normalize(segment.definition).name||
   !archiving&&(typeof definitionMatches!=='function'||!definitionMatches(audiencePayloadHash(AudienceContract.normalize(segment.definition)))))throw new ProxyError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');
 return {phase:'succeeded',status:receipt.status,body:inner,receiptCode:null,segmentId:segment.id,segmentVersion:segment.version};
}
const CAMPAIGN_DEFINITION_FIELDS=new Set(['schema_version','brand','channel','initiative','utm_campaign','name','subject','from_email','reply_to','list_ids','template_id','html','text','tags','send_at']);
function validCampaignDefinition(value,brand,{crmCampaignSubmitWrite=false}={}){
  if(!plain(value)||Object.keys(value).some(k=>!CAMPAIGN_DEFINITION_FIELDS.has(k))||
    value.schema_version!=='crm-campaign-v1'||value.brand!==brand||value.channel!=='email'||
    !plain(value.initiative)||Object.keys(value.initiative).some(k=>!['key','name'].includes(k))||
    !Array.isArray(value.list_ids)||value.list_ids.length<1||value.list_ids.length>30||
    !value.list_ids.every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isSafeInteger(value.template_id)||value.template_id<1||
    !Array.isArray(value.tags)||value.tags.length>20||!value.tags.every(s=>typeof s==='string'&&s.length>0&&s.length<=100)||
    value.send_at!==undefined&&value.send_at!==null&&(!crmCampaignSubmitWrite||typeof value.send_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.send_at)||!Number.isSafeInteger(Date.parse(value.send_at))||new Date(value.send_at).toISOString()!==value.send_at))return false;
  for(const [name,max]of Object.entries({utm_campaign:100,name:200,subject:250,from_email:254,reply_to:254,html:220000,text:50000}))
    if(typeof value[name]!=='string'||!value[name].trim()||value[name].length>max)return false;
  return typeof value.initiative.key==='string'&&value.initiative.key.length>0&&value.initiative.key.length<=100&&
    typeof value.initiative.name==='string'&&value.initiative.name.length>0&&value.initiative.name.length<=160;
}
function decide(route,method,query,body,{crmCampaignSubmitWrite=false,crmCampaignDraftService=false}={}){
  const spec=READ[route];if(!spec)throw new ProxyError(403,'ROUTE_DENIED');
  if(method!==spec.method&&!(method==='POST'&&['campaigns','segments'].includes(route)))throw new ProxyError(403,'METHOD_DENIED');
  if(!(query instanceof URLSearchParams)||query.toString().length>2048)throw new ProxyError(413,'QUERY_TOO_LARGE');
  if(method==='GET'&&body!==undefined)throw new ProxyError(400,'GET_BODY_DENIED');
  if(method==='POST'&&(!plain(body)||query.toString()!==''))throw new ProxyError(400,'JSON_OBJECT_REQUIRED');
  const fields=method==='GET'?Object.fromEntries(query):body;
  if(method==='GET'&&[...query.keys()].length!==Object.keys(fields).length)throw new ProxyError(403,'QUERY_DUPLICATE');
  if(method==='GET'&&Object.hasOwn(fields,'k')||Object.hasOwn(fields,'key')&&route!=='templates')throw new ProxyError(403,'CREDENTIAL_DENIED');
  const selector=spec.selector,action=selector?fields[selector]:'';
  if(typeof action!=='string'||!Object.hasOwn(spec.actions,action))throw new ProxyError(403,'ACTION_DENIED');
  const policy=spec.actions[action],required=[...(selector?[selector]:[]),...policy.required];
  if(policy.submitGate&&!crmCampaignSubmitWrite&&!(crmCampaignDraftService===true&&route==='campaigns'&&action==='campanha_validar'))throw new ProxyError(403,'EDIT_NOT_READY');
  if(method!==(policy.method||spec.method))throw new ProxyError(403,'METHOD_DENIED');
  const allowed=new Set([...required,...policy.optional,...(method==='POST'?['k']:[])]);
  if(Object.keys(fields).some(k=>!allowed.has(k))||required.some(k=>!Object.hasOwn(fields,k)))throw new ProxyError(403,'FIELD_DENIED');
  if(route==='templates'&&action==='historico'&&(Object.hasOwn(fields,'key')===Object.hasOwn(fields,'draft_id')))throw new ProxyError(403,'FIELD_DENIED');
  if(route==='segments'&&method==='POST'&&Object.hasOwn(fields,'k'))throw new ProxyError(403,'CREDENTIAL_DENIED');
  if(method==='POST'&&Object.hasOwn(fields,'k')&&!/^ui-[a-f0-9]{32,64}$/.test(fields.k))throw new ProxyError(403,'CREDENTIAL_DENIED');
  for(const [name,value]of Object.entries(fields)){
    if(name===selector||name==='k'||route==='campaigns'&&action==='campanha_salvar'&&['definition','id','expected_version'].includes(name)||route==='segments'&&method==='POST'&&['definition','expected_version'].includes(name))continue;
    if(typeof value==='string'&&value.length>256||!validField(route,name,value))throw new ProxyError(403,'FIELD_DENIED');
  }
  if(route==='campaigns'&&action==='campanha_salvar'){
    if(!validCampaignDefinition(fields.definition,fields.brand,{crmCampaignSubmitWrite})||
      Object.hasOwn(fields,'id')!==Object.hasOwn(fields,'expected_version')||
      Object.hasOwn(fields,'id')&&(!Number.isSafeInteger(fields.id)||fields.id<1||!/^[a-f0-9]{32}$/i.test(fields.expected_version)))
      throw new ProxyError(403,'FIELD_DENIED');
  }
  if(route==='campaigns'&&policy.submitGate&&(!Number.isSafeInteger(fields.id)||fields.id<1||action!=='campanha_validar'&&fields.confirm!==action.replace('campanha_','')))throw new ProxyError(403,'FIELD_DENIED');
  if(route==='segments'&&method==='POST'){
    if(action==='segmento_contar'&&(Object.hasOwn(fields,'id')!==Object.hasOwn(fields,'expected_version')||Object.hasOwn(fields,'id')===Object.hasOwn(fields,'definition')))throw new ProxyError(403,'FIELD_DENIED');
    if(Object.hasOwn(fields,'expected_version')&&(!Number.isSafeInteger(fields.expected_version)||fields.expected_version<1||fields.expected_version>999999999)||
      Object.hasOwn(fields,'definition')&&(!plain(fields.definition)||fields.definition.brand!==fields.brand||!validAudienceDefinition(fields.definition))||
      Buffer.byteLength(JSON.stringify(fields),'utf8')>MAX_AUDIENCE_REQUEST)throw new ProxyError(403,'FIELD_DENIED');
  }
  if(route==='crm-read'&&fields.painel!=='growth')throw new ProxyError(403,'AREA_DENIED');
  if(method==='POST'&&Buffer.byteLength(JSON.stringify(body),'utf8')>(route==='campaigns'&&action==='campanha_salvar'?MAX_CAMPAIGN_REQUEST:route==='segments'?MAX_AUDIENCE_REQUEST:MAX_REQUEST))throw new ProxyError(413,'BODY_TOO_LARGE');
  const area=spec.area==='panel'?fields.painel:spec.area;
  const credentialSlot=spec.area==='panel'?{growth:'growth-read',organico:'organico-read',influs:'influs-read'}[area]:policy.slot||spec.slot;
  return {route,area,method,action,edit:policy.edit===true,credentialSlot};
}
function validateUpstreams(config,allowedHosts,dynamicManifest=null,profile='production',{crmCampaignSubmitWrite=false,crmAudienceDraft=false,crmMasterAudienceRead=false,crmCorporateWriter,dashboardIndividualRead=false,dashboardAffiliateRead=false,simpleReadMode=false}={}){
  if(typeof simpleReadMode!=='boolean'||simpleReadMode&&profile!=='production')throw Error('Simple READ route profile invalid');
  if(typeof dashboardIndividualRead!=='boolean')throw Error('Individual READ route profile invalid');
  if(typeof dashboardAffiliateRead!=='boolean'||dashboardAffiliateRead&&profile!=='production')throw Error('Affiliate READ route profile invalid');
  const corporate=crmCorporateWriter!==undefined&&require('./crm-manager-runtime.cjs').isCampaignWriterDescriptor(crmCorporateWriter);
  if(crmCorporateWriter!==undefined&&!corporate)throw Error('Corporate writer profile invalid');
  if(require('./crm-manager-runtime.cjs').isOwnMasterWriterDescriptor(crmCorporateWriter)&&(profile!=='production'||crmAudienceDraft))throw Error('Own Master campaign profile invalid');
  if(!plain(config)||!Array.isArray(allowedHosts)||allowedHosts.some(h=>typeof h!=='string'))throw Error('Invalid upstream configuration');
  if(!['production','crm-sandbox'].includes(profile))throw Error('Invalid upstream profile');
  if(profile==='crm-sandbox'){
    if(dynamicManifest!==null||allowedHosts.length!==1||allowedHosts[0]!==SANDBOX_HOST||Object.keys(config).sort().join(',')!==(crmCampaignSubmitWrite?'cache,campaigns,cx,segments':'cache,cx,segments'))throw Error('Invalid sandbox upstream configuration');
    const out=Object.create(null);
    for(const [route,raw]of Object.entries(config)){
      const value=raw instanceof URL?raw.href:raw;
      if(value!==(route==='campaigns'&&crmCampaignSubmitWrite?SANDBOX_CAMPAIGN_DESTINATION:SANDBOX_DESTINATIONS[route]))throw Error('Unapproved sandbox destination');
      out[route]=new URL(value);
    }
    return Object.freeze(out);
  }
  if(crmMasterAudienceRead&&(!require('./crm-manager-runtime.cjs').isOwnMasterWriterDescriptor(crmCorporateWriter)||profile!=='production'||crmAudienceDraft))throw Error('Original Master audience read profile invalid');
  if(crmCampaignSubmitWrite&&!corporate)throw Error('Campaign submission requires reviewed profile');
  if(corporate&&(!crmCampaignSubmitWrite||!Object.hasOwn(config,'crm-read')||!Object.hasOwn(config,'campaigns')||Object.keys(config).some(k=>!['crm-read','campaigns','campaigns_media','cx','influ',...(dashboardIndividualRead||simpleReadMode?['cache']:[]),...(dashboardAffiliateRead?['tts']:[]),...(crmAudienceDraft||crmMasterAudienceRead?['segments']:[])].includes(k))))throw Error('Corporate writer routes invalid');
  const out=Object.create(null),hosts=new Set(allowedHosts),dynamic=Object.keys(config).filter(route=>!Object.hasOwn(FIXED_DESTINATIONS,route));
  if(dynamic.length){
    if(!plain(dynamicManifest)||Object.keys(dynamicManifest).sort().join(',')!=='routes,schema,sourceRevision'||dynamicManifest.schema!==DYNAMIC_MANIFEST_SCHEMA||dynamicManifest.sourceRevision!==REVIEWED_DYNAMIC.sourceRevision||!plain(dynamicManifest.routes)||Object.keys(dynamicManifest.routes).sort().join(',')!==dynamic.sort().join(','))throw Error('Unreviewed dynamic upstream manifest');
  }else if(dynamicManifest!==null)throw Error('Unexpected dynamic upstream manifest');
  for(const [route,raw]of Object.entries(config)){
    if(!Object.hasOwn(READ,route))throw Error('Unknown upstream route');
    const expected=Object.hasOwn(FIXED_DESTINATIONS,route)?FIXED_DESTINATIONS[route]:REVIEWED_DYNAMIC.routes[route];
    const value=raw instanceof URL?raw.href:raw;
    if(typeof value!=='string'||typeof expected!=='string'||value!==expected||!Object.hasOwn(FIXED_DESTINATIONS,route)&&dynamicManifest.routes[route]!==expected)throw Error('Unapproved upstream destination');
    let url;try{url=new URL(value);}catch{throw Error('Invalid upstream URL');}
    if(url.href!==value||url.protocol!=='https:'||!hosts.has(url.hostname)||url.username||url.password||url.search||url.hash||url.port||url.pathname==='/'||url.pathname.includes('..'))throw Error('Unapproved upstream destination');
    out[route]=url;
  }
  return Object.freeze(out);
}
async function readJson(req,max=MAX_REQUEST){
  let bytes=0;const chunks=[];
  for await(const chunk of req){bytes+=chunk.length;if(bytes>max)throw new ProxyError(413,'BODY_TOO_LARGE');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ProxyError(400,'INVALID_JSON');}
}
async function readResponse(res,max=MAX_RESPONSE){
  let reader;try{reader=res.body?.getReader();}catch{throw new ProxyError(502,'UPSTREAM_UNAVAILABLE');}
  if(!reader)throw new ProxyError(502,'UPSTREAM_BODY_UNAVAILABLE');
  let bytes=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max)throw new ProxyError(502,'UPSTREAM_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}}
  catch(error){try{await reader.cancel();}catch{}throw error instanceof ProxyError?error:new ProxyError(502,'UPSTREAM_UNAVAILABLE');}
  finally{try{reader.releaseLock();}catch{}}
  return Buffer.concat(chunks);
}
// The legacy payload announces writer features independently of this gateway.
// Browser capabilities must describe the BFF contract, never the upstream's
// broader permissions or a feature that happens to be enabled there.
const BLOCKED_CAPABILITY_FLAGS=new Set([
  'write','save','draft','validate','submit','submit_email','set_mode','activate',
  'schedule','cancel','recover','operation','bind','release','inspect','count',
  'send','prepare','publish','publish_paused','create','update','edit','delete',
  'archive','approve','reject','upload','drafts','mutate','set_tester','send_test'
]);
const BLOCKED_CAPABILITY_POLICIES=new Set(['graph_drafts','graph_lifecycle','email_test_recipient','audience_review','recovery_policy','write_key_required']);
const CAPABILITY_ACTION_LISTS=new Set(['actions','operations','caps','allowed_actions','allowedActions','permissions']);
const SAFE_READ_ACTIONS=new Set([
  'read','view','get','list','catalog','status','identity','print','read_content','list_history',
  ...Object.values(READ).flatMap(spec=>Object.entries(spec.actions)
    .filter(([,policy])=>policy.edit!==true).map(([action])=>action))
]);
function scrubActionList(value,depth){
  if(!Array.isArray(value)||depth>12)return [];
  return value.filter(item=>{
    const action=typeof item==='string'?item:plain(item)?item.action||item.name||item.method||item.id:null;
    return typeof action==='string'&&SAFE_READ_ACTIONS.has(action);
  }).map(item=>plain(item)?scrubCapabilityFlags(item,depth+1):item);
}
function scrubCapabilityFlags(value,depth=0){
  if(depth>12)return Array.isArray(value)?[]:{};
  if(Array.isArray(value))return value.map(item=>plain(item)||Array.isArray(item)?scrubCapabilityFlags(item,depth+1):item);
  if(!plain(value))return value;
  const safe={};
  for(const [key,item]of Object.entries(value)){
    if(BLOCKED_CAPABILITY_POLICIES.has(key))continue;
    safe[key]=CAPABILITY_ACTION_LISTS.has(key)&&Array.isArray(item)?scrubActionList(item,depth+1):
      BLOCKED_CAPABILITY_FLAGS.has(key)&&typeof item==='boolean'?false:
      plain(item)||Array.isArray(item)?scrubCapabilityFlags(item,depth+1):item;
  }
  return safe;
}
function rewriteCapabilities(value,upstreams,origin,{sandboxAudienceDraft=false,corporateAudienceDraft=false,managedAudienceRead=false,managedTemplateRead=false,ownMasterAudienceRead=false,ownMasterAudienceWrite=false,ownMasterAudienceCount=false,ownMasterAudienceContextReview=false,route=null}={}){
  if(!plain(value))return value;
  const clone={...value};
  if(Object.hasOwn(clone,'pode_escrever'))clone.pode_escrever=false;
  if(Array.isArray(value.capabilities)&&!(route==='crm-read'&&(managedTemplateRead===true||managedAudienceRead===true||ownMasterAudienceRead===true))){clone.capabilities=scrubActionList(value.capabilities,0);return clone;}
  if(!plain(value.capabilities)&&!(route==='crm-read'&&(managedTemplateRead===true||managedAudienceRead===true||ownMasterAudienceRead===true)))return clone;
  const caps=plain(value.capabilities)?scrubCapabilityFlags(value.capabilities):{};
  // Only an admitted BFF listener may declare the new template read contract.
  // A legacy cache must not assert its readiness.
  if(plain(caps.templates))delete caps.templates.read_contract;
  if(plain(value.capabilities?.endpoints)){
    const urls=Object.fromEntries(Object.entries(upstreams)
      .filter(([route])=>Object.values(READ[route]?.actions||{}).some(action=>action.edit!==true))
      .map(([route,url])=>[url.href,route]));
    caps.endpoints={};
    for(const [name,url]of Object.entries(value.capabilities.endpoints)){
      const route=typeof url==='string'?urls[url]:null;
      if(route&&(name===route||name==='read'&&route==='crm-read'))caps.endpoints[name]=origin+'/api/'+route;
    }
  }else delete caps.endpoints;
  for(const name of ['templates','campaigns','segments','campaign_audience','ab_experiment']){
    if(!plain(caps[name]))continue;
    if(!caps.endpoints?.[name]){
      for(const flag of ['read','read_content','list_history'])if(Object.hasOwn(caps[name],flag))caps[name][flag]=false;
    }
  }
  if(plain(caps.ab_experiment))caps.ab_experiment.enabled=false;
  if(sandboxAudienceDraft===true&&route==='segments'&&upstreams.segments?.href===SANDBOX_DESTINATIONS.segments&&plain(value.catalog)&&['fish','aristo'].includes(value.catalog.brand)&&value.catalog.current===true&&value.capabilities.count===false&&value.capabilities.send===false){
    // A catalogue is fetched with the person's read-only key. Its browser
    // draft grant comes from the separately attested writer/session, not from
    // widening that read-only backend key.
    caps.draft=true;
  }
  if(sandboxAudienceDraft===true&&value.synthetic===true&&caps.endpoints?.segments===origin+'/api/segments'&&upstreams.segments?.href===SANDBOX_DESTINATIONS.segments&&plain(caps.segments)&&caps.segments.read===true&&caps.segments.contract_version===AudienceContract.VERSION){
    // Restore only the reviewed audience CRUD/receipt contract. Counts,
    // campaign bindings, workers and delivery stay unavailable.
    caps.segments.save=true;caps.segments.operation=true;
  }
  if(managedAudienceRead===true&&route==='crm-read'){
    caps.endpoints={...(caps.endpoints||{}),segments:origin+'/api/segments',campaign_audience:origin+'/api/campaign_audience'};
    caps.segments={...(plain(caps.segments)?caps.segments:{}),read:true,save:false,count:false,operation:false};
    caps.campaign_audience={...(plain(caps.campaign_audience)?caps.campaign_audience:{}),read:true,inspect:false,operation:false,validate:false,bind:false,release:false};
  }
  if(corporateAudienceDraft===true&&upstreams.segments?.href===REVIEWED_DYNAMIC.routes.segments){
    if(route==='segments'&&plain(value.catalog)&&['fish','aristo'].includes(value.catalog.brand)&&value.catalog.current===true&&value.capabilities?.count===false&&value.capabilities?.send===false)caps.draft=true;
    if(route==='crm-read'){
      caps.endpoints={...(caps.endpoints||{}),segments:origin+'/api/segments'};
      caps.segments={read:true,save:true,operation:true,count:false,send:false,contract_version:AudienceContract.VERSION,...(ownMasterAudienceContextReview===true?{context_review:true,context_review_contract:'crm-audience-context-review-v2'}:{})};
    }
  }
  if(ownMasterAudienceRead===true&&route==='crm-read'&&upstreams.segments?.href===REVIEWED_DYNAMIC.routes.segments){
    caps.endpoints={...(caps.endpoints||{}),segments:origin+'/api/segments'};
    caps.segments={read:true,save:ownMasterAudienceWrite===true,operation:ownMasterAudienceWrite===true,count:ownMasterAudienceCount===true,send:false,brands:['fish','aristo'],contract_version:AudienceContract.VERSION,...(ownMasterAudienceContextReview===true?{context_review:true,context_review_contract:'crm-audience-context-review-v2'}:{})};
  }
  if(managedTemplateRead===true&&route==='crm-read'){
    caps.endpoints={...(caps.endpoints||{}),templates:origin+'/api/templates'};
    caps.templates={read_content:true,list_history:true,read_contract:'crm-template-read-v1',draft:false,validate:false,submit:false,submit_email:false};
  }
  clone.capabilities=caps;
  return clone;
}
async function forward({route,method,query,body,user,credential,upstreams,origin,crmDraftWrite=false,crmCampaignSubmitWrite=false,crmAudienceDraft=false,sandboxAudienceDraft=false,corporateAudienceDraft=false,ownMasterAudienceRead=false,ownMasterAudienceWrite=false,ownMasterAudienceCount=false,ownMasterAudienceContextReview=false,crmCorporateWriter,simpleAffiliateEdit=false,simpleAudienceRead=false,simpleAudienceCount=false,simpleCampaignDraft=false,simpleAudienceDraft=false,captureReadDiagnostic=false,fetchImpl=fetch}){
  if(require('./crm-manager-runtime.cjs').isOwnMasterWriterDescriptor(crmCorporateWriter)&&route==='campaigns'&&user?.role!=='superadmin')throw new ProxyError(403,'EDIT_NOT_READY');
  const d=decide(route,method,query,body,{crmCampaignSubmitWrite,crmCampaignDraftService:simpleCampaignDraft}),target=upstreams[route];
  const serviceProfile=require('./crm-manager-runtime.cjs').isServiceDraftDescriptor(crmCorporateWriter);
  const servicePerson=user?.permissions?.growth?.read===true&&(user.role==='superadmin'||user.simpleRead===true&&user.productFronts?.includes('growth'));
  const serviceWrite=servicePerson&&(user.role==='superadmin'||user.permissions.growth.edit===true&&user.productWriteFronts?.includes('growth'));
  const campaignDraftService=simpleCampaignDraft===true&&serviceProfile&&route==='campaigns'&&target?.href===REVIEWED_DYNAMIC.routes.campaigns&&servicePerson&&(method==='GET'?['campanha_catalogo','campanha_listar','campanha_obter'].includes(d.action)||d.action==='campanha_operacao'&&serviceWrite:serviceWrite&&['campanha_salvar','campanha_validar'].includes(d.action)&&(!body.definition||body.definition.send_at===null));
  const audienceDraftService=simpleAudienceDraft===true&&serviceProfile&&route==='segments'&&target?.href===REVIEWED_DYNAMIC.routes.segments&&serviceWrite&&(method==='GET'?['segmento_contexto_v2','segmento_operacao'].includes(d.action):['segmento_criar','segmento_salvar'].includes(d.action));
  if(simpleCampaignDraft&&!campaignDraftService||simpleAudienceDraft&&!audienceDraftService)throw new ProxyError(403,'CRM_SERVICE_DRAFT_SCOPE_DENIED');
  const campaignSubmit=crmCampaignSubmitWrite===true&&route==='campaigns'&&(target?.href===SANDBOX_CAMPAIGN_DESTINATION||require('./crm-manager-runtime.cjs').isCampaignWriterDescriptor(crmCorporateWriter)&&target?.href===REVIEWED_DYNAMIC.routes.campaigns);
  if(crmCampaignSubmitWrite&&!campaignSubmit)throw new ProxyError(403,'EDIT_NOT_READY');
  const affiliateEdit=simpleAffiliateEdit===true&&route==='influ'&&['piloto_salvar','piloto_operacao'].includes(d.action)&&target?.href===FIXED_DESTINATIONS.influ&&(user?.role==='superadmin'||(d.action==='piloto_operacao'?user?.productFronts?.includes('afiliados'):user?.productWriteFronts?.includes('afiliados')));
  if(simpleAffiliateEdit&&!affiliateEdit)throw new ProxyError(403,'AFFILIATE_WRITE_DENIED');
  const serviceAudienceRead=simpleAudienceRead===true&&route==='segments'&&method==='GET'&&['segmentos_listar','segmento_obter'].includes(d.action)&&target?.href===REVIEWED_DYNAMIC.routes.segments&&user?.permissions?.growth?.read===true;
  const serviceAudienceCount=simpleAudienceCount===true&&route==='segments'&&method==='POST'&&d.action==='segmento_contar'&&target?.href===REVIEWED_DYNAMIC.routes.segments&&user?.permissions?.growth?.read===true;
  if(simpleAudienceRead&&!serviceAudienceRead||simpleAudienceCount&&!serviceAudienceCount)throw new ProxyError(403,'AUDIENCE_READ_SCOPE_DENIED');
  if(d.edit&&!affiliateEdit&&!serviceAudienceCount&&!campaignDraftService&&!audienceDraftService&&!(ownMasterAudienceCount===true&&route==='segments'&&d.action==='segmento_contar')&&!campaignSubmit&&!(crmDraftWrite===true&&route==='campaigns'&&['campanha_salvar','campanha_operacao'].includes(d.action))&&!(crmAudienceDraft===true&&route==='segments'&&['segmento_criar','segmento_salvar','segmento_arquivar','segmento_operacao','segmento_contexto_v2'].includes(d.action)))throw new ProxyError(403,'EDIT_NOT_READY');
  if(ownMasterAudienceRead&&(!require('./crm-manager-runtime.cjs').isOwnMasterWriterDescriptor(crmCorporateWriter)||user?.role!=='superadmin'||route!=='segments'||method!=='GET'||d.edit||!['segmentos_listar','segmento_obter'].includes(d.action)||target?.href!==REVIEWED_DYNAMIC.routes.segments))throw new ProxyError(403,'MASTER_AUDIENCE_READ_DENIED');
  if(ownMasterAudienceWrite&&(!require('./crm-manager-runtime.cjs').isOwnMasterWriterDescriptor(crmCorporateWriter)||user?.role!=='superadmin'||route!=='segments'||target?.href!==REVIEWED_DYNAMIC.routes.segments||!['segmento_criar','segmento_salvar','segmento_arquivar','segmento_operacao','segmento_contexto_v2'].includes(d.action)||crmAudienceDraft!==true))throw new ProxyError(403,'MASTER_AUDIENCE_WRITE_DENIED');
  if(ownMasterAudienceCount&&(!require('./crm-manager-runtime.cjs').isOwnMasterWriterDescriptor(crmCorporateWriter)||user?.role!=='superadmin'||route!=='segments'||method!=='POST'||d.action!=='segmento_contar'||target?.href!==REVIEWED_DYNAMIC.routes.segments))throw new ProxyError(403,'MASTER_AUDIENCE_COUNT_DENIED');
  if(ownMasterAudienceContextReview&&(!require('./crm-manager-runtime.cjs').isOwnMasterWriterDescriptor(crmCorporateWriter)||user?.role!=='superadmin'||route!=='segments'||method!=='GET'||d.action!=='segmento_contexto_revisao'||target?.href!==REVIEWED_DYNAMIC.routes.segments))throw new ProxyError(403,'MASTER_AUDIENCE_CONTEXT_READ_DENIED');
  if(!target)throw new ProxyError(503,'UPSTREAM_NOT_CONFIGURED');
  if(!user||!(user.role==='superadmin'||user.areas?.includes(d.area)))throw new ProxyError(403,'AREA_DENIED');
  if(typeof credential!=='string'||!/^[A-Za-z0-9_.:-]{8,256}$/.test(credential))throw new ProxyError(503,'INDIVIDUAL_CREDENTIAL_MISSING');
  const url=new URL(target.href);url.search=query.toString();
  if(route==='segments'&&d.action==='segmento_operacao')url.searchParams.set('acao','segmento_operacao_v2');
  // Origin and browser cookies are never forwarded. The gateway already checked
  // session, exact browser Origin and CSRF before selecting the person/slot.
  const spec=READ[route],policy=spec.actions[d.action],keyInBody=policy.bodyKey||spec.bodyKey;
  // Saved-audience A/B speaks Bearer; the fixed legacy A/B webhook speaks the
  // dedicated header. The configured destination remains an exact allowlist URL.
  const abLegacy=route==='ab_experiment'&&target.hostname!=='comunicacao-crm-audience.tazdb8.easypanel.host';
  const header=keyInBody?null:abLegacy?'X-AB-Write-Key':policy.header||spec.header||'Authorization';
  // The campaign backend may reconcile a draft for up to 85 seconds. A longer
  // gateway deadline lets that result arrive; an uncertain outcome is resolved
  // through the same idempotency key, never by minting a new request.
  const options={method,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(route==='campaigns'&&d.action==='campanha_salvar'?93000:method==='GET'?25000:45000),headers:{Accept:'application/json'}};
  if(header)options.headers[header]=header==='Authorization'?'Bearer '+credential:credential;
  if(header==='X-Template-Key')options.headers.Authorization='Bearer '+credential;
  if(method==='POST'){
    const payload={...body};delete payload.k;
    if(keyInBody)payload.k=credential;
    options.headers['Content-Type']='application/json';options.body=JSON.stringify(payload);
  }
  const capture=captureReadDiagnostic===true&&route==='crm-read'&&method==='GET'&&d.action==='cache_growth';
  const diagnostic=(stage,status,error)=>({stage,httpStatus:Number.isInteger(status)?status:null,...(typeof error?.name==='string'&&/^[A-Za-z]{1,40}$/.test(error.name)?{errorType:error.name}:{}),...(typeof error?.cause?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.cause.code)?{transportCode:error.cause.code}:{})});
  const refused=(code,meta)=>{const e=new ProxyError(502,code);if(capture)e.sourceDiagnostic=meta;return e;};
  let result;try{result=await fetchImpl(url,options);}catch(e){const meta=diagnostic('transport',null,e),error=refused('UPSTREAM_UNAVAILABLE',meta);if(method==='GET'&&meta.transportCode==='EAI_AGAIN')error.readDnsTemporary=true;throw error;}
  // A remote credential rejection must not invalidate the browser's local session.
  if(result.status===401){try{await result.body?.cancel();}catch{}return {status:503,body:{error:'UPSTREAM_CREDENTIAL_REJECTED'},...(capture?{sourceDiagnostic:diagnostic('credential',401)}:{})};}
  if(result.status>=300&&result.status<400){try{await result.body?.cancel();}catch{}throw refused('UPSTREAM_REDIRECT_DENIED',diagnostic('redirect',result.status));}
  if(!/^application\/json(?:;|$)/i.test(result.headers.get('content-type')||'')){try{await result.body?.cancel();}catch{}throw refused('UPSTREAM_CONTENT_TYPE_DENIED',diagnostic('content-type',result.status));}
  let bytes;try{bytes=await readResponse(result,route==='crm-read'&&d.action==='cache_growth'?MAX_CRM_CACHE_RESPONSE:route==='candidaturas'&&d.action==='print'?MAX_PRINT_RESPONSE:route==='campaigns_media'?MAX_MEDIA_RESPONSE:MAX_RESPONSE);}catch(e){if(capture)e.sourceDiagnostic=diagnostic('response-body',result.status,e);throw e;}
  let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch(e){throw refused('UPSTREAM_INVALID_JSON',diagnostic('json',result.status,e));}
  if(route==='campaigns'&&d.action==='campanha_salvar'&&result.status>=200&&result.status<300&&
    (!plain(parsed?.campaign)||parsed.campaign.status!=='draft'||parsed.campaign.sent!==0||parsed.campaign.started_at||(campaignSubmit?parsed.campaign.send_at!==(body.definition.send_at??null):parsed.campaign.send_at!==null)||parsed.campaign.definition?.brand!==body.brand))
    throw new ProxyError(502,'UPSTREAM_DRAFT_UNCONFIRMED');
  if(route==='campaigns'&&d.action==='campanha_operacao'&&result.status===200&&!campaignSubmit&&
    (!plain(parsed?.operation)||!(campaignDraftService?['salvar','validar']:['salvar']).includes(parsed.operation.action)||parsed.operation.brand!==query.get('brand')))
    throw new ProxyError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');
  // Exact legacy responses distinguish SQL cache refusal from the Node catch.
  // Raw provider messages never enter diagnostic logs.
  const legacyCode=parsed?.erro==='cache indisponível'?'CRM_CACHE_UNAVAILABLE':parsed?.erro==='consulta indisponível'?'CRM_READER_UNCLASSIFIED':null;
  const headerCode=result.headers.get('x-shrigma-error-code'),requestId=result.headers.get('x-shrigma-request-id'),sqlState=parsed?.sqlstate||result.headers.get('x-shrigma-sqlstate');
  const safeCodes=new Set(['CACHE_READ_REFUSED','SERVICE_DISABLED','SERVICE_STOPPING','ADMISSION_FULL','QUERY_DEADLINE','SQL_FAILED','DRIVER_FAILED','RESULT_SHAPE_INVALID','RESPONSE_FAILED','HANDLER_FAILED','CACHE_UNAVAILABLE','SQL_503_UNCLASSIFIED']);
  const sourceCode=safeCodes.has(parsed?.error)?parsed.error:safeCodes.has(headerCode)?headerCode:legacyCode;
  const sourceDiagnostic=capture&&result.status!==200?{...diagnostic('source-response',result.status),...(sourceCode?{sourceCode}:{}),...(typeof sqlState==='string'&&/^[A-Z0-9]{5}$/.test(sqlState)?{sqlState}:{}),...(/^[a-f0-9-]{36}$/.test(requestId||'')?{requestId}:{})}:undefined;
  return {status:result.status,body:ownMasterAudienceRead||ownMasterAudienceWrite||ownMasterAudienceCount||ownMasterAudienceContextReview||serviceAudienceRead||serviceAudienceCount||campaignDraftService||audienceDraftService?parsed:rewriteCapabilities(parsed,upstreams,origin,{sandboxAudienceDraft,corporateAudienceDraft,route}),...(sourceDiagnostic?{sourceDiagnostic}:{})};
}
module.exports={READ,FIXED_DESTINATIONS,SANDBOX_HOST,SANDBOX_DESTINATIONS,SANDBOX_CAMPAIGN_DESTINATION,DYNAMIC_MANIFEST_SCHEMA,REVIEWED_DYNAMIC,ProxyError,MAX_REQUEST,MAX_CAMPAIGN_REQUEST,MAX_AUDIENCE_REQUEST,MAX_RESPONSE,MAX_CRM_CACHE_RESPONSE,MAX_PRINT_RESPONSE,MAX_MEDIA_RESPONSE,decide,validateUpstreams,readJson,rewriteCapabilities,forward,audiencePayloadHash,verifiedAudienceScope,verifiedAudienceOperation};
