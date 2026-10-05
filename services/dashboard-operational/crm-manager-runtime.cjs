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
const corporateDescriptors=new WeakSet();
const CORPORATE_WRITER_MODE='corporate-read-writer-v1';
const OWN_MASTER_WRITER_MODE='own-master-production-v1',ownMasterDescriptors=new WeakSet();
function ownMasterWriterDescriptor(mode,allowedEmailDomains){
 if(mode!==OWN_MASTER_WRITER_MODE||!Array.isArray(allowedEmailDomains)||allowedEmailDomains.length!==3||Object.keys(allowedEmailDomains).length!==3||new Set(allowedEmailDomains).size!==3||!['oaristocrata.com','shrigma.com.br','fishermans.com.br'].every(d=>allowedEmailDomains.includes(d)))refuse();
 const out=Object.freeze({mode});ownMasterDescriptors.add(out);return out;
}
const CORPORATE_HOSTS=Object.freeze([
 Object.freeze({manager:'gerencial.shrigma.com.br',growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),
 Object.freeze({manager:'dashboard-v25-gerencial.tazdb8.easypanel.host',growth:'dashboard-v25-crm.tazdb8.easypanel.host',organico:'dashboard-v25-organico.tazdb8.easypanel.host',influs:'dashboard-v25-influs.tazdb8.easypanel.host'})
]);
function corporateHostsAllowed(managerHost,areaHosts){
 try{const areas=snapshot(areaHosts,['growth','organico','influs']);return CORPORATE_HOSTS.some(h=>h.manager===managerHost&&['growth','organico','influs'].every(k=>h[k]===areas[k]));}catch{return false;}
}
const WRITER_ORIGIN='https://comunicacao-crm-manager-writer.tazdb8.easypanel.host';
const WRITER_PATHS=Object.freeze({prepare_writer:'/internal/v1/crm-writers/prepare',renew_writer:'/internal/v1/crm-writers/prepare',commit_writer:'/internal/v1/crm-writers/commit',revoke_writer:'/internal/v1/crm-writers/revoke',writer_status:'/internal/v1/crm-writers/status'});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function corporateWriterDescriptor(value,read,allowedEmailDomains){
 const keys=['mode','issuerId','namespaceId',...(Object.hasOwn(value||{},'provisionerToken')?['provisionerToken']:[])];
 const v=snapshot(value,keys);
 if(v.mode!==CORPORATE_WRITER_MODE||!UUID.test(v.issuerId||'')||!UUID.test(v.namespaceId||'')||!read||!UUID.test(read.issuerId||'')||!UUID.test(read.namespaceId||'')||new Set([v.issuerId,v.namespaceId,read.issuerId,read.namespaceId]).size!==4||!(Array.isArray(allowedEmailDomains)&&allowedEmailDomains.length===3&&Object.keys(allowedEmailDomains).length===3&&new Set(allowedEmailDomains).size===3&&['oaristocrata.com','shrigma.com.br','fishermans.com.br'].every(d=>allowedEmailDomains.includes(d)))||Object.hasOwn(v,'provisionerToken')&&!/^[A-Za-z0-9_-]{43,128}$/.test(v.provisionerToken))refuse();
 const out=Object.freeze({mode:v.mode,issuerId:v.issuerId,namespaceId:v.namespaceId});corporateDescriptors.add(out);return out;
}
// A separate, fixed writer origin and authentication scheme. Neither a SQL
// string nor destination, bearer, callback or service token comes from HTTP.
function writerTransport(requestImpl,token,q){
 const {FUNCTIONS}=require('./crm-manager-writer-client.cjs');
 if(!plain(q)||Reflect.ownKeys(q).length!==2||!Array.isArray(q.parameters)||q.parameters.length!==1||typeof q.parameters[0]!=='string'||Buffer.byteLength(q.parameters[0])>4096)refuse();
 let command;try{command=JSON.parse(q.parameters[0]);}catch{refuse();}
 if(!Object.hasOwn(WRITER_PATHS,command.action)||FUNCTIONS[command.action]!==q.procedure)refuse();
 return new Promise((resolve,reject)=>{
  let settled=false,request,response,ended=false;
  const finish=(failed,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(failed){try{response?.destroy();}catch{}try{request?.destroy();}catch{}reject(new ManagedCrmRuntimeError());}else resolve(value);};
  const timer=setTimeout(()=>finish(true),5000);
  try{
   request=requestImpl(WRITER_ORIGIN+WRITER_PATHS[command.action],{method:'POST',agent:false,rejectUnauthorized:true,maxHeaderSize:8192,headers:{Authorization:'CRM-Writer-Provisioner '+token,'Content-Type':'application/json; charset=utf-8',Accept:'application/json','Accept-Encoding':'identity','Content-Length':Buffer.byteLength(q.parameters[0]),'Cache-Control':'no-store'}},res=>{
    response=res;if(settled){try{res.destroy();}catch{}return;}
    const h=res.headers||{},length=h['content-length'];
    if(res.statusCode!==200||typeof h['content-type']!=='string'||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(h['content-type'])||h['content-encoding']!==undefined&&h['content-encoding']!=='identity'||length!==undefined&&(typeof length!=='string'||!/^\d{1,5}$/.test(length)||Number(length)>8192))return finish(true);
    if(Array.isArray(res.rawHeaders))for(const name of ['content-type','content-length','content-encoding'])if(res.rawHeaders.filter((_,i)=>i%2===0).filter(v=>String(v).toLowerCase()===name).length>1)return finish(true);
    let bytes=0,reads=0;const chunks=[];
    res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));res.on('close',()=>{if(!ended)finish(true);});
    res.on('data',chunk=>{if(settled)return;if(!(chunk instanceof Uint8Array)||++reads>8193||bytes+chunk.byteLength>8192)return finish(true);bytes+=chunk.byteLength;chunks.push(Buffer.from(chunk));});
    res.on('end',()=>{ended=true;if(settled)return;if(length!==undefined&&Number(length)!==bytes)return finish(true);let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return finish(true);}finish(false,body);});
   });
   request.on('error',()=>finish(true));request.setTimeout(5000,()=>finish(true));request.end(q.parameters[0]);
  }catch{finish(true);}
 });
}
function createWriterManagerRuntime(config,adapters={}){
 try{
  const c=snapshot(config,['auth','descriptor','readDescriptor','allowedEmailDomains','provisionerToken']);
  corporateWriterDescriptor(c.descriptor,c.readDescriptor,c.allowedEmailDomains);
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(c.provisionerToken)||!plain(adapters)||Reflect.ownKeys(adapters).some(k=>!['requestImpl','fetchImpl','now'].includes(k))||Object.values(adapters).some(v=>typeof v!=='function'))refuse();
  const journal=c.auth?.managedCampaignWriterJournal;if(!journal||typeof journal.pending!=='function')refuse();
  const {createWriterClient}=require('./crm-manager-writer-client.cjs'),{createWriterCoordinator}=require('./crm-manager-writer-coordinator.cjs'),{verifyCampaignWriterCredential}=require('./crm-campaign-writer-attestation.cjs');
  const now=adapters.now||Date.now,client=createWriterClient({issuerId:c.descriptor.issuerId,namespaceId:c.descriptor.namespaceId,allowedEmailDomains:c.allowedEmailDomains,now,invoke:q=>writerTransport(adapters.requestImpl||require('node:https').request,c.provisionerToken,q)});
  const coordinator=createWriterCoordinator({journal,client,now,attest:q=>verifyCampaignWriterCredential(q,adapters.fetchImpl?{fetchImpl:adapters.fetchImpl}:{})});
  let closed=false,active=null,closing=null;
  function kick(){
   if(closed)return Promise.resolve(ZERO);if(active)return active;
   const work=async()=>{const counts={ready:0,pending:0,expired:0,revoked:0};for(const id of journal.pending(8)){if(closed)break;let result;try{result=await coordinator.run(id);}catch{result=CLOSED_OPERATION;}counts[Object.hasOwn(counts,result?.state)?result.state:'pending']++;}return Object.freeze(counts);};
   let promise;promise=Promise.resolve().then(work).catch(()=>PENDING).finally(()=>{if(active===promise)active=null;});active=promise;return promise;
  }
  function close(){closed=true;if(!closing)closing=active?active.then(()=>undefined,()=>undefined):Promise.resolve();return closing;}
  return Object.freeze({kick,close});
 }catch{refuse();}
}
module.exports={createManagerRuntime,createWriterManagerRuntime,corporateWriterDescriptor,ownMasterWriterDescriptor,corporateHostsAllowed,CORPORATE_WRITER_MODE,OWN_MASTER_WRITER_MODE,WRITER_ORIGIN,isCorporateWriterDescriptor:value=>corporateDescriptors.has(value),isOwnMasterWriterDescriptor:value=>ownMasterDescriptors.has(value),isCampaignWriterDescriptor:value=>corporateDescriptors.has(value)||ownMasterDescriptors.has(value),ManagedCrmRuntimeError};
