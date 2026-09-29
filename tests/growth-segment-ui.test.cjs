'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const {fixture,definition,api}=require('./growth-segment-fixture.cjs'),UI=require('../growth-segment-ui.js');
function boot(f=fixture()){
 const {document,window}=parseHTML('<html><body><section id="segments"></section></body></html>');
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 window.HTMLElement.prototype.focus=function(){};let key='synthetic-actor-one';const element=document.querySelector('#segments'),ui=UI.create({element,document,key:()=>key,storage:f.storage,fetch:f.fetch,locks:f.locks});
 const q=s=>element.querySelector(s),input=(selector,value,event='change')=>{q(selector).value=value;q(selector).dispatchEvent(new window.Event(event,{bubbles:true}));};
 return {f,ui,element,q,input,document,window,setKey:v=>{key=v;}};
}
async function settled(x){for(let i=0;i<100;i++){if(!x.ui.contextStatus().blocked)return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI pending');}
async function click(x,action){x.q('[data-gs="'+action+'"]').click();await settled(x);}
function fill(x,brand){x.input('[data-gs-name]','Público de '+brand,'input');x.input('[data-gs-list]',brand==='fish'?'11':'21');}
test('without capability segments stay OFF and issue no requests',async()=>{const x=boot();await x.ui.sync({api:{},brand:'fish'});assert.match(x.element.textContent,/ainda não está disponível/);assert.equal(x.f.calls.length,0);assert.equal(x.q('[data-gs-name]'),null);});
test('read-only announcement does not expose save or count even when the list response grants them',async()=>{const x=boot(),readOnly=structuredClone(api);readOnly.capabilities.segments.save=false;readOnly.capabilities.segments.count=false;await x.ui.sync({api:readOnly,brand:'fish'});fill(x,'fish');assert.equal(x.q('[data-gs="save"]').disabled,true);assert.equal(x.q('[data-gs="count"]').disabled,true);assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);});
test('in-place capability withdrawal invalidates the catalog and cannot retain previously enabled actions',async()=>{const x=boot(),payload=structuredClone(api);await x.ui.sync({api:payload,brand:'fish'});fill(x,'fish');assert.equal(x.q('[data-gs="save"]').disabled,false);const before=x.f.calls.length;payload.capabilities.segments.save=false;payload.capabilities.segments.count=false;await x.ui.sync({api:payload,brand:'fish'});assert.equal(x.q('[data-gs-list]'),null);assert.equal(x.f.calls.length,before);await click(x,'refresh');assert.equal(x.q('[data-gs-name]').value,'Público de fish');assert.equal(x.q('[data-gs="save"]').disabled,true);assert.equal(x.q('[data-gs="count"]').disabled,true);assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);});
test('both brands use named lists and nested E/OU, save reusable identity and keep counting informational',async()=>{
 for(const brand of ['fish','aristo']){const x=boot();await x.ui.sync({api,brand});fill(x,brand);assert.match(x.element.textContent,/não autoriza envio/);assert.ok(x.q('[data-gs-list]').textContent.includes('Lista principal '+brand));assert.ok(!x.element.textContent.includes('SQL'));
  x.q('[data-gs="add-group"]').click();assert.equal(x.element.querySelectorAll('[data-gs-op]').length,2);x.input('[data-gs-list="1.0"]',brand==='fish'?'12':'22');x.input('[data-gs-op="1"]','or');assert.equal(x.q('[data-gs="save"]').disabled,false);
  await click(x,'save');assert.equal(x.ui.contextStatus().dirty,false);assert.equal(x.f.rows.size,1);assert.match(x.element.textContent,/Público salvo/);assert.ok(x.q('[data-gs="add-list"]'),'a normalized single-list or group remains editable');
  await click(x,'count');assert.match(x.q('[data-gs-count]').textContent,/7 pessoas/);assert.match(x.element.textContent,/não autoriza envio/);x.input('[data-gs-name]','Nome alterado','input');assert.doesNotMatch(x.q('[data-gs-count]').textContent,/7 pessoas/);assert.equal(x.ui.contextStatus().dirty,true);assert.equal(x.q('[data-gs="archive"]').disabled,true);
  await click(x,'save');assert.equal([...x.f.rows.values()][0].version,2);assert.equal(x.f.rows.size,1);assert.ok(x.f.calls.every(c=>c.body.brand===brand));
 }
});
test('archive and replacing dirty content require explicit confirmation; cancel does nothing',async()=>{
 const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');await click(x,'save');const before=x.f.calls.length;x.q('[data-gs="archive"]').click();assert.equal(x.q('[data-gs-dialog]').hasAttribute('open'),true);assert.match(x.q('[data-gs-confirm-text]').textContent,/Fishermans.*versão 1/);x.q('[data-gs="back"]').click();assert.equal(x.f.calls.length,before);
 x.q('[data-gs="archive"]').click();x.q('[data-gs="accept"]').click();await settled(x);assert.equal([...x.f.rows.values()][0].archived,true);assert.equal(x.q('[data-gs-fields]').hasAttribute('disabled'),true);
 await click(x,'new');fill(x,'fish');x.q('[data-gs="new"]').click();assert.match(x.q('[data-gs-confirm-text]').textContent,/alterações locais/);x.q('[data-gs="back"]').click();assert.equal(x.q('[data-gs-name]').value,'Público de fish');
});
test('uncertain save freezes edits and reload consults only the original operation',async()=>{
 const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');x.f.control.lose=true;await click(x,'save');assert.equal(x.ui.contextStatus().pending,true);assert.equal(x.q('[data-gs-fields]').hasAttribute('disabled'),true);assert.ok(x.q('[data-gs="consult"]'));
 const restored=boot(x.f);await restored.ui.sync({api,brand:'fish'});assert.equal(restored.ui.contextStatus().pending,true);x.f.control.lose=false;await click(restored,'consult');assert.equal(restored.ui.contextStatus().pending,false);assert.equal(restored.q('[data-gs-name]').value,'Público de fish');assert.equal(x.f.calls.filter(c=>c.body.acao==='segmento_criar').length,1);
});
test('brand switch preserves separate local drafts; repeated same-context sync retains catalog without extra reads',async()=>{
 const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');const requests=x.f.calls.length,input=x.q('[data-gs-name]');await x.ui.sync({api:structuredClone(api),brand:'fish'});assert.strictEqual(x.q('[data-gs-name]'),input);assert.ok(x.q('[data-gs-list]'));assert.equal(x.f.calls.length,requests);
 await x.ui.sync({api,brand:'aristo'});assert.equal(x.q('[data-gs-name]').value,'');assert.doesNotMatch(x.q('[data-gs-list]').textContent,/fish/);fill(x,'aristo');await x.ui.sync({api,brand:'fish'});assert.equal(x.q('[data-gs-name]').value,'Público de fish');assert.equal(x.q('[data-gs-list]').value,'11');assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);
});
test('a changed actor cannot inherit another preparation; another tab cannot overwrite local edits',async()=>{
 const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');const saved=x.f.store.get(UI.SLOT+'fish');x.setKey('another-synthetic-actor');await x.ui.sync({api,brand:'fish'});assert.equal(x.q('[data-gs-name]'),null);assert.match(x.element.textContent,/outro acesso/);assert.equal(x.f.store.get(UI.SLOT+'fish'),saved);
 const a=boot(),b=boot(a.f);await a.ui.sync({api,brand:'fish'});await b.ui.sync({api,brand:'fish'});fill(a,'fish');const current=a.f.store.get(UI.SLOT+'fish');b.input('[data-gs-name]','Concorrente','input');assert.equal(a.f.store.get(UI.SLOT+'fish'),current);assert.match(b.element.textContent,/Outra aba alterou/);assert.equal(b.q('[data-gs="save"]').disabled,true);
});
test('unconfirmed source count stays unknown, never zero',async()=>{const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');x.f.control.countUnknown=true;await click(x,'count');assert.match(x.q('[data-gs-count]').textContent,/quantidade permanece desconhecida/);assert.doesNotMatch(x.q('[data-gs-count]').textContent,/0 pessoas/);});
test('v2 typed filters cover purchases, dates, money, product, confirmed origin and email engagement without free IDs',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js');
 for(const brand of ['fish','aristo'])for(const [field,value,expected]of [['purchase.count','0',0],['purchase.last_date','2026-09-01','2026-09-01'],['purchase.amount','125,50','125.50'],['purchase.product','gid://shopify/Product/'+(brand==='fish'?101:201),'gid://shopify/Product/'+(brand==='fish'?101:201)],['signup.origin',brand==='fish'?'popup':'vip_alma',brand==='fish'?'popup':'vip_alma'],['email.opened','30',30],['email.clicked','7',7]]){
  const x=boot(fixture({version:Audience.VERSION}));await x.ui.sync({api:x.f.api,brand});x.input('[data-gs-name]','Condição tipada','input');x.q('[data-gs="add-condition"]').click();x.input('[data-gs-field]',field);
  const valueControl=x.q('[data-gs-value]');if(['purchase.product','signup.origin'].includes(field)){assert.equal(valueControl.tagName,'SELECT');assert.ok(valueControl.textContent.includes(field==='purchase.product'?'Produto '+brand:brand==='fish'?'Popup confirmado':'VIP Alma da Roça'));}else assert.equal(valueControl.tagName,'INPUT');
  x.input('[data-gs-value]',value);x.q('[data-gs="remove"][data-path="0"]').click();assert.equal(x.q('[data-gs="save"]').disabled,false,field);await click(x,'save');const d=[...x.f.rows.values()][0].definition;assert.equal(d.schema_version,Audience.VERSION);assert.equal(d.rule.field,field);assert.equal(d.rule.value,expected);assert.equal(d.rule.op,'condition');assert.match(x.element.textContent,/não autoriza envio/);
 }
});
test('negative product choice says never bought only for identified Shopify orders and keeps unknown scope visible',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js'),x=boot(fixture({version:Audience.VERSION}));await x.ui.sync({api:x.f.api,brand:'fish'});
 x.input('[data-gs-name]','Nunca comprou o produto','input');x.q('[data-gs="add-condition"]').click();x.input('[data-gs-field]','purchase.product');x.input('[data-gs-operator]','not_purchased');
 const selected=[...x.q('[data-gs-operator]').options].find(o=>o.hasAttribute('selected'));assert.match(selected.textContent,/não comprou este produto nos pedidos identificados do cadastro Shopify/);
 assert.match(x.q('[data-gs-product-scope]').textContent,/produto identificado deixa a ausência desconhecida/);
 assert.doesNotMatch(selected.textContent,/sem pedido com no histórico/);
});
test('v2 unavailable fields, unproven origin and missing currency are not offered; missing count stays unknown',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js'),f=fixture({version:Audience.VERSION});f.control.catalogPatch={fields:Object.keys(Audience.FIELDS).map(key=>({key,available:key!=='email.opened'})),origins:[],currency:null};const x=boot(f);await x.ui.sync({api:f.api,brand:'fish'});x.input('[data-gs-name]','Sem inferir dados','input');x.q('[data-gs="add-condition"]').click();
 const values=[...x.q('[data-gs-field]').options].map(o=>o.value);assert.ok(!values.includes('email.opened'));assert.ok(!values.includes('signup.origin'));assert.ok(!values.includes('purchase.amount'));
 x.input('[data-gs-field]','purchase.count');assert.equal(x.q('[data-gs-value]').value,'');assert.equal(x.q('[data-gs="save"]').disabled,true,'missing value does not become zero');x.input('[data-gs-value]','0');x.q('[data-gs="remove"][data-path="0"]').click();f.control.countUnknown=true;await click(x,'count');assert.match(x.q('[data-gs-count]').textContent,/quantidade permanece desconhecida/);assert.doesNotMatch(x.q('[data-gs-count]').textContent,/0 pessoas/);assert.match(x.element.textContent,/não comprova consentimento/);assert.doesNotMatch(x.q('[data-gs-count]').textContent,/origem das listas/);
});
test('a draft-only preparation cannot move silently to a different endpoint or contract',async()=>{
 for(const change of ['endpoint','contract']){const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');const saved=x.f.store.get(UI.SLOT+'fish'),next=structuredClone(api);if(change==='endpoint')next.capabilities.endpoints.segments='https://other.example.test/segments';else next.capabilities.segments.contract_version='crm-audience-v2';await x.ui.sync({api:next,brand:'fish'});assert.equal(x.q('[data-gs-name]'),null);assert.equal(x.f.store.get(UI.SLOT+'fish'),saved);assert.match(x.element.textContent,/incompatível/);assert.equal(x.f.calls.length,1);}
});
test('v2 local drafts keep their original currency across refresh and reload when source meaning changes',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js'),f=fixture({version:Audience.VERSION}),x=boot(f);
 await x.ui.sync({api:f.api,brand:'fish'});x.input('[data-gs-name]','Gasto em reais','input');x.q('[data-gs="add-condition"]').click();x.input('[data-gs-field]','purchase.amount');x.input('[data-gs-value]','100,00');x.q('[data-gs="remove"][data-path="0"]').click();
 assert.match(x.element.textContent,/Valor em BRL/);const original=JSON.parse(f.storage.getItem(UI.SLOT+'fish'));
 f.control.catalogPatch={currency:'USD',timezone:'Pacific/Honolulu',catalog_hash:'b'.repeat(64)};await click(x,'refresh');
 assert.match(x.element.textContent,/Valor em BRL/);assert.doesNotMatch(x.element.textContent,/Valor em USD/);assert.ok(x.q('[data-gs-context-changed]'));assert.equal(x.q('[data-gs="save"]').disabled,true);assert.equal(x.q('[data-gs="count"]').disabled,true);
 const reloaded=boot(f);await reloaded.ui.sync({api:f.api,brand:'fish'});assert.match(reloaded.element.textContent,/Valor em BRL/);assert.equal(reloaded.q('[data-gs="save"]').disabled,true);assert.equal(JSON.parse(f.storage.getItem(UI.SLOT+'fish')).draft_catalog_hash,original.draft_catalog_hash);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 reloaded.q('[data-gs="new"]').click();assert.equal(reloaded.q('[data-gs-dialog]').hasAttribute('open'),true);reloaded.q('[data-gs="accept"]').click();await settled(reloaded);assert.equal(reloaded.q('[data-gs-name]').value,'');assert.equal(reloaded.q('[data-gs-context-changed]'),null);
 assert.equal(JSON.parse(f.storage.getItem(UI.SLOT+'fish')).draft_catalog_hash,'b'.repeat(64));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
