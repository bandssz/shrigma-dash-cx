'use strict';
// Portable PGlite proof for the OFF buyer-conversion read candidate
// (n8n/growth/recipient-buyer-conversion.sql). Synthetic data only: nothing is
// installed in a real database, no capture/gate is enabled outside PGlite, no
// API/route/screen exists. Native PostgreSQL concurrency is not proven here.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupShopifySelection}=require('./segment-shopify-selection-fixture.cjs');
const {rule}=require('./segment-shopify-facts-fixture.cjs');
const Install=require('../n8n/growth/recipient-conversion-install.cjs');
const Attribution=require('../n8n/growth/attribution.js');

const ROOT=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const buyerSQL=read('n8n/growth/recipient-buyer-conversion.sql');
const CAMPAIGN={fish:100,aristo:200};
const METRICS=['accepted_people','identity_mapped_people','identity_unknown_people','window_open_people','orders_unavailable_people','measured_people','buyers','non_buyers','buyer_rate','identity_coverage','measured_share','orders_without_customer','buyers_lower_bound'];

async function setup(t){
 const db=new PGlite();t.after(()=>db.close());
 const fixture=await setupShopifySelection(db);
 await db.exec(read('n8n/growth/ab-experiment-core.sql'));
 // Same limited digest compatibility as tests/recipient-conversion-evidence.test.cjs.
 await db.exec(`CREATE FUNCTION public.digest(data bytea,algorithm text) RETURNS bytea
  LANGUAGE plpgsql IMMUTABLE AS $$BEGIN
   IF lower(algorithm)<>'sha256' THEN RAISE EXCEPTION 'SYNTHETIC_DIGEST_ALGORITHM';END IF;
   RETURN sha256(data);
  END$$`);
 const snapshot=(await db.query(Install.snapshotSQL())).rows[0].snapshot;
 const plan=Install.compile({expectedSnapshot:snapshot,expectedSnapshotSha256:Install.sha(Install.canonical(snapshot)),pins:Install.sourcePins(),reviewSha256:Install.sha('SYNTHETIC_BUYER_COMPONENT_REVIEW_ONLY'),notBefore:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+5*60*1000).toISOString()});
 await db.exec(plan.sql);
 // Real attribution order/coverage tables and ingest function (same slice as
 // tests/attribution-recipient-workflow.test.cjs). hoje_br is the São Paulo day.
 await db.exec("CREATE OR REPLACE FUNCTION public.hoje_br() RETURNS date LANGUAGE sql STABLE AS $$SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date$$;");
 const schema=read('n8n/growth/attribution-schema.sql'),marker='REVOKE ALL ON FUNCTION public.crm_attribution_ingest_v2(jsonb,jsonb) FROM PUBLIC;';
 await db.exec(schema.slice(0,schema.indexOf(marker)+marker.length));
 return fixture;
}
async function installBuyer(db){
 await db.query("SELECT set_config('shrigma.buyer_conversion.install_guard',$1,false)",[Install.sha('SYNTHETIC_BUYER_REVIEW_ONLY')]);
 try{await db.exec(buyerSQL);}catch(e){await db.exec('ROLLBACK');throw e;}
 finally{await db.exec('RESET shrigma.buyer_conversion.install_guard');}
}
const buyers=async(db,brand,days)=>(await db.query(
 days===undefined?'SELECT crm_email_conversion_candidate.buyer_conversion_v1($1,$2) AS v':'SELECT crm_email_conversion_candidate.buyer_conversion_v1($1,$2,$3) AS v',
 days===undefined?[brand,CAMPAIGN[brand]]:[brand,CAMPAIGN[brand],days])).rows[0].v;
const coverage=async(db,brand)=>(await db.query('SELECT crm_email_conversion_candidate.accepted_coverage_v1($1,$2) AS v',[brand,CAMPAIGN[brand]])).rows[0].v;
const metrics=r=>Object.fromEntries(METRICS.map(k=>[k,r[k]]));
const nulls=Object.fromEntries(METRICS.map(k=>[k,null]));

// Real collector classification (n8n/growth/attribution.js) -> real v2 ingest.
function order(brand,id,createdAt,customer,{financial='PAID',legacy=false}={}){
 const row=Attribution.classify({_marca:brand,id:`gid://shopify/Order/${id}`,name:`#${id}`,createdAt,updatedAt:createdAt,
  test:false,cancelledAt:null,displayFinancialStatus:financial,customer:customer===null?null:{id:`gid://shopify/Customer/${customer}`},
  netPaymentSet:{shopMoney:{amount:'99.90',currencyCode:'BRL'}},customerJourneySummary:{ready:true,customerOrderIndex:1,firstVisit:null,lastVisit:null,moments:{pageInfo:{hasNextPage:false},nodes:[]}}});
 if(legacy){delete row.customer_gid;delete row.customer_identity_state;} // collector before customer{id}
 return row;
}
let run=0;
async function ingest(db,rows,{from,until,readAt}){
 const scope={complete:true,mode:'created',brands:['aristo','fish'],execution_id:'buyer-synthetic-'+(++run),read_at:readAt,coverage_from:from,coverage_until:until};
 return (await db.query('SELECT public.crm_attribution_ingest_v2($1::jsonb,$2::jsonb) AS n',[JSON.stringify(rows),JSON.stringify(scope)])).rows[0].n;
}

async function startRegular(db,fixture,brand){
 const {f,rebind}=fixture,campaignId=CAMPAIGN[brand];
 await db.transaction(async tx=>{
  await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(campaignId)]);
  await tx.query("UPDATE campaigns SET send_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[campaignId]);
 });
 await rebind(brand,rule('purchase.count','gte',0));
 await f.approve();
 await db.query(`INSERT INTO crm_audience_v2.regular_delivery_campaign(
   campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,
   envelope_from,account_id,region,configuration_set,enabled)
  SELECT b.campaign_id,b.binding_version,b.binding_hash,
   crm_audience_v2.regular_delivery_material(b.campaign_id),repeat('a',64),repeat('b',64),
   s.envelope_from,s.account_id,s.region,s.configuration_set,true
  FROM crm_audience_v2.campaign_binding b
  JOIN crm_audience_v2.regular_sender_policy s ON s.brand=b.brand
  WHERE b.campaign_id=$1`,[campaignId]);
 await db.transaction(async tx=>{
  await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(campaignId)]);
  await tx.query("UPDATE campaigns SET status='scheduled' WHERE id=$1",[campaignId]);
 });
 await db.query("UPDATE campaigns SET status='running',max_subscriber_id=5 WHERE id=$1",[campaignId]);
}
async function claim(db,brand,subscriberId){
 const subscriber=(await db.query('SELECT to_jsonb(s) AS value FROM subscribers s WHERE id=$1',[subscriberId])).rows[0].value;
 return (await db.query('SELECT crm_audience_v2.regular_delivery_claim($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS value',[
  CAMPAIGN[brand],subscriberId,randomUUID(),'a'.repeat(64),'b'.repeat(64),
  `contato@${brand==='fish'?'fishermans.com.br':'oaristocrata.com'}`,subscriber.email,'c'.repeat(64),JSON.stringify(subscriber)])).rows[0].value;
}
const optOut=(db,brand,sid)=>db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=(SELECT base_list_id FROM crm_audience_v2.campaign_binding_effective($2))",[sid,CAMPAIGN[brand]]);

// Synthetic accepted dispatch + immutable capture row with the exact claim hash.
async function accepted(db,brand,sid,acceptedAt,identity){
 const did=randomUUID(),at=new Date(acceptedAt),started=new Date(at.getTime()-1000).toISOString(),cid=CAMPAIGN[brand];
 await db.query(`INSERT INTO shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,
  recipient_key,recipient_key_version,is_test,transport_state,started_at,accepted_at,outcome_at,claim_token)
  VALUES($1,$2,'campaign',$3,$4,repeat('c',64),'000000000000','fixture','fixture',$5,'synthetic-v1',false,'accepted',$6,$7,$7,gen_random_uuid())`,
  [did,brand,'audience-regular-v1:'+cid,JSON.stringify([cid,1,sid]),`${brand}-recipient-${sid}`,started,at.toISOString()]);
 if(!identity)return did; // capture absent (e.g. before coverage_started_at)
 const confirmed=identity.state==='confirmed';
 await db.query(`INSERT INTO crm_email_conversion_candidate.claim_identity_v1(dispatch_id,brand,campaign_id,binding_version,subscriber_id,
  subscriber_uuid,recipient_key,recipient_key_version,claim_sha256,captured_at,started_at,identity_state,customer_gid,source_operation_id,
  source_query_sha256,source_producer_revision,source_provenance_sha256,source_observed_at,source_expires_at)
  SELECT d.dispatch_id,d.brand,$2,1,$3,gen_random_uuid(),d.recipient_key,d.recipient_key_version,
   crm_email_conversion_candidate.claim_hash_v1(to_jsonb(d)),d.started_at,d.started_at,$4,$5,
   CASE WHEN $6 THEN 'synthetic-op' END,CASE WHEN $6 THEN repeat('d',64) END,CASE WHEN $6 THEN 'synthetic-producer' END,
   CASE WHEN $6 THEN repeat('e',64) END,CASE WHEN $6 THEN d.started_at-interval '1 hour' END,CASE WHEN $6 THEN d.started_at+interval '1 hour' END
  FROM shrigma_email_dispatch d WHERE d.dispatch_id=$1`,
  [did,cid,sid,identity.state,confirmed?`gid://shopify/Customer/${identity.customer}`:null,confirmed]);
 return did;
}

test('install is guarded and OFF; real capture in both brands keeps an open window unknown and follows the claim opt-out rule',async t=>{
 const fixture=await setup(t),{db}=fixture;
 const absent=async()=>(await db.query("SELECT to_regprocedure('crm_email_conversion_candidate.buyer_conversion_v1(text,integer,integer)') IS NULL AND to_regclass('crm_email_conversion_candidate.buyer_read_control_v1') IS NULL AS v")).rows[0].v;
 // Raw SQL without the reviewed install marker is refused and leaves nothing.
 await assert.rejects(db.exec(buyerSQL),/BUYER_CONVERSION_INSTALL_GUARD/);await db.exec('ROLLBACK');
 assert.equal(await absent(),true);
 // Version guard: a drifted capture link refuses installation and rolls back.
 await db.exec("BEGIN;CREATE OR REPLACE FUNCTION crm_email_conversion_candidate.claim_hash_v1(d jsonb) RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$ SELECT repeat('0',64) $fn$;");
 await db.query("SELECT set_config('shrigma.buyer_conversion.install_guard',repeat('a',64),true)");
 await assert.rejects(db.exec(buyerSQL),/BUYER_CONVERSION_DEPENDENCY_DRIFT/);await db.exec('ROLLBACK');
 assert.equal(await absent(),true);
 // A default privilege for the API role must not leak into the new objects.
 await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA crm_email_conversion_candidate GRANT EXECUTE ON FUNCTIONS TO crm_audience_api;ALTER DEFAULT PRIVILEGES IN SCHEMA crm_email_conversion_candidate GRANT SELECT ON TABLES TO crm_audience_api');
 await installBuyer(db);
 await assert.rejects(installBuyer(db),/BUYER_CONVERSION_INSTALL_GUARD/);
 assert.deepEqual((await db.query('SELECT brand,enabled FROM crm_email_conversion_candidate.buyer_read_control_v1 ORDER BY brand')).rows,[{brand:'aristo',enabled:false},{brand:'fish',enabled:false}]);
 assert.deepEqual((await db.query(`SELECT has_function_privilege('crm_audience_api','crm_email_conversion_candidate.buyer_conversion_v1(text,integer,integer)','EXECUTE') f,
  has_table_privilege('crm_audience_api','crm_email_conversion_candidate.buyer_read_control_v1','SELECT') t,
  has_schema_privilege('crm_audience_api','crm_email_conversion_candidate','USAGE') s`)).rows[0],{f:false,t:false,s:false});
 const fn=(await db.query("SELECT p.provolatile v,p.prosecdef d FROM pg_proc p WHERE p.oid='crm_email_conversion_candidate.buyer_conversion_v1(text,integer,integer)'::regprocedure")).rows[0];
 assert.deepEqual(fn,{v:'s',d:true});
 for(const brand of ['fish','aristo']){
  const off=await buyers(db,brand);
  assert.equal(off.available,false);assert.equal(off.reason,'buyer_read_disabled');assert.deepEqual(metrics(off),nulls);
  assert.equal(off.contract,'crm-recipient-buyers-v1');assert.equal(off.unit,'people');assert.equal(off.authorizes_send,false);
  assert.deepEqual(off.window,{anchor:'accepted_at',days:7,max_days:14,start:'inclusive',end:'exclusive'});
 }
 await assert.rejects(buyers(db,'fish',0),/BUYER_CONVERSION_WINDOW_INVALID/);
 await assert.rejects(buyers(db,'fish',15),/BUYER_CONVERSION_WINDOW_INVALID/);
 const wrong=(await db.query("SELECT crm_email_conversion_candidate.buyer_conversion_v1('aristo',100) v")).rows[0].v;
 assert.equal(wrong.available,false);assert.equal(wrong.reason,'campaign_scope_unavailable');assert.deepEqual(metrics(wrong),nulls);

 // Synthetic enablement inside PGlite only.
 await db.query("UPDATE crm_email_conversion_candidate.capture_control_v1 SET enabled=true,coverage_started_at=clock_timestamp()-interval '1 second'");
 await db.query('UPDATE crm_email_conversion_candidate.buyer_read_control_v1 SET enabled=true');
 // Fixture subscriber 2 (Shopify Customer 2) is unconfirmed; confirm it so both 1 and 2 are eligible.
 await db.query("UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=2");
 for(const brand of ['fish','aristo']){
  await startRegular(db,fixture,brand);
  // Opt-out before the send: the native claim never admits the subscriber.
  await optOut(db,brand,1);
  const skipped=await claim(db,brand,1);assert.equal(skipped.should_send,false);assert.equal(skipped.reason,'ineligible');
  const sent=await claim(db,brand,2);assert.equal(sent.should_send,true,JSON.stringify(sent));
  const fin=(await db.query('SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3,$4,$5) AS v',[CAMPAIGN[brand],2,sent.dispatch_id,sent.claim_token,'accepted'])).rows[0].v;
  assert.equal(fin.outcome,'accepted');
  const evidence=(await db.query('SELECT identity_state,customer_gid FROM crm_email_conversion_candidate.claim_identity_v1 WHERE dispatch_id=$1',[sent.dispatch_id])).rows[0];
  assert.deepEqual(evidence,{identity_state:'confirmed',customer_gid:'gid://shopify/Customer/2'});
  const acceptedAt=(await db.query('SELECT accepted_at FROM shrigma_email_dispatch WHERE dispatch_id=$1',[sent.dispatch_id])).rows[0].accepted_at;
  // A paid order of the same customer right after the accepted send.
  const today=(await db.query('SELECT public.hoje_br()::text d')).rows[0].d;
  await ingest(db,[order(brand,brand==='fish'?9001:9002,new Date(acceptedAt.getTime()+1000).toISOString(),2)],{from:today,until:today,readAt:new Date(acceptedAt.getTime()+2000).toISOString()});
  const open=await buyers(db,brand);
  assert.equal(open.available,true);
  assert.deepEqual(metrics(open),{accepted_people:1,identity_mapped_people:1,identity_unknown_people:0,window_open_people:1,
   orders_unavailable_people:0,measured_people:0,buyers:null,non_buyers:null,buyer_rate:null,identity_coverage:1,measured_share:0,
   orders_without_customer:null,buyers_lower_bound:null},'open window is unknown, never zero or a premature rate');
  const cov=await coverage(db,brand);
  assert.deepEqual([cov.accepted_people,cov.mapped_people,cov.unknown_people],[open.accepted_people,open.identity_mapped_people,open.identity_unknown_people]);
  // Opt-out after the accepted send does not shrink the denominator.
  await optOut(db,brand,2);
  const after=await buyers(db,brand);assert.deepEqual(metrics(after),metrics(open));
 }
 assert.equal((await db.query("SELECT count(*)::int n FROM shrigma_email_dispatch WHERE transport_state='accepted'")).rows[0].n,2);
});

test('both brands: window limits, dedupe, order before send, other brand, coverage gaps and unknown never become zero; A/B excluded',async t=>{
 const fixture=await setup(t),{db}=fixture;await installBuyer(db);
 await db.query('UPDATE crm_email_conversion_candidate.buyer_read_control_v1 SET enabled=true');
 // Accepted 2026-09-01 15:00Z (12:00 São Paulo). Window 7d: until 2026-09-08 15:00Z, end exclusive.
 const T0='2026-09-01T15:00:00.000Z',ms=Date.parse(T0),at=(d)=>new Date(ms+d).toISOString(),H=36e5,D=24*H,UNTIL=7*D;
 for(const [sid,customer] of [[11,101],[12,102],[13,103],[14,104],[15,105],[16,106]])await accepted(db,'fish',sid,T0,{state:'confirmed',customer});
 await accepted(db,'fish',17,T0,{state:'identity_unresolved'});
 await accepted(db,'fish',18,T0,null);
 // A later anchor (T0+1h) keeps the order scan open past T0+7d, so each person's own window end is what excludes.
 await accepted(db,'fish',20,at(H),{state:'confirmed',customer:120});
 await accepted(db,'aristo',21,T0,{state:'confirmed',customer:201});
 await accepted(db,'aristo',22,T0,{state:'confirmed',customer:106});
 // A non-accepted claim is never in the denominator.
 await db.query(`INSERT INTO shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
  VALUES(gen_random_uuid(),'fish','campaign','audience-regular-v1:100','[100,1,19]','fish-recipient-19','synthetic-v1',false,'outcome_unknown',$1,gen_random_uuid())`,[T0]);

 // 1) No order collection at all: identity is known, buyers are unknown (NULL), not zero.
 let fish=await buyers(db,'fish');
 assert.deepEqual(metrics(fish),{accepted_people:9,identity_mapped_people:7,identity_unknown_people:2,window_open_people:0,orders_unavailable_people:7,
  measured_people:0,buyers:null,non_buyers:null,buyer_rate:null,identity_coverage:0.777778,measured_share:0,orders_without_customer:null,buyers_lower_bound:null});
 const cov=await coverage(db,'fish');
 assert.deepEqual([cov.accepted_people,cov.mapped_people,cov.unknown_people],[9,7,2]);
 // 2) Partial coverage: last window day read before the window closed.
 await ingest(db,[],{from:'2026-09-01',until:'2026-09-08',readAt:at(UNTIL-H)});
 fish=await buyers(db,'fish');assert.equal(fish.orders_unavailable_people,7);assert.equal(fish.buyers,null);assert.equal(fish.buyer_rate,null);
 // 3) Complete coverage and no orders: a measured zero.
 await ingest(db,[],{from:'2026-09-01',until:'2026-09-08',readAt:at(UNTIL+H)});
 fish=await buyers(db,'fish');
 assert.deepEqual([fish.measured_people,fish.buyers,fish.non_buyers,fish.buyer_rate,fish.measured_share,fish.orders_without_customer,fish.buyers_lower_bound],[7,0,7,0,0.777778,0,false]);
 const aristoZero=await buyers(db,'aristo');assert.deepEqual([aristoZero.measured_people,aristoZero.buyers,aristoZero.buyer_rate,aristoZero.identity_coverage],[2,0,0,1]);

 // 4) Orders through the real classifier and ingest.
 await ingest(db,[
  order('fish',1001,at(-60*1000),101),             // before the send: no
  order('fish',1002,at(D),101,{financial:'PENDING'}), // not paid: no
  order('fish',1003,at(D),102),order('fish',1004,at(2*D),102), // two orders: one buyer
  order('fish',1005,at(UNTIL-1000),103),           // last second inside: yes
  order('fish',1006,at(UNTIL),104),order('fish',1007,at(UNTIL+D),104), // limit and after: no
  order('fish',1008,at(0),105),                    // exactly at accepted_at: yes
  order('aristo',1009,at(D),106),                  // other brand for fish customer 106
  order('fish',1010,at(D),201),                    // other brand for aristo customer 201
  order('fish',1013,at(H/2),120),                  // after others' send, before this person's own send: no
 ],{from:'2026-09-01',until:'2026-09-08',readAt:at(UNTIL+2*H)});
 fish=await buyers(db,'fish');
 assert.deepEqual(metrics(fish),{accepted_people:9,identity_mapped_people:7,identity_unknown_people:2,window_open_people:0,orders_unavailable_people:0,
  measured_people:7,buyers:3,non_buyers:4,buyer_rate:0.428571,identity_coverage:0.777778,measured_share:0.777778,orders_without_customer:0,buyers_lower_bound:false});
 const aristo=await buyers(db,'aristo');
 assert.deepEqual(metrics(aristo),{accepted_people:2,identity_mapped_people:2,identity_unknown_people:0,window_open_people:0,orders_unavailable_people:0,
  measured_people:2,buyers:1,non_buyers:1,buyer_rate:0.5,identity_coverage:1,measured_share:1,orders_without_customer:0,buyers_lower_bound:false});
 // Buyers are people, not orders: 6 paid fish orders fall in [T0,T0+7d), 3 buyers.
 assert.equal((await db.query("SELECT count(*)::int n FROM crm_attribution_order_v2 WHERE brand='fish' AND payload->>'eligible'='true' AND (payload->>'created_at')::timestamptz>=$1 AND (payload->>'created_at')::timestamptz<$2",[T0,at(UNTIL)])).rows[0].n,6);

 // 4b) A person whose window is still open buys: no change to buyers or rate until the window closes.
 const now=Date.now();await accepted(db,'fish',30,new Date(now-D).toISOString(),{state:'confirmed',customer:130});
 const today=(await db.query('SELECT public.hoje_br()::text d')).rows[0].d;
 await ingest(db,[order('fish',1014,new Date(now-H).toISOString(),130)],{from:today,until:today,readAt:new Date(now).toISOString()});
 fish=await buyers(db,'fish');
 assert.deepEqual([fish.accepted_people,fish.window_open_people,fish.measured_people,fish.buyers,fish.buyer_rate,fish.identity_coverage,fish.measured_share],[10,1,7,3,0.428571,0.8,0.7]);

 // 5) Explicit shorter window (3 days): only orders before T0+3d count.
 const short=await buyers(db,'fish',3);
 assert.deepEqual([short.window.days,short.measured_people,short.buyers],[3,7,2]);

 // 6) A paid order without customer identity inside a measured window: buyers is a lower bound.
 await ingest(db,[order('fish',1011,at(3*D),null)],{from:'2026-09-04',until:'2026-09-04',readAt:at(UNTIL+3*H)});
 fish=await buyers(db,'fish');assert.deepEqual([fish.buyers,fish.orders_without_customer,fish.buyers_lower_bound],[3,1,true]);

 // 7) An order collected before the identity field existed makes the window unknown, never a measured zero.
 await ingest(db,[order('fish',1012,at(4*D),null,{legacy:true})],{from:'2026-09-05',until:'2026-09-05',readAt:at(UNTIL+4*H)});
 fish=await buyers(db,'fish');
 assert.deepEqual([fish.orders_unavailable_people,fish.measured_people,fish.buyers,fish.buyer_rate],[7,0,null,null]);
 assert.equal((await buyers(db,'aristo')).buyers,1,'other brand unaffected');

 // 8) A/B registration excludes the campaign, as in accepted_coverage_v1.
 const tid=randomUUID();
 await db.query("INSERT INTO public.crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids) VALUES($1,'aristo','{}',ARRAY[16])",[tid]);
 await db.query("INSERT INTO public.crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version) VALUES($1,'a',200,'synthetic-version')",[tid]);
 const ab=await buyers(db,'aristo');
 assert.equal(ab.available,false);assert.equal(ab.reason,'campaign_scope_unavailable');assert.deepEqual(metrics(ab),nulls);
 assert.equal((await coverage(db,'aristo')).coverage_available,false);
 // 9) Read gate OFF again returns no numbers.
 await db.query("UPDATE crm_email_conversion_candidate.buyer_read_control_v1 SET enabled=false WHERE brand='fish'");
 const off=await buyers(db,'fish');assert.equal(off.reason,'buyer_read_disabled');assert.deepEqual(metrics(off),nulls);
});
