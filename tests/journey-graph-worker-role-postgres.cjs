/* Isolated PostgreSQL 17.10. No remote host, contacts, credentials or HTTP. */
'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg');
const {setup,assertForbidden,assertLegacyOff,assertLedgerForbidden,assertDeferredGuards}=require('./journey-graph-worker-role-fixture.cjs');
const {createWorker}=require('../n8n/growth/journey-graph-worker.cjs');
const {ROLE}=require('../n8n/growth/journey-graph-worker-role.cjs');
function rendezvous(){let n=0,resolve,reject,timer;const ready=new Promise((r,j)=>{resolve=r;reject=j;});return async()=>{if(++n===1)timer=setTimeout(()=>reject(Error('role worker barrier timed out')),3000);if(n===2){clearTimeout(timer);resolve();}await ready;};}
(async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.equal(url.port,'5432');assert.equal(url.pathname,'/journey_graph_worker_role_test');assert.equal(url.username,'synthetic');assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');
 const pool=new Pool({connectionString:url.toString(),max:4,statement_timeout:10000,connectionTimeoutMillis:3000});
 let installed=false;
 async function clean(){
  // This runner owns only the disposable fixture database and the role whose
  // initial absence it verified. NOLOGIN role has no membership or other use.
  await pool.query('ROLLBACK');await pool.query('DROP OWNED BY '+ROLE);await pool.query('DROP ROLE '+ROLE);installed=false;
  await pool.query('DROP SCHEMA crm_graph_candidate CASCADE;DROP SCHEMA crm_maintenance_candidate CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
 }
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_graph_candidate','crm_maintenance_candidate') AND c.relkind IN('r','p','v')")).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=$1',[ROLE])).rows[0].n,0);
  for(const brand of ['fish','aristo'])for(const outcome of ['accepted','outcome_unknown','optout','deferred']){
   const workerPool=new Pool({connectionString:url.toString(),max:4,statement_timeout:10000,connectionTimeoutMillis:3000});
   let a;
   try{
    const db={exec:q=>pool.query(q),query:(q,p)=>pool.query(q,p),close:async()=>{}};
    a=await setup({db,pool,workerPool,brand,outcome:['optout','deferred'].includes(outcome)?'accepted':outcome});installed=true;
    // Consent writes are tested against revoked values, not accidental no-ops.
    await pool.query("UPDATE subscribers SET attribs=jsonb_set(jsonb_set(attribs,'{fish,mkt_consent}','\"unsubscribed\"'),'{aristo,mkt_consent}','\"unsubscribed\"') WHERE id=2");
    await assertForbidden(a);
    await pool.query("UPDATE subscribers SET attribs=jsonb_set(jsonb_set(attribs,'{fish,mkt_consent}','\"subscribed\"'),'{aristo,mkt_consent}','\"subscribed\"') WHERE id=2");
    await a.captureAndEnroll();
    assert.equal((await createWorker({...a.options,enabled:false}).tick({brand,limit:1})).state,'disabled');assert.equal(a.posts(),0);
    if(outcome==='optout'){
     await pool.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=2 AND list_id=$1",[brand==='fish'?22:21]);
     const r=await a.worker.tick({brand,limit:1});assert.deepEqual(r.errors,[]);assert.equal(a.posts(),0);
     assert.equal((await pool.query('SELECT stopped_reason FROM crm_graph_candidate.entry WHERE id<>$1',[a.f.entry.id])).rows[0].stopped_reason,'consent_withdrawn');
    }else if(outcome==='deferred'){
     for(let n=0;n<2;n++)assert.deepEqual((await a.worker.tick({brand,limit:1})).errors,[]);await assertDeferredGuards(a,brand);assert.equal(a.posts(),0);
    }else{
     // Two actual transitions by the restricted role reach a message intent.
     for(let n=0;n<2;n++)assert.deepEqual((await a.worker.tick({brand,limit:1})).errors,[]);
     const barrier=rendezvous();let inspections=0;
     const competing={connect:()=>a.rolePool.connect(),query:async(q,p)=>{const r=await a.rolePool.query(q,p);if(q.startsWith('SELECT crm_graph_candidate.cart_dispatch_v1')&&inspections++<2){assert.equal(r.rows[0].result,null);await barrier();}return r;}};
     const workers=[createWorker({...a.options,pool:competing}),createWorker({...a.options,pool:competing})];
     await Promise.all(workers.map(w=>w.tick({brand,limit:1})));assert.equal(a.posts(),1);
     const receipt=(await pool.query('SELECT intent_id,transport_state FROM crm_graph_candidate.dispatch_receipt_v1')).rows[0];assert.ok(receipt);assert.equal(receipt.transport_state,outcome);
     await createWorker(a.options).reconcile({brand,intent_id:receipt.intent_id});await createWorker(a.options).tick({brand,limit:1});assert.equal(a.posts(),1);
     assert.equal((await pool.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.dispatch_receipt_v1')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,outcome==='accepted'?1:0);
    }
    if(outcome!=='optout')await assertLedgerForbidden(a,brand);
    await assertLegacyOff(a,brand);
    console.log('PASS '+brand+'/'+outcome+': restricted SET ROLE, source/step/claim/finish/receipt, forbidden writes and graph-OFF legacy regression; zero external HTTP.');
   }finally{await workerPool.end();if(a)await a.close();}
   await clean();
  }
 }finally{if(installed)await clean();await pool.end();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
