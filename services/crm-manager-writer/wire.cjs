'use strict';
// Dormant internal gateway. No socket, environment, pg import or pool is opened
// by requiring this module. It never receives an individual manager bearer.
const crypto=require('node:crypto');
const HOST='comunicacao-crm-manager-writer.tazdb8.easypanel.host';
const ROLE='crm_manager_writer_service_v1',DATABASE='listmonk',PG_HOST='comunicacao_postgres',PG_PORT=5432;
const REQUEST='crm-manager-writer-request-v1',RECEIPT='crm-manager-writer-receipt-v1',STATUS='crm-manager-writer-status-v1',ERROR='crm-manager-writer-error-v1';
const CAPS=Object.freeze(['read_content','draft','validate','submit']);
const CANDIDATE_TTL=600000,LIFETIME=1209600000,MAX_BODY=4096,MAX_RESPONSE=8192;
const ROUTES=Object.freeze({'/internal/v1/crm-writers/prepare':Object.freeze(['prepare_writer','renew_writer']),'/internal/v1/crm-writers/commit':Object.freeze(['commit_writer']),'/internal/v1/crm-writers/revoke':Object.freeze(['revoke_writer']),'/internal/v1/crm-writers/status':Object.freeze(['writer_status'])});
const QUERIES=Object.freeze({prepare_writer:'SELECT public.crm_manager_writer_prepare_v1($1::jsonb) AS body',renew_writer:'SELECT public.crm_manager_writer_prepare_v1($1::jsonb) AS body',commit_writer:'SELECT public.crm_manager_writer_commit_v1($1::jsonb) AS body',revoke_writer:'SELECT public.crm_manager_writer_revoke_v1($1::jsonb) AS body',writer_status:'SELECT public.crm_manager_writer_status_v1($1::jsonb) AS body'});
const REMOTE_CODES=Object.freeze(['ISSUER_DENIED','INPUT_INVALID','IDEMPOTENCY_CONFLICT','LIFECYCLE_REVOKED','CREDENTIAL_CONFLICT','CANDIDATE_EXPIRED','SUBJECT_NOT_FOUND','GENERATION_CONFLICT']);
const ERROR_STATUS=Object.freeze({INPUT_INVALID:400,AUTH_REQUIRED:401,ISSUER_DENIED:403,SUBJECT_NOT_FOUND:404,IDEMPOTENCY_CONFLICT:409,GENERATION_CONFLICT:409,LIFECYCLE_REVOKED:409,CANDIDATE_EXPIRED:409,CREDENTIAL_CONFLICT:409,EDIT_NOT_READY:403,UNAVAILABLE:503});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uuid=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),principal=v=>typeof v==='string'&&/^dcrmw-[a-f0-9]{32}$/.test(v);
const time=v=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-LIFETIME;
const generation=v=>Number.isSafeInteger(v)&&v>=0&&v<=999999999;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function exact(v,keys){return plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d&&d.enumerable&&Object.hasOwn(d,'value');});}
function canonical(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
const sha=v=>crypto.createHash('sha256').update(v,'utf8').digest('hex');
const caps=v=>Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&v.length===CAPS.length&&Reflect.ownKeys(v).length===v.length+1&&v.every((x,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));return d?.enumerable&&Object.hasOwn(d,'value')&&x===CAPS[i];});
class GatewayError extends Error{constructor(code,status=ERROR_STATUS[code]||503){super(code);this.code=code;this.status=status;}}
const refuse=(code='INPUT_INVALID',status)=>{throw new GatewayError(code,status);};
function domainsValid(v){return Array.isArray(v)&&v.length>0&&v.length<=8&&Object.keys(v).length===v.length&&new Set(v).size===v.length&&v.every(d=>typeof d==='string'&&d.length<=253&&/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(d));}
function ownerValid(v,domains){return typeof v==='string'&&v.length<=254&&v===v.toLowerCase()&&/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,63}$/.test(v)&&v.split('@')[0].length<=64&&domains.has(v.split('@')[1]);}
const COMMON=['schema','issuerId','namespaceId','action','operationId'];
const SUBJECT=['userId','lifecycleId','owner'];
const POLICY=['area','slot','role','caps','candidateTtlMs','lifetimeMs'];
const CREDENTIAL=['principalId','keySha256','generation','expectedGeneration'];
function validateRequest(value,path,{issuerId,namespaceId,domains}){
 if(!plain(value)||!Object.hasOwn(ROUTES,path)||!ROUTES[path].includes(value.action))refuse();
 const keys=[...COMMON,...(value.action==='writer_status'?['expectedRequestSha256']:[...SUBJECT,...(value.action==='revoke_writer'?[]:[...POLICY,...CREDENTIAL,...(value.action==='commit_writer'?['prepareOperationId','issuedAt','candidateExpiresAt','expiresAt']:[])])])];
 if(!exact(value,keys)||value.schema!==REQUEST||!uuid(value.issuerId)||!uuid(value.namespaceId)||!uuid(value.operationId))refuse();
 if(value.issuerId!==issuerId||value.namespaceId!==namespaceId)refuse('ISSUER_DENIED');
 if(value.action==='writer_status'){if(!hash(value.expectedRequestSha256))refuse();return value;}
 if(!uuid(value.userId)||!uuid(value.lifecycleId)||!ownerValid(value.owner,domains))refuse();
 if(value.action==='revoke_writer')return value;
 if(value.area!=='growth'||value.slot!=='growth-campaign'||value.role!=='manager'||!caps(value.caps)||value.candidateTtlMs!==CANDIDATE_TTL||value.lifetimeMs!==LIFETIME||!principal(value.principalId)||!hash(value.keySha256)||!generation(value.generation)||!generation(value.expectedGeneration)||value.generation!==value.expectedGeneration+1)refuse();
 if(value.action==='prepare_writer'&&(value.generation!==1||value.expectedGeneration!==0)||value.action==='renew_writer'&&value.expectedGeneration<1)refuse();
 if(value.action==='commit_writer'&&(!uuid(value.prepareOperationId)||value.prepareOperationId===value.operationId||!time(value.issuedAt)||value.candidateExpiresAt!==value.issuedAt+CANDIDATE_TTL||value.expiresAt!==value.issuedAt+LIFETIME))refuse();
 return value;
}
function validateReceipt(value,command,scope,now,{statusLookup=false}={}){
 const base=['schema','issuerId','namespaceId','operationId','action','requestSha256','userId','lifecycleId','owner','state'];
 const action=statusLookup?value?.action:command.action;
 const extra=action==='revoke_writer'?['revocationMode','allGenerationsRevoked','effectiveAt','revokedCount']:['principalId','generation','expectedGeneration','area','slot','role','caps','issuedAt','candidateExpiresAt','expiresAt',...(action==='commit_writer'?['prepareOperationId','committedAt','revokedGeneration']:[])];
 if(!['prepare_writer','renew_writer','commit_writer','revoke_writer'].includes(action)||!exact(value,[...base,...extra])||value.schema!==RECEIPT||value.issuerId!==scope.issuerId||value.namespaceId!==scope.namespaceId||value.operationId!==command.operationId||value.action!==action||value.requestSha256!==(statusLookup?command.expectedRequestSha256:sha(canonical(command)))||!uuid(value.userId)||!uuid(value.lifecycleId)||!ownerValid(value.owner,scope.domains))refuse('UNAVAILABLE');
 if(!statusLookup&&(value.userId!==command.userId||value.lifecycleId!==command.lifecycleId||value.owner!==command.owner))refuse('UNAVAILABLE');
 if(action==='revoke_writer'){
  if(value.state!=='revoked'||value.revocationMode!=='lifecycle'||value.allGenerationsRevoked!==true||!time(value.effectiveAt)||value.effectiveAt>now+30000||!generation(value.revokedCount))refuse('UNAVAILABLE');return value;
 }
 if(!principal(value.principalId)||!generation(value.generation)||!generation(value.expectedGeneration)||value.generation!==value.expectedGeneration+1||value.area!=='growth'||value.slot!=='growth-campaign'||value.role!=='manager'||!caps(value.caps)||!time(value.issuedAt)||value.issuedAt>now+30000||value.candidateExpiresAt!==value.issuedAt+CANDIDATE_TTL||value.expiresAt!==value.issuedAt+LIFETIME)refuse('UNAVAILABLE');
 if(!statusLookup&&(value.principalId!==command.principalId||value.generation!==command.generation||value.expectedGeneration!==command.expectedGeneration))refuse('UNAVAILABLE');
 if(action==='prepare_writer'&&(value.generation!==1||value.expectedGeneration!==0)||action==='renew_writer'&&value.expectedGeneration<1)refuse('UNAVAILABLE');
 if(action==='commit_writer'){
  if(value.state!=='committed'||!uuid(value.prepareOperationId)||value.prepareOperationId===value.operationId||!time(value.committedAt)||value.committedAt<value.issuedAt||value.committedAt>=value.candidateExpiresAt||value.committedAt>now+30000||value.revokedGeneration!==(value.expectedGeneration===0?null:value.expectedGeneration))refuse('UNAVAILABLE');
  if(!statusLookup&&(value.prepareOperationId!==command.prepareOperationId||value.issuedAt!==command.issuedAt||value.candidateExpiresAt!==command.candidateExpiresAt||value.expiresAt!==command.expiresAt))refuse('UNAVAILABLE');
 }else if(value.state!=='prepared')refuse('UNAVAILABLE');return value;
}
function validateResult(value,command,scope,now){
 if(value?.schema===ERROR){
  if(!exact(value,['schema','issuerId','namespaceId','operationId','requestSha256','code'])||!([scope.issuerId,null].includes(value.issuerId)&&[scope.namespaceId,null].includes(value.namespaceId)&&(value.issuerId===null)===(value.namespaceId===null))||value.operationId!==command.operationId||value.requestSha256!==sha(canonical(command))||value.issuerId===null&&value.code!=='ISSUER_DENIED'||typeof value.code!=='string'||!REMOTE_CODES.includes(value.code))refuse('UNAVAILABLE');return {status:200,body:JSON.parse(canonical(value))};
 }
 if(command.action==='writer_status'){
  if(!exact(value,['schema','issuerId','namespaceId','operationId','found',...(value?.found===true?['receipt']:[])])||value.schema!==STATUS||value.issuerId!==scope.issuerId||value.namespaceId!==scope.namespaceId||value.operationId!==command.operationId||typeof value.found!=='boolean')refuse('UNAVAILABLE');
  if(value.found)validateReceipt(value.receipt,command,scope,now,{statusLookup:true});return {status:200,body:JSON.parse(canonical(value))};
 }
 validateReceipt(value,command,scope,now);return {status:200,body:JSON.parse(canonical(value))};
}

module.exports={HOST,ROLE,DATABASE,PG_HOST,PG_PORT,REQUEST,RECEIPT,STATUS,ERROR,CAPS,CANDIDATE_TTL,LIFETIME,MAX_BODY,MAX_RESPONSE,ROUTES,QUERIES,ERROR_STATUS,uuid,time,plain,exact,canonical,sha,GatewayError,refuse,validateRequest,validateResult};
