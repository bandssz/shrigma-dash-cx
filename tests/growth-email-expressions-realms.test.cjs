'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../growth-email-expressions.js'),'utf8');
const GEE=require('../growth-email-expressions.js'),GEC=require('../growth-email-contract.js'),ENP=require('../n8n/growth/email-native-preview.cjs'),{digest}=require('../n8n/growth/template-operation-receipt.cjs');
const plain=()=>({Tx:{Data:{has_discount:true,items:[{name:'Item fictício',quantity:1,image:'https://example.invalid/item.png'}]}},Subscriber:{Name:'Assinante fictício',UUID:'00000000-0000-4000-8000-000000000001'}});
const draft=brand=>({marca:brand,canal:'email',nome:'fixture',from_email:'contato@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),reply_to:'contato@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),preheader:'Fictício',assunto:'Exemplo',corpo:'<p>{{ .Subscriber.Name }}</p>{{ if .Tx.Data.has_discount }}<p>Exemplo</p>{{ end }}{{ range .Tx.Data.items }}<p>{{ .name }}</p>{{ end }}',botoes:[]});
function sandbox(globals={}){const ctx=vm.createContext(globals);vm.runInContext(source+'\nglobalThis.parser=GEE;',ctx);return ctx;}
function bridgeContext(unstable,hideNull=false){const ctx=vm.createContext({JSON}),localProto=vm.runInContext('Object.getPrototypeOf({})',ctx),mapped=new Map([[Object.prototype,{}],[localProto,{}]]);
 ctx.Object=new Proxy(Object,{get(target,key,receiver){if(key==='getPrototypeOf')return value=>{const p=Reflect.getPrototypeOf(value);return p===null&&hideNull?{}:mapped.has(p)?(unstable?{}:mapped.get(p)):p;};return Reflect.get(target,key,receiver);}});return ctx;}
test('GEE retains strict plain validation and the same public result shape; caller records are not normalized',()=>{
 const input=plain();assert.equal(GEE.validateContext(input).ok,true);const ctx=sandbox();assert.equal(ctx.parser.validateContext(input).ok,false,'foreign non-null prototype is still outside the strict original predicate');
 assert.equal(ctx.parser.validateContext(vm.runInContext('({Tx:{Data:{first_name:"Fixture"}},Subscriber:{Name:"",UUID:""}})',ctx)).ok,true);
 const result=GEE.validateContext(input).value;assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.equal(Object.getPrototypeOf(result.Tx.Data.items[0]),Object.prototype);assert.notEqual(result,input);
});
test('ENP supplies only primitive JSON from its internal context, preserving the previous complete JSON/hash/source/profile',()=>{
 const snapshots={fish:['425b6374b3fdd25f633abb1be8cfb9e0888a4f7b5bf6736093f370df17463bc7','d501796a6b6a49e62683613e87ece225648f7cc753cfc9d3a1e46a7dde7e3fc1'],aristo:['0030f7d04ceb2f52ff8665fdcafca50ab3513208c33dd9b24c0714c5c3c16bab','728428d4ee92d23657de693b15f92c38b41223687e39eb14f26bece005dbd963']};
 for(const brand of ['fish','aristo']){
  const r=draft(brand),before=JSON.stringify(r);let validations=0,builds=0,validated;
  const spy={...GEE,validateContext(){throw Error('Object API must not be used internally');},buildPreviewEnvelope(){throw Error('Object builder must not be used internally');},validateContextJSON(text){validations++;assert.equal(typeof text,'string');validated=text;return GEE.validateContextJSON(text);},buildPreviewEnvelopeJSON(source,text){builds++;assert.equal(text,validated);return GEE.buildPreviewEnvelopeJSON(source,text);}};
  const actual=ENP.prepare(r,{GEC,GEE:spy,digest});assert.equal(actual.eligible,true);assert.equal(validations,1);assert.equal(builds,1);assert.equal(JSON.stringify(r),before);assert.equal(Object.getPrototypeOf(actual.context),Object.prototype);
  assert.equal(actual.source_hash,snapshots[brand][0]);assert.equal(crypto.createHash('sha256').update(JSON.stringify(actual)).digest('hex'),snapshots[brand][1]);
  assert.equal(actual.request.form.body,GEE.buildPreviewEnvelope(actual.source.body,actual.context));
 }
});
test('JSON API has the same typed validation and rejects non-text, malformed/oversize JSON, forbidden fields, arrays and unsafe values',()=>{
 const text=JSON.stringify(plain()),source='<p>{{ .Subscriber.Name }}</p>{{ range .Tx.Data.items }}<p>{{ .name }}</p>{{ end }}';
 assert.deepEqual(GEE.validateContextJSON(text),GEE.validateContext(plain()));assert.equal(GEE.buildPreviewEnvelopeJSON(source,text),GEE.buildPreviewEnvelope(source,plain()));
 for(const input of [plain(),new String(text),null,[],()=>text,'{secret-not-valid-json',' '.repeat(GEE.LIMITS.context+1)+text]){assert.equal(GEE.validateContextJSON(input).ok,false);assert.throws(()=>GEE.buildPreviewEnvelopeJSON(source,input));}
 const invalid=['null','[]','true','42','"text"'];
 for(const where of ['root','Tx','Data','Subscriber','item'])for(const key of ['__proto__','constructor','prototype']){
  const x=plain(),target=where==='root'?x:where==='Tx'?x.Tx:where==='Data'?x.Tx.Data:where==='Subscriber'?x.Subscriber:x.Tx.Data.items[0];Object.defineProperty(target,key,{value:'forbidden',enumerable:true});invalid.push(JSON.stringify(x));
 }
 const mutate=fn=>{const x=plain();fn(x);invalid.push(JSON.stringify(x));};
 for(const where of ['Tx','Data','Subscriber','item'])mutate(x=>{if(where==='Tx')x.Tx=[];else if(where==='Data')x.Tx.Data=[];else if(where==='Subscriber')x.Subscriber=[];else x.Tx.Data.items=[[]];});
 mutate(x=>x.Tx.Data.has_discount='true');mutate(x=>x.Tx.Data.items[0].quantity=-1);mutate(x=>x.Tx.Data.items[0].quantity=1.5);mutate(x=>x.Tx.Data.items[0].name={});mutate(x=>x.Tx.Data.items_count=1000001);mutate(x=>x.Tx.Data.items=Array.from({length:21},()=>({name:'fixture'})));
 mutate(x=>x.Tx.Data.items[0].image='javascript:alert(1)');mutate(x=>x.Tx.Data.store_url='https://secret@example.invalid/');mutate(x=>x.Subscriber.Name='x'.repeat(201));mutate(x=>x.Subscriber.UUID='not-a-uuid');mutate(x=>x.Tx.Data.first_name='x'.repeat(GEE.LIMITS.string+1));
 for(const value of invalid){assert.equal(GEE.validateContextJSON(value).ok,false);assert.throws(()=>GEE.buildPreviewEnvelopeJSON(source,value));}
 assert.equal(GEE.validateContextJSON('{"Tx":{"Data":{"items_count":1e999}},"Subscriber":{}}').ok,false);
 assert.equal(GEE.validateContextJSON('{secret-not-valid-json').errors[0].code,'EMAIL_CONTEXT_JSON');assert.equal(JSON.stringify(GEE.validateContextJSON('{secret-not-valid-json')).includes('secret-not-valid-json'),false);
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
test('adversarial bridge hides even null prototypes; only JSON preparation succeeds for both brands with identical JSON/hash',()=>{
 const {BUNDLE}=require('../n8n/growth/email-native-workflow-patch.cjs');
 for(const unstable of [false,true])for(const brand of ['fish','aristo']){
  const ctx=bridgeContext(unstable,true);vm.runInContext(source+'\nglobalThis.parser=GEE;',ctx);const input=plain(),diagnostic=ctx.parser.diagnoseContext(input);
  for(const check of Object.values(diagnostic.checks)){for(const field of ['protoNull','parentNull','ownCtor','ctorType','ctorProtoSame','intrinsicSourceMatch'])assert.equal(check[field],false);assert.equal(check.failed_at,null);}
  assert.equal(ctx.parser.validateContext(input).ok,false,'No fallback admits arbitrary opaque input records');
  const nullRecord=Object.assign(Object.create(null),input);assert.equal(ctx.parser.validateContext(nullRecord).ok,false);assert.equal(ctx.parser.diagnoseContext(nullRecord).checks.root.protoNull,false);
  assert.equal(ctx.parser.validateContextJSON(JSON.stringify(input)).ok,true);
  const complete=bridgeContext(unstable,true),r=draft(brand);complete.syntheticDraft=r;
  const prepared=vm.runInContext(BUNDLE+'\nENP.prepare(syntheticDraft,{GEC,GEE,digest});',complete,{timeout:1000});const expected=ENP.prepare(r,{GEC,GEE,digest});
  assert.equal(prepared.eligible,true);assert.equal(prepared.source_hash,expected.source_hash);assert.equal(JSON.stringify(prepared),JSON.stringify(expected));
  for(const bad of [[],Object.assign(new(class Fixture{})(),input),Object.assign(Object.create({polluted:true}),input),Object.assign(Object.create(Object.assign(Object.create(null),{constructor:Object})),input)])assert.equal(ctx.parser.validateContext(bad).ok,false);
 }
});
