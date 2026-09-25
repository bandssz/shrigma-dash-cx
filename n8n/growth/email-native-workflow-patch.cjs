'use strict';
// Pure CRM23 incremental workflow builder. No credentials, remote calls or deployment.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {ROUTE:OLD_ROUTE}=require('./email-test-workflow-patch.cjs');
const read=(file)=>fs.readFileSync(file,'utf8');
const strip=s=>s.split("if(typeof module!=='undefined'&&module.exports)")[0].split('module.exports=')[0];
const GEE=strip(read(process.env.CRM_EMAIL_EXPRESSIONS_MODULE||path.join(__dirname,'../../growth-email-expressions.js')));
const GEC=strip(read(process.env.CRM_EMAIL_CONTRACT_MODULE||path.join(__dirname,'../../growth-email-contract.js')));
const ENP=strip(read(path.join(__dirname,'email-native-preview.cjs'))),ENTP=strip(read(path.join(__dirname,'email-native-test-protocol.cjs')));
const HASH=read(path.join(__dirname,'template-operation-receipt.cjs')).split('function safePayload(')[0];
const LEGACY='const ETP=(()=>{'+strip(read(path.join(__dirname,'email-test-protocol.cjs')))+';return {request,plan,preview};})();';
const BUNDLE=GEE+'\n'+GEC+'\n'+HASH+'\n'+ENP+'\n'+ENTP;
const MARKER='CRM_EMAIL_NATIVE_PREVIEW_V1';
const CAPABILITIES={contract:'crm_email_native_preview_v1',policy_version:1,brands:['fish','aristo'],native_email_preview:true,native_email_derive:true,native_email_test:true};
const ROUTES=`// ${MARKER}: the route itself is the authenticated capability gate; no login/shared flags.
if(['email_capacidades','email_previa'].includes(acao)){
 if(!auth.who?.startsWith('panel:')||!Array.isArray(auth.caps)||!['draft','validate','submit'].every(c=>auth.caps.includes(c)))return [out(403,{erro:'manager_required'})];
 if(acao==='email_capacidades'){
  if(method!=='GET')return [out(405,{erro:'metodo_invalido'})];
  if(Object.keys(q).some(k=>k!=='acao'))return [out(400,{erro:'campos_invalidos'})];
  return [out(200,${JSON.stringify(CAPABILITIES)})];
 }
 if(method!=='POST')return [out(405,{erro:'metodo_invalido'})];
 if(Object.keys(b).sort().join(',')!=='acao,rascunho')return [out(400,{erro:'campos_invalidos'})];
 return [{json:{_step:'crm_email_native_preview',native_kind:'illustrative',prepared:ENP.prepare(b.rascunho,{GEC,GEE,digest})}}];
}
`;
const PLAN=BUNDLE+'\n'+LEGACY+`
const context=$('Prepara').first().json,envelope=$json.snapshot;
let extended=!!context.request_payload?.preview_token;
if(envelope?.eligible){try{extended=ENP.needsNativeTest(envelope.snapshot.rascunho,{GEC,GEE});}catch{extended=true;}}
if(extended&&envelope?.eligible){
 if(context.email_test_action==='email_teste'){try{ENTP.request(context.request_payload);}catch{return [{json:{_step:'response',_http:400,_body:{erro:'native_preview_required'}}}];}}
 return [{json:{_step:'native_read',envelope}}];
}
const selected=extended?{eligible:false,code:envelope?.code||'snapshot_unavailable'}:ETP.plan(envelope?.snapshot||envelope,GEC);
if(context.email_test_action==='email_teste_previa')return [{json:{_step:'response',_http:200,_body:extended?ENTP.preview(selected):ETP.preview(selected)}}];
let payload;try{payload=extended?ENTP.request(context.request_payload):ETP.request(context.request_payload);}catch{return [{json:{_step:'response',_http:400,_body:{erro:'campos_invalidos'}}}];}
return [{json:{_step:'claim',sql:'SELECT public.'+(extended?'crm_email_native_claim_v1':'crm_email_test_claim_v1')+'($1::text,$2::jsonb,$3::jsonb) AS result',sqlParameters:[context.who,JSON.stringify(payload),JSON.stringify(selected)]}}];`;
const TEST_PREPARE=BUNDLE+`
const envelope=$('CRM Email Test plan').first().json.envelope;
return [{json:{native_kind:'test',prepared:ENTP.prepare(envelope,$json,{ENP,GEC,GEE,digest})}}];`;
const REQUEST="return [{json:{...$json,_native_ready:$json.prepared?.eligible===true?'yes':'no'}}];";
const FINISH=BUNDLE+`
const ctx=$('CRM Email Native request').first().json;
const result=ctx.native_kind==='test'?ENTP.rendered(ctx.prepared,$json,{ENP,GEC}):ENP.accept(ctx.prepared,$json,{GEC});
if(ctx.native_kind==='test'){
 const c=$('Prepara').first().json;
 if(c.email_test_action==='email_teste_previa')return [{json:{_step:'resposta',_http:200,_body:ENTP.preview(result)}}];
 return [{json:{_step:'crm_email_native_claim',sql:'SELECT public.crm_email_native_claim_v1($1::text,$2::jsonb,$3::jsonb) AS result',sqlParameters:[c.who,JSON.stringify(ENTP.request(c.request_payload)),JSON.stringify(result)]}}];
}
if(ctx.native_kind==='compile')return [{json:result.eligible?ctx.continuation:ctx.rejection}];
return [{json:{_step:'resposta',_http:200,_body:result}}];`;
const sha=s=>createHash('sha256').update(s).digest('hex');
const once=(s,a,b)=>{if(s.split(a).length!==2)throw Error('CRM23 exact anchor drift');return s.replace(a,b);};
function replaceContract(code){const mark='// CRM_EMAIL_ENVELOPE_V1\n',end='// Email drafts become new Listmonk templates. Existing production IDs are immutable here.';
 const begin=code.indexOf(mark)+mark.length,at=code.indexOf(end,begin);if(code.split(mark).length!==2||code.split(end).length!==2||at<=begin)throw Error('CRM23 envelope anchors changed');return code.slice(0,begin)+BUNDLE+'\n'+code.slice(at);}
function registrationGuard(original){
 return `// ${MARKER}: preserve existing CAS/idempotency decisions; compile before any extended write/claim.
${BUNDLE}
function originalDecision(){\n${original}\n}
const decisions=originalDecision(),d=decisions[0]?.json,c=$('Prepara').first().json,row=$input.first().json||{},draft=row.draft||null;
const r=c.acao==='rascunho'?c.rascunho:draft?.rascunho;
if(!d||!['pg_escrita','meta_submeter'].includes(d._step)||!['rascunho','validar','submeter'].includes(c.acao)||r?.canal!=='email')return decisions;
let native=false;try{native=ENP.needsNativeTest(r,{GEC,GEE});}catch{native=true;}
if(!native)return decisions;
const prepared=c.crm23_manager===true?ENP.prepare(r,{GEC,GEE,digest},{purpose:'compile'}):{eligible:false,code:'manager_required'};
const body={erro:'native_preview_required',erros:[{codigo:'EMAIL_NATIVE_PREVIEW',campo:'corpo',mensagem:'A compilação segura do e-mail não foi confirmada. Revise o conteúdo e consulte esta tentativa.'}]};
const quote=v=>"'"+String(v).replace(/'/g,"''")+"'",jsonb=v=>quote(JSON.stringify(v).replace(/\\{\\{/g,'\\\\u007b\\\\u007b').replace(/\\}\\}/g,'\\\\u007d\\\\u007d'))+'::jsonb';
const insert='insert into shrigma_api_idempotencia(chave,rota,corpo_hash,resposta) values ('+quote(c.idem)+','+quote(c.acao)+','+quote(c.corpoHash)+','+jsonb({status:422,body})+')';
const rejection={_step:'pg_escrita',sql:'select public.shrigma_template_apply_v2('+jsonb({ctx:{...c,snapshot:draft},status:422,body,statements:[insert]})+') as result'};
return [{json:{_step:'crm_email_native_compile',native_kind:'compile',prepared,continuation:d,rejection}}];`;
}
function patchWorkflow(fresh,{expectedVersionId,expectedNodeHashes}={}){
 if(!expectedVersionId||fresh?.versionId!==expectedVersionId||!Array.isArray(fresh.nodes))throw Error('Fresh matching workflow required');
 if(fresh.settings?.saveDataErrorExecution!=='none'||fresh.settings?.saveDataSuccessExecution!=='none'||fresh.settings?.saveManualExecutions!==false||fresh.settings?.saveExecutionProgress!==false)throw Error('Execution payload retention must already be disabled');
 const w=JSON.parse(JSON.stringify(fresh)),node=name=>{const ns=w.nodes.filter(n=>n.name===name);if(ns.length!==1)throw Error('Expected node '+name);return ns[0];};
 const affected=['Autenticação entrada','Prepara','Decide escrita','Etapa','CRM Email Test plan','CRM Email Test plan route'];
 for(const name of affected)if(!expectedNodeHashes?.[name]||sha(JSON.stringify(node(name)))!==expectedNodeHashes[name])throw Error('CRM23 node hash mismatch: '+name);
 if(w.nodes.some(n=>n.name.startsWith('CRM Email Native '))||node('Prepara').parameters.jsCode.includes(MARKER))throw Error('CRM23 patch already present');
 const auth=node('Autenticação entrada'),prepare=node('Prepara'),decide=node('Decide escrita'),stage=node('Etapa'),pg=node('CRM Email Test claim'),provider=node('Listmonk criar template');
 if(provider.type!=='n8n-nodes-base.httpRequest'||provider.parameters.url!=='https://email.shrigma.com.br/api/templates'||!provider.credentials?.httpBasicAuth||provider.parameters.genericAuthType!=='httpBasicAuth')throw Error('Native provider anchor changed');
 const oldList="['email_teste','email_teste_previa','email_teste_operacao']";
 auth.parameters.jsCode=once(auth.parameters.jsCode,oldList,"['email_teste','email_teste_previa','email_teste_operacao','email_previa','email_capacidades']");
 let route=OLD_ROUTE.replace("['acao','draft_id','expected_version','idempotency_key','confirm']","['acao','draft_id','expected_version','idempotency_key','confirm','preview_token']").replace('confirm:b.confirm}:null','confirm:b.confirm,...(Object.hasOwn(b,\'preview_token\')?{preview_token:b.preview_token}:{})}:null').replace('public.crm_email_test_snapshot_v1','public.crm_email_native_snapshot_v1');
 prepare.parameters.jsCode=once(replaceContract(prepare.parameters.jsCode),OLD_ROUTE,ROUTES+route);
 prepare.parameters.jsCode=once(prepare.parameters.jsCode,"const ctx={acao,who:auth.who,method,wabas:WABA,","const ctx={acao,who:auth.who,method,wabas:WABA,crm23_manager:typeof req.headers?.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')&&auth.who?.startsWith('panel:')&&['draft','validate','submit'].every(x=>auth.caps?.includes(x)),");
 // The original decision keeps all legacy branching. Its GEC declaration is removed in favor of the guarded bundle above.
 const embeddedStart=decide.parameters.jsCode.indexOf('// CRM_EMAIL_ENVELOPE_V1\n'),embeddedEnd=decide.parameters.jsCode.indexOf('// Email drafts become new Listmonk templates.',embeddedStart);
 if(embeddedStart<0||embeddedEnd<=embeddedStart)throw Error('Decision contract anchors changed');
 const original=decide.parameters.jsCode.slice(0,embeddedStart)+decide.parameters.jsCode.slice(embeddedEnd);
 decide.parameters.jsCode=registrationGuard(original);
 node('CRM Email Test plan').parameters.jsCode=PLAN;
 const edge=name=>({node:name,type:'main',index:0});
 const rule=(value,key='_step')=>({conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'loose',version:2},conditions:[{leftValue:'={{ $json.'+key+' }}',rightValue:value,operator:{type:'string',operation:'equals'}}],combinator:'and'},renameOutput:true,outputKey:value});
 function add(name,type,parameters,rest={}){const n={id:'crm23-'+name.replace(/[^A-Za-z0-9]/g,'-').toLowerCase(),name,type,typeVersion:type==='n8n-nodes-base.code'?2:type==='n8n-nodes-base.switch'?3.2:provider.typeVersion,position:[1200+(w.nodes.length%5)*240,3400+Math.floor(w.nodes.length/5)*160],parameters,...rest};w.nodes.push(n);return n;}
 const code=(name,jsCode)=>add(name,'n8n-nodes-base.code',{jsCode});const sw=(name,rules)=>add(name,'n8n-nodes-base.switch',{rules:{values:rules},options:{fallbackOutput:'extra'}});
 const connect=(from,to)=>w.connections[from]={main:[[edge(to)]]};
 const options={timeout:15000,redirect:{redirect:{followRedirects:false}},response:{response:{fullResponse:true,neverError:true}}};
 const http=(name,parameters)=>add(name,provider.type,{authentication:'genericCredentialType',genericAuthType:'httpBasicAuth',options,...parameters},{credentials:JSON.parse(JSON.stringify(provider.credentials)),retryOnFail:false,onError:'continueRegularOutput'});
 http('CRM Email Native read',{method:'GET',url:"={{ 'https://email.shrigma.com.br/api/templates/' + $json.envelope.snapshot.native.id }}"});
 code('CRM Email Native test prepare',TEST_PREPARE);code('CRM Email Native request',REQUEST);sw('CRM Email Native ready',[rule('yes','_native_ready')]);
 http('CRM Email Native render',{method:'POST',url:'https://email.shrigma.com.br/api/templates/preview',sendBody:true,contentType:'form-urlencoded',bodyParameters:{parameters:[{name:'template_type',value:'tx'},{name:'body',value:'={{ $json.prepared.request.form.body }}'}]}});
 // /preview returns HTML rather than JSON; never parse or expose a provider error body.
 node('CRM Email Native render').parameters.options.response.response.responseFormat='text';
 code('CRM Email Native finish',FINISH);sw('CRM Email Native final route',[rule('crm_email_native_claim')]);sw('CRM Email Native registration route',[rule('crm_email_native_compile')]);
 const stageRules=stage.parameters.rules.values,stageOutputs=w.connections.Etapa?.main;
 if(stageOutputs?.length!==stageRules.length+1||stage.parameters.options?.fallbackOutput!=='extra')throw Error('Stage route drift');
 stageOutputs.splice(stageRules.length,0,[edge('CRM Email Native request')]);stageRules.push(rule('crm_email_native_preview'));
 const planRoute=node('CRM Email Test plan route'),pr=planRoute.parameters.rules.values,po=w.connections[planRoute.name]?.main;
 if(po?.length!==pr.length+1||pr.length!==1||pr[0].outputKey!=='claim')throw Error('Test plan route drift');po.splice(pr.length,0,[edge('CRM Email Native read')]);pr.push(rule('native_read'));
 if(JSON.stringify(w.connections['Decide escrita'])!==JSON.stringify({main:[[edge('Escrita →')]]}))throw Error('Registration edge drift');
 connect('Decide escrita','CRM Email Native registration route');w.connections['CRM Email Native registration route']={main:[[edge('CRM Email Native request')],[edge('Escrita →')]]};
 connect('CRM Email Native read','CRM Email Native test prepare');connect('CRM Email Native test prepare','CRM Email Native request');connect('CRM Email Native request','CRM Email Native ready');
 w.connections['CRM Email Native ready']={main:[[edge('CRM Email Native render')],[edge('CRM Email Native finish')]]};connect('CRM Email Native render','CRM Email Native finish');connect('CRM Email Native finish','CRM Email Native final route');
 w.connections['CRM Email Native final route']={main:[[edge(pg.name)],[edge('Escrita →')]]};
 return {workflow:w,changes:{existingNodes:affected,newNodes:w.nodes.filter(n=>n.name.startsWith('CRM Email Native ')).map(n=>n.name),scope:'Growth Fish/Aristo safe native email preview, compile and fixed-recipient tests; no additional transport'}};
}
module.exports={MARKER,CAPABILITIES,BUNDLE,ROUTES,PLAN,TEST_PREPARE,REQUEST,FINISH,registrationGuard,patchWorkflow,sha};
