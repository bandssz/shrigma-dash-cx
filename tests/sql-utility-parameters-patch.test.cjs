'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const P=require('../n8n/growth/sql-utility-parameters-patch.cjs');
function fixture(){return {id:P.WORKFLOW_ID,versionId:'fresh',nodes:[{name:'Webhook',type:'n8n-nodes-base.webhook',parameters:{httpMethod:'POST',path:'synthetic-existing-path'}},{name:'Chave confere?',type:'n8n-nodes-base.if',parameters:{conditions:{existing_auth:'synthetic-secret'}}},{name:'SQL',type:'n8n-nodes-base.postgres',typeVersion:2.6,parameters:{operation:'executeQuery',query:'={{ $json.body.q }}',options:{}},credentials:{postgres:{id:'synthetic-existing-reference'}}},{name:'Nega 401',type:'n8n-nodes-base.respondToWebhook',parameters:{options:{responseCode:401}}}],connections:{Webhook:{main:[[{node:'Chave confere?',type:'main',index:0}]]},'Chave confere?':{main:[[{node:'SQL',type:'main',index:0}],[{node:'Nega 401',type:'main',index:0}]]}},settings:{executionOrder:'v1'}};}
const expression=body=>vm.runInNewContext(P.EXPRESSION.slice(3,-2),{$json:{body}});
test('adds one optional native parameter field and preserves auth, query, credentials, route and settings',()=>{
 const before=fixture(),copy=structuredClone(before),out=P.patchUtility(before,{expectedVersionId:'fresh'});
 assert.deepEqual(before,copy);assert.deepEqual(out.changes,[{node:'SQL',field:'options.queryReplacement'}]);
 const reversed=structuredClone(out.workflow);delete reversed.nodes[2].parameters.options.queryReplacement;assert.deepEqual(reversed,before);
 assert.deepEqual(P.patchUtility(out.workflow,{expectedVersionId:'fresh'}).changes,[]);
 assert.throws(()=>P.patchUtility(before,{expectedVersionId:'stale'}),/version/);
 const bypass=fixture();bypass.connections.Webhook.main[0][0].node='SQL';assert.throws(()=>P.patchUtility(bypass,{expectedVersionId:'fresh'}),/auth gate/);
 const other=fixture();other.nodes[2].parameters.options.queryReplacement='other';assert.throws(()=>P.patchUtility(other,{expectedVersionId:'fresh'}),/differs/);
});
test('zero-argument legacy queries remain unchanged and literals never become SQL source',()=>{
 assert.deepEqual(Array.from(expression({q:'select 1'})),[]);assert.deepEqual(Array.from(expression({q:'select $$literal$$'})),[]);
 const args=['commas,quotes\'" Unicode ç {{ UnsubscribeURL }}',JSON.stringify({text:"'); DROP TABLE synthetic; --"}),null,42,true];
 assert.deepEqual(Array.from(expression({q:'SELECT $1,$2,$3,$4,$5',args})),args);
 for(const args of [null,{},'a,b',[{}],[[]],[undefined],[Infinity],Array(129).fill('x')])assert.throws(()=>expression({q:'SELECT 1',args}),/SQL_ARGS_INVALID/);
});
test('native PostgreSQL binding round-trips opaque JSON while preserving a table and legacy SQL',async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec('CREATE TABLE synthetic(id integer); INSERT INTO synthetic VALUES(1)');
  const value={quote:"'); DROP TABLE synthetic; --",unicode:'ação',macro:'{{ UnsubscribeURL }}',csv:'one,two'},args=Array.from(expression({args:['synthetic-key',JSON.stringify(value)]}));
  const row=(await db.query('SELECT $1::text AS key,$2::jsonb AS payload',args)).rows[0];assert.equal(row.key,'synthetic-key');assert.deepEqual(row.payload,value);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM synthetic',Array.from(expression({q:'unused'})))).rows[0].n,1);
 }finally{await db.close();}
});
