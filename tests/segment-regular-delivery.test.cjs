'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupRegularDelivery}=require('./segment-regular-delivery-fixture.cjs');
test('durable regular delivery defaults OFF and accepted finish acknowledges exactly once',async()=>{
 const db=new PGlite();try{
  const f=await setupRegularDelivery(db);
  for(const cid of [100,200])await assert.rejects(f.claim(cid,(await f.batch(cid))[0].id),e=>e.code==='55000');
  await f.enable();
  for(const cid of [100,200]){
   const sid=(await f.batch(cid))[0].id,before=await f.state(cid),grant=await f.claim(cid,sid);
   assert.equal(grant.should_send,true);assert.ok(grant.claim_token);assert.deepEqual(await f.state(cid),before);
   const response=await f.finish(cid,sid,grant);assert.equal(response.outcome,'accepted');
   assert.deepEqual(await f.state(cid),{sent:1,last_subscriber_id:sid});
   assert.deepEqual(await f.finish(cid,sid,grant),response);assert.deepEqual(await f.state(cid),{sent:1,last_subscriber_id:sid});
   const replay=await f.claim(cid,sid);assert.deepEqual(replay,{should_send:false,reason:'accepted',dispatch_id:grant.dispatch_id,claim_token:null});
  }
 }finally{await db.close();}
});
test('lost claim reply and uncertain SMTP outcome block replay and later recipients',async()=>{
 const db=new PGlite();try{
  const f=await setupRegularDelivery(db);await f.enable();
  for(const cid of [100,200]){
   const [a,b]=await f.batch(cid),before=await f.state(cid),grant=await f.claim(cid,a.id);
   assert.equal((await f.claim(cid,a.id)).reason,'in_flight','lost claim ACK never grants another attempt');
   await assert.rejects(f.claim(cid,b.id),/RECONCILIATION_REQUIRED/);
   await f.finish(cid,a.id,grant,'outcome_unknown');
   assert.deepEqual(await f.state(cid),before,'unknown never advances checkpoint or sent');
   await assert.rejects(f.claim(cid,b.id),e=>e.code==='55000');
   await assert.rejects(f.finish(cid,a.id,grant,'accepted'),/OUTCOME_CONFLICT/);
  }
 }finally{await db.close();}
});
test('fresh consent can skip without sending; order, recipient, material and runtime drift fail closed',async()=>{
 const db=new PGlite();try{
  const f=await setupRegularDelivery(db);await f.enable();
  for(const [cid,base]of [[100,17],[200,16]]){
   const [a,b]=await f.batch(cid);
   await assert.rejects(f.claim(cid,b.id),/DELIVERY_ORDER/);
   await assert.rejects(f.claim(cid,a.id,{recipient:'someone-else@example.invalid'}),/SUBSCRIBER_DRIFT/);
   await assert.rejects(f.claim(cid,a.id,{sender:'other@example.invalid'}),/UNAVAILABLE/);
   await assert.rejects(f.claim(cid,a.id,{workerHash:'d'.repeat(64)}),/UNAVAILABLE/);
   await assert.rejects(f.claim(cid,a.id,{runtimeHash:'d'.repeat(64)}),/UNAVAILABLE/);
   const selectedSnapshot=await f.snapshot(a.id);
   await db.query("UPDATE subscribers SET email='changed-'||id||'@example.invalid' WHERE id=$1",[a.id]);
   await assert.rejects(f.claim(cid,a.id,{snapshot:selectedSnapshot}),/SUBSCRIBER_DRIFT/);
   await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=$2",[a.id,base]);
   assert.equal((await f.claim(cid,a.id)).reason,'ineligible');assert.deepEqual(await f.state(cid),{sent:0,last_subscriber_id:a.id});
   await db.query("UPDATE campaigns SET body='changed' WHERE id=$1",[cid]);
   await assert.rejects(f.claim(cid,b.id),/MATERIAL_DRIFT/);
  }
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM shrigma_email_dispatch')).rows[0].n,0);
 }finally{await db.close();}
});

test('SQL failure after receipt update rolls back history and checkpoint together',async()=>{
 const db=new PGlite();try{
  const f=await setupRegularDelivery(db);await f.enable();const sid=(await f.batch(100))[0].id,grant=await f.claim(100,sid);
  await db.exec(`CREATE FUNCTION fixture_fail_progress() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'FIXTURE_PROGRESS_FAILURE';END$$;
   CREATE TRIGGER fixture_fail_progress BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION fixture_fail_progress();`);
  await assert.rejects(f.finish(100,sid,grant),/FIXTURE_PROGRESS_FAILURE/);
  const row=(await db.query('SELECT transport_state,outcome_at,accepted_at FROM shrigma_email_dispatch WHERE dispatch_id=$1',[grant.dispatch_id])).rows[0];
  assert.deepEqual(row,{transport_state:'in_flight',outcome_at:null,accepted_at:null});
  assert.deepEqual(await f.state(100),{sent:0,last_subscriber_id:0});
  await db.exec('DROP TRIGGER fixture_fail_progress ON campaigns');
  assert.equal((await f.finish(100,sid,grant)).outcome,'accepted');
 }finally{await db.close();}
});
test('finish records confirmed history after OFF while fresh source failure never reserves an attempt',async()=>{
 const db=new PGlite();try{
  const f=await setupRegularDelivery(db);await f.enable();
  const sid=(await f.batch(100))[0].id;
  await db.exec('UPDATE crm_audience_v2.selection_runtime SET enabled=false');
  await assert.rejects(f.claim(100,sid),e=>e.code==='55000');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM shrigma_email_dispatch')).rows[0].n,0);
  await db.exec('UPDATE crm_audience_v2.selection_runtime SET enabled=true');
  const grant=await f.claim(100,sid);
  await db.exec("UPDATE campaigns SET status='paused' WHERE id=100;UPDATE crm_audience_v2.regular_delivery_campaign SET enabled=false;");
  assert.equal((await f.finish(100,sid,grant)).outcome,'accepted');
  assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:sid});
 }finally{await db.close();}
});
test('an unavailable bound audience is paused before scanning unrelated native campaigns',async()=>{
 const db=new PGlite();try{
  const f=await setupRegularDelivery(db);await f.enable();
  await db.exec(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":300,"status":"scheduled"}'::jsonb)).* FROM campaigns c WHERE id=100;
   INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(300,17,'Legacy');
   UPDATE crm_audience_v2.config SET enabled=false WHERE brand='fish';`);
  const scan=()=>db.query(require('../n8n/growth/segment-listmonk-selection.cjs').section(f.worker.source,'next-campaigns').text,[[],[]]);
  await assert.rejects(scan(),e=>e.code==='55000');
  const quarantine=ids=>db.query('SELECT crm_audience_v2.regular_delivery_quarantine($1) result',[ids]).then(r=>r.rows[0].result);
  assert.deepEqual(await quarantine([100]),[],'the active local pipe remains its own responsibility');
  assert.deepEqual(await quarantine([]),[{campaign_id:100,reason:'source_unavailable'}]);
  assert.deepEqual(await f.state(100),{sent:0,last_subscriber_id:0});
  const rows=(await scan()).rows;assert.deepEqual(rows.map(r=>r.id).sort(),[200,300]);
  assert.equal((await db.query('SELECT status FROM campaigns WHERE id=100')).rows[0].status,'paused');
  await db.exec('UPDATE crm_audience_v2.config SET enabled=true');
  assert.deepEqual(await quarantine([]),[],'refresh never resumes a suspended campaign');
  assert.equal((await db.query('SELECT count(*)::integer n FROM shrigma_email_dispatch')).rows[0].n,0);
 }finally{await db.close();}
});
test('subscriber timestamps preserve native instants across session timezones without hiding drift',async()=>{
 const db=new PGlite();try{
  const f=await setupRegularDelivery(db);await f.enable();const [first,next]=await f.batch(100);
  await db.query("UPDATE subscribers SET created_at='2026-09-28T23:15:01.123456-03:00',updated_at='2026-09-29T02:16:02.654321+00:00' WHERE id=$1",[first.id]);
  await db.query("SET TimeZone='America/Sao_Paulo'");const snapshot=await f.snapshot(first.id);
  assert.match(snapshot.created_at,/-03:00$/);
  for(const change of [
   s=>{delete s.created_at;},s=>{delete s.updated_at;},s=>{s.created_at=123;},
   s=>{s.updated_at='now';},s=>{s.updated_at='2026-09-31T02:16:02.654321+00:00';},
   s=>{s.updated_at='2026-09-29T02:16:02.654322+00:00';},s=>{s.updated_at=null;},
   s=>{s.created_at='2026-09-29T02:15:01.123456';},s=>{s.extra='unexpected';}
  ]){const candidate=structuredClone(snapshot);change(candidate);await assert.rejects(f.claim(100,first.id,{snapshot:candidate}),/SUBSCRIBER_DRIFT/);}
  const grant=await f.claim(100,first.id,{snapshot});assert.equal(grant.should_send,true);await f.finish(100,first.id,grant);
  await db.query('UPDATE subscribers SET created_at=NULL,updated_at=NULL WHERE id=$1',[next.id]);
  const nullable=await f.snapshot(next.id);assert.equal(nullable.created_at,null);assert.equal(nullable.updated_at,null);
  const nextGrant=await f.claim(100,next.id,{snapshot:nullable});assert.equal(nextGrant.should_send,true);
 }finally{await db.close();}
});
