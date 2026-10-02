'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const Response=require('../n8n/growth/template-response-route.cjs');
const Patch=require('../n8n/growth/template-operation-patch.cjs');
const Receipt=require('../n8n/growth/template-operation-receipt.cjs');
const VERSION='synthetic-version',ACTOR='synthetic-actor',KEY='20000000-0000-4000-8000-000000000001';
const node=(workflow,name)=>workflow.nodes.find(n=>n.name===name);
function fixture({wrapped=false}={}){
 const prepare="const req=$('Autenticação entrada').first().json.req;const q=req.query||{},method=req.method,acao=q.acao,auth=$json.auth;const out=(s,b)=>({json:{_http:s,_body:b}});"+Patch.PREP_ANCHOR+
  "if(acao==='sql_read')return [{json:{sql:'SELECT $1',sqlParameters:[auth.who],_http:200,_body:{sentinel:true}}}];"+
  "if(acao==='sql_write')return [{json:{_step:'pg_escrita',sql:'UPDATE synthetic_table SET value=$1',sqlParameters:[7],who:auth.who}}];"+
  "if(acao==='explicit')return [{json:{_step:'existing_route',_http:201,_body:{who:auth.who}}}];"+
  'return [out(201,{synthetic:true,who:auth.who})];';
 return {versionId:VERSION,settings:{saveDataSuccessExecution:'none',timezone:'America/Sao_Paulo'},connections:{
  Prepara:{main:[[{node:'Etapa',type:'main',index:0}]]},
  Etapa:{main:[[{node:'Responde',type:'main',index:0}],[{node:'PG leitura',type:'main',index:0}]]},
  'Existing transport':{main:[[{node:'Responde',type:'main',index:0}]]}
 },nodes:[
  {name:'Autenticação entrada',type:'n8n-nodes-base.code',parameters:{jsCode:Patch.AUTH_ANCHOR+'return [{json:{req,k}}];'}},
  {name:'Prepara',type:'n8n-nodes-base.code',parameters:{jsCode:wrapped?Response.finalizePrepareCode(prepare):prepare}},
  {name:'Formata leitura',type:'n8n-nodes-base.code',parameters:{jsCode:Patch.FORMAT_ANCHOR+"throw Error('synthetic provider sentinel');"}},
  {name:'PG leitura',type:'n8n-nodes-base.postgres',typeVersion:2.5,parameters:{operation:'executeQuery',query:'={{ $json.sql }}',options:{}},credentials:{postgres:{id:'synthetic-postgres',name:'Synthetic credential reference'}}},
  {name:'Etapa',type:'n8n-nodes-base.switch',parameters:{rules:{values:[{conditions:{conditions:[{leftValue:'={{ $json._step }}',rightValue:'resposta',operator:{type:'string',operation:'equals'}}]}}]}}},
  {name:'Responde',type:'n8n-nodes-base.respondToWebhook',parameters:{respondWith:'json',responseBody:'={{ $json._body }}',options:{responseCode:'={{ $json._http }}',responseHeaders:{entries:[]}}}},
  {name:'Existing transport',type:'n8n-nodes-base.httpRequest',parameters:{url:'https://provider.example.invalid/never-called',method:'POST'},retryOnFail:false}
 ]};
}
function execute(code,json,context={}){
 return new vm.Script('(function(){'+code+'\n})()').runInNewContext({...context,$json:json},{timeout:200,contextCodeGeneration:{strings:false,wasm:false}});
}
function prepare(workflow,auth,query={},method='GET'){
 return execute(node(workflow,'Prepara').parameters.jsCode,{auth},{$:()=>({first:()=>({json:{req:{method,query}}})})})[0].json;
}
function dispatchResponse(workflow,json){
 Response.assertResponseRoute(workflow);
 const branch=node(workflow,'Etapa').parameters.rules.values[0].conditions.conditions[0];
 assert.equal(json._step,branch.rightValue,'the existing Switch must select the response branch');
 const expression=value=>value.replace(/^=\{\{\s*|\s*\}\}$/g,'');
 const response=node(workflow,'Responde').parameters;
 const body=vm.runInNewContext(expression(response.responseBody),{$json:json});
 return {status:vm.runInNewContext(expression(response.options.responseCode),{$json:json}),body:typeof body==='string'?JSON.parse(body):body};
}
test('terminal responses gain only their response step without mutating body, actor or item metadata',()=>{
 const body=Object.freeze({erro:'synthetic_denial',who:ACTOR}),pairedItem=Object.freeze({item:0});
 const json=Object.freeze({_http:403,_body:body,who:ACTOR}),item=Object.freeze({json,pairedItem});
 const result=Response.normalizeResponse(item);
 assert.notEqual(result,item);assert.notEqual(result.json,json);assert.equal(result.json._step,'resposta');
 assert.equal(result.json._body,body);assert.equal(result.json.who,ACTOR);assert.equal(result.pairedItem,pairedItem);assert.equal(Object.hasOwn(json,'_step'),false);
 for(const status of [200,204,299,400,401,403,599])assert.equal(Response.normalizeResponse({json:{_http:status,_body:null}}).json._step,'resposta');
});
test('explicit routes, SQL presence, invalid HTTP contracts and non-items remain identical',()=>{
 for(const fields of [{_step:undefined},{_step:null},{_step:''},{_step:'pg_escrita'},{sql:undefined},{sql:null},{sql:'SELECT $1'},{sqlParameters:undefined},{sqlParameters:[]}]){
  const item={json:{_http:401,_body:{erro:'synthetic'},...fields}};assert.equal(Response.normalizeResponse(item),item);
 }
 for(const status of [199,600,200.5,NaN,'401',undefined]){const item={json:{_http:status,_body:{}}};assert.equal(Response.normalizeResponse(item),item);}
 for(const item of [null,undefined,0,{json:null},{json:[]},{json:{_http:401}},{json:{_body:{}}}])assert.equal(Response.normalizeResponse(item),item);
});
test('recognized wrapper is idempotent and malformed or nested markers fail closed',()=>{
 const base='return [{json:{_http:401,_body:{erro:"synthetic"}}}];',wrapped=Response.finalizePrepareCode(base);
 assert.equal(wrapped,Response.PREFIX+base+Response.SUFFIX);assert.equal(Response.finalizePrepareCode(wrapped),wrapped);
 for(const damaged of [wrapped+'\n',wrapped.replace('route explicit','modified explicit'),wrapped.replace('map(', 'filter('),Response.PREFIX+wrapped+Response.SUFFIX,'// '+Response.MARKER+'\n'+base])assert.throws(()=>Response.finalizePrepareCode(damaged),/Unrecognized/);
 for(const code of [null,undefined,'','  '])assert.throws(()=>Response.finalizePrepareCode(code),/Expected/);
});
test('generated wrapper preserves n8n context and requires the array output contract',()=>{
 const code="const q=$('Synthetic request').first().json;return [{json:{_http:401,_body:{who:$json.who,marker:q.marker,count:$input.all().length}}}];";
 const result=execute(Response.finalizePrepareCode(code),{who:ACTOR},{$:()=>({first:()=>({json:{marker:'synthetic'}})}),$input:{all:()=>[{},{}]}})[0].json;
 assert.equal(result._step,'resposta');assert.deepEqual(JSON.parse(JSON.stringify(result._body)),{who:ACTOR,marker:'synthetic',count:2});
 assert.throws(()=>execute(Response.finalizePrepareCode('return {unexpected:true};'),{}),/Template output contract changed/);
});
test('receipt denials reach the existing Switch and Responde with the original HTTP body',()=>{
 const workflow=Patch.patchWorkflow(fixture(),{expectedVersionId:VERSION}).workflow;
 const query={acao:'operacao',operacao:'rascunho',idempotency_key:KEY};
 for(const [auth,q,method,status,error] of [
  [null,query,'GET',401,'invalid_key'],
  [{who:ACTOR,caps:['read_content']},query,'GET',403,'capability_missing'],
  [{who:'',caps:['draft']},query,'GET',403,'actor_unavailable'],
  [{who:ACTOR,caps:['draft']},{...query,operacao:'unexpected'},'GET',400,'operacao_invalida'],
  [{who:ACTOR,caps:['draft']},query,'POST',405,'metodo_invalido']
 ]){
  const result=prepare(workflow,auth,q,method),response=dispatchResponse(workflow,result);
  assert.equal(response.status,status);assert.equal(response.body.erro,error);assert.equal(response.body,result._body);assert.equal(Object.hasOwn(result,'sql'),false);assert.equal(Object.hasOwn(result,'sqlParameters'),false);
 }
 const success=prepare(workflow,{who:ACTOR,caps:[]},{acao:'existing'}),response=dispatchResponse(workflow,success);
 assert.equal(response.status,201);assert.equal(response.body.who,ACTOR);assert.equal(response.body.synthetic,true);
});
test('receipt lookup and existing SQL paths retain every query, parameter and routing field',()=>{
 const original=fixture(),workflow=Patch.patchWorkflow(original,{expectedVersionId:VERSION}).workflow,auth={who:ACTOR,caps:['draft']};
 const lookup=prepare(workflow,auth,{acao:'operacao',operacao:'rascunho',idempotency_key:KEY});
 assert.equal(lookup._step,'pg_leitura');assert.equal(lookup.sql,Receipt.SQL);assert.deepEqual(Array.from(lookup.sqlParameters),[KEY,ACTOR]);
 for(const action of ['sql_read','sql_write','explicit']){
  const before=prepare(original,auth,{acao:action}),after=prepare(workflow,auth,{acao:action});
  assert.equal(JSON.stringify(after),JSON.stringify(before),action);
 }
 assert.deepEqual(workflow.connections,original.connections);assert.deepEqual(workflow.settings,original.settings);
 assert.deepEqual(node(workflow,'PG leitura').credentials,node(original,'PG leitura').credentials);
 assert.deepEqual(node(workflow,'Existing transport'),node(original,'Existing transport'));
});
test('the canonical JSON stringification response contract preserves wire status and body',()=>{
 const fresh=fixture();node(fresh,'Responde').parameters.responseBody='={{ JSON.stringify($json._body) }}';
 const workflow=Patch.patchWorkflow(fresh,{expectedVersionId:VERSION}).workflow;
 for(const auth of [null,{who:ACTOR,caps:[]}]){
  const result=prepare(workflow,auth,{acao:'existing'}),response=dispatchResponse(workflow,result);
  assert.equal(response.status,auth?201:401);assert.deepEqual(response.body,JSON.parse(JSON.stringify(result._body)));
 }
 assert.equal(node(workflow,'Responde').parameters.responseBody,node(fresh,'Responde').parameters.responseBody);
});
test('receipt composition works before or after wrapping and never duplicates change records',()=>{
 const fresh=fixture(),snapshot=JSON.stringify(fresh),first=Patch.patchWorkflow(fresh,{expectedVersionId:VERSION});
 const wrappedFirst=Patch.patchWorkflow(fixture({wrapped:true}),{expectedVersionId:VERSION});
 assert.equal(JSON.stringify(fresh),snapshot,'input export remains unchanged');assert.deepEqual(wrappedFirst.workflow,first.workflow);
 assert.equal(first.changes.filter(c=>c.node==='Prepara'&&c.field==='jsCode').length,1);
 const repeated=Patch.patchWorkflow(first.workflow,{expectedVersionId:VERSION});assert.deepEqual(repeated.changes,[]);assert.deepEqual(repeated.workflow,first.workflow);
 assert.equal(node(first.workflow,'Prepara').parameters.jsCode.split(Response.MARKER).length,2);
});
test('a later anchored Code transformation preserves the wrapper and its finalization',()=>{
 const workflow=Patch.patchWorkflow(fixture(),{expectedVersionId:VERSION}).workflow,prepareNode=node(workflow,'Prepara');
 const anchor='return [out(201,{synthetic:true,who:auth.who})];';
 prepareNode.parameters.jsCode=prepareNode.parameters.jsCode.replace(anchor,"return [out(403,{erro:'synthetic_later_denial',who:auth.who})];");
 assert.equal(Response.finalizePrepareCode(prepareNode.parameters.jsCode),prepareNode.parameters.jsCode);
 const result=prepare(workflow,{who:ACTOR,caps:[]},{acao:'existing'}),response=dispatchResponse(workflow,result);
 assert.equal(response.status,403);assert.equal(response.body.erro,'synthetic_later_denial');assert.equal(response.body.who,ACTOR);
});
test('response graph drift is refused before a finalized export is returned',()=>{
 const mutations=[
  w=>{node(w,'Prepara').disabled=true;},
  w=>{w.connections.Prepara.main[0][0].node='Existing transport';},
  w=>{w.connections.Prepara.main[0][0].index=1;},
  w=>{node(w,'Etapa').parameters.rules.values[0].conditions.conditions[0].rightValue='different';},
  w=>{w.connections.Etapa.main[0][0].node='Existing transport';},
  w=>{node(w,'Responde').parameters.options.responseCode='200';},
  w=>{node(w,'Responde').parameters.responseBody='={{ $json.other }}';},
  w=>{node(w,'Responde').parameters.responseBody='={{ $json._body || $json.secret }}';},
  w=>{node(w,'Responde').parameters.responseBody='={{ JSON.stringify({...$json._body,changed:true}) }}';}
 ];
 for(const mutate of mutations){const workflow=fixture();mutate(workflow);const before=JSON.stringify(workflow);assert.throws(()=>Patch.patchWorkflow(workflow,{expectedVersionId:VERSION}),/changed|enabled/);assert.equal(JSON.stringify(workflow),before);}
});
