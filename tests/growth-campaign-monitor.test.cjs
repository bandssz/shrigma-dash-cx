'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{parseHTML}=require('linkedom');
const M=require('../growth-campaign-monitor.js');
const campaign=(extra={})=>({marca:'fish',canal:'email',campanha_id:1,nome:'Campanha de teste',status:'running',enviados:25,publico:100,enviado_em:'2026-09-29T12:00:00Z',coletado_em:'2026-09-29T12:30:00Z',segmentos:['Recorrentes'],...extra});
const input=(campaigns,extra={})=>({api:{crm_attribution:{schema_version:2,generated_at:'2026-09-29T12:35:00Z',campaigns}},marca:'fish',canal:'email',ini:'2026-09-29',fim:'2026-09-29',...extra});
function boot(value){const {window,document}=parseHTML('<html><body><section id="campaign-monitor"></section></body></html>'),context=vm.createContext({window,document,Intl,Date});vm.runInContext(fs.readFileSync(path.join(__dirname,'../growth-campaign-monitor.js'),'utf8'),context);context.input=value;vm.runInContext('globalThis.render=()=>GCM.render(input)',context);context.render();return {window,document,render:context.render,input:value,q:s=>document.querySelector(s)};}
test('ongoing, scheduled and paused campaigns are not hidden by the purchase period; history follows the send date in Brasilia',()=>{
 const list=[campaign(),campaign({campanha_id:2,status:'scheduled',enviados:0,agendado_em:'2026-10-05T12:00:00Z'}),campaign({campanha_id:3,status:'paused',enviado_em:'2026-09-01T12:00:00Z'}),campaign({campanha_id:4,status:'finished',enviado_em:'2026-09-29T01:00:00Z'}),campaign({campanha_id:5,status:'finished',enviado_em:'2026-09-29T04:00:00Z'}),campaign({campanha_id:6,status:'cancelled',enviado_em:'2026-09-01T12:00:00Z'})];
 const v=M.model(input(list));assert.deepEqual(v.rows.map(m=>m.campanha_id),[1,3,2,5]);assert.deepEqual(v.counts,{all:4,running:1,scheduled:1,finished:1,other:1});assert.equal(M.model(input(list,{filter:'finished'})).rows[0].campanha_id,5);
});
test('progress uses sent / total, never total as remaining, and refuses unknown or incoherent counters',()=>{
 assert.equal(M.model(input([campaign()])).rows[0].progress,25);
 for(const fields of [{publico:0},{publico:null},{enviados:null},{enviados:''},{enviados:101},{enviados:-1},{enviados:Infinity},{enviados:0.5},{enviados:true},{publico:'invalid'},{status:'finished'},{status:'paused'}])assert.equal(M.model(input([campaign(fields)])).rows[0].progress,null,JSON.stringify(fields));
 assert.equal(M.model(input([campaign({enviados:'0',publico:'100'})])).rows[0].progress,0);
 const x=boot(input([campaign({status:'finished'})]));assert.equal(x.q('progress'),null);assert.match(x.q('#gcm-list').textContent,/Envio encerrado/);assert.doesNotMatch(x.q('#gcm-list').textContent,/100%/);
});
test('visual summary counts real states from the same scoped snapshot and does not follow search or status filters',()=>{
 const list=[campaign(),campaign({campanha_id:2,status:'scheduled',agendado_em:'2026-10-05T12:00:00Z'}),campaign({campanha_id:3,status:'finished'}),campaign({campanha_id:4,status:'paused'}),campaign({campanha_id:5,status:'paused',marca:'aristo'})];
 const summary=M.model(input(list,{search:'sem correspondência',filter:'finished'})).summary;
 assert.deepEqual(summary,{running:1,scheduled:1,finished:1,paused:1});
 const x=boot(input(list));
 assert.deepEqual([...x.document.querySelectorAll('.gcm-summary-card strong')].map(node=>node.textContent),['1','1','1','1']);
 assert.match(x.q('[data-summary-status="finished"] small').textContent,/no período/);
});
test('summary never presents zero when the source is unavailable or the selected channel is not covered',()=>{
 const value=input([campaign()]),x=boot(value);value.api={};x.render();
 assert.deepEqual([...x.document.querySelectorAll('.gcm-summary-card strong')].map(node=>node.textContent),['—','—','—','—']);
 assert.match(x.q('.gcm-summary').textContent,/Fonte indisponível/);
 value.api=input([campaign()]).api;value.canal='whatsapp';x.render();
 assert.deepEqual([...x.document.querySelectorAll('.gcm-summary-card strong')].map(node=>node.textContent),['—','—','—','—']);
 assert.match(x.q('.gcm-summary').textContent,/Somente para campanhas de e-mail/);
});
test('brand, email channel, unknown status and missing source never inherit another source or imply a completed send',()=>{
 const v=input([campaign(),campaign({marca:'aristo',campanha_id:2}),campaign({canal:'whatsapp',campanha_id:3}),campaign({status:'unrecognized',campanha_id:4})]);assert.deepEqual(M.model(v).rows.map(m=>m.campanha_id),[1,4]);assert.equal(M.model({...v,canal:'whatsapp'}).rows.length,0);
 const x=boot(v);assert.match(x.q('#gcm-list').textContent,/Situação não informada/);assert.equal(x.document.querySelectorAll('.gcm-row').length,2);
 v.api={};x.render();assert.match(x.q('#gcm-list').textContent,/não está disponível/);assert.equal(x.q('.gcm-row'),null);
});
test('snapshot refresh keeps the search input node, filter and expanded detail; stale failure is explicit and does not start polling',async()=>{
 let reads=0;const v=input([campaign(),campaign({status:'finished',campanha_id:2,nome:'Outra'})],{onRefresh:async()=>{reads++;}}),x=boot(v),search=x.q('#gcm-search');
 search.value='recorrentes';search.dispatchEvent(new x.window.Event('input'));x.q('[data-gcm-filter="running"]').click();x.q('.gcm-detail').open=true;v.api.crm_attribution.campaigns[0].enviados=50;v.consulta={falhou:true};x.render();
 assert.equal(x.q('#gcm-search'),search);assert.equal(search.value,'recorrentes');assert.equal(x.q('[data-gcm-filter="running"]').getAttribute('aria-pressed'),'true');assert.equal(x.q('.gcm-detail').open,true);assert.equal(x.q('progress').getAttribute('value'),'50');assert.match(x.q('#gcm-freshness').textContent,/última atualização falhou/);assert.equal(reads,0);
 x.q('#gcm-refresh').click();x.q('#gcm-refresh').click();await new Promise(r=>setImmediate(r));assert.equal(reads,1);
 v.marca='aristo';x.render();assert.equal(search.value,'');assert.equal(x.q('.gcm-row'),null);
});
test('search and pagination operate only on the selected brand and untrusted names cannot create HTML',()=>{
 const v=input(Array.from({length:35},(_,i)=>campaign({campanha_id:i+1,nome:i===0?'<img src=x onerror=bad>':'Envio '+i}))),x=boot(v);assert.equal(x.document.querySelectorAll('.gcm-row').length,30);assert.equal(x.q('#gcm-more').hidden,false);assert.equal(x.q('img'),null);x.q('#gcm-more').click();assert.equal(x.document.querySelectorAll('.gcm-row').length,35);
 const search=x.q('#gcm-search');search.value='sem correspondência';search.dispatchEvent(new x.window.Event('input'));assert.equal(x.q('.gcm-row'),null);assert.match(x.q('#gcm-count').textContent,/0 de 0/);
});
test('the manager page exposes campaign activity before the collapsed preparation and propagates read failures',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../growth.html'),'utf8'),{document}=parseHTML(source),monitor=document.getElementById('campaign-monitor');assert.ok(monitor);assert.equal(monitor.closest('[data-crm-owner-only]'),null);assert.equal(monitor.nextElementSibling.id,'campaign-composer');assert.match(source,/GCM.render\(\{api:API,marca:MARCA,ini:PER.ini,fim:PER.fim,canal:CANAL,consulta:CONSULTA,onRefresh:carregar\}\)/);
});
