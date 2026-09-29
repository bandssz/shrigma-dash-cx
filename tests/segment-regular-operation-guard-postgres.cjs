'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg');
const {setupOperationGuard}=require('./segment-regular-operation-guard-fixture.cjs');
const Selection=require('../n8n/growth/segment-listmonk-selection.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString:uri,max:3,statement_timeout:10000});
(async()=>{const a=await pool.connect(),b=await pool.connect();try{
 assert.equal((await a.query("SELECT current_setting('server_version_num') AS v")).rows[0].v,'170010');
 const f=await setupOperationGuard(a);
 const metadata=async()=>(await a.query("SELECT oid,proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid='crm_audience_v2.campaign_send_guard()'::regprocedure")).rows[0];
 const bodyHash=async()=>(await a.query("SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid='crm_audience_v2.campaign_send_guard()'::regprocedure")).rows[0].hash;
 const before=await metadata(),originalHash=await bodyHash();
 await a.query('BEGIN');await f.install();assert.notEqual(await bodyHash(),originalHash);await a.query('ROLLBACK');
 assert.equal(await bodyHash(),originalHash);assert.deepEqual(await metadata(),before);
 await f.install();assert.deepEqual(await metadata(),before);
 await f.approve();await f.heartbeat();await f.enable();
 await f.schedule(100);await f.schedule(200);await f.scan();
 for(const cid of [100,200]){
  const [sub]=await f.batch(cid),base=cid===100?17:16;
  await assert.rejects(b.query(Selection.section(f.fixture.source,'next-campaign-subscribers').text,
   [cid,'regular',0,240,[base],10]),/RECEIPT_REQUIRED/);
  assert.deepEqual(await f.state(cid),{sent:0,last_subscriber_id:0});
  await a.query('BEGIN');const grant=await f.liveClaim(cid,sub.id);
  assert.equal((await b.query('SELECT count(*)::integer AS n FROM shrigma_email_dispatch WHERE dispatch_id=$1',[grant.dispatch_id])).rows[0].n,0);
  await a.query('COMMIT');
  const writes=await Promise.allSettled([
   f.finish(cid,sub.id,grant),
   b.query('UPDATE campaigns SET sent=sent+1 WHERE id=$1',[cid])
  ]);
  assert.equal(writes[0].status,'fulfilled');assert.equal(writes[1].status,'rejected');assert.match(writes[1].reason.message,/RECEIPT_REQUIRED/);
  assert.deepEqual(await f.state(cid),{sent:1,last_subscriber_id:sub.id});
  const privateState=(await b.query('SELECT acknowledged_sent AS sent,acknowledged_subscriber_id AS last_subscriber_id FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=$1',[cid])).rows[0];
  assert.deepEqual(privateState,await f.state(cid));
 }
 await b.query('UPDATE crm_audience_v2.regular_worker_deployment SET enabled=false');
 await b.query("UPDATE campaigns SET status='paused' WHERE id IN(100,200)");
 await assert.rejects(b.query("UPDATE campaigns SET status='scheduled' WHERE id=100"),/OPERATION_UNAVAILABLE/);
 console.log(JSON.stringify({postgres:'17.10',brands:['fish','aristo'],guard_install_rollback:true,function_identity_and_acl_preserved:true,unchanged_native_batch_blocked_before_rows:true,concurrent_native_increment_rejected:true,private_checkpoint_matches_receipts:true,stop_after_off:true,production_authority_proven:false,sends:0,remote_hosts:0}));
}finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
