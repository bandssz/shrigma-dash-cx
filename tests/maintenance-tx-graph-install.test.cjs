'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const D=require('../tools/maintenance-tx-deploy/deploy.cjs'),F=require('./maintenance-tx-graph-install-fixture.cjs');
test('graph OFF → TX is atomic, chains both seals, preserves both brand CART and rejects repeat',async t=>{await F.composition(await F.setup(t));});
test('graph predecessor validates exact chain, every fingerprint and restricted role before planning',async t=>{
 const x=await F.setup(t),copy=()=>JSON.parse(JSON.stringify(x.before));
 const mutateSeal=(s,key,f)=>{const v=JSON.parse(s[key]);f(v);s[key]=JSON.stringify(v);};
 for(const mutate of [
  s=>delete s.graph_seal,s=>s.graph_shape='a'.repeat(32),s=>s.graph_maintenance_shape='b'.repeat(32),s=>s.graph_public_shape='c'.repeat(32),
  s=>s.graph_worker_role.login=true,
  s=>mutateSeal(s,'seal',v=>v.nonce='40000000-0000-4000-8000-000000000001'),
  s=>mutateSeal(s,'seal',v=>v.ddl='d'.repeat(64)),
  s=>mutateSeal(s,'seal',v=>v.previous.extra=true),
  s=>mutateSeal(s,'graph_seal',v=>v.extra=true),
  s=>mutateSeal(s,'graph_seal',v=>v.previous.ddl='e'.repeat(64)),
  s=>mutateSeal(s,'graph_seal',v=>v.maintenance_extension={contract:D.CONTRACT})
 ]){const s=copy();mutate(s);assert.throws(()=>D.atomicInstall(F.ROOT,s,x.control,F.NONCE),/GRAPH_|OLD_SEAL/);}
 assert.deepEqual(await F.metadata(x.db),x.before);
});
test('fresh graph/public/role/seal drift cannot be silently adopted by the TX DO',async t=>{
 for(const change of [
  'ALTER TABLE crm_graph_candidate.revision ADD COLUMN unexpected boolean',
  'GRANT SELECT(id) ON public.subscribers TO PUBLIC',
  'ALTER ROLE crm_graph_worker LOGIN',
  "COMMENT ON SCHEMA crm_graph_candidate IS '{}'",
  "COMMENT ON SCHEMA crm_maintenance_candidate IS '{}'"
 ]){
  const x=await F.setup(t),m=F.migration(x);await x.db.exec(change);const changed=await F.metadata(x.db),rows=await F.rowSnapshot(x.db);
  await assert.rejects(x.db.exec(m.sql),/TX_DEPLOY_.*DRIFT/);
  assert.deepEqual(await F.metadata(x.db),changed);assert.deepEqual(await F.rowSnapshot(x.db),rows);
  assert.equal((await x.query("SELECT to_regclass('crm_maintenance_candidate.tx_inbox') r")).rows[0].r,null);
 }
});
test('lost TX install response after graph composition reconciles exact paired seals without a second write',async t=>{
 const x=await F.setup(t),p=require('./maintenance-tx-deploy-fixture.cjs').fixture();t.after(()=>fs.rmSync(p.directory,{recursive:true,force:true}));
 // Production prepare intentionally accepts only database listmonk. This injected
 // test adapter maps that logical name to PGlite's disposable database; the exact
 // unmodified SQL batch is exercised by composition() above and PostgreSQL CI.
 p.io.metadata=async()=>({...await F.metadata(x.db),database:'listmonk'});p.io.state=async()=>(await x.query(D.STATE_SQL)).rows[0];
 let writes=0;p.io.sql=async sql=>{writes++;const adapted=sql.replace("current_database()<>'listmonk'","current_database()<>'"+x.before.database.replaceAll("'","''")+"'");assert.notEqual(adapted,sql);await x.db.exec(adapted);throw Error('SYNTHETIC_RESPONSE_LOST');};
 p.guard.retention={seal_sha256:D.sha(D.previousSeal(x.before)),shape:x.before.shape,control_version:2};
 const plan=await p.installer.prepare(p.guard);
 await assert.rejects(p.installer.phase('install',plan.plan_hash),/RESPONSE_LOST/);
 await assert.rejects(p.installer.phase('install',plan.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(writes,1);
 const result=await p.installer.reconcile('install');assert.equal(result.installed,true);assert.equal(result.reconciled_read_only,true);assert.equal(writes,1);
 const now=await F.metadata(x.db);
 for(const change of [s=>delete s.maintenance_extension,s=>s.maintenance_extension.previous_maintenance_shape='f'.repeat(32)]){
  const seal=JSON.parse(now.graph_seal);change(seal);
  await x.query('COMMENT ON SCHEMA crm_graph_candidate IS '+"'"+JSON.stringify(seal).replaceAll("'","''")+"'");
  await assert.rejects(p.installer.phase('create',plan.plan_hash),/GRAPH_EXTENSION_DRIFT/);assert.equal(writes,1);
 }
});
