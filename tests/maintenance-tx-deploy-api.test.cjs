'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAPIAdapter}=require('../tools/maintenance-tx-deploy/api-adapter.cjs'),{main}=require('../tools/maintenance-tx-deploy/cli.cjs');
test('adapter preserves exact activation version, private credential reference and no gate mutation/transport',async()=>{
 const requests=[],queries=[],a=createAPIAdapter({api:async(...x)=>{requests.push(x);if(x[0].endsWith('ygVyBPjJqGqt2V5E'))return {versionId:'v1',nodes:[{type:'n8n-nodes-base.code',parameters:{jsCode:'synthetic-secret'}},{type:'n8n-nodes-base.postgres',credentials:{postgres:{id:'fixture'}},parameters:{}}]};return {id:'created'};},sql:async q=>{queries.push(q);return [{}];}});
 const pg=await a.utilityPG();assert.ok(!JSON.stringify(pg).includes('synthetic-secret'));assert.deepEqual(pg.ids,['fixture']);
 await a.getWorkflow('fixture');await a.createWorkflow({name:'OFF'});await a.putWorkflow('fixture',{name:'same'});await a.activateWorkflow('fixture','exact-v1');await a.deactivateWorkflow('fixture');
 assert.deepEqual(requests.at(-2),['workflows/fixture/activate',{versionId:'exact-v1'},'POST']);assert.ok(requests.every(r=>!r[0].includes('run')&&!r[0].includes('credentials')));
 await a.metadata();await a.state();assert.ok(queries.every(q=>q.startsWith('SELECT ')));assert.throws(()=>a.getWorkflow('../other'),/API_ID/);assert.equal(a.controlOperation,undefined);
});
test('adapter and CLI fail closed with no retries or unsafe error output; no open gate phase',async()=>{
 let calls=0;const a=createAPIAdapter({api:async()=>{calls++;throw Error('HTTP_502');},sql:async()=>[]});await assert.rejects(a.metadata(),/SQL_SHAPE/);await assert.rejects(a.activateWorkflow('fixture','v'),/HTTP_502/);assert.equal(calls,1);
 await assert.rejects(main(['open','/not-loaded','/not-created']),/USAGE/);await assert.rejects(main(['prepare','relative','/not-created']),/USAGE/);
});
