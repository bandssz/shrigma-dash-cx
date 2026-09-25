'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {patchCredential} = require('../n8n/growth/sql-utility-credential-patch.cjs');
const {WORKFLOW_ID,EXPRESSION} = require('../n8n/growth/sql-utility-parameters-patch.cjs');
const edge = node => ({node,type:'main',index:0});
function fixture() { return {id:WORKFLOW_ID,versionId:'v1',activeVersionId:'v1',active:true,name:'Synthetic utility',
  nodes:[{name:'Webhook',type:'n8n-nodes-base.webhook',parameters:{httpMethod:'POST',path:'synthetic',responseMode:'responseNode',options:{}}},
  {name:'Chave confere?',type:'n8n-nodes-base.if',parameters:{conditions:{combinator:'and',conditions:[{leftValue:'={{ $json.body.k }}',rightValue:'synthetic-old-secret-only',operator:{type:'string',operation:'equals'}}]}}},
  {name:'SQL',type:'n8n-nodes-base.postgres',typeVersion:2.6,credentials:{postgres:{id:'synthetic-db'}},parameters:{operation:'executeQuery',query:'={{ $json.body.q }}',options:{queryReplacement:EXPRESSION}}},
  {name:'Responde',type:'n8n-nodes-base.respondToWebhook',parameters:{respondWith:'allIncomingItems'}},
  {name:'Nega 401',type:'n8n-nodes-base.respondToWebhook',parameters:{}}],
  connections:{Webhook:{main:[[edge('Chave confere?')]]},'Chave confere?':{main:[[edge('SQL')],[edge('Nega 401')]]},SQL:{main:[[edge('Responde')]]}},settings:{timezone:'America/Sao_Paulo'}}; }
const options = () => ({expectedVersionId:'v1',credential:{id:'synthetic-header',name:'Synthetic header credential'},
  consumers:{inventoryComplete:true,cxDeveloperMigrated:true,tiktokProtectedEffectMigrated:true,privateToolsMigrated:true,inactiveProbeRetired:true}});
test('candidate preserves query parameters and route, removes secret and suppresses payload retention', () => {
  const before=fixture(), original=structuredClone(before), {payload}=patchCredential(before,options());
  assert.deepEqual(before,original);
  assert.equal(payload.nodes[0].parameters.path,'synthetic');
  assert.equal(payload.nodes[0].parameters.authentication,'headerAuth');
  assert.equal(payload.nodes[0].credentials.httpHeaderAuth.id,'synthetic-header');
  assert.deepEqual(payload.nodes.find(n=>n.name==='SQL'),before.nodes.find(n=>n.name==='SQL'));
  assert.equal(JSON.stringify(payload).includes('synthetic-old-secret-only'),false);
  assert.equal(payload.settings.saveDataErrorExecution,'none');
  assert.equal(payload.settings.saveDataSuccessExecution,'none');
  assert.equal(payload.settings.saveManualExecutions,false);
  assert.equal(payload.settings.saveExecutionProgress,false);
});
test('every migration dependency blocks the candidate until recorded complete', () => {
  for(const k of Object.keys(options().consumers)) {
    const o=options();o.consumers[k]=false;
    assert.throws(()=>patchCredential(fixture(),o),/migration is incomplete/);
  }
});
test('refuses stale revision, draft changes, wrong workflow and changed SQL contract', () => {
  for(const change of [w=>w.versionId='new',w=>w.activeVersionId='old',w=>w.id='cx-workflow',
    w=>w.nodes[2].parameters.options.queryReplacement='unsafe',w=>w.nodes[2].parameters.query='SELECT 1']) {
    const w=fixture();change(w);assert.throws(()=>patchCredential(w,options()));
  }
});
test('refuses added auth conditions, new routes, extra nodes and residual legacy secret', () => {
  for(const change of [w=>w.nodes[1].parameters.conditions.conditions.push({}),
    w=>w.connections.Webhook.main[0].push(edge('SQL')),w=>w.nodes.push({name:'new'}),
    w=>w.settings.notes='synthetic-old-secret-only']) {
    const w=fixture();change(w);assert.throws(()=>patchCredential(w,options()));
  }
});
