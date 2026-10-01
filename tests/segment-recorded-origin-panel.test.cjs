'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const {setupRecordedComponent}=require('./segment-recorded-origin-fixture.cjs');
const UI=require('../growth-segment-ui.js'),{fixture}=require('./growth-segment-fixture.cjs');

const PRODUCT='gid://shopify/Product/101';
const PRODUCT_NAME='Kit <Mar & Rio> "Especial"';

async function boot(t,brand){
 const db=new PGlite();t.after(()=>db.close());
 const actual=await setupRecordedComponent(db);assert.equal(actual.tier,'component-pglite-no-install-guard');await actual.record(1);
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

test('Gestor saves and reopens the prospective form filter, sees coverage, and loses count authority when source is disabled',async t=>{
 const x=await boot(t,'aristo');
 x.input('[data-gs-name]','Inscritos no formulário Alma','input');await x.click('add-condition');x.input('[data-gs-field]','signup.recorded_origin');x.input('[data-gs-value]','vip_alma');x.q('[data-gs="remove"][data-path="0"]').click();
 assert.deepEqual([...x.q('[data-gs-operator]').options].map(o=>o.value),['is']);
 assert.match(x.q('[data-gs-recorded-origin-scope]').textContent,/Conta inscrições aceitas.*desde/);assert.match(x.q('[data-gs-recorded-origin-scope]').textContent,/Não identifica a primeira origem/);
 assert.doesNotMatch(x.q('[data-gs-recorded-origin-scope]').textContent,/o início de cobertura informado/);
 await x.click('save');await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/1 pessoas/);
 const id=(await x.db.query("SELECT id FROM crm_audience_v2.audience WHERE name='Inscritos no formulário Alma'")).rows[0].id;
 await x.click('new');x.q('[data-gs="open"][data-id="'+id+'"]').click();await x.settle();assert.equal(x.q('[data-gs-field]').value,'signup.recorded_origin');assert.equal(x.q('[data-gs-value]').value,'vip_alma');
 await x.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=16");await x.click('count');assert.match(x.q('[data-gs-count]').textContent,/0 pessoas/);
 await x.db.exec("UPDATE crm_audience_v2.recorded_origin_source SET enabled=false WHERE canonical_origin='vip_alma'");await x.click('refresh');assert.equal(x.q('[data-gs="count"]').disabled,true);assert.equal(x.q('[data-gs="save"]').disabled,true);assert.doesNotMatch(x.q('[data-gs-count]').textContent,/0 pessoas/);
 assert.equal((await x.db.query('SELECT definition FROM crm_audience_v2.audience WHERE id=$1',[id])).rows[0].definition.rule.value,'vip_alma');
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);assert.equal(x.calls.filter(c=>c.action==='segmento_criar').length,1);
});
test('Fish never offers the Aristo form source and preserves normal list editing',async t=>{
 const x=await boot(t,'fish');x.input('[data-gs-name]','Fish listas','input');x.input('[data-gs-list]','17');await x.click('add-condition');assert.equal([...x.q('[data-gs-field]').options].some(o=>o.value==='signup.recorded_origin'),false);assert.equal([...x.q('[data-gs-field]').options].some(o=>o.value==='signup.origin'),false);
});
