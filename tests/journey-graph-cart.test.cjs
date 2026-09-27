'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {install,id}=require('./journey-graph-cart-fixture.cjs'),C=require('../n8n/growth/journey-graph-cart.cjs');
const sql=fs.readFileSync(require.resolve('../n8n/growth/journey-graph-cart.sql'),'utf8');
const count=async(x,table)=>(await x.query('SELECT count(*)::int n FROM '+table)).rows[0].n;
test('OFF installation is scoped; exact legacy finish stays unchanged; drift/reinstallation is refused',async t=>{
 const x=await install(t);assert.deepEqual((await x.query('SELECT enabled FROM crm_graph_candidate.cart_control_v1 ORDER BY brand')).rows,[{enabled:false},{enabled:false}]);
 assert.equal((await x.query("SELECT md5(pg_get_functiondef('shrigma_email_finish_cart(uuid,uuid,text,jsonb)'::regprocedure)) hash")).rows[0].hash,x.originalFinish);
 await assert.rejects(x.db.exec(sql),/GRAPH_CART_LEGACY_DRIFT/);await x.query('ROLLBACK');
 assert.equal((await x.query("SELECT count(*)::int n FROM pg_proc p WHERE pronamespace='crm_graph_candidate'::regnamespace AND proname LIKE 'cart_%' AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')")).rows[0].n,0);
});
test('Fish and Aristo use exact clone, canonical native identity and one durable dispatch; finish remains original',async t=>{
 for(const brand of ['fish','aristo']){
  const x=await install(t),f=await x.prepare(brand),proof=await f.proof(),grant=await f.claim.claim(f.request);assert.equal(grant.should_send,true);assert.equal(grant.payload.template_id,f.preparedClone.clone_template_id);assert.equal(grant.context.graph_intent_id,f.intent.intent_id);assert.ok(Date.parse(grant.context.graph_expires_at)>Date.now());assert.equal(grant.context.ref,x.ref);
  const d=(await x.query('SELECT * FROM shrigma_email_dispatch')).rows[0];assert.equal(d.dedupe_key,JSON.stringify(['email',x.ref,1,false]).replaceAll(',',', '));assert.equal(d.is_test,false);assert.equal(d.flow,'carrinho');assert.equal(d.piece,'carrinho-30min');
  assert.equal(await count(x,'crm_graph_candidate.cart_permit_v1'),0);assert.equal(await count(x,'crm_graph_candidate.cart_delivery_v1'),1);
  const replay=await x.bridge.claim({...f.request,preflight:proof});assert.equal(replay.reason,'in_flight');assert.equal(replay.should_send,false);assert.equal(replay.claim_token,null);assert.equal(replay.payload,null);
  const finish=await f.finish(grant);assert.equal(finish.transport_state,'accepted');assert.equal((await f.finish(grant)).send_log_id,finish.send_log_id);assert.equal(await count(x,'shrigma_send_log'),1);
  const lookup=await x.bridge.dispatch(brand,f.intent.intent_id);assert.equal(lookup.transport_state,'accepted');assert.equal(lookup.dispatch_id,grant.dispatch_id);assert.equal(lookup.revision,f.entry.revision);assert.equal(await x.bridge.dispatch(brand==='fish'?'aristo':'fish',f.intent.intent_id),null);
  await assert.rejects(f.finish({...grant,context:{...grant.context,template_id:60}}),/PAYLOAD_MISMATCH/);
 }
});
test('ownership persists across pause and epoch closure; cohort without enrolled owner is blocked from legacy',async t=>{
 const x=await install(t),f=await x.prepare('fish',{ownership:false});assert.equal((await f.legacy()).result.reason,'graph_owned');await assert.rejects(f.claim.claim(f.request),/OWNER_REQUIRED/);assert.equal(await count(x,'shrigma_email_dispatch'),0);
 await x.bridge.enroll('fish',f.entry.id);await x.bridge.closeEpoch('fish',f.epoch);await x.query('UPDATE crm_graph_candidate.cart_control_v1 SET enabled=false');assert.equal((await f.legacy()).result.reason,'graph_owned');await assert.rejects(f.claim.claim(f.request),/DISABLED/);assert.equal(await count(x,'shrigma_email_dispatch'),0);
});
test('new server-clock epoch cannot adopt an old cart; open replay is exact and history immutable',async t=>{
 const x=await install(t),f=await x.prepare('fish',{ownership:false,cohort:false});
 const j=(await x.query('SELECT * FROM crm_graph_candidate.journey')).rows[0];const ep=await x.bridge.openEpoch('panel:synthetic',{brand:'fish',journey_id:j.id,expected_version:j.version});assert.ok(Date.parse(ep.starts_at)>Date.parse(x.ref));assert.equal((await x.bridge.openEpoch('panel:synthetic',{brand:'fish',journey_id:j.id,expected_version:j.version})).epoch_id,ep.epoch_id);
 await assert.rejects(x.bridge.openEpoch('panel:different',{brand:'fish',journey_id:j.id,expected_version:j.version}),/EPOCH_CONFLICT/);
 await assert.rejects(x.query("UPDATE crm_graph_candidate.cart_epoch_v1 SET starts_at=starts_at-interval '1 hour' WHERE id=$1",[ep.epoch_id]),/IMMUTABLE/);
 await assert.rejects(x.bridge.enroll('fish',f.entry.id),/COHORT_MISMATCH/);
 assert.equal((await f.legacy()).result.should_send,true);
});
test('legacy outside the graph cohort remains byte-equivalent and original dedupe blocks a subsequent graph owner',async t=>{
 const x=await install(t),f=await x.prepare('fish',{ownership:false});const p=await f.proof(),base=60;
 const body={brand:'fish',toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',subscriber_id:1,email:p.recipient.email,ref:p.ref,template_id:base,tx:{...p.message,template_id:base,content_type:'html'}};
 // Fixture reset bypasses immutable history only to model a deployment after a prior native claim.
 await x.query('ALTER TABLE crm_graph_candidate.cart_epoch_v1 DISABLE TRIGGER graph_cart_epoch_immutable');await x.query("UPDATE crm_graph_candidate.cart_epoch_v1 SET starts_at=clock_timestamp()");await x.query('ALTER TABLE crm_graph_candidate.cart_epoch_v1 ENABLE TRIGGER graph_cart_epoch_immutable');
 const native=(await x.query('SELECT * FROM shrigma_email_claim_cart($1)',[body])).rows[0];assert.equal(native.should_send,true);assert.equal(native.payload.template_id,60);await assert.rejects(x.bridge.enroll('fish',f.entry.id),/COHORT_MISMATCH/);
 await x.query('ALTER TABLE crm_graph_candidate.cart_epoch_v1 DISABLE TRIGGER graph_cart_epoch_immutable');await x.query("UPDATE crm_graph_candidate.cart_epoch_v1 SET starts_at=$1::timestamptz-interval '1 minute'",[x.ref]);await x.query('ALTER TABLE crm_graph_candidate.cart_epoch_v1 ENABLE TRIGGER graph_cart_epoch_immutable');await x.bridge.enroll('fish',f.entry.id);
 const r=await x.bridge.claim({...f.request,preflight:p});assert.equal(r.reason,'legacy_existing_dispatch');assert.equal(r.claim_token,null);assert.equal(await count(x,'crm_graph_candidate.cart_delivery_v1'),0);assert.equal(await count(x,'shrigma_email_dispatch'),1);
});
test('published base template overrides cannot replace pinned clone; global legacy pause still blocks',async t=>{
 const x=await install(t),f=await x.prepare();await x.query("UPDATE shrigma_flow_definition SET published=jsonb_set(published,'{steps,0,template_id}','\"61\"') WHERE brand='fish'");
 const r=await f.claim.claim(f.request);assert.equal(r.should_send,true);assert.equal(r.payload.template_id,f.preparedClone.clone_template_id);
 const y=await install(t),g=await y.prepare();await y.query("UPDATE shrigma_flow_definition SET enabled=false WHERE brand='fish'");const denied=await g.claim.claim(g.request);assert.equal(denied.reason,'flow_paused');assert.equal(await count(y,'shrigma_email_dispatch'),0);
});
test('trusted proof expiry, identity, raw URL and freshness changes never reserve',async t=>{
 const x=await install(t),f=await x.prepare(),p=await f.proof();
 for(const mutate of [v=>v.recipient.email='other@example.invalid',v=>v.recipient.subject_id=id(88),v=>v.material_sha256='0'.repeat(64),v=>v.native_id=id(88),v=>v.expires_at=new Date(Date.now()-1).toISOString(),v=>v.source_checkout_url+='?changed=1']){const proof=structuredClone(p);mutate(proof);await assert.rejects(x.bridge.claim({...f.request,preflight:proof}),/GRAPH_CART_/);}
 await x.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");await assert.rejects(x.bridge.claim({...f.request,preflight:p}),/SOURCE_CHANGED/);assert.equal(await count(x,'shrigma_email_dispatch'),0);
});
test('canonical URL retains trusted parameters but strips legacy UTMs; graph marker cannot forge permit',async t=>{
 const raw='https://fishermans.com.br/cart/test?discount=SYNTHETIC&utm_source=old&utm_term=legacy';const u=new URL(C.canonicalURL(raw,'fish'));assert.equal(u.searchParams.get('discount'),'SYNTHETIC');assert.equal(u.searchParams.has('utm_term'),false);assert.equal(u.searchParams.get('utm_source'),'email');assert.throws(()=>C.canonicalURL(raw,'aristo'),/URL/);
 const x=await install(t),f=await x.prepare(),{body}=await f.legacy();await assert.rejects(x.query('SELECT * FROM shrigma_email_claim_cart($1)',[{...body,graph_intent_id:f.intent.intent_id}]),/PERMIT_INVALID/);assert.equal(await count(x,'shrigma_email_dispatch'),0);
});
test('atomic delivery linkage failure rolls back reservation; retry uses one original identity',async t=>{
 const x=await install(t),f=await x.prepare();await x.db.exec("CREATE FUNCTION synthetic_delivery_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic';END$$;CREATE TRIGGER synthetic_failure BEFORE INSERT ON crm_graph_candidate.cart_delivery_v1 FOR EACH ROW EXECUTE FUNCTION synthetic_delivery_fail()");await assert.rejects(f.claim.claim(f.request),/OUTCOME_UNKNOWN/);assert.equal(await count(x,'shrigma_email_dispatch'),0);assert.equal(await count(x,'crm_graph_candidate.cart_permit_v1'),0);
 await x.query('DROP TRIGGER synthetic_failure ON crm_graph_candidate.cart_delivery_v1');assert.equal((await f.claim.claim(f.request)).should_send,true);assert.equal(await count(x,'shrigma_email_dispatch'),1);
});
test('private grant rejects diverging payload/context, extra fields and leaked tokens on losers',async t=>{
 const x=await install(t),f=await x.prepare(),r=await f.claim.claim(f.request);for(const mutate of [a=>a.payload.data.checkout_url+='&tampered=1',a=>a.context.tx.subject='extra',a=>a.context.graph_expires_at='invalid',a=>a.payload.headers.push({'X-Unexpected':'bad'}),a=>a.context.graph_intent_id=id(88)]){const bad=structuredClone(r);mutate(bad);assert.throws(()=>C.validateClaim(bad,{brand:'fish',intent_id:f.intent.intent_id}),/UNCONFIRMED/);}
 assert.throws(()=>C.validateClaim({should_send:false,dispatch_id:r.dispatch_id,claim_token:r.claim_token,payload:null,context:null,reason:'in_flight'}),/UNCONFIRMED/);
});
test('maintenance unavailable or closed blocks both direct RPC and epoch open',async t=>{
 const x=await install(t),f=await x.prepare(),p=await f.proof();await x.query("UPDATE crm_maintenance_candidate.control SET mode='closed'");await assert.rejects(x.bridge.claim({...f.request,preflight:p}),/MAINTENANCE_CLOSED/);
 await x.query('DROP TABLE crm_maintenance_candidate.control');await assert.rejects(x.bridge.claim({...f.request,preflight:p}),/MAINTENANCE_UNAVAILABLE/);assert.equal(await count(x,'shrigma_email_dispatch'),0);
});
test('real RPC accepts canonical trusted checkout with replaced UTMs, preserving discount and clone content',async t=>{
 const x=await install(t),raw='https://fishermans.com.br/cart/synthetic?discount=SYNTHETIC&utm_source=old&utm_term=prior';await x.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,cart_url}',$1::jsonb) WHERE id=1",[JSON.stringify(raw)]);const f=await x.prepare(),r=await f.claim.claim(f.request);assert.equal(r.should_send,true);assert.equal(r.payload.data.checkout_url,C.canonicalURL(raw,'fish'));assert.equal((await f.finish(r)).transport_state,'accepted');
});
