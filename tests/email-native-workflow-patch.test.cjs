'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const N=require('../n8n/growth/email-native-workflow-patch.cjs');
const {ROUTE}=require('../n8n/growth/email-test-workflow-patch.cjs');
const GEC=require(process.env.CRM_EMAIL_CONTRACT_MODULE||'../growth-email-contract.js');
const frame=s=>'// CRM_EMAIL_ENVELOPE_V1\nconst GEC={};\n// Email drafts become new Listmonk templates. Existing production IDs are immutable here.\n'+s;
function workflow(){const code=(name,jsCode)=>({id:name,name,type:'n8n-nodes-base.code',typeVersion:2,parameters:{jsCode}});const rule={outputKey:'claim'};
 return{versionId:'fresh',active:true,settings:{saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveManualExecutions:false,saveExecutionProgress:false},nodes:[code('Autenticação entrada',"const routes=['email_teste','email_teste_previa','email_teste_operacao'];"),code('Prepara',frame(ROUTE+"const ctx={acao,who:auth.who,method,wabas:WABA,request_payload:{}};")),code('Decide escrita',frame("return [{json:{_step:'pg_escrita',sql:'original'}}];")),{name:'Etapa',parameters:{rules:{values:[]},options:{fallbackOutput:'extra'}}},code('CRM Email Test plan','old plan'),{name:'CRM Email Test plan route',parameters:{rules:{values:[rule]},options:{fallbackOutput:'extra'}}},{name:'CRM Email Test claim',type:'n8n-nodes-base.postgres',credentials:{postgres:{id:'synthetic'}}},{name:'Listmonk criar template',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,parameters:{url:'https://email.shrigma.com.br/api/templates',genericAuthType:'httpBasicAuth'},credentials:{httpBasicAuth:{id:'synthetic'}}},{name:'CRM Email Test transport',parameters:{url:'/api/tx',retry:false},credentials:{httpBasicAuth:{id:'synthetic'}}}],connections:{Etapa:{main:[[{node:'Responde',type:'main',index:0}]]},'Decide escrita':{main:[[{node:'Escrita →',type:'main',index:0}]]},'CRM Email Test plan route':{main:[[{node:'CRM Email Test claim',type:'main',index:0}],[{node:'Responde',type:'main',index:0}]]}}};}
const expected=w=>Object.fromEntries(w.nodes.map(n=>[n.name,N.sha(JSON.stringify(n))]));
function run(code,ctx={}){return vm.runInNewContext('(function(){'+code+'})()',ctx,{timeout:1000});}
test('patch is version/hash bound, changes only declared nodes/edges, preserves transport and credentials, no retries or redirects in native preview',()=>{
 const original=workflow(),old=JSON.stringify(original),p=N.patchWorkflow(original,{expectedVersionId:'fresh',expectedNodeHashes:expected(original)});
 assert.equal(JSON.stringify(original),old);for(const n of original.nodes)if(!p.changes.existingNodes.includes(n.name))assert.deepEqual(p.workflow.nodes.find(x=>x.name===n.name),n);
 const render=p.workflow.nodes.find(n=>n.name==='CRM Email Native render');assert.equal(render.parameters.url,'https://email.shrigma.com.br/api/templates/preview');assert.equal(render.retryOnFail,false);assert.equal(render.parameters.options.redirect.redirect.followRedirects,false);assert.equal(render.parameters.options.response.response.responseFormat,'text');assert.equal(render.parameters.options.response.response.outputPropertyName,'body');
 const read=p.workflow.nodes.find(n=>n.name==='CRM Email Native read');assert.equal(read.parameters.options.response.response.responseFormat,'json');assert.notEqual(read.parameters.options,render.parameters.options);assert.notEqual(read.parameters.options.response.response,render.parameters.options.response.response);
 assert.deepEqual(render.credentials,{httpBasicAuth:{id:'synthetic'}});
 assert.throws(()=>N.patchWorkflow(original,{expectedVersionId:'stale',expectedNodeHashes:expected(original)}),/matching/);assert.throws(()=>N.patchWorkflow(original,{expectedVersionId:'fresh',expectedNodeHashes:{}}),/hash/);
 const route=p.workflow.nodes.find(n=>n.name==='Prepara').parameters.jsCode;assert.ok(route.includes('crm_email_native_snapshot_v1'));assert.ok(route.includes('preview_token:b.preview_token'));
 for(const n of p.workflow.nodes.filter(n=>n.type==='n8n-nodes-base.code'))assert.doesNotThrow(()=>new vm.Script('(function(){'+n.parameters.jsCode+'})()'),n.name);
});
test('capabilities and illustrative preview require manager, exact method/shape and cannot generate transport or SQL',()=>{
 const env={acao:'email_capacidades',auth:{who:'panel:fixture',caps:['draft','validate','submit']},method:'GET',q:{acao:'email_capacidades'},b:{},out:(_http,_body)=>({json:{_http,_body}})};
 let r=run(N.ROUTES,env)[0].json;assert.equal(r._http,200);assert.equal(r._body.native_email_preview,true);assert.equal(r.sql,undefined);assert.equal(r.payload,undefined);
 for(const patch of [{auth:{who:'legacy',caps:env.auth.caps}},{auth:{who:'panel:fixture',caps:['read_content']}}])assert.equal(run(N.ROUTES,{...env,...patch})[0].json._http,403);
 assert.equal(run(N.ROUTES,{...env,method:'POST'})[0].json._http,405);assert.equal(run(N.ROUTES,{...env,q:{acao:'email_capacidades',k:'ignored'}})[0].json._http,400);
 assert.equal(run(N.ROUTES,{...env,acao:'email_previa',method:'POST',b:{acao:'email_previa',rascunho:{},recipient:'another@example.invalid'}})[0].json._http,400);
});
test('registration compile preserves original continuation, failure durably records 422 without a draft/native create statement; idem replay bypasses preview',()=>{
 const r={marca:'fish',canal:'email',nome:'fixture',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',preheader:'Fixture',assunto:'Example',corpo:'<p>{{ .Subscriber.Name }}</p>',botoes:[]};
 const c={acao:'rascunho',novo:true,crm23_manager:true,who:'panel:fixture',idem:'same-identity',corpoHash:'legacy',draft_id:'d_fixture',request_payload:{acao:'rascunho',rascunho:r,draft_id:null,expected_version:null,confirm:null},rascunho:r};
 const env={$:()=>({first:()=>({json:c})}),$input:{first:()=>({json:{}})}};
 let d=run(N.registrationGuard("return [{json:{_step:'pg_escrita',sql:'ORIGINAL_CREATE'}}];"),env)[0].json;
 assert.equal(d._step,'crm_email_native_compile');assert.equal(d.prepared.eligible,true);assert.equal(d.continuation.sql,'ORIGINAL_CREATE');assert.match(d.rejection.sql,/shrigma_template_apply_v2/);assert.match(d.rejection.sql,/422/);assert.match(d.rejection.sql,/insert into shrigma_api_idempotencia/);assert.doesNotMatch(d.rejection.sql,/insert into shrigma_template_draft|update shrigma_template_draft|claim_prepare/);
 d=run(N.registrationGuard("return [{json:{_step:'resposta',_http:201,_body:{_replay:true}}}];"),env)[0].json;assert.equal(d._body._replay,true);assert.equal(d.prepared,undefined);
});
test('native finish never forwards provider error HTML and never claims illustrative or compile requests',()=>{
 const env={$:()=>({first:()=>({json:{native_kind:'illustrative',prepared:{eligible:true,brand:'fish',data:{},subject:'Fixture',source_hash:'a'.repeat(64)}}})}),$json:{statusCode:500,body:'secret provider diagnostic'}};
 const d=run(N.FINISH,env)[0].json;assert.equal(d._step,'resposta');assert.equal(d._body.eligible,false);assert.equal(d._body.code,'native_preview_unconfirmed');assert.equal(JSON.stringify(d).includes('secret'),false);assert.equal(d.sql,undefined);
});

// n8n HttpRequestV3 (versions 3/4.x) emits the text body under the configured
// outputPropertyName, defaulting to data even for fullResponse. JSON uses body.
// Official source: https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts
function httpOutput(parameters,response){
 const option=parameters.options.response.response;assert.equal(option.fullResponse,true);
 if(option.responseFormat==='text')return {[option.outputPropertyName||'data']:typeof response.body==='object'?JSON.stringify(response.body):response.body,headers:response.headers,statusCode:response.statusCode,statusMessage:response.statusMessage};
 assert.equal(option.responseFormat,'json');return {...response,body:typeof response.body==='string'?JSON.parse(response.body):response.body};
}
test('real HTTP text/fullResponse representation reaches finish as body; native read remains a JSON object after serialization',()=>{
 const w=workflow(),patched=N.patchWorkflow(w,{expectedVersionId:'fresh',expectedNodeHashes:expected(w)}).workflow;
 const nodes=JSON.parse(JSON.stringify(patched.nodes)),render=nodes.find(n=>n.name==='CRM Email Native render'),read=nodes.find(n=>n.name==='CRM Email Native read');
 const context={native_kind:'illustrative',prepared:{eligible:true,brand:'fish',data:{},subject:'Fixture',source_hash:'a'.repeat(64)}},env={$:()=>({first:()=>({json:context})})};
 const response={statusCode:200,headers:{'content-type':'text/html'},statusMessage:'OK',body:'<p>Fixture</p>'};
 const legacy=JSON.parse(JSON.stringify(render.parameters));delete legacy.options.response.response.outputPropertyName;
 const failure=run(N.FINISH,{...env,$json:httpOutput(legacy,response)})[0].json;assert.equal(failure._body.code,'native_preview_unconfirmed');
 const result=run(N.FINISH,{...env,$json:httpOutput(render.parameters,response)})[0].json;assert.equal(result._body.eligible,true);assert.equal(result._body.body_html,response.body);assert.equal(result.sql,undefined);
 const template={data:{id:99,type:'tx',subject:'Fixture',body:'<p>Fixture</p>'}},readback=httpOutput(read.parameters,{...response,body:JSON.stringify(template)});assert.equal(typeof readback.body,'object');assert.deepEqual(readback.body,template);
 const changedRead=patched.nodes.find(n=>n.name===read.name),changedRender=patched.nodes.find(n=>n.name===render.name);changedRender.parameters.options.response.response.outputPropertyName='changed';assert.equal(changedRead.parameters.options.response.response.outputPropertyName,undefined);assert.equal(changedRead.parameters.options.response.response.responseFormat,'json');
});

test('registration wrapper preserves the original reservation context used by provider routing and native publication',()=>{
 const r={marca:'fish',canal:'email',nome:'fixture',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',preheader:'Fixture',assunto:'Example',corpo:'<p>{{ .Subscriber.Name }}</p>',botoes:[]};
 const payload={name:'fixture',type:'tx',subject:'Example',body:'<p>{{ .Subscriber.Name }}</p>'},draft={draft_id:'d_fixture',version:1,brand:'fish',rascunho:r};
 const original={_step:'meta_submeter',provider:'listmonk',claim_sql:'SYNTHETIC_RESERVE',draft,payload,payload_json:JSON.stringify(payload),idem:'fixture-key',who:'panel:fixture',draft_id:'d_fixture',corpoHash:'fixture-hash'};
 const ctx={acao:'submeter',crm23_manager:true,who:'panel:fixture',idem:'fixture-key',corpoHash:'fixture-hash',draft_id:'d_fixture'};
 const env={$:()=>({first:()=>({json:ctx})}),$input:{first:()=>({json:{draft}})}};
 const guarded=run(N.registrationGuard('return [{json:'+JSON.stringify(original)+'}];'),env)[0].json;
 assert.equal(guarded._step,'crm_email_native_compile');assert.equal(guarded.prepared.eligible,true);assert.equal(JSON.stringify(guarded.continuation),JSON.stringify(original));
 for(const [key,value]of Object.entries(original))if(key!=='_step')assert.equal(JSON.stringify(guarded[key]),JSON.stringify(value),key);
 const finish=run(N.FINISH,{$:()=>({first:()=>({json:guarded})}),$json:{statusCode:200,body:'<p>Fixture</p>'}})[0].json;assert.equal(JSON.stringify(finish),JSON.stringify(original));
 // Exact published Resultado reserva: it explicitly reads Decide escrita again,
 // rather than taking the restored continuation that reached the PG node.
 const reservation="const r=$input.first().json.result;return [{json:r?.ready?{...$('Decide escrita').first().json,claim_id:r.claim_id,_step:'transportar'}:{_step:'resposta',...(r||{_http:500,_body:{erro:'reserva_indisponivel'}})}}];";
 const reserved=run(reservation,{$:name=>{assert.equal(name,'Decide escrita');return{first:()=>({json:guarded})};},$input:{first:()=>({json:{result:{ready:true,claim_id:'fixture-claim'}}})}})[0].json;
 assert.equal(reserved._step,'transportar');assert.equal(reserved.claim_id,'fixture-claim');assert.equal(reserved.provider,'listmonk');assert.equal(reserved.payload_json,original.payload_json);assert.equal(reserved.draft_id,original.draft_id);assert.equal(reserved.draft.version,1);assert.deepEqual(JSON.parse(reserved.payload_json),payload);
 const rejected=run(N.FINISH,{$:()=>({first:()=>({json:guarded})}),$json:{statusCode:422,body:'native rejection'}})[0].json;assert.equal(rejected._step,'pg_escrita');assert.match(rejected.sql,/422/);assert.equal(rejected.provider,undefined);assert.equal(rejected.payload_json,undefined);
});
