'use strict';
// Candidate domain policy only. No provider transport, SQL, filesystem or send.
// Private verifier/authorizer callbacks are trusted server code, not a sandbox.
const {createHash}=require('node:crypto');
const VERSION='crm-deliverability-state-v1',EVENT_VERSION='crm-classified-delivery-event-v1';
const LIMITS=Object.freeze({records:10000,providers:8,softBounceAttempts:100,admissionTtlMs:300000});
const BRANDS=Object.freeze(['fish','aristo','olivas']);
const HEX=/^[a-f0-9]{64}$/,PROVIDER=/^[a-z][a-z0-9_-]{0,63}$/,ID=/^[A-Za-z0-9_.:/+-]{1,200}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
function fail(code){throw Object.assign(new Error(code),{name:'DeliverabilityPolicyError',code,status:503});}
function shape(v,required,optional=[]){
 if(!plain(v))fail('DELIVERABILITY_FIELDS');
 const names=Reflect.ownKeys(v);
 if(names.some(k=>typeof k!=='string'||!required.includes(k)&&!optional.includes(k))||required.some(k=>!own(v,k))||names.some(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !d.enumerable||!own(d,'value');}))fail('DELIVERABILITY_FIELDS');
}
function array(v,max){
 if(!Array.isArray(v)||v.length>max)fail('DELIVERABILITY_LIMIT');
 const names=Reflect.ownKeys(v);
 if(names.length!==v.length+1||names.some(k=>typeof k!=='string'||k!=='length'&&(!/^(0|[1-9]\d*)$/.test(k)||Number(k)>=v.length||!Object.getOwnPropertyDescriptor(v,k).enumerable||!own(Object.getOwnPropertyDescriptor(v,k),'value'))))fail('DELIVERABILITY_FIELDS');
}
const positive=v=>Number.isSafeInteger(v)&&v>=1&&v<=LIMITS.softBounceAttempts;
const instant=v=>Number.isSafeInteger(v)&&v>=0;
const hash=v=>createHash('sha256').update(JSON.stringify(v),'utf8').digest('hex');
const freezeState=s=>{s.records.forEach(Object.freeze);Object.freeze(s.records);return Object.freeze(s);};
const eventFacts=r=>({type:'event',providerId:r.providerId,eventRef:r.eventRef,attemptRef:r.attemptRef,recipientRef:r.recipientRef,classification:r.classification,occurredAt:r.occurredAt});
const configFacts=r=>({type:'configuration',operationRef:r.operationRef,actorRef:r.actorRef,softBounceAttempts:r.softBounceAttempts});
const facts=r=>r.type==='event'?eventFacts(r):configFacts(r);
const genesis=(brand,limit)=>hash([VERSION,brand,limit]);
const recordHash=(brand,previousHash,record)=>hash(['crm-deliverability-journal-entry-v1',brand,previousHash,{...facts(record),recordedAt:record.recordedAt}]);
function createPolicy(config){
 shape(config,['brand','softBounceAttempts','providers','verifyClassifiedEvent'],['authorizePolicyChange','clock']);
 array(config.providers,LIMITS.providers);
 if(!BRANDS.includes(config.brand)||!positive(config.softBounceAttempts)||!config.providers.length||new Set(config.providers).size!==config.providers.length||config.providers.some(p=>typeof p!=='string'||!PROVIDER.test(p))||typeof config.verifyClassifiedEvent!=='function'||config.authorizePolicyChange!==undefined&&typeof config.authorizePolicyChange!=='function'||config.clock!==undefined&&typeof config.clock!=='function')fail('DELIVERABILITY_CONFIG');
 const brand=config.brand,initialLimit=config.softBounceAttempts,providers=new Set(config.providers),verify=config.verifyClassifiedEvent,authorize=config.authorizePolicyChange,clock=config.clock||Date.now;
 const admissions=new WeakMap();
 const time=()=>{let n;try{n=clock();}catch{fail('DELIVERABILITY_CLOCK');}if(!instant(n)||n>Number.MAX_SAFE_INTEGER-LIMITS.admissionTtlMs)fail('DELIVERABILITY_CLOCK');return n;};
 const mint=(body,at)=>{const token=Object.freeze({schema:'crm-deliverability-admission-v1',brand,type:body.type});admissions.set(token,{body:Object.freeze(body),admittedAt:at,expiresAt:at+LIMITS.admissionTtlMs});return token;};
 function initialState(){return freezeState({schema:VERSION,brand,initialSoftBounceAttempts:initialLimit,revision:0,records:[],historyHash:genesis(brand,initialLimit)});}
 async function admitEvent(raw,context){
  let e;try{e=await verify(raw,context);}catch{fail('DELIVERABILITY_EVENT_UNCONFIRMED');}
  shape(e,['schema','providerId','brand','recipientRef','eventId','attemptId','classification','occurredAt']);
  const at=time();
  if(e.schema!==EVENT_VERSION||e.brand!==brand||!providers.has(e.providerId)||typeof e.recipientRef!=='string'||!HEX.test(e.recipientRef)||typeof e.eventId!=='string'||!ID.test(e.eventId)||typeof e.attemptId!=='string'||!ID.test(e.attemptId)||!['hard_bounce','soft_bounce','delivered'].includes(e.classification)||!instant(e.occurredAt)||e.occurredAt>at)fail('DELIVERABILITY_EVENT_UNCONFIRMED');
  return mint({type:'event',providerId:e.providerId,eventRef:hash(['crm-deliverability-event-v1',brand,e.providerId,e.eventId]),attemptRef:hash(['crm-deliverability-attempt-v1',brand,e.recipientRef,e.attemptId]),recipientRef:e.recipientRef,classification:e.classification,occurredAt:e.occurredAt},at);
 }
 async function admitPolicyChange(input,context){
  if(!authorize)fail('DELIVERABILITY_CONFIG_NOT_ADMITTED');
  shape(input,['operationId','softBounceAttempts']);
  if(typeof input.operationId!=='string'||!UUID.test(input.operationId)||!positive(input.softBounceAttempts))fail('DELIVERABILITY_CONFIG');
  const request=Object.freeze({brand,operationId:input.operationId,softBounceAttempts:input.softBounceAttempts});
  let proof;try{proof=await authorize(request,context);}catch{fail('DELIVERABILITY_CONFIG_NOT_ADMITTED');}
  shape(proof,['brand','actorRef']);
  if(proof.brand!==brand||typeof proof.actorRef!=='string'||!HEX.test(proof.actorRef))fail('DELIVERABILITY_CONFIG_NOT_ADMITTED');
  return mint({type:'configuration',operationRef:hash(['crm-deliverability-configuration-v1',brand,request.operationId]),actorRef:proof.actorRef,softBounceAttempts:request.softBounceAttempts},time());
 }
 function replay(state,at){
  shape(state,['schema','brand','initialSoftBounceAttempts','revision','records','historyHash']);array(state.records,LIMITS.records);
  if(state.schema!==VERSION||state.brand!==brand||!positive(state.initialSoftBounceAttempts)||state.revision!==state.records.length||typeof state.historyHash!=='string'||!HEX.test(state.historyHash))fail('DELIVERABILITY_STATE_SCOPE');
  let previous=genesis(brand,state.initialSoftBounceAttempts),limit=state.initialSoftBounceAttempts,lastAt=0;
  const recipients=new Map(),events=new Map(),operations=new Map(),records=[];
  const subject=ref=>{if(!recipients.has(ref))recipients.set(ref,{soft:new Set(),hard:new Set(),reason:null,blockedAt:null});return recipients.get(ref);};
  const suppress=(s,reason,t)=>{if(s.reason===null)s.blockedAt=t;if(reason==='hard_bounce'||s.reason===null)s.reason=reason;};
  function consume(r){
   if(r.type==='configuration'){
    limit=r.softBounceAttempts;operations.set(r.operationRef,hash(facts(r)));
    for(const s of recipients.values())if(s.soft.size>=limit)suppress(s,'soft_threshold',r.recordedAt);
   }else{
    events.set(r.eventRef,hash(facts(r)));const s=subject(r.recipientRef);
    if(r.classification==='soft_bounce')s.soft.add(r.attemptRef);
    if(r.classification==='hard_bounce'){s.hard.add(r.attemptRef);suppress(s,'hard_bounce',r.recordedAt);}
    if(s.soft.size>=limit)suppress(s,'soft_threshold',r.recordedAt);
   }
  }
  for(const r of state.records){
   const type=Object.getOwnPropertyDescriptor(r||{},'type');if(!type||!own(type,'value'))fail('DELIVERABILITY_FIELDS');
   if(type.value==='event'){
    shape(r,['type','providerId','eventRef','attemptRef','recipientRef','classification','occurredAt','recordedAt','previousHash','hash']);
    if(typeof r.providerId!=='string'||!PROVIDER.test(r.providerId)||[r.eventRef,r.attemptRef,r.recipientRef].some(x=>typeof x!=='string'||!HEX.test(x))||!['hard_bounce','soft_bounce','delivered'].includes(r.classification)||!instant(r.occurredAt)||r.occurredAt>r.recordedAt||events.has(r.eventRef))fail('DELIVERABILITY_STATE_CORRUPT');
   }else if(type.value==='configuration'){
    shape(r,['type','operationRef','actorRef','softBounceAttempts','recordedAt','previousHash','hash']);
    if([r.operationRef,r.actorRef].some(x=>typeof x!=='string'||!HEX.test(x))||!positive(r.softBounceAttempts)||operations.has(r.operationRef))fail('DELIVERABILITY_STATE_CORRUPT');
   }else fail('DELIVERABILITY_STATE_CORRUPT');
   if(!instant(r.recordedAt)||r.recordedAt<lastAt||r.recordedAt>at||r.previousHash!==previous||r.hash!==recordHash(brand,previous,r))fail('DELIVERABILITY_STATE_CORRUPT');
   const normal={...facts(r),recordedAt:r.recordedAt,previousHash:previous,hash:r.hash};records.push(normal);consume(normal);previous=r.hash;lastAt=r.recordedAt;
  }
  if(previous!==state.historyHash)fail('DELIVERABILITY_STATE_CORRUPT');
  return {state:{schema:VERSION,brand,initialSoftBounceAttempts:state.initialSoftBounceAttempts,revision:records.length,records,historyHash:previous},recipients,events,operations,limit,lastAt};
 }
 function decision(loaded,recipientRef){
  if(typeof recipientRef!=='string'||!HEX.test(recipientRef))fail('DELIVERABILITY_RECIPIENT');
  const s=loaded.recipients.get(recipientRef);
  return Object.freeze({schema:'crm-deliverability-decision-v1',brand,recipientRef,softBounceAttempts:loaded.limit,softBounceAttemptCount:s?.soft.size||0,hardBounceAttemptCount:s?.hard.size||0,houseSuppressed:!!s?.reason,reason:s?.reason||null,blockedAt:s?.blockedAt??null,policyRevision:loaded.state.revision,historyHash:loaded.state.historyHash,authorizesSend:false,providerSuppressionConfirmed:false,workerSuspensionChanged:false,trackingChanged:false});
 }
 function inspect(state,recipientRef){return decision(replay(state,time()),recipientRef);}
 function apply(state,token){
  const admitted=admissions.get(token),at=time();
  if(!admitted||at<admitted.admittedAt||at>=admitted.expiresAt)fail('DELIVERABILITY_ADMISSION_REQUIRED');
  const loaded=replay(state,at),body=admitted.body;
  const existing=body.type==='event'?loaded.events.get(body.eventRef):loaded.operations.get(body.operationRef);
  if(existing!==undefined&&existing!==hash(body))fail('DELIVERABILITY_EVENT_CONFLICT');
  let next=loaded.state,status='duplicate';
  if(existing===undefined){
   if(next.records.length>=LIMITS.records)fail('DELIVERABILITY_LEDGER_LIMIT');
   const entry={...body,recordedAt:at,previousHash:next.historyHash};entry.hash=recordHash(brand,entry.previousHash,entry);
   next={...next,revision:next.revision+1,records:[...next.records,entry],historyHash:entry.hash};status='recorded';
  }
  const final=replay(next,at),frozen=freezeState(final.state);
  return Object.freeze({schema:'crm-deliverability-transition-v1',type:body.type,status,state:frozen,decision:body.type==='event'?decision(final,body.recipientRef):null,requiresPersistence:status==='recorded',durableCommitConfirmed:false,providerSuppressionConfirmed:false,authorizesSend:false,workerSuspensionChanged:false,trackingChanged:false});
 }
 return Object.freeze({initialState,admitEvent,admitPolicyChange,apply,inspect});
}
module.exports=Object.freeze({VERSION,EVENT_VERSION,LIMITS,BRANDS,createPolicy});
