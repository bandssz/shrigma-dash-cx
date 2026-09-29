'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const {setupProducts,productEvidence}=require('./segment-shopify-products-fixture.cjs');
const UI=require('../growth-segment-ui.js'),{fixture}=require('./growth-segment-fixture.cjs');

const PRODUCT='gid://shopify/Product/101';
const PRODUCT_NAME='Kit <Mar & Rio> "Especial"';

async function boot(t,brand){
 const db=new PGlite();t.after(()=>db.close());
 const actual=await setupProducts(db),e=productEvidence(brand);e.customers[0].products[0].name=PRODUCT_NAME;
 await actual.ingestProducts(e);await actual.enableProducts(brand);
 const memory=fixture({version:'crm-audience-v2'}),{document,window}=parseHTML('<html><body><section id="segments"></section></body></html>');
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialog=Object.getPrototypeOf(document.createElement('dialog'));dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.onclose?.();};window.HTMLElement.prototype.focus=function(){};
 const calls=[],element=document.querySelector('#segments'),key='synthetic-manager-key';
 const fetch=async(url,init)=>{const u=new URL(url),p=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(u.searchParams);calls.push({method:init.method,action:p.acao});
  assert.equal(init.headers.Authorization,'Bearer '+key);const response=await actual.f.api.handle({method:init.method,request:{headers:init.headers,[init.method==='POST'?'body':'query']:p}});return {status:response.status,json:async()=>response.body};};
 const ui=UI.create({element,document,key:()=>key,storage:memory.storage,fetch,locks:memory.locks});
 const q=s=>element.querySelector(s),settle=async()=>{for(let n=0;n<200;n++){if(!ui.contextStatus().blocked)return;await new Promise(r=>setTimeout(r,2));}assert.fail('Panel did not settle');};
 const click=async action=>{const b=q('[data-gs="'+action+'"]');assert.ok(b);assert.equal(b.disabled,false);b.click();await settle();};
 const input=(selector,value,type='change')=>{const node=q(selector);assert.ok(node);node.value=value;node.dispatchEvent(new window.Event(type,{bubbles:true}));};
 await ui.sync({api:memory.api,brand});return {...actual,db,memory,element,ui,q,input,click,settle,calls};
}

for(const brand of ['fish','aristo'])test(brand+': Gestor saves, reopens and counts a product audience without authorizing transport',async t=>{
 const x=await boot(t,brand);
 x.input('[data-gs-name]','Comprou produto · '+brand,'input');await x.click('add-condition');x.input('[data-gs-field]','purchase.product');
 x.input('[data-gs-value]',PRODUCT);x.q('[data-gs="remove"][data-path="0"]').click();
 const option=[...x.q('[data-gs-value]').options].find(o=>o.value===PRODUCT);assert.ok(option);assert.equal(option.textContent,PRODUCT_NAME);assert.equal(x.q('[data-gs-value]').querySelector('img'),null);
 const scope=x.q('[data-gs-product-scope]').textContent;assert.match(scope,/sem filtro de pagamento/);assert.match(scope,/removidos ou reembolsados/);
 await x.click('save');await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/1 pessoas/);
 const id=(await x.db.query('SELECT id FROM crm_audience_v2.audience WHERE brand=$1',[brand])).rows[0].id;
 await x.click('new');x.q('[data-gs="open"][data-id="'+id+'"]').click();await x.settle();
 assert.equal(x.q('[data-gs-field]').value,'purchase.product');assert.equal(x.q('[data-gs-operator]').value,'purchased');assert.equal(x.q('[data-gs-value]').value,PRODUCT);
 await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/1 pessoas/);

 x.input('[data-gs-operator]','not_purchased');await x.click('save');await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/1 pessoas/);
 await x.click('new');x.q('[data-gs="open"][data-id="'+id+'"]').click();await x.settle();assert.equal(x.q('[data-gs-operator]').value,'not_purchased');assert.equal(x.q('[data-gs-value]').value,PRODUCT);
 await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=2 AND list_id=$1",[brand==='fish'?17:16]);
 await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/0 pessoas/);
 assert.match(x.q('[data-gs-count]').nextElementSibling.textContent,/não comprova consentimento ou autorização para enviar/);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);

 await x.db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours' WHERE brand=$1",[brand]);await x.click('refresh');
 assert.match(x.q('[data-gs-shopify-snapshot]').textContent,/venceu/);assert.equal(x.q('[data-gs="count"]').disabled,true);assert.equal(x.q('[data-gs="save"]').disabled,true);
 assert.doesNotMatch(x.q('[data-gs-count]').textContent,/0 pessoas/);
 const persisted=(await x.db.query('SELECT definition FROM crm_audience_v2.audience WHERE id=$1',[id])).rows[0].definition;assert.equal(persisted.rule.value,PRODUCT);assert.equal(persisted.rule.operator,'not_purchased');
 assert.equal(x.calls.filter(c=>c.action==='segmento_criar').length,1);assert.equal(x.calls.filter(c=>c.action==='segmento_salvar').length,1);assert.ok(x.calls.every(c=>/^segment/.test(c.action)));
});
for(const brand of ['fish','aristo'])test(brand+': Gestor explicitly selects confirmed Shopify records, saves and reopens the scope without turning missing records into never bought',async t=>{
 const x=await boot(t,brand);await x.db.exec("INSERT INTO subscribers(id,status,email) VALUES(6,'enabled','missing@example.test');INSERT INTO subscriber_lists VALUES(6,17,'confirmed'),(6,16,'confirmed')");
 x.input('[data-gs-name]','Compradores confirmados · '+brand,'input');await x.click('add-condition');x.input('[data-gs-field]','purchase.count');x.input('[data-gs-operator]','gt');x.input('[data-gs-value]','0');x.q('[data-gs="remove"][data-path="0"]').click();
 await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/desconhecida/);
 const scope=x.q('[data-gs-confirmed]');assert.equal(scope.hasAttribute('checked'),false);scope.checked=true;scope.dispatchEvent(new x.element.ownerDocument.defaultView.Event('change',{bubbles:true}));
 assert.match(x.q('[data-gs-confirmed-scope]').textContent,/Dado ausente não significa nunca comprou/);
 await x.click('save');await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/2 pessoas/);
 const row=(await x.db.query('SELECT id,definition FROM crm_audience_v2.audience WHERE brand=$1',[brand])).rows[0];assert.equal(row.definition.rule.op,'confirmed');assert.equal(row.definition.rule.rule.field,'purchase.count');
 await x.click('new');x.q('[data-gs="open"][data-id="'+row.id+'"]').click();await x.settle();assert.equal(x.q('[data-gs-confirmed]').hasAttribute('checked'),true);assert.equal(x.q('[data-gs-operator]').value,'gt');
 await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[brand==='fish'?17:16]);await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/1 pessoas/);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
