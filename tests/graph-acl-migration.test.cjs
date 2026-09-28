'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../tools/graph-acl-migration/deploy.cjs'),F=require('./graph-acl-fixture.cjs');
test('one DO preserves every existing identity, grant option, SET ROLE and usage while excluding new unaffiliated roles',async t=>{
 const x=await F.setup(t),before=x.before,m=D.atomicInstall(before,F.NONCE,x.retired);
 assert.ok(before.dependent_roles.some(r=>r.name==='central_leitor'));assert.ok(before.dependent_roles.some(r=>r.name==='fixture_app'));assert.equal(before.dependent_roles.some(r=>r.name==='fixture_set_target'),false);
 const results=await x.db.exec(m.sql);assert.equal(results.length,1);await F.assertPreserved(x,assert,before);
});
test('late failure rolls grants, PUBLIC revoke and receipt schema back on a healthy connection',async t=>{
 const x=await F.setup(t),m=D.atomicInstall(x.before,F.NONCE,x.retired);
 await assert.rejects(x.db.exec(F.breakLate(m.sql)),/missing_acl_preservation_fixture_function/);
 assert.equal((await x.query('SELECT 1 ok')).rows[0].ok,1);assert.deepEqual(await x.metadata(),x.before);
 assert.equal((await x.db.exec(m.sql)).length,1);await assert.rejects(x.db.exec(m.sql),/PREFLIGHT_DRIFT/);
 assert.equal((await x.query('SELECT 2 ok')).rows[0].ok,2);
});
test('fresh inventory, membership and schema ACL drift refuse before grants or receipts',async t=>{
 for(const mutation of [
  'CREATE ROLE fixture_new_login LOGIN',
  'ALTER ROLE central_leitor INHERIT',
  'GRANT fixture_group TO central_leitor WITH INHERIT TRUE,SET FALSE',
  'GRANT USAGE ON SCHEMA public TO fixture_app',
  "COMMENT ON SCHEMA public IS 'changed elsewhere'"
 ]){
  const x=await F.setup(t),m=D.atomicInstall(x.before,F.NONCE,x.retired);await x.db.exec(mutation);const changed=await x.metadata();
  await assert.rejects(x.db.exec(m.sql),/PREFLIGHT_DRIFT/);assert.deepEqual(await x.metadata(),changed);assert.equal(changed.receipt_schema,null);
 }
});
test('zero or excessive server timeout refuses preparation and stale SQL before catalog locks',async t=>{
 const x=await F.setup(t),m=D.atomicInstall(x.before,F.NONCE,x.retired);
 for(const timeout of ['0','31s']){
  await x.db.exec("SET statement_timeout='"+timeout+"'");const before=await x.metadata();assert.throws(()=>D.atomicInstall(before,F.NONCE,x.retired),/STATEMENT_TIMEOUT/);
  await assert.rejects(x.db.exec(m.sql),/STATEMENT_TIMEOUT/);assert.deepEqual(await x.metadata(),before);
 }
});
test('retirement barrier rejects a previously compiled graph installation and a fresh OFF installation remains compatible',async t=>{
 const G=require('../tools/graph-install/deploy.cjs'),GF=require('./journey-graph-install-fixture.cjs');
 const x=await F.setup(t),rows=await GF.rowSnapshot(x.db);
 // Freeze the full graph SQL against the pre-barrier structure. Its newer
 // permission check is also satisfied after this ACL migration; only the old
 // structure fingerprint must now reject it before any installation effects.
 const old=G.atomicInstall(GF.ROOT,{...x.before.graph_state,public_create_schemas:[]},F.NONCE);
 x.retired.sql_hash=D.sha(old.sql);
 await x.db.exec(D.atomicInstall(x.before,F.NONCE,x.retired).sql);
 assert.deepEqual(await GF.rowSnapshot(x.db),rows);
 await assert.rejects(x.db.exec(old.sql),/GRAPH_INSTALL_SCHEMA_DRIFT/);
 assert.equal((await x.metadata()).graph_state.worker_role,null);
 const fresh=(await x.query(G.METADATA_SQL)).rows[0];G.preflight(fresh);
 await x.db.exec(G.atomicInstall(GF.ROOT,fresh,F.NONCE).sql);
 assert.equal((await x.query(G.METADATA_SQL)).rows[0].worker_role.login,false);
 assert.deepEqual(await GF.rowSnapshot(x.db),rows);
 const grant=await x.claim('fish');assert.equal(grant.should_send,true);await x.finish(grant);
});
test('retirement rejects a stale plan reference, an already installed worker, or an active graph',async t=>{
 const x=await F.setup(t);
 assert.throws(()=>D.atomicInstall(x.before,F.NONCE,{...x.retired,graph_shape:'f'.repeat(32)}),/RETIREMENT_REFERENCE/);
 assert.throws(()=>D.atomicInstall(x.before,F.NONCE),/RETIREMENT_REFERENCE/);
 const sql=D.atomicInstall(x.before,F.NONCE,x.retired).sql;
 await x.db.exec('UPDATE crm_graph_candidate.control SET enabled=true WHERE singleton');
 const active=await x.metadata();assert.throws(()=>D.atomicInstall(active,F.NONCE,x.retired),/GRAPH_NOT_OFF/);
 await assert.rejects(x.db.exec(sql),/PREFLIGHT_DRIFT/);assert.deepEqual(await x.metadata(),active);
 await x.db.exec('UPDATE crm_graph_candidate.control SET enabled=false WHERE singleton;CREATE ROLE crm_graph_worker NOLOGIN');
 const installed=await x.metadata();assert.throws(()=>D.atomicInstall(installed,F.NONCE,x.retired),/WORKER_ALREADY_EXISTS/);
 await assert.rejects(x.db.exec(sql),/PREFLIGHT_DRIFT/);assert.deepEqual(await x.metadata(),installed);
});
test('unusual existing role names are quoted safely, while an embedded DO delimiter refuses before compilation',async t=>{
 const x=await F.setup(t);
 await x.db.exec(`CREATE ROLE "existing ' quoted role" NOLOGIN`);
 const before=await x.metadata(),sql=D.atomicInstall(before,F.NONCE,x.retired).sql;
 assert.equal((await x.db.exec(sql)).length,1);
 assert.equal((await x.query("SELECT has_schema_privilege($1,'public','CREATE') value",["existing ' quoted role"])).rows[0].value,true);
 const y=await F.setup(t);await y.db.exec('CREATE ROLE "$acl_preservation$" NOLOGIN');
 const unsafe=await y.metadata();assert.throws(()=>D.atomicInstall(unsafe,F.NONCE,y.retired),/SQL_DELIMITER/);assert.deepEqual(await y.metadata(),unsafe);
});
test('control no-op update refuses triggers or rewrite side effects before writes',async t=>{
 const x=await F.setup(t),sql=D.atomicInstall(x.before,F.NONCE,x.retired).sql;
 await x.db.exec(`CREATE FUNCTION public.fixture_control_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'SHOULD_NOT_RUN';END$$;CREATE TRIGGER fixture_control_trigger BEFORE UPDATE ON crm_graph_candidate.control FOR EACH ROW EXECUTE FUNCTION public.fixture_control_trigger();`);
 const changed=await x.metadata();assert.equal(changed.graph_state.control_update_safe,false);
 assert.throws(()=>D.atomicInstall(changed,F.NONCE,{...x.retired,graph_shape:changed.graph_state.graph_shape}),/CONTROL_UPDATE_UNSAFE/);
 await assert.rejects(x.db.exec(sql),/PREFLIGHT_DRIFT/);assert.deepEqual(await x.metadata(),changed);
});

test('no-op update rejects CHECK functions, expression indexes and extra columns before they can execute',async t=>{
 for(const mutation of [
  `ALTER TABLE crm_graph_candidate.control ADD CONSTRAINT extra_check CHECK(public.fixture_control_side_effect(enabled)) NOT VALID`,
  `CREATE INDEX extra_expression ON crm_graph_candidate.control ((public.fixture_control_side_effect(enabled)))`,
  `ALTER TABLE crm_graph_candidate.control ADD COLUMN extra boolean DEFAULT false`
 ]){
  const x=await F.setup(t),sql=D.atomicInstall(x.before,F.NONCE,x.retired).sql;
  await x.db.exec(`CREATE TABLE public.fixture_side_effect_log(value boolean);CREATE FUNCTION public.fixture_control_side_effect(value boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$BEGIN RETURN true;END$$;`);
  await x.db.exec(mutation);
  // Mark the UDF volatile only after the synthetic expression index is built.
  // The function would now write outside the graph metadata if an UPDATE ran.
  await x.db.exec(`CREATE OR REPLACE FUNCTION public.fixture_control_side_effect(value boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$BEGIN INSERT INTO public.fixture_side_effect_log VALUES(value);RETURN true;END$$;`);
  const changed=await x.metadata();assert.equal(changed.graph_state.control_update_safe,false);
  assert.throws(()=>D.atomicInstall(changed,F.NONCE,{...x.retired,graph_shape:changed.graph_state.graph_shape}),/CONTROL_UPDATE_UNSAFE/);
  await assert.rejects(x.db.exec(sql),/PREFLIGHT_DRIFT/);assert.deepEqual(await x.metadata(),changed);
  assert.equal((await x.query('SELECT count(*)::int n FROM public.fixture_side_effect_log')).rows[0].n,0);
 }
});

test('a frozen REPEATABLE READ or SERIALIZABLE migration snapshot refuses before locks and cannot miss newly committed roles',async t=>{
 const x=await F.setup(t),sql=D.atomicInstall(x.before,F.NONCE,x.retired).sql;
 for(const isolation of ['repeatable read','serializable']){
  await x.db.exec("SET default_transaction_isolation='"+isolation+"'");const changed=await x.metadata();assert.equal(changed.transaction_isolation,isolation);
  assert.throws(()=>D.atomicInstall(changed,F.NONCE,x.retired),/ISOLATION/);await assert.rejects(x.db.exec(sql),/ISOLATION/);assert.deepEqual(await x.metadata(),changed);
 }
});
