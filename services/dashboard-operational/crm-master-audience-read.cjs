 'use strict';
// Source-only READ boundary. No transport, authentication, identity, DB or write admission.
const crypto=require('node:crypto');
const AudienceContract=require('./segment-audience-contract.js');
const metadata=new WeakMap();
const brandRecord=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
function brandDate(v){
 if(typeof v!=='string'||v.length>64||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))return false;
 const [y,m,d,h,min,sec]=v.slice(0,19).split(/[-T:]/).map(Number);
 return m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate()&&h<24&&min<60&&sec<60;
}
function snapshot(input,secrets){
 const seen=new Set();let nodes=0;const lower=secrets.filter(s=>s.length).map(s=>s.toLowerCase());
 const echo=v=>{if(lower.some(s=>v.toLowerCase().includes(s)))throw Error('AUDIENCE_READ_RESPONSE_DENIED');};
 const walk=(v,depth,location=[])=>{
  if(++nodes>50000||depth>16)throw Error('AUDIENCE_READ_RESPONSE_DENIED');
  if(typeof v==='string'){
   const actorField=location.length===3&&location[0]==='body'&&location[1]==='segment'&&location[2]==='updated_by'||location.length===4&&location[0]==='body'&&location[1]==='segments'&&/^(0|[1-9]\d*)$/.test(location[2])&&location[3]==='updated_by';
   if(!actorField||!secrets.some(secret=>secret.length&&v==='panel:'+secret))echo(v);
   return v;
  }
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v!=='object'||seen.has(v)||!Array.isArray(v)&&!brandRecord(v))throw Error('AUDIENCE_READ_RESPONSE_DENIED');
  seen.add(v);const out=Array.isArray(v)?[]:{};const keys=Reflect.ownKeys(v);
  if(Array.isArray(v)&&(v.length>10000||keys.length!==v.length+1))throw Error('AUDIENCE_READ_RESPONSE_DENIED');
  for(const k of keys){
   if(Array.isArray(v)&&k==='length')continue;
   if(typeof k!=='string')throw Error('AUDIENCE_READ_RESPONSE_DENIED');echo(k);
   const d=Object.getOwnPropertyDescriptor(v,k);
   if(!d?.enumerable||!Object.hasOwn(d,'value')||Array.isArray(v)&&(!/^(0|[1-9]\d*)$/.test(k)||Number(k)>=v.length))throw Error('AUDIENCE_READ_RESPONSE_DENIED');
   Object.defineProperty(out,k,{value:walk(d.value,depth+1,[...location,k]),enumerable:true,writable:true,configurable:true});
  }
  seen.delete(v);return out;
 };
 const out=walk(input,0);if(Buffer.byteLength(JSON.stringify(out))>2000000)throw Error('AUDIENCE_READ_RESPONSE_DENIED');return out;
}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
const exact=(v,keys)=>brandRecord(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validateBody(body,action,brand,query){
 const denied=()=>{throw Error('AUDIENCE_READ_RESPONSE_DENIED');};
 const exact=(v,keys)=>brandRecord(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 const bool=v=>typeof v==='boolean',positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
 const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),text=(v,max=500)=>typeof v==='string'&&v.length<=max;
 const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':brandRecord(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
 const segment=s=>{
  if(!exact(s,['id','brand','name','definition','version','archived','created_at','updated_at','updated_by','semantic_context'])||!text(s.id,36)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s.id)||s.brand!==brand||!positive(s.version)||s.version>999999999||!bool(s.archived)||!brandDate(s.created_at)||!brandDate(s.updated_at)||Date.parse(s.created_at)>Date.parse(s.updated_at)||!text(s.updated_by,200)||!/^panel:[A-Za-z0-9_.:-]{1,194}$/.test(s.updated_by)||!exact(s.semantic_context,['currency','timezone','current'])||!bool(s.semantic_context.current)||s.semantic_context.currency!==null&&(typeof s.semantic_context.currency!=='string'||!/^[A-Z]{3}$/.test(s.semantic_context.currency))||s.semantic_context.timezone!==null&&!text(s.semantic_context.timezone,100))return false;
  try{if(s.semantic_context.timezone!==null)new Intl.DateTimeFormat('en',{timeZone:s.semantic_context.timezone});const d=AudienceContract.normalize(s.definition);return d.brand===brand&&d.name===s.name&&canonical(d)===canonical(s.definition);}catch{return false;}
 };
 const catalog=c=>{
  if(!brandRecord(c))return false;
  if(!exact(c,['brand','current','currency','timezone','shop_id','fields','products','origins','lists','coverage','checked_at','catalog_hash',...(Object.hasOwn(c,'recorded_origins')?['recorded_origins']:[]),...(Object.hasOwn(c,'shopify_snapshot')?['shopify_snapshot']:[])])||c.brand!==brand||!bool(c.current)||c.coverage!=='unconfirmed'||!brandDate(c.checked_at)||!hash(c.catalog_hash)||c.currency!==null&&(typeof c.currency!=='string'||!/^[A-Z]{3}$/.test(c.currency))||c.shop_id!==null&&(typeof c.shop_id!=='string'||!/^gid:\/\/shopify\/Shop\/[1-9]\d{0,19}$/.test(c.shop_id))||c.timezone!==null&&!text(c.timezone,100))return false;
  if(c.timezone!==null)try{new Intl.DateTimeFormat('en',{timeZone:c.timezone});}catch{return false;}
  const rows=(v,max,key,check)=>Array.isArray(v)&&v.length<=max&&new Set(v.map(x=>x?.[key])).size===v.length&&v.every(check);
  if(!rows(c.fields,Object.keys(AudienceContract.FIELDS).length,'key',f=>exact(f,['key','available','source_hash'])&&Object.hasOwn(AudienceContract.FIELDS,f.key)&&bool(f.available)&&(f.source_hash===null||hash(f.source_hash))&&(!f.available||f.source_hash!==null))||!rows(c.lists,1000,'id',l=>exact(l,['id','brand','name','available'])&&positive(l.id)&&l.brand===brand&&text(l.name)&&bool(l.available))||!rows(c.products,1000,'id',p=>exact(p,['id','brand','name','available'])&&p.brand===brand&&typeof p.id==='string'&&/^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/.test(p.id)&&text(p.name)&&bool(p.available))||!rows(c.origins,3,'key',o=>exact(o,['key','brand','name','available','provenance_hash'])&&['popup','vip_alma','vip_desodorante'].includes(o.key)&&o.brand===brand&&text(o.name)&&bool(o.available)&&(o.provenance_hash===null||hash(o.provenance_hash))&&(!o.available||o.provenance_hash!==null)))return false;
  if(Object.hasOwn(c,'recorded_origins')){
   if(!AudienceContract.recordedOriginsValid(c.recorded_origins,brand))return false;
   for(const o of c.recorded_origins){const pinned={contract:'crm-recorded-origin-exists-v1',brand:o.brand,origin:o.key,scope_id:o.scope_id,producer_id:o.producer_id,producer_revision:o.producer_revision,coverage_started_at:o.coverage_started_at};if(o.provenance_hash!==crypto.createHash('sha256').update(canonical(pinned)).digest('hex'))return false;}
  }
  if(Object.hasOwn(c,'shopify_snapshot')){
   const v=c.shopify_snapshot;
   if(!brandRecord(v)||!bool(v.current)||!(exact(v,['current'])&&!v.current||exact(v,['current','started_at','observed_at','expires_at'])&&[v.started_at,v.observed_at,v.expires_at].every(brandDate)&&Date.parse(v.started_at)<=Date.parse(v.observed_at)&&Date.parse(v.expires_at)-Date.parse(v.started_at)===93600000))return false;
  }
  return true;
 };
 if(action==='segmentos_listar'){
  const limit=Number(query.get('limit')||50),offset=Number(query.get('offset')||0);
  if(!exact(body,['segments','limit','offset','catalog','capabilities'])||body.limit!==limit||body.offset!==offset||!Array.isArray(body.segments)||body.segments.length>limit||!body.segments.every(segment)||new Set(body.segments.map(s=>s.id.toLowerCase())).size!==body.segments.length||!catalog(body.catalog)||!exact(body.capabilities,['draft','count','send'])||!bool(body.capabilities.draft)||!bool(body.capabilities.count)||body.capabilities.send!==false||!body.catalog.current&&(body.capabilities.draft||body.capabilities.count))denied();
 }else if(action==='segmento_obter'){
  if(!exact(body,['segment'])||!segment(body.segment)||body.segment.id.toLowerCase()!==query.get('id')?.toLowerCase())denied();
 }else denied();
 return body;
}
function validateAudienceRead(result,{brand,action,query,secrets=[]}={}){
 const finish=(status,body,sourceCapabilities)=>{
  const out=freeze({status,body,...(sourceCapabilities?{sourceCapabilities}:{})});
  metadata.set(out,{brand:['fish','aristo'].includes(brand)?brand:null,action});return out;
 };
 const denied=()=>finish(502,{error:'AUDIENCE_READ_RESPONSE_DENIED'});
 if(!['fish','aristo'].includes(brand)||!['segmentos_listar','segmento_obter'].includes(action)||!(query instanceof URLSearchParams)||!Array.isArray(secrets)||secrets.some(s=>typeof s!=='string'))return finish(400,{error:'AUDIENCE_READ_REQUEST_INVALID'});
 const keys=[...query.keys()];if(new Set(keys).size!==keys.length||query.has('brand')&&query.get('brand')!==brand||query.has('acao')&&query.get('acao')!==action)return finish(400,{error:'AUDIENCE_READ_REQUEST_INVALID'});
 if(action==='segmentos_listar'){
  for(const [key,fallback,max,min]of [['limit','50',100,1],['offset','0',10000,0]]){const v=query.get(key)??fallback;if(!/^(0|[1-9]\d*)$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)<min||Number(v)>max)return finish(400,{error:'AUDIENCE_READ_REQUEST_INVALID'});}
 }else if(!UUID.test(query.get('id')??''))return finish(400,{error:'AUDIENCE_READ_REQUEST_INVALID'});
 if(result===null||result===undefined)return finish(503,{error:'AUDIENCE_READ_SOURCE_UNAVAILABLE'});
 try{
  const r=snapshot(result,secrets);
  if(!exact(r,['status','body',...(Object.hasOwn(r,'headers')?['headers']:[])]))return denied();
  if(Object.hasOwn(r,'headers')){if(!brandRecord(r.headers)||Object.keys(r.headers).length!==1||!Object.entries(r.headers).every(([k,v])=>k.toLowerCase()==='cache-control'&&v==='no-store'))return denied();}
  if(r.status!==200){
   const errors={401:['SEGMENT_UNAUTHORIZED'],403:['SEGMENT_ACCESS_DENIED'],404:['SEGMENT_NOT_FOUND'],400:['SEGMENT_REQUEST_INVALID','SEGMENT_FIELDS','SEGMENT_ID_INVALID','SEGMENT_PAGE_INVALID'],503:['SEGMENT_SERVICE_UNAVAILABLE','SEGMENT_UNAVAILABLE','SEGMENT_SESSION_BOUNDARY']};
   if(!exact(r.body,['error'])||!errors[r.status]?.includes(r.body.error))return denied();
   return finish(r.status,{error:r.body.error});
  }
  const body=validateBody(r.body,action,brand,query);
  // Only after the original DTO is fully validated may an exact historical key
  // reference become a response-only pseudonym. Never request/auth/write identity.
  const records=action==='segmentos_listar'?body.segments:[body.segment];
  for(const record of records)if(secrets.some(secret=>secret.length&&record.updated_by==='panel:'+secret))record.updated_by='panel:sha256:'+crypto.createHash('sha256').update(record.updated_by,'utf8').digest('hex');
  // GET segmento_obter carries no capability metadata: null preserves unknown.
  const sourceCapabilities=action==='segmentos_listar'?{...body.capabilities}:{draft:null,count:null,send:false};
  if(action==='segmentos_listar')body.capabilities={draft:false,count:false,send:false};
  return finish(200,body,sourceCapabilities);
 }catch{return denied();}
}
function audienceSummary(result,{brand}={}){
 const accepted=metadata.get(result),trusted=!!accepted&&['fish','aristo'].includes(brand)&&accepted.brand===brand,ok=trusted&&result.status===200;
 const base={brand:['fish','aristo'].includes(brand)?brand:null,status:trusted?result.status:502,available:ok,countReturned:null,limit:null,offset:null,current:null,catalogHash:null,checked_at:null,availableFields:null,availableLists:null,availableProducts:null,availableOrigins:null,availableRecordedOrigins:null,originalDraftAuthorized:null,originalCountAuthorized:null,send:false,gatewayWrite:false,operational:false};
 if(!ok)return freeze(base);
 base.originalDraftAuthorized=result.sourceCapabilities.draft;base.originalCountAuthorized=result.sourceCapabilities.count;
 if(accepted.action==='segmentos_listar'){
  const b=result.body,c=b.catalog;Object.assign(base,{countReturned:b.segments.length,limit:b.limit,offset:b.offset,current:c.current,catalogHash:c.catalog_hash,checked_at:c.checked_at,availableFields:c.fields.filter(x=>x.available).length,availableLists:c.lists.filter(x=>x.available).length,availableProducts:c.products.filter(x=>x.available).length,availableOrigins:c.origins.filter(x=>x.available).length,availableRecordedOrigins:Object.hasOwn(c,'recorded_origins')?c.recorded_origins.filter(x=>x.available).length:null});
 }else Object.assign(base,{countReturned:1,current:result.body.segment.semantic_context.current});
 return freeze(base);
}
module.exports={validateAudienceRead,audienceSummary};
