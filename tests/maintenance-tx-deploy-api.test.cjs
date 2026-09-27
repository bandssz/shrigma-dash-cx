'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAPIAdapter}=require('../tools/maintenance-tx-deploy/api-adapter.cjs'),{main}=require('../tools/maintenance-tx-deploy/cli.cjs');
test('adapter preserves exact activation version, private credential reference and no gate mutation/transport',async()=>{
 const requests=[],queries=[],a=createAPIAdapter({api:async(...x)=>{requests.push(x);if(x[0].endsWith('ygVyBPjJqGqt2V5E'))return {versionId:'v1',nodes:[{type:'n8n-nodes-base.code',parameters:{jsCode:'synthetic-secret'}},{type:'n8n-nodes-base.postgres',credentials:{postgres:{id:'fixture'}},parameters:{}}]};return {id:'created'};},sql:async q=>{queries.push(q);return [{}];}});
 const pg=await a.utilityPG();assert.ok(!JSON.stringify(pg).includes('synthetic-secret'));assert.deepEqual(pg.ids,['fixture']);
 await a.getWorkflow('fixture');await a.createWorkflow({name:'OFF',nodes:[],connections:{},settings:{}});await a.putWorkflow('fixture',{name:'same',nodes:[],connections:{},settings:{}});await a.activateWorkflow('fixture','exact-v1');await a.deactivateWorkflow('fixture');
 assert.deepEqual(requests.at(-2),['workflows/fixture/activate',{versionId:'exact-v1'},'POST']);assert.ok(requests.every(r=>!r[0].includes('run')&&!r[0].includes('credentials')));
 await a.metadata();await a.state();assert.ok(queries.every(q=>q.startsWith('SELECT ')));assert.throws(()=>a.getWorkflow('../other'),/API_ID/);assert.equal(a.controlOperation,undefined);
});
test('adapter and CLI fail closed with no retries or unsafe error output; no open gate phase',async()=>{
 let calls=0;const a=createAPIAdapter({api:async()=>{calls++;throw Error('HTTP_502');},sql:async()=>[]});await assert.rejects(a.metadata(),/SQL_SHAPE/);await assert.rejects(a.activateWorkflow('fixture','v'),/HTTP_502/);assert.equal(calls,1);
 await assert.rejects(main(['open','/not-loaded','/not-created']),/USAGE/);await assert.rejects(main(['prepare','relative','/not-created']),/USAGE/);
});
test('CLI reports a static 2.0.2 preflight rejection and still hides arbitrary error details',t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tx-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const adapter=path.join(dir,'adapter.cjs'),cli=path.join(__dirname,'../tools/maintenance-tx-deploy/cli.cjs');
 fs.writeFileSync(adapter,`module.exports=()=>require(${JSON.stringify(require.resolve('../tools/maintenance-tx-deploy/n8n-2.0.2.cjs'))}).forPut({name:'synthetic',nodes:[],connections:{},settings:{unknown:'synthetic-secret'}});`);
 const denied=spawnSync(process.execPath,[cli,'verify',adapter,path.join(dir,'state')],{encoding:'utf8'});
 assert.equal(denied.status,1);assert.equal(denied.stdout,'');assert.equal(denied.stderr,'TX_N8N_202_UNKNOWN_SETTING\n');
 fs.writeFileSync(adapter,"module.exports=()=>{throw Error('TX_N8N_202_UNKNOWN_SETTING synthetic-secret');};");
 const hidden=spawnSync(process.execPath,[cli,'verify',adapter,path.join(dir,'state')],{encoding:'utf8'});
 assert.equal(hidden.status,1);assert.equal(hidden.stdout,'');assert.equal(hidden.stderr,'TX_DEPLOY_UNKNOWN_CHECK_PRIVATE_STATE\n');
});
