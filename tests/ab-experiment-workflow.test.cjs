'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {buildWorkflow,prepareCode,finishCode}=require('../n8n/growth/ab-experiment-workflow.cjs');
const {fixture,uuid}=require('./ab-experiment-fixture.cjs');
const origin='https://dashboard.example.invalid',run=(code,json)=>JSON.parse(JSON.stringify(vm.runInNewContext(`(()=>{${code}})()`,{$json:json,$input:{all:()=>[{json}]}})))[0].json;
test('dedicated inactive candidate has no sending node, schedule, inline secret or shared workflow changes',()=>{
 const credential={id:'synthetic-pg',name:'Existing PostgreSQL'},w=buildWorkflow({postgres:credential,allowedOrigin:origin});
 assert.equal(w.active,false);assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveManualExecutions,false);assert.equal(w.settings.saveExecutionProgress,false);
 assert.equal(w.nodes.filter(n=>n.type==='n8n-nodes-base.webhook').length,3);
 assert.ok(w.nodes.every(n=>!/(httpRequest|schedule|executeWorkflow|email|smtp)/i.test(n.type)));
 const pg=w.nodes.find(n=>n.type==='n8n-nodes-base.postgres');assert.deepEqual(pg.credentials,{postgres:credential});assert.equal(pg.parameters.options.queryReplacement,'={{ $json.parameters }}');assert.equal(pg.onError,'continueErrorOutput');
 for(const n of w.nodes.filter(n=>n.type==='n8n-nodes-base.respondToWebhook'))assert.equal(n.parameters.options.responseHeaders.entries.find(x=>x.name==='Access-Control-Allow-Origin').value,origin);
 assert.throws(()=>buildWorkflow({postgres:credential,allowedOrigin:'https://another.invalid/path'}));assert.throws(()=>buildWorkflow({postgres:{...credential,password:'never-inline'},allowedOrigin:origin}));assert.throws(()=>buildWorkflow({postgres:credential,allowedOrigin:origin,path:'cx-anything'}));
});
test('sandbox validation uses only parameterized SQL, refuses caller SQL/actor and keeps writes out of GET',async()=>{
 const x=await fixture();try{
  const p=await x.protocol(),raw={method:'mutate',k:'synthetic-key',brand:'fish',operation_id:uuid(500),request_payload:p};
  const plan=run(prepareCode(false,origin),{body:raw,headers:{origin}});assert.equal(plan.ok,true);assert.deepEqual(plan.parameters,['synthetic-key','mutate',JSON.stringify({brand:'fish',operation_id:uuid(500),request_payload:p})]);
  assert.equal(plan.sql,'SELECT public.crm_ab_api_v2($1::text,$2::text,$3::jsonb) AS result');assert.equal(plan.data,undefined);
  for(const body of [{...raw,sql:'untrusted'},{...raw,actor:'panel:forged'},{...raw,brand:'olivas'},{...raw,request_payload:{...p,confirm:'schedule'}},{...raw,k:''}])assert.equal(run(prepareCode(false,origin),{body,headers:{origin}}).ok,false);
  assert.equal(run(prepareCode(false,origin),{body:raw,headers:{origin:'https://wrong.invalid'}}).status,403);
  const q={method:'operation',brand:'fish',operation_id:uuid(500),action:'prepare'},read=run(prepareCode(true,origin),{query:q,headers:{'x-ab-write-key':'synthetic-key',origin}});assert.equal(read.ok,true);assert.equal(read.parameters[1],'operation');
  for(const query of [{...q,k:'synthetic-key'},{...q,method:'mutate'},{...q,sql:'untrusted'},{...q,operation_id:'bad'}])assert.equal(run(prepareCode(true,origin),{query,headers:{'x-ab-write-key':'synthetic-key'}}).ok,false);
 }finally{await x.db.close();}
});
test('unexpected SQL output or error detail becomes generic uncertainty, never a definitive receipt',()=>{
 for(const result of [null,{status:500,body:{error:'server detail'}},{status:409,body:{error:'database detail'}},{status:200,body:null}])assert.deepEqual(run(finishCode,{result}),{status:503,body:{error:'AB_V2_OUTCOME_UNKNOWN'}});
 const result={status:409,body:{error:'AB_V2_VERSION'}};assert.deepEqual(run(finishCode,{result}),result);
});
