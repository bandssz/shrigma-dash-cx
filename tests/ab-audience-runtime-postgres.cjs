'use strict';
// Disposable loopback PostgreSQL only. Actual service login and transaction
// adapter; no SMTP connection, clock change or disabled trigger.
const assert=require('node:assert/strict'),{Pool}=require('pg');
const {prove}=require('./ab-audience-runtime-access.test.cjs');
const {createTransaction}=require('../services/crm-audience/transaction.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:5,statement_timeout:30000,connectionTimeoutMillis:5000});
const db={query:(q,v)=>owner.query(q,v),exec:q=>owner.query(q),transaction:async work=>{const c=await owner.connect();try{await c.query('BEGIN');const out=await work(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{let apiPool;try{
 assert.equal((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v,'170010');
 const proof=await prove(db,{createRoleTransaction:async()=>{
  await db.query('ALTER ROLE crm_audience_api LOGIN');const roleURL=new URL(uri);roleURL.username='crm_audience_api';
  apiPool=new Pool({connectionString:roleURL.href,max:4,statement_timeout:10000,connectionTimeoutMillis:5000});
  return createTransaction({pool:apiPool});
 }});
 const reader=await apiPool.connect(),writer=await owner.connect();try{
  await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.equal((await reader.query('SELECT crm_audience_v2.ab_regular_tracking() ready')).rows[0].ready,true);
  const write=writer.query("UPDATE settings SET value='true'::jsonb WHERE key='privacy.disable_tracking'");
  let blocked=false;
  for(let i=0;i<100;i++){const row=(await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[writer.processID])).rows[0];if(row?.wait_event_type==='Lock'){blocked=true;break;}await delay(10);}
  assert.equal(blocked,true,'tracking changes must wait for admitted material transaction');
  await reader.query('COMMIT');await write;
  assert.equal((await reader.query('SELECT crm_audience_v2.ab_regular_tracking() ready')).rows[0].ready,false);
  proof.tracking_change_serialized=true;
 }finally{await reader.query('ROLLBACK');reader.release();writer.release();}
 console.log(JSON.stringify({postgres:'17.10',actual_api_login:true,...proof}));
}finally{await apiPool?.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
