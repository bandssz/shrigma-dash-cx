'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const createLocks=require('./campaign-lock-fixture.cjs');
const {parseHTML}=require('linkedom'),C=require('../campaign-contract');
global.CampaignContract=C;const Editor=require('../growth-campaign-editor');
const root=path.resolve(__dirname,'..'),END='https://campaign.example.test/operations';
const api={capabilities:{campaigns:{contract_version:C.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true},endpoints:{campaigns:END}}};
const definition=()=>({schema_version:C.VERSION,brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Campanha de exemplo',subject:'Assunto',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[125],template_id:1,html:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',tags:[],send_at:'2030-09-20T15:00:00Z'});
const catalog={brand:'fish',current:true,lists:[{id:125,name:'Clientes recorrentes',brand:'fish',available:true}],templates:[{id:1,name:'Modelo principal',type:'campaign',available:true,version:'t1'}],initiatives:[]};
function boot({payload=api,store=new Map(),timeout=false,locks=createLocks(),masterOnly=false}={}){
 const {document,window}=parseHTML('<section id="campaign-composer"></section>');
 const proto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 if(!store.has('shrigma_campaign_composer_v1'))store.set('shrigma_campaign_composer_v1',JSON.stringify(Editor.fromDefinition(definition())));
 store.set('write-slot','synthetic-write-secret');if(masterOnly){store.delete('read-slot');store.set('shrigma_k_mestre','synthetic-master-secret');}else store.set('read-slot','synthetic-read-secret');
 const calls=[];let current={id:100,version:'v1',status:'draft',sent:0,started_at:null,send_at:definition().send_at,definition:definition()};
 const context=vm.createContext({document,window,console,Date,Intl,URL,URLSearchParams,AbortSignal,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,navigator:{locks},shrigmaChave:panel=>panel==='growth'?(store.get('read-slot')||store.get('shrigma_k_mestre')||''):'',
  localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},GTA:{CHAVE_ESCRITA:'write-slot',CHAVE_LEITURA:'read-slot'},GMP:{openEmail:()=>{}},confirm:()=>{throw Error('native confirm must not be called');},__api:payload,
  fetch:async(url,init)=>{const req=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push(req);let body;
   if(req.acao==='campanha_catalogo')body=catalog;
   else if(req.acao==='campanha_listar')body={campaigns:[current]};
   else if(req.acao==='campanha_obter')body={campaign:current};
   else if(req.acao==='campanha_operacao')body={operation:{brand:'fish',state:'outcome_unknown'}};
   else{if(timeout)throw Error('lost transport response');if(req.acao==='campanha_salvar')current={...current,definition:req.definition};if(req.acao==='campanha_agendar')current={...current,status:'scheduled'};if(req.acao==='campanha_cancelar')current={...current,status:'cancelled',version:'v2'};body={campaign:current,...(req.acao==='campanha_validar'?{validation:{policy:C.VERSION,version:current.version,ok:true}}:{})};}
   return {status:200,json:async()=>structuredClone(body)};
  }});
 for(const file of ['campaign-contract.js','growth-campaign-api.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 vm.runInContext('GCE.mount({marca:"fish",api:__api})',context);
 const dialog=require('./campaign-dialog-fixture.cjs')(document,window);
 return {document,window,calls,store,confirmations:dialog.messages,accept:dialog.accept,run:code=>vm.runInContext(code,context),q:s=>document.querySelector(s)};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI did not reach expected state');}

test('absent capabilities keep local preparation and remote clicks do not issue requests; Olivas remains local',async()=>{
 const x=boot({payload:{}});assert.equal(x.q('[data-ce-remote]').hidden,true);x.q('[data-ce-save]').click();await new Promise(setImmediate);assert.equal(x.calls.length,0);
 const y=boot();y.q('[name=brand]').value='olivas';y.q('[name=brand]').dispatchEvent(new y.window.Event('change',{bubbles:true}));assert.equal(y.q('[data-ce-remote]').hidden,true);
 assert.equal(y.q('[name=list_ids]').closest('label').hidden,false);
});
test('operators select named catalogs, save, validate and explicitly schedule the reviewed date',async()=>{
 const x=boot();assert.ok(!x.q('[data-ce-server-state]').textContent.includes('Versão salva validada.'));x.q('[data-ce-refresh]').click();await until(()=>x.q('[data-ce-list]'));
 assert.match(x.q('[data-ce-catalog]').textContent,/Clientes recorrentes/);assert.match(x.q('[data-ce-catalog]').textContent,/Modelo principal/);
 assert.equal(x.q('[name=list_ids]').closest('label').hidden,true);assert.equal(x.q('[data-ce-key]').type,'password');assert.ok(!x.q('#campaign-composer').innerHTML.includes('synthetic-write-secret'));
 x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);assert.match(x.q('[data-ce-server-state]').textContent,/Rascunho · 0 enviados/);
 x.q('[data-ce-validate]').click();await until(()=>!x.q('[data-ce-schedule]').disabled);
 x.q('[name=subject]').value='Alterado';x.q('[name=subject]').dispatchEvent(new x.window.Event('input',{bubbles:true}));assert.equal(x.q('[data-ce-schedule]').disabled,true);
 x.q('[name=subject]').value='Assunto';x.q('[name=subject]').dispatchEvent(new x.window.Event('input',{bubbles:true}));
 x.q('[data-ce-schedule]').click();x.accept();await until(()=>/Agendada/.test(x.q('[data-ce-server-state]').textContent));
 assert.equal(x.confirmations.length,1);assert.match(x.confirmations[0],/Campanha de exemplo/);assert.match(x.confirmations[0],/20\/09\/2030/);
 const scheduled=x.calls.find(c=>c.acao==='campanha_agendar');assert.equal(scheduled.confirm,'agendar');assert.equal(scheduled.expected_version,'v1');
 assert.equal(x.q('[data-ce-save]').disabled,true);assert.equal(x.q('[data-ce-schedule]').disabled,true);assert.match(x.q('[data-ce-campaigns]').textContent,/Agendada/);assert.ok(!x.q('[data-ce-campaigns]').textContent.includes('Rascunho'));
});
test('uncertain save disables editing and survives reload without creating a second request',async()=>{
 const x=boot({timeout:true});x.q('[data-ce-save]').click();await until(()=>/Resultado pendente ou incerto/.test(x.q('[data-ce-server-state]').textContent));
 assert.equal(x.q('[name=brand]').disabled,true);assert.equal(x.q('[data-ce-reset]').disabled,true);
 const y=boot({store:x.store});assert.equal(y.q('[data-ce-save]').disabled,true);assert.equal(y.q('[name=html]').disabled,true);assert.equal(y.q('[data-ce-import]').disabled,true);
 y.q('[data-ce-save]').click();await new Promise(setImmediate);assert.equal(y.calls.length,0);
 y.q('[data-ce-consult]').click();await until(()=>y.calls.some(c=>c.acao==='campanha_operacao'));
 const lookup=y.calls.find(c=>c.acao==='campanha_operacao');assert.equal(lookup.k,'synthetic-write-secret');assert.equal(lookup.idempotency_key,x.calls.find(c=>c.acao==='campanha_salvar').idempotency_key);
});

test('the shared master key fallback can read the catalog without a dedicated Growth key',async()=>{
 const x=boot({masterOnly:true});x.q('[data-ce-refresh]').click();await until(()=>x.calls.some(c=>c.acao==='campanha_listar'));
 assert.equal(x.calls.find(c=>c.acao==='campanha_catalogo').k,'synthetic-master-secret');assert.ok(!x.q('#campaign-composer').innerHTML.includes('synthetic-master-secret'));
});
test('without Web Locks the editor preserves reading and local preparation but disables server writes',async()=>{
 const x=boot({locks:null});assert.match(x.q('[data-ce-server-state]').textContent,/proteção entre abas/);assert.equal(x.q('[data-ce-save]').disabled,true);assert.equal(x.q('[data-ce-new]').disabled,true);assert.equal(x.q('[name=subject]').disabled,false);
 x.q('[data-ce-refresh]').click();await until(()=>x.q('[data-ce-list]'));assert.ok(x.calls.every(c=>!['campanha_salvar','campanha_agendar'].includes(c.acao)));
});
test('cancel is optional and confirms saved name and date even with unsaved local changes',async()=>{
 const hidden=boot({payload:{capabilities:{...api.capabilities,campaigns:{...api.capabilities.campaigns,cancel:undefined}}}});assert.equal(hidden.q('[data-ce-cancel]').hidden,true);
 const x=boot();x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);x.q('[data-ce-validate]').click();await until(()=>!x.q('[data-ce-schedule]').disabled);x.q('[data-ce-schedule]').click();x.accept();await until(()=>!x.q('[data-ce-cancel]').disabled);
 x.q('[name=name]').value='Alteração que não foi salva';x.q('[name=name]').dispatchEvent(new x.window.Event('input',{bubbles:true}));assert.equal(x.q('[data-ce-cancel]').disabled,false);
 x.q('[data-ce-cancel]').click();x.accept();await until(()=>/Cancelada/.test(x.q('[data-ce-server-state]').textContent));const prompt=x.confirmations.at(-1);assert.match(prompt,/Campanha de exemplo/);assert.match(prompt,/20\/09\/2030/);assert.ok(!prompt.includes('Alteração que não foi salva'));
 assert.equal(x.calls.find(c=>c.acao==='campanha_cancelar').confirm,'cancelar');assert.equal(x.q('[data-ce-cancel]').disabled,true);assert.match(x.q('[data-ce-campaigns]').textContent,/Cancelada/);
});
