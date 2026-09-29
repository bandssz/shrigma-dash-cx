'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const P=require('../n8n/growth/growth-cache-parameterized-upsert.cjs');

const payload={gerado_em:'2026-09-29T18:00:00Z',titulo:"Growth ' $crmjson$ 😀",nested:{nul:null,html:"</script><script>alert('x')</script>"},rows:[1,true,'𐐷']};

test('bound parameters preserve body/direct shapes and UTF-16 byte-column semantics',()=>{
 const direct=P.prepareCacheParameters(payload,1000,2250),wrapped=P.prepareCacheParameters({body:payload},1000,2250);
 assert.deepEqual(wrapped,direct);
 assert.deepEqual(JSON.parse(direct.parameters[0]),payload);
 assert.equal(direct.parameters[1],JSON.stringify(payload).length);
 assert.equal(direct.parameters[1],Buffer.byteLength(JSON.stringify(payload),'utf16le')/2);
 assert.notEqual(direct.parameters[1],Buffer.byteLength(JSON.stringify(payload),'utf8'));
 assert.equal(direct.parameters[2],1250);
 assert.equal(direct.diagnostics.blocos,Object.keys(payload).length);
});

test('static SQL preserves the five live columns, PG now(), and parameter boundary',()=>{
 assert.match(P.SQL,/\(painel, payload, gerado_em, bytes, origem_ms\)/);
 assert.match(P.SQL,/VALUES \('growth', \$1::jsonb, now\(\), \$2, \$3\)/);
 assert.match(P.SQL,/gerado_em = now\(\)/);
 assert.doesNotMatch(P.SQL,/RETURNING|blocos|\$json|<script>|crmjson/i);
 const args=P.prepareCacheParameters({body:payload},0,5000).parameters;
 assert.equal(args.length,3);assert.match(args[0],/DROP|script|crmjson/);assert.equal(P.SQL.includes(args[0]),false);
});

test('n8n replacement expression evaluates to an array, once, with clock parity',()=>{
 const source=P.QUERY_REPLACEMENT.slice(3,-2),fixedNow=2250;let stringifies=0;
 const DateFixture=class extends Date{static now(){return fixedNow;}};
 const countedJson={stringify(value){stringifies++;return JSON.stringify(value);}};
 const context={$json:{body:payload},$:name=>{assert.equal(name,P.CLOCK);return {first:()=>({json:{ms:1000}})};},Date:DateFixture,JSON:countedJson,Math,Number,Error,Array};
 const value=vm.runInNewContext(source,context);
 assert.equal(Array.isArray(value),true);
 assert.deepEqual(Array.from(value),P.prepareCacheParameters({body:payload},1000,fixedNow).parameters);
 assert.equal(stringifies,1);
 assert.throws(()=>vm.runInNewContext(source,{...context,$json:[]}),/CACHE_PAYLOAD_INVALID/);
});

test('validation rejects non-contract payloads without echoing their content',()=>{
 for(const value of [null,[],{}, {body:null},{body:{gerado_em:''}}])assert.throws(()=>P.prepareCacheParameters(value,1,2),e=>e.message==='CACHE_PAYLOAD_INVALID'&&!e.message.includes(JSON.stringify(value)));
});

test('theoretical run-data measurement is exact serialization, not a heap claim',()=>{
 const m=P.measureRunDataRepresentation({body:payload},1000,2250);
 assert.equal(m.input_json_utf8,Buffer.byteLength(JSON.stringify({body:payload})));
 assert.ok(m.removed_code_output_json_utf8>m.bytes_utf16);
 assert.equal(m.candidate_intermediate_output_json_utf8,0);
 assert.equal(m.blocos,Object.keys(payload).length);
});

function layer(){
 const node=(id,name,type,typeVersion,parameters={})=>({id,name,type,typeVersion,parameters,position:[0,0]});
 return {nodes:[node('t','Relógio sintético','n8n-nodes-base.scheduleTrigger',1.2),node('w','Webhook sintético','n8n-nodes-base.webhook',2),node('c',P.CLOCK,'n8n-nodes-base.postgres',2.5),node(P.NODE_IDS.source,P.SOURCE,'n8n-nodes-base.httpRequest',4.2,{url:'https://redacted.invalid'}),node(P.NODE_IDS.removed,P.REMOVED,'n8n-nodes-base.code',2,{jsCode:'/* fixture redigido */ return [];'}),node(P.NODE_IDS.sink,P.SINK,'n8n-nodes-base.postgres',2.5,{operation:'executeQuery',query:'={{ $json.sql }}',options:{}})],connections:{'Relógio sintético':{main:[[{node:P.SOURCE,type:'main',index:0}]]},[P.SOURCE]:{main:[[{node:P.REMOVED,type:'main',index:0}]]},[P.REMOVED]:{main:[[{node:P.SINK,type:'main',index:0}]]}}};
}
test('exported layer transform is pure and changes only reviewed node and edges',()=>{
 const input=layer(),before=structuredClone(input),out=P.transformGrowthCacheLayer(input);
 assert.deepEqual(input,before);assert.equal(out.nodes.length,5);assert.equal(out.nodes.some(n=>n.name===P.REMOVED),false);
 assert.deepEqual(out.connections[P.SOURCE],{main:[[{node:P.SINK,type:'main',index:0}]]});assert.equal(out.connections[P.REMOVED],undefined);
 assert.deepEqual(out.connections['Relógio sintético'],before.connections['Relógio sintético']);
 const sink=out.nodes.find(n=>n.name===P.SINK);assert.deepEqual(sink.parameters,{operation:'executeQuery',query:P.SQL,options:{queryReplacement:P.QUERY_REPLACEMENT}});
 assert.deepEqual(out.nodes.filter(n=>n.id!==P.NODE_IDS.sink),before.nodes.filter(n=>![P.NODE_IDS.removed,P.NODE_IDS.sink].includes(n.id)));
});

test('structural layer drift and production workflow pins fail closed without private fixtures',()=>{
 for(const mutate of [x=>x.nodes.pop(),x=>x.nodes.find(n=>n.name===P.REMOVED).name='Outro',x=>x.nodes.find(n=>n.name===P.SINK).parameters.query='SELECT 1',x=>x.connections[P.SOURCE].main[0][0].node=P.SINK,x=>x.connections.Other={main:[[{node:P.REMOVED,type:'main',index:0}]]}]){const x=layer();mutate(x);assert.throws(()=>P.transformGrowthCacheLayer(x),/GROWTH_CACHE_.*_DRIFT/);}
 for(const value of [null,{}, {id:P.WORKFLOW_ID,active:false,versionId:P.VERSION_ID,activeVersionId:P.VERSION_ID}, {id:P.WORKFLOW_ID,active:true,versionId:P.VERSION_ID,activeVersionId:P.VERSION_ID,nodes:layer().nodes,connections:layer().connections,activeVersion:{versionId:P.VERSION_ID,workflowId:P.WORKFLOW_ID,nodes:layer().nodes,connections:layer().connections}}])assert.throws(()=>P.patchGrowthCacheWorkflow(value),/GROWTH_CACHE_.*_DRIFT/);
});
