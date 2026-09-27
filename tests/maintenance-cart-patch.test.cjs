'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {workflow}=require('./maintenance-cart-fixture.cjs');
const {digest,patchCartProducer,buildCartConsumer}=require('../n8n/growth/maintenance-cart-patch.cjs');
const guard=w=>({version:w.versionId,workflowHash:digest(w),connectionsHash:digest(w.connections)});
const clone=x=>JSON.parse(JSON.stringify(x));
const code=(src,ctx)=>vm.runInNewContext('(function(){'+src+'})()',ctx);
test('producer patch changes exactly three SQL bodies, preserving graph and all other brands/transport/settings',()=>{
 const w=workflow(),original=clone(w),patched=patchCartProducer(w,guard(w));assert.deepEqual(w,original);assert.deepEqual(patched.connections,w.connections);
 const changes=patched.nodes.filter((n,i)=>digest(n)!==digest(w.nodes[i])).map(n=>n.name);assert.deepEqual(changes,['Elegíveis (PG)','R4 reserva carrinho','R4 finaliza carrinho']);
 const before=clone(w),after=clone(patched);for(const name of changes){delete before.nodes.find(n=>n.name===name).parameters.query;delete after.nodes.find(n=>n.name===name).parameters.query;}assert.deepEqual(after,before);
 assert.match(patched.nodes.find(n=>n.name==='Elegíveis (PG)').parameters.query,/\$2::text IN \('fish','aristo'\)/);
});
test('source version/hash/graph and known claim/brand/transport guards all fail closed',()=>{
 const w=workflow();for(const g of [{...guard(w),version:'stale'},{...guard(w),workflowHash:'bad'},{...guard(w),connectionsHash:'bad'}])assert.throws(()=>patchCartProducer(w,g),/VERSION_HASH/);
 for(const mutate of [w=>w.nodes.find(n=>n.name==='R4 Listmonk carrinho').retryOnFail=true,w=>w.nodes.find(n=>n.name==='R4 reserva carrinho').parameters.options.queryBatching='transaction',w=>w.nodes.find(n=>n.name==='R4 carrinho Fish Aristo').parameters.conditions.conditions[0].leftValue='true',w=>w.connections['R4 reserva carrinho'].main[0].push({node:'Envia /api/tx',type:'main',index:0})]){
  const x=clone(w);mutate(x);assert.throws(()=>patchCartProducer(x,guard(x)),/DRIFT|GUARD/);
 }
});
test('consumer remains inactive, bounded to 20 independent turns and no Olivas/non-cart path',()=>{
 const w=workflow(),c=buildCartConsumer(w,guard(w));assert.equal(c.active,false);assert.equal(c.nodes.length,7);assert.equal(c.nodes.filter(n=>n.type.endsWith('.httpRequest')).length,1);
 assert.equal(c.settings.saveDataSuccessExecution,'none');assert.equal(c.settings.saveDataErrorExecution,'none');assert.equal(c.settings.saveExecutionProgress,false);
 const turns=code(c.nodes.find(n=>n.name==='Dez tentativas por marca').parameters.jsCode,{});assert.equal(turns.length,20);assert.equal(turns.filter(n=>n.json.brand==='fish').length,10);assert.equal(turns.filter(n=>n.json.brand==='aristo').length,10);
 const reserve=c.nodes.find(n=>n.name==='R4 reserva carrinho');assert.equal(reserve.parameters.options.queryBatching,'independently');assert.equal(reserve.retryOnFail,false);assert.match(reserve.parameters.query,/cart_next_v1/);
 for(const name of ['R4 vencedores carrinho','R4 Listmonk carrinho','R4 classifica carrinho','R4 finaliza carrinho']){
  const original=clone(w.nodes.find(n=>n.name===name)),copied=clone(c.nodes.find(n=>n.name===name));for(const key of ['id','position']){delete original[key];delete copied[key];}if(name==='R4 finaliza carrinho'){assert.match(copied.parameters.query,/cart_finish_v1/);delete original.parameters.query;delete copied.parameters.query;}assert.deepEqual(copied,original);
 }
});
test('reused winner keeps item pairing and only sends true; original classifier preserves unknown',()=>{
 const w=workflow(),c=buildCartConsumer(w,guard(w)),payload={synthetic:'unchanged'},token='same-original-token',context={brand:'fish'};
 const input=[{json:{should_send:false,event_id:'retained'}},{json:{should_send:true,event_id:'one',dispatch_id:'original',claim_token:token,payload,context}},{json:{should_send:false,event_id:'unknown'}}];
 const winners=code(c.nodes.find(n=>n.name==='R4 vencedores carrinho').parameters.jsCode,{$input:{all:()=>input}});assert.equal(winners.length,1);assert.equal(winners[0].pairedItem.item,1);assert.equal(winners[0].json,input[1].json);
 const classify=c.nodes.find(n=>n.name==='R4 classifica carrinho').parameters.jsCode;
 for(const [response,outcome] of [[{statusCode:200,body:{data:true}},'accepted'],[{statusCode:422},'rejected'],[{error:'timeout'},'outcome_unknown'],[{statusCode:200,body:{data:false}},'outcome_unknown']])assert.equal(code(classify,{$json:response}).json.outcome,outcome);
 const expression=c.nodes.find(n=>n.name==='R4 finaliza carrinho').parameters.options.queryReplacement.slice(3,-2);
 const args=vm.runInNewContext(expression,{$:name=>{assert.equal(name,'R4 reserva carrinho');return {item:input[1]};},$json:{outcome:'accepted'},JSON});
 assert.equal(args[0],'original');assert.equal(args[1],token);assert.equal(args[2],'accepted');assert.deepEqual(JSON.parse(args[3]),context);
});
