'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {hash}=require('../n8n/growth/campaign-service');
const bundle=fs.readFileSync(path.join(__dirname,'../n8n/growth/campaign-runtime.bundle.js'),'utf8');
function load(){
 const context=vm.createContext({});
 assert.equal(vm.runInContext('typeof URL+"/"+typeof require+"/"+typeof Buffer+"/"+typeof TextEncoder',context),'undefined/undefined/undefined/undefined');
 vm.runInContext(bundle,context,{timeout:5000});
 return context.ShrigmaCampaignRuntime;
}
test('bundle SHA-256 matches the existing service without Node or browser globals',()=>{
 const b=load();
 for(const x of [{b:2,a:1},{text:"Olá 👩🏽‍💻, 'aspas'\n{{ UnsubscribeURL }}",array:[1,null,'ç']},
  {surrogate:'\ud800',nested:{z:false,a:0},ignore:undefined},['data',null,{},['árvore']]])assert.equal(b.hashValue(x),hash(x));
 assert.equal(b.hashValue({a:1,b:2}),b.hashValue({b:2,a:1}));
});
test('bundled URL preserves coupon routing, Unicode and repeated parameters',()=>{
 const b=load();
 for(const input of ['https://fishermans.com.br/products/kit?x=1&x=2&utm_content=a%20b',
  'https://oaristocrata.com/discount/BEMVINDO?redirect=%2Fproducts%2Fcaf%C3%A9%3Fvariant%3D5',
  'https://www.fishermans.com.br/collections/ação#top']){
  const actual=new b.URL(input),expected=new URL(input);
  assert.equal(actual.href,expected.href);assert.equal(actual.hostname,expected.hostname);
  actual.searchParams.set('utm_term','lm-3-l17');expected.searchParams.set('utm_term','lm-3-l17');
  assert.equal(actual.href,expected.href);
 }
});
test('bundle starts and resumes the original service using only closed effects',async()=>{
 const b=load(),r=b.createRuntime({now:()=>Date.parse('2026-09-19T18:00:00Z')});
 const start=await r.start({actor:'synthetic-reader',caps:['read_content']},{acao:'campanha_catalogo',brand:'fish'},{executionId:'probe-bundle'});
 assert.equal(start.kind,'effect');assert.equal(start.effect.kind,'provider');assert.equal(start.effect.action,'catalog');
 assert.equal(start.effect.payload.brand,'fish');
 const done=await r.resume(start.context,{effect_id:start.effect.id,ok:true,value:{rows:[{result:{lists:[],templates:[]}}]}},{executionId:'probe-bundle'});
 assert.equal(done.kind,'response');assert.equal(done.response.status,200);
 assert.deepEqual(JSON.parse(JSON.stringify(done.response.body)),{lists:[],templates:[]});
 assert.equal(Object.hasOwn(done,'context'),false);
});
