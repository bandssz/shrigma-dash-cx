'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const R=require('../n8n/growth/template-operation-receipt.cjs'),P=require('../n8n/growth/template-operation-patch.cjs');
const context={operation_key:'fixture-operation-123',operation_action:'rascunho',who:'fixture:writer'};
const request=(acao='rascunho')=>({acao,rascunho:acao==='rascunho'?{canal:'email',marca:'fish',nome:'Fixture',corpo:'Olá, "teste", {{ .Tx.Data.first_name }} 🙂',exemplos:{10:'dez',2:'dois'},botoes:[]}:null,draft_id:acao==='rascunho'?null:'d_fixture',expected_version:acao==='rascunho'?null:1,confirm:acao==='submeter'?'submeter':null});
const receipt=(p=request())=>({idempotency_key:context.operation_key,acao:p.acao,actor:context.who,request_payload:p,response:{status:201,body:{draft_id:'d_fixture',version:1,estado:'rascunho',who:context.who}}});
const CLAIM_ID='00000000-0000-4000-8000-000000000001';
const claim=(state='reserved')=>({claim_id:CLAIM_ID,idempotency_key:context.operation_key,acao:'submeter',actor:context.who,request_payload:request('submeter'),draft_id:'d_fixture',version:1,state,response:null});
const op=(r,c=context)=>R.operationReceipt(c,r).operation;
const copy=x=>JSON.parse(JSON.stringify(x));
test('canonical SHA256 matches native crypto for Unicode, quotes, placeholders, numeric keys and null',()=>{
 for(const payload of [request(),request('submeter'),{z:'',a:['ç','🙂','\ud800',null],exemplos:{2:'dois',10:'dez'}},null]){
  assert.equal(R.digest(payload),createHash('sha256').update(R.canonical(payload),'utf8').digest('hex'));
 }
 assert.equal(R.digest({z:1,a:2}),R.digest({a:2,z:1}));
 assert.notEqual(R.digest({a:[1,2]}),R.digest({a:[2,1]}));
});
test('missing preflight is explicit and carries only authenticated actor and lookup identity',()=>{
 assert.deepEqual(op({receipts:[],claims:[]}),{idempotency_key:context.operation_key,acao:'rascunho',actor:context.who,request_payload:null,request_sha256:null,hash_schema:'json-stable-sha256-v1',state:'missing',response:null,claim_id:null});
 assert.equal(op(null).state,'inconsistent');
});
test('completed draft receipt is projected without credentials, provider raw payload or preview',()=>{
 const i=receipt();i.response.body.k='secret';i.response.body.headers={Authorization:'secret'};i.response.body.components_preview={private:'not needed'};
 const r=op({receipts:[i],claims:[]});assert.equal(r.state,'completed');assert.deepEqual(r.request_payload,request());assert.equal(r.request_sha256,R.digest(request()));
 assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(r.response.body.components_preview,undefined);
});
test('draft and validation confirmations require the exact revision and actor',()=>{
 const i=receipt();for(const patch of [{version:2},{who:'other'},{draft_id:''}])assert.equal(op({receipts:[{...i,response:{status:201,body:{...i.response.body,...patch}}}],claims:[]}).state,'inconsistent');
 const payload={...request(),draft_id:'d_fixture',expected_version:4},updated=receipt(payload);updated.response.body.version=5;updated.response.status=200;
 assert.equal(op({receipts:[updated],claims:[]}).state,'completed');updated.response.body.version=4;assert.equal(op({receipts:[updated],claims:[]}).state,'inconsistent');
 const validated=receipt(request('validar'));validated.response={status:200,body:{draft_id:'d_fixture',version:1,estado:'validado',who:context.who}};
 assert.equal(op({receipts:[validated],claims:[]},{...context,operation_action:'validar'}).state,'completed');
 validated.response.body.version=2;assert.equal(op({receipts:[validated],claims:[]},{...context,operation_action:'validar'}).state,'inconsistent');
});
test('legacy/FNV-only, malformed payload or credential-shaped extra fields cannot confirm',()=>{
 for(const payload of [null,{...request(),k:'secret'},{...request(),rascunho:{...request().rascunho,headers:{authorization:'secret'}}},{...request(),expected_version:'1'}]){
  const i=receipt();i.request_payload=payload;i.corpo_hash='legacy';const r=op({receipts:[i],claims:[]});assert.equal(r.state,'legacy_unverifiable');assert.equal(r.request_payload,null);assert.equal(r.response,null);
 }
});
test('wrong actor, key, action, duplicate rows or disagreeing claim fail closed',()=>{
 for(const patch of [{actor:'other'},{idempotency_key:'different-key'},{acao:'validar'},{request_payload:request('validar')}])assert.equal(op({receipts:[{...receipt(),...patch}],claims:[]}).state,'inconsistent');
 assert.equal(op({receipts:[receipt(),receipt()],claims:[]}).state,'inconsistent');
 const cl=claim('succeeded'),i=receipt(request('submeter'));cl.request_payload.confirm='different';assert.equal(op({receipts:[i],claims:[cl]},{...context,operation_action:'submeter'}).state,'inconsistent');
});
test('durable reserved claim is pending even with no idempotency receipt; it cannot be rejected by a body',()=>{
 const c={...context,operation_action:'submeter'};assert.equal(op({receipts:[],claims:[claim()]},c).state,'pending');
 const cl=claim();cl.response={_http:400,_body:{nothing_changed:true}};assert.equal(op({receipts:[],claims:[cl]},c).state,'inconsistent');
});
test('submission completion requires matching durable claim, payload, revision and both receipts',()=>{
 const c={...context,operation_action:'submeter'},i=receipt(request('submeter'));i.response={status:201,body:{draft_id:'d_fixture',estado:'publicado',provider:'listmonk',provider_id:321,who:c.who,operation_id:CLAIM_ID,submission_id:'s_'+CLAIM_ID.replace(/-/g,'')}};
 const cl=claim('succeeded');cl.response={_http:i.response.status,_body:i.response.body};
 assert.equal(op({receipts:[i],claims:[cl]},c).state,'completed');
 for(const patch of [{claim_id:'00000000-0000-4000-8000-000000000002'},{version:2},{draft_id:'d_other'},{response:{_http:201,_body:{...i.response.body,provider_id:999}}}])assert.equal(op({receipts:[i],claims:[{...cl,...patch}]},c).state,'inconsistent');
 assert.equal(op({receipts:[i],claims:[]},c).state,'legacy_unverifiable');
});
test('unknown never becomes completed from status or nothing_changed, while stored rejection can finish',()=>{
 const c={...context,operation_action:'submeter'},i=receipt(request('submeter')),cl=claim('outcome_unknown');
 i.response={status:502,body:{erro:'outcome_unknown',nothing_changed:false,operation_id:CLAIM_ID,who:c.who}};cl.response={_http:502,_body:i.response.body};
 assert.equal(op({receipts:[i],claims:[cl]},c).state,'outcome_unknown');
 cl.state='rejected';i.response.body.nothing_changed=true;assert.equal(op({receipts:[i],claims:[cl]},c).state,'completed');
 cl.state='outcome_unknown';i.response.status=400;cl.response._http=400;assert.equal(op({receipts:[i],claims:[cl]},c).state,'outcome_unknown');
});
function fixture(){return {versionId:'fixture-fresh',connections:{existing:'untouched'},nodes:[
 {name:'Autenticação entrada',type:'n8n-nodes-base.code',parameters:{jsCode:P.AUTH_ANCHOR+"return [{json:{req,k}}];"}},
 {name:'Prepara',type:'n8n-nodes-base.code',parameters:{jsCode:"const req=$('Autenticação entrada').first().json.req;const q=req.query||{},method=req.method,acao=q.acao,auth=$json.auth;const out=(s,b)=>({json:{_http:s,_body:b}});"+P.PREP_ANCHOR+"return [{json:{legacy:true}}];"}},
 {name:'Formata leitura',type:'n8n-nodes-base.code',parameters:{jsCode:P.FORMAT_ANCHOR+"throw Error('provider path sentinel');"}},
 {name:'PG leitura',type:'n8n-nodes-base.postgres',typeVersion:2.5,parameters:{operation:'executeQuery',query:'={{ $json.sql }}',options:{}}},
 {name:'Responde',type:'n8n-nodes-base.respondToWebhook',parameters:{options:{responseHeaders:{entries:[{name:'Access-Control-Allow-Origin',value:'*'}]}}}},
 {name:'Native transport',parameters:{untouched:true}}
]};}
const fn=(w,name)=>new Function('$json','$','$input',w.nodes.find(n=>n.name===name).parameters.jsCode);
test('fresh patch changes five existing nodes only, preserves transport/connections, is repeatable and fails on drift',()=>{
 const w=fixture(),p=P.patchWorkflow(w,{expectedVersionId:w.versionId});assert.equal(new Set(p.changes.map(x=>x.node)).size,5);assert.deepEqual(p.workflow.connections,w.connections);assert.deepEqual(p.workflow.nodes.at(-1),w.nodes.at(-1));
 assert.deepEqual(P.patchWorkflow(p.workflow,{expectedVersionId:w.versionId}).changes,[]);
 assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:'old'}),/matching/);w.nodes[0].parameters.jsCode='drift';assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:w.versionId}),/anchor changed/);
});
test('new route authenticates header only; old routes keep legacy key behavior',()=>{
 const w=P.patchWorkflow(fixture(),{expectedVersionId:'fixture-fresh'}).workflow,f=fn(w,'Autenticação entrada');
 assert.equal(f({query:{acao:'operacao',k:'url-secret'},headers:{'x-template-key':'header-secret'}})[0].json.k,'header-secret');
 assert.equal(f({query:{acao:'operacao',k:'url-secret'},headers:{}})[0].json.k,'');
 assert.equal(f({query:{acao:'historico',k:'legacy'}})[0].json.k,'legacy');
});
test('lookup capability and method gates run before SQL; parameters never interpolate into fixed query',()=>{
 const w=P.patchWorkflow(fixture(),{expectedVersionId:'fixture-fresh'}).workflow,f=fn(w,'Prepara');
 const run=(auth,patch={})=>f({auth},()=>({first:()=>({json:{req:{method:'GET',query:{acao:'operacao',operacao:'rascunho',idempotency_key:context.operation_key},...patch}}})}))[0].json;
 assert.equal(run(null)._http,401);assert.equal(run({who:context.who,caps:['read_content']})._http,403);assert.equal(run({who:context.who,caps:['draft']},{method:'POST'})._http,405);
 assert.equal(run({who:context.who,caps:['draft']},{query:{acao:'operacao',operacao:'rascunho',idempotency_key:"injection';--"}})._http,400);
 const r=run({who:context.who,caps:['draft']});assert.equal(r.sql,R.SQL);assert.deepEqual(r.sqlParameters,[context.operation_key,context.who]);assert.equal(r._step,'pg_leitura');assert.equal(r.sql.includes(context.operation_key),false);
});
test('format lookup always returns directly without entering provider polling/consolidation',()=>{
 const w=P.patchWorkflow(fixture(),{expectedVersionId:'fixture-fresh'}).workflow,f=fn(w,'Formata leitura');
 for(const row of [{receipts:[],claims:[]},{receipts:[receipt()],claims:[]}]){
  const r=f(null,()=>({first:()=>({json:{acao:'operacao',...context}})}),{all:()=>[{json:row}]})[0].json;assert.equal(r._step,'resposta');assert.equal(r._http,200);assert.equal(r._body.contract,'template_operation_v1');
 }
});
test('fixed SQL is SELECT-only and executes in read-only PostgreSQL with actor isolation and unchanged records',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec('CREATE TABLE shrigma_api_idempotencia(chave text,rota text,actor text,request_payload jsonb,resposta jsonb);CREATE TABLE shrigma_template_claim_v2(claim_id uuid,idem text,actor text,request_payload jsonb,draft_id text,version integer,state text,response jsonb)');
  const i=receipt();await db.query('INSERT INTO shrigma_api_idempotencia VALUES($1,$2,$3,$4,$5)',[i.idempotency_key,i.acao,i.actor,JSON.stringify(i.request_payload),JSON.stringify(i.response)]);
  const cl=claim();await db.query('INSERT INTO shrigma_template_claim_v2 VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[cl.claim_id,'fixture-submit-key',cl.actor,JSON.stringify(cl.request_payload),cl.draft_id,cl.version,cl.state,null]);
  const before=(await db.query('SELECT * FROM shrigma_api_idempotencia')).rows;
  await db.exec('BEGIN READ ONLY');
  assert.equal(op((await db.query(R.SQL,[context.operation_key,context.who])).rows[0]).state,'completed');
  assert.deepEqual((await db.query(R.SQL,[context.operation_key,'other:actor'])).rows[0],{receipts:[],claims:[]});
  assert.deepEqual((await db.query(R.SQL,["x' OR true --",context.who])).rows[0],{receipts:[],claims:[]});
  const claimRow=(await db.query(R.SQL,['fixture-submit-key',context.who])).rows[0];assert.equal(op(claimRow,{...context,operation_key:'fixture-submit-key',operation_action:'submeter'}).state,'pending');assert.equal(claimRow.claims[0].claim_id,CLAIM_ID);
  await db.exec('COMMIT');assert.deepEqual((await db.query('SELECT * FROM shrigma_api_idempotencia')).rows,before);
 }finally{await db.close();}
});
