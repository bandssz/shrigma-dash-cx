'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {evaluateTransactionOrder:guard,patchWorkflow,OLD_QUERY,NEW_QUERY,ANCHOR}=require('../n8n/growth/whatsapp-transaction-guard.cjs');
const now=Date.parse('2026-09-19T19:00:00Z'),request={order_id:'42',piece:'pedido-pago'};
const good=()=>({data:{order:{id:'gid://shopify/Order/42',test:false,cancelledAt:null,displayFinancialStatus:'PAID',transactions:[{kind:'SALE',status:'SUCCESS',test:false,processedAt:'2026-09-19T18:00:00Z'}]}}});
test('natural Shopify payment confirmation requires exact order, real capture and known cancellation state',()=>{
 assert.equal(guard(good(),request,now).eligible,true);
 for(const [field,value] of [['id','gid://shopify/Order/43'],['test',true],['test',undefined],['cancelledAt','2026-09-19T18:30:00Z'],['cancelledAt',undefined],['displayFinancialStatus','PENDING'],['displayFinancialStatus','AUTHORIZED'],['transactions',undefined],['transactions',[]]]){
  const response=good();response.data.order[field]=value;assert.equal(guard(response,request,now).eligible,false,field+':'+value);
 }
});
test('errors, authorization-only, failed/test/future/invalid dated transactions fail closed',()=>{
 assert.equal(guard({...good(),errors:[{message:'partial failure'}]},request,now).eligible,false);
 for(const change of [{kind:'AUTHORIZATION'},{status:'FAILURE'},{test:true},{test:undefined},{processedAt:'2026-09-19T20:00:00Z'},{processedAt:'2026-09-19T18:00:00'},{processedAt:'2026-02-30T18:00:00Z'},null]){
  const response=good();response.data.order.transactions=[change===null?null:{...response.data.order.transactions[0],...change}];
  assert.equal(guard(response,request,now).eligible,false,JSON.stringify(change));
 }
});
test('tracking also stops on cancellation, test, refund and unknown state without inventing a payment rule',()=>{
 const tracking={...request,piece:'rastreio-criado'};
 const response=good();delete response.data.order.transactions;response.data.order.displayFinancialStatus='PARTIALLY_REFUNDED';
 assert.equal(guard(response,tracking,now).eligible,true);
 for(const change of [{cancelledAt:'2026-09-19T18:30:00Z'},{cancelledAt:undefined},{test:true},{displayFinancialStatus:'REFUNDED'},{displayFinancialStatus:'VOIDED'},{displayFinancialStatus:'EXPIRED'},{displayFinancialStatus:undefined}]){
  const r=good();Object.assign(r.data.order,change);assert.equal(guard(r,tracking,now).eligible,false,JSON.stringify(change));
 }
});
const originalMount=`const saida=[];const rots=$('Roteia evento → peça').all();
$input.all().forEach((item,i)=>{const r=rots[i].json;
${ANCHOR}
saida.push({json:{_skip:null,piece:r.piece,ref:r.order_id}});});return saida;`;
const fresh=()=>({versionId:'fresh',nodes:[{name:'Roteia evento → peça',type:'n8n-nodes-base.code',parameters:{jsCode:OLD_QUERY}},{name:'Monta componentes',type:'n8n-nodes-base.code',parameters:{jsCode:originalMount}},{name:'motor',parameters:{unchanged:true}}],connections:{unchanged:true},settings:{unchanged:true}});
test('patched node routes cancelled/unpaid orders to the existing discarded path, and allows the proved order',()=>{
 const w=fresh(),p=patchWorkflow(w,{expectedVersionId:'fresh'}),code=p.workflow.nodes[1].parameters.jsCode;
 const paid=good(),pending=good(),cancelled=good();pending.data.order.displayFinancialStatus='PENDING';cancelled.data.order.cancelledAt='2026-09-19T18:30:00Z';
 const inputs=[paid,pending,cancelled].map(json=>({json}));
 const output=vm.runInNewContext('(function(){'+code+'})()',{$input:{all:()=>inputs},$:()=>({all:()=>inputs.map(()=>({json:request}))}),Date});
 assert.equal(output[0].json._skip,null);assert.equal(output[1].json._skip,'pedido_nao_pago');assert.equal(output[2].json._skip,'pedido_cancelado');
 assert.deepEqual(p.workflow.nodes[2],w.nodes[2]);assert.deepEqual(p.workflow.connections,w.connections);assert.deepEqual(p.workflow.settings,w.settings);
 assert.equal(p.changes.length,2);assert.ok(p.workflow.nodes[0].parameters.jsCode.includes(NEW_QUERY));assert.equal(w.nodes[1].parameters.jsCode,originalMount);
 assert.deepEqual(patchWorkflow(p.workflow,{expectedVersionId:'fresh'}).changes,[]);
 assert.throws(()=>patchWorkflow(w,{expectedVersionId:'old'}),/matching/);
 w.nodes[0].parameters.jsCode='changed';assert.throws(()=>patchWorkflow(w,{expectedVersionId:'fresh'}),/changed/);
});
