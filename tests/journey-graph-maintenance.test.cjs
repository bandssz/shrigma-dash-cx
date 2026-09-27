'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{install,M}=require('./journey-graph-maintenance-fixture.cjs');
function noGrant(r){assert.equal(r.should_send,false);for(const k of ['dispatch_id','claim_token','payload','context'])assert.equal(r[k],null);}
test('regression: original retained claim misclassifies the actual graph-owned cart',async t=>{
 const x=await install(t,{migrate:false}),f=await x.prepare(),body=await x.legacyBody(f),r=await x.maintenance.ingest(body);
 noGrant(r);assert.equal(r.reason,'review_required');assert.equal((await x.maintenance.row(r.event_id)).reason,'unrecognized_original_refusal');assert.equal(await x.count('shrigma_email_dispatch'),0);
 const before=await x.maintenance.row(r.event_id);await x.migrate();assert.deepEqual(await x.maintenance.row(r.event_id),before);assert.equal((await x.maintenance.claim(r.event_id)).reason,'already_review_required');
});
for(const brand of ['fish','aristo'])test(brand+': retained real cart claim delegates atomically, preserves immutable receipt and never reissues a grant',async t=>{
 const x=await install(t),f=await x.prepare(brand),body=await x.legacyBody(f),receipt=await x.maintenance.admit(brand,'cart',body),before=await x.snapshot(receipt.event_id);
 const r=await x.maintenance.claim(receipt.event_id);noGrant(r);assert.equal(r.reason,'delegated');assert.deepEqual(await x.snapshot(r.event_id),before);
 const link=(await x.query('SELECT event_id,epoch_id,brand FROM crm_graph_candidate.maintenance_delegation_v1')).rows[0];assert.deepEqual(link,{event_id:r.event_id,epoch_id:f.epoch,brand});
 // Simulates losing the committed SQL response: same admission/claim cannot send.
 assert.deepEqual(await x.maintenance.admit(brand,'cart',body),receipt);const replay=await x.maintenance.ingest(body);noGrant(replay);assert.equal(replay.reason,'already_delegated');
 assert.deepEqual(await x.maintenance.next(brand),[]);const rec=await x.maintenance.reconcile(r.event_id);assert.equal(rec.state,'delegated');assert.equal(rec.drained,false);assert.equal(rec.authorizes_send,false);
 for(const state of ['queued','claimed','accepted','review_required'])await assert.rejects(x.query('UPDATE crm_maintenance_candidate.event SET state=$1 WHERE id=$2',[state,r.event_id]),/IMMUTABLE|TERMINAL/);
 await assert.rejects(x.query("UPDATE crm_maintenance_candidate.event SET reason='changed' WHERE id=$1",[r.event_id]),/TERMINAL/);
 await assert.rejects(x.query('DELETE FROM crm_graph_candidate.maintenance_delegation_v1 WHERE event_id=$1',[r.event_id]),/IMMUTABLE/);
 assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),1);assert.equal(await x.count('shrigma_email_dispatch'),0);assert.equal(await x.count('shrigma_send_log'),0);
});
test('epoch-only ownership remains delegated after cohort closes and graph is paused/OFF',async t=>{
 const x=await install(t),f=await x.prepare('fish',{ownership:false}),body=await x.legacyBody(f);
 await x.bridge.closeEpoch('fish',f.epoch);await x.query('UPDATE crm_graph_candidate.control SET enabled=false');await x.query('UPDATE crm_graph_candidate.cart_control_v1 SET enabled=false');await x.query('UPDATE crm_graph_candidate.journey SET paused=true');
 const r=await x.maintenance.ingest(body);noGrant(r);assert.equal(r.reason,'delegated');assert.equal((await x.query('SELECT epoch_id FROM crm_graph_candidate.maintenance_delegation_v1')).rows[0].epoch_id,f.epoch);
 assert.equal((await x.maintenance.control(2,false,'closed')).drained,false);
});
test('closed retention and expired carts retain original behavior; wrong kind/refusal cannot delegate',async t=>{
 const x=await install(t),f=await x.prepare(),body=await x.legacyBody(f);await x.maintenance.control(2,false,'closed');
 let r=await x.maintenance.ingest(body);noGrant(r);assert.equal(r.reason,'retained');assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),0);
 await x.maintenance.control(3,true,'open');assert.equal((await x.maintenance.claim(r.event_id)).reason,'delegated');
 const expired={...body,ref:new Date(Date.now()-7200000).toISOString()};r=await x.maintenance.ingest(expired);assert.equal(r.reason,'already_expired');noGrant(r);
 for(const [kind,b] of [['transactional',M.tx()],['popup',M.popup()]]){const a=await x.maintenance.admit('fish',kind,b);r=await x.maintenance.claim(a.event_id);assert.equal(r.reason,'review_required');noGrant(r);}
 const later={...body,toque:'t1',piece:'carrinho-1h',chave:'cart_t1_at'};r=await x.maintenance.ingest(later);assert.notEqual(r.reason,'delegated');assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),1);
});
test('ledger failure rolls back queued→delegated, and state cannot be set without its ledger',async t=>{
 const x=await install(t),f=await x.prepare(),body=await x.legacyBody(f),r=await x.maintenance.admit('fish','cart',body),before=await x.maintenance.row(r.event_id);
 await assert.rejects(x.query("UPDATE crm_maintenance_candidate.event SET state='delegated',reason='graph_owned' WHERE id=$1",[r.event_id]),/TRANSITION/);
 await x.db.exec("CREATE FUNCTION synthetic_delegation_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic ledger failure';END$$;CREATE TRIGGER synthetic_failure BEFORE INSERT ON crm_graph_candidate.maintenance_delegation_v1 FOR EACH ROW EXECUTE FUNCTION synthetic_delegation_failure()");
 await assert.rejects(x.maintenance.claim(r.event_id),/synthetic ledger failure/);assert.deepEqual(await x.maintenance.row(r.event_id),before);assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),0);
 await x.db.exec('DROP TRIGGER synthetic_failure ON crm_graph_candidate.maintenance_delegation_v1');assert.equal((await x.maintenance.claim(r.event_id)).reason,'delegated');
});
test('install and use preserve accepted/unknown native dispatch history, including non-owned carts',async t=>{
 const x=await install(t,{migrate:false}),history=[];
 for(const [brand,outcome] of [['fish','accepted'],['aristo','outcome_unknown']]){
  const f=await x.prepare(brand,{ownership:false,cohort:false}),legacy=await f.legacy();assert.equal(legacy.result.should_send,true);
  const r=await x.maintenance.ingest(legacy.body);assert.equal(r.dispatch_id,legacy.result.dispatch_id);
  await x.maintenance.finish({...legacy.result,outcome});history.push(await x.maintenance.row(r.event_id));
 }
 await x.migrate();for(const row of history){assert.deepEqual(await x.maintenance.row(row.id),row);const replay=await x.maintenance.claim(row.id);assert.equal(replay.should_send,false);assert.equal(replay.dispatch_id,row.dispatch_id);for(const k of ['claim_token','payload','context'])assert.equal(replay[k],null);}
 assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),0);assert.equal(await x.count('shrigma_email_dispatch'),2);
});
test('installation rejects changed original, schema drift and repeat without partial changes',async t=>{
 const x=await install(t,{migrate:false});
 await x.query("ALTER FUNCTION crm_maintenance_candidate.claim_v1(uuid) SET lock_timeout='4s'");await assert.rejects(x.migrate(),/CLAIM_DRIFT/);await x.db.exec('ROLLBACK');assert.equal((await x.query("SELECT to_regclass('crm_graph_candidate.maintenance_delegation_v1') t")).rows[0].t,null);
 await x.query("ALTER FUNCTION crm_maintenance_candidate.claim_v1(uuid) SET lock_timeout='3s'");
 await x.db.exec("ALTER TABLE crm_maintenance_candidate.event DROP CONSTRAINT event_state_check;ALTER TABLE crm_maintenance_candidate.event ADD CONSTRAINT event_state_check CHECK(state IN('queued','claimed','accepted','rejected','outcome_unknown','review_required','expired','foreign_state'))");
 await assert.rejects(x.migrate(),/STATE_DRIFT/);await x.db.exec('ROLLBACK');assert.equal((await x.query("SELECT to_regclass('crm_graph_candidate.maintenance_delegation_v1') t")).rows[0].t,null);
 await x.db.exec("ALTER TABLE crm_maintenance_candidate.event DROP CONSTRAINT event_state_check;ALTER TABLE crm_maintenance_candidate.event ADD CONSTRAINT event_state_check CHECK(state IN('queued','claimed','accepted','rejected','outcome_unknown','review_required','expired'))");
 await x.migrate();await assert.rejects(x.migrate(),/COLLISION/);await x.db.exec('ROLLBACK');assert.equal(await x.count('crm_graph_candidate.maintenance_delegation_v1'),0);
 assert.equal((await x.query("SELECT bool_and(NOT p.prosecdef) ok FROM pg_proc p WHERE p.oid IN('crm_graph_candidate.maintenance_delegate_v1(uuid)'::regprocedure,'crm_graph_candidate.maintenance_delegated_guard_v1()'::regprocedure)")).rows[0].ok,true);
});
