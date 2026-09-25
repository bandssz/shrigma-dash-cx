'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../growth-email-expressions.js'),'utf8');
const GEE=require('../growth-email-expressions.js'),GEC=require('../growth-email-contract.js'),ENP=require('../n8n/growth/email-native-preview.cjs'),{digest}=require('../n8n/growth/template-operation-receipt.cjs');
const plain=()=>({Tx:{Data:{has_discount:true,items:[{name:'Item fictício',quantity:1,image:'https://example.invalid/item.png'}]}},Subscriber:{Name:'Assinante fictício',UUID:'00000000-0000-4000-8000-000000000001'}});
const draft=brand=>({marca:brand,canal:'email',nome:'fixture',from_email:'contato@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),reply_to:'contato@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),preheader:'Fictício',assunto:'Exemplo',corpo:'<p>{{ .Subscriber.Name }}</p>{{ if .Tx.Data.has_discount }}<p>Exemplo</p>{{ end }}{{ range .Tx.Data.items }}<p>{{ .name }}</p>{{ end }}',botoes:[]});
function sandbox(globals={}){const ctx=vm.createContext(globals);vm.runInContext(source+'\nglobalThis.parser=GEE;',ctx);return ctx;}
function bridgeContext(unstable){const ctx=vm.createContext({JSON}),localProto=vm.runInContext('Object.getPrototypeOf({})',ctx),mapped=new Map([[Object.prototype,{}],[localProto,{}]]);
 ctx.Object=new Proxy(Object,{get(target,key,receiver){if(key==='getPrototypeOf')return value=>{const p=Reflect.getPrototypeOf(value);return mapped.has(p)?(unstable?{}:mapped.get(p)):p;};return Reflect.get(target,key,receiver);}});return ctx;}
test('GEE retains strict plain validation and the same public result shape; caller records are not normalized',()=>{
 const input=plain();assert.equal(GEE.validateContext(input).ok,true);const ctx=sandbox();assert.equal(ctx.parser.validateContext(input).ok,false,'foreign non-null prototype is still outside the strict original predicate');
 assert.equal(ctx.parser.validateContext(vm.runInContext('({Tx:{Data:{first_name:"Fixture"}},Subscriber:{Name:"",UUID:""}})',ctx)).ok,true);
 const result=GEE.validateContext(input).value;assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.equal(Object.getPrototypeOf(result.Tx.Data.items[0]),Object.prototype);assert.notEqual(result,input);
});
test('ENP passes only null-prototype internal and already-validated records to GEE; output JSON and hash stay identical',()=>{
 const r=draft('fish');let validations=0,builds=0;
 const checkNull=value=>{if(Array.isArray(value))return value.forEach(checkNull);if(value&&typeof value==='object'){assert.equal(Object.getPrototypeOf(value),null);Object.values(value).forEach(checkNull);}};
 const spy={...GEE,validateContext(value){validations++;checkNull(value);return GEE.validateContext(value);},buildPreviewEnvelope(source,value){builds++;checkNull(value);return GEE.buildPreviewEnvelope(source,value);}};
 const expected=ENP.prepare(r,{GEC,GEE,digest}),actual=ENP.prepare(r,{GEC,GEE:spy,digest});assert.equal(actual.eligible,true);assert.equal(validations,1);assert.equal(builds,1);assert.deepEqual(actual,expected);assert.equal(Object.getPrototypeOf(r),Object.prototype);assert.equal(Object.getPrototypeOf(actual.context),Object.prototype);
});
test('arrays, classes, custom/forged prototypes, forbidden own keys and bounds remain rejected',()=>{
 const cases=[[],new(class Fixture{constructor(){Object.assign(this,plain());}})(),Object.assign(Object.create({polluted:true}),plain()),Object.assign(Object.create(Object.assign(Object.create(null),{constructor:Object})),plain())];
 for(const field of ['__proto__','constructor','prototype']){const x=plain();Object.defineProperty(x.Tx.Data,field,{value:'bad',enumerable:true});cases.push(x);}
 const nested=plain();nested.Tx.Data.items=[Object.assign(Object.create({name:'inherited'}),{quantity:1})];cases.push(nested);
 cases.push(vm.runInNewContext('Object.assign(new (class Fixture {})(),{Tx:{Data:{}},Subscriber:{}})'));
 for(const x of cases)assert.equal(GEE.validateContext(x).ok,false);
 const valid=Object.assign(Object.create(null),plain());assert.equal(GEE.validateContext(valid).ok,true);
 const tooMany=plain();tooMany.Tx.Data.items=Array.from({length:21},()=>({name:'synthetic'}));assert.equal(GEE.validateContext(tooMany).ok,false);
 const unsafe=plain();unsafe.Tx.Data.items[0].image='javascript:alert(1)';assert.equal(GEE.validateContext(unsafe).ok,false);
});
test('stable or unstable opaque prototype wrappers reproduce the diagnostic but internal preparation succeeds for both brands with identical JSON/hash',()=>{
 const {BUNDLE}=require('../n8n/growth/email-native-workflow-patch.cjs');
 for(const unstable of [false,true])for(const brand of ['fish','aristo']){
  const ctx=bridgeContext(unstable);vm.runInContext(source+'\nglobalThis.parser=GEE;',ctx);const input=plain(),diagnostic=ctx.parser.diagnoseContext(input);
  for(const check of Object.values(diagnostic.checks)){for(const field of ['protoNull','parentNull','ownCtor','ctorType','ctorProtoSame','intrinsicSourceMatch'])assert.equal(check[field],false);assert.equal(check.failed_at,null);}
  assert.equal(ctx.parser.validateContext(input).ok,false,'No fallback admits arbitrary opaque input records');
  const complete=bridgeContext(unstable),r=draft(brand);complete.syntheticDraft=r;
  const prepared=vm.runInContext(BUNDLE+'\nENP.prepare(syntheticDraft,{GEC,GEE,digest});',complete,{timeout:1000});const expected=ENP.prepare(r,{GEC,GEE,digest});
  assert.equal(prepared.eligible,true);assert.equal(prepared.source_hash,expected.source_hash);assert.equal(JSON.stringify(prepared),JSON.stringify(expected));
  for(const bad of [[],Object.assign(new(class Fixture{})(),input),Object.assign(Object.create({polluted:true}),input),Object.assign(Object.create(Object.assign(Object.create(null),{constructor:Object})),input)])assert.equal(ctx.parser.validateContext(bad).ok,false);
 }
});
