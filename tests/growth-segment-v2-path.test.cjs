'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto'),{parseHTML}=require('linkedom');
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const Fixture=require('./segment-audience-store-fixture.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs'),UI=require('../growth-segment-ui.js'),Client=require('../growth-segment-client.js');
const api={capabilities:{segments:{contract_version:'crm-audience-v2',brands:['fish','aristo'],read:true,save:true,count:true,operation:true},endpoints:{segments:'https://synthetic.invalid/audience-v2'}}};
async function setup(t){
 const db=new PGlite();t.after(()=>db.close());const f=await Fixture.setup(db,{countProvider:Counter.countAudience,timeoutMs:10000}),saved=new Map(),calls=[];
 const storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},locks=require('./campaign-lock-fixture.cjs')();
 const fetch=async(url,init)=>{
  assert.equal(new URL(url).origin,'https://synthetic.invalid');
  const request=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);
  calls.push({method:init.method,request});
  const r=await f.api.handle({method:init.method,request:{headers:init.headers,[init.method==='POST'?'body':'query']:request}});
  return {status:r.status,json:async()=>r.body};
 };
 return {...f,storage,locks,fetch,calls,saved};
}
function boot(f){
 const {document,window}=parseHTML('<html><body><section id="segments"></section></body></html>');
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogs=Object.getPrototypeOf(document.createElement('dialog'));dialogs.showModal=function(){this.setAttribute('open','');};dialogs.close=function(){this.removeAttribute('open');this.onclose?.();};window.HTMLElement.prototype.focus=function(){};
 const element=document.querySelector('#segments'),ui=UI.create({element,document,key:()=> 'synthetic-manager-key',storage:f.storage,locks:f.locks,fetch:f.fetch}),q=s=>element.querySelector(s);
 const input=(s,v,event='change')=>{assert.ok(q(s),s);q(s).value=v;q(s).dispatchEvent(new window.Event(event,{bubbles:true}));};
 return {ui,element,q,input};
}
async function settled(x){const until=Date.now()+10000;while(x.ui.contextStatus().blocked&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.equal(x.ui.contextStatus().blocked,false,'UI must finish the bounded local request');}
async function click(x,action){const el=x.q('[data-gs="'+action+'"]');assert.ok(el,action);assert.equal(el.disabled,false,action+' available');el.click();await settled(x);}
const rows=async f=>(await f.db.query('SELECT id,brand,definition,version,archived FROM crm_audience_v2.audience ORDER BY brand')).rows;

test('real v2 DOM → API → SQL: both brands save, reopen and count the persisted revision with current opt-out',async t=>{
 const f=await setup(t);
 for(const brand of ['fish','aristo']){
  const x=boot(f);await x.ui.sync({api,brand});assert.ok(x.q('[data-gs-name]'),x.element.textContent);
  x.input('[data-gs-name]','Público '+brand,'input');x.input('[data-gs-list]',brand==='fish'?'101':'201');
  await click(x,'save');assert.match(x.element.textContent,/Público salvo/);assert.equal(x.ui.contextStatus().dirty,false);
  const record=(await rows(f)).find(r=>r.brand===brand);assert.equal(record.version,1);assert.equal(record.definition.schema_version,'crm-audience-v2');
  const reopened=boot(f);await reopened.ui.sync({api,brand});assert.equal(reopened.q('[data-gs-name]').value,'Público '+brand);
  await click(reopened,'count');assert.match(reopened.q('[data-gs-count]').textContent,/1 pessoas/);assert.match(reopened.element.textContent,/Campanhas → Público salvo.*Contar não autoriza envio/);
  const base=brand==='fish'?17:16;await f.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[base]);
  await click(reopened,'count');assert.match(reopened.q('[data-gs-count]').textContent,/0 pessoas/);
  reopened.input('[data-gs-name]','Público revisto '+brand,'input');await click(reopened,'save');assert.equal((await rows(f)).find(r=>r.brand===brand).version,2);
 }
 assert.equal((await rows(f)).length,2);assert.ok(f.calls.every(c=>['fish','aristo'].includes(c.request.brand)));assert.ok([...f.saved.values()].every(v=>!v.includes('synthetic-manager-key')));
 assert.equal((await f.db.query('SELECT count(*) AS n FROM subscribers')).rows[0].n,5);
});
test('typed v2 conditions persist through the real store, while unconnected external sources remain unknown',async t=>{
 const f=await setup(t);
 for(const brand of ['fish','aristo']){
  const x=boot(f);await x.ui.sync({api,brand});x.input('[data-gs-name]','Gasto '+brand,'input');
  await click(x,'add-condition');x.input('[data-gs-field]','purchase.amount');x.input('[data-gs-value]','125,50');
  x.q('[data-gs="remove"][data-path="0"]').click();await click(x,'save');
  const record=(await rows(f)).find(r=>r.brand===brand);assert.deepEqual(record.definition.rule,{op:'condition',field:'purchase.amount',operator:'eq',value:'125.50'});
  const reopened=boot(f);await reopened.ui.sync({api,brand});assert.equal(reopened.q('[data-gs-field]').value,'purchase.amount');await click(reopened,'count');
  assert.match(reopened.q('[data-gs-count]').textContent,/quantidade permanece desconhecida/);assert.doesNotMatch(reopened.q('[data-gs-count]').textContent,/0 pessoas/);
  const receipt=(await f.db.query('SELECT context FROM crm_audience_v2.revision WHERE audience_id=$1',[record.id])).rows[0];
  assert.match(JSON.stringify(receipt.context),/BRL/);assert.match(JSON.stringify(receipt.context),/America\/Sao_Paulo/);
 }
});
test('lost acknowledgement after SQL COMMIT freezes DOM; reload consults the same receipt without a second write',async t=>{
 const f=await setup(t);
 for(const brand of ['fish','aristo']){
  const x=boot(f);await x.ui.sync({api,brand});x.input('[data-gs-name]','Recibo '+brand,'input');x.input('[data-gs-list]',brand==='fish'?'101':'201');
  f.control.afterCommit=result=>{if(result?._http===201)throw Error('synthetic lost acknowledgement');};
  const before=f.calls.filter(c=>c.method==='POST').length;await click(x,'save');
  assert.match(x.element.textContent,/tentativa sem confirmação/);assert.equal(x.q('[data-gs="save"]').disabled,true);
  const journal=JSON.parse(f.storage.getItem(Client.SLOT+brand)),op=journal.operation.request.idempotency_key;assert.equal(journal.operation.phase,'uncertain');
  f.control.afterCommit=null;
  const reopened=boot(f);await reopened.ui.sync({api,brand});await click(reopened,'consult');assert.match(reopened.element.textContent,/Resultado confirmado/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,before+1);
  const confirmed=JSON.parse(f.storage.getItem(Client.SLOT+brand));assert.equal(confirmed.operation.request.idempotency_key,op);assert.equal(confirmed.operation.phase,'confirmed');
  assert.equal((await rows(f)).filter(r=>r.brand===brand).length,1);assert.equal((await rows(f)).find(r=>r.brand===brand).version,1);
 }
 assert.equal((await f.db.query('SELECT count(*) AS n FROM crm_audience_v2.request')).rows[0].n,2);
});
test('catalog drift before save yields a durable rejection; the DOM keeps original units and never creates the reinterpreted audience',async t=>{
 const f=await setup(t),x=boot(f);await x.ui.sync({api,brand:'fish'});x.input('[data-gs-name]','Cem reais','input');await click(x,'add-condition');x.input('[data-gs-field]','purchase.amount');x.input('[data-gs-value]','100,00');x.q('[data-gs="remove"][data-path="0"]').click();
 const old=JSON.parse(f.storage.getItem(UI.SLOT+'fish')).draft_catalog_hash;
 await f.db.exec("UPDATE crm_audience_v2.config SET catalog=jsonb_set(catalog,'{currency}','\"USD\"'::jsonb) WHERE brand='fish'");
 await click(x,'save');assert.match(x.element.textContent,/tentativa sem confirmação/);assert.equal((await rows(f)).length,0);
 await click(x,'consult');assert.match(x.element.textContent,/Tentativa recusada/);assert.match(x.element.textContent,/Valor em BRL/);assert.doesNotMatch(x.element.textContent,/Valor em USD/);assert.ok(x.q('[data-gs-context-changed]'));assert.equal(x.q('[data-gs="save"]').disabled,true);
 const request=f.calls.find(c=>c.request.acao==='segmento_criar').request;assert.equal(request.expected_catalog_hash,old);assert.equal(f.calls.filter(c=>c.request.acao==='segmento_criar').length,1);
 const receipt=(await f.db.query('SELECT response FROM crm_audience_v2.request')).rows[0].response;assert.equal(receipt._http,409);assert.equal(receipt._body.error,'SEGMENT_CATALOG_CHANGED');
});
test('reopened saved money keeps saved BRL and blocks count/save after source changes, even with a new catalog hash',async t=>{
 const f=await setup(t),x=boot(f);await x.ui.sync({api,brand:'aristo'});x.input('[data-gs-name]','Gasto antigo','input');await click(x,'add-condition');x.input('[data-gs-field]','purchase.amount');x.input('[data-gs-value]','100,00');x.q('[data-gs="remove"][data-path="0"]').click();await click(x,'save');
 const original=(await rows(f))[0];await f.db.exec("UPDATE crm_audience_v2.config SET catalog=jsonb_set(catalog,'{currency}','\"USD\"'::jsonb) WHERE brand='aristo'");
 const fresh=boot(f);await fresh.ui.sync({api,brand:'aristo'});assert.match(fresh.element.textContent,/Valor em BRL/);assert.doesNotMatch(fresh.element.textContent,/Valor em USD/);assert.equal(fresh.q('[data-gs="save"]').disabled,true);assert.equal(fresh.q('[data-gs="count"]').disabled,true);
 const listed=await f.call({acao:'segmentos_listar',brand:'aristo',limit:50,offset:0});const hash=listed.body.catalog.catalog_hash;
 assert.deepEqual(listed.body.segments[0].semantic_context,{currency:'BRL',timezone:'America/Sao_Paulo',current:false});
 const r=await f.call({acao:'segmento_salvar',brand:'aristo',id:original.id,expected_version:1,definition:{...original.definition,name:'Ainda significa reais'},idempotency_key:'changed-context-save',expected_catalog_hash:hash});assert.equal(r.status,409);assert.equal(r.body.error,'SEGMENT_CATALOG_CHANGED');assert.equal((await rows(f))[0].version,1);
});

// Exercise the actual analyst path with server-owned source semantics; the UI
// cannot turn an arbitrary available flag into a connected source.
test('engagement DOM → persisted source pins → SQL counts registered events by brand and rechecks opt-out',async t=>{
 const f=await setup(t);
 await f.db.exec(`CREATE TABLE campaigns(id integer PRIMARY KEY,attribs jsonb,messenger text,type text);
 CREATE TABLE campaign_views(campaign_id integer,subscriber_id integer,created_at timestamptz);
 CREATE TABLE link_clicks(campaign_id integer,subscriber_id integer,created_at timestamptz);
 INSERT INTO campaigns VALUES(11,'{"crm":{"brand":"fish","policy":"crm-campaign-v1"}}','email','regular'),(12,'{"crm":{"brand":"aristo","policy":"crm-campaign-v1"}}','email','regular'),(13,'{}','email','regular');
 INSERT INTO campaign_views VALUES(11,1,clock_timestamp()-interval '1 day'),(12,1,clock_timestamp()-interval '1 day');
 INSERT INTO link_clicks VALUES(11,1,clock_timestamp()-interval '1 day'),(13,1,clock_timestamp()-interval '1 day');`);
 for(const brand of ['fish','aristo']){
  const source=Fixture.source(brand);
  source.fields=source.fields.map(field=>field.key.startsWith('email.')?{...field,source_hash:Counter.engagementSourceHash(brand,field.key)}:field);
  await f.db.query('UPDATE crm_audience_v2.config SET catalog=$2::jsonb WHERE brand=$1',[brand,JSON.stringify(source)]);
  const x=boot(f);await x.ui.sync({api,brand});
  x.input('[data-gs-name]','Engajamento '+brand,'input');x.input('[data-gs-list]',brand==='fish'?'101':'201');
  await click(x,'add-condition');x.input('[data-gs-field]','email.opened');x.input('[data-gs-value]','30');
  assert.match(x.q('[data-gs-engagement-scope]').textContent,/campanhas de e-mail criadas no painel desta marca/);
  assert.match(x.q('[data-gs-engagement-scope]').textContent,/não comprova/);
  await click(x,'save');assert.match(x.element.textContent,/Público salvo/);
  const reopened=boot(f);await reopened.ui.sync({api,brand});await click(reopened,'count');
  assert.match(reopened.q('[data-gs-count]').textContent,/1 pessoas/);
  reopened.input('[data-gs-field]','email.clicked');reopened.input('[data-gs-value]','30');
  await click(reopened,'save');await click(reopened,'count');
  assert.match(reopened.q('[data-gs-count]').textContent,brand==='fish'?/1 pessoas/:/0 pessoas/);
  reopened.input('[data-gs-operator]','not_within_last_days');await click(reopened,'save');await click(reopened,'count');
  assert.match(reopened.q('[data-gs-count]').textContent,brand==='fish'?/0 pessoas/:/1 pessoas/);
  const record=(await rows(f)).find(r=>r.brand===brand);
  const revision=(await f.db.query('SELECT context FROM crm_audience_v2.revision WHERE audience_id=$1 AND version=$2',[record.id,record.version])).rows[0];
  assert.equal(revision.context.rules.find(r=>r.source==='email').source_hash,Counter.engagementSourceHash(brand,'email.clicked'));
  await f.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[brand==='fish'?17:16]);
  await click(reopened,'count');assert.match(reopened.q('[data-gs-count]').textContent,/0 pessoas/);
  assert.match(reopened.element.textContent,/Campanhas → Público salvo.*Contar não autoriza envio/);
 }
 assert.equal((await f.db.query('SELECT count(*) AS n FROM campaigns')).rows[0].n,3);
});
