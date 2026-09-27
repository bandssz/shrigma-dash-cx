'use strict';
// Same one-DO SimpleQuery sent by the installer; disposable PostgreSQL 17.10 only.
// SQL reservations use synthetic contacts and never call HTTP/SMTP.
const assert=require('node:assert/strict');
const D=require('../tools/graph-install/deploy.cjs'),F=require('./journey-graph-install-fixture.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');
 assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/journey_graph_install_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Client}=require('pg'),client=new Client({connectionString:u.toString(),statement_timeout:20000,application_name:'synthetic-graph-install'});await client.connect();
 const query=client.query.bind(client),db={query,exec:query,close:async()=>{}},pool={connect:async()=>({query,release(){}})};
 const meta=async()=>(await query(D.METADATA_SQL)).rows[0];let createdRole=false;
 try{
  assert.equal((await query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_graph_candidate','crm_maintenance_candidate') AND c.relkind IN('r','p','v')")).rows[0].n,0);
  assert.equal((await query("SELECT count(*)::int n FROM pg_roles WHERE rolname='crm_graph_worker'")).rows[0].n,0);
  const x=await F.installBase({after(){}},{db,pool}),before=await meta(),rows=await F.rowSnapshot(db),m=D.atomicInstall(F.ROOT,before,F.NONCE);
  const marker="EXECUTE format('COMMENT ON SCHEMA crm_graph_candidate IS %L',gs::text);";assert.ok(m.sql.includes(marker));
  const broken=m.sql.replace(marker,'PERFORM missing_graph_install_fixture_function();\n'+marker);
  assert.doesNotMatch(m.sql,/^\s*(?:BEGIN|COMMIT);\s*$/m);
  await assert.rejects(query(broken),/missing_graph_install_fixture_function/);
  assert.equal((await query('SELECT 1 ok')).rows[0].ok,1);assert.deepEqual(await meta(),before);assert.deepEqual(await F.rowSnapshot(db),rows);
  console.log('PASS late error rolls back migrations, legacy patches, role and grants; same connection stays healthy without explicit transaction recovery.');

  await query('ALTER TABLE crm_graph_candidate.revision DISABLE TRIGGER graph_immutable');
  const changed=await meta();await assert.rejects(query(m.sql),/GRAPH_INSTALL_SCHEMA_DRIFT/);assert.deepEqual(await meta(),changed);assert.deepEqual(await F.rowSnapshot(db),rows);
  await query('ALTER TABLE crm_graph_candidate.revision ENABLE TRIGGER graph_immutable');assert.deepEqual(await meta(),before);
  console.log('PASS fresh trigger-state drift blocks before writing any migration or worker role.');

  // Only this disposable synthetic database is modified to reproduce a legacy
  // PUBLIC grant. The installer must report it, never repair shared privileges.
  await query('GRANT CREATE ON SCHEMA public TO PUBLIC');
  const inherited=await meta();assert.deepEqual(inherited.public_create_schemas,['public']);
  assert.throws(()=>D.atomicInstall(F.ROOT,inherited,F.NONCE),/PUBLIC_CREATE_INHERITED/);
  await assert.rejects(query(m.sql),/PUBLIC_CREATE_INHERITED/);
  assert.equal((await query('SELECT 3 ok')).rows[0].ok,3);assert.deepEqual(await meta(),inherited);assert.deepEqual(await F.rowSnapshot(db),rows);assert.equal(inherited.worker_role,null);
  await query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');assert.deepEqual(await meta(),before);
  console.log('PASS inherited PUBLIC CREATE blocks compilation and stale SQL before migrations; shared grant remains untouched by installer and no role exists.');

  const installed=await query(m.sql);createdRole=true;
  assert.equal(Array.isArray(installed),false);assert.equal(installed.command,'DO');
  const after=await meta();assert.deepEqual(await F.rowSnapshot(db),rows);
  const graphSeal=JSON.parse(after.graph_seal),maintenanceSeal=JSON.parse(after.maintenance_seal);
  assert.equal(graphSeal.graph_shape,after.graph_shape);assert.equal(graphSeal.maintenance_shape,after.maintenance_shape);assert.equal(graphSeal.public_shape,after.public_shape);assert.equal(graphSeal.ddl,m.seal.ddl);
  assert.equal(maintenanceSeal.shape,after.maintenance_legacy_shape);assert.equal(maintenanceSeal.contract,D.MAINTENANCE_CONTRACT);assert.deepEqual(maintenanceSeal.previous,JSON.parse(before.maintenance_seal));
  assert.deepEqual((await query(D.OFF_SQL)).rows[0],{cart_off:true,epochs:'0',owners:'0',sources:'0',clones:'0'});
  assert.equal(after.worker_role.login,false);assert.equal(after.worker_role.superuser,false);assert.equal(after.worker_role.memberships,0);
  await assert.rejects(query(m.sql),/GRAPH_INSTALL_/);assert.equal((await query('SELECT 2 ok')).rows[0].ok,2);assert.deepEqual(await meta(),after);
  console.log('PASS compiled installation returns exactly one DO result, seals both schemas once, keeps graph OFF and preserves both brand drafts plus retained CART receipt.');

  await query('SET ROLE crm_graph_worker');
  try{
   const helper=(await query("SELECT * FROM public.shrigma_email_recipient_key('synthetic@example.invalid')")).rows[0];assert.match(helper.recipient_key,/^[a-f0-9]{32}$/);
   await assert.rejects(query('SELECT * FROM public.graph_install_fixture_secret'),/permission denied/);
   await assert.rejects(query('UPDATE crm_graph_candidate.control SET enabled=true'),/permission denied/);
   await assert.rejects(query("UPDATE crm_maintenance_candidate.control SET enabled=false,mode='closed'"),/permission denied/);
  }finally{await query('RESET ROLE');}
  assert.doesNotMatch(JSON.stringify(after),/synthetic-key-only/);
  console.log('PASS NOLOGIN worker may invoke the frozen recipient helper, without reading its secret or enabling/closing either gate.');

  for(const brand of ['fish','aristo']){
   const grant=await x.claim(brand);assert.equal(grant.should_send,true);assert.equal(grant.reason,'claimed');
   const repeat=await x.claim(brand);assert.equal(repeat.should_send,false);assert.equal(repeat.dispatch_id,grant.dispatch_id);assert.equal(repeat.claim_token,null);
   const finished=await x.finish(grant);assert.equal(finished.transport_state,'accepted');assert.equal((await x.finish(grant)).send_log_id,finished.send_log_id);
  }
  assert.equal((await query("SELECT md5(pg_get_functiondef('public.shrigma_email_finish_cart(uuid,uuid,text,jsonb)'::regprocedure)) value")).rows[0].value,'d34ea14526664f660d749017023ef537');
  assert.equal((await query('SELECT count(*)::int n FROM public.shrigma_send_log')).rows[0].n,2);
  assert.equal((await query('SELECT count(*)::int n FROM public.shrigma_email_dispatch')).rows[0].n,2);
  assert.equal((await query('SELECT count(*)::int n FROM crm_graph_candidate.cart_delivery_v1')).rows[0].n,0);
  assert.equal((await query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
  console.log('PASS legacy CART SQL still reserves and finishes once for Fish/Aristo with graph OFF; original finish unchanged, zero HTTP/SMTP.');
 }finally{
  if(createdRole){await query('DROP OWNED BY crm_graph_worker');await query('DROP ROLE crm_graph_worker');}
  await client.end();
 }
}
run().catch(e=>{console.error('FAIL graph installation:',e.code||'',e.message);process.exitCode=1;});
