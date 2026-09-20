'use strict';
const assert=require('node:assert/strict'),{Client}=require('pg'),{SCHEMA,SQL,input,close}=require('./ab-registry-postgres.cjs');
(async()=>{
 if(process.env.AB_TEST_DATABASE_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('Explicit isolated database required');
 const a=new Client({connectionString:process.env.TEST_DATABASE_URL}),b=new Client({connectionString:process.env.TEST_DATABASE_URL});let pending;
 const run=async(c,mode,p)=>(await c.query('SELECT crm_ab_registry_v1($1,$2::jsonb) AS result',[mode,JSON.stringify(p)])).rows[0].result;
 try{
  await a.connect();await b.connect();assert.match((await a.query('SELECT current_database() AS name')).rows[0].name,/^ab_registry_test(?:_[a-z0-9]+)?$/);
  assert.equal((await a.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows[0].n,0,'empty database required');await a.query(SCHEMA);
  const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const wait=async()=>{for(let i=0;i<100;i++){await a.query('SELECT pg_stat_clear_snapshot()');if((await a.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,20));}assert.fail('Independent session did not wait for lock');};
  // A legacy transaction already writing completes before cutover. DDL waits;
  // executions reaching SQL after installation cannot bypass the new function.
  await a.query('BEGIN');await a.query("UPDATE crm_teste SET nome='legacy committed before cut' WHERE teste_id='historical'");pending=b.query(SQL);await wait();await a.query('COMMIT');await pending;pending=null;
  assert.equal((await run(a,'record',{actor_sha256:'a'.repeat(64),teste_id:'historical'})).body.record.teste.nome,'legacy committed before cut');
  await assert.rejects(a.query("UPDATE crm_teste SET nome='old execution after cut' WHERE teste_id='historical'"),/AB_REGISTRY_MANAGED_WRITE_REQUIRED/);
  await assert.rejects(a.query("DELETE FROM crm_teste_braco WHERE teste_id='historical'"),/AB_REGISTRY_MANAGED_WRITE_REQUIRED/);
  await a.query(SQL);
  // Concurrent delivery of one UUID gets one mutation and the exact same receipt.
  const p=input(1);await a.query('BEGIN');const saved=await run(a,'write',p);pending=run(b,'write',p);await wait();await a.query('COMMIT');assert.deepEqual(await pending,saved);pending=null;
  // Different operation UUIDs cannot close a stale version twice.
  await a.query('BEGIN');const first=await run(a,'write',close(2,p.teste_id,1));pending=run(b,'write',close(3,p.teste_id,1));await wait();await a.query('COMMIT');const second=await pending;pending=null;
  assert.equal(first.body.version,2);assert.equal(second.body.code,'version_conflict');assert.equal(second.body.version,2);
  // Reusing one operation with a different frozen payload cannot overwrite it.
  const other=input(4);await a.query('BEGIN');const original=await run(a,'write',other);pending=run(b,'write',{...other,request_payload:{...other.request_payload,teste:{...other.request_payload.teste,nome:'different payload'}}});await wait();await a.query('COMMIT');assert.equal((await pending).body.code,'operation_identity_conflict');pending=null;
  assert.deepEqual((await run(b,'operation',other)).body.operation.response,original);
  // Different UUIDs creating the same test cannot replace metadata or arms.
  const x=input(5);await a.query('BEGIN');const created=await run(a,'write',x);pending=run(b,'write',input(6,x.teste_id));await wait();await a.query('COMMIT');assert.equal((await pending).body.code,'record_exists');pending=null;
  assert.deepEqual((await run(b,'record',{actor_sha256:'a'.repeat(64),teste_id:x.teste_id})).body.record,created.body.record);
  assert.equal((await a.query('SELECT count(*)::int AS n FROM crm_ab_operation_v1')).rows[0].n,6);
  console.log('PASS two-session A/B registry: cutover waits for old DML; later legacy writes refused; same UUID one receipt; CAS serializes close; conflicting creation preserves arms. Synthetic only.');
 }finally{await a.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});await Promise.allSettled([a.end(),b.end()]);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
