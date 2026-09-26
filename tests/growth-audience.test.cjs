'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const A=require('../growth-audience.js');
const rule=(marca,galho,rotulo=galho)=>({marca,galho,rotulo});
const snap=(marca,galho,dia,pessoas)=>({marca,galho,dia,pessoas});
test('latest snapshot wins, including a smaller count, zero or an explicitly missing count; brands never join by ID alone',()=>{
 const api={crm_regra_galho:[rule('fish','C1','Clientes'),rule('aristo','C1','Clientes')],crm_galho:[snap('fish','C1','2026-09-01',1000),snap('fish','C1','2026-09-26',12),snap('aristo','C1','2026-09-25',900)]},before=JSON.stringify(api);
 assert.deepEqual(A.rows(api,{brand:'fish'}).map(r=>[r.brand,r.count,r.measuredAt]),[['fish',12,'2026-09-26']]);assert.equal(JSON.stringify(api),before);
 api.crm_galho.push(snap('fish','C1','2026-09-27',0));assert.equal(A.rows(api,{brand:'fish'})[0].count,0);
 api.crm_galho.push(snap('fish','C1','2026-09-28',null));assert.equal(A.rows(api,{brand:'fish'})[0].count,null);
});
test('missing, invalid and tied conflicting counts remain unknown instead of zero or a historical maximum',()=>{
 const api={crm_regra_galho:['none','null','empty','bad','conflict'].map(id=>rule('fish',id)),crm_galho:[snap('fish','null','2026-09-26',null),snap('fish','empty','2026-09-26',''),snap('fish','bad','2026-09-26',-1),snap('fish','conflict','2026-09-26',1),snap('fish','conflict','2026-09-26',2)]};
 const rows=A.rows(api);assert.ok(rows.every(r=>r.count===null));assert.equal(rows.find(r=>r.id==='conflict').reason,'conflicting_snapshot');
 assert.equal(A.rows({crm_regra_galho:[rule('fish','invalid')],crm_galho:[snap('fish','invalid','2026-02-30',10)]})[0].measuredAt,null);
});
test('campaign catalogs contribute real list identities but never fabricate size from unrelated fields or another brand',()=>{
 const catalogs=[{brand:'fish',current:true,lists:[{id:3,brand:'fish',name:'Base Fish',available:true,total:50000},{id:3,brand:'aristo',name:'Wrong brand',available:true}]},{brand:'aristo',current:true,lists:[{id:3,brand:'aristo',name:'Base Aristo',available:true}]},{brand:'olivas',current:false,lists:[{id:4,brand:'olivas',name:'Stale',available:true}]}];
 const rows=A.rows({},{catalogs});assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.key)).size,2);assert.ok(rows.every(r=>r.count===null));assert.deepEqual(A.rows({},{catalogs,brand:'fish'}).map(r=>r.name),['Base Fish']);
});
test('size sorting uses confirmed counts, keeps unknowns last in either direction, and searching ignores accents',()=>{
 const rows=A.rows({crm_regra_galho:[rule('fish','a','Reativação'),rule('fish','b','Boas-vindas'),rule('aristo','c','Alto valor'),rule('aristo','d','Sem medida')],crm_galho:[snap('fish','a','2026-09-26',30),snap('fish','b','2026-09-26',0),snap('aristo','c','2026-09-26',10)]});
 assert.deepEqual(A.sortRows(rows).map(r=>r.count),[30,10,0,null]);assert.deepEqual(A.sortRows(rows,{sort:'size_asc'}).map(r=>r.count),[0,10,30,null]);assert.equal(A.sortRows(rows,{search:'reativacao'}).length,1);assert.equal(A.sortRows(rows,{search:'Aristocrata'}).length,2);assert.deepEqual(rows.map(r=>r.id),['a','b','c','d']);
});
test('date-only snapshots retain their day in Brazil and show the age of the count, not the page refresh',()=>{
 const now=Date.parse('2026-09-26T15:00:00Z');assert.deepEqual(A.freshness({measuredAt:'2026-09-24T00:00:00.000Z'},now),{label:'Contagem de 24/09/2026',age:'Há 2 dias',stale:true});assert.equal(A.freshness({measuredAt:null},now).age,'Sem data de contagem');assert.match(A.freshness({measuredAt:'2026-09-27'},now).age,/Data futura/);
});
test('read-only UI preserves the search/sort controls across refresh and brand change, escapes source names and never sums overlapping audiences',()=>{
 const {document}=parseHTML('<div id="audience"></div>'),element=document.querySelector('#audience');let refreshes=0;
 const api={crm_regra_galho:[rule('fish','a','<img src=x onerror=alert(1)>'),rule('fish','b','Clientes ativos'),rule('aristo','a','Clientes ativos')],crm_galho:[snap('fish','a','2026-09-26',100),snap('fish','b','2026-09-25',40),snap('aristo','a','2026-09-24',5)]};
 const ui=A.mount({element,onRefresh:()=>refreshes++}),now=Date.parse('2026-09-26T15:00:00Z');const initial=ui.update({api,brand:'fish',now});assert.deepEqual(initial,{total:2,visible:2,unknown:0});assert.equal(element.querySelectorAll('img,script').length,0);assert.match(element.querySelector('.ga-note').title,/não são somados/);assert.match(element.textContent,/25\/09\/2026/);
 const input=element.querySelector('[data-ga-search]'),select=element.querySelector('[data-ga-sort]');input.value='ativos';input.oninput({target:input});select.onchange({target:{value:'size_asc'}});ui.update({api,brand:'aristo',now});assert.equal(element.querySelector('[data-ga-search]'),input);assert.equal(element.querySelector('[data-ga-sort]'),select);assert.equal(input.value,'ativos');assert.equal(element.querySelectorAll('[data-ga-row]').length,1);assert.match(element.textContent,/O Aristocrata/);assert.doesNotMatch(element.querySelector('[data-ga-result]').textContent,/Fishermans/);
 element.querySelector('[data-ga-refresh]').onclick();assert.equal(refreshes,1);ui.destroy();assert.equal(input.oninput,null);
});
test('real base contract exposes profile, relationship and purchase-interest groups from the latest collection of each brand',()=>{
 const old={marca:'fish',dia:'2026-09-26',coletado_em:'2026-09-26T14:00:00Z',total:100000,ativos:99999,segmentos:{rfm:{leal:5000},next_best:{X4:3000}}};
 const current={...old,coletado_em:'2026-09-26T16:30:00Z',total:50858,ativos:48691,compradores:22966,recompradores:3412,engajados_90d:9364,novos_dia:30,blocklisted:20,descadastrados:null,segmentos:{rfm:{leal:2508,um_x:11128,campeao:135,dormant:45,um_x_lapsando:8426,needs_attention:90,ex_campeao_at_risk:634},next_best:{X4:200,'(sem)':300}}};
 const aristo={...current,marca:'aristo',total:83281,segmentos:{rfm:{campeao:10},next_best:{'(sem)':83281}}};
 const api={crm_base:[current,aristo,old]},before=JSON.stringify(api),rows=A.rows(api,{brand:'fish'});
 assert.equal(rows.find(r=>r.id==='total').count,50858);assert.equal(rows.find(r=>r.id==='descadastrados').count,null);assert.equal(rows.find(r=>r.id==='leal').count,2508);assert.equal(rows.find(r=>r.id==='X4').name,'Linha X4');assert.equal(rows.find(r=>r.id==='(sem)').name,'Sem sugestão de próxima compra');assert.ok(rows.every(r=>r.measuredAt==='2026-09-26T16:30:00Z'));
 assert.equal(A.sortRows(rows,{group:'rfm'}).length,7);assert.equal(A.sortRows(rows,{group:'profile'}).length,8);assert.equal(A.sortRows(rows,{group:'interest'}).length,2);assert.equal(JSON.stringify(api),before);
 assert.equal(A.rows(api,{brand:'aristo'}).find(r=>r.id==='(sem)').count,83281);
 const time=A.freshness(rows[0],Date.parse('2026-09-26T17:00:00Z'));assert.match(time.label,/13:30 BRT/);assert.equal(time.age,'Há 30 min');assert.equal(time.stale,false);
});
test('new base snapshot with nulls or a missing date never adopts old values; collection age honors the existing 26-hour stop threshold',()=>{
 const first={marca:'fish',dia:'2026-09-25',coletado_em:'2026-09-25T12:00:00Z',total:100,segmentos:{rfm:{campeao:10}}},last={marca:'fish',dia:'2026-09-26',coletado_em:'2026-09-26T12:00:00Z',total:null,segmentos:{rfm:{campeao:null}}};
 const rows=A.rows({crm_base:[first,last]});assert.ok(rows.every(r=>r.count===null));assert.equal(rows.find(r=>r.id==='campeao').measuredAt,last.coletado_em);
 assert.ok(A.rows({crm_base:[{marca:'fish',total:100}]}).every(r=>r.count===null));assert.equal(A.freshness({measuredAt:last.coletado_em,dateOnly:false},Date.parse('2026-09-27T14:01:00Z')).stale,true);
 const midnight=A.freshness({measuredAt:'2026-09-26T00:00:00Z',dateOnly:false},Date.parse('2026-09-26T01:00:00Z'));assert.match(midnight.label,/25\/09\/2026, 21:00 BRT/);
});
test('group filtering keeps its control and selection across live data updates',()=>{
 const {document}=parseHTML('<div id="audience"></div>'),element=document.querySelector('#audience'),ui=A.mount({element});
 const api={crm_base:[{marca:'fish',dia:'2026-09-26',total:12,segmentos:{rfm:{leal:5},next_best:{X4:2}}}]};ui.update({api,brand:'fish'});const group=element.querySelector('[data-ga-group]');group.onchange({target:{value:'rfm'}});assert.equal(element.querySelectorAll('[data-ga-row]').length,1);assert.match(element.querySelector('[data-ga-result]').textContent,/Clientes leais/);ui.update({api,brand:'fish'});assert.equal(element.querySelector('[data-ga-group]'),group);assert.equal(element.querySelectorAll('[data-ga-row]').length,1);
});
test('empty and filtered states distinguish absent data from zero people',()=>{
 const {document}=parseHTML('<div id="audience"></div>'),e=document.querySelector('#audience'),ui=A.mount({element:e});ui.update({api:{},brand:'fish'});assert.match(e.querySelector('[data-ga-result]').textContent,/Nenhum público disponível/);
 ui.update({api:{crm_regra_galho:[rule('fish','a','Ativos')],crm_galho:[snap('fish','a','2026-09-26',0)]},brand:'fish'});assert.equal(e.querySelector('.ga-count span'),null);assert.match(e.querySelector('tbody .ga-count').textContent,/^0$/);
 const input=e.querySelector('[data-ga-search]');input.value='inexistente';input.oninput({target:input});assert.match(e.querySelector('[data-ga-result]').textContent,/Nenhum público corresponde/);
});
test('audience controls avoid global section/attribution classes and unavailable groups; brand changes explain a reset to all',()=>{
 const {document}=parseHTML('<div id="audience"></div>'),e=document.querySelector('#audience'),ui=A.mount({element:e,onRefresh(){}});
 const api={crm_base:[{marca:'fish',dia:'2026-09-26',total:10,segmentos:{rfm:{leal:5},next_best:{'(sem)':3}}},{marca:'aristo',dia:'2026-09-26',total:20,segmentos:{rfm:{leal:4}}}]};
 ui.update({api,brand:'fish'});assert.equal(e.querySelectorAll('.sec,.ga-summary').length,0);assert.ok(e.querySelector('.ga-audience-summary'));assert.ok(e.querySelector('[data-ga-refresh]').classList.contains('refresh-btn'));
 const select=e.querySelector('[data-ga-group]');assert.deepEqual([...select.options].map(o=>o.value),['all','profile','rfm','interest']);assert.match(e.textContent,/Próxima compra sugerida/);assert.match(e.textContent,/Sem sugestão de próxima compra/);assert.doesNotMatch(e.textContent,/Interesse ainda/);
 select.onchange({target:{value:'interest'}});assert.equal(e.querySelectorAll('[data-ga-row]').length,1);
 ui.update({api,brand:'aristo'});assert.equal(e.querySelector('[data-ga-group]'),select);assert.deepEqual([...select.options].map(o=>o.value),['all','profile','rfm']);assert.equal(select.querySelector('option[selected]').value,'all');assert.equal(e.querySelectorAll('[data-ga-row]').length,9);assert.match(e.querySelector('[data-ga-summary]').textContent,/não está disponível.*Exibindo todos os grupos/);
 select.onchange({target:{value:'rfm'}});assert.doesNotMatch(e.querySelector('[data-ga-summary]').textContent,/não está disponível/);assert.equal(e.querySelectorAll('[data-ga-row]').length,1);
});
