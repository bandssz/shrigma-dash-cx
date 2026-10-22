'use strict';
// Inert operator-side admission. No env, client, SQL or service on import.
const O=require('./operator.cjs');
function refuse(){throw Error('READ_CREDENTIAL_CUSTODY_ADMISSION_REFUSED');}
function exact(v,keys){
 if(!v||Object.getPrototypeOf(v)!==Object.prototype)refuse();
 const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))refuse();
 for(const k of own){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||d.enumerable!==true||!Object.hasOwn(d,'value'))refuse();}
}
function publicCustody(c){return Object.freeze(Object.fromEntries(Object.entries(c)));}
function unknown(){return Object.freeze({schema:'crm-manager-read-runtime-result-v1',action:'stage',state:'outcome_unknown',phase:null,coreVerified:false,credentialBound:false,commitAck:false});}
function result(value){
 exact(value,['schema','action','state','phase','coreVerified','credentialBound','commitAck']);
 if(value.schema!=='crm-manager-read-runtime-result-v1'||value.action!=='stage'||!['confirmed','before_verified','not_dispatched','outcome_unknown'].includes(value.state)||![null,'empty','staged'].includes(value.phase)||typeof value.commitAck!=='boolean'||value.coreVerified!==(value.phase!==null)||value.credentialBound!==(value.phase==='staged')||value.state==='confirmed'&&value.phase!=='staged'||value.state==='before_verified'&&value.phase!=='empty'||value.state==='outcome_unknown'&&value.phase!==null)refuse();
 return Object.freeze({...value});
}
async function invoke(createRuntime,method,intent,credential){
 // The factory itself is withheld until every custody barrier and binding has
 // succeeded. A failure after that factory could have reached PG stays unknown.
 try{
  const runtime=await createRuntime(publicCustody(credential));
  if(!runtime||typeof runtime.execute!=='function'||typeof runtime.reconcile!=='function')refuse();
  return result(await runtime[method](intent,{verifier:credential.verifier}));
 }catch{return unknown();}
}
async function retainAndExecute(input,deps){
 let intent,credential;
 try{
  exact(input,['directory','intent','password','verifier','publicKey','privateKey','approvedAction']);exact(deps,['createRuntime']);
  if(input.approvedAction!=='stage'||typeof deps.createRuntime!=='function')refuse();
  O.binding(input.intent);intent=Object.freeze({...input.intent});
  O.sealNew({directory:input.directory,intent,password:input.password,verifier:input.verifier,publicKey:input.publicKey});
  credential=O.openExisting({directory:input.directory,intent,privateKey:input.privateKey});
  if(credential.password!==input.password||credential.verifier!==input.verifier||credential.durabilityBarrier!==true)refuse();
 }catch{refuse();}
 return invoke(deps.createRuntime,'execute',intent,credential);
}
async function reconcileRetained(input,deps){
 let intent,credential;
 try{
  exact(input,['directory','intent','privateKey','approvedAction']);exact(deps,['createRuntime']);
  if(input.approvedAction!=='readonly-reconcile'||typeof deps.createRuntime!=='function')refuse();
  O.binding(input.intent);intent=Object.freeze({...input.intent});
  credential=O.openExisting({directory:input.directory,intent,privateKey:input.privateKey});
  if(credential.durabilityBarrier!==true)refuse();
 }catch{refuse();}
 return invoke(deps.createRuntime,'reconcile',intent,credential);
}
module.exports=Object.freeze({retainAndExecute,reconcileRetained});
if(require.main===module){process.stderr.write('READ_CREDENTIAL_CUSTODY_ADMISSION_API_ONLY\n');process.exitCode=1;}
