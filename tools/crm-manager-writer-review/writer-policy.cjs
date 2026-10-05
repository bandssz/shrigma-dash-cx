'use strict';
// Closed writer protocol only. No sockets, environment, files, timers, database,
// issuer activation or bearer values. The read issuer and its caps stay intact.
const crypto=require('node:crypto');
const CAPS=Object.freeze(['read_content','draft','validate','submit']);
const POLICY=Object.freeze({area:'growth',slot:'growth-campaign',role:'manager',caps:CAPS,candidateTtlMs:600000,lifetimeMs:1209600000});
const SCHEMAS=Object.freeze({request:'crm-manager-writer-request-v1',receipt:'crm-manager-writer-receipt-v1',status:'crm-manager-writer-status-v1'});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PRINCIPAL=/^dcrmw-[a-f0-9]{32}$/,HASH=/^[a-f0-9]{64}$/;
const COMMON=['operationId','userId','lifecycleId','owner'];
const PREPARE=[...COMMON,'brand','principalId','keySha256'];
const RENEW=[...PREPARE,'generation','expectedGeneration'];
const COMMIT=[...RENEW,'prepareOperationId','issuedAt','candidateExpiresAt','expiresAt'];
const COMMANDS=Object.freeze({prepare_writer:PREPARE,renew_writer:RENEW,commit_writer:COMMIT,revoke_writer:COMMON});
class WriterPolicyError extends Error {constructor(){super('CRM_WRITER_POLICY_REFUSED');this.name='WriterPolicyError';this.code='CRM_WRITER_POLICY_REFUSED';}}
function fail(){throw new WriterPolicyError();}
function exact(v,keys){return v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable===true&&Object.hasOwn(d,'value');});}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function canonical(v){if(v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);if(Array.isArray(v))return'['+v.map(canonical).join(',')+']';if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail();return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
const hash=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const uuid=v=>typeof v==='string'&&UUID.test(v),generation=v=>Number.isSafeInteger(v)&&v>=0&&v<=999999999,time=v=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-POLICY.lifetimeMs;
function exactCaps(v){if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||Reflect.ownKeys(v).length!==5||v.length!==4)return false;return CAPS.every((cap,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));return d?.enumerable===true&&Object.hasOwn(d,'value')&&d.value===cap;});}
function createWriterPolicy(config){
 if(!exact(config,['issuerId','namespaceId','allowedEmailDomains','now'])||!uuid(config.issuerId)||!uuid(config.namespaceId)||typeof config.now!=='function'||!Array.isArray(config.allowedEmailDomains)||config.allowedEmailDomains.length<1||config.allowedEmailDomains.length>8||Object.keys(config.allowedEmailDomains).length!==config.allowedEmailDomains.length||new Set(config.allowedEmailDomains).size!==config.allowedEmailDomains.length||config.allowedEmailDomains.some(v=>typeof v!=='string'||v.length>253||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(v)))fail();
 const {issuerId,namespaceId,now}=config,domains=new Set(config.allowedEmailDomains),prepared=new WeakMap(),receipts=new Map(),revokedLifecycles=new Set();
 function current(){let t;try{t=now();if(t&&typeof t.then==='function'){Promise.resolve(t).catch(()=>{});fail();}}catch{fail();}if(!time(t))fail();return t;}
 function owner(v){return typeof v==='string'&&v.length<=254&&v===v.toLowerCase()&&/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,63}$/.test(v)&&v.split('@')[0].length<=64&&domains.has(v.split('@')[1]);}
 function command(action,args){
  const keys=Object.hasOwn(COMMANDS,action)?COMMANDS[action]:null;if(!keys||!exact(args,keys))fail();
  const s=Object.fromEntries(keys.map(k=>[k,args[k]]));
  if(!uuid(s.operationId)||!uuid(s.userId)||!uuid(s.lifecycleId)||!owner(s.owner))fail();
  if(action!=='revoke_writer'){
   if(!['fish','aristo'].includes(s.brand)||typeof s.principalId!=='string'||!PRINCIPAL.test(s.principalId)||typeof s.keySha256!=='string'||!HASH.test(s.keySha256))fail();
   if(action==='prepare_writer'){s.generation=1;s.expectedGeneration=0;}
   if(!generation(s.generation)||!generation(s.expectedGeneration)||s.generation!==s.expectedGeneration+1||action==='renew_writer'&&s.expectedGeneration<1)fail();
   if(action==='commit_writer'&&(!uuid(s.prepareOperationId)||s.prepareOperationId===s.operationId||!time(s.issuedAt)||s.candidateExpiresAt!==s.issuedAt+POLICY.candidateTtlMs||s.expiresAt!==s.issuedAt+POLICY.lifetimeMs))fail();
  }
  return freeze({schema:SCHEMAS.request,issuerId,namespaceId,action,...s,...(action==='revoke_writer'?{}:{area:POLICY.area,slot:POLICY.slot,role:POLICY.role,caps:[...CAPS],candidateTtlMs:POLICY.candidateTtlMs,lifetimeMs:POLICY.lifetimeMs})});
 }
 function expected(input){
  const descriptor=input&&typeof input==='object'?Object.getOwnPropertyDescriptor(input,'action'):null;
  if(!descriptor||!Object.hasOwn(descriptor,'value')||!Object.hasOwn(COMMANDS,descriptor.value))fail();
  const action=descriptor.value,keys=['schema','issuerId','namespaceId','action',...COMMANDS[action],...(action==='revoke_writer'?[]:[...(action==='prepare_writer'?['generation','expectedGeneration']:[]),'area','slot','role','caps','candidateTtlMs','lifetimeMs'])];
  if(!exact(input,keys))fail();
  const args=Object.fromEntries(COMMANDS[input.action].map(k=>[k,input[k]])),normalized=command(input.action,args);
  if(canonical(normalized)!==canonical(input))fail();return normalized;
 }
 function receipt(value,input){
  const c=expected(input),revoked=c.action==='revoke_writer',committed=c.action==='commit_writer';
  const base=['schema','issuerId','namespaceId','operationId','action','requestSha256','userId','lifecycleId','owner','state'];
  const fields=revoked?['revocationMode','allGenerationsRevoked','effectiveAt','revokedCount']:['brand','principalId','generation','expectedGeneration','area','slot','role','caps','issuedAt','candidateExpiresAt','expiresAt',...(committed?['prepareOperationId','committedAt','revokedGeneration']:[])];
  if(!exact(value,[...base,...fields])||value.schema!==SCHEMAS.receipt||value.requestSha256!==hash(c)||['issuerId','namespaceId','operationId','action','userId','lifecycleId','owner'].some(k=>value[k]!==c[k]))fail();
  if(revoked){if(value.state!=='revoked'||value.revocationMode!=='lifecycle'||value.allGenerationsRevoked!==true||!time(value.effectiveAt)||value.effectiveAt>current()+30000||!generation(value.revokedCount))fail();}
  else{
   if(['brand','principalId','generation','expectedGeneration','area','slot','role'].some(k=>value[k]!==c[k])||!exactCaps(value.caps)||!time(value.issuedAt)||value.issuedAt>current()+30000||value.candidateExpiresAt!==value.issuedAt+POLICY.candidateTtlMs||value.expiresAt!==value.issuedAt+POLICY.lifetimeMs)fail();
   if(committed){if(value.state!=='committed'||['prepareOperationId','issuedAt','candidateExpiresAt','expiresAt'].some(k=>value[k]!==c[k])||!time(value.committedAt)||value.committedAt<value.issuedAt||value.committedAt>=value.candidateExpiresAt||value.committedAt>current()+30000||value.revokedGeneration!==(c.expectedGeneration===0?null:c.expectedGeneration))fail();}
   else if(value.state!=='prepared')fail();
  }
  const previous=receipts.get(c.operationId),encoded=canonical(value),requestHash=hash(c);
  if(previous&&(previous.requestHash!==requestHash||previous.encoded!==encoded)||!previous&&receipts.size>=4096)fail();
  receipts.set(c.operationId,{requestHash,encoded});const result=freeze(JSON.parse(encoded));
  if(!revoked&&!committed)prepared.set(result,c);
  if(revoked)revokedLifecycles.add(c.userId+':'+c.lifecycleId);return result;
 }
 function commit(input){
  if(!exact(input,['operationId','proof']))fail();const {operationId,proof}=input;
  const c=prepared.get(proof);if(!c||current()>=proof.candidateExpiresAt||revokedLifecycles.has(c.userId+':'+c.lifecycleId))fail();
  return command('commit_writer',{operationId,prepareOperationId:c.operationId,userId:c.userId,lifecycleId:c.lifecycleId,owner:c.owner,brand:c.brand,principalId:c.principalId,keySha256:c.keySha256,generation:c.generation,expectedGeneration:c.expectedGeneration,issuedAt:proof.issuedAt,candidateExpiresAt:proof.candidateExpiresAt,expiresAt:proof.expiresAt});
 }
 function statusRequest(input){const c=expected(input);return freeze({schema:SCHEMAS.request,issuerId,namespaceId,action:'writer_status',operationId:c.operationId,expectedRequestSha256:hash(c)});}
 function status(value,input,options={}){
  if(!exact(options,[])&&!exact(options,['requireFound']))fail();const requireFound=options.requireFound??false;
  if(typeof requireFound!=='boolean')fail();const c=expected(input);
  if(!exact(value,['schema','issuerId','namespaceId','operationId','found',...(value?.found===true?['receipt']:[])])||value.schema!==SCHEMAS.status||value.issuerId!==issuerId||value.namespaceId!==namespaceId||value.operationId!==c.operationId||typeof value.found!=='boolean')fail();
  if(!value.found){if(requireFound||receipts.has(c.operationId))fail();return freeze({found:false});}
  return freeze({found:true,receipt:receipt(value.receipt,c)});
 }
 const guard=fn=>(...values)=>{try{return fn(...values);}catch{fail();}};
 return Object.freeze({command:guard(command),receipt:guard(receipt),commit:guard(commit),statusRequest:guard(statusRequest),status:guard(status)});
}
module.exports={createWriterPolicy,WriterPolicyError,CAPS,POLICY,SCHEMAS};
