'use strict';
const fs=require('node:fs'),path=require('node:path'),P=require('./prepare.cjs');
const flags={sourceOnly:true,operational:false,productionAdmitted:false,productionDurabilityProved:false,nativeNetworkAckProof:false};
const refuse=()=>{throw Error('FACTS_CI_FIXTURE_REFUSED');};
async function metadata(c){const show=await c.query('SHOW server_version_num');if(show?.command!=='SHOW'||show.rowCount!==null||show.rows?.length!==1||!/^17[0-9]{4}$/.test(show.rows[0].server_version_num))refuse();const r=await c.query('SELECT current_database() AS database_name, pg_backend_pid() AS backend_pid');if(r?.command!=='SELECT'||r.rowCount!==1||r.rows?.length!==1||r.rows[0].database_name!=='crm_borrowed_source_test'||!Number.isSafeInteger(r.rows[0].backend_pid)||r.rows[0].backend_pid!==c.processID)refuse();return {engine:show.rows[0].server_version_num,pid:r.rows[0].backend_pid};}
// Injectable orchestration is exclusively a focal lifecycle test surface. It never
// emits native proof. CLI uses only its verified real pg Client path below.
async function runOwned({makeClient,originalSchema,factsSchema,runFacts}){const clients=[],idle=new WeakMap(),busy=new WeakSet();let errored=false,ready=false,result=null,engine=null,endCalls=0,closed=0;try{
 for(let n=0;n<2;n++){const c=makeClient();clients.push(c);c.connection.on('readyForQuery',m=>idle.set(c,m.status));c.on('error',()=>{errored=true;ready=false;});}
 const connects=await Promise.allSettled(clients.map(c=>c.connect()));if(connects.some(r=>r.status!=='fulfilled'))refuse();
 const original=await Promise.all(clients.map(metadata));if(original[0].engine!==original[1].engine||original[0].pid===original[1].pid)refuse();engine=original[0].engine;
 // Only on the fixed admitted temporary service, after BOTH observed majors/PIDs.
 await clients[0].query('DROP SCHEMA IF EXISTS dashboard_crm_controls CASCADE');await clients[0].query(originalSchema);await clients[0].query(factsSchema);
 if(errored||clients.some(c=>idle.get(c)!=='I'))refuse();ready=true;
 const withDomainSessions=clients.map(c=>async work=>{if(!ready||errored||busy.has(c)||idle.get(c)!=='I'||typeof work!=='function')refuse();busy.add(c);try{return await work();}finally{busy.delete(c);}});
 const admitIsolatedClients=async pair=>{if(!ready||errored||pair.length!==2||pair.some((c,n)=>c!==clients[n]||busy.has(c)||idle.get(c)!=='I'))refuse();const current=await Promise.all(clients.map(metadata));if(current.some((m,n)=>m.engine!==original[n].engine||m.pid!==original[n].pid)||clients.some(c=>idle.get(c)!=='I'))refuse();return {isolated:true,existingNamespace:'dashboard_crm_controls',dedicatedClients:true,factsSchemaInstalled:true,production:false};};
 result=await runFacts({enabled:true,clients,admitIsolatedClients,withDomainSessions});if(errored||result?.executed!==true||result.engine!==engine||result.scenarios!==4||result.operational!==false||result.productionAdmitted!==false)refuse();
 }catch{result={code:'FACTS_CI_FIXTURE_REFUSED',executed:false};}
 finally{ready=false;for(const c of clients){endCalls++;try{await c.end();closed++;}catch{result={code:'FACTS_CI_CLEANUP_REFUSED',executed:false};}}}
 return Object.freeze({...result,nativeFactsProof:false,engine,cleanup:Object.freeze({created:clients.length,endCalls,closed}),fixtureScope:'injected-test-only',...flags});}
async function execute(){let prepared;try{
 if(process.env.CONTROL_FACTS_PG17_CI!=='1'||process.env.GITHUB_ACTIONS!=='true'||process.version!=='v22.23.3')refuse();
 const runnerTemp=process.env.RUNNER_TEMP,modulePath=process.env.BORROWED_PG_MODULE;P.physical(runnerTemp);P.physical(modulePath);if(!modulePath.startsWith(runnerTemp+path.sep)||!modulePath.endsWith('/node_modules/pg'))refuse();P.physical(path.join(modulePath,'package.json'),true);if(JSON.parse(fs.readFileSync(path.join(modulePath,'package.json'),'utf8')).version!=='8.13.1')refuse();const pg=require(modulePath);if(typeof pg.Client!=='function')refuse();
 prepared=P.prepare({repositoryRoot:process.cwd(),runnerTemp});P.verifyPrepared(prepared);
 const originalSchema=fs.readFileSync(prepared.originalSchema,'utf8'),factsSchema=fs.readFileSync(path.join(prepared.source,'services/dashboard-operational/domain/crm-mvp-controls-persistence/facts/schema-v1.sql'),'utf8');
 const before=process.env.CONTROL_FACTS_PUBLIC_CONTEXT;process.env.CONTROL_FACTS_PUBLIC_CONTEXT=prepared.context;let result;try{
 const runner=require(path.join(prepared.source,'tests/crm-mvp-controls-persistence/facts/pg17.cjs'));
 result=await runOwned({makeClient:()=>new pg.Client({host:'127.0.0.1',port:5432,user:'crm_test',password:'crm_test_only',database:'crm_borrowed_source_test',connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000}),originalSchema,factsSchema,runFacts:runner.run});
 }finally{if(before===undefined)delete process.env.CONTROL_FACTS_PUBLIC_CONTEXT;else process.env.CONTROL_FACTS_PUBLIC_CONTEXT=before;}
 P.verifyPrepared(prepared);return Object.freeze({...result,fixtureScope:'Root-isolated-raw-PG17',nativeFactsProof:result.executed===true&&result.cleanup.created===2&&result.cleanup.closed===2});
 }catch{return Object.freeze({code:'FACTS_CI_FIXTURE_REFUSED',executed:false,nativeFactsProof:false,...flags});}}
module.exports=Object.freeze({execute,runOwned});
if(require.main===module)execute().then(r=>{console.log(JSON.stringify(r));if(r.executed!==true||r.nativeFactsProof!==true)process.exitCode=1;},()=>{console.error('FACTS_CI_FIXTURE_REFUSED');process.exitCode=1;});
