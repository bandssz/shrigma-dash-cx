'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const html=fs.readFileSync(require.resolve('../influs.html'),'utf8');
function fixture(source=html){
 const {document,window}=parseHTML(source),reads=[];
 const state={document,window,SEC:'creators',MARCA:'todas',PER:{ini:'2026-09-01',fim:'2026-09-20'},$:s=>document.querySelector(s),
  carregarInflu:()=>{reads.push({area:'creators',...state.PER});return Promise.resolve();},
  carregarTTS:()=>{reads.push({area:'tiktok',...state.PER});return Promise.resolve();},
  faixaCredencial:()=>{reads.push({area:'health'});return Promise.resolve();},
  preset:()=>({ini:'2026-09-14',fim:'2026-09-20'}),pintaMarca(){},renderTudo(){},salvarInflu(){}};
 state.window.carregarTTS=state.carregarTTS;
 const context=vm.createContext(state);
 const helper=source.indexOf('async function carregarAbaAtiva(){');
 if(helper>=0)vm.runInContext(source.slice(helper,source.indexOf('\ndocument.querySelectorAll',helper)),context);
 const start=source.indexOf("$('#d-ini').value=PER.ini;$('#d-fim').value=PER.fim;\ndocument.querySelectorAll('#presets button')");
 assert(start>0);vm.runInContext(source.slice(start,source.lastIndexOf('</script>')),context);
 return {state,reads,document,context,$:s=>document.querySelector(s),
  select:s=>document.querySelector(`#secoes [data-s="${s}"]`).click(),
  // Afiliados agora tem canais: abrir a seção cai em Parceiros, e o TikTok só é lido quando escolhido.
  canal:c=>document.querySelector(`#canais [data-c="${c}"]`).click(),
  range:(a,b)=>{state.$('#d-ini').value=a;state.$('#d-fim').value=b;state.$('#d-fim').onchange();},
  async login(){const body=source.match(/onRead:async\(\)=>\{(.*?)\}\}\);/s)?.[1];assert(body);await vm.runInContext('(async()=>{'+body+'})()',context);}};
}
test('initial load and period change query only Creators; opening TikTok reads the current range',()=>{
 const p=fixture();assert.deepEqual(p.reads.map(x=>x.area),['creators']);
 p.range('2026-08-01','2026-08-31');assert.deepEqual(p.reads.map(x=>x.area),['creators','creators']);
 p.select('afil');assert.deepEqual(p.reads.at(-1),{area:'creators',ini:'2026-08-01',fim:'2026-08-31'},'Afiliados abre em Parceiros, que usa a leitura de creators');
 p.canal('tiktok');assert.deepEqual(p.reads.at(-1),{area:'tiktok',ini:'2026-08-01',fim:'2026-08-31'});
 const n=p.reads.length;p.select('afil');assert.equal(p.reads.length,n,'clicking the selected tab does not duplicate a request');
 p.canal('tiktok');assert.equal(p.reads.length,n,'clicar no canal já aberto também não duplica');
 p.$('#presets button[data-p="7"]').click();assert.deepEqual(p.reads.at(-1),{area:'tiktok',ini:'2026-09-14',fim:'2026-09-20'});
 p.select('creators');assert.deepEqual(p.reads.at(-1),{area:'creators',ini:'2026-09-14',fim:'2026-09-20'});
});
test('replacing read access refreshes only the visible domain and the shared health strip',async()=>{
 const p=fixture();p.reads.length=0;await p.login();assert.deepEqual(p.reads.map(x=>x.area),['creators','health']);
 p.select('afil');p.canal('tiktok');p.reads.length=0;await p.login();assert.deepEqual(p.reads.map(x=>x.area),['tiktok','health']);
});
test('invalid dates do not query; rapid tab switching uses the newest chosen period',()=>{
 const p=fixture();p.reads.length=0;p.range('2026-09-20','2026-09-01');assert.equal(p.reads.length,0);
 p.range('2026-07-01','2026-07-31');p.select('afil');p.canal('tiktok');p.range('2026-08-01','2026-08-31');p.select('creators');
 assert.deepEqual(p.reads.map(x=>[x.area,x.ini]),[['creators','2026-07-01'],['creators','2026-07-01'],['tiktok','2026-07-01'],['tiktok','2026-08-01'],['creators','2026-08-01']]);
});
test('an unavailable hidden TikTok loader cannot prevent Creators period selection',()=>{
 const p=fixture();p.state.window.carregarTTS=undefined;p.reads.length=0;p.range('2026-08-01','2026-08-31');
 assert.deepEqual(p.reads.map(x=>x.area),['creators']);p.select('afil');p.canal('tiktok');assert.deepEqual(p.reads.map(x=>x.area),['creators','creators'],'sem o carregador do TikTok, o canal de Parceiros continua respondendo');
});
test('own affiliate UI sends one edit, survives uncertainty and reads only the original receipt on explicit click',async()=>{
 const {document}=parseHTML(html),calls=[],id='10000000-0000-4000-8000-000000000001',rid='20000000-0000-4000-8000-000000000001';let pending=false,confirmed=false,release;
 const data=()=>({schema:'shrigma-own-affiliates-read-v1',brand:'fish',janela:{ini:'2026-10-01',fim:'2026-10-12'},programs:[],links:[],candidates:[{id,name:'Synthetic affiliate',handle:'',state:confirmed?'em_analise':'novo',version:confirmed?2:1}],editAvailable:true,pendingEdits:pending?[{candidate_id:id,request_id:rid,state:'uncertain'}]:[]});
 const state={document,SEC:'afil',CANAL:'parceiros',MARCA:'fish',PER:{ini:'2026-10-01',fim:'2026-10-12'},PRODUCT_FRONT:{id:'afiliados'},$:s=>document.querySelector(s),AbortController,URLSearchParams,crypto:{randomUUID:()=>rid},carregarAbaAtiva:()=>{},ShrigmaSimpleRead:true,ShrigmaOwnAffiliates:require('../afiliados-proprios.js')};state.window=state;
 state.fetch=async(url,options={})=>{calls.push({url,method:options.method||'GET',body:options.body&&JSON.parse(options.body)});if(url==='/api/affiliate-own-edit'){await new Promise(r=>{release=r;});pending=true;return {status:202,json:async()=>({state:'uncertain'})};}if(url.startsWith('/api/affiliate-own-operation?')){confirmed=true;pending=false;return {status:200,json:async()=>({state:'confirmed'})};}return {ok:true,json:async()=>data()};};
 const ctx=vm.createContext(state),start=html.indexOf('let OWN_AFFILIATE_SEQ=0'),end=html.indexOf('// Root injeta explicitamente gateway',start);vm.runInContext(html.slice(start,end),ctx);await vm.runInContext('carregarAfiliadosProprios()',ctx);
 const button=document.querySelector('[data-own-affiliate-review]');button.click();button.click();assert.equal(calls.filter(c=>c.url==='/api/affiliate-own-edit').length,1);release();for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 assert.equal(calls.filter(c=>c.url.startsWith('/api/affiliate-own-operation?')).length,0);assert.equal(document.querySelector('[data-own-affiliate-review]'),null);const receipt=document.querySelector('[data-own-affiliate-operation]');assert(receipt);receipt.click();for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 const query=calls.find(c=>c.url.startsWith('/api/affiliate-own-operation?'));assert.equal(query.method,'GET');assert.equal(new URLSearchParams(query.url.split('?')[1]).get('request_id'),rid);assert.equal(calls.filter(c=>c.url==='/api/affiliate-own-edit').length,1);assert.match(document.querySelector('#area-partners').textContent,/Tentativa confirmada/);
});
test('a late own affiliate read cannot paint another selected brand',async()=>{
 const {document}=parseHTML(html);let release;const state={document,SEC:'afil',CANAL:'parceiros',MARCA:'fish',PER:{ini:'2026-10-01',fim:'2026-10-12'},PRODUCT_FRONT:{id:'afiliados'},$:s=>document.querySelector(s),AbortController,URLSearchParams,ShrigmaSimpleRead:true,ShrigmaOwnAffiliates:require('../afiliados-proprios.js')};state.window=state;
 state.fetch=()=>new Promise(r=>{release=r;});const ctx=vm.createContext(state),start=html.indexOf('let OWN_AFFILIATE_SEQ=0');vm.runInContext(html.slice(start,html.indexOf('// Root injeta explicitamente gateway',start)),ctx);const p=vm.runInContext('carregarAfiliadosProprios()',ctx);state.MARCA='aristo';
 release({ok:true,json:async()=>({schema:'shrigma-own-affiliates-read-v1',brand:'fish',janela:{...state.PER},programs:[],links:[],candidates:[{id:'synthetic',name:'Foreign stale person'}]})});await p;assert(!document.querySelector('#area-partners').textContent.includes('Foreign stale person'));
});
