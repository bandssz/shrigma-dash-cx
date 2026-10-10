"use strict";
// Real PG17.10 functions/guards with synthetic accepted history, no original/SMTP/worker.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),a=require("node:assert/strict");
const SOURCE_PINS=Object.freeze({
  "prepare.cjs": "90c291759a023863ec622238975f5c6a87998416cfea0a63a6eedd1f7e178cb3",
  "resume.atomic.sql.in": "c3ebe81adee5abba8c00c1fed6fbb7f3d8453e03b82c1e8aafd3182072b7015d",
  "snapshot.private-read.sql": "8e832e93a53eef8d9f11fbd6680cca89a9e7c2bf155b01043c271bbd8cf5b674",
  "PUBLIC-FUNCTION-PINS.json": "f84844815cb3cd8812b0eb8b968d8716a559e5c008bf20de1018862c0721856f"
});
const HEARTBEAT_PREPARE_SHA="e1e45367ab8eea1f0ca629ea6785bb392a4f8df33d77745d3caf07de2d7366bc";
const EXTRA_GUARDS_SHA="53ee6e4d2aef2128a05a0bc719473a7e5a91ae7a93ab0b34b3326fcb9ec7e1c1";
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const INSTANCE="77777777-7777-4777-8777-777777777777";
let phase="boundary",client,db,kernel,src,inTx=false,ended=false,rollbackConfirmed=true;const cases=[];
const equal=(x,y)=>a.equal(JSON.stringify(x),JSON.stringify(y));
function request(campaignId){const refs={};for(const n of ["admission","snapshot","quiescence","binding","disposition"])refs[n]={reference:crypto.randomUUID(),sha256:sha("synthetic-only:"+n)};return {campaignId,operationId:crypto.randomUUID(),candidate:{...kernel.CANDIDATE},privateReferences:refs};}
function admission(p){return {operationId:p.operationId,purpose:p.admissionPurpose,campaignId:String(p.campaignId),candidate:p.candidate,admissionSha256:p.privateReferences.admission.sha256,snapshotSha256:p.privateReferences.snapshot.sha256,quiescenceSha256:p.privateReferences.quiescence.sha256,bindingSha256:p.privateReferences.binding.sha256,dispositionSha256:p.privateReferences.disposition.sha256,actor:"synthetic-fixture-only-no-original-authority",checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString()};}
async function snapshot(){return (await db.query(src.snapshotReadSQL)).rows[0].jsonb_build_object;}
async function rb(){try{await db.query("ROLLBACK");inTx=false;}catch{rollbackConfirmed=false;throw Error("FIXTURE_ROLLBACK_NOT_CONFIRMED");}}
async function begin(p){await db.query(p.statements[0]);inTx=true;for(const s of p.statements.slice(1,5))await db.query(s);}
async function run(cid,{change,expect,sqlstate,mutateAdmission,mutateSnapshot}={}){
 phase="resume-"+cid+(expect||sqlstate?"-refusal":"-accepted");const p=kernel.prepare(request(cid));await begin(p);
 try{if(change)await change();const before=await snapshot(),ad=admission(p.plan);if(mutateAdmission)mutateAdmission(ad);if(mutateSnapshot)mutateSnapshot(before);
  await db.query(p.statements[5],[JSON.stringify({plan:p.plan,snapshot:before,privateAdmission:ad})]);
  try{await db.query(p.statements[6]);}catch(e){if(!expect&&!sqlstate)throw e;a.equal(e.code,sqlstate||"P0001");if(expect)a.equal(e.message,expect);await rb();cases.push({name:phase,refused:true,rollback:true});return;}
  if(expect||sqlstate)throw Error("EXPECTED_REFUSAL_MISSING");const after=await snapshot();await db.query(p.statements[7]);await db.query(p.statements[8]);inTx=false;
  const target=structuredClone(before);target.controls.find(c=>c.campaign_id===cid).suspended=false;target.campaigns.find(c=>c.id===cid).status="scheduled";equal(after,target);
  cases.push({name:phase,commitAcknowledged:true,acceptedLedgerAndAllProgressPreserved:true,selectedCampaignOnly:true});return {before,after};
 }finally{if(inTx)await rb();}
}
async function seed(){
 a.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign")).rows[0].n,0,"Full fixture must be BEFORE activate");
 a.equal((await db.query("SELECT count(*)::int n FROM campaigns WHERE id=ANY(ARRAY[171,172,173,174])")).rows[0].n,0,"New synthetic IDs required");
 a.equal((await db.query("SELECT count(*)::int n FROM public.shrigma_email_dispatch")).rows[0].n,0,"No synthetic attempt yet");
 // Only new synthetic rows in the existing tables: no DDL, stub, function rewrite or grant.
 await db.query(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object(
  'id',n,'uuid',gen_random_uuid(),'name','Own recovery synthetic '||n,'status',CASE WHEN n=172 THEN 'scheduled' ELSE 'paused' END,
  'send_at',CASE WHEN n=172 THEN clock_timestamp()+interval '2 days' ELSE clock_timestamp()-interval '1 minute' END,
  'started_at',CASE WHEN n IN(171,174) THEN clock_timestamp()-interval '2 minutes' ELSE NULL END,'sent',CASE WHEN n=171 THEN 15 WHEN n=174 THEN 18 ELSE 0 END,'last_subscriber_id',CASE WHEN n=171 THEN 146 WHEN n=174 THEN 1977 ELSE 0 END,
  'to_send',CASE WHEN n IN(171,174) THEN 50 ELSE 0 END,'max_subscriber_id',CASE WHEN n IN(171,174) THEN 3000 ELSE 0 END))).*
  FROM campaigns c CROSS JOIN unnest(ARRAY[171,172,174]) n WHERE c.id=100`);
 await db.query(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object(
  'id',173,'uuid',gen_random_uuid(),'name','Own recovery legacy synthetic','send_at',clock_timestamp()+interval '2 days'))).* FROM campaigns c WHERE id=300`);
 await db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) SELECT n,17,'Synthetic Fish' FROM unnest(ARRAY[171,172,174]) n; INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(173,40,'Synthetic legacy')");
 const H=require(path.join(process.env.ACCEPTED_RESUME_REPO_ROOT||path.resolve(__dirname,"../.."),"n8n/growth/segment-audience-review.cjs"));
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
  FROM campaigns c JOIN LATERAL crm_audience_v2.campaign_binding_effective(c.id) b ON true WHERE c.id IN(171,172,174)`,[kernel.CANDIDATE.workerSha256,kernel.CANDIDATE.runtimeSha256]);
 await db.query(`UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,worker_sha256=$1,runtime_sha256=$2,query_sha256=$3,
  database_role=session_user,approved_at=clock_timestamp()-interval '1 minute',approved_by='synthetic-own-recovery-fixture',topology_receipt_sha256=$4 WHERE singleton`,
  [kernel.CANDIDATE.workerSha256,kernel.CANDIDATE.runtimeSha256,kernel.CANDIDATE.querySha256,"f".repeat(64)]);
 await db.query("UPDATE crm_audience_v2.selection_runtime SET enabled=false");
 await db.query(`INSERT INTO crm_audience_v2.regular_sender_policy(brand,envelope_from,account_id,region,configuration_set,enabled)
  VALUES('fish','contato@fishermans.com.br','000000000000','native-fixture','native-fixture',true),
  ('aristo','contato@oaristocrata.com','000000000000','native-fixture','native-fixture',true)
  ON CONFLICT(brand) DO UPDATE SET enabled=true`);
 const extra=fs.readFileSync(path.join(__dirname,"fixture-extra-guards.sql"));a.equal(sha(extra),EXTRA_GUARDS_SHA);
 await db.query(extra.toString("utf8"));
 const guards=(await db.query("SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='public.campaigns'::regclass")).rows[0].n;
 a.equal(guards,3,"Exactly3 original public guards required in fixture");
 await db.query(`UPDATE crm_audience_v2.regular_delivery_campaign r SET acknowledged_sent=c.sent,acknowledged_subscriber_id=c.last_subscriber_id FROM campaigns c WHERE c.id=r.campaign_id AND c.id IN(171,174)`);
 await db.query(`INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token,outcome_at,accepted_at)
  SELECT gen_random_uuid(),b.brand,'campaign','audience-regular-v1:'||c.id::text,jsonb_build_array(c.id,b.binding_version,CASE WHEN n=c.sent THEN c.last_subscriber_id ELSE n END)::text,
   repeat('d',64),'000000000000','native-fixture','native-fixture','synthetic-no-customer:'||c.id::text||':'||n::text,'fixture-only-v1',false,'accepted',clock_timestamp()-interval '2 minutes',gen_random_uuid(),clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute'
  FROM campaigns c JOIN crm_audience_v2.campaign_binding b ON b.campaign_id=c.id CROSS JOIN LATERAL generate_series(1,c.sent) n WHERE c.id IN(171,174)`);
 a.equal((await db.query("SELECT count(*)::int n FROM public.shrigma_email_dispatch WHERE transport_state='accepted'")).rows[0].n,33);

}
async function main(){
 a.equal(process.env.ACCEPTED_RESUME_FIXTURE_ISOLATED,"1");a.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,"1");a.equal(process.env.REGULAR_NATIVE_SOURCE_PROOF,"1");
 a.equal(process.version,"v22.23.3");a.equal(process.platform,"linux");a.equal(process.arch,"x64");a.equal(process.getuid(),1000);a.equal(require("pg/package.json").version,"8.23.1");
 const u=new URL(process.env.ACCEPTED_RESUME_FIXTURE_URL||"https://invalid");a.equal(u.protocol,"postgresql:");a.equal(u.hostname,"127.0.0.1");a.equal(u.pathname,"/listmonk");a(u.port&&u.port!=="5432");a.equal(u.username,"postgres");a.equal(u.password,"");a.equal(u.search,"");a.equal(u.hash,"");
 const dir=process.env.ACCEPTED_RESUME_SOURCE_DIR;a(dir&&path.isAbsolute(dir)&&!fs.lstatSync(dir).isSymbolicLink());
 for(const[n,h]of Object.entries(SOURCE_PINS)){const f=path.join(dir,n);a(!fs.lstatSync(f).isSymbolicLink());a.equal(sha(fs.readFileSync(f)),h);}
 const hbDir=process.env.ACCEPTED_RESUME_HEARTBEAT_SOURCE_DIR||path.resolve(__dirname,"../source");a(path.isAbsolute(hbDir));const hbPrepare=path.join(hbDir,"prepare.cjs");a(!fs.lstatSync(hbPrepare).isSymbolicLink());a.equal(sha(fs.readFileSync(hbPrepare)),HEARTBEAT_PREPARE_SHA);
 const heartbeatSource=require(hbPrepare);kernel=require(path.join(dir,"prepare.cjs"));src=kernel.prepare(request(174));
 const{Client}=require("pg");client=new Client({connectionString:u.href,options:"-c TimeZone=Etc/UTC",query_timeout:12000});db={query:(s,p)=>client.query(s,p)};
 try{await client.connect();const b=(await db.query("SELECT current_setting('server_version_num') v,current_database() d,current_setting('TimeZone') tz,session_user=current_user AS same")).rows[0];a.deepEqual(b,{v:"170010",d:"listmonk",tz:"Etc/UTC",same:true});
  phase="synthetic-seed";a.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.regular_worker_lease")).rows[0].n,0);await seed();
  phase="real-function-2s";const hp=heartbeatSource.prepare("apply"),hm=(await db.query(hp.snapshotReadSQL)).rows[0].function_metadata;
  for(let i=0;i<hp.statements.length;i++){if(i===0){await db.query(hp.statements[i]);inTx=true;}else if(i===4)await db.query(hp.statements[i],[JSON.stringify({schema:"heartbeat-lock-2s-expected-v1",stage:"apply",functionMetadata:hm})]);else await db.query(hp.statements[i]);}inTx=false;
  await begin(src);const hb=(await db.query("SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) h",[INSTANCE,kernel.CANDIDATE.workerSha256,kernel.CANDIDATE.runtimeSha256])).rows[0].h;a.equal(hb.ready,true);a.equal(hb.instance_id,INSTANCE);await db.query("COMMIT");inTx=false;
  const baseline=await snapshot();a.equal(baseline.lease.instance_id,INSTANCE);a.equal(baseline.lease.suspended,false);a.equal(baseline.dispatch.length,33);a.equal(baseline.campaignGuard.length,3);a.deepEqual(baseline.functionMetadata["crm_audience_v2.regular_worker_heartbeat(uuid,text,text)"].proconfig,["search_path=pg_catalog","lock_timeout=2s"]);
  cases.push({name:"genuine-heartbeat-2s-and-accepted-ledger",actualHeartbeatFunction:true,acceptedFixtureCount:33,threeOriginalGuards:true});
  await run(174,{mutateAdmission:x=>delete x.purpose,expect:"ACCEPTED_RESUME_PRIVATE_ADMISSION_MISMATCH"});equal(await snapshot(),baseline);
  await run(174,{mutateSnapshot:x=>x.campaigns[0].sent++,expect:"ACCEPTED_RESUME_SNAPSHOT_DRIFT"});equal(await snapshot(),baseline);
  await run(174,{change:()=>db.query("UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=19 WHERE campaign_id=174"),sqlstate:"P0002"});equal(await snapshot(),baseline);
  await run(174,{change:()=>db.query("UPDATE public.shrigma_email_dispatch SET transport_state='outcome_unknown' WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:174' LIMIT 1)"),expect:"ACCEPTED_RESUME_LEDGER_REFUSED"});equal(await snapshot(),baseline);
  await run(174,{change:()=>db.query("UPDATE public.shrigma_email_dispatch SET dedupe_key='[174,1,1]' WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:174' ORDER BY dedupe_key DESC LIMIT 1)"),expect:"ACCEPTED_RESUME_LEDGER_REFUSED"});equal(await snapshot(),baseline);
  await run(174,{change:()=>db.query("UPDATE crm_audience_v2.regular_worker_lease SET heartbeat_at=clock_timestamp()-interval '70 seconds',expires_at=clock_timestamp()-interval '10 seconds'"),expect:"ACCEPTED_RESUME_REAL_HEARTBEAT_REQUIRED"});equal(await snapshot(),baseline);
  await run(174,{change:()=>db.query("UPDATE crm_audience_v2.regular_delivery_campaign SET material='{}'::jsonb WHERE campaign_id=174"),sqlstate:"P0002"});equal(await snapshot(),baseline);
  const resumed=await run(174);a.equal(resumed.after.campaigns.find(c=>c.id===171).status,"paused");
  phase="accepted-dedupe-never-new-claim";await begin(src);await db.query("UPDATE campaigns SET status='running' WHERE id=174");const beforeClaim=await snapshot();
  const ctl=beforeClaim.controls.find(c=>c.campaign_id===174);const claim=(await db.query("SELECT crm_audience_v2.regular_delivery_claim_live($1::uuid,174,1,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9) result",[INSTANCE,crypto.randomUUID(),kernel.CANDIDATE.workerSha256,kernel.CANDIDATE.runtimeSha256,ctl.envelope_from,"synthetic@example.invalid","d".repeat(64),"{}",ctl.configuration_set])).rows[0].result;
  a.equal(claim.should_send,false);a.equal(claim.reason,"accepted");a.equal(claim.claim_token,null);equal(await snapshot(),beforeClaim);
  const accepted=beforeClaim.dispatch.find(d=>d.dispatch_id===claim.dispatch_id);a(accepted);await db.query("SELECT crm_audience_v2.regular_delivery_finish(174,1,$1::uuid,$2::uuid,'accepted')",[accepted.dispatch_id,accepted.claim_token]);equal(await snapshot(),beforeClaim);await rb();equal(await snapshot(),resumed.after);
  cases.push({name:phase,realClaimAndFinishFunctions:true,shouldSend:false,existingAcceptedNotRepeated:true,rollback:true,smtpCalls:0});
  await run(171,{expect:"ACCEPTED_RESUME_SEQUENTIAL_SCOPE_REFUSED"});equal(await snapshot(),resumed.after);
  // Genuine original halt trigger: other incident becomes paused again, no progress rewind.
  await db.query("UPDATE campaigns SET status='paused' WHERE id=174");const halted=await snapshot();a.equal(halted.controls.find(c=>c.campaign_id===174).suspended,true);
  const second=await run(171);a.equal(second.after.campaigns.find(c=>c.id===174).status,"paused");a.equal(second.after.dispatch.length,33);a.equal(cases.length,12);phase="closed";
 }finally{try{if(inTx)await rb();}finally{try{await client.end();ended=true;}catch{ended=false;}}}
}
main().then(()=>{a.equal(ended,true);a.equal(rollbackConfirmed,true);const r={schema:"accepted-sequential-resume-native-proof-v1",ok:true,cases,caseCount:12,nodeVersion:process.version,uid:process.getuid(),postgresVersion:"17.10",pgVersion:"8.23.1",sourcePins:SOURCE_PINS,synthetic:true,originalCalls:0,originalWrites:0,smtpCalls:0,nativeWorkerExecuted:false,originalAuthorityAccepted:false,clientEndConfirmed:ended,rollbackConfirmed,fixtureServerEnded:false,operational:false};const file=process.env.ACCEPTED_RESUME_FIXTURE_RECEIPT;a(file&&path.isAbsolute(file)&&!fs.existsSync(file));fs.writeFileSync(file,JSON.stringify(r,null,2)+"\n",{flag:"wx",mode:0o644});fs.chmodSync(file,0o644);process.stdout.write(JSON.stringify({schema:r.schema,ok:true,cases:12,clientEndConfirmed:true,rollbackConfirmed:true,originalCalls:0,operational:false})+"\n");}).catch(e=>{process.stdout.write(JSON.stringify({schema:"accepted-sequential-resume-native-proof-v1",ok:false,phase,sqlstate:typeof e.code==="string"&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null,cases,clientEndConfirmed:ended,rollbackConfirmed,originalCalls:0,operational:false})+"\n");process.exitCode=1;});
