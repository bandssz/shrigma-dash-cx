/* Independent PostgreSQL sessions; disposable journey_test database only.
 * Candidate SQL is unmodified. The synthetic legacy boundary models the same
 * advisory -> dispatch -> subscriber lock order, without private runtime data.
 * No HTTP, Listmonk, SES, customer or production connection. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Client}=require('pg');
const {createCartEntryProvider}=require('../n8n/growth/journey-cart-provider.cjs');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const one=async(c,q,p=[])=>(await c.query(q,p)).rows[0];
const result=async(c,q,p=[]) =>(await one(c,q,p)).result;
(async()=>{
 if(process.env.JOURNEY_TEST_DATABASE_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('Explicit isolated journey test database required');
 const a=new Client({connectionString:process.env.TEST_DATABASE_URL}),b=new Client({connectionString:process.env.TEST_DATABASE_URL});
 let pending;let next=1000;let assertions=0;
 const queue=fn=>{assert.equal(pending,undefined);pending=fn().then(value=>({value}),error=>({error}));};
 async function receive(){const r=await pending;pending=undefined;if(r.error)throw r.error;return r.value;}
 async function locked(observer,blockedPid){
  for(let i=0;i<75;i++){
   await observer.query('SELECT pg_stat_clear_snapshot()');
   const r=await one(observer,'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[blockedPid]);
   if(r?.wait_event_type==='Lock'){assertions++;return;}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('Independent session did not enter a real lock wait');
 }
 const enroll=(c,s)=>result(c,'SELECT shrigma_journey_cart_enroll_v1($1,$2) AS result',[s.id,s.ref]);
 const payload=s=>({brand:'fish',toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',template_id:60,subscriber_id:s.id,ref:s.ref,email:'fixture-'+s.id+'@example.invalid',tx:{template_id:60,subscriber_email:'fixture-'+s.id+'@example.invalid',from_email:'Fishermans <fixture@example.invalid>',headers:[],data:{checkout_url:'https://example.invalid/checkout/fixture'}}});
 const claim=(c,s,entry)=>one(c,'SELECT * FROM shrigma_email_claim_cart($1::jsonb)',[JSON.stringify({...payload(s),...(entry?{journey_entry_id:entry.entry_id}:{})})]);
 const check=(c,entry)=>result(c,'SELECT shrigma_journey_cart_check_v1($1) AS result',[entry.entry_id]);
 const get=(c,entry)=>result(c,'SELECT shrigma_journey_cart_get_v1($1) AS result',[entry.entry_id]);
 async function source(c,age=35){
  const id=next++,ref=(await one(c,"SELECT to_char(clock_timestamp()-make_interval(secs=>$1::double precision*60),'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS ref",[age])).ref;
  await c.query("INSERT INTO subscribers(id,email,status,attribs) VALUES($1,$2,'enabled',$3::jsonb)",[id,'fixture-'+id+'@example.invalid',JSON.stringify({fish:{cart_abandoned_at:ref,cart_url:'https://example.invalid/checkout/fixture',flows:{}}})]);
  await c.query("INSERT INTO subscriber_lists VALUES($1,22,'confirmed')",[id]);return {id,ref};
 }
 try{
  await a.connect();await b.connect();
  for(const c of [a,b])await c.query("SET statement_timeout='8s';SET lock_timeout='3s';SET timezone='UTC'");
  assert.match((await one(a,'SELECT current_database() AS name')).name,/^journey_test(?:_[a-z0-9]+)?$/,'reserved disposable DB name required');
  assert.equal((await one(a,"SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).n,0,'fixture database must start empty');
  const pidA=(await one(a,'SELECT pg_backend_pid() AS pid')).pid,pidB=(await one(b,'SELECT pg_backend_pid() AS pid')).pid;
  assert.notEqual(pidA,pidB,'two actual database backends');
  let fixture=read('tests/sql/journey-cart-fixture.sql');
  // Real PostgreSQL can test the production SHA-256 primitive, unlike PGlite.
  const stub="CREATE FUNCTION digest(data bytea,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT decode(md5(data),'hex')$$;";
  assert.equal(fixture.split(stub).length,2);fixture=fixture.replace(stub,'CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  const anchor="IF NOT (age>=shrigma_flow_wait(v_brand,'email','carrinho-30min',30)";
  assert.equal(fixture.split(anchor).length,2);
  fixture=fixture.replace(anchor,"PERFORM 1 FROM public.subscribers WHERE id=v_id FOR UPDATE;\n"+anchor);
  await a.query(fixture);
  await a.query(read('n8n/growth/journey-template-release.sql'));
  const prepare=c=>result(c,"SELECT shrigma_journey_template_prepare_v1(60,'fixture-cache') AS result");
  // Same source/hash/cache: advisory contention creates exactly one release.
  await a.query('BEGIN');const prepared=await prepare(a);
  queue(()=>prepare(b));await locked(a,pidB);await a.query('COMMIT');
  assert.equal((await receive()).id,prepared.id);
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_journey_template_release_v1')).n,1);
  // Two creators compete for the durable claim; the loser cannot issue a POST.
  await b.query('BEGIN');const winner=await result(b,'SELECT shrigma_journey_template_begin_v1($1,$2) AS result',[prepared.id,'fixture-cache']);
  assert.equal(winner.should_create,true);
  queue(()=>result(a,'SELECT shrigma_journey_template_begin_v1($1,$2) AS result',[prepared.id,'fixture-cache']));
  await locked(b,pidA);await b.query('COMMIT');
  const loser=await receive();assert.equal(loser.should_create,false);assert.equal(loser.release.state,'creating');assert.equal(loser.release.claim_token,undefined);
  // Native-create fixture holds the release lock through its insert. Confirm
  // waits for the same durable clone, never creates or reserves a second one.
  await b.query('BEGIN');const snapshot=prepared.snapshot;
  const clone=await one(b,'INSERT INTO templates(name,type,subject,body,body_source) VALUES($1,$2,$3,$4,$5) RETURNING *',[prepared.clone_name,snapshot.type,snapshot.subject,snapshot.body,snapshot.body_source]);
  queue(()=>result(a,'SELECT shrigma_journey_template_confirm_v1($1,$2,$3,$4) AS result',[prepared.id,winner.release.claim_token,clone.id,'fixture-cache']));
  await locked(b,pidA);await b.query('COMMIT');
  const ready=await receive();assert.equal(ready.state,'ready');assert.equal(ready.clone_template_id,clone.id);
  assert.equal((await one(a,'SELECT count(*)::int n FROM templates WHERE name=$1',[prepared.clone_name])).n,1);
  await assert.rejects(b.query("UPDATE templates SET body='Changed fixture' WHERE id=$1",[clone.id]),/IMMUTABLE/);

  await a.query(read('n8n/growth/journey-cart-entry.sql'));
  assert.equal((await one(a,'SELECT enabled FROM shrigma_journey_cart_control_v1')).enabled,false);
  // Safe cutover uses the present source timestamp. A legacy call already in
  // flight refers to an older cart and remains outside the new cohort.
  const old=await source(a);
  await a.query('BEGIN');const historic=await claim(a,old);assert.equal(historic.should_send,true);
  await b.query("UPDATE shrigma_journey_cart_control_v1 SET enabled=true,starts_at=clock_timestamp(),template_cache_target='fixture-cache'");
  queue(()=>claim(b,old));await locked(a,pidB);await a.query('COMMIT');
  assert.equal((await receive()).should_send,false);
  assert.equal((await enroll(b,old)).reason,'outside_cohort');
  const current=await source(b,0);assert.equal((await claim(b,current)).reason,'journey_entry_required');
  const newEntry=await enroll(a,current);assert.equal(newEntry.created,true);assert.equal((await check(a,newEntry)).reason,'not_due');
  await b.query('UPDATE shrigma_journey_cart_control_v1 SET enabled=false');
  assert.equal((await claim(a,current)).reason,'journey_entry_required','pause cannot release an owned entry to the legacy selector');
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_email_dispatch')).n,1);

  // Synthetic time acceleration only: seed due references as if the safe
  // cohort had run for two hours. Never use a backdated cutover in production.
  await b.query("UPDATE shrigma_journey_cart_control_v1 SET enabled=true,starts_at=clock_timestamp()-interval '2 hours'");
  const shared=await source(a);
  await a.query('BEGIN');const entry=await enroll(a,shared);
  queue(()=>enroll(b,shared));await locked(a,pidB);await a.query('COMMIT');
  const joined=await receive();assert.equal(joined.entry_id,entry.entry_id);assert.equal(joined.created,false);
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_journey_cart_entry_v1 WHERE subscriber_id=$1',[shared.id])).n,1);
  // A checker and a claimer use the same entry lock order.
  await a.query('BEGIN');assert.equal((await check(a,entry)).reason,'due');
  queue(()=>claim(b,shared,entry));await locked(a,pidB);await a.query('COMMIT');
  const first=await receive();assert.equal(first.should_send,true);
  assert.equal((await claim(a,shared,entry)).should_send,false);
  // Two claims for a new entry serialize, one physical reservation.
  const racing=await source(a),raceEntry=await enroll(a,racing);
  await a.query('BEGIN');const owned=await claim(a,racing,raceEntry);assert.equal(owned.should_send,true);
  queue(()=>claim(b,racing,raceEntry));await locked(a,pidB);await a.query('COMMIT');
  assert.equal((await receive()).should_send,false);
  assert.equal((await one(a,'SELECT count(*)::int n FROM shrigma_email_dispatch WHERE dispatch_id=$1',[owned.dispatch_id])).n,1);
  await b.query('SELECT * FROM shrigma_email_finish_cart($1,$2,$3,$4::jsonb)',[owned.dispatch_id,owned.claim_token,'outcome_unknown',JSON.stringify(owned.context)]);
  assert.equal((await claim(a,racing,raceEntry)).should_send,false);assert.equal((await get(a,raceEntry)).transport_state,'outcome_unknown');

  // Purchase commits while the final check waits for the subscriber lock; the
  // newly committed event must be observed without discarding the reservation.
  const bought=await source(a),purchaseEntry=await enroll(a,bought),purchaseClaim=await claim(a,bought,purchaseEntry);
  assert.equal(purchaseClaim.should_send,true);
  await b.query('BEGIN');await b.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,last_order_at}',to_jsonb(clock_timestamp())) WHERE id=$1",[bought.id]);
  queue(()=>check(a,purchaseEntry));await locked(b,pidA);await b.query('COMMIT');
  const blocked=await receive();assert.equal(blocked.reason,'purchase_after_reservation');assert.equal(blocked.state,'reserved');assert.equal(blocked.dispatch_id,purchaseClaim.dispatch_id);

  // Real separate connection mutates the source/config after claim and before
  // the provider's final check. No transport callback exists in this suite.
  for(const interruption of ['purchase','opt_out','source','flow_pause','cohort_pause','unknown']){
   const s=await source(a),e=await enroll(a,s);let injection=0;
   const provider=createCartEntryProvider({cacheTarget:'fixture-cache',query:async(q,params)=>{
    const r=await a.query(q,params);
    if(q.includes('shrigma_email_claim_cart')&&r.rows[0]?.should_send){
     injection++;
     if(interruption==='purchase')await b.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,last_order_at}',to_jsonb(clock_timestamp())) WHERE id=$1",[s.id]);
     if(interruption==='opt_out')await b.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1",[s.id]);
     if(interruption==='source')await b.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,cart_abandoned_at}',to_jsonb(clock_timestamp())) WHERE id=$1",[s.id]);
     if(interruption==='flow_pause')await b.query('UPDATE shrigma_flow_definition SET enabled=false');
     if(interruption==='cohort_pause')await b.query('UPDATE shrigma_journey_cart_control_v1 SET enabled=false');
     if(interruption==='unknown'){const c=r.rows[0];await b.query('SELECT * FROM shrigma_email_finish_cart($1,$2,$3,$4::jsonb)',[c.dispatch_id,c.claim_token,'outcome_unknown',JSON.stringify(c.context)]);}
    }
    return r;
   }});
   await assert.rejects(provider.claim(e.entry_id,payload(s)),/binding unconfirmed/);assert.equal(injection,1);
   const stored=await get(a,e);assert.equal(stored.state,'reserved');assert.ok(stored.dispatch_id);
   if(interruption==='unknown')assert.equal(stored.transport_state,'outcome_unknown');
   else assert.equal(stored.reason,{purchase:'purchase_after_reservation',opt_out:'opt_out_after_reservation',source:'source_superseded_after_reservation',flow_pause:'flow_paused_after_reservation',cohort_pause:'journey_paused_after_reservation'}[interruption]);
   await b.query('UPDATE shrigma_flow_definition SET enabled=true;UPDATE shrigma_journey_cart_control_v1 SET enabled=true');
   assert.equal((await claim(a,s,e)).should_send,false,'cleared source/config cannot release an existing reservation');
  }
  assert.equal((await one(a,'SELECT transport_state FROM shrigma_email_dispatch WHERE dispatch_id=$1',[historic.dispatch_id])).transport_state,'in_flight','legacy reservation remains untouched');
  assert.ok(assertions>=8);
  console.log('PASS journey PostgreSQL two-session contention: '+assertions+' observed lock waits; one release/native clone/entry/reservation, cutover preserves legacy, interrupted final authorization and uncertain state fenced. Synthetic only; no HTTP or live cache proof.');
 }finally{
  await Promise.allSettled([a.query('ROLLBACK'),b.query('ROLLBACK')]);if(pending)await pending;
  await Promise.allSettled([a.end(),b.end()]);
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
