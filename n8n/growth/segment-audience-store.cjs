'use strict';
// Trusted service boundary, local candidate. No network, pool, credential or
// operational default is created here. See segment-audience-store.md.
const A=require('./segment-audience-contract.js');
const H=require('./segment-audience-review.cjs');
const Shopify=require('./segment-shopify-facts.cjs');
const Recorded=require('./segment-recorded-origin.cjs');
const ContextReview=require('./segment-audience-context-review.cjs');
const VERSION=A.VERSION,ENABLED=false,MAX_VERSION=999999999;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/,KEY=/^[A-Za-z0-9_.:-]{8,128}$/;
const fields={segmento_contexto_revisao:['id','expected_version','expected_catalog_hash'],segmentos_listar:['limit','offset'],segmento_obter:['id'],segmento_contexto_v2:[],segmento_operacao:['idempotency_key'],segmento_operacao_v2:['idempotency_key'],segmento_criar:['definition','idempotency_key','expected_catalog_hash'],segmento_salvar:['id','expected_version','definition','idempotency_key','expected_catalog_hash'],segmento_arquivar:['id','expected_version','idempotency_key'],segmento_contar:['definition','expected_catalog_hash']};
const mutations=['segmento_criar','segmento_salvar','segmento_arquivar'];
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const response=(status,body)=>({_http:status,_body:body});
const error=(status,code,extra={})=>response(status,{error:code,...extra});
const copy=value=>JSON.parse(H.canonical(value));
function request(value){
 let p;try{p=copy(value);if(Buffer.byteLength(JSON.stringify(p))>16000)throw Error();}catch{throw fail('SEGMENT_REQUEST_INVALID',400);}
 if(!p||!['fish','aristo'].includes(p.brand)||!Object.hasOwn(fields,p.acao))throw fail('SEGMENT_REQUEST_INVALID',400);
 const keys=p.acao==='segmento_contar'&&Object.hasOwn(p,'id')?['id','expected_version','expected_catalog_hash']:fields[p.acao];
 if(!exact(p,['acao','brand',...keys]))throw fail('SEGMENT_FIELDS',400);
 if(Object.hasOwn(p,'id')){if(typeof p.id!=='string'||!UUID.test(p.id))throw fail('SEGMENT_ID_INVALID',400);p.id=p.id.toLowerCase();}
 if(Object.hasOwn(p,'expected_version')&&(!positive(p.expected_version)||p.expected_version>MAX_VERSION))throw fail('SEGMENT_VERSION_REQUIRED',400);
 if(Object.hasOwn(p,'idempotency_key')&&(typeof p.idempotency_key!=='string'||!KEY.test(p.idempotency_key)))throw fail('SEGMENT_OPERATION_ID_REQUIRED',400);
 if(Object.hasOwn(p,'expected_catalog_hash')&&(typeof p.expected_catalog_hash!=='string'||!HASH.test(p.expected_catalog_hash)))throw fail('SEGMENT_FIELDS',400);
 if(p.acao==='segmentos_listar'&&(!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>100||!Number.isSafeInteger(p.offset)||p.offset<0||p.offset>10000))throw fail('SEGMENT_PAGE_INVALID',400);
 return p;
}
const SQL=Object.freeze({
 setup:"SELECT pg_catalog.set_config('search_path','pg_catalog,public',true),pg_catalog.set_config('lock_timeout','500ms',true)",
 boundary:"SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,extract(epoch FROM pg_catalog.current_setting('statement_timeout')::interval)*1000 AS timeout_ms",
 // The shared helper uses now(), which is transaction-start time. Match the
 // exact helper identity/key again with clock_timestamp() after every wait.
 auth:"SELECT operator,live_count,live_actor FROM crm_audience_v2.authenticate($1::text)",
 lock:"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm-audience-v2-request:'||pg_catalog.jsonb_build_array($1::text,$2::text)::text,0))",
 operation:"SELECT brand,payload,payload_hash,response FROM crm_audience_v2.request WHERE actor=$1::text AND operation_key=$2::text",
 config:"SELECT brand,enabled,base_list_id,revision,catalog,checked_at,expires_at,pg_catalog.clock_timestamp() AS read_at FROM crm_audience_v2.config_snapshot($1::text)",
 recorded:"SELECT crm_audience_v2.recorded_origin_source_current($1::text,$2::text,$3::text) AS current",
 shopify:"SELECT crm_audience_v2.shopify_snapshot($1::text) AS source",
 lists:"SELECT id,name,status,optin FROM crm_audience_v2.catalog_lists($1::text)",
 list:"SELECT * FROM crm_audience_v2.audience WHERE brand=$1::text ORDER BY updated_at DESC,id LIMIT $2::integer OFFSET $3::integer",
 get:"SELECT * FROM crm_audience_v2.audience WHERE id=$1::uuid AND brand=$2::text FOR SHARE",
 getWrite:"SELECT * FROM crm_audience_v2.audience WHERE id=$1::uuid AND brand=$2::text FOR UPDATE",
 create:"INSERT INTO crm_audience_v2.audience(brand,name,definition,definition_hash,context,context_hash,created_by,updated_by) VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$7) RETURNING *",
 save:"UPDATE crm_audience_v2.audience SET name=$3,definition=$4::jsonb,definition_hash=$5,context=$6::jsonb,context_hash=$7,version=version+1,updated_by=$8,updated_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid AND brand=$2 RETURNING *",
 archive:"UPDATE crm_audience_v2.audience SET archived=true,version=version+1,updated_by=$3,updated_at=pg_catalog.clock_timestamp() WHERE id=$1::uuid AND brand=$2 RETURNING *",
 revision:"INSERT INTO crm_audience_v2.revision(audience_id,version,definition,definition_hash,context,context_hash,archived,actor) VALUES($1::uuid,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8)",
 receipt:"INSERT INTO crm_audience_v2.request(actor,operation_key,brand,payload,payload_hash,response) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)"
});
function date(v){const n=v instanceof Date?v.getTime():Date.parse(v);if(!Number.isFinite(n))throw fail('SEGMENT_READBACK_UNCONFIRMED');return n;}
function iso(v){return new Date(date(v)).toISOString();}
async function readAuth(query,key,needed){
 const rows=(await query(SQL.auth,[key])).rows,op=rows?.length===1?rows[0].operator:null;
 if(!op||typeof op.who!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,194}$/.test(op.who)||rows[0].live_count!==1||rows[0].live_actor!==op.who)throw fail('SEGMENT_UNAUTHORIZED',401);
 if(!Array.isArray(op.caps)||!op.caps.includes(needed))throw fail('SEGMENT_ACCESS_DENIED',403);
 return {actor:op.who,caps:op.caps};
}
function sourceConfig(raw,brand){
 if(!exact(raw,['currency','timezone','shop_id','fields','products','origins',...(Object.hasOwn(raw,'recorded_origins')?['recorded_origins']:[])])||raw.currency!==null&&(typeof raw.currency!=='string'||!/^([A-Z]{3})$/.test(raw.currency))||raw.shop_id!==null&&(typeof raw.shop_id!=='string'||!/^gid:\/\/shopify\/Shop\/[1-9]\d{0,19}$/.test(raw.shop_id))||raw.timezone!==null&&typeof raw.timezone!=='string')throw fail('SEGMENT_UNAVAILABLE');
 if(raw.timezone!==null){try{new Intl.DateTimeFormat('en',{timeZone:raw.timezone});}catch{throw fail('SEGMENT_UNAVAILABLE');}}
 if(!Array.isArray(raw.fields)||raw.fields.length>Object.keys(A.FIELDS).length||new Set(raw.fields.map(x=>x?.key)).size!==raw.fields.length||raw.fields.some(x=>!exact(x,['key','available','source_hash'])||!Object.hasOwn(A.FIELDS,x.key)||typeof x.available!=='boolean'||x.source_hash!==null&&(typeof x.source_hash!=='string'||!HASH.test(x.source_hash))||x.available&&x.source_hash===null))throw fail('SEGMENT_UNAVAILABLE');
 if(!Array.isArray(raw.products)||raw.products.length>1000||new Set(raw.products.map(x=>x?.id)).size!==raw.products.length||raw.products.some(x=>!exact(x,['id','brand','name','available'])||x.brand!==brand||typeof x.id!=='string'||!/^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/.test(x.id)||typeof x.name!=='string'||x.name.length>500||typeof x.available!=='boolean'))throw fail('SEGMENT_UNAVAILABLE');
 if(!Array.isArray(raw.origins)||raw.origins.length>3||new Set(raw.origins.map(x=>x?.key)).size!==raw.origins.length||raw.origins.some(x=>!exact(x,['key','brand','name','available','provenance_hash'])||!['popup','vip_alma','vip_desodorante'].includes(x.key)||x.brand!==brand||typeof x.name!=='string'||x.name.length>500||typeof x.available!=='boolean'||x.provenance_hash!==null&&(typeof x.provenance_hash!=='string'||!HASH.test(x.provenance_hash))||x.available&&x.provenance_hash===null))throw fail('SEGMENT_UNAVAILABLE');
 if(!Recorded.validOrigins(Object.hasOwn(raw,'recorded_origins')?raw.recorded_origins:[],brand))throw fail('SEGMENT_UNAVAILABLE');return copy(raw);
}
async function readCatalog(query,brand){
 const rows=(await query(SQL.config,[brand])).rows,listRows=(await query(SQL.lists,[brand])).rows;
 if(rows?.length!==1||!Array.isArray(listRows)||listRows.length>1000)throw fail('SEGMENT_UNAVAILABLE');
 const c=rows[0],base=listRows.find(x=>x.id===c.base_list_id);let source,ready=false;
 const empty={currency:null,timezone:null,shop_id:null,fields:Object.keys(A.FIELDS).map(key=>({key,available:false,source_hash:null})),products:[],origins:[]};
 try{source=sourceConfig(c.catalog,brand);ready=c.enabled===true&&positive(c.base_list_id)&&positive(c.revision)&&!!base&&base.status==='active'&&['single','double'].includes(base.optin)&&date(c.checked_at)<=date(c.read_at)&&date(c.expires_at)>date(c.read_at)&&date(c.expires_at)-date(c.checked_at)<=300000;}catch{source=empty;}
 source.fields=source.fields.map(field=>Shopify.FIELDS.includes(field.key)&&field.available&&!Shopify.sourceReady(brand,field.key,source)?{...field,available:false}:field);
 if(source.recorded_origins){
  for(const o of source.recorded_origins){
   if(!Recorded.sourceReady(brand,o.key,source)){o.available=false;continue;}
   const rows=(await query(SQL.recorded,[brand,o.key,o.provenance_hash])).rows;
   if(rows?.length!==1||typeof rows[0].current!=='boolean')throw fail('SEGMENT_UNAVAILABLE');
   if(!rows[0].current)o.available=false;
  }
  if(!source.recorded_origins.some(o=>o.available))source.fields=source.fields.map(f=>f.key===Recorded.FIELD?{...f,available:false}:f);
 }
 let shopify=null;
 if(Shopify.FIELDS.some(field=>Shopify.sourceReady(brand,field,source))){
  const evidence=(await query(SQL.shopify,[brand])).rows;
  const v=evidence?.length===1?evidence[0].source:null;
  if(!v||typeof v.current!=='boolean')throw fail('SEGMENT_UNAVAILABLE');
  if(v.started_at!==undefined){
   if(!exact(v,['current','started_at','observed_at','expires_at','customers','mapped','unresolved'])
    ||![v.customers,v.mapped,v.unresolved].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||v.mapped+v.unresolved!==v.customers||date(v.started_at)>date(v.observed_at)
    ||date(v.expires_at)-date(v.started_at)!==93600000)throw fail('SEGMENT_UNAVAILABLE');
   shopify={current:v.current,started_at:iso(v.started_at),observed_at:iso(v.observed_at),expires_at:iso(v.expires_at)};
  }else if(!exact(v,['current'])||v.current)throw fail('SEGMENT_UNAVAILABLE');
  else shopify={current:false};
  if(!v.current)source.fields=source.fields.map(f=>Shopify.FIELDS.includes(f.key)?{...f,available:false}:f);
 }
 const lists=listRows.map(l=>{if(!positive(l.id)||typeof l.name!=='string'||l.name.length>500)throw fail('SEGMENT_UNAVAILABLE');return {id:l.id,brand,name:l.name,available:l.status==='active'&&['single','double'].includes(l.optin)};});
 // Times and configuration revision refreshes are intentionally excluded. The
 // public hash pins the semantics the operator actually saw, including base
 // opt-in, native list state, currency/timezone and origin provenance.
 const catalog_hash=H.digest({contract:'crm-audience-catalog-semantics-v1',brand,base_list_id:c.base_list_id,lists:listRows,source});
 const catalog={brand,current:ready,...source,lists,coverage:'unconfirmed',checked_at:iso(c.read_at),catalog_hash,...(shopify?{shopify_snapshot:shopify}:{})};
 return {catalog,ready,base_list_id:c.base_list_id,config_revision:c.revision,base:base?{id:base.id,brand,optin:base.optin}:null,lists:listRows,expires_at:c.expires_at===null?null:iso(c.expires_at)};
}
function pins(definition,current){
 if(!current.ready||!A.checkCatalog(definition,current.catalog).ok)throw fail('SEGMENT_LIST_UNAVAILABLE',422);
 const contexts=A.leaves(definition).map(({key,rule})=>{
  if(rule.op==='in_list'){const l=current.lists.find(x=>x.id===rule.list_id);return {rule_key:key,list_id:l.id,optin:l.optin};}
  const field=current.catalog.fields.find(x=>x.key===rule.field),value={rule_key:key,source:A.FIELDS[rule.field].source,source_hash:field.source_hash};
  if(value.source==='shopify'){
   if(!current.catalog.shop_id||!current.catalog.timezone||!current.catalog.currency)throw fail('SEGMENT_LIST_UNAVAILABLE',422);
   Object.assign(value,{shop_id:current.catalog.shop_id,currency:current.catalog.currency,timezone:current.catalog.timezone});
  }
  if(rule.field===Recorded.FIELD){if(!Recorded.sourceReady(definition.brand,rule.value,current.catalog))throw fail('SEGMENT_LIST_UNAVAILABLE',422);value.recorded_origin_provenance_hash=current.catalog.recorded_origins.find(x=>x.key===rule.value).provenance_hash;}
  if(rule.field==='signup.origin')value.origin_provenance_hash=current.catalog.origins.find(x=>x.key===rule.value).provenance_hash;
  return value;
 });
 return {contract:'crm-audience-context-v1',hash_contract:H.HASH_CONTRACT,brand:definition.brand,base:current.base,rules:contexts};
}
// Metadata-only view: tolerate unavailable typed fields with their real hash.
// Bindings and all pin values still pass the original pins/checkCatalog checks.
// Never pass this detached view to count/save/provider/refresh.
function reviewPins(definition,current){
 const view=copy(current),unavailable_fields=[];
 const selected=[...new Set(A.leaves(definition).filter(x=>x.rule.op!=='in_list').map(x=>x.rule.field))].sort();
 for(const field of selected){
  const rows=view.catalog.fields.filter(x=>x.key===field);
  if(rows.length!==1||typeof rows[0].available!=='boolean'||typeof rows[0].source_hash!=='string'||!HASH.test(rows[0].source_hash))throw fail('SEGMENT_LIST_UNAVAILABLE',422);
  if(!rows[0].available)unavailable_fields.push(field);
  rows[0].available=true;
 }
 return {context:pins(definition,view),source_ready:unavailable_fields.length===0,unavailable_fields};
}
function validStored(row){
 let d;try{d=A.normalize(row?.definition);}catch{throw fail('SEGMENT_READBACK_UNCONFIRMED');}
 if(!row||typeof row.id!=='string'||!UUID.test(row.id)||row.brand!==d.brand||row.name!==d.name||!positive(row.version)||row.version>MAX_VERSION||typeof row.archived!=='boolean'||H.digest(d)!==row.definition_hash||H.digest(row.definition)!==row.definition_hash||H.digest(row.context)!==row.context_hash||row.context?.contract!=='crm-audience-context-v1'||row.context.brand!==row.brand||typeof row.updated_by!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,194}$/.test(row.updated_by))throw fail('SEGMENT_READBACK_UNCONFIRMED');
 iso(row.created_at);iso(row.updated_at);return row;
}
function semanticContext(row,current){
 const shopify=row.context?.rules?.filter(x=>x.source==='shopify')||[],units=[...new Set(shopify.map(x=>x.currency))],zones=[...new Set(shopify.map(x=>x.timezone))];
 if(units.length>1||zones.length>1||units.some(x=>typeof x!=='string'||!/^([A-Z]{3})$/.test(x))||zones.some(x=>typeof x!=='string'||!x))throw fail('SEGMENT_READBACK_UNCONFIRMED');
 let matches=false;try{matches=current?.ready===true&&H.digest(pins(row.definition,current))===row.context_hash;}catch{}
 return {currency:units[0]??null,timezone:zones[0]??null,current:matches};
}
function publicSegment(row,current){const s=validStored(row);return {id:s.id,brand:s.brand,name:s.name,definition:copy(s.definition),version:s.version,archived:s.archived,created_at:iso(s.created_at),updated_at:iso(s.updated_at),updated_by:s.updated_by,semantic_context:semanticContext(s,current)};}
async function readDefinition(query,{brand,id}){const rows=(await query(SQL.get,[id,brand])).rows;if(rows.length!==1)return null;return validStored(rows[0]);}
function normalized(input,brand){let d;try{d=A.normalize(input);}catch{throw fail('SEGMENT_SHAPE',422);}if(d.brand!==brand)throw fail('SEGMENT_BRAND_MISMATCH',422);return d;}
function countResult(raw,d,c,id,version){
 const v=copy(raw);if(!exact(v,['source_confirmed','eligible_count','checked_at','definition','definition_hash','base_list_id','transport_supported','unknown_reason'])||typeof v.source_confirmed!=='boolean'||(v.source_confirmed?!Number.isSafeInteger(v.eligible_count)||v.eligible_count<0:v.eligible_count!==null)||H.digest(v.definition)!==H.digest(d)||v.definition_hash!==H.digest(d)||v.base_list_id!==c.base_list_id||v.transport_supported!==false||v.source_confirmed&&v.unknown_reason!==null||!v.source_confirmed&&!['external_source_unavailable','list_source_unavailable'].includes(v.unknown_reason))throw fail('SEGMENT_READBACK_UNCONFIRMED');
 v.checked_at=iso(v.checked_at);return response(200,{...v,segment_id:id,version});
}
const rejectionStatus=Object.freeze({SEGMENT_SHAPE:422,SEGMENT_BRAND_MISMATCH:422,SEGMENT_LIST_UNAVAILABLE:422,SEGMENT_UNAVAILABLE:503,SEGMENT_NOT_FOUND:404,SEGMENT_VERSION_CONFLICT:409,SEGMENT_ARCHIVED:409,SEGMENT_CATALOG_CHANGED:409});
function operationV2(old,p,actor){
 let original;try{original=request(old.payload);}catch{throw fail('SEGMENT_READBACK_UNCONFIRMED');}
 if(!exact(old,['brand','payload','payload_hash','response'])||!mutations.includes(original.acao)||original.brand!==p.brand||original.brand!==old.brand||original.idempotency_key!==p.idempotency_key||!HASH.test(old.payload_hash)||old.payload_hash!==H.digest(original)||old.payload_hash!==H.digest(old.payload))throw fail('SEGMENT_READBACK_UNCONFIRMED');
 const receipt=copy(old.response),status=receipt?._http,body=receipt?._body;
 if(!exact(receipt,['_http','_body'])||!body||typeof body!=='object'||Array.isArray(body))throw fail('SEGMENT_READBACK_UNCONFIRMED');
 if(Object.hasOwn(body,'error')){
  if(rejectionStatus[body.error]!==status||!exact(body,['error',...(body.error==='SEGMENT_VERSION_CONFLICT'?['current_version']:[])])||body.error==='SEGMENT_VERSION_CONFLICT'&&(!positive(body.current_version)||body.current_version>MAX_VERSION||body.current_version===original.expected_version)||original.acao==='segmento_criar'&&['SEGMENT_NOT_FOUND','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED'].includes(body.error)||original.acao==='segmento_arquivar'&&['SEGMENT_SHAPE','SEGMENT_BRAND_MISMATCH','SEGMENT_LIST_UNAVAILABLE'].includes(body.error))throw fail('SEGMENT_READBACK_UNCONFIRMED');
 }else{
  const s=body.segment;
  if(!exact(body,['segment','transport_supported'])||body.transport_supported!==false||!exact(s,['id','brand','name','definition','version','archived','created_at','updated_at','updated_by','semantic_context'])||typeof s.id!=='string'||!UUID.test(s.id)||s.brand!==p.brand||s.updated_by!==actor||!positive(s.version)||s.version>MAX_VERSION||typeof s.archived!=='boolean'||!exact(s.semantic_context,['currency','timezone','current'])||typeof s.semantic_context.current!=='boolean'||s.semantic_context.currency!==null&&(typeof s.semantic_context.currency!=='string'||!/^[A-Z]{3}$/.test(s.semantic_context.currency))||s.semantic_context.timezone!==null&&(typeof s.semantic_context.timezone!=='string'||s.semantic_context.timezone.length>100)||!Number.isFinite(Date.parse(s.created_at))||!Number.isFinite(Date.parse(s.updated_at)))throw fail('SEGMENT_READBACK_UNCONFIRMED');
  if(original.acao==='segmento_criar'&&(status!==201||s.version!==1||s.archived)||original.acao==='segmento_salvar'&&(status!==200||s.id!==original.id||s.version!==original.expected_version+1||s.archived)||original.acao==='segmento_arquivar'&&(status!==200||s.id!==original.id||s.version!==original.expected_version+1||!s.archived))throw fail('SEGMENT_READBACK_UNCONFIRMED');
  let recorded;try{recorded=normalized(s.definition,p.brand);}catch{throw fail('SEGMENT_READBACK_UNCONFIRMED');}
  if(s.name!==recorded.name||H.digest(recorded)!==H.digest(s.definition))throw fail('SEGMENT_READBACK_UNCONFIRMED');
  if(original.acao!=='segmento_arquivar'){
   let definition;try{definition=normalized(original.definition,p.brand);}catch{throw fail('SEGMENT_READBACK_UNCONFIRMED');}
   if(H.digest(definition)!==H.digest(s.definition))throw fail('SEGMENT_READBACK_UNCONFIRMED');
  }
 }
 return response(200,{operation:{schema:'crm-audience-operation-v2',idempotency_key:p.idempotency_key,brand:p.brand,action:original.acao,actor_sha256:H.digest(actor),payload_sha256:old.payload_hash,receipt:{status,body}}});
}
function createAudienceStore({transaction,countProvider=null,refreshCatalog=null,timeoutMs=25000}={}){
 if(typeof transaction!=='function'||refreshCatalog!==null&&typeof refreshCatalog!=='function'||countProvider!==null&&typeof countProvider!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('SEGMENT_ADAPTER_INVALID');
 async function execute({key,request:input,signal:external}={}){
  let p;try{p=request(input);}catch(e){return error(e.status||400,e.code||'SEGMENT_REQUEST_INVALID');}
  if(typeof key!=='string'||!/^[a-z0-9-]{8,128}$/.test(key))return error(401,'SEGMENT_UNAUTHORIZED');
  if(external!==undefined&&!(external instanceof AbortSignal))return error(400,'SEGMENT_REQUEST_INVALID');
  const writing=mutations.includes(p.acao),needed=writing||p.acao==='segmento_contexto_v2'?'draft':'read_content',controller=new AbortController(),signal=controller.signal;let timer,abortHandler;
  const active=()=>{if(signal.aborted)throw fail('SEGMENT_SERVICE_UNAVAILABLE');};
  const run=()=>transaction(async tx=>{
   if(!tx||typeof tx.query!=='function')throw fail('SEGMENT_ADAPTER_INVALID');
   const query=async(text,values=[])=>{active();const r=await tx.query(text,values);active();if(!r||!Array.isArray(r.rows))throw fail('SEGMENT_READBACK_UNCONFIRMED');return r;};
   await query(SQL.setup);const boundary=(await query(SQL.boundary)).rows[0];
   if(boundary?.isolation!=='read committed'||!(Number(boundary.timeout_ms)>0&&Number(boundary.timeout_ms)<=30000))throw fail('SEGMENT_SESSION_BOUNDARY');
   const first=await readAuth(query,key,needed),reauth=async()=>{const a=await readAuth(query,key,needed);if(a.actor!==first.actor)throw fail('SEGMENT_UNAUTHORIZED',401);return a;};
   // Same original authentication/journal: these two GETs never touch catalog,
   // take a write lock, insert a receipt or replay the original mutation.
   if(p.acao==='segmento_contexto_v2'){
    await reauth();const scope={schema:'crm-audience-writer-scope-v2',brand:p.brand,actor_sha256:H.digest(first.actor)};
    await reauth();return response(200,{scope});
   }
   if(p.acao==='segmento_operacao_v2'){
    await reauth();const rows=(await query(SQL.operation,[first.actor,p.idempotency_key])).rows;
    await reauth();if(rows.length>1)throw fail('SEGMENT_READBACK_UNCONFIRMED');
    if(!rows.length)return error(404,'SEGMENT_OPERATION_UNCONFIRMED');
    const old=rows[0];if(old.brand!==p.brand)return error(409,'SEGMENT_OPERATION_MISMATCH');
    const result=operationV2(old,p,first.actor);await reauth();return result;
   }
   if(p.acao==='segmento_contexto_revisao'){
    let row;
    try{
     await reauth();const before=await readCatalog(query,p.brand);await reauth();
     const checkCatalog=c=>{if(!c.ready||!c.catalog.current)throw fail('SEGMENT_UNAVAILABLE',503);if(c.catalog.catalog_hash!==p.expected_catalog_hash)throw fail('SEGMENT_CATALOG_CHANGED',409);};checkCatalog(before);
     const readRow=async()=>{const rows=(await query(SQL.get,[p.id,p.brand])).rows;if(!rows.length)throw fail('SEGMENT_NOT_FOUND',404);if(rows.length!==1)throw fail('SEGMENT_READBACK_UNCONFIRMED');const s=validStored(rows[0]);row=s;if(s.id!==p.id||s.brand!==p.brand)throw fail('SEGMENT_READBACK_UNCONFIRMED');if(s.version!==p.expected_version)throw fail('SEGMENT_VERSION_CONFLICT',409);if(s.archived)throw fail('SEGMENT_ARCHIVED',409);return s;};
     row=await readRow();const custody=s=>copy({id:s.id,brand:s.brand,version:s.version,definition:s.definition,definition_hash:s.definition_hash,context:s.context,context_hash:s.context_hash});const saved=custody(row),current=reviewPins(saved.definition,before);
     await reauth();const after=await readCatalog(query,p.brand);await reauth();checkCatalog(after);
     if(before.config_revision!==after.config_revision||before.expires_at!==after.expires_at||H.digest(current)!==H.digest(reviewPins(saved.definition,after)))throw fail('SEGMENT_CATALOG_CHANGED',409);
     const final=await readRow();if(H.digest(custody(final))!==H.digest(saved))throw fail('SEGMENT_READBACK_UNCONFIRMED');
     const body=ContextReview.create({brand:p.brand,id:p.id,version:saved.version,definition:saved.definition,definition_hash:saved.definition_hash,stored_context:saved.context,stored_context_hash:saved.context_hash,current_context:current.context,source_ready:current.source_ready,unavailable_fields:current.unavailable_fields,catalog_hash:after.catalog.catalog_hash,checked_at:after.catalog.checked_at},{secrets:[key,first.actor]});
     await reauth();active();return response(200,body);
    }catch(e){await reauth();if(['SEGMENT_NOT_FOUND','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED','SEGMENT_CATALOG_CHANGED','SEGMENT_LIST_UNAVAILABLE','SEGMENT_UNAVAILABLE','SEGMENT_READBACK_UNCONFIRMED'].includes(e?.code))return error(e.status||503,e.code,e.code==='SEGMENT_VERSION_CONFLICT'&&row?{current_version:row.version}:{});throw e;}
   }
   if(writing)await query(SQL.lock,[first.actor,p.idempotency_key]);
   await reauth();
   if(writing||p.acao==='segmento_operacao'){
    const old=(await query(SQL.operation,[first.actor,p.idempotency_key])).rows[0];
    if(old){if(old.brand!==p.brand||writing&&(old.payload_hash!==H.digest(p)||H.digest(old.payload)!==H.digest(p)))return error(409,'SEGMENT_OPERATION_MISMATCH');await reauth();return copy(old.response);}
    if(!writing)return error(404,'SEGMENT_OPERATION_UNCONFIRMED');
   }
   if(refreshCatalog){await refreshCatalog({query,brand:p.brand,signal});await reauth();}
   let result,applied=false,initialCatalog=null;
   const freshCatalog=async(afterWrite=false)=>{
    const fresh=await readCatalog(query,p.brand);
    if(!fresh.ready||initialCatalog&&fresh.expires_at!==initialCatalog.expires_at){if(afterWrite)throw fail('SEGMENT_CATALOG_UNCONFIRMED');throw fail('SEGMENT_UNAVAILABLE');}
    if(initialCatalog&&fresh.catalog.catalog_hash!==initialCatalog.catalog.catalog_hash){if(afterWrite)throw fail('SEGMENT_CATALOG_UNCONFIRMED');throw fail('SEGMENT_CATALOG_CHANGED',409);}
    return fresh;
   };
   // Expected business rejections are durable receipts too. Database errors
   // escape the callback and roll back the transaction; they are never retried.
   try{
    let c=await readCatalog(query,p.brand);initialCatalog=c;
    if(p.acao==='segmentos_listar'){
     const stored=(await query(SQL.list,[p.brand,p.limit,p.offset])).rows,auth=await reauth();
     c=await readCatalog(query,p.brand);
     await reauth();
     const segments=stored.map(row=>publicSegment(row,c));
     return response(200,{segments,limit:p.limit,offset:p.offset,catalog:c.catalog,capabilities:{draft:c.ready&&auth.caps.includes('draft'),count:c.ready&&countProvider!==null,send:false}});
    }
    let s=null;
    if(p.id){const rows=(await query(writing?SQL.getWrite:SQL.get,[p.id,p.brand])).rows;s=rows.length===1?validStored(rows[0]):null;if(!s)throw fail('SEGMENT_NOT_FOUND',404);if(p.acao==='segmento_obter'){c=await readCatalog(query,p.brand);await reauth();return response(200,{segment:publicSegment(s,c)});}if(s.version!==p.expected_version)throw fail('SEGMENT_VERSION_CONFLICT',409);if(s.archived)throw fail('SEGMENT_ARCHIVED',409);}
    if(!c.ready)throw fail('SEGMENT_UNAVAILABLE');
    if(p.expected_catalog_hash&&p.expected_catalog_hash!==c.catalog.catalog_hash)throw fail('SEGMENT_CATALOG_CHANGED',409);
    if(s&&['segmento_salvar','segmento_contar'].includes(p.acao)&&!semanticContext(s,c).current)throw fail('SEGMENT_CATALOG_CHANGED',409);
    if(p.acao==='segmento_contar'){
     if(!countProvider)throw fail('SEGMENT_UNAVAILABLE');
     const d=s?s.definition:normalized(p.definition,p.brand);pins(d,c);
     await reauth();await freshCatalog();const counted=await countProvider({definition:copy(d),baseListId:c.base_list_id,catalog:copy(c.catalog),query,signal});result=countResult(counted,d,c,s?.id??null,s?.version??null);await reauth();await freshCatalog(true);await reauth();return result;
    }
    if(s&&s.version===MAX_VERSION)throw fail('SEGMENT_UNAVAILABLE');
    let d,context;if(p.acao!=='segmento_arquivar'){d=normalized(p.definition,p.brand);context=pins(d,c);}
    await freshCatalog();await reauth();
    let rows;
    if(p.acao==='segmento_criar')rows=(await query(SQL.create,[p.brand,d.name,JSON.stringify(d),H.digest(d),JSON.stringify(context),H.digest(context),first.actor])).rows;
    else if(p.acao==='segmento_salvar')rows=(await query(SQL.save,[p.id,p.brand,d.name,JSON.stringify(d),H.digest(d),JSON.stringify(context),H.digest(context),first.actor])).rows;
    else rows=(await query(SQL.archive,[p.id,p.brand,first.actor])).rows;
    if(rows.length!==1)throw fail('SEGMENT_READBACK_UNCONFIRMED');applied=true;s=validStored(rows[0]);
    await query(SQL.revision,[s.id,s.version,JSON.stringify(s.definition),s.definition_hash,JSON.stringify(s.context),s.context_hash,s.archived,first.actor]);
    result=response(p.acao==='segmento_criar'?201:200,{segment:publicSegment(s,c),transport_supported:false});
   }catch(e){
    if(applied||!['SEGMENT_SHAPE','SEGMENT_BRAND_MISMATCH','SEGMENT_LIST_UNAVAILABLE','SEGMENT_UNAVAILABLE','SEGMENT_NOT_FOUND','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED','SEGMENT_CATALOG_CHANGED'].includes(e?.code))throw e;
    let extra={};if(e.code==='SEGMENT_VERSION_CONFLICT'){const rows=(await query(SQL.get,[p.id,p.brand])).rows;if(rows.length!==1)throw fail('SEGMENT_READBACK_UNCONFIRMED');extra={current_version:rows[0].version};}
    result=error(e.status||503,e.code,extra);
   }
   if(writing)await query(SQL.receipt,[first.actor,p.idempotency_key,p.brand,JSON.stringify(p),H.digest(p),JSON.stringify(result)]);
   if(applied)await freshCatalog(true);await reauth();active();return result;
  },{signal,readOnly:false,isolation:'read committed'});
  if(external?.aborted)return error(writing?202:503,'SEGMENT_SERVICE_UNAVAILABLE',writing?{state:'unconfirmed',idempotency_key:p.idempotency_key}:{});
  const aborted=new Promise((_,reject)=>{abortHandler=()=>{controller.abort();reject(fail('SEGMENT_SERVICE_UNAVAILABLE'));};external?.addEventListener('abort',abortHandler,{once:true});});
  try{return await Promise.race([run(),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('SEGMENT_SERVICE_UNAVAILABLE'));},timeoutMs);})]);}
  catch(e){if(['SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED','SEGMENT_SESSION_BOUNDARY'].includes(e?.code))return error(e.status||503,e.code);return error(writing?202:503,'SEGMENT_SERVICE_UNAVAILABLE',writing?{state:'unconfirmed',idempotency_key:p.idempotency_key}:{});}
  finally{clearTimeout(timer);external?.removeEventListener('abort',abortHandler);controller.abort();}
 }
 return Object.freeze({enabled:false,countAvailable:countProvider!==null,execute});
}
module.exports={VERSION,ENABLED,MAX_VERSION,SQL,request,sourceConfig,pins,publicSegment,readAuth,readCatalog,readDefinition,countResult,createAudienceStore};
