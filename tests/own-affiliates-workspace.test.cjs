'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom'),V=require('../afiliados-proprios.js');
function fixture(){
 const {document,window}=parseHTML('<main id="host"></main>'),host=document.getElementById('host');
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||''},set(v){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(v))}});
 const data={schema:'shrigma-own-affiliates-read-v1',brand:'fish',janela:{ini:'2026-10-01',fim:'2026-10-12'},gerado_em:'2026-10-13T00:00:00Z',programs:[{rate:.05}],candidates:[{id:'one',name:'André Synthetic',handle:'@one',state:'novo',version:1},{id:'two',name:'Bia Synthetic',handle:'@two',state:'aprovado_piloto',version:2}],links:[{candidate_id:'two',ref:'live-ref',state:'ativo',url:'https://fishermans.com.br/?ref=live-ref'}],partner_orders:[{ref:'live-ref',pedidos:2,base_elegivel:null,comissao:null}],editAvailable:true,pendingEdits:[]};
 V.render(host,data);return {host,window,data};
}
test('search is accent-insensitive and combined with state and explicit link',()=>{
 const {host,window}=fixture(),input=host.querySelector('[data-own-search]');input.value='andre';input.dispatchEvent(new window.Event('input'));assert.equal(host.querySelector('[data-own-count]').textContent,'1 de 2 cadastros');
 host.querySelector('[data-own-pipeline="no_link"]').click();assert.equal(host.querySelector('[data-own-count]').textContent,'1 de 2 cadastros');
 input.value='live-ref';input.dispatchEvent(new window.Event('input'));assert.equal(host.querySelector('[data-own-count]').textContent,'0 de 2 cadastros');assert.equal(host.querySelector('[data-own-empty]').hidden,false);
 host.querySelector('[data-own-clear]').click();assert.equal(host.querySelector('[data-own-count]').textContent,'2 de 2 cadastros');
});
test('filtering keeps already bound review buttons and pending-operation checks intact',()=>{
 const {host,window,data}=fixture();data.pendingEdits=[{candidate_id:'two',request_id:'existing'}];V.render(host,data);const button=host.querySelector('[data-own-affiliate-review]');let clicks=0;button.addEventListener('click',()=>clicks++);
 const input=host.querySelector('[data-own-search]');input.value='absent';input.dispatchEvent(new window.Event('input'));assert(host.querySelector('[data-own-affiliate-operation]'));host.querySelector('[data-own-clear]').click();assert.equal(host.querySelector('[data-own-affiliate-review]'),button);button.click();assert.equal(clicks,1);
});
test('partner detail preserves unknown amounts, live reference and missing closing',()=>{
 const {host}=fixture();host.querySelector('[data-own-affiliate-detail="two"]').click();const detail=host.querySelector('[data-own-detail]');assert.equal(detail.hidden,false);assert.match(detail.textContent,/Indisponível/);assert.match(detail.textContent,/não confirma pagamento/);assert.match(detail.textContent,/Fechamento indisponível/);assert.equal(detail.querySelector('a').getAttribute('href'),'https://fishermans.com.br/?ref=live-ref');detail.querySelector('[data-own-detail-close]').click();assert(detail.hidden);
});
test('detail escapes labels and zero is shown only when measured',()=>{
 const {host,data}=fixture();data.candidates[1].name='<img onerror="unsafe">';data.partner_orders[0].base_elegivel=0;data.partner_orders[0].comissao=0;V.render(host,data);host.querySelector('[data-own-affiliate-detail="two"]').click();const detail=host.querySelector('[data-own-detail]');assert(!detail.querySelector('img'));assert(detail.textContent.includes('<img onerror="unsafe">'));assert.match(detail.textContent,/0,00/);
});
test('at-profile search finds handles stored without the at sign for both brands',()=>{
 for(const brand of ['fish','aristo']){const {host,window,data}=fixture();data.brand=brand;data.candidates[0].handle='plainhandle';V.render(host,data);const search=host.querySelector('[data-own-search]');search.value='@plainhandle';search.dispatchEvent(new window.Event('input'));assert.equal(host.querySelector('[data-own-count]').textContent,'1 de 2 cadastros');}
});
