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
 a.equal((await db.query("SELECT count(*)::int n FROM public.shrigma_email_dispatch WHERE transport_state='accepted'")).rows[0].n,33);

}

 await seed();
}
module.exports=Object.freeze({prepareFixture,CANDIDATE:Object.freeze(kernel.CANDIDATE)});
