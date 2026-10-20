'use strict';
const FreezeDependency=(()=>{const module={exports:{}};
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

return module.exports;})();
const Source=(()=>{const module={exports:{}};
'use strict';
// Runs inside the original Campaigns service, where API16 already lives.
// All returned member data is reduced to IDs, UUIDs and membership state.
const crypto=require('node:crypto');
const Freeze=FreezeDependency;
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
const canonical=o=>Array.isArray(o)?'['+o.map(canonical).join(',')+']':plain(o)?'{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}':JSON.stringify(o);
const sha=o=>crypto.createHash('sha256').update(canonical(o)).digest('hex');
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s),id=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const fail=code=>{throw Object.assign(Error(code),{code});};
const data=r=>{if(r?.status!==200||!plain(r.body)||!Object.hasOwn(r.body,'data'))fail('CONSENT_NATIVE_UNCONFIRMED');return r.body.data;};
function originIds(definition,base){
 const out=new Set([base]);let nodes=0;
 function walk(rule,depth){if(++nodes>32||depth>4||!plain(rule))fail('CONSENT_ORIGIN_UNCONFIRMED');if(rule.op==='in_list'){if(!id(rule.list_id))fail('CONSENT_ORIGIN_UNCONFIRMED');out.add(rule.list_id);return;}if(['and','or'].includes(rule.op)){if(!Array.isArray(rule.rules)||!rule.rules.length||rule.rules.length>16)fail('CONSENT_ORIGIN_UNCONFIRMED');rule.rules.forEach(x=>walk(x,depth+1));return;}if(rule.op!=='condition')fail('CONSENT_ORIGIN_UNCONFIRMED');}
 walk(definition.rule,0);return [...out].sort((a,b)=>a-b);
}
function createSource({campaignRead,audienceRead,audienceCount,api,sign,verify,scope,now=Date.now}){
 if(![campaignRead,audienceRead,audienceCount,api,sign,verify,now].every(f=>typeof f==='function'))throw Error('CONSENT_SOURCE_CONFIG');
 async function native(resource,fields={}){return data(await api({resource,...fields}));}
 async function operation(brand,key){
  const r=await campaignRead({acao:'campanha_operacao',brand,idempotency_key:key}),o=r?.body?.operation,c=o?.response?.body?.campaign;
  if(r?.status!==200||o?.state!=='succeeded'||o.action!=='salvar'||o.brand!==brand||o.operation_key!==key||o.response?.status!==201||!uuid(o.id)||o.response.body.operation_id!==o.id||!id(o.providerId)||c?.id!==o.providerId||c.status!=='draft'||c.sent!==0||c.started_at!==null||c.send_at!==null||c.definition?.send_at!==null||c.definition.brand!==brand||!Array.isArray(c.definition.list_ids)||c.definition.list_ids.length!==1)fail('CONSENT_CREATE_UNCONFIRMED');
  return{o,c,receipt:sha(o)};
 }
 async function list(listId,expectedUuid){const l=await native('list',{id:listId});if(l?.id!==listId||!uuid(l.uuid)||expectedUuid&&l.uuid!==expectedUuid||!['single','double'].includes(l.optin)||!['active','archived'].includes(l.status))fail('CONSENT_LIST_UNCONFIRMED');return{id:l.id,uuid:l.uuid,optin:l.optin,status:l.status};}
 async function members(listId,status,listUuid){
  const out=[],seen=new Set();let total=null;
  for(let page=1;;page++){
   const r=await native('members',{id:listId,page,perPage:1000,...(status?{subscriptionStatus:status}:{})});
   if(!plain(r)||!Array.isArray(r.results)||r.results.length>1000||r.page!==page||r.per_page!==1000||!Number.isSafeInteger(r.total)||r.total<0||total!==null&&total!==r.total)fail('CONSENT_MEMBERS_UNCONFIRMED');total=r.total;
   for(const m of r.results){if(!id(m.id)||!uuid(m.uuid)||seen.has(m.id))fail('CONSENT_MEMBERS_UNCONFIRMED');seen.add(m.id);const row={id:m.id,uuid:m.uuid};if(listUuid){if(!Array.isArray(m.lists))fail('CONSENT_MEMBER_UNCONFIRMED');const rows=m.lists.filter(l=>l.id===listId);if(rows.length!==1||rows[0].uuid!==listUuid||!['confirmed','unconfirmed'].includes(rows[0].subscription_status))fail('CONSENT_FREEZE_CHANGED');row.subscription_status=rows[0].subscription_status;}out.push(row);}
   if(out.length===total)return out.sort((a,b)=>a.id-b.id);if(out.length>total||!r.results.length)fail('CONSENT_MEMBERS_UNCONFIRMED');
  }
  fail('CONSENT_MEMBERS_PENDING');
 }
 async function campaign(p){
  const c=await native('campaign',{id:p.campaignId});if(!uuid(p.campaignUuid)||c?.id!==p.campaignId||c.uuid!==p.campaignUuid||c.attribs?.crm?.policy!=='crm-campaign-v1'||c.attribs.crm.brand!==p.brand||c.attribs.crm.created_operation_id!==p.createdOperationId||!Array.isArray(c.lists)||c.lists.length!==1||c.lists[0].id!==p.freeze.list_id)fail('CONSENT_CAMPAIGN_CHANGED');return c;
 }
 function signed(input){
  if(!plain(input)||typeof input.seal!=='string'||!/^[a-f0-9]{64}$/.test(input.seal))fail('CONSENT_PROVENANCE_UNCONFIRMED');const p={...input};delete p.seal;
  const membersKnown=p.memberScope==='server'&&!Object.hasOwn(p,'members')||Array.isArray(p.members)&&p.members.length>0;
  if(p.schema!=='crm-consent-provenance-v1'||!['aristo','fish'].includes(p.brand)||!id(p.campaignId)||!uuid(p.campaignUuid)||!uuid(p.createdOperationId)||!plain(p.freeze)||!plain(p.audience)||!Array.isArray(p.origins)||!p.origins.length||!membersKnown||typeof p.originalReceiptSha256!=='string'||!/^[a-f0-9]{64}$/.test(p.originalReceiptSha256)||verify(canonical(p),input.seal)!==true)fail('CONSENT_PROVENANCE_UNCONFIRMED');return p;
 }
 async function register({brand,createKey,freezeKey}){
  if(!['aristo','fish'].includes(brand)||!/^bff-[a-f0-9]{64}$/.test(createKey||'')||!uuid(freezeKey))fail('CONSENT_REGISTRATION_INPUT');
  const {o,c,receipt}=await operation(brand,createKey),freezeRead=await audienceRead({acao:'segmento_congelamento_nativo_obter',brand,idempotency_key:freezeKey}),f=freezeRead?.body;
  if(f?.contract==='crm-native-frozen-list-v3')return registerV3({brand,createKey,freezeKey,o,c,receipt,freezeRead,f});
  if(freezeRead?.status!==200||f?.contract!=='crm-native-frozen-internal-list-v2'||f.brand!==brand||!uuid(f.audience_id)||!Number.isSafeInteger(f.audience_version)||f.audience_version<1||!/^[a-f0-9]{64}$/.test(f.definition_hash||'')||f.internal_test!==true||f.eligible_count!==1||f.members_sha256!==sha([26948228])||!id(f.list_id)||!uuid(f.list_uuid)||f.sends!==false||f.schedules!==false||c.definition.list_ids[0]!==f.list_id)fail('CONSENT_FREEZE_UNCONFIRMED');
  const head=await audienceRead({acao:'segmento_obter',brand,id:f.audience_id}),segment=head?.body?.segment;
  if(head?.status!==200||segment?.id!==f.audience_id||segment.brand!==brand||segment.version!==f.audience_version||segment.definition?.brand!==brand||sha(segment.definition)!==f.definition_hash)fail('CONSENT_AUDIENCE_CHANGED');
  const catalog=await audienceRead({acao:'segmentos_listar',brand,limit:1,offset:0}),cat=catalog?.body?.catalog;
  if(catalog?.status!==200||cat?.brand!==brand||cat.current!==true||!/^[a-f0-9]{64}$/.test(cat.catalog_hash||'')||!Array.isArray(cat.lists))fail('CONSENT_ORIGIN_UNCONFIRMED');
  const count=await audienceCount({acao:'segmento_contar',brand,id:f.audience_id,expected_version:f.audience_version,expected_catalog_hash:cat.catalog_hash}),q=count?.body;
  const baseId=brand==='aristo'?16:17,internalId=brand==='aristo'?176:175;
  if(count?.status!==200||q?.source_confirmed!==true||q.segment_id!==f.audience_id||q.version!==f.audience_version||q.definition_hash!==f.definition_hash||q.base_list_id!==baseId)fail('CONSENT_ORIGIN_UNCONFIRMED');
  // Exact v2 source custody: base16/17 + internal176/175 are enforced by the
  // original freeze itself. A generic v3 must carry original origins instead.
  const required=[...new Set([...originIds(segment.definition,baseId),internalId])].sort((a,b)=>a-b),origins=[];for(const listId of required){if(!cat.lists.some(x=>x.id===listId&&x.brand===brand&&x.available!==false))fail('CONSENT_ORIGIN_UNCONFIRMED');origins.push(await list(listId));}
  if(origins.some(x=>x.id===f.list_id))fail('CONSENT_ORIGIN_UNCONFIRMED');
  const frozen=await list(f.list_id,f.list_uuid),initial=await members(f.list_id);
  if(initial.length!==1||initial[0].id!==26948228||sha(initial.map(x=>x.id))!==f.members_sha256)fail('CONSENT_FREEZE_CHANGED');
  const current=await native('campaign',{id:c.id});
  const p={schema:'crm-consent-provenance-v1',brand,campaignId:c.id,campaignUuid:current.uuid,createdOperationId:o.id,createKey,freezeKey,originalReceiptSha256:receipt,freeze:JSON.parse(JSON.stringify(f)),audience:{id:segment.id,version:segment.version,definition_hash:f.definition_hash},origins,members:initial,registeredAt:now()};
  await campaign(p);if(frozen.optin!=='double'||frozen.status!=='active')fail('CONSENT_FREEZE_CHANGED');return{...p,seal:sign(canonical(p))};
 }
 async function registerV3({brand,createKey,freezeKey,o,c,receipt,freezeRead,f}){
  try{Freeze.receipt({_http:freezeRead.status,_body:f},{brand,id:f.audience_id,expected_version:f.audience_version,expected_definition_hash:f.definition_hash});}catch{fail('CONSENT_FREEZE_UNCONFIRMED');}
  if(c.definition.list_ids[0]!==f.list_id)fail('CONSENT_FREEZE_UNCONFIRMED');
  const origins=[];for(const expected of f.origins){const current=await list(expected.id,expected.uuid);if(canonical(current)!==canonical(expected))fail('CONSENT_ORIGIN_UNCONFIRMED');origins.push(current);}
  const frozen=await list(f.list_id,f.list_uuid);
  if(frozen.optin!==f.list_optin||frozen.status!=='active')fail('CONSENT_FREEZE_CHANGED');
  // The original SQL receipt pins the complete cohort. Its members stay in
  // Postgres; the existing CREATE row stores only these compact signed pins.
  const current=await native('campaign',{id:c.id}),p={schema:'crm-consent-provenance-v1',brand,campaignId:c.id,campaignUuid:current.uuid,createdOperationId:o.id,createKey,freezeKey,originalReceiptSha256:receipt,freeze:JSON.parse(JSON.stringify(f)),audience:{id:f.audience_id,version:f.audience_version,definition_hash:f.definition_hash},origins,memberScope:'server',registeredAt:now()};
  await campaign(p);await checkedScope(p,undefined,true);return{...p,seal:sign(canonical(p))};
 }
 async function checkedScope(p,subscriberId,initial=false){
  if(typeof scope!=='function')fail('CONSENT_SCOPE_UNCONFIRMED');
  const s=await scope({brand:p.brand,campaignId:p.campaignId,createKey:p.createKey,freezeKey:p.freezeKey,...(subscriberId===undefined?{}:{subscriberId})});
  if(s?.confirmed!==true||s.list_id!==p.freeze.list_id||s.list_uuid!==p.freeze.list_uuid||s.campaign_uuid!==p.campaignUuid||s.created_operation_id!==p.createdOperationId||s.freeze_key!==p.freezeKey||['eligible_count','members_sha256','members_identity_sha256','members_meta_sha256'].some(k=>s[k]!==p.freeze[k])||initial&&s.members_state_sha256!==p.freeze.members_state_sha256||subscriberId!==undefined&&!uuid(s.member_uuid))fail('CONSENT_SCOPE_UNCONFIRMED');
  return s;
 }
 async function admission(input,{member=false}={}){const p=signed(input),original=await operation(p.brand,p.createKey);if(original.o.id!==p.createdOperationId||original.c.id!==p.campaignId||original.receipt!==p.originalReceiptSha256)fail('CONSENT_CREATE_CHANGED');await campaign(p);await list(p.freeze.list_id,p.freeze.list_uuid);for(const l of p.origins)await list(l.id,l.uuid);if(p.memberScope==='server'&&!member)await checkedScope(p);return p;}
 async function plan(input){const p=await admission(input),withdrawn=await members(p.freeze.list_id,'unsubscribed'),known=p.memberScope==='server'?null:new Map(p.members.map(x=>[x.id,x.uuid]));return{schema:'crm-campaign-consent-job-plan-v1',brand:p.brand,campaign_id:p.campaignId,campaign_uuid:p.campaignUuid,created_operation_id:p.createdOperationId,frozen:await list(p.freeze.list_id,p.freeze.list_uuid),origins:p.origins.map(x=>({id:x.id,uuid:x.uuid})),original_receipt_sha256:p.originalReceiptSha256,member_ids:withdrawn.filter(x=>known===null||known.get(x.id)===x.uuid).map(x=>x.id)};}
 async function memberValue(p,subscriberId){
  const known=p.memberScope==='server'?{id:subscriberId,uuid:(await checkedScope(p,subscriberId)).member_uuid}:p.members.find(x=>x.id===subscriberId);if(!known)fail('CONSENT_MEMBER_SCOPE');
  const value=await native('subscriber',{id:subscriberId});if(value?.id!==subscriberId||value.uuid!==known.uuid||!Array.isArray(value.lists))fail('CONSENT_MEMBER_UNCONFIRMED');
  const status=(listId,listUuid)=>{const rows=value.lists.filter(x=>x.id===listId);if(!rows.length)return'absent';if(rows.length!==1||rows[0].uuid!==listUuid||!['confirmed','unconfirmed','unsubscribed'].includes(rows[0].subscription_status))fail('CONSENT_MEMBER_UNCONFIRMED');return rows[0].subscription_status;};
  return{id:subscriberId,uuid:value.uuid,frozen_id:p.freeze.list_id,frozen_uuid:p.freeze.list_uuid,frozen_status:status(p.freeze.list_id,p.freeze.list_uuid),origins:p.origins.map(x=>({id:x.id,uuid:x.uuid,status:status(x.id,x.uuid)}))};
 }
 async function member(input,subscriberId){if(!id(subscriberId))fail('CONSENT_MEMBER_SCOPE');return memberValue(await admission(input,{member:true}),subscriberId);}
 async function unsubscribe(input,{id:subscriberId,uuid:subscriberUuid,originId,originUuid,expectedOriginStatus}){
  if(!['confirmed','unconfirmed'].includes(expectedOriginStatus))fail('CONSENT_BACKUP_UNCONFIRMED');
  if(!id(subscriberId))fail('CONSENT_MEMBER_SCOPE');const p=await admission(input,{member:true}),origin=p.origins.find(x=>x.id===originId&&x.uuid===originUuid);if(!origin)fail('CONSENT_ORIGIN_SCOPE');const m=await memberValue(p,subscriberId),o=m.origins.find(x=>x.id===originId);
  if(m.uuid!==subscriberUuid||m.frozen_status!=='unsubscribed')fail('CONSENT_WITHDRAWAL_CHANGED');if(o.status==='absent'||o.status==='unsubscribed')return true;if(o.status!==expectedOriginStatus)fail('CONSENT_ORIGIN_CHANGED');
  const changed=await native('unsubscribe',{subscriberId,originId});if(changed!==true)fail('CONSENT_EFFECT_UNCONFIRMED');return true;
 }
 return Object.freeze({register,plan,member,unsubscribe});
}
module.exports={createSource,canonical,originIds};

return module.exports;})();
const Transport=(()=>{const module={exports:{}};
'use strict';
// Private fixed adapters for the original Campaigns service. API16 is neither
// exported nor transferred to the gateway. No opt-in or global status method.
const crypto=require('node:crypto'),{createSource,canonical}=Source;
const AUDIENCE='https://comunicacao-crm-audience.tazdb8.easypanel.host/segments';
const AUTH_SQL='SELECT public.shrigma_crm_campaign_auth_v1($1::text) AS auth';
const EFFECT_SQL='SELECT public.shrigma_crm_campaign_effect_v1($1::text,$2::jsonb,$3::jsonb) AS result';
const positive=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
const exact=(o,keys)=>plain(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const fail=code=>{throw Object.assign(Error(code),{code});};
async function response(r,maxBytes=2*1024*1024){
 if(!r||r.redirected||!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type')||''))fail('CONSENT_RESPONSE_UNCONFIRMED');
 let bytes=0;const chunks=[];if(!r.body)fail('CONSENT_RESPONSE_UNCONFIRMED');for await(const chunk of r.body){bytes+=chunk.length;if(bytes>maxBytes)fail('CONSENT_RESPONSE_UNCONFIRMED');chunks.push(Buffer.from(chunk));}
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('CONSENT_RESPONSE_UNCONFIRMED');}return{status:r.status,body};
}
function createNativeConsent({origin,username,token,fetchFn=fetch}){
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||typeof username!=='string'||!username||typeof token!=='string'||!token)throw Error('CONSENT_NATIVE_CONFIG');
 const authorization='Basic '+Buffer.from(username+':'+token).toString('base64'),sealKey=crypto.createHmac('sha256',token).update('shrigma-consent-provenance-key-v1\0'+username).digest();
 const sign=value=>crypto.createHmac('sha256',sealKey).update(value).digest('hex');
 const verify=(value,mac)=>typeof mac==='string'&&/^[a-f0-9]{64}$/.test(mac)&&crypto.timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(sign(value),'hex'));
 async function api(q,interrupted=()=>false){
  if(!plain(q))fail('CONSENT_NATIVE_INPUT');let pathname,method='GET',body;
  if(['campaign','list','subscriber'].includes(q.resource)&&exact(q,['resource','id'])&&positive(q.id))pathname='/api/'+{campaign:'campaigns',list:'lists',subscriber:'subscribers'}[q.resource]+'/'+q.id;
  else if(q.resource==='members'&&exact(q,['resource','id','page','perPage',...(q.subscriptionStatus!==undefined?['subscriptionStatus']:[])])&&positive(q.id)&&positive(q.page)&&q.perPage===1000&&(q.subscriptionStatus===undefined||q.subscriptionStatus==='unsubscribed')){const query=new URLSearchParams({list_id:String(q.id),page:String(q.page),per_page:'1000',order_by:'id',order:'asc'});if(q.subscriptionStatus)query.set('subscription_status',q.subscriptionStatus);pathname='/api/subscribers?'+query;}
  else if(q.resource==='unsubscribe'&&exact(q,['resource','subscriberId','originId'])&&positive(q.subscriberId)&&positive(q.originId)){pathname='/api/subscribers/lists';method='PUT';body=JSON.stringify({ids:[q.subscriberId],action:'unsubscribe',target_list_ids:[q.originId]});}
  else fail('CONSENT_NATIVE_INPUT');
  if(interrupted())fail('CONSENT_REQUEST_ENDED');return response(await fetchFn(new URL(pathname,base).href,{method,headers:{Accept:'application/json',Authorization:authorization,...(body?{'Content-Type':'application/json'}:{})},...(body?{body}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)}),q.resource==='members'?8*1024*1024:2*1024*1024);
 }
 return Object.freeze({api,sign,verify});
}
function createConsentExecutor({pool,campaignExecutor,nativeConsent,fetchFn=fetch,enabled=false}){
 if(!pool?.query||typeof campaignExecutor!=='function'||!nativeConsent)throw Error('CONSENT_EXECUTOR_CONFIG');
 async function identity(key,brand){const r=await pool.query(AUTH_SQL,[key]),a=r?.rows?.length===1?r.rows[0].auth:null;if(!a||typeof a.actor!=='string'||!a.actor.startsWith('panel:')||!Array.isArray(a.caps)||!['read_content','draft','validate','submit'].every(x=>a.caps.includes(x))||Object.hasOwn(a,'brand')&&a.brand!==brand)fail('CONSENT_ACCESS_DENIED');return canonical(a);}
 return async({key,command,interrupted=()=>false})=>{
  try{
   if(enabled!==true||!plain(command)||!['aristo','fish'].includes(command.brand))fail('CONSENT_ACCESS_DENIED');
   const {kind,brand}=command,fields={register:['kind','brand','createKey','freezeKey'],plan:['kind','brand','provenance'],member:['kind','brand','provenance','subscriberId'],unsubscribe:['kind','brand','provenance','member']}[kind];if(!fields||!exact(command,fields)||kind!=='register'&&command.provenance?.brand!==brand)fail('CONSENT_REQUEST_INVALID');
   const before=await identity(key,brand),guard=()=>{if(interrupted())fail('CONSENT_REQUEST_ENDED');};
   const audience=async(q,method)=>{guard();const url=new URL(AUDIENCE);if(method==='GET')for(const[k,v]of Object.entries(q))url.searchParams.set(k,String(v));return response(await fetchFn(url.href,{method,headers:{Accept:'application/json',Authorization:'Bearer '+key,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(q)}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25000)}));};
   const scope=async p=>{guard();if(p.brand!==brand)fail('CONSENT_ACCESS_DENIED');const result=await pool.query(EFFECT_SQL,[key,JSON.stringify({command:{acao:'campanha_nativa_contexto',brand,id:p.campaignId},actor:JSON.parse(before).actor,operation:null}),JSON.stringify({kind:'nativeContext',payload:{id:p.campaignId,purpose:'consent_scope',createKey:p.createKey,freezeKey:p.freezeKey,...(p.subscriberId===undefined?{}:{subscriberId:p.subscriberId})}})]);guard();if(result.rows?.length!==1)fail('CONSENT_SCOPE_UNCONFIRMED');return result.rows[0].result;};
   const source=createSource({scope,campaignRead:async q=>{guard();return campaignExecutor({key,command:q,interrupted});},audienceRead:q=>audience(q,'GET'),audienceCount:q=>audience(q,'POST'),api:async q=>{guard();if(q.resource==='unsubscribe'){if(await identity(key,brand)!==before)fail('CONSENT_ACCESS_CHANGED');guard();}return nativeConsent.api(q,interrupted);},sign:nativeConsent.sign,verify:nativeConsent.verify});
   guard();const result=kind==='register'?await source.register(command):kind==='plan'?await source.plan(command.provenance):kind==='member'?await source.member(command.provenance,command.subscriberId):await source.unsubscribe(command.provenance,command.member);
   guard();if(await identity(key,brand)!==before)fail('CONSENT_ACCESS_CHANGED');
   const serialized=JSON.stringify(result);if(serialized.includes(key))fail('CONSENT_RESPONSE_UNCONFIRMED');
   return{status:200,body:{schema:'crm-campaign-consent-private-result-v1',brand,kind,result}};
  }catch(e){return{status:e?.code==='CONSENT_ACCESS_DENIED'?403:503,body:{error:'CONSENT_PENDING',code:/^CONSENT_[A-Z_]{1,70}$/.test(e?.code||'')?e.code:'CONSENT_PENDING'}};}
 };
}
module.exports={createNativeConsent,createConsentExecutor,AUTH_SQL,AUDIENCE};

return module.exports;})();
module.exports=Transport;
