/* PostgreSQL 17.10 full-stack proof. Synthetic only; no HTTP or transport. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const Cart=require('./journey-graph-cart-fixture.cjs');

const root=path.join(__dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const hash=body=>createHash('sha256').update(body).digest('hex');

async function main(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');
 const fixedCI=process.env.CI==='true'&&process.env.GRAPH_CACHE_INTEGRATED_CI_FIXED_PORT==='1';
 const expectedRole=process.env.GRAPH_CACHE_EXPECTED_ROLE||'postgres';
 assert.equal(expectedRole,fixedCI?'synthetic':'postgres');
 assert.equal(process.env.GRAPH_CACHE_INTEGRATED_TEST_ISOLATED,'1');
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'127.0.0.1');
 assert.equal(u.pathname,'/journey_graph_cache_integrated_test');assert.equal(u.username,expectedRole);
 assert.equal(u.password,'');assert.ok(u.port&&Number(u.port)>=1024&&Number(u.port)<=65535);if(fixedCI)assert.equal(u.port,'5432');else assert.notEqual(u.port,'5432');assert.equal(u.search,'');assert.equal(u.hash,'');
 const pool=new Pool({connectionString:u.href,max:8,statement_timeout:20000,connectionTimeoutMillis:3000,application_name:'graph-cache-integrated-proof'});
 const db={exec:q=>pool.query(q),query:(q,a)=>pool.query(q,a),close:async()=>{}};
 const proof={schema:'journey-graph-cache-integrated-postgres-proof-v1',postgres:'17.10',success:false,
  full_stack_real_sql:false,installed_off:false,actual_native_clone:false,actual_cart_claim:false,
  cache_heartbeat:false,consume_once:false,replay_blocked:false,acl:false,lifecycle_preserved:false,
  sends:0,http_calls:0,smtp_calls:0,production_changed:false};
 let createdRoles=false;
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_graph_candidate') AND c.relkind IN('r','p','v')")).rows[0].n,0);
  const x=await Cart.install({after(){}},db,pool,{cacheIdentity:false});
  // The portable cart fixture supplies only digest(). Replace that compatibility
  // helper with PostgreSQL's real pgcrypto extension before the integrated proof.
  await pool.query('DROP FUNCTION public.digest(bytea,text);DROP FUNCTION public.hmac(bytea,bytea,text);CREATE EXTENSION pgcrypto WITH SCHEMA public');
  assert.equal((await pool.query("SELECT md5(pg_get_functiondef('crm_graph_candidate.cart_immutable_v1()'::regprocedure)) h")).rows[0].h,'a03dc95d1acff46c78638c3f96f585bc');
  await pool.query(read('tests/fixtures/journey-graph-auth.sql'));
  await pool.query(read('n8n/access/panel-operator.sql'));
  assert.deepEqual((await pool.query("SELECT to_regclass('public.crm_dash_chave')::text keys,to_regclass('public.shrigma_panel_permission_v1')::text permissions")).rows[0],{keys:'crm_dash_chave',permissions:'shrigma_panel_permission_v1'});
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('crm_audience_api','crm_graph_worker')")).rows[0].n,0);
  await pool.query("CREATE ROLE crm_audience_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;CREATE ROLE crm_graph_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");createdRoles=true;
  const stack=[
   'n8n/growth/journey-graph-lifecycle-prepare.sql',
   'n8n/growth/journey-graph-lifecycle-publication.sql',
   'n8n/growth/journey-graph-lifecycle-runtime-access.sql',
   'n8n/growth/journey-graph-worker-lease.sql',
   'n8n/growth/journey-graph-activation-readiness.sql',
   'n8n/growth/journey-graph-cache-identity.sql',
  ];
  for(const relative of stack)await pool.query(read(relative));
  proof.full_stack_real_sql=true;
  const initial=(await pool.query(`SELECT
   (SELECT enabled FROM crm_graph_candidate.control WHERE singleton) graph_enabled,
   (SELECT bool_and(NOT enabled AND cache_target IS NULL) FROM crm_graph_candidate.cart_control_v1) cart_off,
   (SELECT enabled FROM crm_graph_candidate.graph_worker_deployment_v1 WHERE singleton) worker_enabled,
   (SELECT count(*)::int FROM crm_graph_candidate.cache_identity_deployment_v1) cache_deployments,
   (SELECT count(*)::int FROM crm_graph_candidate.lifecycle_publication_v1) publications,
   (SELECT count(*)::int FROM crm_graph_candidate.cart_delivery_v1) deliveries`)).rows[0];
  assert.deepEqual(initial,{graph_enabled:false,cart_off:true,worker_enabled:false,cache_deployments:0,publications:0,deliveries:0});
  proof.installed_off=true;
  const acl=(await pool.query(`SELECT
   has_function_privilege('crm_graph_worker','crm_graph_candidate.cache_identity_issue_v1(text,uuid,uuid,text)','EXECUTE') worker_issue,
   has_function_privilege('crm_graph_worker','crm_graph_candidate.cache_identity_consume_v1(jsonb)','EXECUTE') worker_consume,
   has_function_privilege('crm_audience_api','crm_graph_candidate.cache_identity_readiness_v1(text)','EXECUTE') api_readiness,
   has_function_privilege('crm_audience_api','crm_graph_candidate.lifecycle_activation_readiness_v1(uuid,text,integer,integer,text)','EXECUTE') api_activation`)).rows[0];
  assert.deepEqual(acl,{worker_issue:true,worker_consume:false,api_readiness:true,api_activation:true});proof.acl=true;

  const f=await x.prepare('fish');
  const native=(await pool.query('SELECT id,cache_target,state,clone_template_id,native_sha256,snapshot FROM crm_graph_candidate.native_template_v1 WHERE id=$1',[f.preparedClone.native_id])).rows[0];
  assert.equal(native.state,'ready');assert.equal(native.cache_target,x.cacheTarget);assert.ok(Number.isInteger(native.clone_template_id));
  proof.actual_native_clone=true;
  const executable=hash('synthetic-executable'),runtime=hash('synthetic-runtime');
  await pool.query(`INSERT INTO crm_graph_candidate.cache_identity_deployment_v1
   (cache_target,enabled,executable_sha256,runtime_sha256,expected_role,heartbeat_seconds,lease_seconds,action_key)
   VALUES($1,true,$2,$3,$4,5,15,$5)`,[x.cacheTarget,executable,runtime,expectedRole,randomUUID()]);
  const template=(await pool.query('SELECT id,type::text,subject,body,body_source FROM public.templates WHERE id=$1',[native.clone_template_id])).rows[0];
  const snapshot=[{template_id:template.id,type:template.type,subject:template.subject,body:template.body,body_source:template.body_source}];
  const instance=randomUUID(),token=randomUUID();
  const heartbeat=(await pool.query('SELECT crm_graph_candidate.cache_identity_heartbeat_v1($1,$2,$3,$4,$5,$6::jsonb) r',
   [x.cacheTarget,instance,token,executable,runtime,JSON.stringify(snapshot)])).rows[0].r;
  assert.equal(heartbeat.ready,true);assert.equal(heartbeat.template_count,1);
  assert.equal((await pool.query('SELECT crm_graph_candidate.cache_identity_readiness_v1($1) r',[x.cacheTarget])).rows[0].r.ready,true);
  proof.cache_heartbeat=true;

  const preflight=await f.proof();
  const grant=(await pool.query('SELECT crm_graph_candidate.cart_claim_v1($1,$2,$3,$4,$5) r',
   [f.request.brand,f.request.intent_id,f.request.expected_entry_version,JSON.stringify(preflight),x.cacheTarget])).rows[0].r;
  assert.equal(grant.should_send,true);assert.equal(grant.reason,'claimed');
  const delivery=(await pool.query('SELECT intent_id,dispatch_id,cache_action_consumed_at FROM crm_graph_candidate.cart_delivery_v1 WHERE intent_id=$1',[f.intent.intent_id])).rows[0];
  assert.equal(delivery.dispatch_id,grant.dispatch_id);assert.equal(delivery.cache_action_consumed_at,null);proof.actual_cart_claim=true;
  const guard=(await pool.query("SELECT crm_graph_candidate.cache_identity_issue_v1('fish',$1,$2,$3) r",[f.intent.intent_id,grant.dispatch_id,x.cacheTarget])).rows[0].r;
  assert.equal(guard.contract,'journey_graph_cache_guard_v1');assert.equal(guard.template_id,native.clone_template_id);
  assert.equal((await pool.query('SELECT crm_graph_candidate.cache_identity_consume_v1($1::jsonb) ok',[JSON.stringify(guard)])).rows[0].ok,true);proof.consume_once=true;
  assert.equal((await pool.query('SELECT crm_graph_candidate.cache_identity_consume_v1($1::jsonb) ok',[JSON.stringify(guard)])).rows[0].ok,false);proof.replay_blocked=true;
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.shrigma_send_log')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.lifecycle_publication_v1')).rows[0].n,0);proof.lifecycle_preserved=true;
  proof.sends=0;proof.success=true;
  proof.hashes=Object.fromEntries(stack.map(relative=>[relative,hash(read(relative))]));
  proof.hashes.cart_sql=hash(read('n8n/growth/journey-graph-cart.sql'));
  proof.hashes.native_sql=hash(read('n8n/growth/journey-graph-native.sql'));
  proof.hashes.test=hash(fs.readFileSync(__filename));
  console.log(JSON.stringify(proof));
 }finally{try{if(createdRoles)await pool.query('DROP OWNED BY crm_audience_api,crm_graph_worker;DROP ROLE crm_audience_api;DROP ROLE crm_graph_worker');}finally{await pool.end();}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
