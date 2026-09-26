'use strict';
// Pure additive v2 patch. No deployment, secrets or remote calls.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const strip=s=>s.split("if(typeof module!=='undefined'&&module.exports)")[0].split('module.exports=')[0];
const read=f=>fs.readFileSync(path.join(__dirname,f),'utf8');
const BUNDLE=strip(read('../../growth-email-expressions.js'))+'\n'+strip(read('../../growth-email-contract.js'))+'\n'+read('template-operation-receipt.cjs').split('function safePayload(')[0]+'\n'+strip(read('email-native-preview.cjs'))+'\n'+strip(read('email-test-recipient-protocol.cjs'));
const ETR=require('./email-test-recipient-protocol.cjs');
const ACTIONS=['email_teste_capacidades_v2','email_teste_testadores_v2','email_teste_testador_v2','email_teste_previa_v2','email_teste_v2','email_teste_operacao_v2'];
const MARKER='CRM_EMAIL_TEST_RECIPIENT_V2';
const ROUTE=`// ${MARKER}: authenticated manager only; recipient never travels in query strings.
if(${JSON.stringify(ACTIONS)}.includes(acao)){
 if(!auth.who?.startsWith('panel:')||!Array.isArray(auth.caps)||!['draft','validate','submit'].every(c=>auth.caps.includes(c)))return [out(403,{erro:'manager_required'})];
 const writes=['email_teste_testador_v2','email_teste_previa_v2','email_teste_v2'].includes(acao);
 if(method!==(writes?'POST':'GET'))return [out(405,{erro:'metodo_invalido'})];
 const src=writes?b:q,p={...src};delete p.acao;
 if(['email_teste_previa_v2','email_teste_v2','email_teste_testador_v2'].includes(acao)){const address=(${ETR.normalize.toString()})(p.recipient);if(!address)return [out(400,{erro:'recipient_invalid'})];p.recipient=address;}
 if(['email_teste_previa_v2','email_teste_v2'].includes(acao)&&(!/^d_[A-Za-z0-9_-]{1,96}$/.test(p.draft_id||'')||!Number.isSafeInteger(p.expected_version)||p.expected_version<1||p.expected_version>999999999))return [out(400,{erro:'campos_invalidos'})];
 if(acao==='email_teste_v2'&&(p.confirm!=='enviar_teste'||!/^[a-f0-9]{64}$/.test(p.preview_token||'')||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(p.idempotency_key||'')))return [out(400,{erro:'campos_invalidos'})];
 if(['email_teste_testadores_v2','email_teste_testador_v2'].includes(acao)&&!['fish','aristo'].includes(p.brand))return [out(400,{erro:'brand_unavailable'})];
 const sqls={email_teste_capacidades_v2:['SELECT public.crm_email_test_capabilities_v2($1::text) AS result',[],[]],email_teste_testadores_v2:['SELECT public.crm_email_test_testers_v2($1::text,$2::text) AS result',['brand'],[p.brand]],email_teste_testador_v2:['SELECT public.crm_email_test_set_tester_v2($1::text,$2::text,$3::text,$4::boolean) AS result',['brand','enabled','recipient'],[p.brand,p.recipient,p.enabled]],email_teste_previa_v2:['SELECT public.crm_email_test_prepare_v2($1::text,$2::jsonb) AS result',['draft_id','expected_version','recipient'],[JSON.stringify(p)]],email_teste_v2:['SELECT public.crm_email_test_review_v2($1::text,$2::jsonb) AS result',['confirm','draft_id','expected_version','idempotency_key','preview_token','recipient'],[JSON.stringify(p)]],email_teste_operacao_v2:['SELECT public.crm_email_test_operation_v2($1::text,$2::uuid) AS result',['idempotency_key'],[p.idempotency_key]]};
 const spec=sqls[acao];if(Object.keys(p).sort().join(',')!==spec[1].slice().sort().join(','))return [out(400,{erro:'campos_invalidos'})];
 if(acao==='email_teste_testador_v2'&&(typeof p.enabled!=='boolean'||typeof p.recipient!=='string'||p.recipient.length>254))return [out(400,{erro:'campos_invalidos'})];
 if(acao==='email_teste_operacao_v2'&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(p.idempotency_key||''))return [out(400,{erro:'campos_invalidos'})];
 return [{json:{_step:'crm_email_recipient',who:auth.who,email_test_action:acao,request_payload:p,sql:spec[0],sqlParameters:[auth.who,...spec[2]]}}];
}
`;
const INITIAL=`const c=$('Prepara').first().json,r=$json.result;
if(r?._http)return [{json:{_step:'response',...r}}];
if(r?.eligible===true)return [{json:{_step:'read',envelope:r}}];
if(c.email_test_action==='email_teste_v2')return [{json:{_step:'claim',sql:'SELECT public.crm_email_test_claim_v2($1::text,$2::jsonb,$3::jsonb) AS result',sqlParameters:[c.who,JSON.stringify(c.request_payload),JSON.stringify({eligible:false,code:r?.code||'snapshot_unavailable'})]}}];
return [{json:{_step:'response',_http:200,_body:{contract:'crm_email_test_recipient_v2',eligible:false,code:r?.code||'snapshot_unavailable'}}}];`;
const PREPARE=BUNDLE+`\nconst envelope=$('CRM Email Recipient initial').first().json.envelope;const prepared=ETR.prepare(envelope,$json,{ENP,GEC,GEE,digest});return [{json:{prepared,_step:prepared.eligible?'render':'finish'}}];`;
const RENDERED=BUNDLE+`\nconst c=$('Prepara').first().json,p=$('CRM Email Recipient prepare').first().json.prepared;const prepared=ETR.rendered(p,$json,{ENP,GEC});
if(c.email_test_action==='email_teste_v2')return [{json:{_step:'claim',sql:'SELECT public.crm_email_test_claim_v2($1::text,$2::jsonb,$3::jsonb) AS result',sqlParameters:[c.who,JSON.stringify(c.request_payload),JSON.stringify(prepared)]}}];
if(!prepared.eligible)return [{json:{_step:'response',_http:200,_body:ETR.preview(prepared)}}];
return [{json:{_step:'seal',preview:ETR.preview(prepared),sql:'SELECT public.crm_email_test_preview_finish_v2($1::text,$2::text,$3::jsonb) AS result',sqlParameters:[c.who,prepared.preview_token,JSON.stringify(prepared)]}}];`;
const SEAL=`const proof=$json.result,p=$('CRM Email Recipient rendered').first().json.preview;return [{json:{_http:200,_body:proof?.eligible===true?p:{contract:'crm_email_test_recipient_v2',eligible:false,code:proof?.code||'preview_changed'}}}];`;
const FINISH=`const c=$('CRM Email Recipient claim result').first().json;return [{json:{sql:'SELECT public.crm_email_test_finish_v2($1::uuid,$2::uuid,$3::text) AS result',sqlParameters:[c.operation_id,c.claim_token,$json.statusCode===200&&$json.body?.data===true?'accepted':'outcome_unknown']}}];`;
const AFFECTED=['Autenticação entrada','Prepara','Etapa','CRM Email Test claim'];
function patchWorkflow(fresh,{expectedVersionId,expectedNodeHashes}={}){
 if(!expectedVersionId||fresh?.versionId!==expectedVersionId||!Array.isArray(fresh.nodes))throw Error('Fresh matching workflow required');
 if(fresh.settings?.saveDataErrorExecution!=='none'||fresh.settings?.saveDataSuccessExecution!=='none'||fresh.settings?.saveManualExecutions!==false||fresh.settings?.saveExecutionProgress!==false)throw Error('Payload retention must be disabled');
 const w=JSON.parse(JSON.stringify(fresh)),node=name=>{const a=w.nodes.filter(n=>n.name===name);if(a.length!==1)throw Error('Expected node '+name);return a[0];};
 for(const n of AFFECTED)if(!expectedNodeHashes?.[n]||sha(node(n))!==expectedNodeHashes[n])throw Error('Node drift: '+n);
 if(w.nodes.some(n=>n.name.startsWith('CRM Email Recipient ')))throw Error('Recipient patch already present');
 const once=(s,a,b)=>{if(s.split(a).length!==2)throw Error('Recipient exact anchor drift');return s.replace(a,b);};
 const auth=node('Autenticação entrada');auth.parameters.jsCode=once(auth.parameters.jsCode,"['email_teste','email_teste_previa','email_teste_operacao','email_previa','email_capacidades']",JSON.stringify(['email_teste','email_teste_previa','email_teste_operacao','email_previa','email_capacidades',...ACTIONS]));
 const prepare=node('Prepara');prepare.parameters.jsCode=once(prepare.parameters.jsCode,'// CRM_EMAIL_NATIVE_PREVIEW_V1',ROUTE+'// CRM_EMAIL_NATIVE_PREVIEW_V1');
 const legacy=node('CRM Email Test claim');if(legacy.parameters.query!=='={{ $json.sql }}'||legacy.parameters.options?.queryReplacement!=='={{ $json.sqlParameters || [] }}')throw Error('Parameterized legacy PG anchor drift');
 legacy.parameters.query="={{ $json.sql.replace(/public\\.crm_email_(?:native|test)_claim_v1\\(/g, 'public.crm_email_test_legacy_claim_v2(') }}";
 const pg=node('CRM Email Test snapshot'),provider=node('CRM Email Test transport'),nativeRead=node('CRM Email Native read'),nativeRender=node('CRM Email Native render');
 if(provider.parameters.url!=='https://email.shrigma.com.br/api/tx'||nativeRender.parameters.url!=='https://email.shrigma.com.br/api/templates/preview'||!provider.credentials?.httpBasicAuth)throw Error('Provider anchor drift');
 const edge=n=>({node:n,type:'main',index:0}),connect=(a,b)=>w.connections[a]={main:[[edge(b)]]};
 const add=(name,type,parameters,rest={})=>{const n={id:'recipient-v2-'+name.replace(/[^a-z0-9]/gi,'-').toLowerCase(),name,type,typeVersion:type==='n8n-nodes-base.code'?2:3.2,position:[1600+(w.nodes.length%5)*240,5200+Math.floor(w.nodes.length/5)*140],parameters,...rest};w.nodes.push(n);return n;};
 const code=(name,jsCode)=>add(name,'n8n-nodes-base.code',{jsCode});
 const rule=v=>({conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'loose',version:2},conditions:[{leftValue:'={{ $json._step }}',rightValue:v,operator:{type:'string',operation:'equals'}}],combinator:'and'},renameOutput:true,outputKey:v});
 const sw=(name,values)=>add(name,'n8n-nodes-base.switch',{rules:{values:values.map(rule)},options:{fallbackOutput:'extra'}});
 const copy=(source,name)=>{const n=JSON.parse(JSON.stringify(source));n.name=name;n.id='recipient-v2-'+name.replace(/[^a-z0-9]/gi,'-').toLowerCase();n.position=[1600,6000+w.nodes.length*30];w.nodes.push(n);return n;};
 const sql=name=>{const n=copy(pg,name);n.parameters.query='={{ $json.sql }}';n.parameters.options.queryReplacement='={{ $json.sqlParameters || [] }}';return n;};
 sql('CRM Email Recipient SQL');code('CRM Email Recipient initial',INITIAL);sw('CRM Email Recipient initial route',['read','claim']);
 const read=copy(nativeRead,'CRM Email Recipient read');read.parameters.url="={{ 'https://email.shrigma.com.br/api/templates/' + $json.envelope.snapshot.native.id }}";
 code('CRM Email Recipient prepare',PREPARE);sw('CRM Email Recipient prepare route',['render']);copy(nativeRender,'CRM Email Recipient render');code('CRM Email Recipient rendered',RENDERED);sw('CRM Email Recipient rendered route',['claim','seal']);
 sql('CRM Email Recipient seal');code('CRM Email Recipient sealed',SEAL);sql('CRM Email Recipient claim');copy(node('CRM Email Test claim result'),'CRM Email Recipient claim result');sw('CRM Email Recipient transport route',['send']);copy(provider,'CRM Email Recipient transport');code('CRM Email Recipient finish payload',FINISH);sql('CRM Email Recipient finish');copy(node('CRM Email Test response'),'CRM Email Recipient response');
 for(const n of w.nodes.filter(n=>n.name.startsWith('CRM Email Recipient ')&&n.type==='n8n-nodes-base.httpRequest')){n.retryOnFail=false;n.onError='continueRegularOutput';if(n.parameters.options?.redirect?.redirect?.followRedirects!==false)throw Error('Redirect guard missing');}
 const stage=node('Etapa'),outs=w.connections.Etapa?.main;if(outs?.length!==stage.parameters.rules.values.length+1||stage.parameters.options?.fallbackOutput!=='extra')throw Error('Stage drift');outs.splice(stage.parameters.rules.values.length,0,[edge('CRM Email Recipient SQL')]);stage.parameters.rules.values.push(rule('crm_email_recipient'));
 connect('CRM Email Recipient SQL','CRM Email Recipient initial');connect('CRM Email Recipient initial','CRM Email Recipient initial route');w.connections['CRM Email Recipient initial route']={main:[[edge('CRM Email Recipient read')],[edge('CRM Email Recipient claim')],[edge('Responde')]]};connect('CRM Email Recipient read','CRM Email Recipient prepare');connect('CRM Email Recipient prepare','CRM Email Recipient prepare route');w.connections['CRM Email Recipient prepare route']={main:[[edge('CRM Email Recipient render')],[edge('CRM Email Recipient rendered')]]};connect('CRM Email Recipient render','CRM Email Recipient rendered');connect('CRM Email Recipient rendered','CRM Email Recipient rendered route');w.connections['CRM Email Recipient rendered route']={main:[[edge('CRM Email Recipient claim')],[edge('CRM Email Recipient seal')],[edge('Responde')]]};connect('CRM Email Recipient seal','CRM Email Recipient sealed');connect('CRM Email Recipient sealed','Responde');connect('CRM Email Recipient claim','CRM Email Recipient claim result');connect('CRM Email Recipient claim result','CRM Email Recipient transport route');w.connections['CRM Email Recipient transport route']={main:[[edge('CRM Email Recipient transport')],[edge('Responde')]]};connect('CRM Email Recipient transport','CRM Email Recipient finish payload');connect('CRM Email Recipient finish payload','CRM Email Recipient finish');connect('CRM Email Recipient finish','CRM Email Recipient response');connect('CRM Email Recipient response','Responde');
 return {workflow:w,changes:{existingNodes:AFFECTED,newNodes:w.nodes.filter(n=>n.name.startsWith('CRM Email Recipient ')).map(n=>n.name),scope:'Growth template recipient tests v2; policy OFF; legacy receipts retained'}};
}
module.exports={patchWorkflow,sha,AFFECTED,ACTIONS,ROUTE,INITIAL,PREPARE,RENDERED,SEAL,FINISH,BUNDLE};
