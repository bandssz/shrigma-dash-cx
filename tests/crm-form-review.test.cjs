'use strict';
// Campanhas — O que vai sair, o que saiu e como foi?
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{parseHTML}=require('linkedom');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),crm=runtime+'/public/crm-preview/',Home=require(crm+'home.js'),Analytics=require(crm+'analytics.js'),appSource=fs.readFileSync(crm+'app.js','utf8'),tick=()=>new Promise(setImmediate),stamp='2026-10-14T11:30:00Z',collectorStamp='2026-10-14T10:05:00Z';
function payload(brand){
 return {brand,brands:[brand],crm_fluxo:[],crm_carrinho:[],crm_familia_campanha:[],crm_campanha:[{marca:brand,campanha_id:77,nome:'Campanha existente '+brand,status:'finished',enviados:12,publico:12}],crm_diario:[{marca:brand,canal:'email',janela:'1d',dia:'2026-10-14',enviados:12}],crm_fontes:[{marca:brand,fonte:'shopify_conversao',coletado_em:'2026-10-14T10:00:00Z'},{marca:brand,fonte:'listmonk_snapshot',coletado_em:'2026-10-14T11:00:00Z'}],crm_collection_receipt:[{brand,source:'legacy_conversion',observed_at:collectorStamp}],crm_attribution:{schema_version:2,generated_at:'2026-10-14T11:30:00Z',coverage:[{brand,day:'2026-10-14',checked_at:'2026-10-14T11:25:00Z'}],daily:[{marca:brand,dia:'2026-10-14',model:'last_click',grain:'channel',dimension:['email'],receita:123.45,pedidos:2}]},_cache_gerado_em:'2026-10-14T12:00:00Z'};
}
function elements(document,window){
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||'';},set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===String(value));}});
 for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'options',{value:[...select.querySelectorAll('option')]});
}
async function workspace(brand,view,{analytics=false,model='last_click'}={}){
 const {window,document}=parseHTML(fs.readFileSync(crm+'index.html','utf8'));elements(document,window);const session={authenticated:true,user:{id:'qa-synthetic',brands:['fish','aristo'],permissions:{growth:{read:true}}}},sources={fish:payload('fish'),aristo:payload('aristo')},calls=[];
 let gate=null,fail=false,period={preset:'custom',ini:'2026-10-14',fim:'2026-10-14'};
 const ui={ShrigmaReadSession:async()=>structuredClone(session),ShrigmaCrmHome:Home,ShrigmaCrmAnalyticsReady:async()=>{if(analytics){ui.ShrigmaCrmAnalytics=Analytics;return;}throw Error('OPTIONAL_ANALYTICS_UNAVAILABLE');},ShrigmaJourneyLabUI:{instance:null,clear(){}},ShrigmaPeriod:{bind:()=>({get:()=>({...period}),sync(){}}),previous:()=>({ini:'2026-10-13',fim:'2026-10-13'}),comparison:()=>''}};
 const context=vm.createContext({window:ui,document,location:{pathname:'/app/crm/',search:'?brand='+brand+'&view='+view+'&model='+model},history:{replaceState(){}},URLSearchParams,AbortController,Date,Intl,fetch:async(url,options)=>{assert.match(url,/^\/api\/crm-read\?/);const scoped=options.headers['X-Shrigma-View-Brand'];calls.push({url,brand:scoped});const captured=structuredClone(sources[scoped]);if(gate){const hold=gate;gate=null;await hold;}if(fail)throw Error('SOURCE_UNAVAILABLE');return {ok:true,status:200,json:async()=>captured};}});
 vm.runInContext(appSource,context);const settle=async()=>{for(let i=0;i<24;i++)await tick();};await settle();
 return {document,window,context,sources,calls,session,settle,chip:()=>document.getElementById(view==='home'?'home-revenue-updated':'campaign-revenue-updated'),reload:()=>document.getElementById('reload').click(),hold:()=>{let done;gate=new Promise(resolve=>done=resolve);return done;},fail:value=>fail=value,period:value=>period=value,brand:value=>{document.getElementById('brand').value=value;document.getElementById('brand').dispatchEvent(new window.Event('change'));}};
}
for(const brand of ['fish','aristo'])for(const view of ['home','campaigns'])test('revenue freshness uses the same attribution snapshot without changing metrics '+brand+' '+view,async()=>{
 const f=await workspace(brand,view),data=f.sources[brand],before=Home.summarize(data,brand,'2026-10-14','2026-10-14'),original=JSON.stringify(data),chip=f.chip();
 assert.equal(f.document.getElementById('error').classList.contains('d-none'),true);assert.equal(chip.dataset.updatedAt,stamp);assert.match(chip.textContent,/Receita atualizada em .*08:30/);assert.doesNotMatch(chip.textContent,/07:05|09:00/);
 data._cache_gerado_em='2026-10-15T20:00:00Z';f.period({preset:'custom',ini:'2026-10-13',fim:'2026-10-14'});f.reload();await f.settle();assert.equal(chip.dataset.updatedAt,stamp);
 const copy=JSON.parse(original);assert.equal(Home.summarize(copy,brand,'2026-10-14','2026-10-14').revenue,before.revenue);assert.equal(Home.summarize(copy,brand,'2026-10-14','2026-10-14').orders,before.orders);
 assert.equal(Home.summarize(data,brand,'2026-10-14','2026-10-14').revenue,123.45);assert.equal(Home.summarize(data,brand,'2026-10-14','2026-10-14').orders,2);
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(x=>x.brand===brand));
});
for(const view of ['home','campaigns'])test('snapshot clock cannot advance from collection, coverage, cache or GET times '+view,async()=>{
 const f=await workspace('fish',view),d=f.sources.fish,chip=f.chip();
 d.crm_fontes.push({marca:'fish',fonte:'shopify_conversao',coletado_em:'2026-10-16T15:00:00Z'},{marca:'aristo',fonte:'shopify_conversao',coletado_em:'2026-10-16T20:00:00Z'});
 d.crm_collection_receipt[0].observed_at='2026-10-16T15:00:00Z';d._cache_gerado_em='2026-10-16T16:00:00Z';
 f.reload();await f.settle();assert.equal(chip.dataset.updatedAt,stamp);assert.equal(d.crm_attribution.coverage[0].checked_at,'2026-10-14T11:25:00Z');
 d.crm_collection_receipt[0].observed_at='2099-01-01T00:00:00Z';f.reload();await f.settle();assert.equal(chip.dataset.updatedAt,stamp);
});
for(const view of ['home','campaigns'])for(const invalid of ['missing','malformed','future','foreign-coverage','no-coverage','foreign-scope','invalid-relation'])test('unconfirmed attribution snapshot stays unavailable despite fresh collector '+view+' '+invalid,async()=>{
 const f=await workspace('fish',view),d=f.sources.fish,chip=f.chip();
 if(invalid==='missing')delete d.crm_attribution.generated_at;
 else if(invalid==='malformed')d.crm_attribution.generated_at='not-a-date';
 else if(invalid==='future')d.crm_attribution.generated_at='2099-01-01T00:00:00Z';
 else if(invalid==='foreign-coverage')d.crm_attribution.coverage[0].brand='aristo';
 else if(invalid==='no-coverage')d.crm_attribution.coverage=[];
 else if(invalid==='foreign-scope'){d.brand='aristo';d.brands=['aristo'];}
 else d.crm_attribution.daily=null;
 d.crm_collection_receipt[0].observed_at='2026-10-16T15:00:00Z';d._cache_gerado_em='2026-10-16T16:00:00Z';
 f.reload();await f.settle();assert.equal(chip.dataset.updatedAt,undefined);assert.equal(chip.textContent,'Receita atualizada em —');assert.match(chip.title,/desde/);
});
for(const view of ['home','campaigns'])for(const change of ['brand','reload','person','logout','failure'])test('freshness clears before waiting and cannot return from a stale source '+view+' '+change,async()=>{
 const f=await workspace('fish',view),chip=f.chip();assert.equal(chip.dataset.updatedAt,stamp);
 const release=f.hold();if(change==='brand')f.brand('aristo');else f.reload();
 assert.equal(chip.dataset.updatedAt,undefined);assert.equal(chip.textContent,'Receita atualizada em —');
 for(let i=0;i<8;i++)await tick();
 if(change==='brand'){f.sources.aristo.crm_attribution.generated_at='2026-10-14T12:10:00Z';f.reload();await f.settle();}
 else if(change==='person')f.session.user.id='another-person';else if(change==='logout')f.session.authenticated=false;else if(change==='failure')f.fail(true);
 release();await f.settle();
 if(change==='brand')assert.equal(chip.dataset.updatedAt,'2026-10-14T12:10:00Z');
 else if(change==='reload')assert.equal(chip.dataset.updatedAt,stamp);
 else {assert.equal(chip.dataset.updatedAt,undefined);assert.equal(chip.textContent,'Receita atualizada em —');}
 assert.equal(f.calls.some(x=>x.url.includes('campanha_nativa_')),false);
});

for(const brand of ['fish','aristo'])for(const model of ['last_click','last_non_direct'])test('campaign analytics retains the chosen model while showing the attribution snapshot clock '+brand+' '+model,async()=>{
 const f=await workspace(brand,'campaigns',{analytics:true,model}),d=f.sources[brand],member={marca:brand,campanha_id:77,nome:'Disparo sintético',familia:'launch',canal:'email',status:'finished',enviado_em:'2026-10-14T12:00:00Z',enviados:100,entregues:80,abriram:40,clicaram:8,utms:[{source:'listmonk',medium:'campanha',campaign:'qa-launch',content:'message',term:''}]};
 d.crm_attribution.campaigns=[member];
 for(const chosen of ['last_click','last_non_direct'])for(const [grain,dimension]of [['campaign',['qa-launch']],['campaign_channel',['qa-launch','email']]])d.crm_attribution.daily.push({marca:brand,dia:'2026-10-14',model:chosen,grain,dimension,receita:chosen==='last_click'?123.45:321.98,pedidos:chosen==='last_click'?2:5,assistidos:0,receita_assistida:0,novos:1,recorrentes:1});
 const original=JSON.stringify(d),before=Analytics.build({[brand]:d},[brand],'2026-10-14','2026-10-14','email',model,{campaignHistory:true});
 f.reload();await f.settle();assert.equal(f.document.getElementById('error').classList.contains('d-none'),true);assert.equal(f.chip().dataset.updatedAt,stamp);
 const revenue=f.document.querySelector('[data-campaign-revenue]'),orders=f.document.querySelector('[data-campaign-orders]');assert.ok(revenue);assert.ok(orders);
 assert.match(revenue.textContent,model==='last_click'?/123,45/:/321,98/);assert.equal(orders.textContent,model==='last_click'?'2':'5');
 assert.equal(vm.runInContext('crmState.model',f.context),model);assert.equal(JSON.stringify(d),original);
 const after=Analytics.build({[brand]:d},[brand],'2026-10-14','2026-10-14','email',model,{campaignHistory:true});assert.deepEqual(after.revenueTotal,before.revenueTotal);assert.deepEqual(after.ordersTotal,before.ordersTotal);
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.brand===brand));
});
