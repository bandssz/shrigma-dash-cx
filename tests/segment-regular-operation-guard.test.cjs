'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupOperationGuard}=require('./segment-regular-operation-guard-fixture.cjs');
const withDB=fn=>async()=>{const db=new PGlite();try{await db.waitReady;const f=await setupOperationGuard(db);await fn(db,f);}finally{await db.close();}};

test('operation guard preserves draft-only behavior until deployment, process and campaign are all approved',withDB(async(db,f)=>{
 await assert.rejects(f.schedule(100),/SELECTOR_REQUIRED/);await f.install();
 await assert.rejects(f.schedule(100),/OPERATION_UNAVAILABLE/);
 await f.approve();await f.heartbeat();await assert.rejects(f.schedule(100),/OPERATION_UNAVAILABLE/);
 await f.enable();await f.schedule(100);await f.scan();
 assert.equal((await db.query('SELECT status FROM campaigns WHERE id=100')).rows[0].status,'running');
 await assert.rejects(f.install(),/INSTALL_UNAVAILABLE/);
}));

test('native counter and batch cursor assignments cannot impersonate durable receipt progress',withDB(async(db,f)=>{
 await f.install();await f.approve();await f.heartbeat();await f.enable();await f.schedule(100);await f.scan();
 const [sub]=await f.batch(100);
 const Selection=require('../n8n/growth/segment-listmonk-selection.cjs');
 // Run the entire unchanged upstream batch: its anticipatory cursor UPDATE
 // must roll back the SELECT before an old sender could receive subscribers.
 await assert.rejects(db.query(Selection.section(f.fixture.source,'next-campaign-subscribers').text,
  [100,'regular',0,240,[17],10]),/RECEIPT_REQUIRED/);
 await assert.rejects(db.query('UPDATE campaigns SET last_subscriber_id=$2 WHERE id=$1',[100,sub.id]),/RECEIPT_REQUIRED/);
 await assert.rejects(db.query('UPDATE campaigns SET sent=sent+1 WHERE id=100'),/RECEIPT_REQUIRED/);
 await assert.rejects(db.query("UPDATE campaigns SET status='finished' WHERE id=100"),/FINALIZE_UNAVAILABLE/);
 const grant=await f.liveClaim(100,sub.id);await f.finish(100,sub.id,grant);
 assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:sub.id});
 const next=(await f.batch(100,{cursor:sub.id}))[0];
 await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=17",[next.id]);
 assert.equal((await f.liveClaim(100,next.id)).reason,'ineligible');
 assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:next.id});
}));

test('pause remains available after worker loss and accepted history can commit after pause without authorizing resume',withDB(async(db,f)=>{
 await f.install();await f.approve();await f.heartbeat();await f.enable();await f.schedule(200);await f.scan();
 const [sub]=await f.batch(200),grant=await f.liveClaim(200,sub.id);
 await db.query('UPDATE crm_audience_v2.regular_worker_deployment SET enabled=false');
 await db.query("UPDATE campaigns SET status='paused' WHERE id=200");
 assert.equal((await db.query('SELECT suspended FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=200')).rows[0].suspended,true);
 await f.finish(200,sub.id,grant);assert.deepEqual(await f.state(200),{sent:1,last_subscriber_id:sub.id});
 await assert.rejects(db.query("UPDATE campaigns SET status='scheduled' WHERE id=200"),/OPERATION_UNAVAILABLE/);
 await assert.rejects(db.query('DELETE FROM campaigns WHERE id=200'),/OPERATION_REQUIRED/);
}));

test('a missing control can still be quarantined, and draft edits cannot silently refresh captured material',withDB(async(db,f)=>{
 await f.install();await f.approve();await f.heartbeat();await f.enable();await f.schedule(100);await f.scan();
 await db.query('DELETE FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=100');
 const quarantine=(await db.query("SELECT crm_audience_v2.regular_delivery_quarantine('{}') AS result")).rows[0].result;
 assert.deepEqual(quarantine,[{campaign_id:100,reason:'control_unavailable'}]);
 assert.deepEqual(await f.state(100),{sent:0,last_subscriber_id:0});
 await db.query('BEGIN');await db.query("SELECT set_config('shrigma.campaign_writer','200',true)");
 await db.query("UPDATE campaigns SET subject='Edited draft' WHERE id=200");await db.query('COMMIT');
 await assert.rejects(f.schedule(200),/OPERATION_UNAVAILABLE/);
}));
