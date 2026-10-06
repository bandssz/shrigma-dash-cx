'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const {fixture}=require('./growth-segment-fixture.cjs'),UI=require('../growth-segment-ui.js'),Slices=require('../growth-audience-slices-ui.js');
let parseHTML;
before(async()=>{parseHTML=process.env.AUDIENCE_SLICE_DOM_WORKER?(await import(pathToFileURL(process.env.AUDIENCE_SLICE_DOM_WORKER).href)).parseHTML:require('linkedom').parseHTML;});
function boot(f=fixture({version:'crm-audience-v2'})){
 const {document,window}=parseHTML('<html><body><section id="segments"></section></body></html>'),element=document.querySelector('#segments');
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(value){for(const o of this.options)o.toggleAttribute('selected',o.value===String(value));}});
 const ui=UI.create({element,document,key:()=> 'synthetic-slice-user',storage:f.storage,fetch:f.fetch,locks:f.locks}),q=s=>element.querySelector(s);
 const input=(selector,value,event='change')=>{q(selector).value=value;q(selector).dispatchEvent(new window.Event(event,{bubbles:true}));};
 return {f,ui,element,q,input,window};
}
async function settled(x){for(let i=0;i<100;i++){if(!x.ui.contextStatus().busy)return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI pending');}
test('Fatia do público is explicitly unavailable and cannot enter the existing v2 definition or count',async()=>{
 const x=boot(),payload=structuredClone(x.f.api);payload.capabilities.audience_slices={enabled:true,send:true,brands:['fish']};
 await x.ui.sync({api:payload,brand:'fish'});
 assert.equal(Slices.ENABLED,false);assert.ok(x.q('[data-gs-audience-slices]'));assert.match(x.q('[data-gs-audience-slices]').textContent,/Fatia do público/);assert.match(x.q('#gs-slices-status').textContent,/Indisponível.*Quantidade não informada/);assert.ok(x.q('[data-gs-audience-slices] fieldset').hasAttribute('disabled'));assert.equal(x.q('[data-gs-audience-slices] button').disabled,true);
 x.input('[data-gs-name]','Aquecimento Fishermans','input');x.input('[data-gs-list]','11');const before=x.f.store.get(UI.SLOT+'fish');
 x.q('[data-gs-audience-slices] input').value='10';x.q('[data-gs-audience-slices] input').dispatchEvent(new x.window.Event('input',{bubbles:true}));x.q('[data-gs-audience-slices] button').click();
 assert.equal(x.f.store.get(UI.SLOT+'fish'),before);assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);
 x.q('[data-gs="count"]').click();await settled(x);assert.match(x.q('[data-gs-count]').textContent,/7 pessoas/);const request=x.f.calls.find(c=>c.body.acao==='segmento_contar').body;assert.equal(request.definition.schema_version,'crm-audience-v2');assert.equal(JSON.stringify(request.definition).includes('slice'),false);assert.equal(request.definition.brand,'fish');
 assert.match(x.q('#gs-slices-status').textContent,/Quantidade não informada/);
});
test('brand navigation preserves existing independent drafts and never creates a distribution or claim',async()=>{
 const x=boot();await x.ui.sync({api:x.f.api,brand:'fish'});x.input('[data-gs-name]','Rascunho Fishermans','input');x.input('[data-gs-list]','11');const fish=x.f.store.get(UI.SLOT+'fish');
 await x.ui.sync({api:x.f.api,brand:'aristo'});assert.equal(x.q('[data-gs-name]').value,'');x.input('[data-gs-name]','Rascunho Aristo','input');x.input('[data-gs-list]','21');await x.ui.sync({api:x.f.api,brand:'fish'});
 assert.equal(x.q('[data-gs-name]').value,'Rascunho Fishermans');assert.equal(x.q('[data-gs-list]').value,'11');assert.equal(x.f.store.get(UI.SLOT+'fish'),fish);assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);assert.ok(x.f.calls.every(c=>['segmentos_listar'].includes(c.body.acao)));assert.match(x.q('[data-gs-audience-slices]').textContent,/tentativa sem confirmação/);
});
test('without the existing segment integration the editor makes no request or false audience-slice claim',async()=>{
 const x=boot();await x.ui.sync({api:{capabilities:{audience_slices:{enabled:true}}},brand:'fish'});assert.equal(x.f.calls.length,0);assert.match(x.element.textContent,/ainda não está disponível/);assert.equal(x.q('[data-gs-name]'),null);assert.equal(x.q('[data-gs-audience-slices]'),null);
});
