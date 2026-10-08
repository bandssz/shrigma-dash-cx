'use strict';
const crypto=require('node:crypto');
const {createDeliveryHealthRead,PURPOSE,RESOURCE,queryHash}=require('./native-delivery-health.cjs');
const SCOPE='crm.delivery-health',HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const exact=(x,keys)=>!!x&&Object.getPrototypeOf(x)===Object.prototype&&Reflect.ownKeys(x).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,k)||{},'value'))&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
function createDeliveryHealthController({enabled=false,driver,auth,coreFactory=createDeliveryHealthRead}={}){
 const vault=auth?.nativeDatabaseVault,store=auth?.nativeConnections;
 const ready=enabled===true&&typeof driver?.Client==='function'&&driver.version==='8.23.1'&&HASH.test(driver.packageSha256||'')&&typeof auth?.ownMasterPublishedJourneyReadBinding==='function'&&typeof vault?.getPrivateCredential==='function'&&['deliveryHealthOwner','permitDeliveryHealth','deliveryHealthConsent','authenticate','list'].every(k=>typeof store?.[k]==='function');
 let active=null,closing=false;
 function requireReady(){if(!ready||closing)fail('DELIVERY_HEALTH_NOT_ADMITTED',503);}
 function input(context,value){
  const native=context?.nativeBearer!==undefined,keys=['brand',...(native?[]:['connectionId'])];
  if(!exact(value,keys)||!['fish','aristo'].includes(value.brand))fail('DELIVERY_HEALTH_ARGUMENTS_INVALID',400);
  const connectionId=native?store.authenticate(context.nativeBearer,{scope:SCOPE,brand:value.brand}).id:value.connectionId;
  if(!UUID.test(connectionId||''))fail('DELIVERY_HEALTH_ARGUMENTS_INVALID',400);
  return {brand:value.brand,connectionId};
 }
 function snapshot(context,q){
  requireReady();
  const owner=store.deliveryHealthOwner({context,...q});
  const proofs=['fish','aristo'].map(brand=>{
   const proof=auth.ownMasterPublishedJourneyReadBinding({...context,method:'GET'},{brand});
   if(proof?.userId!==owner.ownerId||!HASH.test(proof?.binding||''))fail('DELIVERY_HEALTH_BINDING_CHANGED',409);
   return proof.binding; // Only the original CURRENT binding; never its credential.
  });
  const p=vault.getPrivateCredential({ownerId:owner.ownerId});
  if(!exact(p,['schema','revision','ownerId','username','password','resource','transport'])||p.schema!=='shrigma-private-database-credential-v1'||p.ownerId!==owner.ownerId||!Number.isSafeInteger(p.revision)||p.revision<1||typeof p.username!=='string'||!p.username||typeof p.password!=='string'||!p.password||canonical(p.resource)!==canonical(RESOURCE)||!exact(p.transport,['mode'])||p.transport.mode!=='admitted-private-network')fail('DELIVERY_HEALTH_BINDING_CHANGED',409);
  const pub={schema:p.schema,revision:p.revision,ownerId:p.ownerId,username:p.username,resource:p.resource,transport:p.transport};
  return {schema:'shrigma-delivery-health-consent-v1',...owner,brand:q.brand,crmBindingHash:sha(canonical(proofs)),profileRevision:p.revision,credentialBindingHash:sha(canonical(pub)),resourceHash:sha(canonical(RESOURCE)),queryHash};
 }
 function current(context,q,expected){
  const consent=store.deliveryHealthConsent({context,...q}),fresh=snapshot(context,q);
  if(canonical(consent)!==canonical(fresh)||expected&&canonical(expected)!==canonical(fresh))fail('DELIVERY_HEALTH_BINDING_CHANGED',409);
  return fresh;
 }
 const core=ready?coreFactory({enabled:true,driver,
  getPrivateCredential:({ownerId})=>{if(!active||ownerId!==active.binding.ownerId)fail('DELIVERY_HEALTH_BINDING_CHANGED',409);current(active.context,active.q,active.binding);return vault.getPrivateCredential({ownerId});},
  admitHealth:proof=>{
   if(!active||!['connect','read','release'].includes(proof?.phase)||proof.purpose!==PURPOSE)fail('DELIVERY_HEALTH_BINDING_CHANGED',409);
   const b=current(active.context,active.q,active.binding);
   if(['ownerId','profileRevision','credentialBindingHash','resourceHash','queryHash'].some(k=>proof[k]!==b[k]))fail('DELIVERY_HEALTH_BINDING_CHANGED',409);
   return {admitted:true,ownerId:b.ownerId,profileRevision:b.profileRevision,credentialBindingHash:b.credentialBindingHash,resourceHash:b.resourceHash,queryHash:b.queryHash,purpose:PURPOSE};
  }}):null;
 function status(context){
  requireReady();if(context?.nativeBearer!==undefined)fail('DELIVERY_HEALTH_BROWSER_REQUIRED');
  const connections=store.list(context).filter(c=>!c.revoked&&c.expiresAt>Date.now()&&c.scopes.includes('crm.read')&&['fish','aristo'].every(b=>c.brands.includes(b)));
  const database=vault.status(context);
  return {schema:'shrigma-delivery-health-status-v1',enabled:true,databaseLinked:database.linked===true,connections:connections.map(c=>({id:c.id,label:c.label,brands:c.brands})),operational:false};
 }
 function authorize(args={}){
  requireReady();if(!exact(args,['context','connectionId','brand','consent'])||args.context?.nativeBearer!==undefined||args.context?.method!=='POST'||args.consent!==true)fail('DELIVERY_HEALTH_BROWSER_CONSENT_REQUIRED');
  const {context,connectionId,brand}=args,q=input(context,{connectionId,brand}),binding=snapshot(context,q);
  store.permitDeliveryHealth({context,connectionId:q.connectionId,binding});current(context,q,binding);
  return {authorized:true,scope:SCOPE,brand,operational:false};
 }
 async function inspect({context,...value}={}){
  requireReady();if(active)fail('DELIVERY_HEALTH_BUSY',409);
  const q=input(context,value),privateContext=Object.freeze({...context}),binding=current(privateContext,q),call={context:privateContext,q,binding};active=call;
  try{const result=await core.inspect({brand:q.brand},{ownerId:binding.ownerId});if(active!==call)fail('DELIVERY_HEALTH_BINDING_CHANGED',409);current(privateContext,q,binding);return result;}finally{if(active===call)active=null;}
 }
 async function close(){closing=true;if(core)await core.close();return {closed:true,operational:false};}
 return Object.freeze({status,authorize,inspect,close,enabled:ready});
}
module.exports=Object.freeze({createDeliveryHealthController,SCOPE});
