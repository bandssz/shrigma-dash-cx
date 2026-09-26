'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom');
function boot(api,brand){
 const {document}=parseHTML('<html><body data-crm-view="manager"><section id="control-fluxos"></section></body></html>');
 const context=vm.createContext({document,api,brand});
 for(const file of ['growth-flows.js','growth-flows-ui.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+file),'utf8'),context);
 vm.runInContext("GFU.render({api,marca:brand,ini:'2026-09-01',fim:'2026-09-07'})",context);
 return {document,run:code=>vm.runInContext(code,context)};
}
function projection(root,role){const copy=root.cloneNode(true);copy.querySelectorAll(role==='owner'?'[data-crm-manager-only]':'[data-crm-owner-only]').forEach(el=>el.remove());return copy;}
test('fallback history is understandable in both brands while counts, missing configuration and alerts remain visible',()=>{
 for(const brand of ['fish','aristo']){
  const api={crm_fluxo:[{marca:brand,dia:'2026-09-07',flow:'carrinho',piece:'30min',canal:'email',enviados:12}],wa_fluxo_saude:[{brand,chave:'gatilho:'+brand+':30min',nome:'API · Listmonk synthetic',estado:'alerta',motivo:'workflow technical failure',verificado_em:'2026-09-07T15:00:00Z'}]},before=JSON.stringify(api),x=boot(api,brand),root=x.document.querySelector('#control-fluxos'),view=projection(root,'manager');
  assert.match(view.textContent,/Histórico de mensagens/);assert.match(view.textContent,/Configuração indisponível/);assert.match(view.textContent,/Sequência e esperas ainda não disponíveis; consulte Operação atual/);assert.match(view.textContent,/ordem alfabética, não na sequência de envio/);assert.match(view.textContent,/12 envios registrados/);assert.match(view.textContent,/Modelo da mensagem não informado/);assert.match(view.textContent,/Atenção nesta automação/);
  assert.doesNotMatch(view.innerHTML,/observado no motor|manifesto|Listmonk|\bAPI\b|workflow technical/i);assert.match(view.querySelector('.fluxo-chip').getAttribute('title'),/Verificado em 2026-09-07T15:00:00Z/);
  const owner=projection(root,'owner');assert.match(owner.textContent,/Workflow não declarado no manifesto/i);assert.match(owner.textContent,/API · Listmonk synthetic/);assert.match(owner.querySelector('.fluxo-chip').getAttribute('title'),/workflow technical failure/);
  assert.equal(JSON.stringify(api),before);assert.equal(x.run('GF.linhasCsv(GF.lista(api,{marca:brand}))[0].origem'),'observado no motor');assert.equal(root.querySelectorAll('[data-flow]').length,1);assert.equal(root.querySelector('[data-flow]').dataset.flow,brand+'|carrinho');assert.equal(root.querySelector('[data-flow]').dataset.origem,'observado');
 }
});
test('operational configuration labels keep uncertainty, partial coverage and inactive automations',()=>{
 const x=boot({},'fish');
 const label=(mode,steps)=>x.run('GFU.modoGerencia('+JSON.stringify({modo:{valor:mode},etapas:steps})+')');
 assert.equal(label('nao_confirmado',[{workflows:[{atual:false}]}]),'Configuração não confirmada');
 assert.equal(label('real',[{workflows:[{ativo:false}]},{workflows:[]}]),'Envio real configurado · parte das mensagens · automação inativa');
 assert.equal(label('sombra',[{workflows:[{ativo:true}]}]),'Simulação configurada');assert.equal(label('interno',[{workflows:[{ativo:true}]}]),'Envio interno configurado');
 const f={marca:'fish',flow:'carrinho',etapas:[],saude:[{estado:'other',motivo:'raw API detail'}],modo:{valor:'nao_confirmado',rotulo:'Modo não confirmado (consulta não confirmada em private-key)',tone:'warning'}};
 const {document}=parseHTML(x.run('GFU.observado('+JSON.stringify(f)+')')),manager=projection(document.querySelector('article'),'manager');assert.match(manager.textContent,/Verificação indisponível/);assert.doesNotMatch(manager.innerHTML,/private-key|raw API detail/);assert.equal(manager.querySelector('.fluxo-chip').dataset.estado,'desconhecido');
});
test('defined fallback preserves invalid counts and known descriptions while restricting validation and event identifiers to the owner',()=>{
 const api=JSON.parse(fs.readFileSync(require.resolve('./fixtures/growth-fluxo-def.synthetic.json'),'utf8')),before=JSON.stringify(api),x=boot(api,'todas'),root=x.document.querySelector('#control-fluxos'),manager=projection(root,'manager'),owner=projection(root,'owner');
 assert.match(manager.textContent,/2 fluxos não puderam ser carregados\. Consulte Operação atual/);assert.match(manager.textContent,/configuração disponível/);assert.match(manager.textContent,/Quando começa: Checkout criado sem pedido pago em 30 min/);assert.match(manager.textContent,/Regras de retorno e encerramento: consulte Operação atual/);
 for(const trigger of manager.querySelectorAll('.flow-trigger'))assert.doesNotMatch(trigger.textContent,/chave do evento|checkout_id|order_id|pedido_pago|checkout_abandonado|reentrada:/);
 assert.doesNotMatch(manager.textContent,/gatilho\.chave_evento|marca inválida|formato inválido ignorada/);assert.match(owner.textContent,/2 definição\(ões\).*quebrado/);assert.match(owner.textContent,/chave do evento checkout_id/);assert.equal(manager.querySelectorAll('[data-origem=definido]').length,2);assert.equal(JSON.stringify(api),before);
});
