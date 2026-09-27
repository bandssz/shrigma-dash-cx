'use strict';
// The same implicit SimpleQuery installation batch, against a disposable database only.
const assert=require('node:assert/strict');
const D=require('../tools/maintenance-tx-deploy/deploy.cjs'),F=require('./maintenance-tx-deploy-fixture.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.MAINTENANCE_TEST_DATABASE_ISOLATED,'1');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/maintenance_tx_install_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Client}=require('pg'),db=new Client({connectionString:u.toString(),statement_timeout:20000,application_name:'synthetic-tx-install'});await db.connect();db.exec=q=>db.query(q);
 try{
  assert.equal((await db.query('SHOW server_version_num')).rows[0].server_version_num,'170010');assert.equal((await db.query("SELECT to_regnamespace('crm_maintenance_candidate') n")).rows[0].n,null);
  const {before,control}=await F.installBase(db),rows=await F.rowSnapshot(db),m=D.atomicInstall(F.ROOT,before,control,'11111111-1111-4111-8111-111111111111');
  const broken=m.sql.replace('CREATE TABLE crm_maintenance_candidate.tx_attempt','SELECT missing_tx_install_fixture();\nCREATE TABLE crm_maintenance_candidate.tx_attempt');assert.notEqual(broken,m.sql);await assert.rejects(db.query(broken),/missing_tx_install_fixture/);
  assert.deepEqual((await db.query(D.METADATA_SQL)).rows[0],before);assert.deepEqual(await F.rowSnapshot(db),rows);assert.equal((await db.query("SELECT to_regclass('crm_maintenance_candidate.tx_turn') r")).rows[0].r,null);console.log('PASS failed additive install rolls back DDL/seal, preserving all prior rows and usable session.');
  await db.query(m.sql);const after=(await db.query(D.METADATA_SQL)).rows[0],seal=JSON.parse(after.seal);assert.deepEqual(seal.previous,JSON.parse(before.seal));assert.equal(seal.shape,after.shape);assert.deepEqual(after.dependencies,before.dependencies);assert.deepEqual(await F.rowSnapshot(db),rows);assert.throws(()=>D.previousSeal(after),/OLD_SEAL/);console.log('PASS TX extension commits atomically with chained seal, exact open v2 and prior CART rows/functions.');
  await assert.rejects(db.query(m.sql),/OLD_SEAL_DRIFT/);assert.deepEqual(await F.rowSnapshot(db),rows);assert.equal((await db.query('SELECT 1 ok')).rows[0].ok,1);console.log('PASS duplicate/adoption attempt rejected; no replayed writes or transport.');
  // Temporary schema-only observation must not mutate the retained CART/TX seal.
  const fs=require('node:fs'),path=require('node:path'),O=require('../n8n/growth/maintenance-tx-observation.cjs'),B=require('./maintenance-tx-popup-fixture.cjs');
  await db.query(fs.readFileSync(path.join(F.ROOT,'n8n/growth/maintenance-tx-observation.sql'),'utf8'));
  const sample=O.observe('fish',B.body('fish'));
  assert.equal(sample.verdict,'accepted');
  const peer=new Client({connectionString:u.toString(),statement_timeout:2000,application_name:'synthetic-tx-probe'});await peer.connect();
  try{await Promise.all([db.query('SELECT crm_tx_input_probe.record_v1($1::jsonb)',[JSON.stringify(sample)]),peer.query('SELECT crm_tx_input_probe.record_v1($1::jsonb)',[JSON.stringify(sample)])]);}finally{await peer.end();}
  assert.equal((await db.query('SELECT observations FROM crm_tx_input_probe.outcome')).rows[0].observations,'2');
  await assert.rejects(db.query('SELECT crm_tx_input_probe.record_v1($1::jsonb)',[JSON.stringify({...sample,email:'synthetic@example.invalid'})]),/TX_PROBE_INPUT/);
  assert.deepEqual((await db.query(D.METADATA_SQL)).rows[0],after);assert.deepEqual(await F.rowSnapshot(db),rows);
  console.log('PASS aggregate input probe counts two concurrent observations, rejects raw fields and preserves retention seal/rows.');
 }finally{await db.end();}
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
