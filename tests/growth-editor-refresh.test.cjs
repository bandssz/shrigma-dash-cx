'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom');
const source=file=>fs.readFileSync(require.resolve('../'+file),'utf8');
function builder(visual=false){
 const {document,window}=parseHTML('<body><section id="control-fluxos"></section></body>');let focused=null;
 Object.defineProperty(document,'activeElement',{get:()=>focused?.isConnected?focused:document.body});
 window.HTMLElement.prototype.getBoundingClientRect=()=>({width:1000,height:700,x:0,y:0,left:0,top:0});
 window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.setSelectionRange=function(a,b,d){this.selectionStart=a;this.selectionEnd=b;this.selectionDirection=d;};
 const context=vm.createContext({document,window,console,confirm:()=>false}),run=s=>vm.runInContext(s,context);
 run(source('growth-builder.js'));if(visual){run(source('growth-canvas.js'));run('GBC.flowKey="fish:carrinho";GBC.selected="step:w"');}
 run(`GB.journal=()=>null;GB.loadTemplates=async()=>{};const step={key:'w',name:'Etapa',channel:'whatsapp',kind:'interactive',body:'Original',wait_min:30,min_wait:1,max_wait:60,enabled:true};const flow={key:'fish:carrinho',brand:'fish',name:'Carrinho Fish',trigger:'Sintético',version:1,published_version:1,runtime_ready:true,enabled:true,available_steps:[step],draft:{name:'Carrinho Fish',steps:[step]}};GB.state={...GB.state,loaded:true,flows:[flow],selected:flow.key,baseVersion:1,draft:GB.clone(flow.draft)};GB.render({marca:'fish'});`);
 return {document,window,run,q:s=>document.querySelector(s)};
}
test('focused journey text persists on input before blur and refresh preserves focus/cursor',()=>{
 const x=builder(),input=x.q('[data-field="body"]');input.value='Edição em andamento';input.focus();input.setSelectionRange(6,9,'backward');input.dispatchEvent(new x.window.Event('input'));
 assert.equal(x.run('GB.state.draft.steps[0].body'),'Edição em andamento');assert.equal(x.run('GB.state.dirty'),true);
 x.run('GB.render({marca:"fish"})');const after=x.q('[data-field="body"]');assert.equal(after.value,'Edição em andamento');assert.equal(x.document.activeElement===after,true);assert.deepEqual([after.selectionStart,after.selectionEnd,after.selectionDirection],[6,9,'backward']);
 assert.equal(x.run('GB.state.baseVersion'),1);assert.equal(x.run('GB.state.pending'),null);
});
test('focused wait and journey name survive refresh without premature input normalization',()=>{
 const x=builder(),input=x.q('[data-field="wait_min"]');input.value='31';input.focus();input.dispatchEvent(new x.window.Event('input'));assert.equal(x.run('GB.state.draft.steps[0].wait_min'),31);
 x.run('GB.render({marca:"fish"})');assert.equal(x.q('[data-field="wait_min"]').value,'31');assert.equal(x.document.activeElement===x.q('[data-field="wait_min"]'),true);
 const name=x.q('#builder-name');name.value='Nome novo';name.focus();name.setSelectionRange(2,4,'forward');name.dispatchEvent(new x.window.Event('input'));x.run('GB.render()');assert.equal(x.q('#builder-name').value,'Nome novo');assert.equal(x.document.activeElement===x.q('#builder-name'),true);assert.equal(x.q('#builder-name').selectionStart,2);
});
test('empty brand clears only clean selection and never displays the previous brand journey',()=>{
 const x=builder();x.run('GB.render({marca:"aristo"})');assert.equal(!!x.q('#builder-name'),false);assert.equal(x.run('GB.state.selected'),null);assert.equal(x.run('GB.state.draft'),null);assert.match(x.q('#control-fluxos').textContent,/Nenhuma jornada/);
 x.run('GB.render({marca:"fish"})');assert.equal(x.run('GB.state.selected'),'fish:carrinho');assert.equal(x.q('#builder-name').value,'Carrinho Fish');
});
test('out-of-scope dirty draft and pending journal stay preserved without a misleading editor',()=>{
 const x=builder();x.run('GB.state.dirty=true;GB.state.pending={signature:"retained",context:{brand:"fish",name:"Pendente"},request_payload:{key:"fish:carrinho"}}');const before=x.run('JSON.stringify(GB.state)');
 x.run('GB.render({marca:"aristo"})');assert.equal(!!x.q('#builder-name'),false);assert.equal(x.run('JSON.stringify(GB.state)'),before);assert.ok(x.q('#builder-reconcile'));
 x.run('GB.render({marca:"fish"})');assert.equal(x.q('#builder-name').value,'Carrinho Fish');assert.equal(x.run('JSON.stringify(GB.state)'),before);
});
function catalog(){
 const {document,window}=parseHTML('<body><div id="control-workflows"></div><div id="control-templates"></div></body>'),pending=[];let key='synthetic-key';
 const endpoint='https://example.invalid/templates',api={crm_operacao:JSON.parse(fs.readFileSync(require.resolve('./fixtures/growth-control.json'),'utf8')),capabilities:{endpoints:{templates:endpoint}}};
 const GTA={caps:a=>({endpoint:a.capabilities.endpoints.templates,pode:{read_content:true,list_history:true}}),chaveLeitura:()=>key,cliente:()=>({listar:brand=>new Promise(resolve=>pending.push({brand,resolve})),historico:()=>new Promise(resolve=>pending.push({resolve}))}),erro:()=>({texto:'Synthetic read failure'}),publicadoAtivo:()=>null};
 const context=vm.createContext({document,window,Date,Intl,GTA,console}),run=s=>vm.runInContext(s,context);context.ctx={api,marca:'fish',canal:'whatsapp'};
 run(source('growth-control.js'));run('GC.render(ctx)');
 return {document,pending,run,api,key:v=>key=v,brand:v=>run('GC.render({...ctx,marca:'+JSON.stringify(v)+'})')};
}
test('late catalog response cannot repaint the previous brand or overwrite a newer request',async()=>{
 const x=catalog(),old=x.run('GC.carregarConteudo(ctx)');x.brand('aristo');const fresh=x.run('GC.carregarConteudo(GC.previewContext)');assert.equal(x.pending.length,2);
 x.pending[1].resolve({ok:true,body:{templates:[]}});await fresh;x.pending[0].resolve({ok:true,body:{templates:[{key:'stale-fish'}]}});await old;
 assert.equal(x.run('GC.previewContext.marca'),'aristo');assert.equal(x.run('GC.conteudo["stale-fish"]'),undefined);assert.deepEqual([...x.document.querySelectorAll('[data-control-template]')].map(e=>e.dataset.controlTemplate),['aristo_paid']);assert.equal(x.run('GC.carregando'),null);
});
test('late history result cannot replace the current brand context or history',async()=>{
 const x=catalog(),old=x.run('GC.carregarHistorico(ctx,"fish_paid")');x.brand('aristo');x.pending[0].resolve({ok:true,body:{events:[{action:'stale'}]}});await old;
 assert.equal(x.run('GC.previewContext.marca'),'aristo');assert.equal(x.run('GC.historicos.fish_paid'),undefined);assert.equal(x.run('GC.carregando'),null);
});
test('catalog results are discarded when access or endpoint changes, including a failed response',async()=>{
 for(const changed of ['key','endpoint'])for(const ok of [true,false]){
  const x=catalog(),old=x.run('GC.carregarConteudo(ctx)');if(changed==='key')x.key('new-synthetic-key');else x.api.capabilities.endpoints.templates='https://example.invalid/other';
  x.pending[0].resolve({ok,body:{templates:[{key:'stale'}]}});await old;assert.equal(x.run('GC.conteudo'),null);assert.equal(x.run('GC.conteudoErro'),null);assert.equal(x.run('GC.carregando'),null);
 }
});

test('visual canvas inspector preserves typing and selection through a template refresh',()=>{
 const x=builder(true),input=x.q('.flow-inspector [data-field="body"]');assert.ok(input);input.value='Texto do inspetor';input.focus();input.setSelectionRange(4,8,'forward');input.dispatchEvent(new x.window.Event('input'));
 x.run('GB.render()');const after=x.q('.flow-inspector [data-field="body"]');assert.equal(after.value,'Texto do inspetor');assert.equal(x.document.activeElement===after,true);assert.deepEqual([after.selectionStart,after.selectionEnd],[4,8]);assert.equal(x.run('GBC.selected'),'step:w');assert.equal(x.run('GB.state.dirty'),true);
});
