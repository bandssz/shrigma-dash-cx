"use strict";
// Prepared CI-only SQL proof. It connects only to the existing disposable full
// listmonk fixture. It never starts worker/SMTP or accepts original authority.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),a=require("node:assert/strict");
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const ASSETS=Object.freeze({
  "source/prepare.cjs": "5052b7dcfa65354df75efed74d3bdb3ea6090b5ecbbfe441a216672793a10dad",
  "source/handoff.atomic.sql.in": "a474c866bdafd3364d98eeff12038ea2a7087a010ae5d1593e9c0af4640ebd32",
  "source/snapshot.private-read.sql": "f11be5325368eee57498c30a154a2d336d6fdf197d9940dc3dfb6840c4982ed8",
  "source/PUBLIC-FUNCTION-PINS.json": "ce7c579cf73c98b30111f8d36b0150e1ab0c1a2041452aeed9224eb05afb09c7",
  "source/quiescence.read.sql": "b9793e502d29238ad49356ecfa065e093583c01c1de00f9f7532059ba59ea667",
  "bootstrap.cjs": "3945c077309fc9a11d744a443311baaf76bf3f0569d5d1ce2c9325bdb0528272",
  "schema.sql": "9d94ea32ee76aab91f6fc5c1179539513a8a955984951570ed537b1916230a8f",
  "fixture.cjs": "4e3dc98ca2754240cd2ed8ee492739ce518a2926f3aa0b9197964323cdea92b5",
  "fixture-extra-guards.sql": "53ee6e4d2aef2128a05a0bc719473a7e5a91ae7a93ab0b34b3326fcb9ec7e1c1",
  "heartbeat.current-fixture.sql": "a45eed57cf0b43db41873fc198f0c80f9f00c3fe8cba08ebbc29638168d0d606",
  "fixture-inputs/OBJECTS.install.sql": "cac58221689ee10702352846f91070bd29c6ba0a3ebfeb4297e4be37314394f0",
  "fixture-inputs/CLAIM.proposed.sql": "413405c54e3ad1c10b586c027494fa3be3e26cddc469d670762acea4adc8a709",
  "fixture-inputs/RECOVER.proposed.sql": "d9a428584dcf5f3284062f17bcc7bea4117b27cec7bf33c6db98c5f7f03bae12",
  "fixture-inputs/GUARD.proposed.sql": "5fed102b61c871678eb2b14eee73f81d764bdbce066128b378c16c2f5a7442c8"
});
let phase="boundary",client,kernel,inTx=false,clientEnded=false,rollbackConfirmed=true;const cases=[];
const oldInstance="77777777-7777-4777-8777-777777777777",newInstance="88888888-8888-4888-8888-888888888888",returnInstance="99999999-9999-4999-8999-999999999999";
let originalSnapshot,stageCommitAt,candidate;
const equal=(x,y)=>a.deepEqual(x,y);
async function snapshot(){return (await client.query(kernel.prepare(request("switch-to-candidate",{})).snapshotReadSQL)).rows[0].jsonb_build_object;}
function request(stage,s,restore={}){const refs={};for(const n of kernel.REFERENCES)refs[n]={reference:crypto.randomUUID(),sha256:sha(n==="snapshot"?JSON.stringify(s):n==="restore"?JSON.stringify(restore):n==="legacyPending"?JSON.stringify(originalSnapshot?.legacyPendingRows||[]):"synthetic-only:"+stage+":"+n)};return {stage,operationId:crypto.randomUUID(),candidate:{...candidate},privateReferences:refs};}
function syntheticCallback(stage,p,{extras={},snapshotState}={}){return async()=>{
 const useNew=["switch-to-candidate","verify-candidate"].includes(stage),verify=stage.startsWith("verify-");
 return {operationId:p.operationId,stage,purpose:p.admissionPurpose,candidate:p.candidate,
  actor:"synthetic-fixture-only-no-original-authority",checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),
  ...Object.fromEntries(Object.entries(p.privateReferences).map(([n,r])=>[n+"Sha256",r.sha256])),activeWorkerProcesses:verify?1:0,
  measuredWorkerSha256:useNew?candidate.newWorkerSha256:candidate.oldWorkerSha256,
  measuredImageSha256:useNew?candidate.newImageSha256:candidate.oldImageSha256,measuredRuntimeSha256:candidate.runtimeSha256,measuredQuerySha256:candidate.querySha256,compiledKernelSha256:candidate.kernelSha256,...kernel.SOURCE,legacyPendingRows:originalSnapshot.legacyPendingRows,
  quiescence:{checkedAt:new Date(Date.now()-100).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),allFlowReserved:0,allFlowInFlight:34,newOutcomeUnknownAfterCheckpoint:0,httpActive:0,msgQPending:0,smtpActive:0,legacyIngressCoverage:"all-producers-blocked-and-drained",checkpointDispatchFingerprint:snapshotState.allDispatchFingerprint},
  ...(verify?{currentProcessInstanceId:useNew?newInstance:returnInstance,priorLeaseInstanceId:useNew?oldInstance:newInstance,identityCommitAcknowledgedAt:stageCommitAt}:{}),...extras};};}
async function rollback(){try{await client.query("ROLLBACK");inTx=false;}catch{rollbackConfirmed=false;throw Error("FIXTURE_ROLLBACK_NOT_CONFIRMED");}}
async function run(stage,{change,expect,mutateEnvelope,restore,extras,rollbackSuccess}={}){
 phase=stage+(expect?"-"+expect:"-accepted");const proto=kernel.prepare(request(stage,{}));
 await client.query(proto.statements[0]);inTx=true;for(const s of proto.statements.slice(1,5))await client.query(s);
 try{
  if(change)await change();const before=await snapshot(),prepared=kernel.prepare(request(stage,before,restore));
  const text=await kernel.bindCurrent({prepared,snapshot:before,originalSnapshot:restore,context:{synthetic:true},current:syntheticCallback(stage,prepared.plan,{extras,snapshotState:before})});
  const e=JSON.parse(text);if(mutateEnvelope)mutateEnvelope(e);
  await client.query(prepared.statements[5],[JSON.stringify(e)]);
  try{await client.query(prepared.statements[6]);}catch(err){if(!expect||err.code!=="P0001"||err.message!==expect)throw err;a.equal(err.code,"P0001");a.equal(err.message,expect);await rollback();cases.push({name:phase,refused:true,rollback:true});return;}
  if(expect)throw Error("EXPECTED_REFUSAL_MISSING");const after=await snapshot();
  const target=structuredClone(before);if(!stage.startsWith("verify-")){const worker=stage==="switch-to-candidate"?candidate.newWorkerSha256:candidate.oldWorkerSha256;target.deployment.worker_sha256=worker;for(const c of target.controls)c.worker_sha256=worker;for(const c of target.allControls)if([171,172,174].includes(c.campaign_id))c.worker_sha256=worker;}
  equal(after,target);await client.query(prepared.statements[7]);
  if(rollbackSuccess){await rollback();cases.push({name:phase+'-accepted-rollback',accepted:true,rollback:true,onlyOwnedWorkerFieldsChanged:true,acceptedAndHeldLedgerPreserved:true});}
  else{await client.query(prepared.statements[8]);inTx=false;cases.push({name:phase,commitAcknowledged:true,onlyOwnedWorkerFieldsChanged:true,acceptedAndHeldLedgerPreserved:true});}
  return {before,after};
 }finally{if(inTx)await rollback();}
}
async function heartbeat(instance,worker){
 phase="real-original-heartbeat-fixture";await client.query("BEGIN READ WRITE");inTx=true;await client.query("SET LOCAL statement_timeout='5s'");
 try{const r=(await client.query("SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) r",[instance,worker,candidate.runtimeSha256])).rows[0].r;a.equal(r.ready,true);await client.query("COMMIT");inTx=false;return r;}finally{if(inTx)await rollback();}
}
async function expire(){await client.query("UPDATE crm_audience_v2.regular_worker_lease SET heartbeat_at=clock_timestamp()-interval '70 seconds',expires_at=clock_timestamp()-interval '10 seconds'");}
async function main(){
 a.equal(process.env.HELD174_HANDOFF_FIXTURE_ISOLATED,"1");a.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,"1");a.equal(process.env.REGULAR_NATIVE_SOURCE_PROOF,"1");
 a.equal(process.version,"v22.23.3");a.equal(process.getuid(),1000);a.equal(process.platform,"linux");a.equal(process.arch,"x64");a.equal(require("pg/package.json").version,"8.23.1");
 const url=new URL(process.env.HELD174_HANDOFF_FIXTURE_URL||"https://invalid");a.equal(url.protocol,"postgresql:");a.equal(url.hostname,"127.0.0.1");a.equal(url.port,"55432");a.equal(url.pathname,"/listmonk");a.equal(url.username,"postgres");a.equal(url.password,"");a.equal(url.search,"");a.equal(url.hash,"");
 for(const[n,h]of Object.entries(ASSETS)){const f=path.join(__dirname,n);a(!fs.lstatSync(f).isSymbolicLink());a.equal(sha(fs.readFileSync(f)),h);}
 kernel=require("./source/prepare.cjs");candidate={...kernel.FIXED,newWorkerSha256:"a".repeat(64),newImageSha256:"b".repeat(64)};const {Client}=require("pg");client=new Client({connectionString:url.href,options:"-c TimeZone=Etc/UTC",query_timeout:12000});
 try{
  await client.connect();a.deepEqual((await client.query("SELECT current_setting('server_version_num') v,current_database() d,current_setting('TimeZone') z,session_user=current_user r")).rows[0],{v:"170010",d:"listmonk",z:"Etc/UTC",r:true});
  phase="full-original-schema-synthetic-ledger-seed";await require("./fixture.cjs").prepareFixture(client,path.resolve(__dirname,"../.."));
  await client.query(fs.readFileSync(path.join(__dirname,"heartbeat.current-fixture.sql"),"utf8"));
  await heartbeat(oldInstance,candidate.oldWorkerSha256);await expire();originalSnapshot=await snapshot();
  a.equal(originalSnapshot.dispatch.length,3214);a.equal(originalSnapshot.dispatch.filter(x=>x.transport_state==='accepted').length,3213);
  a.equal(originalSnapshot.dispatch.filter(x=>x.transport_state==='outcome_unknown').length,1);a.equal(Object.keys(originalSnapshot.functionMetadata).length,15);
  a.equal(originalSnapshot.legacyPendingRows.length,34);a.equal(originalSnapshot.allFlowPending,34);a.equal(originalSnapshot.permanentExclusion.length,1);a.equal(originalSnapshot.exclusionTriggers.length,2);a.equal(originalSnapshot.campaigns.find(c=>c.id===171).status,'paused');
  await run('switch-to-candidate',{mutateEnvelope:e=>delete e.privateAdmission.purpose,expect:'HELD174_HANDOFF_PRIVATE_ADMISSION_MISMATCH'});
  await run('switch-to-candidate',{mutateEnvelope:e=>e.snapshot.permanentExclusion[0].disposition='NOT_A_DISPOSITION',expect:'HELD174_HANDOFF_SNAPSHOT_DRIFT'});
  await run('switch-to-candidate',{change:()=>client.query('UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=false WHERE campaign_id=171'),expect:'HELD174_HANDOFF_HELD_OR_FUTURE_REFUSED'});
  async function pending(flow,state,piece='SYNTHETIC_OTHER_FLOW'){await client.query(`INSERT INTO public.shrigma_email_dispatch
   SELECT (jsonb_populate_record(NULL::public.shrigma_email_dispatch,to_jsonb(d)||jsonb_build_object(
    'dispatch_id',gen_random_uuid(),'flow',$1::text,'piece',$3::text,'dedupe_key',CASE WHEN $3::text='audience-regular-v1:171'
      THEN jsonb_build_array(171,(SELECT binding_version FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=171),999901)::text ELSE gen_random_uuid()::text END,
    'transport_state',$2::text,'accepted_at',NULL,'outcome_at',CASE WHEN $2::text='outcome_unknown' THEN clock_timestamp() ELSE NULL END,
    'error_code',CASE WHEN $2::text='outcome_unknown' THEN 'NATIVE_REGULAR_OUTCOME_UNKNOWN' ELSE NULL END))).*
   FROM public.shrigma_email_dispatch d WHERE d.dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'`,[flow,state,piece]);}
  await run('switch-to-candidate',{change:()=>pending('transacional','reserved'),expect:'HELD174_HANDOFF_LEGACY_PENDING_REFUSED'});
  await run('switch-to-candidate',{change:()=>pending('transacional','in_flight'),expect:'HELD174_HANDOFF_LEGACY_PENDING_REFUSED'});
  await run('switch-to-candidate',{change:()=>pending('campaign','outcome_unknown','audience-regular-v1:171'),expect:'HELD174_HANDOFF_SCOPE_OR_LEDGER_REFUSED'});
  await run('switch-to-candidate',{change:()=>pending('campaign','in_flight','audience-regular-v1:171'),expect:'HELD174_HANDOFF_LEGACY_PENDING_REFUSED'});
  await run('switch-to-candidate',{change:()=>client.query('UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=acknowledged_sent-1 WHERE campaign_id=171'),expect:'HELD174_HANDOFF_CONTROL_BINDING_REFUSED'});
  await run('switch-to-candidate',{change:()=>client.query('UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_subscriber_id=acknowledged_subscriber_id-1 WHERE campaign_id=171'),expect:'HELD174_HANDOFF_CONTROL_BINDING_REFUSED'});
  await run('switch-to-candidate',{change:async()=>{
   // Construct a second admitted synthetic terminal state without performing a
   // lifecycle transition. Restore the same three real guards before core.
   await client.query('ALTER TABLE public.campaigns DISABLE TRIGGER USER');
   try{await client.query("UPDATE public.campaigns SET status='finished' WHERE id=171");}
   finally{await client.query('ALTER TABLE public.campaigns ENABLE TRIGGER USER');}
  },rollbackSuccess:true});
  await run('switch-to-candidate',{mutateEnvelope:e=>e.privateAdmission.quiescence.legacyIngressCoverage='unknown',expect:'HELD174_HANDOFF_QUIESCENCE_UNPROVED'});
  await run('switch-to-candidate',{mutateEnvelope:e=>e.privateAdmission.quiescence.httpActive=1,expect:'HELD174_HANDOFF_QUIESCENCE_UNPROVED'});
  await run('switch-to-candidate',{change:()=>client.query('UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=false WHERE campaign_id=174'),expect:'HELD174_HANDOFF_HELD_OR_FUTURE_REFUSED'});
  await run('switch-to-candidate',{change:()=>client.query('ALTER TABLE crm_audience_v2.regular_delivery_permanent_exclusion DISABLE TRIGGER regular_permanent_exclusion_no_truncate'),expect:'HELD174_HANDOFF_PERMANENT_OBJECTS_REFUSED'});
  await run('switch-to-candidate',{change:()=>client.query('ALTER FUNCTION crm_audience_v2.regular_delivery_recover(integer,integer,uuid,boolean) RENAME TO synthetic_hidden_recover'),expect:'HELD174_HANDOFF_FUNCTION_PIN_REFUSED'});
  await run('switch-to-candidate',{change:()=>client.query("UPDATE crm_audience_v2.regular_worker_lease SET expires_at=clock_timestamp()+interval '60 seconds'"),expect:'HELD174_HANDOFF_OLD_LEASE_STILL_LIVE'});
  await run('switch-to-candidate',{change:()=>client.query("UPDATE public.shrigma_email_dispatch SET payload_sha256=repeat('9',64) WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE flow='transacional' ORDER BY dispatch_id LIMIT 1)"),expect:'HELD174_HANDOFF_LEGACY_PENDING_REFUSED'});
  await run('switch-to-candidate',{change:()=>client.query("UPDATE public.shrigma_email_dispatch SET started_at=clock_timestamp() WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE flow='transacional' ORDER BY dispatch_id LIMIT 1)"),expect:'HELD174_HANDOFF_LEGACY_PENDING_REFUSED'});
  for(const mutate of [rows=>rows[0].recipient_key='SYNTHETIC_CHANGED',rows=>rows[0].flow='campaign',rows=>rows[0].transport_state='reserved',rows=>rows[0].started_at=new Date().toISOString()])
   await run('switch-to-candidate',{mutateEnvelope:e=>mutate(e.privateAdmission.legacyPendingRows=structuredClone(e.privateAdmission.legacyPendingRows)),expect:'HELD174_HANDOFF_LEGACY_PENDING_REFUSED'});
  equal(await snapshot(),originalSnapshot);
  const switched=await run('switch-to-candidate');stageCommitAt=new Date().toISOString();equal(switched.before,originalSnapshot);
  await run('verify-candidate',{expect:'HELD174_HANDOFF_LEASE_IDENTITY_REFUSED'});
  const returned=await run('return-to-original',{restore:originalSnapshot});equal(returned.after,originalSnapshot);
  await run('switch-to-candidate');stageCommitAt=new Date().toISOString();await heartbeat(newInstance,candidate.newWorkerSha256);
  const live=await snapshot();a.equal(live.lease.instance_id,newInstance);a.equal(live.selectionRuntime.enabled,true);
  await run('verify-candidate');equal(await snapshot(),live);
  async function neverResend(instance,worker){
   phase='exact-excluded-recipient-never-claim';await client.query('BEGIN READ WRITE');inTx=true;await client.query("SET LOCAL statement_timeout='5s'");
   const ctl=(await snapshot()).controls.find(c=>c.campaign_id===174);
   try{await client.query('SELECT crm_audience_v2.regular_delivery_claim_live($1::uuid,174,139874,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9)',[instance,crypto.randomUUID(),worker,candidate.runtimeSha256,ctl.envelope_from,'synthetic@example.invalid','d'.repeat(64),'{}',ctl.configuration_set]);throw Error('EXCLUDED_CLAIM_UNEXPECTEDLY_ACCEPTED');}
   catch(err){a(['P0001','55000'].includes(err.code));await rollback();cases.push({name:phase,excludedNeverResent:true,heldUnknownPreserved:true,refused:true,rollback:true,smtpCalls:0});}
  }
  await neverResend(newInstance,candidate.newWorkerSha256);equal(await snapshot(),live);
  await run('return-to-original',{restore:originalSnapshot,expect:'HELD174_HANDOFF_OLD_LEASE_STILL_LIVE'});equal(await snapshot(),live);
  await expire();const afterExpired=await snapshot();
  await run('return-to-original',{restore:originalSnapshot,mutateEnvelope:e=>e.originalSnapshot.permanentExclusion[0].disposition='REOPEN',expect:'HELD174_HANDOFF_OWN_RETURN_AFTER_DRIFT'});equal(await snapshot(),afterExpired);
  const finalReturn=await run('return-to-original',{restore:originalSnapshot});stageCommitAt=new Date().toISOString();a.equal(finalReturn.after.lease.instance_id,newInstance);
  await heartbeat(returnInstance,candidate.oldWorkerSha256);const originalLive=await snapshot();await run('verify-original');equal(await snapshot(),originalLive);
  await neverResend(returnInstance,candidate.oldWorkerSha256);equal(await snapshot(),originalLive);
  a.equal(originalLive.controls.find(c=>c.campaign_id===174).suspended,true);a.equal(originalLive.campaigns.find(c=>c.id===174).status,'paused');
  equal(originalLive.dispatch,originalSnapshot.dispatch);equal(originalLive.permanentExclusion,originalSnapshot.permanentExclusion);equal(originalLive.functionMetadata,originalSnapshot.functionMetadata);equal(originalLive.legacyPendingRows,originalSnapshot.legacyPendingRows);
  a.equal(cases.length,33);phase='closed';
 }finally{try{if(inTx)await rollback();}finally{try{await client.end();clientEnded=true;}catch{clientEnded=false;}}}
}
main().then(()=>{a(clientEnded&&rollbackConfirmed);const r={schema:"held174-own-runtime-handoff-native-proof-v1",ok:true,caseCount:cases.length,cases,sourcePins:ASSETS,
 node:process.version,uid:process.getuid(),postgresVersion:"17.10",pgVersion:"8.23.1",synthetic:true,acceptedFixtureCount:3213,heldUnknownFixtureCount:1,permanentExclusionFixtureCount:1,permanentExclusionPreserved:true,historicalPendingFixtureCount:34,historicalPendingPreserved:true,legacyDrainObserved:false,legacyDrainEvidenceIsSyntheticOnly:true,
 originalCalls:0,originalWrites:0,smtpCalls:0,nativeWorkerExecuted:false,originalAuthorityAccepted:false,originalRuntimeMeasured:false,
 clientEndConfirmed:clientEnded,rollbackConfirmed,fixtureServerEnded:false,operational:false};
 const f=process.env.HELD174_HANDOFF_FIXTURE_RECEIPT;a(f&&path.isAbsolute(f)&&!fs.existsSync(f));fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n",{flag:"wx",mode:0o644});fs.chmodSync(f,0o644);
 console.log(JSON.stringify({schema:r.schema,ok:true,caseCount:r.caseCount,clientEndConfirmed:true,originalCalls:0,operational:false}));
}).catch(e=>{
 const sqlstate=typeof e.code==="string"&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null;
 const refusal=typeof e.message==="string"&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:null;
 const pos=typeof e.position==="string"&&/^[1-9][0-9]{0,6}$/.test(e.position)?Number(e.position):null;
 const r={schema:"held174-own-runtime-handoff-native-proof-v1",ok:false,phase,sqlstate,
  errorClass:sqlstate==="42601"?"SQL_SYNTAX_REFUSED":sqlstate?"SQL_REFUSED":e.code==="ERR_ASSERTION"?"ASSERTION_REFUSED":"PROOF_REFUSED",
  refusalCode:refusal,statementPosition:pos,caseCount:cases.length,cases,sourcePins:ASSETS,
  node:process.version,uid:typeof process.getuid==="function"?process.getuid():null,
  postgresVersionExpected:"17.10",pgVersionExpected:"8.23.1",synthetic:true,
  clientEndConfirmed:clientEnded,rollbackConfirmed,fixtureServerEnded:false,
  originalCalls:0,originalWrites:0,smtpCalls:0,nativeWorkerExecuted:false,
  originalAuthorityAccepted:false,originalRuntimeMeasured:false,operational:false};
 let receiptWritten=false;const f=process.env.HELD174_HANDOFF_FIXTURE_RECEIPT;
 // Failure evidence is synthetic/closed. Never overwrite a receipt, emit SQL,
 // free error text, a snapshot or any original parameter.
 if(clientEnded&&process.env.HELD174_HANDOFF_FIXTURE_ISOLATED==="1"&&f&&path.isAbsolute(f)&&!fs.existsSync(f)){
  try{fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n",{flag:"wx",mode:0o644});fs.chmodSync(f,0o644);receiptWritten=true;}catch{}
 }
 console.log(JSON.stringify({...r,receiptWritten}));process.exitCode=1;
});
