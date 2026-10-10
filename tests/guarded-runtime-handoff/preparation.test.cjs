"use strict";
const test=require("node:test"),a=require("node:assert/strict"),crypto=require("node:crypto"),path=require("node:path");
const k=require(path.join(__dirname,"source/prepare.cjs"));
const refs=s=>Object.fromEntries(["admission","snapshot","restore","quiescence","binding","measurement"].map(n=>[n,{reference:crypto.randomUUID(),sha256:k.sha(n==="snapshot"?JSON.stringify(s):"fixture:"+n)}]));
const request=(stage,s={})=>({stage,operationId:crypto.randomUUID(),privateReferences:refs(s)});
const fixedCallback=p=>async()=>({operationId:p.operationId,stage:p.stage,purpose:p.admissionPurpose,candidate:p.candidate,
 actor:"synthetic-unit-test-only-no-original-authority",checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),
 ...Object.fromEntries(Object.entries(p.privateReferences).map(([n,r])=>[n+"Sha256",r.sha256])),activeWorkerProcesses:0,
 measuredWorkerSha256:k.CANDIDATE.newWorkerSha256,measuredImageSha256:k.CANDIDATE.newImageSha256,measuredRuntimeSha256:k.CANDIDATE.runtimeSha256});
test("all four stages are purpose-separated/inert and pin source",()=>{
 a.equal(new Set(Object.values(k.PURPOSES)).size,4);
 for(const stage of Object.keys(k.PURPOSES)){const p=k.prepare(request(stage));a.equal(p.executionAvailable,false);a.equal(p.processingAuthorized,false);a.equal(p.plan.stage,stage);a.equal(p.statements.at(-1),"COMMIT;");a(p.statements[6].includes("worker_sha256=to_worker"));
  a(!/UPDATE\s+(public\.campaigns|public\.shrigma_email_dispatch|crm_audience_v2\.regular_worker_lease|crm_audience_v2\.selection_runtime)/i.test(p.statements[6]));
  a(p.statements[6].includes("GUARDED_HANDOFF_OLD_LEASE_STILL_LIVE"));a(p.statements[6].includes("'lock_timeout=2s'" )||p.statements[6].includes('"lock_timeout=2s"'));}
 a.throws(()=>k.executeOriginal(),{code:"GUARDED_HANDOFF_ORIGINAL_EXECUTION_NOT_ADMITTED"});
});
test("boolean/caller actor/grant never replaces private CURRENT callback",async()=>{
 const p=k.prepare(request("switch-to-candidate"));for(const current of [undefined,true,{actor:"caller",grant:true}])await a.rejects(k.bindCurrent({prepared:p,snapshot:{},current}),{code:"GUARDED_HANDOFF_CURRENT_CALLBACK_REQUIRED"});
 await a.rejects(k.bindCurrent({prepared:p,snapshot:{},current:async()=>true}),{code:"GUARDED_HANDOFF_CURRENT_REFUSED"});
 await a.rejects(k.bindCurrent({prepared:p,snapshot:{},current:async()=>{throw Error("synthetic private callback text must not escape");}}),{code:"GUARDED_HANDOFF_CURRENT_REFUSED",message:"GUARDED_HANDOFF_CURRENT_REFUSED"});
 a.throws(()=>k.prepare({...request("switch-to-candidate"),actor:"caller"}),{code:"GUARDED_HANDOFF_INPUT_REFUSED"});
});
test("genuine-runtime interface cannot substitute graph hash, expired purpose or active worker",async()=>{
 const p=k.prepare(request("switch-to-candidate"));const base=await fixedCallback(p.plan)();
 for(const delta of [{measuredRuntimeSha256:"52991c68b5d94dd469b7b0d3a1bc731db108c3e4d139a17351690ae7c37a3335"},{activeWorkerProcesses:1},{expiresAt:new Date(Date.now()-1).toISOString()},{measuredWorkerSha256:k.CANDIDATE.oldWorkerSha256}])
  await a.rejects(k.bindCurrent({prepared:p,snapshot:{},current:async()=>({...base,...delta})}),{code:"GUARDED_HANDOFF_CURRENT_MEASUREMENT_REFUSED"});
 await a.rejects(k.bindCurrent({prepared:p,snapshot:{},current:async()=>({...base,purpose:"old-consumed-purpose"})}),{code:"GUARDED_HANDOFF_CURRENT_REFUSED"});
});
test("exact private snapshot/reference and genuine object identity are required",async()=>{
 const snapshot={held:true,note:"synthetic $$ $& $' literal"},p=k.prepare(request("switch-to-candidate",snapshot));
 let called=0;const cb=async args=>{called++;a.equal(args.snapshotSha256,k.sha(JSON.stringify(snapshot)));return fixedCallback(p.plan)();};
 const envelope=JSON.parse(await k.bindCurrent({prepared:p,context:{opaque:"fixture"},snapshot,current:cb}));a.deepEqual(envelope.snapshot,snapshot);a.equal(called,1);
 await a.rejects(k.bindCurrent({prepared:p,snapshot:{held:false},current:cb}),{code:"GUARDED_HANDOFF_SNAPSHOT_REFERENCE_REFUSED"});a.equal(called,1);
 await a.rejects(k.bindCurrent({prepared:JSON.parse(JSON.stringify(p)),snapshot,current:cb}),{code:"GUARDED_HANDOFF_CURRENT_CALLBACK_REQUIRED"});
});
test("verify requires new real instance/heartbeat, own return original reference",async()=>{
 const p=k.prepare(request("verify-candidate"));const base=await fixedCallback(p.plan)();
 await a.rejects(k.bindCurrent({prepared:p,snapshot:{},current:async()=>({...base,activeWorkerProcesses:1})}),{code:"GUARDED_HANDOFF_CURRENT_HEARTBEAT_REQUIRED"});
 const q=k.prepare(request("return-to-original"));await a.rejects(k.bindCurrent({prepared:q,snapshot:{},current:fixedCallback(q.plan)}),{code:"GUARDED_HANDOFF_RESTORE_REFERENCE_REFUSED"});
});
