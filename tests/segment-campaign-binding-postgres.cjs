'use strict';
// Explicit, empty, loopback-only disposable PG17.10 database. No credential discovery.
const assert=require('node:assert/strict'),{Pool}=require('pg');
const F=require('./segment-campaign-binding-fixture.cjs'),B=require('../n8n/growth/segment-campaign-binding.cjs');
const connectionString=process.env.TEST_DATABASE_URL;
if(process.env.SEGMENT_BINDING_TEST_DATABASE_ISOLATED!=='1'||!connectionString)throw Error('ISOLATED_DATABASE_REQUIRED');
const url=new URL(connectionString);
if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.pathname!=='/segment_binding_test'||!url.port||url.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString,max:8,statement_timeout:20000,connectionTimeoutMillis:5000});
const db={query:(q,p)=>pool.query(q,p),exec:q=>pool.query(q),transaction:async work=>{
 const c=await pool.connect();let destroy=false;
 try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){try{await c.query('ROLLBACK');}catch{destroy=true;}throw e;}
 finally{c.release(destroy);}
}};
const clients=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 try{
  const info=(await db.query("SELECT current_database() AS db,current_setting('server_version_num')::int AS version,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','v','m','S')) AS existing")).rows[0];
  assert.equal(info.db,'segment_binding_test');assert.equal(info.version,170010);assert.equal(info.existing,0);
  const x=await F.setup(db),a=await pool.connect(),b=await pool.connect(),blocker=await pool.connect();clients.push(a,b,blocker);
  const pids=await Promise.all(clients.map(c=>c.query('SELECT pg_backend_pid() AS pid').then(r=>r.rows[0].pid)));
  assert.equal(new Set(pids).size,3);
  const fish=await x.createAudience('fish','pg-fish-audience',{op:'in_list',list_id:101});
  const aristo=await x.createAudience('aristo','pg-aristo-audience',{op:'in_list',list_id:201});
  const checked=await x.inspect('fish',100,fish);assert.equal(checked.status,200);

  // Establish a real old RR snapshot before creating the binding. The no-op
  // campaign touch must force a serialization failure, not let an old snapshot
  // overlook the new guard row. No guard or isolation rule is bypassed.
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await a.query('SELECT id FROM campaigns WHERE id=100');
  const pair=await Promise.all([x.bind(checked.body.intent,'pg-parallel-binding'),x.bind(checked.body.intent,'pg-parallel-binding')]);
  assert.equal(pair[0].status,201);assert.deepEqual(pair[0],pair[1]);
  await assert.rejects(a.query('UPDATE campaigns SET updated_at=updated_at WHERE id=100'),e=>e.code==='40001');await a.query('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding')).rows[0].n,1);
  assert.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_request WHERE operation_key='pg-parallel-binding'")).rows[0].n,1);

  // Independent readers recover the original receipt without rebinding.
  const service=client=>B.createSegmentCampaignBinding({transaction:async work=>{
   await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');try{const r=await work(client);await client.query('COMMIT');return r;}catch(e){await client.query('ROLLBACK');throw e;}
  },timeoutMs:10000});
  const recovered=await service(b).execute({key:'synthetic-manager-key',request:{acao:B.ACTIONS.operation,brand:'fish',idempotency_key:'pg-parallel-binding'}});
  assert.equal(recovered._http,201);assert.deepEqual(recovered._body,pair[0].body);

  // Competing editors with the same binding CAS: exactly one new revision.
  const current=await x.inspect('fish',100,fish);assert.equal(current.status,200);
  const edits=await Promise.all([x.bind(current.body.intent,'pg-cas-binding-one'),x.bind(current.body.intent,'pg-cas-binding-two')]);
  assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);
  assert.equal((await x.bound(100)).binding_version,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_revision WHERE campaign_id=100')).rows[0].n,2);

  // A RC transaction that predates the Aristo binding must observe it on its
  // later statement. A valid legacy scheduling path still cannot activate it.
  await a.query('BEGIN');await a.query('SELECT id FROM campaigns WHERE id=200');
  const ai=await x.inspect('aristo',200,aristo);assert.equal(ai.status,200);
  assert.equal((await x.bind(ai.body.intent,'pg-aristo-binding')).status,201);
  assert.equal((await a.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding WHERE campaign_id=200')).rows[0].n,1);await a.query('COMMIT');
  for(const id of [100,200])await assert.rejects(x.legacySchedule(id),e=>e.message.includes('SEGMENT_CAMPAIGN_SELECTOR_REQUIRED'));
  assert.deepEqual((await db.query('SELECT status,sent,started_at FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows,[{status:'draft',sent:0,started_at:null},{status:'draft',sent:0,started_at:null}]);

  // Revoke permission while an independent connection waits on the operation
  // lock. It must reauthorize after the wait and create no receipt/revision.
  const ri=await x.inspect('aristo',200,aristo),key='pg-revoked-binding';assert.equal(ri.status,200);
  await blocker.query('BEGIN');await blocker.query(B.SQL.lock,['panel:manager',key]);
  const pending=service(a).execute({key:'synthetic-manager-key',request:{acao:B.ACTIONS.bind,...ri.body.intent,idempotency_key:key}});
  let waiting=false;const until=Date.now()+350;
  while(Date.now()<until){const activity=(await db.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pids[0]])).rows[0];if(activity?.wait_event==='advisory'){waiting=true;break;}await wait(5);}
  assert.equal(waiting,true);
  await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='manager'");await blocker.query('COMMIT');
  const denied=await pending;assert.equal(denied._http,403);
  assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_request WHERE operation_key=$1',[key])).rows[0].n,0);
  assert.equal((await x.bound(200)).binding_version,1);
  console.log(JSON.stringify({ok:true,postgres_version:info.version,independent_connections:true,parallel_replay:true,binding_cas:true,old_repeatable_read_rejected:true,read_committed_observes_binding:true,legacy_schedule_blocked_both_brands:true,independent_receipt_readback:true,reauthorization_after_lock:true,transport:false}));
 }finally{
  for(const c of clients){try{await c.query('ROLLBACK');}catch{}c.release();}
  await pool.end();
 }
})().catch(e=>{console.error('SEGMENT_BINDING_POSTGRES_PROOF_FAILED',e.code||e.name,e.message);process.exitCode=1;});
