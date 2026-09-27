'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('../tools/maintenance-tx-deploy/n8n-2.0.2.cjs');
const D=require('../tools/maintenance-tx-deploy/deploy.cjs');
const {createAPIAdapter}=require('../tools/maintenance-tx-deploy/api-adapter.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
// Exact keys/types of the reviewed source; all workflow content is synthetic.
const settings=()=>({executionOrder:'v1',timeSavedMode:'fixed',callerPolicy:'workflowsFromSameOwner',availableInMCP:false,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false});
const body=()=>({name:'synthetic TX',nodes:[{name:'unchanged transport',credentials:{postgres:{id:'synthetic-reference'}},parameters:{query:'SELECT 1'}}],connections:{},settings:settings()});
test('2.0.2 PUT omits only known timeSavedMode without mutating reviewed body or transport',()=>{
 for(const mode of ['fixed','dynamic']){
  const original=body();original.settings.timeSavedMode=mode;const before=clone(original),wire=N.forPut(original);
  const expected=clone(before);delete expected.settings.timeSavedMode;assert.deepEqual(wire,expected);assert.deepEqual(original,before);
  wire.nodes[0].parameters.query='changed in wire';assert.deepEqual(original,before);
 }
});
test('adapter simulates public validation before handler and exact stored-settings merge/readback',async()=>{
 const original=body(),before=clone(original);let handlerCalls=0,requests=0;
 const a=createAPIAdapter({sql:async()=>[],api:async(route,wire,method)=>{
  requests++;assert.equal(route,'workflows/fixture');assert.equal(method,'PUT');
  assert.ok(!Object.hasOwn(wire.settings,'timeSavedMode'));handlerCalls++;
  // Exact update operation from n8n@2.0.2 WorkflowService.update:296–302.
  return {...clone(wire),settings:{...before.settings,...wire.settings}};
 }});
 assert.deepEqual(await a.putWorkflow('fixture',original),before);assert.deepEqual(original,before);assert.equal(handlerCalls,1);assert.equal(requests,1);
});
test('unknown settings or unsupported mode fail closed before any API request',()=>{
 let requests=0;const a=createAPIAdapter({sql:async()=>[],api:async()=>{requests++;}});
 for(const key of ['newFutureSetting','constructor','__proto__']){
  const value=body();Object.defineProperty(value.settings,key,{value:'synthetic-private-value',enumerable:true});
  assert.throws(()=>a.putWorkflow('fixture',value),e=>e.message==='TX_N8N_202_UNKNOWN_SETTING');
 }
 for(const mode of ['other',null,0]){const value=body();value.settings.timeSavedMode=mode;assert.throws(()=>a.putWorkflow('fixture',value),/TIME_SAVED_MODE/);}
 assert.equal(requests,0);
});
test('create refuses timeSavedMode, accepts known settings and preserves explicit false/none',async()=>{
 let requests=0;const a=createAPIAdapter({sql:async()=>[],api:async(route,wire,method)=>{requests++;assert.equal(route,'workflows');assert.equal(method,'POST');return wire;}});
 assert.throws(()=>a.createWorkflow(body()),/CREATE_TIME_SAVED_MODE/);assert.equal(requests,0);
 const input=body();delete input.settings.timeSavedMode;assert.deepEqual(await a.createWorkflow(input),input);assert.equal(requests,1);
});
test('settings type/schema drift and unexpected top-level fields are rejected rather than removed',()=>{
 for(const [key,value] of [['saveManualExecutions','false'],['availableInMCP',1],['saveDataErrorExecution','DEFAULT'],['callerPolicy','unknown'],['executionTimeout',NaN],['timeSavedPerExecution',Infinity],['timezone',null]]){
  const input=body();input.settings[key]=value;assert.throws(()=>N.forPut(input),/SETTING_TYPE/);
 }
 const input=body();input.active=true;assert.throws(()=>N.forPut(input),/BODY/);
 assert.throws(()=>N.forPut({...body(),settings:[]}),/BODY/);
});
test('reviewed installer source hash includes the version-specific serializer',()=>{
 const sources=D.sourceFiles(require('node:path').join(__dirname,'..'));
 assert.match(sources['tools/maintenance-tx-deploy/n8n-2.0.2.cjs'],/^[a-f0-9]{64}$/);
});
