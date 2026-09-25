'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const J=require('../growth-template-journal.js'),R=require('../n8n/growth/template-operation-receipt.cjs');
const ID='20000000-0000-4000-8000-000000000001',CLAIM='30000000-0000-4000-8000-000000000001',ACTOR='synthetic-author';
const content={canal:'email',marca:'fish',idioma:'pt_BR',categoria:'UTILITY',nome:'fixture',peca:'',cabecalho:'',corpo:'Olá, "sintético" — {{ .Tx.Data.first_name }} 🙂',rodape:'',assunto:'Fixture',exemplos:{},botoes:[]};
function fixture(request,{provider='meta',approved=false,change=()=>{},loseResponse=false}={}){
 const values=new Map(),calls=[],rows={receipts:[],claims:[]};let locked=false,sequence=0;
 const client=J.create({storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks:{request:async(k,o,fn)=>{if(locked)return fn(null);locked=true;try{return await fn({name:k});}finally{locked=false;}}},endpoint:'https://example.invalid/templates',crypto:webcrypto,uuid:()=>++sequence===1?ID:ID.slice(0,-1)+String(sequence)});
 const lookup=async(key,action)=>{calls.push('GET');return {status:200,body:R.operationReceipt({operation_key:key,operation_action:action,who:ACTOR},{receipts:rows.receipts.filter(x=>x.idempotency_key===key),claims:rows.claims.filter(x=>x.idempotency_key===key)})};};
 const transport=async wire=>{
  calls.push('POST');assert.equal(JSON.parse(values.get(J.SLOT)).operations[0].phase,'pending');
  const payload=J.payloadFor(wire),body=wire.acao==='rascunho'?{draft_id:wire.draft_id||'d_fixture',version:wire.draft_id?wire.expected_version+1:1,estado:'rascunho',who:ACTOR}:wire.acao==='validar'?{draft_id:wire.draft_id,version:wire.expected_version,estado:'validado',erros:[],avisos:[],who:ACTOR}:{draft_id:wire.draft_id,submission_id:'s_'+CLAIM.replace(/-/g,''),estado:approved?'publicado':'submetido',provider,provider_id:'synthetic-provider-id',provider_status:approved?'APPROVED':'PENDING',operation_id:CLAIM,who:ACTOR};
  const status=wire.acao==='rascunho'?201:wire.acao==='submeter'?202:200;
  rows.receipts.push({idempotency_key:wire.idempotency_key,acao:wire.acao,actor:ACTOR,request_payload:payload,response:{status,body}});
  if(wire.acao==='submeter')rows.claims.push({claim_id:CLAIM,idempotency_key:wire.idempotency_key,acao:'submeter',actor:ACTOR,request_payload:payload,draft_id:wire.draft_id,version:wire.expected_version,state:'succeeded',response:{_http:status,_body:body}});
  change(rows);if(loseResponse)throw Error('synthetic lost receipt');return {status,body};
 };
 return {client,calls,rows,lookup,run:()=>client.run({local_id:'synthetic-local',request_payload:request},{lookup,transport,persistLocal:async()=>true})};
}
test('browser and backend canonical receipts agree for save and validation after a lost HTTP response',async()=>{
 for(const request of [{acao:'rascunho',rascunho:content},{acao:'validar',draft_id:'d_fixture',expected_version:4}]){
  const f=fixture(request,{loseResponse:true}),result=await f.run();assert.equal(result.ok,true);assert.equal(f.client.inspect().operations[0].phase,'confirmed');assert.deepEqual(f.calls,['GET','POST','GET']);
 }
});
test('complete email fields survive the durable save receipt without changing legacy pending payloads',async()=>{
 const r={...content,from_email:'Fishermans <teste@fishermans.com.br>',reply_to:'reply@fishermans.com.br',preheader:'Prévia do teste'};
 const f=fixture({acao:'rascunho',rascunho:r},{loseResponse:true});
 const result=await f.run();assert.equal(result.ok,true);
 assert.deepEqual(f.rows.receipts[0].request_payload.rascunho,r);assert.deepEqual(f.calls,['GET','POST','GET']);
 await f.client.reconcile(ID,f.lookup);assert.equal(f.calls.filter(x=>x==='POST').length,1);
});
test('submission joins its distinct claim UUID and preserves pending or approved provider states',async()=>{
 for(const [provider,approved] of [['meta',false],['meta',true],['listmonk',true]]){
  const f=fixture({acao:'submeter',draft_id:'d_fixture',expected_version:4,confirm:'submeter'},{provider,approved,loseResponse:true});
  const result=await f.run();assert.equal(result.ok,true);assert.equal(result.body.operation_id,CLAIM);assert.notEqual(result.body.operation_id,result.operation_id);assert.equal(result.body.estado,approved?'publicado':'submetido');assert.deepEqual(f.calls,['GET','POST','GET']);
  await f.client.reconcile(ID,f.lookup);assert.equal(f.calls.filter(x=>x==='POST').length,1);
 }
});
test('first-save revision and receipt author drift fail closed across backend and browser',async()=>{
 for(const patch of [{version:9},{who:'different-author'}]){
  const f=fixture({acao:'rascunho',rascunho:content},{change:rows=>Object.assign(rows.receipts[0].response.body,patch)});
  await assert.rejects(f.run(),{code:'TPL_UNKNOWN'});assert.equal(f.client.inspect().operations[0].phase,'unknown');await assert.rejects(f.run(),{code:'TPL_PENDING'});assert.equal(f.calls.filter(x=>x==='POST').length,1);
 }
});
test('claim linkage drift cannot attach another submission and never invokes a second POST',async()=>{
 for(const patch of [{operation_id:ID},{submission_id:'s_other'},{draft_id:'d_other'}]){
  const f=fixture({acao:'submeter',draft_id:'d_fixture',expected_version:4,confirm:'submeter'},{change:rows=>Object.assign(rows.receipts[0].response.body,patch)});
  await assert.rejects(f.run(),{code:'TPL_UNKNOWN'});assert.equal(f.client.inspect().operations[0].phase,'unknown');await assert.rejects(f.client.reconcile(ID,f.lookup),{code:'TPL_UNKNOWN'});assert.equal(f.calls.filter(x=>x==='POST').length,1);
 }
});
test('a stale tab cannot recreate its server draft after another tab applied the confirmed creation',async()=>{
 const f=fixture({acao:'rascunho',rascunho:content});await f.run();await f.client.markApplied(ID,async()=>true);
 assert.equal(f.client.inspect().blocked,false);const before=f.calls.length;
 await assert.rejects(f.run());assert.equal(f.calls.length,before,'stale local identity is rejected before GET and POST');assert.equal(f.calls.filter(x=>x==='POST').length,1);
});
