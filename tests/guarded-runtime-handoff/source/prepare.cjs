"use strict";
// Inert SOURCE; neither caller input nor a source hash creates original authority.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const ASSETS=Object.freeze({
  "handoff.atomic.sql.in": "8bc9da5a1e4685c01a12ba1b01b48fb8adf675b6d491c72cf7fa970adcf21042",
  "snapshot.private-read.sql": "90af778e67c767c4dd5b0bcb6b7c0169c55b00ec1d59c5ae42674a2b540c49f9",
  "PUBLIC-FUNCTION-PINS.json": "fac062d80b0a252823ea8e877466fd7cad4121a28c92a2db9651a13f22226b68"
});
const sha=v=>crypto.createHash("sha256").update(v).digest("hex");
const hex=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=="00000000-0000-0000-0000-000000000000";
const CANDIDATE=Object.freeze({
 oldWorkerSha256:"4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb",
 newWorkerSha256:"4f0df98b0852ae7ac01ee4bbecbf5d9f013e30c8cc6cc4786260747e4b3b9c46",
 runtimeSha256:"4cd321fbdfd9a163f7c5ea2e1ba71029140e00a468d421908de8d0211d1e42cb",
 querySha256:"772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700",
 oldImageSha256:"85acc4a8b455d9fa9f841cfb2c307fba1263651402ec569a213d8fb0d20544ad",
 newImageSha256:"6fb797a7ab1213c4e822a7e30bb5ee2de1a35e8b0fa46c499bc520488ef8af9d"
});
const PURPOSES=Object.freeze({
 "switch-to-candidate":"crm.guarded-runtime-handoff.switch",
 "verify-candidate":"crm.guarded-runtime-handoff.verify-candidate",
 "return-to-original":"crm.guarded-runtime-handoff.own-return",
 "verify-original":"crm.guarded-runtime-handoff.verify-original"
});
const REFERENCE_NAMES=Object.freeze(["admission","snapshot","restore","quiescence","binding","measurement"]);
const preparedObjects=new WeakSet();
function refuse(code){const e=new Error(code);e.code=code;throw e;}
function keys(v,names){if(!v||typeof v!=="object"||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype
 ||Object.keys(v).sort().join("|")!==[...names].sort().join("|"))refuse("GUARDED_HANDOFF_INPUT_REFUSED");}
function freeze(v){if(v&&typeof v==="object"){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function load(n){const file=path.join(__dirname,n);let b;try{if(fs.lstatSync(file).isSymbolicLink())refuse("GUARDED_HANDOFF_SOURCE_DRIFT");b=fs.readFileSync(file);}catch{refuse("GUARDED_HANDOFF_SOURCE_DRIFT");}if(sha(b)!==ASSETS[n])refuse("GUARDED_HANDOFF_SOURCE_DRIFT");return b.toString("utf8");}
function replaceOne(s,n,v){if(s.split(n).length!==2)refuse("GUARDED_HANDOFF_ANCHOR_REFUSED");return s.replace(n,()=>v);}
const literal=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'";
function prepare(input){
 keys(input,["stage","operationId","privateReferences"]);
 if(!Object.hasOwn(PURPOSES,input.stage)||!uuid(input.operationId))refuse("GUARDED_HANDOFF_STAGE_REFUSED");
 keys(input.privateReferences,REFERENCE_NAMES);const refs={};
 for(const n of REFERENCE_NAMES){const r=input.privateReferences[n];keys(r,["reference","sha256"]);if(!uuid(r.reference)||!hex(r.sha256))refuse("GUARDED_HANDOFF_REFERENCE_REFUSED");refs[n]={...r};}
 const plan={schema:"guarded-runtime-handoff-plan-v1",stage:input.stage,operationId:input.operationId,
  admissionPurpose:PURPOSES[input.stage],candidate:{...CANDIDATE},privateReferences:refs,
  heldDispatchId:"0d8c77b2-18e7-474f-b9b7-bbfc733bac2f",ownedControls:[171,172,174],
  preservedCampaigns:[171,172,173,174,175,176,177],statementTimeoutMs:5000,lockTimeoutMs:500,
  runtimeIdentityMustBeGenuinelyMeasured:true,processingAuthorized:false};
 const snapshot=load("snapshot.private-read.sql").trim();if(!snapshot.endsWith(";"))refuse("GUARDED_HANDOFF_SOURCE_DRIFT");
 let core=load("handoff.atomic.sql.in");core=replaceOne(core,"__PLAN_JSON_LITERAL__",literal(plan));
 core=replaceOne(core,"__PUBLIC_FUNCTION_PINS_LITERAL__",literal(JSON.parse(load("PUBLIC-FUNCTION-PINS.json"))));
 if(core.split("__SNAPSHOT_SELECT__").length!==3)refuse("GUARDED_HANDOFF_ANCHOR_REFUSED");
 core=core.replaceAll("__SNAPSHOT_SELECT__",()=>snapshot.slice(0,-1));
 const result=freeze({schema:"guarded-runtime-handoff-prepared-v1",plan,planSha256:sha(JSON.stringify(plan)),sourcePins:{...ASSETS},
  atomicSha256:sha(core),snapshotReadSQL:snapshot,statements:[
   "BEGIN ISOLATION LEVEL READ COMMITTED;","SET LOCAL statement_timeout='5s';","SET LOCAL lock_timeout='500ms';",
   "SET LOCAL idle_in_transaction_session_timeout='10s';","SET LOCAL search_path=pg_catalog;",
   "SELECT pg_catalog.set_config('shrigma.private_guarded_handoff_envelope',$1::text,true) IS NOT NULL AS private_envelope_bound;",
   core,"SELECT pg_catalog.set_config('shrigma.private_guarded_handoff_envelope','',true) IS NOT NULL AS private_envelope_cleared;","COMMIT;"],
  executionAvailable:false,originalOperational:false,processingAuthorized:false,
  privateParameterContract:"Envelope/full snapshot only DB/RAM/stdin; never shell argv, SQL file or log"});
 preparedObjects.add(result);return result;
}
async function bindCurrent({prepared,context,current,snapshot,originalSnapshot}){
 if(!preparedObjects.has(prepared)||typeof current!=="function")refuse("GUARDED_HANDOFF_CURRENT_CALLBACK_REQUIRED");
 if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot))refuse("GUARDED_HANDOFF_PRIVATE_SNAPSHOT_REQUIRED");
 const snapshotText=JSON.stringify(snapshot),snapshotSha256=sha(snapshotText);
 if(snapshotSha256!==prepared.plan.privateReferences.snapshot.sha256)refuse("GUARDED_HANDOFF_SNAPSHOT_REFERENCE_REFUSED");
 if(prepared.plan.stage==="return-to-original"&&(!originalSnapshot||sha(JSON.stringify(originalSnapshot))!==prepared.plan.privateReferences.restore.sha256))
  refuse("GUARDED_HANDOFF_RESTORE_REFERENCE_REFUSED");
 // Root provides this private native CURRENT callback. No authority object/actor
 // is accepted as a request argument and no callback/admission is constructed.
 let admission;try{admission=await current({context,plan:prepared.plan,planSha256:prepared.planSha256,snapshotSha256});}
 catch{refuse("GUARDED_HANDOFF_CURRENT_REFUSED");}
 if(!admission||typeof admission!=="object"||Array.isArray(admission)
  ||admission.operationId!==prepared.plan.operationId||admission.stage!==prepared.plan.stage
  ||admission.purpose!==prepared.plan.admissionPurpose||typeof admission.actor!=="string"||!admission.actor||admission.actor.length>200
  ||JSON.stringify(admission.candidate)!==JSON.stringify(prepared.plan.candidate))refuse("GUARDED_HANDOFF_CURRENT_REFUSED");
 for(const n of REFERENCE_NAMES)if(admission[n+"Sha256"]!==prepared.plan.privateReferences[n].sha256)refuse("GUARDED_HANDOFF_CURRENT_REFUSED");
 const expectedNew=["switch-to-candidate","verify-candidate"].includes(prepared.plan.stage);
 const count=["switch-to-candidate","return-to-original"].includes(prepared.plan.stage)?0:1;
 const checked=Date.parse(admission.checkedAt),expires=Date.parse(admission.expiresAt),now=Date.now();
 if(!Number.isFinite(checked)||!Number.isFinite(expires)||checked>now||expires<=now||expires>checked+300000
  ||admission.activeWorkerProcesses!==count||admission.measuredRuntimeSha256!==CANDIDATE.runtimeSha256
  ||admission.measuredWorkerSha256!==(expectedNew?CANDIDATE.newWorkerSha256:CANDIDATE.oldWorkerSha256)
  ||admission.measuredImageSha256!==(expectedNew?CANDIDATE.newImageSha256:CANDIDATE.oldImageSha256))refuse("GUARDED_HANDOFF_CURRENT_MEASUREMENT_REFUSED");
 if(count===1&&(!uuid(admission.currentProcessInstanceId)||!uuid(admission.priorLeaseInstanceId)
  ||admission.currentProcessInstanceId===admission.priorLeaseInstanceId||!Number.isFinite(Date.parse(admission.identityCommitAcknowledgedAt))))
  refuse("GUARDED_HANDOFF_CURRENT_HEARTBEAT_REQUIRED");
 const envelope={plan:prepared.plan,snapshot,privateAdmission:admission};
 if(prepared.plan.stage==="return-to-original")envelope.originalSnapshot=originalSnapshot;
 // Returns private data only to trusted Root RAM. Never print or persist it.
 return JSON.stringify(envelope);
}
function executeOriginal(){refuse("GUARDED_HANDOFF_ORIGINAL_EXECUTION_NOT_ADMITTED");}
module.exports=Object.freeze({prepare,bindCurrent,executeOriginal,CANDIDATE,PURPOSES,ASSETS,sha});
