"use strict";
// Rollback-only synthetic PG17.10 fixture adapter. No original connection discovery.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const DIAGNOSTIC_FIELDS=new Set(["serverVersionNum", "sessionUser", "currentUser", "regularRunning", "deployment", "lease", "selectionRuntime", "controls", "campaigns", "bindings", "bindingHistory", "dispatch", "abArms", "functionMetadata", "relationMetadata", "mutationTriggers", "campaignGuard", "unexpected_field", "snapshot_schema"]);
function divergentFields(e){if(typeof e?.detail!=='string'||!/^fields:[A-Za-z0-9_,]+$/.test(e.detail))return [];const fields=e.detail.slice(7).split(',');return fields.every(k=>DIAGNOSTIC_FIELDS.has(k))?[...new Set(fields)].sort():[];}
const INSTANCE='77777777-7777-4777-8777-777777777777';
let db,kernel,src,finishedCount,seed174State='paused',inTx=false,rollbackConfirmed=true,clientEndConfirmed=false;
function request(campaignId){const refs={};for(const n of ['admission','snapshot','quiescence','binding','disposition'])refs[n]={reference:crypto.randomUUID(),sha256:sha('SYNTHETIC_ONLY:'+n+':'+crypto.randomUUID())};return {campaignId,operationId:crypto.randomUUID(),candidate:{...kernel.CANDIDATE},privateReferences:refs};}
function admission(p){return {resumeScope:p.resumeScope,operationId:p.operationId,purpose:p.admissionPurpose,campaignId:String(p.campaignId),candidate:p.candidate,admissionSha256:p.privateReferences.admission.sha256,snapshotSha256:p.privateReferences.snapshot.sha256,quiescenceSha256:p.privateReferences.quiescence.sha256,bindingSha256:p.privateReferences.binding.sha256,dispositionSha256:p.privateReferences.disposition.sha256,actor:'SYNTHETIC_FIXTURE_ONLY_NO_ORIGINAL_AUTHORITY',checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString()};}
async function seed(){
 a.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign")).rows[0].n,0,"Full fixture must be BEFORE activate");
 a.equal((await db.query("SELECT count(*)::int n FROM public.campaigns WHERE id=ANY(ARRAY[171,172,173,174])")).rows[0].n,0,"New synthetic IDs required");
 a.equal((await db.query("SELECT count(*)::int n FROM public.shrigma_email_dispatch")).rows[0].n,0,"No synthetic attempt yet");
 // Only new synthetic rows in the existing tables: no DDL, stub, function rewrite or grant.
 await db.query(`INSERT INTO public.campaigns SELECT (jsonb_populate_record(NULL::public.campaigns,to_jsonb(c)||jsonb_build_object(
  'id',n,'uuid',gen_random_uuid(),'name','Own recovery synthetic '||n,'status',CASE WHEN n=172 THEN 'scheduled' WHEN n=174 THEN '${seed174State}' ELSE 'paused' END,
  'send_at',CASE WHEN n=172 THEN clock_timestamp()+interval '2 days' ELSE clock_timestamp()-interval '1 minute' END,
  'started_at',CASE WHEN n IN(171,174) THEN clock_timestamp()-interval '2 minutes' ELSE NULL END,'sent',CASE WHEN n=171 THEN 2510 WHEN n=174 THEN ${finishedCount} ELSE 0 END,'last_subscriber_id',CASE WHEN n=171 THEN 51635 WHEN n=174 THEN ${139873} ELSE 0 END,
  'to_send',CASE WHEN n=171 THEN 3467 WHEN n=174 THEN 2373 ELSE 0 END,'max_subscriber_id',CASE WHEN n=171 THEN 11035396 WHEN n=174 THEN ${21021791} ELSE 0 END))).*
  FROM public.campaigns c CROSS JOIN unnest(ARRAY[171,172,174]) n WHERE c.id=100`);
 await db.query(`INSERT INTO public.campaigns SELECT (jsonb_populate_record(NULL::public.campaigns,to_jsonb(c)||jsonb_build_object(
  'id',173,'uuid',gen_random_uuid(),'name','Own recovery legacy synthetic','send_at',clock_timestamp()+interval '2 days'))).* FROM public.campaigns c WHERE id=300`);
 await db.query("INSERT INTO public.campaign_lists(campaign_id,list_id,list_name) SELECT n,17,'Synthetic Fish' FROM unnest(ARRAY[171,172,174]) n; INSERT INTO public.campaign_lists(campaign_id,list_id,list_name) VALUES(173,40,'Synthetic legacy')");
 await db.query(`INSERT INTO public.campaigns SELECT (jsonb_populate_record(NULL::public.campaigns,to_jsonb(c)||jsonb_build_object('id',n,'uuid',gen_random_uuid(),'name','SYNTHETIC Aristo wave '||n,'status',CASE WHEN n IN(175,176) THEN 'finished' ELSE 'scheduled' END,'sent',0,'last_subscriber_id',0,'to_send',0,'max_subscriber_id',0,'started_at',NULL,'send_at',clock_timestamp()+interval '1 day'))).* FROM public.campaigns c CROSS JOIN unnest(ARRAY[175,176,177])n WHERE c.id=300`);
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
  FROM public.campaigns c JOIN LATERAL crm_audience_v2.campaign_binding_effective(c.id) b ON true WHERE c.id IN(171,172,174)`,[kernel.CANDIDATE.workerSha256,kernel.CANDIDATE.runtimeSha256]);
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
 await db.query(`UPDATE crm_audience_v2.regular_delivery_campaign r SET acknowledged_sent=c.sent,acknowledged_subscriber_id=c.last_subscriber_id FROM public.campaigns c WHERE c.id=r.campaign_id AND c.id IN(171,174)`);
 await db.query(`INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token,outcome_at,accepted_at)
  SELECT gen_random_uuid(),b.brand,'campaign','audience-regular-v1:'||c.id::text,jsonb_build_array(c.id,b.binding_version,CASE WHEN n=c.sent THEN c.last_subscriber_id ELSE n END)::text,
   repeat('d',64),'000000000000','native-fixture','native-fixture','synthetic-no-customer:'||c.id::text||':'||n::text,'fixture-only-v1',false,'accepted',clock_timestamp()-interval '2 minutes',gen_random_uuid(),clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute'
  FROM public.campaigns c JOIN crm_audience_v2.campaign_binding b ON b.campaign_id=c.id CROSS JOIN LATERAL generate_series(1,c.sent) n WHERE c.id IN(171,174)`);
 a.equal((await db.query("SELECT count(*)::int n FROM public.shrigma_email_dispatch WHERE transport_state='accepted'")).rows[0].n,2510+finishedCount);
 await db.query(`INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token,outcome_at,accepted_at,error_code)
 SELECT '0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'::uuid,'fish','campaign','audience-regular-v1:174',jsonb_build_array(174,b.binding_version,139874)::text,repeat('d',64),'000000000000','native-fixture','native-fixture','SYNTHETIC_HELD_UNKNOWN','fixture-only-v1',false,'outcome_unknown',clock_timestamp()-interval '2 minutes',gen_random_uuid(),clock_timestamp()-interval '1 minute',NULL,'NATIVE_REGULAR_OUTCOME_UNKNOWN' FROM crm_audience_v2.campaign_binding b WHERE campaign_id=174`);


}
const EXTRA_GUARDS_SHA='53ee6e4d2aef2128a05a0bc719473a7e5a91ae7a93ab0b34b3326fcb9ec7e1c1';
const CONTENTION_PREPARE_SHA='eb720857ab797f4f2b68d76d81488adc1ea1682a69292a164cd5da07f88f1384';
const HEARTBEAT_PREPARE_SHA='e1e45367ab8eea1f0ca629ea6785bb392a4f8df33d77745d3caf07de2d7366bc';
async function rollback(){if(inTx){try{await db.query('ROLLBACK');inTx=false;}catch{rollbackConfirmed=false;throw Error('FIXTURE_ROLLBACK_NOT_CONFIRMED');}}}
function filePin(file,digest){a(path.isAbsolute(file));a(!file.split(path.sep).includes('.private'));a.equal(fs.realpathSync(file),file);a(!fs.lstatSync(file).isSymbolicLink());a.equal(sha(fs.readFileSync(file)),digest);}
function createFixture(heartbeatSource,contentionSource){return Object.freeze({synthetic:true,
 async reset({finished174Count,target171Sent,target171Cursor,seed174Status='paused'}){
  a.equal(finished174Count,503);a.equal(target171Sent,2510);a.equal(target171Cursor,51635);a.equal(seed174Status,'paused');await rollback();finishedCount=finished174Count;seed174State=seed174Status;
  await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');inTx=true;
  await db.query("SET LOCAL TimeZone='Etc/UTC';SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='500ms';SET LOCAL search_path=pg_catalog;");
  await seed();
  const hp=heartbeatSource.prepare('apply');const metadata=(await db.query(hp.snapshotReadSQL)).rows[0].function_metadata;
  // Same exact public heartbeat adapter; its transaction boundary belongs to this outer fixture.
  for(let i=1;i<hp.statements.length-1;i++)await db.query(hp.statements[i],i===4?[JSON.stringify({schema:'heartbeat-lock-2s-expected-v1',stage:'apply',functionMetadata:metadata})]:[]);
  const cp=contentionSource.prepare('apply');const cm=(await db.query(cp.snapshotReadSQL)).rows[0].function_metadata;
  for(let i=1;i<cp.statements.length-1;i++)await db.query(cp.statements[i],i===4?[JSON.stringify({schema:'heartbeat-contention-expected-v1',stage:'apply',functionMetadata:cm})]:[]);
  const hb=(await db.query('SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) h',[INSTANCE,kernel.CANDIDATE.workerSha256,kernel.CANDIDATE.runtimeSha256])).rows[0].h;
  a.equal(hb.ready,true);a.equal(hb.instance_id,INSTANCE);
  const input=request(171);src=kernel.prepare(input);const baseline=(await db.query(src.snapshotReadSQL)).rows[0].jsonb_build_object;
  a.equal(baseline.campaignGuard.length,3);a.equal(baseline.dispatch.length,2511+finishedCount);a.equal(baseline.campaigns.length,7);
  a.equal(baseline.campaigns.find(c=>c.id===174).status,seed174State);a.deepEqual(baseline.functionMetadata['crm_audience_v2.regular_worker_heartbeat(uuid,text,text)'].proconfig,['search_path=pg_catalog','lock_timeout=2s']);
  a.equal(crypto.createHash('md5').update(baseline.functionMetadata['crm_audience_v2.regular_worker_heartbeat(uuid,text,text)'].prosrc).digest('hex'),'2fb7f585e75826a8a3b813b76caf7c20');
  return input;
 },
 async envelope(prepared,current){return {plan:prepared.plan,snapshot:structuredClone(current),privateAdmission:admission(prepared.plan)};},
 async applyNegative(name,{envelope}={}){
  const fresh=name.startsWith('fresh-'),kind=fresh?name.slice(6):name;
  if(kind==='wrong-purpose'){a(envelope);envelope.privateAdmission.purpose='crm.native171.resume-after174-finished';return;}
  if(kind==='wrong-binding'){await db.query("UPDATE crm_audience_v2.regular_delivery_campaign SET binding_hash=repeat('e',64) WHERE campaign_id=171");return;}
  if(kind==='wrong-function'){
   const ddl=(await db.query("SELECT pg_get_functiondef('crm_audience_v2.regular_worker_heartbeat(uuid,text,text)'::regprocedure) ddl")).rows[0].ddl;
   // Negative-only: retain original function body, add comment to prove exact prosrc pin refusal.
   a(ddl.includes('AS $function$'));await db.query(ddl.replace('AS $function$','AS $function$\n-- SYNTHETIC_PIN_DRIFT_NEGATIVE_ONLY'));return;
  }
  if(kind==='wrong-trigger'){
   const name=(await db.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='public.campaigns'::regclass ORDER BY tgname LIMIT 1")).rows[0].tgname;
   a(/^[a-z0-9_]+$/.test(name));await db.query('ALTER TABLE public.campaigns DISABLE TRIGGER "'+name+'"');return;
  }
  if(kind==='171-ack-drift'||kind==='171-progress'){await db.query('UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=2511 WHERE campaign_id=171');return;}
  if(kind==='new-regular-running'||kind==='176-running'){await db.query("UPDATE public.campaigns SET status='running' WHERE id=176");return;}
  if(kind==='174-paused'){await this.reset({finished174Count:finishedCount,target171Sent:2510,target171Cursor:51635,seed174Status:'paused'});return;}
  if(kind==='unknown'||kind==='inflight'){
   await db.query("UPDATE public.shrigma_email_dispatch SET transport_state=$1 WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:174' ORDER BY dispatch_id LIMIT 1)",[kind==='unknown'?'outcome_unknown':'in_flight']);return;
  }

  if(kind==='held-count'){await db.query('UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=502 WHERE campaign_id=174');return;}
  if(kind==='held-uuid'){await db.query("UPDATE public.shrigma_email_dispatch SET dispatch_id=gen_random_uuid() WHERE dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'");return;}
  if(kind==='held-inflight'){await db.query("UPDATE public.shrigma_email_dispatch SET transport_state='in_flight' WHERE dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'");return;}
  if(kind==='held-accepted-drift'){await db.query("UPDATE public.shrigma_email_dispatch SET payload_sha256=repeat('b',64) WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:174' AND transport_state='accepted' ORDER BY dispatch_id LIMIT 1)");return;}
  if(kind==='175-priority'){await db.query("UPDATE public.campaigns SET status='running' WHERE id=175");return;}
  if(kind==='171-unknown'){await db.query("UPDATE public.shrigma_email_dispatch SET transport_state='outcome_unknown' WHERE dispatch_id=(SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:171' ORDER BY dispatch_id LIMIT 1)");return;}
  if(kind==='other-fish-unknown'){await db.query(`INSERT INTO public.shrigma_email_dispatch SELECT (jsonb_populate_record(NULL::public.shrigma_email_dispatch,to_jsonb(d)||jsonb_build_object('dispatch_id',gen_random_uuid(),'piece','audience-regular-v1:172','dedupe_key',jsonb_build_array(172,1,147)::text,'recipient_key','SYNTHETIC_OTHER_FISH'))).* FROM public.shrigma_email_dispatch d WHERE dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'`);return;}
  if(kind==='expired-lease'){await db.query("UPDATE crm_audience_v2.regular_worker_lease SET heartbeat_at=clock_timestamp()-interval '70 seconds',expires_at=clock_timestamp()-interval '10 seconds'");return;}
  if(kind==='expired'){a(envelope);envelope.privateAdmission.expiresAt=new Date(Date.now()-1).toISOString();return;}
  if(kind==='wrong-held-scope'){a(envelope);envelope.privateAdmission.resumeScope={...envelope.privateAdmission.resumeScope,heldDispatchId:'11111111-1111-4111-8111-111111111111'};return;}
  throw Error('UNKNOWN_FOCAL_NEGATIVE');
 }
});}
async function main(){
 a.equal(process.env.ACCEPTED_RESUME_FIXTURE_ISOLATED,'1');a.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,'1');a.equal(process.env.REGULAR_NATIVE_SOURCE_PROOF,'1');
 a.equal(process.version,'v22.23.3');a.equal(process.platform,'linux');a.equal(process.arch,'x64');a.equal(process.getuid(),1000);a.equal(require('pg/package.json').version,'8.23.1');
 const u=new URL(process.env.ACCEPTED_RESUME_FIXTURE_URL||'https://invalid');a.equal(u.protocol,'postgresql:');a.equal(u.hostname,'127.0.0.1');a.equal(u.pathname,'/listmonk');a(u.port&&u.port!=='5432');a.equal(u.username,'postgres');a.equal(u.password,'');a.equal(u.search,'');a.equal(u.hash,'');
 const pins=JSON.parse(fs.readFileSync(path.join(__dirname,'FIXTURE-SOURCE-PINS.json')));for(const[n,h]of Object.entries(pins))filePin(path.join(__dirname,n),h);
 const hbDir=process.env.ACCEPTED_RESUME_HEARTBEAT_SOURCE_DIR;a(hbDir&&path.isAbsolute(hbDir));const hbPrepare=path.join(hbDir,'prepare.cjs');filePin(hbPrepare,HEARTBEAT_PREPARE_SHA);
 const repo=process.env.ACCEPTED_RESUME_REPO_ROOT;a(repo&&path.isAbsolute(repo)&&!repo.split(path.sep).includes('.private'));filePin(path.join(__dirname,'fixture-extra-guards.sql'),EXTRA_GUARDS_SHA);
 const contentionDir=process.env.ACCEPTED_RESUME_CONTENTION_SOURCE_DIR;a(contentionDir&&path.isAbsolute(contentionDir));const contentionPrepare=path.join(contentionDir,'prepare.cjs');filePin(contentionPrepare,CONTENTION_PREPARE_SHA);const contentionSource=require(contentionPrepare);
 const heartbeatSource=require(hbPrepare);kernel=require('./prepare.cjs');src=kernel.prepare(request(171));
 const{Client}=require('pg');const client=new Client({connectionString:u.href,options:'-c TimeZone=Etc/UTC',query_timeout:12000});db={query:(s,p)=>client.query(s,p)};
 let result=null,nativeCommitVerified=false,phase='connect',safeError=null;
 try{
  await client.connect();const b=(await db.query("SELECT current_setting('server_version_num') v,current_database() d,current_setting('TimeZone') tz,session_user=current_user AS same")).rows[0];a.deepEqual(b,{v:'170010',d:'listmonk',tz:'Etc/UTC',same:true});
  a.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_worker_lease')).rows[0].n,0);
  phase='18-held-focal-cases';const fixture=createFixture(heartbeatSource,contentionSource);result=await require('./pg-focal.test.cjs').run({db,fixture});a.equal(result.cases,18);
  // One additional real synthetic COMMIT checks the unchanged full transaction wrapper.
  phase='full-transaction-commit';const ci=await fixture.reset({finished174Count:503,target171Sent:2510,target171Cursor:51635});
  await db.query('COMMIT');inTx=false;const cp=kernel.prepare(ci),before=(await db.query(cp.snapshotReadSQL)).rows[0].jsonb_build_object;
  const env=await fixture.envelope(cp,before);for(const sql of cp.statements){if(sql.startsWith('BEGIN'))inTx=true;await db.query(sql,sql.includes('$1::text')?[JSON.stringify(env)]:[]);if(sql==='COMMIT;')inTx=false;}
  const after=(await db.query(cp.snapshotReadSQL)).rows[0].jsonb_build_object,expected=structuredClone(before);expected.campaigns.find(c=>c.id===171).status='scheduled';expected.controls.find(c=>c.campaign_id===171).suspended=false;a.deepEqual(after,expected);a.deepEqual(after.dispatch,before.dispatch);nativeCommitVerified=true;phase='rollback-end';
 }catch(e){safeError={phase,divergentFields:divergentFields(e),sqlstate:typeof e.code==='string'&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null};}
 finally{try{await rollback();}finally{try{await client.end();clientEndConfirmed=true;}catch{clientEndConfirmed=false;}}}
 const r={schema:'native171-remaining957-fixture-receipt-v1',ok:!!result&&!safeError&&clientEndConfirmed&&rollbackConfirmed,caseCount:result?.cases||0,synthetic:true,rollbackOnly:false,fixtureCommits:true,nativeCommitVerified,heartbeatBodyMd5:'2fb7f585e75826a8a3b813b76caf7c20',kernelSourcePins:Object.fromEntries(Object.entries(pins).filter(([n])=>['prepare.cjs','resume.atomic.sql.in','snapshot.private-read.sql','PUBLIC-FUNCTION-PINS.json'].includes(n))),originalCalls:0,originalWrites:0,originalAuthorityAccepted:false,smtpCalls:0,nativeWorkerExecuted:false,nodeVersion:process.version,uid:process.getuid(),pgVersion:'8.23.1',postgresVersion:'17.10',clientEndConfirmed,rollbackConfirmed,fixtureServerEnded:false,serverEndOwner:'Root CI must stop service and seal shutdown receipt before complete acceptance',failure:safeError,sourcePins:pins,operational:false};
 const output=process.env.ACCEPTED_RESUME_FIXTURE_RECEIPT;a(output&&path.isAbsolute(output)&&!output.split(path.sep).includes('.private')&&!fs.existsSync(output));fs.writeFileSync(output,JSON.stringify(r,null,2)+'\n',{flag:'wx',mode:0o644});process.stdout.write(JSON.stringify({schema:r.schema,ok:r.ok,divergentFields:safeError?.divergentFields||[],caseCount:r.caseCount,rollbackConfirmed,clientEndConfirmed,originalCalls:0,operational:false})+'\n');if(!r.ok)process.exitCode=1;
}
module.exports=Object.freeze({createFixture,divergentFields});
if(require.main===module)main().catch(()=>{process.stdout.write(JSON.stringify({schema:'native171-remaining957-fixture-receipt-v1',ok:false,phase:'boundary-or-cleanup',clientEndConfirmed,rollbackConfirmed,fixtureServerEnded:false,originalCalls:0,operational:false})+'\n');process.exitCode=1;});
