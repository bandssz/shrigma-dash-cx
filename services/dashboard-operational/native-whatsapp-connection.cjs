'use strict';
const crypto=require('node:crypto');
const WABAS=Object.freeze({fish:'1809908546361438',aristo:'3800362180098479'}),GRAPH_VERSION='v21.0';
const ORIGINAL=Object.freeze({workflowId:'7gPAgpgle0bSWmoe',credentialId:'4GdnUtcDaMLS0am5',type:'httpHeaderAuth'});
const FIELDS='id,name,status,category,language,components,quality_score,rejected_reason',H=/^[a-f0-9]{64}$/;
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
function create({db,consent,identity,authorizeRead,encrypt,decrypt,mac,now=Date.now,fetchImpl=fetch}={}){
 if(!db?.prepare||[consent,identity,authorizeRead,encrypt,decrypt,mac,now,fetchImpl].some(x=>typeof x!=='function'))fail('WA_CONNECTION_CONFIG_REFUSED',500);
 db.exec(`CREATE TABLE IF NOT EXISTS shrigma_meta_wa_connection_v1(
  owner_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),
  connection_ref TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,encrypted_credential TEXT NOT NULL,
  owner_revision TEXT NOT NULL,consent_session_hash TEXT NOT NULL,linked_at INTEGER NOT NULL,
  revoked_at INTEGER,binding_mac TEXT NOT NULL,PRIMARY KEY(owner_id,brand));
  CREATE TABLE IF NOT EXISTS shrigma_meta_wa_connection_versions_v1(
   owner_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL,revision INTEGER NOT NULL,
   encrypted_previous TEXT NOT NULL,archived_at INTEGER NOT NULL,PRIMARY KEY(owner_id,brand,revision));`);
 const time=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('WA_CLOCK_REFUSED',500);return t;};
 const brandGate=brand=>{if(!Object.hasOwn(WABAS,brand))fail('WA_BRAND_REFUSED',400);return brand;};
 const digest=r=>mac(canonical([r.owner_id,r.brand,r.connection_ref,r.revision,r.encrypted_credential,r.owner_revision,r.consent_session_hash,r.linked_at,r.revoked_at,WABAS[r.brand],GRAPH_VERSION,ORIGINAL]));
 const same=(x,y)=>typeof x==='string'&&typeof y==='string'&&H.test(x)&&H.test(y)&&crypto.timingSafeEqual(Buffer.from(x,'hex'),Buffer.from(y,'hex'));
 function owner(id){const o=identity(id);if(!o||o.role!=='superadmin'||o.active!==true||o.canReadGrowth!==true||!H.test(o.revision||''))fail('WA_ORIGINAL_OWNER_REQUIRED');return o;}
 function row(ownerId,brand){brandGate(brand);const r=db.prepare('SELECT * FROM shrigma_meta_wa_connection_v1 WHERE owner_id=? AND brand=?').get(ownerId,brand);if(r&&(!Number.isSafeInteger(r.revision)||r.revision<1||!same(r.binding_mac,digest(r))))fail('WA_CONNECTION_INTEGRITY',409);return r;}
 function browser(context){const p=consent(context);if(!p||typeof p.userId!=='string'||!H.test(p.sessionHash||''))fail('WA_OWNER_SESSION_REQUIRED');return {...p,owner:owner(p.userId)};}
 function credential(r){let v;try{v=JSON.parse(decrypt(r.encrypted_credential));}catch{fail('WA_CONNECTION_INTEGRITY',409);}if(!v||typeof v.token!=='string'||v.token.length<32||Buffer.byteLength(v.token)>8192||/\s|[\x00-\x1f\x7f]/.test(v.token))fail('WA_CONNECTION_INTEGRITY',409);if(!exact(v,['token'])&&!(exact(v,['token','source','permissions'])&&v.source==='system-user-owner'&&Array.isArray(v.permissions)&&v.permissions.every(p=>typeof p==='string'&&/^[a-z][a-z0-9_]{1,80}$/.test(p))))fail('WA_CONNECTION_INTEGRITY',409);return v;}
 const view=r=>{const v=credential(r),system=v.source==='system-user-owner',permissions=system?v.permissions:[];v.token='';return {brand:r.brand,connectionRef:r.connection_ref,revision:r.revision,binding:r.binding_mac,linked:r.revoked_at===null&&identity(r.owner_id)?.revision===r.owner_revision,ownerChanged:identity(r.owner_id)?.revision!==r.owner_revision,wabaId:WABAS[r.brand],graphVersion:GRAPH_VERSION,capabilities:['templates.read'],submission:false,messages:false,original:system?null:{...ORIGINAL},source:system?'system-user-owner':'original',permissions};};
 function status(context){const p=browser(context);return {schema:'shrigma-meta-wa-connections-v1',connections:Object.keys(WABAS).map(brand=>{const r=row(p.userId,brand);return r?view(r):{brand,linked:false,wabaId:WABAS[brand],graphVersion:GRAPH_VERSION,capabilities:[],submission:false,messages:false};})};}
 function bind({context,brand,token,original,expectedRevision,connectionRef}={}){
  brandGate(brand);const p=browser(context);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision===0&&connectionRef!==undefined||expectedRevision>0&&typeof connectionRef!=='string'||!exact(original,['workflowId','credentialId','type'])||canonical(original)!==canonical(ORIGINAL)||typeof token!=='string'||token.length<32||Buffer.byteLength(token)>8192||/\s|[\x00-\x1f\x7f]/.test(token))fail('WA_ORIGINAL_BIND_INPUT_REFUSED',400);
  db.exec('BEGIN IMMEDIATE');try{
   const prior=row(p.userId,brand);if(expectedRevision===0&&prior)fail('WA_CONNECTION_ALREADY_BOUND',409);
   if(expectedRevision>0&&(!prior||prior.revision!==expectedRevision||prior.connection_ref!==connectionRef||prior.revoked_at===null))fail('WA_CONNECTION_REBIND_REFUSED',409);
   const t=time();if(prior)db.prepare('INSERT INTO shrigma_meta_wa_connection_versions_v1 VALUES(?,?,?,?,?)').run(prior.owner_id,prior.brand,prior.revision,encrypt(JSON.stringify(prior)),t);
   const r={owner_id:p.userId,brand,connection_ref:prior?.connection_ref||'meta-wa:'+brand+':'+crypto.randomUUID(),revision:expectedRevision+1,encrypted_credential:encrypt(JSON.stringify({token})),owner_revision:p.owner.revision,consent_session_hash:p.sessionHash,linked_at:t,revoked_at:null};r.binding_mac=digest(r);
   db.prepare('INSERT INTO shrigma_meta_wa_connection_v1 VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,brand) DO UPDATE SET connection_ref=excluded.connection_ref,revision=excluded.revision,encrypted_credential=excluded.encrypted_credential,owner_revision=excluded.owner_revision,consent_session_hash=excluded.consent_session_hash,linked_at=excluded.linked_at,revoked_at=NULL,binding_mac=excluded.binding_mac').run(r.owner_id,r.brand,r.connection_ref,r.revision,r.encrypted_credential,r.owner_revision,r.consent_session_hash,r.linked_at,r.revoked_at,r.binding_mac);
   db.exec('COMMIT');return view(r);
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 // One owner paste, two brand-specific ciphertexts. Provider calls are GET only;
 // nothing is saved until both fixed WABAs and the granted scope are confirmed.
 async function bindSystemUser({context,token,expectedConnections}={}){
  const p=browser(context);
  if(typeof token!=='string'||token.length<32||Buffer.byteLength(token)>8192||/\s|[\x00-\x1f\x7f]/.test(token))fail('WA_SYSTEM_TOKEN_INPUT_REFUSED',400);
  const snapshot=Object.keys(WABAS).map(brand=>{const r=row(p.userId,brand);return r?{brand,connectionRef:r.connection_ref,revision:r.revision,binding:r.binding_mac}:{brand,connectionRef:null,revision:0,binding:null};});
  const replacing=expectedConnections!==undefined;
  if(replacing&&(!Array.isArray(expectedConnections)||expectedConnections.length!==2||expectedConnections.some(x=>!exact(x,['brand','connectionRef','revision','binding']))||canonical(expectedConnections)!==canonical(snapshot)))fail('WA_CONNECTION_CHANGED',409);
  const available=()=>{const next=browser(context);if(next.userId!==p.userId||next.sessionHash!==p.sessionHash||next.owner.revision!==p.owner.revision)fail('WA_OWNER_CHANGED',409);for(const before of snapshot){const r=row(p.userId,before.brand);if(!replacing&&r)fail('WA_CONNECTION_ALREADY_BOUND',409);if((r?.revision||0)!==before.revision||(r?.binding_mac||null)!==before.binding||(r?.connection_ref||null)!==before.connectionRef)fail('WA_CONNECTION_CHANGED',409);}};
  available();
  async function read(path,fields){
   const url=new URL('https://graph.facebook.com/'+GRAPH_VERSION+'/'+path);if(fields)url.searchParams.set('fields',fields);
   let response;try{response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{accept:'application/json',Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});}catch{fail('WA_META_TOKEN_CHECK_UNAVAILABLE',503);}
   if(response.status!==200||!/application\/json/i.test(response.headers.get('content-type')||''))fail('WA_META_TOKEN_CHECK_REFUSED',400);
   let size=0,parts=[];try{for await(const chunk of response.body){size+=chunk.length;if(size>65536)fail('WA_META_TOKEN_CHECK_REFUSED',502);parts.push(Buffer.from(chunk));}const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(JSON.stringify(value).includes(token))fail('WA_META_TOKEN_CHECK_REFUSED',502);return value;}catch{fail('WA_META_TOKEN_CHECK_REFUSED',502);}finally{for(const b of parts)b.fill(0);}
  }
  try{
   const scope=await read('me/permissions');
   if(!Array.isArray(scope?.data)||scope.data.length>100||scope.paging?.next||scope.data.some(x=>!x||typeof x.permission!=='string'||!/^[a-z][a-z0-9_]{1,80}$/.test(x.permission)||!['granted','declined','expired'].includes(x.status)))fail('WA_META_SCOPE_UNCONFIRMED',400);
   const permissions=[...new Set(scope.data.filter(x=>x.status==='granted').map(x=>x.permission))].sort();
   if(!permissions.includes('whatsapp_business_management'))fail('WA_META_MANAGEMENT_SCOPE_REQUIRED',400);
   for(const id of Object.values(WABAS)){const waba=await read(id,'id');if(waba?.id!==id)fail('WA_META_WABA_UNCONFIRMED',400);}
   available();db.exec('BEGIN IMMEDIATE');try{
    available();const t=time(),rows=[];
    for(const brand of Object.keys(WABAS)){
     const prior=row(p.userId,brand);
     if(prior){const metadata={owner_id:prior.owner_id,brand,connection_ref:prior.connection_ref,revision:prior.revision,linked_at:prior.linked_at,revoked_at:prior.revoked_at,supersededAt:t,tokenDiscarded:true};db.prepare('INSERT INTO shrigma_meta_wa_connection_versions_v1 VALUES(?,?,?,?,?)').run(p.userId,brand,prior.revision,encrypt(JSON.stringify(metadata)),t);}
     const r={owner_id:p.userId,brand,connection_ref:prior?.connection_ref||'meta-wa:'+brand+':'+crypto.randomUUID(),revision:(prior?.revision||0)+1,encrypted_credential:encrypt(JSON.stringify({token,source:'system-user-owner',permissions})),owner_revision:p.owner.revision,consent_session_hash:p.sessionHash,linked_at:t,revoked_at:null};r.binding_mac=digest(r);
     db.prepare('INSERT INTO shrigma_meta_wa_connection_v1 VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,brand) DO UPDATE SET revision=excluded.revision,encrypted_credential=excluded.encrypted_credential,owner_revision=excluded.owner_revision,consent_session_hash=excluded.consent_session_hash,linked_at=excluded.linked_at,revoked_at=NULL,binding_mac=excluded.binding_mac').run(r.owner_id,r.brand,r.connection_ref,r.revision,r.encrypted_credential,r.owner_revision,r.consent_session_hash,r.linked_at,r.revoked_at,r.binding_mac);rows.push(r);
    }
    const result={schema:'shrigma-meta-wa-connections-v1',connections:rows.map(view)};db.exec('COMMIT');return result;
   }catch(e){db.exec('ROLLBACK');throw e;}
  }finally{token='';}
 }
 function revoke({context,brand,connectionRef,expectedRevision}={}){brandGate(brand);const p=browser(context);db.exec('BEGIN IMMEDIATE');try{const r=row(p.userId,brand);if(!r||r.connection_ref!==connectionRef||r.revision!==expectedRevision)fail('WA_CONNECTION_CHANGED',409);if(r.revoked_at===null){const next={...r,revoked_at:time()};db.prepare('UPDATE shrigma_meta_wa_connection_v1 SET revoked_at=?,binding_mac=? WHERE owner_id=? AND brand=?').run(next.revoked_at,digest(next),p.userId,brand);r.revoked_at=next.revoked_at;r.binding_mac=digest(next);}db.exec('COMMIT');return view(r);}catch(e){db.exec('ROLLBACK');throw e;}}
 function resolve({context,brand}={}){
  brandGate(brand);const p=authorizeRead(context,{brand});if(!p||typeof p.ownerId!=='string'||typeof p.userId!=='string'||!H.test(p.revision||''))fail('WA_READ_AUTHORITY_REFUSED');
  const o=owner(p.ownerId),r=row(p.ownerId,brand);if(!r||r.revoked_at!==null)fail('WA_ORIGINAL_CONNECTION_UNAVAILABLE',503);if(r.owner_revision!==o.revision)fail('WA_ORIGINAL_OWNER_CHANGED',409);
  function assertCurrent(){const next=authorizeRead(context,{brand});if(!next||canonical(next)!==canonical(p))fail('WA_READER_CHANGED',409);const currentOwner=owner(p.ownerId),current=row(p.ownerId,brand);if(!current||current.revoked_at!==null||current.owner_revision!==currentOwner.revision||current.binding_mac!==r.binding_mac)fail('WA_CONNECTION_CHANGED',409);}
  async function listTemplates({after}={}){
   if(after!==undefined&&(typeof after!=='string'||after.length<1||Buffer.byteLength(after)>4096||/[\x00-\x20\x7f]/.test(after)))fail('WA_CURSOR_REFUSED',400);
   assertCurrent();const privateValue=credential(r);
   const url=new URL('https://graph.facebook.com/'+GRAPH_VERSION+'/'+WABAS[brand]+'/message_templates');url.searchParams.set('fields',FIELDS);url.searchParams.set('limit','100');if(after!==undefined)url.searchParams.set('after',after);
   let response;try{response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{accept:'application/json',Authorization:'Bearer '+privateValue.token},signal:AbortSignal.timeout(15000)});}catch{fail('WA_META_READ_UNAVAILABLE',503);}finally{privateValue.token='';}
   if(response.status!==200)fail('WA_META_READ_UNAVAILABLE',503);if(!/application\/json/i.test(response.headers.get('content-type')||''))fail('WA_META_RESPONSE_REFUSED',502);
   let size=0,parts=[];try{for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024){await response.body.cancel?.().catch(()=>{});fail('WA_META_RESPONSE_TOO_LARGE',502);}parts.push(Buffer.from(chunk));}}catch(e){if(e.code==='WA_META_RESPONSE_TOO_LARGE')throw e;fail('WA_META_READ_UNAVAILABLE',503);}
   let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('WA_META_RESPONSE_REFUSED',502);}if(!body||!Array.isArray(body.data)||body.data.length>100||body.data.some(x=>!x||typeof x.id!=='string'||!/^\d{1,30}$/.test(x.id)||typeof x.name!=='string'||typeof x.status!=='string'||typeof x.category!=='string'||typeof x.language!=='string'||!Array.isArray(x.components)))fail('WA_META_RESPONSE_REFUSED',502);
   if(body.paging!==undefined&&(!body.paging||Object.getPrototypeOf(body.paging)!==Object.prototype)||body.paging&&Object.hasOwn(body.paging,'next')&&(typeof body.paging.next!=='string'||body.paging.next.length<1))fail('WA_META_PAGINATION_UNCONFIRMED',502);
   const hasMore=typeof body.paging?.next==='string',next=hasMore?body.paging?.cursors?.after:null;if(hasMore&&(typeof next!=='string'||next.length<1||Buffer.byteLength(next)>4096||/[\x00-\x20\x7f]/.test(next)||next===after))fail('WA_META_PAGINATION_UNCONFIRMED',502);
   assertCurrent();return {schema:'shrigma-meta-wa-template-page-v1',brand,connectionRef:r.connection_ref,connectionRevision:r.revision,binding:r.binding_mac,wabaId:WABAS[brand],graphVersion:GRAPH_VERSION,observedAtUtc:new Date(time()).toISOString(),templates:body.data.map(x=>({id:x.id,name:x.name,status:x.status,category:x.category,language:x.language,components:x.components,quality_score:x.quality_score??null,rejected_reason:x.rejected_reason??null})),hasMore,nextCursor:next,mirrorWrites:0,submission:false,messages:false};
  }
  async function inspectToken(){
   assertCurrent();const privateValue=credential(r),url=new URL('https://graph.facebook.com/'+GRAPH_VERSION+'/debug_token');url.searchParams.set('input_token',privateValue.token);
   let response;try{response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{accept:'application/json',Authorization:'Bearer '+privateValue.token},signal:AbortSignal.timeout(15000)});}catch{fail('WA_META_INTROSPECTION_UNAVAILABLE',503);}finally{privateValue.token='';url.search='';}
   if(response.status!==200)fail('WA_META_INTROSPECTION_UNCONFIRMED',503);if(!/application\/json/i.test(response.headers.get('content-type')||''))fail('WA_META_INTROSPECTION_UNCONFIRMED',502);
   let size=0,parts=[],data;try{for await(const chunk of response.body){size+=chunk.length;if(size>65536)fail('WA_META_INTROSPECTION_UNCONFIRMED',502);parts.push(Buffer.from(chunk));}data=JSON.parse(Buffer.concat(parts).toString('utf8')).data;}catch{fail('WA_META_INTROSPECTION_UNCONFIRMED',502);}finally{for(const b of parts)b.fill(0);}
   if(!data||typeof data.is_valid!=='boolean'||!['SYSTEM_USER','USER','PAGE','APP'].includes(data.type)||!Array.isArray(data.scopes)||data.scopes.length>100||data.scopes.some(x=>typeof x!=='string'||!/^[a-z][a-z0-9_]{1,80}$/.test(x)))fail('WA_META_INTROSPECTION_UNCONFIRMED',502);
   const expiry=value=>value===undefined?null:Number.isSafeInteger(value)&&value>=0?value:fail('WA_META_INTROSPECTION_UNCONFIRMED',502),expiresAt=expiry(data.expires_at),dataAccessExpiresAt=expiry(data.data_access_expires_at);assertCurrent();
   return {schema:'shrigma-meta-wa-token-metadata-v1',brand,connectionRef:r.connection_ref,connectionRevision:r.revision,wabaId:WABAS[brand],isValid:data.is_valid,type:data.type,expiresAt,dataAccessExpiresAt,expiryConfirmed:expiresAt!==null,scopes:[...new Set(data.scopes)].sort(),observedAtUtc:new Date(time()).toISOString(),mirrorWrites:0,submission:false,messages:false};
  }
  return Object.freeze({...view(r),assertCurrent,listTemplates,inspectToken});
 }
 function authorizeOwnerRead(context){const p=authorizeRead(context,{brand:'fish'});if(!p||p.userId!==p.ownerId)fail('WA_ORIGINAL_OWNER_REQUIRED');owner(p.userId);return true;}
 return Object.freeze({status,bind,bindSystemUser,revoke,resolve,authorizeOwnerRead});
}
module.exports=Object.freeze({create,WABAS,GRAPH_VERSION,ORIGINAL,FIELDS});
