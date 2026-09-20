'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');

function setup({legacyKey='',storageBlocked=false,response=null,sharedValues=null,operations=new Map(),failLocalAfterReceipt=false}={}){
  const {document,window}=parseHTML('<html><body><section id="control-drafts"></section></body></html>');
  let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};
  Object.defineProperty(document,'activeElement',{get:()=>focused?.isConnected?focused:document.body});
  const values=sharedValues||new Map(legacyKey?[['shrigma_tpl_key',legacyKey]]:[]),calls=[],reads=[],writes=[],failures={local:false};
  const storage={getItem:k=>{if(storageBlocked)throw Error('storage blocked');return values.get(k)||null;},
    setItem:(k,v)=>{if(storageBlocked||failures.local&&k==='shrigma_growth_rascunhos')throw Error('storage blocked');writes.push(k);values.set(k,v);},
    removeItem:k=>{if(storageBlocked)throw Error('storage blocked');values.delete(k);}};
  const crypto=require('node:crypto').webcrypto,J=require('../growth-template-journal.js'),held=new Set();
  const locks={request:async(k,_opts,fn)=>{if(held.has(k))return fn(null);held.add(k);try{return await fn({name:k});}finally{held.delete(k);}}};
  const json=(status,body)=>({status,json:async()=>body});
  const ctx=vm.createContext({document,window,localStorage:storage,URLSearchParams,URL,Date,Intl,console,crypto,TextEncoder,navigator:{locks},
    prompt:()=>{throw Error('prompt is unavailable');},setInterval:()=>1,
    FileReader:class{readAsText(file){this.result=file.fixture;this.onload();}},
    fetch:async(url,options)=>{
      if(options?.method!=='POST'){
        reads.push({url,options});const query=new URL(url).searchParams,id=query.get('idempotency_key'),acao=query.get('operacao');
        if(response?.status===401)return json(401,{erro:'invalid_key'});
        const operation=operations.get(id)||{idempotency_key:id,acao,actor:'fixture-actor',hash_schema:'json-stable-sha256-v1',claim_id:null,request_payload:null,request_sha256:null,state:'missing',response:null};
        if(failLocalAfterReceipt&&operation.state==='completed')failures.local=true;
        return json(200,{contract:'template_operation_v1',operation});
      }
      calls.push({url,options});if(response instanceof Error)throw response;
      const {k,...wire}=JSON.parse(options.body),payload=J.payloadFor(wire),claim='20000000-0000-4000-8000-000000000001';
      const status=response?.status||201,body=response?await response.json():wire.acao==='rascunho'?{draft_id:wire.draft_id||'fixture-draft',version:wire.expected_version?wire.expected_version+1:1,estado:'rascunho'}:wire.acao==='validar'?{draft_id:wire.draft_id,version:wire.expected_version,estado:'validado',erros:[],avisos:[]}:{draft_id:wire.draft_id,estado:'publicado',provider_status:'APPROVED',operation_id:claim,submission_id:'s_'+claim.replace(/-/g,''),provider:'listmonk'};
      operations.set(wire.idempotency_key,{idempotency_key:wire.idempotency_key,acao:wire.acao,actor:'fixture-actor',hash_schema:'json-stable-sha256-v1',claim_id:wire.acao==='submeter'?claim:null,request_payload:payload,request_sha256:await J.sha256(payload,crypto),state:'completed',response:{status,body}});
      return json(status,body);
    }});
  for(const file of ['whatsapp-template-contract.js','growth-drafts.js','growth-templates-api.js','growth-template-journal.js','growth-table.js','growth-message-preview.js','growth-drafts-ui.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx,{filename:file});
  vm.runInContext(`globalThis.ui=GRU;globalThis.drafts=GR;globalThis.apiRules=GTA;
    GRU.render({api:{capabilities:{templates:{draft:true,validate:true,submit:true,submit_email:true},endpoints:{templates:'https://example.invalid/templates'}}}});`,ctx);
  const $=selector=>document.querySelector(selector);
  const submit=()=>{const event=new window.Event('submit',{bubbles:true,cancelable:true});$('#drafts-acesso').dispatchEvent(event);assert.equal(event.defaultPrevented,true);};
  const draft=()=>ctx.drafts.novo({canal:'email',marca:'fish',nome:'fixture_email',assunto:'Assunto fixture',corpo:'Corpo fixture'});
  return {ctx,ui:ctx.ui,document,window,$,calls,reads,values,writes,submit,draft,operations,failures,focused:()=>focused};
}

test('missing key opens a labelled inline form; preparing access never resumes the requested operation',async()=>{
  const s=setup(),draft=s.draft();
  await s.ui.salvarServidor(draft);
  assert.equal(s.calls.length,0);assert.ok(s.$('#drafts-acesso'));assert.equal(s.focused(),s.$('#drafts-chave-escrita'));
  assert.equal(s.$('#drafts-chave-escrita').type,'password');assert.ok(s.$('#drafts-chave-escrita').hasAttribute('required'));
  assert.equal(s.$('label[for="drafts-chave-escrita"]').textContent,'Chave de escrita de templates');
  assert.equal(s.$('#drafts-acesso button[type="submit"]').textContent,'Preparar acesso');
  s.submit();assert.equal(s.calls.length,0);assert.match(s.$('#drafts-acesso-erro').textContent,/Informe a chave/);
  const field=s.$('#drafts-chave-escrita');field.value='fixture-new-key';s.submit();
  assert.equal(field.value,'');assert.equal(s.$('#drafts-acesso'),null);assert.equal(s.calls.length,0);
  assert.equal(s.values.has('shrigma_tpl_key'),false);
  assert.doesNotMatch(s.document.body.innerHTML,/fixture-new-key/);assert.match(s.document.body.textContent,/Nenhuma operação foi enviada/);
  // Only the operator's explicit new action reaches the existing client.
  await s.ui.salvarServidor(draft);assert.equal(s.calls.length,1);
  assert.equal(JSON.parse(s.calls[0].options.body).k,'fixture-new-key');
});

test('cancel and Escape retain the previous key and pending operation, clear the field and restore focus',()=>{
  for(const cancel of ['button','Escape']){
    const s=setup({legacyKey:'fixture-existing-key'}),draft=s.draft();
    draft.servidor={draft_id:'fixture-id',version:7,pendente:{acao:'submeter',idempotency_key:'fixture-pending'}};
    s.ui.state.rascunho=draft;const before=JSON.stringify(draft);
    const opener=s.$('#drafts-chave');opener.focus();opener.click();
    const field=s.$('#drafts-chave-escrita');field.value='fixture-uncommitted';
    if(cancel==='button')s.$('#drafts-acesso-cancelar').click();
    else{const event=new s.window.Event('keydown',{bubbles:true,cancelable:true});event.key='Escape';s.$('#drafts-acesso').dispatchEvent(event);assert.equal(event.defaultPrevented,true);}
    assert.equal(field.value,'');assert.equal(s.ui.chaveEscrita(),'fixture-existing-key');assert.equal(JSON.stringify(draft),before);
    assert.equal(s.values.get('shrigma_tpl_key'),'fixture-existing-key');assert.equal(s.calls.length,0);assert.equal(s.focused(),s.$('#drafts-chave'));
  }
});

test('duplicate form submit events cannot send or rewrite the pending operation',()=>{
  const s=setup(),draft=s.draft();draft.servidor={pendente:{acao:'rascunho',idempotency_key:'fixture-stable'}};
  s.ui.state.rascunho=draft;const before=JSON.stringify(draft);s.$('#drafts-chave').click();
  const form=s.$('#drafts-acesso');s.$('#drafts-chave-escrita').value='fixture-prepared';
  for(let i=0;i<2;i++)form.dispatchEvent(new s.window.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(s.calls.length,0);assert.equal(s.writes.filter(k=>k==='shrigma_tpl_key').length,0);assert.equal(JSON.stringify(draft),before);
});

test('new keys remain only in memory while legacy storage is read without being replaced',()=>{
  const s=setup({legacyKey:'fixture-legacy'});
  assert.equal(s.ui.chaveEscrita(),'fixture-legacy');s.$('#drafts-chave').click();
  assert.match(s.$('#drafts-acesso-ajuda').textContent,/apenas enquanto esta página estiver aberta/);
  s.$('#drafts-chave-escrita').value='fixture-memory-only';s.submit();
  assert.equal(s.ui.chaveEscrita(),'fixture-memory-only');assert.equal(s.values.get('shrigma_tpl_key'),'fixture-legacy');
  assert.equal(s.writes.length,0);assert.equal(s.calls.length,0);
  assert.doesNotMatch([...s.values.values()].join(''),/fixture-memory-only/);
});

test('missing authentication or an in-flight request cannot replace a prior pending operation before opening access',async()=>{
  for(const action of ['salvarServidor','validarServidor','submeter'])for(const occupied of [false,true]){
    const s=setup({legacyKey:occupied?'fixture-existing':''}),draft=s.draft();
    draft.servidor={draft_id:'fixture-id',version:3,estado:'validado',pendente:{acao:'other-uncertain-action',idempotency_key:'fixture-must-survive'}};
    if(occupied)s.ui.state.ocupado='rascunho';
    const before=JSON.stringify(draft);await s.ui[action](draft);
    assert.equal(JSON.stringify(draft),before);assert.equal(s.calls.length,0);
    assert.equal(s.$('#drafts-acesso'),null);
  }
});

test('blocked storage still permits session authentication without exceptions or putting the key in markup',async()=>{
  const s=setup({storageBlocked:true}),draft=s.draft();s.$('#drafts-chave').click();
  s.$('#drafts-chave-escrita').value='fixture-session-key';s.submit();s.ui.render();
  assert.equal(s.ui.chaveEscrita(),'fixture-session-key');assert.equal(s.values.size,0);assert.equal(s.calls.length,0);
  assert.doesNotMatch(s.document.body.innerHTML,/fixture-session-key/);
  await s.ui.salvarServidor(draft);assert.equal(s.calls.length,0);
  s.ui.esqueceChave();assert.equal(s.ui.chaveEscrita(),null);
});

test('a refused key is forgotten and the next explicit action opens access without another POST',async()=>{
  const s=setup({legacyKey:'fixture-refused',response:{status:401,json:async()=>({})}}),draft=s.draft();
  await s.ui.salvarServidor(draft);assert.equal(s.calls.length,0);assert.equal(s.ui.chaveEscrita(),null);
  await s.ui.salvarServidor(draft);assert.equal(s.calls.length,0);assert.ok(s.$('#drafts-acesso'));
  s.$('#drafts-chave-escrita').value='fixture-replacement';s.submit();assert.equal(s.calls.length,0);
});

test('an uncertain request keeps its existing idempotency identity through authentication changes without replay',async()=>{
  const s=setup({legacyKey:'fixture-existing',response:Error('fixture network failure')}),draft=s.draft();
  draft.servidor={draft_id:'fixture-id',version:2,estado:'rascunho'};
  await s.ui.validarServidor(draft);assert.equal(s.calls.length,1);
  const pending=JSON.stringify(s.ui.journal().inspect().operations),stored=s.values.get('shrigma_growth_rascunhos');
  assert.ok(pending.includes('validar'));s.ui.state.rascunho=draft;
  s.$('#drafts-chave').click();s.$('#drafts-acesso-cancelar').click();
  s.$('#drafts-chave').click();s.$('#drafts-chave-escrita').value='fixture-changed';s.submit();
  assert.equal(s.calls.length,1);assert.equal(JSON.stringify(s.ui.journal().inspect().operations),pending);
  assert.equal(s.values.get('shrigma_growth_rascunhos'),stored);
});

test('import uses native button semantics, invokes the picker once and only imports a local draft',()=>{
  const s=setup(),button=s.$('#drafts-importar'),input=s.$('#drafts-arquivo');
  assert.equal(button.tagName,'BUTTON');assert.equal(button.type,'button');assert.equal(button.textContent,'Importar arquivo');assert.equal(button.hasAttribute('tabindex'),false);
  assert.equal(input.getAttribute('aria-label'),'Arquivo de rascunho para importar');
  let picks=0;input.click=()=>{picks++;};button.click();assert.equal(picks,1);
  Object.defineProperty(input,'files',{value:[{fixture:s.ctx.drafts.exporta(s.draft())}]});input.onchange();
  assert.ok(s.ui.state.rascunho);assert.equal(s.ui.state.rascunho.nome,'fixture_email');
  assert.equal(s.calls.length,0);assert.equal(s.values.has('shrigma_growth_rascunhos'),false);
});

test('confirmed creation survives failure applying the local receipt and reload cannot create it again',async()=>{
  const first=setup({legacyKey:'fixture-existing',failLocalAfterReceipt:true}),draft=first.draft();
  await first.ui.salvarServidor(draft);
  assert.equal(first.calls.length,1);let op=first.ui.journal().inspect().operations[0];
  assert.equal(op.phase,'confirmed');assert.equal(op.applied,false);
  assert.equal(JSON.parse(first.values.get('shrigma_growth_rascunhos'))[0].servidor,undefined);
  const reload=setup({sharedValues:first.values,operations:first.operations});
  const restored=reload.ctx.drafts.lista()[0];await reload.ui.salvarServidor(restored);
  assert.equal(reload.calls.length,0);assert.match(reload.document.body.textContent,/aguarda atualização local/);
  await reload.ui.consultarOperacao(op.id);op=reload.ui.journal().inspect().operations[0];
  assert.equal(op.applied,true);assert.equal(reload.calls.length,0);
  const recovered=reload.ctx.drafts.lista()[0];assert.equal(recovered.servidor.draft_id,'fixture-draft');assert.equal(recovered.servidor.version,1);
  await reload.ui.salvarServidor(recovered);assert.equal(reload.calls.length,1);
  const request=JSON.parse(reload.calls[0].options.body);assert.equal(request.draft_id,'fixture-draft');assert.equal(request.expected_version,1);
});

test('unknown first creation stays frozen after reload, local deletion, import or another draft ID',async()=>{
  const first=setup({legacyKey:'fixture-existing',response:Error('lost response')}),draft=first.draft();await first.ui.salvarServidor(draft);
  const id=first.ui.journal().inspect().operations[0].id;first.values.delete('shrigma_growth_rascunhos');
  const reload=setup({sharedValues:first.values});await reload.ui.salvarServidor(reload.draft());
  assert.equal(reload.calls.length,0);await reload.ui.consultarOperacao(id);assert.equal(reload.calls.length,0);
  assert.equal(reload.ui.journal().inspect().operations[0].phase,'unknown');assert.match(reload.document.body.textContent,/Não repita|não repita/);
});

test('published email receipt is applied as published without claiming activation, and its review is never posted twice',async()=>{
  const s=setup({legacyKey:'fixture-existing'}),draft=s.draft();await s.ui.salvarServidor(draft);await s.ui.validarServidor(draft);await s.ui.submeter(draft);
  assert.equal(s.calls.length,3);assert.equal(draft.servidor.estado,'publicado');assert.equal(draft.servidor.provider_status,'APPROVED');
  assert.match(s.document.body.textContent,/Publicado não é ativo/);const op=s.ui.journal().inspect().operations.at(-1);
  await s.ui.consultarOperacao(op.id);assert.equal(s.calls.length,3);assert.equal(s.ctx.drafts.lista()[0].servidor.estado,'publicado');
  for(const read of s.reads){assert.equal(new URL(read.url).searchParams.has('k'),false);assert.equal(read.options.headers['X-Template-Key'],'fixture-existing');assert.equal(read.options.redirect,'error');assert.equal(read.options.credentials,'omit');assert.equal(read.options.cache,'no-store');}
});
