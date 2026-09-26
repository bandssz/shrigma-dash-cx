/* Build a NEW n8n workflow from trusted deployment inputs. Never import this over
   the active template/journey workflow. No credentials, endpoint path or bundle
   are accepted from webhook requests. Build output is a private deploy artifact. */
'use strict';
const PAGES_ORIGIN='https://bandssz.github.io';
const AUTH_SQL="SELECT CASE WHEN a IS NULL OR a='null'::jsonb THEN NULL ELSE jsonb_build_object('who',a->'who','caps',a->'caps','rotulo',a->'rotulo') END AS auth FROM (SELECT public.shrigma_template_auth_v2($1::text) AS a) verified";
const STORE_SQL='SELECT public.shrigma_campaign_store($1::text,$2::jsonb) AS result';
const PROVIDER_SQL='SELECT public.shrigma_campaign_provider($1::text,$2::jsonb) AS result';
const STORE_ACTIONS=['claim','get','provider','finish','validation_get','validation_set','validation_invalidate'];
const PROVIDER_ACTIONS=['catalog','list','get','update','schedule','cancel','review','recovery_inspect','recover'];
const DB_ERRORS=['RECOVERY_UNAVAILABLE','RECOVERY_ALREADY_CLAIMED','RECOVERY_INVALID','AUDIENCE_REVIEW_REQUIRED','AUDIENCE_STALE','AUDIENCE_CHANGED','AUDIENCE_EMPTY','AUDIENCE_DISABLED','CAMPAIGN_RECEIPT_MISMATCH','CAMPAIGN_OPERATION_INVALID','CAMPAIGN_NOT_FOUND','CAMPAIGN_SCOPE','VERSION_CONFLICT','CAMPAIGN_LOCKED','LIST_SCOPE','TEMPLATE_SCOPE','TEMPLATE_CHANGED','INITIATIVE_INVALID','INITIATIVE_CONFLICT','VALIDATION_STALE','SCHEDULE_TOO_SOON','INITIATIVE_MISSING','CONTENT_UNVALIDATED','CONTENT_EMPTY','CAMPAIGN_EDITOR_REQUIRED','CAMPAIGN_REVIEW_REQUIRED','CAMPAIGN_DEPENDENCY_IN_USE','CAMPAIGN_CREATE_DRAFT_ONLY','CAMPAIGN_ADOPTION_REQUIRED'];

function buildWorkflow({name='Growth · Campanhas protegidas',webhookPath,listmonkOrigin,postgresCredential,listmonkCredential,bundle}={}){
 if(typeof webhookPath!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(webhookPath))throw Error('Trusted webhook path required');
 const base=new URL(listmonkOrigin);
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('Fixed HTTPS Listmonk origin required');
 for(const ref of [postgresCredential,listmonkCredential])if(!ref||typeof ref.id!=='string'||!ref.id||typeof ref.name!=='string'||!ref.name||Object.keys(ref).some(k=>!['id','name'].includes(k)))throw Error('Existing credential references required');
 if(typeof bundle!=='string'||!bundle.includes('ShrigmaCampaignRuntime')||bundle.length<50)throw Error('Trusted self-contained runtime bundle required');
 const nodes=[],connections={};
 const add=(name,type,version,parameters,extra={})=>{const n={id:'campaign-'+(nodes.length+1),name,type:'n8n-nodes-base.'+type,typeVersion:version,position:[(nodes.length%6)*280,Math.floor(nodes.length/6)*220],parameters,...extra};nodes.push(n);return name;};
 const connect=(from,to,output=0)=>{const c=connections[from]||(connections[from]={main:[]});while(c.main.length<=output)c.main.push([]);c.main[output].push({node:to,type:'main',index:0});};
 const code=(name,jsCode)=>add(name,'code',2,{mode:'runOnceForAllItems',jsCode});
 const route=(name,values)=>add(name,'switch',3.2,{rules:{values:values.map(value=>({conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{leftValue:'={{ $json._route }}',rightValue:value,operator:{type:'string',operation:'equals'}}],combinator:'and'},renameOutput:true,outputKey:value}))},options:{fallbackOutput:'extra'}});
 const pg=(name,query,queryReplacement)=>add(name,'postgres',2.5,{operation:'executeQuery',query,options:{queryReplacement}},{credentials:{postgres:{...postgresCredential}},retryOnFail:false,onError:'continueErrorOutput'});
 const unavailable="return [{json:{response:{status:503,body:{error:'RUNTIME_RECONCILIATION_REQUIRED',message:'Resultado não confirmado. Consulte a operação antes de tentar novamente; não use outra chave.'}}}}];";
 for(const method of ['GET','POST','OPTIONS']){
  add(method,'webhook',2,{httpMethod:method,path:webhookPath,responseMode:'responseNode',options:{}});
  if(method==='OPTIONS')connect(method,code('Preflight',"return [{json:{response:{status:204,body:{}}}}];"));
  else{const label=code('Método '+method,`return [{json:{request:$json,method:${JSON.stringify(method)}}}];`);connect(method,label);connect(label,'Entrada');}
 }
 code('Entrada',`const input=$json,req=input.request||{},method=input.method;
const origin=req.headers?.origin;
const reply=(status,error,message)=>[{json:{_route:'response',response:{status,body:{error,message}}}}];
if(origin&&origin!==${JSON.stringify(PAGES_ORIGIN)})return reply(403,'ORIGIN_DENIED','Origem não permitida.');
const commandSource=method==='GET'?(req.query||{}):(req.body||{});
if(method!=='GET'&&method!=='POST')return reply(405,'METHOD_INVALID','Método incompatível com a ação.');
if(!commandSource||typeof commandSource!=='object'||Array.isArray(commandSource))return reply(422,'REQUEST_INVALID','Solicitação inválida.');
const allowed=['k','acao','brand','id','definition','expected_version','idempotency_key','confirm','audience_review_id','source_operation_id'];
if(Object.keys(commandSource).some(k=>!allowed.includes(k)))return reply(422,'REQUEST_FIELD_INVALID','Campo não permitido.');
const reads=['campanha_catalogo','campanha_listar','campanha_obter','campanha_operacao'],writes=['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar','campanha_recuperar'];
if(!reads.includes(commandSource.acao)&&!writes.includes(commandSource.acao))return reply(400,'ACTION_INVALID','Ação desconhecida.');
if((method==='GET'&&!reads.includes(commandSource.acao))||(method==='POST'&&!writes.includes(commandSource.acao)))return reply(405,'METHOD_INVALID','Método incompatível com a ação.');
const key=commandSource.k;
if(typeof key!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(key))return reply(401,'UNAUTHORIZED','Autenticação necessária.');
const command=Object.fromEntries(Object.entries(commandSource).filter(([k])=>k!=='k'));
if(method==='GET'&&command.id!==undefined){if(typeof command.id!=='string'||!/^[1-9][0-9]*$/.test(command.id)||!Number.isSafeInteger(Number(command.id)))return reply(422,'ID_INVALID','Campanha inválida.');command.id=Number(command.id);}
return [{json:{_route:'auth',key,command}}];`);
 route('Entrada →',['auth','response']);connect('Entrada','Entrada →');connect('Entrada →','Autentica',0);connect('Entrada →','Responde',1);connect('Entrada →','Interrompe',2);
 pg('Autentica',AUTH_SQL,'={{ [$json.key] }}');connect('Autentica','Iniciar',0);connect('Autentica','Falha autenticação',1);
 code('Falha autenticação',"return [{json:{response:{status:503,body:{error:'AUTH_UNAVAILABLE',message:'Autenticação indisponível.'}}}}];");
 code('Iniciar',`${bundle}\nconst verified=$json.auth,entry=$('Entrada').item.json;
if(!verified||typeof verified.who!=='string'||!verified.who.trim()||!Array.isArray(verified.caps)||verified.caps.some(c=>typeof c!=='string'))return [{json:{response:{status:401,body:{error:'UNAUTHORIZED',message:'Autenticação necessária.'}},kind:'response'}}];
const result=await ShrigmaCampaignRuntime.createRuntime().start({actor:verified.who,caps:verified.caps},entry.command,{executionId:String($execution.id)});
return [{json:result}];`);
 code('Retomar',`${bundle}\nconst source=$json;
const result=await ShrigmaCampaignRuntime.createRuntime().resume(source.context,source.receipt,{executionId:String($execution.id)});
return [{json:result}];`);
 code('Despacha',`const source=$json,e=source.effect;
if(source.kind==='response'&&source.response)return [{json:{_route:'response',response:source.response}}];
const stop=()=>[{json:{_route:'response',response:{status:503,body:{error:'RUNTIME_RECONCILIATION_REQUIRED',message:'Efeito não confirmado. Consulte a operação antes de repetir.'}}}}];
if(source.kind!=='effect'||!e||!source.context||source.context.executionId!==String($execution.id)||!Array.isArray(source.context.transcript)||source.context.transcript.length!==$runIndex||JSON.stringify(e)!==JSON.stringify(source.context.pending))return stop();
const store=${JSON.stringify(STORE_ACTIONS)},provider=${JSON.stringify(PROVIDER_ACTIONS)};
const pg=(e.kind==='store'&&store.includes(e.action))||(e.kind==='provider'&&provider.includes(e.action));
const native=e.kind==='nativeCreate'&&e.payload?.send_at===null&&e.payload?.type==='regular';
const preview=e.kind==='preview'&&Number.isSafeInteger(e.idCampaign)&&e.idCampaign>0;
if(!pg&&!native&&!preview)return stop();
return [{json:{_route:e.kind,effect:e,context:source.context}}];`);
 connect('Iniciar','Despacha');connect('Retomar','Despacha');route('Efeito →',['response','store','provider','nativeCreate','preview']);connect('Despacha','Efeito →');
 for(const [i,to] of ['Responde','Store','Provedor','Criar rascunho','Prévia'].entries())connect('Efeito →',to,i);connect('Efeito →','Interrompe',5);
 pg('Store',STORE_SQL,'={{ [$json.effect.action, JSON.stringify($json.effect.payload)] }}');
 pg('Provedor',PROVIDER_SQL,'={{ [$json.effect.action, JSON.stringify($json.effect.payload)] }}');
 // Text + fullResponse defaults to `data` in HTTP Request v4.3. Set body
 // explicitly so both transports obey the native adapter's response contract.
 const httpOptions=responseFormat=>({timeout:20000,redirect:{redirect:{followRedirects:false}},response:{response:{fullResponse:true,neverError:true,responseFormat,outputPropertyName:'body'}}});
 add('Criar rascunho','httpRequest',4.3,{method:'POST',url:base.origin+'/api/campaigns',authentication:'genericCredentialType',genericAuthType:'httpBasicAuth',sendBody:true,contentType:'json',specifyBody:'json',jsonBody:'={{ $json.effect.payload }}',options:httpOptions('json')},{credentials:{httpBasicAuth:{...listmonkCredential}},retryOnFail:false,onError:'continueErrorOutput'});
 add('Prévia','httpRequest',4.3,{method:'POST',url:'='+base.origin+'/api/campaigns/{{$json.effect.idCampaign}}/preview',authentication:'genericCredentialType',genericAuthType:'httpBasicAuth',sendBody:true,contentType:'form-urlencoded',specifyBody:'keypair',bodyParameters:{parameters:[{name:'content_type',value:'={{ $json.effect.payload.content_type }}'},{name:'template_id',value:'={{ $json.effect.payload.template_id }}'},{name:'body',value:'={{ $json.effect.payload.body }}'}]},options:httpOptions('text')},{credentials:{httpBasicAuth:{...listmonkCredential}},retryOnFail:false,onError:'continueErrorOutput'});
 // .item is the paired predecessor, not "the latest run". Verify both agree
 // in this single-item sequential loop; never fall back to a different context.
 const receiptBinding=kinds=>`let source;
try{
 const linked=$('Despacha').item.json,latest=$('Despacha').all(0);
 if($input.all().length!==1||latest.length!==1||!linked?.effect||!linked.context||linked.context.executionId!==String($execution.id)||linked.effect.id!==linked.context.pending?.id||linked.effect.id!==latest[0].json.effect?.id||!${JSON.stringify(kinds)}.includes(linked.effect.kind))throw Error('Receipt binding unavailable');
 source=linked;
}catch{return [{json:{context:null,receipt:null}}];}
`;
 code('Recibo PG',`${receiptBinding(['store','provider'])}const rows=$input.all().map(i=>i.json);
const valid=rows.length===1&&Object.hasOwn(rows[0],'result');
const receipt=valid?{effect_id:source.effect.id,ok:true,value:{rows}}:{effect_id:source.effect.id,ok:false,error:{message:'Resposta do banco não confirmada.'}};
return [{json:{context:source.context,receipt}}];`);
 code('Recibo erro PG',`${receiptBinding(['store','provider'])}const e=$json.error||$json;
const code=e.code||e.cause?.code,known=${JSON.stringify(DB_ERRORS)};
let error={message:'Resultado do banco não confirmado.'};
if(['55P03','40P01','40001'].includes(code))error={code,message:'DATABASE_ROLLBACK'};
else if(code==='P0001'&&known.includes(e.message))error={code,message:e.message};
return [{json:{context:source.context,receipt:{effect_id:source.effect.id,ok:false,error}}}];`);
 code('Recibo HTTP',`${receiptBinding(['nativeCreate','preview'])}const r=$json;
const receipt=Number.isInteger(r.statusCode)&&Object.hasOwn(r,'body')?{effect_id:source.effect.id,ok:true,value:{status:r.statusCode,body:r.body}}:{effect_id:source.effect.id,ok:false,error:{message:'Resposta do Listmonk não confirmada.'}};
return [{json:{context:source.context,receipt}}];`);
 code('Recibo erro HTTP',`${receiptBinding(['nativeCreate','preview'])}
return [{json:{context:source.context,receipt:{effect_id:source.effect.id,ok:false,error:{message:'Resultado do Listmonk não confirmado.'}}}}];`);
 for(const n of ['Store','Provedor']){connect(n,'Recibo PG',0);connect(n,'Recibo erro PG',1);}
 for(const n of ['Criar rascunho','Prévia']){connect(n,'Recibo HTTP',0);connect(n,'Recibo erro HTTP',1);}
 for(const n of ['Recibo PG','Recibo erro PG','Recibo HTTP','Recibo erro HTTP'])connect(n,'Retomar');
 code('Interrompe',unavailable);
 add('Responde','respondToWebhook',1.1,{respondWith:'json',responseBody:'={{ $json.response.body }}',options:{responseCode:'={{ $json.response.status }}',responseHeaders:{entries:[
  {name:'Content-Type',value:'application/json; charset=utf-8'},{name:'Cache-Control',value:'no-store'},{name:'Access-Control-Allow-Origin',value:PAGES_ORIGIN},{name:'Access-Control-Allow-Methods',value:'GET, POST, OPTIONS'},{name:'Access-Control-Allow-Headers',value:'Content-Type'},{name:'Vary',value:'Origin'}]}}});
 for(const n of ['Preflight','Interrompe','Falha autenticação'])connect(n,'Responde');
 return {name,nodes,connections,settings:{executionOrder:'v1',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false},active:false};
}
module.exports={buildWorkflow,PAGES_ORIGIN,AUTH_SQL,STORE_SQL,PROVIDER_SQL};
