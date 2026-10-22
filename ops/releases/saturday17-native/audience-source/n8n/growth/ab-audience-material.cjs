'use strict';
// Private, pure shadow contract. Input is a complete database snapshot supplied
// by a trusted reader, never a client claim. This module performs no I/O.
const {createHash}=require('node:crypto');
const {types}=require('node:util');
const VERSION='crm-ab-audience-material-v1';
const HASH_CONTRACT='json-utf8-key-order-safe-integer-sha256-v1';
const LIMITS=Object.freeze({bytes:8*1024*1024,dependencies:1000,depth:32,nodes:300000});
const OPERATIONAL_CAMPAIGN_FIELDS=Object.freeze(['status','sent','to_send','max_subscriber_id','last_subscriber_id','started_at','updated_at']);
const REQUIRED_FIELDS=Object.freeze({
 campaign:Object.freeze(['id','uuid','name','subject','from_email','body','body_source','altbody','content_type','send_at','headers','attribs','status','tags','type','messenger','template_id','to_send','sent','max_subscriber_id','last_subscriber_id','archive','archive_slug','archive_template_id','archive_meta','started_at','created_at','updated_at']),
 template:Object.freeze(['id','name','type','subject','body','body_source','is_default','created_at','updated_at']),
 list:Object.freeze(['id','uuid','name','type','optin','status','tags','description','created_at','updated_at']),
 list_relation:Object.freeze(['id','campaign_id','list_id','list_name']),
 media:Object.freeze(['id','uuid','provider','filename','content_type','thumb','meta','created_at']),
 media_relation:Object.freeze(['campaign_id','media_id','filename'])
});
const FLAGS=Object.freeze({authorizes_selection:false,authorizes_send:false,execution_blocked:true,external_dependencies_complete:false});
const fail=code=>Object.assign(new Error(code),{code});
const own=(v,k)=>Object.hasOwn(v,k);
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const text=v=>typeof v==='string';
const nullableText=v=>v===null||text(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>own(v,k));
const requireFields=(v,keys)=>record(v)&&keys.every(k=>own(v,k));
const utf8Order=(a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));

// Encode explicitly rather than invoking toJSON/getters or accepting silent
// JSON coercions. Fractions are refused because parsed JSON cannot establish
// arbitrary PostgreSQL numeric precision. The database reader must first use
// parseDatabaseSnapshot() on text, before driver JSON decoding can round it.
// No per-string 32 KiB limit exists.
function canonical(value){
 let bytes=0,nodes=0;const chunks=[],active=new Set();
 const emit=s=>{bytes+=Buffer.byteLength(s,'utf8');if(bytes>LIMITS.bytes)throw fail('AB_MATERIAL_LIMIT');chunks.push(s);};
 function string(s){
  if(s.length>LIMITS.bytes)throw fail('AB_MATERIAL_LIMIT');
  for(let i=0;i<s.length;i++){
   const u=s.charCodeAt(i);
   if(u===0)throw fail('AB_MATERIAL_JSON');
   if(u>=0xd800&&u<=0xdbff){const next=s.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw fail('AB_MATERIAL_JSON');}
   else if(u>=0xdc00&&u<=0xdfff)throw fail('AB_MATERIAL_JSON');
  }
  return JSON.stringify(s);
 }
 function visit(v,depth){
  if(++nodes>LIMITS.nodes||depth>LIMITS.depth)throw fail('AB_MATERIAL_LIMIT');
  if(v===null||typeof v==='boolean'){emit(JSON.stringify(v));return;}
  if(typeof v==='string'){emit(string(v));return;}
  if(typeof v==='number'){
   if(!Number.isSafeInteger(v)||Object.is(v,-0))throw fail('AB_MATERIAL_JSON');
   emit(String(v));return;
  }
  if(!v||typeof v!=='object'||types.isProxy(v))throw fail('AB_MATERIAL_JSON');
  const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)throw fail('AB_MATERIAL_JSON');
  if(active.has(v))throw fail('AB_MATERIAL_JSON');
  const keys=Reflect.ownKeys(v),values=new Map();
  for(const key of keys){
   if(typeof key!=='string')throw fail('AB_MATERIAL_JSON');
   const d=Object.getOwnPropertyDescriptor(v,key);
   if(!d||!own(d,'value')||(!array||key!=='length')&&!d.enumerable)throw fail('AB_MATERIAL_JSON');
   string(key);values.set(key,d.value);
  }
  active.add(v);
  if(array){
   const length=values.get('length');
   if(!Number.isSafeInteger(length)||length<0||length>LIMITS.nodes||keys.length!==length+1||keys.some(k=>k!=='length'&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=length)))throw fail('AB_MATERIAL_JSON');
   emit('[');for(let i=0;i<length;i++){if(i)emit(',');visit(values.get(String(i)),depth+1);}emit(']');
  }else{
   emit('{');for(const [i,key]of keys.sort(utf8Order).entries()){if(i)emit(',');emit(string(key));emit(':');visit(values.get(key),depth+1);}emit('}');
  }
  active.delete(v);
 }
 visit(value,0);return chunks.join('');
}
// Validate original numeric tokens before JSON.parse can round decimal JSON
// into an apparently safe integer. Reject duplicate keys, too (including
// differently escaped keys), instead of accepting JSON.parse's last key wins.
function parseDatabaseSnapshot(source){
 if(typeof source!=='string')throw fail('AB_MATERIAL_JSON');
 if(Buffer.byteLength(source,'utf8')>LIMITS.bytes)throw fail('AB_MATERIAL_LIMIT');
 let offset=0,nodes=0;
 const invalid=()=>{throw fail('AB_MATERIAL_JSON');};
 const whitespace=()=>{while(offset<source.length&&/[\x20\t\r\n]/.test(source[offset]))offset++;};
 function string(){
  const start=offset++;while(offset<source.length){const c=source[offset++];
   if(c==='"')return source.slice(start,offset);
   if(c.charCodeAt(0)<32)invalid();
   if(c==='\\'){
    const escape=source[offset++];
    if(escape==='u'){if(!/^[0-9a-fA-F]{4}$/.test(source.slice(offset,offset+4)))invalid();offset+=4;}
    else if(!['"','\\','/','b','f','n','r','t'].includes(escape))invalid();
   }
  }
  invalid();
 }
 function value(depth){
  if(++nodes>LIMITS.nodes||depth>LIMITS.depth)throw fail('AB_MATERIAL_LIMIT');
  whitespace();const c=source[offset];
  if(c==='"'){string();return;}
  if(c==='{'||c==='['){
   const object=c==='{',end=object?'}':']',keys=new Set();offset++;whitespace();
   if(source[offset]===end){offset++;return;}
   for(;;){
    if(object){if(source[offset]!=='"')invalid();const key=JSON.parse(string());if(keys.has(key))invalid();keys.add(key);whitespace();if(source[offset++]!==':')invalid();}
    value(depth+1);whitespace();const separator=source[offset++];if(separator===end)return;if(separator!==',')invalid();whitespace();
   }
  }
  for(const literal of ['true','false','null'])if(source.startsWith(literal,offset)){offset+=literal.length;return;}
  const start=offset;if(source[offset]==='-')offset++;
  if(source[offset]==='0')offset++;
  else if(/[1-9]/.test(source[offset]||'')){while(/[0-9]/.test(source[offset]||''))offset++;}
  else invalid();
  const token=source.slice(start,offset),number=Number(token);
  if(!Number.isSafeInteger(number)||Object.is(number,-0))invalid();
  // Fractions, exponents and leading zeroes leave an invalid delimiter;
  // none can reach JSON.parse and silently change the numeric identity.
 }
 value(0);whitespace();if(offset!==source.length)invalid();
 const parsed=JSON.parse(source);canonical(parsed);return parsed;
}
const digest=value=>createHash('sha256').update(canonical(value),'utf8').digest('hex');
function freeze(value){if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;}
// PostgreSQL to_jsonb(timestamptz) emits an ISO timestamp with an offset, and
// fixtures may emit UTC Z. Validate rather than normalize retained timestamps.
function stamp(v){
 if(typeof v!=='string')return false;
 const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.exec(v);
 if(!m||!Number.isFinite(Date.parse(v)))return false;
 const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 return year>0&&month>=1&&month<=12&&day>=1&&day<=days[month-1]&&Number(m[4])<24&&Number(m[5])<60&&Number(m[6])<60;
}
const nullableStamp=v=>v===null||stamp(v);
function validateOperational(c){
 if(!['draft','scheduled','running','paused','cancelled','finished'].includes(c.status)||!own(c,'sent')||!own(c,'started_at')||!own(c,'updated_at'))throw fail('AB_MATERIAL_SNAPSHOT');
 for(const key of ['sent','to_send','max_subscriber_id','last_subscriber_id'])if(own(c,key)&&(!Number.isSafeInteger(c[key])||c[key]<0||c[key]>2147483647))throw fail('AB_MATERIAL_SNAPSHOT');
 for(const key of ['started_at','updated_at'])if(c[key]!==null&&!stamp(c[key]))throw fail('AB_MATERIAL_SNAPSHOT');
}
function normalize(input,scope){
 // Validate even the excluded operational fields before copying: getters,
 // non-JSON and oversized values cannot hide inside a field later discarded.
 const raw=JSON.parse(canonical(input)),bound=JSON.parse(canonical(scope));
 if(!exact(bound,['brand','campaignId'])||!['fish','aristo'].includes(bound.brand)||!positive(bound.campaignId))throw fail('AB_MATERIAL_SCOPE');
 if(!exact(raw,['campaign','lists','media','template']))throw fail('AB_MATERIAL_SNAPSHOT');
 const c=raw.campaign,t=raw.template;
 if(!requireFields(c,REQUIRED_FIELDS.campaign)||
  !positive(c.id)||c.id!==bound.campaignId||!record(c.attribs)||!record(c.attribs.crm)||c.attribs.crm.policy!=='crm-campaign-v1'||c.attribs.crm.brand!==bound.brand)throw fail('AB_MATERIAL_SCOPE');
 if(!uuid(c.uuid)||!['name','subject','from_email','body','content_type','messenger','type'].every(k=>text(c[k]))||!nullableText(c.altbody)||!nullableText(c.body_source)||!nullableText(c.archive_slug)||!nullableStamp(c.created_at)||
  c.type!=='regular'||c.messenger!=='email'||!['richtext','html','plain','markdown','visual'].includes(c.content_type)||
  !(c.send_at===null||stamp(c.send_at))||!Array.isArray(c.headers)||c.headers.some(h=>!record(h)||Object.values(h).some(v=>!text(v)))||
  !(c.tags===null||Array.isArray(c.tags)&&c.tags.every(text))||typeof c.archive!=='boolean')throw fail('AB_MATERIAL_SNAPSHOT');
 validateOperational(c);
 if(!positive(c.template_id)||!requireFields(t,REQUIRED_FIELDS.template)||t.id!==c.template_id||!text(t.name)||!text(t.subject)||!text(t.body)||!nullableText(t.body_source)||typeof t.is_default!=='boolean'||!nullableStamp(t.created_at)||!nullableStamp(t.updated_at)||t.type!=='campaign')throw fail('AB_MATERIAL_TEMPLATE');
 if(own(c,'archive_template_id')&&c.archive_template_id!==null)throw fail('AB_MATERIAL_TEMPLATE');
 if(!Array.isArray(raw.lists)||!raw.lists.length||!Array.isArray(raw.media))throw fail('AB_MATERIAL_DEPENDENCY');
 if(raw.lists.length+raw.media.length+1>LIMITS.dependencies)throw fail('AB_MATERIAL_LIMIT');
 const listIds=new Set(),mediaIds=new Set();
 for(const entry of raw.lists){
  if(!exact(entry,['relation','list']))throw fail('AB_MATERIAL_DEPENDENCY');
  const r=entry.relation,l=entry.list;
  if(!requireFields(r,REQUIRED_FIELDS.list_relation)||!Number.isSafeInteger(r.id)||r.id<1||r.campaign_id!==c.id||!positive(r.list_id)||!text(r.list_name)||
   !requireFields(l,REQUIRED_FIELDS.list)||l.id!==r.list_id||!uuid(l.uuid)||!text(l.name)||!text(l.description)||!['public','private','temporary'].includes(l.type)||!nullableStamp(l.created_at)||!nullableStamp(l.updated_at)||!['active','archived'].includes(l.status)||!['single','double'].includes(l.optin)||
   !(l.tags===null||Array.isArray(l.tags)&&l.tags.every(text))||listIds.has(l.id))throw fail('AB_MATERIAL_DEPENDENCY');
  listIds.add(l.id);
 }
 for(const entry of raw.media){
  if(!exact(entry,['relation','media']))throw fail('AB_MATERIAL_DEPENDENCY');
  const r=entry.relation,m=entry.media;
  if(!requireFields(r,REQUIRED_FIELDS.media_relation)||r.campaign_id!==c.id||!positive(r.media_id)||!text(r.filename)||
   !requireFields(m,REQUIRED_FIELDS.media)||m.id!==r.media_id||!uuid(m.uuid)||!['filename','provider','content_type','thumb'].every(k=>text(m[k]))||!nullableStamp(m.created_at)||mediaIds.has(m.id))throw fail('AB_MATERIAL_DEPENDENCY');
  mediaIds.add(m.id);
 }
 raw.lists.sort((a,b)=>a.relation.list_id-b.relation.list_id);
 raw.media.sort((a,b)=>a.relation.media_id-b.relation.media_id);
 for(const key of OPERATIONAL_CAMPAIGN_FIELDS)delete c[key];
 const result={contract:VERSION,brand:bound.brand,campaign_id:c.id,snapshot:raw};
 // Bound the final envelope, too: source bytes and normalized material each
 // must fit the same budget. Unknown row columns are intentionally retained.
 canonical(result);return freeze(result);
}
function hash(input,scope){return digest(normalize(input,scope));}
function materialize(input,scope){const normal=normalize(input,scope);return freeze({...normal,material_hash:digest(normal),...FLAGS});}
module.exports={VERSION,HASH_CONTRACT,LIMITS,OPERATIONAL_CAMPAIGN_FIELDS,REQUIRED_FIELDS,FLAGS,ENABLED:false,parseDatabaseSnapshot,canonical,digest,normalize,hash,materialize};
