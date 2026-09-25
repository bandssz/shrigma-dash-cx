/* Real independent sessions, disposable synthetic loopback database, no HTTP/transport. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Client}=require('pg');
const {setup,uuid,GEC,P}=require('./fixtures/email-test-fixture.cjs');
const GEE=require('../growth-email-expressions.js'),ENP=require('../n8n/growth/email-native-preview.cjs'),ENTP=require('../n8n/growth/email-native-test-protocol.cjs'),{digest}=require('../n8n/growth/template-operation-receipt.cjs');
const one=async(c,q,p=[])=>(await c.query(q,p)).rows[0];
(async()=>{
 const connectionString=process.env.TEST_DATABASE_URL;if(process.env.EMAIL_TEST_DATABASE_ISOLATED!=='1'||!connectionString)throw Error('Explicit disposable database required');
 const u=new URL(connectionString);assert.ok(['127.0.0.1','localhost','[::1]'].includes(u.hostname));assert.match(u.pathname,/^\/crm_email_native_test(?:_[a-z0-9]+)?$/);
 const a=new Client({connectionString}),b=new Client({connectionString});let pending;const queue=fn=>{assert.equal(pending,undefined);pending=fn().then(value=>({value}),error=>({error}));};
 async function receive(){const r=await pending;pending=undefined;if(r.error)throw r.error;return r.value;}
 async function locked(pid){for(let i=0;i<100;i++){await a.query('SELECT pg_stat_clear_snapshot()');if((await one(a,'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]))?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,20));}assert.fail('Expected real lock wait');}
 try{
  await a.connect();await b.connect();for(const c of[a,b])await c.query("SET statement_timeout='8s';SET lock_timeout='3s'");assert.equal((await one(a,"SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).n,0);
  const f=await setup({db:{exec:q=>a.query(q),query:(q,p)=>a.query(q,p)}});await a.query("ALTER TABLE subscribers ADD COLUMN name text NOT NULL DEFAULT 'Fixture';ALTER TABLE subscribers ADD COLUMN uuid uuid NOT NULL DEFAULT '20000000-0000-4000-8000-000000000001'");await a.query(fs.readFileSync(path.join(__dirname,'../n8n/growth/email-native-test.sql'),'utf8'));
  const pid=(await one(b,'SELECT pg_backend_pid() pid')).pid;
  const snapshot=async()=> (await one(a,"SELECT crm_email_native_snapshot_v1('panel:manager','d_fixture',1) s")).s;
  const plan=async()=>{const s=await snapshot(),p=ENTP.prepare(s,{statusCode:200,body:{data:s.snapshot.native}},{GEC,GEE,ENP,digest});return ENTP.rendered(p,{statusCode:200,body:'<p>Fixture</p>'},{GEC,ENP});};
  const claim=(c,n,p)=>one(c,"SELECT crm_email_native_claim_v1('panel:manager',$1,$2) r",[{...f.request(n),preview_token:p.preview_token},p]).then(x=>x.r);
  let p=await plan();assert.equal(p.eligible,true);const legacy=P.plan(await f.snapshot(),GEC);
  await a.query('BEGIN');assert.equal((await claim(a,1,p)).should_send,true);queue(()=>one(b,"SELECT crm_email_test_claim_v1('panel:manager',$1,$2) r",[f.request(2),legacy]));await locked(pid);await a.query('COMMIT');assert.equal((await receive()).r.result._body.operation.code,'version_already_attempted');assert.equal((await claim(b,1,p)).should_send,false);
  await a.query('TRUNCATE crm_email_test_operation_v1,shrigma_email_dispatch');p=await plan();
  await a.query('BEGIN');assert.equal((await one(a,"SELECT crm_email_test_claim_v1('panel:manager',$1,$2) r",[f.request(3),legacy])).r.should_send,true);queue(()=>claim(b,4,p));await locked(pid);await a.query('COMMIT');assert.equal((await receive()).result._body.operation.code,'version_already_attempted');
  await a.query('TRUNCATE crm_email_test_operation_v1,shrigma_email_dispatch');p=await plan();
  await a.query('BEGIN');await a.query("UPDATE subscribers SET name='Changed' WHERE id=1");queue(()=>claim(b,5,p));await locked(pid);await a.query('COMMIT');assert.equal((await receive()).result._body.operation.code,'preview_changed');
  p=await plan();await a.query('BEGIN');await a.query("UPDATE subscribers SET status='blocklisted' WHERE id=1");queue(()=>claim(b,6,p));await locked(pid);await a.query('COMMIT');assert.equal((await receive()).result._body.operation.code,'recipient_disabled');
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_email_dispatch')).n,0);
  console.log('Native email tests: two-session shared once/version both directions, immutable replay, identity drift and opt-out contention passed; no transport.');
 }finally{await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});if(pending)await pending;await a.end();await b.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
