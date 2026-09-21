const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
// The validators live inline in growth.html between two markers; run exactly that slice.
function load(fetch){
 const html=fs.readFileSync(path.join(__dirname,'..','growth.html'),'utf8');
 const a=html.indexOf('// GROWTH_CACHE_READ_BEGIN'),b=html.indexOf('// GROWTH_CACHE_READ_END');
 assert.ok(a>0&&b>a,'markers present');
 const ctx=vm.createContext({fetch,AbortSignal,Date,Number,Array,Promise,Error,JSON});
 vm.runInContext(html.slice(a,b),ctx);return ctx;
}
const fresh={_escopo:'growth',_cache_gerado_em:new Date(Date.now()-5*60*1000).toISOString(),crm_campanha:[],crm_fluxo:[],crm_conversao:[]};
test('a fresh growth cache payload is accepted',()=>{const c=load();assert.equal(c.cacheGrowthValido(fresh),true);});
test('a stale cache (older than 20 min) is refused so the live API takes over',()=>{
 const c=load();assert.equal(c.cacheGrowthValido({...fresh,_cache_gerado_em:new Date(Date.now()-21*60*1000).toISOString()}),false);
});
test('a payload from another scope or without the arrays is refused',()=>{
 const c=load();
 assert.equal(c.payloadGrowthValido({...fresh,_escopo:'cx'}),false);
 assert.equal(c.payloadGrowthValido({...fresh,crm_conversao:null}),false);
 assert.equal(c.payloadGrowthValido({...fresh,error:'x'}),false);
 assert.equal(c.payloadGrowthValido(null),false);
});
test('a cache body that is not JSON is a miss, not a crash',async()=>{
 const c=load(async()=>({ok:true,status:200,json:async()=>{throw new Error('empty body');}}));
 const out=await c.consultaGrowth('https://synthetic.invalid','k',1000);
 assert.equal(out.r.ok,true);assert.equal(out.payload,null);
});
test('a denied response keeps its status for the caller to refuse the key',async()=>{
 const c=load(async()=>({ok:false,status:401}));
 const out=await c.consultaGrowth('https://synthetic.invalid','k',1000);
 assert.equal(out.r.status,401);assert.equal(out.payload,null);
});
test('the panel requests the cache before the live API and falls back on a miss',()=>{
 const html=fs.readFileSync(path.join(__dirname,'..','growth.html'),'utf8');
 const i=html.indexOf("consultaGrowth(CX_CACHE_URL+'?painel=growth'"),j=html.indexOf('consultaGrowth(`${CX_API_URL}?painel=growth`');
 assert.ok(i>0&&j>i,'cache read comes first, live read second');
 assert.match(html,/if\(!next&&!\(r&&\(r\.status===401\|\|r\.status===403\)\)\)/,'live fallback is skipped only when the key was refused');
});
