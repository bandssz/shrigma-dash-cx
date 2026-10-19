'use strict';
// Runs inside the original Campaigns service, where API16 already lives.
// All returned member data is reduced to IDs, UUIDs and membership state.
const crypto=require('node:crypto');
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
function createSource({campaignRead,audienceRead,audienceCount,api,sign,verify,now=Date.now}){
 if(![campaignRead,audienceRead,audienceCount,api,sign,verify,now].every(f=>typeof f==='function'))throw Error('CONSENT_SOURCE_CONFIG');
 async function native(resource,fields={}){return data(await api({resource,...fields}));}
 async function operation(brand,key){
  const r=await campaignRead({acao:'campanha_operacao',brand,idempotency_key:key}),o=r?.body?.operation,c=o?.response?.body?.campaign;
  if(r?.status!==200||o?.state!=='succeeded'||o.action!=='salvar'||o.brand!==brand||o.operation_key!==key||o.response?.status!==201||!uuid(o.id)||o.response.body.operation_id!==o.id||!id(o.providerId)||c?.id!==o.providerId||c.status!=='draft'||c.sent!==0||c.started_at!==null||c.send_at!==null||c.definition?.send_at!==null||c.definition.brand!==brand||!Array.isArray(c.definition.list_ids)||c.definition.list_ids.length!==1)fail('CONSENT_CREATE_UNCONFIRMED');
  return{o,c,receipt:sha(o)};
 }
 async function list(listId,expectedUuid){const l=await native('list',{id:listId});if(l?.id!==listId||!uuid(l.uuid)||expectedUuid&&l.uuid!==expectedUuid||!['single','double'].includes(l.optin)||!['active','archived'].includes(l.status))fail('CONSENT_LIST_UNCONFIRMED');return{id:l.id,uuid:l.uuid,optin:l.optin,status:l.status};}
 async function members(listId,status){
  const out=[],seen=new Set();let total=null;
  for(let page=1;page<=100;page++){
   const r=await native('members',{id:listId,page,perPage:100,...(status?{subscriptionStatus:status}:{})});
   if(!plain(r)||!Array.isArray(r.results)||r.results.length>100||r.page!==page||r.per_page!==100||!Number.isSafeInteger(r.total)||r.total<0||r.total>10000||total!==null&&total!==r.total)fail('CONSENT_MEMBERS_UNCONFIRMED');total=r.total;
   for(const m of r.results){if(!id(m.id)||!uuid(m.uuid)||seen.has(m.id))fail('CONSENT_MEMBERS_UNCONFIRMED');seen.add(m.id);out.push({id:m.id,uuid:m.uuid});}
   if(out.length===total)return out.sort((a,b)=>a.id-b.id);if(!r.results.length)fail('CONSENT_MEMBERS_UNCONFIRMED');
  }
  fail('CONSENT_MEMBERS_PENDING');
 }
 async function campaign(p){
  const c=await native('campaign',{id:p.campaignId});if(!uuid(p.campaignUuid)||c?.id!==p.campaignId||c.uuid!==p.campaignUuid||c.attribs?.crm?.policy!=='crm-campaign-v1'||c.attribs.crm.brand!==p.brand||c.attribs.crm.created_operation_id!==p.createdOperationId||!Array.isArray(c.lists)||c.lists.length!==1||c.lists[0].id!==p.freeze.list_id)fail('CONSENT_CAMPAIGN_CHANGED');return c;
 }
 function signed(input){
  if(!plain(input)||typeof input.seal!=='string'||!/^[a-f0-9]{64}$/.test(input.seal))fail('CONSENT_PROVENANCE_UNCONFIRMED');const p={...input};delete p.seal;
  if(p.schema!=='crm-consent-provenance-v1'||!['aristo','fish'].includes(p.brand)||!id(p.campaignId)||!uuid(p.campaignUuid)||!uuid(p.createdOperationId)||!plain(p.freeze)||!plain(p.audience)||!Array.isArray(p.origins)||!p.origins.length||!Array.isArray(p.members)||!p.members.length||p.members.length>10000||typeof p.originalReceiptSha256!=='string'||!/^[a-f0-9]{64}$/.test(p.originalReceiptSha256)||verify(canonical(p),input.seal)!==true)fail('CONSENT_PROVENANCE_UNCONFIRMED');return p;
 }
 async function register({brand,createKey,freezeKey}){
  if(!['aristo','fish'].includes(brand)||!/^bff-[a-f0-9]{64}$/.test(createKey||'')||!uuid(freezeKey))fail('CONSENT_REGISTRATION_INPUT');
  const {o,c,receipt}=await operation(brand,createKey),freezeRead=await audienceRead({acao:'segmento_congelamento_nativo_obter',brand,idempotency_key:freezeKey}),f=freezeRead?.body;
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
 async function admission(input){const p=signed(input),original=await operation(p.brand,p.createKey);if(original.o.id!==p.createdOperationId||original.c.id!==p.campaignId||original.receipt!==p.originalReceiptSha256)fail('CONSENT_CREATE_CHANGED');await campaign(p);await list(p.freeze.list_id,p.freeze.list_uuid);for(const l of p.origins)await list(l.id,l.uuid);return p;}
 async function plan(input){const p=await admission(input),withdrawn=await members(p.freeze.list_id,'unsubscribed'),known=new Map(p.members.map(x=>[x.id,x.uuid]));return{schema:'crm-campaign-consent-job-plan-v1',brand:p.brand,campaign_id:p.campaignId,campaign_uuid:p.campaignUuid,created_operation_id:p.createdOperationId,frozen:await list(p.freeze.list_id,p.freeze.list_uuid),origins:p.origins.map(x=>({id:x.id,uuid:x.uuid})),original_receipt_sha256:p.originalReceiptSha256,member_ids:withdrawn.filter(x=>known.get(x.id)===x.uuid).map(x=>x.id)};}
 async function memberValue(p,subscriberId){
  const known=p.members.find(x=>x.id===subscriberId);if(!known)fail('CONSENT_MEMBER_SCOPE');
  const value=await native('subscriber',{id:subscriberId});if(value?.id!==subscriberId||value.uuid!==known.uuid||!Array.isArray(value.lists))fail('CONSENT_MEMBER_UNCONFIRMED');
  const status=(listId,listUuid)=>{const rows=value.lists.filter(x=>x.id===listId);if(!rows.length)return'absent';if(rows.length!==1||rows[0].uuid!==listUuid||!['confirmed','unconfirmed','unsubscribed'].includes(rows[0].subscription_status))fail('CONSENT_MEMBER_UNCONFIRMED');return rows[0].subscription_status;};
  return{id:subscriberId,uuid:value.uuid,frozen_id:p.freeze.list_id,frozen_uuid:p.freeze.list_uuid,frozen_status:status(p.freeze.list_id,p.freeze.list_uuid),origins:p.origins.map(x=>({id:x.id,uuid:x.uuid,status:status(x.id,x.uuid)}))};
 }
 async function member(input,subscriberId){return memberValue(await admission(input),subscriberId);}
 async function unsubscribe(input,{id:subscriberId,uuid:subscriberUuid,originId,originUuid,expectedOriginStatus}){
  if(!['confirmed','unconfirmed'].includes(expectedOriginStatus))fail('CONSENT_BACKUP_UNCONFIRMED');
  const p=await admission(input),origin=p.origins.find(x=>x.id===originId&&x.uuid===originUuid);if(!origin)fail('CONSENT_ORIGIN_SCOPE');const m=await memberValue(p,subscriberId),o=m.origins.find(x=>x.id===originId);
  if(m.uuid!==subscriberUuid||m.frozen_status!=='unsubscribed')fail('CONSENT_WITHDRAWAL_CHANGED');if(o.status==='absent'||o.status==='unsubscribed')return true;if(o.status!==expectedOriginStatus)fail('CONSENT_ORIGIN_CHANGED');
  const changed=await native('unsubscribe',{subscriberId,originId});if(changed!==true)fail('CONSENT_EFFECT_UNCONFIRMED');return true;
 }
 return Object.freeze({register,plan,member,unsubscribe});
}
module.exports={createSource,canonical,originIds};
