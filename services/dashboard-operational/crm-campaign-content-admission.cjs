'use strict';
// Current IAM/SQL proof only. Fixed GET, original bindings, no retries or writes.
const {SCHEMA,PROFILE_SHA256}=require('./crm-campaign-content-profile.cjs');
const DESTINATION=require('./crm-manager-read-bridge.cjs').DESTINATIONS.campaigns;
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':plain(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const closed=()=>{throw Object.assign(Error('CAMPAIGN_CONTENT_NOT_READY'),{status:503,code:'BRAND_TEMPLATE_OWNERSHIP_NOT_READY'});};
function validateProof(value,snapshot,write){
 if(!exact(value,['schema','profileSha256','brand','actor','owner','role','scope','caps','writerBinding','catalogue'])||value.schema!==SCHEMA||value.profileSha256!==PROFILE_SHA256||value.brand!==snapshot.brand||value.actor!=='panel:'+snapshot.principalId||value.owner!==snapshot.owner||value.role!=='manager'||!Array.isArray(value.caps)||JSON.stringify(value.caps)!==JSON.stringify(snapshot.caps)||value.scope!==(write?'single':'reader')||canonical(value.writerBinding)!==canonical(snapshot.writerBinding)||!exact(value.catalogue,['current','templates','lists','initiatives'])||typeof value.catalogue.current!=='boolean'||['templates','lists','initiatives'].some(k=>!Number.isSafeInteger(value.catalogue[k])||value.catalogue[k]<0))closed();
 const catalogueReady=value.catalogue.current&&value.catalogue.templates>0&&value.catalogue.lists>0;
 return Object.freeze({read:true,writerAttested:write,write:write&&catalogueReady,catalogueReady});
}
function createContentAdmission({auth,corporateWriter,upstreams},{fetchImpl=globalThis.fetch,deadlineMs=4500}={}){
 if(typeof auth?.campaignContentAdmissionSnapshot!=='function'||!require('./crm-manager-runtime.cjs').isCorporateWriterDescriptor(corporateWriter)||upstreams?.campaigns?.href!==DESTINATION||typeof fetchImpl!=='function'||!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>4500)throw Error('CAMPAIGN_CONTENT_ADMISSION_CONFIG');
 let pending=0;
 async function attest(context,{brand,write=false,userId}={}){
  if(pending>=8)closed();const selection={brand,write,...(userId===undefined?{}:{userId})},before=auth.campaignContentAdmissionSnapshot(context,selection);
  const url=new URL(DESTINATION);url.search=new URLSearchParams({acao:'campanha_acesso',brand}).toString();pending++;
  const controller=new AbortController();let reader,timer;
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('CONTENT_ADMISSION_DEADLINE'));},deadlineMs);});
  const bounded=value=>Promise.race([Promise.resolve(value),expired]);
  try{
   const response=await bounded(fetchImpl(url,{method:'GET',redirect:'manual',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json','Accept-Encoding':'identity',Authorization:'Bearer '+before.credential}}));
   if(response?.status!==200||response.redirected===true||response.url&&response.url!==url.href||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')||'')||![null,'','identity'].includes(response.headers.get('content-encoding')))closed();
   const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9]\d*)$/.test(length)||Number(length)>8192))closed();
   reader=response.body?.getReader();if(typeof reader?.read!=='function')closed();let size=0;const chunks=[];
   for(;;){const next=await bounded(reader.read());if(next.done)break;if(!(next.value instanceof Uint8Array))closed();size+=next.value.byteLength;if(size>8192)closed();chunks.push(Buffer.from(next.value));}
   if(length!==null&&Number(length)!==size)closed();const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));if(text.includes(before.credential))closed();
   const proof=validateProof(JSON.parse(text),before,write),after=auth.campaignContentAdmissionSnapshot(context,selection);if(JSON.stringify(before)!==JSON.stringify(after))closed();return proof;
  }catch{closed();}finally{clearTimeout(timer);controller.abort();try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}pending--;}
 }
 async function inspect(context,{brand,userId}={}){
  try{return await attest(context,{brand,write:true,...(userId===undefined?{}:{userId})});}catch{}
  try{return await attest(context,{brand,write:false,...(userId===undefined?{}:{userId})});}catch{return Object.freeze({read:false,writerAttested:false,write:false,catalogueReady:false});}
 }
 async function requireWrite(context,{brand}={}){const proof=await attest(context,{brand,write:true});if(!proof.write)closed();return proof;}
 return Object.freeze({attest,inspect,requireWrite});
}
module.exports={createContentAdmission,validateProof,DESTINATION};
