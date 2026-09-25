'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),AB=require('../growth-ab-experiment-contract.js');
const {fixture}=require('./ab-experiment-fixture.cjs');
test('database freezes deduplicated disjoint cohort, exact half split, replay, brand scope and no native writes',async()=>{
 const x=await fixture();try{
  const before=(await x.db.query('SELECT to_jsonb(c) x FROM campaigns c ORDER BY id')).rows,p=await x.protocol(),r=await x.prepare(p);
  assert.deepEqual(r.arms.map(a=>a.allocated),[500,500]);assert.equal(r.transport_bound,false);assert.equal(r.state,'prepared');assert.deepEqual(await x.prepare(p),r);
  const receipt=(await x.db.query('SELECT crm_ab_operation_v2($1,$2) x',['panel:synthetic','00000000-0000-4000-8000-000000000101'])).rows[0].x;
  assert.equal(receipt.state,'completed');assert.deepEqual(receipt.response,r);assert.deepEqual(receipt.request_payload,p);
  assert.equal((await x.db.query('SELECT crm_ab_operation_v2($1,$2) x',['panel:other','00000000-0000-4000-8000-000000000101'])).rows[0].x.state,'missing');
  assert.deepEqual((await x.db.query('SELECT to_jsonb(c) x FROM campaigns c ORDER BY id')).rows,before);
  assert.equal((await x.db.query('SELECT count(DISTINCT subscriber_id)::int n FROM crm_ab_member_v2')).rows[0].n,1000);
  assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_member_v2 WHERE subscriber_id>1000')).rows[0].n,0);
  assert.doesNotMatch(JSON.stringify(r),/subscriber_id|source_list_ids|seed/);
  await assert.rejects(x.prepare(p,102),/AB_V2_ACTIVE_EXISTS/);await assert.rejects(x.prepare({...p,name:'Changed'}),/AB_V2_IDENTITY/);await assert.rejects(x.prepare(p,101,'panel:other'),/AB_V2_IDENTITY/);
  const other=await x.protocol('aristo',2);assert.equal((await x.prepare(other,103)).brand,'aristo');
  assert.equal(AB.result(p,await x.measure()).status,'unknown');
  await x.db.exec('CREATE ROLE untrusted;SET ROLE untrusted');await assert.rejects(x.measure(),/permission denied/);await x.db.exec('RESET ROLE');
 }finally{await x.db.close();}
});
test('native counts use distinct matching assigned IDs and fixed window; missing/cross-arm data stays unknown',async()=>{
 const x=await fixture();try{
  const p=await x.protocol();await x.prepare(p);
  await x.db.exec(`UPDATE crm_ab_experiment_v2 SET state='scheduled',window_start=now()-interval '25 hours',window_end=now()-interval '1 hour',transport_bound=true,tracking_continuous=true;
   UPDATE campaigns SET status='finished',sent=500 WHERE id IN (100,101);UPDATE crm_ab_arm_v2 SET finished_at=now()-interval '2 hours';
   INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) SELECT 100,subscriber_id,now()-interval '2 hours' FROM crm_ab_member_v2 WHERE arm='a' LIMIT 10;
   INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) SELECT 101,subscriber_id,now()-interval '2 hours' FROM crm_ab_member_v2 WHERE arm='b' LIMIT 200;
   INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) SELECT 101,subscriber_id,now()-interval '2 hours' FROM crm_ab_member_v2 WHERE arm='b' LIMIT 200;
   INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) SELECT 100,subscriber_id,now()-interval '30 hours' FROM crm_ab_member_v2 WHERE arm='a' LIMIT 100;`);
  let s=await x.measure();assert.deepEqual(s.arms.map(a=>a.unique_clickers),[10,200]);assert.equal(AB.result(p,s).winner,'b');
  await x.db.exec(`INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) SELECT 100,subscriber_id,now()-interval '2 hours' FROM crm_ab_member_v2 WHERE arm='b' LIMIT 1`);
  assert.equal(AB.result(p,await x.measure()).status,'unknown');
  await x.db.exec('DELETE FROM link_clicks WHERE id=(SELECT max(id) FROM link_clicks)');
  await x.db.exec(`INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) VALUES(100,NULL,now()-interval '2 hours')`);assert.equal(AB.result(p,await x.measure()).status,'unknown');
  await x.db.exec('DELETE FROM link_clicks WHERE subscriber_id IS NULL;DELETE FROM subscribers WHERE id=1');s=await x.measure();assert.equal(s.arms[0].allocated+s.arms[1].allocated,1000);assert.equal(s.arms[0].unknown+s.arms[1].unknown,1);assert.equal(AB.result(p,s).status,'unknown');
 }finally{await x.db.close();}
});
test('version, disabled recipients, different audience and insufficient size fail before allocation',async()=>{
 const x=await fixture();try{
  let p=await x.protocol();await x.db.exec("UPDATE campaigns SET subject='Changed' WHERE id=100");await assert.rejects(x.prepare(p),/AB_V2_CAMPAIGN_VERSION/);
  p=await x.protocol();await x.db.exec("UPDATE subscribers SET status='disabled' WHERE id=1");await assert.rejects(x.prepare(p),/AB_V2_DISABLED_SUBSCRIBERS/);
  await x.db.exec("UPDATE subscribers SET status='enabled' WHERE id=1;DELETE FROM campaign_lists WHERE campaign_id=101 AND list_id=17");p=await x.protocol();await assert.rejects(x.prepare(p),/AB_V2_AUDIENCE_DIFFERS/);
  await x.db.exec("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(101,17,'Base Fish')");p=await x.protocol();p.rule.minimum_per_arm=501;await assert.rejects(x.prepare(p),/AB_V2_MINIMUM_NOT_REACHED/);
  assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_member_v2')).rows[0].n,0);assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_action_v2')).rows[0].n,0);
 }finally{await x.db.close();}
});
