"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sourceDir = process.env.OWN_RECOVERY_SOURCE_DIR || (fs.existsSync(path.join(__dirname,"prepare.cjs")) ? __dirname : path.join(__dirname,"source"));
const m = require(path.join(sourceDir,"prepare.cjs"));
function input(stage="repair-identity") {
 const refs={}; let n=0;
 for (const name of ["admission","snapshot","restore","quiescence","binding"])
  refs[name]={reference:`11111111-1111-1111-1111-${String(++n).padStart(12,"0")}`, sha256:String(n).repeat(64)};
 return {stage,operationId:"22222222-2222-2222-2222-222222222222",candidate:{
  oldWorkerSha256:"a".repeat(64),newWorkerSha256:m.NEW_WORKER_SHA256,runtimeSha256:m.RUNTIME_SHA256,
  querySha256:m.QUERY_SHA256,kernelSha256:m.KERNEL_SHA256,imageSha256:m.IMAGE_SHA256},privateReferences:refs};
}
const code = (fn,c) => assert.throws(fn,e => e.code===c && e.message===c);
test("three distinct stages bind exact finite scope and have no execution capability",()=>{
 const purposes=new Set();
 for(const stage of Object.keys(m.PURPOSES)) {
  const p=m.prepare(input(stage)); purposes.add(p.plan.admissionPurpose);
  assert.equal(p.plan.stage,stage);assert.equal(p.executionAvailable,false);assert.equal(p.authorizesProcessing,false);
  assert.deepEqual(p.plan.ownedControls,[171,172,174]);assert.deepEqual(p.plan.resumeCampaigns,[171,174]);
  assert.deepEqual(p.plan.preservedLegacyCampaigns,[173]);
  assert.equal(p.plan.statementTimeoutMs,5000);assert.equal(p.plan.lockTimeoutMs,500);
  assert.equal(p.statements.at(-1),"COMMIT;");
  assert.equal(p.statements[5],"SELECT pg_catalog.set_config('shrigma.private_own_recovery_envelope',$1::text,true) IS NOT NULL AS private_envelope_bound;");
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.plan)&&Object.isFrozen(p.statements));
  code(()=>m.executeOriginal(p),"OWN_RECOVERY_ORIGINAL_EXECUTION_NOT_ADMITTED");
 }
 assert.equal(purposes.size,3);
});
test("caller actor grant issuer booleans and arbitrary scope cannot prepare admission",()=>{
 for(const field of ["actor","grant","issuer","authorized","context","executeOriginal"]) {
  const v=input();v[field]=true;code(()=>m.prepare(v),"OWN_RECOVERY_INPUT_REFUSED");
 }
 for(const stage of ["rearm","resume","restore","dispatch","repair-identity; DROP TABLE campaigns",true,null]) {
  const v=input();v.stage=stage;code(()=>m.prepare(v),"OWN_RECOVERY_STAGE_REFUSED");
 }
});
test("candidate drift refuses runtime query kernel image or wrong executable",()=>{
 for(const field of ["newWorkerSha256","runtimeSha256","querySha256","kernelSha256","imageSha256"]) {
  const v=input();v.candidate[field]="f".repeat(64);code(()=>m.prepare(v),"OWN_RECOVERY_CANDIDATE_REFUSED");
 }
 const v=input();v.candidate.oldWorkerSha256=v.candidate.newWorkerSha256;
 code(()=>m.prepare(v),"OWN_RECOVERY_CANDIDATE_REFUSED");
});
test("reference hashes are attempt binders, not private content or authority",()=>{
 for(const value of [true,{},"secret $$$'$&", "sha256:"+"f".repeat(64),"F".repeat(64)]) {
  const v=input();v.privateReferences.binding.sha256=value;code(()=>m.prepare(v),"OWN_RECOVERY_REFERENCE_REFUSED");
 }
 const v=input();v.privateReferences.binding.secret="private";
 code(()=>m.prepare(v),"OWN_RECOVERY_INPUT_REFUSED");
 const x=input();x.privateReferences.binding.reference="https://private.invalid/token";
 code(()=>m.prepare(x),"OWN_RECOVERY_REFERENCE_REFUSED");
});
test("unknown shape inherited object zero UUID and non-objects refuse",()=>{
 for(const v of [null,true,[],Object.assign(Object.create({grant:true}),input())]) code(()=>m.prepare(v),"OWN_RECOVERY_INPUT_REFUSED");
 const v=input();v.operationId="00000000-0000-0000-0000-000000000000";code(()=>m.prepare(v),"OWN_RECOVERY_STAGE_REFUSED");
 const z=input();z.privateReferences.snapshot.reference="00000000-0000-0000-0000-000000000000";
 code(()=>m.prepare(z),"OWN_RECOVERY_REFERENCE_REFUSED");
});
test("source pin checked again by preparation, tampered asset cannot produce SQL",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"own-recovery-source-test-"));
 try {
  for(const name of ["prepare.cjs",...Object.keys(m.ASSETS)]) fs.copyFileSync(path.join(sourceDir,name),path.join(dir,name));
  const isolated=require(path.join(dir,"prepare.cjs"));
  assert.equal(isolated.prepare(input()).executionAvailable,false);
  fs.appendFileSync(path.join(dir,"recovery.atomic.sql.in"),"\n-- drift\n");
  code(()=>isolated.prepare(input()),"OWN_RECOVERY_SOURCE_DRIFT");
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test("attempt and binder changes make distinct immutable preparation hashes",()=>{
 const a=m.prepare(input()); const i=input();i.privateReferences.admission.sha256="f".repeat(64);
 const b=m.prepare(i);assert.notEqual(a.planSha256,b.planSha256);assert.notEqual(a.atomicSha256,b.atomicSha256);
 assert.equal(m.prepare(input()).atomicSha256,a.atomicSha256);
});
