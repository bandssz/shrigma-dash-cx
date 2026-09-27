'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,read}=require('./ab-experiment-fixture.cjs');
const {insertPredicate,patchSource}=require('../n8n/growth/ab-listmonk-cohort-patch.cjs');
// Small authored selection fixtures. A separate private proof executes the full,
// SHA-pinned upstream count/batch queries, including their native checkpoints.
const count=`WITH camps AS (SELECT * FROM campaigns),
campLists AS (
 SELECT cl.campaign_id,l.id list_id,l.optin FROM campaign_lists cl JOIN lists l ON l.id=cl.list_id
),
counts AS (
 SELECT camps.id,count(DISTINCT sl.subscriber_id)::int n,coalesce(max(sl.subscriber_id),0) max_id
 FROM camps JOIN campLists cl ON cl.campaign_id=camps.id
 JOIN subscriber_lists sl ON sl.list_id=cl.list_id AND (
 CASE WHEN camps.type='optin' THEN sl.status='unconfirmed' AND cl.optin='double'
 WHEN cl.optin='double' THEN sl.status='confirmed' ELSE sl.status!='unsubscribed' END)
 JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')
 GROUP BY camps.id
)
SELECT * FROM counts ORDER BY id`;
const oldCount=q=>q.replace("JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')",
 "JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted' AND (camps.id NOT IN (SELECT campaign_id FROM public.crm_ab_arm_v2) OR public.crm_ab_delivery_allowed_v2(camps.id, s.id)))");
const enable=`UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9',verified_at=now();
 UPDATE crm_ab_experiment_v2 SET state='scheduled',window_start=now(),window_end=now()+interval '1 day',transport_bound=true,tracking_continuous=true`;

const batch=`SELECT DISTINCT s.id FROM subscriber_lists sl JOIN lists l ON l.id=sl.list_id JOIN campaign_lists cl ON cl.list_id=l.id
 JOIN subscribers s ON s.id=sl.subscriber_id WHERE cl.campaign_id=$1 AND s.id>$2 AND s.id<=$3
 AND s.status != 'blocklisted' AND ((l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status!='unsubscribed')) ORDER BY s.id LIMIT $4`;
test('native predicate is an added AND; count, batch, optout, blocklist, pagination and non-AB stay consistent',async()=>{
 const x=await fixture();try{
  const p=await x.protocol();await x.prepare(p);await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  const c=insertPredicate(count,{phase:'count'}),b=insertPredicate(batch,{phase:'batch'});
  assert.equal((await x.db.query(c)).rows.some(r=>r.id===100),false,'runtime OFF denies A/B');
  await x.db.exec(`UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9',verified_at=now();
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
   await x.db.exec(`UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9',verified_at=now();
    UPDATE crm_ab_experiment_v2 SET state='scheduled',transport_bound=true,tracking_continuous=true,window_start=now()-interval '1 hour',window_end=now()+interval '23 hours';
    SELECT set_config('shrigma.ab_schedule_v2','${p.test_id}',false);UPDATE campaigns SET status='running' WHERE id IN(100,101);SELECT set_config('shrigma.ab_schedule_v2','',false);
    UPDATE campaigns SET sent=500,status='finished' WHERE id=100;UPDATE crm_ab_runtime_v2 SET ${change};UPDATE campaigns SET sent=0,status='finished' WHERE id=101;
    INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) SELECT 100,subscriber_id,now() FROM crm_ab_member_v2 WHERE arm='a' LIMIT 50;`);
   assert.equal((await x.measure()).integrity.transport_continuous,false,change);
   await x.db.exec("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9',verified_at=now()");
   const m=await x.measure();m.as_of=m.window_end;assert.equal(C.result(p,m).status,'unknown',change+' remains unknown after ON');
  }finally{await x.db.close();}
 }
 const x=await fixture();try{
  await x.prepare(await x.protocol());await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  await x.db.exec(`UPDATE crm_ab_experiment_v2 SET state='scheduled',transport_bound=true,tracking_continuous=true,window_start=now(),window_end=now()+interval '1 day';
   UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9',verified_at=now();
   SELECT set_config('shrigma.ab_schedule_v2',(SELECT test_id::text FROM crm_ab_experiment_v2),false);UPDATE campaigns SET status='running' WHERE id IN(100,101);SELECT set_config('shrigma.ab_schedule_v2','',false);
   UPDATE campaigns SET status='paused' WHERE id=100;`);
  assert.equal((await x.measure()).integrity.transport_continuous,false,'native pause records interruption without changing legitimate optouts');
 }finally{await x.db.close();}
});

test('set count equals the original per-member gate across runtime, campaign and individual invalidations',async()=>{
 const x=await fixture();try{
  await x.prepare(await x.protocol());await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));await x.db.exec(enable);
  const first=(await x.db.query("SELECT min(subscriber_id)::int id FROM crm_ab_member_v2 WHERE arm='a'")).rows[0].id;
  const cases=[
   ['ready','SELECT 1'],['runtime_off','UPDATE crm_ab_runtime_v2 SET enabled=false'],
   ['runtime_missing','DELETE FROM crm_ab_runtime_v2'],['hash_invalid',"UPDATE crm_ab_runtime_v2 SET native_query_sha256=repeat('b',64)"],
   ['receipt_future',"UPDATE crm_ab_runtime_v2 SET verified_at=now()+interval '1 hour'"],
   ['receipt_infinite',"UPDATE crm_ab_runtime_v2 SET verified_at='infinity'"],
   ['receipt_negative_infinite',"UPDATE crm_ab_runtime_v2 SET verified_at='-infinity'"],
   ['receipt_absent','UPDATE crm_ab_runtime_v2 SET enabled=false,verified_at=NULL'],
   ...['prepared','cancelled','closed'].map(state=>['experiment_'+state,`UPDATE crm_ab_experiment_v2 SET state='${state}'`]),
   ['transport_unbound','UPDATE crm_ab_experiment_v2 SET transport_bound=false'],
   ['tracking_off','UPDATE crm_ab_experiment_v2 SET tracking_continuous=false'],
   ['source_incomplete','UPDATE crm_ab_experiment_v2 SET source_complete=false'],
   ['window_expired',"UPDATE crm_ab_experiment_v2 SET window_start=now()-interval '1 day',window_end=now()-interval '1 second'"],
   ['window_missing','UPDATE crm_ab_experiment_v2 SET window_start=NULL,window_end=NULL'],
   ['member_revoked',`UPDATE crm_ab_member_v2 SET revoked_at=now() WHERE subscriber_id=${first}`],
   ['member_disabled',`UPDATE subscribers SET status='disabled' WHERE id=${first}`],
   ['member_blocklisted',`UPDATE subscribers SET status='blocklisted' WHERE id=${first}`],
   ['representative_native_optout',`UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=${first} AND list_id IN(3,17)`],
   ['single_only_qualifies',"UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=5 AND list_id IN(3,17)"],
   ['double_unconfirmed_does_not_qualify',"UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=1000 AND list_id=3"],
   ['arm_no_members',"DELETE FROM crm_ab_member_v2 WHERE arm='a'"],
   ['arm_all_revoked',"UPDATE crm_ab_member_v2 SET revoked_at=now() WHERE arm='a'"],
   ['arm_all_disabled',"UPDATE subscribers SET status='disabled' WHERE id IN(SELECT subscriber_id FROM crm_ab_member_v2 WHERE arm='a')"],
   ['no_members','DELETE FROM crm_ab_member_v2'],
   ['native_optin_campaign',"UPDATE campaigns SET type='optin' WHERE id IN(200,201);UPDATE subscriber_lists SET status='unconfirmed' WHERE list_id=7 AND subscriber_id<=500"],
  ];
  for(const [name,mutation]of cases){
   await x.db.exec('BEGIN');try{
    await x.db.exec(mutation);
    const old=(await x.db.query(oldCount(count))).rows,optimized=(await x.db.query(insertPredicate(count,{phase:'count'}))).rows;
    assert.deepEqual(optimized,old,name);
    assert.deepEqual(optimized.filter(r=>r.id>=200),(await x.db.query(count)).rows.filter(r=>r.id>=200),name+': ordinary campaigns remain native');
    if(name==='representative_native_optout')assert.equal(optimized.find(r=>r.id===100).n,499,'native opt-out of probe must not suppress its other 499 peers');
    if(name==='arm_no_members'||name==='arm_all_revoked'||name==='arm_all_disabled')assert.equal(optimized.some(r=>r.id===100),false,'preserve absent count row, not an invented zero');
   }finally{await x.db.exec('ROLLBACK');}
  }
 }finally{await x.db.close();}
});

test('MATERIALIZED readiness calls the canonical gate at most once per admitted arm and zero times for ordinary campaigns',async()=>{
 const x=await fixture();try{
  await x.prepare(await x.protocol());await x.db.exec(read('n8n/growth/ab-experiment-selection.sql'));await x.db.exec(enable);
  await x.db.exec(`CREATE TABLE count_gate_calls(cid integer,sid integer);
   ALTER FUNCTION crm_ab_delivery_allowed_v2(integer,integer) RENAME TO count_canonical_gate;
   CREATE FUNCTION crm_ab_delivery_allowed_v2(cid integer,sid integer) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN
    INSERT INTO count_gate_calls VALUES(cid,sid);RETURN count_canonical_gate(cid,sid);END$$;`);
  for(const [name,filter,maxCalls]of [['mixed','',2],['only_a',' WHERE id=100',1],['ordinary_only',' WHERE id>=200',0]]){
   await x.db.exec('TRUNCATE count_gate_calls');
   const selected=count.replace('SELECT * FROM campaigns','SELECT * FROM campaigns'+filter);
   await x.db.query(insertPredicate(selected,{phase:'count'}));
   const calls=(await x.db.query('SELECT cid,count(*)::int n FROM count_gate_calls GROUP BY cid')).rows;
   assert.equal(calls.length,maxCalls,name);assert.ok(calls.every(r=>r.n===1&&[100,101].includes(r.cid)),name);
  }
  await x.db.exec("DELETE FROM crm_ab_member_v2 WHERE arm='a';TRUNCATE count_gate_calls");
  assert.equal((await x.db.query(insertPredicate(count,{phase:'count'}))).rows.some(r=>r.id===100),false);
  assert.deepEqual((await x.db.query('SELECT cid,count(*)::int n FROM count_gate_calls GROUP BY cid ORDER BY cid')).rows,[{cid:100,n:1},{cid:101,n:1}]);
  assert.equal((await x.db.query('SELECT sid FROM count_gate_calls WHERE cid=100')).rows[0].sid,null);
 }finally{await x.db.close();}
});

test('representative decomposition requires review if canonical per-member gates change; build receipt digest is excluded',()=>{
 const {createHash}=require('node:crypto');
 const source=read('n8n/growth/ab-experiment-selection.sql');
 const match=source.match(/CREATE FUNCTION public\.crm_ab_delivery_allowed_v2\(cid integer,sid integer\) RETURNS boolean([\s\S]*?)\$\$;/);
 assert.ok(match,'canonical function boundary');
 const normalized=match[1].replace(/[a-f0-9]{64}/g,'BUILD_RECEIPT_SHA').replace(/\s+/g,' ').trim();
 assert.equal(createHash('sha256').update(normalized).digest('hex'),'8f83ff0c9f379502ec24d315cb94eea8308ed65f44815a9fa26d31c752b77105',
  'Only membership of this arm + enabled + not revoked may vary by participant; changes require rechecking count decomposition');
});
