'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{parseHTML}=require('linkedom');
const source=process.env.CRM_PRODUCT_SOURCE||path.resolve(__dirname,'..');
const ui=process.env.CRM_PRODUCT_UI||path.join(source,'growth-flows-ui.js');
function boot(api={},brand='fish',observedOnly=true){
 const {document}=parseHTML('<html><body><input id="outside-draft" value="Rascunho preservado"><section id="control-fluxos"></section></body></html>');
 const context=vm.createContext({document,api,brand,observedOnly,fetch(){throw Error('UI_MUST_NOT_FETCH')}});
 for(const file of [path.join(source,'growth-table.js'),path.join(source,'growth-flows.js'),ui])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 vm.runInContext('let editorCalls=0;const GB={render(){editorCalls++}};GFU.render({api,marca:brand,observedOnly,ini:"2026-10-01",fim:"2026-10-06"})',context);
 return {document,root:document.querySelector('#control-fluxos'),run:code=>vm.runInContext(code,context)};
}
test('missing observed sources remain unavailable in both brands and never become zero journeys',()=>{
 for(const brand of ['fish','aristo']){
  const x=boot({},brand),text=x.root.textContent;
  assert.match(text,/Contagem indisponível/);assert.match(text,/Consulta de jornadas indisponível/);
  assert.doesNotMatch(text,/\b0 (?:fluxos|jornadas|com configuração|no histórico)/);
  assert.equal(x.root.querySelector('#fluxos-export'),null);assert.equal(x.run('editorCalls'),0);
 }
});
test('loaded empty arrays show zero loaded journeys without claiming no automation exists',()=>{
 for(const brand of ['fish','aristo']){
  const x=boot({crm_fluxo:[],crm_wa_envios:[]},brand);
  assert.match(x.root.textContent,/0 jornadas carregadas/);assert.match(x.root.textContent,/Ausência de linha não prova ausência de automação/);
  assert.doesNotMatch(x.root.textContent,/Consulta de jornadas indisponível/);
 }
});
test('malformed sources and arrays whose records cannot be displayed do not claim a confirmed zero',()=>{
 for(const api of [{crm_fluxo:{error:'not a collection'},crm_wa_envios:null},{crm_fluxo:{error:'not a collection'},crm_wa_envios:[]},{crm_fluxo:[],crm_wa_envios:{error:'not a collection'}},{crm_fluxo:[null],crm_wa_envios:[]}]){
  const x=boot(api);assert.match(x.root.textContent,/Contagem indisponível/);assert.doesNotMatch(x.root.textContent,/\b0 jornadas/);
 }
});
test('malformed definitions are unavailable in legacy view but never change corporate observed view',()=>{
 const api={crm_fluxo:[],crm_fluxo_def:{fluxos:{error:'not a collection'}}};
 const legacy=boot(api,'fish',false);assert.match(legacy.root.textContent,/Contagem indisponível/);assert.doesNotMatch(legacy.root.textContent,/0 jornadas/);
 const corporate=boot(api);assert.match(corporate.root.textContent,/0 jornadas carregadas/);assert.doesNotMatch(corporate.root.textContent,/Consulta de jornadas indisponível/);assert.equal(corporate.run('editorCalls'),0);
});
test('partial malformed source preserves valid cards while refusing a complete count',()=>{
 const api={crm_fluxo:{error:'not a collection'},crm_wa_envios:[{marca:'fish',dia:'2026-10-05',flow:'Carrinho parcial',piece:'Lembrete',canal:'whatsapp',aceitos:3,entregues:2}]},x=boot(api);
 assert.match(x.root.textContent,/Contagem indisponível/);assert.match(x.root.textContent,/Consulta de jornadas incompleta/);
 assert.match(x.root.textContent,/Carrinho parcial/);assert.match(x.root.textContent,/3 aceitos · 2 entregues/);assert.equal(x.root.querySelectorAll('[data-flow]').length,1);
});
test('incomplete source keeps real search and clear-filter recovery without losing loaded cards or drafts',()=>{
 const api={crm_fluxo:{error:'not a collection'},crm_wa_envios:[{marca:'fish',dia:'2026-10-05',flow:'Carrinho parcial',piece:'Lembrete',canal:'whatsapp',aceitos:3,entregues:2}]},before=JSON.stringify(api),x=boot(api);
 x.run('GFU.state.q="nenhuma correspondência";GFU.render()');
 assert.match(x.root.textContent,/Consulta de jornadas incompleta/);assert.match(x.root.textContent,/Nenhum fluxo com esses filtros/);
 assert.equal(x.root.querySelectorAll('[data-flow]').length,0);assert.equal(x.root.querySelector('#fluxos-export').disabled,true);
 x.root.querySelector('#fluxos-limpar').click();
 assert.equal(x.run('GFU.state.q'),'');assert.equal(x.root.querySelectorAll('[data-flow]').length,1);assert.match(x.root.textContent,/Carrinho parcial/);
 assert.match(x.root.textContent,/Contagem indisponível/);assert.equal(JSON.stringify(api),before);assert.equal(x.document.querySelector('#outside-draft').value,'Rascunho preservado');assert.equal(x.run('editorCalls'),0);
});
test('partial valid history is counted only as loaded journeys, preserving warning and unknown volume',()=>{
 const api={crm_fluxo:[null,{marca:'fish',dia:'2026-10-05',flow:'Carrinho',piece:'Lembrete',canal:'email',enviados:null}]},before=JSON.stringify(api),x=boot(api);
 assert.match(x.root.textContent,/1 jornada carregada/);assert.match(x.root.textContent,/1 linha\(s\).*inválido/);
 assert.match(x.root.textContent,/— envios registrados/);assert.doesNotMatch(x.root.textContent,/0 envios registrados/);
 assert.equal(JSON.stringify(api),before);
});
test('corporate observed view keeps the legacy editor and declared definitions outside its scope',()=>{
 const api={capabilities:{workflows:{editor:true}},crm_fluxo_def:{fluxos:[{nome:'Private legacy draft'}]}},before=JSON.stringify(api),x=boot(api);
 assert.match(x.root.textContent,/Consulta de jornadas indisponível/);assert.doesNotMatch(x.root.textContent,/Private legacy draft/);
 assert.equal(x.run('editorCalls'),0);assert.equal(JSON.stringify(api),before);
 assert.equal(x.document.querySelector('#outside-draft').value,'Rascunho preservado');
});
test('legacy declared configuration remains visible without observed history',()=>{
 const api={crm_fluxo_def:{generated_at:'2026-10-05T15:00:00Z',fluxos:[{key:'final',marca:'fish',nome:'Jornada declarada',gatilho:{evento:'checkout',chave_evento:'checkout_id',reentrada:'nunca',saida:[]},versao:{id:'v1',numero:1,ativa:false},modo:'sombra',etapas:[{key:'fim',tipo:'fim',ordem:1}]}]}},x=boot(api,'fish',false);
 assert.match(x.root.textContent,/1 jornada carregada/);assert.match(x.root.textContent,/Jornada declarada/);
 assert.doesNotMatch(x.root.textContent,/Consulta de jornadas indisponível/);
});
test('brand isolation and surrounding drafts survive loaded-to-unavailable updates',()=>{
 const api={crm_fluxo:[{marca:'fish',dia:'2026-10-05',flow:'Fish journey',piece:'Fish message',canal:'email',enviados:0},{marca:'aristo',dia:'2026-10-05',flow:'Aristo private',piece:'Aristo message',canal:'email',enviados:777}]},x=boot(api);
 assert.match(x.root.textContent,/1 jornada carregada/);assert.match(x.root.textContent,/0 envios registrados/);
 assert.doesNotMatch(x.root.textContent,/Aristo private|Aristo message|777/);
 x.run('GFU.render({api:{},marca:"aristo",observedOnly:true})');
 assert.match(x.root.textContent,/Contagem indisponível/);assert.doesNotMatch(x.root.textContent,/Fish journey|0 jornadas/);
 assert.equal(x.document.querySelector('#outside-draft').value,'Rascunho preservado');assert.equal(x.run('editorCalls'),0);
});
