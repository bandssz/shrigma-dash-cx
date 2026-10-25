'use strict';
const CONTRACTS=require('./crm-person-contracts.cjs'),MAX_ID=9223372036854775807n,BRANDS=new Set(['aristo','fish']);
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,keys)=>plain(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const decimalId=x=>typeof x==='string'&&/^[1-9][0-9]{0,18}$/.test(x)&&BigInt(x)<=MAX_ID;
function instant(x){if(typeof x!=='string'||!/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString()!==x)fail('PERSON_INPUT_INVALID');return Date.parse(x);}
function selection(input,now){
 if(!plain(input)||!BRANDS.has(input.brand))fail('PERSON_INPUT_INVALID');
 const schemas={emailProfile:'action,brand,email',emailActivity:'action,brand,email,kind,from,to,afterId,pageSize',waContact:'action,brand,phone',waStatus:'action,brand,phone,from,to,asOf,afterId,pageSize'};
 if(typeof input.action!=='string'||!Object.hasOwn(schemas,input.action))fail('PERSON_INPUT_INVALID');const schema=schemas[input.action];if(!exact(input,schema))fail('PERSON_INPUT_INVALID');
 const email=input.action.startsWith('email'),paged=['emailActivity','waStatus'].includes(input.action);let person;
 if(email){if(typeof input.email!=='string'||input.email!==input.email.trim()||input.email.length>254||!/^[^@\s\u0000-\u001f\u007f-\u009f]+@[^@\s\u0000-\u001f\u007f-\u009f]+\.[^@\s\u0000-\u001f\u007f-\u009f]+$/.test(input.email))fail('PERSON_INPUT_INVALID');person=input.email.toLowerCase();}
 else{if(typeof input.phone!=='string'||input.phone.length<1||input.phone.length>64||input.phone.trim()!==input.phone||/[\u0000-\u001f\u007f-\u009f]/.test(input.phone))fail('PERSON_INPUT_INVALID');person=input.phone;}
 if(paged){const from=instant(input.from),to=instant(input.to);if(from>=to||to-from>31*86400000||to>now||!Number.isSafeInteger(input.pageSize)||input.pageSize<1||input.pageSize>100||input.afterId!==null&&!decimalId(input.afterId))fail('PERSON_INPUT_INVALID');if(input.action==='waStatus'){if(instant(input.asOf)>now||Date.parse(input.asOf)<to)fail('PERSON_INPUT_INVALID');}else if(!['send','open','click'].includes(input.kind))fail('PERSON_INPUT_INVALID');}
 const common=[input.brand,person];let contract,params;
 if(input.action==='emailProfile'){contract='person-email-profile-v2';params=common;}
 if(input.action==='waContact'){contract='person-wa-contact-v2';params=common;}
 if(input.action==='emailActivity'){contract='person-email-activity-page-v2';params=[...common,input.kind,input.from,input.to,input.afterId,input.pageSize];}
 if(input.action==='waStatus'){contract='person-wa-status-page-v2';params=[...common,input.from,input.to,input.asOf,input.afterId,input.pageSize];}
 return {contract,params,person,email,paged};
}
const sameInstant=(a,b)=>typeof a==='string'&&Number.isFinite(Date.parse(a))&&Date.parse(a)===Date.parse(b);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const nativeId=x=>Number.isSafeInteger(x)&&x>0;
const stringOrNull=x=>x===null||typeof x==='string';
const dateOrNull=x=>x===null||typeof x==='string'&&Number.isFinite(Date.parse(x));
const requireShape=(x,keys)=>{if(!exact(x,keys))fail('PERSON_SOURCE_INVALID',503);};
function admittedShape(data,input){
 const roots={emailProfile:'contract,valid,error,brand,emailExactNormalized,observedAtUtc,brandPersonConfirmed,person,listScopeCurrent,lists,shopifySource,purchaseSummary,journeyHistory,journeyHistoryStatus,historicalCoverageProved,sourceMutations',emailActivity:'contract,valid,error,brand,emailExactNormalized,kind,fromInclusive,toExclusive,observedAtUtc,subscriberResolved,rows,hasMore,nextAfterId,received,notOpened,notClicked,historicalCoverageProved,sourceMutations',waContact:'contract,valid,error,brand,phoneExact,observedAtUtc,found,person,contactAbsenceIsOptIn,sourceMutations',waStatus:'contract,valid,error,scope,observedAtUtc,rows,hasMore,nextAfterId'};
 requireShape(data,roots[input.action]);if(data.error!==null)fail('PERSON_SOURCE_INVALID',503);
 if(input.action==='emailProfile'){
  if(data.historicalCoverageProved!==false||data.brandPersonConfirmed!==(data.person!==null))fail('PERSON_SOURCE_INVALID',503);
  if(data.person!==null){const p=data.person;requireShape(p,'subscriberId,subscriberUuid,email,name,status,createdAt,updatedAt');if(!nativeId(p.subscriberId)||!uuid(p.subscriberUuid)||typeof p.email!=='string'||!stringOrNull(p.name)||!['enabled','disabled','blocklisted'].includes(p.status)||!dateOrNull(p.createdAt)||!dateOrNull(p.updatedAt))fail('PERSON_SOURCE_INVALID',503);}
  if(data.lists!==null){if(!Array.isArray(data.lists))fail('PERSON_SOURCE_INVALID',503);let prev=0;for(const l of data.lists){requireShape(l,'listId,listUuid,name,type,listStatus,membershipStatus,joinedAt,updatedAt');if(!nativeId(l.listId)||l.listId<=prev||!uuid(l.listUuid)||typeof l.name!=='string'||typeof l.type!=='string'||typeof l.listStatus!=='string'||typeof l.membershipStatus!=='string'||!dateOrNull(l.joinedAt)||!dateOrNull(l.updatedAt))fail('PERSON_SOURCE_INVALID',503);prev=l.listId;}}
  if(data.shopifySource!==null){const s=data.shopifySource;requireShape(s,'operationId,enabled,fresh,maxAgeSeconds,batchStatus,completedAt,observedAt,finalizedAt,identityResolvedToSubscriber,multipleEmailMatches,summaryCompletenessProved');if(!stringOrNull(s.operationId)||typeof s.enabled!=='boolean'||typeof s.fresh!=='boolean'||!Number.isFinite(s.maxAgeSeconds)||s.maxAgeSeconds<0||!stringOrNull(s.batchStatus)||!dateOrNull(s.completedAt)||!dateOrNull(s.observedAt)||!dateOrNull(s.finalizedAt)||typeof s.identityResolvedToSubscriber!=='boolean'||typeof s.multipleEmailMatches!=='boolean'||s.summaryCompletenessProved!==false)fail('PERSON_SOURCE_INVALID',503);}
  if(data.purchaseSummary!==null){const p=data.purchaseSummary;requireShape(p,'ordersCountDecimal,amountSpentDecimal,currency,lastOrderAt,source,fresh,paidOrderSemanticsProved');if(!data.brandPersonConfirmed||data.shopifySource?.identityResolvedToSubscriber!==true||p.ordersCountDecimal!==null&&(typeof p.ordersCountDecimal!=='string'||!/^\d+(?:\.0+)?$/.test(p.ordersCountDecimal))||p.amountSpentDecimal!==null&&(typeof p.amountSpentDecimal!=='string'||!/^\d+(?:\.\d+)?$/.test(p.amountSpentDecimal)||!Number.isFinite(Number(p.amountSpentDecimal)))||p.currency!==null&&(typeof p.currency!=='string'||!/^[A-Z]{3}$/.test(p.currency))||!dateOrNull(p.lastOrderAt)||p.source!=='shopify_customer_fact'||typeof p.fresh!=='boolean'||p.paidOrderSemanticsProved!==false)fail('PERSON_SOURCE_INVALID',503);}
 }
 if(input.action==='emailActivity'&&(typeof data.subscriberResolved!=='boolean'||data.historicalCoverageProved!==false))fail('PERSON_SOURCE_INVALID',503);
 if(input.action==='waContact'&&data.person!==null){const p=data.person;requireShape(p,'phone,brand,optInAt,optInSource,optOutAt,lastInboundAt,updatedAt,consentState');if(!dateOrNull(p.optInAt)||!dateOrNull(p.optOutAt)||!dateOrNull(p.lastInboundAt)||!dateOrNull(p.updatedAt)||!stringOrNull(p.optInSource))fail('PERSON_SOURCE_INVALID',503);}
 if(input.action==='waStatus')requireShape(data.scope,'brand,phoneExact,sentFromInclusive,sentToExclusive,eventOccurredAndReceivedThroughInclusive');
 if(Array.isArray(data.rows))for(const r of data.rows){requireShape(r,input.action==='waStatus'?'logId,brand,flow,campaignId,piece,sentAt,phone,wamid,templateRef,acceptedWithWamid,loggedError,nativeSent,nativeDelivered,nativeRead,nativeFailed,nativeFailedCode,pendingDelivery,noStatus,ambiguousCrossbrand,unknownNativeStatus,lastNativeOccurredAt,lastNativeReceivedAt':'eventId,kind,at,campaignId,campaignUuid,campaignName,campaignStatus,flow,piece,loggedError,semantics');if(r.loggedError!==null&&typeof r.loggedError!=='boolean'||r.campaignId!==null&&((input.action==='waStatus'||input.kind==='send')?!Number.isInteger(r.campaignId)||r.campaignId< -2147483648||r.campaignId>2147483647:!nativeId(r.campaignId))||!stringOrNull(r.flow)||!stringOrNull(r.piece))fail('PERSON_SOURCE_INVALID',503);if(input.action==='emailActivity'&&(r.campaignUuid!==null&&!uuid(r.campaignUuid)||!stringOrNull(r.campaignName)||!stringOrNull(r.campaignStatus)))fail('PERSON_SOURCE_INVALID',503);if(input.action==='waStatus'&&(!stringOrNull(r.wamid)||!stringOrNull(r.templateRef)))fail('PERSON_SOURCE_INVALID',503);}
}
function envelope(result,input,scope){
 if(!result||!Array.isArray(result.rows)||result.rows.length!==1||!plain(result.rows[0].result))fail('PERSON_SOURCE_INVALID',503);
 const data=result.rows[0].result;if(data.contract!==scope.contract||typeof data.valid!=='boolean')fail('PERSON_SOURCE_INVALID',503);
 if(!data.valid)fail('PERSON_SCOPE_OR_CURSOR_INVALID');
 admittedShape(data,input);
 if(typeof data.observedAtUtc!=='string'||!Number.isFinite(Date.parse(data.observedAtUtc))||JSON.stringify(data).length>2097152)fail('PERSON_SOURCE_INVALID',503);
 if(input.action==='waStatus'){const s=data.scope;if(!plain(s)||s.brand!==input.brand||s.phoneExact!==scope.person||!sameInstant(s.sentFromInclusive,input.from)||!sameInstant(s.sentToExclusive,input.to)||!sameInstant(s.eventOccurredAndReceivedThroughInclusive,input.asOf))fail('PERSON_SOURCE_INVALID',503);}
 else if(data.brand!==input.brand||(scope.email?data.emailExactNormalized:data.phoneExact)!==scope.person||data.sourceMutations!==0)fail('PERSON_SOURCE_INVALID',503);
 if(scope.paged){
  if(!Array.isArray(data.rows)||data.rows.length>input.pageSize||typeof data.hasMore!=='boolean'||data.hasMore&&data.rows.length!==input.pageSize)fail('PERSON_SOURCE_INVALID',503);
  if(input.action==='emailActivity'&&(data.kind!==input.kind||!sameInstant(data.fromInclusive,input.from)||!sameInstant(data.toExclusive,input.to)||data.received!==null||data.notOpened!==null||data.notClicked!==null))fail('PERSON_SOURCE_INVALID',503);
  let previous=input.afterId===null?0n:BigInt(input.afterId);
  for(const row of data.rows){if(!plain(row))fail('PERSON_SOURCE_INVALID',503);const id=input.action==='waStatus'?row.logId:row.eventId,time=input.action==='waStatus'?row.sentAt:row.at;if(!decimalId(id)||BigInt(id)<=previous||!Number.isFinite(Date.parse(time))||Date.parse(time)<Date.parse(input.from)||Date.parse(time)>=Date.parse(input.to))fail('PERSON_SOURCE_INVALID',503);previous=BigInt(id);
   if(input.action==='waStatus'){if(row.brand!==input.brand||row.phone!==scope.person)fail('PERSON_SOURCE_INVALID',503);for(const k of ['acceptedWithWamid','nativeSent','nativeDelivered','nativeRead','nativeFailed','pendingDelivery','noStatus','ambiguousCrossbrand','unknownNativeStatus'])if(typeof row[k]!=='boolean')fail('PERSON_SOURCE_INVALID',503);for(const k of ['lastNativeOccurredAt','lastNativeReceivedAt'])if(row[k]!==null&&(!Number.isFinite(Date.parse(row[k]))||Date.parse(row[k])>Date.parse(input.asOf)))fail('PERSON_SOURCE_INVALID',503);}
   else if(row.kind!==input.kind||row.semantics!==(input.kind==='send'?'local_send_log_not_delivery':'native_positive_event'))fail('PERSON_SOURCE_INVALID',503);
  }
  const last=data.rows.at(-1),expected=last?(input.action==='waStatus'?last.logId:last.eventId):null;if(data.nextAfterId!==expected)fail('PERSON_SOURCE_INVALID',503);
 }
 if(input.action==='emailProfile'){
  if(typeof data.brandPersonConfirmed!=='boolean'||typeof data.listScopeCurrent!=='boolean'||data.journeyHistory!==null||data.journeyHistoryStatus!=='not_admitted_individual_source'||data.purchaseSummary&&data.purchaseSummary.paidOrderSemanticsProved!==false)fail('PERSON_SOURCE_INVALID',503);
  if(data.person!==null&&(!plain(data.person)||!data.brandPersonConfirmed||String(data.person.email).toLowerCase()!==scope.person))fail('PERSON_SOURCE_INVALID',503);
  if(data.lists!==null&&(!Array.isArray(data.lists)||!data.brandPersonConfirmed||!data.listScopeCurrent))fail('PERSON_SOURCE_INVALID',503);
  if(data.purchaseSummary!==null&&(!plain(data.purchaseSummary)||data.shopifySource?.identityResolvedToSubscriber!==true))fail('PERSON_SOURCE_INVALID',503);
 }
 if(input.action==='waContact'){
  if(typeof data.found!=='boolean'||data.contactAbsenceIsOptIn!==false||data.person&&(data.person.brand!==input.brand||data.person.phone!==scope.person))fail('PERSON_SOURCE_INVALID',503);
  if(data.found!==(data.person!==null))fail('PERSON_SOURCE_INVALID',503);
  if(data.person){const state=data.person.optOutAt!==null?'opted_out':data.person.optInAt!==null?'opt_in_recorded':'unknown';if(data.person.consentState!==state)fail('PERSON_SOURCE_INVALID',503);}
 }
 const safe=structuredClone(data);if(Array.isArray(safe.rows))for(const row of safe.rows){if(Object.hasOwn(row,'loggedError')){row.hasLoggedError=row.loggedError;delete row.loggedError;}if(Object.hasOwn(row,'nativeFailedCode')&&row.nativeFailedCode!==null&&!/^\d{1,16}$/.test(String(row.nativeFailedCode)))row.nativeFailedCode=null;}
 return safe;
}
function create({authorize,read,now=Date.now}){
 if(typeof authorize!=='function'||typeof read!=='function')fail('PERSON_CONFIGURATION_INVALID',503);
 const authority=(context,brand)=>{const a=authorize(context,brand);if(!a||typeof a.userId!=='string'||!a.userId||typeof a.revision!=='string'||!a.revision)fail('PERSON_ACCESS_DENIED',403);return {userId:a.userId,revision:a.revision};};
 async function personRead(context,input){const scope=selection(input,now()),before=authority(context,input.brand);let result;try{result=await read(scope.contract,scope.params,CONTRACTS[scope.contract].sql);}catch(e){authority(context,input.brand);if(e?.code?.startsWith('PERSON_'))throw e;fail('PERSON_SOURCE_UNAVAILABLE',503);}const after=authority(context,input.brand);if(before.userId!==after.userId||before.revision!==after.revision)fail('PERSON_AUTHORITY_CHANGED',403);const data=envelope(result,input,scope);const final=authority(context,input.brand);if(final.userId!==before.userId||final.revision!==before.revision)fail('PERSON_AUTHORITY_CHANGED',403);return {schema:'crm-person-read-v2',contract:scope.contract,action:input.action,brand:input.brand,readAt:new Date(now()).toISOString(),data,sourceMutations:0,customerEdits:false};}
 return Object.freeze({read:personRead});
}
async function readOnlyDatabase(client,work){
 let timer,expired=false;const ignore=()=>{};client.on?.('error',ignore);
 const abort=()=>{try{client.connection?.stream?.destroy();}catch{}try{Promise.resolve(client.end()).catch(ignore);}catch{}};
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;abort();reject(Object.assign(Error('PERSON_SOURCE_DEADLINE'),{code:'PERSON_SOURCE_DEADLINE',status:503}));},8000);});
 const operation=(async()=>{await client.connect();await client.query("BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='250ms'");const value=await work(client);await client.query('ROLLBACK');return value;})();
 try{return await Promise.race([operation,deadline]);}catch{abort();fail(expired?'PERSON_SOURCE_DEADLINE':'PERSON_SOURCE_UNAVAILABLE',503);}finally{clearTimeout(timer);try{await client.end();}catch{}client.removeListener?.('error',ignore);}
}
module.exports={create,selection,readOnlyDatabase};
