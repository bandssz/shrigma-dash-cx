'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),P=require('../n8n/growth/email-test-workflow-patch.cjs');
const base=()=>({id:'fixture',versionId:'fixture-v1',settings:{timezone:'America/Sao_Paulo',saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveManualExecutions:false,saveExecutionProgress:false},nodes:[
 {name:'Autenticação entrada',type:'n8n-nodes-base.code',parameters:{jsCode:`const req=$json;const k=String(req.headers?.authorization?.slice(7)||req.body?.k||req.query?.k||'');\n${P.AUTH_ANCHOR}\nconst sql=valid?"select public.shrigma_crm_operator_auth_v1('"+k+"') as auth":"select null::jsonb as auth";return [{json:{req,sql}}];`}},
 {name:'Prepara',type:'n8n-nodes-base.code',parameters:{jsCode:`const req=$('Autenticação entrada').first().json.req,q=req.query||{},b=req.body||{},method=req.method,acao=b.acao||q.acao,auth=$json.auth;const out=(status,body)=>({json:{_http:status,_body:body}});${P.PREPARE_ANCHOR}\nreturn [out(200,{legacy:true})];`}},
 {name:'Etapa',type:'n8n-nodes-base.switch',parameters:{rules:{values:[{existing:true}]},options:{fallbackOutput:'extra'}}},
 {name:'PG leitura',type:'n8n-nodes-base.postgres',typeVersion:2.6,parameters:{query:'={{ $json.sql }}',options:{queryReplacement:'={{ $json.sqlParameters || [] }}'}},credentials:{postgres:{id:'credential-ref'}}},
 {name:'Listmonk criar template',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,parameters:{method:'POST',url:'https://email.shrigma.com.br/api/templates',authentication:'genericCredentialType',genericAuthType:'httpBasicAuth',sendBody:true,specifyBody:'json'},credentials:{httpBasicAuth:{id:'credential-ref'}}},
 {name:'Responde',type:'n8n-nodes-base.respondToWebhook',parameters:{fixture:true}}],connections:{Prepara:{main:[[{node:'Etapa',type:'main',index:0}]]},Etapa:{main:[[{node:'Responde',type:'main',index:0}],[{node:'Responde',type:'main',index:0}]]}}});
const node=(w,n)=>w.nodes.find(x=>x.name===n);
function execute(code,json,ctx={}){return vm.runInNewContext('(function(){'+code+'})()',{...ctx,$json:json});}
test('pure patch preserves every unrelated node/connection/settings, creates a single nonretrying transport path',()=>{const original=base(),p=P.patchWorkflow(original,{expectedVersionId:'fixture-v1'}),w=p.workflow;
 assert.deepEqual(w.settings,original.settings);for(const n of original.nodes)if(!p.changes.existingNodes.includes(n.name))assert.deepEqual(node(w,n.name),n);
 assert.deepEqual(w.connections.Prepara,original.connections.Prepara);assert.equal(node(w,'CRM Email Test transport').retryOnFail,false);assert.equal(node(w,'CRM Email Test transport').onError,'continueRegularOutput');assert.equal(node(w,'CRM Email Test transport').parameters.options.redirect.redirect.followRedirects,false);assert.equal(node(w,'CRM Email Test transport').parameters.url,'https://email.shrigma.com.br/api/tx');assert.equal(w.connections.Etapa.main.length,node(w,'Etapa').parameters.rules.values.length+1);
 assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:'fixture-v1'}));assert.throws(()=>P.patchWorkflow(original,{expectedVersionId:'other'}));const retained=base();delete retained.settings.saveDataErrorExecution;assert.throws(()=>P.patchWorkflow(retained,{expectedVersionId:'fixture-v1'}),/retention/);
});
test('new routes use manager auth with header only and every SQL input is parameterized; legacy behavior remains separate',()=>{const w=P.patchWorkflow(base(),{expectedVersionId:'fixture-v1'}).workflow,auth=node(w,'Autenticação entrada').parameters.jsCode,prepare=node(w,'Prepara').parameters.jsCode;
 for(const keyLocation of ['body','query']){const req={method:'GET',query:{acao:'email_teste_operacao',idempotency_key:'10000000-0000-4000-8000-000000000001'},body:{},headers:{}};req[keyLocation].k='synthetic-manager';assert.match(execute(auth,req)[0].json.sql,/null::jsonb/);}
 const req={method:'POST',body:{acao:'email_teste',draft_id:'d_fixture',expected_version:1,idempotency_key:'10000000-0000-4000-8000-000000000001',confirm:'enviar_teste'},headers:{authorization:'Bearer synthetic-manager'}};
 assert.match(execute(auth,req)[0].json.sql,/shrigma_panel_operator_v1/);assert.doesNotMatch(execute(auth,req)[0].json.sql,/shrigma_crm_operator_auth/);
 const run=(who='panel:manager',r=req)=>execute(prepare,{auth:{who,caps:['draft','validate','submit']}},{$:()=>({first:()=>({json:{req:r}})})})[0].json;
 assert.equal(run('legacy-writer')._http,403);const valid=run();assert.equal(valid._step,'crm_email_test_snapshot');assert.deepEqual(Array.from(valid.sqlParameters),['panel:manager','d_fixture',1]);assert.doesNotMatch(valid.sql,/d_fixture|panel:manager/);
 assert.equal(run('panel:manager',{...req,body:{...req.body,recipient:'other@example.invalid'}})._http,400);
 assert.equal(run('panel:manager',{...req,method:'GET'})._http,405);
 assert.match(execute(auth,{headers:{authorization:'Bearer synthetic-key'},body:{acao:'rascunho'}})[0].json.sql,/shrigma_crm_operator_auth_v1/);
});
test('refused/replayed claims cannot reach transport and the finish path only records sanitized outcome',()=>{
 for(const result of [{should_send:false,result:{_http:200,_body:{state:'claimed'}}},{error:'synthetic'}])assert.equal(execute(P.CLAIM,{result})[0].json._step,'response');
 const fake={operation_id:'10000000-0000-4000-8000-000000000001',claim_token:'10000000-0000-4000-8000-000000000002'};
 for(const [response,outcome]of [[{statusCode:200,body:{data:true}},'accepted'],[{error:{message:'provider secret must not persist'}},'outcome_unknown']]){const r=execute(P.FINISH,response,{$:()=>({first:()=>({json:fake})})})[0].json;assert.equal(r.sqlParameters[2],outcome);assert.doesNotMatch(JSON.stringify(r),/provider secret/);assert.match(r.sql,/crm_email_test_finish_v1/);}
});
