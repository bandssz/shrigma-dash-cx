'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,read,uuid}=require('./ab-experiment-fixture.cjs');
const CAPS=['draft','validate','submit','read_content'];
const NATIVE_SHA='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817';
async function setup(){
 const x=await fixture();await x.db.exec(read('n8n/growth/campaign-write-guard.sql'));
 await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));await x.db.exec(read('n8n/growth/ab-experiment-coordinator.sql'));
 let n=1000;
 x.control=async(p,oid=uuid(++n),actor='panel:synthetic',caps=CAPS)=>(await x.db.query('SELECT crm_ab_control_v2($1,$2,$3,$4) x',[actor,JSON.stringify(caps),oid,JSON.stringify(p)])).rows[0].x;
 x.request=(action,extra={})=>({contract:'crm-ab-email-v2',action,test_id:uuid(1),brand:'fish',expected_version:1,...extra});
 x.reviews=async()=>{const rows=(await x.db.query('SELECT id,fixture_audience_review(id) v FROM campaigns WHERE id IN(100,101) ORDER BY id')).rows;return Object.fromEntries(rows.map((r,i)=>[['a','b'][i],r.v.audience.review_id]));};
 x.review=async()=>x.control(x.request('review',{source_reviews:await x.reviews()}));
 x.enable=async()=>x.db.query('UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256=$1,verified_at=now()',[NATIVE_SHA]);
 x.states=async()=>(await x.db.query('SELECT id,status,sent,started_at,send_at FROM campaigns WHERE id IN(100,101) ORDER BY id')).rows;
 x.setup=async()=>{await x.enable();const p=await x.protocol();assert.equal((await x.control(p)).status,200);return p;};
 return x;
}
test('control receipt binds actor and payload; configuration never schedules and known rejection stays exact after state changes',async()=>{
 const x=await setup();try{
  const p=await x.protocol(),oid=uuid(501),before=await x.states();
  assert.equal((await x.control(p,uuid(500))).body.error,'AB_V2_TRANSPORT_UNAVAILABLE');assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_member_v2')).rows[0].n,0);
  await x.enable();const saved=await x.control(p,oid);
  assert.equal(saved.status,200);assert.equal(saved.body.experiment.state,'prepared');assert.deepEqual(await x.control(p,oid),saved);assert.deepEqual(await x.states(),before);
  assert.deepEqual((await x.db.query('SELECT crm_ab_operation_v2($1,$2) x',['panel:synthetic',oid])).rows[0].x.response,saved);
  await assert.rejects(x.control(p,oid,'panel:other'),/AB_V2_IDENTITY/);await assert.rejects(x.control({...p,name:'Changed'},oid),/AB_V2_IDENTITY/);
  await assert.rejects(x.control(p,uuid(502),'template:legacy'),/AB_V2_ACCESS/);assert.equal((await x.control(p,uuid(502),'panel:reader',['read_content'])).status,403);
  await x.db.exec('UPDATE crm_ab_runtime_v2 SET enabled=false');const req=x.request('schedule',{review_id:uuid(1),confirm:'schedule_both'}),blocked=await x.control(req,uuid(503));
  assert.equal(blocked.body.error,'AB_V2_TRANSPORT_UNAVAILABLE');await x.enable();assert.deepEqual(await x.control(req,uuid(503)),blocked);
  const unknown=x.request('cancel',{confirm:'cancel_both',extra:true});const bad=await x.control(unknown,uuid(504));assert.equal(bad.status,422);assert.deepEqual(await x.control(unknown,uuid(504)),bad);
 }finally{await x.db.close();}
});
test('fresh standard campaign reviews bind both arms and counts; optout changed after review blocks schedule without either native mutation',async()=>{
 const x=await setup();try{
  await x.setup();assert.equal((await x.control(x.request('review',{source_reviews:{a:'missing',b:'missing'}}))).body.error,'AB_V2_CAMPAIGN_REVIEW_REQUIRED');
  const r=await x.review();assert.equal(r.status,200,JSON.stringify(r));assert.deepEqual(r.body.review.arms.map(a=>a.counts.eligible),[500,500]);
  assert.doesNotMatch(JSON.stringify(r),/subscriber_id|fingerprint|seed/);
  await x.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id IN(3,17)");await x.enable();
  const s=await x.control(x.request('schedule',{review_id:r.body.review.review_id,confirm:'schedule_both'}));assert.equal(s.body.error,'AB_V2_AUDIENCE_CHANGED');assert.deepEqual((await x.states()).map(c=>c.status),['draft','draft']);
  const fresh=await x.review();assert.equal(fresh.status,200,JSON.stringify(fresh));assert.deepEqual(fresh.body.review.arms.map(a=>a.counts.eligible).sort(),[499,500]);
  const scheduled=await x.control(x.request('schedule',{review_id:fresh.body.review.review_id,confirm:'schedule_both'}));assert.equal(scheduled.status,200,JSON.stringify(scheduled));
  assert.equal(scheduled.body.experiment.state,'scheduled');assert.equal(scheduled.body.experiment.version,2);assert.deepEqual((await x.states()).map(c=>c.status),['scheduled','scheduled']);
  assert.equal(Date.parse(scheduled.body.experiment.window_end)-Date.parse(scheduled.body.experiment.window_start),86400000);
  assert.equal((await x.db.query("SELECT current_setting('shrigma.ab_schedule_v2',true) ab,current_setting('shrigma.campaign_writer',true) writer")).rows[0].ab,'');
 }finally{await x.db.close();}
});
test('both campaign updates and success receipt share one transaction; second-arm failure rolls back the first and archives only a defined rejection',async()=>{
 const x=await setup();try{
  await x.setup();const r=await x.review();await x.enable();
  await x.db.exec(`CREATE FUNCTION fail_second() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id=101 AND NEW.status='scheduled' THEN RAISE EXCEPTION 'AB_V2_SYNTHETIC_CONFLICT';END IF;RETURN NEW;END$$;
   CREATE TRIGGER zz_fail_second BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION fail_second();`);
  const p=x.request('schedule',{review_id:r.body.review.review_id,confirm:'schedule_both'}),oid=uuid(701),rejected=await x.control(p,oid);
  assert.equal(rejected.body.error,'AB_V2_SYNTHETIC_CONFLICT');assert.deepEqual((await x.states()).map(c=>c.status),['draft','draft']);
  assert.equal((await x.db.query('SELECT version FROM crm_ab_experiment_v2')).rows[0].version,1);
  await x.db.exec('DROP TRIGGER zz_fail_second ON campaigns');assert.deepEqual(await x.control(p,oid),rejected,'lost rejection response cannot become success on replay');
  assert.equal((await x.control(p)).status,200);
 }finally{await x.db.close();}
});
test('unclassified database failure produces neither mutation nor a fabricated definitive receipt',async()=>{
 const x=await setup();try{
  await x.setup();const r=await x.review();await x.enable();
  await x.db.exec(`CREATE FUNCTION fail_second() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id=101 THEN RAISE EXCEPTION USING ERRCODE='XX000',MESSAGE='synthetic database failure';END IF;RETURN NEW;END$$;
   CREATE TRIGGER zz_fail_second BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION fail_second();`);
  const oid=uuid(702);await assert.rejects(x.control(x.request('schedule',{review_id:r.body.review.review_id,confirm:'schedule_both'}),oid),/synthetic database failure/);
  assert.deepEqual((await x.states()).map(c=>c.status),['draft','draft']);assert.equal((await x.db.query('SELECT crm_ab_operation_v2($1,$2) x',['panel:synthetic',oid])).rows[0].x.state,'missing');
 }finally{await x.db.close();}
});
test('cancel works with transport OFF, requires confirmation and never cancels just one started arm',async()=>{
 const x=await setup();try{
  await x.setup();await x.db.exec('UPDATE crm_ab_runtime_v2 SET enabled=false');assert.equal((await x.control(x.request('cancel',{confirm:'wrong'}))).body.error,'AB_V2_CONFIRM');
  const r=await x.control(x.request('cancel',{confirm:'cancel_both'}));assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.experiment.state,'cancelled');assert.deepEqual((await x.states()).map(c=>c.status),['cancelled','cancelled']);
 }finally{await x.db.close();}
 const y=await setup();try{
  await y.setup();const review=await y.review();await y.enable();await y.control(y.request('schedule',{review_id:review.body.review.review_id,confirm:'schedule_both'}));
  await y.db.exec("UPDATE crm_ab_runtime_v2 SET enabled=false;UPDATE campaigns SET started_at=now() WHERE id=100");
  const r=await y.control(y.request('cancel',{expected_version:2,confirm:'cancel_both'}));assert.equal(r.body.error,'AB_V2_ALREADY_STARTED');assert.deepEqual((await y.states()).map(c=>c.status),['scheduled','scheduled']);
 }finally{await y.db.close();}
});
test('expired review, changed campaign version and premature measurement close remain defined non-mutating rejections',async()=>{
 const x=await setup();try{
  await x.setup();const r=await x.review();await x.enable();
  await x.db.exec("UPDATE crm_ab_review_v2 SET checked_at=checked_at-interval '10 minutes',expires_at=expires_at-interval '10 minutes'");
  assert.equal((await x.control(x.request('schedule',{review_id:r.body.review.review_id,confirm:'schedule_both'}))).body.error,'AB_V2_REVIEW_EXPIRED');
  await x.db.exec("UPDATE templates SET body='Changed dependency' WHERE id=1");
  assert.equal((await x.review()).body.error,'AB_V2_CAMPAIGN_VERSION');assert.deepEqual((await x.states()).map(c=>c.status),['draft','draft']);
  assert.equal((await x.control(x.request('close',{confirm:'close_measurement'}))).body.error,'AB_V2_WINDOW_OPEN');
 }finally{await x.db.close();}
});
