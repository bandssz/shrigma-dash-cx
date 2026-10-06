'use strict';
// OUTER Root CI setup only. Borrowed runner never connects, seeds or closes.
const fs=require('node:fs'),path=require('node:path'),G=require('./source-gate.cjs');
const owned=new WeakSet();
const VERSION='SHOW server_version_num',SESSION='SELECT current_database() AS database_name, pg_backend_pid() AS backend_pid';
const scenarios=new Set(['registration-race','consume-cas','brand-isolation','pending-hook','ack-hook']);
const flags={sourceOnly:true,operational:false,completeReservation:false,productionChanged:false,nativeNetworkAckProof:false,productionDurabilityProved:false};
const refuse=()=>{throw Error('BORROWED_CI_FIXTURE_REFUSED');};
async function metadata(c){const show=await c.query(VERSION);if(show?.command!=='SHOW'||show.rowCount!==null||show.rows?.length!==1||typeof show.rows[0].server_version_num!=='string'||!/^17[0-9]{4}$/.test(show.rows[0].server_version_num))refuse();const r=await c.query(SESSION);if(r?.command!=='SELECT'||r.rowCount!==1||r.rows?.length!==1||r.rows[0].database_name!=='crm_borrowed_source_test'||!Number.isSafeInteger(r.rows[0].backend_pid)||r.rows[0].backend_pid!==c.processID)refuse();return {version:Number(show.rows[0].server_version_num),database:r.rows[0].database_name,pid:r.rows[0].backend_pid};}
function authenticatedSources(){const source=process.env.BORROWED_SOURCE_DIRECTORY,reference=process.env.CRM_PERSISTENCE_CONTEXT_DIRECTORY;G.verifyDirectory(source,'source');G.verifyDirectory(reference,'reference');require(path.join(source,'tests/crm-mvp-controls-persistence/verify-context.cjs')).verifyContext();return source;}
async function executeScenario(scenario){let clients=[],ends=0,closed=0,ready=false,version=null,result=null;const idle=new WeakMap();try{
 if(!scenarios.has(scenario)||process.env.BORROWED_PG17_CI!=='1'||process.env.GITHUB_ACTIONS!=='true'||process.version!=='v22.23.3')refuse();
 const source=authenticatedSources(),runnerTemp=process.env.RUNNER_TEMP,modulePath=process.env.BORROWED_PG_MODULE;G.physical(runnerTemp,false);G.physical(modulePath,false);if(!modulePath.startsWith(runnerTemp+path.sep)||!modulePath.endsWith('/node_modules/pg'))refuse();G.physical(path.join(modulePath,'package.json'));if(JSON.parse(fs.readFileSync(path.join(modulePath,'package.json'),'utf8')).version!=='8.13.1')refuse();const pg=require(modulePath);if(typeof pg.Client!=='function')refuse();
 // Public credentials are for the explicit temporary GitHubActions service only.
 // No external configuration, URL, original Auth lease or production database accepted.
 for(let n=0;n<2;n++){const c=new pg.Client({host:'127.0.0.1',port:5432,user:'crm_test',password:'crm_test_only',database:'crm_borrowed_source_test',connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});clients.push(c);c.connection.on('readyForQuery',m=>idle.set(c,m.status));c.on('error',()=>{ready=false;});}
 const connects=await Promise.allSettled(clients.map(c=>c.connect()));if(connects.some(r=>r.status!=='fulfilled'))refuse();clients.forEach(c=>owned.add(c));
 const original=await Promise.all(clients.map(metadata));if(original[0].version!==original[1].version||original[0].pid===original[1].pid||original.some(m=>m.database!=='crm_borrowed_source_test'))refuse();version=original[0].version;
 // Major17 was observed on BOTH real sessions before any schema/seed SQL.
 const schema=fs.readFileSync(path.join(source,'services/dashboard-operational/domain/crm-mvp-controls-persistence/schema-v1.sql'),'utf8');await clients[0].query('DROP SCHEMA IF EXISTS dashboard_crm_controls CASCADE');await clients[0].query(schema);
 const F=require(path.join(source,'tests/crm-mvp-controls-persistence/fixtures.cjs')),C=require(path.join(source,'services/dashboard-operational/domain/crm-mvp-controls-persistence/codec.cjs'));
 if(scenario==='pending-hook'||scenario==='ack-hook'){const body=F.reserved(F.identity('fish',scenario==='pending-hook'?61:62)),row=C.encode(body);const seed=`INSERT INTO dashboard_crm_controls.crm_mvp_operations_v1 (${C.COLUMNS.join(',')}) VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6::bigint,$7,$8,$9,$10::bigint,$11::bigint,$12::jsonb,$13,$14::bigint,$15,$16,$17)`;await clients[0].query(seed,C.COLUMNS.map(k=>k==='scope'?JSON.stringify(row[k]):row[k]));}
 if(clients.some(c=>idle.get(c)!=='I'))refuse();ready=true;
 const admitTest=async request=>{const pair=request?.clients,descriptors=Array.isArray(pair)&&pair.length===2?[Object.getOwnPropertyDescriptor(pair,'0'),Object.getOwnPropertyDescriptor(pair,'1')]:[];if(!ready||request.scenario!==scenario||descriptors.length!==2||descriptors.some((d,n)=>!d||!d.enumerable||!Object.hasOwn(d,'value')||d.value!==clients[n]||!owned.has(d.value)||idle.get(d.value)!=='I'))refuse();const observed=await Promise.all(clients.map(metadata));if(observed.some((m,n)=>m.version!==original[n].version||m.database!==original[n].database||m.pid!==original[n].pid)||clients.some(c=>idle.get(c)!=='I'))refuse();return {isolated:true,noExternalTransaction:true,reservedRowsReady:true,schemaInstalled:true};};
 const runner=require('../../tests/crm-mvp-controls-persistence/borrowed-pg17-protocol.cjs');result=await runner.run({enabled:true,clients,admitTest,sourceDirectory:source,scenario});if(result.code!=='BORROWED_PG17_SCENARIO_PASSED'||result.executed!==true||result.engineVersionNum!==version||result.twoDistinctStableSessions!==true)refuse();
 }catch{result={code:'BORROWED_CI_FIXTURE_REFUSED',executed:false,...flags};}
 finally{ready=false;for(const c of clients){owned.delete(c);ends++;try{await c.end();closed++;}catch{result={code:'BORROWED_CI_CLEANUP_REFUSED',executed:false,...flags};}}}
 return Object.freeze({...result,engineVersionNum:version,cleanup:Object.freeze({created:clients.length,endCalls:ends,closed}),...flags});
}
module.exports=Object.freeze({executeScenario,authenticatedSources});
