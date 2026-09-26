'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const day='2026-09-15';
function fixture(){return {crm_attribution:{schema_version:2,generated_at:day+'T14:00:00Z',coverage:[{brand:'fish',day,checked_at:day+'T13:00:00Z'}],quality:[{marca:'fish',dia:day,pedidos_lidos:4,pagos_elegiveis:3,pagos_com_ultima_sessao:2,pagos_sem_ultima_sessao:1,jornada_pendente:1,jornada_parcial:1}],daily:[],campaigns:[{marca:'fish',emissor:'fish',canal:'email',campanha_id:1,nome:'Campanha sintética',familia:'fixture',segmentos:['Recorrentes'],status:'finished',enviados:3,enviado_em:day+'T12:00:00Z',utms:[]}],dispatch_evidence:{schema_version:1,checked_at:day+'T13:30:00Z',daily:[]}}};}
function boot(api=fixture(),{brand='fish',channel='email'}={}){
 const {document,window}=parseHTML('<html><body><section id="attribution-campaign-status" hidden></section><section id="attribution-status"></section><section id="attribution-campaigns"></section></body></html>');
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};Object.defineProperty(document,'activeElement',{get:()=>focused||document.body});
 let refreshes=0;const downloads=[],context=vm.createContext({document,window,Date,Intl,__downloads:downloads,__refresh:()=>refreshes++});
 for(const file of ['growth-table.js','growth-ui.js','growth-utm.js','growth-attribution.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context,{filename:file});
 context.input=api;vm.runInContext(`GT.baixar=(name,text)=>__downloads.push({name,text});globalThis.render=()=>GA.render({api:input,marca:${JSON.stringify(brand)},ini:'2026-09-14',fim:'${day}',canal:${JSON.stringify(channel)},GUI,onModel:()=>{},onRefresh:__refresh});`,context);context.render();
 return {document,window,api,downloads,refreshes:()=>refreshes,render:context.render,q:s=>document.querySelector(s)};
}

test('partial coverage and pending journeys stay visible beside history in both brands and Results',()=>{
 for(const brand of ['fish','aristo']){const api=fixture();api.crm_attribution.coverage[0].brand=brand;api.crm_attribution.quality[0].marca=brand;Object.assign(api.crm_attribution.campaigns[0],{marca:brand,emissor:brand});const x=boot(api,{brand});
  assert.equal(x.q('#attribution-campaign-status').hidden,false);assert.match(x.q('#attribution-campaign-status').textContent,/Cobertura parcial/);assert.match(x.q('#attribution-campaign-status').textContent,/1.*2/);assert.match(x.q('#attribution-campaign-status').textContent,/jornada/);assert.match(x.q('#attribution-status').textContent,/Cobertura parcial/);assert.ok(x.q('.ga-campaign'));
 }
});
test('missing attribution is an honest history empty state with a refresh action and no invented zero metrics',()=>{
 for(const brand of ['fish','aristo']){const x=boot({}, {brand});assert.equal(x.q('#attribution-campaign-status').hidden,false);assert.match(x.q('#attribution-campaign-status').textContent,/indisponível/);assert.match(x.q('#attribution-campaigns').textContent,/Histórico indisponível/);assert.match(x.q('#attribution-status').textContent,/ainda não disponível/);assert.equal(x.q('.ga-summary'),null);x.q('[data-attribution-refresh]').click();assert.equal(x.refreshes(),1);}
});
test('a subsequent complete snapshot clears the compact partial warning',()=>{
 const x=boot();x.api.crm_attribution.coverage.push({brand:'fish',day:'2026-09-14',checked_at:day+'T13:00:00Z'});x.api.crm_attribution.quality=[];x.render();assert.doesNotMatch(x.q('#attribution-campaign-status').textContent,/Cobertura parcial|jornada/);assert.equal(x.q('#attribution-campaign-status').hidden,true);assert.equal(x.q('#attribution-campaign-status').textContent,'');assert.match(x.q('#attribution-status').textContent,/Período conciliado/);x.api.crm_attribution.coverage.pop();x.render();assert.equal(x.q('#attribution-campaign-status').hidden,false);
});
