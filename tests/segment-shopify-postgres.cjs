'use strict';
// Opt-in PostgreSQL 17.10 proof. The database must be disposable, loopback-only
// and use a non-default port. No Shopify, SMTP or other remote connection occurs.
const assert=require('node:assert/strict'),fs=require('node:fs'),{Pool}=require('pg'),{randomUUID,createHash}=require('node:crypto');
const {setupShopifySelection}=require('./segment-shopify-selection-fixture.cjs');
const {evidence,rule}=require('./segment-shopify-facts-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs');
const API=require('../n8n/growth/segment-audience-api.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const {createTransaction}=require('../services/crm-audience/transaction.cjs');

const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:8,statement_timeout:30000,connectionTimeoutMillis:5000,application_name:'shopify-proof-owner'});
const db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q),transaction:async work=>{const c=await owner.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const finalizationMs={};
async function waitLock(client,pid){for(let i=0;i<100;i++){await client.query('SELECT pg_stat_clear_snapshot()');const r=await client.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);if(r.rows[0]?.wait_event_type==='Lock')return;await delay(10);}assert.fail('expected PostgreSQL lock wait');}
function customers(brand,start,count){return Array.from({length:count},(_,i)=>{const id=start+i,orders=id%2?'2':'0';return {id,orders,email:`person${id}@example.test`,amount:orders==='0'?'0.00':'125.10'};});}
async function ingestPart(e,part){const {customers,...meta}=e;return (await db.query('SELECT crm_audience_v2.shopify_ingest_chunk($1,$2,$3) receipt',[JSON.stringify(meta),part,JSON.stringify(customers.slice(part*5000,(part+1)*5000))])).rows[0].receipt;}
function planSummary(plan){const nodes=[];(function walk(n){nodes.push({node:n['Node Type'],relation:n['Relation Name']||null,join:n['Join Type']||null,rows:n['Plan Rows'],cost:n['Total Cost']});for(const child of n.Plans||[])walk(child);})(plan);return nodes;}
async function ingestAll(e,{explain=false}={}){let last;const parts=Math.max(1,Math.ceil(e.customers.length/5000));for(let part=0;part<parts;part++){
  if(explain&&part===parts-1){const plan=(await db.query(`EXPLAIN (FORMAT JSON) WITH native_contacts AS MATERIALIZED (
   SELECT lower(btrim(s.email)) email,count(*)::integer matches,min(s.id) sid FROM public.subscribers s WHERE s.email IS NOT NULL GROUP BY lower(btrim(s.email))
  ),candidates AS MATERIALIZED (SELECT f.customer_gid,coalesce(n.matches,0) matches,n.sid FROM crm_audience_v2.shopify_customer_fact f LEFT JOIN native_contacts n ON n.email=f.email
   WHERE f.brand=$1 AND f.operation_id=$2 AND f.identity_state='pending'),classified AS MATERIALIZED (SELECT c.*,s.uuid,CASE WHEN c.matches=0 THEN 'missing_contact' WHEN c.matches>1 THEN 'ambiguous_contact'
   WHEN EXISTS(SELECT 1 FROM crm_audience_v2.shopify_identity i WHERE i.brand=$1 AND ((i.customer_gid=c.customer_gid AND (i.subscriber_id<>s.id OR i.subscriber_uuid<>s.uuid)) OR (i.subscriber_uuid=s.uuid AND i.customer_gid<>c.customer_gid))) THEN 'identity_changed' ELSE 'resolved' END state
   FROM candidates c LEFT JOIN public.subscribers s ON s.id=c.sid)
  UPDATE crm_audience_v2.shopify_customer_fact f SET identity_state=c.state,subscriber_id=CASE WHEN c.state='resolved' THEN c.sid END,subscriber_uuid=CASE WHEN c.state='resolved' THEN c.uuid END FROM classified c WHERE f.brand=$1 AND f.operation_id=$2 AND f.customer_gid=c.customer_gid`,[e.brand,e.operation_id])).rows[0]['QUERY PLAN'][0].Plan;console.log(JSON.stringify({stage:'pre_finalize_plan',brand:e.brand,operation_id:e.operation_id,total_cost:plan['Total Cost'],plan_rows:plan['Plan Rows'],nodes:planSummary(plan)}));}
  const partStarted=performance.now();last=await ingestPart(e,part);if(part===parts-1)finalizationMs[e.brand]=+(performance.now()-partStarted).toFixed(3);
 }return last;}
async function prepareDelivery(f,brand,cid){
 await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(cid)]);await tx.query("UPDATE campaigns SET send_at=clock_timestamp()+interval '20 minutes',max_subscriber_id=(SELECT max(subscriber_id) FROM subscriber_lists WHERE list_id=$2) WHERE id=$1",[cid,brand==='fish'?17:16]);});
 const audience=await f.rebind(brand,rule('purchase.count','gt',0));await f.f.approve();
 const request=await f.f.prepareRequest(brand),review=await f.f.call(request);assert.equal(review.status,200,JSON.stringify(review));
 const scheduled=await f.f.call(f.f.scheduleRequest(request,review,'shopify-pg-schedule-'+brand));assert.equal(scheduled.status,200,JSON.stringify(scheduled));
 // Fixture-only clock transition after exercising real admission. The product
 // guard remains installed and enabled for every subsequent claim assertion.
 await db.transaction(async tx=>{await tx.query("SET LOCAL session_replication_role='replica'");await tx.query("UPDATE campaigns SET status='running' WHERE id=$1",[cid]);});
 return audience;
}

(async()=>{let rolePool,roleTransaction;const metrics={};let concurrentDuplicate;try{
 assert.equal((await db.query("SELECT current_setting('server_version_num') AS v")).rows[0].v,'170010');
 const f=await setupShopifySelection(db);
 await db.query('ALTER ROLE crm_audience_api LOGIN');
 const roleURL=new URL(uri);roleURL.username='crm_audience_api';rolePool=new Pool({connectionString:roleURL.href,max:4,statement_timeout:10000,connectionTimeoutMillis:5000,application_name:'shopify-proof-api'});
 roleTransaction=createTransaction({pool:rolePool});

 // Real API role sees only aggregate source state and aggregate count output.
 const roleStore=Store.createAudienceStore({transaction:roleTransaction,countProvider:Counter.countAudience,timeoutMs:10000});
 const roleAPI=API.createAudienceAPI({store:roleStore});
 const catalog=await Store.readCatalog(rolePool.query.bind(rolePool),'fish');
 assert.deepEqual(Object.keys(catalog.catalog.shopify_snapshot).sort(),['current','expires_at','observed_at','started_at']);
 const counted=await roleAPI.handle({method:'POST',request:{headers:{Authorization:'Bearer synthetic-manager-key'},body:{acao:'segmento_contar',brand:'fish',definition:{schema_version:'crm-audience-v2',brand:'fish',name:'Aggregate only',rule:rule()},expected_catalog_hash:catalog.catalog.catalog_hash}}});
 assert.equal(counted.status,200,JSON.stringify(counted));assert.equal(counted.body.source_confirmed,true);assert.equal(Object.hasOwn(counted.body,'subscribers'),false);
 for(const sql of ['SELECT * FROM crm_audience_v2.shopify_customer_fact','SELECT * FROM crm_audience_v2.shopify_identity','SELECT email FROM subscribers',"SELECT crm_audience_v2.shopify_ingest_chunk('{}',0,'[]')",'GRANT SELECT ON crm_audience_v2.shopify_customer_fact TO crm_audience_api'])await assert.rejects(rolePool.query(sql),e=>e.code==='42501');

 // A duplicate final chunk serializes and finalizes exactly once.
 const concurrent=evidence('fish',customers('fish',1,5001),'91'),parts=[0,1];
 const {customers:concurrentRows,...concurrentMeta}=concurrent,shape=(await db.query("SELECT jsonb_typeof($1::jsonb) meta_type,octet_length($1::jsonb::text) meta_bytes,($1::jsonb->'version'='1'::jsonb) version_ok,jsonb_typeof($2::jsonb) rows_type,jsonb_array_length($2::jsonb) rows_count,octet_length($2::jsonb::text) rows_bytes,($1::jsonb ?& ARRAY['version','brand','shop','operation_id','started_at','completed_at','observed_at','query_sha256','workflow_id','workflow_version','source_sha256','counts','bulk']) required_meta,($1::jsonb-'version'-'brand'-'shop'-'operation_id'-'started_at'-'completed_at'-'observed_at'-'query_sha256'-'workflow_id'-'workflow_version'-'source_sha256'-'counts'-'bulk'='{}'::jsonb) exact_meta",[JSON.stringify(concurrentMeta),JSON.stringify(concurrentRows.slice(0,5000))])).rows[0];
 assert.equal(shape.meta_type,'object');assert.equal(shape.version_ok,true);assert.equal(shape.required_meta,true);assert.equal(shape.exact_meta,true);assert.equal(shape.rows_type,'array');assert.equal(shape.rows_count,5000);assert.ok(shape.meta_bytes<16000);assert.ok(shape.rows_bytes<16777216);
 await ingestPart(concurrent,parts[0]);
 const raced=await Promise.allSettled([ingestPart(concurrent,parts[1]),ingestPart(concurrent,parts[1])]);
 assert.equal(raced.filter(x=>x.status==='fulfilled'&&x.value.status==='ready'&&x.value.replayed===false).length,1);
 const bounded=raced.filter(x=>x.status==='rejected'&&x.reason.code==='55P03').length,concurrentReplay=raced.filter(x=>x.status==='fulfilled'&&x.value.status==='ready'&&x.value.replayed===true).length;assert.equal(bounded+concurrentReplay,1);concurrentDuplicate=bounded?'55P03_then_replay':'serialized_replay';
 const replay=await ingestPart(concurrent,parts[1]);assert.equal(replay.status,'ready');assert.equal(replay.replayed,true);
 assert.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.shopify_chunk WHERE brand='fish' AND operation_id='gid://shopify/BulkOperation/91'")).rows[0].n,2);

 // A native UUID change is unknown on the next export; it is never silently
 // attached to the old Customer GID.
 await db.query('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=1');
 await ingestAll(evidence('fish',[{id:1,orders:'2'}],'92'));
 const drift=(await db.query("SELECT identity_state,subscriber_id FROM crm_audience_v2.shopify_customer_fact WHERE brand='fish' AND operation_id='gid://shopify/BulkOperation/92'")).rows[0];
 assert.deepEqual(drift,{identity_state:'identity_changed',subscriber_id:null});

 // Replace the small fixture with two complete 50k exports and native contacts.
 await db.query('UPDATE crm_audience_v2.shopify_source SET enabled=false,current_operation=NULL');
 await db.query('TRUNCATE crm_audience_v2.shopify_customer_fact,crm_audience_v2.shopify_chunk,crm_audience_v2.shopify_batch,crm_audience_v2.shopify_identity');
 await db.query('TRUNCATE subscriber_lists,subscribers');
 await db.query("INSERT INTO subscribers(id,status,uuid,email,created_at,updated_at) SELECT n,'enabled',gen_random_uuid(),'person'||n||'@example.test',clock_timestamp(),clock_timestamp() FROM generate_series(1,100000)n");
 await db.query("INSERT INTO subscriber_lists(subscriber_id,list_id,status) SELECT n,17,'confirmed' FROM generate_series(1,50000)n UNION ALL SELECT n,16,'confirmed' FROM generate_series(50001,100000)n");
 await db.query('ANALYZE public.subscribers');
 for(const [brand,start,operation] of [['fish',1,'101'],['aristo',50001,'102']]){
  const built=evidence(brand,customers(brand,start,50000),operation),began=performance.now();
  const receipt=await ingestAll(built,{explain:true});metrics[brand]={ingest_ms:+(performance.now()-began).toFixed(3),finalization_ms:finalizationMs[brand]};assert.equal(receipt.status,'ready');assert.equal(receipt.mapped,50000);assert.equal(receipt.unresolved,0);console.log(JSON.stringify({stage:'ingest_complete',brand,...metrics[brand]}));
  await db.query('UPDATE crm_audience_v2.shopify_source SET enabled=true WHERE brand=$1',[brand]);await db.query('SELECT crm_audience_v2.refresh_native_catalog($1)',[brand]);
  // Release the large JS payload before measuring the database count.
 }
 for(const [brand,expected] of [['fish',25000],['aristo',25000]]){
  const c=await Store.readCatalog(rolePool.query.bind(rolePool),brand),began=performance.now();
  let databaseError=null,databaseRows=null;const measuredQuery=async(q,p)=>{try{const r=await rolePool.query(q,p);databaseRows=r.rows;return r;}catch(e){databaseError={code:e.code,message:e.message};throw e;}};let result;try{result=await Counter.countAudience({definition:{schema_version:'crm-audience-v2',brand,name:'Cost '+brand,rule:rule('purchase.count','gt',0)},baseListId:brand==='fish'?17:16,catalog:c.catalog,query:measuredQuery,timeoutMs:10000});}catch(e){console.log(JSON.stringify({stage:'count_failed',brand,elapsed_ms:+(performance.now()-began).toFixed(3),counter_error:e.code,database_error:databaseError,database_rows:databaseRows}));throw e;}
  metrics[brand].count_ms=+(performance.now()-began).toFixed(3);metrics[brand].eligible=result.eligible_count;assert.equal(result.source_confirmed,true);assert.equal(result.eligible_count,expected);assert.ok(metrics[brand].count_ms<10000);
 }

 // Claim holds the source pointer while waiting downstream. A producer update
 // cannot cross that lock; expiry during the wait aborts without a receipt or cursor.
 await db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '26 hours'+interval '10 seconds' WHERE brand='fish' AND operation_id=(SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand='fish')");
 await prepareDelivery(f,'fish',100);
 const sid=1,snapshot=(await db.query('SELECT to_jsonb(s) v FROM subscribers s WHERE id=$1',[sid])).rows[0].v;
 const expiresAt=Date.parse((await db.query("SELECT (crm_audience_v2.shopify_snapshot('fish')->>'expires_at')::text v")).rows[0].v),untilWindow=expiresAt-Date.now()-450;if(untilWindow>0)await delay(untilWindow);
 let contendedClaimCode=null;
 const blocker=await owner.connect(),claimer=await owner.connect(),producer=await owner.connect();
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM subscriber_lists WHERE subscriber_id=$1 AND list_id=17 FOR UPDATE',[sid]);
  const claimArgs=[100,sid,randomUUID(),'a'.repeat(64),'b'.repeat(64),'contato@fishermans.com.br',snapshot.email,'c'.repeat(64),JSON.stringify(snapshot)];
  const claim=claimer.query('SELECT crm_audience_v2.regular_delivery_claim($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) v',claimArgs).then(()=>{throw Error('CLAIM_SHOULD_EXPIRE');},e=>e);
  let early=false,earlyValue;claim.then(v=>{early=true;earlyValue=v;});await delay(20);if(early){console.log(JSON.stringify({stage:'claim_ended_before_wait',code:earlyValue.code,message:earlyValue.message}));throw earlyValue;}
  await waitLock(blocker,claimer.processID);
  await producer.query('BEGIN');const sourceUpdate=producer.query("UPDATE crm_audience_v2.shopify_source SET producer_revision=producer_revision WHERE brand='fish'");await waitLock(blocker,producer.processID);
  await delay(470);await blocker.query('COMMIT');const claimError=await claim;
  // The function has a 500 ms lock timeout. Under CI load it can fail closed
  // before the source expires, so both bounded aborts are valid here.
  assert.ok(['55000','55P03'].includes(claimError.code),`unexpected claim abort: ${claimError.code}`);
  contendedClaimCode=claimError.code;
  await sourceUpdate;await producer.query('COMMIT');
  const expired=(await db.query("SELECT (crm_audience_v2.shopify_snapshot('fish')->>'expires_at')::timestamptz<=clock_timestamp() expired")).rows[0].expired;
  assert.equal(expired,true);
  const expiredArgs=[...claimArgs];expiredArgs[2]=randomUUID();
  const expiredClaim=await claimer.query('SELECT crm_audience_v2.regular_delivery_claim($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) v',expiredArgs).then(()=>{throw Error('EXPIRED_CLAIM_SHOULD_FAIL');},e=>e);
  assert.equal(expiredClaim.code,'55000');
  assert.match(expiredClaim.message,/^(?:SEGMENT_SELECTION_UNAVAILABLE|SEGMENT_DELIVERY_(?:MATERIAL_DRIFT|SOURCE_EXPIRED))$/);
  assert.equal((await db.query("SELECT count(*)::int n FROM shrigma_email_dispatch WHERE piece='audience-regular-v1:100'")).rows[0].n,0);
  assert.deepEqual((await db.query('SELECT sent,last_subscriber_id FROM campaigns WHERE id=100')).rows[0],{sent:0,last_subscriber_id:0});
 }finally{await blocker.query('ROLLBACK');await claimer.query('ROLLBACK');await producer.query('ROLLBACK');blocker.release();claimer.release();producer.release();}

 const sha=p=>createHash('sha256').update(fs.readFileSync(require.resolve(p))).digest('hex'),proof={postgres:'17.10',brands:['fish','aristo'],contacts_per_brand:50000,source_sha256:{facts_sql:sha('../n8n/growth/segment-shopify-facts.sql'),selection_sql:sha('../n8n/growth/segment-shopify-selection.sql'),counter:sha('../n8n/growth/segment-audience-listmonk.cjs')},metrics,api_role:'crm_audience_api',aggregate_count_only:true,aggregate_snapshot_only:true,private_facts_denied:true,identity_denied:true,email_denied:true,ingest_denied:true,grant_denied:true,duplicate_chunk_one_finalize:true,concurrent_duplicate:concurrentDuplicate,replay_after_race:true,native_uuid_drift_unknown:true,claim_source_lock:true,contended_claim_abort:contendedClaimCode,expiry_after_wait:contendedClaimCode==='55000',expired_source_55000:true,receipt_or_cursor_advanced:false,statement_timeout_ms:10000,sends:0,remote_hosts:0};
 console.log(JSON.stringify(proof));
}finally{if(roleTransaction)await roleTransaction.drain();if(rolePool)await rolePool.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
