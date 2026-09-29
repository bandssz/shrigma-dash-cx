'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const {setup,evidence}=require('./segment-shopify-facts-fixture.cjs'),UI=require('../growth-segment-ui.js');
const {fixture}=require('./growth-segment-fixture.cjs');
async function boot(t,brand){
 const actual=await setup(t);await actual.ingest(evidence(brand));await actual.enable();
 const memory=fixture({version:'crm-audience-v2'}),{document,window}=parseHTML('<html><body><section id="segments"></section></body></html>');
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialog=Object.getPrototypeOf(document.createElement('dialog'));dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.onclose?.();};window.HTMLElement.prototype.focus=function(){};
 const calls=[],element=document.querySelector('#segments'),key='synthetic-manager-key';
 const fetch=async(url,init)=>{const u=new URL(url),p=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(u.searchParams);calls.push({method:init.method,action:p.acao});
  assert.equal(init.headers.Authorization,'Bearer '+key);const response=await actual.f.api.handle({method:init.method,request:{headers:init.headers,[init.method==='POST'?'body':'query']:p}});return {status:response.status,json:async()=>response.body};};
 const ui=UI.create({element,document,key:()=>key,storage:memory.storage,fetch,locks:memory.locks});
 const q=s=>element.querySelector(s),settle=async()=>{for(let n=0;n<200;n++){if(!ui.contextStatus().blocked)return;await new Promise(r=>setTimeout(r,2));}assert.fail('Panel did not settle');};
 const click=async action=>{const b=q('[data-gs="'+action+'"]');assert.ok(b);assert.equal(b.disabled,false);b.click();await settle();};
 const input=(selector,value,type='change')=>{q(selector).value=value;q(selector).dispatchEvent(new window.Event(type,{bubbles:true}));};
 await ui.sync({api:memory.api,brand});return {...actual,memory,element,ui,q,input,click,settle,calls};
}
for(const brand of ['fish','aristo'])test(brand+': analyst creates/reopens/counts Shopify audience and sees nightly coverage and expiry',async t=>{
 const x=await boot(t,brand);assert.match(x.q('[data-gs-shopify-snapshot]').textContent,/Dados Shopify coletados entre.*Válidos até/);assert.match(x.element.textContent,/sincronização é noturna/);
 x.input('[data-gs-name]','Clientes sem compras · '+brand,'input');await x.click('add-condition');x.input('[data-gs-field]','purchase.count');x.input('[data-gs-value]','0');x.q('[data-gs="remove"][data-path="0"]').click();
 await x.click('save');assert.equal(x.ui.contextStatus().dirty,false);await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/1 pessoas/);
 const id=(await x.db.query('SELECT id FROM crm_audience_v2.audience WHERE brand=$1',[brand])).rows[0].id;
 await x.click('new');x.q('[data-gs="open"][data-id="'+id+'"]').click();await x.settle();assert.equal(x.q('[data-gs-value]').value,'0');await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/1 pessoas/);
 await x.db.query("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours' WHERE brand=$1",[brand]);await x.click('refresh');
 assert.match(x.q('[data-gs-shopify-snapshot]').textContent,/venceu/);assert.equal(x.q('[data-gs="count"]').disabled,true);assert.equal(x.q('[data-gs="save"]').disabled,true);assert.equal(x.q('[data-gs-value]').value,'0');
 assert.doesNotMatch(x.q('[data-gs-count]').textContent,/0 pessoas/);assert.equal(x.calls.filter(c=>c.action==='segmento_criar').length,1);assert.ok(x.calls.every(c=>/^segment/.test(c.action)));
});
