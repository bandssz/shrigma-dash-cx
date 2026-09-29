'use strict';
// Real pinned queries and selector. Structural fixture only: the production
// draft-only binding guard is not replaced or admitted by these tests.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const P=require('../n8n/growth/segment-listmonk-selection.cjs');
const {setupRegularPostgres}=require('./segment-listmonk-selection-regular-postgres-fixture.cjs');
async function setup(){
 const db=new PGlite();
 try{
  const fixture=await setupRegularPostgres(db,{subscribersPerBrand:120});
  const worker=P.patchRegularWorkerSource(fixture.source);
  await db.query('UPDATE crm_audience_v2.selection_runtime SET candidate_query_sha256=$1',[worker.patched_sha256]);
  const query=(name,params)=>db.query(P.section(worker.source,name).text,params);
  await query('next-campaigns',[[],[]]);
  return {db,fixture,worker,query,
   batch:cid=>query('next-campaign-subscribers',[cid,'regular',0,240,[cid===100?17:16],4]),
   state:cid=>db.query('SELECT sent,last_subscriber_id,updated_at FROM campaigns WHERE id=$1',[cid]).then(r=>r.rows[0])};
 }catch(e){await db.close();throw e;}
}
test('bound selection and repeated reads never acknowledge a recipient',async()=>{
 const x=await setup();try{
  assert.equal(x.worker.patched_sha256,'3dc9433187c4ee16f0516503c6cc3efae63e9a607f9a15748e52a43217c6f7de');
  assert.equal(x.worker.requires_durable_finish,true);assert.equal(x.worker.authorizes_send,false);
  for(const cid of [100,200]){
   const before=await x.state(cid),first=await x.batch(cid),again=await x.batch(cid);
   assert.equal(first.rows.length,4);assert.deepEqual(again.rows,first.rows);
   assert.deepEqual(await x.state(cid),before,'a process crash after selection loses no checkpoint');
   await x.query('next-campaigns',[[cid],[999]]);
   assert.deepEqual(await x.state(cid),before,'periodic legacy counters cannot duplicate durable finishes');
   await x.query('update-campaign-counts',[cid,999,999,240]);
   assert.deepEqual(await x.state(cid),before,'cleanup cannot overwrite the durable checkpoint');
  }
 }finally{await x.db.close();}
});
test('worker pin is separate and fresh consent distinguishes opt-out from source failure',async()=>{
 const x=await setup();try{
  for(const [cid,base]of [[100,17],[200,16]]){
   const sid=(await x.batch(cid)).rows[0].id;
   const allowed=()=>x.db.query('SELECT crm_audience_v2.selection_worker_allowed($1,$2) AS allowed',[cid,sid]);
   assert.equal((await allowed()).rows[0].allowed,true);
   await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=$2",[sid,base]);
   assert.equal((await allowed()).rows[0].allowed,false,'consent reread after native selection');
   await x.db.query('UPDATE crm_audience_v2.selection_runtime SET enabled=false');
   await assert.rejects(allowed(),e=>e.code==='55000');
   await x.db.query('UPDATE crm_audience_v2.selection_runtime SET enabled=true');
  }
  await x.db.query('UPDATE crm_audience_v2.selection_runtime SET candidate_query_sha256=$1',[x.fixture.regular.patched_sha256]);
  await assert.rejects(x.batch(100),e=>e.code==='55000');
 }finally{await x.db.close();}
});
test('unbound native cursor and counters keep upstream behavior',async()=>{
 const x=await setup();try{
  await x.db.exec(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":300}'::jsonb)).* FROM campaigns c WHERE id=100;
   INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(300,17,'Legacy');`);
  const params=[300,'regular',0,240,[17],4];
  const first=await x.query('next-campaign-subscribers',params);
  assert.equal((await x.state(300)).last_subscriber_id,Math.max(...first.rows.map(s=>s.id)));
  await x.query('next-campaigns',[[300],[2]]);assert.equal((await x.state(300)).sent,2);
  await x.query('update-campaign-counts',[300,0,3,9]);
  const final=await x.state(300);assert.equal(final.sent,5);assert.equal(final.last_subscriber_id,9);
 }finally{await x.db.close();}
});
