'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const day='2026-09-15';
function fixture(){return {crm_attribution:{schema_version:2,generated_at:day+'T14:00:00Z',coverage:[{brand:'fish',day,checked_at:day+'T13:00:00Z'}],quality:[{marca:'fish',dia:day,pedidos_lidos:4,pagos_elegiveis:3,pagos_com_ultima_sessao:2,pagos_sem_ultima_sessao:1,jornada_pendente:1,jornada_parcial:1}],daily:[],campaigns:[{marca:'fish',emissor:'fish',canal:'email',campanha_id:1,nome:'Campanha sintética',familia:'fixture',segmentos:['Recorrentes'],status:'finished',enviados:3,enviado_em:day+'T12:00:00Z',utms:[]}],dispatch_evidence:{schema_version:1,checked_at:day+'T13:30:00Z',daily:[]}}};}
function boot(api=fixture()){
 const {document,window}=parseHTML('<html><body><section id="attribution-status"></section><section id="attribution-campaigns"></section></body></html>');
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};Object.defineProperty(document,'activeElement',{get:()=>focused||document.body});
 const context=vm.createContext({document,window,Date,Intl});
 for(const file of ['growth-table.js','growth-ui.js','growth-attribution.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context,{filename:file});
 context.input=api;vm.runInContext(`globalThis.render=()=>GA.render({api:input,marca:'fish',ini:'2026-09-14',fim:'${day}',canal:'email',GUI,onModel:()=>{}});`,context);context.render();
 return {document,window,api,render:context.render,q:s=>document.querySelector(s)};
}
test('empty campaign search has a safe clear action that restores results and focus without changing the recorte',()=>{
 const x=boot(),before=JSON.stringify(x.api),summary=x.q('.ga-summary').textContent,input=x.q('#attribution-search');
 assert.equal(x.document.querySelectorAll('.ga-campaign').length,1);
 input.value='<img src=x onerror=fixture>';input.dispatchEvent(new x.window.Event('input'));
 assert.equal(x.document.querySelectorAll('.ga-campaign').length,0);assert.match(x.q('#attribution-list').textContent,/Nenhuma campanha ou segmento contém/);
 assert.equal(!!x.q('#attribution-list img'),false);assert.equal(x.q('#attribution-count').textContent,'0 iniciativas');
 x.q('#attribution-clear').click();assert.equal(input.value,'');assert.equal(x.document.activeElement.id,'attribution-search');
 assert.equal(x.document.querySelectorAll('.ga-campaign').length,1);assert.equal(x.q('.ga-summary').textContent,summary);assert.equal(JSON.stringify(x.api),before);
 x.render();assert.equal(x.q('#attribution-search').value,'');assert.equal(x.document.querySelectorAll('.ga-campaign').length,1);
});
test('a genuinely empty recorte explains which filters to check without claiming a search result or an action to open',()=>{
 const api=fixture();api.crm_attribution.campaigns=[];const x=boot(api);
 assert.match(x.q('#attribution-list').textContent,/Confira a marca, o canal e o período/);assert.equal(!!x.q('#attribution-clear'),false);
 assert.equal(x.q('#attribution-count').textContent,'0 iniciativas');
});
test('compact attribution keeps partial coverage and all source clocks visible, with methodology in a persistent detail',()=>{
 const x=boot(),bar=x.q('#attribution-status'),detail=bar.querySelector('details'),visible=bar.cloneNode(true);
 visible.querySelectorAll('details').forEach(el=>el.replaceWith(el.querySelector('summary').cloneNode(true)));
 assert.match(visible.textContent,/Cobertura parcial/);assert.match(visible.textContent,/Total parcial: dias sem conciliação/);
 assert.match(visible.textContent,/1 pedido\(s\) com jornada pendente/);assert.match(visible.textContent,/assistências podem estar incompletas/);
 for(const clock of ['15/09/2026, 10:00','15/09/2026, 11:00','15/09/2026, 10:30'])assert.ok(visible.textContent.includes(clock));
 assert.match(visible.textContent,/Horários de Brasília/);assert.match(visible.textContent,/Rastreamento · 1 pedido\(s\) sem última sessão/);
 assert.doesNotMatch(visible.textContent,/PIX copiado/);assert.match(detail.textContent,/não comprova clique nem venda adicional/);assert.match(detail.textContent,/Cobertura de leitura não garante rastreamento completo/);
 detail.open=true;x.render();assert.equal(x.q('#attribution-status details').open,true);
 x.api.crm_attribution.quality=[];x.render();assert.match(x.q('#attribution-status summary').textContent,/última sessão não informada/);
});
