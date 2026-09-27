'use strict';
// Same implicit SimpleQuery batch used by db.multi; no SMTP/client data/production endpoint.
const assert=require('node:assert/strict'),path=require('node:path');
const D=require('../tools/maintenance-cart-deploy/deploy.cjs'),{fixtureSQL}=require('./maintenance-cart-fixture.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.MAINTENANCE_TEST_DATABASE_ISOLATED,'1');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/maintenance_cart_install_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Client}=require('pg'),db=new Client({connectionString:u.toString(),statement_timeout:20000,application_name:'synthetic-cart-install'});await db.connect();
 try{assert.equal((await db.query('SHOW server_version_num')).rows[0].server_version_num,'170010');assert.equal((await db.query("SELECT to_regnamespace('crm_maintenance_candidate') n")).rows[0].n,null);await db.query(fixtureSQL);
  const before=(await db.query(D.METADATA_SQL)).rows[0],q=D.atomicInstall(path.join(__dirname,'..'),before,'00000000-0000-4000-8000-000000000000').sql;
  const broken=q.replace('CREATE SEQUENCE crm_maintenance_candidate.cart_turn;','SELECT missing_install_fixture_function();\nCREATE SEQUENCE crm_maintenance_candidate.cart_turn;');assert.notEqual(q,broken);
  await assert.rejects(db.query(broken),/missing_install_fixture_function/);assert.equal((await db.query('SELECT 1 ok')).rows[0].ok,1);assert.equal((await db.query(D.METADATA_SQL)).rows[0].schema,null);
  console.log('PASS implicit SimpleQuery error rolls back all DDL; same pooled connection accepts next query.');
  await db.query(q);const after=(await db.query(D.METADATA_SQL)).rows[0];assert.deepEqual(after.dependencies,before.dependencies);assert.equal(JSON.parse(after.seal).shape,after.shape);const s=(await db.query(D.STATE_SQL)).rows[0];assert.equal(s.control.enabled,false);assert.equal(s.control.mode,'closed');assert.equal(s.event_count,'0');
  await assert.rejects(db.query(q),/SCHEMA_EXISTS/);assert.equal((await db.query('SELECT 2 ok')).rows[0].ok,2);console.log('PASS exact atomic installer commits OFF once; duplicate batch fails without partial work or poisoned session.');
  await db.query('ALTER TABLE crm_maintenance_candidate.cart_attempt ADD COLUMN fixture_drift boolean');assert.notEqual((await db.query(D.METADATA_SQL)).rows[0].shape,after.shape);console.log('PASS structural drift is detected by the committed catalog seal; no transport or runtime activation.');
 }finally{await db.end();}
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
