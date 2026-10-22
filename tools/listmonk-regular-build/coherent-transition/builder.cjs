 'use strict';
const crypto=require('node:crypto'),pins=require('./source-pins.json'),T=require('./templates.cjs');
const LEGACY='084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d',BODY='c794db19bf9e8e030284651947510ae5c00a12647fed3ab81f8eeec50b4eb582',HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash=(b,algorithm='sha256')=>crypto.createHash(algorithm).update(b).digest('hex');
for(const pin of pins)Object.freeze(pin);
function deepFreeze(v){if(v&&typeof v==='object'){for(const child of Object.values(v))deepFreeze(child);Object.freeze(v);}return v;}
function refuse(){throw Error('COHERENT_TRANSITION_PREPARATION_REFUSED');}
function keys(v,want){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join()!==[...want].sort().join())refuse();}
function literal(s){return "'"+s.replaceAll("'","''")+"'";}
function sourceBody(inputs){
 if(!Array.isArray(inputs)||inputs.length!==pins.length)refuse();
 for(const [i,item] of inputs.entries()){
  keys(item,['path','bytes','sha256','content']);const expected=pins[i];
  if(item.path!==expected.path||item.bytes!==expected.bytes||item.sha256!==expected.sha256||typeof item.content!=='string'||Buffer.byteLength(item.content)!==item.bytes||hash(item.content)!==item.sha256)refuse();
 }
 const installed=JSON.parse(inputs[7].content);if(installed.bodySha256!==BODY||installed.exactHashAnchorCount!==1||installed.contextIncludesOriginalAB!==true)refuse();
 const marker='CREATE OR REPLACE FUNCTION crm_audience_v2.selection_worker_context(cid integer) RETURNS jsonb\n LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$';
 const sql=inputs[6].content;if(sql.split(marker).length!==2)refuse();const start=sql.indexOf(marker)+marker.length,end=sql.indexOf('$fn$',start),body=sql.slice(start,end);
 if(hash(body)!==BODY||hash(body,'md5')!==installed.bodyMd5||body.split(LEGACY).length!==2||!body.includes('RETURN crm_audience_v2.ab_regular_context(cid,ctx);'))refuse();return body;
}
function prepare(request){
 keys(request,['sourceInputs','candidate','privateReferences','operationId','mode','sendTargets']);
 const original=sourceBody(request.sourceInputs);
 if(!['forward','rollback'].includes(request.mode)||typeof request.operationId!=='string'||!UUID.test(request.operationId))refuse();
 keys(request.candidate,['querySha256','kernelSha256','workerSha256','runtimeSha256','imageDigest']);
 const c=request.candidate;for(const key of Object.keys(c))if(typeof c[key]!=='string'||!HASH.test(c[key]))refuse();if(c.querySha256===LEGACY)refuse();
 keys(request.privateReferences,['admission','restore','snapshot','quiescence']);
 const purpose={admission:request.mode==='forward'?'coherent-original-worker-transition':'coherent-original-worker-rollback',restore:'coherent-original-worker-restore',snapshot:request.mode==='forward'?'original-transition-preflight':'original-rollback-preflight',quiescence:'original-worker-quiesced'};
 for(const [key,ref] of Object.entries(request.privateReferences)){
  keys(ref,['reference','sha256','purpose']);if(typeof ref.reference!=='string'||!/^root-private:[a-z0-9][a-z0-9._/-]{1,150}$/.test(ref.reference)||ref.reference.includes('..')||typeof ref.sha256!=='string'||!HASH.test(ref.sha256)||ref.purpose!==purpose[key])refuse();
 }
 if(!Array.isArray(request.sendTargets)||request.sendTargets.length>1024)refuse();
 let previous=0;for(const target of request.sendTargets){keys(target,['campaignId','admission']);
  if(!Number.isSafeInteger(target.campaignId)||target.campaignId<=previous||target.campaignId>2147483647)refuse();previous=target.campaignId;
  keys(target.admission,['reference','sha256','purpose']);const ref=target.admission;
  if(typeof ref.reference!=='string'||!/^root-private:[a-z0-9][a-z0-9._/-]{1,150}$/.test(ref.reference)||ref.reference.includes('..')||typeof ref.sha256!=='string'||!HASH.test(ref.sha256)||ref.purpose!=='existing-campaign-send-admission')refuse();
 }
 const candidateBody=original.replace(LEGACY,c.querySha256),forward=request.mode==='forward';
 const plan={schema:'shrigma-coherent-original-transition-preparation-v2',mode:request.mode,operationId:request.operationId,candidate:{...c},sendTargets:JSON.parse(JSON.stringify(request.sendTargets)),privateReferences:JSON.parse(JSON.stringify(request.privateReferences)),admissionPurpose:purpose.admission,expectedQuerySha256:forward?LEGACY:c.querySha256,targetQuerySha256:forward?c.querySha256:LEGACY};
 const expected=forward?original:candidateBody,target=forward?candidateBody:original;
 let core=T.core;for(const [marker,value]of Object.entries({'__PLAN_JSON_LITERAL__':JSON.stringify(plan),'__EXPECTED_BODY_LITERAL__':expected,'__TARGET_BODY_LITERAL__':target,'__TARGET_MD5_LITERAL__':hash(target,'md5')})){if(core.split(marker).length!==2)refuse();core=core.replace(marker,literal(value));}
 return deepFreeze({plan:deepFreeze(plan),planSha256:hash(JSON.stringify(plan)),status:'prepared-unadmitted',operational:false,authorizesExecution:false,authorizesDispatch:false,sourceBodySha256:BODY,targetBodySha256:hash(target),sourcePins:pins,
  preflightRead:T.read,postflightRead:T.read,preflightTransactionStatements:['BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;',"SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'; SET LOCAL search_path=pg_catalog; SET LOCAL TimeZone='UTC';",T.read,'ROLLBACK;'],
  transactionStatements:Object.freeze([
   'BEGIN ISOLATION LEVEL READ COMMITTED;',"SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL search_path=pg_catalog; SET LOCAL TimeZone='UTC';",T.guard,
   "SELECT pg_catalog.set_config('shrigma.private_transition_envelope',$1::jsonb::text,true);",core,T.read,
   "SELECT pg_catalog.set_config('shrigma.private_transition_envelope','',true);",'COMMIT;']),
  transactionSqlSha256:hash(core),commitUnknownAction:'Root must reconcile the same operation using read-only postflight; no replay, new operation or rollback without fresh own restore/quiescence evidence.',
  requiredPrivateEnvelope:['plan','snapshot','ownedCampaignIds','privateAdmission','originalSnapshot (rollback only)'],
  preservationScope:'owned row CAS only; no unrelated full-table equality claim',conflictScope:{"relationBoundary": ["crm_audience_v2.regular_worker_deployment (constraint DDL)", "crm_audience_v2.regular_delivery_campaign (phantom admission/tuple/flag changes)"], "rowLocks": ["lease singleton", "selection_runtime singleton", "enabled old-tuple campaign candidates", "existing bindings for enabled old-tuple candidates"], "noWholeTableLockOrHash": ["public.campaigns", "templates", "media", "lists", "dispatch", "AB", "binding/history"]},privateAuthorityDependency:'Root must verify admission, restore, snapshot and quiescence references using existing private authority. This builder validates shape/pins only, not authenticity or grants.'});
}
module.exports=Object.freeze({prepare,LEGACY,sourcePins:Object.freeze(pins),preflightRead:T.read,postflightRead:T.read});
