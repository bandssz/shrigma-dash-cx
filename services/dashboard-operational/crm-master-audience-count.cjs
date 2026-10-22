'use strict';
// Pure original-source COUNT DTO boundary. No clock default, transport, auth,
// identity, DB, journal, operation replay, enrollment or send authorization.
const {createHash}=require('node:crypto');
const A=require('./segment-audience-contract.js');
const provenance=new WeakMap();
const LIMITS=Object.freeze({requestBytes:16000,responseBytes:2000000,depth:16,nodes:50000,array:10000,string:32768,ageMs:300000});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const digest=v=>createHash('sha256').update(canonical(v),'utf8').digest('hex');
// Same hash semantics as original segment-audience-review.cjs: recursively
// sorted JSON object keys, array order retained, UTF-8 SHA256, not jsonb::text.
function canonical(v){return Array.isArray(v)?'['+v.map(canonical).join(',')+']':plain(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);}
function capture(input,secrets,maxBytes){
 const active=new Set(),needles=secrets.filter(s=>s.length).map(s=>s.toLowerCase());let nodes=0,bytes=0;
 const text=v=>{if(v.length>LIMITS.string||needles.some(s=>v.toLowerCase().includes(s)))throw Error('DENIED');bytes+=Buffer.byteLength(v);if(bytes>maxBytes)throw Error('DENIED');};
 const visit=(v,depth)=>{
  if(++nodes>LIMITS.nodes||depth>LIMITS.depth)throw Error('DENIED');
  if(typeof v==='string'){text(v);return v;}
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v!=='object'||active.has(v)||!Array.isArray(v)&&!plain(v))throw Error('DENIED');
  const keys=Reflect.ownKeys(v),array=Array.isArray(v);if(array&&(v.length>LIMITS.array||keys.length!==v.length+1))throw Error('DENIED');
  active.add(v);const out=array?[]:{};
  for(const key of keys){
   if(array&&key==='length')continue;
   if(typeof key!=='string'||array&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=v.length))throw Error('DENIED');text(key);
   const d=Object.getOwnPropertyDescriptor(v,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw Error('DENIED');
   Object.defineProperty(out,key,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});
  }
  active.delete(v);return out;
 };
 const out=visit(input,0);if(Buffer.byteLength(JSON.stringify(out))>maxBytes)throw Error('DENIED');return out;
}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function stamp(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
const errors=Object.freeze({SEGMENT_REQUEST_INVALID:400,SEGMENT_FIELDS:400,SEGMENT_ID_INVALID:400,SEGMENT_VERSION_REQUIRED:400,SEGMENT_UNAUTHORIZED:401,SEGMENT_ACCESS_DENIED:403,SEGMENT_NOT_FOUND:404,SEGMENT_VERSION_CONFLICT:409,SEGMENT_ARCHIVED:409,SEGMENT_CATALOG_CHANGED:409,SEGMENT_SHAPE:422,SEGMENT_BRAND_MISMATCH:422,SEGMENT_LIST_UNAVAILABLE:422,SEGMENT_UNAVAILABLE:503,SEGMENT_SERVICE_UNAVAILABLE:503,SEGMENT_SESSION_BOUNDARY:503});
function validateAudienceCount(result,{brand,request,originalDefinition,nowMs,secrets=[]}={}){
 const finish=(status,body,scope=null)=>{const checked=freeze({status,body});provenance.set(checked,{brand:['fish','aristo'].includes(brand)?brand:null,scope});return checked;};
 const denied=()=>finish(502,{error:'AUDIENCE_COUNT_RESPONSE_DENIED'});
 const invalid=()=>finish(400,{error:'AUDIENCE_COUNT_REQUEST_INVALID'});
 if(!['fish','aristo'].includes(brand)||!integer(nowMs,0,8640000000000000)||!Array.isArray(secrets)||secrets.some(s=>typeof s!=='string'))return invalid();
 let p,expected,scope;
 try{
  p=capture(request,secrets,LIMITS.requestBytes);
  if(!plain(p)||p.acao!=='segmento_contar'||p.brand!==brand||typeof p.expected_catalog_hash!=='string'||!HASH.test(p.expected_catalog_hash))return invalid();
  const saved=Object.hasOwn(p,'id');scope=saved?'saved':'draft';
  if(!exact(p,['acao','brand','expected_catalog_hash',...(saved?['id','expected_version']:['definition'])]))return invalid();
  if(saved){
   if(typeof p.id!=='string'||!UUID.test(p.id)||!integer(p.expected_version,1,999999999))return invalid();
   p.id=p.id.toLowerCase(); // Same UUID canonicalization as the original Store.request.
   const original=capture(originalDefinition,secrets,LIMITS.requestBytes);expected=A.normalize(original);
   if(expected.brand!==brand||canonical(expected)!==canonical(original))return invalid();
  }else{
   expected=A.normalize(p.definition);if(expected.brand!==brand)return invalid();
   if(originalDefinition!==undefined&&originalDefinition!==null){const original=capture(originalDefinition,secrets,LIMITS.requestBytes);if(canonical(A.normalize(original))!==canonical(expected)||canonical(original)!==canonical(expected))return invalid();}
  }
 }catch{return invalid();}
 if(result===null||result===undefined)return finish(503,{error:'AUDIENCE_COUNT_SOURCE_UNAVAILABLE'},scope);
 try{
  const r=capture(result,secrets,LIMITS.responseBytes);
  if(!exact(r,['status','body',...(Object.hasOwn(r,'headers')?['headers']:[])]))return denied();
  if(Object.hasOwn(r,'headers')&&(!plain(r.headers)||Object.keys(r.headers).length!==1||!Object.entries(r.headers).every(([k,v])=>k.toLowerCase()==='cache-control'&&v==='no-store')))return denied();
  if(r.status!==200){
   const b=r.body;if(!plain(b)||!Object.hasOwn(errors,b.error)||errors[b.error]!==r.status||!exact(b,['error',...(b.error==='SEGMENT_VERSION_CONFLICT'?['current_version']:[])]))return denied();
   if(b.error==='SEGMENT_VERSION_CONFLICT'&&(scope!=='saved'||!integer(b.current_version,1,999999999)||b.current_version===p.expected_version))return denied();
   if(scope==='draft'&&['SEGMENT_NOT_FOUND','SEGMENT_ARCHIVED'].includes(b.error))return denied();
   return finish(r.status,{error:b.error},scope);
  }
  const b=r.body;
  if(!exact(b,['source_confirmed','eligible_count','checked_at','definition','definition_hash','base_list_id','transport_supported','unknown_reason','segment_id','version'])||typeof b.source_confirmed!=='boolean'||b.transport_supported!==false||!integer(b.base_list_id,1,2147483647)||!stamp(b.checked_at)||Date.parse(b.checked_at)>nowMs||nowMs-Date.parse(b.checked_at)>LIMITS.ageMs)return denied();
  if(b.source_confirmed?(!integer(b.eligible_count,0,Number.MAX_SAFE_INTEGER)||b.unknown_reason!==null):(b.eligible_count!==null||!['external_source_unavailable','list_source_unavailable'].includes(b.unknown_reason)))return denied();
  if(scope==='saved'?(b.segment_id!==p.id||b.version!==p.expected_version):(b.segment_id!==null||b.version!==null))return denied();
  const normal=A.normalize(b.definition),hash=digest(expected);
  if(normal.brand!==brand||canonical(normal)!==canonical(b.definition)||canonical(normal)!==canonical(expected)||typeof b.definition_hash!=='string'||!HASH.test(b.definition_hash)||b.definition_hash!==hash||digest(b.definition)!==hash)return denied();
  // No catalog hash in native count DTO: source binding and authorization
  // remain Root's private original-source obligation, never inferred here.
  return finish(200,b,scope);
 }catch{return denied();}
}
function audienceCountSummary(checked,{brand}={}){
 const meta=provenance.get(checked),trusted=!!meta&&['fish','aristo'].includes(brand)&&meta.brand===brand,ok=trusted&&checked.status===200;
 const out={brand:['fish','aristo'].includes(brand)?brand:null,status:trusted?checked.status:502,available:ok,scope:trusted?meta.scope:null,source_confirmed:null,eligible_count:null,checked_at:null,unknown_reason:null,catalogBindingConfirmed:false,authorizes_selection:false,authorizes_send:false,gatewayWrite:false,operational:false};
 if(ok)Object.assign(out,{source_confirmed:checked.body.source_confirmed,eligible_count:checked.body.eligible_count,checked_at:checked.body.checked_at,unknown_reason:checked.body.unknown_reason});
 return freeze(out);
}
module.exports={validateAudienceCount,audienceCountSummary};
