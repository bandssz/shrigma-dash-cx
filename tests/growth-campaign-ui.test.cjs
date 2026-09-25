'use strict';
const audienceFixture=require('./campaign-audience-fixture.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const createLocks=require('./campaign-lock-fixture.cjs');
const {parseHTML}=require('linkedom'),C=require('../campaign-contract');
global.CampaignContract=C;const Editor=require('../growth-campaign-editor');
const root=path.resolve(__dirname,'..'),END='https://campaign.example.test/operations';
const api={capabilities:{campaigns:{contract_version:C.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:"listmonk-6.1-regular-v1"},endpoints:{campaigns:END}}};
const definition=()=>({schema_version:C.VERSION,brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Campanha de exemplo',subject:'Assunto',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[125],template_id:1,html:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',tags:[],send_at:'2030-09-20T15:00:00Z'});
const catalog={brand:'fish',current:true,lists:[{id:125,name:'Clientes recorrentes',brand:'fish',available:true}],templates:[{id:1,name:'Modelo principal',type:'campaign',available:true,version:'t1'}],initiatives:[]};
function boot({payload=api,store=new Map(),timeout=false,locks=createLocks(),masterOnly=false,beforeResponse=null,audiencePatch={},respond=null}={}){
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
 for(const file of ['n8n/growth/campaign-tracking.js','campaign-contract.js','growth-brand-state.js','growth-campaign-api.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 vm.runInContext('GCE.mount({marca:"fish",api:__api})',context);
 const dialog=require('./campaign-dialog-fixture.cjs')(document,window);
 return {document,window,calls,store,advance:ms=>{clock+=ms;},setCurrent:value=>{current=structuredClone(value);},confirmations:dialog.messages,accept:dialog.accept,run:code=>vm.runInContext(code,context),q:s=>document.querySelector(s)};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI did not reach expected state');}

test('absent capabilities keep local preparation and remote clicks do not issue requests; Olivas remains local',async()=>{
 const x=boot({payload:{}});assert.equal(x.q('[data-ce-remote]').hidden,true);x.q('[data-ce-save]').click();await new Promise(setImmediate);assert.equal(x.calls.length,0);
 const y=boot();y.run('GCE.preserve();GCE.mount({marca:"olivas",api:__api})');assert.equal(y.q('[data-ce-remote]').hidden,true);
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

test('campaign header context restores per-brand preparation without carrying lists or touching an uncertain journal',async()=>{
 const x=boot({timeout:true}),legacy=x.store.get('shrigma_campaign_composer_v1');
 x.q('[data-ce-save]').click();await until(()=>x.run('GCE.contextStatus().pending'));
 const journal=x.store.get('shrigma_campaign_operation_v1:fish');
 x.run('GCE.preserve();GCE.mount({marca:"aristo",api:__api})');
 assert.equal(x.q('[name=brand]').value,'aristo');assert.equal(x.q('[name=list_ids]').value,'');
 x.q('[name=subject]').value='Preparação Aristo';x.q('[name=subject]').dispatchEvent(new x.window.Event('input',{bubbles:true}));
 x.run('GCE.preserve();GCE.mount({marca:"fish",api:__api})');
 assert.equal(x.q('[name=subject]').value,'Assunto');assert.equal(x.q('[data-ce-save]').disabled,true);
 assert.equal(x.store.get('shrigma_campaign_operation_v1:fish'),journal);assert.equal(x.store.get('shrigma_campaign_composer_v1'),legacy);
 x.q('[data-ce-save]').click();await new Promise(setImmediate);assert.equal(x.calls.filter(c=>c.acao==='campanha_salvar').length,1);
 x.run('GCE.preserve();GCE.mount({marca:"aristo",api:__api})');assert.equal(x.q('[name=subject]').value,'Preparação Aristo');
});
test('a delayed catalog request blocks context switching until its response completes',async()=>{
 let release,entered;const barrier=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const x=boot({beforeResponse:async req=>{if(req.acao==='campanha_catalogo'){entered();await barrier;}}});
 x.q('[data-ce-refresh]').click();await started;
 assert.equal(x.run('GCE.contextStatus().blocked'),true);assert.equal(x.run('GCE.enterBrand("aristo")'),false);
 assert.equal(x.q('[name=brand]').value,'fish');release();await until(()=>!x.run('GCE.contextStatus().blocked'));
 x.run('GCE.preserve();GCE.mount({marca:"aristo",api:__api})');
 assert.equal(x.q('[name=brand]').value,'aristo');assert.equal(x.q('[data-ce-catalog]').textContent,'');
});
test('returning to a campaign cannot attach old local content to a newer journal revision',async()=>{
 const x=boot();x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);
 x.q('[name=subject]').value='Minha edição ainda local';x.q('[name=subject]').dispatchEvent(new x.window.Event('input',{bubbles:true}));
 x.run('GCE.preserve();GCE.mount({marca:"aristo",api:__api})');
 const key='shrigma_campaign_operation_v1:fish',journal=JSON.parse(x.store.get(key));journal.campaign.version='changed-in-other-tab';const changed=JSON.stringify(journal);x.store.set(key,changed);
 x.run('GCE.preserve();GCE.mount({marca:"fish",api:__api})');
 assert.equal(x.q('[name=subject]').value,'Minha edição ainda local');assert.equal(x.q('[data-ce-save]').disabled,true);assert.match(x.q('[data-ce-status]').textContent,/mudou em outra aba/);assert.equal(x.store.get(key),changed);assert.equal(x.calls.filter(c=>c.acao==='campanha_salvar').length,1);
});

test('a revision conflict stays frozen through catalog events, import, reset and field input until explicit reopen',async()=>{
 const x=boot();x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);
 x.q('[name=subject]').value='Preparação antiga preservada';x.q('[name=subject]').dispatchEvent(new x.window.Event('input',{bubbles:true}));
 x.run('GCE.preserve();GCE.mount({marca:"aristo",api:__api})');
 const journalKey='shrigma_campaign_operation_v1:fish',localKey='shrigma_growth_editor_v1:campaign:fish',journal=JSON.parse(x.store.get(journalKey));
 journal.campaign.version='v2';journal.campaign.definition.subject='Revisão nova do servidor';x.setCurrent(journal.campaign);const journalRaw=JSON.stringify(journal);x.store.set(journalKey,journalRaw);
 x.run('GCE.preserve();GCE.mount({marca:"fish",api:__api})');const localRaw=x.store.get(localKey);
 x.q('[data-ce-refresh]').click();await until(()=>x.q('[data-ce-list]')&&!x.run('GCE.contextStatus().blocked'));
 for(const selector of ['[data-ce-list]','[data-ce-template]','[data-ce-import]','[data-ce-reset]','[name=subject]'])assert.equal(x.q(selector).disabled,true,selector);
 x.q('[data-ce-list]').checked=false;x.q('[data-ce-list]').dispatchEvent(new x.window.Event('change'));
 x.q('[data-ce-template]').value='';x.q('[data-ce-template]').dispatchEvent(new x.window.Event('change'));
 x.q('[name=subject]').dispatchEvent(new x.window.Event('input',{bubbles:true}));
 let fileRead=false;Object.defineProperty(x.q('[data-ce-import]'),'files',{value:[{size:100,text:async()=>{fileRead=true;return JSON.stringify(definition());}}]});x.q('[data-ce-import]').dispatchEvent(new x.window.Event('change'));
 x.q('[data-ce-reset]').dispatchEvent(new x.window.Event('click'));x.q('[data-ce-save]').dispatchEvent(new x.window.Event('click'));await new Promise(setImmediate);
 assert.equal(fileRead,false);assert.equal(x.confirmations.length,0);assert.equal(x.q('[name=list_ids]').value,'125');assert.equal(x.q('[name=template_id]').value,'1');assert.equal(x.store.get(localKey),localRaw);assert.equal(x.store.get(journalKey),journalRaw);assert.equal(x.calls.filter(c=>c.acao==='campanha_salvar').length,1);assert.equal(x.q('[data-ce-save]').disabled,true);assert.match(x.q('[data-ce-status]').textContent,/mudou em outra aba/);
 x.q('[data-ce-open]').click();assert.equal(x.confirmations.length,1);assert.equal(x.q('[name=subject]').value,'Preparação antiga preservada');x.accept();await until(()=>!x.q('[data-ce-save]').disabled);
 assert.equal(x.q('[name=subject]').value,'Revisão nova do servidor');assert.equal(JSON.parse(x.store.get(localKey)).value._campaign.version,'v2');assert.equal(x.calls.filter(c=>c.acao==='campanha_salvar').length,1);
});

async function audienceReady(x){x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);x.q('[data-ce-validate]').click();await until(()=>/pessoas? pode/.test(x.q('[data-ce-audience]').textContent));}
test('audience display explains union, opt-out, exclusions and live count before confirmation',async()=>{
 const x=boot({audiencePatch:{eligible_count:1234,unique_members_count:1241,excluded_blocklisted_count:3,excluded_subscription_count:4}});await audienceReady(x);
 const text=x.q('[data-ce-audience]').textContent;assert.match(text,/1\.234 pessoas podem receber agora/);assert.match(text,/Descadastros e bloqueios conferidos/);assert.match(text,/outra lista selecionada/);assert.match(text,/3 bloqueados · 4 sem inscrição válida/);assert.match(text,/O total pode mudar até o envio/);
 const visible=x.q('[data-ce-audience]').cloneNode(true);visible.querySelectorAll('details').forEach(el=>el.remove());
 assert.match(visible.textContent,/1\.234 pessoas podem receber agora/);assert.match(visible.textContent,/Conferido em/);assert.match(visible.textContent,/Válido até/);assert.match(visible.textContent,/novos descadastros serão respeitados/);
 assert.doesNotMatch(visible.textContent,/outra lista selecionada/);assert.match(x.q('[data-ce-audience] details').textContent,/Inscrições e exclusões.*3 bloqueados · 4 sem inscrição válida.*outra lista selecionada/);
 x.q('[data-ce-schedule]').click();assert.match(x.confirmations.at(-1),/Fishermans/);assert.match(x.confirmations.at(-1),/1\.234 pessoas/);assert.equal(x.calls.some(c=>c.acao==='campanha_agendar'),false);x.accept();await until(()=>x.calls.some(c=>c.acao==='campanha_agendar'));
 assert.equal(x.calls.find(c=>c.acao==='campanha_agendar').audience_review_id,'00000000-0000-4000-8000-000000000001');
});
test('zero and disabled audiences remain visible but cannot open scheduling',async()=>{
 for(const patch of [{eligible_count:0,unique_members_count:0},{native_disabled_count:1}]){const x=boot({audiencePatch:patch});await audienceReady(x);assert.equal(x.q('[data-ce-schedule]').disabled,true);x.q('[data-ce-schedule]').click();assert.equal(x.confirmations.length,0);assert.equal(x.calls.some(c=>c.acao==='campanha_agendar'),false);assert.equal(x.q('[data-ce-validate]').disabled,false);if(patch.native_disabled_count)assert.match(x.q('[data-ce-audience] .ce-audience-warning').textContent,/Há contatos desativados.*Revise o público antes de agendar/);}
});
test('expiry while confirmation is open requires a new review with no schedule request',async()=>{
 const x=boot();await audienceReady(x);x.q('[data-ce-schedule]').click();x.advance(300001);x.accept();await until(()=>/venceu/.test(x.q('[data-ce-status]').textContent));assert.equal(x.calls.some(c=>c.acao==='campanha_agendar'),false);assert.equal(x.q('[data-ce-schedule]').disabled,true);assert.equal(x.q('[data-ce-validate]').disabled,false);
});
test('another tab replacing only the audience review invalidates the displayed approval',async()=>{
 const x=boot();await audienceReady(x);x.q('[data-ce-schedule]').click();const key='shrigma_campaign_operation_v1:fish',s=JSON.parse(x.store.get(key));s.validation.audience.review_id='00000000-0000-4000-8000-000000000002';x.store.set(key,JSON.stringify(s));x.accept();await until(()=>/mudou durante a confirmação/.test(x.q('[data-ce-status]').textContent));assert.equal(x.calls.some(c=>c.acao==='campanha_agendar'),false);
});

const RECOVERY_SOURCE='00000000-0000-4000-8000-000000000160',RECOVERY_OPERATION='00000000-0000-4000-8000-000000000161';
const recoveryApi={capabilities:{...api.capabilities,campaigns:{...api.capabilities.campaigns,recover:true,recovery_policy:'crm-campaign-recovery-v1'}}};
function recoverySetup(){
 const sourceKey='original-save-attempt-160',original={...definition(),send_at:'2099-09-20T15:00:00.000Z',html:'https://fishermans.com.br/ {{ UnsubscribeURL }}',text:'https://fishermans.com.br/ {{ UnsubscribeURL }}'},native={id:160,version:'native-160',status:'draft',sent:0,started_at:null,send_at:null,definition:{...original,send_at:null}},record={id:RECOVERY_SOURCE,operation_key:sourceKey,action:'salvar',brand:'fish',state:'outcome_unknown',providerId:160,response:{status:502,body:{error:'OUTCOME_UNKNOWN',message:'Original immutable receipt'}}};
 const proof={policy:'crm-campaign-recovery-v1',source_operation_id:RECOVERY_SOURCE,campaign:native,frozen:false},receipt={campaign:native,operation_id:RECOVERY_OPERATION,source_operation_id:RECOVERY_SOURCE,recovery_policy:proof.policy};
 const state={version:1,brand:'fish',endpoint:END,campaign:null,validation:null,operation:{phase:'uncertain',actorFingerprint:require('node:crypto').createHash('sha256').update('synthetic-write-secret').digest('hex'),key:sourceKey,request:{acao:'campanha_salvar',brand:'fish',definition:original,idempotency_key:sourceKey},created_at:'2026-09-25T12:00:00.000Z'}};
 const store=new Map([['shrigma_campaign_composer_v1',JSON.stringify(Editor.fromDefinition(original))],['shrigma_campaign_operation_v1:fish',JSON.stringify(state)]]);
 return {sourceKey,original,native,record,proof,receipt,store};
}
test('homepage-only campaign content stays editable with a specific error and never issues a save POST',async()=>{
 const x=boot();for(const name of ['html','text'])x.q(`[name=${name}]`).value='https://fishermans.com.br/ {{ UnsubscribeURL }}';x.q('[name=html]').dispatchEvent(new x.window.Event('input',{bubbles:true}));x.q('[data-ce-save]').click();await until(()=>/produto, página ou coleção/.test(x.q('[data-ce-status]').textContent));
 assert.equal(x.calls.filter(c=>c.acao==='campanha_salvar').length,0);assert.equal(x.store.has('shrigma_campaign_operation_v1:fish'),false);assert.equal(x.q('[name=html]').disabled,false);assert.equal(x.q('[name=html]').value,'https://fishermans.com.br/ {{ UnsubscribeURL }}');
});
test('existing-draft recovery requires an HTML confirmation and preserves requested content for update of the same ID',async()=>{
 const p=recoverySetup();let current=p.native;
 const x=boot({payload:recoveryApi,store:p.store,respond:async(req,init,store)=>{
  if(req.acao==='campanha_operacao')return {status:200,body:req.idempotency_key===p.sourceKey?{operation:p.record,recovery:p.proof}:{operation:{id:RECOVERY_OPERATION,operation_key:req.idempotency_key,action:'recuperar',providerId:160,brand:'fish',state:'succeeded',response:{status:200,body:p.receipt}}}};
  if(req.acao==='campanha_recuperar'){const s=JSON.parse(store.get('shrigma_campaign_operation_v1:fish'));assert.deepEqual(s.sourceOperation.serverRecord,p.record);assert.equal(s.sourceOperation.request.definition.send_at,p.original.send_at);assert.equal(s.operation.phase,'pending');return {status:200,body:p.receipt};}
  if(req.acao==='campanha_obter')return {status:200,body:{campaign:current}};
  if(req.acao==='campanha_salvar'){assert.equal(req.id,160);assert.equal(req.expected_version,'native-160');current={...current,definition:req.definition,send_at:req.definition.send_at,version:'edited-160'};return {status:200,body:{campaign:current}};}
 }});
 assert.equal(x.q('[data-ce-recover]').hidden,true);x.q('[data-ce-consult]').click();await until(()=>!x.q('[data-ce-recover]').hidden);assert.equal(x.q('[data-ce-save]').disabled,true);
 x.q('[data-ce-recover]').click();assert.equal(x.confirmations.length,1);assert.match(x.confirmations[0],/Fishermans.*campanha 160.*0 envios.*não cria outra campanha, não agenda e não envia/);assert.equal(x.calls.some(c=>c.acao==='campanha_recuperar'),false);x.q('[data-ce-confirm-no]').click();await until(()=>!x.q('[data-ce-recover]').disabled);assert.equal(x.calls.some(c=>c.acao==='campanha_recuperar'),false);
 x.q('[data-ce-recover]').click();x.accept();await until(()=>!x.q('[data-ce-save]').disabled);
 assert.match(x.q('[data-ce-status]').textContent,/Seu conteúdo original foi preservado/);assert.equal(x.q('[name=send_at]').value,'2099-09-20T12:00:00');assert.equal(x.q('[name=html]').value,p.original.html);assert.match(x.q('[data-ce-server-state]').textContent,/Há alterações locais/);assert.equal(x.q('[data-ce-validate]').disabled,true);
 const saved=JSON.parse(x.store.get('shrigma_growth_editor_v1:campaign:fish'));assert.deepEqual(saved.value._campaign,{id:160,version:'native-160'});assert.deepEqual(JSON.parse(x.store.get('shrigma_campaign_operation_v1:fish')).sourceOperation.serverRecord,p.record);
 for(const n of ['html','text']){x.q(`[name=${n}]`).value=definition()[n];x.q(`[name=${n}]`).dispatchEvent(new x.window.Event('input',{bubbles:true}));}x.q('[data-ce-save]').click();await until(()=>x.calls.some(c=>c.acao==='campanha_salvar'));assert.equal(x.calls.filter(c=>c.acao==='campanha_salvar').length,1);assert.equal(x.calls.find(c=>c.acao==='campanha_salvar').id,160);assert.equal(x.calls.find(c=>c.acao==='campanha_salvar').definition.send_at,p.original.send_at);
});
test('recovery confirmation refuses changed journal, access or context without a reconciliation POST',async()=>{
 for(const change of ['journal','writer','brand']){
  const p=recoverySetup(),x=boot({payload:recoveryApi,store:p.store,respond:async req=>req.acao==='campanha_operacao'?{status:200,body:{operation:p.record,recovery:p.proof}}:undefined});x.q('[data-ce-consult]').click();await until(()=>!x.q('[data-ce-recover]').hidden);x.q('[data-ce-recover]').click();
  if(change==='journal'){const s=JSON.parse(x.store.get('shrigma_campaign_operation_v1:fish'));s.recoveryProof.campaign.version='changed';x.store.set('shrigma_campaign_operation_v1:fish',JSON.stringify(s));}
  if(change==='writer')x.store.set('write-slot','changed-key');
  if(change==='brand'){assert.equal(x.run('GCE.enterBrand("aristo")'),false);x.q('[name=brand]').value='aristo';}
  x.accept();await new Promise(setImmediate);assert.equal(x.calls.some(c=>c.acao==='campanha_recuperar'),false,change);assert.equal(JSON.parse(x.store.get('shrigma_campaign_operation_v1:fish')).operation.key,p.sourceKey);
 }
});
test('lost recovery response reloads safely, consults its new identity and preserves both the original request and newer edits',async()=>{
 const p=recoverySetup();let accepted=false;
 const respond=async req=>{if(req.acao==='campanha_recuperar'){accepted=true;throw Error('lost response');}if(req.acao==='campanha_operacao')return {status:200,body:accepted?{operation:{id:RECOVERY_OPERATION,operation_key:req.idempotency_key,action:'recuperar',providerId:160,brand:'fish',state:'succeeded',response:{status:200,body:p.receipt}}}:{operation:p.record,recovery:p.proof}};if(req.acao==='campanha_obter')return {status:200,body:{campaign:p.native}};};
 const x=boot({payload:recoveryApi,store:p.store,respond});x.q('[data-ce-consult]').click();await until(()=>!x.q('[data-ce-recover]').hidden);x.q('[data-ce-recover]').click();x.accept();await until(()=>/Resultado não confirmado/.test(x.q('[data-ce-status]').textContent));assert.equal(x.q('[data-ce-save]').disabled,true);
 const state=JSON.parse(x.store.get('shrigma_campaign_operation_v1:fish')),newKey=state.operation.key;assert.notEqual(newKey,p.sourceKey);assert.deepEqual(state.sourceOperation.serverRecord,p.record);
 const y=boot({payload:recoveryApi,store:p.store,respond});assert.equal(y.q('[data-ce-save]').disabled,true);y.q('[data-ce-consult]').click();await until(()=>!y.q('[data-ce-save]').disabled);assert.equal(y.calls.find(c=>c.acao==='campanha_operacao').idempotency_key,newKey);assert.equal(y.calls.some(c=>c.acao==='campanha_recuperar'),false);assert.equal(y.q('[name=send_at]').value,'2099-09-20T12:00:00');assert.equal(y.q('[name=html]').value,p.original.html);
 y.q('[name=subject]').value='Correção local posterior';y.q('[name=subject]').dispatchEvent(new y.window.Event('input',{bubbles:true}));y.q('[data-ce-consult]').click();await until(()=>!y.run('GCE.contextStatus().blocked'));assert.equal(y.q('[name=subject]').value,'Correção local posterior');assert.deepEqual(JSON.parse(p.store.get('shrigma_campaign_operation_v1:fish')).sourceOperation.serverRecord,p.record);
});
