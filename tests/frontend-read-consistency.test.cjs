/* Synthetic responses only. Runs the actual read functions, never a real endpoint. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const slice=(s,a,b)=>{const x=s.indexOf(a),z=s.indexOf(b,x);assert(x>=0&&z>x);return s.slice(x,z);};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=(payload,status=200)=>({status,ok:status>=200&&status<300,json:async()=>payload});
const tick=()=>new Promise(setImmediate),NOW=Date.parse('2026-09-19T18:00:00Z');
const payload=(extra={})=>({gerado_em:'2026-09-19T17:50:00Z',_escopo:'cx',snapshot_1d:[],janelas:[],agentes_1d:[],agentes_janelas:[],...extra});
function cx(fetch){
 const calls=[],timers=new Map(),auth=[],paint=[],el={innerHTML:''};let id=0;
 class FixedDate extends Date {static now(){return NOW;}}
 const ctx=vm.createContext({Date:FixedDate,AbortController,estado:{dados:null},CX_CACHE_URL:'https://example.invalid/cache',CX_API_URL:'https://example.invalid/live',CX_REFRESH_SEG:600,
  chave:()=> 'synthetic&key',pedeChave:x=>auth.push(x),shrigmaEsqueceChave:x=>auth.push(x),shrigmaMarcaMestra:()=>{},pinta:()=>paint.push(ctx.estado.dados),$:()=>el,
  setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:n=>timers.delete(n),
  fetch:(url,init)=>{calls.push({url,init});return fetch(url,init,calls.length);}});
 vm.runInContext(slice(read('app.js'),'const CX_CACHE_MAX_MS','function hojeRef()'),ctx);
 return {ctx,calls,timers,auth,paint,el,run:()=>ctx.carrega()};
}
test('CX fresh valid cache is used once, without live fallback or query-key injection',async()=>{
 const p=payload(),x=cx(async()=>response(p));await x.run();assert.equal(x.calls.length,1);assert.equal(x.ctx.estado.dados,p);
 assert.equal(new URL(x.calls[0].url).searchParams.has('k'),false);assert.equal(x.calls[0].init.headers.Authorization,'Bearer synthetic&key');assert.equal(x.calls[0].init.cache,'no-store');assert.equal(x.timers.size,0);
});
test('CX old, invalid, future or wrong-scope cache falls back to scoped live data',async()=>{
 for(const bad of [payload({gerado_em:'2026-09-19T17:39:59Z'}),payload({gerado_em:'invalid'}),payload({gerado_em:'2026-09-19T19:00:00Z'}),payload({_escopo:'growth'}),{gerado_em:'2026-09-19T17:50:00Z'}]){
  const live=payload({fixture:'live'}),x=cx(async(_,__,n)=>response(n===1?bad:live));await x.run();
  assert.equal(x.calls.length,2);assert.equal(new URL(x.calls[1].url).searchParams.get('painel'),'cx');assert.equal(x.ctx.estado.dados,live);assert.equal(x.timers.size,0);
 }
});
test('CX 401 and 403 do not fall back around authorization',async()=>{
 for(const status of [401,403]){const x=cx(async()=>response(null,status));await x.run();assert.equal(x.calls.length,1);assert.equal(x.ctx.estado.dados,null);assert.equal(x.auth[0],'cx');assert.equal(x.paint.length,0);}
});
test('CX cache timeout falls back; live timeout preserves previous data and releases read lock',async()=>{
 const aborted=(_,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('synthetic timeout')),{once:true}));
 const x=cx(aborted),previous=payload({fixture:'previous'});x.ctx.estado.dados=previous;
 const run=x.run();await x.run();assert.equal(x.calls.length,1,'concurrent timer does not duplicate a read');
 [...x.timers.values()].find(t=>t.ms===8000).fn();await tick();assert.equal(x.calls.length,2);
 [...x.timers.values()].find(t=>t.ms===45000).fn();await run;
 assert.equal(x.ctx.estado.dados,previous);assert.equal(x.paint.length,0);assert.match(x.el.innerHTML,/synthetic timeout/);assert.equal(x.timers.size,0);
 assert.equal(vm.runInContext('CX_CARREGANDO',x.ctx),false);
});
test('CX malformed live payload is rejected without replacing last good data',async()=>{
 const x=cx(async(_,__,n)=>n===1?response(null,503):response({gerado_em:'2026-09-19T18:00:00Z'}));const old=payload();x.ctx.estado.dados=old;
 await x.run();assert.equal(x.ctx.estado.dados,old);assert.equal(x.paint.length,0);assert.match(x.el.innerHTML,/Sem dados agora/);
});
function influ(){
 const calls=[],paints=[],notices=[];
 const ctx=vm.createContext({AbortController,setTimeout,clearTimeout,SEC:'creators',PER:{ini:'2026-09-01',fim:'2026-09-01'},chaveLeitura:()=> 'dummy',avisoTela:(...x)=>notices.push(x),esc:String,
  influPost:body=>{const d=deferred();calls.push({body,...d});return d.promise;},renderTudo:()=>paints.push(vm.runInContext('INFLU',ctx))});
 vm.runInContext(slice(read('influs.html'),'let INFLU=null,','function chaveEscritaInflu()')+slice(read('influs.html'),'async function carregarInflu(){','function renderTudo(){'),ctx);
 return {ctx,calls,paints,notices,run:()=>ctx.carregarInflu(),data:()=>vm.runInContext('INFLU',ctx)};
}
test('Influs newer period wins even if the previous response resolves last',async()=>{
 const x=influ(),a=x.run();x.ctx.PER={ini:'2026-09-19',fim:'2026-09-19'};const b=x.run();
 x.calls[1].resolve({fixture:'new',roi:[],influs:[],cupons:[],custos:[],receita_cupom:[],termos:[],janela:{ini:x.ctx.PER.ini,fim:x.ctx.PER.fim}});await b;x.calls[0].resolve({fixture:'old'});await a;
 assert.equal(x.data().fixture,'new');assert.equal(x.paints.length,1);assert.equal(x.calls[0].body.ini,'2026-09-01');assert.equal(x.calls[1].body.ini,'2026-09-19');
});
test('Influs late failure cannot erase newer success; old data is cleared during period change',async()=>{
 const x=influ(),a=x.run(),b=x.run();x.calls[1].resolve({fixture:'new',roi:[],influs:[],cupons:[],custos:[],receita_cupom:[],termos:[],janela:{ini:x.ctx.PER.ini,fim:x.ctx.PER.fim}});await b;const notices=x.notices.length;
 x.calls[0].reject(Error('old failure'));await a;assert.equal(x.data().fixture,'new');assert.equal(x.notices.length,notices);
 x.ctx.PER={ini:'2026-08-01',fim:'2026-08-01'};const c=x.run();assert.equal(x.data(),null);
 x.calls[2].reject(Error('current failure'));await c;assert.equal(x.data(),null);assert.match(x.notices.at(-1)[1],/current failure/);
});
test('Influs credentials banner requests only its authorized scope',async()=>{
 const calls=[],ctx=vm.createContext({AbortController,setTimeout,clearTimeout,CRED_READ:null,CX_API_URL:'https://example.invalid/read',shrigmaChave:()=> 'synthetic&other=x',shrigmaMarcaMestra:()=>{},shrigmaFrescor:()=>{},window:{},$:()=>({}),
  fetch:async(url,init)=>{calls.push({url,init});return response({crm_credencial:[]});}});
 vm.runInContext(slice(read('influs.html'),'function leituraInfluLimitada(run){','function chaveEscritaInflu()')+slice(read('influs.html'),'async function faixaCredencial(){','faixaCredencial();'),ctx);await ctx.faixaCredencial();
 const url=new URL(calls[0].url);assert.equal(url.searchParams.get('painel'),'influs');assert.equal(url.searchParams.has('k'),false);assert.equal(calls[0].init.headers.Authorization,'Bearer synthetic&other=x');assert.equal(url.searchParams.get('other'),null);
});
const TTS=require('../influs-tts.js');
function tts(initial=null){
 const calls=[],paints=[],notices=[],store=new Map(),forgot=[];
 const ctx=vm.createContext({TTS,TTS_API_URL:'https://example.invalid/read',DADOS:initial,SEQ:0,PER:{ini:'2026-09-19',fim:'2026-09-19'},chaveLeitura:()=> 'dummy',Date,AbortController,setTimeout,clearTimeout,READ_TTS:null,
  CACHE_TTS:initial?{key:'dummy',em:new Date().toISOString(),...initial._periodo,payload:initial}:null,
  per:()=>ctx.PER,renderTTS:()=>paints.push(ctx.DADOS),vazio:(...x)=>notices.push(x),esc:String,shrigmaEsqueceChave:x=>forgot.push(x),
  localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
  fetch:(url,init)=>{const d=deferred();calls.push({body:JSON.parse(init.body),...d});return d.promise;}});
 vm.runInContext(slice(read('influs-tts.js'),'  async function carregarTTS()','  function renderTTS()'),ctx);
 return {ctx,calls,paints,notices,store,forgot,run:()=>ctx.carregarTTS()};
}
const ttsPayload=(fixture,day='2026-09-19')=>({fixture,kpis:[],amostras:[],fila:[],janela:{ini:day,fim:day}});
const prior=()=>({...ttsPayload('old'),_periodo:{ini:'2026-09-19',fim:'2026-09-19'}});
test('TikTok late error cannot restore stale data after a newer success',async()=>{
 const x=tts(prior()),a=x.run(),b=x.run();x.calls[1].resolve(response(ttsPayload('new')));await b;const painted=x.paints.length;x.calls[0].reject(Error('old timeout'));await a;
 assert.equal(x.ctx.DADOS.fixture,'new');assert.equal(x.ctx.DADOS._caiu,null);assert.equal(x.paints.length,painted);
});
test('TikTok success and in-memory cache retain the requested period despite filter changes',async()=>{
 const x=tts(),a=x.run();x.ctx.PER={ini:'2026-09-01',fim:'2026-09-01'};const b=x.run();x.calls[1].resolve(response(ttsPayload('new-period','2026-09-01')));await b;x.calls[0].resolve(response(ttsPayload('old-period')));await a;
 assert.equal(x.ctx.DADOS.fixture,'new-period');const cache=x.ctx.CACHE_TTS;assert.equal(cache.ini,'2026-09-01');assert.equal(cache.payload.janela.ini,cache.ini);assert.equal(x.store.has('shrigma_tts_cache'),false);
});
test('TikTok network failure preserves only data from the same period',async()=>{
 const x=tts(prior()),a=x.run();x.calls[0].reject(Error('offline'));await a;assert.equal(x.ctx.DADOS.fixture,'old');assert.match(x.ctx.DADOS._caiu,/Não foi possível consultar/);
 x.ctx.PER={ini:'2026-08-01',fim:'2026-08-01'};const b=x.run();assert.equal(x.ctx.DADOS,null);x.calls[1].reject(Error('offline'));await b;assert.equal(x.ctx.DADOS,null);assert.match(x.notices.at(-1)[0],/Falha/);
});
test('TikTok authorization refusal clears data and session cache instead of fallback',async()=>{
 for(const status of [401,403]){const x=tts(prior());const a=x.run();x.calls[0].resolve(response(null,status));await a;
  assert.equal(x.ctx.DADOS,null);assert.equal(x.ctx.CACHE_TTS,null);assert.deepEqual(x.forgot,['influs']);assert(x.paints.every(p=>p._cache));assert.match(x.notices.at(-1)[0],/Acesso/);}
});
test('TikTok consolidated freshness flags stale, absent, invalid and failed brands',()=>{
 const fresh={marca:'aristo',ultima_ok:'2026-09-19T17:55:00Z',ultima_ok_todas:true},old={marca:'fish',ultima_ok:'2026-09-15T18:00:00Z',ultima_ok_todas:true};
 assert.equal(TTS.frescor({frescor:[fresh,old]},'aristo',NOW).velho,false);
 const stale=TTS.frescor({frescor:[fresh,old]},'todas',NOW);assert.equal(stale.velho,true);assert.match(stale.txt,/fish há 4 d/);
 for(const rows of [[fresh],[fresh,{...old,ultima_ok:'invalid'}],[fresh,{...old,ultima_ok:'2026-09-20T18:00:00Z'}]]){const f=TTS.frescor({frescor:rows},'todas',NOW);assert.equal(f.velho,true);assert.match(f.txt,/fish sem confirmação/);}
 assert.equal(TTS.frescor({frescor:[fresh,{...fresh,marca:'fish',ultima_ok_todas:false}]},'todas',NOW).velho,true);
 assert.equal(TTS.frescor({frescor:[fresh,{...fresh,marca:'fish'}]},'todas',NOW).velho,false);
});
