'use strict';
// Browser-to-upstream contract. Each action has its own exact method, selector,
// fields and credential slot. A receipt lookup is a read, but must use the
// writer's principal; edit:true makes the session grant mandatory as well.
const rule=(required=[],optional=[],options={})=>Object.freeze({required,optional,...options});
const READ=Object.freeze({
  cx:{area:'panel',slot:'growth-read',method:'GET',actions:{'':rule(['painel'],['access'])}},
  cache:{area:'panel',slot:'growth-read',method:'GET',actions:{'':rule(['painel'])}},
  'crm-read':{area:'growth',slot:'growth-read',method:'GET',selector:'action',actions:{identity:rule(['painel']),cache_growth:rule(['painel'])}},
  campaigns:{area:'growth',slot:'growth-campaign-read',method:'GET',selector:'acao',actions:{
    campanha_catalogo:rule(['brand']),campanha_listar:rule(['brand']),campanha_obter:rule(['brand','id']),
    campanha_operacao:rule(['brand','idempotency_key'],[],{slot:'growth-campaign',edit:true})}},
  segments:{area:'growth',slot:'growth-audience-read',method:'GET',selector:'acao',actions:{
    segmentos_listar:rule(['brand','offset','limit']),segmento_obter:rule(['brand','id']),
    segmento_operacao:rule(['brand','idempotency_key'],[],{slot:'growth-audience',edit:true})}},
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
const MAX_REQUEST=128*1024,MAX_RESPONSE=4*1024*1024,MAX_PRINT_RESPONSE=5*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
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
    case 'after':return value===''||UUID.test(value);
    case 'id':return route==='candidaturas'?UUID.test(value):route==='segments'?UUID.test(value):positive(value);
    case 'campaign_id':return positive(value);
    case 'journey_id':case 'request_id':case 'test_id':case 'operation_id':return UUID.test(value);
    case 'application_id':return /^[1-9]\d{0,79}$/.test(value);
    case 'teste_id':return typeof value==='string'&&value.length>=1&&value.length<=256&&value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value);
    case 'idempotency_key':return route==='campaigns'?/^[A-Za-z0-9_-]{16,100}$/.test(value):KEY.test(value);
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
function decide(route,method,query,body){
  const spec=READ[route];if(!spec)throw new ProxyError(403,'ROUTE_DENIED');
  if(method!==spec.method)throw new ProxyError(403,'METHOD_DENIED');
  if(!(query instanceof URLSearchParams)||query.toString().length>2048)throw new ProxyError(413,'QUERY_TOO_LARGE');
  if(method==='GET'&&body!==undefined)throw new ProxyError(400,'GET_BODY_DENIED');
  if(method==='POST'&&(!plain(body)||query.toString()!==''))throw new ProxyError(400,'JSON_OBJECT_REQUIRED');
  const fields=method==='GET'?Object.fromEntries(query):body;
  if(method==='GET'&&[...query.keys()].length!==Object.keys(fields).length)throw new ProxyError(403,'QUERY_DUPLICATE');
  if(method==='GET'&&Object.hasOwn(fields,'k')||Object.hasOwn(fields,'key')&&route!=='templates')throw new ProxyError(403,'CREDENTIAL_DENIED');
  const selector=spec.selector,action=selector?fields[selector]:'';
  if(typeof action!=='string'||!Object.hasOwn(spec.actions,action))throw new ProxyError(403,'ACTION_DENIED');
  const policy=spec.actions[action],required=[...(selector?[selector]:[]),...policy.required];
  const allowed=new Set([...required,...policy.optional,...(method==='POST'?['k']:[])]);
  if(Object.keys(fields).some(k=>!allowed.has(k))||required.some(k=>!Object.hasOwn(fields,k)))throw new ProxyError(403,'FIELD_DENIED');
  if(route==='templates'&&action==='historico'&&(Object.hasOwn(fields,'key')===Object.hasOwn(fields,'draft_id')))throw new ProxyError(403,'FIELD_DENIED');
  if(method==='POST'&&Object.hasOwn(fields,'k')&&!/^ui-[a-f0-9]{32,64}$/.test(fields.k))throw new ProxyError(403,'CREDENTIAL_DENIED');
  for(const [name,value]of Object.entries(fields)){
    if(name===selector||name==='k')continue;
    if(typeof value==='string'&&value.length>256||!validField(route,name,value))throw new ProxyError(403,'FIELD_DENIED');
  }
  if(route==='crm-read'&&fields.painel!=='growth')throw new ProxyError(403,'AREA_DENIED');
  if(method==='POST'&&JSON.stringify(body).length>MAX_REQUEST)throw new ProxyError(413,'BODY_TOO_LARGE');
  const area=spec.area==='panel'?fields.painel:spec.area;
  const credentialSlot=spec.area==='panel'?{growth:'growth-read',organico:'organico-read',influs:'influs-read'}[area]:policy.slot||spec.slot;
  return {route,area,method,action,edit:policy.edit===true,credentialSlot};
}
function validateUpstreams(config,allowedHosts){
  const out=Object.create(null),hosts=new Set(allowedHosts);
  for(const [route,raw]of Object.entries(config||{})){
    if(!Object.hasOwn(READ,route))throw new Error('Unknown upstream route');
    let url;try{url=new URL(raw);}catch{throw new Error('Invalid upstream URL');}
    if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.username||url.password||url.search||url.hash||url.port||url.pathname==='/'||url.pathname.includes('..'))throw new Error('Unapproved upstream destination');
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
  const reader=res.body?.getReader();if(!reader){const bytes=Buffer.from(await res.arrayBuffer());if(bytes.length>max)throw new ProxyError(502,'UPSTREAM_RESPONSE_TOO_LARGE');return bytes;}
  let bytes=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max)throw new ProxyError(502,'UPSTREAM_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
function rewriteCapabilities(value,upstreams,origin){
  if(!plain(value)||!plain(value.capabilities)||!plain(value.capabilities.endpoints))return value;
  const urls=Object.fromEntries(Object.entries(upstreams).map(([name,url])=>[url.href,origin+'/api/'+name]));
  const clone={...value,capabilities:{...value.capabilities,endpoints:{...value.capabilities.endpoints}}};
  for(const [name,url]of Object.entries(clone.capabilities.endpoints)){
    if(typeof url==='string'&&urls[url])clone.capabilities.endpoints[name]=urls[url];
    else delete clone.capabilities.endpoints[name];
  }
  return clone;
}
async function forward({route,method,query,body,user,credential,upstreams,origin,fetchImpl=fetch}){
  const d=decide(route,method,query,body),target=upstreams[route];
  if(!target)throw new ProxyError(503,'UPSTREAM_NOT_CONFIGURED');
  if(!user||!(user.role==='superadmin'||user.areas?.includes(d.area)))throw new ProxyError(403,'AREA_DENIED');
  if(typeof credential!=='string'||!/^[A-Za-z0-9_.:-]{8,256}$/.test(credential))throw new ProxyError(503,'INDIVIDUAL_CREDENTIAL_MISSING');
  const url=new URL(target.href);url.search=query.toString();
  // Origin and browser cookies are never forwarded. The gateway already checked
  // session, exact browser Origin and CSRF before selecting the person/slot.
  const spec=READ[route],policy=spec.actions[d.action],keyInBody=policy.bodyKey||spec.bodyKey;
  // Saved-audience A/B speaks Bearer; the fixed legacy A/B webhook speaks the
  // dedicated header. The configured destination remains an exact allowlist URL.
  const abLegacy=route==='ab_experiment'&&target.hostname!=='comunicacao-crm-audience.tazdb8.easypanel.host';
  const header=keyInBody?null:abLegacy?'X-AB-Write-Key':policy.header||spec.header||'Authorization';
  const options={method,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(method==='GET'?25000:45000),headers:{Accept:'application/json'}};
  if(header)options.headers[header]=header==='Authorization'?'Bearer '+credential:credential;
  if(header==='X-Template-Key')options.headers.Authorization='Bearer '+credential;
  if(method==='POST'){
    const payload={...body};delete payload.k;
    if(keyInBody)payload.k=credential;
    options.headers['Content-Type']='application/json';options.body=JSON.stringify(payload);
  }
  let result;try{result=await fetchImpl(url,options);}catch{throw new ProxyError(502,'UPSTREAM_UNAVAILABLE');}
  if(result.status>=300&&result.status<400)throw new ProxyError(502,'UPSTREAM_REDIRECT_DENIED');
  if(!/^application\/json(?:;|$)/i.test(result.headers.get('content-type')||''))throw new ProxyError(502,'UPSTREAM_CONTENT_TYPE_DENIED');
  const bytes=await readResponse(result,route==='candidaturas'&&d.action==='print'?MAX_PRINT_RESPONSE:MAX_RESPONSE);
  let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw new ProxyError(502,'UPSTREAM_INVALID_JSON');}
  return {status:result.status,body:rewriteCapabilities(parsed,upstreams,origin)};
}
module.exports={READ,ProxyError,MAX_REQUEST,MAX_RESPONSE,MAX_PRINT_RESPONSE,decide,validateUpstreams,readJson,rewriteCapabilities,forward};
