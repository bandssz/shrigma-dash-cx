'use strict';
// Opt-in PG17.10 proof against a disposable loopback database only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Pool}=require('pg');
const {setupProducts,productEvidence}=require('./segment-shopify-products-fixture.cjs');
const {createStore}=require('../services/crm-shopify-sync/store.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
u.username='postgres';u.password='';
const admin=new Pool({connectionString:u.href,max:2,statement_timeout:30000}),querySha256='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086';
const db={query:(q,p)=>admin.query(q,p),exec:q=>admin.query(q),transaction:async fn=>{const client=await admin.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}};
const call=(pool,action,payload)=>pool.query('SELECT crm_audience_v2.shopify_sync_effect($1,$2) result',[action,JSON.stringify(payload)]).then(r=>r.rows[0].result);
const expire=()=>admin.query("UPDATE crm_audience_v2.shopify_sync_operation SET lease_until=clock_timestamp()-interval '1 second' WHERE state NOT IN('completed','blocked');UPDATE crm_audience_v2.shopify_sync_mutex SET lease_until=clock_timestamp()-interval '1 second'");
(async()=>{let role,shortRole;try{
 assert.equal((await admin.query('show server_version_num')).rows[0].server_version_num,'170010');
 await setupProducts(db);
 await admin.query(fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-sync-runtime.sql'),'utf8'));
 await admin.query('ALTER ROLE crm_shopify_sync LOGIN');
 const roleUrl=new URL(u);roleUrl.username='crm_shopify_sync';role=new Pool({connectionString:roleUrl.href,max:2,statement_timeout:10000});

 const evidence=productEvidence('fish',Array.from({length:5001},(_,i)=>({id:i+1,products:[101]})),'901'),{customers,...meta}=evidence;
 const base={idempotency_key:'shopify-products:fish:2026-09-29',brand:'fish',kind:'recover',scheduled_for:'2026-09-29T00:00:00.000Z',bulk_operation_id:evidence.operation_id,lease_seconds:300,query_sha256:querySha256};
 const first=await call(role,'claim',base);assert.equal(first.owned,true);
 const duplicate=await call(role,'claim',base);assert.equal(duplicate.owned,false);assert.equal(Object.hasOwn(duplicate,'lease'),false);
 assert.equal((await admin.query('SELECT count(*)::int n FROM crm_audience_v2.shopify_sync_operation')).rows[0].n,1);
 await expire();
 const resumed=await call(role,'claim',base);assert.equal(resumed.owned,true);assert.notEqual(resumed.lease,first.lease);
 await assert.rejects(call(role,'renew',{operation_id:first.operation_id,lease:first.lease,lease_seconds:90}),/SHOPIFY_SYNC_LEASE_LOST/);
 await call(role,'bind_bulk',{operation_id:resumed.operation_id,lease:resumed.lease,bulk_operation_id:evidence.operation_id});
 const staged=await call(role,'evidence',{operation_id:resumed.operation_id,lease:resumed.lease,meta,chunks:2});assert.equal(staged.next_chunk,0);
 const chunk0=customers.slice(0,5000);
 shortRole=new Pool({connectionString:roleUrl.href,max:1,statement_timeout:10,query_timeout:2000});
 const normalStore=createStore({pool:shortRole}),largeStore=createStore({pool:shortRole,ingestTimeoutMs:180000});
 await assert.rejects(normalStore.ingest(resumed.operation_id,resumed.lease,0,chunk0),e=>e.code==='57014');
 assert.equal((await admin.query('SELECT count(*)::int n FROM crm_audience_v2.shopify_product_chunk')).rows[0].n,0);
 assert.equal((await call(role,'inspect',{idempotency_key:base.idempotency_key})).next_chunk,0);
 await largeStore.ingest(resumed.operation_id,resumed.lease,0,chunk0);
 assert.equal((await shortRole.query('SHOW statement_timeout')).rows[0].statement_timeout,'10ms');
 await assert.rejects(shortRole.query('SELECT pg_sleep(0.05)'),e=>e.code==='57014');
 // An invalid next chunk must roll back and discard the extended-deadline client.
 await assert.rejects(largeStore.ingest(resumed.operation_id,resumed.lease,1,[]),/SHOPIFY_INGEST_COMPLETENESS/);
 assert.equal((await shortRole.query('SHOW statement_timeout')).rows[0].statement_timeout,'10ms');
 const reconciled=await call(role,'chunk_status',{operation_id:resumed.operation_id,lease:resumed.lease,part:0,customers:chunk0});assert.equal(reconciled.status,'committed');
 const replayEvidence=await call(role,'evidence',{operation_id:resumed.operation_id,lease:resumed.lease,meta,chunks:2});assert.equal(replayEvidence.replayed,true);assert.equal(replayEvidence.next_chunk,1);
 const drift=structuredClone(meta);drift.observed_at=new Date(Date.parse(meta.observed_at)+1000).toISOString();
 await assert.rejects(call(role,'evidence',{operation_id:resumed.operation_id,lease:resumed.lease,meta:drift,chunks:2}),/SHOPIFY_SYNC_EVIDENCE_CONFLICT/);
 const lostCommitPool={query:(...args)=>role.query(...args),connect:async()=>{const client=await role.connect();return {query:async(...args)=>{const result=await client.query(...args);if(args[0]==='COMMIT')throw Object.assign(Error('SYNTHETIC_COMMIT_ACK_LOST'),{code:'ECONNRESET'});return result;},release:discard=>client.release(discard)};}};
 const lostCommitStore=createStore({pool:lostCommitPool,ingestTimeoutMs:180000});
 await assert.rejects(lostCommitStore.ingest(resumed.operation_id,resumed.lease,1,customers.slice(5000)),/SYNTHETIC_COMMIT_ACK_LOST/);
 assert.equal((await call(role,'chunk_status',{operation_id:resumed.operation_id,lease:resumed.lease,part:1,customers:customers.slice(5000)})).status,'committed');
 const done=await call(role,'finish',{operation_id:resumed.operation_id,lease:resumed.lease});assert.equal(done.state,'completed');

 const before=(await admin.query('SELECT chunk_index,payload_sha256,xmin::text,ctid::text FROM crm_audience_v2.shopify_product_chunk WHERE brand=$1 AND operation_id=$2 ORDER BY chunk_index',['fish',evidence.operation_id])).rows;
 const readyBase={...base,idempotency_key:'shopify-products:fish:2026-09-29-ready',scheduled_for:'2026-09-29T00:00:01.000Z'},ready=await call(role,'claim',readyBase);
 await call(role,'bind_bulk',{operation_id:ready.operation_id,lease:ready.lease,bulk_operation_id:evidence.operation_id});
 const recoveredMeta=structuredClone(meta);recoveredMeta.observed_at=new Date(Date.parse(meta.observed_at)+1000).toISOString();const recoveredDrift=structuredClone(recoveredMeta);recoveredDrift.workflow_version+='-drift';
 await assert.rejects(call(role,'evidence',{operation_id:ready.operation_id,lease:ready.lease,meta:recoveredDrift,chunks:2}),/SHOPIFY_SYNC_EVIDENCE_CONFLICT/);
 await call(role,'evidence',{operation_id:ready.operation_id,lease:ready.lease,meta:recoveredMeta,chunks:2});
 for(const [part,chunk] of [chunk0,customers.slice(5000)].entries())assert.equal((await call(role,'chunk_status',{operation_id:ready.operation_id,lease:ready.lease,part,customers:chunk})).status,'committed');
 assert.equal((await call(role,'finish',{operation_id:ready.operation_id,lease:ready.lease})).state,'completed');
 const after=(await admin.query('SELECT chunk_index,payload_sha256,xmin::text,ctid::text FROM crm_audience_v2.shopify_product_chunk WHERE brand=$1 AND operation_id=$2 ORDER BY chunk_index',['fish',evidence.operation_id])).rows;assert.deepEqual(after,before);

 const runBase={idempotency_key:'shopify-products:aristo:2026-09-29',brand:'aristo',kind:'run',scheduled_for:'2026-09-29T00:00:00.000Z',bulk_operation_id:null,lease_seconds:90,query_sha256:querySha256};
 const run=await call(role,'claim',runBase),intent=await call(role,'start_intent',{operation_id:run.operation_id,lease:run.lease,intent_sha256:'c'.repeat(64)});assert.ok(intent.intent_at);
 await expire();
 await assert.rejects(call(role,'claim',{...base,idempotency_key:'shopify-products:fish:2026-09-30',scheduled_for:'2026-09-30T00:00:00.000Z'}),/SHOPIFY_SYNC_START_UNCERTAIN/);
 const runResumed=await call(role,'claim',runBase);assert.equal(runResumed.state,'start_intent');
 await call(role,'bind_bulk',{operation_id:runResumed.operation_id,lease:runResumed.lease,bulk_operation_id:'gid://shopify/BulkOperation/999'});
 const runDuplicate=await call(role,'claim',runBase);assert.equal(runDuplicate.owned,false);assert.equal(runDuplicate.bulk_operation_id,'gid://shopify/BulkOperation/999');assert.equal(Object.hasOwn(runDuplicate,'lease'),false);

 await assert.rejects(role.query('SELECT * FROM crm_audience_v2.shopify_sync_operation'),e=>e.code==='42501');
 await assert.rejects(role.query("SELECT crm_audience_v2.shopify_ingest_product_chunk('{}'::jsonb,0,'[]'::jsonb)"),e=>e.code==='42501');
 console.log(JSON.stringify({ok:true,postgres:'17.10',ingest_deadline_only:true,cancelled_ingest_rolled_back:true,deadline_restored_after_commit_and_failure:true,lost_commit_ack_reconciled:true,duplicate_claim_does_not_steal:true,expired_lease_fenced:true,start_intent_blocks_competing_mutation:true,run_idempotency_survives_bulk_binding:true,committed_chunk_reconciled:true,evidence_resume_exact:true,ready_recovery_rejects_meta_drift:true,ready_recovery_no_rewrite:true,direct_tables_denied:true,direct_ingest_denied:true,remote:false}));
}finally{if(shortRole)await shortRole.end();if(role)await role.end();await admin.end();}})().catch(e=>{console.error(JSON.stringify({ok:false,error:'CRM_SHOPIFY_SYNC_PG_PROOF',code:e.code||'ASSERTION',message:String(e.message||'ASSERTION').slice(0,200)}));process.exitCode=1;});
