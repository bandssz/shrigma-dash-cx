"use strict";
// Inert SOURCE: structured hashes/flags do not authenticate anyone or create authority.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ASSETS=Object.freeze({
  "handoff.atomic.sql.in": "a474c866bdafd3364d98eeff12038ea2a7087a010ae5d1593e9c0af4640ebd32",
  "snapshot.private-read.sql": "f11be5325368eee57498c30a154a2d336d6fdf197d9940dc3dfb6840c4982ed8",
  "PUBLIC-FUNCTION-PINS.json": "ce7c579cf73c98b30111f8d36b0150e1ab0c1a2041452aeed9224eb05afb09c7",
  "quiescence.read.sql": "b9793e502d29238ad49356ecfa065e093583c01c1de00f9f7532059ba59ea667"
});
const SOURCE=Object.freeze({
  "canonicalSourceDeliverySha256": "2b24b13e54f1cefed6d213e9a3cd5fddfd9ad49e206a0c52e89e2573f4ea3eab",
  "canonicalOverlaySha256": "fddc286630157005e82a64ba97dbcb100869f56ea6cf2ba7e61cb59232486fee",
  "nativeSourceAcceptanceSha256": "c1149cdd0e69279a23d9b95fdd032adccd652aa5e5c1f9516492c0c49b92f78c"
});
const PURPOSE='crm.fish174.permanent-exclusion-runtime-handoff';
const STAGES=Object.freeze(['switch-to-candidate','verify-candidate','return-to-original','verify-original']);
const FIXED=Object.freeze({oldWorkerSha256:'4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb',oldImageSha256:'85acc4a8b455d9fa9f841cfb2c307fba1263651402ec569a213d8fb0d20544ad',runtimeSha256:'4cd321fbdfd9a163f7c5ea2e1ba71029140e00a468d421908de8d0211d1e42cb',querySha256:'772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700',kernelSha256:'7d9e4cd7fd4e3c6f9967386c5ca7b1410e755690fac3a77149d8d032d2c4e8b4'});
const REFERENCES=Object.freeze(['admission','snapshot','restore','quiescence','binding','measurement','disposition','build','handoffProof','legacyPending']);
const MAX_PRIVATE_BYTES=8388608,preparedObjects=new WeakSet();
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
function fail(code){throw Object.assign(new Error(code),{code});}
function keys(v,n){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join('|')!==[...n].sort().join('|'))fail('HELD174_HANDOFF_INPUT_REFUSED');}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function load(n){let data;try{const p=path.join(__dirname,n);if(fs.lstatSync(p).isSymbolicLink())fail('HELD174_HANDOFF_SOURCE_DRIFT');data=fs.readFileSync(p);}catch{fail('HELD174_HANDOFF_SOURCE_DRIFT');}if(sha(data)!==ASSETS[n])fail('HELD174_HANDOFF_SOURCE_DRIFT');return data.toString('utf8');}
function one(s,a,b){if(s.split(a).length!==2)fail('HELD174_HANDOFF_ANCHOR_REFUSED');return s.replace(a,()=>b);}
const literal=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'";
function prepare(input){
 keys(input,['stage','operationId','candidate','privateReferences']);
 if(!STAGES.includes(input.stage)||!uuid(input.operationId))fail('HELD174_HANDOFF_STAGE_REFUSED');
 keys(input.candidate,[...Object.keys(FIXED),'newWorkerSha256','newImageSha256']);
 for(const[n,h]of Object.entries(FIXED))if(input.candidate[n]!==h)fail('HELD174_HANDOFF_IDENTITY_REFUSED');
 if(!hex(input.candidate.newWorkerSha256)||!hex(input.candidate.newImageSha256)
  ||input.candidate.newWorkerSha256===FIXED.oldWorkerSha256||input.candidate.newImageSha256===FIXED.oldImageSha256)fail('HELD174_HANDOFF_IDENTITY_REFUSED');
 keys(input.privateReferences,REFERENCES);
 for(const r of Object.values(input.privateReferences)){keys(r,['reference','sha256']);if(!uuid(r.reference)||!hex(r.sha256))fail('HELD174_HANDOFF_REFERENCE_REFUSED');}
 const plan={schema:'held174-own-runtime-handoff-plan-v1',stage:input.stage,operationId:input.operationId,
  admissionPurpose:PURPOSE,candidate:{...input.candidate},source:{...SOURCE},privateReferences:structuredClone(input.privateReferences),
  heldDispatchId:'0d8c77b2-18e7-474f-b9b7-bbfc733bac2f',ownedControls:[171,172,174],preservedCampaigns:[171,172,173,174,175,176,177],
  statementTimeoutMs:5000,lockTimeoutMs:500,maxPrivateBytes:MAX_PRIVATE_BYTES,irreversibleDispositionPreserved:true,processingAuthorized:false};
 const snapshot=load('snapshot.private-read.sql').trim();if(!snapshot.endsWith(';'))fail('HELD174_HANDOFF_SOURCE_DRIFT');
 let core=load('handoff.atomic.sql.in');core=one(core,'__PLAN_JSON_LITERAL__',literal(plan));core=one(core,'__PUBLIC_FUNCTION_PINS_LITERAL__',literal(JSON.parse(load('PUBLIC-FUNCTION-PINS.json'))));
 if(core.split('__SNAPSHOT_SELECT__').length!==3)fail('HELD174_HANDOFF_ANCHOR_REFUSED');core=core.replaceAll('__SNAPSHOT_SELECT__',()=>snapshot.slice(0,-1));
 if(/__[A-Z_]+__/.test(core))fail('HELD174_HANDOFF_ANCHOR_REFUSED');
 const result=freeze({schema:'held174-own-runtime-handoff-prepared-v1',plan,planSha256:sha(JSON.stringify(plan)),atomicSha256:sha(core),sourcePins:{...ASSETS},snapshotReadSQL:snapshot,quiescenceReadSQL:load('quiescence.read.sql'),statements:[
  'BEGIN ISOLATION LEVEL READ COMMITTED;',"SET LOCAL statement_timeout='5s';","SET LOCAL lock_timeout='500ms';","SET LOCAL idle_in_transaction_session_timeout='10s';","SET LOCAL search_path=pg_catalog;",
  "SELECT pg_catalog.set_config('shrigma.private_held174_handoff_envelope',$1::text,true) IS NOT NULL AS private_envelope_bound;",core,
  "SELECT pg_catalog.set_config('shrigma.private_held174_handoff_envelope','',true) IS NOT NULL AS private_envelope_cleared;",'COMMIT;'],executionAvailable:false,originalOperational:false,processingAuthorized:false});
 preparedObjects.add(result);return result;
}
function fresh(checkedAt,expiresAt,limit,now){const checked=Date.parse(checkedAt),expires=Date.parse(expiresAt);return Number.isFinite(checked)&&Number.isFinite(expires)&&checked<=now&&expires>now&&expires<=checked+limit;}
function checkLegacyPending(rows){
 if(!Array.isArray(rows)||rows.length!==34)fail('HELD174_HANDOFF_LEGACY_PENDING_REFUSED');
 const ids=new Set();let fish=0,aristo=0;
 for(const row of rows){
  if(!row||Object.getPrototypeOf(row)!==Object.prototype||!uuid(row.dispatch_id)||ids.has(row.dispatch_id)
   ||row.flow!=='transacional'||row.transport_state!=='in_flight'||row.is_test!==false
   ||row.outcome_at!==null||row.accepted_at!==null||row.send_log_id!==null
   ||!['fish','aristo'].includes(row.brand)||typeof row.started_at!=='string'
   ||!Number.isFinite(Date.parse(row.started_at))||Date.parse(row.started_at)<Date.parse('2026-09-14T00:00:00Z')
   ||Date.parse(row.started_at)>=Date.parse('2026-09-15T00:00:00Z'))fail('HELD174_HANDOFF_LEGACY_PENDING_REFUSED');
  ids.add(row.dispatch_id);if(row.brand==='fish')fish++;else aristo++;
 }
 if(fish!==18||aristo!==16)fail('HELD174_HANDOFF_LEGACY_PENDING_REFUSED');
}
function checkQuiescence(q,snapshot,now){
 const fp=snapshot.allDispatchFingerprint;
 if(!fp||Object.getPrototypeOf(fp)!==Object.prototype||!Number.isSafeInteger(fp.count)||fp.count<0||typeof fp.md5!=='string'||!/^[a-f0-9]{32}$/.test(fp.md5))fail('HELD174_HANDOFF_QUIESCENCE_UNPROVED');
 if(!q||Object.getPrototypeOf(q)!==Object.prototype||!fresh(q.checkedAt,q.expiresAt,120000,now))fail('HELD174_HANDOFF_QUIESCENCE_UNPROVED');
 for(const n of ['allFlowReserved','newOutcomeUnknownAfterCheckpoint','httpActive','msgQPending','smtpActive'])if(q[n]!==0)fail('HELD174_HANDOFF_QUIESCENCE_UNPROVED');
 if(q.allFlowInFlight!==34)fail('HELD174_HANDOFF_QUIESCENCE_UNPROVED');
 if(q.legacyIngressCoverage!=='all-producers-blocked-and-drained'||!q.checkpointDispatchFingerprint||Object.keys(q.checkpointDispatchFingerprint).sort().join('|')!=='count|md5'||q.checkpointDispatchFingerprint.count!==fp.count||q.checkpointDispatchFingerprint.md5!==fp.md5)fail('HELD174_HANDOFF_QUIESCENCE_UNPROVED');
}
async function bindCurrent({prepared,context,current,snapshot,originalSnapshot}){
 if(!preparedObjects.has(prepared)||typeof current!=='function')fail('HELD174_HANDOFF_CURRENT_CALLBACK_REQUIRED');
 if(!snapshot||Object.getPrototypeOf(snapshot)!==Object.prototype)fail('HELD174_HANDOFF_PRIVATE_SNAPSHOT_REQUIRED');
 const text=JSON.stringify(snapshot);if(Buffer.byteLength(text)>MAX_PRIVATE_BYTES)fail('HELD174_HANDOFF_PRIVATE_BOUND_REFUSED');
 const snapshotSha256=sha(text);if(snapshotSha256!==prepared.plan.privateReferences.snapshot.sha256)fail('HELD174_HANDOFF_SNAPSHOT_REFERENCE_REFUSED');
 if(prepared.plan.stage==='return-to-original'&&(!originalSnapshot||sha(JSON.stringify(originalSnapshot))!==prepared.plan.privateReferences.restore.sha256))fail('HELD174_HANDOFF_RESTORE_REFERENCE_REFUSED');
 let admission;try{admission=await current({context,plan:prepared.plan,planSha256:prepared.planSha256,snapshotSha256});}catch{fail('HELD174_HANDOFF_CURRENT_REFUSED');}
 if(!admission||Object.getPrototypeOf(admission)!==Object.prototype||admission.operationId!==prepared.plan.operationId||admission.stage!==prepared.plan.stage||admission.purpose!==PURPOSE
  ||typeof admission.actor!=='string'||!admission.actor||admission.actor.length>200||JSON.stringify(admission.candidate)!==JSON.stringify(prepared.plan.candidate))fail('HELD174_HANDOFF_CURRENT_REFUSED');
 for(const[n,r]of Object.entries(prepared.plan.privateReferences))if(admission[n+'Sha256']!==r.sha256)fail('HELD174_HANDOFF_CURRENT_REFUSED');
 for(const[n,h]of Object.entries(SOURCE))if(admission[n]!==h)fail('HELD174_HANDOFF_CURRENT_SOURCE_PROOF_REFUSED');
 const useNew=['switch-to-candidate','verify-candidate'].includes(prepared.plan.stage),verify=prepared.plan.stage.startsWith('verify-'),now=Date.now();
 if(!fresh(admission.checkedAt,admission.expiresAt,300000,now)||admission.activeWorkerProcesses!==(verify?1:0)
  ||admission.measuredWorkerSha256!==(useNew?prepared.plan.candidate.newWorkerSha256:FIXED.oldWorkerSha256)
  ||admission.measuredImageSha256!==(useNew?prepared.plan.candidate.newImageSha256:FIXED.oldImageSha256)
  ||admission.measuredRuntimeSha256!==FIXED.runtimeSha256||admission.measuredQuerySha256!==FIXED.querySha256||admission.compiledKernelSha256!==FIXED.kernelSha256)fail('HELD174_HANDOFF_CURRENT_MEASUREMENT_REFUSED');
 checkLegacyPending(admission.legacyPendingRows);
 if(sha(JSON.stringify(admission.legacyPendingRows))!==prepared.plan.privateReferences.legacyPending.sha256)fail('HELD174_HANDOFF_LEGACY_PENDING_REFERENCE_REFUSED');
 checkQuiescence(admission.quiescence,snapshot,now);
 if(verify&&(!uuid(admission.currentProcessInstanceId)||!uuid(admission.priorLeaseInstanceId)||admission.currentProcessInstanceId===admission.priorLeaseInstanceId
  ||!Number.isFinite(Date.parse(admission.identityCommitAcknowledgedAt))))fail('HELD174_HANDOFF_CURRENT_HEARTBEAT_REQUIRED');
 const envelope={plan:prepared.plan,snapshot,privateAdmission:admission};if(prepared.plan.stage==='return-to-original')envelope.originalSnapshot=originalSnapshot;
 const privateText=JSON.stringify(envelope);if(Buffer.byteLength(privateText)>MAX_PRIVATE_BYTES)fail('HELD174_HANDOFF_PRIVATE_BOUND_REFUSED');return privateText;
}
function executeOriginal(){fail('HELD174_HANDOFF_ORIGINAL_EXECUTION_NOT_ADMITTED');}
module.exports=Object.freeze({prepare,bindCurrent,executeOriginal,FIXED,STAGES,PURPOSE,ASSETS,SOURCE,REFERENCES,MAX_PRIVATE_BYTES,sha});
