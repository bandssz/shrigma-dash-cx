'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const setup=require('./fixtures/growth-email-test-ui-fixture.cjs');
test('both brands show the exact fixed-recipient envelope in an isolated HTML preview; cancelling makes zero POSTs',async()=>{
 for(const brand of ['fish','aristo']){
  const s=setup({brand});assert.equal(s.$('#d-email-test-preview').disabled,false);await s.ui.emailTestPrepare(s.ui.state.rascunho);
  const panel=s.$('#d-email-test-confirm');assert.equal(panel.getAttribute('role'),'dialog');assert.match(panel.textContent,/felipebandeira@oaristocrata.com/);assert.match(panel.textContent,/✅ FINAL — Olá Felipe/);assert.match(panel.textContent,/first_name: Felipe/);assert.ok(panel.textContent.includes(s.draft.from_email));assert.ok(panel.textContent.includes(s.draft.reply_to));
  const frame=panel.querySelector('iframe');assert.equal(frame.getAttribute('sandbox'),'');assert.equal(frame.getAttribute('referrerpolicy'),'no-referrer');assert.doesNotMatch(frame.getAttribute('srcdoc'),/<script|href="https:\/\/example/);assert.match(frame.getAttribute('srcdoc'),/img-src &#39;none&#39;/);assert.match(frame.getAttribute('srcdoc'),/Conteúdo Felipe/);
  assert.equal(s.$('#d-assunto').disabled,true);s.$('#d-email-test-cancel').click();assert.equal(s.calls.filter(x=>x.method==='POST').length,0);assert.equal(s.values.has('shrigma_crm_email_tests_v1'),false);assert.equal(s.ui.contextStatus().blocked,false);assert.equal(s.focused(),s.$('#d-email-test-preview'));
 }
});
test('header brand and editing stay unchanged during slow preview and confirmation; key/version stay captured until receipt',async()=>{
 let release;const gate=new Promise(r=>release=r),s=setup({previewGate:gate});const pending=s.ui.emailTestPrepare(s.ui.state.rascunho);
 assert.equal(s.ctx.changeBrand('aristo'),false);assert.equal(s.ui.enterBrand('aristo'),false);assert.equal(s.$('[data-marca="fish"]').classList.contains('ativo'),true);assert.equal(s.ui.ctx.marca,'fish');
 release();await pending;assert.equal(s.ctx.changeBrand('aristo'),false);assert.equal(s.ui.abrir(s.ctx.drafts.novo({marca:'aristo'}),null),false);
 s.setKey('different-session');s.ui.ctx.api.capabilities.endpoints.templates='https://changed.invalid/templates';s.ui.render();await s.ui.emailTestSend();assert.equal(s.calls.filter(x=>x.method==='POST').length,1);assert.ok(s.calls.every(x=>x.headers.Authorization==='Bearer synthetic-manager'));assert.ok(s.calls.every(x=>new URL(x.url).origin==='https://example.invalid'));
 assert.match(s.document.body.textContent,/Envio aceito; entrega ainda não confirmada/);assert.doesNotMatch([...s.values.values()].join(''),/synthetic-manager|different-session/);assert.equal(s.$('#d-email-test-preview').disabled,true);
});
test('refresh restores an uncertain attempt and its only action is GET reconciliation, never another POST',async()=>{
 const first=setup({mode:'missing'});await first.ui.emailTestPrepare(first.ui.state.rascunho);await first.ui.emailTestSend();const id=JSON.parse(first.values.get('shrigma_crm_email_tests_v1')).operations[0].id;
 const reload=setup({values:first.values,operations:first.operations,mode:'missing'});assert.ok(reload.$('[data-email-test-receipt]'));assert.equal(reload.$('#d-email-test-preview').disabled,true);await reload.ui.emailTestReconcile(id);await reload.ui.emailTestPrepare(reload.ui.state.rascunho);
 assert.equal(first.calls.filter(x=>x.method==='POST').length,1);assert.equal(reload.calls.filter(x=>x.method==='POST').length,0);assert.ok(reload.calls.every(x=>new URL(x.url).searchParams.get('acao')==='email_teste_operacao'));assert.match(reload.document.body.textContent,/não envie|não repita|já tem uma tentativa/i);
});
test('ineligible or mismatched preview and a changed revision fail closed before POST',async()=>{
 for(const patch of [{eligible:false,code:'recipient_opted_out'},{recipient:'elsewhere@example.invalid'},{version:2},{brand:'aristo'}]){const s=setup({previewPatch:patch});await s.ui.emailTestPrepare(s.ui.state.rascunho);assert.equal(s.$('#d-email-test-confirm'),null);assert.equal(s.calls.filter(x=>x.method==='POST').length,0);assert.equal(s.ui.emailTestSession,null);}
 const s=setup();await s.ui.emailTestPrepare(s.ui.state.rascunho);s.ui.state.rascunho.servidor.version=2;await s.ui.emailTestSend();assert.equal(s.calls.filter(x=>x.method==='POST').length,0);assert.match(s.document.body.textContent,/versão mudou/i);
});
test('missing manager access or corrupt journal prevents even preview; no native confirmation is called',async()=>{
 for(const opts of [{key:''},{storageBlocked:true}]){const s=setup(opts);await s.ui.emailTestPrepare(s.ui.state.rascunho);assert.equal(s.calls.length,0);assert.equal(s.$('#d-email-test-preview').disabled,true);}
 const s=setup();s.values.set('shrigma_crm_email_tests_v1','{invalid');await s.ui.emailTestPrepare(s.ui.state.rascunho);assert.equal(s.calls.length,0);
});
test('Escape closes confirmation without a durable attempt and duplicate confirmation cannot make another POST',async()=>{
 const s=setup();await s.ui.emailTestPrepare(s.ui.state.rascunho);const event=new s.window.Event('keydown',{bubbles:true,cancelable:true});event.key='Escape';s.$('#d-email-test-confirm').dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(s.ui.emailTestSession,null);assert.equal(s.values.has('shrigma_crm_email_tests_v1'),false);
 await s.ui.emailTestPrepare(s.ui.state.rascunho);const first=s.ui.emailTestSend();await s.ui.emailTestSend();await first;assert.equal(s.calls.filter(x=>x.method==='POST').length,1);
});
test('a later complaint or failure remains visible even if delivery was recorded earlier',()=>{
 const s=setup();
 for(const flag of ['complaint','bounce','reject','rendering_failure']){
  assert.match(s.ui.emailTestSummary({phase:'confirmed',operation:{http_accepted:true,ses:{delivery:'2026-09-24T23:00:00Z',[flag]:'2026-09-24T23:01:00Z'}}}),/falha ou reclamação/);
 }
 assert.match(s.ui.emailTestSummary({phase:'confirmed',operation:{http_accepted:true,ses:{}}}),/ainda não confirmada/);
});
test('content guidance follows the open channel without promising publication, delivery or an unavailable WhatsApp email test',()=>{
 for(const brand of ['fish','aristo']){
  const s=setup({brand}),title=()=>s.$('#d-checagens .control-badge').title;
  assert.match(title(),/não confirma publicação nem entrega/);assert.match(title(),/envio de teste.*e-mail/);
  s.ui.abrir(s.ctx.drafts.novo({marca:brand,canal:'whatsapp',nome:'fixture_whatsapp',corpo:'Mensagem sintética.',categoria:'UTILITY'}),null);
  assert.match(title(),/não confirma publicação nem entrega/);assert.match(title(),/aprovação da Meta/);assert.doesNotMatch(title(),/e-mail|envio de teste/);
  assert.equal(!!s.$('#d-email-test-preview'),false);assert.equal(s.calls.length,0);
 }
});
test('switching brands clears only the transient test status and retains its labeled receipt and duplicate guard',async()=>{
 for(const brand of ['fish','aristo'])for(const mode of ['accepted','missing']){
  const s=setup({brand,mode}),other=brand==='fish'?'aristo':'fish';
  await s.ui.emailTestPrepare(s.ui.state.rascunho);await s.ui.emailTestSend();
  assert.ok(s.$('.drafts-msg'));
  const stored=s.values.get('shrigma_crm_email_tests_v1'),operation=JSON.parse(stored).operations[0];
  const receipt=()=>s.$('[data-email-test-receipt]').closest('li');
  const receiptBefore=receipt().textContent;
  assert.match(receipt().textContent,brand==='fish'?/Fishermans/:/O Aristocrata/);
  assert.equal(s.ctx.changeBrand(other),true);
  assert.equal(!!s.$('.drafts-msg'),false,'The previous brand transient status must not follow the header');
  assert.equal(s.ui.state.msg,'');assert.equal(s.ui.state.msgTone,'ok');
  assert.equal(s.values.get('shrigma_crm_email_tests_v1'),stored);
  assert.equal(s.$('[data-email-test-receipt]').dataset.emailTestReceipt,operation.id);
  assert.equal(receipt().textContent,receiptBefore);
  assert.match(receipt().textContent,brand==='fish'?/Fishermans/:/O Aristocrata/);
  assert.equal(s.ctx.changeBrand(brand),true);
  assert.equal(!!s.$('.drafts-msg'),false);
  assert.equal(s.$('#d-email-test-preview').disabled,true);
  assert.equal(s.values.get('shrigma_crm_email_tests_v1'),stored);
  assert.equal(s.calls.filter(x=>x.method==='POST').length,1);
 }
});
