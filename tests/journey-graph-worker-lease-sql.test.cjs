'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const SQL=fs.readFileSync(path.join(__dirname,'../n8n/growth/journey-graph-worker-lease.sql'),'utf8'),W='a'.repeat(64),R='b'.repeat(64),C='c'.repeat(64),T='d'.repeat(64);
async function tx(db,instance,worker=W,runtime=R){await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');try{await db.query("SET LOCAL statement_timeout='10s'");const out=(await db.query('SELECT crm_graph_candidate.graph_worker_heartbeat_v1($1,$2,$3) result',[instance,worker,runtime])).rows[0].result;await db.query('COMMIT');return out;}catch(e){await db.query('ROLLBACK');throw e;}}
test('SQL defaults OFF, grants nothing, fences identities and exposes only aggregate non-authority status',async()=>{
 const db=new PGlite();try{await db.waitReady;await db.exec("CREATE SCHEMA crm_graph_candidate;CREATE ROLE crm_graph_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;");await db.exec(SQL);
  assert.equal((await db.query("SELECT has_function_privilege('public','crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text)','EXECUTE') ok")).rows[0].ok,false);
  assert.equal((await db.query("SELECT has_function_privilege('crm_graph_worker','crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text)','EXECUTE') ok")).rows[0].ok,false);
  for(const fn of ['graph_worker_readiness_v1()','graph_worker_lease_status_v1()'])assert.equal((await db.query("SELECT has_function_privilege('public',$1,'EXECUTE') ok",['crm_graph_candidate.'+fn])).rows[0].ok,false);
  await db.exec(`CREATE FUNCTION crm_graph_candidate.fixture_approve(onoff boolean) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$UPDATE crm_graph_candidate.graph_worker_deployment_v1 SET enabled=onoff,worker_sha256=repeat('a',64),runtime_sha256=repeat('b',64),database_role='crm_graph_worker',cache_target='fixture-cache',cache_approval_sha256=repeat('c',64),topology_receipt_sha256=repeat('d',64),approved_at=clock_timestamp(),approved_by='admin:fixture'$$;
   CREATE FUNCTION crm_graph_candidate.fixture_expire() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$UPDATE crm_graph_candidate.graph_worker_lease_v1 SET suspended=false,suspension_reason=NULL,heartbeat_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute'$$;
   GRANT USAGE ON SCHEMA crm_graph_candidate TO crm_graph_worker;
   GRANT EXECUTE ON FUNCTION crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text),crm_graph_candidate.graph_worker_lease_status_v1(),crm_graph_candidate.graph_worker_readiness_v1(),crm_graph_candidate.fixture_approve(boolean),crm_graph_candidate.fixture_expire() TO crm_graph_worker`);
  const one=randomUUID(),two=randomUUID();await db.query('SET SESSION AUTHORIZATION crm_graph_worker');
  assert.deepEqual(await tx(db,one),{ready:false,reason:'deployment_unavailable',authorizes_activate:false});await db.query('SELECT crm_graph_candidate.fixture_approve(true)');
  const healthy=await tx(db,one);assert.equal(healthy.ready,true);assert.equal(healthy.authorizes_activate,false);assert.equal(healthy.cache_identity_live_verified,false);
  assert.deepEqual(await tx(db,two),{ready:false,reason:'competing_instance',authorizes_activate:false});assert.deepEqual(await tx(db,one),{ready:false,reason:'lease_suspended',authorizes_activate:false});
  let status=(await db.query('SELECT crm_graph_candidate.graph_worker_lease_status_v1() result')).rows[0].result;assert.equal(status.executor_ready,false);assert.equal(status.reason,'competing_instance');assert.equal(status.activation_ready,false);assert.equal(status.cache_identity_live_verified,false);assert.equal(Object.hasOwn(status,'instance_id'),false);assert.equal(JSON.stringify(status).includes(W),false);
  const privateReadiness=(await db.query('SELECT crm_graph_candidate.graph_worker_readiness_v1() result')).rows[0].result;assert.deepEqual(privateReadiness.blockers,['competing_instance','cache_identity_live_unverified']);assert.equal(privateReadiness.pins.cache_target,'fixture-cache');assert.equal(privateReadiness.pins.cache_identity_live_verified,false);
  await db.query('SELECT crm_graph_candidate.fixture_expire()');assert.equal((await tx(db,two)).ready,true);assert.deepEqual(await tx(db,two,W,'e'.repeat(64)),{ready:false,reason:'identity_unavailable',authorizes_activate:false});
  status=(await db.query('SELECT crm_graph_candidate.graph_worker_lease_status_v1() result')).rows[0].result;assert.equal(status.reason,'identity_changed');
 }finally{await db.close();}
});
