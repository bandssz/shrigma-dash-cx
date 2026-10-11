"use strict";
// Synthetic new rows only; seed body copied from accepted-resume public fixture.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),a=require("node:assert/strict");
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const EXTRA_GUARDS_SHA="53ee6e4d2aef2128a05a0bc719473a7e5a91ae7a93ab0b34b3326fcb9ec7e1c1";
const kernel={CANDIDATE:{workerSha256:"4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb",runtimeSha256:"4cd321fbdfd9a163f7c5ea2e1ba71029140e00a468d421908de8d0211d1e42cb",querySha256:"772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700"}};
async function prepareFixture(client,repoRoot){
 const db=client;
 if(!repoRoot||!path.isAbsolute(repoRoot))throw Error("FIXTURE_PUBLIC_ROOT_REQUIRED");
async function seed(){
 a.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign")).rows[0].n,0,"Full fixture must be BEFORE activate");
 a.equal((await db.query("SELECT count(*)::int n FROM campaigns WHERE id=ANY(ARRAY[171,172,173,174])")).rows[0].n,0,"New synthetic IDs required");
 a.equal((await db.query("SELECT count(*)::int n FROM public.shrigma_email_dispatch")).rows[0].n,0,"No synthetic attempt yet");
 // Row construction is synthetic only. Exact public original guard bodies and
 // the accepted owned SQL graph are installed below, only in this disposable DB.
 await db.query(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object(
  'id',n,'uuid',gen_random_uuid(),'name','Own recovery synthetic '||n,'status',CASE WHEN n=172 THEN 'scheduled' ELSE 'paused' END,
  'send_at',CASE WHEN n=172 THEN '2026-10-11 21:00:00+00'::timestamptz ELSE clock_timestamp()-interval '1 minute' END,
  'started_at',CASE WHEN n IN(171,174) THEN clock_timestamp()-interval '2 minutes' ELSE NULL END,'sent',CASE WHEN n=171 THEN 2710 WHEN n=174 THEN 503 ELSE 0 END,'last_subscriber_id',CASE WHEN n=171 THEN 27100 WHEN n=174 THEN 139873 ELSE 0 END,
  'to_send',CASE WHEN n=171 THEN 3482 WHEN n=174 THEN 2500 ELSE 0 END,'max_subscriber_id',CASE WHEN n IN(171,174) THEN 21021791 ELSE 0 END))).*
  FROM campaigns c CROSS JOIN unnest(ARRAY[171,172,174]) n WHERE c.id=100`);
 await db.query(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object(
  'id',173,'uuid',gen_random_uuid(),'name','Own recovery legacy synthetic','send_at','2026-10-11 21:00:00+00'::timestamptz))).* FROM campaigns c WHERE id=300`);
 await db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) SELECT n,17,'Synthetic Fish' FROM unnest(ARRAY[171,172,174]) n; INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(173,40,'Synthetic legacy')");
 const H=require(path.join(repoRoot,"n8n/growth/segment-audience-review.cjs"));
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
 a.equal((await db.query("SELECT count(*)::int n FROM public.shrigma_email_dispatch WHERE transport_state='accepted'")).rows[0].n,3213);
 await db.query(`INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
  SELECT gen_random_uuid(),CASE WHEN n<=16 THEN 'aristo' ELSE 'fish' END,'transacional','SYNTHETIC_HISTORICAL',
   'synthetic-legacy:'||n,repeat('a',64),'000000000000','native-fixture','native-fixture','synthetic-legacy:'||n,'fixture-only-v1',false,'in_flight',
   CASE WHEN n<=16 THEN timestamptz '2026-09-14 17:10:00+00' ELSE timestamptz '2026-09-14 23:09:00+00' END,gen_random_uuid()
  FROM generate_series(1,34) n`);
 await db.query(`INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token,outcome_at,error_code)
  SELECT '0d8c77b2-18e7-474f-b9b7-bbfc733bac2f','fish','campaign','audience-regular-v1:174',jsonb_build_array(174,b.binding_version,139874)::text,
   repeat('e',64),'000000000000','native-fixture','native-fixture','synthetic-held-not-a-customer','fixture-only-v1',false,'outcome_unknown',
   clock_timestamp()-interval '1 minute',gen_random_uuid(),clock_timestamp()-interval '1 minute','NATIVE_REGULAR_OUTCOME_UNKNOWN'
  FROM crm_audience_v2.campaign_binding b WHERE b.campaign_id=174`);
 await db.query(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||jsonb_build_object(
  'id',n,'uuid',gen_random_uuid(),'name','Synthetic handoff wave '||n,'status',CASE WHEN n=175 THEN 'finished' ELSE 'scheduled' END,
  'send_at',clock_timestamp()+interval '2 days'))).* FROM campaigns c CROSS JOIN unnest(ARRAY[175,176,177]) n WHERE c.id=300;
  INSERT INTO campaign_lists(campaign_id,list_id,list_name) SELECT n,40,'Synthetic legacy' FROM unnest(ARRAY[175,176,177]) n;`);

}

 await seed();
 // Install the exact accepted proposed function graph in this disposable fixture only.
 for(const name of ['OBJECTS.install.sql','CLAIM.proposed.sql','RECOVER.proposed.sql','GUARD.proposed.sql'])
  await db.query(fs.readFileSync(path.join(__dirname,'fixture-inputs',name),'utf8'));
 // Simulate the already separately proved irreversible disposition, never acceptance.
 await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
 try {
 await db.query(`INSERT INTO crm_audience_v2.regular_delivery_permanent_exclusion
 (dispatch_id,campaign_id,binding_version,binding_hash,subscriber_id,dedupe_key,dispatch_snapshot,operation_id,disposition)
 SELECT d.dispatch_id,174,b.binding_version,b.binding_hash,139874,d.dedupe_key,to_jsonb(d),gen_random_uuid(),'human_permanent_no_resend'
 FROM public.shrigma_email_dispatch d JOIN crm_audience_v2.campaign_binding_effective(174) b ON true
 WHERE d.dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'`);
 await db.query("UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_subscriber_id=139874 WHERE campaign_id=174; UPDATE public.campaigns SET last_subscriber_id=139874 WHERE id=174");
 a.equal((await db.query("SELECT crm_audience_v2.regular_delivery_permanently_excluded('0d8c77b2-18e7-474f-b9b7-bbfc733bac2f',174) ready")).rows[0].ready,true);
 await db.query('COMMIT');
 } catch (error) { await db.query('ROLLBACK'); throw error; }

}
module.exports=Object.freeze({prepareFixture,CANDIDATE:Object.freeze(kernel.CANDIDATE)});
