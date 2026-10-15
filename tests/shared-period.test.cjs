'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom');
const W=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'))+'/public/read-workspace.js'),P=W.Period;
const at=value=>Date.parse(value),pair=p=>[p.ini,p.fim],previous=p=>pair(p.previous);
test('civil dates stay on their day; timestamps use the Brasilia boundary',()=>{
 a.equal(W.date('2026-10-14'),'2026-10-14');a.equal(W.date('2026-02-30'),'');
 a.equal(P.today(at('2026-10-15T02:59:59Z')),'2026-10-14');a.equal(P.today(at('2026-10-15T03:00:00Z')),'2026-10-15');
});
test('rolling periods are inclusive, adjacent and never overlap their predecessors',()=>{
 for(const [key,n]of [['today',1],['yesterday',1],['last7',7],['last30',30]]){const p=P.resolve(key,at('2026-10-14T15:00:00Z'));a.equal(p.days,n);a.equal(p.previous.days,n);a.equal(W.addDays(p.previous.fim,1),p.ini);a(p.previous.fim<p.ini);}
 a.deepEqual(pair(P.resolve('last7',at('2026-10-14T15:00:00Z'))),['2026-10-08','2026-10-14']);
});
test('weeks run Monday through Sunday, with week-to-date compared to the same weekdays',()=>{
 const w=P.resolve('week',at('2026-10-14T15:00:00Z'));a.deepEqual(pair(w),['2026-10-12','2026-10-14']);a.deepEqual(previous(w),['2026-10-05','2026-10-07']);
 a.deepEqual(pair(P.resolve('lastWeek',at('2026-10-14T15:00:00Z'))),['2026-10-05','2026-10-11']);
 a.equal(P.resolve('week',at('2026-10-18T15:00:00Z')).days,7);a.equal(P.resolve('week',at('2026-10-19T15:00:00Z')).days,1);
});
test('month-to-date clamps the previous month and crosses leap years and year boundaries',()=>{
 for(const [stamp,end]of [['2026-03-31T15:00:00Z','2026-02-28'],['2024-03-31T15:00:00Z','2024-02-29']]){const p=P.resolve('month',at(stamp));a.equal(p.previous.fim,end);a.equal(p.previous.clamped,true);}
 a.deepEqual(previous(P.resolve('month',at('2026-01-14T15:00:00Z'))),['2025-12-01','2025-12-14']);
 const p=P.resolve('lastMonth',at('2026-03-31T15:00:00Z'));a.deepEqual(pair(p),['2026-02-01','2026-02-28']);a.deepEqual(previous(p),['2026-01-01','2026-01-31']);
});
test('custom periods reject invalid calendar days, inversion, overlong windows and unsafe shapes',()=>{
 for(const range of [{ini:'2026-02-30',fim:'2026-03-01'},{ini:'2026-10-15',fim:'2026-10-14'},{ini:'2025-01-01',fim:'2026-01-02'},{ini:'<script>',fim:'2026-10-14'}])a.throws(()=>P.resolve('custom',Date.now(),range));
 a.equal(P.resolve('custom',Date.now(),{ini:'2024-01-01',fim:'2024-12-31'}).days,366);
 a.equal(P.parse('%E0%A4%A'),null);a.equal(P.parse('x'.repeat(513)),null);a.equal(P.parse(JSON.stringify({v:1,preset:'custom',ini:'2026-10-01',fim:'2026-10-07',brand:'aristo'})),null);
});
test('explicit URLs outrank a valid shared cookie; presets roll forward at midnight',()=>{
 const now=at('2026-10-14T15:00:00Z'),cookie=P.COOKIE+'='+encodeURIComponent(JSON.stringify({v:1,preset:'custom',ini:'2026-09-01',fim:'2026-09-30'}));
 a.deepEqual(pair(P.initial({search:'?ini=2026-10-01&fim=2026-10-07',cookie,now})),['2026-10-01','2026-10-07']);
 a.deepEqual(pair(P.initial({cookie,now})),['2026-09-01','2026-09-30']);
 const rolling=P.COOKIE+'='+encodeURIComponent(JSON.stringify({v:1,preset:'today',ini:'2026-10-14',fim:'2026-10-14'}));a.equal(P.readCookie(rolling,at('2026-10-15T03:00:00Z')).fim,'2026-10-15');
 a.equal(P.readCookie(cookie+'; '+cookie,now),null);
});
test('the shared cookie contains dates only and cannot be written outside the project hosts',()=>{
 const doc={},p=P.resolve('last7',at('2026-10-14T15:00:00Z'));a.equal(P.save(doc,{protocol:'https:',hostname:'crm.shrigma.com.br'},p),true);
 a.match(doc.cookie,/Path=\/; Domain=shrigma\.com\.br; Max-Age=31536000; Secure; SameSite=Lax$/);a.doesNotMatch(doc.cookie,/brand|token|user|email|key/i);
 const before=doc.cookie;a.equal(P.save(doc,{protocol:'https:',hostname:'external.invalid'},p),false);a.equal(doc.cookie,before);
 a.equal(P.save(doc,{protocol:'http:',hostname:'crm.shrigma.com.br'},p),false);
});
test('comparisons preserve unknowns and zero bases and show direction without infinity',()=>{
 a.equal(P.change(null,10).available,false);a.equal(P.change(10,null).available,false);a.equal(P.change(10,0).percent,null);a.doesNotMatch(P.change(10,0).text,/Infinity|100%/);
 a.equal(P.change(15,10).text,'↑ 50%');a.equal(P.change(5,10).text,'↓ 50%');a.equal(P.change(10,10).text,'→ 0%');a.equal(P.change(1,1,{ready:false}).text,'Comparando…');
 a.match(P.change(.1,.05,{rate:true}).text,/↑ 5 p\.p\. \(100%\)/);a.equal(P.change(-5,-10).percent,50);
});
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const tick=async()=>{for(let n=0;n<4;n++)await new Promise(setImmediate);};
function dom(html){const {document,window}=parseHTML(html),proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||''},set(value){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(value));}});for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'options',{get:()=>[...select.querySelectorAll('option')]});return {document,window};}
test('an open page refresh advances a dynamic preset after Brasilia midnight, preserving custom dates',()=>{
 const f=dom('<select id="p"></select><input id="i"><input id="f"><button id="a"></button><p id="n"></p>');let now=at('2026-10-15T02:59:59Z');
 const bind=P.bind({document:f.document,location:{search:'?preset=today',protocol:'https:',hostname:'crm.shrigma.com.br'},select:f.document.getElementById('p'),start:f.document.getElementById('i'),end:f.document.getElementById('f'),apply:f.document.getElementById('a'),note:f.document.getElementById('n'),now:()=>now});
 a.equal(bind.get().fim,'2026-10-14');now=at('2026-10-15T03:00:00Z');a.equal(bind.get().fim,'2026-10-14');a.equal(bind.get({refresh:true}).fim,'2026-10-15');a.equal(f.document.getElementById('f').value,'2026-10-15');
 f.document.getElementById('i').value='2026-09-01';f.document.getElementById('f').value='2026-09-03';f.document.getElementById('p').value='custom';bind.apply();now+=86400000;a.deepEqual(pair(bind.get()),['2026-09-01','2026-09-03']);
});
function workspace(){
 const f=dom(fs.readFileSync(runtime+'/public/influs-workspace/index.html','utf8')),pending=[];let identity='one',reads=0,revokeAt=null;
 const session=()=>({authenticated:true,user:{id:identity,brands:['fish','aristo'],permissions:{influs:{read:true}},productFronts:['influs']}});
 const ctx=vm.createContext({window:{ShrigmaReadSession:async()=>{if(++reads===revokeAt)identity='two';return session();}},document:f.document,location:{pathname:'/app/influs/',search:'?brand=fish&preset=last7',protocol:'https:',hostname:'influs.shrigma.com.br'},history:{replaceState(){}},URLSearchParams,Date,Intl,AbortController,getComputedStyle:()=>({getPropertyValue:()=> '#123456'}),fetch:(_url,opts)=>new Promise(resolve=>pending.push({opts,resolve})),Chart:class{destroy(){}}});
 vm.runInContext(fs.readFileSync(runtime+'/public/read-workspace.js','utf8'),ctx);
 const app=ctx.window.ShrigmaReadWorkspace.mount({front:'influs',area:'influs',views:{overview:'Resultados'},required:['roi'],render:({state,el})=>{el('overview-content').textContent='Actual '+state.data.roi[0].value;}});
 const answer=(index,status=200,value=100)=>pending[index].resolve({ok:status===200,status,json:async()=>status===200?{brand:'fish',roi:[{value}]}:{error:'SOURCE_REFUSED'}});
 return {...f,app,pending,answer,revoke(){identity='two';},revokeAfter(n){revokeAt=reads+n;}};
}
test('previous-source failure preserves current figures, while previous authorization refusal erases the entire view',async()=>{
 for(const status of [503,401,403]){const f=workspace();await tick();f.answer(0);await tick();a.equal(f.document.getElementById('overview-content').textContent,'Actual 100');f.answer(1,status);await tick();
  if(status===503){a(f.app.state.data);a.equal(f.app.state.comparisonStatus,'unavailable');a.equal(f.document.getElementById('overview-content').textContent,'Actual 100');}
  else{a.equal(f.app.state.data,null);a.equal(f.app.state.previousData,null);a.equal(f.document.getElementById('overview-content').textContent,'');a.match(f.document.getElementById('error').textContent,/acesso mudou/);}
 }
});
test('identity changes during comparison or a cached refresh cannot retain the former account data',async()=>{
 const f=workspace();await tick();f.answer(0);await tick();f.revoke();f.answer(1);await tick();a.equal(f.app.state.data,null);a.equal(f.document.getElementById('overview-content').textContent,'');
 const g=workspace();await tick();g.answer(0);await tick();g.answer(1);await tick();a.equal(g.pending.length,2);g.revokeAfter(2);await g.app.load();a.equal(g.pending.length,2);a.equal(g.app.state.data,null);a.match(g.document.getElementById('error').textContent,/acesso mudou/);
});
function affiliate(){
 const f=dom(fs.readFileSync(runtime+'/public/afiliados-preview/index.html','utf8')),pending=[],period=P.resolve('custom',at('2026-10-15T03:00:00Z'),{ini:'2026-10-05',fim:'2026-10-11'});
 const ctx=vm.createContext({window:{ShrigmaPeriod:{...P,bind:()=>({get:()=>period,sync(){}})},ShrigmaBrandAccess:{brands:['fish','aristo']},ShrigmaAffiliateAccess:{prepareSelection:async b=>b,ready:async()=>true,read:range=>new Promise((resolve,reject)=>pending.push({range,resolve,reject}))}},document:f.document,location:{pathname:'/app/afiliados/',search:'?brand=fish'},history:{replaceState(){}},URLSearchParams,Date,Intl,AbortController,getComputedStyle:()=>({getPropertyValue:()=> '#123456'}),Chart:class{destroy(){}}});
 vm.runInContext(fs.readFileSync(runtime+'/public/afiliados-preview/app.js','utf8'),ctx);
 const answer=(i,{kpis=[{gmv:100,pedidos:2,criadores:1,comissao:5}],serie=[],canal=[]}={})=>pending[i].resolve({brand:'fish',janela:pending[i].range,kpis,serie,canal,lives:[],videos:[]});
 return {...f,ctx,pending,answer};
}
test('affiliate comparison cannot replace known current KPIs with a previous daily series',async()=>{
 const f=affiliate();await tick();f.answer(0);await tick();f.answer(1,{kpis:[{gmv:999}],serie:[{dia:'2026-10-04',gmv:999}]});await tick();a.equal(vm.runInContext('state.data.kpis[0].gmv',f.ctx),100);a.equal(vm.runInContext('state.fallbackPeriod',f.ctx),null);a.match(f.document.getElementById('affiliate-kpis').textContent,/100,00/);
});
test('affiliate access revocation erases both current and comparison data; a source outage only removes comparison',async()=>{
 for(const [code,status]of [['AFFILIATE_READ_UNAVAILABLE',503],['AFFILIATE_ACCESS_REJECTED',403],['AFFILIATE_BINDING_REPLACED',0]]){const f=affiliate();await tick();f.answer(0);await tick();f.pending[1].reject(Object.assign(Error(code),{code,status}));await tick();
  if(status===503)a.equal(vm.runInContext('state.data.kpis[0].gmv',f.ctx),100);
  else{a.equal(vm.runInContext('state.data',f.ctx),null);a.equal(f.document.getElementById('affiliate-kpis').textContent,'');a.match(f.document.getElementById('error').textContent,/acesso mudou/);}
 }
});
