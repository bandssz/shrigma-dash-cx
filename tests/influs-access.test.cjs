'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),Access=require('../influs-access.js');
const html=fs.readFileSync(require.resolve('../influs.html'),'utf8'),tick=()=>new Promise(r=>setImmediate(r));
function storage(initial={}){const map=new Map(Object.entries(initial)),writes=[];return {map,writes,getItem:k=>map.get(k)??null,setItem:(k,v)=>{writes.push(['set',k,v]);map.set(k,v);},removeItem:k=>{writes.push(['remove',k]);map.delete(k);}};}
function fixture(opts={}){
 const {window,document}=parseHTML('<html><body><button id="caller">Salvar</button><section id="access"></section><aside id="i-editor" hidden><button id="drawer-save">Salvar cadastro</button></aside></body></html>');
 let focus=null;Object.defineProperty(document,'activeElement',{get:()=>focus});window.HTMLElement.prototype.focus=function(){if(this.closest('fieldset')?.disabled)return;focus=this;};
 const store=opts.storage||storage(),reads=[];
 const api=Access.bind({document,host:document.querySelector('#access'),readExisting:()=>store.getItem('read'),writeExisting:()=>store.getItem('write'),authorExisting:()=>store.getItem('author'),onRead:async()=>{reads.push(1);return opts.onRead?.();}});
 const $=s=>document.querySelector(s),submit=()=>{const e=new window.Event('submit',{bubbles:true,cancelable:true});$('#influ-access-form').dispatchEvent(e);assert.equal(e.defaultPrevented,true);};
 return {api,window,document,store,reads,$,submit,focused:()=>focus};
}
const file=(role,extra={})=>JSON.stringify({schema:'shrigma_panel_access_v1',panel:'influs',role,key:'fixture-secret',...extra});
test('access files require exact panel, role and supported shape; no broad private file import',()=>{
 assert.equal(Access.parseFile(file('read'),'read').key,'fixture-secret');assert.equal(Access.parseFile(file('write',{author:'Fixture Operator'}),'write').author,'Fixture Operator');
 for(const [text,role]of [[file('write'),'read'],[file('read'),'write'],[file('read',{panel:'growth'}),'read'],[file('read',{author:'Fixture'}),'read'],[file('read',{endpoint:'https://example.invalid'}),'read'],[file('read',{key:''}),'read'],[file('read',{key:'a\nb'}),'read'],[file('write',{author:''}),'write'],['{}','read'],['null','read'],['[]','read'],['','read']])assert.throws(()=>Access.parseFile(text,role),/invalid_access_file/);
});
test('empty/invalid access, cancel and Escape do not invoke reads, writes or persist keys',()=>{
 const x=fixture();assert.equal(x.api.requireWrite(),'');assert.equal(x.$('#influ-access-form').hidden,false);
 x.submit();assert.match(x.$('#influ-access-message').textContent,/chave válida/);assert.equal(x.$('#influ-access-key').getAttribute('aria-invalid'),'true');
 x.$('#influ-access-key').value='fixture-secret';x.submit();assert.match(x.$('#influ-access-message').textContent,/nome no histórico/);
 x.$('#influ-access-cancel').click();assert.equal(x.api.current('write'),'');assert.equal(x.$('#influ-access-key').value,'');
 x.api.show('read');const e=new x.window.Event('keydown',{bubbles:true,cancelable:true});e.key='Escape';x.$('#influ-access-form').dispatchEvent(e);assert.equal(e.defaultPrevented,true);assert.equal(x.$('#influ-access-form').hidden,true);assert.deepEqual(x.reads,[]);assert.deepEqual(x.store.writes,[]);
});
test('write key and author are separate from reader, memory only, and confirmation never resumes a write',()=>{
 const x=fixture({storage:storage({read:'reader',journal:'pending-unchanged'})});assert.equal(x.api.current('read'),'reader');assert.equal(x.api.requireWrite(),'');
 x.$('#influ-access-key').value='writer';x.$('#influ-access-author').value='Fixture Operator';x.submit();x.submit();
 assert.equal(x.api.requireWrite(),'writer');assert.equal(x.api.author(),'Fixture Operator');assert.equal(x.api.current('read'),'reader');assert.equal(x.reads.length,0);assert.deepEqual(x.store.writes,[]);assert.equal(x.store.getItem('journal'),'pending-unchanged');assert.equal(x.$('#influ-access-key').value,'');assert.match(x.$('#influ-access-status').textContent,/Nenhuma alteração foi enviada/);
 assert.doesNotMatch(x.document.body.innerHTML,/writer|Fixture Operator/);
 const reload=fixture({storage:x.store});assert.equal(reload.api.requireWrite(),'');
});
test('legacy writer requires an author and cancellation cannot replace existing access',()=>{
 const x=fixture({storage:storage({write:'legacy-writer'})});assert.equal(x.api.requireWrite(),'');assert.equal(x.focused(),x.$('#influ-access-author'));
 x.$('#influ-access-author').value='New Operator';x.submit();assert.equal(x.api.requireWrite(),'legacy-writer');assert.equal(x.api.author(),'New Operator');
 x.api.show('write',{explicit:true});x.$('#influ-access-key').value='replacement';x.$('#influ-access-author').value='Replacement';x.$('#influ-access-cancel').click();assert.equal(x.api.requireWrite(),'legacy-writer');assert.equal(x.api.author(),'New Operator');assert.deepEqual(x.store.writes,[]);
});
test('one explicit reader submit performs one read, in-memory; failure is visible and busy clears',async()=>{
 let resolve;const x=fixture({onRead:()=>new Promise(r=>resolve=r)});x.api.requireRead();x.$('#influ-access-key').value='new-reader';x.submit();x.submit();assert.equal(x.reads.length,1);assert.equal(x.api.current('read'),'new-reader');assert.equal(x.api.isSessionRead('new-reader'),true);assert.deepEqual(x.store.writes,[]);resolve();await tick();assert.equal(x.$('#influ-access-fields').disabled,false);
 const bad=fixture({onRead:()=>{throw Error('fixture-secret');}});bad.api.requireRead();bad.$('#influ-access-key').value='fixture-secret';bad.submit();await tick();assert.match(bad.$('#influ-access-status').textContent,/Não foi possível/);assert.doesNotMatch(bad.document.body.innerHTML,/fixture-secret/);
});
test('401/403 rejection opens the correct role during a pending read and stale rejection cannot erase newer key',async()=>{
 const x=fixture({storage:storage({write:'writer',author:'Operator'}),onRead:()=>x.api.reject('read','reader','Acesso recusado')});x.api.requireRead();x.$('#influ-access-key').value='reader';x.submit();await tick();assert.equal(x.api.current('read'),'');assert.equal(x.api.current('write'),'writer');assert.equal(x.$('#influ-access-form').hidden,false);assert.match(x.$('#influ-access-message').textContent,/recusado/);
 x.$('#influ-access-key').value='new-reader';x.submit();await tick();x.api.reject('read','reader','old');assert.equal(x.api.current('read'),'new-reader');
});
test('access inside creator drawer remains visible; Escape preserves draft and returns focus',()=>{
 const x=fixture();x.$('#i-editor').hidden=false;x.$('#drawer-save').focus();x.api.requireWrite();assert.equal(x.$('#influ-access-form').parentNode,x.$('#i-editor'));assert.ok(x.$('label[for="influ-access-author"]'));
 x.$('#influ-access-cancel').click();assert.equal(x.$('#i-editor').hidden,false);assert.equal(x.focused(),x.$('#drawer-save'));assert.equal(x.$('#influ-access-form').parentNode,x.$('#access'));
});
test('file import fills only after strict validation; wrong role and cancelled async import never authenticate',async()=>{
 const x=fixture();x.api.show('read');let resolve;const f=x.$('#influ-access-file');Object.defineProperty(f,'files',{configurable:true,value:[{size:100,text:()=>new Promise(r=>resolve=r)}]});const pending=f.onchange();x.$('#influ-access-cancel').click();resolve(file('read'));await pending;assert.equal(x.api.current('read'),'');assert.equal(x.$('#influ-access-key').value,'');
 x.api.show('read');Object.defineProperty(f,'files',{configurable:true,value:[{size:100,text:async()=>file('write')}]});await f.onchange();x.submit();assert.equal(x.api.current('read'),'');assert.equal(x.reads.length,0);
 Object.defineProperty(f,'files',{configurable:true,value:[{size:100,text:async()=>file('read')}]});f.focus();await f.onchange();assert.equal(x.api.current('read'),'');assert.equal(x.$('#influ-access-key').value,'fixture-secret');assert.equal(x.focused(),x.$('#influ-access-key'));x.submit();await tick();assert.equal(x.reads.length,1);assert.deepEqual(x.store.writes,[]);
});
function page({initial={},responses=[]}={}){
 const {window,document}=parseHTML(html),store=storage(initial),calls=[],master=[],forgot=[];let focus=null;
 Object.defineProperty(document,'activeElement',{get:()=>focus});window.HTMLElement.prototype.focus=function(){if(this.closest('fieldset')?.disabled)return;focus=this;};
 const ctx=vm.createContext({window,document,InflusAccess:Access,localStorage:store,INFLU_API_URL:'https://example.invalid/influs',CX_API_URL:'https://example.invalid/shared',
  shrigmaChave:()=>store.getItem('read')||'',shrigmaEsqueceChave:p=>forgot.push(p),shrigmaMarcaMestra:(...x)=>master.push(x),shrigmaFrescor:()=>{},Date,Intl,console,
  prompt:()=>{throw Error('prompt forbidden');},fetch:async(url,init)=>{calls.push({url,...init,body:init?.body?JSON.parse(init.body):undefined});const next=responses.shift();if(next instanceof Error)throw next;return next||{status:200,ok:true,json:async()=>({roi:[],influs:[],cupons:[],custos:[],receita_cupom:[],termos:[]})};}});
 const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');vm.runInContext(source,ctx);store.writes.length=0; // Ignore the existing pane preference written during page boot.
 const $=s=>document.querySelector(s),submit=()=>$('#influ-access-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
 return {ctx,$,calls,store,master,forgot,window,document,submit};
}
test('real page has no prompt and writer login waits for a second explicit save with author',async()=>{
 const x=page();assert.doesNotMatch(html,/\bprompt\s*\(/);await tick();assert.equal(x.calls.length,0);
 x.$('#i-f-slug').value='fixture-influ';x.$('#i-f-nome').value='Fixture';x.$('#i-f-com').value='5';
 await x.ctx.salvarInflu();assert.equal(x.calls.length,0);assert.match(x.$('#influ-access-title').textContent,/cadastro/);
 x.$('#influ-access-key').value='writer';x.$('#influ-access-author').value='Fixture Author';x.submit();await tick();assert.equal(x.calls.length,0);
 await x.ctx.salvarInflu();assert.equal(x.calls.length,1);assert.equal(x.calls[0].body.acao,'salvar_influ');assert.equal(x.calls[0].body.autor,'Fixture Author');assert.equal(x.calls[0].body.k,'writer');assert.equal(x.calls[0].redirect,'error');assert.deepEqual(x.store.writes,[]);
});
test('real page rejects empty receipts and 401/403 without auto-retry or touching journal/TTS credentials',async()=>{
 for(const response of [{status:200,ok:true,json:async()=>{throw Error('empty');}},{status:200,ok:true,json:async()=>({})},{status:401,ok:false,json:async()=>({erro:'invalid'})},{status:403,ok:false,json:async()=>({erro:'denied'})}]){
  const x=page({initial:{shrigma_influ_key:'legacy-writer',shrigma_autor:'Operator',shrigma_tts_wkey:'tts-secret',journal:'pending'},responses:[response]});await tick();
  await assert.rejects(x.ctx.influPost({k:'legacy-writer',acao:'salvar_custo',custo:{}}),/confirmada|inválida|não permite/);assert.equal(x.calls.length,1);assert.equal(x.store.getItem('journal'),'pending');assert.equal(x.store.getItem('shrigma_tts_wkey'),'tts-secret');assert.deepEqual(x.store.writes,[]);
 }
});
test('new master reader stays in memory; legacy TTS read rejection also clears page read access',async()=>{
 const x=page();x.$('#influ-access-key').value='session-reader';x.submit();await tick();
 assert.equal(x.calls.filter(c=>c.body?.acao==='listar').length,1);assert.equal(x.master.length,0);assert.equal(x.ctx.chaveLeitura(),'session-reader');assert.deepEqual(x.store.writes,[]);
 x.ctx.shrigmaEsqueceChave('influs');assert.equal(x.ctx.chaveLeitura(),'');assert.deepEqual(x.forgot,['influs']);assert.equal(x.$('#influ-access-form').hidden,false);
});
