'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),P=require('../n8n/growth/email-template-envelope-patch.cjs'),G=require('../growth-email-contract');
const source=end=>`// untouched auth/whatsapp prelude\n// Email drafts become new Listmonk templates. Existing production IDs are immutable here.\nfunction emailErrors(r) {\n  const errors=[];\n  if(!r.corpo)errors.push({codigo:'EMAIL_CONTENT',campo:'corpo'});\n  return errors;\n}\nfunction emailPayload(r) { return {legacy:true}; }\n\n${end}\n// untouched routes`;
function fresh(){return {versionId:'fixture',settings:{keep:true},nodes:[...['Prepara','Decide escrita'].map(name=>({name,type:'n8n-nodes-base.code',parameters:{jsCode:source(name==='Prepara'?'// API de escrita de templates':'// Decide a escrita com o estado')}})),{name:'Formata leitura',type:'n8n-nodes-base.code',parameters:{jsCode:P.LEGACY_FIELDS}}],connections:{keep:true}};}
test('envelope patch is version guarded, idempotent and preserves unrelated workflow fields',()=>{
 const input=fresh(),before=JSON.stringify(input),patched=P.patchWorkflow(input,{expectedVersionId:'fixture'});
 assert.equal(JSON.stringify(input),before);assert.equal(patched.changes.length,3);assert.deepEqual(patched.workflow.connections,input.connections);assert.deepEqual(patched.workflow.settings,input.settings);
 for(const n of patched.workflow.nodes.slice(0,2)){assert.ok(n.parameters.jsCode.startsWith('// untouched auth/whatsapp prelude'));assert.ok(n.parameters.jsCode.endsWith('// untouched routes'));}
 assert.deepEqual(P.patchWorkflow(patched.workflow,{expectedVersionId:'fixture'}).changes,[]);
 assert.throws(()=>P.patchWorkflow(input,{expectedVersionId:'other'}));
 input.nodes[0].parameters.jsCode=input.nodes[0].parameters.jsCode.replace('return errors;','return errors.slice();');assert.throws(()=>P.patchWorkflow(input,{expectedVersionId:'fixture'}));
});
test('server emitted code and shared contract produce identical preheader/body and check complete envelopes',()=>{
 const w=P.patchWorkflow(fresh(),{expectedVersionId:'fixture'}).workflow;
 for(const n of w.nodes.slice(0,2)){
  const c=vm.createContext({});vm.runInContext(n.parameters.jsCode+'\nthis.server={errors:emailErrors,payload:emailPayload};',c);
  for(const marca of ['fish','aristo']){
   const r={canal:'email',marca,nome:'QA',assunto:'Assunto',corpo:'Olá',from_email:'teste@'+G.BRANDS[marca].domain,reply_to:'reply@'+G.BRANDS[marca].domain,preheader:'Texto seguro'};
   assert.equal(JSON.stringify(c.server.payload(r)),JSON.stringify(G.payload(r)));assert.equal(c.server.errors(r).length,0);
   assert.equal(c.server.errors({...r,reply_to:'outro@example.invalid'})[0].campo,'reply_to');
  }
  assert.equal(c.server.errors({canal:'email',marca:'fish',corpo:'Legado'}).length,0);
 }
});
