'use strict';
const audienceFixture=require('./campaign-audience-fixture.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const {parseHTML}=require('linkedom'),locks=require('./campaign-lock-fixture.cjs'),C=require('../campaign-contract');
global.CampaignContract=C;const E=require('../growth-campaign-editor'),root=path.resolve(__dirname,'..');
const file=extra=>JSON.stringify({schema:'shrigma_panel_access_v1',panel:'campaign',role:'write',key:'synthetic-campaign-writer',...extra});
const definition=()=>({schema_version:C.VERSION,brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Fixture técnica',subject:'Fixture',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[1000],template_id:1,html:'https://fishermans.com.br/products/fixture {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/fixture {{ UnsubscribeURL }}',tags:[],send_at:'2099-01-01T15:00:00.000Z'});
function boot({store=new Map(),legacyWrite='',failure=null,beforeCatalog=null,dialogSupport=true,operatorWrite=''}={}){
 const {document,window}=parseHTML('<section id="campaign-composer"></section>');let focused=null;window.HTMLElement.prototype.focus=function(){if(!this.disabled&&!this.closest('fieldset')?.disabled)focused=this;};Object.defineProperty(document,'activeElement',{get:()=>focused});
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 if(!store.has('shrigma_campaign_composer_v1'))store.set('shrigma_campaign_composer_v1',JSON.stringify(E.fromDefinition(definition())));
 store.set('read','synthetic-reader');if(legacyWrite)store.set('write',legacyWrite);
 const calls=[],writes=[];let review=null;let c={id:1000,version:'v1',status:'draft',sent:0,started_at:null,send_at:definition().send_at,definition:definition()};
 const ctx=vm.createContext({document,window,Date,Intl,URL,URLSearchParams,AbortSignal,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,navigator:{locks:locks()},GTA:{CHAVE_ESCRITA:'write',CHAVE_LEITURA:'read'},shrigmaChaveOperador:(area,cap)=>area==='growth'&&cap==='draft'?operatorWrite:'',GMP:{openEmail:()=>{}},
  localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>{writes.push(k);store.set(k,v);},removeItem:k=>{writes.push(k);store.delete(k);}},confirm:()=>{throw Error('native confirm must not be called');},
  fetch:async(url,init)=>{const req=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push({req,init});let body;
   if(init.method==='POST'){const journal=JSON.parse(store.get('shrigma_campaign_operation_v1:fish'));assert.equal(journal.operation.phase,'pending');assert.equal(journal.operation.key,req.idempotency_key);assert.ok(!JSON.stringify(journal).includes(req.k));if(failure==='timeout')throw Error('fixture lost response');if(failure)return {status:failure,json:async()=>({error:failure===401?'UNAUTHORIZED':'CAPABILITY_MISSING',operation_id:null})};}
   if(req.acao==='campanha_catalogo'){await beforeCatalog?.();body={brand:'fish',current:true,lists:[{id:1000,name:'Lista técnica vazia',available:true,brand:'fish'}],templates:[{id:1,name:'Fixture',type:'campaign',available:true}]};}
   else if(req.acao==='campanha_operacao')body={operation:{brand:'fish',state:'outcome_unknown'}};
   else if(req.acao==='campanha_listar')body={campaigns:[c]};
   else{if(req.acao==='campanha_salvar')c={...c,definition:req.definition};if(req.acao==='campanha_agendar')c={...c,status:'scheduled'};if(req.acao==='campanha_cancelar')c={...c,status:'cancelled',version:'v2'};if(req.acao==='campanha_validar')review=audienceFixture(c,Date.now());body={campaign:c,...(req.acao==='campanha_validar'?{validation:{policy:C.VERSION,version:c.version,ok:true,audience:review}}:{}),...(req.acao==='campanha_agendar'?{audience:{...review,rechecked_at:review.checked_at}}:{})};}
   return {status:200,json:async()=>structuredClone(body)};}});
 for(const name of ['campaign-contract.js','growth-brand-state.js','growth-campaign-api.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),ctx,{filename:name});
 const run=s=>vm.runInContext(s,ctx);run('GCE.mount({marca:"fish",api:{capabilities:{campaigns:{contract_version:"crm-campaign-v1",brands:["fish"],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:"listmonk-6.1-regular-v1"},endpoints:{campaigns:"https://fixture.test/campaigns"}}}})');
 writes.length=0; // Migration is tested separately; access actions must never persist credentials.
 const q=s=>document.querySelector(s),submit=()=>q('[data-ce-access-form]').onsubmit({preventDefault(){}});
 async function importFile(text){const field=q('[data-ce-access-file]');Object.defineProperty(field,'files',{configurable:true,value:[{size:typeof text==='string'?text.length:100,text:()=>typeof text==='function'?text():Promise.resolve(text)}]});await field.onchange();}
 function prepare(k='synthetic-campaign-writer'){q('[data-ce-access-open]').click();q('[data-ce-key]').value=k;submit();}
 const dialog=dialogSupport?require('./campaign-dialog-fixture.cjs')(document,window):null;
 return {run,q,document,window,store,calls,writes,confirms:dialog?.messages,dialog,submit,importFile,prepare,focused:()=>focused,setFailure:v=>{failure=v;}};
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
 const x=boot();x.prepare();x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);x.q('[data-ce-validate]').click();await until(()=>!x.q('[data-ce-schedule]').disabled);x.q('[data-ce-schedule]').click();x.dialog.accept();await until(()=>!x.q('[data-ce-cancel]').disabled);x.q('[data-ce-cancel]').click();x.dialog.accept();await until(()=>/Cancelada/.test(x.q('[data-ce-server-state]').textContent));
 assert.deepEqual(posts(x).map(c=>c.req.acao),['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar']);assert.ok(posts(x).slice(1).every(c=>c.req.id===1000));assert.equal(new Set(posts(x).map(c=>c.req.idempotency_key)).size,4);assert.equal(x.confirms.length,2);assert.ok(x.confirms.every(s=>s.includes('2099')));assert.equal(x.q('[data-ce-save]').disabled,true);assert.equal(x.q('[data-ce-cancel]').disabled,true);assert.equal(x.store.has('write'),false);
});

async function readyToSchedule(x){x.prepare();x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);x.q('[data-ce-validate]').click();await until(()=>!x.q('[data-ce-schedule]').disabled);}
function importCampaign(x,value){const field=x.q('[data-ce-import]');Object.defineProperty(field,'files',{configurable:true,value:[{size:100,text:()=>typeof value==='function'?value():Promise.resolve(JSON.stringify(value))}]});field.dispatchEvent(new x.window.Event('change'));}
test('dialog cancellation by button, Escape or external close has no effects and restores focus',async()=>{
 for(const method of ['cancel','escape','close']){
  const x=boot(),before=x.store.get('shrigma_campaign_composer_v1');x.q('[data-ce-reset]').focus();x.q('[data-ce-reset]').click();
  assert.equal(x.dialog.dialog.open,true);assert.equal(x.focused(),x.q('[data-ce-confirm-no]'));assert.equal(x.q('[data-ce-save]').disabled,true);assert.equal(x.q('[data-ce-refresh]').disabled,true);assert.equal(x.q('[name=subject]').disabled,true);
  x.dialog[method]();await until(()=>!x.q('[data-ce-reset]').disabled);assert.equal(x.dialog.dialog.open,false);assert.equal(x.focused(),x.q('[data-ce-reset]'));assert.equal(x.store.get('shrigma_campaign_composer_v1'),before);assert.equal(x.calls.length,0);
 }
});
test('new preparation, reset, reopening and import each wait for their own explicit dialog',async()=>{
 const fresh=boot();fresh.q('[data-ce-new]').click();assert.equal(fresh.q('[name=subject]').value,'Fixture');assert.match(fresh.confirms[0],/nova preparação/);fresh.dialog.accept();await until(()=>fresh.q('[name=subject]').value==='');assert.equal(fresh.calls.length,0);assert.match(fresh.q('[data-ce-status]').textContent,/Nenhuma campanha foi criada/);
 const reset=boot(),legacy=reset.store.get('shrigma_campaign_composer_v1');reset.q('[data-ce-reset]').click();assert(reset.store.has('shrigma_campaign_composer_v1'));reset.dialog.accept();await until(()=>reset.q('[name=subject]').value==='');assert.equal(reset.store.get('shrigma_campaign_composer_v1'),legacy);assert.equal(JSON.parse(reset.store.get('shrigma_growth_editor_v1:campaign:fish')).value.subject,'');assert.equal(reset.calls.length,0);
 const open=boot();open.q('[data-ce-refresh]').click();await until(()=>open.q('[data-ce-open]'));const count=open.calls.length;open.q('[data-ce-open]').click();assert.equal(open.calls.length,count);assert.match(open.confirms[0],/conteúdo salvo/);open.dialog.accept();await until(()=>open.calls.some(c=>c.req.acao==='campanha_obter'));assert.equal(posts(open).length,0);
 const imported=boot();importCampaign(imported,{...definition(),subject:'Arquivo conferido'});await until(()=>imported.dialog.dialog.open);assert.equal(imported.q('[name=subject]').value,'Fixture');imported.dialog.accept();await until(()=>imported.q('[name=subject]').value==='Arquivo conferido');assert.equal(imported.calls.length,0);
});
test('one dialog blocks other actions and repeated acceptance makes only one schedule request',async()=>{
 const x=boot();await readyToSchedule(x);const count=x.calls.length;x.q('[data-ce-schedule]').click();assert.equal(x.dialog.dialog.open,true);
 for(const selector of ['[data-ce-save]','[data-ce-validate]','[data-ce-new]','[data-ce-refresh]','[data-ce-consult]','[data-ce-reset]','[data-ce-access-open]','[data-ce-preview]','[data-ce-export]'])x.q(selector).click();
 assert.equal(x.calls.length,count);assert.equal(x.confirms.length,1);assert.equal(x.q('[data-ce-access-form]').hidden,true);
 x.dialog.accept();x.dialog.accept();x.dialog.close();await until(()=>/Agendada/.test(x.q('[data-ce-server-state]').textContent));assert.equal(posts(x).filter(c=>c.req.acao==='campanha_agendar').length,1);
});
test('editing draft or changing saved revision in another tab invalidates the displayed schedule approval',async()=>{
 for(const change of ['draft','journal']){
  const x=boot();await readyToSchedule(x);x.q('[data-ce-schedule]').click();const count=posts(x).length;
  if(change==='draft')x.q('[name=subject]').value='Alteração durante confirmação';
  else{const state=JSON.parse(x.store.get('shrigma_campaign_operation_v1:fish'));state.campaign.version='changed-in-other-tab';x.store.set('shrigma_campaign_operation_v1:fish',JSON.stringify(state));}
  x.dialog.accept();await until(()=>/mudou durante a confirmação/.test(x.q('[data-ce-status]').textContent));assert.equal(posts(x).length,count);assert.equal(x.dialog.dialog.open,false);
 }
});
test('withdrawn capabilities or a different client cannot inherit a previous approval',async()=>{
 for(const endpoint of ['https://fixture.test/campaigns','https://changed.test/campaigns']){
  const x=boot();await readyToSchedule(x);x.q('[data-ce-schedule]').click();const count=posts(x).length;
  x.run('GCE.mount({api:{capabilities:{campaigns:{contract_version:"crm-campaign-v1",brands:["fish"],read:true,save:true,validate:true,schedule:false,cancel:true,operation:true},endpoints:{campaigns:'+JSON.stringify(endpoint)+'}}}})');
  x.dialog.accept();await until(()=>/mudou durante a confirmação/.test(x.q('[data-ce-status]').textContent));assert.equal(posts(x).length,count);
 }
});
test('changing legacy author while dialog is open aborts local replacement and preserves the original journal',async()=>{
 const x=boot({legacyWrite:'original-writer'}),before=x.store.get('shrigma_campaign_composer_v1');x.q('[data-ce-new]').click();x.store.set('write','changed-writer');x.dialog.accept();await until(()=>/mudou durante a confirmação/.test(x.q('[data-ce-status]').textContent));assert.equal(x.calls.length,0);assert.equal(x.store.get('shrigma_campaign_composer_v1'),before);assert.equal(x.store.has('shrigma_campaign_operation_v1:fish'),false);
});
test('missing or throwing native dialog support fails closed without fallback confirmation',async()=>{
 for(const throwing of [false,true]){
  const x=boot({dialogSupport:throwing}),before=x.store.get('shrigma_campaign_composer_v1');if(throwing)x.dialog.dialog.showModal=()=>{throw Error('dialog unavailable');};
  x.q('[data-ce-new]').click();await until(()=>/abrir a confirmação/.test(x.q('[data-ce-status]').textContent));assert.equal(x.calls.length,0);assert.equal(x.store.get('shrigma_campaign_composer_v1'),before);assert.equal(x.q('[data-ce-new]').disabled,false);
 }
});
test('a delayed file cannot replace content or launch a dialog after the local draft changed',async()=>{
 const x=boot();let done;importCampaign(x,()=>new Promise(r=>done=r));x.q('[name=subject]').value='Texto novo';x.q('[name=subject]').dispatchEvent(new x.window.Event('input',{bubbles:true}));done(JSON.stringify({...definition(),subject:'Arquivo atrasado'}));await until(()=>/mudou durante a leitura/.test(x.q('[data-ce-status]').textContent));assert.equal(x.q('[name=subject]').value,'Texto novo');assert.equal(x.dialog.dialog.open,false);assert.equal(x.calls.length,0);
});
test('cancel scheduling waits for confirmation, keeps the saved identity and restores focus when its action becomes unavailable',async()=>{
 const x=boot();await readyToSchedule(x);x.q('[data-ce-schedule]').click();x.dialog.accept();await until(()=>!x.q('[data-ce-cancel]').disabled);
 x.q('[name=name]').value='Nome não salvo';x.q('[data-ce-cancel]').focus();x.q('[data-ce-cancel]').click();assert.match(x.confirms.at(-1),/Fixture técnica/);assert.doesNotMatch(x.confirms.at(-1),/Nome não salvo/);const count=posts(x).length;
 x.dialog.cancel();await until(()=>!x.q('[data-ce-cancel]').disabled);assert.equal(posts(x).length,count);assert.equal(x.focused(),x.q('[data-ce-cancel]'));
 x.q('[data-ce-cancel]').click();x.dialog.accept();await until(()=>/Cancelada/.test(x.q('[data-ce-server-state]').textContent));assert.equal(x.focused(),x.q('.ce-shell > summary'));assert.equal(posts(x).at(-1).req.id,1000);assert.equal(posts(x).at(-1).req.expected_version,'v1');
});
test('a lost cancellation receipt preserves its journal and cannot be repeated through another confirmation',async()=>{
 const x=boot();await readyToSchedule(x);x.q('[data-ce-schedule]').click();x.dialog.accept();await until(()=>!x.q('[data-ce-cancel]').disabled);x.setFailure('timeout');x.q('[data-ce-cancel]').click();x.dialog.accept();await until(()=>/incerto/.test(x.q('[data-ce-server-state]').textContent));const saved=x.store.get('shrigma_campaign_operation_v1:fish'),count=posts(x).length;
 assert.equal(JSON.parse(saved).operation.phase,'uncertain');assert.equal(x.dialog.dialog.open,false);x.q('[data-ce-cancel]').click();x.q('[data-ce-new]').click();await new Promise(setImmediate);assert.equal(posts(x).length,count);assert.equal(x.dialog.dialog.open,false);assert.equal(x.store.get('shrigma_campaign_operation_v1:fish'),saved);
 const y=boot({store:x.store});assert.equal(y.q('[data-ce-cancel]').disabled,true);assert.equal(y.q('[data-ce-new]').disabled,true);assert.equal(y.calls.length,0);
});
test('the real styles keep the open dialog and both controls visible with bound labels and a mobile width rule',()=>{
 const CSSOM=require('cssom'),x=boot(),page=fs.readFileSync(path.join(root,'growth.html'),'utf8');
 const css=[...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n')+'\n'+fs.readFileSync(path.join(root,'growth-campaign-editor.css'),'utf8');
 const hidden=[];function rules(list){for(const r of list){if(r.cssRules)rules(r.cssRules);else if(r.selectorText&&r.style?.display==='none')hidden.push(...r.selectorText.split(',').filter(s=>!s.includes('::')));}}rules(CSSOM.parse(css).cssRules);
 x.q('[data-ce-reset]').click();assert.equal(x.dialog.dialog.open,true);assert.equal(x.q('[data-ce-confirm]').closest('details'),null);
 for(const selector of ['[data-ce-confirm]','[data-ce-confirm-no]','[data-ce-confirm-yes]']){let el=x.q(selector);while(el){assert.equal(el.hidden,false);for(const s of hidden)assert.equal(el.matches(s),false,selector+' is hidden by '+s);el=el.parentElement;}}
 assert(x.q('#'+x.dialog.dialog.getAttribute('aria-labelledby')));assert(x.q('#'+x.dialog.dialog.getAttribute('aria-describedby')));assert.equal(x.focused(),x.q('[data-ce-confirm-no]'));assert.match(css,/width:min\(520px,calc\(100vw - 32px\)\)/);x.dialog.cancel();
});

test('authenticated CRM operator uses its area session only after an explicit Save, retaining the journal guard',async()=>{
 const x=boot({operatorWrite:'synthetic-area-operator'});assert.equal(x.calls.length,0);assert.equal(x.q('[data-ce-access-form]').hidden,true);
 x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);assert.equal(posts(x).length,1);assert.equal(posts(x)[0].req.k,'synthetic-area-operator');assert.equal(x.store.has('write'),false);assert.ok(![...x.store.values()].join('').includes('synthetic-area-operator'));
});
