'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto'),{parseHTML}=require('linkedom');
const J=require('../growth-template-journal.js');
function setup({brand='fish',remote=true,lost=false}={}){
 const {document,window}=parseHTML('<html><body><section id="control-drafts"></section></body></html>'),values=new Map(),calls=[],operations=new Map(),held=new Set();let focused;
 window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 Object.defineProperty(document,'activeElement',{get:()=>focused?.isConnected?focused:document.body});
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},locks={request:async(k,opts,fn)=>{if(held.has(k))return fn(null);held.add(k);try{return await fn({});}finally{held.delete(k);}}};
 const ctx=vm.createContext({document,window,localStorage:storage,crypto:webcrypto,TextEncoder,URL,URLSearchParams,Date,Intl,console,navigator:{locks},setInterval:()=>1,shrigmaChaveOperador:()=> 'synthetic-manager',confirm:()=>{throw Error('Native confirmation forbidden');},
  fetch:async(url,options={})=>{
   calls.push({url,options});const json=(status,body)=>({status,json:async()=>body});
   if(options.method!=='POST'){const q=new URL(url).searchParams,id=q.get('idempotency_key');return json(200,{contract:'template_operation_v1',operation:operations.get(id)||{idempotency_key:id,acao:q.get('operacao'),actor:'fixture',hash_schema:'json-stable-sha256-v1',claim_id:null,request_payload:null,request_sha256:null,state:'missing',response:null}});}
   if(lost)throw Error('Synthetic lost response');
   const {k,...wire}=JSON.parse(options.body),payload=J.payloadFor(wire),body={draft_id:wire.draft_id||'synthetic-draft',version:wire.expected_version?wire.expected_version+1:1,estado:'rascunho',salvo_em:'2026-09-26T12:00:00Z'};
   operations.set(wire.idempotency_key,{idempotency_key:wire.idempotency_key,acao:wire.acao,actor:'fixture',hash_schema:'json-stable-sha256-v1',claim_id:null,request_payload:payload,request_sha256:await J.sha256(payload,webcrypto),state:'completed',response:{status:201,body}});return json(201,body);
  }});
 for(const f of ['growth-email-expressions.js','whatsapp-template-contract.js','growth-email-contract.js','growth-drafts.js','growth-templates-api.js','growth-template-journal.js','growth-table.js','growth-message-preview.js','growth-brand-state.js','growth-drafts-ui.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),ctx,{filename:f});
 const run=s=>vm.runInContext(s,ctx);run('globalThis.ui=GRU;globalThis.gr=GR;globalThis.gta=GTA');
 const api=remote?{capabilities:{templates:{draft:true,validate:true,submit:true,submit_email:true},endpoints:{templates:'https://example.invalid/templates'}}}:{};
 ctx.ui.render({marca:brand,api});
 const draft=(canal='whatsapp',extra={})=>ctx.gr.novo({marca:brand,canal,nome:'synthetic_template',corpo:canal==='email'?'<p>Olá, conteúdo de exemplo.</p>':'Olá, conteúdo de exemplo.',assunto:'Assunto de exemplo',preheader:'Resumo de exemplo',...(canal==='email'?{from_email:(brand==='fish'?'Fishermans <contato@fishermans.com.br>':'O Aristocrata <contato@oaristocrata.com>'),reply_to:brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com'}:{}),...extra});
 return {ui:ctx.ui,gr:ctx.gr,gta:ctx.gta,document,window,values,calls,run,draft,$:s=>document.querySelector(s),posts:()=>calls.filter(c=>c.options.method==='POST')};
}
test('one create menu identifies both channels equally and the current editor channel in both brands',()=>{
 for(const brand of ['fish','aristo'])for(const channel of ['whatsapp','email']){
  const s=setup({brand}),id=channel==='email'?'drafts-novo-email':'drafts-novo';
  assert.equal(s.$('#drafts-create summary').textContent,'Criar template');assert.equal(s.$('#drafts-novo').textContent,'WhatsApp');assert.equal(s.$('#drafts-novo-email').textContent,'E-mail');
  s.$('#'+id).click();assert.equal(s.ui.state.rascunho.canal,channel);assert.equal(s.ui.state.rascunho.marca,brand);
  assert.equal(s.$('#'+id).getAttribute('aria-pressed'),'true');assert.ok(s.$('#'+id).classList.contains('ativo'));assert.match(s.$('#draft-editor h2').textContent,channel==='email'?/E-mail/:/WhatsApp/);assert.equal(s.calls.length,0);
 }
});
test('switching an intact empty creation needs no discard but never exempts typed, imported or prefilled content or brand protection',()=>{
 for(const brand of ['fish','aristo']){
  const s=setup({brand});s.$('#drafts-novo').click();assert.equal(s.ui.contextStatus().dirty,true,'brand preservation stays conservative');s.$('#drafts-novo-email').click();
  assert.equal(!!s.$('#d-editor-change'),false);assert.equal(s.ui.state.rascunho.canal,'email');assert.equal(s.ui.contextStatus().dirty,true);
  s.$('#drafts-novo').click();assert.equal(!!s.$('#d-editor-change'),false);assert.equal(s.ui.state.rascunho.canal,'whatsapp');
  s.$('#d-corpo').value='Conteúdo digitado';s.$('#d-corpo').oninput();const snapshot=JSON.stringify(s.ui.state.rascunho);s.$('#drafts-novo-email').click();assert.ok(s.$('#d-editor-change'));assert.equal(JSON.stringify(s.ui.state.rascunho),snapshot);s.$('#d-editor-change-cancel').click();
  for(const imported of [false,true]){s.ui.fechar();const d=s.draft();if(imported)s.ui.importaTexto(s.gr.exporta(d));else s.ui.abrir(d,null);const before=JSON.stringify(s.ui.state.rascunho);s.$('#drafts-novo-email').click();assert.ok(s.$('#d-editor-change'));assert.equal(JSON.stringify(s.ui.state.rascunho),before);s.$('#d-editor-change-cancel').click();}
  assert.equal(s.calls.length,0);
 }
});
test('creating another template preserves unsaved work until explicit HTML confirmation; Escape and duplicate clicks are safe',()=>{
 for(const brand of ['fish','aristo']){
  const s=setup({brand}),d=s.draft();s.gr.guarda(d);s.ui.abrir(d,d.id);s.$('#d-corpo').value='Edição ainda não salva';s.$('#d-corpo').oninput();
  const before=JSON.stringify(s.ui.state.rascunho),saved=s.values.get(s.gr.CHAVE);s.$('#drafts-novo-email').focus();s.$('#drafts-novo-email').click();
  assert.equal(JSON.stringify(s.ui.state.rascunho),before);assert.equal(s.ui.contextStatus().blocked,true);assert.equal(s.$('#d-servidor').disabled,true);assert.equal(s.$('#draft-editor').inert,true);
  const ev=new s.window.Event('keydown',{bubbles:true,cancelable:true});ev.key='Escape';s.$('#d-editor-change').dispatchEvent(ev);assert.equal(ev.defaultPrevented,true);assert.equal(JSON.stringify(s.ui.state.rascunho),before);assert.equal(s.document.activeElement.id,'drafts-novo-email');
  s.$('#drafts-novo-email').click();const accept=s.$('#d-editor-change-accept');accept.click();const next=s.ui.state.rascunho.id;accept.click();assert.equal(s.ui.state.rascunho.id,next);assert.notEqual(next,d.id);assert.equal(s.ui.state.rascunho.canal,'email');assert.equal(s.values.get(s.gr.CHAVE),saved);assert.equal(s.calls.length,0);
 }
});
test('edit, import and close use the same discard guard; changed snapshots and active operations cannot be discarded',()=>{
 for(const action of ['edit','import','close']){
  const s=setup(),other=s.draft('email',{id:'other',nome:'other'});s.gr.guarda(other);s.ui.abrir(s.draft(),null);s.ui.state.rascunho.corpo='Unsaved';s.ui.render();const before=JSON.stringify(s.ui.state.rascunho);
  if(action==='edit')s.$('[data-draft-edit="other"]').click();else if(action==='import')s.ui.importaTexto(s.gr.exporta(other));else s.$('#d-cancelar').click();
  assert.ok(s.$('#d-editor-change'));assert.equal(JSON.stringify(s.ui.state.rascunho),before);s.ui.state.rascunho.corpo='Newer unsaved';s.$('#d-editor-change-accept').click();assert.equal(s.ui.state.rascunho.corpo,'Newer unsaved');assert.match(s.ui.state.msg,/preparação mudou/);
  s.ui.state.ocupado='operacao';s.ui.trocarEditor(()=>{throw Error('must not execute');});assert.equal(s.ui.editorChangeSession,null);assert.equal(s.calls.length,0);
 }
});
test('remote stages highlight only the next action, keep local saving under other options and require publication confirmation',()=>{
 for(const channel of ['whatsapp','email']){
  const s=setup(),d=s.draft(channel);s.ui.abrir(d,null);assert.equal(s.$('#d-servidor').textContent,'Salvar rascunho');assert.match(s.$('#d-save-status').textContent,/Salvamento no CRM/);assert.ok(s.$('#d-salvar').closest('.draft-editor-more'));assert.equal(s.$('#d-salvar').classList.contains('btn'),false);
  for(const [state,primary]of [['rascunho','d-validar'],['validado','d-submeter']]){
   s.ui.state.rascunho.servidor={draft_id:'saved',version:4,estado:state,hash:s.gta.hash(s.gr.conteudo(s.ui.state.rascunho)),salvo_em:'2026-09-26T12:00:00Z'};s.ui.render();assert.equal(s.$('#'+primary).classList.contains('sec'),false);assert.equal(s.$('#d-servidor').classList.contains('sec'),true);assert.match(s.$('#d-save-status').textContent,/Salvo no CRM · versão 4 · 26\/09/);
  }
  s.$('#d-submeter').click();assert.ok(s.$('#d-confirmar'));assert.equal(s.$('#d-confirm-ok').disabled,true);assert.equal(s.calls.length,0);assert.match(s.$('#d-confirmar').textContent,channel==='email'?/Não envia nenhum e-mail/:/aprovação não ativa nenhuma automação/);
 }
});
test('local save never writes remotely; reopening a saved draft is clean and local-only changes preserve the server revision',()=>{
 const s=setup(),d=s.draft('email');d.servidor={draft_id:'saved',version:3,estado:'rascunho',hash:s.gta.hash(s.gr.conteudo(d))};s.gr.guarda(d);s.ui.abrir(d,d.id);assert.equal(s.ui.contextStatus().dirty,false);
 s.$('#d-corpo').value='<p>Conteúdo alterado.</p>';s.$('#d-corpo').oninput();assert.equal(s.ui.contextStatus().dirty,true);assert.match(s.$('#d-save-status').textContent,/Alterações ainda não salvas no CRM/);
 s.$('#d-salvar').click();assert.equal(s.ui.state.rascunho,null);assert.equal(s.ui.contextStatus().dirty,false);assert.equal(s.calls.length,0);const saved=s.gr.lista()[0];assert.equal(saved.servidor.version,3);assert.equal(saved.servidor.hash,d.servidor.hash);
 s.ui.abrir(saved,saved.id);assert.equal(s.ui.contextStatus().dirty,false);assert.equal(s.gta.situacao(saved).sujo,true);assert.equal(s.$('#d-servidor').textContent,'Salvar rascunho');s.$('#d-cancelar').click();assert.equal(s.ui.state.rascunho,null);assert.equal(!!s.$('#d-editor-change'),false);
});
test('server save uses the existing journal once, keeps the editor clean and cannot clear an uncertain operation',async()=>{
 for(const lost of [false,true]){
  const s=setup({lost}),d=s.draft('email');s.ui.abrir(d,null);await s.ui.salvarServidor(s.ui.state.rascunho);assert.equal(s.posts().length,1);assert.equal(JSON.parse(s.posts()[0].options.body).acao,'rascunho');
  const before=JSON.stringify(s.ui.journal().inspect().operations);
  if(!lost){assert.equal(s.ui.state.rascunho.servidor.version,1);assert.equal(s.ui.contextStatus().dirty,false);assert.equal(s.$('#d-validar').classList.contains('sec'),false);assert.match(s.$('#d-save-status').textContent,/Salvo no CRM/);}
  else{s.$('#drafts-novo-email').click();assert.ok(s.$('#d-editor-change'));s.$('#d-editor-change-accept').click();assert.equal(JSON.stringify(s.ui.journal().inspect().operations),before);await s.ui.salvarServidor(s.draft('email'));assert.equal(s.posts().length,1);assert.equal(s.ui.journal().inspect().operations[0].phase,'unknown');}
 }
});
test('without server capability the primary save is explicitly local, and all-brands cannot create either channel',()=>{
 const s=setup({remote:false});s.$('#drafts-novo').click();assert.equal(s.$('#d-servidor'),null);assert.equal(s.$('#d-salvar').classList.contains('btn'),true);assert.equal(s.$('#d-salvar').closest('details'),null);assert.match(s.$('.draft-editor-actions').textContent,/apenas neste dispositivo · não publica nem envia/);assert.equal(s.calls.length,0);
 const all=setup({brand:'todas'});assert.equal(all.$('#drafts-novo').disabled,true);assert.equal(all.$('#drafts-novo-email').disabled,true);assert.equal(all.ui.state.rascunho,null);
});
