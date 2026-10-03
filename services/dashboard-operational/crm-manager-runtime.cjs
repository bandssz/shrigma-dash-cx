'use strict';
// Dormant composition only. No environment, startup hook, queue, renewal or
// automatic retry. Private journal/credentials are never returned to callers.
const {createProvisioningClient}=require('./crm-manager-provisioning.cjs');
const {createManagerCoordinator}=require('./crm-manager-coordinator.cjs');
const {verifyManagedCrmCredential}=require('./crm-manager-attestation.cjs');
const {createManagerDispatcher}=require('./crm-manager-dispatcher.cjs');
const CONFIG=['auth','issuerId','namespaceId','allowedEmailDomains','provisionerToken'];
const ADAPTERS=['requestImpl','fetchImpl','now'];
const JOURNAL=['request','beginPrepare','recordPrepared','candidateForAttestation','recordAttestation','commitDescriptor','beginCommit','recordCommitted','promote','expireCandidate','confirmRevoked','operationState','pendingOperations'];
const ZERO=Object.freeze({ready:0,pending:0,expired:0,revoked:0});
const PENDING=Object.freeze({ready:0,pending:1,expired:0,revoked:0});
const CLOSED_OPERATION=Object.freeze({state:'pending'});
class ManagedCrmRuntimeError extends Error{
 constructor(){super('MANAGED_CRM_RUNTIME_REFUSED');this.name='ManagedCrmRuntimeError';this.code='MANAGED_CRM_RUNTIME_REFUSED';}
}
const refuse=()=>{throw new ManagedCrmRuntimeError();};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function snapshot(value,keys){
 if(!plain(value)||Reflect.ownKeys(value).length!==keys.length)refuse();
 const out={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))refuse();out[key]=d.value;}return Object.freeze(out);
}
function domains(value){
 if(!Array.isArray(value)||value.length<1||value.length>8||Reflect.ownKeys(value).length!==value.length+1)refuse();
 const out=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value')||typeof d.value!=='string')refuse();out.push(d.value);}return Object.freeze(out);
}
const observe=value=>{try{Promise.resolve(value).catch(()=>{});}catch{}};
function synchronous(callback){
 const value=callback();
 if(value!==null&&['object','function'].includes(typeof value)){
  let then;try{then=value.then;}catch{observe(value);refuse();}
  if(then!==undefined&&then!==null)observe(then);
  if(typeof then==='function'){observe(value);refuse();}
 }
 return value;
}

// config is EXACT {auth,issuerId,namespaceId,allowedEmailDomains,provisionerToken}.
// adapters is an optional EXACT subset of {requestImpl,fetchImpl,now}.
function createManagerRuntime(config,adapters={}){
 try{
  const c=snapshot(config,CONFIG);
  if(!plain(adapters)||Reflect.ownKeys(adapters).some(k=>!ADAPTERS.includes(k)))refuse();
  const a=snapshot(adapters,ADAPTERS.filter(k=>Object.hasOwn(adapters,k)));
  if(Object.values(a).some(v=>typeof v!=='function')||!plain(c.auth))refuse();
  const descriptor=Object.getOwnPropertyDescriptor(c.auth,'managedCrmJournal');
  if(!descriptor||!Object.hasOwn(descriptor,'value')||!plain(descriptor.value))refuse();
  const provided=descriptor.value,journal={};
  for(const name of JOURNAL){
   const method=Object.getOwnPropertyDescriptor(provided,name);
   if(!method||!Object.hasOwn(method,'value')||typeof method.value!=='function')refuse();
   journal[name]=(...args)=>Reflect.apply(method.value,provided,args);
  }
  Object.freeze(journal);
  const clock=Object.hasOwn(a,'now')?()=>synchronous(a.now):Date.now;
  const client=createProvisioningClient({issuerId:c.issuerId,namespaceId:c.namespaceId,allowedEmailDomains:domains(c.allowedEmailDomains),provisionerToken:c.provisionerToken,now:clock,
   ...(Object.hasOwn(a,'requestImpl')?{requestImpl:(...args)=>synchronous(()=>Reflect.apply(a.requestImpl,undefined,args))}:{})});
  const attest=input=>verifyManagedCrmCredential(input,Object.hasOwn(a,'fetchImpl')?{fetchImpl:a.fetchImpl}:{});
  const coordinator=createManagerCoordinator({journal,client,attest,getOperationState:journal.operationState,now:clock});
  let closed=false,active=null,closing=null;
  const dispatcher=createManagerDispatcher({getPendingOperations:maximum=>closed?[]:journal.pendingOperations(maximum),coordinator:{run:operationId=>closed?Promise.resolve(CLOSED_OPERATION):coordinator.run(operationId)}});
  function kick(){
   if(closed)return Promise.resolve(ZERO);
   if(active)return active;
   let promise;promise=dispatcher.drain().catch(()=>PENDING).finally(()=>{if(active===promise)active=null;});
   active=promise;return promise;
  }
  // Immediately prevent new IDs, but let the already-started operation settle
  // safely before the caller closes auth/SQLite. Preserve every durable intent.
  function close(){
   closed=true;
   if(!closing)closing=active?active.then(()=>undefined,()=>undefined):Promise.resolve();
   return closing;
  }
  return Object.freeze({kick,close});
 }catch{refuse();}
}
module.exports={createManagerRuntime,ManagedCrmRuntimeError};
