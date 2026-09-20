'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),TTS=require('../influs-tts.js');
const source=fs.readFileSync(require.resolve('../influs-tts.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const data=(ini='2026-09-01',fim='2026-09-20')=>({janela:{ini,fim},kpis:[{marca:'fish',gmv:125}],amostras:[],fila:[],regra_contrato:'atomic_v1'});
const response=(body,status=200)=>({status,ok:status===200,json:async()=>body});
function page(code=source){
 const {document}=parseHTML('<html><body><div id="tts-frescor"></div><div id="tts-autorizacao">old access</div><div id="tts-aviso">old warning</div><nav id="tts-abas"><span class="n">99</span></nav><div id="tts-kpis"></div><div id="tts-area"></div></body></html>');
 const stored=new Map([['shrigma_tts_cache',JSON.stringify({em:new Date().toISOString(),ini:'2026-09-01',fim:'2026-09-20',payload:data()})],['shrigma_tts_manual_v1:pending','uncertain-reservation']]);
 const calls=[],paints=[],rejected=[],writes=[],timers=new Map();let key='reader-a',clock=0;
 const ctx=vm.createContext({window:{},document,TTS,DADOS:null,SEQ:0,CACHE_TTS:null,READ_TTS:null,PER:{ini:'2026-09-01',fim:'2026-09-20'},AbortController,
  TTS_API_URL:'https://example.invalid/tiktok',Date,INFLU_ACCESS:{current:()=>key,reject:(role,k)=>{rejected.push({role,key:k});if(k===key)key='';}},
  chaveLeitura:()=>key,per:()=>ctx.PER,$:s=>document.querySelector(s),esc:x=>String(x).replace(/</g,'&lt;'),
  localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>{writes.push(k);stored.set(k,v);},removeItem:k=>stored.delete(k)},
  setTimeout:(fn,ms)=>{const id=++clock;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  fetch:(url,init)=>new Promise((resolve,reject)=>calls.push({url,init,resolve,reject})),
  renderTTS:()=>paints.push({data:ctx.DADOS,editable:TTS.regrasEditaveis(ctx.DADOS)})});
 const legacyCleanup=code.slice(0,code.indexOf('  async function carregarTTS()')).match(/try \{ localStorage\.removeItem\('shrigma_tts_cache'\); \} catch \(_\) \{\}/);
 if(legacyCleanup)vm.runInContext(legacyCleanup[0],ctx);
 const start=code.indexOf('  function vazio('),end=code.indexOf('  function renderTTS()',start);
 assert(start>=0&&end>start);vm.runInContext(code.slice(start,end),ctx);
 return {ctx,document,calls,paints,rejected,stored,writes,timers,load:()=>ctx.carregarTTS(),key:v=>{key=v;},
  async good(payload=data()){const p=ctx.carregarTTS();calls.at(-1).resolve(response(payload));await p;},
  timeout(){const entry=[...timers.values()][0];assert(entry,'a stalled read must have a deadline');assert.equal(entry.ms,20000);entry.fn();}};
}
test('never paints a legacy persistent cache before authorization; only that data cache is retired',async()=>{
 const p=page(),pending=p.load();assert.equal(p.paints.length,0);assert.equal(p.ctx.DADOS,null);
 assert.equal(p.stored.has('shrigma_tts_cache'),false);assert.equal(p.stored.get('shrigma_tts_manual_v1:pending'),'uncertain-reservation');
 p.calls[0].resolve(response(data()));await pending;assert.equal(p.ctx.DADOS.kpis[0].gmv,125);assert.deepEqual(p.writes,[]);
 assert.equal(p.calls[0].init.redirect,'error');assert.equal(p.calls[0].init.credentials,'omit');assert.equal(p.calls[0].init.cache,'no-store');
});
test('same-access same-period cache is read-only during refresh and failure; successful refresh restores eligibility',async()=>{
 const p=page();await p.good();assert.equal(TTS.regrasEditaveis(p.ctx.DADOS),true);
 const refresh=p.load();assert.equal(p.paints.at(-1).editable,false);assert(p.ctx.DADOS._cache);
 p.calls.at(-1).reject(Error('network reader-a'));await refresh;
 assert.equal(p.ctx.DADOS.kpis[0].gmv,125);assert.equal(TTS.regrasEditaveis(p.ctx.DADOS),false);assert(p.ctx.DADOS._caiu);
 assert.doesNotMatch(p.ctx.DADOS._caiu,/reader-a/);await p.good();assert.equal(TTS.regrasEditaveis(p.ctx.DADOS),true);
});
test('access replacement cannot inherit another reader data or clear the replacement on a late 401',async()=>{
 const p=page();await p.good();p.key('reader-b');const b=p.load();assert.equal(p.ctx.DADOS,null);
 assert.equal(p.document.querySelector('#tts-autorizacao').hidden,true);assert.equal(p.document.querySelector('#tts-abas .n').textContent,'');
 p.key('reader-c');p.calls.at(-1).resolve(response({},401));await b;assert.deepEqual(p.rejected,[]);assert.equal(p.ctx.DADOS,null);
 const c=p.load();p.calls.at(-1).reject(Error('offline'));await c;assert.equal(p.ctx.DADOS,null);assert.match(p.document.querySelector('#tts-area').textContent,/não foram confirmados/);
});
test('overlapping periods cancel the obsolete read; an out-of-order response cannot repaint or overwrite cache',async()=>{
 const p=page(),old=p.load();p.ctx.PER={ini:'2026-08-01',fim:'2026-08-31'};const current=p.load();
 assert.equal(p.calls[0].init.signal.aborted,true);
 p.calls[1].resolve(response(data('2026-08-01','2026-08-31')));await current;await old;
 p.calls[0].resolve(response(data()));await tick();assert.equal(p.ctx.DADOS.janela.ini,'2026-08-01');assert.equal(p.ctx.CACHE_TTS.ini,'2026-08-01');
 assert.equal(p.timers.size,0);
});
test('20-second deadline covers both headers and a stalled body; late results cannot revive the expired read',async()=>{
 for(const bodyStalls of [false,true]){
  const p=page();let resolveBody;const pending=p.load();
  if(bodyStalls){p.calls[0].resolve({status:200,ok:true,json:()=>new Promise(r=>resolveBody=r)});await tick();}
  p.timeout();await pending;assert.equal(p.calls[0].init.signal.aborted,true);assert.equal(p.ctx.DADOS,null);
  assert.match(p.document.querySelector('#tts-area').textContent,/20 segundos/);assert.equal(p.timers.size,0);
  if(bodyStalls)resolveBody(data());else p.calls[0].resolve(response(data()));await tick();assert.equal(p.ctx.DADOS,null);
 }
});
test('empty, incomplete and wrong-period responses stay unavailable instead of becoming zero revenue',async()=>{
 for(const payload of [{},[],null,{kpis:[],amostras:[],fila:[]},data('2026-08-01','2026-08-31')]){
  const p=page(),pending=p.load();p.calls[0].resolve(response(payload));await pending;
  assert.equal(p.ctx.DADOS,null);assert.equal(p.ctx.CACHE_TTS,null);assert.match(p.document.querySelector('#tts-area').textContent,/não confirmou/);
 }
});
test('current authorization rejection clears session cache without deleting a decision reservation',async()=>{
 const p=page();await p.good();const pending=p.load();p.calls.at(-1).resolve(response({},403));await pending;
 assert.equal(p.ctx.DADOS,null);assert.equal(p.ctx.CACHE_TTS,null);assert.deepEqual(p.rejected,[{role:'read',key:'reader-a'}]);
 assert.equal(p.stored.get('shrigma_tts_manual_v1:pending'),'uncertain-reservation');assert.deepEqual(p.writes,[]);
});
