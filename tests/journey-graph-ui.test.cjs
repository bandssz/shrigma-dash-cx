'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const UI=require('../growth-journey-graph-ui.js'),Editor=require('../growth-journey-graph-editor.js');
const {fixture,id}=require('./fixtures/journey-graph-runtime.cjs');
const copy=x=>JSON.parse(JSON.stringify(x)),tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const API={capabilities:{journeys:{graph_drafts:'journey_graph_draft_api_v1'},endpoints:{journey_graph:'https://example.invalid/graph'}}};
function shared(){
 const f=Object.fromEntries(['fish','aristo'].map(b=>[b,fixture({async connect(){throw Error('No storage access in UI tests');}},b)])),store=new Map(),saved=new Map(),calls=[],journal={pending:null};let seq=1,mode='success',readHook=null,runHook=null;
 const state={read:(kind,brand)=>copy(store.get(brand)||null),save:(kind,brand,value)=>store.set(brand,copy(value))};
 function result(op){const p=op.payload,old=p.action==='save'?saved.get(p.journey_id):null,server={journey_id:p.journey_id||id(100+seq++),brand:p.brand,version:old?old.server.version+1:1,revision:old?old.server.revision+1:1,published_revision:null,paused:true};
  const receipt={...server,operation_id:p.request_id};saved.set(server.journey_id,{server,definition:copy(p.definition)});op.receipt=receipt;return {state:'succeeded',receipt,request_payload:copy(p)};}
 function factory({endpoint,key}){return {
  inspect(){return {pending:copy(journal.pending),blocked:!!journal.pending};},
  async get(action,brand,params={}){calls.push({kind:'get',action,brand,params:copy(params),endpoint});if(readHook){const r=readHook(action,brand,params);if(r!==undefined)return await r;}
   const catalog=copy(f[brand].catalog),labels={triggers:{'cart.abandoned':'Carrinho abandonado'},fields:{},messages:{'cart.email':'Mensagem da marca'}};
   if(action==='catalog')return {catalog,labels};if(action==='list')return {journeys:[...saved.values()].filter(x=>x.server.brand===brand).map(x=>({...x.server,name:x.definition.name})),next_cursor:null};
   const v=saved.get(params.journey_id);if(!v||v.server.brand!==brand)throw Error('Não encontrado');return {...copy(v),catalog,labels};
  },
  async run(p){const op={payload:{...copy(p),request_id:id(seq++)},endpoint};calls.push({kind:'run',payload:copy(op.payload),endpoint});if(mode==='conflict')throw Error('Outra pessoa salvou uma versão mais recente. Sua edição foi preservada; confira a versão salva.');journal.pending=op;if(runHook)return await runHook(op,result);if(mode==='unknown')return {state:'unconfirmed'};return result(op);},
  async recover(requestId,{resume=false}={}){calls.push({kind:'recover',requestId,resume,endpoint});assert.equal(requestId,journal.pending.payload.request_id);if(!resume&&!journal.pending.receipt)return {state:'unconfirmed'};return journal.pending.receipt?{state:'succeeded',receipt:copy(journal.pending.receipt),request_payload:copy(journal.pending.payload)}:result(journal.pending);},
  async acknowledge(requestId){calls.push({kind:'ack',requestId,endpoint,buffer:copy(store.get(journal.pending.payload.brand)||null)});assert.equal(requestId,journal.pending.payload.request_id);journal.pending=null;}
 };}
 return {f,state,store,saved,calls,journal,factory,setMode:x=>mode=x,setReadHook:x=>readHook=x,setRunHook:x=>runHook=x};
}
function boot(s=shared()){
 const {document,window}=parseHTML('<html><body><button id="control-tab-graph" hidden></button><section id="control-graph"></section></body></html>');
 let active=document.body;Object.defineProperty(document,'activeElement',{get:()=>active});window.HTMLElement.prototype.focus=function(){active=this;};
 const root=document.querySelector('#control-graph'),ui=UI.create({document,Editor,state:s.state,key:()=> 'synthetic-key',clientFactory:s.factory});
 const el=sel=>{const x=document.querySelector(sel);assert.ok(x,'missing '+sel);return x;};
 const sync=(brand='fish',extra={})=>ui.sync({api:API,marca:brand,section:'regua',tab:'graph',...extra});
 const click=async sel=>{const b=el(sel);b.focus();b.dispatchEvent(new window.Event('click',{bubbles:true}));await tick();};
 const name=value=>{const input=el('[data-name]');input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));return input;};
 const escape=async()=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:'Escape'});document.activeElement.dispatchEvent(event);await tick();};
 return {s,document,window,root,ui,el,sync,click,name,escape};
}
test('capability and route gates perform no reads while absent or hidden; supported brands load on opening',async()=>{
 const x=boot();await x.sync('fish',{api:{}});assert.equal(x.el('#control-tab-graph').hidden,true);assert.equal(x.s.calls.length,0);
 await x.sync('fish',{section:'inicio',tab:'overview'});assert.equal(x.s.calls.length,0);
 await x.sync();assert.equal(x.ui.contextStatus().pending,false);assert.equal(x.s.calls.filter(x=>x.kind==='get').length,2);assert.ok(x.el('[data-name]'));
 await x.sync('todas');assert.equal(x.el('#control-tab-graph').disabled,true);assert.equal(x.s.calls.length,2);assert.match(x.root.textContent,/Escolha Fishermans ou O Aristocrata/);
});
test('contextual additions persist their paths per brand and save only after the explicit draft action',async()=>{
 const x=boot();await x.sync();await x.click('[data-action="insert"][data-node="entry"][data-type="condition"]');
 const fish=copy(x.s.store.get('fish'));assert.equal(fish.definition.nodes.length,4);assert.equal(x.ui.contextStatus().dirty,true);assert.equal(x.s.calls.filter(c=>c.kind==='run').length,0);
 await x.sync('aristo');assert.equal(x.root.querySelector('[data-node-id="step1"]'),null);await x.click('[data-action="insert"][data-node="entry"][data-type="message"]');assert.equal(x.s.store.get('aristo').definition.nodes.length,3);
 await x.sync('fish');assert.deepEqual(x.s.store.get('fish'),fish);await x.click('[data-graph="save"]');
 const request=x.s.calls.find(c=>c.kind==='run');assert.equal(request.payload.brand,'fish');assert.deepEqual(request.payload.definition,fish.definition);assert.equal(x.s.store.get('fish').server.paused,true);assert.equal(x.s.store.get('fish').server.published_revision,null);assert.equal(x.s.store.get('aristo').server,null);
});
test('late catalog/list of the previous brand cannot restore it over the current brand',async()=>{
 const x=boot(),wait=deferred();x.s.setReadHook((a,b)=>b==='fish'?wait.promise.then(()=>a==='catalog'?{catalog:x.s.f.fish.catalog,labels:{}}:{journeys:[],next_cursor:null}):undefined);
 const old=x.sync();await x.sync('aristo');assert.match(x.root.textContent,/O Aristocrata/);wait.resolve();await old;
 assert.match(x.root.textContent,/O Aristocrata/);assert.doesNotMatch(x.root.textContent,/Construir fluxo · Fishermans/);assert.equal(x.ui.contextStatus().brand,'aristo');assert.equal(x.el('[data-name]').disabled,false);
});
test('create/save/reopen use the confirmed identity and preserve separate Fish and Aristo buffers',async()=>{
 const x=boot();await x.sync();x.name('Fish inicial');await x.click('[data-graph="save"]');const fish=x.s.store.get('fish');assert.equal(fish.server.version,1);assert.equal(x.s.journal.pending,null);
 x.name('Fish revisão');await x.click('[data-graph="save"]');assert.equal(x.s.calls.filter(x=>x.kind==='run')[1].payload.action,'save');assert.equal(x.s.calls.filter(x=>x.kind==='run')[1].payload.expected_version,1);assert.equal(x.s.store.get('fish').server.version,2);
 x.name('Fish edição não salva');await x.sync('aristo');x.name('Aristo edição própria');await x.sync('fish');assert.equal(x.el('[data-name]').value,'Fish edição não salva');assert.equal(x.ui.contextStatus().dirty,true);
 await x.click('[data-graph="open"]');assert.ok(x.el('[role="alertdialog"]'));await x.click('[data-graph="accept"]');assert.equal(x.el('[data-name]').value,'Fish revisão');assert.equal(x.ui.contextStatus().dirty,false);
 await x.sync('aristo');assert.equal(x.el('[data-name]').value,'Aristo edição própria');assert.equal(x.s.calls.filter(x=>x.kind==='run').length,2);
});
test('a version conflict preserves the edited definition and old CAS version across reload',async()=>{
 const s=shared(),x=boot(s);await x.sync();x.name('Salvo');await x.click('[data-graph="save"]');x.name('Minha edição');s.setMode('conflict');await x.click('[data-graph="save"]');
 assert.match(x.el('[data-graph-status]').textContent,/versão mais recente/);assert.equal(x.el('[data-name]').value,'Minha edição');assert.equal(x.ui.contextStatus().dirty,true);assert.equal(s.store.get('fish').server.version,1);
 const reload=boot(s);await reload.sync();assert.equal(reload.el('[data-name]').value,'Minha edição');assert.equal(reload.ui.contextStatus().dirty,true);assert.equal(s.store.get('fish').base.name,'Salvo');
});
test('unknown save survives reload, GET-only recovery and cancel; explicit resume retains the same request',async()=>{
 const s=shared(),x=boot(s);s.setMode('unknown');await x.sync();x.name('Não duplicar');await x.click('[data-graph="save"]');const pending=copy(s.journal.pending);
 assert.equal(x.el('[data-name]').disabled,true);assert.equal(x.el('[data-graph="new"]').disabled,true);
 const reload=boot(s);await reload.sync();assert.equal(reload.el('[data-name]').value,'Não duplicar');assert.equal(reload.ui.contextStatus().pending,true);
 await reload.click('[data-graph="recover"]');assert.ok(reload.document.activeElement===reload.el('[data-graph="cancel"]'),'asynchronous confirmation keeps focus in live dialog');assert.equal(s.calls.filter(x=>x.kind==='run').length,1);assert.equal(s.calls.filter(x=>x.kind==='recover').at(-1).resume,false);await reload.escape();assert.equal(s.journal.pending.payload.request_id,pending.payload.request_id);
 await reload.click('[data-graph="recover"]');await reload.click('[data-graph="accept"]');assert.equal(s.calls.filter(x=>x.kind==='run').length,1);assert.equal(s.calls.filter(x=>x.kind==='recover').at(-1).resume,true);assert.equal(s.calls.filter(x=>x.kind==='recover').at(-1).requestId,pending.payload.request_id);
 assert.equal(s.journal.pending,null);assert.equal(reload.ui.contextStatus().pending,false);assert.equal(s.store.get('fish').definition.name,'Não duplicar');assert.equal(reload.ui.contextStatus().dirty,false);
});
test('discard requires confirmation, Escape keeps the draft and focus returns to the visible invoking control',async()=>{
 const x=boot();await x.sync();x.name('Preservar');await x.click('[data-graph="new"]');assert.ok(x.el('[data-graph-content]').hasAttribute('inert'));assert.ok(x.document.activeElement===x.el('[data-graph="cancel"]'),'cancel receives focus');
 await x.escape();assert.equal(x.el('[data-name]').value,'Preservar');assert.ok(x.document.activeElement===x.el('[data-graph="new"]'),'visible invoking button receives focus');assert.equal(x.el('[data-graph-content]').hasAttribute('inert'),false);
 await x.click('[data-graph="new"]');await x.click('[data-graph="accept"]');assert.equal(x.el('[data-name]').value,'Nova jornada');assert.equal(x.s.calls.filter(x=>x.kind==='run').length,0);
});
test('onChange persists without rebuilding the focused input or caret; simulation does not dirty the buffer',async()=>{
 const x=boot();await x.sync();const input=x.el('[data-name]');input.focus();input.selectionStart=4;input.selectionEnd=4;x.name('Fluxo editado');assert.ok(x.el('[data-name]')===input,'same input node');assert.ok(x.document.activeElement===input,'input keeps focus');assert.equal(input.selectionStart,4);assert.equal(x.s.store.get('fish').definition.name,'Fluxo editado');
 await x.click('[data-graph="save"]');const saved=copy(x.s.store.get('fish'));await x.click('[data-action="simulate"]');assert.deepEqual(x.s.store.get('fish'),saved);assert.equal(x.ui.contextStatus().dirty,false);assert.equal(x.s.calls.filter(x=>x.kind==='run').length,1);
});
test('capability loss and restoration remount the same-brand draft without losing unblurred edits',async()=>{
 const x=boot();await x.sync();x.name('Ainda nesta marca');await x.sync('fish',{api:{}});assert.equal(x.root.innerHTML,'');await x.sync();assert.equal(x.el('[data-name]').value,'Ainda nesta marca');assert.equal(x.ui.contextStatus().dirty,true);
});
test('a save response arriving after a brand round trip stays pending until explicitly recovered',async()=>{
 const x=boot(),wait=deferred();x.s.setRunHook((op,result)=>wait.promise.then(()=>result(op)));await x.sync();x.name('Fish reservado');await x.click('[data-graph="save"]');
 await x.sync('aristo');await x.sync('fish');wait.resolve();await tick();assert.equal(x.s.calls.filter(x=>x.kind==='ack').length,0);assert.equal(x.ui.contextStatus().pending,true);
 await x.click('[data-graph="recover"]');assert.equal(x.s.journal.pending,null);assert.equal(x.s.calls.filter(x=>x.kind==='run').length,1);assert.equal(x.s.store.get('fish').server.version,1);
});

test('malformed same-brand local preparation resolves sync with a visible error and preserves the entire buffer',async()=>{
 const s=shared(),definition={version:'journey_graph_v1',brand:'fish',name:'Preservar bytes',nodes:null,edges:[]},buffer={definition,server:null,base:copy(definition)};
 s.store.set('fish',copy(buffer));const x=boot(s);await assert.doesNotReject(x.sync());
 assert.match(x.el('[data-graph-status]').textContent,/preparação guardada.*preservada.*Recarregue/);assert.deepEqual(s.store.get('fish'),buffer);
 assert.equal(x.el('[data-graph="save"]').disabled,true);assert.equal(x.el('[data-graph="new"]').disabled,true);assert.equal(x.ui.contextStatus().blocked,true);assert.equal(x.ui.contextStatus().pending,false);
 assert.equal(s.calls.some(c=>c.kind==='run'||c.kind==='recover'||c.kind==='ack'),false);
 const reload=boot(s);await assert.doesNotReject(reload.sync());assert.deepEqual(s.store.get('fish'),buffer);assert.match(reload.root.textContent,/Preparação preservada/);
});

function recoveryFixture({different=false}={}){
 const s=shared(),base=copy(s.f.fish.graph),submitted={...copy(base),name:'Submetido'},local={...copy(base),name:'Edição local mais recente'};
 const previous={journey_id:id(600),brand:'fish',version:1,revision:1,published_revision:null,paused:true},confirmed={...previous,version:2,revision:2};
 const payload={action:'save',brand:'fish',journey_id:previous.journey_id,expected_version:1,definition:submitted,request_id:id(601)};
 s.saved.set(confirmed.journey_id,{server:confirmed,definition:submitted});
 s.journal.pending={payload,endpoint:API.capabilities.endpoints.journey_graph,receipt:{...confirmed,operation_id:payload.request_id}};
 const buffer={definition:local,server:different?{...previous,journey_id:id(602)}:previous,base};s.store.set('fish',copy(buffer));return {s,buffer,submitted,confirmed};
}
test('recovering the same journey keeps a newer local edit and advances only its saved baseline and identity',async()=>{
 const {s,buffer,submitted,confirmed}=recoveryFixture(),x=boot(s);await x.sync();await x.click('[data-graph="recover"]');
 const after=s.store.get('fish');assert.deepEqual(after.definition,buffer.definition);assert.deepEqual(after.base,submitted);assert.deepEqual(after.server,confirmed);assert.equal(after.last_recovered,undefined);
 assert.equal(x.el('[data-name]').value,buffer.definition.name);assert.equal(x.ui.contextStatus().dirty,true);assert.equal(x.ui.contextStatus().pending,false);assert.match(x.el('[data-graph-status]').textContent,/alterações locais ainda não salvas/);
 assert.deepEqual(s.calls.find(c=>c.kind==='ack').buffer,after);assert.equal(s.calls.filter(c=>c.kind==='run').length,0);
});
test('recovering another journey durably preserves the full edited buffer and last recovered draft before acknowledging',async()=>{
 const {s,buffer,submitted,confirmed}=recoveryFixture({different:true}),x=boot(s);await x.sync();await x.click('[data-graph="recover"]');
 const expected={...buffer,last_recovered:{definition:submitted,server:confirmed}},after=s.store.get('fish');assert.deepEqual(after,expected);assert.deepEqual(s.calls.find(c=>c.kind==='ack').buffer,expected);
 assert.equal(x.el('[data-name]').value,buffer.definition.name);assert.equal(x.ui.contextStatus().dirty,true);assert.equal(x.ui.contextStatus().pending,false);assert.equal(x.el('[data-name]').disabled,false);
 assert.match(x.el('[data-graph-status]').textContent,/Gravação confirmada; edição atual mantida. Fluxo recuperado em Rascunhos salvos/);assert.ok(x.root.querySelector('[data-graph="open"][data-id="'+confirmed.journey_id+'"]'));
 const reload=boot(s);await reload.sync();assert.deepEqual(s.store.get('fish'),expected);assert.equal(reload.el('[data-name]').value,buffer.definition.name);assert.equal(s.calls.filter(c=>c.kind==='run').length,0);
});
