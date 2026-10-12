'use strict';
// Actual panel loading function with synthetic adapter and DOM; no network/provider.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../influs-tts.js'),'utf8');
const start=source.indexOf('  async function carregarTTS() {'),end=source.indexOf('\n  function renderTTS()',start);
assert(start>0&&end>start);const loader=source.slice(start,end);
const period={ini:'2026-10-01',fim:'2026-10-12'};
function fixture({brand='aristo',ready=true,read,onReady,prepare}={}){
 const f={calls:[],paints:[],messages:[],network:0,retries:0,ref:'synthetic-ui-reference',rejected:0};
 const scope={SEQ:0,READ_TTS:null,CACHE_TTS:null,DADOS:null,PRODUCT_FRONT:{id:'afiliados'},MARCA:'todas',TTS_API_URL:'/api/tts',
  per:()=>period,marcaAtual:()=>scope.MARCA,esc:x=>String(x),setTimeout,clearTimeout,AbortController,Promise,
  vazio:(title,detail)=>f.messages.push({title,detail}),renderTTS:()=>f.paints.push(scope.DADOS),
  document:{querySelectorAll:()=>[]},pintaMarca(){},chavePainelTTS:()=>f.ref,
  TTS:{MARCAS:['fish','aristo'],cacheServe:c=>!!c},PainelRede:{ler:()=>{f.retries++;throw Error('Legacy retry not permitted');}},
  fetch:()=>{f.network++;throw Error('Legacy source not permitted');},window:{}};
 scope.window.ShrigmaAffiliateAccess={prepareSelection:async(requested,options)=>{f.calls.push(['selection',requested,options.signal]);return prepare?prepare(f,scope,options.signal):brand;},ready:async(selected,options)=>{f.calls.push(['ready',selected,options.signal]);if(onReady)onReady(f,scope);return ready;},current:()=>f.ref,reject:()=>{f.rejected++;f.ref='';},read:async(p,options)=>{f.calls.push(['read',p,options.signal]);return read?read(f,scope):{brand,brands:[brand],brandAccess:'single',janela:period,kpis:[],amostras:[],fila:[],frescor:[]};}};
 const context=vm.createContext(scope);new vm.Script(loader+'\nglobalThis.load=carregarTTS;').runInContext(context);f.scope=scope;f.load=()=>scope.load();return f;
}
test('first load resolves actual manager brand and uses only own session reader',async()=>{const f=fixture();await f.load();assert.equal(f.scope.MARCA,'aristo');assert.deepEqual(f.calls.map(c=>c[0]),['selection','ready','read']);assert.equal(f.paints.length,1);assert.equal(f.paints[0].brand,'aristo');assert.equal(f.network,0);assert.equal(f.retries,0);});
test('unchanged source refresh retains a valid cache before fresh read',async()=>{const f=fixture();await f.load();const cache=f.scope.CACHE_TTS;await f.load();assert.equal(f.paints.length,3);assert.equal(f.paints[1].brand,'aristo');assert.notEqual(f.scope.CACHE_TTS,cache);assert.equal(f.retries,0);});
test('missing own binding does no data query and does not display a successful zero',async()=>{const f=fixture({ready:false});await f.load();assert.equal(f.calls.filter(c=>c[0]==='read').length,0);assert.equal(f.paints.length,0);assert.equal(f.scope.DADOS,null);assert.match(f.messages.at(-1).title,/não liberada/);});
test('provider failure never retries automatically or invents data',async()=>{const f=fixture({read:()=>{throw Object.assign(new Error('Synthetic source unavailable'),{status:503});}});await f.load();assert.equal(f.calls.filter(c=>c[0]==='read').length,1);assert.equal(f.paints.length,0);assert.equal(f.scope.DADOS,null);assert.equal(f.scope.CACHE_TTS,null);assert.equal(f.retries,0);});
test('a later brand selection discards a pending old response',async()=>{const f=fixture({read:(f,s)=>{s.MARCA='fish';return{brand:'aristo',janela:period,kpis:[],amostras:[],fila:[]};}});await f.load();assert.equal(f.paints.length,0);assert.equal(f.scope.CACHE_TTS,null);assert.equal(f.scope.DADOS,null);});
test('own auth rejection closes the same binding, without invoking Creators access',async()=>{const f=fixture({read:()=>{throw Object.assign(new Error('Synthetic rejection'),{status:403});}});await f.load();assert.equal(f.rejected,1);assert.equal(f.paints.length,0);assert.equal(f.scope.DADOS,null);assert.equal(f.network,0);});
test('new ready supersedes pending old load before its source query',async()=>{const f=fixture({onReady:(_,s)=>{s.SEQ++;}});await f.load();assert.equal(f.calls.filter(c=>c[0]==='read').length,0);assert.equal(f.paints.length,0);});
test('Afiliados thumbnail loader cannot borrow a session reference for cobranca',()=>{
 const start=source.indexOf('  async function carregarProdutosTTS() {'),end=source.indexOf('\n  const produtoTTS',start);const fn=source.slice(start,end);
 const scope={PRODUCT_FRONT:{id:'afiliados'},fetch:()=>{throw Error('No thumbnail contract');},PRODUTOS_TTS:null,PRODUTOS_CHAVE:null,PRODUTOS_BUSY:false};
 const context=vm.createContext(scope);new vm.Script(fn+'\nglobalThis.load=carregarProdutosTTS;').runInContext(context);return assert.doesNotReject(scope.load());
});

test('session selection, availability and source share the same parent cancel/budget signal',async()=>{const f=fixture();await f.load();const signals=f.calls.map(c=>c[2]);assert.equal(signals.length,3);assert(signals[0] instanceof AbortSignal);assert(signals.every(s=>s===signals[0]));});
test('an early selection can be cancelled before readiness or business query',async()=>{const f=fixture({prepare:(_,s,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Cancelled synthetic preflight')),{once:true}))});const work=f.load();assert(f.scope.READ_TTS);f.scope.READ_TTS.cancel();await work;assert.equal(f.calls.filter(c=>c[0]==='ready'||c[0]==='read').length,0);assert.equal(f.scope.READ_TTS,null);assert.equal(f.scope.DADOS,null);});
test('legacy loader remains independent of the Afiliados brand helper and keeps its original reader',async()=>{
 const f=fixture(),s=f.scope;delete s.PRODUCT_FRONT;delete s.marcaAtual;
 s.chaveLeitura=()=> 'synthetic-legacy-reader';s.INFLU_ACCESS={current:s.chaveLeitura,reject:()=>{throw Error('Unexpected legacy rejection');}};
 s.PainelRede={ler:fn=>fn()};s.fetch=async()=>{f.network++;return{status:200,ok:true,json:async()=>({janela:period,kpis:[{marca:'fish',gmv:125}],amostras:[],fila:[],regra_contrato:'atomic_v1'})};};
 await f.load();assert.equal(f.network,1);assert.equal(f.calls.length,0);assert.equal(f.paints.length,1);assert.equal(s.DADOS.kpis[0].gmv,125);assert.equal(s.READ_TTS,null);
});
