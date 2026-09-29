'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg');
const {setupRecovery,one}=require('./segment-regular-recovery-fixture.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString:uri,max:4,statement_timeout:10000});
(async()=>{try{
 assert.equal((await one(pool,"SELECT current_setting('server_version_num') v")).v,'170010');
 assert.equal((await one(pool,"SELECT count(*)::integer n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).n,0);
 const f=await setupRecovery(pool,{realCrypto:true});
 const a=await pool.connect(),b=await pool.connect();
 try{
  for(const [cid,state]of [[100,'in_flight'],[200,'outcome_unknown']]){
   const s=await f.seed(cid,state),before=await f.state(cid);
   assert.equal((await f.recover(s)).result,'would_reconcile');assert.deepEqual(await f.state(cid),before);
   const query='SELECT crm_audience_v2.regular_delivery_recover($1,$2,$3,false) result',args=[cid,s.sid,s.id];
   const results=await Promise.all([a.query(query,args),b.query(query,args)]);
   assert.deepEqual(results.map(r=>r.rows[0].result.result).sort(),['already_reconciled','reconciled']);
   assert.deepEqual(await f.state(cid),{sent:1,last_subscriber_id:s.sid});
   assert.equal((await one(pool,'SELECT suspended FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=$1',[cid])).suspended,true);
   await assert.rejects(f.claim(cid,s.sid),/UNAVAILABLE/);
   await pool.query("UPDATE shrigma_email_queue_receipt SET body_raw=body_raw||' ' WHERE ingest_id IN(SELECT first_ingest_id FROM shrigma_email_status WHERE dispatch_id=$1)",[s.id]);
   await assert.rejects(f.recover(s,false),/ARCHIVE/);assert.deepEqual(await f.state(cid),{sent:1,last_subscriber_id:s.sid});
  }
 }finally{a.release();b.release();}
 console.log(JSON.stringify({postgres:'17.10',brands:['fish','aristo'],dry_run_rolled_back:true,concurrent_recovery_one_increment:true,archive_sha256_checked:true,remains_suspended:true,production_authority_proven:false,sends:0,remote_hosts:0}));
}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
