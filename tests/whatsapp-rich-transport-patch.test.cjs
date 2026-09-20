'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const WAT=require('../whatsapp-template-contract.js');
const {patch,ANCHOR,INSERT,BEFORE_FIELDS}=require('../n8n/growth/whatsapp-rich-transport-patch.cjs');
function message(){return {flow:'transacional',piece:'pedido-pago',template_id:'42',template_name:'synthetic_order',language:'pt_BR',components:[{type:'body',parameters:[{type:'text',text:'Cliente de teste'}]}]};}
function template(){return {id:'42',name:'synthetic_order',language:'pt_BR',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'Olá {{1}}'}]};}
function workflow(){return {active:true,versionId:'synthetic-v1',settings:{executionOrder:'v1'},connections:{preserved:{main:[]}},nodes:[
 {name:'Valida template UTILITY',type:'n8n-nodes-base.code',parameters:{jsCode:"const WAT={runtime(input,template){\n"+ANCHOR+"\nreturn null;}};\nconst input=$('Prepara guarda UTILITY').item.json,response=$json;const reason=WAT.runtime(input,response.body);return reason?{utility_guard_ok:false,reason}:{utility_guard_ok:true};"}},
 {name:'Meta /template UTILITY',type:'n8n-nodes-base.httpRequest',credentials:{httpHeaderAuth:{id:'synthetic-only'}},parameters:{method:'GET',url:'https://graph.facebook.com/v21.0/42',queryParameters:{parameters:[{name:'fields',value:BEFORE_FIELDS}]}}},
 {name:'Guarda + reserva (PG)',type:'n8n-nodes-base.postgres',parameters:{query:'SELECT 1 /* unchanged synthetic guard */'}},
 {name:'Meta /messages',type:'n8n-nodes-base.httpRequest',parameters:{method:'POST',url:'https://example.invalid/no-send'}}]};}
test('native receipt cannot pass generic BODY-only sender even when approved or falsely flagged as ready',()=>{
 for(const extra of [{},{native_receipt_ready:true,transport:'customer_events'},{modo:'interno'}])assert.equal(WAT.runtime({...message(),...extra},{...template(),sub_category:'RICH_ORDER_STATUS'}),'template_recibo_nativo_transporte_nao_integrado');
 assert.equal(WAT.runtime(message(),template()),null);
 assert.equal(WAT.runtime(message(),{...template(),sub_category:'CUSTOM'}),null);
 assert.equal(WAT.runtime(message(),{...template(),status:'PAUSED',sub_category:'RICH_ORDER_STATUS'}),'template_nao_aprovado_ou_divergente');
});
test('fresh patch changes only metadata fields and contract while preserving guards, transport, credentials and wiring',()=>{
 const before=workflow(),result=patch(before),after=result.workflow;
 assert.equal(before.nodes[1].parameters.queryParameters.parameters[0].value,BEFORE_FIELDS);
 assert.equal(after.nodes[1].parameters.queryParameters.parameters[0].value,BEFORE_FIELDS+',sub_category');
 after.nodes[0].parameters.jsCode=after.nodes[0].parameters.jsCode.replace(INSERT,'');
 after.nodes[1].parameters.queryParameters.parameters[0].value=BEFORE_FIELDS;
 assert.deepEqual(after,before);
});
test('patched actual Code shape refuses native receipt before continuing to reservation',()=>{
 const code=patch(workflow()).workflow.nodes[0].parameters.jsCode;
 for(const rich of [false,true]){
  const c=vm.createContext({$:()=>({item:{json:message()}}),$json:{body:{...template(),...(rich?{sub_category:'RICH_ORDER_STATUS'}:{})}}});
  const result=vm.runInContext('(function(){'+code+'})()',c);
  assert.equal(result.utility_guard_ok,!rich);
 }
});
test('drift, duplicate fields, duplicate nodes and a repeated patch require review',()=>{
 for(const change of [w=>w.nodes[0].parameters.jsCode=w.nodes[0].parameters.jsCode.replace(ANCHOR,'changed'),w=>w.nodes[1].parameters.queryParameters.parameters[0].value='changed',w=>w.nodes[1].parameters.queryParameters.parameters.push({name:'fields',value:BEFORE_FIELDS}),w=>w.nodes.push(w.nodes[0])]){const w=workflow();change(w);assert.throws(()=>patch(w));}
 assert.throws(()=>patch(patch(workflow()).workflow));
});
