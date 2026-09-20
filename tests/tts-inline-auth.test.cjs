'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),TTS=require('../influs-tts.js'),TTSActionJournal=require('../influs-tts-actions.js'),TTSManual=require('../influs-tts-manual.js');
const {webcrypto}=require('node:crypto'),C=require('../n8n/tiktok/manual-decision.cjs'),{digest}=require('../n8n/growth/template-operation-receipt.cjs');
const code=fs.readFileSync(path.join(__dirname,'../influs-tts.js'),'utf8');
const actions=code.slice(code.indexOf('  const ACESSO_TTS ='),code.indexOf('  function vazio('));
const request={acao:'revisar',marca:'fish',application_id:'1234567890',resultado:'APPROVE',motivo_rejeicao:null,observacao:''};
const answer={ok:true,linhas:[{application_id:request.application_id,status:'AWAITING_SHIPMENT',decisao:'manual_aprovada'}]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function makeStorage() {const data=new Map();return {data,get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
function locks(){const held=new Set();return {request:async(name,options,fn)=>{if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}};}
function setup({storage=makeStorage(),lock=locks(),response={status:200,ok:true,json:async()=>structuredClone(answer)},data={regra_contrato:'atomic_v1'},manualWrite=true,ledger=new Map(),getReceiptError=false}={}){
 const {window,document}=parseHTML('<html><body><main><button id="caller">Aprovar</button><nav id="tts-abas"><button class="ativo">Fila</button></nav><div id="tts-area"><p id="tts-manual-status"></p><button id="tts-manual-check">Consultar disponibilidade</button><table><tr><td class="tts-acoes" data-marca="fish" data-id="1234567890"><button class="tts-ok">Aprovar</button><button class="tts-nao">Rejeitar</button></td></tr></table></div></main></body></html>');
 let focused=null;window.HTMLElement.prototype.focus=function(){assert.ok(!this.disabled&&!this.closest('[hidden]'),'focus target must be enabled and visible');focused=this;};const calls=[],reads=[];
 const ctx=vm.createContext({window,document,TTS,TTSActionJournal,TTSManual,crypto:webcrypto,Date,localStorage:storage,navigator:{locks:lock},URL,SEQ:1,PANE:'fila',DADOS:data,marcaAtual:()=> 'fish',MARCA_N:{fish:'Fishermans',aristo:'Aristocrata'},TTS_ACAO_URL:'https://example.invalid/tiktok-action',
  $:s=>document.querySelector(s),esc:v=>String(v).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])),setTimeout:()=>{},renderPane:()=>{},
  prompt:()=>{throw Error('prompt must not be used');},fetch:async(url,options)=>{
   if(options.method==='GET'||JSON.parse(options.body||'{}').acao==='revisar'){assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');}
   if(options.method==='GET'){
    const u=new URL(url),q=Object.fromEntries(u.searchParams);reads.push(q);assert.ok(!u.searchParams.has('k'));const key=options.headers['X-TTS-Write-Key'];
    if(q.acao==='capacidades')return {status:200,json:async()=>({contract:'tts_manual_runtime_v1',operation:true,write:manualWrite,cutover_verified:manualWrite,admission_verified:manualWrite})};
    if(getReceiptError)throw Error('synthetic read failure');
    return {status:200,json:async()=>structuredClone(ledger.get(q.operation_id)||{contract:'tts_manual_operation_v1',operation:{operation_id:q.operation_id,marca:q.marca,application_id:q.application_id,actor_sha256:digest({scope:'tts-manual-v1',credential:key}),state:'missing',request_payload:null,response:null}})};
   }
   const body=JSON.parse(options.body);calls.push({url,body});if(response instanceof Error)throw response;
   if(body.acao==='regra')return response;
   const p=C.normalize(body,{actor_sha256:digest({scope:'tts-manual-v1',credential:body.k}),owner:'synthetic-ui'});
   let returned;try{returned=await response.json();}catch{return response;}
   if(response.status===200&&returned?.ok===true){const b={...structuredClone(returned),operation_id:p.operation_id};ledger.set(p.operation_id,{contract:'tts_manual_operation_v1',operation:{operation_id:p.operation_id,actor_sha256:p.actor_sha256,marca:p.marca,application_id:p.application_id,state:'accepted',request_payload:p.request_payload,response:{status:200,body:b}}});return {...response,json:async()=>structuredClone(b)};}
   return response;
  }});
 vm.runInContext(actions+';globalThis.ui={acaoTTS,armar,travaAmostrasTTS,consultaManualTTS,manualDisponivelTTS};',ctx);
 Object.assign(ctx,{nf:v=>String(v??'—'),pf:v=>String(v??'—'),prazo:v=>String(v??'sem prazo'),tag:v=>String(v),carregarTTS:async()=>{ctx.reloads=(ctx.reloads||0)+1;}});
 vm.runInContext(code.slice(code.indexOf('  function renderFila()'),code.indexOf('  function renderCriadores()'))+';ui.renderFila=renderFila;',ctx);
 const $=s=>document.querySelector(s);
 const submit=()=>{const e=new window.Event('submit',{bubbles:true,cancelable:true});$('#tts-acesso-form').dispatchEvent(e);assert.equal(e.defaultPrevented,true);};
 const fill=()=>{$('#tts-acesso-chave').value='synthetic-secret';$('#tts-acesso-autor').value='Fixture Operator';};
 return {window,document,ctx,ui:ctx.ui,$,calls,reads,ledger,storage,submit,fill,focused:()=>focused};
}
test('inline form labels, required validation and cancel have no HTTP or reservation effects',async()=>{
 const s=setup();const pending=s.ui.acaoTTS(request);await tick();
 assert.equal(s.focused(),s.$('#tts-acesso-chave'));assert.equal(s.$('#tts-acesso-chave').type,'password');
 assert.ok(s.$('label[for="tts-acesso-chave"]'));assert.ok(s.$('label[for="tts-acesso-autor"]'));
 s.submit();assert.match(s.$('#tts-acesso-msg').textContent,/chave/);assert.equal(s.$('#tts-acesso-chave').getAttribute('aria-invalid'),'true');assert.equal(s.calls.length,0);
 s.$('#tts-acesso-chave').value='synthetic-secret';s.submit();assert.equal(s.focused(),s.$('#tts-acesso-autor'));assert.equal(s.calls.length,0);
 s.$('#tts-acesso-autor').value='x'.repeat(41);s.submit();assert.match(s.$('#tts-acesso-msg').textContent,/40/);
 s.$('#tts-acesso-cancelar').click();await assert.rejects(pending,{code:'TTS_CANCELLED'});
 assert.equal(s.calls.length,0);assert.equal(s.storage.data.size,0);assert.equal(s.$('#tts-acesso').hidden,true);assert.equal(s.$('#tts-acesso-chave').value,'');
});
test('Escape cancels and two-stage button restores its accessible operation and focus',async()=>{
 const s=setup(),button=s.$('#caller');const action=()=>s.ui.acaoTTS(request);
 s.ui.armar(button,'Confirmar aprovação?',action);assert.equal(s.$('#tts-acesso'),null);
 s.ui.armar(button,'Confirmar aprovação?',action);await tick();
 const escape=new s.window.Event('keydown',{bubbles:true,cancelable:true});escape.key='Escape';s.$('#tts-acesso-form').dispatchEvent(escape);await tick();
 assert.equal(escape.defaultPrevented,true);assert.equal(button.disabled,false);assert.equal(button.textContent,'Aprovar');assert.equal(s.focused(),button);assert.equal(s.calls.length,0);
 assert.match(s.$('#tts-acao-msg').textContent,/Nenhuma solicitação/);
});
test('duplicate native submit events invoke exactly one authorized POST, without persisting or rendering credentials',async()=>{
 const s=setup();const pending=s.ui.acaoTTS(request);await tick();s.fill();s.submit();s.submit();await pending;
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].url,'https://example.invalid/tiktok-action');assert.equal(s.calls[0].body.k,'synthetic-secret');assert.equal(s.calls[0].body.autor,'Fixture Operator');assert.equal(s.calls[0].body.resultado,'APPROVE');
 assert.doesNotMatch(s.document.body.innerHTML,/synthetic-secret|Fixture Operator/);assert.doesNotMatch([...s.storage.data.values()].join(''),/synthetic-secret/);
 assert.equal(JSON.parse(s.storage.getItem(TTSManual.PREFIX+'fish:'+request.application_id)).request_payload.autor,'Fixture Operator');
 assert.equal(JSON.parse(s.storage.getItem(TTSActionJournal.PREFIX+'fish:'+request.application_id)).autor,undefined);
 assert.equal(s.$('#tts-acesso-chave').value,'');assert.equal(s.$('#tts-acesso-autor').value,'');assert.equal(s.$('#tts-area .tts-ok').disabled,true);
 await assert.rejects(s.ui.acaoTTS({...request,resultado:'REJECT'}),{code:'TTS_DECISION_RECORDED'});assert.equal(s.calls.length,1);
});
test('legacy stored access is reused; editing rule requires no prompt or native-decision lock',async()=>{
 const storage=makeStorage();storage.setItem('shrigma_tts_wkey','fixture-existing');storage.setItem('shrigma_autor','Fixture');
 const s=setup({storage,lock:null,response:{status:200,ok:true,json:async()=>({ok:true,mensagem:'Atualizada'})}});
 const rule={acao:'regra',marca:'fish',regra:{gmv_auto:100},esperado_atualizado_em:'2026-01-01T00:00:00Z'};
 await s.ui.acaoTTS(rule);assert.equal(s.$('#tts-acesso'),null);assert.equal(s.calls.length,1);assert.deepEqual(s.calls[0].body.regra,{gmv_auto:100});assert.equal(s.calls[0].body.esperado_atualizado_em,rule.esperado_atualizado_em);
 assert.equal([...storage.data.keys()].some(k=>k.startsWith(TTSActionJournal.PREFIX)),false);
});
test('read or filter changes while form is open revoke operation authorization with zero POST',async()=>{
 for(const field of ['SEQ','PANE']){
  const s=setup();const pending=s.ui.acaoTTS(request);await tick();s.fill();s.ctx[field]=field==='SEQ'?2:'regras';s.submit();await assert.rejects(pending,/tela foi atualizada/);assert.equal(s.calls.length,0);assert.equal(s.storage.data.size,0);
 }
});
test('empty or network response freezes both decisions and the freeze survives a new document',async()=>{
 for(const response of [{status:200,ok:true,json:async()=>{throw Error('empty');}},Error('network synthetic-secret')]){
  const s=setup({response});const pending=s.ui.acaoTTS(request);await tick();s.fill();s.submit();await assert.rejects(pending,{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(s.calls.length,1);
  assert.ok([...s.document.querySelectorAll('.tts-acoes .tts-ok,.tts-acoes .tts-nao')].every(b=>b.disabled));assert.match(s.$('.tts-decisao-estado').textContent,/Não repita/);
  const reload=setup({storage:s.storage});reload.ui.travaAmostrasTTS();assert.ok([...reload.document.querySelectorAll('.tts-acoes .tts-ok,.tts-acoes .tts-nao')].every(b=>b.disabled));
  await assert.rejects(reload.ui.acaoTTS(request),{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(reload.calls.length,0);assert.equal(reload.$('#tts-acesso'),null);
 }
});
test('missing Web Locks blocks only native review before asking credentials; rule form still opens',async()=>{
 const s=setup({lock:null});s.ui.travaAmostrasTTS();assert.match(s.$('.tts-decisao-estado').textContent,/proteção entre abas/);assert.equal(s.$('#tts-area .tts-ok').disabled,true);
 await assert.rejects(s.ui.acaoTTS(request),{code:'TTS_WRITE_UNAVAILABLE'});assert.equal(s.$('#tts-acesso'),null);assert.equal(s.calls.length,0);
 const pending=s.ui.acaoTTS({acao:'regra',marca:'fish',regra:{gmv_auto:100}});await tick();assert.ok(s.$('#tts-acesso-form'));s.$('#tts-acesso-cancelar').click();await assert.rejects(pending,{code:'TTS_CANCELLED'});
});
test('rule response errors cannot echo the entered credential into UI',async()=>{
 const s=setup({response:{status:400,ok:false,json:async()=>({ok:false,erro:'fixture synthetic-secret refused'})}});
 const pending=s.ui.acaoTTS({acao:'regra',marca:'fish',regra:{gmv_auto:100}});await tick();s.fill();s.submit();
 await assert.rejects(pending,e=>{assert.doesNotMatch(e.message,/synthetic-secret/);assert.match(e.message,/acesso ocultado/);return true;});
});


test('capability read with write=false reserves nothing and leaves rule action independent',async()=>{
 const s=setup({manualWrite:false,response:{status:200,ok:true,json:async()=>({ok:true,mensagem:'Atualizada'})}});s.ui.travaAmostrasTTS();
 assert.equal(s.$('.tts-ok').disabled,true);assert.equal(s.$('.tts-nao').disabled,true);
 const check=s.ui.consultaManualTTS({acao:'capacidades',marca:'fish'});await tick();
 s.$('#tts-acesso-chave').value='synthetic-secret';s.submit();await check;
 assert.match(s.$('#tts-manual-status').textContent,/indisponíveis/);assert.equal(s.calls.length,0);assert.equal(s.reads.length,1);assert.equal(s.storage.data.size,0);
 const rule=s.ui.acaoTTS({acao:'regra',marca:'fish',regra:{gmv_auto:100}});await tick();s.$('#tts-acesso-autor').value='Fixture Operator';s.submit();await rule;
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].body.acao,'regra');assert.equal([...s.storage.data.keys()].some(k=>k.startsWith(TTSActionJournal.PREFIX)||k.startsWith(TTSManual.PREFIX)),false);
});
test('closed service refuses even a direct manual action before reserving or posting',async()=>{
 const s=setup({manualWrite:false});const action=s.ui.acaoTTS(request);await tick();s.fill();s.submit();await assert.rejects(action,{code:'TTS_WRITE_CLOSED'});
 assert.equal(s.calls.length,0);assert.equal(s.reads.length,1);assert.equal(s.storage.data.size,0);assert.match(s.$('#tts-manual-status').textContent,/indisponíveis/);
});
test('reloaded pending operation has GET-only recovery even while write=false',async()=>{
 const initial=setup();const a=initial.ui.acaoTTS(request);await tick();initial.fill();initial.submit();await a;
 const slot=TTSManual.PREFIX+'fish:'+request.application_id,pending=JSON.parse(initial.storage.getItem(slot));pending.state='pending';delete pending.receipt;initial.storage.setItem(slot,JSON.stringify(pending));
 const s=setup({storage:initial.storage,ledger:initial.ledger,manualWrite:false});s.ui.travaAmostrasTTS();
 assert.equal(s.$('.tts-ok').disabled,true);assert.equal(s.$('.tts-nao').disabled,true);assert.ok(s.$('.tts-consultar'));assert.equal(s.$('.tts-consultar').disabled,false);
 const read=s.ui.consultaManualTTS({acao:'operacao',marca:'fish',application_id:request.application_id});await tick();s.$('#tts-acesso-chave').value='synthetic-secret';s.submit();await read;
 assert.equal(s.calls.length,0);assert.deepEqual(s.reads.map(x=>x.acao),['operacao']);assert.equal(JSON.parse(s.storage.getItem(slot)).state,'accepted');assert.match(s.$('#tts-acao-msg').textContent,/Recibo confirmado/);assert.equal(s.$('.tts-ok').disabled,true);
});
test('legacy unknown shows no false receipt recovery action and remains untouched',()=>{
 const storage=makeStorage(),raw=JSON.stringify({version:1,brand:'fish',application_id:request.application_id,result:'APPROVE',endpoint:'https://example.invalid/tiktok-action',state:'unknown'});storage.setItem(TTSActionJournal.PREFIX+'fish:'+request.application_id,raw);
 const s=setup({storage});s.ui.travaAmostrasTTS();assert.equal(s.$('.tts-consultar'),null);assert.match(s.$('.tts-decisao-estado').textContent,/anterior/);assert.equal(storage.getItem(TTSActionJournal.PREFIX+'fish:'+request.application_id),raw);assert.equal(s.calls.length,0);
});

const until=async(fn,label)=>{const deadline=Date.now()+3000;while(!fn()){if(Date.now()>deadline)throw Error('Timed out waiting for '+label);await tick();}};
test('real queue wiring consults capability before enabling, preserves platform refusal and submits exact approved schema',async()=>{
 const data={regra_contrato:'atomic_v1',regra:[],envio:[],fila:[{marca:'fish',application_id:request.application_id,product_title:'Synthetic item',is_approvable:false}]};
 const s=setup({data});s.ui.renderFila();assert.equal(s.$('.tts-ok').disabled,true);assert.equal(s.$('.tts-nao').disabled,true);
 const check=s.$('#tts-manual-check').onclick();await tick();s.$('#tts-acesso-chave').value='synthetic-secret';s.submit();await check;
 assert.equal(s.calls.length,0);assert.equal(s.storage.data.size,0);assert.equal(s.$('.tts-ok').disabled,true,'platform refusal still blocks approval');assert.equal(s.$('.tts-nao').disabled,false);
 data.fila[0].is_approvable=true;s.ui.renderFila();const button=s.$('.tts-ok');assert.equal(button.disabled,false);
 button.onclick();assert.equal(s.calls.length,0);assert.equal(button.textContent,'Confirmar aprovação?');button.onclick();await until(()=>s.$('#tts-acesso-autor')?.hasAttribute('required'),'operator form');s.$('#tts-acesso-autor').value='Fixture Operator';s.submit();
 await until(()=>s.ctx.reloads===1,'accepted receipt before queue refresh');assert.equal(s.calls.length,1);assert.equal(s.calls[0].body.motivo_rejeicao,null);assert.equal(s.calls[0].body.observacao,'');assert.match(s.calls[0].body.operation_id,/^[a-f0-9-]{36}$/);assert.equal(s.reads.at(-1).acao,'operacao');
 assert.ok(s.$('.tts-consultar'));const before=s.calls.length;await s.$('.tts-consultar').onclick();assert.equal(s.calls.length,before,'receipt handler must not be overwritten by queue decision wiring');
});
test('empty real queue still exposes capability GET without creating a reservation',async()=>{
 const s=setup({data:{regra:[],envio:[],fila:[]},manualWrite:false});s.ui.renderFila();assert.match(s.$('#tts-area').textContent,/Nenhum pedido/);
 const read=s.$('#tts-manual-check').onclick();await tick();s.$('#tts-acesso-chave').value='synthetic-secret';s.submit();await read;
 assert.equal(s.reads.length,1);assert.equal(s.calls.length,0);assert.equal(s.storage.data.size,0);assert.match(s.$('#tts-manual-status').textContent,/indisponíveis/);
});

test('empty queue after reload retains GET-only receipt recovery, including partial mirror, without a copied ID',async()=>{
 const initial=setup();const action=initial.ui.acaoTTS(request);await tick();initial.fill();initial.submit();await action;
 const slot=TTSManual.PREFIX+'fish:'+request.application_id,pending=JSON.parse(initial.storage.getItem(slot));pending.state='unknown';delete pending.receipt;
 for(const partial of [false,true]){
  const storage=makeStorage();for(const [k,v] of initial.storage.data)storage.setItem(k,v);if(partial)storage.data.delete(slot);else storage.setItem(slot,JSON.stringify(pending));
  const s=setup({storage,ledger:initial.ledger,manualWrite:false,data:{regra:[],envio:[{marca:'fish',application_id:request.application_id}],fila:[]}});s.ui.renderFila();
  assert.equal(s.$('.tts-acoes'),null);const btn=s.$('.tts-recibo-local');assert.ok(btn,'receipt must remain available outside PENDING');assert.doesNotMatch(s.$('#tts-tentativas-locais').textContent,/Fixture Operator|synthetic-secret/);
  const read=btn.onclick();await tick();s.$('#tts-acesso-chave').value='synthetic-secret';s.submit();await read;
  assert.equal(s.calls.length,0);assert.equal(s.reads.length,1);assert.equal(s.reads[0].acao,'operacao');assert.equal(s.reads[0].operation_id,pending.operation_id);assert.equal(JSON.parse(storage.getItem(slot)).state,'accepted');assert.equal(s.focused(),s.$('.tts-recibo-local'),'focus restored to recreated receipt button');
 }
});
test('local attempts stay visible by selected brand; legacy without UUID has only a preserved warning',()=>{
 const storage=makeStorage();for(const brand of ['fish','aristo'])storage.setItem(TTSActionJournal.PREFIX+brand+':42',JSON.stringify({version:1,brand,application_id:'42',result:'APPROVE',endpoint:'https://example.invalid/tiktok-action',state:'unknown'}));
 const before=[...storage.data],s=setup({storage,data:{regra:[],envio:[],fila:[]}});s.ui.renderFila();assert.match(s.$('#tts-tentativas-locais').textContent,/Fishermans.*amostra 42/);assert.doesNotMatch(s.$('#tts-tentativas-locais').textContent,/Aristocrata/);assert.equal(s.$('.tts-recibo-local'),null);assert.match(s.$('#tts-tentativas-locais').textContent,/conciliação/);assert.deepEqual([...storage.data],before);assert.equal(s.calls.length+s.reads.length,0);
});
test('capability button restores visible focus after Cancel, Escape and successful GET',async()=>{
 for(const finish of ['cancel','escape','complete']){
  const s=setup({manualWrite:false});s.ui.travaAmostrasTTS();const btn=s.$('#tts-manual-check'),read=btn.onclick();await tick();
  if(finish==='cancel')s.$('#tts-acesso-cancelar').click();else if(finish==='escape'){const e=new s.window.Event('keydown',{bubbles:true,cancelable:true});e.key='Escape';s.$('#tts-acesso-form').dispatchEvent(e);}else{s.$('#tts-acesso-chave').value='synthetic-secret';s.submit();}
  await read;assert.equal(s.focused(),btn);assert.equal(btn.disabled,false);assert.equal(s.calls.length,0);assert.equal(s.storage.data.size,0);assert.equal(s.reads.length,finish==='complete'?1:0);
 }
});
