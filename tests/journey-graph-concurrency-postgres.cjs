'use strict';
// Opt-in only: isolated PostgreSQL 17.10, synthetic data, no transport or network APIs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,faultPool}=require('./fixtures/journey-graph-runtime.cjs');
const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs');
async function run(){
 const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');
 assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1','explicit isolated database opt-in required');
 assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.equal(url.pathname,'/journey_graph_test');assert.equal(url.username,'synthetic');assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');assert.equal(url.port,'5432');
 const {Pool}=require('pg'),pool=new Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'synthetic-graph-proof'});
 let blocker=null;
 try{
  const server=(await pool.query('SHOW server_version_num')).rows[0].server_version_num;assert.equal(server,'170010','fixture pins PostgreSQL 17.10');
  assert.equal((await pool.query("SELECT to_regnamespace('crm_graph_candidate') AS schema")).rows[0].schema,null,'database must be clean; never drop existing data');
  await pool.query(fs.readFileSync(path.join(__dirname,'../n8n/growth/journey-graph-store.sql'),'utf8'));
  const a=await pool.connect(),b=await pool.connect();try{assert.notEqual((await a.query('SELECT pg_backend_pid() id')).rows[0].id,(await b.query('SELECT pg_backend_pid() id')).rows[0].id);}finally{a.release();b.release();}
  const f=fixture(pool);let j=await f.ready();
  const enrollment=()=>f.request({journey_id:j.journey_id,expected_version:j.version,source_ref:f.sourceRef});
  const results=await Promise.all([f.api.enroll(enrollment()),f.api.enroll(enrollment())]);
  assert.equal(results[0].entry_id,results[1].entry_id);assert.equal(results.filter(r=>r.created).length,1);
  let e=results[0];
  const raced=await Promise.allSettled([f.step(e),f.step(e)]);assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);assert.equal(raced.find(r=>r.status==='rejected').reason.code,'GRAPH_VERSION_CONFLICT');e=raced.find(r=>r.status==='fulfilled').value;
  f.setTime('2026-09-25T12:01:00.000Z');e=await f.step(e);e=await f.step(e);
  const req=f.request({entry_id:e.entry_id,expected_version:e.version});
  const same=await Promise.all([f.api.step(req),createGraphRuntime(f.settings).step(req)]);assert.deepEqual(same[0],same[1]);assert.equal(same[0].kind,'message_intent');
  assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.intent')).rows[0].n),1);
  await assert.rejects(f.step(e),{code:'GRAPH_VERSION_CONFLICT'});
  console.log('PASS distinct sessions: concurrent event dedup, CAS fencing and one immutable intent per request.');

  // Each source event is synthetic; the identity stays fixed while facts refresh.
  let event=1,minute=2;
  async function newMessage(){f.proof.event_id='synthetic-event-'+(++event);f.setTime(`2026-09-25T12:${String(minute).padStart(2,'0')}:00.000Z`);let x=await f.enroll(j);x=await f.step(x);minute++;f.setTime(`2026-09-25T12:${String(minute).padStart(2,'0')}:00.000Z`);x=await f.step(x);return f.step(x);}
  async function lockProof(lockSQL,changeSQL,changeParams){
   const entry=await newMessage(),before=Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.intent')).rows[0].n);
   blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query(lockSQL,[j.journey_id].slice(0,lockSQL.includes('$1')?1:0));
   let workerPid;
   const tracked={async connect(){const c=await pool.connect();workerPid=(await c.query('SELECT pg_backend_pid() id')).rows[0].id;return c;}};
   const pending=createGraphRuntime({...f.settings,pool:tracked}).step(f.request({entry_id:entry.entry_id,expected_version:entry.version}));
   // Attach rejection immediately, then prove a real server lock before releasing it.
   const settled=pending.then(value=>({value}),error=>({error}));let locked=false;
   for(let i=0;i<80&&!locked;i++){if(workerPid)locked=(await pool.query("SELECT wait_event_type='Lock' locked FROM pg_stat_activity WHERE pid=$1",[workerPid])).rows[0]?.locked===true;if(!locked)await new Promise(r=>setTimeout(r,20));}
   if(!locked){await blocker.query('ROLLBACK');blocker.release();blocker=null;await settled;assert.fail('worker did not demonstrably block on the control/journey lock');}
   await blocker.query(changeSQL,changeParams);await blocker.query('COMMIT');blocker.release();blocker=null;
   const result=await settled;if(result.error)throw result.error;assert.equal(result.value.kind,'paused');
   assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.intent')).rows[0].n),before);
   assert.equal((await pool.query('SELECT version FROM crm_graph_candidate.entry WHERE id=$1',[entry.entry_id])).rows[0].version,entry.version);
  }
  await lockProof('SELECT id FROM crm_graph_candidate.journey WHERE id=$1 FOR UPDATE','UPDATE crm_graph_candidate.journey SET paused=true,version=version+1 WHERE id=$1',[j.journey_id]);
  let v=(await pool.query('SELECT version FROM crm_graph_candidate.journey WHERE id=$1',[j.journey_id])).rows[0].version;
  j=await f.api.pause(f.request({journey_id:j.journey_id,expected_version:v,paused:false,confirm:'retomar'}));
  await lockProof('SELECT enabled FROM crm_graph_candidate.control FOR UPDATE','UPDATE crm_graph_candidate.control SET enabled=false',[]);
  await pool.query('UPDATE crm_graph_candidate.control SET enabled=true');
  console.log('PASS lock barriers: committed journey pause and global OFF fence waiting workers before any intent.');

  e=await newMessage();const lostReq=f.request({entry_id:e.entry_id,expected_version:e.version});let lost=true;
  const faulty=createGraphRuntime({...f.settings,pool:faultPool(pool,{after:q=>q==='COMMIT'&&lost?(lost=false,true):false})});
  await assert.rejects(faulty.step(lostReq),{code:'GRAPH_OUTCOME_UNKNOWN'});
  const recovered=await createGraphRuntime(f.settings).step(lostReq);assert.equal(recovered.kind,'message_intent');
  assert.deepEqual(recovered,(await pool.query('SELECT response FROM crm_graph_candidate.operation WHERE request_id=$1',[lostReq.request_id])).rows[0].response);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.intent WHERE entry_id=$1',[e.entry_id])).rows[0].n),1);
  e=await newMessage();const atomicReq=f.request({entry_id:e.entry_id,expected_version:e.version});
  const crash=createGraphRuntime({...f.settings,pool:faultPool(pool,{before:q=>q.startsWith('INSERT INTO crm_graph_candidate.intent')})});
  await assert.rejects(crash.step(atomicReq),/synthetic pre-commit failure/);
  assert.equal((await pool.query('SELECT version FROM crm_graph_candidate.entry WHERE id=$1',[e.entry_id])).rows[0].version,e.version);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.intent WHERE entry_id=$1',[e.entry_id])).rows[0].n),0);
  assert.equal((await f.api.step(atomicReq)).kind,'message_intent');
  console.log('PASS commit-response loss and pre-commit crash: durable replay, rollback, restart and exact single intention.');
  e=await newMessage();const brokenReq=f.request({entry_id:e.entry_id,expected_version:e.version});let brokenPid,discarded=false;
  const brokenPool={async connect(){const c=await pool.connect();brokenPid=(await c.query('SELECT pg_backend_pid() id')).rows[0].id;return {async query(q,a){if(q==='ROLLBACK'||q.startsWith('INSERT INTO crm_graph_candidate.intent'))throw Error('synthetic broken connection');return c.query(q,a);},release(error){discarded=error instanceof Error;c.release(error);}};}};
  await assert.rejects(createGraphRuntime({...f.settings,pool:brokenPool}).step(brokenReq),{code:'GRAPH_OUTCOME_UNKNOWN'});assert.equal(discarded,true);
  const borrower=await pool.connect();try{assert.notEqual((await borrower.query('SELECT pg_backend_pid() id')).rows[0].id,brokenPid);}finally{borrower.release();}
  // Retrying may wait for the destroyed backend to roll back, then must produce
  // the original message intent, never await_transport with no intent row.
  assert.equal((await f.api.step(brokenReq)).kind,'message_intent');
  assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.intent WHERE entry_id=$1',[e.entry_id])).rows[0].n),1);
  console.log('PASS failed rollback destroys its pool connection; the next borrower cannot commit partial state.');
  await pool.query('UPDATE crm_graph_candidate.control SET enabled=false');
  assert.deepEqual(await f.api.due({brand:'fish'}),[]);
  assert.equal((await pool.query('SELECT bool_and(NOT authorizes_send) safe FROM crm_graph_candidate.intent')).rows[0].safe,true);
  console.log('PASS final state OFF; no receipt, transport, real source or production capacity claim.');
 }finally{
  if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}
  await pool.end();
 }
}
run().catch(e=>{console.error('FAIL graph concurrency:',e.code||'',e.message);process.exitCode=1;});
