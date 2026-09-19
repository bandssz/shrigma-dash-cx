/* Isolated PostgreSQL. Optional JOURNEY_CART_FUNCTIONS_FILE points to a PRIVATE
   fresh function export for exact-runtime regression. Never commit that export.
   Test-only digest stub validates binding/equality, not cryptographic strength.
   PGlite serializes one connection: no multi-session race claim is made. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const {createCartEntryProvider}=require('../n8n/growth/journey-cart-provider.cjs');
const {createTemplateReleaseProvider}=require('../n8n/growth/journey-template-provider.cjs');
const {createCartScanner}=require('../n8n/growth/journey-cart-scanner.cjs');
const {patchCollector,collectorHandoff,patchLegacySelector}=require('../n8n/growth/journey-cart-runtime-patch.cjs');
const fixture=read('tests/sql/journey-cart-fixture.sql');
(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec(fixture);
  if(process.env.JOURNEY_CART_FUNCTIONS_FILE){
   const functions=JSON.parse(fs.readFileSync(process.env.JOURNEY_CART_FUNCTIONS_FILE,'utf8'));
   for(const name of ['shrigma_flow_slot','shrigma_flow_wait','shrigma_flow_stage_enabled','shrigma_email_claim_cart','shrigma_email_finish_cart']){
    const f=functions.find(x=>x.proname===name);assert.ok(f&&f.definition);await db.exec(f.definition);
   }
  }
  const original=(await db.query("SELECT pg_get_functiondef('shrigma_email_claim_cart(jsonb)'::regprocedure) AS source")).rows[0].source;
  const finishBefore=(await db.query("SELECT pg_get_functiondef('shrigma_email_finish_cart(uuid,uuid,text,jsonb)'::regprocedure) AS source")).rows[0].source;
  await db.exec(read('n8n/growth/journey-template-release.sql'));
  const cache=new Map(),cacheTarget='fixture-single-instance';
  const releases=createTemplateReleaseProvider({query:(q,p)=>db.query(q,p),cacheTarget,nativeCreate:async p=>{
   const t=(await db.query('INSERT INTO templates(name,type,subject,body,body_source) VALUES($1,$2,$3,$4,$5) RETURNING *',[p.name,p.type,p.subject,p.body,p.body_source])).rows[0];
   cache.set(t.id,{...p});return {status:200,body:{data:t}};
  }});
  const release60=(await releases.create((await releases.prepare(60)).id)).release;
  const release61=(await releases.create((await releases.prepare(61)).id)).release;
  const sql=read('n8n/growth/journey-cart-entry.sql');await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query("SELECT pg_get_functiondef('shrigma_email_finish_cart(uuid,uuid,text,jsonb)'::regprocedure) AS source")).rows[0].source,finishBefore);
  assert.equal((await db.query('SELECT enabled FROM shrigma_journey_cart_control_v1')).rows[0].enabled,false);
  const provider=createCartEntryProvider({query:(q,p)=>db.query(q,p),cacheTarget});let next=100;
  async function source(minutes=35){
   const id=next++,ref=new Date(Date.now()-minutes*60000).toISOString();
   await db.query("INSERT INTO subscribers(id,email,status,attribs) VALUES($1,$2,'enabled',$3::jsonb)",[id,'fixture-'+id+'@example.invalid',JSON.stringify({fish:{cart_abandoned_at:ref,cart_url:'https://fishermans.com.br/checkouts/fixture',flows:{}}})]);
   await db.query("INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES($1,22,'confirmed')",[id]);return {id,ref};
  }
  const payload=s=>({brand:'fish',toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',template_id:60,subscriber_id:s.id,ref:s.ref,email:'fixture-'+s.id+'@example.invalid',tx:{template_id:60,subscriber_email:'fixture-'+s.id+'@example.invalid',from_email:'Fishermans <contato@fishermans.com.br>',headers:[{'Reply-To':'contato@fishermans.com.br'}],data:{checkout_url:'https://fishermans.com.br/checkouts/fixture?utm_source=email&utm_medium=fluxo&utm_campaign=fish-carrinho&utm_content=carrinho-30min'}}});
  const legacy=async p=>(await db.query('SELECT * FROM shrigma_email_claim_cart($1::jsonb)',[JSON.stringify(p)])).rows[0];
  let s=await source();assert.equal((await provider.enroll(s.id,s.ref)).reason,'outside_cohort');assert.equal((await legacy(payload(s))).should_send,true,'install leaves existing legacy route working');
  const historical=(await db.query('SELECT * FROM shrigma_email_dispatch')).rows;
  await db.exec("UPDATE shrigma_journey_cart_control_v1 SET enabled=true,starts_at=clock_timestamp()-interval '2 hours',template_cache_target='fixture-single-instance'");
  s=await source();assert.equal((await legacy(payload(s))).reason,'journey_entry_required','captured cohort cannot bypass the new owner');
  let entry=await provider.enroll(s.id,s.ref),before=await provider.get(entry.entry_id);assert.equal(entry.created,true);
  assert.equal((await provider.enroll(s.id,s.ref)).entry_id,entry.entry_id);assert.equal((await provider.enroll(s.id,s.ref)).created,false);
  assert.ok((await provider.due()).some(x=>x.entry_id===entry.entry_id));assert.equal((await provider.check(entry.entry_id)).reason,'due');
  // New publication changes both template and wait; entry retains its original.
  await db.exec("UPDATE shrigma_flow_definition SET published_version=2,published=jsonb_set(jsonb_set(published,'{steps,0,wait_min}','45'),'{steps,0,template_id}','\"61\"') WHERE key='fish:carrinho'");
  let claim=await provider.claim(entry.entry_id,payload(s));assert.equal(claim.should_send,true);assert.equal(claim.payload.template_id,release60.clone_template_id);assert.equal(claim.context.template_id,release60.clone_template_id);
  let stored=await provider.get(entry.entry_id);assert.equal(stored.published_version,1);assert.equal(stored.due_at,before.due_at);assert.equal(stored.dispatch_id,claim.dispatch_id);assert.equal(stored.state,'reserved');
  const duplicate=await provider.claim(entry.entry_id,payload(s));assert.equal(duplicate.should_send,false);assert.equal((await provider.get(entry.entry_id)).dispatch_id,claim.dispatch_id);
  const unknown=(await db.query('SELECT * FROM shrigma_email_finish_cart($1,$2,$3,$4::jsonb)',[claim.dispatch_id,claim.claim_token,'outcome_unknown',JSON.stringify(claim.context)])).rows[0];assert.equal(unknown.transport_state,'outcome_unknown');
  assert.equal((await provider.get(entry.entry_id)).transport_state,'outcome_unknown');assert.equal((await provider.claim(entry.entry_id,payload(s))).should_send,false);
  await db.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,last_order_at}',to_jsonb(clock_timestamp())) WHERE id=$1",[s.id]);
  const interrupted=await provider.check(entry.entry_id);assert.equal(interrupted.reason,'purchase_after_reservation');assert.equal(interrupted.state,'reserved');assert.equal(interrupted.transport_state,'outcome_unknown');
  // Reset only fixture configuration; no entry or reservation is deleted.
  await db.exec("UPDATE shrigma_flow_definition SET published_version=1,published=jsonb_set(jsonb_set(published,'{steps,0,wait_min}','30'),'{steps,0,template_id}','\"60\"') WHERE key='fish:carrinho'");
  for(const scenario of ['global_pause','not_due','expired','purchase','opt_out','superseded','release_guard_missing']){
   s=await source(scenario==='not_due'?10:scenario==='expired'?65:35);entry=await provider.enroll(s.id,s.ref);
   if(scenario==='global_pause')await db.exec("UPDATE shrigma_flow_definition SET enabled=false WHERE key='fish:carrinho'");
   if(scenario==='purchase')await db.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,last_order_at}',to_jsonb(clock_timestamp())) WHERE id=$1",[s.id]);
   if(scenario==='opt_out')await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1",[s.id]);
   if(scenario==='superseded')await db.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,cart_abandoned_at}',to_jsonb(clock_timestamp())) WHERE id=$1",[s.id]);
   if(scenario==='release_guard_missing')await db.exec('ALTER TABLE templates DISABLE TRIGGER shrigma_journey_template_guard_v1');
   const r=await provider.claim(entry.entry_id,payload(s));assert.equal(r.should_send,false,scenario);
   if(scenario==='global_pause'){assert.equal(r.reason,'flow_paused');await db.exec("UPDATE shrigma_flow_definition SET enabled=true WHERE key='fish:carrinho'");}
   else assert.equal((await provider.get(entry.entry_id)).reason,{not_due:'not_due',expired:'window_expired',purchase:'purchase_observed',opt_out:'opt_out_or_unavailable',superseded:'source_superseded',release_guard_missing:'template_release_unavailable'}[scenario]);
   if(scenario==='opt_out'){
    await db.query("UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=$1",[s.id]);assert.equal((await provider.claim(entry.entry_id,payload(s))).should_send,false,'resubscription cannot reopen cancelled entry');
   }
   if(scenario==='release_guard_missing')await db.exec('ALTER TABLE templates ENABLE TRIGGER shrigma_journey_template_guard_v1');
  }
  // Source remains editable after capture; both DB clone and simulated cache
  // retain pinned content before and after reservation. Unprepared new bytes fail.
  s=await source();entry=await provider.enroll(s.id,s.ref);
  await db.exec("UPDATE templates SET body='New source revision' WHERE id=60");
  claim=await provider.claim(entry.entry_id,payload(s));assert.equal(claim.should_send,true);
  assert.equal(claim.payload.template_id,release60.clone_template_id);assert.equal(cache.get(claim.payload.template_id).body,'Fixture');
  await assert.rejects(db.query("UPDATE templates SET body='Change after claim' WHERE id=$1",[release60.clone_template_id]),/IMMUTABLE/);
  const freshSource=await source();await assert.rejects(provider.enroll(freshSource.id,freshSource.ref),/RELEASE_UNAVAILABLE/);
  await db.exec("UPDATE templates SET body='Fixture' WHERE id=60");
  // A transport routed to a different cache is never authorized.
  const otherCache=createCartEntryProvider({query:(q,p)=>db.query(q,p),cacheTarget:'another-instance'});
  s=await source();entry=await provider.enroll(s.id,s.ref);
  await assert.rejects(otherCache.claim(entry.entry_id,payload(s)),/binding unconfirmed/);
  assert.equal((await provider.get(entry.entry_id)).state,'reserved','an uncertain caller cannot discard the reservation');
  // Template subject cannot be replaced through the tx override fields.
  s=await source();entry=await provider.enroll(s.id,s.ref);
  for(const field of ['subject','altbody']){
   const b=payload(s);b.tx[field]='Unpinned content';
   await assert.rejects(provider.claim(entry.entry_id,b),/OVERRIDE_UNSUPPORTED/);
   assert.equal((await provider.get(entry.entry_id)).state,'waiting');
  }
  // A fresh purchase or opt-out between reservation and the final provider read
  // blocks HTTP authorization without removing/reopening the dispatch.
  for(const interrupt of ['purchase','opt_out','source','flow_pause','cohort_pause']){
   s=await source();entry=await provider.enroll(s.id,s.ref);
   const guarded=createCartEntryProvider({cacheTarget,query:async(q,p)=>{
    const result=await db.query(q,p);
    if(q.includes('shrigma_email_claim_cart')&&result.rows[0]?.should_send){
     if(interrupt==='purchase')await db.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,last_order_at}',to_jsonb(clock_timestamp())) WHERE id=$1",[s.id]);
     else if(interrupt==='opt_out')await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1",[s.id]);
     else if(interrupt==='source')await db.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,cart_abandoned_at}',to_jsonb(clock_timestamp())) WHERE id=$1",[s.id]);
     else if(interrupt==='flow_pause')await db.exec("UPDATE shrigma_flow_definition SET enabled=false WHERE key='fish:carrinho'");
     else await db.exec('UPDATE shrigma_journey_cart_control_v1 SET enabled=false');
    }
    return result;
   }});
   await assert.rejects(guarded.claim(entry.entry_id,payload(s)),/binding unconfirmed/);
   const interrupted=await provider.get(entry.entry_id);assert.equal(interrupted.state,'reserved');
   assert.equal(interrupted.reason,{purchase:'purchase_after_reservation',opt_out:'opt_out_after_reservation',source:'source_superseded_after_reservation',flow_pause:'flow_paused_after_reservation',cohort_pause:'journey_paused_after_reservation'}[interrupt]);
   assert.equal((await provider.claim(entry.entry_id,payload(s))).should_send,false);
   if(interrupt==='flow_pause')await db.exec("UPDATE shrigma_flow_definition SET enabled=true WHERE key='fish:carrinho'");
   if(interrupt==='cohort_pause')await db.exec('UPDATE shrigma_journey_cart_control_v1 SET enabled=true');
  }
  // Abort at the entry attachment: the original dispatch INSERT must roll back.
  s=await source();entry=await provider.enroll(s.id,s.ref);
  await db.exec(`CREATE FUNCTION fixture_attachment_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${entry.entry_id}' AND NEW.state='reserved' THEN RAISE EXCEPTION 'FIXTURE_ATTACHMENT_FAIL';END IF;RETURN NEW;END $$;
   CREATE TRIGGER fixture_attachment_fail BEFORE UPDATE ON shrigma_journey_cart_entry_v1 FOR EACH ROW EXECUTE FUNCTION fixture_attachment_fail()`);
  const count=()=>db.query('SELECT count(*)::int n FROM shrigma_email_dispatch');const oldCount=(await count()).rows[0].n;
  await assert.rejects(provider.claim(entry.entry_id,payload(s)),/FIXTURE_ATTACHMENT_FAIL/);assert.equal((await count()).rows[0].n,oldCount);assert.equal((await provider.get(entry.entry_id)).state,'waiting');
  await db.exec('DROP TRIGGER fixture_attachment_fail ON shrigma_journey_cart_entry_v1;DROP FUNCTION fixture_attachment_fail()');
  claim=await provider.claim(entry.entry_id,payload(s));assert.equal(claim.should_send,true);
  await assert.rejects(provider.claim(entry.entry_id,{...payload(s),subscriber_id:s.id+1}),/JOURNEY_ENTRY_MISMATCH/);
  // A scanner consumes collector IDs after list reconciliation. The native
  // collector counters and upsert behavior are unchanged by its additive receipt.
  await db.exec("ALTER TABLE subscribers ADD COLUMN uuid uuid;ALTER TABLE subscribers ADD COLUMN name text;ALTER TABLE subscribers ADD COLUMN created_at timestamptz;ALTER TABLE subscribers ADD UNIQUE(email);ALTER TABLE subscribers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 1000);ALTER TABLE subscriber_lists ADD COLUMN meta jsonb;ALTER TABLE subscriber_lists ADD COLUMN created_at timestamptz;ALTER TABLE subscriber_lists ADD COLUMN updated_at timestamptz");
  // The n8n boundary supplies the brand as text; make that parameter type
  // explicit for the isolated raw PostgreSQL driver before polymorphic JSON.
  const sourceQuery=read('tests/sql/journey-collector-fixture.sql').replace('WITH data AS (','WITH fixture_parameter_types AS (SELECT $2::text AS brand), data AS (');
  const workflow={versionId:'fixture-v1',nodes:[{name:'Upsert Carrinhos (Listmonk PG)',type:'n8n-nodes-base.postgres',parameters:{query:sourceQuery}}],connections:{}};
  const changed=patchCollector(workflow,{expectedVersion:'fixture-v1'}).nodes[0].parameters.query;
  const batch=[JSON.stringify([{email:'scanner@example.invalid',name:'Fixture',first_name:'Fixture',cart_abandoned_at:new Date(Date.now()-35*60000).toISOString(),cart_value:0,cart_url:'https://example.invalid/checkout',cart_items:[],cart_id:'fixture',cart_phone:null,mkt_consent:'yes'}]),'fish',3];
  await db.exec('BEGIN');const oldReceipt=(await db.query(sourceQuery,batch)).rows[0];await db.exec('ROLLBACK');
  const receipt=(await db.query(changed,batch)).rows;assert.equal(receipt[0].carrinhos_gravados,oldReceipt.carrinhos_gravados);assert.equal(receipt[0].novos_na_base_geral,oldReceipt.novos_na_base_geral);
  const handoff=collectorHandoff(receipt,{brand:'fish'});assert.equal(handoff.mode,'dry_run');
  await db.query("INSERT INTO subscriber_lists(subscriber_id,list_id,status) SELECT unnest($1::integer[]),22,'confirmed'",[handoff.sourceIds]);
  const scanner=createCartScanner({query:(q,p)=>db.query(q,p),entries:provider});
  const fingerprint=async()=>(await db.query("SELECT (SELECT count(*) FROM shrigma_email_dispatch)::int AS dispatches,(SELECT md5(coalesce(jsonb_agg(to_jsonb(e) ORDER BY id)::text,'')) FROM shrigma_journey_cart_entry_v1 e) AS entries,(SELECT count(*) FROM shrigma_journey_cart_decision_v1)::int AS decisions")).rows[0];
  const beforeDry=await fingerprint(),dry=await scanner.run({...handoff,limit:2});assert.equal(dry.sends,0);assert.deepEqual(await fingerprint(),beforeDry,'dry run must not mutate ledger or source');
  const captureRun=await scanner.run({...handoff,mode:'capture',limit:2});assert.equal(captureRun.capture[0].action,'captured');assert.equal(captureRun.sends,0);
  assert.equal((await fingerprint()).dispatches,beforeDry.dispatches,'capture/check cannot reserve transport');
  assert.equal((await scanner.run({...handoff,mode:'capture',limit:2})).capture[0].action,'already_captured');
  // The patched selector excludes only Fish initial entries owned by the cohort.
  const selector="WITH cl AS (SELECT x AS id,clock_timestamp()-interval '35 minutes' AS cart_at,CASE WHEN x=1 THEN 't05' WHEN x=2 THEN 't1' END AS toque FROM unnest($1::int[])x) SELECT cl.id,cl.cart_at FROM cl WHERE cl.toque IS NOT NULL ORDER BY cl.id";
  const selectorWorkflow={versionId:'fixture-v1',nodes:[{name:'Elegíveis (PG)',type:'n8n-nodes-base.postgres',parameters:{query:selector}}]};
  const safeSelector=patchLegacySelector(selectorWorkflow,{expectedVersion:'fixture-v1'}).nodes[0].parameters.query;
  assert.deepEqual((await db.query(safeSelector,[[1,2],'fish'])).rows.map(x=>x.id),[2]);
  assert.deepEqual((await db.query(safeSelector,[[1,2],'aristo'])).rows.map(x=>x.id),[1,2]);
  // Disabling cannot send the captured cohort through the legacy path.
  await db.exec('UPDATE shrigma_journey_cart_control_v1 SET enabled=false');
  assert.equal((await legacy(payload(s))).reason,'journey_entry_required');
  await db.exec(sql);assert.equal((await db.query('SELECT enabled FROM shrigma_journey_cart_control_v1')).rows[0].enabled,false);
  assert.deepEqual((await db.query('SELECT * FROM shrigma_email_dispatch WHERE dispatch_id=$1',[historical[0].dispatch_id])).rows,historical);
  // Removing the original global guard makes migration fail closed.
  await db.exec(original.replace("IF NOT (stage_config->>'_allowed')::boolean THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'flow_paused';RETURN;END IF;",'-- unexpected guard drift'));
  await assert.rejects(db.exec(sql),/JOURNEY_GLOBAL_GUARD_DRIFT/);await db.exec('ROLLBACK');
  console.log('PASS cart entry '+(process.env.JOURNEY_CART_FUNCTIONS_FILE?'fresh runtime SQL':'public fixture')+': disabled/idempotent install, preserved legacy reservation/global guard, pin version/wait/template, interruption/expiry, uncertain fence and atomic attachment. No transport.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message,e.where||'');process.exitCode=1;});
