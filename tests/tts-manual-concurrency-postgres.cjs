/* Requires two real PostgreSQL sessions in an empty, disposable synthetic DB. */
'use strict';
const assert=require('node:assert/strict'),{Client}=require('pg');
const {SCHEMA,MIGRATION,id,request}=require('./tts-manual-decision-postgres.cjs');
(async()=>{
 if(process.env.TTS_TEST_DATABASE_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('Explicit isolated database required');
 const a=new Client({connectionString:process.env.TEST_DATABASE_URL}),b=new Client({connectionString:process.env.TEST_DATABASE_URL});let pending;
 const store=async(c,action,p)=>(await c.query('SELECT crm_tts_manual_store_v1($1,$2::jsonb) AS result',[action,JSON.stringify(p)])).rows[0].result;
 const add=n=>a.query("INSERT INTO crm_tts_amostra(marca,application_id,status,is_approvable,approve_expira_em,decisao) VALUES('fish',$1,'PENDING',true,clock_timestamp()+interval '1 day','fila_manual')",[String(n)]);
 try{
  await a.connect();await b.connect();
  assert.match((await a.query('SELECT current_database() AS name')).rows[0].name,/^tts_manual_test(?:_[a-z0-9]+)?$/);
  assert.equal((await a.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows[0].n,0,'empty isolated database required');
  await a.query(SCHEMA);await a.query(MIGRATION);await a.query(MIGRATION);
  const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  async function waitLocked(){for(let i=0;i<150;i++){await a.query('SELECT pg_stat_clear_snapshot()');if((await a.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected independent session lock wait');}
  await add(1);await a.query("UPDATE crm_tts_manual_control_v1 SET eligible_from=clock_timestamp(),enabled=true");
  assert.equal((await store(a,'claim',request(1))).code,'legacy_reconciliation_required');
  // Two tabs/executions, different UUIDs, same resource: exactly one durable claim.
  await add(2);let p=request(2);
  await a.query('BEGIN');const claim=await store(a,'claim',p);assert.equal(claim.allowed,true);
  pending=store(b,'claim',{...p,operation_id:id(200),owner:'other-execution'});await waitLocked();await a.query('COMMIT');
  assert.equal((await pending).code,'resource_reserved');pending=null;p.claim_token=claim.claim_token;
  // Even duplicated delivery of the owned work cannot reserve the transport twice.
  await a.query('BEGIN');assert.equal((await store(a,'dispatch',p)).allowed,true);
  pending=store(b,'dispatch',p);await waitLocked();await a.query('COMMIT');assert.equal((await pending).allowed,false);pending=null;
  // Terminal receipt and sample status become visible together; no gap after provider success.
  await a.query('BEGIN');const saved=await store(a,'finish',{...p,receipt:{kind:'accepted',provider_code:0,request_id:'fixture-receipt',reason:'provider_accepted'}});assert.equal(saved.recorded,true);
  assert.equal((await store(b,'get',p)).operation.state,'in_flight');
  pending=store(b,'claim',p);await waitLocked();await a.query('COMMIT');assert.equal((await pending).receipt.operation.state,'accepted');pending=null;
  assert.equal((await b.query("SELECT status FROM crm_tts_amostra WHERE application_id='2'")).rows[0].status,'AWAITING_SHIPMENT');
  // Same UUID against another resource cannot create a second operation.
  await add(3);assert.equal((await store(b,'claim',{...request(3),operation_id:id(2)})).code,'idempotency_conflict');
  // A rule mutation already holding the row lock is observed freshly by dispatch.
  await add(4);p=request(4);p.claim_token=(await store(a,'claim',p)).claim_token;
  await a.query('BEGIN');await a.query("UPDATE crm_tts_regra SET modo='ativo' WHERE marca='fish'");pending=store(b,'dispatch',p);await waitLocked();await a.query('COMMIT');assert.equal((await pending).code,'automatic_decisions_not_fenced');pending=null;
  await a.query("UPDATE crm_tts_regra SET modo='dry_run' WHERE marca='fish'");
  // A pause committed before dispatch is authoritative, with no reservation deletion.
  await add(5);p=request(5);p.claim_token=(await store(a,'claim',p)).claim_token;
  await a.query('BEGIN');await a.query("UPDATE crm_tts_manual_control_v1 SET enabled=false WHERE marca='fish'");pending=store(b,'dispatch',p);await waitLocked();await a.query('COMMIT');assert.equal((await pending).code,'disabled_or_cohort_changed');pending=null;
  await a.query("UPDATE crm_tts_manual_control_v1 SET enabled=true WHERE marca='fish'");assert.equal((await store(b,'claim',p)).receipt.operation.state,'blocked');
  // A collector row change after claim, before dispatch, is observed after the row lock.
  await add(6);p=request(6);p.claim_token=(await store(a,'claim',p)).claim_token;
  await a.query('BEGIN');await a.query("UPDATE crm_tts_amostra SET status='CANCELLED' WHERE application_id='6'");pending=store(b,'dispatch',p);await waitLocked();await a.query('COMMIT');assert.equal((await pending).code,'source_changed_or_expired');pending=null;
  // Explicitly expose the limit: the DB lock cannot fence a legacy worker's later HTTP.
  assert.equal((await b.query('SELECT count(*)::int AS n FROM crm_tts_manual_operation_v1')).rows[0].n,4);
  console.log('PASS two-session PostgreSQL: one claim and dispatch, exact committed receipt, fresh rule/pause/collector boundary, legacy cohort preserved. No HTTP or production objects.');
 }finally{await a.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});await Promise.allSettled([a.end(),b.end()]);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
