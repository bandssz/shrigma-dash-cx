'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAPIAdapter}=require('../tools/maintenance-cart-deploy/api-adapter.cjs');
test('n8n adapter uses version-pinned activation, never PATCH auth/shared workflow or execute endpoint',async()=>{
 const requests=[],queries=[],a=createAPIAdapter({api:async(...x)=>{requests.push(x);if(x[0].endsWith('ygVyBPjJqGqt2V5E'))return {versionId:'v1',nodes:[{type:'n8n-nodes-base.code',parameters:{jsCode:'synthetic-secret'}},{type:'n8n-nodes-base.postgres',credentials:{postgres:{id:'fixture'}},parameters:{options:{}}}]};return {id:'created'};},sql:async q=>{queries.push(q);return [{request:{},response:{}}];}});
 const pg=await a.utilityPG();assert.ok(!JSON.stringify(pg).includes('synthetic-secret'));assert.deepEqual(pg.ids,['fixture']);
 await a.getWorkflow('fixture');await a.createWorkflow({name:'OFF'});await a.putWorkflow('fixture',{name:'same'});await a.activateWorkflow('fixture','exact-reviewed-version');await a.deactivateWorkflow('fixture');
 assert.deepEqual(requests.at(-2),['workflows/fixture/activate',{versionId:'exact-reviewed-version'},'POST']);assert.ok(requests.every(r=>!r[0].includes('run')&&!r[0].includes('credentials')));
 await a.controlOperation('00000000-0000-4000-8000-000000000000');assert.match(queries[0],/^SELECT request,response/);assert.throws(()=>a.getWorkflow('../other'),/API_ID/);await assert.rejects(a.controlOperation("x' OR true"),/OPERATION/);
});
test('metadata/counts must be exactly one row; API errors retain uncertainty and are never retried',async()=>{
 let calls=0;const a=createAPIAdapter({api:async()=>{calls++;throw Error('HTTP_502');},sql:async()=>[]});await assert.rejects(a.metadata(),/SQL_SHAPE/);await assert.rejects(a.activateWorkflow('fixture','v'),/HTTP_502/);assert.equal(calls,1);
});
