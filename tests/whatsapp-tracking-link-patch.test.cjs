'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const M=require('../n8n/growth/whatsapp-tracking-link-patch.cjs');
const request={order_id:'42',carrier:'Melhor Envio',tracking_number:'SYNTHETIC123'};
const response=()=>({data:{order:{id:'gid://shopify/Order/42',test:false,cancelledAt:null,displayFinancialStatus:'PAID',fulfillments:[{id:'gid://shopify/Fulfillment/1',status:'SUCCESS',trackingInfo:[{company:'Jadlog',number:'SYNTHETIC123',url:'https://www.melhorrastreio.com.br/rastreio/SYNTHETIC123'}]}]}}});
const catalog=brand=>['claro_v1',brand==='fish'?'v1':'v2'].map(v=>({brand,name:(brand==='fish'?'fishermans':'aristocrata')+'_rastreio_melhor_envio_'+v,status:'APPROVED',components:[{type:'BUTTONS',buttons:[{type:'URL',url:M.TRACKING_BUTTONS['Melhor Envio'].base},{type:'URL',url:'https://example.invalid/support'}]}]}));
test('retains the authoritative rastreio path and approved base instead of sending only the code',()=>{
 const result=M.resolveMelhorTracking(response(),request);
 assert.equal(result.ok,true);assert.equal(result.parameter,'rastreio/SYNTHETIC123');
 assert.equal(result.url,M.TRACKING_BUTTONS['Melhor Envio'].base.replace('{{1}}',result.parameter));
 assert.notEqual(result.url,'https://melhorrastreio.com.br/SYNTHETIC123');
 const r=response();r.data.order.fulfillments[0].trackingInfo[0].url='https://melhorrastreio.com.br/rastreio/SYNTHETIC123';
 assert.equal(M.resolveMelhorTracking(r,{...request,tracking_number:'LGI-SYNTHETIC123'}).ok,true);
});
test('wrong order, cancellation, unknown fields and unconfirmed fulfillment cannot provide a link',()=>{
 for(const change of [{id:'gid://shopify/Order/43'},{test:true},{test:undefined},{cancelledAt:'2026-09-19T00:00:00Z'},{cancelledAt:undefined},{displayFinancialStatus:'REFUNDED'},{fulfillments:undefined}]){
  const r=response();Object.assign(r.data.order,change);assert.equal(M.resolveMelhorTracking(r,request).ok,false);
 }
 const r=response();r.data.order.fulfillments[0].status='CANCELLED';assert.equal(M.resolveMelhorTracking(r,request).ok,false);
 assert.equal(M.resolveMelhorTracking({...response(),errors:[{message:'partial'}]},request).ok,false);
 const full=response();full.data.order.fulfillments=Array.from({length:20},()=>full.data.order.fulfillments[0]);assert.equal(M.resolveMelhorTracking(full,request).reason,'rastreio_fulfillment_parcial');
});
test('source URL must match both the exact provider path and the same fulfillment tracking number',()=>{
 for(const url of ['https://evil.invalid/rastreio/SYNTHETIC123','https://www.melhorrastreio.com.br.evil.invalid/rastreio/SYNTHETIC123','http://www.melhorrastreio.com.br/rastreio/SYNTHETIC123','https://user@www.melhorrastreio.com.br/rastreio/SYNTHETIC123','https://www.melhorrastreio.com.br/SYNTHETIC123','https://www.melhorrastreio.com.br/rastreio/OTHER','https://www.melhorrastreio.com.br/rastreio/SYNTHETIC123?cpf=private','https://www.melhorrastreio.com.br/rastreio/SYNTHETIC123#fragment','https://www.melhorrastreio.com.br/rastreio/%2fescape']){
  const r=response();r.data.order.fulfillments[0].trackingInfo[0].url=url;assert.equal(M.resolveMelhorTracking(r,request).ok,false,url);
 }
 assert.equal(M.resolveMelhorTracking(response(),{...request,tracking_number:'OTHER'}).ok,false);
 const r=response();r.data.order.fulfillments[0].trackingInfo.push({...r.data.order.fulfillments[0].trackingInfo[0],url:'https://www.melhorrastreio.com.br/rastreio/LGI-SYNTHETIC123'});
 assert.equal(M.resolveMelhorTracking(r,request).reason,'rastreio_url_ambigua');
});
function fixture(brand){
 const mount=brand==='fish'?`const saida=[];const r=$request;const item={json:$response};const code=r.tracking_number;const o=item.json.data.order;
function apply(){
${M.FISH_BUTTON}
saida.push({json:{parameter:btn}});}
apply();return saida;`:`const r=$request;const item={json:$response};const code=r.tracking_number;const o=item.json.data.order;const direto={id:'synthetic'};let tpl,bloqueio=null,components;const txt=a=>a;
${M.ARISTO_ANCHOR}
components=[{${M.ARISTO_BUTTON}}];return {components,bloqueio};`;
 return {versionId:'fresh',nodes:[{name:'Roteia evento → peça',type:'n8n-nodes-base.code',parameters:{jsCode:brand==='fish'?M.FISH_QUERY:M.ARISTO_QUERY}},{name:'Monta componentes',type:'n8n-nodes-base.code',parameters:{jsCode:mount}},{name:'motor',parameters:{safe:true}}],connections:{safe:true},settings:{safe:true}};
}
test('patch is version bound, preserves templates and unrelated nodes, and refuses changed approval',()=>{
 for(const brand of ['fish','aristo']){
  const w=fixture(brand),copy=structuredClone(w),c=catalog(brand),p=M.patchWorkflow(w,{brand,expectedVersionId:'fresh',approvedCatalog:c});
  assert.deepEqual(w,copy);assert.equal(p.changes.length,2);assert.deepEqual(p.workflow.nodes[2],w.nodes[2]);assert.deepEqual(p.workflow.connections,w.connections);assert.deepEqual(p.workflow.settings,w.settings);
  assert.deepEqual(M.patchWorkflow(p.workflow,{brand,expectedVersionId:'fresh',approvedCatalog:c}).changes,[]);
  assert.throws(()=>M.patchWorkflow(w,{brand,expectedVersionId:'old',approvedCatalog:c}),/matching/);
  c[0].components[0].buttons[0].url='https://example.invalid/{{1}}';assert.throws(()=>M.patchWorkflow(w,{brand,expectedVersionId:'fresh',approvedCatalog:c}),/contract changed/);
 }
});
test('Fish patched node discards mismatch and changes only Melhor Envio parameter',()=>{
 const p=M.patchWorkflow(fixture('fish'),{brand:'fish',expectedVersionId:'fresh',approvedCatalog:catalog('fish')});
 const run=(req,res)=>vm.runInNewContext('(function(){'+p.workflow.nodes[1].parameters.jsCode+'})()',{$request:req,$response:res});
 assert.equal(run(request,response())[0].json.parameter,'rastreio/SYNTHETIC123');
 assert.equal(run({...request,carrier:'Loggi'},response())[0].json.parameter,'SYNTHETIC123');
 assert.equal(run({...request,tracking_number:'OTHER'},response())[0].json._skip,'rastreio_sem_fulfillment_correspondente');
});

test('Aristo patched node preserves existing block while refusing unrelated fulfillment',()=>{
 const p=M.patchWorkflow(fixture('aristo'),{brand:'aristo',expectedVersionId:'fresh',approvedCatalog:catalog('aristo')});
 const run=(req,res)=>vm.runInNewContext('(function(){'+p.workflow.nodes[1].parameters.jsCode+'})()',{$request:req,$response:res});
 assert.equal(run(request,response()).components[0].parameters[0],'rastreio/SYNTHETIC123');
 assert.equal(run(request,response()).bloqueio,null);
 assert.equal(run({...request,tracking_number:'OTHER'},response()).bloqueio,'rastreio_sem_fulfillment_correspondente');
});
