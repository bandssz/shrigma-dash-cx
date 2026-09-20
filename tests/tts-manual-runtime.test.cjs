'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createController}=require('../n8n/tiktok/manual-decision.cjs'),{createRuntime}=require('../n8n/tiktok/manual-decision-runtime.cjs');
const P=require('../n8n/tiktok/manual-decision-workflow.cjs'),{RESPONSE_BODY,RESPONSE_CODE}=require('../n8n/tiktok/regra-action-patch.cjs');
const {SCHEMA,MIGRATION,id}=require('./tts-manual-decision-postgres.cjs');
const ids={get:id(801),options:id(802)},key='synthetic-write',token='synthetic-token';
const clone=x=>JSON.parse(JSON.stringify(x)),edge=n=>({node:n,type:'main',index:0});
function fixture(){
 const node=(name,type,parameters)=>({id:name,name,type:'n8n-nodes-base.'+type,typeVersion:type==='postgres'?2.4:2,position:[0,0],parameters});
 const validation=fs.readFileSync(require.resolve('../n8n/tiktok/acao_valida.js'),'utf8').replace('__SERVER_ONLY_TIKTOK_WRITE_KEY__',key);
 const execution=fs.readFileSync(require.resolve('../n8n/tiktok/acao_exec.js'),'utf8').replace('__SERVER_ONLY_TIKTOK_SHOP_SECRET__','synthetic-secret').replace(/const APP_KEY = '[^']+';/,"const APP_KEY = 'synthetic-app';").replace(/const CIPHER = \{[^\n]+\};/,"const CIPHER = {aristo:'synthetic-aristo',fish:'synthetic-fish'};");
 const w={id:'fixture-action',versionId:'fixture-version',active:true,activeVersionId:'fixture-version',settings:{executionOrder:'v1',timezone:'America/Sao_Paulo'},nodes:[node('POST acao','webhook',{httpMethod:'POST',path:'synthetic-tts-action',responseMode:'responseNode',options:{}}),node('Valida','code',{jsCode:validation}),node('Pegar tokens (Token Manager)','executeWorkflow',{workflowId:{value:'synthetic-tokens'},options:{waitForSubWorkflow:true}}),node('Executa acao','code',{jsCode:execution}),node('Grava','postgres',{operation:'executeQuery',query:'={{ $json.sql }}',options:{queryReplacement:'={{ $json.sqlParameters || [] }}'}}),node('Resposta','respondToWebhook',{respondWith:'text',responseBody:RESPONSE_BODY,options:{responseCode:RESPONSE_CODE}}),node('400','respondToWebhook',{respondWith:'json',responseBody:'={{ {erro:$json.error.message} }}',options:{responseCode:400}})],connections:{'POST acao':{main:[[edge('Valida')]]},Valida:{main:[[edge('Pegar tokens (Token Manager)')],[edge('400')]]},'Pegar tokens (Token Manager)':{main:[[edge('Executa acao')]]},'Executa acao':{main:[[edge('Grava')]]},Grava:{main:[[edge('Resposta')]]}}};
 w.nodes.find(n=>n.name==='Valida').onError='continueErrorOutput';w.nodes.find(n=>n.name==='Grava').credentials={postgres:{id:'synthetic-pg',name:'Synthetic isolated database'}};w.activeVersion={versionId:w.versionId,nodes:clone(w.nodes),connections:clone(w.connections)};return w;
}
const candidate=()=>{const w=fixture();return P.patchManual(w,{expectedVersion:w.versionId,expectedFingerprint:P.selectedFingerprint(w,P.ACTION_NODES),webhookIds:ids}).workflow;};
const body=(n=1)=>({k:key,acao:'revisar',operation_id:id(n),marca:'fish',application_id:String(n),resultado:'APPROVE',motivo_rejeicao:null,observacao:'synthetic',autor:'synthetic'});
function evaluate(expression,context){if(typeof expression!=='string'||!expression.startsWith('={{'))return expression;return vm.runInNewContext(expression.slice(3,-2),context);}
async function run(w,entry,input,options={}){
 const records=new Map(),events=[],calls={http:0,pg:[],tokens:0};let current=entry,items=[{json:input}],steps=0;
 const $=name=>({first:()=>{const x=records.get(name);if(!x?.length)throw Error('Unexecuted node '+name);return x[0];},all:()=>records.get(name)||[]});
 while(current){if(++steps>100)throw Error('Unexpected loop');const n=w.nodes.find(n=>n.name===current);assert.ok(n,current);const type=n.type.split('.').at(-1);let output=0,next=items;
  const context={$,$json:items[0]?.json,$input:{all:()=>items,first:()=>items[0]},$execution:{id:options.execution||'synthetic-execution'}};
  events.push(current);
  try{
   if(type==='code')next=await vm.runInNewContext(`(async function(){${n.parameters.jsCode}\n}).call({helpers:{}})`,context);
   else if(type==='switch'){const values=n.parameters.rules.values;output=values.findIndex(rule=>items[0]?.json._route===rule.conditions.conditions[0].rightValue);if(output<0)output=values.length;}
   else if(type==='executeWorkflow'){calls.tokens++;if(options.tokenError)throw Error('synthetic token failure');next=(options.tokenRows||[{loja:'fishermans',access_token:token}]).map(json=>({json}));}
   else if(type==='postgres'){
    const q=evaluate(n.parameters.query,context),args=evaluate(n.parameters.options.queryReplacement,context);calls.pg.push({node:current,query:q,args});
    if(options.store)next=(await options.store(q,JSON.parse(JSON.stringify(args)),current)).map(json=>({json}));else throw Error('Unexpected PostgreSQL');
   }else if(type==='httpRequest'){
    calls.http++;assert.equal(n.retryOnFail,false);assert.equal(n.parameters.options.redirect.redirect.followRedirects,false);assert.equal(n.parameters.contentType,'raw');assert.equal(n.parameters.options.response.response.outputPropertyName,'body');
    const url=new URL(evaluate(n.parameters.url,context)),sent=evaluate(n.parameters.body,context),headers=JSON.parse(evaluate(n.parameters.jsonHeaders,context));
    assert.equal(url.origin,'https://open-api.tiktokglobalshop.com');assert.match(url.pathname,/^\/affiliate_seller\/202409\/sample_applications\/[1-9][0-9]*\/review$/);assert.equal(headers['x-tts-access-token'],token);assert.equal(JSON.parse(sent).review_result,'APPROVE');
    assert.ok(events.indexOf('Manual reserva transporte')<events.indexOf(current));if(options.httpError)throw Error('synthetic private URL exception');next=[{json:options.httpResponse||{statusCode:200,body:JSON.stringify({code:0,request_id:'synthetic-receipt'})}}];
   }else if(type==='respondToWebhook'){return {status:evaluate(n.parameters.options.responseCode,context),body:n.parameters.respondWith==='noData'?null:evaluate(n.parameters.responseBody,context),calls,events,records};}
   else if(type!=='webhook')throw Error('Unknown node '+type);
  }catch(e){if(n.onError==='continueErrorOutput'){output=1;next=[{json:{error:{message:e.message}}}];}else throw e;}
  records.set(current,next);const edges=w.connections[current]?.main?.[output]||[];assert.equal(edges.length,1,'One next node expected at '+current+' output '+output);current=edges[0].node;items=next;
 }
 throw Error('Missing response');
}
async function database(){const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.exec(SCHEMA);await db.exec(MIGRATION);return db;}
async function syntheticEligible(db,n=1){await db.exec("UPDATE crm_tts_manual_control_v1 SET enabled=true,eligible_from=clock_timestamp()");await db.query("INSERT INTO crm_tts_amostra(marca,application_id,status,is_approvable,approve_expira_em,decisao) VALUES('fish',$1,'PENDING',true,clock_timestamp()+interval '1 day','fila_manual')",[String(n)]);}
function mockReady(w){const copy=clone(w);const n=copy.nodes.find(n=>n.name==='Manual preflight');n.parameters.jsCode=n.parameters.jsCode.replace('cutoverVerified:false,admissionVerified:false','cutoverVerified:true,admissionVerified:true');return copy;}
const store=db=>async(q,args)=>(await db.query(q,args)).rows;
const lookup=(w,db,n=1)=>run(w,'GET decisão manual',{headers:{'x-tts-write-key':key},query:{acao:'operacao',operation_id:id(n),marca:'fish',application_id:String(n)}},{store:store(db)});
test('fresh patch preserves the rule branch, existing credentials and original webhook, with a disabled bounded DAG',()=>{
 const old=fixture(),w=P.patchManual(old,{expectedVersion:old.versionId,expectedFingerprint:P.selectedFingerprint(old,P.ACTION_NODES),webhookIds:ids});
 assert.deepEqual(w.readiness,{cutoverVerified:false,admissionVerified:false});for(const name of ['POST acao','Pegar tokens (Token Manager)','Grava','Resposta','400'])assert.deepEqual(w.workflow.nodes.find(n=>n.name===name),old.nodes.find(n=>n.name===name));
 assert.equal(w.workflow.nodes.filter(n=>n.type.endsWith('.httpRequest')).length,1);assert.doesNotMatch(w.workflow.nodes.find(n=>n.name==='Executa acao').parameters.jsCode,/httpRequest|sample_applications/);
 for(const n of w.workflow.nodes.filter(n=>n.type.endsWith('.postgres')&&n.name!=='Grava')){assert.deepEqual(n.credentials,old.nodes.find(n=>n.name==='Grava').credentials);assert.equal(n.parameters.options.queryReplacement,'={{ $json.parameters }}');assert.equal(n.retryOnFail,false);assert.equal(n.alwaysOutputData,true);}
 assert.equal(w.workflow.settings.saveDataSuccessExecution,'none');assert.equal(w.workflow.settings.saveDataErrorExecution,'none');assert.equal(w.workflow.nodes.find(n=>n.name==='GET decisão manual').webhookId,ids.get);
 assert.deepEqual(old.nodes,old.activeVersion.nodes,'patch does not mutate the original export');
});
test('version, fingerprint, active snapshot, missing webhook IDs and signer drift refuse generation',()=>{
 const f=fixture(),opts={expectedVersion:f.versionId,expectedFingerprint:P.selectedFingerprint(f,P.ACTION_NODES),webhookIds:ids};for(const delta of [{expectedVersion:'old'},{expectedFingerprint:'0'.repeat(64)},{webhookIds:null}])assert.throws(()=>P.patchManual(f,{...opts,...delta}));
 const w=clone(f);w.activeVersionId='old';assert.throws(()=>P.patchManual(w,opts),/active/);
 const g=clone(f);g.nodes.find(n=>n.name==='Executa acao').parameters.jsCode=g.nodes.find(n=>n.name==='Executa acao').parameters.jsCode.replace("const BASE = 'https://open-api.tiktokglobalshop.com'","const BASE = 'https://other.invalid'");g.activeVersion.nodes=clone(g.nodes);assert.throws(()=>P.patchManual(g,{...opts,expectedFingerprint:P.selectedFingerprint(g,P.ACTION_NODES)}),/Signing/);
});
test('installed controls false refuse the manual POST before tokens or HTTP; authenticated GET and OPTIONS are read-only',async()=>{
 const db=await database(),w=candidate();try{
  const r=await run(w,'POST acao',{body:body()},{store:store(db)});assert.equal(r.status,409);assert.equal(r.body.code,'disabled');assert.equal(r.calls.tokens,0);assert.equal(r.calls.http,0);assert.equal(r.calls.pg.length,1);assert.equal(r.calls.pg[0].args[0],'claim');
  const get=await lookup(w,db);assert.equal(get.status,200);assert.equal(get.body.operation.state,'missing');assert.equal(get.calls.http,0);assert.equal(get.calls.pg[0].args[0],'get');
  const cap=await run(w,'GET decisão manual',{headers:{'x-tts-write-key':key},query:{acao:'capacidades'}});assert.equal(cap.body.write,false);assert.equal(cap.calls.pg.length,0);
  const denied=await run(w,'GET decisão manual',{headers:{'x-tts-write-key':'wrong'},query:{acao:'operacao'}});assert.equal(denied.status,401);assert.equal(denied.calls.pg.length,0);
  const options=await run(w,'OPTIONS decisão manual',{});assert.equal(options.status,204);assert.equal(options.calls.http,0);
 }finally{await db.close();}
});
test('both independent readiness gates remain false even if an isolated SQL fixture is enabled',async()=>{
 const db=await database();try{await syntheticEligible(db);const r=await run(candidate(),'POST acao',{body:body()},{store:store(db)});assert.equal(r.status,409);assert.equal(r.body.code,'blocked');assert.equal(r.calls.http,0);assert.deepEqual(r.calls.pg.map(x=>x.args[0]),['claim','finish']);assert.equal((await lookup(candidate(),db)).body.operation.state,'blocked');}finally{await db.close();}
});
test('synthetic ready DAG commits both reservations before its only HTTP and exact GET survives reload',async()=>{
 const db=await database(),w=mockReady(candidate());try{await syntheticEligible(db);const r=await run(w,'POST acao',{body:body()},{store:store(db)});assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(r.calls.http,1);assert.deepEqual(r.calls.pg.map(x=>x.args[0]),['claim','dispatch','finish']);
 const again=await run(w,'POST acao',{body:body()},{store:store(db),execution:'another-execution'});assert.equal(again.status,200);assert.equal(again.calls.http,0);assert.equal(again.calls.tokens,0);const get=await lookup(w,db);assert.equal(get.body.operation.state,'accepted');assert.equal(get.calls.http,0);
 }finally{await db.close();}
});
for(const loss of ['claim','dispatch','finish'])test('lost '+loss+' receipt leaves the durable state and never grants another transport',async()=>{
 const db=await database(),w=mockReady(candidate());try{await syntheticEligible(db);let lost=false;const r=await run(w,'POST acao',{body:body()},{store:async(q,args)=>{const rows=(await db.query(q,args)).rows;if(args[0]===loss&&!lost){lost=true;throw Error('lost');}return rows;}});assert.equal(r.status,503);assert.equal(r.calls.http,loss==='finish'?1:0);const get=await lookup(w,db);assert.equal(get.body.operation.state,{claim:'reserved',dispatch:'in_flight',finish:'accepted'}[loss]);const again=await run(w,'POST acao',{body:body()},{store:store(db)});assert.equal(again.calls.http,0);assert.equal(again.calls.tokens,0);
 }finally{await db.close();}
});
test('HTTP timeout, empty, contradicted or nonnumeric provider receipt is uncertain, without retry',async()=>{
 for(const option of [{httpError:true},{httpResponse:{statusCode:200,body:''}},{httpResponse:{statusCode:200,body:JSON.stringify({code:0,request_id:'x',error:{}})}},{httpResponse:{statusCode:200,body:JSON.stringify({code:'0',request_id:'x'})}}]){
 const db=await database(),w=mockReady(candidate());try{await syntheticEligible(db);const r=await run(w,'POST acao',{body:body()},{store:store(db),...option});assert.equal(r.status,503);assert.equal(r.calls.http,1);assert.equal((await lookup(w,db)).body.operation.state,'outcome_unknown');assert.equal((await run(w,'POST acao',{body:body()},{store:store(db)})).calls.http,0);}finally{await db.close();}
 }
});
test('missing/duplicate token blocks the permanent reservation, and unchanged rule path uses its original SQL contract',async()=>{
 for(const tokenRows of [[],[{loja:'fishermans',access_token:token},{loja:'fishermans',access_token:token}]]){const db=await database();try{await syntheticEligible(db);const r=await run(mockReady(candidate()),'POST acao',{body:body()},{store:store(db),tokenRows});assert.equal(r.body.code,'blocked');assert.equal(r.calls.http,0);}finally{await db.close();}}
 let calls=0;const r=await run(candidate(),'POST acao',{body:{k:key,acao:'regra',marca:'fish',autor:'synthetic',regra:{gmv_manual:1},esperado_atualizado_em:'2026-01-01'}},{store:async(q,args)=>{calls++;assert.match(q,/crm_tts_regra_patch_v1\(\$1::text,\$2::jsonb,\$3::text,\$4::text\)/);assert.deepEqual(args,['fish','{"gmv_manual":1}','synthetic','2026-01-01']);return [{regra_result:{ok:true,codigo:'regra_atualizada',linhas:[]}}];}});assert.equal(r.status,200);assert.equal(calls,1);assert.equal(r.calls.http,0);
});
test('pure bridge validates receipt identity, ownership, signature and malformed transport context without I/O',()=>{
 const C=createController(),M=createRuntime(C),p=C.normalize(body(),{actor_sha256:'a'.repeat(64),owner:'synthetic'});p.claim_token=id(2);
 assert.throws(()=>M.request({...p,owner:''},token,{}));assert.throws(()=>M.request(p,token,{base:'https://other.invalid'}));assert.throws(()=>M.bound({...p,request_payload:{...p.request_payload,marca:'aristo'}}));
 assert.equal(M.claim(p,{allowed:false,code:'untrusted_raw_error'}).response.status,503);
 assert.equal(M.providerReceipt({statusCode:200,body:'not json'}).kind,'outcome_unknown');
});
test('automatic patch removes commercial HTTP even for a frozen real snapshot and preserves dry classification, with parameterized log',()=>{
 const old={id:'fixture-auto',versionId:'v1',active:false,settings:{},nodes:P.AUTO_NODES.map(name=>({name,type:'n8n-nodes-base.'+(name==='Log'||name==='Decide'?'postgres':'code'),parameters:name==='Log'?{query:'={{ $json.sql }}',options:{}}:{jsCode:name.startsWith('Executa')?'const reais = decisoes.filter(d => !d.dry_run); await review();':'preserved'}})),connections:{}};
 const w=P.patchAutomatic(old,{expectedVersion:'v1',expectedFingerprint:P.selectedFingerprint(old,P.AUTO_NODES)}).workflow;
 for(const name of ['Monta decisão (SQL)','Decide'])assert.deepEqual(w.nodes.find(n=>n.name===name),old.nodes.find(n=>n.name===name));
 const c=w.nodes.find(n=>n.name.startsWith('Executa')).parameters.jsCode;assert.doesNotMatch(c,/httpRequest|await review|APP_SECRET|access_token/);let effects=0;const rows=[{application_id:'1',marca:'fish',decisao:'auto_aprovada',dry_run:false},{application_id:'2',marca:'fish',decisao:'fila_manual',dry_run:true}];
 const out=vm.runInNewContext(`(()=>{${c}})()`,{$:name=>({all:()=>rows.map(json=>({json})),first:()=>({json:{inicio:'2026-01-01T00:00:00Z'}})}),helpers:{httpRequest:()=>{effects++;}}})[0].json;assert.equal(out.executadas,0);assert.equal(out.bloqueadas,1);assert.equal(out.dry_run,1);assert.equal(out.erros.length,1);assert.equal(effects,0);assert.doesNotMatch(out.sql,/review executado|UPDATE crm_tts_amostra/);assert.equal(out.sqlParameters[2],false);
 assert.equal(P.dryOnly([rows[1]],'2026-01-01').sqlParameters[2],true);assert.equal(w.nodes.find(n=>n.name==='Log').parameters.options.queryReplacement,'={{ $json.sqlParameters }}');
});
