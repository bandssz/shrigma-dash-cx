const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const GB=require('../growth-builder.js');
const {parseHTML}=require(require.resolve('linkedom',{paths:[path.resolve(__dirname,'../../growth-test-tools/node_modules')]}));
test('NPS template choices preserve signed link data; popup choices can use their own supplied fields',()=>{
 const flows=require('../n8n/growth/engagement-flow-definitions.json');
 const slot=flows.find(f=>f.key==='fish:nps-d3').steps[0];
 const template={status:'APPROVED',id:'999',draft_id:'fixture',components:{body_html:'{{ .Tx.Data.nps_url }}?p={{ .Tx.Data.p }}&e={{ .Tx.Data.e }}&s={{ .Tx.Data.s }}'}};
 assert.ok(GB.compatible(template,slot));
 assert.ok(!GB.compatible({...template,components:{body_html:'Olá {{ .Tx.Data.first_name }}'}},slot));
 assert.ok(!GB.compatible({...template,components:{body_html:template.components.body_html+' {{ .Tx.Data.tracking_url }}'}},slot));
 const popup=flows.find(f=>f.key==='fish:popup').steps[0];
 assert.ok(GB.compatible({...template,components:{body_html:'Olá {{ .Tx.Data.first_name }}'}},popup));
 const f={brand:'fish',available_steps:[slot]};GB.state.templates={};
 assert.match(GB.stepHtml(slot,0,f),/minutos desde a pesquisa inicial/);
});
test('template selection requires approval, compatible components and same email data',()=>{
 const components=[{type:'BODY',text:'Oi {{1}}'},{type:'BUTTONS',buttons:[{type:'URL',url:'https://example.com/{{1}}',text:'Abrir'}]}];
 const slot={channel:'whatsapp',category:'UTILITY',signature:GB.signature(components)};
 const t={status:'APPROVED',category:'UTILITY',language:'pt_BR',components};
 assert.ok(GB.compatible(t,slot));assert.ok(!GB.compatible({...t,status:'PENDING'},slot));
 assert.ok(!GB.compatible({...t,components:[{type:'BODY',text:'Oi {{1}} {{2}}'}]},slot));
 const es={channel:'email',template_id:'1',variables:['first_name']};
 assert.ok(GB.compatible({status:'APPROVED',id:'2',draft_id:'new',components:{body_html:'{{ .Tx.Data.first_name }}'}},es));
 assert.ok(!GB.compatible({status:'APPROVED',id:'2',draft_id:'new',components:{body_html:'{{ .Tx.Data.missing }}'}},es));
});
test('canvas shows server flows, protects dirty work and creates templates in the correct tab',()=>{
 const {document}=parseHTML('<section id="control-fluxos"></section><button data-control-tab="drafts"></button>');
 const context=vm.createContext({document,console,URLSearchParams,setTimeout,confirm:()=>false,GTA:{caps:()=>({endpoint:'/api'})}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../growth-builder.js'),'utf8'),context);
 vm.runInContext(`GB.state.loaded=true;GB.state.flows=[{key:'fish:cart',brand:'fish',name:'Carrinho',trigger:'Checkout abandonado',version:1,published_version:1,runtime_ready:true,enabled:true,available_steps:[],draft:{name:'Carrinho',steps:[]}}];GB.state.selected='fish:cart';GB.state.draft={name:'Carrinho',steps:[]};GB.render({marca:'fish'});`,context);
 assert.match(document.querySelector('#control-fluxos').textContent,/Checkout abandonado/);
 assert.equal(document.querySelector('#builder-publish').disabled,false);
 vm.runInContext('GB.state.dirty=true;GB.render()',context);
 assert.equal(document.querySelector('#builder-publish').disabled,true);assert.equal(document.querySelector('#builder-toggle').disabled,true);
 const code=fs.readFileSync(path.join(__dirname,'../growth-builder.js'),'utf8');assert.ok(code.includes('data-control-tab="drafts"'));assert.ok(!code.includes('data-move='));
});
test('refresh during editing cannot silently adopt another writer version',async()=>{
 const {document}=parseHTML('<section id="control-fluxos"></section>');
 const context=vm.createContext({document,console,URLSearchParams,setTimeout,confirm:()=>false,GTA:{caps:()=>({endpoint:'/api'}),uuid:()=> 'fixture-idempotency',erro:()=>({texto:'Conflito de versão'})}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../growth-builder.js'),'utf8'),context);
 await vm.runInContext(`(async()=>{GB.state.loaded=true;GB.state.selected='fish:cart';GB.state.baseVersion=1;GB.state.dirty=true;GB.state.draft={name:'Minha edição',steps:[]};GB.state.flows=[{key:'fish:cart',brand:'fish',version:2,published_version:1,available_steps:[],draft:{name:'Edição de outra pessoa',steps:[]}}];GB.journal=()=>({inspect:()=>({pending:null}),run:async input=>{globalThis.sent=input.request_payload;throw Error('Conflito de versão')}});globalThis.GRU={chaveEscrita:()=> 'synthetic'};await GB.mutate('fluxo_salvar');})()`,context);
 assert.equal(context.sent.expected_version,1);assert.equal(context.sent.definition.name,'Minha edição');
});
