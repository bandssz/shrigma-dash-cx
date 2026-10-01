'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');

const uri=process.env.TEST_DATABASE_URL;
const parsed=new URL(uri||'http://invalid');
if(process.env.GRAPH_WORKER_RUNTIME_ACCESS_TEST_ISOLATED!=='1'||parsed.protocol!=='postgresql:'||parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/graph_worker_access_test'||!parsed.port)throw Error('ISOLATED_DATABASE_REQUIRED');
const ROOT=path.resolve(__dirname,'..');
const LEASE=fs.readFileSync(path.join(ROOT,'n8n/growth/journey-graph-worker-lease.sql'),'utf8');
const ACCESS=fs.readFileSync(path.join(ROOT,'n8n/growth/journey-graph-worker-runtime-access.sql'),'utf8');
const base=new URL(uri);
const pool=(role,app)=>{const u=new URL(base);u.username=role;u.password='';const p=new Pool({connectionString:u.href,max:2,statement_timeout:20000,connectionTimeoutMillis:5000,application_name:app});p.on('error',()=>{});return p;};
const owner=pool('postgres','graph-access-owner');
let worker,api,outsider;

async function reset(){
 for(const p of [worker,api,outsider])if(p){await p.end();}
 worker=api=outsider=null;
 await owner.query('DROP SCHEMA IF EXISTS crm_graph_candidate CASCADE');
 for(const role of ['fixture_untrusted','crm_audience_api','crm_graph_worker'])await owner.query(`DROP ROLE IF EXISTS ${role}`);
 await owner.query(`
  CREATE ROLE crm_graph_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE ROLE crm_audience_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE ROLE fixture_untrusted LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE SCHEMA crm_graph_candidate AUTHORIZATION postgres;
  REVOKE ALL ON SCHEMA crm_graph_candidate FROM PUBLIC;
  GRANT USAGE ON SCHEMA crm_graph_candidate TO crm_graph_worker,crm_audience_api;
  CREATE TABLE crm_graph_candidate.control(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),enabled boolean NOT NULL DEFAULT false);
  INSERT INTO crm_graph_candidate.control(singleton) VALUES(true)`);
 await owner.query(LEASE);
}
async function fnAcl(){return (await owner.query(`SELECT p.proname,pg_get_userbyid(p.proowner) owner,md5(p.prosrc) body_md5,md5(pg_get_functiondef(p.oid)) definition_md5,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute,
  has_function_privilege('crm_graph_worker',p.oid,'EXECUTE') worker_execute,
  has_function_privilege('crm_audience_api',p.oid,'EXECUTE') api_execute,
  (SELECT count(*)::int FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.privilege_type='EXECUTE') execute_grants
 FROM pg_proc p WHERE p.oid=ANY(ARRAY[
  'crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text)'::regprocedure,
  'crm_graph_candidate.graph_worker_lease_status_v1()'::regprocedure,
 'crm_graph_candidate.graph_worker_readiness_v1()'::regprocedure]) ORDER BY p.proname`)).rows;}
async function migrate(){const c=await owner.connect();try{return await c.query(ACCESS);}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
async function rejected(mutator,pattern){await reset();await mutator();const before=await fnAcl();await assert.rejects(migrate(),pattern);assert.deepEqual(await fnAcl(),before,'rejected migration changed access');}

(async()=>{
 const cases=[];
 await reset();
 const before=await fnAcl();
 assert.deepEqual(before.map(x=>[x.proname,x.body_md5,x.definition_md5,x.owner,x.public_execute,x.execute_grants]),[
  ['graph_worker_heartbeat_v1','46a22d18750b78127edaa24aa628e082','f1e59da2ebbe0f4b142a8dba34495556','postgres',false,1],
  ['graph_worker_lease_status_v1','e500af476a5ecda9e5d910f507ab4707','6f2ee040a36f47c9c8a4e966f66ddd32','postgres',false,1],
  ['graph_worker_readiness_v1','be803cbeab78d6b9583bb4c30eb6353f','a246e31d1d59928aa71d6b788c51c65e','postgres',false,1]
 ]);
 await migrate();cases.push('exact_guarded_install');
 const after=await fnAcl();
 assert.deepEqual(after.map(x=>[x.proname,x.worker_execute,x.api_execute,x.public_execute,x.execute_grants]),[
  ['graph_worker_heartbeat_v1',true,false,false,2],
  ['graph_worker_lease_status_v1',false,true,false,2],
  ['graph_worker_readiness_v1',false,false,false,1]
 ]);cases.push('split_minimal_acl');
 await assert.rejects(migrate(),/GRAPH_WORKER_RUNTIME_ACCESS_ACL_DRIFT/);cases.push('replay_blocked');

 await owner.query('ALTER ROLE crm_graph_worker LOGIN');
 worker=pool('crm_graph_worker','graph-access-worker');api=pool('crm_audience_api','graph-access-api');outsider=pool('fixture_untrusted','graph-access-outsider');
 const workerRole=(await worker.query('SELECT current_user,session_user')).rows[0];assert.deepEqual(workerRole,{current_user:'crm_graph_worker',session_user:'crm_graph_worker'});
 await worker.query('BEGIN ISOLATION LEVEL READ COMMITTED');await worker.query("SET LOCAL statement_timeout='10s'");
 const heartbeat=(await worker.query("SELECT crm_graph_candidate.graph_worker_heartbeat_v1('11111111-1111-4111-8111-111111111111',$1,$2) result",['a'.repeat(64),'b'.repeat(64)])).rows[0].result;await worker.query('COMMIT');
 assert.equal(heartbeat.reason,'deployment_unavailable');assert.equal(heartbeat.authorizes_activate,false);assert.equal((await owner.query('SELECT count(*)::int n FROM crm_graph_candidate.graph_worker_lease_v1')).rows[0].n,0);cases.push('worker_session_effective_off');
 const apiRole=(await api.query('SELECT current_user,session_user')).rows[0];assert.deepEqual(apiRole,{current_user:'crm_audience_api',session_user:'crm_audience_api'});
 const status=(await api.query('SELECT crm_graph_candidate.graph_worker_lease_status_v1() result')).rows[0].result;
 assert.equal(status.contract,'journey_graph_worker_lease_status_v1');assert.equal(status.deployment_enabled,false);assert.equal(status.executor_ready,false);assert.equal(status.reason,'deployment_off');
 for(const privateKey of ['instance_id','lease_instance_id','worker_sha256','runtime_sha256','deployment_worker_sha256','deployment_runtime_sha256'])assert.equal(Object.hasOwn(status,privateKey),false,privateKey);
 assert.equal(JSON.stringify(status).includes('11111111-1111-4111-8111-111111111111'),false);cases.push('api_aggregate_no_process_identity');
 for(const [p,sql] of [[api,"SELECT crm_graph_candidate.graph_worker_heartbeat_v1('11111111-1111-4111-8111-111111111111',$1,$2)"],[api,'SELECT crm_graph_candidate.graph_worker_readiness_v1()'],[worker,'SELECT crm_graph_candidate.graph_worker_lease_status_v1()'],[worker,'SELECT crm_graph_candidate.graph_worker_readiness_v1()'],[outsider,'SELECT crm_graph_candidate.graph_worker_lease_status_v1()']]){
  await assert.rejects(p.query(sql,sql.includes('$1')?['a'.repeat(64),'b'.repeat(64)]:undefined),/permission denied/);
 }
 cases.push('cross_role_and_public_scope_denied');

 await rejected(()=>owner.query("GRANT EXECUTE ON FUNCTION crm_graph_candidate.graph_worker_lease_status_v1() TO PUBLIC"),/GRAPH_WORKER_RUNTIME_ACCESS_ACL_DRIFT/);cases.push('public_execute_drift_rejected');
 await rejected(()=>owner.query("ALTER FUNCTION crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text) OWNER TO crm_graph_worker"),/GRAPH_WORKER_RUNTIME_ACCESS_BASE_DRIFT/);cases.push('owner_drift_rejected');
 await rejected(()=>owner.query("CREATE OR REPLACE FUNCTION crm_graph_candidate.graph_worker_lease_status_v1() RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT jsonb_build_object(''contract'',''drift'')'"),/GRAPH_WORKER_RUNTIME_ACCESS_BASE_DRIFT/);cases.push('body_drift_rejected');
 await rejected(()=>owner.query('ALTER ROLE crm_graph_worker LOGIN'),/GRAPH_WORKER_RUNTIME_ACCESS_ROLE/);cases.push('worker_login_rejected');
 await rejected(()=>owner.query('UPDATE crm_graph_candidate.control SET enabled=true'),/GRAPH_WORKER_RUNTIME_ACCESS_NOT_OFF/);cases.push('graph_enabled_rejected');
 await rejected(()=>owner.query('UPDATE crm_graph_candidate.graph_worker_deployment_v1 SET enabled=false,approved_by=\'admin:unexpected\''),/GRAPH_WORKER_RUNTIME_ACCESS_NOT_OFF/);cases.push('nondefault_deployment_rejected');

 console.log(JSON.stringify({success:true,contract:'crm-graph-worker-runtime-access-native-proof-v1',postgres:'17.10',cases,case_count:cases.length,functions:after.map(x=>({name:x.proname,body_md5:x.body_md5,definition_md5:x.definition_md5,owner:x.owner,worker_execute:x.worker_execute,api_execute:x.api_execute,public_execute:x.public_execute})),worker_session:true,api_session:true,status_aggregate:true,process_ids_exposed:false,readiness_owner_only:true,graph_enabled:false,deployment_enabled:false,leases:0,production_changed:false,remote_hosts:0,sends:0}));
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{for(const p of [worker,api,outsider])if(p)await p.end().catch(()=>{});await owner.end().catch(()=>{});});
