'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../services/dashboard-operational/public/crm-preview/app.js'),'utf8');
function render(change={},segment={id:'synthetic-public',version:2}){
 const count={source_confirmed:true,version:2,catalogHash:'synthetic-catalog',eligible_count:0,checked_at:'2026-10-21T15:00:00Z',...change},context={crmState:{audienceCounts:{'synthetic-public':count},audiences:{catalog:{catalog_hash:'synthetic-catalog'}}},crmEsc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),crmNumber:n=>String(n),crmFreshness:()=> 'Atualizado há 30 min',Date:class extends Date{static now(){return Date.parse('2026-10-21T15:30:00Z');}}};
 vm.createContext(context);const when=source.match(/^function crmShortWhen\(value\).*$/m)?.[0],cell=source.match(/function crmCountCell\(s\)\{[\s\S]*?\n\}/)?.[0];a(when&&cell);vm.runInContext(when+'\n'+cell+'\nglobalThis.render=crmCountCell;',context);return context.render(segment);
}
test('confirmed zero is visibly a statistic with its own date and Brasilia time',()=>{const html=render();a.match(html,/>0<\/strong>/);a.match(html,/Estatística · 21\/10\/2026,? 12:00/);});
test('old last count keeps its original time instead of looking current',()=>{const html=render({eligible_count:27,checked_at:'2026-10-19T12:15:00Z'});a.match(html,/>27<\/strong>/);a.match(html,/Estatística · 19\/10\/2026,? 09:15/);});
test('unconfirmed, missing timestamp or invalid amount never becomes zero',()=>{for(const change of [{source_confirmed:false},{checked_at:null},{checked_at:'invalid'},{checked_at:'2099-01-01T00:00:00Z'},{eligible_count:null},{eligible_count:-1}]){const html=render(change);a.match(html,/>—</);a.doesNotMatch(html,/<strong|Estatística/);}});
test('a changed definition or catalog cannot reuse the old statistic',()=>{for(const change of [{version:1},{catalogHash:'different-catalog'}])a.match(render(change),/>—</);});
test('busy or unavailable remains a dash with an actionable title',()=>{a.match(render({source_confirmed:false,busy:true}),/Contagem em andamento/);a.match(render({source_confirmed:false,error:'Contagem indisponível. Atualize.'}),/Contagem indisponível\. Atualize\./);});
