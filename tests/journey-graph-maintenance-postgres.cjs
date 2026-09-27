'use strict';
// Exact disposable PostgreSQL 17.10 database, synthetic fixtures only. No HTTP.
const assert=require('node:assert/strict'),{install}=require('./journey-graph-maintenance-fixture.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['127.0.0.1','localhost'].includes(u.hostname));assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/journey_graph_maintenance_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Pool}=require('pg'),pool=new Pool({connectionString:u.toString(),max:7,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'graph-maintenance-synthetic-proof'});
 const db={exec:q=>pool.query(q),query:(q,p)=>pool.query(q,p),close:async()=>{}};
 let blocker,worker,pending;
 async function lockReached(pid){for(let i=0;i<80;i++){if((await pool.query("SELECT wait_event_type='Lock' yes FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.yes)return;await new Promise(r=>setTimeout(r,20));}throw Error('synthetic worker never reached actual lock');}
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_graph_candidate','crm_maintenance_candidate') AND c.relkind IN('r','p','v')")).rows[0].n,0);
  const x=await install({after(){}},{db,pool}),f=await x.prepare('fish'),body=await x.legacyBody(f),receipt=await x.maintenance.admit('fish','cart',body),before=await x.snapshot(receipt.event_id);
  const pair=await Promise.all([x.maintenance.claim(receipt.event_id),x.maintenance.claim(receipt.event_id)]);
  assert.deepEqual(pair.map(r=>r.reason).sort(),['already_delegated','delegated']);for(const r of pair){assert.equal(r.should_send,false);assert.equal(r.claim_token,null);assert.equal(r.dispatch_id,null);}
  assert.deepEqual(await x.snapshot(receipt.event_id),before);assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),1);assert.equal(await x.count('shrigma_email_dispatch'),0);
  console.log('PASS actual concurrent retained claims: one delegation, immutable receipt, zero dispatch/token.');

  const a=await x.prepare('aristo'),abody=await x.legacyBody(a),ar=await x.maintenance.admit('aristo','cart',abody);
  // A gate close committed while this worker waits must win before any delegation.
  blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("UPDATE crm_maintenance_candidate.control SET mode='closed',enabled=false");
  worker=await pool.connect();const pid=(await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  pending=worker.query('SELECT * FROM crm_maintenance_candidate.claim_v1($1)',[ar.event_id]);await lockReached(pid);await blocker.query('COMMIT');blocker.release();blocker=null;
  assert.equal((await pending).rows[0].reason,'retained');pending=null;worker.release();worker=null;assert.equal((await x.maintenance.row(ar.event_id)).state,'queued');assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),1);
  console.log('PASS concurrent retention close: queued event remains retained, no delegation or grant.');

  await pool.query("UPDATE crm_maintenance_candidate.control SET mode='open',enabled=true");
  // SQL-only reservation is explicitly synthetic; there is no transport caller.
  const raced=await Promise.all([x.maintenance.claim(ar.event_id),a.claim.claim(a.request)]);
  assert.equal(raced[0].reason,'delegated');assert.equal(raced[0].dispatch_id,null);assert.equal(raced[1].should_send,true);assert.equal(await x.count('shrigma_email_dispatch'),1);assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),2);
  const replay=await a.claim.claim(a.request);assert.equal(replay.should_send,false);assert.equal(replay.claim_token,null);assert.equal((await x.maintenance.claim(ar.event_id)).reason,'already_delegated');assert.equal((await x.maintenance.reconcile(ar.event_id)).drained,false);
  assert.equal(await x.count('shrigma_send_log'),0);
  await pool.query("UPDATE crm_maintenance_candidate.control SET mode='closed',enabled=false;UPDATE crm_graph_candidate.control SET enabled=false;UPDATE crm_graph_candidate.cart_control_v1 SET enabled=false");
  console.log('PASS concurrent graph/retention: one native synthetic reservation belongs only to graph; replay has no second token; zero HTTP/send-log, final OFF and never declared drained.');
 }finally{
  if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}
  if(pending)await pending.catch(()=>{});if(worker)worker.release();await pool.end();
 }
}
run().catch(e=>{console.error('FAIL graph maintenance:',e.code||'',e.message);process.exitCode=1;});
