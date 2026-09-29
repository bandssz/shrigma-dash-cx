'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const upstream=process.env.AB_UPSTREAM_SOURCE||path.resolve(__dirname,'../../../runtime/crm-audit-20260924/ab-controls/listmonk-v6.1.0-campaigns.sql');
const options={skip:fs.existsSync(upstream)?false:'Requires the locally cached pinned native query; never downloads.'};
const {setupRegularPostgres}=require('./segment-listmonk-selection-regular-postgres-fixture.cjs');
async function fixture(t){
 const pg=new PGlite();t.after(()=>pg.close());
 const db={query:async(sql,params)=>params?.length?pg.query(sql,params):(await pg.exec(sql)).at(-1)||{rows:[]}};
 const f=await setupRegularPostgres(db,{subscribersPerBrand:24});await f.reset();
 const state=async()=>(await db.query('SELECT id,status,sent,to_send,max_subscriber_id,last_subscriber_id,started_at,updated_at FROM campaigns ORDER BY id')).rows;
 return {...f,db,state};
}
for(const [name,sql] of [
 ['runtime pin mismatch',"UPDATE crm_audience_v2.selection_runtime SET candidate_query_sha256=repeat('f',64)"],
 ['expired runtime attestation',"UPDATE crm_audience_v2.selection_runtime SET verified_at=clock_timestamp()-interval '6 minutes'"],
 ['future runtime attestation',"UPDATE crm_audience_v2.selection_runtime SET verified_at=clock_timestamp()+interval '1 minute'"],
 ['expired source catalog',"UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '1 minute'"],
 ['changed consent semantics',"UPDATE lists SET optin=CASE WHEN optin='single' THEN 'double' ELSE 'single' END WHERE id IN(17,16)"],
 ['archived audience',"UPDATE crm_audience_v2.audience SET archived=true"],
 ['corrupt immutable binding',"UPDATE crm_audience_v2.campaign_binding SET binding_hash=repeat('0',64)"]
]) test('regular selection refuses '+name+' without advancing either campaign, including empty batches',options,async t=>{
 const f=await fixture(t);await f.db.query(sql);const before=await f.state();
 await assert.rejects(f.count(),e=>e.code==='55000'&&/SEGMENT_SELECTION_UNAVAILABLE/.test(e.message));
 for(const cid of [100,200])await assert.rejects(f.batch(cid,{cursor:999999,max:999999}),e=>e.code==='55000'&&/SEGMENT_SELECTION_UNAVAILABLE/.test(e.message));
 assert.deepEqual(await f.state(),before);
});
test('regular selection rechecks actual opt-out and distinguishes it from unavailable data',options,async t=>{
 const f=await fixture(t);await f.count();
 assert.ok((await f.batch(100)).rows.some(x=>x.id===12));assert.ok((await f.batch(200)).rows.some(x=>x.id===28));
 await f.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE (subscriber_id=12 AND list_id=17) OR (subscriber_id=28 AND list_id=16)");
 assert.equal((await f.db.query('SELECT crm_audience_v2.selection_regular_ready(100) AND crm_audience_v2.selection_regular_ready(200) AS ready')).rows[0].ready,true);
 assert.ok(!(await f.batch(100)).rows.some(x=>x.id===12));assert.ok(!(await f.batch(200)).rows.some(x=>x.id===28));
});
for(const status of ['draft','paused','cancelled','finished','scheduled'])test('bound '+status+' campaign cannot advance in a stale batch request',options,async t=>{
 const f=await fixture(t);await f.count();
 // Models the running-metadata read preceding a concurrent status change.
 await f.db.query('UPDATE campaigns SET status=$1 WHERE id IN(100,200)',[status]);
 const before=await f.state();
 for(const cid of [100,200])assert.deepEqual((await f.batch(cid)).rows,[]);
 assert.deepEqual(await f.state(),before);
});
test('inactive or already-processing campaigns never cause a readiness error in native campaign scan',options,async t=>{
 const f=await fixture(t);
 await f.db.query('UPDATE crm_audience_v2.selection_runtime SET enabled=false');
 for(const status of ['draft','paused','cancelled','finished']){
  await f.db.query('UPDATE campaigns SET status=$1',[status]);const before=await f.state();
  assert.deepEqual((await f.count()).rows,[]);assert.deepEqual(await f.state(),before);
 }
 await f.db.query("UPDATE campaigns SET status='scheduled',send_at=clock_timestamp()+interval '1 hour'");
 assert.deepEqual((await f.count()).rows,[]);
 await f.db.query("UPDATE campaigns SET status='running'");
 assert.deepEqual((await f.db.query(f.countSQL,[[100,200],[0,0]])).rows,[]);
});
