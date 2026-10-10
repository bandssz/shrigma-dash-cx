'use strict';
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const K=require('./prepare.cjs'),D=K.HELD;
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function input(stage,cid,candidate){return {stage,campaignId:cid,operationId:crypto.randomUUID(),candidate,privateReferences:Object.fromEntries(['admission','snapshot','quiescence','binding','disposition','identity'].map(n=>[n,{reference:crypto.randomUUID(),sha256:sha('SYNTHETIC:'+n+crypto.randomUUID())}]))};}
function envelope(p,s){return {plan:p.plan,snapshot:structuredClone(s),privateAdmission:{operationId:p.plan.operationId,purpose:K.PURPOSE,stage:p.plan.stage,actor:'SYNTHETIC_ONLY_NO_ORIGINAL_AUTHORITY',candidate:p.plan.candidate,privateReferences:p.plan.privateReferences,scope:structuredClone(p.plan.scope),sourcePins:structuredClone(p.plan.sourcePins),checkedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),binaryExclusionSupportVerified:true,measuredWorkerSha256:p.plan.candidate.workerSha256,exclusionSourceSha256:p.plan.sourcePins['files/tools/listmonk-regular-build/overlay/listmonk/cmd/manager_store_regular.go']}};}
async function run({db,candidate}){
 let n=0;
 const snap=async s=>(await db.query(s)).rows[0].jsonb_build_object;
 async function point(stage,cid,mutate){const p=K.prepare(input(stage,cid,candidate));const e=envelope(p,await snap(p.snapshotReadSQL));if(mutate)mutate(e);await db.query(p.statements[5],[JSON.stringify(e)]);await db.query(p.statements[6]);return p;}
 async function test(name,f){try{await f();n++;}catch(e){e.focalCase=name;e.passedCases=n;throw e;}}
 async function refuses(f,code){await db.query('SAVEPOINT negative');let caught=false;try{await f();}catch(e){caught=true;if(code)a.equal(e.message,code);}finally{await db.query('ROLLBACK TO SAVEPOINT negative');await db.query('RELEASE SAVEPOINT negative');}a.equal(caught,true);}
 const heldBefore=(await db.query('SELECT to_jsonb(d) d FROM public.shrigma_email_dispatch d WHERE dispatch_id=$1',[D])).rows[0].d;
 const acceptedBefore=(await db.query("SELECT jsonb_agg(to_jsonb(d) ORDER BY dispatch_id) d FROM public.shrigma_email_dispatch d WHERE transport_state='accepted'")).rows[0].d;
 await test('original-inline-gate-refuses-unknown',async()=>a.equal((await db.query("SELECT EXISTS(SELECT 1 FROM public.shrigma_email_dispatch WHERE piece='audience-regular-v1:174' AND transport_state IN('in_flight','outcome_unknown')) b")).rows[0].b,true));
 await test('wrong-human-purpose',()=>refuses(()=>point('install',174,e=>e.privateAdmission.purpose='crm.other'),'PERMANENT_EXCLUSION_CURRENT_ADMISSION_REQUIRED'));
 await test('install-preserves-metadata-and-ledger',async()=>{await point('install',174);a.deepEqual((await db.query('SELECT to_jsonb(d) d FROM public.shrigma_email_dispatch d WHERE dispatch_id=$1',[D])).rows[0].d,heldBefore);});
 await test('install-repeated-name-collision-refused',()=>refuses(()=>point('install',174)));
 await test('wrong-exact-dispatch-disposition-refused',()=>refuses(()=>point('dispose',174,e=>e.privateAdmission.scope.heldDispatchId=crypto.randomUUID())));
 await test('max-cursor-drift-refused',()=>refuses(async()=>{await db.query("UPDATE public.campaigns SET max_subscriber_id=0 WHERE id=174");await point('dispose',174);}));
 await test('dispose-no-sent-or-accepted-change',async()=>{const b=(await db.query('SELECT sent,last_subscriber_id FROM public.campaigns WHERE id=174')).rows[0];await point('dispose',174);const c=(await db.query('SELECT sent,last_subscriber_id FROM public.campaigns WHERE id=174')).rows[0];a.equal(c.sent,b.sent);a.equal(c.last_subscriber_id,139874);a.deepEqual((await db.query("SELECT jsonb_agg(to_jsonb(d) ORDER BY dispatch_id) d FROM public.shrigma_email_dispatch d WHERE transport_state='accepted'")).rows[0].d,acceptedBefore);a.deepEqual((await db.query('SELECT to_jsonb(d) d FROM public.shrigma_email_dispatch d WHERE dispatch_id=$1',[D])).rows[0].d,heldBefore);});
 await test('immutable-update',()=>refuses(()=>db.query("UPDATE crm_audience_v2.regular_delivery_permanent_exclusion SET disposition='human_permanent_no_resend'"),'REGULAR_PERMANENT_EXCLUSION_IRREVERSIBLE'));
 await test('immutable-delete',()=>refuses(()=>db.query('DELETE FROM crm_audience_v2.regular_delivery_permanent_exclusion'),'REGULAR_PERMANENT_EXCLUSION_IRREVERSIBLE'));
 await test('immutable-truncate',()=>refuses(()=>db.query('TRUNCATE crm_audience_v2.regular_delivery_permanent_exclusion'),'REGULAR_PERMANENT_EXCLUSION_IRREVERSIBLE'));
 await test('recover-dryrun-refused',()=>refuses(()=>db.query('SELECT crm_audience_v2.regular_delivery_recover(174,139874,$1,true)',[D]),'REGULAR_PERMANENT_EXCLUSION_RECOVERY_FORBIDDEN'));
 await test('recover-write-refused',()=>refuses(()=>db.query('SELECT crm_audience_v2.regular_delivery_recover(174,139874,$1,false)',[D]),'REGULAR_PERMANENT_EXCLUSION_RECOVERY_FORBIDDEN'));
 await test('late-accepted-ack-never-reclassifies',()=>refuses(async()=>{await db.query("SELECT crm_audience_v2.regular_delivery_finish(174,139874,$1,claim_token,'accepted') FROM public.shrigma_email_dispatch WHERE dispatch_id=$1",[D]);},'SEGMENT_DELIVERY_OUTCOME_CONFLICT'));
 await test('late-ses-feedback-keeps-disposition-and-recover-refused',async()=>{
  // Public synthetic SES table contracts only; no SNS/SES consumer or crypto routine runs.
  await db.query(fs.readFileSync(path.join(__dirname,'sql/late-feedback.fixture.sql'),'utf8'));
  const message='SYNTHETIC_LATE_SES_MESSAGE';
  await db.query('INSERT INTO public.shrigma_email_message_link VALUES($1,$2,$3,$4)',[heldBefore.account_id,heldBefore.region,message,D]);
  for(const status of ['send','delivery']){
   const ingest=crypto.randomUUID(),event={eventType:status==='send'?'Send':'Delivery',mail:{messageId:message,sendingAccountId:heldBefore.account_id,destination:['synthetic@example.invalid'],tags:{crm_dispatch_id:[D],crm_test:['false'],'ses:configuration-set':[heldBefore.configuration_set]}}};
   await db.query("INSERT INTO public.shrigma_email_event_ingest VALUES($1,$2::jsonb,$3,$4,$5,'processed')",[ingest,JSON.stringify(event),'a'.repeat(64),'SYNTHETIC_SNS_'+status,'SYNTHETIC_TOPIC']);
   await db.query("INSERT INTO public.shrigma_email_status VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,false,false,'matched')",['SYNTHETIC_'+status,ingest,heldBefore.account_id,heldBefore.region,message,status,heldBefore.recipient_key,heldBefore.recipient_key_version,D]);
  }
  a.equal((await db.query('SELECT count(*)::int n FROM public.shrigma_email_status WHERE dispatch_id=$1',[D])).rows[0].n,2);
  a.equal((await db.query('SELECT crm_audience_v2.regular_delivery_permanently_excluded($1,174) v',[D])).rows[0].v,true);
  a.deepEqual((await db.query('SELECT to_jsonb(d) d FROM public.shrigma_email_dispatch d WHERE dispatch_id=$1',[D])).rows[0].d,heldBefore);
  await refuses(()=>db.query('SELECT crm_audience_v2.regular_delivery_recover(174,139874,$1,false)',[D]),'REGULAR_PERMANENT_EXCLUSION_RECOVERY_FORBIDDEN');
  // Direct mutation is not harmless feedback. In particular accepted_at/transport cannot drift.
  for(const assignment of ["send_log_id=123","accepted_at=clock_timestamp()","transport_state='accepted'"])
   await refuses(async()=>{await db.query('UPDATE public.shrigma_email_dispatch SET '+assignment+' WHERE dispatch_id=$1',[D]);a.equal((await db.query('SELECT crm_audience_v2.regular_delivery_permanently_excluded($1,174) v',[D])).rows[0].v,false);await point('resume',174);});
  a.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_permanent_exclusion')).rows[0].n,1);
 });
 await test('snapshot-drift-refuses',()=>refuses(()=>point('resume',174,e=>e.snapshot.campaigns.find(c=>c.id===174).sent++),'PERMANENT_EXCLUSION_SNAPSHOT_DRIFT'));
 await test('binary-proof-missing-refuses',()=>refuses(()=>point('resume',174,e=>delete e.privateAdmission.binaryExclusionSupportVerified),'PERMANENT_EXCLUSION_BINARY_AND_DISPOSITION_REQUIRED'));
 await test('other-unknown-still-blocks',()=>refuses(async()=>{await db.query("UPDATE public.shrigma_email_dispatch SET transport_state='outcome_unknown' WHERE piece='audience-regular-v1:171' AND transport_state='accepted'");await point('resume',174);}));
 await test('resume174-twofields-only',async()=>{await point('resume',174);a.equal((await db.query('SELECT status::text s FROM public.campaigns WHERE id=174')).rows[0].s,'scheduled');});
 // No worker/SMTP: only the existing running gate and terminal SQL are exercised in RAM fixture.
 await db.query("UPDATE public.campaigns SET status='running' WHERE id=174");
 await test('claim-excluded-never-send',async()=>{const r=(await db.query("SELECT crm_audience_v2.regular_delivery_claim(174,139874,$1,$2,$3,'contato@fishermans.com.br','synthetic@example.invalid',repeat('d',64),'{}'::jsonb) r",[crypto.randomUUID(),candidate.workerSha256,candidate.runtimeSha256])).rows[0].r;a.equal(r.should_send,false);a.equal(r.reason,'already_checkpointed');a.equal(r.claim_token,null);a.equal(r.dispatch_id,D);});
 await test('binding-drift-never-enables-replay',()=>refuses(async()=>{await db.query("UPDATE crm_audience_v2.regular_delivery_campaign SET binding_hash=repeat('e',64) WHERE campaign_id=174");a.equal((await db.query('SELECT crm_audience_v2.regular_delivery_permanently_excluded($1,174) v',[D])).rows[0].v,false);await db.query("SELECT crm_audience_v2.regular_delivery_claim(174,139874,$1,$2,$3,'contato@fishermans.com.br','synthetic@example.invalid',repeat('d',64),'{}'::jsonb)",[crypto.randomUUID(),candidate.workerSha256,candidate.runtimeSha256]);},'SEGMENT_DELIVERY_UNAVAILABLE'));
 await test('new-inline-gate-and-finalizer-predicates',async()=>{
  const go=fs.readFileSync(path.join(__dirname,'files/tools/listmonk-regular-build/overlay/listmonk/cmd/manager_store_regular.go'),'utf8');
  const gate=go.slice(go.indexOf('func (s *store) RegularDeliveryGate'),go.indexOf('func (s *store) HeartbeatRegularWorker')).match(/tx\.GetContext\(ctx, &row, `([\s\S]*?)`, campaignID\)/);a(gate);
  a.equal((await db.query(gate[1],[174])).rows[0].ready,true);
  const fin=go.slice(go.indexOf('func (s *store) FinalizeRegularDelivery')).match(/tx\.GetContext\(ctx, &unresolved, `([\s\S]*?)`, campaignID\)/);a(fin);a.equal((await db.query(fin[1],[174])).rows[0].exists,false);
 });
 await test('terminal-finish-keeps-outcome-and-irreversible-no-resend',async()=>{await db.query("UPDATE public.campaigns SET status='finished' WHERE id=174");a.equal((await db.query("SELECT c.sent+(SELECT count(*) FROM crm_audience_v2.regular_delivery_permanent_exclusion WHERE campaign_id=c.id)=c.to_send accounted FROM public.campaigns c WHERE id=174")).rows[0].accounted,true);a.deepEqual((await db.query('SELECT to_jsonb(d) d FROM public.shrigma_email_dispatch d WHERE dispatch_id=$1',[D])).rows[0].d,heldBefore);await refuses(()=>db.query("SELECT crm_audience_v2.regular_delivery_claim(174,139874,$1,$2,$3,'contato@fishermans.com.br','synthetic@example.invalid',repeat('d',64),'{}'::jsonb)",[crypto.randomUUID(),candidate.workerSha256,candidate.runtimeSha256]));await refuses(()=>db.query('SELECT crm_audience_v2.regular_delivery_recover(174,139874,$1,false)',[D]),'REGULAR_PERMANENT_EXCLUSION_RECOVERY_FORBIDDEN');});
 await test('sequential171-resume-keeps-all-accepted-and-174-terminal',async()=>{await point('resume',171);a.equal((await db.query('SELECT status::text s FROM public.campaigns WHERE id=171')).rows[0].s,'scheduled');a.equal((await db.query('SELECT status::text s FROM public.campaigns WHERE id=174')).rows[0].s,'finished');a.deepEqual((await db.query("SELECT jsonb_agg(to_jsonb(d) ORDER BY dispatch_id) d FROM public.shrigma_email_dispatch d WHERE transport_state='accepted'")).rows[0].d,acceptedBefore);});
 return {cases:n,synthetic:true,originalCalls:0,workerExecuted:false,smtpCalls:0,lateSESConsumerExecuted:false};
}
module.exports=Object.freeze({run,input,envelope});
