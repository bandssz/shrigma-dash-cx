'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../influs.html'),'utf8');
const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const response=(data,status=200)=>({status,ok:status===200,json:async()=>data});
const data=(ini='2026-09-14',fim='2026-09-20')=>({janela:{ini,fim},roi:[{receita:125}],influs:[],cupons:[],custos:[],receita_cupom:[],termos:[]});
const tick=()=>new Promise(setImmediate);
function page(){
 let key='reader-a',id=0;const calls=[],paints=[],notices=[],banners=[],master=[],rejects=[],timers=new Map(),fresh={textContent:'old',title:'old'};
 const ctx=vm.createContext({AbortController,setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  PER:{ini:'2026-09-14',fim:'2026-09-20'},INFLU_API_URL:'https://example.invalid/creators',CX_API_URL:'https://example.invalid/shared',
  INFLU_ACCESS:{current:()=>key,isSessionRead:()=>true,requireWrite:()=>key,author:()=> 'Operator',reject:(r,k)=>{rejects.push({r,k});if(k===key)key='';}},
  chaveLeitura:()=>key,shrigmaChave:()=>key,esc:String,avisoTela:(...args)=>notices.push(args),$:()=>fresh,
  window:{avisoCredencial:x=>banners.push(x)},shrigmaMarcaMestra:(...x)=>master.push(x),shrigmaFrescor:p=>{fresh.textContent=p.gerado_em;},
  fetch:(url,init)=>new Promise((resolve,reject)=>calls.push({url,init,resolve,reject})),
  renderTudo:()=>paints.push(vm.runInContext('INFLU',ctx))});
 vm.runInContext(section('let INFLU=null,','/* Faixa de credencial.')+section('async function faixaCredencial(){','faixaCredencial();')+section('async function carregarInflu(){','function renderTudo(){'),ctx);
 return {ctx,calls,paints,notices,banners,master,rejects,timers,fresh,key:k=>key=k,data:()=>vm.runInContext('INFLU',ctx),load:()=>ctx.carregarInflu(),banner:()=>ctx.faixaCredencial(),expire(){const t=[...timers.values()][0];assert.equal(t.ms,20000);t.fn();}};
}
test('Creators cancels superseded period reads and only renders the matching response',async()=>{
 const p=page(),old=p.load();p.ctx.PER={ini:'2026-08-01',fim:'2026-08-31'};const current=p.load();assert(p.calls[0].init.signal.aborted);
 p.calls[1].resolve(response(data('2026-08-01','2026-08-31')));await current;await old;
 p.calls[0].resolve(response(data()));await tick();assert.equal(p.paints.length,1);assert.equal(p.data().janela.ini,'2026-08-01');assert.equal(p.timers.size,0);
});
test('Creators rejects malformed or wrong-period data rather than manufacturing zero revenue',async()=>{
 for(const d of [{fixture:true},{...data(),roi:null},data('2026-08-01','2026-08-31')]){const p=page(),r=p.load();p.calls[0].resolve(response(d));await r;assert.equal(p.data(),null);assert.match(p.notices.at(-1)[1],/não confirmou/);}
});
test('Creators deadline covers fetch and JSON body; a late rejection cannot forget the access',async()=>{
 for(const bodyStalls of [false,true]){
  const p=page();let resolveBody;const r=p.load();
  if(bodyStalls){p.calls[0].resolve({status:401,ok:false,json:()=>new Promise(resolve=>resolveBody=resolve)});await tick();}
  p.expire();await r;assert(p.calls[0].init.signal.aborted);assert.match(p.notices.at(-1)[1],/20 segundos/);
  if(bodyStalls)resolveBody({erro:'old'});else p.calls[0].resolve(response({},401));await tick();
  assert.deepEqual(p.rejects,[]);assert.equal(p.data(),null);assert.equal(p.timers.size,0);
 }
});
test('a replaced access cannot receive old Creators data or old authentication rejection',async()=>{
 for(const status of [200,401]){const p=page(),r=p.load();p.key('reader-b');p.calls[0].resolve(response(data(),status));await r;assert.equal(p.data(),null);assert.equal(p.paints.length,0);assert.deepEqual(p.rejects,[]);}
});
test('current 403 still requests correct access and does not retry',async()=>{
 const p=page(),r=p.load();p.calls[0].resolve(response({},403));await r;
 assert.equal(p.rejects.length,1);assert.match(p.notices.at(-1)[0],/Acesso/);assert.equal(p.calls.length,1);assert.equal(p.data(),null);
});
test('credential banner cannot restore an old access or old response, and clears stale notices',async()=>{
 const p=page(),old=p.banner();assert.equal(p.fresh.textContent,'coleta sem confirmação');assert.equal(p.banners.at(-1).length,0);
 p.key('reader-b');const current=p.banner();assert(p.calls[0].init.signal.aborted);
 p.calls[1].resolve(response({crm_credencial:[{id:'current'}],gerado_em:'now'}));await current;await old;
 p.calls[0].resolve(response({crm_credencial:[{id:'old'}],gerado_em:'old'}));await tick();assert.equal(p.banners.at(-1)[0].id,'current');assert.equal(p.fresh.textContent,'now');assert.equal(p.master.length,0);
 const changed=p.banner();p.key('reader-c');p.calls[2].resolve(response({crm_credencial:[{id:'wrong'}],gerado_em:'wrong'}));await changed;assert.equal(p.banners.at(-1).length,0);assert.equal(p.fresh.textContent,'coleta sem confirmação');
});
test('credential timeout cannot block Creators and writes retain their own unbounded receipt semantics',async()=>{
 const p=page(),banner=p.banner(),load=p.load();p.calls[1].resolve(response(data()));await load;p.expire();await banner;assert.equal(p.data().roi[0].receita,125);
 const written=p.ctx.influPost({k:'reader-a',acao:'salvar_custo'});assert.equal(p.timers.size,0);assert.equal(p.calls[2].init.signal,undefined);
 p.calls[2].reject(Error('offline'));await assert.rejects(written,/Resposta não confirmada/);assert.equal(p.calls.length,3);
});
