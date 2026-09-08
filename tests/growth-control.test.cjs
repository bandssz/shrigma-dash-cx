const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const GC=require('../growth-control.js');
const {parseHTML}=require(require.resolve('linkedom',{paths:[path.resolve(__dirname,'../../growth-test-tools/node_modules')]}));
const fixture=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
const now=Date.parse('2026-09-08T01:10:00Z');
function render(payload=fixture(),options={}){
 const html=fs.readFileSync(path.join(__dirname,'../growth.html'),'utf8'),{document,window}=parseHTML(html);
 const context=vm.createContext({document,window,Date,Intl,console});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../growth-control.js'),'utf8'),context);
 context.ctx={api:{crm_operacao:payload},now,...options};
 vm.runInContext('GC.init();GC.render(ctx);',context);
 return {document,window,run:source=>vm.runInContext(source,context)};
}
test('marca e canal mantêm serviços compartilhados e não filtram pelo período histórico',()=>{
 const payload=fixture(),model=GC.model(payload,{now,marca:'fish',canal:'whatsapp',ini:'2020-01-01',fim:'2020-01-02'});
 assert.deepEqual(model.workflows.map(row=>row.key),['fish_tx','shared_monitor']);
 assert.deepEqual(model.templates.map(row=>row.key),['fish_paid','fish_native']);
 const email=GC.model(payload,{now,marca:'aristo',canal:'email'});
 assert.deepEqual(email.workflows.map(row=>row.key),['shared_email','shared_monitor']);assert.equal(email.templates.length,0);
});
test('ausência, schema incompatível, metadata inválida e coleta vencida nunca têm template verde',()=>{
 for(const mutate of [()=>null,p=>({...p,schema_version:2}),p=>({...p,refresh_interval_seconds:null}),p=>({...p,stale_after_seconds:9999}),p=>({...p,generated_at:'2026-09-08T00:55:00Z'}),p=>({...p,generated_at:'amanhã'}),p=>({...p,generated_at:'2026-09-08T02:00:00Z'})]){
  const x=render(mutate(fixture()));assert.equal(x.document.querySelectorAll('.control-verified').length,0);
 }
 const x=render(null);assert.match(x.document.querySelector('#control-workflows').textContent,/indisponível/);
 assert.deepEqual([...x.document.querySelectorAll('.control-summary strong')].map(node=>node.textContent),['—','—','—']);
});
test('data, status, categoria, identidade e campos inválidos não são apresentados como aprovação verificada',()=>{
 for(const change of [t=>delete t.checked_at,t=>t.last_good_at='2026-09-08T00:55:00Z',t=>t.checked_at='2026-09-08T03:00:00Z',t=>t.collection_status='unknown',t=>t.collection_status='error',t=>t.category_matches_expected='true',t=>t.status='PENDING',t=>t.category='nova_categoria',t=>delete t.name,t=>delete t.id,t=>delete t.channel,t=>t.usage='qualquer']){
  const p=fixture();change(p.templates[0]);const x=render(p),row=x.document.querySelector('[data-control-template="fish_paid"]');
  assert.equal(row.querySelectorAll('.control-verified').length,0);
 }
});
test('reclassificação e reprovação têm alerta factual sem alegar causa ou trocar template',()=>{
 const p=fixture();Object.assign(p.templates[0],{category:'MARKETING',category_matches_expected:false,status:'REJECTED'});
 const x=render(p),row=x.document.querySelector('[data-control-template="fish_paid"]');
 assert.match(row.textContent,/Categoria recebida: MARKETING; esperada: UTILITY/);
 assert.match(row.textContent,/Status recebido: REJECTED/);assert.equal(row.querySelectorAll('.control-verified').length,0);
 assert.equal(row.querySelectorAll('button,a').length,0);
});
test('cartão aprovado permanece planejado e template mapeado não implica envio',()=>{
 const x=render(),native=x.document.querySelector('[data-control-template="fish_native"]'),current=x.document.querySelector('[data-control-template="aristo_paid"]');
 assert.match(native.textContent,/APPROVED/);assert.match(native.textContent,/Integração pendente · ainda fora do envio/);assert.equal(native.querySelectorAll('.control-verified').length,0);
 assert.match(current.textContent,/Mapeado no fluxo · envio depende da ativação/);
});
test('última execução retida com erro não vira falha atual, inclusive quando sucesso não é salvo',()=>{
 const x=render(),card=x.document.querySelector('[data-control-workflow="fish_tx"]');
 assert.match(card.textContent,/Consulta atual/);assert.match(card.textContent,/Erro registrado/);
 assert.match(card.textContent,/não salva execuções concluídas/);assert.match(card.textContent,/não comprova entrega ao cliente/);
 assert.equal(GC.model(fixture(),{now}).workflows[0].attention,false);
 assert.match(x.document.querySelector('[data-control-workflow="aristo_tx"]').textContent,/Pedido pago: sombra · Rastreio: sombra/);
});
test('falha de coleta mantém hora da última consulta válida e não rotula estado como atual',()=>{
 const p=fixture();Object.assign(p.workflows[0],{collection_status:'error',active:null,published:null,checked_at:'2026-09-08T01:09:00Z',last_good_at:'2026-09-07T23:30:00Z'});
 const x=render(p),card=x.document.querySelector('[data-control-workflow="fish_tx"]');
 assert.match(card.textContent,/Falha na consulta/);assert.match(card.textContent,/Ativação desconhecida/);
 assert.match(card.textContent,/Última consulta válida: 07\/09\/2026, 20:30/);assert(!card.textContent.includes('Consulta atual'));
});
test('abas funcionam por clique e teclado e pesquisa mantém filtro durante a troca',()=>{
 const x=render();x.document.querySelector('[data-control-tab="templates"]').click();
 assert.equal(x.document.querySelector('#control-history').hidden,true);assert.equal(x.document.querySelector('#control-templates').hidden,false);
 const input=x.document.querySelector('#control-template-search');input.value='card';input.dispatchEvent(new x.window.Event('input'));
 assert.equal(x.document.querySelectorAll('[data-control-template]').length,1);
 x.document.querySelector('[data-control-tab="workflows"]').click();assert.equal(x.document.querySelector('#control-workflows').hidden,false);
 const event=new x.window.Event('keydown');event.key='ArrowLeft';x.document.querySelector('[data-control-tab="workflows"]').dispatchEvent(event);
 assert.equal(x.document.querySelector('#control-history').hidden,false);
 x.run('GC.render(ctx)');assert.equal(x.document.querySelector('#control-template-search').value,'card');
});
test('reconsulta preserva detalhes abertos e envelhece a coleta mesmo sem payload novo',()=>{
 const x=render();x.document.querySelector('[data-control-workflow="fish_tx"] details').open=true;
 x.run('ctx.now+=16*60*1000;GC.render(ctx)');
 assert.equal(x.document.querySelector('[data-control-workflow="fish_tx"] details').open,true);
 assert.equal(x.document.querySelectorAll('.control-verified').length,0);
 assert.match(x.document.querySelector('#control-workflows').textContent,/desatualizada/);
});
test('campos textuais são escapados e modo de retry não é inventado',()=>{
 const p=fixture();p.workflows[0].label='<img src=x onerror=alert(1)>';p.templates[0].name='<svg onload=alert(1)>';p.workflows[0].modes=[];p.workflows[0].mode_source='upstream';
 const x=render(p);assert.equal(x.document.querySelectorAll('#control-workflows img,#control-templates svg,[onerror],[onload]').length,0);
 assert.match(x.document.querySelector('[data-control-workflow="fish_tx"]').textContent,/Segue o modo da automação de origem/);
});
test('filtro e-mail explica catálogo WhatsApp e marca sem cobertura não esconde compartilhados',()=>{
 const x=render(fixture(),{marca:'olivas',canal:'email'});
 assert.match(x.document.querySelector('#control-templates').textContent,/Selecione WhatsApp ou Todos os canais/);
 assert.match(x.document.querySelector('#control-workflows').textContent,/Nenhuma automação específica de Olivas/);
 assert.equal(x.document.querySelectorAll('[data-control-workflow]').length,2);
});
test('conferência manual não promete coleta automática e envelhece após 15 minutos',()=>{
 const p=fixture();p.collection_mode='manual';p.refresh_interval_seconds=0;
 const x=render(p);assert.match(x.document.querySelector('#control-workflows').textContent,/Conferência pontual · atualização automática pendente/);
 assert(!x.document.querySelector('#control-workflows').textContent.includes('Coleta automática a cada'));
 assert.equal(x.document.querySelectorAll('[data-control-template="fish_paid"] .control-verified').length,2);
 x.run('ctx.now+=16*60*1000;GC.render(ctx)');assert.equal(x.document.querySelectorAll('.control-verified').length,0);
});
test('modo de coleta ausente ou desconhecido não promete periodicidade',()=>{
 const p=fixture();delete p.collection_mode;
 const x=render(p);assert.match(x.document.querySelector('#control-workflows').textContent,/Periodicidade de coleta não confirmada/);
 assert(!x.document.querySelector('#control-workflows').textContent.includes('Coleta automática a cada'));
 p.collection_mode='invalid';const y=render(p);assert.equal(y.document.querySelectorAll('.control-verified').length,0);
});
