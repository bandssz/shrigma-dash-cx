'use strict';
const audienceFixture=require('./campaign-audience-fixture.cjs');
const Audience=require('../growth-audience.js');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const createLocks=require('./campaign-lock-fixture.cjs');
const {parseHTML}=require('linkedom'),C=require('../campaign-contract');
global.CampaignContract=C;const Editor=require('../growth-campaign-editor');
const root=path.resolve(__dirname,'..'),END='https://campaign.example.test/operations';
const api={capabilities:{campaigns:{contract_version:C.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:"listmonk-6.1-regular-v1"},endpoints:{campaigns:END}}};
const definition=()=>({schema_version:C.VERSION,brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Campanha de exemplo',subject:'Assunto',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[125],template_id:1,html:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',tags:[],send_at:'2030-09-20T15:00:00Z'});
const catalog={brand:'fish',current:true,lists:[{id:125,name:'Clientes recorrentes',brand:'fish',available:true}],templates:[{id:1,name:'Modelo principal',type:'campaign',available:true,version:'t1'}],initiatives:[]};
function boot({payload=api,brand='fish',store=new Map(),timeout=false,locks=createLocks(),masterOnly=false,beforeResponse=null,audiencePatch={},respond=null}={}){
 const {document,window}=parseHTML('<section id="campaign-composer"></section>');
 const proto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 if(!store.has('shrigma_campaign_composer_v1'))store.set('shrigma_campaign_composer_v1',JSON.stringify(Editor.fromDefinition(definition())));
 store.set('write-slot','synthetic-write-secret');if(masterOnly){store.delete('read-slot');store.set('shrigma_k_mestre','synthetic-master-secret');}else store.set('read-slot','synthetic-read-secret');
 const calls=[];let review=null;let current={id:100,version:'v1',status:'draft',sent:0,started_at:null,send_at:definition().send_at,definition:definition()};
 let clock=Date.now();const Clock=class extends Date{static now(){return clock;}};
 const context=vm.createContext({document,window,console,Date:Clock,Intl,URL,URLSearchParams,AbortSignal,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,navigator:{locks},shrigmaChave:panel=>panel==='growth'?(store.get('read-slot')||store.get('shrigma_k_mestre')||''):'',
  localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},GTA:{CHAVE_ESCRITA:'write-slot',CHAVE_LEITURA:'read-slot'},GMP:{openEmail:()=>{}},confirm:()=>{throw Error('native confirm must not be called');},__api:payload,
  fetch:async(url,init)=>{const req=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);if(init.method==='GET'){assert.equal(new URL(url).searchParams.has('k'),false);req.k=init.headers.Authorization?.slice(7);}calls.push(req);if(beforeResponse)await beforeResponse(req);if(respond){const custom=await respond(req,init,store);if(custom!==undefined)return {status:custom.status,json:async()=>structuredClone(custom.body)};}let body;
   if(req.acao==='campanha_catalogo')body=catalog;
   else if(req.acao==='campanha_listar')body={campaigns:[current]};
   else if(req.acao==='campanha_obter')body={campaign:current};
   else if(req.acao==='campanha_operacao')body={operation:{brand:'fish',state:'outcome_unknown'}};
   else{if(timeout)throw Error('lost transport response');if(req.acao==='campanha_salvar')current={...current,definition:req.definition};if(req.acao==='campanha_agendar')current={...current,status:'scheduled'};if(req.acao==='campanha_cancelar')current={...current,status:'cancelled',version:'v2'};if(req.acao==='campanha_validar')review=audienceFixture(current,clock,audiencePatch);body={campaign:current,...(req.acao==='campanha_validar'?{validation:{policy:C.VERSION,version:current.version,ok:true,audience:review}}:{}),...(req.acao==='campanha_agendar'?{audience:{...review,rechecked_at:review.checked_at}}:{})};}
   return {status:200,json:async()=>structuredClone(body)};
  }});
 for(const file of ['n8n/growth/campaign-tracking.js','campaign-contract.js','growth-brand-state.js','growth-campaign-api.js','growth-utm.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 vm.runInContext('GCE.mount({marca:'+JSON.stringify(brand)+',api:__api})',context);
 const dialog=require('./campaign-dialog-fixture.cjs')(document,window);
 return {document,window,calls,store,advance:ms=>{clock+=ms;},setCurrent:value=>{current=structuredClone(value);},confirmations:dialog.messages,accept:dialog.accept,run:code=>vm.runInContext(code,context),q:s=>document.querySelector(s)};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI did not reach expected state');}


const clone=v=>JSON.parse(JSON.stringify(v));
const apiFor=endpoint=>({capabilities:{...api.capabilities,endpoints:{campaigns:endpoint}}});
const currentCatalog=brand=>({brand,current:true,lists:[{id:125,brand,name:'Lista '+brand,available:true,total:999},{id:126,brand:brand==='fish'?'aristo':'fish',name:'Outra marca',available:true}],templates:[],initiatives:[]});
function dynamicReply(req){if(req.acao==='campanha_catalogo')return {status:200,body:currentCatalog(req.brand)};if(req.acao==='campanha_listar')return {status:200,body:{campaigns:[]}};}
async function load(x){x.q('[data-ce-refresh]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));}
test('confirmed catalogs update Public without extra requests, stay brand-bound and never invent list counts',async()=>{
 const x=boot({respond:dynamicReply});let notifications=0;const target=x.document.createElement('section'),view=Audience.mount({element:target});x.document.body.append(target);
 x.window.onCatalog=()=>{notifications++;view.update({brand:x.q('[name=brand]').value,catalogs:clone(x.run('GCE.catalogs()'))});};
 x.run('GCE.mount({marca:"fish",api:__api,onCatalog:window.onCatalog})');
 assert.deepEqual(clone(x.run('GCE.catalogs()')),[]);assert.equal(x.calls.length,0);
 for(const brand of ['fish','aristo']){
  x.run('GCE.mount({marca:'+JSON.stringify(brand)+',api:__api,onCatalog:window.onCatalog})');await load(x);
  const found=clone(x.run('GCE.catalogs()'));assert.equal(found.length,1);assert.equal(found[0].brand,brand);assert.equal(found[0].lists.length,1);
  const rows=Audience.rows({}, {brand,catalogs:found});assert.equal(rows[0].count,null);assert.equal(rows[0].measuredAt,null);assert.match(target.textContent,new RegExp('Lista '+brand));assert.match(target.textContent,/Sem contagem/);assert.doesNotMatch(target.textContent,/Outra marca|999/);
  found[0].lists[0].name='tampered';assert.notEqual(x.run('GCE.catalogs()[0].lists[0].name'),'tampered');
 }
 assert.equal(x.calls.length,4);assert.equal(notifications,3);assert.ok(x.calls.every(r=>['campanha_catalogo','campanha_listar'].includes(r.acao)));
});
test('brand switching clears catalog and its Public rows without touching drafts or the operation journal',async()=>{
 const x=boot({respond:dynamicReply});await load(x);const before=[...x.store];x.run('GCE.mount({marca:"aristo",api:__api})');
 assert.deepEqual(clone(x.run('GCE.catalogs()')),[]);assert.equal(x.q('[data-ce-catalog]').textContent,'');assert.deepEqual([...x.store],before);
 assert.equal(Audience.rows({}, {brand:'aristo',catalogs:clone(x.run('GCE.catalogs()'))}).length,0);
});
test('read and write access changes, absent capabilities and endpoint changes invalidate confirmed catalogs',async()=>{
 for(const change of ['read','write','capabilities','endpoint']){
  const x=boot({respond:dynamicReply});await load(x);assert.equal(x.run('GCE.catalogs().length'),1);
  if(change==='read')x.store.set('read-slot','synthetic-new-read');
  if(change==='write')x.store.set('write-slot','synthetic-new-write');
  const payload=change==='capabilities'?{}:change==='endpoint'?apiFor('https://another.example.test/operations'):api;
  x.run('GCE.mount({marca:"fish",api:'+JSON.stringify(payload)+'})');assert.deepEqual(clone(x.run('GCE.catalogs()')),[],change);assert.equal(x.calls.length,2);
 }
});
test('late catalog from a replaced endpoint or access cannot publish or paint its old source',async()=>{
 for(const change of ['endpoint','read']){
  let release,entered;const barrier=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const x=boot({respond:dynamicReply,beforeResponse:async req=>{if(req.acao==='campanha_catalogo'){entered();await barrier;}}});x.q('[data-ce-refresh]').click();await started;
  assert.equal(x.run('GCE.enterBrand("aristo")'),false);
  if(change==='read')x.store.set('read-slot','different-read-key');
  x.run('GCE.mount({marca:"fish",api:'+JSON.stringify(change==='endpoint'?apiFor('https://new.example.test/operations'):api)+'})');
  release();await until(()=>!x.run('GCE.contextStatus().blocked'));
  assert.deepEqual(clone(x.run('GCE.catalogs()')),[]);assert.equal(x.q('[data-ce-catalog]').textContent,'');assert.equal(x.calls.length,1,change);
 }
});
test('failed catalog refresh withdraws previous confirmation and empty Public explains how to load lists',async()=>{
 let fail=false;const x=boot({respond:req=>fail?{status:503,body:{error:'unavailable'}}:dynamicReply(req)});await load(x);assert.equal(x.run('GCE.catalogs().length'),1);fail=true;await load(x);
 assert.deepEqual(clone(x.run('GCE.catalogs()')),[]);const el=x.document.createElement('div');Audience.mount({element:el}).update({brand:'fish',catalogs:[]});assert.match(el.textContent,/Campanhas/);
});
