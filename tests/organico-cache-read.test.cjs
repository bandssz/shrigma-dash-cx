const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
// The validators live inline in organico.html between two markers; run exactly that slice.
function load(){
 const html=fs.readFileSync(path.join(__dirname,'..','organico.html'),'utf8');
 const a=html.indexOf('// ORGANICO_CACHE_READ_BEGIN'),b=html.indexOf('// ORGANICO_CACHE_READ_END');
 assert.ok(a>0&&b>a,'markers present');
 const ctx=vm.createContext({Date,Number,Array,JSON});
 vm.runInContext(html.slice(a,b),ctx);return ctx;
}
const fresco={_escopo:'organico',_cache_gerado_em:new Date(Date.now()-6*60*1000).toISOString(),cx_post:[],cx_story:[],cx_organico_receita:[]};
test('a fresh organic cache payload is accepted',()=>{assert.equal(load().cacheOrganicoValido(fresco),true);});
test('a cache older than twenty minutes hands over to the live API',()=>{
 const c=load();
 assert.equal(c.cacheOrganicoValido({...fresco,_cache_gerado_em:new Date(Date.now()-21*60*1000).toISOString()}),false);
 assert.equal(c.cacheOrganicoValido({...fresco,_cache_gerado_em:undefined}),false,'sem carimbo não é cache válido');
});
test('another scope, an error body or a payload without the organic arrays is refused',()=>{
 const c=load();
 assert.equal(c.payloadOrganicoValido({...fresco,_escopo:'growth'}),false);
 assert.equal(c.payloadOrganicoValido({...fresco,erro:'x'}),false);
 assert.equal(c.payloadOrganicoValido({_escopo:'organico'}),false);
 assert.equal(c.payloadOrganicoValido(null),false);
 assert.equal(c.payloadOrganicoValido([fresco]),false,'array cru não passa');
});
test('the live envelope shapes are unwrapped the same way as before',()=>{
 const c=load();
 assert.deepEqual(c.payloadOrganico({payload:fresco}),fresco);
 assert.deepEqual(c.payloadOrganico([{payload:fresco}]),fresco);
 assert.deepEqual(c.payloadOrganico([fresco]),fresco);
 assert.deepEqual(c.payloadOrganico(fresco),fresco);
});
test('the panel asks the cache first and only skips the live read when the key was refused',()=>{
 const html=fs.readFileSync(path.join(__dirname,'..','organico.html'),'utf8');
 const i=html.indexOf("CX_CACHE_URL+'?painel=organico'"),j=html.indexOf("CX_API_URL+'?painel=organico'");
 assert.ok(i>0&&j>i,'cache read comes first');
 assert.match(html,/if\(!payload&&!\(r&&\(r\.status===401\|\|r\.status===403\)\)\)/);
 assert.match(html,/id="origem-leitura"/,'o cabeçalho diz de onde veio a leitura');
});
