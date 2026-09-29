'use strict';
// Opt-in PostgreSQL17.10 proof. Never accepts a remote or default-port database.
const assert=require('node:assert/strict'),{Pool}=require('pg'),{randomUUID}=require('node:crypto');
const {setupRegularDelivery}=require('./segment-regular-delivery-fixture.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString:uri,max:4,statement_timeout:10000});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const claimSQL='SELECT crm_audience_v2.regular_delivery_claim($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS result';
(async()=>{try{
 assert.equal((await pool.query("SELECT current_setting('server_version_num') AS v")).rows[0].v,'170010');
 const f=await setupRegularDelivery(pool);await f.enable();
 const a=await pool.connect(),b=await pool.connect();
 try{
  for(const cid of [100,200]){
   const [first,next]=await f.batch(cid),snapshot=await f.snapshot(first.id);
   const args=()=>[cid,first.id,randomUUID(),'a'.repeat(64),'b'.repeat(64),'sender@example.invalid',snapshot.email,'c'.repeat(64),JSON.stringify(snapshot)];
   const results=await Promise.all([a.query(claimSQL,args()),b.query(claimSQL,args())]);
   const grants=results.map(r=>r.rows[0].result);assert.equal(grants.filter(r=>r.should_send).length,1);
   assert.equal(grants.find(r=>!r.should_send).reason,'in_flight');
   const grant=grants.find(r=>r.should_send);assert.deepEqual(await f.state(cid),{sent:0,last_subscriber_id:0});
   await assert.rejects(f.claim(cid,next.id),/RECONCILIATION_REQUIRED/);
   const finishSQL='SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3,$4,$5) AS result';
   const finishArgs=[cid,first.id,grant.dispatch_id,grant.claim_token,'accepted'];
   await Promise.all([a.query(finishSQL,finishArgs),b.query(finishSQL,finishArgs)]);
   assert.deepEqual(await f.state(cid),{sent:1,last_subscriber_id:first.id});
   assert.equal((await f.claim(cid,first.id)).reason,'accepted','response loss/restart cannot reserve again');
  }
  // Selection precedes an opt-out committed on an independent connection.
  const candidates=await f.batch(100),sid=candidates[1].id,snapshot=await f.snapshot(sid);
  await a.query('BEGIN');await a.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=17",[sid]);
  let completed=false;const waiting=b.query(claimSQL,[100,sid,randomUUID(),'a'.repeat(64),'b'.repeat(64),'sender@example.invalid',snapshot.email,'c'.repeat(64),JSON.stringify(snapshot)]).finally(()=>{completed=true;});
  await pause(80);assert.equal(completed,false);await a.query('COMMIT');
  assert.equal((await waiting).rows[0].result.reason,'ineligible');
  assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:sid});
  // Catalog expires while the claim waits on a subscriber-membership lock.
  const target=candidates[2].id,snap2=await f.snapshot(target);
  await pool.query("UPDATE crm_audience_v2.config SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE brand='fish'");
  await a.query('BEGIN');await a.query('SELECT 1 FROM subscriber_lists WHERE subscriber_id=$1 FOR UPDATE',[target]);
  const expired=b.query(claimSQL,[100,target,randomUUID(),'a'.repeat(64),'b'.repeat(64),'sender@example.invalid',snap2.email,'c'.repeat(64),JSON.stringify(snap2)]).then(()=>{throw Error('CLAIM_SHOULD_EXPIRE');},e=>e);
  await pause(280);await a.query('COMMIT');assert.equal((await expired).code,'55000');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM shrigma_email_dispatch')).rows[0].n,2);
  assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:sid});
  await pool.query(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":300,"status":"scheduled"}'::jsonb)).* FROM campaigns c WHERE id=100;
   INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(300,17,'Legacy');`);
  const isolated=(await pool.query("SELECT crm_audience_v2.regular_delivery_quarantine('{}') AS result")).rows[0].result;
  assert.deepEqual(isolated,[{campaign_id:100,reason:'source_unavailable'}]);
  const P=require('../n8n/growth/segment-listmonk-selection.cjs');
  const rows=(await pool.query(P.section(f.worker.source,'next-campaigns').text,[[],[]])).rows;
  assert.deepEqual(rows.map(r=>r.id).sort(),[200,300]);
  assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:sid});
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
 console.log(JSON.stringify({postgres:'17.10',brands:['fish','aristo'],concurrent_claim_one_winner:true,concurrent_finish_one_increment:true,lost_response_no_replay:true,optout_after_wait:true,catalog_expiry_after_wait:true,unready_bound_isolated_from_legacy_scan:true,production_authority_proven:false,sends:0,remote_hosts:0}));
}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
