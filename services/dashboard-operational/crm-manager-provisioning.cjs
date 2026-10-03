'use strict';
// Proposed internal management origin. This module is deliberately not imported
// by auth/server or included in the runtime pack until the origin is reviewed.
// It never accepts a manager bearer: only a caller-computed SHA-256 digest.
const https=require('node:https');
const crypto=require('node:crypto');

const MANAGEMENT_ORIGIN='https://comunicacao-crm-manager-provisioner.tazdb8.easypanel.host';
const REQUEST_SCHEMA='crm-manager-provision-request-v1';
const RECEIPT_SCHEMA='crm-manager-provision-receipt-v1';
const STATUS_SCHEMA='crm-manager-provision-status-v1';
const ERROR_SCHEMA='crm-manager-provision-error-v1';
const CAPS=Object.freeze(['read_content','list_history','submission']);
const POLICY=Object.freeze({area:'growth',slot:'crm-panel-read',role:'manager',caps:CAPS,candidateTtlMs:600000,lifetimeMs:14*24*60*60*1000});
const PATHS=Object.freeze({prepare_read:'/internal/v1/crm-managers/prepare',renew_read:'/internal/v1/crm-managers/prepare',commit_read:'/internal/v1/crm-managers/commit',revoke_read:'/internal/v1/crm-managers/revoke',status:'/internal/v1/crm-managers/status'});
const MAX_REQUEST=4096,MAX_RESPONSE=8192,TIMEOUT_MS=5000,MAX_OPERATIONS=4096;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uuid=value=>typeof value==='string'&&UUID.test(value);
const PRINCIPAL=/^dcrm-[a-f0-9]{32}$/;
const HASH=/^[a-f0-9]{64}$/;
const COMMON=['operationId','userId','lifecycleId','owner'];
const PREPARE=[...COMMON,'principalId','keySha256'];
const RENEW=[...PREPARE,'generation','expectedGeneration'];
const COMMIT=[...RENEW,'prepareOperationId','issuedAt','candidateExpiresAt','expiresAt'];
const REMOTE_ERRORS=Object.freeze({INPUT_INVALID:400,AUTH_REQUIRED:401,ISSUER_DENIED:403,SUBJECT_NOT_FOUND:404,IDEMPOTENCY_CONFLICT:409,GENERATION_CONFLICT:409,LIFECYCLE_REVOKED:409,CANDIDATE_EXPIRED:409,CREDENTIAL_CONFLICT:409,EDIT_NOT_READY:403,UNAVAILABLE:503});

class ProvisioningError extends Error{
 constructor(code,{uncertain=false,retryable=false,status=503}={}){super(code);this.name='ProvisioningError';this.code=code;this.uncertain=uncertain;this.retryable=retryable;this.status=status;}
}
const refuse=(code='PROVISIONING_INPUT_INVALID',status=400)=>{throw new ProvisioningError(code,{status});};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
function exact(value,keys){
 if(!plain(value)||Reflect.ownKeys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key)))return false;
 return keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d&&d.enumerable&&Object.hasOwn(d,'value');});
}
function freeze(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(!plain(value))refuse();return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
const sha=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const timestamp=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000-POLICY.lifetimeMs;
const generation=value=>Number.isSafeInteger(value)&&value>=0&&value<=999999999;
const policyMatches=value=>value.area===POLICY.area&&value.slot===POLICY.slot&&value.role===POLICY.role&&Array.isArray(value.caps)&&value.caps.length===CAPS.length&&value.caps.every((cap,index)=>cap===CAPS[index]);
function fixedPolicy(){return {area:POLICY.area,slot:POLICY.slot,role:POLICY.role,caps:[...CAPS],candidateTtlMs:POLICY.candidateTtlMs,lifetimeMs:POLICY.lifetimeMs};}

// The only credential in this transport is a separate service authentication
// token. This auth scheme cannot be confused with a manager's Bearer header.
function transport({requestImpl,token,action,payload}){
 const body=canonical(payload);
 if(Buffer.byteLength(body,'utf8')>MAX_REQUEST)refuse('PROVISIONING_REQUEST_TOO_LARGE',413);
 return new Promise((resolve,reject)=>{
  let settled=false,request,response,ended=false;
  const finish=(error,value)=>{
   if(settled)return;settled=true;clearTimeout(deadline);
   if(error){try{response?.destroy();}catch{}try{request?.destroy();}catch{}reject(error);}else resolve(value);
  };
  const fail=code=>finish(new ProvisioningError(code,{uncertain:action!=='status',retryable:true}));
  const deadline=setTimeout(()=>fail('PROVISIONING_TRANSPORT_TIMEOUT'),TIMEOUT_MS);
  try{
   request=requestImpl(MANAGEMENT_ORIGIN+PATHS[action],{
    method:'POST',rejectUnauthorized:true,agent:false,maxHeaderSize:8192,
    headers:{Authorization:'CRM-Provisioner '+token,'Content-Type':'application/json; charset=utf-8',Accept:'application/json','Content-Length':Buffer.byteLength(body,'utf8'),'Cache-Control':'no-store'}
   },res=>{
    response=res;if(settled){try{res.destroy();}catch{}return;}
    const status=res.statusCode;
    if(!Number.isInteger(status)||status<200||status>=300&& !Object.values(REMOTE_ERRORS).includes(status)||status!==200&&status<300)return fail('PROVISIONING_HTTP_REFUSED');
    const headers=res.headers||{},contentType=headers['content-type'],encoding=headers['content-encoding'],length=headers['content-length'];
    if(typeof contentType!=='string'||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)||encoding!==undefined&&encoding!=='identity')return fail('PROVISIONING_RESPONSE_INVALID');
    if(length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>MAX_RESPONSE))return fail('PROVISIONING_RESPONSE_INVALID');
    if(Array.isArray(res.rawHeaders))for(const name of ['content-type','content-length','content-encoding'])if(res.rawHeaders.filter((_,i)=>i%2===0).filter(h=>String(h).toLowerCase()===name).length>1)return fail('PROVISIONING_RESPONSE_INVALID');
    const chunks=[];let bytes=0;
    res.on('error',()=>fail('PROVISIONING_TRANSPORT_UNAVAILABLE'));
    res.on('aborted',()=>fail('PROVISIONING_TRANSPORT_UNAVAILABLE'));
    res.on('close',()=>{if(!ended)fail('PROVISIONING_TRANSPORT_UNAVAILABLE');});
    res.on('data',chunk=>{
     if(settled)return;
     if(!(chunk instanceof Uint8Array))return fail('PROVISIONING_RESPONSE_INVALID');
     bytes+=chunk.byteLength;if(bytes>MAX_RESPONSE)return fail('PROVISIONING_RESPONSE_INVALID');chunks.push(Buffer.from(chunk));
    });
    res.on('end',()=>{
     ended=true;if(settled)return;
     if(length!==undefined&&Number(length)!==bytes)return fail('PROVISIONING_RESPONSE_INVALID');
     let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return fail('PROVISIONING_RESPONSE_INVALID');}
     finish(null,{status,value});
    });
   });
   request.on('error',()=>fail('PROVISIONING_TRANSPORT_UNAVAILABLE'));
   request.setTimeout(TIMEOUT_MS,()=>fail('PROVISIONING_TRANSPORT_TIMEOUT'));
   request.end(body);
  }catch{fail('PROVISIONING_TRANSPORT_UNAVAILABLE');}
 });
}

function createProvisioningClient(options){
 if(!plain(options))refuse('PROVISIONING_CONFIGURATION_INVALID',500);
 if(!exact(options,['issuerId','namespaceId','allowedEmailDomains','provisionerToken',...(['requestImpl','now'].filter(key=>Object.hasOwn(options,key)))]))refuse('PROVISIONING_CONFIGURATION_INVALID',500);
 const {issuerId,namespaceId,provisionerToken:token}=options;
 if(!uuid(issuerId)||!uuid(namespaceId)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(token))refuse('PROVISIONING_CONFIGURATION_INVALID',500);
 const domains=options.allowedEmailDomains;
 if(!Array.isArray(domains)||domains.length<1||domains.length>8||Object.keys(domains).length!==domains.length||new Set(domains).size!==domains.length||domains.some(domain=>typeof domain!=='string'||domain.length>253||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)))refuse('PROVISIONING_CONFIGURATION_INVALID',500);
 const allowedDomains=new Set(domains),requestImpl=Object.hasOwn(options,'requestImpl')?options.requestImpl:https.request,now=Object.hasOwn(options,'now')?options.now:Date.now;
 if(typeof requestImpl!=='function'||typeof now!=='function')refuse('PROVISIONING_CONFIGURATION_INVALID',500);
 const operations=new Map(),preparedProofs=new WeakMap(),revokedLifecycles=new Set();
 const current=()=>{let t;try{t=now();}catch{refuse('PROVISIONING_CLOCK_INVALID',500);}if(!timestamp(t))refuse('PROVISIONING_CLOCK_INVALID',500);return t;};
 function ownerValid(owner){
  return typeof owner==='string'&&owner.length<=254&&owner===owner.toLowerCase()&&/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,63}$/.test(owner)&&owner.split('@')[0].length<=64&&allowedDomains.has(owner.split('@')[1]);
 }
 function normalize(action,args){
  const keys=action==='prepare_read'?PREPARE:action==='renew_read'?RENEW:action==='commit_read'?COMMIT:action==='revoke_read'?COMMON:null;
  if(!keys||!exact(args,keys))refuse();
  const snapshot=Object.fromEntries(keys.map(key=>[key,args[key]]));
  if(!uuid(snapshot.operationId)||!uuid(snapshot.userId)||!uuid(snapshot.lifecycleId)||!ownerValid(snapshot.owner))refuse();
  if(action!=='revoke_read'){
   if(typeof snapshot.principalId!=='string'||!PRINCIPAL.test(snapshot.principalId)||typeof snapshot.keySha256!=='string'||!HASH.test(snapshot.keySha256))refuse();
   if(action==='prepare_read'){snapshot.generation=1;snapshot.expectedGeneration=0;}
   if(!generation(snapshot.generation)||!generation(snapshot.expectedGeneration)||snapshot.generation!==snapshot.expectedGeneration+1||action==='renew_read'&&snapshot.expectedGeneration<1)refuse();
   if(action==='commit_read'&&(!uuid(snapshot.prepareOperationId)||snapshot.prepareOperationId===snapshot.operationId||!timestamp(snapshot.issuedAt)||snapshot.candidateExpiresAt!==snapshot.issuedAt+POLICY.candidateTtlMs||snapshot.expiresAt!==snapshot.issuedAt+POLICY.lifetimeMs))refuse();
  }
  return freeze({schema:REQUEST_SCHEMA,issuerId,namespaceId,action,...snapshot,...(action==='revoke_read'?{}:fixedPolicy())});
 }
 function remember(command){
  const encoded=canonical(command),fingerprint=sha(encoded),existing=operations.get(command.operationId);
  if(existing&&existing.fingerprint!==fingerprint)refuse('PROVISIONING_IDEMPOTENCY_CONFLICT',409);
  if(!existing){if(operations.size>=MAX_OPERATIONS)refuse('PROVISIONING_REPLAY_STORE_FULL',503);operations.set(command.operationId,{fingerprint,command,receipt:null,inFlight:null});}
  return operations.get(command.operationId);
 }
 const lifecycleKey=command=>command.userId+':'+command.lifecycleId;
 function receipt(value,command){
  const base=['schema','issuerId','namespaceId','operationId','action','requestSha256','userId','lifecycleId','owner','state'];
  const fields=command.action==='revoke_read'?['revocationMode','allGenerationsRevoked','effectiveAt','revokedCount']:
   ['principalId','generation','expectedGeneration','area','slot','role','caps','issuedAt','candidateExpiresAt','expiresAt',...(command.action==='commit_read'?['prepareOperationId','committedAt','revokedGeneration']:[])];
  if(!exact(value,[...base,...fields])||value.schema!==RECEIPT_SCHEMA||value.issuerId!==issuerId||value.namespaceId!==namespaceId||value.operationId!==command.operationId||value.action!==command.action||value.requestSha256!==sha(canonical(command))||value.userId!==command.userId||value.lifecycleId!==command.lifecycleId||value.owner!==command.owner)refuse('PROVISIONING_RECEIPT_INVALID',502);
  if(command.action==='revoke_read'){
   if(value.state!=='revoked'||value.revocationMode!=='lifecycle'||value.allGenerationsRevoked!==true||!timestamp(value.effectiveAt)||value.effectiveAt>current()+30000||!Number.isSafeInteger(value.revokedCount)||value.revokedCount<0||value.revokedCount>999999999)refuse('PROVISIONING_RECEIPT_INVALID',502);
  }else{
   if(value.principalId!==command.principalId||value.generation!==command.generation||value.expectedGeneration!==command.expectedGeneration||!policyMatches(value)||!timestamp(value.issuedAt)||value.issuedAt>current()+30000||value.candidateExpiresAt!==value.issuedAt+POLICY.candidateTtlMs||value.expiresAt!==value.issuedAt+POLICY.lifetimeMs)refuse('PROVISIONING_RECEIPT_INVALID',502);
   if(command.action==='commit_read'){
    if(value.state!=='committed'||value.prepareOperationId!==command.prepareOperationId||value.issuedAt!==command.issuedAt||value.candidateExpiresAt!==command.candidateExpiresAt||value.expiresAt!==command.expiresAt||!timestamp(value.committedAt)||value.committedAt<value.issuedAt||value.committedAt>=value.candidateExpiresAt||value.committedAt>current()+30000||value.revokedGeneration!==(command.expectedGeneration===0?null:command.expectedGeneration))refuse('PROVISIONING_RECEIPT_INVALID',502);
   }else if(value.state!=='prepared')refuse('PROVISIONING_RECEIPT_INVALID',502);
  }
  const record=remember(command),encoded=canonical(value);
  if(record.receipt!==null&&record.receipt!==encoded)refuse('PROVISIONING_REPLAY_RECEIPT_CHANGED',502);
  record.receipt=encoded;
  const result=freeze(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='requestSha256')));
  if(command.action==='prepare_read'||command.action==='renew_read')preparedProofs.set(result,command);
  if(command.action==='revoke_read')revokedLifecycles.add(lifecycleKey(command));
  return result;
 }
 function remoteError(value,status,command){
  if(!exact(value,['schema','issuerId','namespaceId','operationId','requestSha256','code'])||value.schema!==ERROR_SCHEMA||value.issuerId!==issuerId||value.namespaceId!==namespaceId||value.operationId!==command.operationId||value.requestSha256!==sha(canonical(command))||typeof value.code!=='string'||!Object.hasOwn(REMOTE_ERRORS,value.code)||REMOTE_ERRORS[value.code]!==status)throw new ProvisioningError('PROVISIONING_RESPONSE_INVALID',{uncertain:command.action!=='status',retryable:true,status:502});
  throw new ProvisioningError('PROVISIONING_'+value.code,{uncertain:status===503&&command.action!=='status',retryable:status===503,status});
 }
 async function execute(command){
  const record=remember(command);
  current();
  if(command.action!=='revoke_read'&&revokedLifecycles.has(lifecycleKey(command)))refuse('PROVISIONING_LIFECYCLE_REVOKED',409);
  if(command.action==='commit_read'&&current()>=command.candidateExpiresAt)refuse('PROVISIONING_CANDIDATE_EXPIRED',409);
  if(record.inFlight)return record.inFlight;
  record.inFlight=(async()=>{
   const response=await transport({requestImpl,token,action:command.action,payload:command});
   // A revocation acknowledged while this RPC was in flight invalidates its
   // result. The durable journal still must enforce its own local lifecycle CAS.
   if(command.action!=='revoke_read'&&revokedLifecycles.has(lifecycleKey(command)))throw new ProvisioningError('PROVISIONING_LIFECYCLE_REVOKED',{uncertain:true,retryable:true,status:409});
   if(response.status!==200)return remoteError(response.value,response.status,command);
   try{return receipt(response.value,command);}catch(error){if(error instanceof ProvisioningError){error.uncertain=true;error.retryable=true;}throw error;}
  })();
  try{return await record.inFlight;}finally{record.inFlight=null;}
 }
 function commitCommand(args){
  if(!exact(args,['operationId','prepared']))refuse();
  const prepared=args.prepared,source=preparedProofs.get(prepared);
  if(!source)refuse('PROVISIONING_PREPARED_PROOF_REQUIRED',403);
  return normalize('commit_read',{operationId:args.operationId,prepareOperationId:source.operationId,userId:source.userId,lifecycleId:source.lifecycleId,owner:source.owner,principalId:source.principalId,keySha256:source.keySha256,generation:source.generation,expectedGeneration:source.expectedGeneration,issuedAt:prepared.issuedAt,candidateExpiresAt:prepared.candidateExpiresAt,expiresAt:prepared.expiresAt});
 }
 function describe(command){
  const keys=command.action==='prepare_read'?PREPARE:command.action==='renew_read'?RENEW:command.action==='commit_read'?COMMIT:COMMON;
  return freeze({action:command.action,args:Object.fromEntries(keys.map(key=>[key,command[key]]))});
 }
 return Object.freeze({
  prepareRead:args=>execute(normalize('prepare_read',args)),
  prepareRenewalRead:args=>execute(normalize('renew_read',args)),
  commitRead:args=>execute(commitCommand(args)),
  revokeRead:args=>execute(normalize('revoke_read',args)),
  prepareEdit:()=>refuse('EDIT_NOT_READY',403),
  describeCommit:args=>describe(commitCommand(args)),
  describeRead:args=>describe(normalize('prepare_read',args)),
  describeRenewalRead:args=>describe(normalize('renew_read',args)),
  describeRevoke:args=>describe(normalize('revoke_read',args)),
  operationStatus:async expected=>{
   if(!plain(expected)||!exact(expected,['action','args',...(Object.hasOwn(expected,'requireFound')?['requireFound']:[])])||Object.hasOwn(expected,'requireFound')&&typeof expected.requireFound!=='boolean')refuse();
   const command=normalize(expected.action,expected.args),record=remember(command);
   current();
   const requireFound=expected.requireFound===true||record.receipt!==null;
   const payload=freeze({schema:REQUEST_SCHEMA,issuerId,namespaceId,action:'status',operationId:command.operationId,expectedRequestSha256:sha(canonical(command))});
   const response=await transport({requestImpl,token,action:'status',payload});
   if(response.status!==200)return remoteError(response.value,response.status,payload);
   const value=response.value;
   if(!exact(value,['schema','issuerId','namespaceId','operationId','found',...(value?.found===true?['receipt']:[])])||value.schema!==STATUS_SCHEMA||value.issuerId!==issuerId||value.namespaceId!==namespaceId||value.operationId!==command.operationId||typeof value.found!=='boolean')refuse('PROVISIONING_STATUS_INVALID',502);
   if(!value.found){if(requireFound)refuse('PROVISIONING_STATUS_DISAPPEARED',502);return freeze({found:false});}
   return freeze({found:true,receipt:receipt(value.receipt,command)});
  }
 });
}
module.exports={createProvisioningClient,ProvisioningError,MANAGEMENT_ORIGIN,PATHS,POLICY,REQUEST_SCHEMA,RECEIPT_SCHEMA,STATUS_SCHEMA,ERROR_SCHEMA,MAX_REQUEST,MAX_RESPONSE,TIMEOUT_MS};
