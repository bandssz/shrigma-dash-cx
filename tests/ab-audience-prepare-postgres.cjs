'use strict';
// Dedicated, empty, loopback-only PG17.10 test database. No credential lookup.
const assert=require('node:assert/strict'),{Pool}=require('pg');
const F=require('./ab-audience-prepare-fixture.cjs'),P=require('../n8n/growth/ab-audience-prepare.cjs');
const connectionString=process.env.TEST_DATABASE_URL;
if(process.env.AB_AUDIENCE_TEST_DATABASE_ISOLATED!=='1'||!connectionString)throw Error('ISOLATED_DATABASE_REQUIRED');
const url=new URL(connectionString);
if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.pathname!=='/ab_audience_prepare_test'||!url.port||url.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString,max:8,statement_timeout:20000,connectionTimeoutMillis:5000});
const db={query:(q,v)=>pool.query(q,v),exec:q=>pool.query(q),transaction:async work=>{
 const c=await pool.connect();let destroy=false;try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');const r=await work(c);await c.query('COMMIT');return r;}catch(e){try{await c.query('ROLLBACK');}catch{destroy=true;}throw e;}finally{c.release(destroy);}
}};
const clients=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
function service(c){return P.createAudiencePrepare({timeoutMs:10000,transaction:async work=>{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');try{const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}}});}
(async()=>{try{
 const info=(await db.query("SELECT current_database() AS db,current_setting('server_version_num')::int AS version,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','v','m','S')) AS existing")).rows[0];
 assert.equal(info.db,'ab_audience_prepare_test');assert.equal(info.version,170010);assert.equal(info.existing,0);
 const x=await F.setup(db),a=await pool.connect(),b=await pool.connect(),blocker=await pool.connect();clients.push(a,b,blocker);
 const pids=await Promise.all(clients.map(c=>c.query('SELECT pg_backend_pid() AS pid').then(r=>r.rows[0].pid)));assert.equal(new Set(pids).size,3);
 await x.bindBoth('fish');await x.bindBoth('aristo');
 const fish=await x.protocol('fish'),preview=await x.inspect(fish);assert.equal(preview._http,200,JSON.stringify(preview));
 await blocker.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await blocker.query('SELECT campaign_id FROM crm_audience_v2.campaign_binding');
 const op=F.uuid(6001),request={acao:P.ACTIONS.prepare,brand:'fish',protocol:fish,intent:preview._body.intent,operation_id:op};
 const pair=await Promise.all([service(a).execute({key:'synthetic-manager-key',request}),service(b).execute({key:'synthetic-manager-key',request})]);
 assert.equal(pair[0]._http,201,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_request')).rows[0].n,1);
 const saved=await x.members(fish.test_id);assert.deepEqual(saved.map(m=>m.subscriber_id),[1,2,3,4]);
 await assert.rejects(blocker.query('UPDATE crm_audience_v2.campaign_binding SET updated_at=updated_at WHERE campaign_id=100'),e=>e.code==='P0001'&&e.message==='AB_AUDIENCE_ISOLATION');await blocker.query('ROLLBACK');
 const readback=await service(b).execute({key:'synthetic-manager-key',request:{acao:P.ACTIONS.operation,brand:'fish',operation_id:op}});assert.deepEqual(readback,pair[0]);
 await assert.rejects(db.query("UPDATE crm_ab_experiment_v2 SET state='scheduled',transport_bound=true WHERE test_id=$1",[fish.test_id]));
 await assert.rejects(db.query('UPDATE crm_ab_arm_v2 SET allocated_count=allocated_count+1 WHERE test_id=$1',[fish.test_id]));
 await assert.rejects(db.query('DELETE FROM crm_ab_member_v2 WHERE test_id=$1',[fish.test_id]));
 const oldSeed=(await db.query('SELECT seed FROM crm_ab_experiment_v2 WHERE test_id=$1',[fish.test_id])).rows[0].seed;
 await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=17");
 await db.query("INSERT INTO subscriber_lists VALUES(9,101,'confirmed')");
 assert.deepEqual(await x.members(fish.test_id),saved);assert.equal((await db.query('SELECT seed FROM crm_ab_experiment_v2 WHERE test_id=$1',[fish.test_id])).rows[0].seed,oldSeed);

 const aristo=await x.protocol('aristo'),review=await x.inspect(aristo),op2=F.uuid(6002);assert.equal(review._http,200);
 await blocker.query('BEGIN');await blocker.query(P.SQL.operationLock,[op2]);
 const waiting=service(a).execute({key:'synthetic-manager-key',request:{acao:P.ACTIONS.prepare,brand:'aristo',protocol:aristo,intent:review._body.intent,operation_id:op2}});
 let blocked=false;const deadline=Date.now()+350;
 while(Date.now()<deadline){if((await db.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pids[0]])).rows[0]?.wait_event==='advisory'){blocked=true;break;}await wait(5);}assert.equal(blocked,true);
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='manager'");await blocker.query('COMMIT');
 assert.equal((await waiting)._http,403);assert.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.ab_request WHERE operation_key=$1",[op2])).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int n FROM crm_ab_experiment_v2 WHERE brand='aristo'")).rows[0].n,0);
 assert.deepEqual((await db.query('SELECT DISTINCT status,sent,started_at FROM campaigns WHERE id IN(100,101,200,201)')).rows,[{status:'draft',sent:0,started_at:null}]);
 assert.equal((await db.query('SELECT enabled FROM crm_ab_runtime_v2')).rows[0].enabled,false);
 console.log(JSON.stringify({ok:true,postgres_version:info.version,independent_connections:true,parallel_replay:true,private_cohort_before_split:true,immutable_seed_denominator:true,old_snapshot_cannot_rebind:true,independent_receipt_readback:true,reauth_after_wait:true,operational_runtime_off:true,transport:false}));
}finally{for(const c of clients){try{await c.query('ROLLBACK');}catch{}c.release();}await pool.end();}})().catch(e=>{console.error('AB_AUDIENCE_POSTGRES_PROOF_FAILED',e.code||e.name,e.message);process.exitCode=1;});
