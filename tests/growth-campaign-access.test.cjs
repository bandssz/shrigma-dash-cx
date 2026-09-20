'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const {parseHTML}=require('linkedom'),locks=require('./campaign-lock-fixture.cjs'),C=require('../campaign-contract');
global.CampaignContract=C;const E=require('../growth-campaign-editor'),root=path.resolve(__dirname,'..');
const file=extra=>JSON.stringify({schema:'shrigma_panel_access_v1',panel:'campaign',role:'write',key:'synthetic-campaign-writer',...extra});
const definition=()=>({schema_version:C.VERSION,brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Fixture técnica',subject:'Fixture',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[1000],template_id:1,html:'https://fishermans.com.br/products/fixture {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/fixture {{ UnsubscribeURL }}',tags:[],send_at:'2099-01-01T15:00:00.000Z'});
function boot({store=new Map(),legacyWrite='',failure=null,beforeCatalog=null}={}){
 const {document,window}=parseHTML('<section id="campaign-composer"></section>');let focused=null;window.HTMLElement.prototype.focus=function(){if(!this.disabled&&!this.closest('fieldset')?.disabled)focused=this;};Object.defineProperty(document,'activeElement',{get:()=>focused});
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 if(!store.has('shrigma_campaign_composer_v1'))store.set('shrigma_campaign_composer_v1',JSON.stringify(E.fromDefinition(definition())));
 store.set('read','synthetic-reader');if(legacyWrite)store.set('write',legacyWrite);
 const calls=[],writes=[],confirms=[];let c={id:1000,version:'v1',status:'draft',sent:0,started_at:null,send_at:definition().send_at,definition:definition()};
 const ctx=vm.createContext({document,window,Date,Intl,URL,URLSearchParams,AbortSignal,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,navigator:{locks:locks()},GTA:{CHAVE_ESCRITA:'write',CHAVE_LEITURA:'read'},GMP:{openEmail:()=>{}},
  localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>{writes.push(k);store.set(k,v);},removeItem:k=>{writes.push(k);store.delete(k);}},confirm:text=>{confirms.push(text);return true;},
  fetch:async(url,init)=>{const req=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push({req,init});let body;
   if(init.method==='POST'){const journal=JSON.parse(store.get('shrigma_campaign_operation_v1:fish'));assert.equal(journal.operation.phase,'pending');assert.equal(journal.operation.key,req.idempotency_key);assert.ok(!JSON.stringify(journal).includes(req.k));if(failure==='timeout')throw Error('fixture lost response');if(failure)return {status:failure,json:async()=>({error:failure===401?'UNAUTHORIZED':'CAPABILITY_MISSING',operation_id:null})};}
   if(req.acao==='campanha_catalogo'){await beforeCatalog?.();body={brand:'fish',current:true,lists:[{id:1000,name:'Lista técnica vazia',available:true,brand:'fish'}],templates:[{id:1,name:'Fixture',type:'campaign',available:true}]};}
   else if(req.acao==='campanha_operacao')body={operation:{brand:'fish',state:'outcome_unknown'}};
   else if(req.acao==='campanha_listar')body={campaigns:[c]};
   else{if(req.acao==='campanha_salvar')c={...c,definition:req.definition};if(req.acao==='campanha_agendar')c={...c,status:'scheduled'};if(req.acao==='campanha_cancelar')c={...c,status:'cancelled',version:'v2'};body={campaign:c,...(req.acao==='campanha_validar'?{validation:{policy:C.VERSION,version:c.version,ok:true}}:{})};}
   return {status:200,json:async()=>structuredClone(body)};}});
 for(const name of ['campaign-contract.js','growth-campaign-api.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),ctx,{filename:name});
 const run=s=>vm.runInContext(s,ctx);run('GCE.mount({marca:"fish",api:{capabilities:{campaigns:{contract_version:"crm-campaign-v1",brands:["fish"],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true},endpoints:{campaigns:"https://fixture.test/campaigns"}}}})');
 const q=s=>document.querySelector(s),submit=()=>q('[data-ce-access-form]').onsubmit({preventDefault(){}});
 async function importFile(text){const field=q('[data-ce-access-file]');Object.defineProperty(field,'files',{configurable:true,value:[{size:typeof text==='string'?text.length:100,text:()=>typeof text==='function'?text():Promise.resolve(text)}]});await field.onchange();}
 function prepare(k='synthetic-campaign-writer'){q('[data-ce-access-open]').click();q('[data-ce-key]').value=k;submit();}
 return {run,q,document,window,store,calls,writes,confirms,submit,importFile,prepare,focused:()=>focused};
}
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI did not finish');}
const posts=x=>x.calls.filter(c=>c.init.method==='POST');
test('campaign writer import has exact schema/panel/role and rejects reader, master, content and extra fields',()=>{
 assert.deepEqual(E.parseAccessFile(file()),{key:'synthetic-campaign-writer'});
 for(const p of [file({panel:'growth'}),file({panel:'influs'}),file({role:'read'}),file({role:'master'}),file({key:' '}),file({key:'bad key'}),file({endpoint:'https://fixture.test'}),file({author:'Operator'}),JSON.stringify(definition()),'null','[]','{',' '.repeat(8193)])assert.throws(()=>E.parseAccessFile(p));
});
test('missing writer opens form before any read/POST; empty, cancel and Escape preserve draft without key storage',async()=>{
 const x=boot(),before=x.store.get('shrigma_campaign_composer_v1');x.q('[data-ce-save]').click();assert.equal(x.q('[data-ce-access-form]').hidden,false);assert.equal(x.calls.length,0);
 x.submit();assert.equal(x.q('[data-ce-key]').getAttribute('aria-invalid'),'true');assert.equal(x.calls.length,0);x.q('[data-ce-key]').value='unconfirmed';x.q('[data-ce-key]').dispatchEvent(new x.window.Event('input',{bubbles:true}));assert.deepEqual(x.writes,[]);
 x.q('[data-ce-access-cancel]').click();assert.equal(x.q('[data-ce-key]').value,'');assert.equal(x.q('[data-ce-access-form]').hidden,true);assert.equal(x.store.get('shrigma_campaign_composer_v1'),before);
 x.q('[data-ce-access-open]').click();x.q('[data-ce-access-form]').onkeydown({key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(x.calls.length,0);assert.equal(x.store.has('write'),false);
});
test('import only fills password; native form submit prepares memory and a later explicit Save owns journal before POST',async()=>{
 const x=boot();x.q('[data-ce-save]').click();await x.importFile(file());assert.equal(x.calls.length,0);assert.equal(x.q('[data-ce-key]').value,'synthetic-campaign-writer');assert.equal(x.focused(),x.q('[data-ce-key]'));
 x.submit();x.submit();assert.equal(x.calls.length,0);assert.equal(x.q('[data-ce-key]').value,'');assert.equal(x.q('[data-ce-access-form]').hidden,true);assert.deepEqual(x.writes,[]);
 x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);assert.equal(posts(x).length,1);assert.equal(posts(x)[0].req.k,'synthetic-campaign-writer');assert.equal(x.store.has('write'),false);assert.ok(![...x.store.values()].join('').includes('synthetic-campaign-writer'));
});
test('wrong-role and cancelled async imports cannot authenticate or replay an action',async()=>{
 const x=boot();x.q('[data-ce-access-open]').click();await x.importFile(file({role:'read'}));x.submit();assert.equal(x.q('[data-ce-access-form]').hidden,false);assert.equal(x.calls.length,0);
 let done;const pending=x.importFile(()=>new Promise(r=>done=r));x.q('[data-ce-access-cancel]').click();done(file());await pending;assert.equal(x.q('[data-ce-key]').value,'');x.q('[data-ce-save]').click();assert.equal(x.calls.length,0);assert.equal(x.q('[data-ce-access-form]').hidden,false);
});
test('legacy means the existing writer slot only; refresh keeps session and does not promote read credentials or replay',async()=>{
 const x=boot({legacyWrite:'legacy-template-writer'});x.prepare();assert.equal(x.store.get('write'),'legacy-template-writer');x.q('[data-ce-refresh]').click();await until(()=>x.q('[data-ce-open]'));assert.equal(posts(x).length,0);
 x.q('[data-ce-save]').click();await until(()=>posts(x).length===1);assert.equal(posts(x)[0].req.k,'synthetic-campaign-writer');assert.equal(x.store.get('read'),'synthetic-reader');assert.ok(!x.writes.includes('write')&&!x.writes.includes('read'));
 const legacy=boot({legacyWrite:'existing-writer'});legacy.q('[data-ce-save]').click();await until(()=>posts(legacy).length===1);assert.equal(posts(legacy)[0].req.k,'existing-writer');
});
test('catalog-to-save window cannot replace author in the middle of an operation',async()=>{
 let done;const x=boot({beforeCatalog:()=>new Promise(r=>done=r)});x.prepare('original-writer');x.q('[data-ce-save]').click();await until(()=>!!done);assert.equal(x.q('[data-ce-access-open]').disabled,true);assert.equal(x.q('[data-ce-access-fields]').disabled,true);
 x.q('[data-ce-access-open]').click();x.q('[data-ce-key]').value='replacement-writer';x.submit();await x.importFile(file({key:'replacement-writer'}));done();await until(()=>posts(x).length===1);assert.equal(posts(x)[0].req.k,'original-writer');
});
test('cancelling access during a catalog read returns focus to the visible summary instead of a disabled control',async()=>{
 let done;const x=boot({beforeCatalog:()=>new Promise(r=>done=r)});x.q('[data-ce-access-open]').focus();x.q('[data-ce-access-open]').click();x.q('[data-ce-refresh]').click();await until(()=>!!done);assert.equal(x.q('[data-ce-access-open]').disabled,true);
 x.q('[data-ce-access-cancel]').click();assert.equal(x.focused(),x.q('.ce-shell > summary'));done();await until(()=>!x.q('[data-ce-access-open]').disabled);assert.equal(posts(x).length,0);assert.equal(x.q('[data-ce-access-form]').hidden,true);
});
test('401/403 preserve journal and old storage; preparing corrected access causes no automatic retry',async()=>{
 for(const failure of [401,403]){const x=boot({failure,legacyWrite:'old-writer'});x.prepare();x.q('[data-ce-save]').click();await until(()=>posts(x).length===1&&x.q('[data-ce-access-form]').hidden===false);const before=x.store.get('shrigma_campaign_operation_v1:fish');assert.equal(JSON.parse(before).operation.phase,'rejected');assert.equal(x.store.get('write'),'old-writer');
  x.q('[data-ce-key]').value='corrected-writer';x.submit();assert.equal(posts(x).length,1);assert.equal(x.store.get('shrigma_campaign_operation_v1:fish'),before);assert.equal(x.store.get('write'),'old-writer');}
});
test('uncertain operation survives reload without session key; same writer lookup is GET only, wrong writer cannot bypass fingerprint',async()=>{
 const x=boot({failure:'timeout'});x.prepare();x.q('[data-ce-save]').click();await until(()=>/incerto/.test(x.q('[data-ce-server-state]').textContent));const saved=x.store.get('shrigma_campaign_operation_v1:fish'),id=JSON.parse(saved).operation.key;
 const y=boot({store:x.store});assert.equal(y.q('[data-ce-save]').disabled,true);y.q('[data-ce-consult]').click();assert.equal(y.calls.length,0);y.prepare('wrong-writer');assert.equal(y.calls.length,0);y.q('[data-ce-consult]').click();await until(()=>/mesma chave/.test(y.q('[data-ce-status]').textContent));assert.equal(y.calls.length,0);assert.equal(y.store.get('shrigma_campaign_operation_v1:fish'),saved);
 y.prepare();assert.equal(y.calls.length,0);y.q('[data-ce-consult]').click();await until(()=>y.calls.length===1);assert.equal(y.calls[0].init.method,'GET');assert.equal(y.calls[0].req.idempotency_key,id);assert.equal(posts(y).length,0);assert.equal(y.q('[data-ce-save]').disabled,true);
});
test('four explicit actions keep one technical campaign and confirmation; access never creates a fifth POST',async()=>{
 const x=boot();x.prepare();x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);x.q('[data-ce-validate]').click();await until(()=>!x.q('[data-ce-schedule]').disabled);x.q('[data-ce-schedule]').click();await until(()=>!x.q('[data-ce-cancel]').disabled);x.q('[data-ce-cancel]').click();await until(()=>/Cancelada/.test(x.q('[data-ce-server-state]').textContent));
 assert.deepEqual(posts(x).map(c=>c.req.acao),['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar']);assert.ok(posts(x).slice(1).every(c=>c.req.id===1000));assert.equal(new Set(posts(x).map(c=>c.req.idempotency_key)).size,4);assert.equal(x.confirms.length,2);assert.ok(x.confirms.every(s=>s.includes('2099')));assert.equal(x.q('[data-ce-save]').disabled,true);assert.equal(x.q('[data-ce-cancel]').disabled,true);assert.equal(x.store.has('write'),false);
});
