'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {fixtureSQL,store,cart,tx,popup,api}=require('./maintenance-fixture.cjs');
async function setup(t){const db=new PGlite();t.after(()=>db.close());await db.exec(fixtureSQL);await db.exec(store);return {db,a:api(db)};}
test('OFF retains exact receipt, no expiry invented, no dispatch; replay and identity mismatch',async t=>{
 const {db,a}=await setup(t),b=tx(),r=await a.admit('fish','transactional',b);
 assert.equal(r.persisted,true);assert.equal(r.authorizes_send,false);assert.equal(r.expires_at,null);
 assert.deepEqual(await a.admit('fish','transactional',b),r);assert.equal((await a.claim(r.event_id)).reason,'retained');
 await assert.rejects(a.admit('fish','transactional',{...b,subject:'Changed'}),/MAINTENANCE_REPLAY_MISMATCH/);
 assert.equal((await db.query('SELECT count(*) n FROM public.shrigma_email_dispatch')).rows[0].n,0);
 const p=await a.admit('aristo','popup',popup('aristo'));assert.equal(p.expires_at,null);
});
test('brand/kind/source identity validation refuses unsupported scope and invented popup refs',async t=>{
 const {a}=await setup(t);
 for(const brand of ['olivas','cx',null])await assert.rejects(a.admit(brand,'transactional',tx()),/MAINTENANCE_INPUT/);
 await assert.rejects(a.admit('fish','nps',{}),/MAINTENANCE_INPUT/);
 await assert.rejects(a.admit('fish','cart',cart('aristo')),/MAINTENANCE_CART_IDENTITY/);
 await assert.rejects(a.admit('fish','cart',cart('fish',{piece:'carrinho-24h'})),/MAINTENANCE_CART_STAGE/);
 await assert.rejects(a.admit('fish','popup',popup('fish',{ref:'maintenance-new-identity'})),/MAINTENANCE_POPUP_IDENTITY/);
 await assert.rejects(a.admit('fish','transactional',tx({event_type:'unknown'})),/MAINTENANCE_TX_IDENTITY/);
 await assert.rejects(a.admit('fish','transactional',tx({authorization:'synthetic-secret'})),/MAINTENANCE_INPUT/);
});
test('cart canonical identity and actual expiry are preserved; expiry never reopens or extends',async t=>{
 const {a}=await setup(t),b=cart('fish',{ref:'2026-09-24T10:00:00-03:00'}),r=await a.admit('fish','cart',b);
 assert.equal(r.expires_at,'2026-09-24T14:00:00+00:00');assert.equal((await a.row(r.event_id)).state,'expired');
 assert.deepEqual(await a.admit('fish','cart',{...b,ref:'2026-09-24T13:00:00.000Z',marketing_7d:42}),r);
 await a.control(1,true,'open');assert.equal((await a.claim(r.event_id)).reason,'already_expired');
 for(const [toque,label,hours] of [['t1','1h',4],['t2','2h',5],['t24','24h',27],['t48','48h',51]]){
  const x=await a.admit('aristo','cart',cart('aristo',{ref:b.ref,toque,piece:'carrinho-'+label,chave:'cart_'+toque+'_at'}));
  assert.equal(Date.parse(x.expires_at)-Date.parse(b.ref),hours*3600000);
 }
});
test('open resumes exact original payload and token once; response loss replay is fenced',async t=>{
 const {db,a}=await setup(t),b=tx(),r=await a.admit('fish','transactional',b);await a.control(1,true,'open');
 const c=await a.claim(r.event_id);assert.equal(c.should_send,true);assert.deepEqual(c.payload,b);assert.ok(c.claim_token);
 const again=await a.claim(r.event_id);assert.equal(again.should_send,false);assert.equal(again.claim_token,null);assert.equal(again.payload,null);assert.equal(again.dispatch_id,c.dispatch_id);
 assert.equal((await db.query('SELECT count(*) n FROM public.shrigma_email_dispatch')).rows[0].n,1);
 for(const state of ['accepted','outcome_unknown','rejected']){
  await db.query('UPDATE public.shrigma_email_dispatch SET transport_state=$1 WHERE dispatch_id=$2',[state,c.dispatch_id]);
  assert.equal((await a.reconcile(r.event_id)).state,state);assert.equal((await a.claim(r.event_id)).should_send,false);
 }
 assert.deepEqual(await a.admit('fish','transactional',b),r);
});
test('preexisting accepted/unknown/inflight/rejected dispatch is attached without new reservation',async t=>{
 const {db,a}=await setup(t);await a.control(1,true,'open');
 for(const state of ['accepted','outcome_unknown','in_flight','rejected']){
  const b=tx(),old=(await db.query("SELECT * FROM public.shrigma_flow_email_claim_tx('aristo',$1)",[JSON.stringify(b)])).rows[0];
  await db.query('UPDATE public.shrigma_email_dispatch SET transport_state=$1 WHERE dispatch_id=$2',[state,old.dispatch_id]);
  const e=await a.admit('aristo','transactional',b),c=await a.claim(e.event_id);assert.equal(c.should_send,false);assert.equal(c.dispatch_id,old.dispatch_id);assert.equal(c.claim_token,null);
 }
 assert.equal((await db.query('SELECT count(*) n FROM public.shrigma_email_dispatch')).rows[0].n,4);
});
test('existing policy is reevaluated: pause retains, optout requires review, no new dedupe on reopening',async t=>{
 const {db,a}=await setup(t),e=await a.admit('fish','popup',popup());await a.control(1,true,'open');
 await db.exec('UPDATE public.maintenance_fixture_policy SET paused=true');assert.equal((await a.claim(e.event_id)).reason,'retained_flow_paused');
 assert.equal((await a.row(e.event_id)).state,'queued');
 await db.exec('UPDATE public.maintenance_fixture_policy SET paused=false,optout=true');assert.equal((await a.claim(e.event_id)).reason,'review_required');
 await db.exec('UPDATE public.maintenance_fixture_policy SET optout=false');assert.equal((await a.claim(e.event_id)).should_send,false);
});
test('atomic rollback on original failure, wrong token or identity; no partial dispatch/event claim',async t=>{
 const {db,a}=await setup(t),e=await a.admit('fish','transactional',tx());await a.control(1,true,'open');
 for(const flag of ['crash','bad_token']){
  await db.exec(`UPDATE public.maintenance_fixture_policy SET ${flag}=true`);await assert.rejects(a.claim(e.event_id));
  assert.equal((await a.row(e.event_id)).state,'queued');assert.equal((await db.query('SELECT count(*) n FROM public.shrigma_email_dispatch')).rows[0].n,0);
  await db.exec(`UPDATE public.maintenance_fixture_policy SET ${flag}=false`);
 }
 assert.equal((await a.claim(e.event_id)).should_send,true);
});
test('control CAS, exact durable replay and no false drain claim; late message stays queued',async t=>{
 const {a}=await setup(t),op=randomUUID(),r=await a.control(1,true,'open',op);assert.deepEqual(await a.control(1,true,'open',op),r);
 await assert.rejects(a.control(1,true,'closed',op),/MAINTENANCE_REPLAY_MISMATCH/);await assert.rejects(a.control(1,true,'closed'),/MAINTENANCE_VERSION_CONFLICT/);
 const e=await a.admit('fish','transactional',tx());await a.claim(e.event_id);
 const close=await a.control(2,true,'closed');assert.equal(close.reserved_unconfirmed,1);assert.equal(close.drained,false);assert.ok(close.cutoff_at);
 const late=await a.admit('aristo','popup',popup('aristo'));assert.equal((await a.claim(late.event_id)).reason,'retained');
 await a.control(3,true,'open');assert.equal((await a.claim(late.event_id)).should_send,true);assert.equal((await a.claim(e.event_id)).should_send,false);
});
test('immutable input/receipt/operation; PUBLIC has no execution or schema privilege',async t=>{
 const {db,a}=await setup(t),e=await a.admit('fish','transactional',tx());await a.control(1,true,'closed');
 await assert.rejects(db.query("UPDATE crm_maintenance_candidate.event SET payload='{}' WHERE id=$1",[e.event_id]),/MAINTENANCE_IMMUTABLE/);
 await assert.rejects(db.query('DELETE FROM crm_maintenance_candidate.event WHERE id=$1',[e.event_id]),/MAINTENANCE_IMMUTABLE/);
 await assert.rejects(db.query("UPDATE crm_maintenance_candidate.operation SET response='{}'"),/MAINTENANCE_IMMUTABLE/);
 await db.exec('CREATE ROLE maintenance_untrusted');
 assert.equal((await db.query("SELECT has_schema_privilege('maintenance_untrusted','crm_maintenance_candidate','USAGE') ok")).rows[0].ok,false);
 assert.equal((await db.query("SELECT has_function_privilege('maintenance_untrusted','crm_maintenance_candidate.claim_v1(uuid)','EXECUTE') ok")).rows[0].ok,false);
});

test('temporary denials retain same identity; unknown denial is held for review without automatic retry',async t=>{
 const {db,a}=await setup(t),b=cart(),e=await a.admit('fish','cart',b);await a.control(1,true,'open');
 for(const reason of ['not_due','journey_paused','cadence_or_cap_changed']){
  await db.query('UPDATE public.maintenance_fixture_policy SET refusal=$1',[reason]);assert.equal((await a.claim(e.event_id)).reason,'retained_'+reason);assert.equal((await a.row(e.event_id)).state,'queued');
 }
 await db.exec('UPDATE public.maintenance_fixture_policy SET refusal=NULL');assert.equal((await a.claim(e.event_id)).should_send,true);
 const x=await a.admit('aristo','transactional',tx());await db.exec("UPDATE public.maintenance_fixture_policy SET refusal='new_reason'");
 assert.equal((await a.claim(x.event_id)).reason,'review_required');await db.exec('UPDATE public.maintenance_fixture_policy SET refusal=NULL');
 assert.equal((await a.claim(x.event_id)).reason,'already_review_required');assert.equal((await a.row(x.event_id)).reason,'unrecognized_original_refusal');
});
test('deadline crossed during original reservation rolls back its dispatch before returning expired',async t=>{
 const {db,a}=await setup(t);await a.control(1,true,'open');
 const b=cart('fish',{ref:new Date(Date.now()-3600000+400).toISOString()}),e=await a.admit('fish','cart',b);
 await db.exec('UPDATE public.maintenance_fixture_policy SET delay_seconds=0.6');
 const c=await a.claim(e.event_id);assert.equal(c.reason,'expired');assert.equal(c.should_send,false);assert.equal(c.claim_token,null);
 assert.equal((await a.row(e.event_id)).state,'expired');assert.equal((await db.query('SELECT count(*) n FROM public.shrigma_email_dispatch')).rows[0].n,0);
});
