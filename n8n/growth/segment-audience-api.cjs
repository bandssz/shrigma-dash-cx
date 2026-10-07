'use strict';
// Local HTTP-shaped boundary only: no listener, fetch, n8n workflow or deployment.
const A=require('./segment-audience-contract.js'),S=require('./segment-audience-store.cjs'),H=require('./segment-audience-review.cjs');
const ContextReview=require('./segment-audience-context-review.cjs');
const VERSION=A.VERSION,ENABLED=false,MAX_RESPONSE=2000000;
const same=(a,b)=>H.digest(A.normalize(a))===H.digest(A.normalize(b));
const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const writing=p=>['segmento_criar','segmento_salvar','segmento_arquivar'].includes(p?.acao);
const response=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body});
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const errors=new Set(['SEGMENT_REQUEST_INVALID','SEGMENT_FIELDS','SEGMENT_ID_INVALID','SEGMENT_VERSION_REQUIRED','SEGMENT_OPERATION_ID_REQUIRED','SEGMENT_PAGE_INVALID','SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED','SEGMENT_SESSION_BOUNDARY','SEGMENT_OPERATION_MISMATCH','SEGMENT_OPERATION_UNCONFIRMED','SEGMENT_NOT_FOUND','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED','SEGMENT_UNAVAILABLE','SEGMENT_SHAPE','SEGMENT_BRAND_MISMATCH','SEGMENT_LIST_UNAVAILABLE','SEGMENT_SERVICE_UNAVAILABLE','SEGMENT_CATALOG_CHANGED']);
const durableRejections=Object.freeze({SEGMENT_SHAPE:422,SEGMENT_BRAND_MISMATCH:422,SEGMENT_LIST_UNAVAILABLE:422,SEGMENT_UNAVAILABLE:503,SEGMENT_NOT_FOUND:404,SEGMENT_VERSION_CONFLICT:409,SEGMENT_ARCHIVED:409,SEGMENT_CATALOG_CHANGED:409});
function copy(v,max){const text=H.canonical(v);if(Buffer.byteLength(text)>max)throw fail('SEGMENT_REQUEST_SIZE',413);return JSON.parse(text);}
function parse(value){
 try{
  const v=copy(value,32768);if(!exact(v,['method','request'])||!['GET','POST'].includes(v.method))throw fail('SEGMENT_METHOD_NOT_ALLOWED',405);
  const r=v.request;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['headers','body','query'].includes(k)))throw fail('SEGMENT_FIELDS',400);
  const entries=Object.entries(r.headers||{}),auth=entries.filter(([k])=>k.toLowerCase()==='authorization'),origin=entries.filter(([k])=>k.toLowerCase()==='origin');
  if(origin.length>1||origin.length===1&&origin[0][1]!=='https://bandssz.github.io')throw fail('SEGMENT_ORIGIN_DENIED',403);
  if(auth.length!==1||typeof auth[0][1]!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth[0][1]))throw fail('SEGMENT_UNAUTHORIZED',401);
  if(v.method==='GET'&&r.body&&Object.keys(r.body).length||v.method==='POST'&&r.query&&Object.keys(r.query).length)throw fail('SEGMENT_FIELDS',400);
  const p=copy(v.method==='POST'?r.body:r.query,16000);
  if(p.acao==='segmentos_listar')for(const [key,fallback]of [['limit',50],['offset',0]]){
   if(!Object.hasOwn(p,key))p[key]=fallback;else if(typeof p[key]==='string'&&/^(0|[1-9][0-9]*)$/.test(p[key]))p[key]=Number(p[key]);
  }
  if(p.acao==='segmento_contexto_revisao'&&typeof p.expected_version==='string'&&/^[1-9][0-9]*$/.test(p.expected_version))p.expected_version=Number(p.expected_version);
  const request=S.request(p);if(v.method!==(['segmento_criar','segmento_salvar','segmento_arquivar','segmento_contar'].includes(p.acao)?'POST':'GET'))throw fail('SEGMENT_METHOD_NOT_ALLOWED',405);
  return {route:'execute',key:auth[0][1].slice(7),request,writing:writing(request)};
 }catch(e){return {route:'response',response:response(e.status||400,{error:e.code?.startsWith('SEGMENT_')?e.code:'SEGMENT_REQUEST_INVALID'})};}
}
function segment(s,brand){
 if(!exact(s,['id','brand','name','definition','version','archived','created_at','updated_at','updated_by','semantic_context'])||!exact(s.semantic_context,['currency','timezone','current'])||typeof s.semantic_context.current!=='boolean'||s.semantic_context.currency!==null&&(typeof s.semantic_context.currency!=='string'||!/^[A-Z]{3}$/.test(s.semantic_context.currency))||s.semantic_context.timezone!==null&&(typeof s.semantic_context.timezone!=='string'||s.semantic_context.timezone.length>100)||typeof s.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s.id)||s.brand!==brand||!Number.isSafeInteger(s.version)||s.version<1||s.version>S.MAX_VERSION||typeof s.archived!=='boolean'||typeof s.updated_by!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,194}$/.test(s.updated_by)||!Number.isFinite(Date.parse(s.created_at))||!Number.isFinite(Date.parse(s.updated_at)))return false;
 try{const d=A.normalize(s.definition);return d.brand===brand&&d.name===s.name&&H.digest(d)===H.digest(s.definition);}catch{return false;}
}
function catalog(c,brand){
 if(!exact(c,['brand','current','currency','timezone','shop_id','fields','products','origins','lists','coverage','checked_at','catalog_hash',...(Object.hasOwn(c,'recorded_origins')?['recorded_origins']:[]),...(Object.hasOwn(c,'shopify_snapshot')?['shopify_snapshot']:[])])||typeof c.catalog_hash!=='string'||!/^[a-f0-9]{64}$/.test(c.catalog_hash)||c.brand!==brand||typeof c.current!=='boolean'||c.coverage!=='unconfirmed'||!Number.isFinite(Date.parse(c.checked_at))||!Array.isArray(c.lists)||c.lists.length>1000||new Set(c.lists.map(x=>x?.id)).size!==c.lists.length||c.lists.some(x=>!exact(x,['id','brand','name','available'])||!Number.isSafeInteger(x.id)||x.id<1||x.id>2147483647||x.brand!==brand||typeof x.name!=='string'||x.name.length>500||typeof x.available!=='boolean'))return false;
 if(Object.hasOwn(c,'shopify_snapshot')){
  const v=c.shopify_snapshot;
  if(!v||typeof v.current!=='boolean'||!(exact(v,['current'])&&!v.current||exact(v,['current','started_at','observed_at','expires_at'])
   &&[v.started_at,v.observed_at,v.expires_at].every(x=>typeof x==='string'&&Number.isFinite(Date.parse(x)))
   &&Date.parse(v.started_at)<=Date.parse(v.observed_at)&&Date.parse(v.expires_at)-Date.parse(v.started_at)===93600000))return false;
 }
 try{S.sourceConfig(Object.fromEntries(['currency','timezone','shop_id','fields','products','origins',...(Object.hasOwn(c,'recorded_origins')?['recorded_origins']:[])].map(k=>[k,c[k]])),brand);return true;}catch{return false;}
}
function project(entry,value){
 const r=copy(value,MAX_RESPONSE),p=entry.request,b=r?._body,status=r?._http;if(!exact(r,['_http','_body'])||!b||typeof b!=='object'||Array.isArray(b))throw fail('SEGMENT_READBACK_UNCONFIRMED');
 if(p.acao==='segmento_contexto_revisao'){const checked=status===200?{status,body:ContextReview.validateBody(b,p,{secrets:[entry.key]})}:ContextReview.validateResponse({status,body:b},p,{secrets:[entry.key]});return response(checked.status,checked.body);}
 if(Object.hasOwn(b,'error')){
  if(['segmento_contexto_v2','segmento_operacao_v2'].includes(p.acao)){
   const fixed={SEGMENT_UNAUTHORIZED:401,SEGMENT_ACCESS_DENIED:403,SEGMENT_SESSION_BOUNDARY:503,SEGMENT_SERVICE_UNAVAILABLE:503,...(p.acao==='segmento_operacao_v2'?{SEGMENT_OPERATION_UNCONFIRMED:404,SEGMENT_OPERATION_MISMATCH:409}:{})};
   if(!exact(b,['error'])||!Object.hasOwn(fixed,b.error)||fixed[b.error]!==status)throw fail('SEGMENT_READBACK_UNCONFIRMED');
   return response(status,b);
  }

  const allowed=status===202?['error','state','idempotency_key']:['error','current_version'];
  if(![202,400,401,403,404,409,422,503].includes(status)||!errors.has(b.error)||Object.keys(b).some(k=>!allowed.includes(k))||Object.hasOwn(b,'current_version')&&(!Number.isSafeInteger(b.current_version)||b.current_version<1)||status===202&&(b.error!=='SEGMENT_SERVICE_UNAVAILABLE'||b.state!=='unconfirmed'||b.idempotency_key!==p.idempotency_key||!entry.writing))throw fail('SEGMENT_READBACK_UNCONFIRMED');
  return response(status,b);
 }
 let ok=false;
 if(p.acao==='segmentos_listar')ok=status===200&&exact(b,['segments','limit','offset','catalog','capabilities'])&&Array.isArray(b.segments)&&b.segments.length<=p.limit&&b.segments.every(x=>segment(x,p.brand))&&b.limit===p.limit&&b.offset===p.offset&&catalog(b.catalog,p.brand)&&exact(b.capabilities,['draft','count','send'])&&typeof b.capabilities.draft==='boolean'&&typeof b.capabilities.count==='boolean'&&b.capabilities.send===false&&(b.catalog.current||!b.capabilities.draft&&!b.capabilities.count);
 else if(p.acao==='segmento_obter')ok=status===200&&exact(b,['segment'])&&segment(b.segment,p.brand)&&b.segment.id===p.id;
 else if(p.acao==='segmento_contexto_v2')ok=status===200&&exact(b,['scope'])&&exact(b.scope,['schema','brand','actor_sha256'])&&b.scope.schema==='crm-audience-writer-scope-v2'&&b.scope.brand===p.brand&&typeof b.scope.actor_sha256==='string'&&/^[a-f0-9]{64}$/.test(b.scope.actor_sha256);
 else if(p.acao==='segmento_operacao_v2'){
  const o=b.operation,r=o?.receipt,inner=r?.body;
  ok=status===200&&exact(b,['operation'])&&exact(o,['schema','idempotency_key','brand','action','actor_sha256','payload_sha256','receipt'])&&
   o.schema==='crm-audience-operation-v2'&&o.idempotency_key===p.idempotency_key&&o.brand===p.brand&&
   ['segmento_criar','segmento_salvar','segmento_arquivar'].includes(o.action)&&typeof o.actor_sha256==='string'&&/^[a-f0-9]{64}$/.test(o.actor_sha256)&&typeof o.payload_sha256==='string'&&/^[a-f0-9]{64}$/.test(o.payload_sha256)&&
   exact(r,['status','body'])&&inner&&typeof inner==='object'&&!Array.isArray(inner);
  if(ok&&Object.hasOwn(inner,'error'))ok=durableRejections[inner.error]===r.status&&exact(inner,['error',...(inner.error==='SEGMENT_VERSION_CONFLICT'?['current_version']:[])])&&!(o.action==='segmento_criar'&&['SEGMENT_NOT_FOUND','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED'].includes(inner.error))&&!(o.action==='segmento_arquivar'&&['SEGMENT_SHAPE','SEGMENT_BRAND_MISMATCH','SEGMENT_LIST_UNAVAILABLE'].includes(inner.error))&&(!Object.hasOwn(inner,'current_version')||Number.isSafeInteger(inner.current_version)&&inner.current_version>0&&inner.current_version<=S.MAX_VERSION);
  else if(ok)ok=exact(inner,['segment','transport_supported'])&&inner.transport_supported===false&&segment(inner.segment,p.brand)&&
   (o.action==='segmento_criar'?r.status===201&&inner.segment.version===1&&!inner.segment.archived:r.status===200&&inner.segment.version>=2&&inner.segment.archived===(o.action==='segmento_arquivar'));
 }
 else if(p.acao==='segmento_contar')ok=status===200&&exact(b,['source_confirmed','eligible_count','checked_at','definition','definition_hash','base_list_id','transport_supported','unknown_reason','segment_id','version'])&&typeof b.source_confirmed==='boolean'&&(b.source_confirmed?Number.isSafeInteger(b.eligible_count)&&b.eligible_count>=0&&b.unknown_reason===null:b.eligible_count===null&&['external_source_unavailable','list_source_unavailable'].includes(b.unknown_reason))&&Number.isFinite(Date.parse(b.checked_at))&&H.digest(A.normalize(b.definition))===b.definition_hash&&b.definition.brand===p.brand&&Number.isSafeInteger(b.base_list_id)&&b.base_list_id>0&&b.transport_supported===false&&(p.id?b.segment_id===p.id&&b.version===p.expected_version:b.segment_id===null&&b.version===null&&same(b.definition,p.definition));
 else {
  ok=exact(b,['segment','transport_supported'])&&segment(b.segment,p.brand)&&b.transport_supported===false;
  if(p.acao==='segmento_criar')ok=ok&&status===201&&b.segment.version===1&&!b.segment.archived&&same(b.segment.definition,p.definition);
  else if(p.acao==='segmento_salvar')ok=ok&&status===200&&b.segment.id===p.id&&b.segment.version===p.expected_version+1&&!b.segment.archived&&same(b.segment.definition,p.definition);
  else if(p.acao==='segmento_arquivar')ok=ok&&status===200&&b.segment.id===p.id&&b.segment.version===p.expected_version+1&&b.segment.archived;
  else ok=ok&&p.acao==='segmento_operacao'&&[200,201].includes(status);
 }
 if(!ok)throw fail('SEGMENT_READBACK_UNCONFIRMED');return response(status,b);
}
function failure(entry){return response(entry?.writing?202:503,{error:'SEGMENT_SERVICE_UNAVAILABLE',...(entry?.writing?{state:'unconfirmed',idempotency_key:entry.request.idempotency_key}:{})});}
function createAudienceAPI({store}={}){
 if(!store||typeof store.execute!=='function')throw fail('SEGMENT_ADAPTER_INVALID');
 async function handle(value,{signal}={}){const entry=parse(value);if(entry.route==='response')return entry.response;try{return project(entry,await store.execute({key:entry.key,request:entry.request,signal}));}catch{return failure(entry);}}
 return Object.freeze({enabled:false,handle});
}
module.exports={VERSION,ENABLED,parse,project,failure,createAudienceAPI};
