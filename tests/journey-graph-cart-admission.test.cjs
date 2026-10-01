'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {install,id}=require('./journey-graph-cart-fixture.cjs');
const {createWorker,ACTOR}=require('../n8n/growth/journey-graph-worker.cjs');
const admissionSQL=fs.readFileSync(require.resolve('../n8n/growth/journey-graph-cart-admission.sql'),'utf8');

test('captured source is admitted through the bounded receipt once; exact replay is read-only',async t=>{
 const x=await install(t),f=await x.prepare('fish',{ownership:false});
 await x.db.exec(`CREATE ROLE crm_graph_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;${admissionSQL}`);
 const captured=await x.receipt('fish',id(9100)),handoff={version:captured.version,brand:'fish',reconciled:true,observed_at:captured.observed_at,items:captured.items,workflow_id:'syntheticFish',execution_id:'9100',batch_index:0,authorizes_enrollment:false,authorizes_send:false};
 const pool={...x.pool,query:x.query},options={pool,actor:ACTOR,authorizeWorker:async()=>true,cacheTarget:x.cacheTarget,collectorWorkflowIds:{fish:'syntheticFish',aristo:'syntheticAristo'},readSource:f.settings.readSource,sendTx:async()=>{throw Error('UNEXPECTED_SEND');}};
 const first=await createWorker({...options,enabled:false}).captureHandoff(handoff),activeBefore=(await x.query('SELECT e.journey_id,j.version,e.cache_target FROM crm_graph_candidate.cart_epoch_v1 e JOIN crm_graph_candidate.journey j ON j.id=e.journey_id AND j.brand=e.brand WHERE e.brand=\'fish\' AND e.ends_at IS NULL')).rows[0];
 await x.query('SELECT crm_graph_candidate.cart_admit_source_v1($1,$2,$3,$4,$5)',['fish',first.source_refs[0],activeBefore.journey_id,activeBefore.version,activeBefore.cache_target]);
 const worker=createWorker({...options,enabled:true}),second=await worker.captureHandoff(handoff);assert.deepEqual(second,first);
 const rows=(await x.query('SELECT receipt FROM crm_graph_candidate.cart_admission_receipt_v1')).rows;assert.equal(rows.length,1);assert.equal(rows[0].receipt.contract,'journey_graph_cart_admission_v1');assert.equal(rows[0].receipt.state,'admitted');assert.equal(rows[0].receipt.authorizes_send,false);
 assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.cart_owner_v1')).rows[0].n,1);
 assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.entry')).rows[0].n,1);
 const active=(await x.query('SELECT journey_id,expected_version,cache_target FROM crm_graph_candidate.cart_admission_receipt_v1')).rows[0];
 const replay=(await x.query('SELECT crm_graph_candidate.cart_admit_source_v1($1,$2,$3,$4,$5) result',['fish',first.source_refs[0],active.journey_id,active.expected_version,active.cache_target])).rows[0].result;assert.deepEqual(replay,rows[0].receipt);
 await assert.rejects(x.query('SELECT crm_graph_candidate.cart_admit_source_v1($1,$2,$3,$4,$5)',['fish',first.source_refs[0],active.journey_id,active.expected_version+1,active.cache_target]),/REPLAY_MISMATCH/);
 assert.equal((await x.query("SELECT has_table_privilege('crm_graph_worker','crm_graph_candidate.cart_admission_receipt_v1','INSERT') ok")).rows[0].ok,false);
 assert.equal((await x.query("SELECT has_function_privilege('crm_graph_worker','crm_graph_candidate.cart_admit_source_v1(text,uuid,uuid,integer,text)','EXECUTE') ok")).rows[0].ok,true);
});

test('admission input and current consent fail closed before ownership',async t=>{
 const x=await install(t),f=await x.prepare('fish',{ownership:false});await x.db.exec(`CREATE ROLE crm_graph_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;${admissionSQL}`);
 const active=(await x.query('SELECT e.journey_id,j.version,e.cache_target,s.id source_ref FROM crm_graph_candidate.cart_epoch_v1 e JOIN crm_graph_candidate.journey j ON j.id=e.journey_id AND j.brand=e.brand CROSS JOIN crm_graph_candidate.source_event_v1 s WHERE e.brand=\'fish\' AND e.ends_at IS NULL LIMIT 1')).rows[0];
 await assert.rejects(x.query('SELECT crm_graph_candidate.cart_admit_source_v1($1,$2,$3,$4,$5)',['fish',active.source_ref,active.journey_id,active.version,null]),/GRAPH_ADMISSION_INPUT/);
 await x.query("UPDATE crm_graph_candidate.source_observation_v1 SET observed_at=(SELECT starts_at-interval '1 second' FROM crm_graph_candidate.cart_epoch_v1 WHERE brand='fish' AND ends_at IS NULL)");
 await assert.rejects(x.query('SELECT crm_graph_candidate.cart_admit_source_v1($1,$2,$3,$4,$5)',['fish',active.source_ref,active.journey_id,active.version,active.cache_target]),/GRAPH_ADMISSION_SOURCE/);
 await x.query('UPDATE crm_graph_candidate.source_observation_v1 SET observed_at=clock_timestamp()');
 await x.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=17");
 await assert.rejects(x.query('SELECT crm_graph_candidate.cart_admit_source_v1($1,$2,$3,$4,$5)',['fish',active.source_ref,active.journey_id,active.version,active.cache_target]),/GRAPH_ADMISSION_INELIGIBLE/);
 assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.cart_owner_v1')).rows[0].n,0);assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.cart_admission_receipt_v1')).rows[0].n,0);
});
