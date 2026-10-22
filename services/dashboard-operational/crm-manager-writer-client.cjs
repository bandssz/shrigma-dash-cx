'use strict';
// PRIVATE proposal. Only this four-function RPC interface; no environment,
// token, URL discovery, SQL text, sockets, retries or bearer values.
const crypto=require('node:crypto');
const {createWriterPolicy}=require('./crm-manager-writer-policy.cjs');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.getOwnPropertyDescriptor(v,k)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
function refused(){const e=new Error('CRM_WRITER_BRIDGE_REFUSED');e.code='CRM_WRITER_BRIDGE_REFUSED';throw e;}
const FUNCTIONS=Object.freeze({prepare_writer:'public.crm_manager_writer_prepare_v1',renew_writer:'public.crm_manager_writer_prepare_v1',commit_writer:'public.crm_manager_writer_commit_v1',revoke_writer:'public.crm_manager_writer_revoke_v1',writer_status:'public.crm_manager_writer_status_v1'});
function createWriterClient(config){
 if(!exact(config,['issuerId','namespaceId','allowedEmailDomains','now','invoke'])||typeof config.invoke!=='function')refused();
 const policy=createWriterPolicy({issuerId:config.issuerId,namespaceId:config.namespaceId,allowedEmailDomains:config.allowedEmailDomains,now:config.now});
 async function rpc(request){
  const encoded=canonical(request);if(Buffer.byteLength(encoded)>4096)refused();
  const value=await config.invoke(Object.freeze({procedure:FUNCTIONS[request.action],parameters:Object.freeze([encoded])}));
  let body;try{const out=canonical(value);if(Buffer.byteLength(out)>8192)refused();body=JSON.parse(out);}catch{refused();}
  if(body?.schema==='crm-manager-writer-error-v1'){
   // Remote codes/raw details remain private. Validate correlation first.
   if(!exact(body,['schema','issuerId','namespaceId','operationId','requestSha256','code'])||![null,config.issuerId].includes(body.issuerId)||![null,config.namespaceId].includes(body.namespaceId)||body.operationId!==request.operationId||body.requestSha256!==crypto.createHash('sha256').update(encoded).digest('hex')||!['ISSUER_DENIED','INPUT_INVALID','IDEMPOTENCY_CONFLICT','LIFECYCLE_REVOKED','CREDENTIAL_CONFLICT','CANDIDATE_EXPIRED','SUBJECT_NOT_FOUND','GENERATION_CONFLICT'].includes(body.code))refused();
   refused();
  }
  return body;
 }
 const command=(action,args)=>policy.command(action,args);
 const checked=request=>{policy.statusRequest(request);return request;};
 async function prepare(request){checked(request);if(!['prepare_writer','renew_writer'].includes(request.action))refused();return policy.receipt(await rpc(request),request);}
 async function status(request,options={}){const q=policy.statusRequest(request);return policy.status(await rpc(q),request,options);}
 async function commit({operationId,proof,expectedRequest}){const request=policy.commit({operationId,proof});if(canonical(request)!==canonical(expectedRequest))refused();return policy.receipt(await rpc(request),request);}
 async function revoke(request){checked(request);if(request.action!=='revoke_writer')refused();return policy.receipt(await rpc(request),request);}
 return Object.freeze({command,prepare,status,commit,revoke});
}
module.exports={createWriterClient,FUNCTIONS};
