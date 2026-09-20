/* Patch only a freshly reviewed private export. No publication or secret loading.
 * Outputs retain existing server configuration and must never enter the public repo. */
'use strict';
const crypto=require('node:crypto');
const {createController}=require('./manual-decision.cjs'),{createRuntime}=require('./manual-decision-runtime.cjs');
const {sha256Bytes,stable,canonical,digest}=require('../growth/template-operation-receipt.cjs');
const {VALIDATE,EXECUTE}=require('./regra-action-patch.cjs');
const runtimeSource=`const C=(${createController.toString()})();\nconst M=(${createRuntime.toString()})(C);`;
const cryptoSource=[sha256Bytes,stable,canonical,digest].map(f=>f.toString()).join('\n');
const ACTION_NODES=['POST acao','Valida','Pegar tokens (Token Manager)','Executa acao','Grava','Resposta','400'];
const AUTO_NODES=['Monta decisão (SQL)','Decide','Executa review (só modo ativo)','Log'];
const exact=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function selectedFingerprint(w,names){
 const nodes=names.map(name=>{const xs=w?.nodes?.filter(n=>n.name===name);if(xs?.length!==1)throw Error('Unique reviewed node required');const n=xs[0];return Object.fromEntries(['name','type','typeVersion','parameters','credentials','onError','retryOnFail','alwaysOutputData'].map(k=>[k,n[k]??null]));});
 return crypto.createHash('sha256').update(JSON.stringify({nodes,connections:w.connections})).digest('hex');
}
function checked(fresh,{expectedVersion,expectedFingerprint},names){
 if(!fresh?.id||!expectedVersion||fresh.versionId!==expectedVersion||selectedFingerprint(fresh,names)!==expectedFingerprint)throw Error('Fresh version and reviewed selected-node fingerprint required');
 if(fresh.active&&(!fresh.activeVersion||fresh.activeVersionId!==fresh.versionId||fresh.activeVersion.versionId!==fresh.versionId||!exact(fresh.activeVersion.nodes,fresh.nodes)||!exact(fresh.activeVersion.connections,fresh.connections)))throw Error('Saved and active workflow differ');
 return JSON.parse(JSON.stringify(fresh));
}
function patchManual(fresh,options={}){
 const w=checked(fresh,options,ACTION_NODES),by=name=>w.nodes.find(n=>n.name===name),ids=options.webhookIds;
 if(!ids||!['get','options'].every(k=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(ids[k]||''))||ids.get===ids.options)throw Error('Distinct explicit webhook UUIDs required');
 if(w.nodes.length!==7||by('POST acao').parameters.httpMethod!=='POST'||by('POST acao').parameters.responseMode!=='responseNode'||by('Grava').parameters.query!=='={{ $json.sql }}'||by('Grava').parameters.options.queryReplacement!=='={{ $json.sqlParameters || [] }}')throw Error('Manual route shape changed');
 const validation=by('Valida').parameters.jsCode,execution=by('Executa acao').parameters.jsCode;
 const key=validation.match(/^const ESCRITA = ('[^'\n]+'|"[^"\n]+");$/m);
 const boundary="const a = $('Valida').first().json;";
 if(!key||validation.split('const ESCRITA = ').length!==2||!validation.includes(VALIDATE)||!execution.includes(EXECUTE)||execution.split(boundary).length!==2||!execution.includes('/affiliate_seller/202409/sample_applications/${a.application_id}/review'))throw Error('Reviewed validation/rule/individual transport contract changed');
 const signer=execution.split(boundary)[0];
 if(signer.includes('httpRequest(')||!signer.includes('function assinar(')||!signer.includes("const BASE = 'https://open-api.tiktokglobalshop.com'"))throw Error('Signing prefix changed');
 const originalConnections=JSON.parse(JSON.stringify(w.connections));
 const add=(name,type,parameters,extra={})=>{if(w.nodes.some(n=>n.name===name))throw Error('Duplicate generated node');w.nodes.push({id:'tts-manual-'+w.nodes.length,name,type:'n8n-nodes-base.'+type,typeVersion:type==='switch'?3.2:type==='postgres'?2.4:type==='httpRequest'?4.3:2,position:[(w.nodes.length%6)*280,Math.floor(w.nodes.length/6)*200],parameters,...extra});return name;};
 const connect=(from,to,index=0)=>{const c=w.connections[from]||(w.connections[from]={main:[]});while(c.main.length<=index)c.main.push([]);c.main[index].push({node:to,type:'main',index:0});};
 const code=(name,source)=>{add(name,'code',{mode:'runOnceForAllItems',jsCode:source},{onError:'continueErrorOutput',retryOnFail:false});connect(name,'Manual resultado incerto',1);return name;};
 const route=(name,values)=>add(name,'switch',{rules:{values:values.map(value=>({conditions:{options:{caseSensitive:true,typeValidation:'strict',version:2},conditions:[{leftValue:'={{ $json._route }}',rightValue:value,operator:{type:'string',operation:'equals'}}],combinator:'and'},renameOutput:true,outputKey:value}))},options:{fallbackOutput:'extra'}});
 const pg=name=>{add(name,'postgres',{operation:'executeQuery',query:'={{ $json.sql }}',options:{queryReplacement:'={{ $json.parameters }}'}},{credentials:JSON.parse(JSON.stringify(by('Grava').credentials)),onError:'continueErrorOutput',retryOnFail:false,alwaysOutputData:true});connect(name,'Manual resultado incerto',1);};
 const single="if($input.all().length!==1)throw Error('TTS_MANUAL_SINGLE_ITEM_REQUIRED');\n";
 const binding=(name,field)=>`const p=$(${JSON.stringify(name)}).first().json.${field};M.bound(p);if(p.owner!==${JSON.stringify(w.id+':')}+String($execution.id))throw Error('TTS_MANUAL_EXECUTION_MISMATCH');\n`;
 by('Valida').parameters.jsCode=`${key[0]}\nconst incoming=$json.body||{};\nif(incoming.acao==='regra'){const checked=(()=>{${validation}\n})();return checked.map(i=>({json:{...i.json,_route:'regra'}}));}\nif(typeof incoming.k!=='string'||incoming.k!==ESCRITA)throw Error('chave invalida');\n${runtimeSource}\n${cryptoSource}\n${single}const eid=String($execution.id);if(!eid||['undefined','null'].includes(eid)||eid.length>120)throw Error('TTS_MANUAL_EXECUTION_REQUIRED');\nconst p=C.normalize(incoming,{actor_sha256:digest({scope:'tts-manual-v1',credential:ESCRITA}),owner:${JSON.stringify(w.id+':')}+eid});\nreturn [{json:{_route:'manual',p,...M.plan('claim',p)}}];`;
 by('Executa acao').parameters.jsCode=`const a=$('Valida').first().json;\n${EXECUTE}\nthrow Error('TTS_MANUAL_LEGACY_REVIEW_DISABLED');`;
 w.connections.Valida={main:[[{node:'Ação manual ou regra',type:'main',index:0}],originalConnections.Valida.main[1]]};
 route('Ação manual ou regra',['manual','regra']);connect('Ação manual ou regra','Manual reserva',0);connect('Ação manual ou regra','Pegar tokens (Token Manager)',1);connect('Ação manual ou regra','Manual resultado incerto',2);
 pg('Manual reserva');code('Manual recibo reserva',`${runtimeSource}\n${single}${binding('Valida','p')}return [{json:M.claim(p,$json.result)}];`);connect('Manual reserva','Manual recibo reserva');route('Manual reserva →',['tokens','response']);connect('Manual recibo reserva','Manual reserva →');connect('Manual reserva →','Manual tokens',0);connect('Manual reserva →','Manual responde',1);connect('Manual reserva →','Manual resultado incerto',2);
 const tokens=JSON.parse(JSON.stringify(by('Pegar tokens (Token Manager)')));tokens.name='Manual tokens';tokens.id='tts-manual-tokens';tokens.retryOnFail=false;tokens.onError='continueErrorOutput';tokens.alwaysOutputData=true;w.nodes.push(tokens);connect('Manual tokens','Manual preflight');connect('Manual tokens','Manual preflight indisponível',1);
 // These are independent hard gates, not inferred from local first_seen or a quiet queue.
 code('Manual preflight',`${runtimeSource}\n${binding('Manual recibo reserva','owned')}const readiness={cutoverVerified:false,admissionVerified:false};\nreturn [{json:M.preflight(p,$input.all().map(i=>i.json),readiness)}];`);
 code('Manual preflight indisponível',`${runtimeSource}\n${binding('Manual recibo reserva','owned')}return [{json:M.preflight(p,[],{})}];`);
 route('Manual preflight →',['dispatch','finish']);connect('Manual preflight','Manual preflight →');connect('Manual preflight indisponível','Manual preflight →');connect('Manual preflight →','Manual reserva transporte',0);connect('Manual preflight →','Manual plano finish',1);connect('Manual preflight →','Manual resultado incerto',2);
 pg('Manual reserva transporte');code('Manual recibo transporte',`${runtimeSource}\n${single}${binding('Manual recibo reserva','owned')}return [{json:M.dispatch(p,$json.result)}];`);connect('Manual reserva transporte','Manual recibo transporte');route('Manual transporte →',['transport','response']);connect('Manual recibo transporte','Manual transporte →');connect('Manual transporte →','Manual assina',0);connect('Manual transporte →','Manual responde',1);connect('Manual transporte →','Manual resultado incerto',2);
 code('Manual assina',`${signer}\n${runtimeSource}\n${single}${binding('Manual recibo transporte','owned')}if($json._route!=='transport'||JSON.stringify($json.owned)!==JSON.stringify(p))throw Error('TTS_MANUAL_TRANSPORT_UNBOUND');\nconst access=M.token($('Manual tokens').all().map(i=>i.json),p.marca);\nconst request=M.request(p,access,{base:BASE,appKey:APP_KEY,cipher:CIPHER[p.marca],timestamp:Math.floor(Date.now()/1000),sign:assinar});\nreturn [{json:{request}}];`);
 add('Manual HTTP review','httpRequest',{method:'POST',url:'={{ $json.request.url }}',sendHeaders:true,specifyHeaders:'json',jsonHeaders:'={{ JSON.stringify($json.request.headers) }}',sendBody:true,contentType:'raw',rawContentType:'application/json',body:'={{ $json.request.body }}',options:{timeout:30000,redirect:{redirect:{followRedirects:false}},response:{response:{fullResponse:true,neverError:true,responseFormat:'text',outputPropertyName:'body'}}}},{onError:'continueErrorOutput',retryOnFail:false,alwaysOutputData:true});connect('Manual assina','Manual HTTP review');
 code('Manual recibo HTTP',`${runtimeSource}\n${single}${binding('Manual recibo transporte','owned')}return [{json:{finish:{...p,receipt:M.providerReceipt($json)}}}];`);
 code('Manual HTTP incerto',`${runtimeSource}\n${binding('Manual recibo transporte','owned')}return [{json:{finish:{...p,receipt:{kind:'outcome_unknown',provider_code:null,request_id:null,reason:'transport_uncertain'}}}}];`);connect('Manual HTTP review','Manual recibo HTTP');connect('Manual HTTP review','Manual HTTP incerto',1);connect('Manual recibo HTTP','Manual plano finish');connect('Manual HTTP incerto','Manual plano finish');
 code('Manual plano finish',`${runtimeSource}\n${single}const p=$json.finish;M.bound(p);if(p.owner!==${JSON.stringify(w.id+':')}+String($execution.id))throw Error('TTS_MANUAL_EXECUTION_MISMATCH');return [{json:M.finishPlan(p,p.receipt)}];`);pg('Manual finish');connect('Manual plano finish','Manual finish');code('Manual recibo final',`${runtimeSource}\n${single}const plan=$('Manual plano finish').first().json;return [{json:M.response(plan.owned,plan.receipt,$json.result)}];`);connect('Manual finish','Manual recibo final');connect('Manual recibo final','Manual responde');
 const headers={entries:[{name:'Content-Type',value:'application/json'},{name:'Cache-Control',value:'no-store'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'content-type,x-tts-write-key'},{name:'Access-Control-Allow-Methods',value:'POST,GET,OPTIONS'}]};
 add('Manual responde','respondToWebhook',{respondWith:'json',responseBody:'={{ $json.response.body }}',options:{responseCode:'={{ $json.response.status }}',responseHeaders:headers}},{typeVersion:1.1});
 add('Manual resultado incerto','code',{jsCode:`let p;try{p=$('Valida').first().json.p;}catch{}\nreturn [{json:{response:{status:503,body:{ok:false,code:'outcome_unknown',operation_id:p?.operation_id||null,mensagem:'Resultado não comprovado. Preserve a mesma operação e consulte; não repita.'}}}}];`});connect('Manual resultado incerto','Manual responde');
 for(const [method,keyName] of [['GET','get'],['OPTIONS','options']]){const n=JSON.parse(JSON.stringify(by('POST acao')));n.name=method+' decisão manual';n.id=ids[keyName];n.webhookId=ids[keyName];n.parameters.httpMethod=method;w.nodes.push(n);}
 code('Manual consulta',`${key[0]}\n${runtimeSource}\n${cryptoSource}\n${single}if(typeof $json.headers?.['x-tts-write-key']!=='string'||$json.headers['x-tts-write-key']!==ESCRITA)return [{json:{_route:'response',response:{status:401,body:{ok:false,code:'invalid_key'}}}}];\nconst q=$json.query||{};if(q.acao==='capacidades')return [{json:{_route:'response',response:{status:200,body:{contract:'tts_manual_runtime_v1',operation:true,write:false,cutover_verified:false,admission_verified:false}}}}];\nif(q.acao!=='operacao')return [{json:{_route:'response',response:{status:400,body:{ok:false,code:'invalid_action'}}}}];\nconst p=C.identity(q,{actor_sha256:digest({scope:'tts-manual-v1',credential:ESCRITA})});return [{json:{_route:'get',p,...M.plan('get',p)}}];`);
 connect('GET decisão manual','Manual consulta');route('Manual consulta →',['get','response']);connect('Manual consulta','Manual consulta →');connect('Manual consulta →','Manual lê recibo',0);connect('Manual consulta →','Manual responde',1);connect('Manual consulta →','Manual resultado incerto',2);pg('Manual lê recibo');code('Manual recibo consulta',`${runtimeSource}\n${single}return [{json:M.lookup($('Manual consulta').first().json.p,$json.result)}];`);connect('Manual lê recibo','Manual recibo consulta');connect('Manual recibo consulta','Manual responde');
 add('Manual OPTIONS','respondToWebhook',{respondWith:'noData',options:{responseCode:204,responseHeaders:headers}},{typeVersion:1.1});connect('OPTIONS decisão manual','Manual OPTIONS');
 w.settings={...w.settings,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false};
 return {workflow:w,readiness:{cutoverVerified:false,admissionVerified:false},requiresSQL:'manual-decision.sql; control.enabled remains false',modified:['Valida','Executa acao','Valida connections','retention'],ruleNodesPreserved:['Pegar tokens (Token Manager)','Grava','Resposta','400']};
}
function dryOnly(decisions,inicio){
 if(!Array.isArray(decisions)||typeof inicio!=='string'||!Number.isFinite(Date.parse(inicio)))throw Error('TTS_AUTOMATIC_CONTEXT_INVALID');
 const rows=decisions.filter(d=>d?.application_id),blocked=rows.filter(d=>d.dry_run!==true),counts={};
 for(const d of rows)counts[d.marca+':'+d.decisao]=(counts[d.marca+':'+d.decisao]||0)+1;
 const error=blocked.length?'TTS_AUTOMATIC_TRANSPORT_DISABLED: '+blocked.length+' resultado(s) não seco(s); nenhum review iniciado.':null;
 return {decididas:rows.length,dry_run:rows.filter(d=>d.dry_run===true).length,executadas:0,bloqueadas:blocked.length,transporte_automatico:'disabled',erros:error?[error]:[],por_decisao:counts,
  decisoes:rows.map(d=>({marca:d.marca,user:d.username,decisao:d.decisao,tier:d.decisao_tier,motivo:d.decisao_motivo,dry_run:d.dry_run})),
  sql:"INSERT INTO crm_tts_coleta_log(marca,fonte,iniciado_em,terminado_em,linhas,ok,erro) VALUES(NULL,'esteira',$1::timestamptz,clock_timestamp(),$2::integer,$3::boolean,$4::text)",sqlParameters:[inicio,rows.length,blocked.length===0,error]};
}
function patchAutomatic(fresh,options={}){
 const w=checked(fresh,options,AUTO_NODES),node=name=>w.nodes.find(n=>n.name===name),transport=node('Executa review (só modo ativo)'),log=node('Log');
 if(!transport.parameters.jsCode.includes('const reais = decisoes.filter(d => !d.dry_run')||!transport.parameters.jsCode.includes('await review(')||log.parameters.query!=='={{ $json.sql }}')throw Error('Automatic transport/log contract changed');
 transport.parameters.jsCode=`const dryOnly=${dryOnly.toString()};\nreturn [{json:dryOnly($('Decide').all().map(i=>i.json),$('Janela').first().json.inicio)}];`;
 log.parameters.options={...log.parameters.options,queryReplacement:'={{ $json.sqlParameters }}'};
 return {workflow:w,modified:['Executa review (só modo ativo).jsCode','Log.queryReplacement'],commercialTransportRemoved:true};
}
module.exports={ACTION_NODES,AUTO_NODES,selectedFingerprint,patchManual,patchAutomatic,dryOnly};
