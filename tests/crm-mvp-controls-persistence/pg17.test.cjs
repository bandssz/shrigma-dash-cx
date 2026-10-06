'use strict';
// Explicit opt-in REAL PostgreSQL17-compatible engine fixture in isolated RAM.
// No installation, disk data directory, network URL, production session or fallback.
// Run directly: CRM_TEST_PGLITE_MODULE=/already/authorized/local/module node pg17.test.cjs
const assert=require('node:assert/strict'),path=require('node:path');
const B=require('../../services/dashboard-operational/domain/crm-mvp-controls-persistence/store.cjs');
const F=require('./fixtures.cjs'),{C,SQL}=F;
const BIGINT_COLUMNS=new Set(['revision','registered_at','updated_at','reserved_member_count','expected_operation_revision','created_at']);
function engineClient(db){
 const commands=new Map(Object.entries(SQL).filter(([k])=>k!=='SCHEMA_SQL').map(([,sql])=>[sql,sql.split(' ')[0]]));
 const client={calls:[],before:null,after:null,ownedCalls:0};
 client.query=async(sql,params=[])=>{
  assert(commands.has(sql),'fixture client accepts only the actual foundation SQL');client.calls.push(sql);if(client.before)await client.before(sql,params);
  const raw=await db.query(sql,params),command=commands.get(sql);
  // PGlite returns native engine rows/affectedRows, not a node-postgres wire ACK.
  // This normalization is test-only. It does not prove real network COMMIT custody.
  const rows=(raw.rows||[]).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>{
   if(BIGINT_COLUMNS.has(k)&&v!==null){if(typeof v==='number')assert(Number.isSafeInteger(v));v=String(v);}return [k,v];
  })));
  const r={command,rows,rowCount:['SELECT','INSERT','UPDATE'].includes(command)?rows.length:null};
  return client.after?client.after(sql,r):r;
 };
 for(const method of ['connect','end','release'])client[method]=()=>{client.ownedCalls++;throw Error('fixture borrowed client ownership refused');};
 return client;
}
const SEED=`INSERT INTO dashboard_crm_controls.crm_mvp_operations_v1 (${C.COLUMNS.join(',')}) VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6::bigint,$7,$8,$9,$10::bigint,$11::bigint,$12::jsonb,$13,$14::bigint,$15,$16,$17)`;
async function seedHistorical(db,body){const row=C.encode(body);await db.query(SEED,C.COLUMNS.map(k=>k==='scope'?JSON.stringify(row[k]):row[k]));}
async function constraint(db,sql,params){
 await db.query('BEGIN');try{await assert.rejects(db.query(sql,params));}finally{await db.query('ROLLBACK');}
}
async function main(){
 const hint=process.env.CRM_TEST_PGLITE_MODULE;
 if(!hint){console.log(JSON.stringify({code:'PG17_TEST_ENGINE_NOT_LOCATED',executed:false,status:'EXECUCAO_PG17_PENDENTE',runtimeVersion:process.version,operational:false}));process.exitCode=2;return;}
 if(!path.isAbsolute(hint)&&hint!=='@electric-sql/pglite')throw Error('local-test-module-only');
 let loaded;try{loaded=require(hint);}catch{console.log(JSON.stringify({code:'PG17_TEST_ENGINE_UNAVAILABLE',executed:false,status:'EXECUCAO_PG17_PENDENTE',runtimeVersion:process.version,operational:false}));process.exitCode=2;return;}
 assert.equal(typeof loaded.PGlite,'function');const db=new loaded.PGlite();let groups=0;
 try{
  const version=await db.query('SHOW server_version_num'),versionNum=Number(version.rows[0].server_version_num);assert(Number.isSafeInteger(versionNum)&&Math.floor(versionNum/10000)===17,'actual PostgreSQL major17 required');
  await db.exec(SQL.SCHEMA_SQL);groups++;
  const client=engineClient(db),options=F.options(client),store=B.create(options),i=F.identity();
  const first=await store.registerOriginal(F.registration(i));assert.equal(first.state,'registered');assert.equal(first.revision,1);assert.equal(first.reservation,false);const inserts=client.calls.filter(s=>s===SQL.INSERT).length;assert.deepEqual(await store.registerOriginal(F.registration(i)),first);assert.equal(client.calls.filter(s=>s===SQL.INSERT).length,inserts);await assert.rejects(store.registerOriginal({...F.registration(i),principalRefHash:F.E}));groups++;
  const other=F.identity('aristo');await store.registerOriginal({...F.registration(other),principalRefHash:F.E});assert.equal((await store.inspectOperation(i)).principalRefHash,F.H);assert.equal((await store.inspectOperation(other)).principalRefHash,F.E);groups++;
  const fenced=await store.consumeReservationAttempt({...i,expectedOperationRevision:1});assert.equal(fenced.revision,2);assert.equal(fenced.reservationAttempted,true);assert.deepEqual(await store.consumeReservationAttempt({...i,expectedOperationRevision:1}),fenced);await assert.rejects(store.consumeReservationAttempt({...i,expectedOperationRevision:2}));assert.equal((await B.create(options).inspectOperation(i)).revision,2);groups++;
  await constraint(db,'UPDATE dashboard_crm_controls.crm_mvp_operations_v1 SET reservation_attempted=false WHERE brand=$1 AND operation_id=$2::uuid',[i.brand,i.operationId]);
  await constraint(db,'UPDATE dashboard_crm_controls.crm_mvp_operations_v1 SET principal_ref_hash=$3 WHERE brand=$1 AND operation_id=$2::uuid',[i.brand,i.operationId,F.E]);
  await constraint(db,'DELETE FROM dashboard_crm_controls.crm_mvp_operations_v1 WHERE brand=$1 AND operation_id=$2::uuid',[i.brand,i.operationId]);
  const bad=F.registered(F.identity('fish',50)),row=C.encode(bad);row.revision='9007199254740992';await constraint(db,SEED,C.COLUMNS.map(k=>k==='scope'?null:row[k]));groups++;
  const rolled=F.identity('fish',51),rbody=F.registered(rolled),rrow=C.encode(rbody);await db.query('BEGIN');await db.query(SEED,C.COLUMNS.map(k=>k==='scope'?null:rrow[k]));await db.query('ROLLBACK');assert.equal((await store.inspectOperation(rolled)).state,'absent');groups++;
  // These complete reservation rows are visibly SYNTHETIC test SQL seeds only.
  // The product foundation has no import/reserve/seed API and never creates them.
  const historical=F.identity('fish',60),body=F.reserved(historical);await seedHistorical(db,body);
  const accepted=await store.recordOutcome({...historical,outcome:'accepted',expectedOperationRevision:2});assert.equal(accepted.state,'accepted');assert.equal(accepted.revision,3);assert.deepEqual(accepted.scope,body.scope);assert.equal(accepted.scope.expiresAt,2);assert.equal((await B.create(options).inspectOperation(historical)).state,'accepted');assert.deepEqual(await store.recordOutcome({...historical,outcome:'accepted',expectedOperationRevision:2}),accepted);await assert.rejects(store.recordOutcome({...historical,outcome:'unknown',expectedOperationRevision:3}));groups++;
  const interrupted=F.identity('fish',61);await seedHistorical(db,F.reserved(interrupted));const interruptedClient=engineClient(db);let begins=0;interruptedClient.before=async sql=>{if(sql===SQL.BEGIN_WRITE&&++begins===2)throw Object.assign(Error('synthetic fault BETWEEN real engine transactions'),{code:'57014'});};await assert.rejects(B.create(F.options(interruptedClient)).recordOutcome({...interrupted,outcome:'accepted',expectedOperationRevision:2}));const newClient=engineClient(db),recreated=B.create(F.options(newClient)),pending=await recreated.inspectOperation(interrupted);assert.equal(pending.outcomeWriteState,'pending');assert.equal(pending.state,'reserved');await assert.rejects(recreated.recordOutcome({...interrupted,outcome:'accepted',expectedOperationRevision:2}));assert.equal(newClient.calls.includes(SQL.FINISH),false);groups++;
  const after=F.identity('fish',62);await seedHistorical(db,F.reserved(after));const faulty=engineClient(db);let commits=0;faulty.after=async(sql,result)=>sql===SQL.COMMIT&&++commits===2?{}:result;await assert.rejects(B.create(F.options(faulty)).recordOutcome({...after,outcome:'accepted',expectedOperationRevision:2}));const recoveryClient=engineClient(db),recovery=B.create(F.options(recoveryClient));assert.equal((await recovery.inspectOperation(after)).state,'accepted');await recovery.recordOutcome({...after,outcome:'accepted',expectedOperationRevision:2});assert.equal(recoveryClient.calls.includes(SQL.FINISH),false);groups++;
  await constraint(db,'UPDATE dashboard_crm_controls.crm_mvp_outcome_intents_v1 SET phase=$3 WHERE brand=$1 AND operation_id=$2::uuid',[historical.brand,historical.operationId,'pending']);
  await constraint(db,'DELETE FROM dashboard_crm_controls.crm_mvp_outcome_intents_v1 WHERE brand=$1 AND operation_id=$2::uuid',[historical.brand,historical.operationId]);assert.equal(client.ownedCalls,0);groups++;
  console.log(JSON.stringify({executed:true,result:'passed-isolated-real-PG17-SQL-fixture',engineVersionNum:versionNum,groups,runtimeVersion:process.version,sourceOnly:true,operational:false,nativeNetworkAckProof:false,productionDurabilityProved:false,syntheticFaultHooks:true}));
 }finally{await db.close();} // Fixture owns this RAM engine; product never closes a client.
}
main().catch(()=>{console.error(JSON.stringify({executed:true,result:'failed-PG17-fixture',code:'PG17_FIXTURE_REFUSED',runtimeVersion:process.version,operational:false}));process.exitCode=1;});
