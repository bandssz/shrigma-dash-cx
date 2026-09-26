'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const setupLegacy=require('./fixtures/growth-email-test-ui-fixture.cjs');
const {POLICY,normalize}=require('../n8n/growth/email-test-recipient-protocol.cjs');
// UI contract fixture only: transport, policy, quotas and concurrency are tested
// independently against the real client/protocol/PostgreSQL implementation.
function setup({brand='fish',announced=true,previewPatch={},gate=null}={}){
 const s=setupLegacy({brand}),original=s.ctx.GETest,calls=[],operations=[],testers=[];
 const client={inspect:()=>({blocked:false,operations}),capabilities:async()=>{calls.push({action:'capabilities'});return {contract:POLICY,enabled:true};},
  preview:async p=>{calls.push({action:'preview',...p});if(gate)await gate;return {contract:POLICY,eligible:true,brand,draft_id:p.draft_id,version:p.expected_version,recipient:p.recipient,from_email:s.draft.from_email,reply_to:s.draft.reply_to,rendered_subject:'[TESTE] Conteúdo fictício',body_html:'<p>Prévia de teste</p>',data:{first_name:'Pessoa de teste'},preview_token:'a'.repeat(64),source_hash:'b'.repeat(64),expires_at:new Date(Date.now()+300000).toISOString(),...previewPatch};},
  run:async p=>{calls.push({action:'send',...p});const op={id:'test-'+(operations.length+1),phase:'confirmed',request_payload:p,receipt:{http_accepted:true,ses:{}}};operations.push(op);return {phase:'confirmed',operation:op.receipt};},
  testers:async p=>{calls.push({action:'testers',...p});return {contract:POLICY,brand,testers:[...testers]};},
  setTester:async p=>{calls.push({action:'setTester',...p});const row={...p,expires_at:'2030-10-26T12:00:00Z',updated_at:'2030-09-26T12:00:00Z'};const index=testers.findIndex(t=>t.recipient===p.recipient);if(index<0)testers.push(row);else testers[index]=row;return {contract:POLICY,brand,testers:[...testers]};}
 };
 s.ctx.GETest={...original,RECIPIENT_POLICY:POLICY,recipient:value=>{const r=normalize(value);if(!r)throw Error('Informe um único e-mail válido.');return r;},create:options=>options.recipientPolicy===POLICY?client:original.create(options)};
 if(announced)s.ui.ctx.api.capabilities.templates.email_test_recipient=POLICY;s.ui.render();
 function type(value,id='#d-email-test-recipient'){const field=s.$(id);field.value=value;field.dispatchEvent(new s.window.Event('input'));}
 return {...s,calls,operations,testers,type};
}
test('recipient field appears from creation only under the exact capability and keeps the correct brand',()=>{
 for(const brand of ['fish','aristo']){
  const s=setup({brand});assert.ok(s.$('#d-email-test-recipient'));assert.equal(s.$('#d-email-test-preview').disabled,true);
  s.type('  Analista@SHRIGMA.COM.BR  ');assert.equal(s.$('#d-email-test-preview').disabled,false);assert.equal(s.ui.emailTestAddress(s.ui.state.rascunho),'analista@shrigma.com.br');assert.equal(s.calls.length,0);
  s.ui.novoTemplate('email');assert.ok(s.$('#d-email-test-recipient'));assert.equal(s.$('#d-email-test-recipient').value,'');assert.equal(s.$('#d-email-test-preview').disabled,true);assert.match(s.$('#d-email-test-input-help').textContent,/Salve/);
 }
 const off=setup({announced:false});assert.equal(off.$('#d-email-test-recipient'),null);assert.match(off.$('#d-email-test-preview').textContent,/Felipe/);assert.equal(off.calls.length,0);
});
test('multiple or invalid recipients never reach preview; valid preview and cancellation never send',async()=>{
 for(const brand of ['fish','aristo']){
  const s=setup({brand});for(const value of ['','one@shrigma.com.br,two@shrigma.com.br','One <one@shrigma.com.br>','one@shrigma.com.br\nbcc@example.com']){s.type(value);assert.equal(s.$('#d-email-test-preview').disabled,true);await s.ui.emailTestPrepare(s.ui.state.rascunho);assert.equal(s.calls.length,0);}
  s.type('analista@shrigma.com.br');await s.ui.emailTestPrepare(s.ui.state.rascunho);assert.deepEqual(s.calls.map(c=>c.action),['preview']);
  const dialog=s.$('#d-email-test-confirm');assert.match(dialog.textContent,/analista@shrigma.com.br/);assert.match(dialog.textContent,/\[TESTE\]/);assert.doesNotMatch(dialog.textContent,/Confirmar envio para Felipe/);assert.equal(dialog.querySelector('iframe').getAttribute('sandbox'),'');
  s.ui.emailTestCancel();assert.equal(s.calls.some(c=>c.action==='send'),false);assert.equal(s.ui.contextStatus().blocked,false);assert.equal(s.$('#d-email-test-recipient').value,'analista@shrigma.com.br');
 }
});

test('real UI and client preserve one send and its receipt after a lost response in both brands',async()=>{
 for(const brand of ['fish','aristo']){
  const s=setupLegacy({brand}),calls=[],operations=new Map();
  s.ctx.fetch=async(url,options)=>{
   const query=new URL(url).searchParams,p=options.body?JSON.parse(options.body):Object.fromEntries(query);
   assert.equal(query.has('recipient'),false);assert.equal(options.headers.Authorization,'Bearer synthetic-manager');calls.push(p.acao);
   let body;
   if(p.acao==='email_teste_capacidades_v2')body={contract:POLICY,policy_version:2,enabled:true,brands:['fish','aristo'],recipient_input:true,existing_only:false,limits:{per_revision:5,per_actor_hour:20},preview_ttl_seconds:300,prefix:'[TESTE] '};
   else if(p.acao==='email_teste_previa_v2')body={contract:POLICY,eligible:true,brand,draft_id:p.draft_id,version:p.expected_version,recipient:p.recipient,from_email:s.draft.from_email,reply_to:s.draft.reply_to,rendered_subject:'[TESTE] Prévia sintética',body_html:'<p>Prévia sintética</p>',data:{},preview_token:'a'.repeat(64),source_hash:'b'.repeat(64),expires_at:new Date(Date.now()+300000).toISOString(),subscriber_context:'external'};
   else if(p.acao==='email_teste_v2'){
    const {acao,...payload}=p;
    assert.equal(JSON.parse(s.values.get(s.ctx.GETest.SLOT)).operations.at(-1).phase,'pending');
    operations.set(p.idempotency_key,{idempotency_key:p.idempotency_key,actor:'panel:manager',state:'accepted',request_payload:payload,request_sha256:'a'.repeat(64),request_hash_schema:'postgres-jsonb-text-sha256-v1',draft_id:p.draft_id,version:p.expected_version,http_accepted:true,ses:{}});
    throw Error('Synthetic response lost after acceptance');
   }else if(p.acao==='email_teste_operacao_v2')body={contract:POLICY,operation:operations.get(p.idempotency_key)||{idempotency_key:p.idempotency_key,actor:'panel:manager',state:'missing',request_payload:null}};
   else throw Error('Unexpected route '+p.acao);
   return {status:200,json:async()=>body};
  };
  s.ui.ctx.api.capabilities.templates.email_test_recipient=POLICY;s.ui.render();
  const input=s.$('#d-email-test-recipient');input.value='Analista@SHRIGMA.COM.BR';input.dispatchEvent(new s.window.Event('input'));
  await s.ui.emailTestPrepare(s.ui.state.rascunho);assert.ok(s.$('#d-email-test-confirm'));
  assert.equal(calls.filter(a=>a==='email_teste_capacidades_v2').length,1);
  await Promise.all([s.ui.emailTestSend(),s.ui.emailTestSend()]);
  const operation=JSON.parse(s.values.get(s.ctx.GETest.SLOT)).operations[0];
  assert.equal(operation.phase,'confirmed');assert.equal(operation.request_payload.recipient,'analista@shrigma.com.br');
  assert.equal(calls.filter(a=>a==='email_teste_v2').length,1);assert.equal(s.$('#d-email-test-preview').disabled,true);
  await s.ui.emailTestReconcile(operation.id);assert.equal(calls.filter(a=>a==='email_teste_v2').length,1);
  assert.match(s.document.body.textContent,/analista@shrigma.com.br/);
 }
});
test('confirmation captures recipient and revision, prevents double clicks and allows a different recipient',async()=>{
 const s=setup();s.type('one@shrigma.com.br');await s.ui.emailTestPrepare(s.ui.state.rascunho);await Promise.all([s.ui.emailTestSend(),s.ui.emailTestSend()]);
 const sends=s.calls.filter(c=>c.action==='send');assert.equal(sends.length,1);assert.equal(sends[0].recipient,'one@shrigma.com.br');assert.equal(sends[0].expected_version,1);assert.equal(sends[0].preview_token,'a'.repeat(64));assert.equal(sends[0].confirm,'enviar_teste');assert.equal(Object.hasOwn(sends[0],'render_policy'),false);
 assert.equal(s.$('#d-email-test-preview').disabled,true);assert.match(s.document.body.textContent,/one@shrigma.com.br/);s.type('two@shrigma.com.br');assert.equal(s.$('#d-email-test-preview').disabled,false);
});
test('recipient, revision or capability changes invalidate confirmation without sending',async()=>{
 for(const change of ['recipient','revision','capability']){
  const s=setup();s.type('one@shrigma.com.br');await s.ui.emailTestPrepare(s.ui.state.rascunho);
  if(change==='recipient')s.ui.emailTestRecipients.set(s.ui.emailTestRecipientKey(s.ui.state.rascunho),'two@shrigma.com.br');
  if(change==='revision')s.ui.state.rascunho.servidor.version++;
  if(change==='capability')delete s.ui.ctx.api.capabilities.templates.email_test_recipient;
  await s.ui.emailTestSend();assert.equal(s.calls.some(c=>c.action==='send'),false,change);assert.equal(s.ui.emailTestSession,null);
 }
});
test('opt-out and mismatched previews show feedback and never open confirmation',async()=>{
 for(const patch of [{eligible:false,code:'recipient_opted_out'},{eligible:false,code:'recipient_not_allowed'},{recipient:'other@shrigma.com.br'},{rendered_subject:'Without test prefix'},{brand:'aristo'},{version:2}]){
  const s=setup({previewPatch:patch});s.type('one@shrigma.com.br');await s.ui.emailTestPrepare(s.ui.state.rascunho);assert.equal(s.$('#d-email-test-confirm'),null);assert.equal(s.calls.some(c=>c.action==='send'),false);assert.ok(s.$('.drafts-msg').textContent);
 }
});
test('a pending preview protects editing and brand changes',async()=>{
 let release;const gate=new Promise(r=>release=r),s=setup({gate});s.type('one@shrigma.com.br');const work=s.ui.emailTestPrepare(s.ui.state.rascunho);
 assert.equal(s.ui.contextStatus().blocked,true);assert.equal(s.ctx.changeBrand('aristo'),false);assert.equal(s.$('#d-assunto').disabled,true);
 release();await work;s.ui.emailTestCancel();assert.equal(s.calls.some(c=>c.action==='send'),false);
});
test('testers are brand-specific, require confirmation to authorize/revoke, and never send mail',async()=>{
 for(const brand of ['fish','aristo']){
  const s=setup({brand});await s.ui.emailTestersOpen();assert.equal(s.ui.contextStatus().blocked,true);s.type('caixa@gmail.com','#d-tester-email');s.$('#d-tester-add').click();assert.equal(s.calls.some(c=>c.action==='setTester'),false);assert.match(s.$('#d-email-test-confirm').textContent,/30 dias/);
  s.$('#d-tester-back').click();assert.equal(s.calls.some(c=>c.action==='setTester'),false);s.$('#d-tester-add').click();await Promise.all([s.ui.emailTesterConfirm(),s.ui.emailTesterConfirm()]);assert.equal(s.calls.filter(c=>c.action==='setTester').length,1);assert.equal(s.calls.find(c=>c.action==='setTester').brand,brand);assert.equal(s.testers[0].enabled,true);
  s.$('[data-tester-revoke]').click();assert.equal(s.testers[0].enabled,true);await s.ui.emailTesterConfirm();assert.equal(s.testers[0].enabled,false);assert.equal(s.calls.some(c=>c.action==='send'),false);s.ui.emailTestCancel();assert.equal(s.ui.contextStatus().blocked,false);
 }
});
