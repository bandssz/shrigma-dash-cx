'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{Pool}=require('pg');
const F=require('./segment-regular-admission-fixture.cjs'),R=require('../n8n/growth/segment-regular-admission.cjs'),API=require('../n8n/growth/segment-regular-admission-api.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const {createTransaction}=require('../services/crm-audience/transaction.cjs'),{createServer}=require('../services/crm-audience/server.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:4,statement_timeout:10000}),db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q),transaction:async work=>{const c=await owner.connect();try{await c.query('BEGIN');const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
let pool,app,transaction;
(async()=>{try{
 assert.equal((await db.query("SELECT current_setting('server_version_num') AS v")).rows[0].v,'170010');
 const f=await F.setup(db);await db.exec(fs.readFileSync(require.resolve('../n8n/growth/segment-regular-admission-access.sql'),'utf8'));
 await db.query('ALTER ROLE crm_audience_api LOGIN');await f.approve();
 const roleURL=new URL(uri);roleURL.username='crm_audience_api';pool=new Pool({connectionString:roleURL.href,max:4,statement_timeout:10000});transaction=createTransaction({pool});
 const service=R.createRegularAdmission({transaction,countProvider:Counter.countAudience,refreshCatalog:({query,brand})=>query('SELECT crm_audience_v2.refresh_native_catalog($1)',[brand])}),api=API.createRegularAdmissionAPI({store:service});
 app=createServer({segments:api,binding:api,revision:'a'.repeat(40),enabled:true,bindingEnabled:true,regularEnabled:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port+'/campaign-audience';
 const call=async(p,method='POST')=>{const r=await fetch(url+(method==='GET'?'?'+new URLSearchParams(p):''),{method,headers:{Authorization:'Bearer synthetic-manager-key',...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(p)}:{})});return {status:r.status,body:await r.json()};};
 for(const brand of ['fish','aristo']){
  const p=await f.prepareRequest(brand),review=await call(p);assert.equal(review.status,200,JSON.stringify(review));
  const op=f.scheduleRequest(p,review,'pg-admission-'+brand),pair=await Promise.all([call(op),call(op)]);
  assert.equal(pair[0].status,200,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);
  assert.deepEqual(await call({acao:R.ACTIONS.operation,brand,idempotency_key:op.idempotency_key},'GET'),pair[0]);
 }
 for(const sql of ["UPDATE campaigns SET status='scheduled'",'UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true','UPDATE crm_audience_v2.regular_sender_policy SET enabled=true','UPDATE crm_audience_v2.regular_delivery_campaign SET enabled=true','DELETE FROM crm_audience_v2.regular_admission_request',"UPDATE crm_audience_v2.regular_admission_review SET actor='fake'",'SELECT email FROM subscribers','SELECT * FROM crm_dash_chave'])await assert.rejects(pool.query(sql),e=>['42501','42703'].includes(e.code));
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_admission_request')).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign WHERE enabled')).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 const blocker=await owner.connect();try{
  await blocker.query('BEGIN');await blocker.query('LOCK TABLE crm_audience_v2.regular_admission_request IN ACCESS EXCLUSIVE MODE');
  const controller=new AbortController(),started=Date.now(),pending=service.execute({key:'synthetic-manager-key',request:{acao:R.ACTIONS.operation,brand:'fish',idempotency_key:'pg-admission-fish'},signal:controller.signal});
  const timer=setTimeout(()=>controller.abort(),20);const cancelled=await pending;clearTimeout(timer);
  assert.equal(cancelled._http,503);assert.ok(Date.now()-started<2000);
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 // Existing cancellation remains a stop operation. No worker/start is needed.
 await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer','100',true)");await tx.query("UPDATE campaigns SET status='cancelled' WHERE id=100");});
 assert.equal((await db.query('SELECT suspended FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=100')).rows[0].suspended,true);
 console.log(JSON.stringify({postgres:'17.10',http:true,role:'crm_audience_api',brands:['fish','aristo'],parallel_same_operation_one_schedule:true,receipt_lookup:true,native_update_denied:true,worker_and_policy_writes_denied:true,review_mutation_denied:true,cancel_suspends_control:true,operation_get_abort_bounded:true,sends:0,remote_hosts:0}));
}finally{if(app)await app.stop();if(transaction)await transaction.drain();if(pool)await pool.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
