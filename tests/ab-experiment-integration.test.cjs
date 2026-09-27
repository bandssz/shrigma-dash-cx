'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../growth.html'),'utf8');
const composition=html.slice(html.indexOf('let AB_EXPERIMENT_PANEL=null;'),html.indexOf('function render(){'));
const brandChange=html.slice(html.indexOf('function trocaMarca(next,'),html.indexOf('window.growthChangeBrand=trocaMarca;'));
function fixture(){
 const calls=[],element={hidden:false},notice={textContent:'',hidden:true};let status={},access='manager';
 const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;}},accept={focus(){}},cancel={focus(){}},description={};
 const ctx=vm.createContext({console,API:{},MARCA:'aristo',AB_BUSY:false,AB_WRITE_EPOCH:0,GB:{state:{}},G:{MARCA_CHEIA:{}},
  document:{activeElement:{isConnected:true,focus(){}}},$:s=>({'#ab-experiment-panel':element,'#brand-change-confirm':dialog,'#brand-change-accept':accept,'#brand-change-cancel':cancel,'#brand-change-description':description}[s]||notice),ativaBotao:(s,k,b)=>calls.push(['header',b]),salvaPref:v=>calls.push(['preference',v.marca]),gravaHash:()=>{},pintaMarca:()=>{},render:()=>calls.push(['render']),queueMicrotask:fn=>calls.push(['queued-render',fn]),
  GCE:{contextStatus:()=>({}),preserve:()=>calls.push(['preserve-campaign']),mount:v=>calls.push(['campaign',v.marca])},GRU:{contextStatus:()=>({}),preserve:()=>calls.push(['preserve-template']),render:v=>calls.push(['template',v.marca])},GABF:{contextStatus:()=>({}),preserve:()=>calls.push(['preserve-legacy']),enter:b=>calls.push(['legacy',b])},
  GABExperimentPanel:{ACTIVATION:require('../growth-ab-experiment-panel.js').ACTIVATION,create:opts=>{calls.push(['create',opts]);return {contextStatus:()=>status,render:v=>calls.push(['mount',v.marca])};}},GABExperimentClient:{},GABExperimentUI:{},GCA:{},localStorage:{},navigator:{locks:{}},fetch:()=>{throw Error('OFF must not fetch');},shrigmaChaveOperador:(area,cap)=>{assert.equal(area,'growth');assert.equal(cap,'draft');return access;}});
 vm.runInContext(composition+brandChange,ctx);return {ctx,calls,element,notice,dialog,accept,cancel,setStatus:s=>status=s,setKey:k=>access=k,run:s=>vm.runInContext(s,ctx)};
}
test('shipped Growth composition is strict OFF: hidden container, no new client/network/CTA and ordered modules',()=>{
 const f=fixture();f.run('renderABExperiment()');assert.equal(f.element.hidden,true);assert.equal(f.calls.length,0);assert.match(html,/<div id="ab-experiment-panel" hidden><\/div>/);
 const m=require('../tools/panel-build/manifest.json'),names=['contract','client','ui','panel'].map(s=>'growth-ab-experiment-'+s+'.js');let previous=-1;for(const n of names){const i=m.growth.scripts.indexOf(n);assert.ok(i>previous);previous=i;for(const p of ['index','organico','influs'])assert.equal(m[p].scripts.includes(n),false);}
 const {document}=require('linkedom').parseHTML(html);assert.equal(document.querySelectorAll('#ab-experiment-panel').length,1);assert.equal(document.querySelector('#ab-experiment-panel').closest('[data-crm-campaign-panel]')?.id,'crm-campaign-tests');
});
test('real page composition uses existing manager session and brand guard blocks pending/dirty/confirming A/B',()=>{
 const f=fixture();f.run("GABExperimentPanel.ACTIVATION={enabled:true,endpoint:'https://synthetic.invalid/ab'};renderABExperiment()");const opts=f.calls.find(c=>c[0]==='create')[1];assert.equal(opts.getManagerKey(),'manager');f.setKey('rotated');assert.equal(opts.getManagerKey(),'rotated');
 for(const state of [{blocked:true},{pending:true},{dirty:true}]){f.setStatus(state);assert.equal(f.run("trocaMarca('fish')"),false);assert.equal(f.ctx.MARCA,'aristo');}
 f.setStatus({});assert.equal(f.run("trocaMarca('fish')"),true);assert.equal(f.ctx.MARCA,'fish');
});
test('recovery callback restores original header and all editors only after preserving drafts; active unrelated work blocks it',()=>{
 const f=fixture();f.ctx.GB.state.busy=true;assert.equal(f.run("restoreABExperimentBrand('fish')"),false);assert.equal(f.ctx.MARCA,'aristo');assert.equal(f.calls.length,0);
 f.ctx.GB.state.busy=false;assert.equal(f.run("restoreABExperimentBrand('fish')"),true);assert.equal(f.ctx.MARCA,'fish');assert.deepEqual(f.calls.slice(0,3).map(c=>c[0]),['preserve-campaign','preserve-template','preserve-legacy']);for(const part of ['header','campaign','template','legacy'])assert.ok(f.calls.some(c=>c[0]===part&&c[1]==='fish'));assert.equal(f.calls.at(-1)[0],'queued-render');
});
test('current brand dialog remains cancellable and rechecks A/B state before accepting a switch',()=>{
 const f=fixture();f.run("GABExperimentPanel.ACTIVATION={enabled:true,endpoint:'https://synthetic.invalid/ab'};renderABExperiment()");
 f.ctx.GCE.contextStatus=()=>({dirty:true});assert.equal(f.run("trocaMarca('fish')"),false);assert.equal(f.dialog.open,true);
 assert.equal(f.run("restoreABExperimentBrand('fish')"),false);f.cancel.onclick();assert.equal(f.ctx.MARCA,'aristo');
 assert.equal(f.run("trocaMarca('fish')"),false);f.setStatus({pending:true});f.accept.onclick();assert.equal(f.ctx.MARCA,'aristo');assert.match(f.notice.textContent,/tentativa A\/B/);assert.equal(f.dialog.open,false);
 f.setStatus({});assert.equal(f.run("trocaMarca('fish')"),false);f.accept.onclick();assert.equal(f.ctx.MARCA,'fish');
});
