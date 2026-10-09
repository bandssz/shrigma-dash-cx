'use strict';
// Isolated PostgreSQL17 grammar fixture. Never production DB, role or grants.
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const modulePath=process.env.CATALOG_PGLITE_MODULE;
test('fixed scheduler catalog and state SQL parse on isolated PostgreSQL17 with unchanged production guards',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),C=require(path.join(process.env.SCHEDULER_STATE_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational'),'native-scheduler-state.cjs')),db=new PGlite();
 try{
  a.equal((await db.query('SELECT current_database() AS name')).rows[0].name,'template1');
  const guard="pg_catalog.current_database()='listmonk'";
  const sql=v=>{a.equal(v.split(guard).length,2);return v.replace(guard,"pg_catalog.current_database()='template1'");};
  a.equal((await db.query(C.CATALOG_SQL)).rows.length,0);
  const missing=(await db.query(sql(C.CATALOG_SQL))).rows;a.equal(missing.length,3);a(missing.every(r=>r.kind===null&&r.readable===false));
  await db.exec([
   'CREATE SCHEMA crm_audience_v2;',
   'CREATE TABLE crm_audience_v2.regular_worker_deployment(singleton boolean PRIMARY KEY,enabled boolean,worker_sha256 text,runtime_sha256 text,query_sha256 text,database_role name,approved_at timestamptz,approved_by text,topology_receipt_sha256 text);',
   'CREATE TABLE crm_audience_v2.regular_worker_lease(singleton boolean PRIMARY KEY,instance_id uuid,worker_sha256 text,runtime_sha256 text,database_role name,heartbeat_at timestamptz,expires_at timestamptz,suspended boolean,suspension_reason text);',
   'CREATE TABLE crm_audience_v2.selection_runtime(singleton boolean PRIMARY KEY,enabled boolean,candidate_query_sha256 text,verified_at timestamptz,unrelated_note text,expires_at timestamptz);',
   "INSERT INTO crm_audience_v2.regular_worker_deployment VALUES(true,true,repeat('a',64),repeat('b',64),'084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d',current_user,now()-interval '1 minute','synthetic-fixture',repeat('c',64));",
   "INSERT INTO crm_audience_v2.regular_worker_lease VALUES(true,'a1111111-1111-4111-8111-111111111111',repeat('a',64),repeat('d',64),current_user,now()-interval '1 second',now()+interval '1 minute',true,'identity_changed');",
   "INSERT INTO crm_audience_v2.selection_runtime VALUES(true,true,'084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d',now(),'unrelated',now());"
  ].join(' '));
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
   const rows=(await db.query(sql(C.CATALOG_SQL))).rows;a.equal(rows.length,3);a(rows.every(r=>r.kind==='r'&&r.readable===true));a.equal(rows.find(r=>r.relation==='selection').columns.length,4);
   a.equal((await db.query(C.READ_SQL)).rows.length,0);
   const state=(await db.query(sql(C.READ_SQL))).rows;a.equal(state.length,1);const v=state[0].payload;
   a.equal(v.deployment.enabled,true);a.equal(v.deployment.approvalPresent,true);a.equal(v.deployment.approvalTiming,'effective');a.equal(v.deployment.queryExpected,true);
   a.equal(v.lease.live,true);a.equal(v.lease.suspended,true);a.equal(v.lease.reason,'identity_changed');a.equal(v.deploymentLeaseMatch.worker,true);a.equal(v.deploymentLeaseMatch.runtime,false);a.equal(v.selection.queryExpected,true);
   a(!JSON.stringify(v).includes('synthetic-fixture'));a(!Object.hasOwn(v.deployment,'approved_by'));a(!JSON.stringify(v).includes('a'.repeat(64)));
  }finally{await db.exec('ROLLBACK');}
 }finally{await db.close();}
});
