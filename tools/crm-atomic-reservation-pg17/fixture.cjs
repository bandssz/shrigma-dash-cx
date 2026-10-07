'use strict';
const assert=require('node:assert/strict'),PG=require('../../tests/crm-atomic-reservation/pg17.cjs');
const flags={sourceOnly:true,operational:false,productionInstalled:false,nativePG17Proof:false,nativeNetworkAckProof:false,productionDurabilityProved:false};
const refused=()=>{throw Error('CRM_ATOMIC_PG17_FIXTURE_REFUSED');};
async function metadata(client){const v=await client.query('SHOW server_version_num');if(v?.command!=='SHOW'||v.rowCount!==null||v.rows?.length!==1||typeof v.rows[0].server_version_num!=='string'||!/^17[0-9]{4}$/.test(v.rows[0].server_version_num))refused();const r=await client.query('SELECT current_database() AS database_name, pg_backend_pid() AS backend_pid');if(r?.command!=='SELECT'||r.rowCount!==1||r.rows?.length!==1||r.rows[0].database_name!=='crm_borrowed_source_test'||!Number.isSafeInteger(r.rows[0].backend_pid)||r.rows[0].backend_pid!==client.processID)refused();return {engine:v.rows[0].server_version_num,pid:r.rows[0].backend_pid};}
// Root owns the real pinned pg driver/fixed existing CI service configuration.
// Root supplies its existing makeClient constructor callback; no credentials,
// connection URLs, service/DB factory or dependency installation are defined here.
// Imported/injected surface ALWAYS returns nativePG17Proof:false. The real Root
// CI CLI attests only after driver/source admission and these complete receipts.
async function run({enabled=false,makeClient,D,admitIsolatedCI,runScenario=PG.runScenario,scenarios=PG.SCENARIOS}={}){
 if(enabled!==true||typeof makeClient!=='function'||typeof admitIsolatedCI!=='function'||!D||typeof D.journalDDL!=='string'||typeof D.factsDDL!=='string')return Object.freeze({code:'CRM_ATOMIC_PG17_OFF',executed:false,scenarios:0,created:0,endCalls:0,closed:0,...flags});
 const results=[];let created=0,endCalls=0,closed=0,engine=null;
 try{assert.deepEqual(scenarios,PG.SCENARIOS);for(const scenario of scenarios){const clients=[],idle=new WeakMap();let invalid=false,passed=false,observed=[];try{
  // Private Root CI attestation before creating/connecting any client.
  const admit=await admitIsolatedCI({scenario});assert.deepEqual(admit,{isolated:true,database:'crm_borrowed_source_test',engineMajor:17,sourceOnly:true,production:false});
  for(let n=0;n<2;n++){const c=makeClient();if(clients.includes(c))refused();clients.push(c);created++;c.connection.on('readyForQuery',m=>idle.set(c,m.status));c.on('error',()=>{invalid=true;});}
  const connections=await Promise.allSettled(clients.map(c=>c.connect()));if(connections.some(r=>r.status!=='fulfilled'))refused();observed=await Promise.all(clients.map(metadata));if(observed[0].engine!==observed[1].engine||observed[0].pid===observed[1].pid||invalid||clients.some(c=>idle.get(c)!=='I'))refused();if(engine!==null&&engine!==observed[0].engine)refused();engine=observed[0].engine;
  // Original namespace/tables on the one existing ephemeral CI service only,
  // after BOTH major/database/PIDs. Nothing installed in production.
  await clients[0].query('DROP SCHEMA IF EXISTS dashboard_crm_controls CASCADE');await clients[0].query(D.journalDDL);await clients[0].query(D.factsDDL);if(invalid||clients.some(c=>idle.get(c)!=='I'))refused();
  const r=await runScenario({scenario,clients,D});if(r?.scenario!==scenario||r.passed!==true||r.nativePG17Proof!==false||r.operational!==false||r.nativeNetworkAckProof!==false||invalid||clients.some((c,n)=>c.processID!==observed[n].pid))refused();passed=true;
 }catch{passed=false;}finally{for(const c of clients){endCalls++;try{await c.end();closed++;}catch{passed=false;}}if(invalid)passed=false;}
 results.push(Object.freeze({scenario,passed,pids:observed.map(r=>r.pid),engine:observed[0]?.engine||null,created:clients.length,endCalls:clients.length,...flags}));if(!passed)break;
 }}catch{return Object.freeze({code:'CRM_ATOMIC_PG17_REFUSED',executed:false,engine,scenarios:0,created,endCalls,closed,results,...flags});}
 const executed=results.length===PG.SCENARIOS.length&&results.every(r=>r.passed)&&created===12&&endCalls===12&&closed===12;
 return Object.freeze({code:executed?'CRM_ATOMIC_PG17_SCENARIOS_PASSED':'CRM_ATOMIC_PG17_REFUSED',executed,engine,scenarios:executed?6:0,runtime:process.version,created,endCalls,closed,results,fixtureScope:'Root-borrowed-existing-CI-service',faultHooksSynthetic:true,...flags});
}
module.exports=Object.freeze({ENABLED:false,run});
