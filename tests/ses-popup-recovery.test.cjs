'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setup,seed,changeEvent,one,recover,SQL}=require('./ses-popup-recovery-fixture.cjs');
async function use(fn){const db=new PGlite();try{await setup(db);await fn(db);}finally{await db.close();}}
const counts=db=>one(db,'SELECT (SELECT count(*)::int FROM shrigma_send_log) AS logs,(SELECT count(*)::int FROM shrigma_email_popup_recovery_v1) AS audits');
test('popup recovery defaults to rollback; both brands and uncertain states reconcile once, preserving subscriber markers and unknown template',()=>use(async db=>{
 for(const brand of ['fish','aristo'])for(const state of ['in_flight','outcome_unknown']){
  const s=await seed(db,{brand,state}),before=await counts(db);
  assert.equal((await one(db,'SELECT * FROM shrigma_email_recover_popup_delivery_v1($1)',[s.id])).result,'would_reconcile');assert.deepEqual(await counts(db),before);
  assert.equal((await one(db,'SELECT transport_state FROM shrigma_email_dispatch WHERE dispatch_id=$1',[s.id])).transport_state,state);
  const r=await recover(db,s,false);assert.equal(r.result,'reconciled');assert.deepEqual(await recover(db,s,false),{result:'already_applied',send_log_id:r.send_log_id});
  const log=await one(db,'SELECT * FROM shrigma_send_log WHERE id=$1',[r.send_log_id]);assert.equal(log.template_id,null);assert.equal(log.email,s.email);assert.equal(log.ref,s.ref);assert.equal(log.subscriber_id,null);
  const audit=await one(db,'SELECT * FROM shrigma_email_popup_recovery_v1 WHERE dispatch_id=$1',[s.id]);assert.equal(audit.reason,'SES_SEND_AND_DELIVERY_HTTP_NOT_CAPTURED');assert.equal(audit.before_state.transport_state,state);assert.equal(audit.before_state.send_log_id,null);assert.equal(audit.evidence.length,2);
  assert.deepEqual((await one(db,'SELECT attribs FROM subscribers WHERE email=$1',[s.email])).attribs,{marker:'preserved'});
 }
}));
test('wrong scope, state, dedupe, recipient, prior log or captured HTTP always refuse without effects',()=>use(async db=>{
 const cases=[
  ["brand='olivas'",'SCOPE'],["brand=NULL",'SCOPE'],["flow='nps'",'SCOPE'],["piece='nps-d0'",'SCOPE'],['is_test=true','SCOPE'],
  ["transport_state='accepted'",'STATE'],["transport_state=NULL",'STATE'],['claim_token=NULL','STATE'],['started_at=NULL','STATE'],['started_at=now()','STATE'],["configuration_set='wrong'",'STATE'],['payload_sha256=NULL','STATE'],
  ["dedupe_key='[\"email\",\"other\",\"x@example.invalid\",false]'",'REF'],["dedupe_key='not json'",'REF'],["recipient_key='wrong'",'RECIPIENT']
 ];
 for(const [update,reason] of cases){const s=await seed(db);await db.query('UPDATE shrigma_email_dispatch SET '+update+' WHERE dispatch_id=$1',[s.id]);await assert.rejects(recover(db,s,false),new RegExp('POPUP_RECOVERY_'+reason));}
 const http=await seed(db);await db.query("INSERT INTO shrigma_email_transport_evidence VALUES($1,'{}')",[http.id]);await assert.rejects(recover(db,http,false),/HTTP_EVIDENCE_PRESENT/);
 const prior=await seed(db);await db.query("INSERT INTO shrigma_send_log(email,brand,flow,channel,piece,ref) VALUES('other@example.invalid','aristo','popup','email','cupom-boas-vindas',$1)",[prior.ref]);await assert.rejects(recover(db,prior,false),/EXISTING_LOG/);
 assert.equal((await counts(db)).audits,0);assert.equal((await counts(db)).logs,1);
}));
test('archived SES identity, tags, destination and timing are independently required even with rehashed envelopes',()=>use(async db=>{
 const cases=[
  ['send',e=>e.eventType='Delivery',/PROOF/],['send',e=>e.mail.sendingAccountId='wrong',/PROOF/],['send',e=>e.mail.tags.crm_dispatch_id=['00000000-0000-4000-8000-000000000000'],/PROOF/],
  ['send',e=>e.mail.tags.crm_test=['true'],/PROOF/],['send',e=>e.mail.tags['ses:configuration-set']=['wrong'],/PROOF/],['send',e=>e.mail.messageId='wrong',/PROOF/],['send',e=>e.mail.destination.push('other@example.invalid'),/PROOF/],
  ['send',e=>e.mail.timestamp='2000-01-01T00:00:00Z',/TIME|EVENT_MISMATCH/],['delivery',e=>e.delivery.timestamp='2000-01-01T00:00:00Z',/DELIVERY/],['delivery',e=>e.delivery.recipients=['other@example.invalid'],/DELIVERY/],
  ['delivery',e=>e.mail.timestamp=new Date(new Date(e.mail.timestamp).getTime()+100).toISOString(),/EVENT_MISMATCH/]
 ];
 for(const [status,change,error] of cases){const s=await seed(db);await changeEvent(db,s,status,change);await assert.rejects(recover(db,s,false),error);}
 assert.deepEqual(await counts(db),{logs:0,audits:0});
}));
test('missing, conflicting, duplicate, unarchived or corrupted events cannot release the reservation',()=>use(async db=>{
 const mutations=[
  "DELETE FROM shrigma_email_status WHERE dispatch_id=$1 AND status='send'",
  "UPDATE shrigma_email_status SET reconciliation_status='conflict' WHERE dispatch_id=$1",
  "UPDATE shrigma_email_status SET is_test_claim=NULL WHERE dispatch_id=$1",
  "UPDATE shrigma_email_status SET recipient_key='wrong' WHERE dispatch_id=$1",
  "UPDATE shrigma_email_status SET status='send' WHERE dispatch_id=$1",
  "DELETE FROM shrigma_email_queue_receipt WHERE ingest_id IN (SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)",
  "UPDATE shrigma_email_queue_receipt SET body_raw=body_raw||' ' WHERE ingest_id IN (SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)",
  "UPDATE shrigma_email_queue_receipt SET body_sha256='wrong' WHERE ingest_id IN (SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)",
  "DELETE FROM shrigma_email_message_link WHERE dispatch_id=$1"
 ];
 for(const q of mutations){const s=await seed(db);await db.query(q,[s.id]);await assert.rejects(recover(db,s,false),/POPUP_RECOVERY_/);assert.equal((await one(db,'SELECT transport_state FROM shrigma_email_dispatch WHERE dispatch_id=$1',[s.id])).transport_state,'in_flight');}
 assert.deepEqual(await counts(db),{logs:0,audits:0});
}));
test('replay refuses audit or log drift, and transport/old recovery entry points are absent',()=>use(async db=>{
 const s=await seed(db),r=await recover(db,s,false);await db.query('UPDATE shrigma_send_log SET template_id=22 WHERE id=$1',[r.send_log_id]);await assert.rejects(recover(db,s,false),/AUDIT_MISMATCH/);
 assert.doesNotMatch(SQL,/\b(UPDATE\s+(public\.)?subscribers|shrigma_email_finish_engagement\s*\(|shrigma_email_claim_engagement\s*\(|https?:\/\/|http_request)\b/i);
 await assert.rejects(recover(db,s,null),/ARGUMENT_INVALID/);
}));

test('replay verifies audited archive integrity and fingerprints, without demanding new events or current HMAC',()=>use(async db=>{
 const damaged=await seed(db);await recover(db,damaged,false);
 await db.query("UPDATE shrigma_email_queue_receipt SET body_raw=body_raw||' ' WHERE ingest_id IN (SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)",[damaged.id]);
 await assert.rejects(recover(db,damaged,false),/ARCHIVE_INVALID/);
 const rewritten=await seed(db);await recover(db,rewritten,false);await changeEvent(db,rewritten,'send',e=>e.mail.commonHeaders={subject:'Changed archived fixture'});
 await assert.rejects(recover(db,rewritten,false),/AUDIT_PROOF_MISMATCH/);
 const later=await seed(db),r=await recover(db,later,false);
 await db.query("INSERT INTO shrigma_email_status SELECT event_key||':later',first_ingest_id,account_id,region,message_id,'open',recipient_key,recipient_key_version,dispatch_id_claim,dispatch_id,is_test_claim,is_test,reconciliation_status FROM shrigma_email_status WHERE dispatch_id=$1 AND status='send'",[later.id]);
 await db.exec("CREATE OR REPLACE FUNCTION shrigma_email_recipient_key(address text) RETURNS TABLE(recipient_key text,key_version text) LANGUAGE sql AS $$SELECT 'rotated','fixture-v2'$$");
 assert.deepEqual(await recover(db,later,false),{result:'already_applied',send_log_id:r.send_log_id});
 assert.deepEqual(await counts(db),{logs:3,audits:3});
}));
