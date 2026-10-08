'use strict';
// Dormant, explicit composition. No environment reads, identity changes or I/O.
const fail=()=>{throw Object.assign(Error('CRM_INDIVIDUAL_COEXISTENCE_CONFIG_INVALID'),{code:'CRM_INDIVIDUAL_COEXISTENCE_CONFIG_INVALID',status:500});};
function validate(options,{requireTokens=false}={}){
 if(options.crmIndividualCoexistence!==undefined&&typeof options.crmIndividualCoexistence!=='boolean')fail();
 if(options.crmIndividualCoexistence!==true)return false;
 const R=require('./crm-manager-runtime.cjs');
 try{
  R.ownMasterWriterDescriptor(options.crmCampaignWriterProfile,options.allowedEmailDomains);
  R.corporateWriterDescriptor(options.crmManagedWriter,options.crmManagedRead,options.allowedEmailDomains);
  if(options.crmCampaignSubmitWrite!==true||!options.crmManagedRead||!options.crmManagedWriter)fail();
  if(requireTokens){const a=options.crmManagedRead.provisionerToken,b=options.crmManagedWriter.provisionerToken;if(!/^[A-Za-z0-9_-]{43,128}$/.test(a||'')||!/^[A-Za-z0-9_-]{43,128}$/.test(b||'')||a===b)fail();}
 }catch{fail();}
 return true;
}
function compose({read,writer,auth}){
 let closed=false,active=null,closing=null;
 function kick(){
  if(closed)return Promise.resolve([]);if(active)return active;
  let run;run=Promise.resolve().then(async()=>{if(closed)return [];const first=await Promise.allSettled([read.kick()]);if(closed)return first;if(first[0].status==='fulfilled')try{auth.fulfillManagedCampaignWriterRequests();}catch{}const last=await Promise.allSettled([writer.kick()]);if(!closed)try{auth.reconcileUserProfileUpdates();}catch{}return [...first,...last];}).finally(()=>{if(active===run)active=null;});active=run;return run;
 }
 function close(){
  closed=true;if(closing)return closing;
  // Stop both runtimes immediately; each drains its already-started operation.
  closing=Promise.allSettled([Promise.resolve().then(()=>read.close()),Promise.resolve().then(()=>writer.close()),active||Promise.resolve()]).then(()=>undefined);return closing;
 }
 return Object.freeze({kick,close});
}
function guardedTransport(transport,snapshot){return async(ctx,q)=>{const before=snapshot(ctx,q.command);let result,error;try{result=await transport(ctx,q);}catch(e){error=e;}if(before!==null&&before!==snapshot(ctx,q.command))throw Object.assign(Error('CRM_CURRENT_BINDING_CHANGED'),{code:'CRM_CURRENT_BINDING_CHANGED',status:403});if(error)throw error;return result;};}
function guardedOperations(operations,snapshot){return Object.freeze(Object.fromEntries(Object.entries(operations).map(([name,fn])=>[name,name==='describe'?fn:async(ctx,q)=>{const before=snapshot(ctx,q);let result,error;try{result=await fn(ctx,q);}catch(e){error=e;}if(before!==null&&before!==snapshot(ctx,q))throw Object.assign(Error('CRM_CURRENT_BINDING_CHANGED'),{code:'CRM_CURRENT_BINDING_CHANGED',status:403});if(error)throw error;return result;}])));}
module.exports={validate,compose,guardedTransport,guardedOperations};
