'use strict';
const fs=require('node:fs'),path=require('node:path');
const MARKER='CRM_EMAIL_TEST_V1';
const protocol=fs.readFileSync(path.join(__dirname,'email-test-protocol.cjs'),'utf8').split('module.exports=')[0];
const email=fs.readFileSync(path.join(__dirname,'../../growth-email-contract.js'),'utf8').split("if(typeof module!=='undefined'&&module.exports)")[0];
const AUTH_ANCHOR='const valid=/^[A-Za-z0-9_.:-]{1,256}$/.test(k);';
const PREPARE_ANCHOR="if(!auth) return [out(401,{erro:'invalid_key'})];";
const ROUTE=`// ${MARKER}: fixed-recipient tests are exclusively Growth panel-manager operations.
if(['email_teste','email_teste_previa','email_teste_operacao'].includes(acao)){
 if(!auth.who?.startsWith('panel:')||!Array.isArray(auth.caps)||!['draft','validate','submit'].every(c=>auth.caps.includes(c)))return [out(403,{erro:'manager_required'})];
 if(method!==(acao==='email_teste'?'POST':'GET'))return [out(405,{erro:'metodo_invalido'})];
 const allowed=acao==='email_teste'?['acao','draft_id','expected_version','idempotency_key','confirm']:acao==='email_teste_previa'?['acao','draft_id','expected_version']:['acao','idempotency_key'];
 const input=acao==='email_teste'?b:q;if(Object.keys(input).some(k=>!allowed.includes(k)))return [out(400,{erro:'campos_invalidos'})];
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
 if(acao==='email_teste_operacao'){
  if(!uuid.test(q.idempotency_key||''))return [out(400,{erro:'identidade_obrigatoria'})];
  return [{json:{_step:'crm_email_test_read',sql:'SELECT public.crm_email_test_operation_v1($1::text,$2::uuid) AS result',sqlParameters:[auth.who,q.idempotency_key]}}];
 }
 const version=Number(input.expected_version),draft_id=input.draft_id;
 if(typeof draft_id!=='string'||!/^d_[A-Za-z0-9_-]{1,96}$/.test(draft_id)||!Number.isSafeInteger(version)||version<1||version>999999999)return [out(400,{erro:'versao_obrigatoria'})];
 if(acao==='email_teste'&&(typeof b.expected_version!=='number'||!uuid.test(b.idempotency_key||'')||b.confirm!=='enviar_teste'))return [out(400,{erro:'confirmacao_obrigatoria'})];
 const request_payload=acao==='email_teste'?{draft_id,expected_version:version,idempotency_key:b.idempotency_key,confirm:b.confirm}:null;
 return [{json:{_step:'crm_email_test_snapshot',email_test_action:acao,who:auth.who,request_payload,sql:'SELECT public.crm_email_test_snapshot_v1($1::text,$2::text,$3::integer) AS snapshot',sqlParameters:[auth.who,draft_id,version]}}];
}
`;
const PLAN=protocol+'\n'+email+`\nconst context=$('Prepara').first().json,selected=plan($json.snapshot,GEC);
if(context.email_test_action==='email_teste_previa')return [{json:{_step:'response',_http:200,_body:preview(selected)}}];
return [{json:{_step:'claim',sql:'SELECT public.crm_email_test_claim_v1($1::text,$2::jsonb,$3::jsonb) AS result',sqlParameters:[context.who,JSON.stringify(request(context.request_payload)),JSON.stringify(selected)]}}];`;
const CLAIM=`const result=$json.result;
if(result?.should_send===true&&result.operation_id&&result.dispatch_id&&result.claim_token&&result.payload)return [{json:{...result,_step:'send'}}];
return [{json:{_step:'response',...(result?.result||{_http:503,_body:{erro:'claim_unconfirmed'}})}}];`;
const FINISH=protocol+`\nconst claimed=$('CRM Email Test claim result').first().json;
return [{json:{sql:'SELECT public.crm_email_test_finish_v1($1::uuid,$2::uuid,$3::text) AS result',sqlParameters:[claimed.operation_id,claimed.claim_token,transportOutcome($json)]}}];`;
const RESPONSE="return [{json:($json.result||{_http:503,_body:{erro:'email_test_unconfirmed'}})}];";
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(!fresh||fresh.versionId!==expectedVersionId||!expectedVersionId||!Array.isArray(fresh.nodes))throw Error('Fresh matching workflow required');
 if(fresh.settings?.saveDataErrorExecution!=='none'||fresh.settings?.saveDataSuccessExecution!=='none'||fresh.settings?.saveManualExecutions!==false||fresh.settings?.saveExecutionProgress!==false)throw Error('Execution payload retention must already be disabled');
 const w=JSON.parse(JSON.stringify(fresh)),node=name=>{const rows=w.nodes.filter(n=>n.name===name);if(rows.length!==1)throw Error('Expected node '+name);return rows[0];};
 const auth=node('Autenticação entrada'),prepare=node('Prepara'),stage=node('Etapa'),pg=node('PG leitura'),provider=node('Listmonk criar template');
 if(w.nodes.some(n=>n.name.startsWith('CRM Email Test '))||prepare.parameters.jsCode.includes(MARKER))throw Error('Email test patch already present');
 let code=auth.parameters.jsCode;if(code.split(AUTH_ANCHOR).length!==2||code.split('const k=String(').length!==2||!code.includes("public.shrigma_crm_operator_auth_v1('"))throw Error('Auth anchors changed');
 code=code.replace('const k=String(','const legacyK=String(').replace(AUTH_ANCHOR,`// ${MARKER}: do not permit query/body keys or legacy template writers on new routes.
const emailTestRoute=['email_teste','email_teste_previa','email_teste_operacao'].includes(String(req.body?.acao||req.query?.acao||'').toLowerCase());
const k=emailTestRoute?String(req.headers?.origin&&req.headers.origin!=='https://bandssz.github.io'?'':typeof req.headers?.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7):''):legacyK;
${AUTH_ANCHOR}`);
 const oldSQL=`"select public.shrigma_crm_operator_auth_v1('"+k+"') as auth"`;
 if(code.split(oldSQL).length!==2)throw Error('Auth query changed');
 auth.parameters.jsCode=code.replace(oldSQL,`(emailTestRoute?"select public.shrigma_panel_operator_v1('"+k+"','growth') as auth":${oldSQL})`);
 if(prepare.parameters.jsCode.split(PREPARE_ANCHOR).length!==2)throw Error('Prepare anchor changed');prepare.parameters.jsCode=prepare.parameters.jsCode.replace(PREPARE_ANCHOR,PREPARE_ANCHOR+'\n'+ROUTE);
 if(pg.type!=='n8n-nodes-base.postgres'||pg.parameters.options?.queryReplacement!=='={{ $json.sqlParameters || [] }}'||!pg.credentials?.postgres)throw Error('Parameterized PG reference required');
 if(provider.type!=='n8n-nodes-base.httpRequest'||provider.parameters.url!=='https://email.shrigma.com.br/api/templates'||provider.parameters.method!=='POST'||provider.parameters.authentication!=='genericCredentialType'||provider.parameters.genericAuthType!=='httpBasicAuth'||!provider.credentials?.httpBasicAuth)throw Error('Native Listmonk credential reference required');
 const rule=(value)=>({conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'loose',version:2},conditions:[{leftValue:'={{ $json._step }}',rightValue:value,operator:{type:'string',operation:'equals'}}],combinator:'and'},renameOutput:true,outputKey:value});
 const edge=name=>({node:name,type:'main',index:0});
 function add(name,type,parameters,rest={}){if(w.nodes.some(n=>n.name===name))throw Error('Duplicate node '+name);const n={id:'crm-email-test-'+name.replace(/[^A-Za-z0-9]/g,'-').toLowerCase(),name,type,typeVersion:type==='n8n-nodes-base.code'?2:type==='n8n-nodes-base.switch'?3.2:type==='n8n-nodes-base.postgres'?pg.typeVersion:provider.typeVersion,position:[1200+(w.nodes.length%5)*240,1800+Math.floor(w.nodes.length/5)*160],parameters,...rest};w.nodes.push(n);return n;}
 const connect=(from,to)=>w.connections[from]={main:[[edge(to)]]};
 const addPG=name=>add(name,pg.type,JSON.parse(JSON.stringify(pg.parameters)),{credentials:JSON.parse(JSON.stringify(pg.credentials)),retryOnFail:false});
 addPG('CRM Email Test snapshot');addPG('CRM Email Test lookup');add('CRM Email Test plan','n8n-nodes-base.code',{jsCode:PLAN});
 add('CRM Email Test plan route','n8n-nodes-base.switch',{rules:{values:[rule('claim')]},options:{fallbackOutput:'extra'}});
 addPG('CRM Email Test claim');add('CRM Email Test claim result','n8n-nodes-base.code',{jsCode:CLAIM});
 add('CRM Email Test transport route','n8n-nodes-base.switch',{rules:{values:[rule('send')]},options:{fallbackOutput:'extra'}});
 add('CRM Email Test transport',provider.type,{method:'POST',url:'https://email.shrigma.com.br/api/tx',authentication:'genericCredentialType',genericAuthType:'httpBasicAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json.payload) }}',options:{timeout:20000,redirect:{redirect:{followRedirects:false}},response:{response:{fullResponse:true,neverError:true}}}},{credentials:JSON.parse(JSON.stringify(provider.credentials)),retryOnFail:false,onError:'continueRegularOutput'});
 add('CRM Email Test finish payload','n8n-nodes-base.code',{jsCode:FINISH});addPG('CRM Email Test finish');add('CRM Email Test response','n8n-nodes-base.code',{jsCode:RESPONSE});
 const rules=stage.parameters.rules?.values,outputs=w.connections.Etapa?.main;
 if(!Array.isArray(rules)||!Array.isArray(outputs)||outputs.length!==rules.length+1||stage.parameters.options?.fallbackOutput!=='extra')throw Error('Stage routing changed');
 for(const [step,target]of [['crm_email_test_snapshot','CRM Email Test snapshot'],['crm_email_test_read','CRM Email Test lookup']]){outputs.splice(rules.length,0,[edge(target)]);rules.push(rule(step));}
 connect('CRM Email Test snapshot','CRM Email Test plan');connect('CRM Email Test plan','CRM Email Test plan route');
 w.connections['CRM Email Test plan route']={main:[[edge('CRM Email Test claim')],[edge('Responde')]]};connect('CRM Email Test claim','CRM Email Test claim result');connect('CRM Email Test claim result','CRM Email Test transport route');
 w.connections['CRM Email Test transport route']={main:[[edge('CRM Email Test transport')],[edge('Responde')]]};connect('CRM Email Test transport','CRM Email Test finish payload');connect('CRM Email Test finish payload','CRM Email Test finish');connect('CRM Email Test finish','CRM Email Test response');connect('CRM Email Test lookup','CRM Email Test response');connect('CRM Email Test response','Responde');
 return {workflow:w,changes:{existingNodes:['Autenticação entrada','Prepara','Etapa'],newNodes:w.nodes.filter(n=>n.name.startsWith('CRM Email Test ')).map(n=>n.name),scope:'CRM05 fixed-recipient email tests only'}};
}
module.exports={MARKER,AUTH_ANCHOR,PREPARE_ANCHOR,ROUTE,PLAN,CLAIM,FINISH,RESPONSE,patchWorkflow};
