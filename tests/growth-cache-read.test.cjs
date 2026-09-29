const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
// The validators live inline in growth.html between two markers; run exactly that slice.
function load(fetch,{setTimeout:timer=setTimeout,clearTimeout:clear=clearTimeout}={}){
 const html=fs.readFileSync(path.join(__dirname,'..','growth.html'),'utf8');
 const a=html.indexOf('// GROWTH_CACHE_READ_BEGIN'),b=html.indexOf('// GROWTH_CACHE_READ_END');
 assert.ok(a>0&&b>a,'markers present');
 const ctx=vm.createContext({fetch,AbortController,Date,Number,Array,Promise,Error,JSON,URL,setTimeout:timer,clearTimeout:clear,CRM_READ_API_URL:'https://fixture.invalid/crm-panel-read-v1'});
 vm.runInContext(html.slice(a,b),ctx);return ctx;
}
const fresh={_escopo:'growth',_cache_gerado_em:new Date(Date.now()-5*60*1000).toISOString(),crm_campanha:[],crm_fluxo:[],crm_conversao:[]};
test('a fresh growth cache payload is accepted',()=>{const c=load();assert.equal(c.cacheGrowthValido(fresh),true);});
test('a stale cache (older than 20 min) is refused',()=>{
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
test('the panel never runs the expensive live query on a cache miss, stale data, denial or failure',async()=>{
 for(const [status,payload] of [[200,fresh],[200,{...fresh,_cache_gerado_em:'2000-01-01T00:00:00Z'}],[200,{}],[401,null],[403,null],[503,null]]){
  const calls=[],c=load(async(url,options)=>{calls.push({url,options});return {status,ok:status===200,json:async()=>payload};});
  const out=await c.leCacheGrowth('synthetic-key');assert.equal(calls.length,1);assert.equal(out.r.status,status);assert.equal(out.next,payload===fresh?fresh:null);
  const u=new URL(calls[0].url);assert.equal(u.pathname,'/crm-panel-read-v1');assert.equal(u.searchParams.get('action'),'cache_growth');assert.equal(u.searchParams.get('painel'),'growth');assert.equal(u.searchParams.has('k'),false);assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-key');
 }
 const html=fs.readFileSync(path.join(__dirname,'..','growth.html'),'utf8');
 assert.doesNotMatch(html,/consultaGrowth\([^\n]*(?:CX_API_URL|CX_CACHE_URL)/);
});
test('the data deadline includes a hung response body, even if transport ignores abort',async()=>{
 for(const phase of ['fetch','body']){
  let timer,signal;const never=new Promise(()=>{}),c=load(async(url,options)=>{signal=options.signal;return phase==='fetch'?never:{status:200,ok:true,json:()=>never};},{setTimeout:(fn,ms)=>{assert.equal(ms,12000);timer=fn;return 1;},clearTimeout:()=>{}});
  const pending=c.leCacheGrowth('synthetic-key');await Promise.resolve();timer();await assert.rejects(pending,/demorou/);assert.equal(signal.aborted,true);
 }
});
