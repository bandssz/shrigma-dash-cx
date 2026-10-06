'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runOwned}=require('../../../tools/dashboard-crm-control-facts-pg17/fixture.cjs');
test('injected callback cannot assert native facts proof',async()=>{
 let created=0,ended=0;
 const makeClient=()=>{const pid=++created;let ready;return {processID:pid,connection:{on(n,f){ready=f;}},on(){},async connect(){ready({status:'I'});},async end(){ended++;},async query(sql){if(sql==='SHOW server_version_num')return {command:'SHOW',rowCount:null,rows:[{server_version_num:'170011'}]};if(sql.startsWith('SELECT current_database'))return {command:'SELECT',rowCount:1,rows:[{database_name:'crm_borrowed_source_test',backend_pid:pid}]};return {command:'CREATE',rowCount:null,rows:[]};}};};
 const r=await runOwned({makeClient,originalSchema:'SYNTHETIC_ONLY_ORIGINAL',factsSchema:'SYNTHETIC_ONLY_FACTS',runFacts:async()=>({executed:true,engine:'170011',scenarios:4,operational:false,productionAdmitted:false,nativeFactsProof:true})});
 assert.equal(r.executed,true);assert.equal(r.fixtureScope,'injected-test-only');assert.equal(r.nativeFactsProof,false);assert.equal(created,2);assert.equal(ended,2);
});
