'use strict';
// Portable component proof only. This does not prove the production installer
// guard, concurrency/lock races, or A/B delivery capture.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupShopifySelection}=require('./segment-shopify-selection-fixture.cjs');
const {rule}=require('./segment-shopify-facts-fixture.cjs');
const Install=require('../n8n/growth/recipient-conversion-install.cjs');

const ROOT=path.resolve(__dirname,'..');
const candidate=fs.readFileSync(path.join(ROOT,'n8n/growth/recipient-conversion-evidence.sql'),'utf8');

async function setup(t){
 const db=new PGlite();t.after(()=>db.close());
 const fixture=await setupShopifySelection(db);
 await db.exec(fs.readFileSync(path.join(ROOT,'n8n/growth/ab-experiment-core.sql'),'utf8'));
 // PGlite has native sha256() but does not ship the pgcrypto extension. This
 // compatibility function is limited to the exact digest call used here; the
 // native PostgreSQL installer/extension remains outside this component proof.
 await db.exec(`CREATE FUNCTION public.digest(data bytea,algorithm text) RETURNS bytea
  LANGUAGE plpgsql IMMUTABLE AS $$BEGIN
   IF lower(algorithm)<>'sha256' THEN RAISE EXCEPTION 'SYNTHETIC_DIGEST_ALGORITHM';END IF;
   RETURN sha256(data);
  END$$`);
 const snapshot=(await db.query(Install.snapshotSQL())).rows[0].snapshot;
 const plan=Install.compile({expectedSnapshot:snapshot,expectedSnapshotSha256:Install.sha(Install.canonical(snapshot)),pins:Install.sourcePins(),reviewSha256:Install.sha('SYNTHETIC_COMPONENT_REVIEW_ONLY'),notBefore:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+5*60*1000).toISOString()});
 await db.exec(plan.sql);
 return fixture;
}

async function startRegular(db,fixture,brand){
 const {f,rebind}=fixture;
 const campaignId=brand==='fish'?100:200;
 await db.transaction(async tx=>{
  await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(campaignId)]);
  await tx.query("UPDATE campaigns SET send_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[campaignId]);
 });
 await rebind(brand,rule());
 await f.approve();
 await db.query(`INSERT INTO crm_audience_v2.regular_delivery_campaign(
   campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,
   envelope_from,account_id,region,configuration_set,enabled)
  SELECT b.campaign_id,b.binding_version,b.binding_hash,
   crm_audience_v2.regular_delivery_material(b.campaign_id),repeat('a',64),repeat('b',64),
   s.envelope_from,s.account_id,s.region,s.configuration_set,true
  FROM crm_audience_v2.campaign_binding b
  JOIN crm_audience_v2.regular_sender_policy s ON s.brand=b.brand
  WHERE b.campaign_id=$1`,[campaignId]);
 await db.transaction(async tx=>{
  await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(campaignId)]);
  await tx.query("UPDATE campaigns SET status='scheduled' WHERE id=$1",[campaignId]);
 });
 await db.query("UPDATE campaigns SET status='running',max_subscriber_id=5 WHERE id=$1",[campaignId]);
 return campaignId;
}

async function claim(db,campaignId,subscriberId=1,dispatchId=randomUUID()){
 const subscriber=(await db.query('SELECT to_jsonb(s) AS value FROM subscribers s WHERE id=$1',[subscriberId])).rows[0].value;
 const brand=campaignId===100?'fish':'aristo';
 const args=[campaignId,subscriberId,dispatchId,'a'.repeat(64),'b'.repeat(64),
  `contato@${brand==='fish'?'fishermans.com.br':'oaristocrata.com'}`,subscriber.email,
  'c'.repeat(64),JSON.stringify(subscriber)];
 const result=(await db.query(
  'SELECT crm_audience_v2.regular_delivery_claim($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS value',args
 )).rows[0].value;
 return {args,result};
}

test('capture defaults OFF and a real accepted regular delivery creates no prospective evidence',async t=>{
 const fixture=await setup(t),{db}=fixture,campaignId=await startRegular(db,fixture,'fish');
 const batch=(await db.query("SELECT status FROM crm_audience_v2.shopify_batch WHERE brand='fish' AND operation_id=(SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand='fish')")).rows[0];
 assert.equal(batch.status,'ready');
 const first=await claim(db,campaignId);
 assert.equal(first.result.should_send,true,JSON.stringify(first.result));
 const finished=(await db.query(
  'SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3,$4,$5) AS value',
  [campaignId,1,first.result.dispatch_id,first.result.claim_token,'accepted']
 )).rows[0].value;
 assert.equal(finished.outcome,'accepted');
 assert.equal((await db.query('SELECT count(*)::integer AS n FROM crm_email_conversion_candidate.claim_identity_v1')).rows[0].n,0);
 assert.deepEqual((await db.query('SELECT brand,enabled,coverage_started_at FROM crm_email_conversion_candidate.capture_control_v1 ORDER BY brand')).rows,[
  {brand:'aristo',enabled:false,coverage_started_at:null},
  {brand:'fish',enabled:false,coverage_started_at:null},
 ]);
});

test('enabled ready source captures confirmed identity and keeps it immutable across finish/replay recovery',async t=>{
 const fixture=await setup(t),{db}=fixture,campaignId=await startRegular(db,fixture,'fish');
 await db.query("UPDATE crm_email_conversion_candidate.capture_control_v1 SET enabled=true,coverage_started_at=clock_timestamp()-interval '1 second' WHERE brand='fish'");
 const first=await claim(db,campaignId);
 assert.equal(first.result.should_send,true,JSON.stringify(first.result));
 const evidence=(await db.query('SELECT * FROM crm_email_conversion_candidate.claim_identity_v1 WHERE dispatch_id=$1',[first.result.dispatch_id])).rows[0];
 assert.equal(evidence.brand,'fish');
 assert.equal(evidence.campaign_id,campaignId);
 assert.equal(evidence.subscriber_id,1);
 assert.equal(evidence.identity_state,'confirmed');
 assert.equal(evidence.customer_gid,'gid://shopify/Customer/1');
 assert.match(evidence.claim_sha256,/^[a-f0-9]{64}$/);
 assert.match(evidence.source_query_sha256,/^[a-f0-9]{64}$/);
 assert.match(evidence.source_provenance_sha256,/^[a-f0-9]{64}$/);
 assert.ok(evidence.source_operation_id);
 assert.ok(evidence.source_producer_revision);

 const finishArgs=[campaignId,1,first.result.dispatch_id,first.result.claim_token,'accepted'];
 const accepted=(await db.query('SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3,$4,$5) AS value',finishArgs)).rows[0].value;
 assert.equal(accepted.outcome,'accepted');
 // Same finish after a lost response is the real idempotent delivery recovery
 // boundary available in this fixture; it must not recreate capture evidence.
 const recovered=(await db.query('SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3,$4,$5) AS value',finishArgs)).rows[0].value;
 assert.deepEqual(recovered,accepted);
 const replay=await claim(db,campaignId,1,randomUUID());
 assert.equal(replay.result.should_send,false);
 assert.equal(replay.result.reason,'accepted');
 assert.equal(replay.result.dispatch_id,first.result.dispatch_id);
 assert.equal((await db.query('SELECT count(*)::integer AS n FROM crm_email_conversion_candidate.claim_identity_v1')).rows[0].n,1);

 const coverage=(await db.query("SELECT crm_email_conversion_candidate.accepted_coverage_v1('fish',$1) AS value",[campaignId])).rows[0].value;
 assert.deepEqual(coverage,{contract:'crm-recipient-coverage-v1',brand:'fish',campaign_id:campaignId,coverage_available:true,accepted_people:1,mapped_people:1,unknown_people:0,authorizes_send:false});
 assert.equal((await db.query('SELECT claim_sha256 FROM crm_email_conversion_candidate.claim_identity_v1 WHERE dispatch_id=$1',[first.result.dispatch_id])).rows[0].claim_sha256,evidence.claim_sha256);
 await assert.rejects(db.query("UPDATE crm_email_conversion_candidate.claim_identity_v1 SET identity_state='source_unavailable' WHERE dispatch_id=$1",[first.result.dispatch_id]),/RECIPIENT_CONVERSION_IMMUTABLE/);
 await assert.rejects(db.query('DELETE FROM crm_email_conversion_candidate.claim_identity_v1 WHERE dispatch_id=$1',[first.result.dispatch_id]),/RECIPIENT_CONVERSION_IMMUTABLE/);
});
test('an A/B assignment excludes its regular-shaped claim and never reports zero as supported coverage',async t=>{
 const fixture=await setup(t),{db}=fixture,campaignId=await startRegular(db,fixture,'fish'),tid=randomUUID();
 await db.query("INSERT INTO public.crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids) VALUES($1,'fish','{}',ARRAY[17])",[tid]);
 await db.query("INSERT INTO public.crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version) VALUES($1,'a',$2,'synthetic-version')",[tid,campaignId]);
 await db.query("UPDATE crm_email_conversion_candidate.capture_control_v1 SET enabled=true,coverage_started_at=clock_timestamp()-interval '1 second' WHERE brand='fish'");
 const reserved=await claim(db,campaignId);assert.equal(reserved.result.should_send,true);
 await db.query('SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3,$4,$5)',[campaignId,1,reserved.result.dispatch_id,reserved.result.claim_token,'accepted']);
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_email_conversion_candidate.claim_identity_v1')).rows[0].n,0);
 const result=(await db.query("SELECT crm_email_conversion_candidate.accepted_coverage_v1('fish',$1) value",[campaignId])).rows[0].value;
 assert.equal(result.coverage_available,false);assert.equal(result.accepted_people,null);assert.equal(result.mapped_people,null);assert.equal(result.unknown_people,null);
});
