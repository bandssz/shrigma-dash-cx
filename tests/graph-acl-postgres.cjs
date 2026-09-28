'use strict';
// Disposable PostgreSQL 17.10. No production endpoint, business contacts or HTTP.
const assert=require('node:assert/strict');
const D=require('../tools/graph-acl-migration/deploy.cjs'),F=require('./graph-acl-fixture.cjs');
const G=require('../tools/graph-install/deploy.cjs'),GF=require('./journey-graph-install-fixture.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');
 assert.equal(process.env.GRAPH_ACL_TEST_DATABASE_ISOLATED,'1');assert.equal(u.protocol,'postgres:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/graph_acl_migration_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Client}=require('pg'),options={connectionString:u.toString(),statement_timeout:20000,application_name:'synthetic-graph-acl'};
 const client=new Client(options),blocker=new Client(options),delayed=new Client(options);await client.connect();await blocker.connect();await delayed.connect();
 const query=client.query.bind(client),db={query,exec:query,close:async()=>{}};
 try{
  assert.equal((await query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_graph_candidate','crm_maintenance_candidate','crm_schema_acl_migration_v1') AND c.relkind IN('r','p','v')")).rows[0].n,0);
  assert.equal((await query("SELECT count(*)::int n FROM pg_roles WHERE rolname IN('central_leitor','crm_graph_worker','fixture_group','fixture_set_target','fixture_app','fixture_new_worker')")).rows[0].n,0);
  const x=await F.setup({after(){}},{db}),before=x.before,rows=await GF.rowSnapshot(db);
  const old=G.atomicInstall(GF.ROOT,{...before.graph_state,public_create_schemas:[]},F.NONCE);
  // PR147 had no PUBLIC-CREATE precondition; retain its row/shape guards to
  // exercise the uncertain older payload even from a frozen old snapshot.
  old.sql=old.sql.split('\n').filter(line=>!line.includes("RAISE EXCEPTION 'GRAPH_INSTALL_PUBLIC_CREATE_INHERITED'")).join('\n');
  x.retired.sql_hash=D.sha(old.sql);
  const migration=D.atomicInstall(before,F.NONCE,x.retired);
  assert.doesNotMatch(migration.sql,/^\s*(?:BEGIN|COMMIT|SET LOCAL)\b/m);
  await assert.rejects(query(F.breakLate(migration.sql)),/missing_acl_preservation_fixture_function/);
  assert.equal((await query('SELECT 1 ok')).rows[0].ok,1);assert.deepEqual(await x.metadata(),before);assert.deepEqual(await GF.rowSnapshot(db),rows);
  console.log('PASS late failure rolls back the retirement barrier, grants, revoke and receipt; the same connection remains healthy.');

  // Explicit transactions below belong exclusively to a separate disposable
  // blocker connection. The production payload remains exactly one DO.
  for(const lock of ["SELECT pg_advisory_xact_lock(hashtextextended('crm-graph-install',0))",'LOCK TABLE pg_catalog.pg_namespace IN ROW EXCLUSIVE MODE']){
   await blocker.query('BEGIN');try{
    await blocker.query(lock);const start=Date.now();await assert.rejects(query(migration.sql),/GRAPH_ACL_BUSY|lock timeout/);assert.ok(Date.now()-start<10000);
    assert.equal((await query('SELECT value FROM public.fixture_existing')).rows[0].value,'preserved');assert.deepEqual(await x.metadata(),before);
   }finally{await blocker.query('ROLLBACK');}
  }
  console.log('PASS concurrent old installation or administrative catalog lock refuses without effects; ordinary data reads stay available.');

  await query('GRANT fixture_group TO central_leitor WITH INHERIT TRUE,SET FALSE');
  const changed=await x.metadata();await assert.rejects(query(migration.sql),/PREFLIGHT_DRIFT/);assert.deepEqual(await x.metadata(),changed);
  await query('REVOKE fixture_group FROM central_leitor');assert.deepEqual(await x.metadata(),before);
  for(const timeout of [0,30001]){await query('SET statement_timeout='+timeout);const changed=await x.metadata();assert.throws(()=>D.atomicInstall(changed,F.NONCE,x.retired),/STATEMENT_TIMEOUT/);await assert.rejects(query(migration.sql),/STATEMENT_TIMEOUT/);assert.deepEqual(await x.metadata(),changed);}
  await query('SET statement_timeout=20000');assert.deepEqual(await x.metadata(),before);
  for(const isolation of ['repeatable read','serializable']){await query("SET default_transaction_isolation='"+isolation+"'");const frozen=await x.metadata();assert.throws(()=>D.atomicInstall(frozen,F.NONCE,x.retired),/ISOLATION/);await assert.rejects(query(migration.sql),/ISOLATION/);assert.deepEqual(await x.metadata(),frozen);}
  await query("SET default_transaction_isolation='read committed'");assert.deepEqual(await x.metadata(),before);
  console.log('PASS membership drift, unsafe isolation and an unbounded or excessive server timeout refuse before migration.');

  await delayed.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await delayed.query('SELECT pg_current_snapshot()');
  const result=await query(migration.sql);assert.equal(Array.isArray(result),false);assert.equal(result.command,'DO');
  const after=await x.metadata();assert.notEqual(after.graph_state.control_xmin,before.graph_state.control_xmin);
  try{await assert.rejects(delayed.query(old.sql),error=>error.code==='40001'&&/concurrent update/.test(error.message));}finally{await delayed.query('ROLLBACK');}
  assert.equal((await delayed.query('SELECT 1 ok')).rows[0].ok,1);
  console.log('PASS an older REPEATABLE READ snapshot cannot replay the retired installation: the unchanged control values have a new row version and FOR SHARE fails with 40001.');
  assert.deepEqual(await GF.rowSnapshot(db),rows);await F.assertPreserved(x,assert,before);
  await assert.rejects(query(migration.sql),/PREFLIGHT_DRIFT/);assert.equal((await query('SELECT 2 ok')).rows[0].ok,2);
  console.log('PASS exactly one DO preserves every existing identity, grant option, schema usage, data and graph state; a future unaffiliated role cannot CREATE.');

  // Prove the existing SET ROLE dependency from a real non-superuser login,
  // rather than relying on the synthetic administrative session's SET ROLE.
  const appURL=new URL(u);appURL.username='fixture_app';const app=new Client({...options,connectionString:appURL.toString()});await app.connect();
  try{
   assert.equal((await app.query('SELECT session_user')).rows[0].session_user,'fixture_app');
   await app.query('SET ROLE fixture_set_target');
   assert.equal((await app.query("SELECT has_schema_privilege(current_user,'public','CREATE WITH GRANT OPTION') value")).rows[0].value,true);
   await app.query('CREATE TABLE public.fixture_actual_login_ddl(id integer)');
  }finally{await app.end();}
  console.log('PASS an existing non-superuser login retains its SET ROLE target and inherited CREATE WITH GRANT OPTION.');

  await assert.rejects(query(old.sql),/GRAPH_INSTALL_SCHEMA_DRIFT/);
  const fresh=(await query(G.METADATA_SQL)).rows[0];G.preflight(fresh);await query(G.atomicInstall(GF.ROOT,fresh,F.NONCE).sql);
  assert.equal((await query(G.METADATA_SQL)).rows[0].worker_role.login,false);assert.deepEqual(await GF.rowSnapshot(db),rows);
  for(const brand of ['fish','aristo']){const grant=await x.claim(brand);assert.equal(grant.should_send,true);const duplicate=await x.claim(brand);assert.equal(duplicate.should_send,false);await x.finish(grant);}
  console.log('PASS an old compiled graph shape is retired; a new composed installation remains OFF and legacy Fish/Aristo CART still claims once.');
 }finally{await delayed.end();await blocker.end();await client.end();}
}
run().catch(e=>{console.error('FAIL graph ACL preservation:',e.code||'',e.message);process.exitCode=1;});
