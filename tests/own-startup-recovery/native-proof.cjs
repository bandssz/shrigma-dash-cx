"use strict";
// SOURCE-only prepared harness. Root invokes in its EXISTING disposable PG17.10
// full-schema fixture AFTER prepare, BEFORE activate/any worker/SMTP. No server/DB is created here.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),a=require("node:assert/strict");
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const SOURCE_PINS = Object.freeze({
  "prepare.cjs": "1872676ea62c2da6cb11f917023270618d3f244d2a7f86b57d911009e39a171e",
  "recovery.atomic.sql.in": "ba200613101d9cf86e398a082b218b129d903d97c908048e935433c8bb3156c2",
  "snapshot.private-read.sql": "8e832e93a53eef8d9f11fbd6680cca89a9e7c2bf155b01043c271bbd8cf5b674",
  "PUBLIC-FUNCTION-PINS.json": "f84844815cb3cd8812b0eb8b968d8716a559e5c008bf20de1018862c0721856f"
});
const EXTRA_GUARDS_SHA="53ee6e4d2aef2128a05a0bc719473a7e5a91ae7a93ab0b34b3326fcb9ec7e1c1";
const CASES=[];let phase="boundary",inTx=false,client,ended=false,rollbackConfirmed=true;
let kernel,src,db,baseline,firstAcknowledgedAt;
function equal(x,y){a.ok(JSON.stringify(x)===JSON.stringify(y),"Synthetic state mismatch");}
function request(stage){
 const refs={};let i=0;
 for(const n of ["admission","snapshot","restore","quiescence","binding"])
  refs[n]={reference:`33333333-3333-3333-3333-${String(++i).padStart(12,"0")}`,sha256:sha("synthetic-only:"+stage+":"+n)};
 return {stage,operationId:crypto.randomUUID(),candidate:{oldWorkerSha256:"a".repeat(64),newWorkerSha256:kernel.NEW_WORKER_SHA256,
  runtimeSha256:kernel.RUNTIME_SHA256,querySha256:kernel.QUERY_SHA256,kernelSha256:kernel.KERNEL_SHA256,imageSha256:kernel.IMAGE_SHA256},privateReferences:refs};
}
function admission(plan,extras={}){return {operationId:plan.operationId,stage:plan.stage,purpose:plan.admissionPurpose,candidate:plan.candidate,
 admissionSha256:plan.privateReferences.admission.sha256,snapshotSha256:plan.privateReferences.snapshot.sha256,
 restoreSha256:plan.privateReferences.restore.sha256,quiescenceSha256:plan.privateReferences.quiescence.sha256,
 bindingSha256:plan.privateReferences.binding.sha256,actor:"synthetic-fixture-only-no-original-authority",
 checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),...extras};}
async function snapshot(){return (await db.query(src.snapshotReadSQL)).rows[0].jsonb_build_object;}
async function rollback(){try{await db.query("ROLLBACK");inTx=false;}catch{rollbackConfirmed=false;throw Error("FIXTURE_ROLLBACK_NOT_CONFIRMED");}}
async function begin(){await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");inTx=true;for(const s of src.statements.slice(1,5))await db.query(s);}
async function run(stage,{change,expect,originalSnapshot,extras,mutateAdmission,mutateSnapshot}={}){
 phase=stage+(expect?"-refusal":"-accepted");const p=kernel.prepare(request(stage));
 await begin();if(change)await change();const before=await snapshot();const ad=admission(p.plan,extras);if(mutateAdmission)mutateAdmission(ad);
 if(mutateSnapshot)mutateSnapshot(before);const env={plan:p.plan,snapshot:before,privateAdmission:ad,...(originalSnapshot?{originalSnapshot}:{})};
 await db.query(p.statements[5],[JSON.stringify(env)]);
 try {await db.query(p.statements[6]);}
 catch(e){if(!expect){await rollback();throw e;}a.equal(e.code,"P0001");a.equal(e.message,expect);await rollback();CASES.push({stage,kind:"refusal",code:expect,rollback:true});return;}
 if(expect){await rollback();throw Error("FIXTURE_EXPECTED_REFUSAL_MISSING");}
 const after=await snapshot();await db.query(p.statements[7]);await db.query(p.statements[8]);inTx=false;
 CASES.push({stage,kind:"accepted",commitAcknowledged:true});return {before,after};
}
function stageOneTarget(before){const target=structuredClone(before);target.deployment.worker_sha256=kernel.NEW_WORKER_SHA256;
 for(const c of target.controls){c.worker_sha256=kernel.NEW_WORKER_SHA256;if([171,174].includes(c.campaign_id))c.suspended=false;}
 target.lease.suspended=false;target.lease.suspension_reason=null;return target;}
async function seed(){
 a.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign")).rows[0].n,0,"Full fixture must be BEFORE activate");
 a.equal((await db.query("SELECT count(*)::int n FROM campaigns WHERE id=ANY(ARRAY[171,172,173,174])")).rows[0].n,0,"New synthetic IDs required");
 a.equal((await db.query("SELECT count(*)::int n FROM public.shrigma_email_dispatch")).rows[0].n,0,"No synthetic attempt yet");
 // Only new synthetic rows in the existing tables: no DDL, stub, function rewrite or grant.
 await db.query(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object(
  'id',n,'uuid',gen_random_uuid(),'name','Own recovery synthetic '||n,'status',CASE WHEN n=172 THEN 'scheduled' ELSE 'paused' END,
  'send_at',CASE WHEN n=172 THEN clock_timestamp()+interval '2 days' ELSE clock_timestamp()-interval '1 minute' END,
  'started_at',CASE WHEN n=174 THEN clock_timestamp()-interval '2 minutes' ELSE NULL END,
  'to_send',CASE WHEN n=174 THEN 8 ELSE 0 END,'max_subscriber_id',CASE WHEN n=174 THEN 8 ELSE 0 END))).*
  FROM campaigns c CROSS JOIN unnest(ARRAY[171,172,174]) n WHERE c.id=100`);
 await db.query(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object(
  'id',173,'uuid',gen_random_uuid(),'name','Own recovery legacy synthetic','send_at',clock_timestamp()+interval '2 days'))).* FROM campaigns c WHERE id=300`);
 await db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) SELECT n,17,'Synthetic Fish' FROM unnest(ARRAY[171,172,174]) n; INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(173,40,'Synthetic legacy')");
 const H=require(path.join(process.env.OWN_RECOVERY_REPO_ROOT||path.resolve(__dirname,"../.."),"n8n/growth/segment-audience-review.cjs"));
 const old=(await db.query("SELECT * FROM crm_audience_v2.campaign_binding WHERE campaign_id=100")).rows[0];a(old);
 for(const id of [171,172,174]){
  const version=(await db.query("SELECT public.shrigma_campaign_current($1) v",[id])).rows[0].v.version;
  const binding={...old.binding,campaign_id:id,campaign_version:version},hash=H.digest(binding);
  await db.query(`INSERT INTO crm_audience_v2.campaign_binding(campaign_id,brand,binding_version,campaign_version,audience_id,audience_revision,
   definition_hash,context_hash,base_list_id,catalog_hash,binding,binding_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
   [id,old.brand,old.binding_version,version,old.audience_id,old.audience_revision,old.definition_hash,old.context_hash,old.base_list_id,old.catalog_hash,JSON.stringify(binding),hash]);
  await db.query("INSERT INTO crm_audience_v2.campaign_binding_revision VALUES($1,$2,$3::jsonb,$4)",[id,old.binding_version,JSON.stringify(binding),hash]);
 }
 await db.query(`INSERT INTO crm_audience_v2.regular_delivery_campaign(campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,
  envelope_from,account_id,region,configuration_set,enabled,suspended) SELECT c.id,b.binding_version,b.binding_hash,
  crm_audience_v2.regular_delivery_material(c.id),$1,$2,'contato@fishermans.com.br','000000000000','native-fixture','native-fixture',true,c.id<>172
  FROM campaigns c JOIN LATERAL crm_audience_v2.campaign_binding_effective(c.id) b ON true WHERE c.id IN(171,172,174)`,["a".repeat(64),kernel.RUNTIME_SHA256]);
 await db.query(`UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,worker_sha256=$1,runtime_sha256=$2,query_sha256=$3,
  database_role=session_user,approved_at=clock_timestamp()-interval '1 minute',approved_by='synthetic-own-recovery-fixture',topology_receipt_sha256=$4 WHERE singleton`,
  ["a".repeat(64),kernel.RUNTIME_SHA256,kernel.QUERY_SHA256,"f".repeat(64)]);
 await db.query(`INSERT INTO crm_audience_v2.regular_worker_lease(singleton,instance_id,worker_sha256,runtime_sha256,database_role,heartbeat_at,expires_at,suspended,suspension_reason)
  VALUES(true,'44444444-4444-4444-4444-444444444444',$1,$2,session_user,clock_timestamp()-interval '120 seconds',clock_timestamp()-interval '60 seconds',true,'competing_instance')`,["a".repeat(64),kernel.RUNTIME_SHA256]);
 await db.query("UPDATE crm_audience_v2.selection_runtime SET enabled=false");
 await db.query(`INSERT INTO crm_audience_v2.regular_sender_policy(brand,envelope_from,account_id,region,configuration_set,enabled)
  VALUES('fish','contato@fishermans.com.br','000000000000','native-fixture','native-fixture',true),
  ('aristo','contato@oaristocrata.com','000000000000','native-fixture','native-fixture',true)
  ON CONFLICT(brand) DO UPDATE SET enabled=true`);
 const extra=fs.readFileSync(path.join(__dirname,"fixture-extra-guards.sql"));a.equal(sha(extra),EXTRA_GUARDS_SHA);
 await db.query(extra.toString("utf8"));
 const guards=(await db.query("SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='public.campaigns'::regclass")).rows[0].n;
 a.equal(guards,3,"Exactly3 original public guards required in fixture");
}
async function main(){
 a.equal(process.env.OWN_RECOVERY_FIXTURE_ISOLATED,"1");a.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,"1");a.equal(process.env.REGULAR_NATIVE_SOURCE_PROOF,"1");
 a.equal(process.version,"v22.23.3");a.equal(process.platform,"linux");a.equal(process.arch,"x64");a.equal(process.getuid(),1000);
 const u=new URL(process.env.OWN_RECOVERY_FIXTURE_URL||"http://invalid");a.equal(u.protocol,"postgresql:");a.equal(u.hostname,"127.0.0.1");a.equal(u.pathname,"/listmonk");
 a(u.port&&u.port!=="5432");a.equal(u.username,"postgres");a.equal(u.password,"");a.equal(u.search,"");a.equal(u.hash,"");
 const dir=process.env.OWN_RECOVERY_SOURCE_DIR;a(dir&&path.isAbsolute(dir)&&!fs.lstatSync(dir).isSymbolicLink());
 for(const [name,expected] of Object.entries(SOURCE_PINS)){const target=path.join(dir,name);a(!fs.lstatSync(target).isSymbolicLink());a.equal(sha(fs.readFileSync(target)),expected);}
 kernel=require(path.join(dir,"prepare.cjs"));src=kernel.prepare(request("repair-identity"));
 if(process.env.OWN_RECOVERY_REPO_ROOT)a(path.isAbsolute(process.env.OWN_RECOVERY_REPO_ROOT));a.equal(require("pg/package.json").version,"8.23.1");
 const {Client}=require("pg");client=new Client({connectionString:u.href,options:"-c TimeZone=Etc/UTC",statement_timeout:5000,lock_timeout:500});db={query:(s,p)=>client.query(s,p)};
 try {
  phase="fixture-connect";await client.connect();
  const boundary=(await db.query("SELECT current_setting('server_version_num')::integer v,current_database() d,current_setting('TimeZone') tz,session_user=current_user AS role")).rows[0];
  a.equal(boundary.v,170010);a.equal(boundary.d,"listmonk");a.equal(boundary.tz,"Etc/UTC");a.equal(boundary.role,true);
  phase="synthetic-seed";await seed();baseline=await snapshot();
  await run("repair-identity",{mutateAdmission:x=>delete x.purpose,expect:"OWN_RECOVERY_PRIVATE_ADMISSION_MISMATCH"});equal(await snapshot(),baseline);
  await run("repair-identity",{change:()=>db.query("UPDATE crm_audience_v2.regular_worker_lease SET expires_at=clock_timestamp()+interval '1 minute'"),expect:"OWN_RECOVERY_LEASE_OR_PAUSE_REFUSED"});equal(await snapshot(),baseline);
  await run("repair-identity",{change:()=>db.query("UPDATE crm_audience_v2.regular_worker_lease SET suspension_reason='identity_changed'"),expect:"OWN_RECOVERY_COLLISION_SCOPE_REFUSED"});equal(await snapshot(),baseline);
  await run("repair-identity",{change:()=>db.query("UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=1 WHERE campaign_id=174"),expect:"OWN_RECOVERY_CONTROL_BINDING_MATERIAL_REFUSED"});equal(await snapshot(),baseline);
  await run("repair-identity",{change:()=>db.query("UPDATE crm_audience_v2.regular_delivery_campaign SET material='{}'::jsonb WHERE campaign_id=174"),expect:"OWN_RECOVERY_CONTROL_BINDING_MATERIAL_REFUSED"});equal(await snapshot(),baseline);
  await run("repair-identity",{change:()=>db.query("INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,transport_state) VALUES('55555555-5555-5555-5555-555555555555','fish','campaign','audience-regular-v1:174','outcome_unknown')"),expect:"OWN_RECOVERY_SCOPE_OR_ATTEMPT_REFUSED"});equal(await snapshot(),baseline);
  await run("repair-identity",{change:()=>db.query("ALTER TABLE public.campaigns DISABLE TRIGGER shrigma_audience_campaign_send_guard_v1"),expect:"OWN_RECOVERY_TRIGGER_OR_AB_REFUSED"});equal(await snapshot(),baseline);
  await run("repair-identity",{mutateSnapshot:x=>x.campaigns[0].body="synthetic snapshot drift",expect:"OWN_RECOVERY_SNAPSHOT_DRIFT"});equal(await snapshot(),baseline);
  const first=await run("repair-identity");equal(first.before,baseline);equal(first.after,stageOneTarget(baseline));
  await run("resume-after-heartbeat",{extras:{identityCommitAcknowledgedAt:new Date().toISOString(),priorLeaseInstanceId:baseline.lease.instance_id},expect:"OWN_RECOVERY_REAL_HEARTBEAT_REQUIRED"});equal(await snapshot(),first.after);
  const restored=await run("restore-before-heartbeat",{originalSnapshot:baseline});equal(restored.after,baseline);
  const repaired=await run("repair-identity");equal(repaired.after,first.after);firstAcknowledgedAt=new Date().toISOString();
  phase="original-heartbeat-function-in-fixture";await begin();
  const hb=(await db.query("SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) heartbeat",
   ["66666666-6666-6666-6666-666666666666",kernel.NEW_WORKER_SHA256,kernel.RUNTIME_SHA256])).rows[0].heartbeat;
  a.equal(hb.ready,true);await db.query("COMMIT");inTx=false;
  CASES.push({stage:"original-heartbeat-function-in-fixture",kind:"accepted",commitAcknowledged:true,syntheticFunctionInvocationOnly:true});
  const live=await snapshot();a.notEqual(live.lease.instance_id,baseline.lease.instance_id);a.equal(live.lease.worker_sha256,kernel.NEW_WORKER_SHA256);
  a.equal(live.selectionRuntime.enabled,true);a.equal(live.selectionRuntime.candidate_query_sha256,kernel.QUERY_SHA256);
  await run("restore-before-heartbeat",{originalSnapshot:baseline,expect:"OWN_RECOVERY_LEASE_OR_PAUSE_REFUSED"});equal(await snapshot(),live);
  const handoff={identityCommitAcknowledgedAt:firstAcknowledgedAt,priorLeaseInstanceId:baseline.lease.instance_id};
  await run("resume-after-heartbeat",{extras:handoff,change:()=>db.query("UPDATE crm_audience_v2.selection_runtime SET verified_at=clock_timestamp()-interval '10 minutes'"),expect:"OWN_RECOVERY_REAL_HEARTBEAT_REQUIRED"});equal(await snapshot(),live);
  const resumed=await run("resume-after-heartbeat",{extras:handoff});
  const target=structuredClone(live);for(const c of target.campaigns)if([171,174].includes(c.id))c.status="scheduled";
  equal(resumed.after,target);a.equal(CASES.length,16);
  phase="closed";
 } finally {
  try {if(inTx)await rollback();} finally {try{await client.end();ended=true;}catch{ended=false;}}
 }
}
main().then(()=>{
 a.equal(ended,true);a.equal(rollbackConfirmed,true);
 const report={schema:"own-recovery-native-sql-proof-v1",status:"CLIENT_ENDED_FIXTURE_SERVER_END_PENDING",cases:CASES,
  kernelSourcePins:SOURCE_PINS,kernelAssetPins:kernel.ASSETS,nodeVersion:process.version,uid:process.getuid(),postgresVersion:"17.10",pgVersion:"8.23.1",
  synthetic:true,originalCalls:0,originalOperational:false,originalAuthorityAccepted:false,nativeWorkerExecuted:false,originalHeartbeatFunctionInvokedOnlyInFixture:true,
  sqlGuardScenariosPassed:true,clientsEnded:ended,rollbackConfirmed,fixtureServerEnded:false};
 const file=process.env.OWN_RECOVERY_FIXTURE_RECEIPT;a(file&&path.isAbsolute(file)&&!fs.existsSync(file));
 fs.writeFileSync(file,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
 process.stdout.write(JSON.stringify({schema:report.schema,status:report.status,cases:CASES.length,sqlGuardScenariosPassed:true,clientsEnded:true,originalCalls:0})+"\n");
}).catch(e=>{
 const report={schema:"own-recovery-native-sql-proof-v1",status:"REFUSED_OR_UNCERTAIN",phase,sqlstate:typeof e.code==="string"&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null,
  cases:CASES,clientsEnded:ended,rollbackConfirmed,originalCalls:0,originalOperational:false,originalAuthorityAccepted:false};
 process.stdout.write(JSON.stringify(report)+"\n");process.exitCode=1;
});
