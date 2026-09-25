const test=require('node:test'),assert=require('node:assert/strict');
const {build}=require('../n8n/creators/partner-base-workflow.cjs'),C=require('../n8n/creators/partner-base-collector.cjs');
const {order,refund,money,page}=require('./fixtures/partner-base-synthetic.cjs');
const config={shops:['aristo','fish'].map(marca=>({marca,origin:'https://'+marca+'-synthetic.myshopify.com',credential:{id:marca+'-vault-id',name:marca}})),postgresCredential:{id:'pg-vault-id',name:'PG'}};
const workflow=()=>build(config);
const runCode=(w,name,json,lookup=()=>null,input={})=>new Function('$json','$','$input',w.nodes.find(n=>n.name===name).parameters.jsCode)(json,lookup,input);
test('workflow só usa referências de cofre, SQL bind, timezone e trigger privado opcional',()=>{
 const w=workflow();assert.equal(w.settings.timezone,'America/Sao_Paulo');assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveManualExecutions,false);
 assert.equal(w.nodes.find(n=>n.type.endsWith('scheduleTrigger')).parameters.rule.interval[0].expression,'27 6 * * *');
 for(const n of w.nodes.filter(n=>n.type.endsWith('httpRequest'))){assert.ok(n.credentials.httpHeaderAuth.id);assert.equal(n.parameters.options.response.response.neverError,false);assert.equal(n.maxTries,3);assert.equal(n.onError,'continueRegularOutput');}
 for(const n of w.nodes.filter(n=>n.type.endsWith('postgres')))assert.ok(n.parameters.options.queryReplacement);
 assert.equal(w.nodes.filter(n=>n.type.endsWith('webhook')).length,0);
 const withHook=build({...config,maintenanceTrigger:{path:'growth-financial-synthetic',credential:{id:'maintenance-vault-id'}}});
 const hook=withHook.nodes.find(n=>n.type.endsWith('webhook'));assert.equal(hook.parameters.authentication,'headerAuth');assert.equal(hook.parameters.httpMethod,'POST');assert.equal(hook.parameters.responseMode,'lastNode');
 assert.deepEqual(runCode(w,'Nenhum pedido',{})[0].json,{ok:true,pedidos:0,commission_payable:false});assert.equal(w.connections['Há pedidos'].main[1][0].node,'Nenhum pedido');
 assert.throws(()=>build({...config,maintenanceTrigger:{path:'bad',credential:{id:'x'}}}));
});
test('janela aceita body de webhook, valida datas e usa últimos367dias',()=>{
 const w=workflow();assert.deepEqual(runCode(w,'Janela de coleta',{body:{since:'2026-09-01',until:'2026-09-24'}})[0].json,{since:'2026-09-01',until:'2026-09-24'});
 assert.throws(()=>runCode(w,'Janela de coleta',{since:'not-a-date'}),/window/);
 const r=runCode(w,'Janela de coleta',{})[0].json;assert.equal((Date.parse(r.until)-Date.parse(r.since))/86400000,366);
});
test('grafo financeiro simulado percorre marca, todas conexões e preserva estado em cada loop',()=>{
 const w=workflow(),o=order({totalRefundedSet:money(30),displayFinancialStatus:'PARTIALLY_REFUNDED',refunds:[refund({items:30})]});
 for(const marca of ['aristo','fish']){
  let json=runCode(w,'Pedido em coleta',{marca,order_id:'1',dia:'2026-09-10'})[0].json,requests=0;
  while(!json.estado.done){
   const prepared=runCode(w,'Próxima consulta',json)[0].json,req=prepared.request;let body;
   if(req.query===C.ORDER_QUERY)body={data:{order:{...o,refunds:o.refunds.map(r=>({id:r.id}))}}};
   else{const field=['lineItems','shippingLines','refundLineItems','refundShippingLines','transactions'].find(f=>req.query.includes(f+'('));const source=req.variables.id===o.id?o:o.refunds[0];body={data:{node:{id:source.id,[field]:source[field]}}};}
   json=runCode(w,'Conferir resposta',{statusCode:200,body},()=>({item:{json:prepared}}))[0].json;assert.equal(json.failed,false);assert.ok(++requests<=7);
  }
  assert.equal(requests,7);assert.equal(json.estado.row.marca,marca);assert.equal(C.baseElegivel(json.estado.row).base_elegivel,70);
 }
});
test('erro por pedido sai sanitizado, segue lote e conclusão sinaliza falha',()=>{
 const w=workflow(),prepared=runCode(w,'Próxima consulta',runCode(w,'Pedido em coleta',{marca:'fish',order_id:'1'})[0].json)[0].json;
 for(const response of [{statusCode:429,body:{error:'private'}},{statusCode:200,body:{errors:[{message:'private'}]}},{error:{message:'private'}}]){
  const failed=runCode(w,'Conferir resposta',response,()=>({item:{json:prepared}}))[0].json;
  assert.equal(failed.failed,true);assert.equal(JSON.stringify(failed).includes('private'),false);
  assert.equal(w.connections['Coleta válida'].main[1][0].node,'Registrar falha');
  assert.throws(()=>runCode(w,'Concluir coleta',{},null,{all:()=>[{json:failed},{json:{resultado:{ok:true}}}]}),/1 pedido/);
 }
 assert.equal(runCode(w,'Concluir coleta',{},null,{all:()=>[{json:{resultado:{ok:true}}}]} )[0].json.commission_payable,false);
});
