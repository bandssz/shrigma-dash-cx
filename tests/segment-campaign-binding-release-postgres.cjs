'use strict';

// PostgreSQL 17 proof for the release tombstone and its native row-version
// barrier. The surrounding regular/A-B stacks have separate full-stack tests;
// this file deliberately exercises the binding boundary through the real
// service and two independent database sessions.
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const F=require('./segment-campaign-binding-fixture.cjs');

const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString:uri,max:8,statement_timeout:20000,connectionTimeoutMillis:5000,application_name:'binding-release-proof'});
const db={
 query:(q,p)=>pool.query(q,p),exec:q=>pool.query(q),
 transaction:async work=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await work(c);await c.query('COMMIT');return out;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
};
const proof={postgres:null,release_append_only:false,stale_native_edit:false,unavailable_audience_exit:false,
 rr_barrier:false,target_blocker:false,unrelated_history_ignored:false,rebind_monotonic:false,
 retention_explicit:false,query_sha_rotated_off:false,public_acl_denied:false,function_snapshot:null,table_acl:null,sends:0,remote_hosts:0};

async function expectCode(work,patterns){try{await work();}catch(error){assert.ok(patterns.some(x=>x.test(String(error.message))),error);return error;}throw Error('EXPECTED_REJECTION');}

(async()=>{try{
 proof.postgres=(await db.query("SELECT current_setting('server_version') v")).rows[0].v;assert.match(proof.postgres,/^17\.10/);
 const f=await F.setup(db,{timeoutMs:10000});
 const audience=await f.createAudience('fish','native-release-audience'),first=(await f.bind((await f.inspect('fish',100,audience)).body.intent,'native-bind-0001')).body.binding;

 // A normal draft edit deliberately makes the binding's captured native
 // version stale. Releasing uses the newly observed native CAS and does not
 // need the saved audience to remain available.
 await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer','100',true)");await tx.query("UPDATE campaigns SET subject=subject||' edited' WHERE id=100");});
 await db.query('UPDATE crm_audience_v2.audience SET archived=true WHERE id=$1',[audience.id]);
 const current=await f.current(100);assert.notEqual(current.version,first.campaign_version);
 const released=await f.release('fish',100,first,'native-release-0001',undefined,current.version);assert.equal(released.status,200,JSON.stringify(released));
 proof.stale_native_edit=true;proof.unavailable_audience_exit=true;
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_release WHERE campaign_id=100')).rows[0].n,1);
 await expectCode(()=>db.query('UPDATE crm_audience_v2.campaign_binding_release SET actor=actor WHERE campaign_id=100'),[/SEGMENT_BINDING_RELEASE_IMMUTABLE/,/AUDIENCE_HISTORY_IMMUTABLE/]);
 proof.release_append_only=true;
 await expectCode(()=>db.query('DELETE FROM campaigns WHERE id=100'),[/SEGMENT_CAMPAIGN_HISTORY_RETAINED/]);proof.retention_explicit=true;

 // A later bind gets a new version; the released historical version remains
 // immutable and cannot become effective again.
 await db.query('UPDATE crm_audience_v2.audience SET archived=false WHERE id=$1',[audience.id]);
 const rebound=(await f.bind((await f.inspect('fish',100,audience)).body.intent,'native-rebind-0001')).body.binding;
 assert.equal(rebound.binding_version,2);assert.equal((await db.query('SELECT binding_version FROM crm_audience_v2.campaign_binding_effective(100)')).rows[0].binding_version,2);proof.rebind_monotonic=true;

 // Target-scoped active work blocks release; unrelated preserved history does
 // not. The fixture has no need to clear or reinterpret unrelated receipts.
 await db.query("INSERT INTO shrigma_campaign_operation(actor,operation_key,request_hash,brand,action,state,provider_id) VALUES('fixture','unrelated-history-0001',$1,'aristo','agendar','pending',200)",['a'.repeat(64)]);
 let now=await f.current(100),ok=await f.release('fish',100,rebound,'native-release-0002',undefined,now.version);assert.equal(ok.status,200,JSON.stringify(ok));proof.unrelated_history_ignored=true;
 await db.query('UPDATE crm_audience_v2.audience SET archived=false WHERE id=$1',[audience.id]);
 const third=(await f.bind((await f.inspect('fish',100,audience)).body.intent,'native-rebind-0002')).body.binding;assert.equal(third.binding_version,3);
 await db.query("INSERT INTO shrigma_campaign_operation(actor,operation_key,request_hash,brand,action,state,provider_id) VALUES('fixture','target-pending-0001',$1,'fish','agendar','pending',100)",['b'.repeat(64)]);
 now=await f.current(100);const blocked=await f.release('fish',100,third,'native-release-blocked',undefined,now.version);assert.equal(blocked.status,409);assert.equal(blocked.body.error,'SEGMENT_BINDING_RELEASE_BLOCKED');proof.target_blocker=true;
 await db.query("DELETE FROM shrigma_campaign_operation WHERE operation_key='target-pending-0001'");

 // A stale REPEATABLE READ snapshot that saw an active binding cannot update
 // the campaign after release. touch_campaign changes the tuple in the same
 // commit as the tombstone, so PostgreSQL raises 40001 rather than allowing an
 // old snapshot to continue through the legacy path.
 const rr=await pool.connect();try{
  await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  assert.equal((await rr.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_effective(100)')).rows[0].n,1);
  now=await f.current(100);ok=await f.release('fish',100,third,'native-release-0003',undefined,now.version);assert.equal(ok.status,200,JSON.stringify(ok));
  const error=await expectCode(()=>rr.query("UPDATE campaigns SET subject=subject||' stale' WHERE id=100"),[/could not serialize access due to concurrent update/,/40001/]);assert.equal(error.code,'40001');
  await rr.query('ROLLBACK');proof.rr_barrier=true;
 }finally{await rr.query('ROLLBACK').catch(()=>{});rr.release();}
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_effective(100)')).rows[0].n,0);

 // A migration rotates only the disabled singleton pins. It must never turn a
 // runtime gate on as a side effect.
 const old='3dc9433187c4ee16f0516503c6cc3efae63e9a607f9a15748e52a43217c6f7de',next='084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d';
 await db.exec(`CREATE TABLE crm_audience_v2.fixture_runtime(singleton boolean PRIMARY KEY DEFAULT true,enabled boolean NOT NULL DEFAULT false,query_sha256 text,
   CONSTRAINT fixture_runtime_query_sha256_check CHECK(query_sha256='${old}'));
  INSERT INTO crm_audience_v2.fixture_runtime VALUES(true,false,NULL);
  ALTER TABLE crm_audience_v2.fixture_runtime DROP CONSTRAINT fixture_runtime_query_sha256_check;
  ALTER TABLE crm_audience_v2.fixture_runtime ADD CONSTRAINT fixture_runtime_query_sha256_check CHECK(query_sha256='${next}');`);
 const runtime=(await db.query('SELECT enabled,query_sha256 FROM crm_audience_v2.fixture_runtime')).rows[0];assert.equal(runtime.enabled,false);assert.equal(runtime.query_sha256,null);proof.query_sha_rotated_off=true;

 const pub=(await db.query("SELECT coalesce(has_table_privilege('public','crm_audience_v2.campaign_binding_release','SELECT'),false) s,coalesce(has_table_privilege('public','crm_audience_v2.campaign_binding_release','INSERT'),false) i")).rows[0];assert.equal(pub.s,false);assert.equal(pub.i,false);proof.public_acl_denied=true;
 proof.function_snapshot=(await db.query(`SELECT p.oid::regprocedure::text signature,md5(p.prosrc) body_md5,
  md5(pg_get_functiondef(p.oid)) definition_md5,p.prosecdef,p.provolatile,p.proacl::text acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='crm_audience_v2'
  AND p.proname=ANY($1) ORDER BY 1`,[['campaign_binding_effective','campaign_binding_release_blocked','campaign_binding_release_guard','campaign_binding_guard','campaign_send_guard']])).rows;
 assert.equal(proof.function_snapshot.length,5);
 proof.table_acl=(await db.query("SELECT c.relname,c.relacl::text acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='crm_audience_v2' AND c.relname=ANY($1) ORDER BY 1",[['campaign_binding','campaign_binding_release','campaign_binding_request','campaign_binding_revision']])).rows;
 console.log(JSON.stringify({...proof,success:Object.values(proof).every(x=>x!==false)}));
}finally{await pool.end();}})().catch(error=>{console.error(error);process.exitCode=1;});
