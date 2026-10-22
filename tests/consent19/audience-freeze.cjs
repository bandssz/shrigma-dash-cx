'use strict';
// Candidate boundary only. The caller must supply the current original source
// reader and transaction. Nothing creates a connection, worker or credential.
const crypto=require('node:crypto');
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&Object.getPrototypeOf(v)===Object.prototype?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
const HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTION='segmento_congelar_nativo_interno',RECOVER='segmento_congelamento_nativo_obter',RECONCILE='segmento_reconciliar_congelamento_nativo';
const fields=['acao','brand','id','expected_version','expected_definition_hash','expected_context_hash','expected_catalog_hash','idempotency_key'];
const bodyFields=['contract','brand','audience_id','audience_version','definition_hash','list_id','list_uuid','eligible_count','members_sha256','checked_at','schedules','sends','internal_test','source_operation_sha256'];
const bodyFieldsV3=bodyFields.filter(k=>k!=='internal_test').concat(['list_optin','members_state_sha256','members_identity_sha256','members_meta_sha256','base','origins','frozen_at']);
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=(code,status=503)=>{throw Object.assign(Error(code),{code,status});};
const SQL='SELECT crm_audience_v2.freeze_native_internal_saved_audience_20261017($1::text,$2::text,$3::uuid,$4::integer,$5::text,$6::text,$7::text,$8::jsonb,$9::jsonb,$10::text,$11::text) AS result';
function validateRequest(p){if(!exact(p,fields)||p.acao!==ACTION||!['fish','aristo'].includes(p.brand)||!UUID.test(p.id||'')||!Number.isSafeInteger(p.expected_version)||p.expected_version<1||p.expected_version>999999999||!['expected_definition_hash','expected_context_hash','expected_catalog_hash'].every(k=>HEX.test(p[k]||''))||!/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key||''))fail('NATIVE_FREEZE_INPUT',400);return JSON.parse(canonical(p));}
function reconciliationRequest(p){if(!exact(p,[...fields,'confirm'])||p.acao!==RECONCILE||p.confirm!=='reconciliar_intencao_original')fail('NATIVE_FREEZE_INPUT',400);const original={...p,acao:ACTION};delete original.confirm;return validateRequest(original);}
function receipt(value,p){const b=value?._body;
 if(b?.contract==='crm-native-frozen-internal-list-v2'){
  if(!exact(value,['_http','_body'])||value._http!==200||!exact(b,bodyFields)||b.brand!==p.brand||b.audience_id!==p.id||b.audience_version!==p.expected_version||b.definition_hash!==p.expected_definition_hash||!Number.isSafeInteger(b.list_id)||b.list_id<1||b.list_id>2147483647||!UUID.test(b.list_uuid||'')||b.eligible_count!==1||b.members_sha256!==digest([26948228])||b.internal_test!==true||(b.source_operation_sha256!==null&&(typeof b.source_operation_sha256!=='string'||!HEX.test(b.source_operation_sha256)))||typeof b.checked_at!=='string'||!Number.isFinite(Date.parse(b.checked_at))||b.schedules!==false||b.sends!==false)fail('NATIVE_FREEZE_READBACK');
 }else{
  const validList=l=>exact(l,['id','uuid','optin','status'])&&Number.isSafeInteger(l.id)&&l.id>0&&l.id<=2147483647&&UUID.test(l.uuid||'')&&['single','double'].includes(l.optin)&&l.status==='active';
  if(!exact(value,['_http','_body'])||value._http!==200||!exact(b,bodyFieldsV3)||b.contract!=='crm-native-frozen-list-v3'||!UUID.test(b.audience_id||'')||!Number.isSafeInteger(b.audience_version)||b.audience_version<1||b.audience_version>999999999||!HEX.test(b.definition_hash||'')||b.brand!==p.brand||b.audience_id!==p.id||b.audience_version!==p.expected_version||b.definition_hash!==p.expected_definition_hash||!Number.isSafeInteger(b.list_id)||b.list_id<1||b.list_id>2147483647||!UUID.test(b.list_uuid||'')||!Number.isSafeInteger(b.eligible_count)||b.eligible_count<1||!['members_sha256','members_state_sha256','members_identity_sha256','members_meta_sha256'].every(k=>HEX.test(b[k]||''))||!validList(b.base)||b.base.id!==(b.brand==='aristo'?16:17)||b.list_optin!==b.base.optin||!Array.isArray(b.origins)||!b.origins.length||b.origins.length>33||!b.origins.every(validList)||new Set(b.origins.map(l=>l.id)).size!==b.origins.length||b.origins.some((l,i)=>i&&l.id<=b.origins[i-1].id)||!b.origins.some(l=>canonical(l)===canonical(b.base))||b.origins.some(l=>l.id===b.list_id)||!['checked_at','frozen_at'].every(k=>typeof b[k]==='string'&&Number.isFinite(Date.parse(b[k])))||(b.source_operation_sha256!==null&&!HEX.test(b.source_operation_sha256||''))||b.schedules!==false||b.sends!==false)fail('NATIVE_FREEZE_READBACK');
 }
 return JSON.parse(canonical(value));
}
function stored(row,brand,key){if(!row||row.brand!==brand||row.payload?.idempotency_key!==key)fail('NATIVE_FREEZE_REQUEST_CONFLICT',409);let p;try{p=validateRequest(row.payload);}catch{fail('NATIVE_FREEZE_REQUEST_CONFLICT',409);}if(p.brand!==brand||row.payload_hash!==digest(p))fail('NATIVE_FREEZE_REQUEST_CONFLICT',409);return{payload:p,receipt:receipt(row.response,p)};}
function createInternalFreeze({transaction,source}={}){
 if(typeof transaction!=='function'||!source?.SQL||['readAuth','readCatalog','readDefinition','pins'].some(k=>typeof source[k]!=='function'))fail('NATIVE_FREEZE_CONFIG');
 async function within({key,signal},fn){if(typeof key!=='string'||!/^[a-z0-9-]{8,128}$/.test(key))fail('NATIVE_FREEZE_INPUT',400);return transaction(async tx=>{
  const query=async(text,values=[])=>{if(signal?.aborted)fail('NATIVE_FREEZE_ABORTED');const r=await tx.query(text,values);if(signal?.aborted)fail('NATIVE_FREEZE_ABORTED');if(!Array.isArray(r?.rows))fail('NATIVE_FREEZE_READBACK');return r;};
  await query(source.SQL.setup);const boundary=(await query(source.SQL.boundary)).rows[0];if(boundary?.isolation!=='read committed'||!(Number(boundary.timeout_ms)>0&&Number(boundary.timeout_ms)<=30000))fail('NATIVE_FREEZE_BOUNDARY');
  const first=await source.readAuth(query,key,'draft');const reauth=async()=>{const current=await source.readAuth(query,key,'draft');if(current.actor!==first.actor||!['read_content','draft','validate','submit'].every(c=>current.caps.includes(c)))fail('NATIVE_FREEZE_ACCESS_CHANGED',403);};await reauth();return fn({query,reauth,actor:first.actor});
 },{readOnly:false,isolation:'read committed',signal});}
 async function recover({key,request:p,signal}={}){
  if(!exact(p,['acao','brand','idempotency_key'])||p.acao!==RECOVER||!['fish','aristo'].includes(p.brand)||!/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key||''))fail('NATIVE_FREEZE_INPUT',400);
  return within({key,signal},async({query,reauth,actor})=>{const rows=(await query(source.SQL.operation,[actor,p.idempotency_key])).rows;if(rows.length>1)fail('NATIVE_FREEZE_READBACK');await reauth();if(!rows.length)return{_http:404,_body:{error:'NATIVE_FREEZE_NOT_OBSERVED',state:'unconfirmed',idempotency_key:p.idempotency_key}};return stored(rows[0],p.brand,p.idempotency_key).receipt;});
 }
 async function execute({key,request:value,signal}={}){const p=validateRequest(value),payloadHash=digest(p);return within({key,signal},async({query,reauth,actor})=>{
  await query(source.SQL.lock,[actor,p.idempotency_key]);await reauth();const old=(await query(source.SQL.operation,[actor,p.idempotency_key])).rows;if(old.length>1)fail('NATIVE_FREEZE_READBACK');if(old.length){const existing=stored(old[0],p.brand,p.idempotency_key);if(digest(existing.payload)!==payloadHash)fail('NATIVE_FREEZE_REQUEST_CONFLICT',409);await reauth();return existing.receipt;}
  const before=await source.readCatalog(query,p.brand);await reauth();if(!before.ready||!before.catalog.current||before.catalog.catalog_hash!==p.expected_catalog_hash)fail('NATIVE_FREEZE_CATALOG_CHANGED',409);
  const saved=await source.readDefinition(query,{brand:p.brand,id:p.id});if(!saved||saved.archived||saved.version!==p.expected_version||saved.definition_hash!==p.expected_definition_hash||saved.context_hash!==p.expected_context_hash||digest(saved.definition)!==saved.definition_hash||digest(saved.context)!==saved.context_hash)fail('NATIVE_FREEZE_AUDIENCE_CHANGED',409);const current=source.pins(saved.definition,before);if(digest(current)!==saved.context_hash)fail('NATIVE_FREEZE_AUDIENCE_CHANGED',409);await reauth();
  // This operation is synchronous and set-based. Its local SQL deadline does
  // not widen the pool/default deadline used by other audience operations.
  await query("SELECT pg_catalog.set_config('statement_timeout','25000ms',true)");
  const rows=(await query(SQL,[key,p.brand,p.id,p.expected_version,p.expected_definition_hash,p.expected_context_hash,p.expected_catalog_hash,JSON.stringify(before.catalog),JSON.stringify(current),p.idempotency_key,payloadHash])).rows;if(rows.length!==1)fail('NATIVE_FREEZE_READBACK');const result=receipt(rows[0].result,p);
  // Exclude exactly this transaction's new list; retain every other delta.
  const finalQuery=async(text,values)=>{const r=await query(text,values);return text===source.SQL.lists?{...r,rows:r.rows.filter(x=>x.id!==result._body.list_id)}:r;};const after=await source.readCatalog(finalQuery,p.brand);await reauth();if(!after.ready||after.metadataSnapshot!==before.metadataSnapshot||after.config_revision!==before.config_revision||after.expires_at!==before.expires_at||after.catalog.catalog_hash!==before.catalog.catalog_hash||digest(source.pins(saved.definition,after))!==saved.context_hash)fail('NATIVE_FREEZE_CATALOG_CHANGED',409);return result;
 });}
 // Explicit reconciliation acquires the SAME source advisory lock and checks
 // the original immutable receipt before any effect. It never changes the key.
 const reconcile=({key,request,signal}={})=>execute({key,request:reconciliationRequest(request),signal});
 return Object.freeze({execute,recover,reconcile});
}
module.exports={createInternalFreeze,SQL,ACTION,RECOVER,RECONCILE,digest,validateRequest,reconciliationRequest,receipt};
