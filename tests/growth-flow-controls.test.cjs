'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{parseHTML}=require('linkedom');
const root=path.resolve(__dirname,'..'),clone=v=>JSON.parse(JSON.stringify(v));
function backend(){return {calls:[],receipts:new Map(),mode:'success',flows:['fish','aristo'].map(brand=>({key:brand+':carrinho',brand,name:'Carrinho '+brand,trigger:'Fixture',version:2,published_version:1,enabled:true,runtime_ready:true,available_steps:[],draft:{name:'Carrinho '+brand,steps:[]}}))};}
function browser({server=backend(),store,lock,confirm=true}={}){
 const map=new Map();store=store||{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
 let held=false;lock=lock||{request:async(k,o,fn)=>{if(held)return fn(null);held=true;try{return await fn({});}finally{held=false;}}};
 const {document,window}=parseHTML('<html><body><section id="control-fluxos"></section></body></html>');window.HTMLElement.prototype.getBoundingClientRect=()=>({width:1000,height:700,x:0,y:0,left:0,top:0});
 const prompts=[],listeners={};let sequence=10;
 const context=vm.createContext({document,window,URL,URLSearchParams,localStorage:store,navigator:{locks:lock},console,confirm:s=>{prompts.push(s);return confirm;},addEventListener:(n,f)=>listeners[n]=f,
  GTA:{caps:()=>({endpoint:server.endpoint||'https://example.invalid/flows'}),uuid:()=>`10000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,chaveLeitura:()=> 'fixture-reader',erro:r=>({texto:r.body.erro})},GRU:{chaveEscrita:()=> 'fixture-writer'},
  fetch:async(url,init)=>{
   const response=(body,status=200)=>({ok:status<300,status,json:async()=>clone(body)}),q=new URL(url).searchParams;
   if(init.method==='POST'){
    const {k,...p}=JSON.parse(init.body);server.calls.push({method:'POST',action:p.acao,id:p.idempotency_key,origin:new URL(url).origin});assert.equal(k,'fixture-writer');
    if(server.mode==='unknown')throw Error('lost before commit evidence');
    const f=server.flows.find(f=>f.key===p.key);let result;
    if(['409','422'].includes(server.mode))result={_http:Number(server.mode),_body:{erro:server.mode==='409'?'version_conflict':'validation',messages:['Erro sintético definido']}};
    else{if(p.acao==='fluxo_salvar'){f.draft=clone(p.definition);f.version++;}if(p.acao==='fluxo_publicar')f.published_version=f.version;if(p.acao==='fluxo_estado'){f.enabled=p.enabled;f.version++;}result={_http:200,_body:{flow:clone(f),valid:true}};}
    server.receipts.set(p.idempotency_key,{actor:'fixture-writer',idempotency_key:p.idempotency_key,acao:p.acao,state:'completed',request_payload:p,response:result});throw Error('HTTP response lost after commit');
   }
   const a=q.get('acao');server.calls.push({method:'GET',action:a,origin:new URL(url).origin});
   if(a==='fluxos_listar')return response({flows:server.flows});
   if(a==='listar')return response({templates:[]});
   assert.equal(a,'fluxo_operacao');assert.equal(init.headers.Authorization,'Bearer fixture-writer');assert.equal(q.has('k'),false);
   const id=q.get('idempotency_key'),acao=q.get('operation_action');if(server.changeEndpointAfterPreflight&&!server.receipts.has(id))server.endpoint='https://different.invalid/flows';return response({contract:'flow_operation_v1',operation:server.receipts.get(id)||{actor:'fixture-writer',idempotency_key:id,acao,state:'missing',request_payload:null,response:null}});
  }});
 for(const file of ['growth-flow-journal.js','growth-canvas.js','growth-builder.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 const run=code=>vm.runInContext(code,context),dialogs=[];
 const mutate=async(code,accept=true)=>{const pending=run(code),dialog=document.querySelector('#builder-confirm');assert.ok(dialog);dialogs.push(dialog.textContent);dialog.querySelector(accept?'[data-flow-confirm]':'[data-flow-cancel]').click();await pending;assert.equal(document.querySelector('#builder-confirm'),null);};
 run('GB.ctx={marca:"fish"}');return {run,mutate,document,prompts,dialogs,server,store,lock,listeners,q:s=>document.querySelector(s)};
}
test('human cancel for publish/pause/resume shows brand, journey, effect and sends no GET or POST',async()=>{
 const b=browser({confirm:false});await b.run('GB.load()');const n=b.server.calls.length;
 for(const action of ["GB.mutate('fluxo_publicar')","GB.mutate('fluxo_estado',{enabled:false})","GB.mutate('fluxo_estado',{enabled:true})"])await b.mutate(action,false);
 assert.equal(b.server.calls.length,n);assert.equal(b.prompts.length,0);assert.equal(b.dialogs.length,3);
 for(const text of b.dialogs){assert.match(text,/MarcaFishermans/);assert.match(text,/JornadaCarrinho fish/);assert.match(text,/Versão2/);assert.match(text,/descadastro/);}
 assert.match(b.dialogs[1],/já aceitas ou em trânsito/);assert.equal(b.run('GB.state.busy'),false);
});
test('confirmed actions have one human confirmation and one mutation; receipt recovers lost POST response',async()=>{
 for(const [action,confirm] of [["fluxo_publicar","publicar"],["fluxo_estado","pausar"]]){
  const b=browser();await b.run('GB.load()');await b.mutate(`GB.mutate('${action}',${action==='fluxo_estado'?'{enabled:false}':'{}'})`);
  assert.equal(b.prompts.length,0);assert.equal(b.dialogs.length,1);assert.equal(b.server.calls.filter(c=>c.method==='POST').length,1);assert.equal(b.run('GB.state.pending'),null);assert.equal(b.run('GB.state.error'),'');
  const op=[...b.server.receipts.values()][0];assert.equal(op.request_payload.confirm,confirm);assert.equal(op.request_payload.key,'fish:carrinho');
 }
});
test('unknown save survives reselect, refresh, page reload and another tab without replacing identity or local data',async()=>{
 const b=browser();await b.run('GB.load()');b.server.mode='unknown';b.run('GB.state.draft.name="Minha edição";GB.change()');await b.run("GB.mutate('fluxo_salvar')");
 const id=b.run('GB.state.pending.id');assert.ok(id);assert.match(b.q('#builder-reconcile').textContent,/Consultar/);assert.equal(b.q('#builder-name').disabled,true);
 b.run("GB.select('aristo:carrinho');GBC.add('anything')");assert.equal(b.run('GB.state.selected'),'fish:carrinho');await b.run('GB.load()');assert.equal(b.run('GB.state.pending.id'),id);assert.equal(b.run('GB.state.draft.name'),'Minha edição');
 const reload=browser({server:b.server,store:b.store,lock:b.lock});await reload.run('GB.load()');assert.equal(reload.run('GB.state.pending.id'),id);assert.equal(reload.run('GB.state.baseVersion'),2);assert.equal(reload.run('GB.state.draft.name'),'Minha edição');
 await reload.run("GB.mutate('fluxo_salvar')");await reload.run('GB.reconcile()');assert.equal(b.server.calls.filter(c=>c.method==='POST').length,1);assert.equal(reload.run('GB.state.pending.id'),id);
 assert.equal(reload.run('GB.canLeave()'),false);assert.equal(reload.q('#builder-save').disabled,true);
});
test('definite rejected receipt preserves dirty draft and releases controls without a second mutation',async()=>{
 for(const status of ['409','422']){const b=browser();await b.run('GB.load()');b.server.mode=status;b.run('GB.state.draft.name="Preservar edição";GB.change()');await b.run("GB.mutate('fluxo_salvar')");assert.equal(b.run('GB.state.pending'),null);assert.equal(b.run('GB.state.dirty'),true);assert.equal(b.run('GB.state.baseVersion'),2);assert.equal(b.run('GB.state.draft.name'),'Preservar edição');assert.equal(b.q('#builder-save').disabled,false);assert.equal(b.q('#builder-name').disabled,false);assert.equal(b.server.calls.filter(c=>c.method==='POST').length,1);}
});
test('rejected draft can be recovered after page reload with original version and no mutation',async()=>{
 const b=browser();await b.run('GB.load()');b.server.mode='409';b.run('GB.state.draft.name="Edição recusada durável";GB.change()');await b.run("GB.mutate('fluxo_salvar')");
 b.server.flows[0].version=3;
 const reload=browser({server:b.server,store:b.store,lock:b.lock});await reload.run('GB.load()');
 assert.equal(reload.run('GB.state.baseVersion'),3);assert.ok(reload.q('#builder-recover-draft'));
 reload.q('#builder-recover-draft').click();assert.equal(reload.run('GB.state.baseVersion'),2);assert.equal(reload.run('GB.state.draft.name'),'Edição recusada durável');assert.equal(reload.run('GB.state.dirty'),true);assert.equal(b.server.calls.filter(c=>c.method==='POST').length,1);
});
test('refresh and reconciliation of another tab preserve an existing different local draft',async()=>{
 const a=browser(),b=browser({server:a.server,store:a.store,lock:a.lock});await a.run('GB.load()');await b.run('GB.load()');
 b.run("GB.select('aristo:carrinho');GB.state.draft.name='Minha edição Aristo';GB.change()");
 a.server.mode='unknown';a.run("GB.state.draft.name='Tentativa Fish';GB.change()");await a.run("GB.mutate('fluxo_salvar')");
 await b.run('GB.load()');assert.equal(b.run('GB.state.selected'),'aristo:carrinho');assert.equal(b.run('GB.state.draft.name'),'Minha edição Aristo');
 const op=a.run('GB.state.pending');const f=clone(a.server.flows[0]);f.version=3;f.draft=clone(op.request_payload.definition);
 a.server.receipts.set(op.id,{actor:op.actor,idempotency_key:op.id,acao:op.request_payload.acao,state:'completed',request_payload:clone(op.request_payload),response:{_http:200,_body:{flow:f,valid:true}}});
 await b.run('GB.reconcile()');assert.equal(b.run('GB.state.selected'),'aristo:carrinho');assert.equal(b.run('GB.state.draft.name'),'Minha edição Aristo');assert.equal(b.run('GB.state.dirty'),true);assert.equal(b.run('GB.state.baseVersion'),2);assert.equal(b.run('GB.state.pending'),null);assert.equal(a.server.calls.filter(c=>c.method==='POST').length,1);
});
test('capability refresh after preflight cannot move transport, receipt or apply to a different endpoint',async()=>{
 const b=browser();await b.run('GB.load()');b.server.changeEndpointAfterPreflight=true;
 await b.mutate("GB.mutate('fluxo_publicar')");
 const calls=b.server.calls.filter(c=>c.action!=='fluxos_listar');assert.deepEqual(calls.map(c=>c.method),['GET','POST','GET']);assert.ok(calls.every(c=>c.origin==='https://example.invalid'));
 assert.equal(b.run('GB.state.error'),'');assert.equal(b.run('GB.state.pending'),null);
 const j=JSON.parse(b.store.getItem('shrigma_flow_operations_v1:grupo-shrigma'));assert.equal(j.operations[0].endpoint,'https://example.invalid/flows');assert.equal(j.operations[0].applied,true);
});
test('open confirmation blocks editing, journey selection and a second action; Escape cancels without requests',async()=>{
 const b=browser();await b.run('GB.load()');const n=b.server.calls.length,pending=b.run("GB.mutate('fluxo_publicar')");
 assert.equal(b.run('GB.canLeave()'),false);assert.equal(b.q('#builder-save').disabled,true);assert.equal(b.q('#builder-name').disabled,true);
 b.run("GB.select('aristo:carrinho')");await b.run("GB.mutate('fluxo_estado',{enabled:false})");assert.equal(b.run('GB.state.selected'),'fish:carrinho');assert.equal(b.document.querySelectorAll('#builder-confirm').length,1);
 const dialog=b.q('#builder-confirm');assert.equal(dialog.getAttribute('aria-labelledby'),'builder-confirm-title');assert.ok(b.q('#builder-confirm-effect'));
 const event=new b.document.defaultView.Event('keydown',{cancelable:true});event.key='Escape';dialog.dispatchEvent(event);await pending;
 assert.equal(b.server.calls.length,n);assert.equal(b.run('GB.state.busy'),false);assert.equal(b.run('GB.canLeave()'),true);
});
test('brand, selected journey, draft or remote version changes during confirmation reject before any request',async()=>{
 for(const change of ['GB.ctx.marca="aristo"','GB.state.selected="aristo:carrinho"','GB.state.draft.name="Outra edição"','GB.state.flows[0].version=3','GB.state.baseVersion=1']){
  const b=browser();await b.run('GB.load()');const n=b.server.calls.length,pending=b.run("GB.mutate('fluxo_publicar')");b.run(change);b.q('[data-flow-confirm]').click();await pending;
  assert.equal(b.server.calls.length,n,change);assert.match(b.run('GB.state.error'),/mudou durante a confirmação/);assert.equal(b.run('GB.state.busy'),false);
 }
});
test('capability and writer refresh during the dialog retain the confirmed transport identity',async()=>{
 const b=browser();await b.run('GB.load()');const pending=b.run("GB.mutate('fluxo_publicar')");b.server.endpoint='https://different.invalid/flows';b.run('GRU.chaveEscrita=()=>"different-writer"');b.q('[data-flow-confirm]').click();await pending;
 const calls=b.server.calls.filter(c=>c.action!=='fluxos_listar');assert.deepEqual(calls.map(c=>c.method),['GET','POST','GET']);assert.ok(calls.every(c=>c.origin==='https://example.invalid'));assert.equal(b.run('GB.state.error'),'');
});
