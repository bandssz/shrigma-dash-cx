/* Disposable PostgreSQL 17.10, two independent Node factories, synthetic HTTP. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{Pool}=require('pg');
const {install}=require('./journey-graph-cart-fixture.cjs'),{createWorker,ACTOR}=require('../n8n/growth/journey-graph-worker.cjs');
function rendezvous(){let arrived=0,release,reject,timer;const both=new Promise((r,j)=>{release=r;reject=j;});return async()=>{if(++arrived===1)timer=setTimeout(()=>reject(Error('synthetic worker barrier timeout')),3000);if(arrived===2){clearTimeout(timer);release();}await both;};}
(async()=>{
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.pathname,'/journey_graph_worker_test');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.search,'');assert.equal(u.hash,'');
 const pool=new Pool({connectionString:u.toString(),max:8,statement_timeout:10000,connectionTimeoutMillis:3000,application_name:'graph-worker-synthetic-proof'});
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','crm_graph_candidate','crm_maintenance_candidate') AND c.relkind IN ('r','p','v')")).rows[0].n,0);
  const db={exec:q=>pool.query(q),query:(q,p)=>pool.query(q,p),close:async()=>{}},x=await install({after(){}},db,pool);
  await pool.query(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-dispatch-receipt.sql'),'utf8'));
  for(const brand of ['fish','aristo']){
   const f=await x.prepare(brand);let posts=0,dispatchLookups=0;const pendingBarrier=rendezvous(),lookupBarrier=rendezvous();
   // Both processes discover the same unreserved intent before competing. The
   // native claim itself uses separate real transactions and untouched lock order.
   const competingPool={connect:()=>pool.connect(),query:async(q,p)=>{
    const r=await pool.query(q,p);
    if(q.startsWith('SELECT l.intent_id FROM crm_graph_candidate.cart_delivery_v1'))await pendingBarrier();
    if(q.startsWith('SELECT crm_graph_candidate.cart_dispatch_v1')&&dispatchLookups++<2){assert.equal(r.rows[0].result,null);await lookupBarrier();}
    return r;
   }};
   const options={pool,enabled:true,actor:ACTOR,cacheTarget:x.cacheTarget,collectorWorkflowIds:{fish:'syntheticFish',aristo:'syntheticAristo'},readSource:f.settings.readSource,
    authorizeWorker:async({query,actor})=>actor===ACTOR&&(await query('SELECT current_user AS role')).rows[0].role==='synthetic',
    sendTx:async(payload,settings)=>{posts++;assert.equal(payload.template_id,f.preparedClone.clone_template_id);assert.equal(settings.retry,false);assert.equal(settings.redirect,'error');return {statusCode:200,body:{data:true}};}};
   const disabled=createWorker({...options,enabled:false});assert.equal((await disabled.tick({brand,limit:1})).state,'disabled');assert.equal(posts,0);
   await pool.query("UPDATE crm_maintenance_candidate.control SET mode='closed'");assert.equal((await createWorker(options).tick({brand,limit:1})).state,'blocked');assert.equal(posts,0);await pool.query("UPDATE crm_maintenance_candidate.control SET mode='open'");
   const first=createWorker({...options,pool:competingPool}),second=createWorker({...options,pool:competingPool});
   const results=await Promise.all([first.tick({brand,limit:1}),second.tick({brand,limit:1})]);assert.equal(posts,1);assert.equal(results.reduce((sum,r)=>sum+r.transport_started,0),1);assert.equal(results.reduce((sum,r)=>sum+r.reconciled,0),1);
   assert.equal((await pool.query('SELECT count(*)::int n FROM public.shrigma_email_dispatch WHERE brand=$1',[brand])).rows[0].n,1);
   assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.dispatch_receipt_v1 WHERE brand=$1',[brand])).rows[0].n,1);
   assert.equal((await pool.query("SELECT count(*)::int n FROM crm_graph_candidate.dispatch_receipt_v1 WHERE brand=$1 AND transport_state='accepted'",[brand])).rows[0].n,1);
   const restarted=createWorker(options),receipt=await restarted.reconcile({brand,intent_id:f.intent.intent_id});assert.equal(receipt.state,'accepted');assert.equal(receipt.receipt_applied,true);await restarted.tick({brand,limit:1});await restarted.reconcile({brand,intent_id:f.intent.intent_id});assert.equal(posts,1);
   assert.equal((await pool.query('SELECT count(*)::int n FROM public.shrigma_send_log WHERE brand=$1',[brand])).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.dispatch_receipt_v1 WHERE brand=$1',[brand])).rows[0].n,1);
   console.log('PASS '+brand+': two worker instances compete for one owned intent; exactly one synthetic HTTP, native dispatch and receipt; restart/reconciliation never resend; OFF and closed maintenance produce zero HTTP.');
  }
  await pool.query("UPDATE crm_maintenance_candidate.control SET mode='closed';UPDATE crm_graph_candidate.cart_control_v1 SET enabled=false;UPDATE crm_graph_candidate.control SET enabled=false");
  assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.cart_permit_v1')).rows[0].n,0);
  console.log('PASS final OFF; no external network, grants or cohort admissions.');
 }finally{await pool.end();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
