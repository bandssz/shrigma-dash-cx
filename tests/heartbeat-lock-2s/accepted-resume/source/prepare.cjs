"use strict";
// Inert SOURCE only. Authentic Root CURRENT/admission/journal are a separate required interface.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const ASSETS=Object.freeze({
  "resume.atomic.sql.in": "c3ebe81adee5abba8c00c1fed6fbb7f3d8453e03b82c1e8aafd3182072b7015d",
  "snapshot.private-read.sql": "8e832e93a53eef8d9f11fbd6680cca89a9e7c2bf155b01043c271bbd8cf5b674",
  "PUBLIC-FUNCTION-PINS.json": "f84844815cb3cd8812b0eb8b968d8716a559e5c008bf20de1018862c0721856f"
});
const PURPOSE="crm.heartbeat-lock.accepted-sequential-resume";
const CANDIDATE=Object.freeze({workerSha256:"4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb",runtimeSha256:"4cd321fbdfd9a163f7c5ea2e1ba71029140e00a468d421908de8d0211d1e42cb",querySha256:"772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700",kernelSha256:"7d9e4cd7fd4e3c6f9967386c5ca7b1410e755690fac3a77149d8d032d2c4e8b4",imageSha256:"85acc4a8b455d9fa9f841cfb2c307fba1263651402ec569a213d8fb0d20544ad"});
const sha=v=>crypto.createHash("sha256").update(v).digest("hex");
function fail(code){const e=new Error(code);e.code=code;throw e;}
function keys(v,names){if(!v||typeof v!=="object"||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join("|")!==[...names].sort().join("|"))fail("ACCEPTED_RESUME_INPUT_REFUSED");}
function uuid(v){return typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)&&v!=="00000000-0000-0000-0000-000000000000";}
function load(n){let b;try{const p=path.join(__dirname,n);if(fs.lstatSync(p).isSymbolicLink())fail("ACCEPTED_RESUME_SOURCE_DRIFT");b=fs.readFileSync(p);}catch{fail("ACCEPTED_RESUME_SOURCE_DRIFT");}if(sha(b)!==ASSETS[n])fail("ACCEPTED_RESUME_SOURCE_DRIFT");return b.toString("utf8");}
function replaceOne(s,n,v){if(s.split(n).length!==2)fail("ACCEPTED_RESUME_ANCHOR_REFUSED");return s.replace(n,()=>v);}
const literal=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'";
function freeze(v){if(v&&typeof v==="object"){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function prepare(input){
 keys(input,["campaignId","operationId","candidate","privateReferences"]);
 if(![171,174].includes(input.campaignId)||!uuid(input.operationId))fail("ACCEPTED_RESUME_CAMPAIGN_REFUSED");
 keys(input.candidate,Object.keys(CANDIDATE));for(const k of Object.keys(CANDIDATE))if(input.candidate[k]!==CANDIDATE[k])fail("ACCEPTED_RESUME_IDENTITY_REFUSED");
 keys(input.privateReferences,["admission","snapshot","quiescence","binding","disposition"]);
 const refs={};for(const n of ["admission","snapshot","quiescence","binding","disposition"]){const r=input.privateReferences[n];keys(r,["reference","sha256"]);if(!uuid(r.reference)||typeof r.sha256!=="string"||!/^[a-f0-9]{64}$/.test(r.sha256))fail("ACCEPTED_RESUME_REFERENCE_REFUSED");refs[n]={...r};}
 const plan={schema:"accepted-sequential-resume-plan-v1",admissionPurpose:PURPOSE,campaignId:input.campaignId,operationId:input.operationId,candidate:{...CANDIDATE},privateReferences:refs,statementTimeoutMs:5000,lockTimeoutMs:500,executeOriginalAvailable:false};
 const snapshot=load("snapshot.private-read.sql").trim();if(!snapshot.endsWith(";"))fail("ACCEPTED_RESUME_SOURCE_DRIFT");
 let core=load("resume.atomic.sql.in");core=replaceOne(core,"__PLAN_JSON_LITERAL__",literal(plan));core=replaceOne(core,"__PUBLIC_FUNCTION_PINS_LITERAL__",literal(JSON.parse(load("PUBLIC-FUNCTION-PINS.json"))));
 if(core.split("__SNAPSHOT_SELECT__").length!==3)fail("ACCEPTED_RESUME_ANCHOR_REFUSED");core=core.replaceAll("__SNAPSHOT_SELECT__",()=>snapshot.slice(0,-1));
 return freeze({schema:"accepted-sequential-resume-prepared-v1",plan,planSha256:sha(JSON.stringify(plan)),atomicSha256:sha(core),sourcePins:{...ASSETS},statements:["BEGIN ISOLATION LEVEL READ COMMITTED;","SET LOCAL statement_timeout='5s';","SET LOCAL lock_timeout='500ms';","SET LOCAL idle_in_transaction_session_timeout='10s';","SET LOCAL search_path=pg_catalog;","SELECT pg_catalog.set_config('shrigma.private_accepted_resume_envelope',$1::text,true) IS NOT NULL AS private_envelope_bound;",core,"SELECT pg_catalog.set_config('shrigma.private_accepted_resume_envelope','',true) IS NOT NULL AS private_envelope_cleared;","COMMIT;"],snapshotReadSQL:snapshot,executionAvailable:false,authorizesProcessing:false,privateParameterContract:"Authentic Root envelope only RAM/stdin; no SQL/JSON/private snapshot in argv/log/artifact",originalOperational:false});
}
function executeOriginal(){fail("ACCEPTED_RESUME_ORIGINAL_EXECUTION_NOT_ADMITTED");}
module.exports=Object.freeze({prepare,executeOriginal,CANDIDATE,PURPOSE,ASSETS});
