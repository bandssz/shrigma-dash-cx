'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {fixtureSQL,store,cartSQL,cart,tx,popup,cartAPI,workflow}=require('./maintenance-cart-fixture.cjs');
const {digest,patchCartProducer}=require('../n8n/growth/maintenance-cart-patch.cjs');
async function setup(t){const db=new PGlite();t.after(()=>db.close());await db.exec(fixtureSQL);await db.exec(store);await db.exec(cartSQL);return {db,a:cartAPI(db)};}
test('closed producer persists first, open sends original payload once; lost response never returns token again',async t=>{
 const {db,a}=await setup(t),b=cart(),r=await a.ingest(b);assert.equal(r.should_send,false);assert.equal(r.reason,'retained');assert.ok(r.event_id);assert.equal(await a.known(b),true);
 assert.equal((await a.row(r.event_id)).state,'queued');assert.deepEqual(await a.next('fish'),[]);
 await a.control(1,true,'open');const [c]=await a.next('fish');assert.equal(c.should_send,true);assert.equal(c.event_id,r.event_id);assert.deepEqual(c.payload,b);
 assert.equal((await a.ingest(b)).claim_token,null);assert.deepEqual(await a.next('fish'),[]);
 await db.query("UPDATE public.shrigma_email_dispatch SET transport_state='accepted' WHERE dispatch_id=$1",[c.dispatch_id]);
 assert.equal((await a.reconcile(r.event_id)).state,'accepted');assert.equal((await a.ingest(b)).should_send,false);
});
test('open producer path retains exact transport+context and finish identity; closed late item waits',async t=>{
 const {a}=await setup(t);await a.control(1,true,'open');const b=cart('aristo'),c=await a.ingest(b);
 assert.equal(c.should_send,true);assert.deepEqual(c.payload,b);assert.deepEqual(c.context,{brand:'aristo'});
 const close=await a.control(2,true,'closed');assert.equal(close.reserved_unconfirmed,1);assert.equal(close.drained,false);
 const late=await a.ingest(cart('fish'));assert.equal(late.reason,'retained');await a.control(3,true,'open');assert.equal((await a.next('fish'))[0].event_id,late.event_id);
});
test('rotation advances past paused first pages, isolates brands and never consumes tx/popup',async t=>{
 const {a}=await setup(t);const held=[];
 for(let i=1;i<=13;i++)held.push(await a.ingest(cart('fish',{subscriber_id:i,fixture_pause:true})));
 const ready=await a.ingest(cart('fish',{subscriber_id:99})),other=await a.ingest(cart('aristo',{subscriber_id:100}));
 await a.admit('fish','transactional',tx());await a.admit('fish','popup',popup());await a.control(1,true,'open');
 const first=[];for(let i=0;i<14;i++)first.push(...await a.next('fish'));
 assert.equal(new Set(first.map(x=>x.event_id)).size,14);assert.equal(first.filter(x=>x.should_send).length,1);assert.equal(first.find(x=>x.should_send).event_id,ready.event_id);
 assert.equal((await a.row(other.event_id)).state,'queued');assert.equal((await a.next('aristo'))[0].event_id,other.event_id);
 assert.ok(first.filter(x=>!x.should_send).every(x=>x.reason==='retained_flow_paused'));assert.equal((await a.next('fish'))[0].event_id,first.find(x=>!x.should_send).event_id);
});
test('original error rolls back effects and blocks that item for review; next item remains reachable',async t=>{
 const {db,a}=await setup(t),bad=await a.ingest(cart('fish',{subscriber_id:1})),good=await a.ingest(cart('fish',{subscriber_id:2}));await a.control(1,true,'open');
 await db.exec('UPDATE public.maintenance_fixture_policy SET crash=true');const [r]=await a.next('fish');assert.equal(r.event_id,bad.event_id);assert.equal(r.reason,'review_required');
 assert.equal((await a.row(bad.event_id)).reason,'cart_claim_failed');assert.equal((await db.query('SELECT count(*) n FROM public.shrigma_email_dispatch')).rows[0].n,0);
 await db.exec('UPDATE public.maintenance_fixture_policy SET crash=false');assert.equal((await a.next('fish'))[0].event_id,good.event_id);assert.equal((await a.ingest(cart('fish',{subscriber_id:1,ref:(await a.row(bad.event_id)).payload.ref}))).should_send,false);
});
test('expiry during original reservation produces no token/dispatch; unsupported direct scope is refused',async t=>{
 const {db,a}=await setup(t);await a.control(1,true,'open');await db.exec('UPDATE public.maintenance_fixture_policy SET delay_seconds=0.6');
 const r=await a.ingest(cart('fish',{ref:new Date(Date.now()-3600000+300).toISOString()}));assert.equal(r.reason,'expired');assert.equal(r.claim_token,null);
 assert.equal((await db.query('SELECT count(*) n FROM public.shrigma_email_dispatch')).rows[0].n,0);
 const foreign=await a.admit('fish','popup',popup());await assert.rejects(db.query('SELECT * FROM crm_maintenance_candidate.cart_attempt_v1($1)',[foreign.event_id]),/MAINTENANCE_CART_SCOPE/);
 await assert.rejects(a.next('olivas'),/MAINTENANCE_CART_BATCH/);
});
test('selector skip precedes LIMIT500, advances during maintenance and leaves other brands unchanged',async t=>{
 const {db,a}=await setup(t),ref=new Date(Date.now()-45*60000).toISOString();
 await db.exec('CREATE TABLE maintenance_selector_source(id integer,brand text,cart_at timestamptz,toque text,email text)');
 await db.query("INSERT INTO maintenance_selector_source SELECT n,b,$1::timestamptz,'t05','synthetic@example.invalid' FROM generate_series(1,501) n CROSS JOIN (VALUES('fish'),('aristo'),('olivas')) brands(b)",[ref]);
 await a.ingest(cart('fish',{ref,subscriber_id:1}));
 const w=workflow(),patched=patchCartProducer(w,{version:w.versionId,workflowHash:digest(w),connectionsHash:digest(w.connections)}),q=patched.nodes.find(n=>n.name==='Elegíveis (PG)').parameters.query;
 const fish=(await db.query(q,[null,'fish'])).rows;assert.equal(fish.length,500);assert.equal(fish[0].id,2);assert.equal(fish.at(-1).id,501);
 for(const brand of ['aristo','olivas']){const rows=(await db.query(q,[null,brand])).rows;assert.equal(rows[0].id,1);assert.equal(rows.at(-1).id,500);}
});
test('atomic finish preserves original outcome/context and immediately reconciles producer/consumer receipts',async t=>{
 const {db,a}=await setup(t);await a.control(1,true,'open');
 for(const [id,outcome] of [[1,'accepted'],[2,'rejected'],[3,'outcome_unknown']]){
  const c=await a.ingest(cart('fish',{subscriber_id:id})),reply=await a.finish({...c,outcome});assert.equal(reply.dispatch_id,c.dispatch_id);assert.equal(reply.transport_state,outcome);assert.equal(reply.send_log_id,42);assert.equal(reply.error_code,null);assert.equal((await a.row(c.event_id)).state,outcome);
  const log=(await db.query('SELECT * FROM maintenance_finish_log WHERE dispatch_id=$1',[c.dispatch_id])).rows[0];assert.deepEqual(log.context,c.context);assert.equal(log.outcome,outcome);assert.deepEqual(await a.finish({...c,outcome}),reply);assert.equal((await a.claim(c.event_id)).should_send,false);
 }
 assert.equal((await a.control(2,true,'closed')).reserved_unconfirmed,0);
});
test('reconcile failure rolls back native finish state/log; same finish retry cannot reissue transport',async t=>{
 const {db,a}=await setup(t);await a.control(1,true,'open');const c=await a.ingest(cart());
 await db.exec("CREATE FUNCTION maintenance_finish_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='accepted' THEN RAISE EXCEPTION 'synthetic reconcile failure';END IF;RETURN NEW;END $$;CREATE TRIGGER maintenance_finish_fail BEFORE UPDATE ON crm_maintenance_candidate.event FOR EACH ROW EXECUTE FUNCTION maintenance_finish_fail();");
 await assert.rejects(a.finish({...c,outcome:'accepted'}),/synthetic reconcile failure/);assert.equal((await a.row(c.event_id)).state,'claimed');assert.equal((await db.query('SELECT transport_state FROM public.shrigma_email_dispatch WHERE dispatch_id=$1',[c.dispatch_id])).rows[0].transport_state,'in_flight');assert.equal((await db.query('SELECT count(*) n FROM maintenance_finish_log')).rows[0].n,0);assert.equal((await a.claim(c.event_id)).should_send,false);
 await db.exec('DROP TRIGGER maintenance_finish_fail ON crm_maintenance_candidate.event');assert.equal((await a.finish({...c,outcome:'accepted'})).transport_state,'accepted');assert.equal((await a.row(c.event_id)).state,'accepted');
});
