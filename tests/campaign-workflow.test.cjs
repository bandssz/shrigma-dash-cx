'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildWorkflow,PAGES_ORIGIN,AUTH_SQL,STORE_SQL,PROVIDER_SQL}=require('../n8n/growth/campaign-workflow');
const bundle='var ShrigmaCampaignRuntime={createRuntime(){return {start:async(auth,request,meta)=>({kind:"response",response:{status:200,body:{auth,request,meta}}}),resume:async(context,receipt,meta)=>({kind:"response",response:{status:200,body:{context,receipt,meta}}})}}};';
const options=()=>({webhookPath:'synthetic-campaign-api',listmonkOrigin:'https://listmonk.example.test',postgresCredential:{id:'pg-ref',name:'Existing PG'},listmonkCredential:{id:'lm-ref',name:'Existing Listmonk'},bundle});
const node=(w,name)=>w.nodes.find(n=>n.name===name);
async function code(w,name,json,{all=[{json}],linked={},latest=linked,executionId='server-execution',runIndex=0,runtimeDependency}={}){
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const fn=new AsyncFunction('$json','$input','$','$execution','$runIndex','runtimeDependency',node(w,name).parameters.jsCode);
 return fn(json,{all:()=>all},name=>({item:{json:linked[name]},all:()=>[{json:latest[name]}]}),{id:executionId},runIndex,runtimeDependency);
}
const receiptSource=(kind='store',id='trusted-effect')=>({effect:{kind,id},context:{executionId:'server-execution',pending:{id},transcript:[]}});

test('builder creates a separate inactive workflow with only fixed parameterized DB operations and existing credential references',()=>{
 const w=buildWorkflow(options());assert.equal(w.active,false);assert.equal(w.id,undefined);
 const pg=w.nodes.filter(n=>n.type==='n8n-nodes-base.postgres');assert.equal(pg.length,3);
 assert.deepEqual(pg.map(n=>n.parameters.query),[AUTH_SQL,STORE_SQL,PROVIDER_SQL]);assert.match(AUTH_SQL,/shrigma_template_auth_v2\(\$1::text\)/);
 for(const n of pg){assert.match(n.parameters.options.queryReplacement,/^=\{\{ \[/);assert.ok(!n.parameters.query.includes('$json'));assert.equal(n.retryOnFail,false);assert.deepEqual(n.credentials,{postgres:{id:'pg-ref',name:'Existing PG'}});}
 assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveExecutionProgress,false);
 const ids=new Set(w.nodes.map(n=>n.name));
 for(const [from,edges] of Object.entries(w.connections)){assert.ok(ids.has(from));for(const targets of edges.main)for(const target of targets)assert.ok(ids.has(target.node));}
});

test('webhooks reject SQL, transcript, caller identity and unexpected fields before auth; GET never mutates',async()=>{
 const w=buildWorkflow(options()),base={k:'synthetic-key',acao:'campanha_catalogo',brand:'fish'};
 for(const extra of [{sql:'SELECT 1'},{transcript:[]},{context:{}},{actor:'other'},{caps:['submit']},{effect:{kind:'nativeCreate'}}]){
  const out=await code(w,'Entrada',{method:'GET',request:{query:{...base,...extra}}});assert.equal(out[0].json._route,'response');assert.equal(out[0].json.response.status,422);
 }
 const getWrite=await code(w,'Entrada',{method:'GET',request:{query:{...base,acao:'campanha_salvar'}}});assert.equal(getWrite[0].json.response.status,405);
 const postRead=await code(w,'Entrada',{method:'POST',request:{body:base}});assert.equal(postRead[0].json.response.status,405);
 const evilOrigin=await code(w,'Entrada',{method:'GET',request:{query:base,headers:{origin:'https://other.example'}}});assert.equal(evilOrigin[0].json.response.status,403);
 const allowed=await code(w,'Entrada',{method:'GET',request:{query:base,headers:{origin:PAGES_ORIGIN}}});assert.equal(allowed[0].json._route,'auth');assert.equal(allowed[0].json.key,'synthetic-key');assert.ok(!Object.hasOwn(allowed[0].json.command,'k'));
 for(const id of [['1'],{},'9007199254740993','0','1.2']){
  const invalid=await code(w,'Entrada',{method:'GET',request:{query:{...base,id}}});assert.equal(invalid[0].json.response.status,422);
 }
 const validId=await code(w,'Entrada',{method:'GET',request:{query:{...base,id:'123'}}});assert.equal(validId[0].json.command.id,123);
 const unknownMethod=await code(w,'Entrada',{method:'PATCH',request:{body:base}});assert.equal(unknownMethod[0].json.response.status,405);
});

test('runtime starts only with verified identity, stripped command and server execution ID',async()=>{
 const w=buildWorkflow(options()),entry={key:'synthetic-secret',command:{acao:'campanha_catalogo',brand:'fish'}};
 const denied=await code(w,'Iniciar',{auth:null},{linked:{Entrada:entry}});assert.equal(denied[0].json.response.status,401);
 for(const auth of [{who:'',caps:['submit']},{who:'user',caps:[{submit:true}]}])assert.equal((await code(w,'Iniciar',{auth},{linked:{Entrada:entry}}))[0].json.response.status,401);
 const started=await code(w,'Iniciar',{auth:{who:'verified-user',caps:['read_content'],rotulo:'Editor'}},{linked:{Entrada:entry},executionId:'real-server-id'});
 assert.deepEqual(started[0].json.response.body,{auth:{actor:'verified-user',caps:['read_content']},request:entry.command,meta:{executionId:'real-server-id'}});
 assert.ok(!JSON.stringify(started).includes('synthetic-secret'));
 for(const name of ['Iniciar','Retomar'])assert.ok(!node(w,name).parameters.jsCode.includes('require('));
});

test('HTTP transport has fixed origin, only draft creation/preview, native credentials and no redirects or retries',()=>{
 const w=buildWorkflow(options()),http=w.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest');assert.equal(http.length,2);
 assert.equal(node(w,'Criar rascunho').parameters.url,'https://listmonk.example.test/api/campaigns');
 assert.equal(node(w,'Prévia').parameters.url,'=https://listmonk.example.test/api/campaigns/{{$json.effect.idCampaign}}/preview');
 for(const n of http){assert.equal(n.parameters.method,'POST');assert.equal(n.retryOnFail,false);assert.equal(n.parameters.options.redirect.redirect.followRedirects,false);assert.equal(n.parameters.options.response.response.fullResponse,true);assert.equal(n.parameters.options.response.response.outputPropertyName,'body');assert.equal(n.parameters.authentication,'genericCredentialType');assert.deepEqual(n.credentials,{httpBasicAuth:{id:'lm-ref',name:'Existing Listmonk'}});assert.ok(!n.parameters.url.includes('$json.url'));}
 const output=node(w,'Responde').parameters;assert.equal(output.responseBody,'={{ $json.response.body }}');assert.equal(output.options.responseCode,'={{ $json.response.status }}');
 const headers=output.options.responseHeaders.entries;assert.equal(headers.find(h=>h.name==='Access-Control-Allow-Origin').value,PAGES_ORIGIN);assert.equal(headers.find(h=>h.name==='Cache-Control').value,'no-store');assert.ok(!headers.some(h=>h.name==='Access-Control-Allow-Credentials'));
});

test('dispatcher refuses invalid internal effects; receipts only use context from its own matching node',async()=>{
 const w=buildWorkflow(options());
 for(const effect of [{id:'x',kind:'store',action:'execute_sql',payload:{}},{id:'x',kind:'nativeCreate',payload:{type:'regular',send_at:'2027-01-01'}},{id:'x',kind:'preview',idCampaign:'https://evil.test'}]){
  const out=await code(w,'Despacha',{kind:'effect',effect,context:{pending:{id:'x'}}});assert.equal(out[0].json._route,'response');
 }
 const own=receiptSource();
 const pg=await code(w,'Recibo PG',{result:{ok:true}},{linked:{Despacha:own}});assert.deepEqual(pg[0].json,{context:own.context,receipt:{effect_id:'trusted-effect',ok:true,value:{rows:[{result:{ok:true}}]}}});
 const empty=await code(w,'Recibo PG',{},{all:[],linked:{Despacha:own}});assert.equal(empty[0].json.context,null);
 const tooMany=await code(w,'Recibo PG',{result:{}},{all:[{json:{result:{}}},{json:{result:{}}}],linked:{Despacha:own}});assert.equal(tooMany[0].json.context,null);
});

test('trusted PostgreSQL rollback codes survive; HTTP/network errors never pretend nothing changed or leak raw errors',async()=>{
 const w=buildWorkflow(options()),own=receiptSource();
 for(const [codeValue,message] of [['P0001','VERSION_CONFLICT'],['40001','anything'],['55P03','anything']]){
  const out=await code(w,'Recibo erro PG',{error:{code:codeValue,message,headers:{authorization:'synthetic-secret'}}},{linked:{Despacha:own}});
  assert.equal(out[0].json.receipt.error.code,codeValue);assert.ok(!JSON.stringify(out).includes('synthetic-secret'));assert.equal(out[0].json.receipt.error.nothingChanged,undefined);
 }
 const unknown=await code(w,'Recibo erro PG',{error:{code:'ECONNRESET',message:'synthetic-secret'}},{linked:{Despacha:own}});assert.equal(unknown[0].json.receipt.error.code,undefined);assert.ok(!JSON.stringify(unknown).includes('synthetic-secret'));
 const httpOwn=receiptSource('nativeCreate');
 const http=await code(w,'Recibo erro HTTP',{error:{message:'synthetic-secret',nothingChanged:true}},{linked:{Despacha:httpOwn}});assert.equal(http[0].json.receipt.error.nothingChanged,undefined);assert.ok(!JSON.stringify(http).includes('synthetic-secret'));
 const response=await code(w,'Recibo HTTP',{statusCode:302,headers:{authorization:'synthetic-secret'},body:'redirect'},{linked:{Despacha:httpOwn}});assert.deepEqual(response[0].json.receipt.value,{status:302,body:'redirect'});assert.ok(!JSON.stringify(response).includes('synthetic-secret'));
});

test('builder refuses injected deployment URLs, raw credentials and invalid webhook paths',()=>{
 for(const origin of ['http://listmonk.example.test','https://user:pass@listmonk.example.test','https://listmonk.example.test/api','https://listmonk.example.test/?key=x'])assert.throws(()=>buildWorkflow({...options(),listmonkOrigin:origin}));
 assert.throws(()=>buildWorkflow({...options(),postgresCredential:{id:'x',name:'x',password:'synthetic-secret'}}));
 assert.throws(()=>buildWorkflow({...options(),webhookPath:'../status'}));
 assert.throws(()=>buildWorkflow({...options(),bundle:'missing bundle'}));
});

test('receipts fail closed on a stale iteration, missing pairing, wrong transport or different execution',async()=>{
 const w=buildWorkflow(options()),current=receiptSource(),stale=receiptSource('store','older-effect');
 for(const linked of [stale,undefined,{...current,context:{...current.context,executionId:'different-execution'}}]){
  const out=await code(w,'Recibo PG',{result:{ok:true}},{linked:{Despacha:linked},latest:{Despacha:current}});
  assert.deepEqual(out[0].json,{context:null,receipt:null});
 }
 const transport=await code(w,'Recibo HTTP',{statusCode:200,body:'rendered'},{linked:{Despacha:current}});assert.equal(transport[0].json.context,null);
 const {createRuntime}=require('../n8n/growth/campaign-runtime'),runtime=createRuntime();
 const step=await runtime.start({actor:'fixture',caps:['read_content']},{acao:'campanha_catalogo',brand:'fish'},{executionId:'server-execution'});
 const valid=await code(w,'Despacha',step);assert.equal(valid[0].json._route,'provider');
 const replay=await code(w,'Despacha',step,{runIndex:1});assert.equal(replay[0].json.response.status,503,'old context cannot dispatch again at a later loop index');
 const altered={...step,effect:{...step.effect,payload:{brand:'aristo'}}};
 assert.equal((await code(w,'Despacha',altered))[0].json.response.status,503,'pending effect and dispatch must agree in full');
});

test('generated nodes complete a multi-iteration save with native text response mapping, literal SQL parameters and no repeated transport',async()=>{
 const {createRuntime}=require('../n8n/growth/campaign-runtime'),now=Date.parse('2026-09-19T12:00:00Z');
 const runtimeDependency={createRuntime:()=>createRuntime({now:()=>now})};
 const w=buildWorkflow({...options(),bundle:'var ShrigmaCampaignRuntime=runtimeDependency; /* injected only by this test harness */'});
 const definition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},
  utm_campaign:'fixture',name:'Workflow fixture',subject:'Assunto',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',
  list_ids:[125],template_id:1,html:'<a href="https://fishermans.com.br/products/kit">Kit</a> {{ UnsubscribeURL }}',
  text:"O'Brien, café; $1; {{ UnsubscribeURL }}",tags:[],send_at:'2026-09-20T15:00:00-03:00'};
 const request={k:'synthetic-secret',acao:'campanha_salvar',brand:'fish',idempotency_key:'workflow-save-0001',definition};
 const entry=(await code(w,'Entrada',{method:'POST',request:{body:request}}))[0].json;
 let step=(await code(w,'Iniciar',{auth:{who:'fixture',caps:['draft']}},{linked:{Entrada:entry},runtimeDependency}))[0].json;
 const catalog={brand:'fish',current:true,lists:[{id:125,brand:'fish',available:true}],templates:[{id:1,type:'campaign',available:true,version:'template-v1'}],initiatives:[]};
 let campaign={id:100,version:'v1',status:'draft',sent:0,started_at:null,send_at:null,definition:{...definition,send_at:null}},hash;
 const calls=[],counts={create:0,preview:0,update:0};
 for(let iteration=0;step.kind==='effect';iteration++){
  assert.ok(iteration<64);
  const source=(await code(w,'Despacha',step,{runIndex:iteration}))[0].json;
  assert.ok(source.effect,'valid iteration produces exactly one effect');
  const e=source.effect;calls.push(e.kind+':'+(e.action||''));
  let transport,receiptNode;
  if(e.kind==='store'||e.kind==='provider'){
   const n=node(w,e.kind==='store'?'Store':'Provedor'),expression=n.parameters.options.queryReplacement.slice(3,-2).trim();
   const [action,payload]=new Function('$json','return '+expression)(source),p=JSON.parse(payload);
   assert.deepEqual(p,e.payload);assert.equal(n.parameters.query,e.kind==='store'?STORE_SQL:PROVIDER_SQL);
   let result;
   if(action==='claim'){hash=p.hash;result={id:'operation-1',hash,lease:'private-lease',acquired:true};}
   else if(action==='catalog')result=catalog;
   else if(action==='get')result=campaign;
   else if(action==='update'){counts.update++;campaign={...campaign,version:'v2',definition:p.definition,send_at:p.definition.send_at};result=campaign;assert.equal(p.definition.text,definition.text);}
   else if(['provider','validation_invalidate','finish'].includes(action))result={ok:true};
   else assert.fail('Unexpected operation '+action);
   transport={result};receiptNode='Recibo PG';
  }else if(e.kind==='nativeCreate'){
   counts.create++;assert.equal(e.payload.send_at,null);transport={statusCode:201,body:{data:{id:100}}};receiptNode='Recibo HTTP';
  }else{
   assert.equal(e.kind,'preview');counts.preview++;
   // HTTP Request v4.3 uses outputPropertyName for text even with fullResponse.
   const responseOptions=node(w,'Prévia').parameters.options.response.response;
   transport={statusCode:200,[responseOptions.outputPropertyName||'data']:'compiled fixture'};receiptNode='Recibo HTTP';
  }
  const receipt=(await code(w,receiptNode,transport,{linked:{Despacha:source},latest:{Despacha:source}}))[0].json;
  assert.equal(receipt.receipt.effect_id,e.id);
  step=(await code(w,'Retomar',receipt,{runtimeDependency}))[0].json;
 }
 assert.equal(step.response.status,201);assert.deepEqual(counts,{create:1,preview:3,update:1});
 assert.ok(calls.length>10,'store/provider/HTTP branches return to the same loop many times');
 assert.ok(!JSON.stringify(step).includes('private-lease'));assert.ok(!JSON.stringify(step).includes('synthetic-secret'));
});

test('generated cancellation nodes use only parameterized SQL; lost receipt retains the claim and a new HTTP execution never mutates again',async()=>{
 const {createRuntime}=require('../n8n/growth/campaign-runtime'),fixedNow=Date.parse('2026-09-19T12:00:00Z');
 const clone=v=>JSON.parse(JSON.stringify(v));
 for(const loseReceipt of [false,true]){
  const runtimeDependency={createRuntime:()=>createRuntime({now:()=>fixedNow})};
  const w=buildWorkflow({...options(),bundle:'var ShrigmaCampaignRuntime=runtimeDependency; /* test-only injection */'});
  const request={k:'synthetic-cancel-key',acao:'campanha_cancelar',brand:'fish',id:100,expected_version:'scheduled-v1',confirm:'cancelar',idempotency_key:'workflow-cancel-0001'};
  let campaign={id:100,version:'scheduled-v1',status:'scheduled',sent:0,started_at:null,send_at:'2030-09-20T15:00:00Z',definition:{brand:'fish'}},operation=null,cancellations=0;
  const calls=[];
  async function run(executionId){
   const meta={runtimeDependency,executionId};
   const entry=(await code(w,'Entrada',{method:'POST',request:{body:request}},meta))[0].json;assert.equal(entry._route,'auth');
   let step=(await code(w,'Iniciar',{auth:{who:'synthetic-canceller',caps:['submit','read_content']}},{...meta,linked:{Entrada:entry}}))[0].json;
   for(let iteration=0;step.kind==='effect';iteration++){
    assert.ok(iteration<64);
    const source=(await code(w,'Despacha',step,{...meta,runIndex:iteration}))[0].json,e=source.effect;
    assert.ok(e);assert.ok(['store','provider'].includes(e.kind),'cancellation must never use a native HTTP status route');calls.push(e.kind+':'+e.action);
    const sqlNode=node(w,e.kind==='store'?'Store':'Provedor'),expression=sqlNode.parameters.options.queryReplacement.slice(3,-2).trim();
    const [action,json]=new Function('$json','return '+expression)(source),p=JSON.parse(json);
    assert.equal(sqlNode.parameters.query,e.kind==='store'?STORE_SQL:PROVIDER_SQL);assert.deepEqual(p,e.payload);
    let result,transport,receiptNode='Recibo PG';
    if(e.kind==='store'&&action==='claim'){
     if(operation)result={...clone(operation),acquired:false,lease:null};
     else{operation={id:'cancel-operation',lease:'private-cancel-lease',hash:p.hash,brand:p.brand,action:p.action,state:'pending'};result={...operation,acquired:true};}
    }else if(e.kind==='provider'&&action==='get')result=clone(campaign);
    else if(e.kind==='provider'&&action==='cancel'){
     assert.equal(operation.state,'pending');assert.equal(operation.action,'cancelar');assert.equal(p.operationId,operation.id);assert.equal(p.expectedVersion,campaign.version);
     cancellations++;campaign={...campaign,status:'cancelled',version:'cancelled-v2'};operation.providerId=campaign.id;result=clone(campaign);
     if(loseReceipt){receiptNode='Recibo erro PG';transport={error:{code:'ECONNRESET',message:'private-transport-detail'}};}
    }else if(e.kind==='store'&&action==='finish'){
     assert.equal(operation.state,'pending');assert.equal(p.id,operation.id);assert.equal(p.lease,operation.lease);Object.assign(operation,clone(p));result={ok:true};
    }else assert.fail('Unexpected cancellation effect '+e.kind+':'+action);
    if(!transport)transport={result};
    const receipt=(await code(w,receiptNode,transport,{...meta,linked:{Despacha:source},latest:{Despacha:source}}))[0].json;
    assert.equal(receipt.receipt.effect_id,e.id);step=(await code(w,'Retomar',receipt,meta))[0].json;
   }
   assert.ok(!JSON.stringify(step).includes('private-cancel-lease'));assert.ok(!JSON.stringify(step).includes('synthetic-cancel-key'));assert.ok(!JSON.stringify(step).includes('private-transport-detail'));
   return step.response;
  }
  const get=(await code(w,'Entrada',{method:'GET',request:{query:request}}))[0].json;assert.equal(get.response.status,405);
  const first=await run('cancel-workflow-first');assert.equal(campaign.status,'cancelled');assert.equal(campaign.sent,0);assert.equal(campaign.started_at,null);assert.equal(cancellations,1);
  assert.equal(operation.state,loseReceipt?'outcome_unknown':'succeeded');assert.equal(operation.providerId,100);
  if(loseReceipt)assert.equal(first.body.error,'OUTCOME_UNKNOWN');else assert.equal(first.status,200);
  assert.deepEqual(await run('cancel-workflow-retry'),first);assert.equal(cancellations,1);assert.equal(calls.filter(c=>c==='provider:cancel').length,1);
 }
});
