'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const GEE=require('../growth-email-expressions.js'),GEC=require('../growth-email-contract.js'),ENP=require('../n8n/growth/email-native-preview.cjs'),{digest}=require('../n8n/growth/template-operation-receipt.cjs');
const allowedKeys=['protoNull','parentNull','ownCtor','ctorType','ctorProtoSame','intrinsicSourceMatch','failed_at'].sort();
function shape(d){assert.equal(d.contract,'crm_email_context_diagnostic_v1');assert.deepEqual(Object.keys(d.checks),['root','Tx','Data','Subscriber','firstItem']);for(const c of Object.values(d.checks)){assert.deepEqual(Object.keys(c).sort(),allowedKeys);for(const [key,value]of Object.entries(c))if(key==='failed_at')assert.ok(value===null||['lookup','getPrototypeOf','parentPrototype','constructorDescriptor','constructorType','constructorPrototype','intrinsicSource'].includes(value));else assert.equal(typeof value,'boolean');}}
test('diagnostics contain only fixed paths, booleans and a static exception stage; synthetic secrets never appear',()=>{
 const secret='SYNTHETIC_PRIVATE_VALUE_DO_NOT_EXPOSE';const context={Tx:{Data:{first_name:secret,items:[{name:secret}]}},Subscriber:{Name:secret,UUID:secret}};
 let d=GEE.diagnoseContext(context);shape(d);assert.doesNotMatch(JSON.stringify(d),new RegExp(secret));assert.equal(d.checks.root.ctorProtoSame,true);assert.equal(d.checks.firstItem.intrinsicSourceMatch,true);
 const throwing={get Tx(){throw Object.assign(Error(secret),{code:secret});},Subscriber:{Name:secret}};d=GEE.diagnoseContext(throwing);shape(d);assert.equal(d.checks.Tx.failed_at,'lookup');assert.equal(d.checks.Data.failed_at,'lookup');assert.equal(JSON.stringify(d).includes(secret),false);
 const proxy=new Proxy({},{getPrototypeOf(){throw Error(secret);}});d=GEE.diagnoseContext(proxy);shape(d);assert.equal(d.checks.root.failed_at,'getPrototypeOf');assert.equal(JSON.stringify(d).includes(secret),false);
});
test('native failure exposes static validation code and boolean context report, never source, values, raw errors or render descriptor',()=>{
 const secret='SYNTHETIC_SECRET_HTML_VALUE';const r={marca:'fish',canal:'email',nome:'fixture',from_email:'contato@fishermans.com.br',reply_to:'contato@fishermans.com.br',preheader:secret,assunto:'Fixture',corpo:'<p>'+secret+' {{ .Subscriber.Name }}</p>',botoes:[]};
 for(const code of ['EMAIL_CONTEXT_SHAPE',secret]){
  const gee={...GEE,validateContextJSON:()=>({ok:false,errors:[{code,message:secret,source:secret}]})};const p=ENP.prepare(r,{GEE:gee,GEC,digest});assert.equal(p.eligible,false);assert.equal(p.code,'preview_context_invalid');shape(p.context_diagnostic);assert.equal(p.context_diagnostic.validation_code,code==='EMAIL_CONTEXT_SHAPE'?code:'CONTEXT_VALIDATION_FAILED');assert.equal(JSON.stringify(p).includes(secret),false);assert.deepEqual(Object.keys(p).sort(),['eligible','code','contract','context_diagnostic'].sort());
 }
});
test('diagnostic helper does not change refusal of an unsafe context or successful native preparation',()=>{
 const context={Tx:{Data:{first_name:'Fixture'}},Subscriber:{Name:'',UUID:''}},before=GEE.validateContext(context);GEE.diagnoseContext(context);assert.deepEqual(GEE.validateContext(context),before);
 const bad={Tx:{Data:{constructor:'forbidden'}},Subscriber:{}};assert.equal(GEE.validateContext(bad).ok,false);GEE.diagnoseContext(bad);assert.equal(GEE.validateContext(bad).ok,false);
});
