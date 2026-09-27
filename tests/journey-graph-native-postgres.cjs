/* PostgreSQL 17, empty disposable DB only. All native HTTP/cache are synthetic. */
'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg'),{install,id}=require('./journey-graph-native-fixture.cjs');
(async()=>{
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.pathname,'/journey_graph_native_test');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.search,'');assert.equal(u.hash,'');
 const pool=new Pool({connectionString:u.toString(),max:6,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'synthetic-graph-native-proof'});let blocker;
 try{
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','crm_graph_candidate') AND c.relkind IN ('r','p','v')")).rows[0].n,0,'requires empty disposable DB');
  const version=Number((await pool.query("SELECT current_setting('server_version_num') v")).rows[0].v);assert.ok(version>=170000&&version<180000);
  const f=await install({exec:q=>pool.query(q),query:(q,a)=>pool.query(q,a)}),release=await f.release('fish'),p=f.requestFor(release),actor='panel:synthetic';
  const prepared=await Promise.all([f.native.prepare(actor,p),f.native.prepare(actor,p)]);assert.equal(prepared[0].native_id,prepared[1].native_id);assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.native_request_v1')).rows[0].n,1);
  const nid=prepared[0].native_id;await assert.rejects(f.native.prepare('panel:other',p),/REPLAY_MISMATCH/);
  const results=await Promise.all([f.native.create('fish',nid),f.native.create('fish',nid)]);assert.ok(results.every(x=>['creating','ready'].includes(x.state)));assert.equal(f.calls.create,1);
  const ready=await f.native.resolve('fish',release.id,release.material_sha256);assert.equal(ready.state,'ready');assert.equal((await pool.query('SELECT count(*)::int n FROM templates WHERE name=$1',['__shrigma_graph_tx_v1_'+nid])).rows[0].n,1);
  await assert.rejects(f.native.create('aristo',nid),/NOT_FOUND/);
  // A row lock serializes competing begin requests; only the winner receives a token.
  const aristo=await f.prepared('aristo'),aid=aristo.receipt.native_id;blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM crm_graph_candidate.native_template_v1 WHERE id=$1 FOR UPDATE',[aid]);
  const args=['aristo',aid,f.settings.cacheTarget],q='SELECT crm_graph_candidate.native_begin_v1($1,$2,$3) AS result';
  const pending=[pool.query(q,args),pool.query(q,args)];const outcomes=Promise.all(pending);
  let waiting=false;for(let i=0;i<50;i++){waiting=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='synthetic-graph-native-proof' AND wait_event_type='Lock' AND query LIKE 'SELECT crm_graph_candidate.native_begin_v1%'")).rows[0].n===2;if(waiting)break;await new Promise(r=>setTimeout(r,20));}assert.equal(waiting,true);
  await blocker.query('COMMIT');blocker.release();blocker=null;const claims=(await outcomes).map(x=>x.rows[0].result);assert.equal(claims.filter(x=>x.should_create).length,1);assert.ok(claims.filter(x=>!x.should_create).every(x=>!('claim_token'in x)));
  assert.equal((await f.native.create('aristo',aid)).state,'creating');assert.equal(f.calls.create,1);
  // Lost native response produces a clone but cannot acquire cache readiness by GET.
  await pool.query("UPDATE templates SET subject='Second Aristo synthetic revision' WHERE id=95");const lost=await f.prepared('aristo'),lostProvider=f.newProvider({nativeCreate:async(...args)=>{await f.settings.nativeCreate(...args);throw Error('Synthetic lost HTTP reply');}});
  await assert.rejects(lostProvider.create('aristo',lost.receipt.native_id),/OUTCOME_UNKNOWN/);assert.equal((await f.native.reconcile('aristo',lost.receipt.native_id)).diagnosis,'native_exists_cache_unconfirmed');const calls=f.calls.create;assert.equal((await f.native.create('aristo',lost.receipt.native_id)).state,'creating');assert.equal(f.calls.create,calls);
  // ACK known, SQL committed, reply lost: only the original in-memory token is reused.
  await pool.query("UPDATE templates SET subject='Third Aristo synthetic revision' WHERE id=95");const confirmed=await f.prepared('aristo');let lose=true;
  const ackProvider=f.newProvider({query:async(q,a)=>{const r=await f.query(q,a);if(q.includes('native_confirm_v1')&&lose){lose=false;throw Error('Synthetic lost SQL reply');}return r;}});
  await assert.rejects(ackProvider.create('aristo',confirmed.receipt.native_id),/OUTCOME_UNKNOWN/);const observed=await f.native.inspect('aristo',confirmed.receipt.native_id);assert.equal(observed.state,'ready');assert.deepEqual(await ackProvider.confirm('aristo',confirmed.receipt.native_id),observed);
  await assert.rejects(f.native.confirm('aristo',confirmed.receipt.native_id),/ACK_REQUIRED/);
  // A receipt insert error rolls back both reservation and operation identity.
  await pool.query("UPDATE templates SET subject='Fourth synthetic revision' WHERE id=95");const freshRelease=await f.release('aristo'),before=(await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.native_template_v1')).rows[0].n;
  await pool.query("CREATE FUNCTION crm_graph_candidate.native_pg_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic receipt fault';END$$;CREATE TRIGGER native_pg_fault BEFORE INSERT ON crm_graph_candidate.native_request_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.native_pg_fault();");
  await assert.rejects(f.native.prepare(actor,{...f.requestFor(freshRelease),request_id:id(88000)}),/OUTCOME_UNKNOWN/);assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.native_template_v1')).rows[0].n,before);
  console.log(JSON.stringify({proof:'journey_graph_native_postgres_v1',postgres_version_num:version,concurrent_prepare:true,concurrent_create_once:true,lock_serialization:true,token_first_claim_only:true,brand_isolation:true,lost_native_ack_not_ready:true,diagnostic_no_retry:true,lost_sql_reply_same_token:true,receipt_failure_atomic:true,synthetic_native_calls:f.calls.create,real_http_calls:0,sends:0}));
 }finally{if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}await pool.end();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
