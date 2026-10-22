'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.PRESENTATION_CONTEXT_SOURCE||path.resolve(__dirname,'../..');
const build=require(path.join(root,'services/dashboard-operational/build.cjs'));
const canonical=fs.readFileSync(path.join(root,'growth.html'),'utf8');
const transformed=build.transform(canonical,'growth.html');
const html=process.env.PRESENTATION_CONTEXT_IMAGE?fs.readFileSync('/app/presentation-release/public/growth.html','utf8'):transformed;
const bundle=fs.readFileSync(process.env.PRESENTATION_CONTEXT_IMAGE?'/app/presentation-release/public/assets/panels/growth.js':path.join(root,'assets/panels/growth.js'),'utf8');
const start=bundle.indexOf('const CRMWorkspace='),end=bundle.indexOf(';typeof module',start);
a.ok(start>=0&&end>start);
const workspace=bundle.slice(start,end)+';';
const listenerStart=html.indexOf("window.addEventListener('shrigma:brand-access'");
const listenerEnd=html.indexOf('\n});',listenerStart)+4;
a.ok(listenerStart>=0&&listenerEnd>listenerStart);
function fixture(api=null){
 const labels=new Map(['crm-brand-label','crm-active-brand','crm-screen-title'].map(id=>[id,{textContent:'Todas as marcas'}]));
 const selections=['todas','fish','aristo'].map(marca=>({dataset:{marca},classList:{toggle(k,v){this[k]=v;}}}));
 const document={body:{dataset:{}},getElementById:id=>labels.get(id)||null,querySelectorAll:q=>q==='#seg-marca button'?selections:[]};
 let event,renders=0,paints=0;
 const context=vm.createContext({document,window:{addEventListener(name,callback){a.equal(name,'shrigma:brand-access');event=callback;}},API:api,MARCA:'todas',SEC:'base',pintaMarca(){paints++;document.body.dataset.marca=context.MARCA;},render(){renders++;},fetch(){throw Error('Presentation must not request data');}});
 vm.runInContext(workspace,context);vm.runInContext(html.slice(listenerStart,listenerEnd),context);
 return {context,labels,selections,send:detail=>event({detail}),counts:()=>({renders,paints})};
}
for(const [brand,label]of [['fish','Fishermans'],['aristo','O Aristocrata']])test('authorized '+brand+' labels update before data arrives, including unavailable reads',()=>{
 const f=fixture();f.send({brandAccess:'single',brand});
 for(const id of ['crm-brand-label','crm-active-brand'])a.equal(f.labels.get(id).textContent,label);
 a.equal(f.labels.get('crm-screen-title').textContent,'Públicos');a.equal(f.context.MARCA,brand);a.equal(f.context.document.body.dataset.marca,brand);
 a.deepEqual(f.counts(),{renders:0,paints:1});a.deepEqual(f.selections.filter(b=>b.classList.ativo).map(b=>b.dataset.marca),[brand]);
});
test('existing data renders once; unsupported or unscoped brand events cannot change visible scope',()=>{
 const f=fixture({});for(const detail of [null,{}, {brandAccess:'multiple',brand:'fish'},{brandAccess:'single',brand:'olivas'},{brandAccess:'single',brand:'todas'}])f.send(detail);
 a.equal(f.context.MARCA,'todas');a.deepEqual(f.counts(),{renders:0,paints:0});
 f.send({brandAccess:'single',brand:'aristo'});a.deepEqual(f.counts(),{renders:1,paints:1});a.equal(f.labels.get('crm-active-brand').textContent,'O Aristocrata');
});
function navigation(section='visao',activeTab='history'){
 const target={classList:{contains:k=>k==='sec'}};
 const context=vm.createContext({document:{getElementById:()=>target,querySelectorAll:()=>[]},PENDENTE_GRAPH:false,SEC:section,API:null,GC:{activeTab,setTab(value){this.activeTab=value;}},ativaBotao(){},salvaPref(){},render(){},gravaHash(){}});
 const start=html.indexOf('function abrirSecaoCRM('),end=html.indexOf("\ndocument.querySelectorAll('#secoes button')",start);a.ok(start>=0&&end>start);vm.runInContext(html.slice(start,end),context);return context;
}
test('Templates sidebar and explicit legacy edit links always open the admitted inventory',()=>{
 for(const previous of ['history','drafts','templates','graph'])for(const tab of [undefined,'drafts','templates']){
  const n=navigation('visao',previous);n.abrirSecaoCRM('templates',{tab});a.equal(n.SEC,'templates');a.equal(n.GC.activeTab,'templates');
 }
 a.match(html,/id="control-tab-drafts" hidden disabled/);a.match(html,/Consulte os modelos, o inventário/);a.doesNotMatch(html,/Crie ou edite modelos, consulte o inventário/);
 // The pre-existing write visibility restrictions remain present.
 a.match(html,/#control-drafts #draft-editor/);a.match(html,/#crm-media \.crm-media-integrated/);
});
test('saved Templates and legacy Automations draft links normalize to the inventory on initial load',()=>{
 const lines=html.split('\n').filter(line=>line.startsWith("if(SEC==='templates')")||line.startsWith("if(SEC==='regua'&&['templates','drafts']"));a.equal(lines.length,2);
 for(const section of ['templates','regua'])for(const previous of ['drafts','templates']){const n=navigation(section,previous);vm.runInContext(lines.join('\n'),n);a.equal(n.SEC,'templates');a.equal(n.GC.activeTab,'templates');}
});
test('the tested presentation is the image payload and its inline script CSP matches',()=>{
 a.equal(html,transformed);a.ok(html.includes('content="'+build.cspFor(html)+'"'));a.equal((html.match(/id="control-tab-drafts"/g)||[]).length,1);
});
test('changed canonical template contracts refuse packaging instead of silently selecting stale UI',()=>{
 a.throws(()=>build.transform(canonical.replace('Crie ou edite modelos, consulte o inventário','Altered library copy'),'growth.html'),/template inventory presentation contract changed/);
 a.equal(build.transform('public static file','unrelated.css'),'public static file');
});
