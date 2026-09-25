'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../growth-email-expressions.js'),'utf8');
const plain=()=>({Tx:{Data:{has_discount:true,items:[{name:'Item fictício',quantity:1,image:'https://example.invalid/item.png'}]}},Subscriber:{Name:'Assinante fictício',UUID:'00000000-0000-4000-8000-000000000001'}});
function sandbox(globals={}){const ctx=vm.createContext(globals);vm.runInContext(source+'\nglobalThis.parser=GEE;',ctx);return ctx;}
test('ordinary context objects may cross the sandbox boundary without losing their safe shape',()=>{
 const ctx=sandbox(),input=plain();assert.equal(ctx.parser.validateContext(input).ok,true);assert.equal(ctx.parser.validateContext(vm.runInContext('({Tx:{Data:{first_name:"Fixture"}},Subscriber:{Name:"",UUID:""}})',ctx)).ok,true);
 const out=ctx.parser.validateContext(input).value;assert.notEqual(out,input);assert.notEqual(out.Tx.Data.items[0],input.Tx.Data.items[0]);
});
test('bridged Object/JSON globals preserve safe native preparation built from sandbox literals and parsed item records',()=>{
 const ctx=sandbox({Object,JSON});const {BUNDLE}=require('../n8n/growth/email-native-workflow-patch.cjs');
 const result=vm.runInNewContext(BUNDLE+`\nENP.prepare({marca:'fish',canal:'email',nome:'fixture',from_email:'contato@fishermans.com.br',reply_to:'contato@fishermans.com.br',preheader:'Fictício',assunto:'Exemplo',corpo:'<p>{{ .Subscriber.Name }}</p>{{ if .Tx.Data.has_discount }}<p>Exemplo</p>{{ end }}{{ range .Tx.Data.items }}<p>{{ .name }}</p>{{ end }}',botoes:[]},{GEC,GEE,digest});`,{Object,JSON},{timeout:1000});
 assert.equal(result.eligible,true);assert.equal(result.subscriber_context,'synthetic');assert.match(result.source_hash,/^[a-f0-9]{64}$/);assert.equal(ctx.parser.validateContext(plain()).ok,true);
});
test('arrays, class instances, custom/forged prototypes and forbidden own keys stay rejected in both realms',()=>{
 const ctx=sandbox({Object,JSON});
 const cases=[[],new(class Fixture{constructor(){Object.assign(this,plain());}})(),Object.assign(Object.create({polluted:true}),plain()),Object.assign(Object.create(Object.assign(Object.create(null),{constructor:Object})),plain())];
 for(const field of ['__proto__','constructor','prototype']){const x=plain();Object.defineProperty(x.Tx.Data,field,{value:'bad',enumerable:true});cases.push(x);}
 const nested=plain();nested.Tx.Data.items=[Object.assign(Object.create({name:'inherited'}),{quantity:1})];cases.push(nested);
 const foreign=vm.runInNewContext('Object.assign(new (class Fixture {})(),{Tx:{Data:{}},Subscriber:{}})');cases.push(foreign);
 for(const x of cases)assert.equal(ctx.parser.validateContext(x).ok,false);
 const valid=Object.assign(Object.create(null),plain());assert.equal(ctx.parser.validateContext(valid).ok,true);
 const tooMany=plain();tooMany.Tx.Data.items=Array.from({length:21},()=>({name:'synthetic'}));assert.equal(ctx.parser.validateContext(tooMany).ok,false);
 const unsafe=plain();unsafe.Tx.Data.items[0].image='javascript:alert(1)';assert.equal(ctx.parser.validateContext(unsafe).ok,false);
});
