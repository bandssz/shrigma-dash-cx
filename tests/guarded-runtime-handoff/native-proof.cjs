"use strict";
// Prepared CI-only SQL proof. It connects only to the existing disposable full
// listmonk fixture. It never starts worker/SMTP or accepts original authority.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),a=require("node:assert/strict");
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const ASSETS=Object.freeze({
  "source/prepare.cjs": "0a1f76fa24e63108a4ed14cea53ba2e0c8fdafcb9f270c5d94bd618572b4ce2b",
  "source/handoff.atomic.sql.in": "8bc9da5a1e4685c01a12ba1b01b48fb8adf675b6d491c72cf7fa970adcf21042",
  "source/snapshot.private-read.sql": "90af778e67c767c4dd5b0bcb6b7c0169c55b00ec1d59c5ae42674a2b540c49f9",
  "source/PUBLIC-FUNCTION-PINS.json": "fac062d80b0a252823ea8e877466fd7cad4121a28c92a2db9651a13f22226b68",
  "bootstrap.cjs": "e05e34c3495af796134343c143570d8012d0c1502e1c26cd0e39553c1d230ebc",
  "schema.sql": "9d94ea32ee76aab91f6fc5c1179539513a8a955984951570ed537b1916230a8f",
  "fixture.cjs": "4e809c502257cc63c6a6d2e1651d9e4eea669b6127d5e3339e8ac8dcba1a9b2e",
  "fixture-extra-guards.sql": "53ee6e4d2aef2128a05a0bc719473a7e5a91ae7a93ab0b34b3326fcb9ec7e1c1",
  "heartbeat.current-fixture.sql": "a45eed57cf0b43db41873fc198f0c80f9f00c3fe8cba08ebbc29638168d0d606"
});
let phase="boundary",client,kernel,inTx=false,clientEnded=false,rollbackConfirmed=true;const cases=[];
const oldInstance="77777777-7777-4777-8777-777777777777",newInstance="88888888-8888-4888-8888-888888888888";
let originalSnapshot,stageCommitAt;
const equal=(x,y)=>a.deepEqual(x,y);
async function snapshot(){return (await client.query(kernel.prepare(request("switch-to-candidate",{})).snapshotReadSQL)).rows[0].jsonb_build_object;}
function request(stage,s,restore={}){const refs={};for(const n of ["admission","snapshot","restore","quiescence","binding","measurement"])refs[n]={reference:crypto.randomUUID(),sha256:sha(n==="snapshot"?JSON.stringify(s):n==="restore"?JSON.stringify(restore):"synthetic-only:"+stage+":"+n)};return {stage,operationId:crypto.randomUUID(),privateReferences:refs};}
function syntheticCallback(stage,p,{extras={}}={}){return async()=>{
 const useNew=["switch-to-candidate","verify-candidate"].includes(stage),verify=stage.startsWith("verify-");
 return {operationId:p.operationId,stage,purpose:p.admissionPurpose,candidate:p.candidate,
  actor:"synthetic-fixture-only-no-original-authority",checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),
  ...Object.fromEntries(Object.entries(p.privateReferences).map(([n,r])=>[n+"Sha256",r.sha256])),activeWorkerProcesses:verify?1:0,
  measuredWorkerSha256:useNew?kernel.CANDIDATE.newWorkerSha256:kernel.CANDIDATE.oldWorkerSha256,
  measuredImageSha256:useNew?kernel.CANDIDATE.newImageSha256:kernel.CANDIDATE.oldImageSha256,measuredRuntimeSha256:kernel.CANDIDATE.runtimeSha256,
  ...(verify?{currentProcessInstanceId:useNew?newInstance:oldInstance,priorLeaseInstanceId:useNew?oldInstance:newInstance,identityCommitAcknowledgedAt:stageCommitAt}:{}),...extras};};}
async function rollback(){try{await client.query("ROLLBACK");inTx=false;}catch{rollbackConfirmed=false;throw Error("FIXTURE_ROLLBACK_NOT_CONFIRMED");}}
async function run(stage,{change,expect,mutateEnvelope,restore,extras}={}){
 phase=stage+(expect?"-refusal":"-accepted");const proto=kernel.prepare(request(stage,{}));
 await client.query(proto.statements[0]);inTx=true;for(const s of proto.statements.slice(1,5))await client.query(s);
 try{
  if(change)await change();const before=await snapshot(),prepared=kernel.prepare(request(stage,before,restore));
  const text=await kernel.bindCurrent({prepared,snapshot:before,originalSnapshot:restore,context:{synthetic:true},current:syntheticCallback(stage,prepared.plan,{extras})});
  const e=JSON.parse(text);if(mutateEnvelope)mutateEnvelope(e);
  await client.query(prepared.statements[5],[JSON.stringify(e)]);
  try{await client.query(prepared.statements[6]);}catch(err){if(!expect||err.code!=="P0001"||err.message!==expect)throw err;a.equal(err.code,"P0001");a.equal(err.message,expect);await rollback();cases.push({name:phase,refused:true,rollback:true});return;}
  if(expect)throw Error("EXPECTED_REFUSAL_MISSING");const after=await snapshot();
  await client.query(prepared.statements[7]);await client.query(prepared.statements[8]);inTx=false;
  const target=structuredClone(before);if(!stage.startsWith("verify-")){const worker=stage==="switch-to-candidate"?kernel.CANDIDATE.newWorkerSha256:kernel.CANDIDATE.oldWorkerSha256;target.deployment.worker_sha256=worker;for(const c of target.controls)c.worker_sha256=worker;}
  equal(after,target);cases.push({name:phase,commitAcknowledged:true,onlyOwnedWorkerFieldsChanged:true,acceptedAndHeldLedgerPreserved:true});return {before,after};
 }finally{if(inTx)await rollback();}
}
async function heartbeat(instance,worker){
 phase="real-original-heartbeat-fixture";await client.query("BEGIN READ WRITE");inTx=true;await client.query("SET LOCAL statement_timeout='5s'");
 try{const r=(await client.query("SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) r",[instance,worker,kernel.CANDIDATE.runtimeSha256])).rows[0].r;a.equal(r.ready,true);await client.query("COMMIT");inTx=false;return r;}finally{if(inTx)await rollback();}
}
async function expire(){await client.query("UPDATE crm_audience_v2.regular_worker_lease SET heartbeat_at=clock_timestamp()-interval '70 seconds',expires_at=clock_timestamp()-interval '10 seconds'");}
async function main(){
 a.equal(process.env.GUARDED_HANDOFF_FIXTURE_ISOLATED,"1");a.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,"1");a.equal(process.env.REGULAR_NATIVE_SOURCE_PROOF,"1");
 a.equal(process.version,"v22.23.3");a.equal(process.getuid(),1000);a.equal(process.platform,"linux");a.equal(process.arch,"x64");a.equal(require("pg/package.json").version,"8.23.1");
 const url=new URL(process.env.GUARDED_HANDOFF_FIXTURE_URL||"https://invalid");a.equal(url.protocol,"postgresql:");a.equal(url.hostname,"127.0.0.1");a.equal(url.port,"55432");a.equal(url.pathname,"/listmonk");a.equal(url.username,"postgres");a.equal(url.password,"");a.equal(url.search,"");a.equal(url.hash,"");
 for(const[n,h]of Object.entries(ASSETS)){const f=path.join(__dirname,n);a(!fs.lstatSync(f).isSymbolicLink());a.equal(sha(fs.readFileSync(f)),h);}
 kernel=require("./source/prepare.cjs");const {Client}=require("pg");client=new Client({connectionString:url.href,options:"-c TimeZone=Etc/UTC",query_timeout:12000});
 try{
  await client.connect();a.deepEqual((await client.query("SELECT current_setting('server_version_num') v,current_database() d,current_setting('TimeZone') z,session_user=current_user r")).rows[0],{v:"170010",d:"listmonk",z:"Etc/UTC",r:true});
  phase="full-original-schema-synthetic-ledger-seed";await require("./fixture.cjs").prepareFixture(client,path.resolve(__dirname,"../.."));
  await client.query(fs.readFileSync(path.join(__dirname,"heartbeat.current-fixture.sql"),"utf8"));
  await heartbeat(oldInstance,kernel.CANDIDATE.oldWorkerSha256);await expire();originalSnapshot=await snapshot();
  a.equal(originalSnapshot.dispatch.length,519);a.equal(originalSnapshot.dispatch.filter(d=>d.transport_state==="accepted").length,518);
  a.equal(originalSnapshot.dispatch.filter(d=>d.transport_state==="outcome_unknown").length,1);a.equal(originalSnapshot.campaignGuard.length,3);a.equal(Object.keys(originalSnapshot.functionMetadata).length,12);
  await run("switch-to-candidate",{mutateEnvelope:e=>delete e.privateAdmission.purpose,expect:"GUARDED_HANDOFF_PRIVATE_ADMISSION_MISMATCH"});equal(await snapshot(),originalSnapshot);
  await run("switch-to-candidate",{mutateEnvelope:e=>e.snapshot.campaigns[0].sent++,expect:"GUARDED_HANDOFF_SNAPSHOT_DRIFT"});equal(await snapshot(),originalSnapshot);
  await run("switch-to-candidate",{change:()=>client.query("UPDATE crm_audience_v2.regular_worker_lease SET expires_at=clock_timestamp()+interval '60 seconds'"),expect:"GUARDED_HANDOFF_OLD_LEASE_STILL_LIVE"});equal(await snapshot(),originalSnapshot);
  await run("switch-to-candidate",{change:()=>client.query("UPDATE public.shrigma_email_dispatch SET transport_state='accepted' WHERE dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'"),expect:"GUARDED_HANDOFF_SCOPE_OR_LEDGER_REFUSED"});equal(await snapshot(),originalSnapshot);
  await run("switch-to-candidate",{change:()=>client.query("UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=false WHERE campaign_id=174"),expect:"GUARDED_HANDOFF_HELD_OR_FUTURE_REFUSED"});equal(await snapshot(),originalSnapshot);
  await run("switch-to-candidate",{change:()=>client.query("ALTER TABLE public.campaigns DISABLE TRIGGER shrigma_audience_campaign_send_guard_v1"),expect:"GUARDED_HANDOFF_TRIGGER_OR_AB_REFUSED"});equal(await snapshot(),originalSnapshot);
  await run("switch-to-candidate",{change:()=>client.query("UPDATE public.campaigns SET status='running' WHERE id=175"),expect:"GUARDED_HANDOFF_SCOPE_OR_LEDGER_REFUSED"});equal(await snapshot(),originalSnapshot);
  const switched=await run("switch-to-candidate");stageCommitAt=new Date().toISOString();equal(switched.before,originalSnapshot);
  await run("verify-candidate",{expect:"GUARDED_HANDOFF_LEASE_IDENTITY_REFUSED"});equal(await snapshot(),switched.after);
  // Real own return before any candidate heartbeat, retaining old actual lease.
  const returned=await run("return-to-original",{restore:originalSnapshot});equal(returned.after,originalSnapshot);
  await run("switch-to-candidate");stageCommitAt=new Date().toISOString();await heartbeat(newInstance,kernel.CANDIDATE.newWorkerSha256);
  const live=await snapshot();a.equal(live.lease.instance_id,newInstance);a.equal(live.selectionRuntime.enabled,true);
  await run("verify-candidate");equal(await snapshot(),live);
  await run("return-to-original",{restore:originalSnapshot,expect:"GUARDED_HANDOFF_OLD_LEASE_STILL_LIVE"});equal(await snapshot(),live);
  // Actual held claim remains refused with new real heartbeat; no ledger mutation.
  phase="held174-real-claim-refused";await client.query("BEGIN READ WRITE");inTx=true;await client.query("SET LOCAL statement_timeout='5s'");
  const ctl=live.controls.find(c=>c.campaign_id===174);
  try{await client.query("SELECT crm_audience_v2.regular_delivery_claim_live($1::uuid,174,1,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9)",[newInstance,crypto.randomUUID(),kernel.CANDIDATE.newWorkerSha256,kernel.CANDIDATE.runtimeSha256,ctl.envelope_from,"fixture@example.invalid","d".repeat(64),"{}",ctl.configuration_set]);throw Error("HELD_CLAIM_UNEXPECTEDLY_ACCEPTED");}
  catch(err){a(["P0001","55000"].includes(err.code));await rollback();cases.push({name:phase,originalClaimFunction:true,refused:true,rollback:true,smtpCalls:0});}equal(await snapshot(),live);
  await expire();const afterExpired=await snapshot();
  await run("return-to-original",{restore:originalSnapshot,mutateEnvelope:e=>e.originalSnapshot.dispatch[0].payload_sha256="f".repeat(64),expect:"GUARDED_HANDOFF_OWN_RETURN_AFTER_DRIFT"});equal(await snapshot(),afterExpired);
  const finalReturn=await run("return-to-original",{restore:originalSnapshot});stageCommitAt=new Date().toISOString();a.equal(finalReturn.after.lease.instance_id,newInstance);
  await heartbeat(oldInstance,kernel.CANDIDATE.oldWorkerSha256);const originalLive=await snapshot();await run("verify-original");equal(await snapshot(),originalLive);
  a.equal(originalLive.controls.find(c=>c.campaign_id===174).suspended,true);a.equal(originalLive.campaigns.find(c=>c.id===174).status,"paused");equal(originalLive.dispatch,originalSnapshot.dispatch);
  a.equal(cases.length,17);phase="closed";
 }finally{try{if(inTx)await rollback();}finally{try{await client.end();clientEnded=true;}catch{clientEnded=false;}}}
}
main().then(()=>{a(clientEnded&&rollbackConfirmed);const r={schema:"guarded-runtime-handoff-native-proof-v1",ok:true,caseCount:cases.length,cases,sourcePins:ASSETS,
 node:process.version,uid:process.getuid(),postgresVersion:"17.10",pgVersion:"8.23.1",synthetic:true,acceptedFixtureCount:518,heldUnknownFixtureCount:1,
 originalCalls:0,originalWrites:0,smtpCalls:0,nativeWorkerExecuted:false,originalAuthorityAccepted:false,originalRuntimeMeasured:false,
 clientEndConfirmed:clientEnded,rollbackConfirmed,fixtureServerEnded:false,operational:false};
 const f=process.env.GUARDED_HANDOFF_FIXTURE_RECEIPT;a(f&&path.isAbsolute(f)&&!fs.existsSync(f));fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n",{flag:"wx",mode:0o644});fs.chmodSync(f,0o644);
 console.log(JSON.stringify({schema:r.schema,ok:true,caseCount:r.caseCount,clientEndConfirmed:true,originalCalls:0,operational:false}));
}).catch(e=>{
 const sqlstate=typeof e.code==="string"&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null;
 const refusal=typeof e.message==="string"&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:null;
 const pos=typeof e.position==="string"&&/^[1-9][0-9]{0,6}$/.test(e.position)?Number(e.position):null;
 const r={schema:"guarded-runtime-handoff-native-proof-v1",ok:false,phase,sqlstate,
  errorClass:sqlstate==="42601"?"SQL_SYNTAX_REFUSED":sqlstate?"SQL_REFUSED":e.code==="ERR_ASSERTION"?"ASSERTION_REFUSED":"PROOF_REFUSED",
  refusalCode:refusal,statementPosition:pos,caseCount:cases.length,cases,sourcePins:ASSETS,
  node:process.version,uid:typeof process.getuid==="function"?process.getuid():null,
  postgresVersionExpected:"17.10",pgVersionExpected:"8.23.1",synthetic:true,
  clientEndConfirmed:clientEnded,rollbackConfirmed,fixtureServerEnded:false,
  originalCalls:0,originalWrites:0,smtpCalls:0,nativeWorkerExecuted:false,
  originalAuthorityAccepted:false,originalRuntimeMeasured:false,operational:false};
 let receiptWritten=false;const f=process.env.GUARDED_HANDOFF_FIXTURE_RECEIPT;
 // Failure evidence is synthetic/closed. Never overwrite a receipt, emit SQL,
 // free error text, a snapshot or any original parameter.
 if(clientEnded&&process.env.GUARDED_HANDOFF_FIXTURE_ISOLATED==="1"&&f&&path.isAbsolute(f)&&!fs.existsSync(f)){
  try{fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n",{flag:"wx",mode:0o644});fs.chmodSync(f,0o644);receiptWritten=true;}catch{}
 }
 console.log(JSON.stringify({...r,receiptWritten}));process.exitCode=1;
});
