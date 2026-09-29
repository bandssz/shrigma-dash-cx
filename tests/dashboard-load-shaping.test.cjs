'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),P=require('../n8n/growth/dashboard-load-shaping.cjs');
test('snapshot offsets preserve cadence, all SQL/connections, errors and night jobs',()=>{
 for(const [id,p] of Object.entries(P.PLANS)){
  const w={id,active:true,versionId:p.version,activeVersionId:p.version,nodes:[{name:p.node,type:'n8n-nodes-base.scheduleTrigger',parameters:{rule:{interval:[{field:'cronExpression',expression:p.before}]}}},{name:'Night',type:'n8n-nodes-base.scheduleTrigger',parameters:{rule:{interval:[{field:'cronExpression',expression:'20 1 * * *'}]}}},{name:'Database',type:'n8n-nodes-base.postgres',parameters:{query:'SELECT existing_snapshot()'},credentials:{postgres:{id:'same'}}}],connections:{Night:{main:[[{node:'Database'}]]}},settings:{timezone:'America/Sao_Paulo',saveDataErrorExecution:'all'}};
  const before=structuredClone(w),out=P.patch(w);assert.deepEqual(w,before);assert.deepEqual(out.nodes.slice(1),before.nodes.slice(1));assert.deepEqual(out.connections,w.connections);assert.equal(out.settings.timezone,w.settings.timezone);assert.equal(out.settings.saveDataErrorExecution,'all');assert.equal(out.settings.saveDataSuccessExecution,'none');assert.equal(out.settings.saveExecutionProgress,false);
  const cron=out.nodes[0].parameters.rule.interval[0].expression;assert.equal(cron,p.after);assert.deepEqual(cron.split(' ').slice(1),p.before.split(' ').slice(1));assert.equal(cron.split(' ')[0].split('/')[1],'10');
  assert.throws(()=>P.patch({...w,activeVersionId:'other'}),/DRIFT/);assert.throws(()=>P.patch({...w,versionId:'other'}),/DRIFT/);
 }
});
test('unknown flows and cadence drift cannot be changed',()=>{assert.throws(()=>P.patch({id:'unrelated'}),/DRIFT/);for(const [id,p] of Object.entries(P.PLANS))assert.throws(()=>P.patch({id,active:true,versionId:p.version,activeVersionId:p.version,nodes:[{name:p.node,type:'n8n-nodes-base.scheduleTrigger',parameters:{rule:{interval:[{field:'cronExpression',expression:'* * * * *'}]}}}]}),/CADENCE_DRIFT/);});
