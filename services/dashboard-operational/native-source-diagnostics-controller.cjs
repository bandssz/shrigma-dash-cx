'use strict';
const crypto=require('node:crypto');
const {createSourceDiagnostics,PURPOSE,RESOURCE}=require('./native-source-diagnostics.cjs');
const SCOPE='crm.source-diagnostics',HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const exact=(x,keys)=>!!x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
function createDiagnosticsController({enabled=false,driver,auth,coreFactory=createSourceDiagnostics}={}){
 const source=auth?.nativeSourceSync,vault=auth?.nativeDatabaseVault,store=auth?.nativeConnections;
 const ready=enabled===true&&typeof driver?.Client==='function'&&driver.version==='8.23.1'&&HASH.test(driver.packageSha256||'')&&typeof source?.diagnosticsBinding==='function'&&typeof vault?.getPrivateCredential==='function'&&typeof store?.permitSourceDiagnostics==='function'&&typeof store?.sourceDiagnosticsConsent==='function';
 let active=null,closing=false;
 function requireReady(){if(!ready||closing)fail('SOURCE_DIAGNOSTICS_NOT_ADMITTED',503);}
 function input(context,value){
  const native=context?.nativeBearer!==undefined,keys=['brand','requestId',...(native?[]:['connectionId'])];
  if(!exact(value,keys)||!['fish','aristo'].includes(value.brand)||!UUID.test(value.requestId||''))fail('SOURCE_DIAGNOSTICS_ARGUMENTS_INVALID',400);
  const connectionId=native?store.authenticate(context.nativeBearer,{scope:SCOPE,brand:value.brand}).id:value.connectionId;
  if(typeof connectionId!=='string'||!UUID.test(connectionId))fail('SOURCE_DIAGNOSTICS_ARGUMENTS_INVALID',400);
  return {brand:value.brand,requestId:value.requestId,connectionId};
 }
 function snapshot(context,q){
  const original=source.diagnosticsBinding({context,brand:q.brand,requestId:q.requestId});
  const profile=vault.getPrivateCredential({ownerId:original.ownerId}),{password,...pub}=profile;
  if(profile.ownerId!==original.ownerId||canonical(profile.resource)!==canonical(RESOURCE)||profile.transport?.mode!=='admitted-private-network')fail('SOURCE_DIAGNOSTICS_BINDING_CHANGED',409);
  return {schema:'shrigma-source-diagnostics-consent-v1',ownerId:original.ownerId,ownerRevision:original.ownerRevision,brand:q.brand,requestId:q.requestId,operationId:original.operationId,sourceBindingHash:sha(canonical(original)),profileRevision:profile.revision,credentialBindingHash:sha(canonical(pub)),resourceHash:sha(canonical(RESOURCE))};
 }
 function current(context,q,expected){
  const consent=store.sourceDiagnosticsConsent({context,...q});
  const now=snapshot(context,q);
  if(canonical(consent)!==canonical(now)||expected&&canonical(expected)!==canonical(now))fail('SOURCE_DIAGNOSTICS_BINDING_CHANGED',409);
  return now;
 }
 const core=ready?coreFactory({enabled:true,driver,
  getPrivateCredential:({ownerId})=>{
   if(!active||ownerId!==active.binding.ownerId)fail('SOURCE_DIAGNOSTICS_BINDING_CHANGED',409);
   current(active.context,active.q,active.binding);
   return vault.getPrivateCredential({ownerId});
  },
  admitDiagnostic:proof=>{
   if(!active||!['connect','read','release'].includes(proof?.phase)||proof.purpose!==PURPOSE)fail('SOURCE_DIAGNOSTICS_BINDING_CHANGED',409);
   const b=current(active.context,active.q,active.binding);
   if(proof.ownerId!==b.ownerId||proof.profileRevision!==b.profileRevision||proof.credentialBindingHash!==b.credentialBindingHash||proof.resourceHash!==b.resourceHash)fail('SOURCE_DIAGNOSTICS_BINDING_CHANGED',409);
   return {admitted:true,ownerId:b.ownerId,profileRevision:b.profileRevision,credentialBindingHash:b.credentialBindingHash,resourceHash:b.resourceHash,purpose:PURPOSE};
  }}):null;
 function status(context){
  requireReady();
  const connections=store.list(context).filter(c=>!c.revoked&&c.expiresAt>Date.now());
  const sourceStatus=source.status(context),database=vault.status(context);
  let attempts=[];if(sourceStatus.linked)try{attempts=source.list(context).attempts.filter(a=>a.operation?.sourceAuthenticated===true).map(a=>({brand:a.brand,requestId:a.requestId,operationId:a.operation.operationId,state:a.operation.state}));}catch(e){if(e?.code!=='SOURCE_SPECIFIC_AUTHORIZATION_REQUIRED')throw e;}
  return {schema:'shrigma-source-diagnostics-status-v1',enabled:true,sourceLinked:sourceStatus.linked===true,databaseLinked:database.linked===true,connections:connections.map(c=>({id:c.id,label:c.label,brands:c.brands,diagnosticsAuthorized:c.scopes.includes(SCOPE)})),attempts,operational:false};
 }
 function authorize({context,connectionId,brand,requestId,consent}={}){
  requireReady();if(context?.nativeBearer!==undefined||context?.method!=='POST'||consent!==true)fail('SOURCE_DIAGNOSTICS_BROWSER_CONSENT_REQUIRED');
  const q=input(context,{connectionId,brand,requestId}),binding=snapshot(context,q);
  store.permitSourceDiagnostics({context,connectionId:q.connectionId,binding});
  current(context,q,binding);
  return {authorized:true,scope:SCOPE,brand,requestId,operationId:binding.operationId,operational:false};
 }
 async function inspect({context,...value}={}){
  requireReady();if(active)fail('SOURCE_DIAGNOSTICS_BUSY',409);
  const q=input(context,value),privateContext=Object.freeze({...context}),binding=current(privateContext,q);
  const call={context:privateContext,q,binding};active=call;
  try{
   const result=await core.inspect({brand:q.brand,operationId:binding.operationId},{ownerId:binding.ownerId});
   if(active!==call)fail('SOURCE_DIAGNOSTICS_BINDING_CHANGED',409);
   current(privateContext,q,binding);return result;
  }finally{if(active===call)active=null;}
 }
 async function close(){closing=true;if(core)await core.close();return {closed:true,operational:false};}
 return Object.freeze({status,authorize,inspect,close,enabled:ready});
}
module.exports=Object.freeze({createDiagnosticsController,SCOPE});
