'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../tools/graph-install/deploy.cjs');
const F=require('./journey-graph-install-fixture.cjs');
const metadataSQL=()=>D.METADATA_SQL||D.metadataSQL();
const meta=async db=>(await db.query(metadataSQL())).rows[0];
const migrate=before=>D.atomicInstall(F.ROOT,before,F.NONCE);
function failMidway(sql){const marker="EXECUTE format('COMMENT ON SCHEMA crm_graph_candidate IS %L',gs::text);";assert.ok(sql.includes(marker));return sql.replace(marker,'PERFORM missing_graph_install_fixture_function();\n'+marker);}
const count=async(db,sql)=>(await db.query(sql)).rows[0].n;

test('synthetic base matches deployed draft/CART prerequisites without exposing recipient secret',async t=>{
 const x=await F.installBase(t),before=await meta(x.db);
 assert.equal(await count(x.db,"SELECT count(*)::int n FROM pg_class WHERE relnamespace='crm_graph_candidate'::regnamespace AND relkind='r'"),7);
 assert.deepEqual((await x.query('SELECT enabled FROM crm_graph_candidate.control')).rows,[{enabled:false}]);
 const maintenance=(await x.query('SELECT * FROM crm_maintenance_candidate.control')).rows[0];assert.equal(maintenance.version,2);assert.equal(maintenance.enabled,true);assert.equal(maintenance.mode,'open');
 assert.equal(JSON.parse(before.maintenance_seal).contract,'maintenance-cart-install-v1');assert.equal(JSON.parse(before.maintenance_seal).shape,before.maintenance_legacy_shape);
 assert.equal(before.worker_role,null);assert.doesNotMatch(JSON.stringify(before),/synthetic-key-only/);
 assert.equal((await F.rowSnapshot(x.db)).journeys.length,2);
});

test('compiled installation executes one top-level DO, stays OFF and preserves drafts/retained rows',async t=>{
 const x=await F.installBase(t),before=await meta(x.db),rows=await F.rowSnapshot(x.db),m=migrate(before);
 assert.doesNotMatch(m.sql,/^\s*(?:BEGIN|COMMIT);\s*$/m);
 // PGlite returns one result per top-level command. A SET prefix or SELECT
 // suffix would produce a second result even when the installation succeeds.
 const results=await x.db.exec(m.sql);assert.equal(results.length,1);assert.deepEqual(results[0].rows,[]);
 const after=await meta(x.db);
 assert.deepEqual(await F.rowSnapshot(x.db),rows);
 assert.deepEqual((await x.query('SELECT enabled,cache_target FROM crm_graph_candidate.cart_control_v1 ORDER BY brand')).rows,[{enabled:false,cache_target:null},{enabled:false,cache_target:null}]);
 assert.equal(after.worker_role.name,'crm_graph_worker');
 const role=(await x.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='crm_graph_worker'")).rows[0];
 assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
 assert.deepEqual(JSON.parse(after.graph_seal),{...m.seal,graph_shape:after.graph_shape,maintenance_shape:after.maintenance_shape,public_shape:after.public_shape,worker_role:after.worker_role});
 assert.deepEqual(JSON.parse(after.maintenance_seal),{...m.maintenanceSeal,shape:after.maintenance_legacy_shape});
 assert.notEqual(after.graph_shape,before.graph_shape);assert.notEqual(after.maintenance_shape,before.maintenance_shape);
 await assert.rejects(x.db.exec(m.sql),/GRAPH_INSTALL_/);
 assert.equal((await x.query('SELECT 1 ok')).rows[0].ok,1);assert.deepEqual(await meta(x.db),after);assert.deepEqual(await F.rowSnapshot(x.db),rows);
});

test('injected middle failure rolls every schema/function/grant back and keeps same connection healthy',async t=>{
 const x=await F.installBase(t),before=await meta(x.db),rows=await F.rowSnapshot(x.db),m=migrate(before);
 await assert.rejects(x.db.exec(failMidway(m.sql)),/missing_graph_install_fixture_function/);
 assert.equal((await x.query('SELECT 2 ok')).rows[0].ok,2);
 assert.deepEqual(await meta(x.db),before);assert.deepEqual(await F.rowSnapshot(x.db),rows);
 assert.equal((await x.query("SELECT to_regclass('crm_graph_candidate.source_event_v1') value")).rows[0].value,null);
 const results=await x.db.exec(m.sql);assert.equal(results.length,1);assert.equal((await meta(x.db)).worker_role.name,'crm_graph_worker');
});

test('catalog exposes inherited PUBLIC CREATE and stale compiled SQL refuses it without changing shared grants',async t=>{
 const x=await F.installBase(t),before=await meta(x.db),m=migrate(before);
 assert.deepEqual(before.public_create_schemas,[]);
 await x.db.exec('CREATE SCHEMA fixture_shared;GRANT CREATE ON SCHEMA public,fixture_shared TO PUBLIC');
 const changed=await meta(x.db),rows=await F.rowSnapshot(x.db);
 assert.deepEqual(changed.public_create_schemas,['fixture_shared','public']);
 assert.throws(()=>migrate(changed),/PUBLIC_CREATE_INHERITED/);
 await assert.rejects(x.db.exec(m.sql),/PUBLIC_CREATE_INHERITED/);
 assert.equal((await x.query('SELECT 4 ok')).rows[0].ok,4);
 assert.deepEqual(await meta(x.db),changed);assert.deepEqual(await F.rowSnapshot(x.db),rows);
 assert.equal((await x.query("SELECT to_regclass('crm_graph_candidate.source_event_v1') value")).rows[0].value,null);
 assert.equal((await meta(x.db)).worker_role,null);
});

test('fresh pre-write guards reject legacy-body, structure and gate drift before installation',async t=>{
 for(const mutation of [
  "ALTER FUNCTION public.shrigma_email_claim_cart(jsonb) SET statement_timeout='2s'",
  'ALTER TABLE crm_graph_candidate.journey ADD COLUMN unexpected text',
  'GRANT SELECT(id) ON public.subscribers TO PUBLIC',
  'ALTER TABLE crm_graph_candidate.revision DISABLE TRIGGER graph_immutable',
  "COMMENT ON SCHEMA crm_maintenance_candidate IS 'changed seal'",
  "UPDATE crm_maintenance_candidate.control SET mode='closed',enabled=false,version=version+1"
 ]){
  const x=await F.installBase(t),before=await meta(x.db),m=migrate(before);await x.db.exec(mutation);
  const changed=await meta(x.db),rows=await F.rowSnapshot(x.db);
  await assert.rejects(x.db.exec(m.sql),/GRAPH_INSTALL_/);
  assert.equal((await x.query('SELECT 3 ok')).rows[0].ok,3);assert.deepEqual(await meta(x.db),changed);assert.deepEqual(await F.rowSnapshot(x.db),rows);
  assert.equal((await x.query("SELECT to_regclass('crm_graph_candidate.source_event_v1') value")).rows[0].value,null);
 }
});

test('graph OFF preserves native CART eligibility, one reservation and original finish in both brands',async t=>{
 const x=await F.installBase(t),before=await meta(x.db);await x.db.exec(migrate(before).sql);
 const finish=(await x.query("SELECT md5(pg_get_functiondef('public.shrigma_email_finish_cart(uuid,uuid,text,jsonb)'::regprocedure)) value")).rows[0].value;assert.equal(finish,'d34ea14526664f660d749017023ef537');
 for(const brand of ['fish','aristo']){
  const grant=await x.claim(brand);assert.equal(grant.should_send,true);assert.equal(grant.reason,'claimed');
  const repeat=await x.claim(brand);assert.equal(repeat.should_send,false);assert.equal(repeat.dispatch_id,grant.dispatch_id);assert.equal(repeat.claim_token,null);
  const complete=await x.finish(grant);assert.equal(complete.transport_state,'accepted');assert.ok(complete.send_log_id>0);assert.equal((await x.finish(grant)).send_log_id,complete.send_log_id);
 }
 assert.equal(await count(x.db,'SELECT count(*)::int n FROM public.shrigma_email_dispatch'),2);
 assert.equal(await count(x.db,'SELECT count(*)::int n FROM public.shrigma_send_log'),2);
 assert.equal(await count(x.db,'SELECT count(*)::int n FROM crm_graph_candidate.cart_delivery_v1'),0);
 assert.equal((await x.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
});

test('worker can invoke recipient helper but cannot read its secret or enable either gate',async t=>{
 const x=await F.installBase(t);await x.db.exec(migrate(await meta(x.db)).sql);
 await x.db.exec('SET ROLE crm_graph_worker');
 try{
  const key=(await x.query("SELECT * FROM public.shrigma_email_recipient_key('synthetic@example.invalid')")).rows[0];assert.match(key.recipient_key,/^[a-f0-9]{32}$/);assert.equal(key.key_version,'fixture');
  await assert.rejects(x.query('SELECT * FROM public.graph_install_fixture_secret'),/permission denied/);
  await assert.rejects(x.query('UPDATE crm_graph_candidate.control SET enabled=true'),/permission denied/);
  await assert.rejects(x.query("UPDATE crm_maintenance_candidate.control SET enabled=false,mode='closed'"),/permission denied/);
 }finally{await x.db.exec('RESET ROLE');}
 assert.equal((await x.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
 assert.equal((await x.query('SELECT enabled FROM crm_maintenance_candidate.control')).rows[0].enabled,true);
});

module.exports={metadataSQL,meta,migrate,failMidway};
