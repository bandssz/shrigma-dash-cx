'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const html=fs.readFileSync(require.resolve('../organico.html'),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function boot({stored='',fetchImpl}={}){
 const {document,window}=parseHTML(html);let focused=null,reads=0,writes=0;window.HTMLElement.prototype.focus=function(){focused=this;};
 const requests=[],timers=new Map();let timerId=0;
 const context=vm.createContext({document,window,console,AbortController,API:null,CX_API_URL:'https://example.invalid/read',
  prompt:()=>{throw Error('prompt not supported');},$:s=>document.querySelector(s),esc:s=>String(s).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])),
  render:()=>{},shrigmaFrescor:()=>{},shrigmaChave:()=>{reads++;return typeof stored==='function'?stored():stored;},
  shrigmaGuardaChave:()=>{writes++;throw Error('unexpected persistence');},shrigmaMarcaMestra:()=>{writes++;throw Error('unexpected persistence');},shrigmaEsqueceChave:()=>{writes++;throw Error('unexpected removal');},
  setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
  fetch:async(...args)=>{requests.push(args);return fetchImpl?fetchImpl(...args):{ok:true,status:200,json:async()=>({_painel:'todos',_escopo:'organico',cx_story:[]})};}
 });
 vm.runInContext(fs.readFileSync(require.resolve('../organico-access.js'),'utf8'),context);
 const start=html.indexOf('const ACESSO_ORGANICO='),end=html.indexOf("document.querySelectorAll('#seg-marca button')",start);assert(start>=0&&end>start);vm.runInContext(html.slice(start,end),context);
 const $=s=>document.querySelector(s),submit=()=>{const e=new window.Event('submit',{bubbles:true,cancelable:true});$('#organico-acesso').dispatchEvent(e);assert(e.defaultPrevented);};
 const choose=async(data,size)=>{Object.defineProperty($('#organico-chave-arquivo'),'files',{configurable:true,value:[{size:size??Buffer.byteLength(data),text:async()=>data}]});await $('#organico-chave-arquivo').onchange();};
 return {$,document,window,requests,timers,submit,choose,run:s=>vm.runInContext(s,context),focus:()=>focused,writes:()=>writes,reads:()=>reads};
}
const file=key=>JSON.stringify({schema:'shrigma_read_access_v1',panel:'organico',key});
test('missing access uses inline form and focus without prompt, fetch or an endless loading state',async()=>{
 const x=boot();await x.run('carrega()');assert.equal(x.requests.length,0);assert.equal(x.$('#organico-acesso').hidden,false);assert.equal(x.focus(),x.$('#organico-chave'));assert.match(x.$('#aviso-carga').textContent,/Acesso de leitura necessário/);assert.doesNotMatch(x.$('#aviso-carga').textContent,/Carregando/);
 x.submit();assert.equal(x.requests.length,0);assert.match(x.$('#organico-acesso-msg').textContent,/Informe uma chave/);
 x.$('#organico-acesso-cancelar').click();assert.equal(x.$('#organico-acesso').hidden,true);assert.equal(x.focus(),x.$('#organico-acesso-abrir'));assert.equal(x.writes(),0);
});
test('Enter submits once; a new key is memory-only, encoded, scoped and cleared from fields',async()=>{
 let resolve;const x=boot({fetchImpl:()=>new Promise(r=>resolve=r)});await x.run('carrega()');
 x.$('#organico-chave').value='fixture-key&scope=wrong';x.submit();x.submit();await turn();assert.equal(x.requests.length,1);
 const url=new URL(x.requests[0][0]);assert.equal(url.searchParams.get('k'),'fixture-key&scope=wrong');assert.equal(url.searchParams.get('painel'),'organico');assert.equal(url.searchParams.has('scope'),false);assert.equal(x.requests[0][1].cache,'no-store');
 assert.equal(x.$('#organico-chave').value,'');assert.match(x.$('#aviso-carga').textContent,/Carregando/);assert.equal(x.run('chaveLeitura()'),'fixture-key&scope=wrong');
 resolve({ok:true,status:200,json:async()=>({_painel:'todos',_escopo:'organico',cx_story:[]})});await turn();assert.equal(x.$('#aviso-carga').textContent,'');assert.equal(x.writes(),0);assert.equal(x.timers.size,0);
 const reload=boot();assert.equal(reload.run('chaveLeitura()'),'');
});
test('strict scoped file prepares access without a fetch; confirming reads once and never stores the key',async()=>{
 const x=boot();await x.run('carrega()');await x.choose(file('fixture-file-key'));
 assert.equal(x.requests.length,0);assert.equal(x.run('chaveLeitura()'),'');assert.equal(x.$('#organico-chave').type,'password');assert.match(x.$('#organico-acesso-msg').textContent,/Confirme em Acessar/);
 x.submit();await turn();assert.equal(x.requests.length,1);assert.equal(x.run('chaveLeitura()'),'fixture-file-key');assert.equal(x.$('#organico-chave').value,'');assert.equal(x.writes(),0);
});
test('wrong panel, large files, full credential bundles and invalid JSON never provide access',async()=>{
 const x=boot();await x.run('carrega()');
 for(const text of ['not json',JSON.stringify({schema:'shrigma_read_access_v1',panel:'growth',key:'fixture'}),JSON.stringify({services:{private:'fixture'}}),JSON.stringify({schema:'shrigma_read_access_v1',panel:'organico',key:'fixture',extra:true})]){await x.choose(text);assert.equal(x.$('#organico-chave').value,'');assert.match(x.$('#organico-acesso-msg').textContent,/Arquivo inválido/);}
 await x.choose(file('fixture'),5000);assert.equal(x.$('#organico-chave').value,'');assert.equal(x.requests.length,0);
});
test('cancel or Escape clears staged access, including a file read that completes later',async()=>{
 const x=boot();await x.run('carrega()');await x.choose(file('fixture-cancel'));
 const escape=new x.window.Event('keydown',{cancelable:true});escape.key='Escape';x.$('#organico-acesso').dispatchEvent(escape);assert(escape.defaultPrevented);assert.equal(x.$('#organico-chave').value,'');assert.equal(x.requests.length,0);
 x.$('#organico-acesso-abrir').click();let finish;Object.defineProperty(x.$('#organico-chave-arquivo'),'files',{configurable:true,value:[{size:100,text:()=>new Promise(r=>finish=r)}]});
 const pending=x.$('#organico-chave-arquivo').onchange();x.$('#organico-acesso-cancelar').click();finish(file('late-fixture'));await pending;
 assert.equal(x.$('#organico-chave').value,'');assert.equal(x.run('chaveLeitura()'),'');assert.equal(x.requests.length,0);assert.equal(x.$('#organico-acesso').hidden,true);
});
test('existing scoped or master access remains compatible; even a master response does not write storage',async()=>{
 const x=boot({stored:'existing-fixture'});await x.run('carrega()');assert.equal(x.requests.length,1);assert.equal(x.$('#organico-acesso').hidden,true);assert.equal(x.writes(),0);
 const unavailable=boot({stored:()=>{throw Error('storage disabled');}});await unavailable.run('carrega()');assert.equal(unavailable.requests.length,0);assert.equal(unavailable.$('#organico-acesso').hidden,false);
});
test('401 and 403 require explicit new access without deleting master storage or retrying a rejected key',async()=>{
 for(const status of [401,403]){const x=boot({stored:'rejected-fixture',fetchImpl:async()=>({ok:false,status})});await x.run('carrega()');assert.equal(x.run('chaveLeitura()'),'');assert.equal(x.writes(),0);assert.equal(x.$('#organico-acesso').hidden,false);assert.match(x.$('#aviso-carga').textContent,/Acesso recusado/);await x.run('carrega()');assert.equal(x.requests.length,1);}
});
test('network failure has a safe visible message and a bounded retry, with no credential in DOM',async()=>{
 const x=boot({stored:'private-fixture',fetchImpl:async()=>{throw Error('https://example.invalid/?k=private-fixture');}});await x.run('carrega()');assert.match(x.$('#aviso-carga').textContent,/Não foi possível atualizar/);assert.doesNotMatch(x.document.body.textContent,/private-fixture/);assert.equal(x.run('CARGA_ORGANICO'),false);assert.equal(x.timers.size,0);x.$('#btn-retry').click();await turn();assert.equal(x.requests.length,2);
});
test('a stalled fetch times out, releases loading and preserves unknown instead of showing empty metrics',async()=>{
 const x=boot({stored:'fixture',fetchImpl:(_url,{signal})=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error('abort'))))});
 const pending=x.run('carrega()');assert.equal(x.timers.size,1);const timer=[...x.timers.values()][0];assert.equal(timer.ms,45000);timer.fn();await pending;assert.equal(x.run('API'),null);assert.equal(x.run('CARGA_ORGANICO'),false);assert.match(x.$('#aviso-carga').textContent,/demorou além do limite/);assert.equal(x.timers.size,0);
});

test('HTTP 200 with an error, empty object or another scope preserves the last valid payload',async()=>{
 for(const invalid of [{error:'private-server-error'},{},{_escopo:'growth',cx_story:[]},{_escopo:'organico',cx_story:null},{_escopo:'organico',cx_story:[],error:'unexpected'}]){
  const x=boot({stored:'fixture',fetchImpl:async()=>({ok:true,status:200,json:async()=>invalid})});x.run("API={_escopo:'organico',cx_story:[{story_id:'previous-fixture'}]}");
  await x.run('carrega()');assert.equal(x.run('API.cx_story[0].story_id'),'previous-fixture');assert.match(x.$('#aviso-carga').textContent,/Não foi possível atualizar/);assert.doesNotMatch(x.document.body.textContent,/private-server-error/);
 }
});
