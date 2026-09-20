'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),TTS=require('../influs-tts.js'),TTSActionJournal=require('../influs-tts-actions.js');
const code=fs.readFileSync(path.join(__dirname,'../influs-tts.js'),'utf8');
const actions=code.slice(code.indexOf('  const ACESSO_TTS ='),code.indexOf('  function vazio('));
const request={acao:'revisar',marca:'fish',application_id:'1234567890',resultado:'APPROVE'};
const answer={ok:true,linhas:[{application_id:request.application_id,status:'AWAITING_SHIPMENT',decisao:'manual_aprovada'}]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function makeStorage() {const data=new Map();return {data,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
function locks(){const held=new Set();return {request:async(name,options,fn)=>{if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}};}
function setup({storage=makeStorage(),lock=locks(),response={status:200,ok:true,json:async()=>structuredClone(answer)},data={regra_contrato:'atomic_v1'}}={}){
 const {window,document}=parseHTML('<html><body><main><button id="caller">Aprovar</button><nav id="tts-abas"><button class="ativo">Fila</button></nav><div id="tts-area"><table><tr><td class="tts-acoes" data-marca="fish" data-id="1234567890"><button>Aprovar</button><button>Rejeitar</button></td></tr></table></div></main></body></html>');
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};const calls=[];
 const ctx=vm.createContext({window,document,TTS,TTSActionJournal,localStorage:storage,navigator:{locks:lock},URL,SEQ:1,PANE:'fila',DADOS:data,marcaAtual:()=> 'fish',MARCA_N:{fish:'Fishermans',aristo:'Aristocrata'},TTS_ACAO_URL:'https://example.invalid/tiktok-action',
  $:s=>document.querySelector(s),esc:v=>String(v).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])),setTimeout:()=>{},renderPane:()=>{},
  prompt:()=>{throw Error('prompt must not be used');},fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});if(response instanceof Error)throw response;return response;}});
 vm.runInContext(actions+';globalThis.ui={acaoTTS,armar,travaAmostrasTTS};',ctx);
 const $=s=>document.querySelector(s);
 const submit=()=>{const e=new window.Event('submit',{bubbles:true,cancelable:true});$('#tts-acesso-form').dispatchEvent(e);assert.equal(e.defaultPrevented,true);};
 const fill=()=>{$('#tts-acesso-chave').value='synthetic-secret';$('#tts-acesso-autor').value='Fixture Operator';};
 return {window,document,ctx,ui:ctx.ui,$,calls,storage,submit,fill,focused:()=>focused};
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
 assert.doesNotMatch(s.document.body.innerHTML,/synthetic-secret|Fixture Operator/);assert.doesNotMatch([...s.storage.data.values()].join(''),/synthetic-secret|Fixture Operator/);
 assert.equal(s.$('#tts-acesso-chave').value,'');assert.equal(s.$('#tts-acesso-autor').value,'');assert.equal(s.$('#tts-area button').disabled,true);
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
  assert.ok([...s.document.querySelectorAll('.tts-acoes button')].every(b=>b.disabled));assert.match(s.$('.tts-decisao-estado').textContent,/Não repita/);
  const reload=setup({storage:s.storage});reload.ui.travaAmostrasTTS();assert.ok([...reload.document.querySelectorAll('.tts-acoes button')].every(b=>b.disabled));
  await assert.rejects(reload.ui.acaoTTS(request),{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(reload.calls.length,0);assert.equal(reload.$('#tts-acesso'),null);
 }
});
test('missing Web Locks blocks only native review before asking credentials; rule form still opens',async()=>{
 const s=setup({lock:null});s.ui.travaAmostrasTTS();assert.match(s.$('.tts-decisao-estado').textContent,/proteção entre abas/);assert.equal(s.$('#tts-area button').disabled,true);
 await assert.rejects(s.ui.acaoTTS(request),{code:'TTS_WRITE_UNAVAILABLE'});assert.equal(s.$('#tts-acesso'),null);assert.equal(s.calls.length,0);
 const pending=s.ui.acaoTTS({acao:'regra',marca:'fish',regra:{gmv_auto:100}});await tick();assert.ok(s.$('#tts-acesso-form'));s.$('#tts-acesso-cancelar').click();await assert.rejects(pending,{code:'TTS_CANCELLED'});
});
test('rule response errors cannot echo the entered credential into UI',async()=>{
 const s=setup({response:{status:400,ok:false,json:async()=>({ok:false,erro:'fixture synthetic-secret refused'})}});
 const pending=s.ui.acaoTTS({acao:'regra',marca:'fish',regra:{gmv_auto:100}});await tick();s.fill();s.submit();
 await assert.rejects(pending,e=>{assert.doesNotMatch(e.message,/synthetic-secret/);assert.match(e.message,/acesso ocultado/);return true;});
});
