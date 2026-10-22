'use strict';
// Local candidate. No network, deployment, credentials or transport activation.
const S=require('./segment-contract.js');
const VERSION=S.VERSION,ENABLED=false,QUERY='SELECT public.shrigma_segment_http_v1($1::text,$2::jsonb) AS result';
function protocol(S){
 const VERSION=S.VERSION,MAX_REQUEST=16000,MAX_RESPONSE=2000000;
 const mutations=['segmento_criar','segmento_salvar','segmento_arquivar'];
 const posts=[...mutations,'segmento_contar'];
 const fields={segmentos_listar:['limit','offset'],segmento_obter:['id'],segmento_operacao:['idempotency_key'],segmento_criar:['definition','idempotency_key'],segmento_salvar:['id','expected_version','definition','idempotency_key'],segmento_arquivar:['id','expected_version','idempotency_key'],segmento_contar:['id','expected_version','definition']};
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,KEY=/^[A-Za-z0-9_.:-]{8,128}$/;
 const knownErrors=new Set(['SEGMENT_ACCESS_DENIED','SEGMENT_REQUEST_INVALID','SEGMENT_FIELDS','SEGMENT_OPERATION_ID_REQUIRED','SEGMENT_OPERATION_MISMATCH','SEGMENT_OPERATION_UNCONFIRMED','SEGMENT_PAGE_INVALID','SEGMENT_ID_INVALID','SEGMENT_VERSION_REQUIRED','SEGMENT_NOT_FOUND','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED','SEGMENT_UNAVAILABLE','SEGMENT_COUNT_INPUT','SEGMENT_BASE_UNCONFIRMED','SEGMENT_BRAND_MISMATCH','SEGMENT_LIST_UNAVAILABLE','SEGMENT_SHAPE','SEGMENT_VERSION','SEGMENT_BRAND','SEGMENT_NAME','SEGMENT_LIMIT','SEGMENT_RULE','SEGMENT_LIST_ID','SEGMENT_UNAUTHORIZED','SEGMENT_SESSION_BOUNDARY']);
 const bytes=s=>unescape(encodeURIComponent(s)).length;
 const positive=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
 const fail=(status,code)=>Object.assign(Error(code),{status,code});
 const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
 const same=(a,b)=>JSON.stringify(S.normalize(a))===JSON.stringify(S.normalize(b));
 const response=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body});
 function copy(value,limit=MAX_REQUEST){
  const active=new Set();let count=0;
  function visit(v,depth){
   if(++count>20000||depth>20)throw fail(413,'SEGMENT_REQUEST_SIZE');
   if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
   if(!v||typeof v!=='object'||active.has(v)||Object.getOwnPropertySymbols(v).length||!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw fail(400,'SEGMENT_REQUEST_INVALID');
   active.add(v);for(const [k,d]of Object.entries(Object.getOwnPropertyDescriptors(v))){if(Array.isArray(v)&&k==='length')continue;if(!d.enumerable||!Object.hasOwn(d,'value')||['__proto__','constructor','prototype'].includes(k))throw fail(400,'SEGMENT_FIELDS');visit(d.value,depth+1);}active.delete(v);
  }
  visit(value,0);const text=JSON.stringify(value);if(bytes(text)>limit)throw fail(413,'SEGMENT_REQUEST_SIZE');return JSON.parse(text);
 }
 function fromJSON(text,limit){if(typeof text!=='string'||bytes(text)>limit)throw fail(413,'SEGMENT_REQUEST_SIZE');let v;try{v=JSON.parse(text);}catch{throw fail(400,'SEGMENT_REQUEST_INVALID');}return copy(v,limit);}
 function parse(input){
  try{
   const v=copy(input,32768),method=v.method,r=v.request;
   if(!exact(v,['method','request'])||!['GET','POST'].includes(method)||!r||typeof r!=='object'||Array.isArray(r))throw fail(405,'SEGMENT_METHOD_NOT_ALLOWED');
   const headers=Object.entries(r.headers||{}),origins=headers.filter(([k])=>k.toLowerCase()==='origin'),auth=headers.filter(([k])=>k.toLowerCase()==='authorization');
   if(origins.length>1||origins.length===1&&origins[0][1]!=='https://bandssz.github.io')throw fail(403,'SEGMENT_ORIGIN_DENIED');
   if(auth.length!==1||typeof auth[0][1]!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth[0][1]))throw fail(401,'SEGMENT_UNAUTHORIZED');
   // Never accept alternate credential or routing fields on either HTTP channel.
   if(method==='POST'&&r.query&&Object.keys(r.query).length||method==='GET'&&r.body&&Object.keys(r.body).length)throw fail(400,'SEGMENT_FIELDS');
   const p=copy(method==='GET'?r.query:r.body);
   if(!p||Array.isArray(p)||!['fish','aristo'].includes(p.brand)||!Object.hasOwn(fields,p.acao))throw fail(400,'SEGMENT_REQUEST_INVALID');
   if(method!==(posts.includes(p.acao)?'POST':'GET'))throw fail(405,'SEGMENT_METHOD_NOT_ALLOWED');
   let extra=fields[p.acao];
   if(p.acao==='segmentos_listar'){
    for(const [k,fallback,max,min]of [['limit',50,100,1],['offset',0,10000,0]]){if(!Object.hasOwn(p,k))p[k]=fallback;else if(typeof p[k]==='string'&&/^(0|[1-9][0-9]*)$/.test(p[k]))p[k]=Number(p[k]);if(!Number.isSafeInteger(p[k])||p[k]<min||p[k]>max)throw fail(400,'SEGMENT_PAGE_INVALID');}
   }
   if(p.acao==='segmento_contar')extra=Object.hasOwn(p,'definition')?['definition']:['id','expected_version'];
   if(!exact(p,['acao','brand',...extra]))throw fail(400,'SEGMENT_FIELDS');
   if(Object.hasOwn(p,'id')){if(typeof p.id!=='string'||!UUID.test(p.id))throw fail(400,'SEGMENT_ID_INVALID');p.id=p.id.toLowerCase();}
   if(Object.hasOwn(p,'expected_version')&&(!positive(p.expected_version)||p.expected_version>999999999))throw fail(400,'SEGMENT_VERSION_REQUIRED');
   if(Object.hasOwn(p,'idempotency_key')&&(typeof p.idempotency_key!=='string'||!KEY.test(p.idempotency_key)))throw fail(400,'SEGMENT_OPERATION_ID_REQUIRED');
   if(Object.hasOwn(p,'definition')){try{const normalized=S.normalize(p.definition);if(normalized.brand!==p.brand)throw Error();}catch{throw fail(422,'SEGMENT_DEFINITION_INVALID');}}
   return {route:'query',key:auth[0][1].slice(7),request:p,writing:mutations.includes(p.acao)};
  }catch(e){return {route:'response',response:response(e.status||400,{error:e.code||'SEGMENT_REQUEST_INVALID'})};}
 }
 function validSegment(s,brand){
  if(!exact(s,['id','brand','name','definition','version','archived','created_at','updated_at','updated_by'])||!UUID.test(s.id)||s.brand!==brand||!positive(s.version)||typeof s.archived!=='boolean'||typeof s.updated_by!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,194}$/.test(s.updated_by)||!Number.isFinite(Date.parse(s.created_at))||!Number.isFinite(Date.parse(s.updated_at)))return false;
  try{return S.normalize(s.definition).brand===brand&&s.name===s.definition.name;}catch{return false;}
 }
 function project(entry,raw){
  const r=copy(raw,MAX_RESPONSE),p=entry.request,b=r?._body,status=r?._http;
  if(!exact(r,['_http','_body'])||![200,201,400,401,403,404,409,413,422,503].includes(status)||!b||typeof b!=='object'||Array.isArray(b))throw fail(503,'SEGMENT_READBACK_UNCONFIRMED');
  if(Object.hasOwn(b,'error')){
   if(status<400||!knownErrors.has(b.error)||Object.keys(b).some(k=>!['error','current_version','transport_supported'].includes(k))||Object.hasOwn(b,'current_version')&&!positive(b.current_version)||Object.hasOwn(b,'transport_supported')&&b.transport_supported!==false)throw fail(503,'SEGMENT_READBACK_UNCONFIRMED');
   return response(status,b);
  }
  let ok=false;
  if(p.acao==='segmentos_listar'){
   const c=b.catalog;
   ok=status===200&&exact(b,['segments','limit','offset','capabilities','catalog'])&&Array.isArray(b.segments)&&b.segments.length<=p.limit&&b.segments.every(s=>validSegment(s,p.brand))&&b.limit===p.limit&&b.offset===p.offset&&exact(b.capabilities,['draft','count','send'])&&typeof b.capabilities.draft==='boolean'&&typeof b.capabilities.count==='boolean'&&b.capabilities.send===false&&exact(c,['brand','current','lists'])&&c.brand===p.brand&&typeof c.current==='boolean'&&Array.isArray(c.lists)&&c.lists.length<=1000&&c.lists.every(l=>exact(l,['id','brand','name','available'])&&positive(l.id)&&l.brand===p.brand&&typeof l.name==='string'&&l.name.length<=500&&typeof l.available==='boolean')&&new Set(c.lists.map(l=>l.id)).size===c.lists.length&&(!c.current?b.capabilities.draft===false&&b.capabilities.count===false:true);
  }else if(p.acao==='segmento_contar'){
   ok=status===200&&exact(b,['source_confirmed','eligible_count','checked_at','definition','definition_hash','base_list_id','transport_supported','segment_id','version'])&&typeof b.source_confirmed==='boolean'&&(b.source_confirmed?Number.isSafeInteger(b.eligible_count)&&b.eligible_count>=0:b.eligible_count===null)&&Number.isFinite(Date.parse(b.checked_at))&&/^[a-f0-9]{64}$/.test(b.definition_hash)&&positive(b.base_list_id)&&b.transport_supported===false&&(p.id?b.segment_id===p.id&&b.version===p.expected_version:b.segment_id===null&&b.version===null&&same(b.definition,p.definition))&&S.normalize(b.definition).brand===p.brand;
  }else if(p.acao==='segmento_obter')ok=status===200&&exact(b,['segment'])&&validSegment(b.segment,p.brand)&&b.segment.id===p.id;
  else{
   ok=exact(b,['segment','transport_supported'])&&b.transport_supported===false&&validSegment(b.segment,p.brand);
   if(p.acao==='segmento_criar')ok=ok&&status===201&&b.segment.version===1&&!b.segment.archived&&same(b.segment.definition,p.definition);
   else if(p.acao==='segmento_salvar')ok=ok&&status===200&&b.segment.id===p.id&&b.segment.version===p.expected_version+1&&!b.segment.archived&&same(b.segment.definition,p.definition);
   else if(p.acao==='segmento_arquivar')ok=ok&&status===200&&b.segment.id===p.id&&b.segment.version===p.expected_version+1&&b.segment.archived;
   else ok=ok&&p.acao==='segmento_operacao'&&[200,201].includes(status);
  }
  if(!ok)throw fail(503,'SEGMENT_READBACK_UNCONFIRMED');return response(status,b);
 }
 function failure(entry){return {route:'response',response:response(entry?.writing?202:503,{error:'SEGMENT_SERVICE_UNAVAILABLE',...(entry?.writing?{state:'unconfirmed',idempotency_key:entry.request.idempotency_key,retry_same_request_only:true}:{})})};}
 const finish=(entry,r)=>{try{return {route:'response',response:project(entry,r)};}catch{return failure(entry);}};
 function parseJSON(text){try{return parse(fromJSON(text,32768));}catch(e){return {route:'response',response:response(e.status||400,{error:e.code||'SEGMENT_REQUEST_INVALID'})};}}
 function finishJSON(entryText,resultText){let e;try{e=fromJSON(entryText,32768);return finish(e,fromJSON(resultText,MAX_RESPONSE));}catch{return failure(e);}}
 return Object.freeze({VERSION,MAX_REQUEST,MAX_RESPONSE,parse,parseJSON,project,finish,finishJSON,failure});
}
const API=protocol(S);
const FUNCTION_SQL=`CREATE FUNCTION public.shrigma_segment_http_v1(k text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='500ms' AS $segment_http$
DECLARE op jsonb;who text;needed text;mutating boolean;result jsonb;catalog jsonb;ready boolean;rows jsonb;cfg public.shrigma_segment_config%ROWTYPE;timeout_ms numeric;
BEGIN
 timeout_ms:=extract(epoch FROM pg_catalog.current_setting('statement_timeout')::interval)*1000;
 IF timeout_ms<=0 OR timeout_ms>30000 OR pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RETURN pg_catalog.jsonb_build_object('_http',503,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_SESSION_BOUNDARY'));
 END IF;
 IF k IS NULL OR k !~ '^[a-z0-9-]{8,128}$' THEN RETURN pg_catalog.jsonb_build_object('_http',401,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_UNAUTHORIZED'));END IF;
 IF pg_catalog.jsonb_typeof(p) IS DISTINCT FROM 'object' OR pg_catalog.octet_length(p::text)>16000 OR coalesce(p->>'brand','') NOT IN('fish','aristo') THEN RETURN pg_catalog.jsonb_build_object('_http',422,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_REQUEST_INVALID'));END IF;
 mutating:=p->>'acao' IN('segmento_criar','segmento_salvar','segmento_arquivar');
 needed:=CASE WHEN mutating THEN 'draft' WHEN p->>'acao' IN('segmentos_listar','segmento_obter','segmento_contar','segmento_operacao') THEN 'read_content' END;
 SELECT public.shrigma_panel_operator_v1(k,'growth') INTO op;
 IF op IS NULL OR coalesce(op->>'who','') !~ '^panel:[A-Za-z0-9_.:-]{1,194}$' THEN RETURN pg_catalog.jsonb_build_object('_http',401,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_UNAUTHORIZED'));END IF;
 IF needed IS NULL OR pg_catalog.jsonb_typeof(op->'caps') IS DISTINCT FROM 'array' OR NOT(op->'caps' ? needed) THEN RETURN pg_catalog.jsonb_build_object('_http',403,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_ACCESS_DENIED'));END IF;
 who:=op->>'who';
 IF mutating THEN
  IF coalesce(p->>'idempotency_key','') !~ '^[A-Za-z0-9_.:-]{8,128}$' THEN RETURN pg_catalog.jsonb_build_object('_http',422,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_OPERATION_ID_REQUIRED'));END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('segment-request:'||pg_catalog.jsonb_build_array(who,p->>'idempotency_key')::text,0));
  -- A new PL/pgSQL command after waiting gets a fresh RC snapshot. Replay is reauthorized too.
  SELECT public.shrigma_panel_operator_v1(k,'growth') INTO op;
  IF op IS NULL OR op->>'who' IS DISTINCT FROM who THEN RETURN pg_catalog.jsonb_build_object('_http',401,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_UNAUTHORIZED'));END IF;
  IF pg_catalog.jsonb_typeof(op->'caps') IS DISTINCT FROM 'array' OR NOT(op->'caps' ? needed) THEN RETURN pg_catalog.jsonb_build_object('_http',403,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_ACCESS_DENIED'));END IF;
 END IF;
 result:=public.shrigma_segment_api_v1(who,op->'caps',p);
 IF p->>'acao'='segmentos_listar' AND result->>'_http'='200' THEN
  SELECT * INTO cfg FROM public.shrigma_segment_config WHERE brand=p->>'brand';
  SELECT coalesce(cfg.enabled AND cfg.base_list_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.lists l WHERE l.id=cfg.base_list_id AND l.status::text='active' AND l.optin::text IN('single','double') AND public.shrigma_campaign_list_brand(l)=p->>'brand'),false) INTO ready;
  IF (SELECT count(*) FROM public.lists l WHERE public.shrigma_campaign_list_brand(l)=p->>'brand')>1000 THEN RETURN pg_catalog.jsonb_build_object('_http',503,'_body',pg_catalog.jsonb_build_object('error','SEGMENT_UNAVAILABLE'));END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',l.id,'brand',p->>'brand','name',l.name,'available',coalesce(l.status::text='active' AND l.optin::text IN('single','double'),false)) ORDER BY l.id),'[]'::jsonb) INTO rows FROM public.lists l WHERE public.shrigma_campaign_list_brand(l)=p->>'brand';
  catalog:=pg_catalog.jsonb_build_object('brand',p->>'brand','current',ready,'lists',rows);
  result:=pg_catalog.jsonb_set(result,'{_body}',(result->'_body')||pg_catalog.jsonb_build_object('catalog',catalog,'capabilities',pg_catalog.jsonb_build_object('draft',ready AND (op->'caps' ? 'draft'),'count',ready AND (op->'caps' ? 'read_content'),'send',false)));
 END IF;
 RETURN result;
END $segment_http$`;
// One local installation statement, fresh-only and atomic. Deployment still needs a reviewed plan.
const INSTALL_SQL=`DO $segment_http_install$ BEGIN
 IF pg_catalog.to_regprocedure('public.shrigma_segment_http_v1(text,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'SEGMENT_HTTP_INSTALL_COLLISION'; END IF;
 IF pg_catalog.to_regprocedure('public.shrigma_segment_api_v1(text,jsonb,jsonb)') IS NULL OR pg_catalog.to_regprocedure('public.shrigma_panel_operator_v1(text,text)') IS NULL THEN RAISE EXCEPTION 'SEGMENT_HTTP_DEPENDENCY';END IF;
 EXECUTE $segment_http_ddl$${FUNCTION_SQL}$segment_http_ddl$;
 REVOKE ALL ON FUNCTION public.shrigma_segment_http_v1(text,jsonb) FROM PUBLIC;
END $segment_http_install$;`;
module.exports={VERSION,ENABLED,QUERY,API,protocol,INSTALL_SQL};
