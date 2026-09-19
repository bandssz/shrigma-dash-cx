'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {FRAGMENT,patchQuery,patchWhitelist,patchWorkflow}=require('../n8n/organico/api-patch.cjs');
const query=()=>"SELECT json_build_object("+Array.from({length:50},(_,i)=>`'field_${i}',${i}`).join(',')+")::jsonb AS payload;\n";
const whitelist="const allowed={cx:['cx_fila'],growth:['crm_attribution'],organico: ['cx_post','cx_story'],influs:[]}; return allowed;";
const fixture=()=>({id:'synthetic',versionId:'fresh-revision',active:true,settings:{executionOrder:'v1'},connections:{A:{main:[]}},nodes:[
 {name:'Consulta payload',type:'postgres',parameters:{operation:'executeQuery',query:query(),options:{}}},
 {name:'Recorta por painel',type:'code',parameters:{jsCode:whitelist}},
 {name:'Preserve other front',type:'code',parameters:{jsCode:'return [];'},position:[0,1]}]});

test('organic patch only concatenates after the existing 50-pair expression and is idempotent',()=>{
 const q=query(),patched=patchQuery(q);
 assert.equal(patched,q.replace(' AS payload;',FRAGMENT+' AS payload;'));
 assert.equal(patched.slice(0,patched.indexOf(FRAGMENT)),q.slice(0,q.indexOf(' AS payload;')),'central expression byte-for-byte unchanged');
 assert.equal(patchQuery(patched),patched);
 assert.equal(patchQuery(patched,{remove:true}),q,'removes exactly the appended fragment');
 assert.equal(patchQuery(q,{remove:true}),q);
 assert.match(FRAGMENT,/IN \('organico','todos'\)/);assert.match(FRAGMENT,/America\/Sao_Paulo/);assert.match(FRAGMENT,/::date - 399/);
});

test('fresh workflow patch preserves all other nodes, connections, settings and active state',()=>{
 const before=fixture(),snapshot=structuredClone(before),result=patchWorkflow(before);
 assert.deepEqual(before,snapshot,'caller export not mutated');assert.deepEqual(result.changes,[{node:'Consulta payload',field:'query'},{node:'Recorta por painel',field:'jsCode'}]);
 const expected=structuredClone(before);expected.nodes[0].parameters.query=patchQuery(query());expected.nodes[1].parameters.jsCode=patchWhitelist(whitelist);
 assert.deepEqual(result.workflow,expected);
 assert.deepEqual(patchWorkflow(result.workflow).changes,[]);
 // A subsequent unrelated edit survives a rollback of only this field.
 result.workflow.nodes[2].parameters.jsCode='return [{json:{newFront:true}}];';
 const rolled=patchWorkflow(result.workflow,{remove:true});snapshot.nodes[2].parameters.jsCode='return [{json:{newFront:true}}];';
 assert.deepEqual(rolled.workflow,snapshot);
});

test('whitelist patch is restricted to organic; unexpected query layouts fail closed',()=>{
 const p=patchWhitelist(whitelist);assert.equal(p,whitelist.replace("organico: [","organico: ['organico_attribution',"));assert.equal(patchWhitelist(p),p);assert.equal(patchWhitelist(p,{remove:true}),whitelist);
 for(const invalid of ["SELECT json_build_object('organico_attribution',null) AS payload;",'SELECT 1 AS other;',query()+' SELECT 2 AS payload;',query().replace('AS payload','AS something')])assert.throws(()=>patchQuery(invalid));
 assert.throws(()=>patchWhitelist("const x={organico:[],organico:[]}"));
 assert.throws(()=>patchWhitelist("const x={organico:['cx_post','organico_attribution']}" ,{remove:true}));
 const duplicate=fixture();duplicate.nodes.push(structuredClone(duplicate.nodes[0]));assert.throws(()=>patchWorkflow(duplicate));
});
