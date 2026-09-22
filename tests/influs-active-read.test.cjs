'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const html=fs.readFileSync(require.resolve('../influs.html'),'utf8');
function fixture(source=html){
 const {document}=parseHTML(source),reads=[];
 const state={document,window:{},SEC:'creators',MARCA:'todas',PER:{ini:'2026-09-01',fim:'2026-09-20'},$:s=>document.querySelector(s),
  carregarInflu:()=>{reads.push({area:'creators',...state.PER});return Promise.resolve();},
  carregarTTS:()=>{reads.push({area:'tiktok',...state.PER});return Promise.resolve();},
  faixaCredencial:()=>{reads.push({area:'health'});return Promise.resolve();},
  preset:()=>({ini:'2026-09-14',fim:'2026-09-20'}),pintaMarca(){},renderTudo(){},salvarInflu(){}};
 state.window.carregarTTS=state.carregarTTS;
 const context=vm.createContext(state);
 const helper=source.indexOf('function carregarAbaAtiva(){');
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
