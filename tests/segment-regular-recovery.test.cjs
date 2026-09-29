'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupRecovery,one}=require('./segment-regular-recovery-fixture.cjs');
async function use(fn){const db=new PGlite();try{await fn(db,await setupRecovery(db));}finally{await db.close();}}
test('regular uncertain delivery reconciles each brand exactly once without resume, replay or a send log',()=>use(async(db,f)=>{
 for(const [cid,state] of [[100,'in_flight'],[200,'outcome_unknown']]){
  const s=await f.seed(cid,state),before=await f.state(cid);
  assert.equal((await f.recover(s)).result,'would_reconcile');assert.deepEqual(await f.state(cid),before);
  assert.equal((await one(db,'SELECT transport_state FROM shrigma_email_dispatch WHERE dispatch_id=$1',[s.id])).transport_state,state);
  const result=await f.recover(s,false);
  assert.deepEqual(result,{dispatch_id:s.id,result:'reconciled',authorizes_send:false,authorizes_resume:false});
  assert.deepEqual(await f.state(cid),{sent:1,last_subscriber_id:s.sid});
  assert.equal((await f.recover(s,false)).result,'already_reconciled');assert.deepEqual(await f.state(cid),{sent:1,last_subscriber_id:s.sid});
  assert.equal((await one(db,'SELECT suspended FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=$1',[cid])).suspended,true);
  await assert.rejects(f.claim(cid,s.sid),/UNAVAILABLE/);
  assert.equal((await one(db,'SELECT send_log_id FROM shrigma_email_dispatch WHERE dispatch_id=$1',[s.id])).send_log_id,null);
 }
}));
test('missing, conflicting or corrupted archived proof cannot advance the campaign',()=>use(async(db,f)=>{
 const s=await f.seed(100),before=await f.state(100);
 const cases=[
  "DELETE FROM shrigma_email_status WHERE dispatch_id=$1 AND status='send'",
  "UPDATE shrigma_email_status SET reconciliation_status='conflict' WHERE dispatch_id=$1",
  "UPDATE shrigma_email_status SET recipient_key='wrong' WHERE dispatch_id=$1",
  "UPDATE shrigma_email_status SET is_test_claim=true WHERE dispatch_id=$1",
  "UPDATE shrigma_email_status SET message_id='wrong' WHERE dispatch_id=$1 AND status='delivery'",
  "DELETE FROM shrigma_email_message_link WHERE dispatch_id=$1",
  "UPDATE shrigma_email_queue_receipt SET body_raw=body_raw||' ' WHERE ingest_id IN(SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)",
  "UPDATE shrigma_email_event_ingest SET event_payload=jsonb_set(event_payload,'{mail,tags,crm_test}','[\"true\"]') WHERE ingest_id IN(SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)",
  "UPDATE shrigma_email_dispatch SET started_at=clock_timestamp() WHERE dispatch_id=$1",
  "UPDATE shrigma_email_dispatch SET brand='olivas' WHERE dispatch_id=$1",
 ];
 for(const query of cases){
  await db.exec('BEGIN');try{await db.query(query,[s.id]);await assert.rejects(f.recover(s,false),/SEGMENT_RECOVERY_/);}finally{await db.exec('ROLLBACK');}
  assert.deepEqual(await f.state(100),before);
 }
 assert.equal((await one(db,'SELECT count(*)::integer n FROM crm_audience_v2.regular_delivery_recovery')).n,0);
}));
test('reconciliation audit remains immutable, and counter failure rolls the whole recovery back',()=>use(async(db,f)=>{
 const s=await f.seed(100),before=await f.state(100);
 await db.exec("CREATE FUNCTION fixture_recovery_error() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'FIXTURE_RECOVERY_FAILURE';END$$;CREATE TRIGGER fixture_recovery_error BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION fixture_recovery_error();");
 await assert.rejects(f.recover(s,false),/FIXTURE_RECOVERY_FAILURE/);assert.deepEqual(await f.state(100),before);
 assert.equal((await one(db,'SELECT count(*)::integer n FROM crm_audience_v2.regular_delivery_recovery')).n,0);
 await db.exec('DROP TRIGGER fixture_recovery_error ON campaigns');await f.recover(s,false);
 await db.query("UPDATE shrigma_email_queue_receipt SET body_raw=body_raw||' ' WHERE ingest_id IN(SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)",[s.id]);
 await assert.rejects(f.recover(s,false),/ARCHIVE/);assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:s.sid});
}));
