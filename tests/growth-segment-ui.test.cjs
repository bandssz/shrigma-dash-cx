'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const {fixture,definition,api,Client}=require('./growth-segment-fixture.cjs'),UI=require('../growth-segment-ui.js');
function boot(f=fixture(),options={}){
 const {document,window}=parseHTML('<html><body><section id="segments"></section></body></html>');
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 window.HTMLElement.prototype.focus=function(){document._focused=this;};let key=options.key||'synthetic-actor-one';const element=document.querySelector('#segments'),ui=UI.create({element,document,key:()=>key,storage:options.storage||f.storage,fetch:options.fetch||f.fetch,locks:options.locks===undefined?f.locks:options.locks,...(options.identity?{identity:options.identity}:{})});
 const q=s=>element.querySelector(s),input=(selector,value,event='change')=>{q(selector).value=value;q(selector).dispatchEvent(new window.Event(event,{bubbles:true}));};
 return {f,ui,element,q,input,document,window,setKey:v=>{key=v;}};
}
async function settled(x){for(let i=0;i<100;i++){if(!x.ui.contextStatus().blocked)return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI pending');}
async function idle(x){for(let i=0;i<100;i++){if(!x.ui.contextStatus().busy)return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI busy');}
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
 const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');await click(x,'save');const before=x.f.calls.length;x.q('[data-gs="archive"]').click();assert.equal(x.q('[data-gs-dialog]').hasAttribute('open'),true);assert.equal(x.q('#gs-dialog-title').textContent,'Confirmar ação');assert.equal(x.q('[data-gs="back"]').textContent,'Voltar sem alterar');assert.equal(x.q('[data-gs="accept"]').textContent,'Confirmar');assert.strictEqual(x.document._focused,x.q('[data-gs="back"]'));assert.match(x.q('[data-gs-confirm-text]').textContent,/Fishermans.*versão 1/);x.q('[data-gs="back"]').click();assert.equal(x.f.calls.length,before);
 x.q('[data-gs="archive"]').click();x.q('[data-gs="accept"]').click();await settled(x);assert.equal([...x.f.rows.values()][0].archived,true);assert.equal(x.q('[data-gs-fields]').hasAttribute('disabled'),true);
 await click(x,'new');fill(x,'fish');x.q('[data-gs="new"]').click();assert.match(x.q('[data-gs-confirm-text]').textContent,/alterações locais/);x.q('[data-gs="back"]').click();assert.equal(x.q('[data-gs-name]').value,'Público de fish');
});
test('uncertain save freezes edits and reload consults only the original operation',async()=>{
 const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');x.f.control.lose=true;await click(x,'save');assert.equal(x.ui.contextStatus().pending,true);assert.equal(x.q('[data-gs-fields]').hasAttribute('disabled'),true);assert.ok(x.q('[data-gs="consult"]'));assert.ok([...x.element.querySelectorAll('[data-gs="quick"]')].every(b=>b.disabled));
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
test('visual shortcuts come only from current available fields and add no invented values',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js'),f=fixture({version:Audience.VERSION});f.control.catalogPatch={shopify_snapshot:{current:true,started_at:'2026-10-01T03:30:00.000Z',observed_at:'2026-10-01T03:45:00.000Z',expires_at:'2026-10-02T05:30:00.000Z'}};const x=boot(f);await x.ui.sync({api:f.api,brand:'fish'});
 const buttons=[...x.element.querySelectorAll('[data-gs="quick"]')];assert.deepEqual(buttons.map(b=>b.dataset.id),['purchase.count','purchase.last_date','purchase.amount','purchase.product','email.opened','email.clicked']);assert.deepEqual(buttons.map(b=>b.textContent),['Pedidos','Última compra','Valor gasto','Produto','Abriu e-mail','Clicou no e-mail']);
 assert.match(x.q('[data-gs-shopify-snapshot]').textContent,/Dados importados da Shopify.*Coleta entre.*Válida até.*não inicia uma sincronização da loja/i);assert.match(x.q('.gs-shortcuts').textContent,/Escolha uma condição e informe o valor/);
 x.input('[data-gs-name]','Meu público preservado','input');x.input('[data-gs-list]','11');x.input('[data-gs-op]','or');const requests=f.calls.length,posts=f.calls.filter(c=>c.method==='POST').length;
 x.q('[data-gs="quick"][data-id="purchase.amount"]').click();const state=JSON.parse(f.store.get(UI.SLOT+'fish')),rules=state.draft.rule.rules;assert.equal(state.draft.name,'Meu público preservado');assert.equal(state.draft.rule.op,'or');assert.deepEqual(rules[0],{op:'in_list',list_id:11});assert.deepEqual(rules[1],{op:'condition',field:'purchase.amount',operator:'eq',value:''});assert.equal(x.q('[data-gs-value="1"]').value,'');assert.strictEqual(x.document._focused,x.q('[data-gs-value="1"]'));assert.match(x.q('[data-gs-status]').textContent,/Preencha o valor/);assert.equal(x.q('[data-gs="save"]').disabled,true);assert.equal(f.calls.length,requests);assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);
});
test('visual shortcuts stop at the existing root limit without mutation or I/O',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js'),f=fixture({version:Audience.VERSION}),x=boot(f);await x.ui.sync({api:f.api,brand:'fish'});const requests=f.calls.length;
 for(let i=0;i<15;i++){const button=x.q('[data-gs="quick"][data-id="purchase.count"]');assert.equal(button.disabled,false);button.click();}
 const button=x.q('[data-gs="quick"][data-id="purchase.count"]'),before=f.store.get(UI.SLOT+'fish');assert.equal(button.disabled,true);button.click();assert.equal(f.store.get(UI.SLOT+'fish'),before);assert.equal(JSON.parse(before).draft.rule.rules.length,16);assert.equal(f.calls.length,requests);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('RFM preset is offered only by a current versioned source and prepares a draft without writing',async()=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js'),f=fixture({version:Audience.VERSION}),x=boot(f),pin='a'.repeat(64);
 f.control.catalogPatch={fields:Object.keys(Audience.FIELDS).map(key=>({key,available:key!=='relationship.rfm',...(key==='relationship.rfm'?{source_hash:pin}:{})}))};
 await x.ui.sync({api:f.api,brand:'fish'});assert.equal(await x.ui.startPreset({field:'relationship.rfm',value:'campeao',name:'Campeões'}),false);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 f.control.catalogPatch={fields:Object.keys(Audience.FIELDS).map(key=>({key,available:true,...(key==='relationship.rfm'?{source_hash:pin}:{})})),rfm_snapshot:{brand:'fish',current:true,history_complete:true,source_hash:pin}};await click(x,'refresh');
 assert.equal(await x.ui.startPreset({field:'relationship.rfm',value:'campeao',name:'Campeões'}),'started');assert.equal(x.q('[data-gs-name]').value,'Campeões');assert.equal(x.q('[data-gs-field]').value,'relationship.rfm');assert.equal(x.q('[data-gs-value]').value,'campeao');assert.match(x.q('[data-gs-rfm-scope]').textContent,/histórico acessível de pedidos pagos/);assert.equal(x.ui.contextStatus().dirty,true);assert.equal(await x.ui.startNew(),'confirmation');assert.equal(x.q('[data-gs-name]').value,'Campeões');x.q('[data-gs="back"]').click();assert.equal(x.q('[data-gs-name]').value,'Campeões');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
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
 const values=[...x.q('[data-gs-field]').options].map(o=>o.value),shortcuts=[...x.element.querySelectorAll('[data-gs="quick"]')].map(b=>b.dataset.id);assert.ok(!values.includes('email.opened'));assert.ok(!values.includes('signup.origin'));assert.ok(!values.includes('purchase.amount'));assert.ok(!shortcuts.includes('email.opened'));assert.ok(!shortcuts.includes('purchase.amount'));
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
 assert.match(x.element.textContent,/Valor em BRL/);assert.doesNotMatch(x.element.textContent,/Valor em USD/);assert.ok(x.q('[data-gs-context-changed]'));assert.equal(x.q('[data-gs="save"]').disabled,true);assert.equal(x.q('[data-gs="count"]').disabled,true);assert.ok([...x.element.querySelectorAll('[data-gs="quick"]')].every(b=>b.disabled));
 const reloaded=boot(f);await reloaded.ui.sync({api:f.api,brand:'fish'});assert.match(reloaded.element.textContent,/Valor em BRL/);assert.equal(reloaded.q('[data-gs="save"]').disabled,true);assert.equal(JSON.parse(f.storage.getItem(UI.SLOT+'fish')).draft_catalog_hash,original.draft_catalog_hash);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 reloaded.q('[data-gs="new"]').click();assert.equal(reloaded.q('[data-gs-dialog]').hasAttribute('open'),true);reloaded.q('[data-gs="accept"]').click();await settled(reloaded);assert.equal(reloaded.q('[data-gs-name]').value,'');assert.equal(reloaded.q('[data-gs-context-changed]'),null);
 assert.equal(JSON.parse(f.storage.getItem(UI.SLOT+'fish')).draft_catalog_hash,'b'.repeat(64));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

const listRequest=(url,init)=>init?.method==='GET'&&new URL(url).searchParams.get('acao')==='segmentos_listar';
const unavailable=()=>({status:503,json:async()=>({error:'SEGMENT_SERVICE_UNAVAILABLE'})});
function assertSafeReadError(status){assert.equal(typeof status.error,'string');assert.ok(status.error.length>0);assert.doesNotMatch(status.error,/SEGMENT_|https?:\/\/|\bat\s+\S+\s*\(/);}

test('Create public retries one failed catalog GET explicitly, opens a fresh draft and never writes',async()=>{
 const f=fixture();let reads=0;const fetch=async(url,init)=>{if(listRequest(url,init)&&++reads===1)return unavailable();return f.fetch(url,init);};const x=boot(f,{fetch});
 await x.ui.sync({api,brand:'fish'});const status=x.ui.contextStatus();assert.equal(status.brand,'fish');assert.equal(status.blocked,false);assert.equal(status.busy,false);assert.equal(status.dirty,false);assert.equal(status.pending,false);assert.equal(status.catalogReady,false);assert.equal(status.availableClient,true);assertSafeReadError(status);
 assert.equal(await x.ui.startNew(),'started');assert.equal(reads,2);assert.equal(x.ui.contextStatus().catalogReady,true);assert.equal(x.ui.contextStatus().error,'');assert.equal(x.q('[data-gs-name]').value,'');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('Create public reports a safe catalog read error when the explicit retry also fails',async()=>{
 const f=fixture();let reads=0;const fetch=async(url,init)=>{if(listRequest(url,init)){reads++;return unavailable();}return f.fetch(url,init);};const x=boot(f,{fetch});
 await x.ui.sync({api,brand:'fish'});assert.equal(x.q('.gs-saved-count').textContent,'Ainda não carregados');assert.match(x.q('.gs-empty-saved').textContent,/não foi possível carregar os públicos/i);assert.match(x.q('[data-gs-empty-editor]').textContent,/dados desta marca não foram carregados/i);assert.equal(await x.ui.startNew(),false);const status=x.ui.contextStatus();assert.equal(reads,2);assert.equal(status.catalogReady,false);assert.equal(status.availableClient,true);assert.equal(status.pending,false);assertSafeReadError(status);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('pending catalog read shows transient loading copy and performs one read',async()=>{
 const f=fixture();let release,enteredResolve,reads=0;const entered=new Promise(resolve=>{enteredResolve=resolve;}),wait=new Promise(resolve=>{release=resolve;}),fetch=async(url,init)=>{if(listRequest(url,init)){reads++;enteredResolve();await wait;}return f.fetch(url,init);},x=boot(f,{fetch});
 const syncing=x.ui.sync({api,brand:'fish'});await entered;assert.equal(x.q('.gs-saved-count').textContent,'Carregando…');assert.equal(x.q('.gs-empty-saved').textContent,'Carregando públicos…');assert.equal(x.q('[data-gs-empty-editor]').textContent,'Carregando listas e condições…');assert.equal(reads,1);release();await syncing;assert.equal(reads,1);assert.ok(x.q('[data-gs-name]'));
});

test('a restored pending operation blocks Create public without another GET or any local mutation',async()=>{
 const f=fixture(),seed=boot(f);await seed.ui.sync({api,brand:'fish'});fill(seed,'fish');f.control.lose=true;await click(seed,'save');assert.equal(seed.ui.contextStatus().pending,true);
 const restored=boot(f);await restored.ui.sync({api,brand:'fish'});const before={editor:f.store.get(UI.SLOT+'fish'),journal:f.store.get(Client.SLOT+'fish'),calls:f.calls.length,posts:f.calls.filter(c=>c.method==='POST').length};
 assert.equal(await restored.ui.startNew(),false);assert.equal(restored.ui.contextStatus().pending,true);assert.equal(f.calls.length,before.calls);assert.equal(f.calls.filter(c=>c.method==='POST').length,before.posts);assert.equal(f.store.get(UI.SLOT+'fish'),before.editor);assert.equal(f.store.get(Client.SLOT+'fish'),before.journal);
});

test('a fatal actor mismatch preserves both local journals and makes no recovery request',async()=>{
 const f=fixture(),seed=boot(f);await seed.ui.sync({api,brand:'fish'});fill(seed,'fish');const editor=f.store.get(UI.SLOT+'fish'),journal=f.store.get(Client.SLOT+'fish')??null;
 const changed=boot(f,{key:'another-synthetic-actor'}),calls=f.calls.length;await changed.ui.sync({api,brand:'fish'});const beforeCalls=f.calls.length;assert.equal(beforeCalls,calls);assert.equal(await changed.ui.startNew(),false);assert.equal(f.calls.length,beforeCalls);assert.equal(f.store.get(UI.SLOT+'fish'),editor);assert.equal(f.store.get(Client.SLOT+'fish')??null,journal);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(changed.ui.contextStatus().availableClient,false);
});

test('an invalid client journal is preserved byte-for-byte and cannot trigger catalog recovery',async()=>{
 const f=fixture(),invalid='{"version":1,"brand":"fish","tampered":true}';f.store.set(Client.SLOT+'fish',invalid);const x=boot(f);
 await x.ui.sync({api,brand:'fish'});const beforeCalls=f.calls.length;assert.equal(x.ui.contextStatus().availableClient,false);assertSafeReadError(x.ui.contextStatus());assert.equal(await x.ui.startNew(),false);assert.equal(f.calls.length,beforeCalls);assert.equal(f.store.get(Client.SLOT+'fish'),invalid);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('an access-key change during the recovery GET rejects the draft without local writes',async()=>{
 const f=fixture();let reads=0,release,enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});const wait=new Promise(resolve=>{release=resolve;});const fetch=async(url,init)=>{if(listRequest(url,init)){reads++;if(reads===1)return unavailable();enteredResolve();await wait;}return f.fetch(url,init);};const x=boot(f,{fetch});
 await x.ui.sync({api,brand:'fish'});const editor=f.store.get(UI.SLOT+'fish'),journal=f.store.get(Client.SLOT+'fish');const attempt=x.ui.startNew();await entered;x.setKey('another-synthetic-actor');release();assert.equal(await attempt,false);assert.equal(reads,2);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.store.get(UI.SLOT+'fish'),editor);assert.equal(f.store.get(Client.SLOT+'fish'),journal);assert.equal(x.ui.contextStatus().catalogReady,false);assertSafeReadError(x.ui.contextStatus());
});

async function legacyEditor(mode='absent'){
 const Audience=require('../n8n/growth/segment-audience-contract.js'),f=fixture({version:Audience.VERSION}),actor=await Client.fingerprint('synthetic-actor-one'),draft={schema_version:Audience.VERSION,brand:'fish',name:'Preparação legada',rule:{op:'and',rules:[{op:'in_list',list_id:11}]}},saved={version:1,brand:'fish',endpoint:f.api.capabilities.endpoints.segments,actor,draft,base:structuredClone(draft),server:null};
 if(mode==='null')saved.draft_catalog_hash=null;if(mode==='malformed')saved.draft_catalog_hash='not-a-catalog-hash';const raw=JSON.stringify(saved);f.store.set(UI.SLOT+'fish',raw);return {f,raw,draft};
}
const backups=f=>[...f.store.entries()].filter(([key])=>key.startsWith(UI.SLOT+'fish:preserved:'));

test('RFM preset delegates a legacy null-hash draft to the hotfix recovery confirmation',async()=>{
 const {f,raw}=await legacyEditor(),x=boot(f);await x.ui.sync({api:f.api,brand:'fish'});assert.equal(await x.ui.startPreset({field:'relationship.rfm',value:'campeao',name:'Campeões'}),'confirmation');assert.equal(x.q('#gs-dialog-title').textContent,'Começar novo público');assert.match(x.q('[data-gs-confirm-text]').textContent,/rascunho antigo.*cópia.*públicos salvos permanecem/i);assert.equal(x.q('[data-gs="back"]').textContent,'Voltar');assert.equal(x.q('[data-gs="accept"]').textContent,'Guardar e começar');assert.strictEqual(x.document._focused,x.q('[data-gs="back"]'));assert.equal(f.calls.length,0);assert.equal(f.store.get(UI.SLOT+'fish'),raw);x.q('[data-gs="back"]').click();assert.equal(f.store.get(UI.SLOT+'fish'),raw);assert.deepEqual(backups(f),[]);
});

test('explicit legacy recovery confirms first; cancel preserves exact bytes and performs no request',async()=>{
 for(const mode of ['absent','null']){const {f,raw}=await legacyEditor(mode),x=boot(f);await x.ui.sync({api:f.api,brand:'fish'});assert.equal(f.calls.length,0);assert.match(x.q('[data-gs-empty-editor]').textContent,/Use Criar público/);assert.equal(x.q('.gs-saved-count').textContent,'Ainda não carregados');assert.equal(await x.ui.startNew(),'confirmation');assert.equal(x.q('#gs-dialog-title').textContent,'Começar novo público');assert.match(x.q('[data-gs-confirm-text]').textContent,/rascunho antigo.*cópia.*públicos salvos permanecem/i);assert.equal(x.q('[data-gs="back"]').textContent,'Voltar');assert.equal(x.q('[data-gs="accept"]').textContent,'Guardar e começar');assert.equal(f.calls.length,0);assert.equal(f.store.get(UI.SLOT+'fish'),raw);assert.deepEqual(backups(f),[]);x.q('[data-gs="back"]').click();await idle(x);assert.equal(x.q('[data-gs-dialog]').hasAttribute('open'),false);assert.equal(f.calls.length,0);assert.equal(f.store.get(UI.SLOT+'fish'),raw);assert.deepEqual(backups(f),[]);}
});

test('accepting legacy recovery stores an exact immutable backup and starts empty in the fresh catalog without POST',async()=>{
 for(const mode of ['absent','null']){const {f,raw}=await legacyEditor(mode),x=boot(f);await x.ui.sync({api:f.api,brand:'fish'});assert.equal(await x.ui.startNew(),'confirmation');await click(x,'accept');
  const hash=await Client.fingerprint(raw),backupSlot=UI.SLOT+'fish:preserved:'+hash,active=f.store.get(UI.SLOT+'fish'),saved=JSON.parse(active);assert.equal(f.store.get(backupSlot),raw);assert.equal(backups(f).length,1);assert.equal(saved.draft_catalog_hash,'a'.repeat(64));assert.equal(saved.draft_currency,'BRL');assert.equal(saved.draft_timezone,null);assert.equal(saved.draft.name,'');assert.equal(saved.draft.rule.rules[0].list_id,0);assert.deepEqual(saved.base,saved.draft);assert.equal(saved.server,null);assert.equal(x.q('[data-gs-name]').value,'');assert.equal(x.ui.contextStatus().catalogReady,true);assert.equal(f.calls.filter(c=>c.method==='GET').length,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 }
});

test('pending legacy state, malformed hash and actor mismatch never enter recovery or issue a read',async()=>{
 {const {f,raw,draft}=await legacyEditor(),client=f.create();await client.list();f.control.lose=true;await assert.rejects(client.save(draft));f.store.set(UI.SLOT+'fish',raw);const x=boot(f),before=f.calls.length;await x.ui.sync({api:f.api,brand:'fish'});assert.equal(await x.ui.startNew(),false);assert.equal(f.calls.length,before);assert.equal(f.store.get(UI.SLOT+'fish'),raw);assert.deepEqual(backups(f),[]);}
 for(const kind of ['malformed','actor']){const state=await legacyEditor(kind==='malformed'?'malformed':'absent'),{f,raw}=state;if(kind==='actor'){const value=JSON.parse(raw);value.actor=await Client.fingerprint('other-actor');f.store.set(UI.SLOT+'fish',JSON.stringify(value));}const original=f.store.get(UI.SLOT+'fish'),x=boot(f);await x.ui.sync({api:f.api,brand:'fish'});assert.equal(await x.ui.startNew(),false);assert.equal(f.calls.length,0);assert.equal(f.store.get(UI.SLOT+'fish'),original);assert.deepEqual(backups(f),[]);}
});

test('key or editor drift during the recovery GET aborts without backup, overwrite or POST',async()=>{
 for(const drift of ['key','raw']){const {f,raw}=await legacyEditor();let release,enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;}),wait=new Promise(resolve=>{release=resolve;}),fetch=async(url,init)=>{if(listRequest(url,init)){enteredResolve();await wait;}return f.fetch(url,init);},x=boot(f,{fetch});await x.ui.sync({api:f.api,brand:'fish'});assert.equal(await x.ui.startNew(),'confirmation');x.q('[data-gs="accept"]').click();await entered;
  const changed=drift==='raw'?raw+' ':raw;if(drift==='key')x.setKey('other-actor');else f.store.set(UI.SLOT+'fish',changed);release();await idle(x);assert.equal(f.store.get(UI.SLOT+'fish'),changed);assert.deepEqual(backups(f),[]);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assertSafeReadError(x.ui.contextStatus());
 }
});

test('legacy recovery fails closed on journal-lock contention and backup storage failure',async()=>{
 {const {f,raw}=await legacyEditor(),x=boot(f);await x.ui.sync({api:f.api,brand:'fish'});assert.equal(await x.ui.startNew(),'confirmation');await f.locks.request(Client.SLOT+'fish',{mode:'exclusive',ifAvailable:true},async()=>{x.q('[data-gs="accept"]').click();await idle(x);});assert.equal(f.store.get(UI.SLOT+'fish'),raw);assert.deepEqual(backups(f),[]);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assertSafeReadError(x.ui.contextStatus());}
 {const {f,raw}=await legacyEditor(),storage={getItem:key=>f.storage.getItem(key),removeItem:key=>f.storage.removeItem(key),setItem(key,value){if(key.startsWith(UI.SLOT+'fish:preserved:'))throw Error('synthetic backup failure');f.storage.setItem(key,value);}},x=boot(f,{storage});await x.ui.sync({api:f.api,brand:'fish'});assert.equal(await x.ui.startNew(),'confirmation');x.q('[data-gs="accept"]').click();await idle(x);assert.equal(f.store.get(UI.SLOT+'fish'),raw);assert.deepEqual(backups(f),[]);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assertSafeReadError(x.ui.contextStatus());}
});

test('the shared audience catalog is a read-only copy of the existing read with no draft, key or additional I/O',async()=>{
 const x=boot();assert.equal(x.ui.sourceCatalog(),null);await x.ui.sync({api,brand:'fish'});const before=x.f.calls.length,catalog=x.ui.sourceCatalog();assert.equal(catalog.brand,'fish');catalog.lists.length=0;catalog.brand='aristo';assert.equal(x.ui.sourceCatalog().brand,'fish');assert.ok(x.ui.sourceCatalog().lists.length>0);assert.equal(x.f.calls.length,before);assert.doesNotMatch(JSON.stringify(x.ui.sourceCatalog()),/synthetic-manager-key|draft_rule|draft_name/);
});
