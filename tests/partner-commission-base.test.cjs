const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../n8n/creators/partner-base-collector.cjs');
const {money,page,refund,order}=require('./fixtures/partner-base-synthetic.cjs');
const reais=require('./fixtures/partner-base-refunded-orders.json');
const row=o=>C.linhaDeBase(o,'aristocrata','2026-09-24T10:00:00Z');
const base=o=>C.baseElegivel(row(o));
test('produtos após desconto; frete fora; dados completos reconciliados',()=>{
 const r=row(order());assert.equal(r.marca,'aristo');assert.equal(r.itens[0].subtotal_apos_descontos,100);
 assert.deepEqual(base(order()),{base_elegivel:100,base_exata:true});assert.equal(C.comissao(100,0.07),7);
});
test('reembolso parcial só de produto é exato mesmo sem reembolso de frete',()=>{
 assert.deepEqual(base(order({displayFinancialStatus:'PARTIALLY_REFUNDED',totalRefundedSet:money(30),refunds:[refund({items:30})]})),{base_elegivel:70,base_exata:true});
});
test('só frete explícito é excluído; ajuste desconhecido não finge ser frete',()=>{
 assert.deepEqual(base(order({displayFinancialStatus:'PARTIALLY_REFUNDED',totalRefundedSet:money(20),refunds:[refund({shipping:20})]})),{base_elegivel:100,base_exata:true});
 assert.deepEqual(base(order({displayFinancialStatus:'PARTIALLY_REFUNDED',totalRefundedSet:money(20),refunds:[refund({amount:20})]})),{base_elegivel:80,base_exata:false});
});
test('impostos explicitados respeitam a mesma base do subtotal Shopify',()=>{
 const o=order({displayFinancialStatus:'PARTIALLY_REFUNDED',totalRefundedSet:money(33),refunds:[refund({items:30,itemTax:3})]});
 assert.deepEqual(base(o),{base_elegivel:70,base_exata:true});
 assert.deepEqual(base({...o,taxesIncluded:true}),{base_elegivel:67,base_exata:true});
});
test('refund existe mas transação falhou: não fecha comissão',()=>{
 const o=order({totalRefundedSet:money(30),refunds:[refund({items:30,status:'FAILURE'})]});
 assert.equal(base(o).base_exata,false);
});
test('cancelado, teste, integralmente reembolsado e não pago têm base zero',()=>{
 for(const o of [order({cancelledAt:'2026-09-11T12:00:00Z'}),order({test:true}),...['PENDING','AUTHORIZED','VOIDED','REFUNDED','PARTIALLY_PAID'].map(displayFinancialStatus=>order({displayFinancialStatus}))])assert.equal(base(o).base_elegivel,0);
});
test('todos os reembolsos/cancelamentos reais antigos seguem zero e não alegam detalhe novo',()=>{
 for(const [marca,orders] of Object.entries(reais))for(const o of orders){const b=C.baseElegivel(C.linhaDeBase(o,marca));assert.equal(b.base_elegivel,0,o.name);assert.equal(b.base_exata,false,o.name);}
});
test('dados truncados, item inconsistente ou financeiro inválido não fecham',()=>{
 const o=order();assert.equal(base({...o,lineItems:{...o.lineItems,pageInfo:{hasNextPage:true}}}).base_exata,false);
 assert.equal(base({...o,subtotalPriceSet:money(101)}).base_exata,false);
 assert.throws(()=>base({...o,totalRefundedSet:null}),/Invalid/);assert.throws(()=>base({...o,currencyCode:'USD'}),/BRL/);
 assert.throws(()=>base({...o,totalRefundedSet:money('NaN')}),/Invalid/);
});
test('dia é Brasília e ID preserva inteiro grande sem conversão numérica',()=>{
 assert.equal(C.diaBrasilia('2026-09-11T02:30:00Z'),'2026-09-10');assert.equal(C.diaBrasilia('inválido'),null);
 assert.equal(C.orderGid('9007199254740993'),'gid://shopify/Order/9007199254740993');assert.throws(()=>C.orderGid('bad'));
});
function transport(o,{changed=false,paginated=false,repeat=false,partial=false}={}) {
 let reads=0;const calls=[];
 return {calls,graphql:async req=>{
  calls.push(req);
  if(req.query===C.ORDER_QUERY){reads++;return {data:{order:{...o,updatedAt:changed&&reads>1?'2026-09-24T11:00:00Z':o.updatedAt,refunds:o.refunds.map(r=>({id:r.id}))}}};}
  const field=['lineItems','shippingLines','refundLineItems','refundShippingLines','transactions'].find(f=>req.query.includes(f+'('));
  const target=req.variables.id===o.id?o:o.refunds.find(r=>r.id===req.variables.id);
  let conn=target[field];
  if(paginated&&field==='lineItems')conn=req.variables.after&&!repeat?page([]):{...conn,pageInfo:{hasNextPage:true,endCursor:'c1'}};
  return {data:{node:{id:target.id,[field]:conn}},...(partial?{errors:[{message:'secret must never be exposed'}]}:{})};
 }};
}
test('coleta pagina conexões, revalida versão e mantém chave numérica do ledger',async()=>{
 const o=order({displayFinancialStatus:'PARTIALLY_REFUNDED',totalRefundedSet:money(30),refunds:[refund({items:30})]}),t=transport(o,{paginated:true});
 const r=await C.collectOrder({orderId:'1',marca:'fish',graphql:t.graphql,now:()=> '2026-09-24T10:00:00Z'});
 assert.equal(r.order_id,'1');assert.equal(r.detalhes_completos,true);assert.equal(t.calls.length,8);
 assert.equal(t.calls.filter(c=>c.query===C.ORDER_QUERY).length,2);
});
test('alteração durante coleta, paginação repetida e resposta parcial não geram snapshot',async()=>{
 for(const options of [{changed:true},{paginated:true,repeat:true},{partial:true}]){
  const t=transport(order(),options);await assert.rejects(C.collectOrder({orderId:'1',marca:'fish',graphql:t.graphql}),e=>!e.message.includes('secret'));
 }
 await assert.rejects(C.collectOrder({orderId:'1',marca:'fish',graphql:async()=>{throw Error('private token');}}),/financial request failed/);
});
test('limite de páginas e dia divergente rejeitam snapshot',async()=>{
 let t=transport(order(),{paginated:true});await assert.rejects(C.collectOrder({orderId:'1',marca:'fish',graphql:t.graphql,maxPages:1}),/limit/);
 t=transport(order());await assert.rejects(C.collectOrder({orderId:'1',marca:'fish',dia:'2026-09-11',graphql:t.graphql}),/scope/);
});
module.exports={transport};
