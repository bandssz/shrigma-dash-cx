'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const P=require('../n8n/growth/email-html-compat-patch.cjs'),B=require('./fixtures/email-html-compat-baseline.json'),G=require('../growth-email-contract');
function fresh(){return {id:'fixture',versionId:'fixture-version',active:true,settings:{saveDataSuccessExecution:'none',saveDataErrorExecution:'none'},connections:{preserved:{main:[[{node:'other'}]]}},nodes:[...['Prepara','Decide escrita'].map(name=>({name,type:'n8n-nodes-base.code',parameters:{jsCode:'// untouched auth, routes and WhatsApp\n// CRM_EMAIL_ENVELOPE_V1\n'+B.contract+'\n// Email drafts become new Listmonk templates. Existing production IDs are immutable here.\n'+B.errors+'function emailPayload(r) { return GEC.payload(r); }\n// unchanged routing suffix'},credentials:{keep:{id:'synthetic'}}})),{name:'CRM Email Test plan',type:'n8n-nodes-base.code',parameters:{jsCode:B.plan}},{name:'CRM Email Test finish payload',parameters:{jsCode:'unchanged transport and reservation'}},{name:'unrelated',parameters:{keep:'unchanged'},credentials:{keep:{id:'synthetic'}}}]};}
test('CRM20 patch changes only the three guarded code bodies, preserving auth, graph, credentials and settings',()=>{
 const input=fresh(),before=JSON.stringify(input),out=P.patchWorkflow(input,{expectedVersionId:'fixture-version'});assert.equal(JSON.stringify(input),before);assert.deepEqual(out.changes.map(x=>x.node),['Prepara','Decide escrita','CRM Email Test plan']);
 const strip=w=>({...w,nodes:w.nodes.map(n=>['Prepara','Decide escrita','CRM Email Test plan'].includes(n.name)?{...n,parameters:{...n.parameters,jsCode:'expected'}}:n)});assert.deepEqual(strip(out.workflow),strip(input));
 for(const node of out.workflow.nodes.slice(0,2)){assert.ok(node.parameters.jsCode.startsWith('// untouched auth, routes and WhatsApp'));assert.ok(node.parameters.jsCode.endsWith('// unchanged routing suffix'));}
 assert.deepEqual(P.patchWorkflow(out.workflow,{expectedVersionId:'fixture-version'}).changes,[]);assert.throws(()=>P.patchWorkflow(input,{expectedVersionId:'wrong'}));
 for(const [index,anchor] of [[0,'const GEC={'],[1,"'fish','aristo'"],[2,"PREFIX='✅ FINAL — '"]]){const w=fresh();w.nodes[index].parameters.jsCode=w.nodes[index].parameters.jsCode.replace(anchor,anchor+' drift');assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:'fixture-version'}));}
});
test('before/after synthetic proof: both server validators accept passive documents/dynamic links and keep risky HTML blocked',()=>{
 const out=P.patchWorkflow(fresh(),{expectedVersionId:'fixture-version'}).workflow;
 for(const n of out.nodes.slice(0,2)){
  const ctx=vm.createContext({});vm.runInContext(n.parameters.jsCode+'\nthis.server={errors:emailErrors,payload:emailPayload};',ctx);
  for(const brand of ['fish','aristo']){
   const r=G.draft({canal:'email',marca:brand,nome:'fixture',assunto:'Oi {{ .Tx.Data.first_name }}',preheader:'Resumo',corpo:'<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Example+Serif:wght@400;700&amp;display=swap"><style>@media(max-width:600px){p{color:black}}</style></head><body title="1 > 0"><p>{{ .Tx.Data.first_name }}</p></body></html>',botoes:[]});
   assert.equal(ctx.server.errors(r).length,0);assert.deepEqual(JSON.parse(JSON.stringify(ctx.server.payload(r))),G.payload(r));
   const dynamic={...r,corpo:'<a href="{{ .Tx.Data.order_url }}">Pedido</a>'};assert.equal(ctx.server.errors(dynamic).length,0);assert.equal(ctx.server.payload(dynamic).body,G.payload(dynamic).body);
   const old=vm.createContext({});vm.runInContext(B.contract+B.errors+'\nthis.errors=emailErrors;',old);assert.ok(old.errors(r).length);
   for(const body of ['<meta http-equiv="refresh" content="0;url=https://example.invalid">','<img src="data:image/png;base64,AA==">','<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Example&redirect=https://example.invalid">'])assert.ok(ctx.server.errors({...r,corpo:body}).length,body);
  }
 }
});
test('embedded test plan stays fixed-recipient, preview-only in this synthetic proof, and permits static CSS plus text variables',()=>{
 const w=P.patchWorkflow(fresh(),{expectedVersionId:'fixture-version'}).workflow,n=w.nodes.find(n=>n.name==='CRM Email Test plan');
 for(const brand of ['fish','aristo']){
  const r=G.draft({canal:'email',marca:brand,nome:'fixture',assunto:'Oi {{ .Tx.Data.first_name }}',preheader:'Resumo',corpo:'<style>@media(max-width:600px){p{color:black}}</style><p>{{ .Tx.Data.first_name }}</p>',botoes:[]}),native=G.payload(r),snapshot={eligible:true,draft_id:'d_fixture',version:1,rascunho:r,components:{subject:native.subject,body_html:native.body},native:{id:1,type:'tx',subject:native.subject,body:native.body}};
  const ctx=vm.createContext({$json:{snapshot},$:()=>({first:()=>({json:{email_test_action:'email_teste_previa'}})})});const result=vm.runInContext('(function(){'+n.parameters.jsCode+'})()',ctx);
  assert.equal(result[0].json._body.eligible,true);assert.equal(result[0].json._body.recipient,'felipebandeira@oaristocrata.com');assert.equal(result[0].json._body.rendered_subject,'✅ FINAL — Oi Felipe');assert.match(result[0].json._body.body_html,/<p>Felipe<\/p>/);assert.equal(result[0].json._step,'response');
 }
});
