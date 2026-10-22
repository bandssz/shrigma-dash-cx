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
 function authorizeNative({context,...value}={}){
  requireReady();
  if(!exact(value,['brand','requestId','purpose','approved'])||context?.method!=='POST'||context?.nativeBearer===undefined||value.purpose!==SCOPE||value.approved!==true||typeof store.permitNativeSourceDiagnostics!=='function')fail('NATIVE_DIAGNOSTICS_CONFIRMATION_REQUIRED');
  const q=input(context,{brand:value.brand,requestId:value.requestId}),binding=snapshot(context,q);
  store.permitNativeSourceDiagnostics({context,binding,approved:true,purpose:SCOPE});
  current(context,q,binding);
  return {authorized:true,scope:SCOPE,brand:q.brand,requestId:q.requestId,operationId:binding.operationId,operational:false};
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
 return Object.freeze({status,authorize,authorizeNative,inspect,close,enabled:ready});
}

// Separate purpose receipt over the unchanged original connection store.
function withNativeDiagnosticsApproval({db,connections,managerHost,identity,mac,now=Date.now}={}){
 if(!db?.prepare||!connections?.authenticate||typeof managerHost!=='string'||[identity,mac,now].some(v=>typeof v!=='function'))throw Error('NATIVE_CONFIG_INVALID');
 const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype,BRANDS=['fish','aristo'],deny=fail,authenticate=(...args)=>connections.authenticate(...args);
 const time=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)deny('NATIVE_CLOCK_INVALID',500);return t;};
 db.exec(`CREATE TABLE IF NOT EXISTS crm_native_source_diagnostics_approval_v1(
 connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),
 owner_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL,request_id TEXT NOT NULL,
 binding_json TEXT NOT NULL,connection_hash TEXT NOT NULL,happened_at INTEGER NOT NULL,
 binding_mac TEXT NOT NULL,PRIMARY KEY(connection_id,brand,request_id));`);
 function diagnosticBinding(value,ownerId){
  const keys=['schema','ownerId','ownerRevision','brand','requestId','operationId','sourceBindingHash','profileRevision','credentialBindingHash','resourceHash'];
  const h=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
  if(!plain(value)||Object.keys(value).sort().join(',')!==keys.sort().join(',')||value.schema!=='shrigma-source-diagnostics-consent-v1'||value.ownerId!==ownerId||!BRANDS.includes(value.brand)||!uuid(value.requestId)||!uuid(value.operationId)||!Number.isSafeInteger(value.profileRevision)||value.profileRevision<1||['ownerRevision','sourceBindingHash','credentialBindingHash','resourceHash'].some(k=>!h(value[k])))deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])));
 }
 const nativeDiagnosticConnectionHash=r=>sha(JSON.stringify([r.id,r.user_id,r.host,r.token_hash,r.brands_json,r.scopes_json,r.auth_revision,r.created_at,r.expires_at,r.binding_mac]));
 const nativeDiagnosticSeal=r=>mac(JSON.stringify(['source-diagnostics-native-approval-v1',r.connection_id,r.owner_id,r.brand,r.request_id,r.binding_json,r.connection_hash,r.happened_at]));
 function nativeDiagnosticConnection(context,brand){
  if(typeof context?.nativeBearer!=='string')deny('NATIVE_DIAGNOSTICS_NATIVE_REQUIRED');
  const p=authenticate(context.nativeBearer,{scope:'crm.source-diagnostics',brand});
  if(authenticate(context.nativeBearer,{scope:'crm.source-sync',brand}).id!==p.id)deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');
  const owner=identity(p.userId),row=db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=? AND user_id=?').get(p.id,p.userId);
  if(!owner||owner.role!=='superadmin'||owner.active!==true||owner.canEditGrowth!==true||!row||row.host!==managerHost||row.revoked_at!==null||row.expires_at<=time()||row.auth_revision!==owner.revision)deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');
  return {owner,row};
 }
 function nativeDiagnosticRecord(context,brand,requestId){
  const {row,owner}=nativeDiagnosticConnection(context,brand),r=db.prepare('SELECT * FROM crm_native_source_diagnostics_approval_v1 WHERE connection_id=? AND brand=? AND request_id=?').get(row.id,brand,requestId);
  if(!r)return null;
  if(r.owner_id!==row.user_id||r.connection_hash!==nativeDiagnosticConnectionHash(row)||r.binding_mac!==nativeDiagnosticSeal(r)||!Number.isSafeInteger(r.happened_at)||r.happened_at>time())deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');
  let b;try{b=JSON.parse(r.binding_json);}catch{deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');}
  if(diagnosticBinding(b,row.user_id)!==r.binding_json||b.ownerRevision!==owner.revision||b.brand!==brand||b.requestId!==requestId)deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');
  return b;
 }
 function permitNativeSourceDiagnostics({context,binding,approved,purpose}={}){
  if(context?.method!=='POST'||approved!==true||purpose!=='crm.source-diagnostics')deny('NATIVE_DIAGNOSTICS_CONFIRMATION_REQUIRED');
  const {row,owner}=nativeDiagnosticConnection(context,binding?.brand),json=diagnosticBinding(binding,row.user_id);
  if(binding.ownerRevision!==owner.revision)deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');
  db.exec('BEGIN IMMEDIATE');try{
   const fresh=nativeDiagnosticConnection(context,binding.brand);
   if(nativeDiagnosticConnectionHash(fresh.row)!==nativeDiagnosticConnectionHash(row))deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');
   const prior=nativeDiagnosticRecord(context,binding.brand,binding.requestId);
   if(prior){if(JSON.stringify(prior)!==json)deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');db.exec('COMMIT');return {authorized:true};}
   const r={connection_id:row.id,owner_id:row.user_id,brand:binding.brand,request_id:binding.requestId,binding_json:json,connection_hash:nativeDiagnosticConnectionHash(row),happened_at:time()};
   db.prepare('INSERT INTO crm_native_source_diagnostics_approval_v1 VALUES(?,?,?,?,?,?,?,?)').run(r.connection_id,r.owner_id,r.brand,r.request_id,r.binding_json,r.connection_hash,r.happened_at,nativeDiagnosticSeal(r));
   nativeDiagnosticRecord(context,binding.brand,binding.requestId);db.exec('COMMIT');return {authorized:true};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function sourceDiagnosticsConsent(value={}){
  if(value.context?.nativeBearer!==undefined){const p=connections.authenticate(value.context.nativeBearer,{scope:SCOPE,brand:value.brand});if(p.id!==value.connectionId)deny('NATIVE_DIAGNOSTICS_BINDING_REFUSED');const receipt=nativeDiagnosticRecord(value.context,value.brand,value.requestId);if(receipt)return Object.freeze(receipt);}
  return connections.sourceDiagnosticsConsent(value);
 }
 return Object.freeze({...connections,permitNativeSourceDiagnostics,sourceDiagnosticsConsent});
}
module.exports=Object.freeze({createDiagnosticsController,withNativeDiagnosticsApproval,SCOPE});
