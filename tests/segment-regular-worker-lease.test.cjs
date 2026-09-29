'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupWorkerLease}=require('./segment-regular-worker-lease-fixture.cjs');
const withDB=fn=>async()=>{const db=new PGlite();try{await db.waitReady;const f=await setupWorkerLease(db);await fn(db,f);}finally{await db.close();}};
const unavailable=e=>e.code==='55000'&&/SEGMENT_WORKER_LEASE_/.test(e.message);

test('worker lease defaults OFF, requires approved identity and bounds claim expiry to process lease',withDB(async(db,f)=>{
 assert.deepEqual(await f.heartbeat(),{ready:false,reason:'deployment_unavailable'});assert.equal(await f.lease(),undefined);
 await f.approve();assert.deepEqual(await f.heartbeat(f.instance,'c'.repeat(64)),{ready:false,reason:'identity_unavailable'});
 const healthy=await f.heartbeat();assert.equal(healthy.ready,true);assert.equal(healthy.instance_id,f.instance);
 assert.equal(Date.parse(healthy.expires_at)-Date.parse(healthy.checked_at),60000);
 await f.enable();const [sub]=await f.batch(100);
 await assert.rejects(f.liveClaim(100,sub.id,{id:randomUUID()}),unavailable);
 await assert.rejects(f.liveClaim(100,sub.id,{configurationSet:'wrong-set'}),e=>e.code==='55000'&&e.message.includes('CONFIGURATION_SET_MISMATCH'));
 assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 const grant=await f.liveClaim(100,sub.id);assert.equal(grant.should_send,true);
 assert.equal(Date.parse(grant.valid_until),Date.parse(healthy.expires_at));
 await f.finish(100,sub.id,grant);assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:sub.id});
}));

test('competing live instances suspend guarded delivery, and cannot self-clear the suspension',withDB(async(db,f)=>{
 await f.approve();await f.heartbeat();await f.enable();const [sub]=await f.batch(100),other=randomUUID();
 assert.deepEqual(await f.heartbeat(other),{ready:false,reason:'competing_instance'});
 assert.equal((await f.lease()).suspension_reason,'competing_instance');
 assert.deepEqual(await f.heartbeat(),{ready:false,reason:'lease_suspended'});
 await assert.rejects(f.liveClaim(100,sub.id),unavailable);
 assert.deepEqual(await f.state(100),{sent:0,last_subscriber_id:0});
 assert.equal((await db.query('SELECT enabled FROM crm_audience_v2.selection_runtime')).rows[0].enabled,false);
}));

test('expired leases can be replaced, but the previous process cannot claim or renew over a live replacement',withDB(async(db,f)=>{
 await f.approve();await f.heartbeat();await f.enable();const [sub]=await f.batch(100);
 await db.query("UPDATE crm_audience_v2.regular_worker_lease SET heartbeat_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute'");
 await assert.rejects(f.liveClaim(100,sub.id),unavailable);
 const replacement=randomUUID();assert.equal((await f.heartbeat(replacement)).ready,true);
 await assert.rejects(f.liveClaim(100,sub.id),unavailable);
 const grant=await f.liveClaim(100,sub.id,{id:replacement});assert.equal(grant.should_send,true);
 await f.finish(100,sub.id,grant);
 assert.deepEqual(await f.heartbeat(),{ready:false,reason:'competing_instance'});
}));

test('native catalog renewal isolates invalid brands and never enables Shopify or a disabled source',withDB(async(db,f)=>{
 await f.approve();
 await db.query("UPDATE crm_audience_v2.config SET expires_at=clock_timestamp()-interval '1 second',checked_at=clock_timestamp()-interval '4 minutes'");
 await db.query("UPDATE crm_audience_v2.config SET catalog=jsonb_set(catalog,'{fields,5,source_hash}',to_jsonb(repeat('0',64))) WHERE brand='fish'");
 assert.equal((await f.heartbeat()).ready,true);
 const states=(await db.query('SELECT brand,expires_at>clock_timestamp() AS fresh,catalog FROM crm_audience_v2.config ORDER BY brand')).rows;
 assert.equal(states.find(s=>s.brand==='aristo').fresh,true);assert.equal(states.find(s=>s.brand==='fish').fresh,false);
 for(const state of states)assert.equal(state.catalog.fields.some(field=>field.key.startsWith('purchase.')&&field.available),false);
 await db.query("UPDATE crm_audience_v2.config SET enabled=false,expires_at=clock_timestamp()-interval '1 second' WHERE brand='aristo'");
 assert.equal((await f.heartbeat()).ready,true);
 assert.equal((await db.query("SELECT enabled FROM crm_audience_v2.config WHERE brand='aristo'")).rows[0].enabled,false);
}));

test('runtime drift and deployment OFF suspend an existing process without changing receipts or campaign progress',withDB(async(db,f)=>{
 await f.approve();await f.heartbeat();
 assert.deepEqual(await f.heartbeat(f.instance,f.worker,'e'.repeat(64)),{ready:false,reason:'identity_unavailable'});
 assert.equal((await f.lease()).suspension_reason,'identity_changed');
 await db.query('UPDATE crm_audience_v2.regular_worker_deployment SET enabled=false');
 assert.deepEqual(await f.heartbeat(),{ready:false,reason:'deployment_unavailable'});
 assert.equal((await f.lease()).suspension_reason,'deployment_off');
 assert.deepEqual(await f.state(100),{sent:0,last_subscriber_id:0});
 assert.equal((await db.query('SELECT count(*)::integer AS n FROM shrigma_email_dispatch')).rows[0].n,0);
}));
