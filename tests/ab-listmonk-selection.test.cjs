'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,read}=require('./ab-experiment-fixture.cjs');
const {insertPredicate,patchSource}=require('../n8n/growth/ab-listmonk-cohort-patch.cjs');
// Small authored selection fixtures. A separate private proof executes the full,
// SHA-pinned upstream count/batch queries, including their native checkpoints.
const count=`SELECT camps.id,count(DISTINCT sl.subscriber_id)::int n FROM campaigns camps
 JOIN campaign_lists cl ON cl.campaign_id=camps.id JOIN lists l ON l.id=cl.list_id
 JOIN subscriber_lists sl ON sl.list_id=l.id
 JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')
 WHERE (l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status!='unsubscribed') GROUP BY camps.id ORDER BY camps.id`;
const batch=`SELECT DISTINCT s.id FROM subscriber_lists sl JOIN lists l ON l.id=sl.list_id JOIN campaign_lists cl ON cl.list_id=l.id
 JOIN subscribers s ON s.id=sl.subscriber_id WHERE cl.campaign_id=$1 AND s.id>$2 AND s.id<=$3
 AND s.status != 'blocklisted' AND ((l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status!='unsubscribed')) ORDER BY s.id LIMIT $4`;
test('native predicate is an added AND; count, batch, optout, blocklist, pagination and non-AB stay consistent',async()=>{
 const x=await fixture();try{
  const p=await x.protocol();await x.prepare(p);await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  const c=insertPredicate(count,{phase:'count'}),b=insertPredicate(batch,{phase:'batch'});
  assert.equal((await x.db.query(c)).rows.some(r=>r.id===100),false,'runtime OFF denies A/B');
  await x.db.exec(`UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817',verified_at=now();
   UPDATE crm_ab_experiment_v2 SET state='scheduled',window_start=now(),window_end=now()+interval '1 day',transport_bound=true,tracking_continuous=true`);
  assert.deepEqual((await x.db.query(c)).rows.filter(r=>r.id===100||r.id===101).map(r=>r.n),[500,500]);
  const ids=[];let cursor=0;for(;;){const rows=(await x.db.query(b,[100,cursor,1000,37])).rows;if(!rows.length)break;ids.push(...rows.map(r=>r.id));cursor=rows.at(-1).id;}
  assert.equal(ids.length,500);assert.equal(new Set(ids).size,500);
  const other=(await x.db.query(b,[101,0,1000,1000])).rows.map(r=>r.id);assert.equal(ids.filter(id=>other.includes(id)).length,0);
  const victim=ids[0];await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id IN(3,17)",[victim]);
  assert.equal((await x.db.query(b,[100,0,1000,1000])).rows.some(r=>r.id===victim),false,'source optout immediately affects the next native batch, no derived lists');
  await x.db.query("UPDATE subscribers SET status='blocklisted' WHERE id=$1",[ids[1]]);assert.equal((await x.db.query(b,[100,0,1000,1000])).rows.length,498);
  await x.db.query("UPDATE subscribers SET status='disabled' WHERE id=$1",[ids[2]]);assert.equal((await x.db.query(b,[100,0,1000,1000])).rows.length,497,'A/B also suppresses contacts disabled after scheduling');
  const nativeOther=(await x.db.query(batch,[200,0,1000,1000])).rows;assert.deepEqual((await x.db.query(b,[200,0,1000,1000])).rows,nativeOther);
  // Prove per-member predicate is short-circuited for unrelated campaigns.
  await x.db.exec(`ALTER FUNCTION crm_ab_delivery_allowed_v2(integer,integer) RENAME TO real_allow;
   CREATE FUNCTION crm_ab_delivery_allowed_v2(cid integer,sid integer) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN
    IF cid NOT IN (100,101) THEN RAISE EXCEPTION 'NON_AB_PER_ROW_CALL';END IF;RETURN real_allow(cid,sid);END $$;`);
  assert.deepEqual((await x.db.query(b,[200,0,1000,1000])).rows,nativeOther);await x.db.query(c);
 }finally{await x.db.close();}
});
test('A/B attachment freezes content/lists and blocks campaign-editor or native draft scheduling',async()=>{
 const x=await fixture();try{
  await x.prepare(await x.protocol());await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  for(const sql of ["UPDATE campaigns SET status='scheduled' WHERE id=100","UPDATE campaigns SET subject='edit' WHERE id=101","DELETE FROM campaign_lists WHERE campaign_id=100","INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(101,7,'wrong brand')","DELETE FROM campaigns WHERE id=100"]){await assert.rejects(x.db.exec(sql),/AB_V2_/);}
  await x.db.exec("UPDATE campaigns SET subject='ordinary campaign remains editable' WHERE id=200");
  await x.db.exec("SELECT set_config('shrigma.campaign_writer','100',false)");await assert.rejects(x.db.exec("UPDATE campaigns SET status='scheduled' WHERE id=100"),/AB_V2_SCHEDULE_REQUIRED/);
  assert.equal((await x.db.query('SELECT enabled FROM crm_ab_runtime_v2')).rows[0].enabled,false);
 }finally{await x.db.close();}
});
test('lost click evidence or changed tracking settings cannot become a measured zero',async()=>{
 const x=await fixture();try{
  await x.prepare(await x.protocol());await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  await x.db.exec(`UPDATE crm_ab_experiment_v2 SET state='scheduled',window_start=now()-interval '1 hour',window_end=now()+interval '23 hours',tracking_continuous=true;
   INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) SELECT 100,subscriber_id,now() FROM crm_ab_member_v2 WHERE arm='a' LIMIT 1;`);
  assert.equal((await x.measure()).integrity.source_complete,true);
  await x.db.exec('DELETE FROM link_clicks WHERE campaign_id=100');assert.equal((await x.measure()).integrity.source_complete,false);
  await x.db.exec("UPDATE settings SET value='true' WHERE key='privacy.disable_tracking'");
  assert.equal((await x.measure()).integrity.tracking_continuous,false);
  await x.db.exec("UPDATE settings SET value='false' WHERE key='privacy.disable_tracking'");
  assert.equal((await x.measure()).integrity.tracking_continuous,false,'restoring current tracking does not erase the gap');
 }finally{await x.db.close();}
});
test('patch refuses unknown upstream or duplicate/missing anchors',()=>{
 assert.throws(()=>patchSource('unknown source'),/SOURCE_DRIFT/);
 assert.throws(()=>insertPredicate(batch+' '+batch,{phase:'batch'}),/ANCHOR/);
 assert.throws(()=>insertPredicate('SELECT 1',{phase:'count'}),/ANCHOR/);
 assert.throws(()=>insertPredicate(batch,{phase:'other'}),/PHASE/);
});
test('runtime interruptions remain durable after ON; invalid hash/receipt and native pause cannot invent a winner',async()=>{
 const C=require('../growth-ab-experiment-contract.js');
 for(const change of ["enabled=false","native_query_sha256=repeat('b',64)","verified_at=now()+interval '1 hour'","verified_at='-infinity'",'enabled=false,verified_at=NULL']){
  const x=await fixture();try{
   const p=await x.protocol();await x.prepare(p);await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
   await x.db.exec(`UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817',verified_at=now();
    UPDATE crm_ab_experiment_v2 SET state='scheduled',transport_bound=true,tracking_continuous=true,window_start=now()-interval '1 hour',window_end=now()+interval '23 hours';
    SELECT set_config('shrigma.ab_schedule_v2','${p.test_id}',false);UPDATE campaigns SET status='running' WHERE id IN(100,101);SELECT set_config('shrigma.ab_schedule_v2','',false);
    UPDATE campaigns SET sent=500,status='finished' WHERE id=100;UPDATE crm_ab_runtime_v2 SET ${change};UPDATE campaigns SET sent=0,status='finished' WHERE id=101;
    INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) SELECT 100,subscriber_id,now() FROM crm_ab_member_v2 WHERE arm='a' LIMIT 50;`);
   assert.equal((await x.measure()).integrity.transport_continuous,false,change);
   await x.db.exec("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817',verified_at=now()");
   const m=await x.measure();m.as_of=m.window_end;assert.equal(C.result(p,m).status,'unknown',change+' remains unknown after ON');
  }finally{await x.db.close();}
 }
 const x=await fixture();try{
  await x.prepare(await x.protocol());await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  await x.db.exec(`UPDATE crm_ab_experiment_v2 SET state='scheduled',transport_bound=true,tracking_continuous=true,window_start=now(),window_end=now()+interval '1 day';
   UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817',verified_at=now();
   SELECT set_config('shrigma.ab_schedule_v2',(SELECT test_id::text FROM crm_ab_experiment_v2),false);UPDATE campaigns SET status='running' WHERE id IN(100,101);SELECT set_config('shrigma.ab_schedule_v2','',false);
   UPDATE campaigns SET status='paused' WHERE id=100;`);
  assert.equal((await x.measure()).integrity.transport_continuous,false,'native pause records interruption without changing legitimate optouts');
 }finally{await x.db.close();}
});
