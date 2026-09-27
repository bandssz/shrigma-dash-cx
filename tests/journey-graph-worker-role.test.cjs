'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {setup,assertForbidden,assertLegacyOff,assertLedgerForbidden,assertDeferredGuards}=require('./journey-graph-worker-role-fixture.cjs');
const {buildWorkerRoleSql}=require('../n8n/growth/journey-graph-worker-role.cjs');
const {createWorker}=require('../n8n/growth/journey-graph-worker.cjs');
test('role fragment requires exact sequence and recipient boundary; emits no secret, activation, transaction or login',()=>{
 for(const p of [{},{sendLogSequence:'public.a;DROP TABLE x',recipientKeySha256:'a'.repeat(64)},{sendLogSequence:'public.seq',recipientKeySha256:'x'}])assert.throws(()=>buildWorkerRoleSql(p),/CONFIG/);
 const s=buildWorkerRoleSql({sendLogSequence:'public.synthetic_cart_send_log',recipientKeySha256:'a'.repeat(64)});assert.match(s,/CREATE ROLE crm_graph_worker NOLOGIN/);assert.doesNotMatch(s,/GRANT.*(?:ALL|hmac_key|epoch_open|epoch_close|cart_enroll|native_prepare|release_prepare)/i);assert.doesNotMatch(s,/^BEGIN;|^COMMIT;/m);
});
for(const brand of ['fish','aristo']){
 test(brand+': restricted role captures source, advances, claims/finishes/receipts exactly once and forbids lifecycle/consent writes',async()=>{
  const a=await setup({brand});try{
   // Make denial tests meaningful: resubscription would change a revoked consent.
   await a.x.query("UPDATE subscribers SET attribs=jsonb_set(jsonb_set(attribs,'{fish,mkt_consent}','\"unsubscribed\"'),'{aristo,mkt_consent}','\"unsubscribed\"') WHERE id=2");
   await assertForbidden(a);await a.asAdmin();
   await a.x.query("UPDATE subscribers SET attribs=jsonb_set(jsonb_set(attribs,'{fish,mkt_consent}','\"subscribed\"'),'{aristo,mkt_consent}','\"subscribed\"') WHERE id=2");
   await a.captureAndEnroll();
   const off=createWorker({...a.options,enabled:false});assert.equal((await off.tick({brand,limit:1})).state,'disabled');assert.equal(a.posts(),0);
   for(let n=0;n<4;n++){const r=await a.worker.tick({brand,limit:1});assert.deepEqual(r.errors,[]);}
   assert.equal(a.posts(),1);
   const r=(await a.rolePool.query('SELECT intent_id FROM crm_graph_candidate.dispatch_receipt_v1')).rows[0];assert.ok(r);
   await createWorker(a.options).reconcile({brand,intent_id:r.intent_id});await a.worker.tick({brand,limit:1});assert.equal(a.posts(),1);
   await a.asAdmin();assert.equal((await a.x.query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,1);assert.equal((await a.x.query('SELECT count(*)::int n FROM crm_graph_candidate.dispatch_receipt_v1')).rows[0].n,1);
   assert.equal((await a.x.query('SELECT attribs->$1->>\'mkt_consent\' consent FROM subscribers WHERE id=2',[brand])).rows[0].consent,'subscribed');await assertLedgerForbidden(a,brand);await assertLegacyOff(a,brand);
  }finally{await a.close();}
 });
 test(brand+': opt-out after admission wins and HTTP uncertainty never sends twice',async()=>{
  const a=await setup({brand,outcome:'outcome_unknown'});try{
   await a.captureAndEnroll();await a.asAdmin();await a.x.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=2 AND list_id=$1",[brand==='fish'?22:21]);await a.asWorker();
   const blocked=await a.worker.tick({brand,limit:1});assert.deepEqual(blocked.errors,[]);assert.equal(a.posts(),0);
   await a.asAdmin();assert.equal((await a.x.query("SELECT stopped_reason FROM crm_graph_candidate.entry WHERE id<>$1",[a.f.entry.id])).rows[0].stopped_reason,'consent_withdrawn');
  }finally{await a.close();}
  const b=await setup({brand,outcome:'outcome_unknown'});try{
   await b.captureAndEnroll();for(let n=0;n<4;n++)assert.deepEqual((await b.worker.tick({brand,limit:1})).errors,[]);assert.equal(b.posts(),1);
   await createWorker(b.options).tick({brand,limit:1});assert.equal(b.posts(),1);await b.asAdmin();assert.equal((await b.x.query('SELECT transport_state FROM shrigma_email_dispatch')).rows[0].transport_state,'outcome_unknown');assert.equal((await b.x.query('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,0);
  }finally{await b.close();}
 });
}
test('installation refuses helper/sequence drift, public escape and role collision atomically',async()=>{
 const a=await setup({prepareRole:false});try{
  const expectRollback=async(sql,pattern)=>{await assert.rejects(a.x.db.exec('BEGIN;'+sql+'COMMIT;'),pattern);await a.x.query('ROLLBACK');assert.equal((await a.x.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='crm_graph_worker'")).rows[0].n,0);assert.equal((await a.x.query("SELECT to_regprocedure('crm_graph_candidate.worker_lock_guard_v1()') f")).rows[0].f,null);};
  await expectRollback(a.sql.replace(/'([a-f0-9]{64})'/, "'"+'0'.repeat(64)+"'"),/RECIPIENT_BOUNDARY/);
  await expectRollback(a.sql.replaceAll('public.synthetic_cart_send_log','public.unknown_sequence'),/SEQUENCE/);
  await a.x.db.exec('CREATE FUNCTION public.synthetic_public_escape() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$');
  await expectRollback(a.sql,/PUBLIC_ESCAPE/);await a.x.db.exec('DROP FUNCTION public.synthetic_public_escape()');
  for(const [grant,revoke] of [
   ['GRANT UPDATE(status) ON subscribers TO PUBLIC','REVOKE UPDATE(status) ON subscribers FROM PUBLIC'],
   ['GRANT UPDATE(status) ON subscriber_lists TO PUBLIC','REVOKE UPDATE(status) ON subscriber_lists FROM PUBLIC'],
   ['GRANT UPDATE(enabled) ON crm_graph_candidate.control TO PUBLIC','REVOKE UPDATE(enabled) ON crm_graph_candidate.control FROM PUBLIC'],
   ['GRANT DELETE ON subscribers TO PUBLIC','REVOKE DELETE ON subscribers FROM PUBLIC'],
   ['GRANT TRUNCATE ON crm_graph_candidate.operation TO PUBLIC','REVOKE TRUNCATE ON crm_graph_candidate.operation FROM PUBLIC'],
   ['GRANT SELECT ON shrigma_email_hmac_key TO PUBLIC','REVOKE SELECT ON shrigma_email_hmac_key FROM PUBLIC']
  ]){await a.x.db.exec(grant);await expectRollback(a.sql,/EFFECTIVE_PRIVILEGE|PUBLIC_ESCAPE/);await a.x.db.exec(revoke);}
  await a.x.db.exec('CREATE TABLE public.synthetic_unrelated(secret text);GRANT SELECT(secret) ON public.synthetic_unrelated TO PUBLIC');await expectRollback(a.sql,/EFFECTIVE_PRIVILEGE/);await a.x.db.exec('DROP TABLE public.synthetic_unrelated');
  await a.x.db.exec('BEGIN;'+a.sql+'COMMIT;');
  await assert.rejects(a.x.db.exec('BEGIN;'+a.sql+'COMMIT;'),/COLLISION/);await a.x.query('ROLLBACK');
  const role=(await a.x.query("SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='crm_graph_worker'")).rows[0];assert.ok(Object.values(role).every(v=>v===false));
 }finally{await a.close();}
});

test('deferred guards roll back orphan dispatch and unlinked log for both brands',async()=>{
 for(const brand of ['fish','aristo']){const a=await setup({brand});try{await a.captureAndEnroll();for(let n=0;n<2;n++)assert.deepEqual((await a.worker.tick({brand,limit:1})).errors,[]);await assertDeferredGuards(a,brand);}finally{await a.close();}}
});
