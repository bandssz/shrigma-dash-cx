'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg'),{randomUUID}=require('node:crypto');
const {setupWorkerLease}=require('./segment-regular-worker-lease-fixture.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString:uri,max:4,statement_timeout:10000});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{try{
 assert.equal((await pool.query("SELECT current_setting('server_version_num') AS v")).rows[0].v,'170010');
 const f=await setupWorkerLease(pool);await f.approve();await f.enable();
 const a=await pool.connect(),b=await pool.connect();
 try{
  const heartbeat='SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) AS result';
  const ids=[f.instance,randomUUID()];
  const competing=await Promise.all([a,b].map((c,i)=>c.query(heartbeat,[ids[i],f.worker,f.runtime])));
  assert.equal(competing.filter(r=>r.rows[0].result.ready).length,1);
  assert.equal(competing.filter(r=>r.rows[0].result.reason==='competing_instance').length,1);
  assert.equal((await f.lease()).suspended,true);
  assert.equal((await pool.query('SELECT enabled FROM crm_audience_v2.selection_runtime')).rows[0].enabled,false);
  // Only the fixture administrator can clear a detected collision. Heartbeat
  // itself never repairs or overwrites suspended lease state.
  await pool.query('DELETE FROM crm_audience_v2.regular_worker_lease');
  const renewed=await Promise.all([a,b].map(c=>c.query(heartbeat,[f.instance,f.worker,f.runtime])));
  assert.ok(renewed.every(r=>r.rows[0].result.ready));
  const [sub]=await f.batch(100),snapshot=await f.snapshot(sub.id);
  await pool.query("UPDATE crm_audience_v2.regular_worker_lease SET heartbeat_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '200 milliseconds'");
  await a.query('BEGIN');await a.query('SELECT 1 FROM subscriber_lists WHERE subscriber_id=$1 FOR UPDATE',[sub.id]);
  let done=false;
  const blocked=b.query('SELECT crm_audience_v2.regular_delivery_claim_live($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb,$11)',
   [f.instance,100,sub.id,randomUUID(),f.worker,f.runtime,'sender@example.invalid',snapshot.email,'c'.repeat(64),JSON.stringify(snapshot),'fixture'])
   .then(()=>{throw Error('LEASE_SHOULD_EXPIRE');},e=>e).finally(()=>{done=true;});
  await pause(80);assert.equal(done,false);await pause(210);await a.query('COMMIT');
  const expired=await blocked;assert.equal(expired.code,'55000');assert.match(expired.message,/SEGMENT_WORKER_LEASE_EXPIRED/);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM shrigma_email_dispatch')).rows[0].n,0);
  assert.deepEqual(await f.state(100),{sent:0,last_subscriber_id:0});
  await f.heartbeat();const grant=await f.liveClaim(100,sub.id);assert.equal(grant.should_send,true);
  await f.finish(100,sub.id,grant);assert.deepEqual(await f.state(100),{sent:1,last_subscriber_id:sub.id});
  await a.query('CREATE ROLE unrelated_worker NOLOGIN');
  await a.query('SET SESSION AUTHORIZATION unrelated_worker');
  await assert.rejects(a.query(heartbeat,[randomUUID(),f.worker,f.runtime]),e=>e.code==='42501');
  await a.query('RESET SESSION AUTHORIZATION');
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
 console.log(JSON.stringify({postgres:'17.10',competing_instances_suspend:true,same_instance_concurrent_renewal:true,lease_expiry_after_wait_rolls_back_receipt:true,renewal_allows_approved_process:true,public_execution_denied:true,production_authority_proven:false,sends:0,remote_hosts:0}));
}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
