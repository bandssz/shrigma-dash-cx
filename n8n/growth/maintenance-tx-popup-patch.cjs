'use strict';
// Pure builders. No network, publication, credentials discovery or execution.
const {digest}=require('./maintenance-cart-patch.cjs');
const protocol=require('./maintenance-tx-popup-protocol.cjs');
const TARGET='ecK2wke9fKnO3mfy';
const BRANDS={fish:{label:'Fish',webhook:'Webhook — Recebe Evento1',derive:'Derivar Rastreio — Fishermans',start:'Roteia NPS mal endereçado',subscriber:'Verifica se cliente existe1',branch:'R4 pedido confirmado Fish',claim:'R4 reserva exclusiva Fish',winner:'R4 somente vencedor envia',http:'R4 Listmonk Fish',finish:'R4 registra aceite Fish',accepted:'R4 somente aceites seguem',cleanup:'HTTP Request',wa:'→ WhatsApp Fish (WA · Transacional EfSf4rTJb3krbBV2)'},aristo:{label:'Aristo',webhook:'Webhook — Recebe Evento',derive:'Derivar Rastreio — Aristocrata',start:'Derivar Rastreio — Aristocrata',subscriber:'Verifica se cliente existe',branch:'R4 pedido confirmado Aristo',claim:'R4 reserva exclusiva Aristo',winner:'R4 somente vencedor envia Aristo',http:'R4 Listmonk Aristo',finish:'R4 registra aceite Aristo',accepted:'R4 somente aceites seguem Aristo',cleanup:'HTTP Request1',wa:'→ WhatsApp Aristo (transacional em sombra)'}};
const clone=v=>JSON.parse(JSON.stringify(v));
const edge=node=>({node,type:'main',index:0});
function node(w,name,type){const found=w.nodes?.filter(n=>n.name===name);if(found?.length!==1||found[0].type!=='n8n-nodes-base.'+type)throw Error('MAINTENANCE_TX_NODE_DRIFT');return found[0];}
function graph(w,name,groups){if(digest(w.connections?.[name])!==digest({main:groups.map(g=>g.map(edge))}))throw Error('MAINTENANCE_TX_GRAPH_DRIFT');}
function source(w,g){
 if(w?.id!==TARGET||!g?.version||w.versionId!==g.version||w.activeVersionId!==g.version||w.active!==true||g.workflowHash!==digest(w)||g.connectionsHash!==digest(w.connections))throw Error('MAINTENANCE_TX_VERSION_HASH');
 if(w.nodes.some(n=>n.name.startsWith('Maintenance TX')))throw Error('MAINTENANCE_TX_ALREADY_PATCHED');
 for(const [brand,b] of Object.entries(BRANDS)){
  const hook=node(w,b.webhook,'webhook');if(hook.parameters.httpMethod!=='POST'||(hook.parameters.responseMode&&hook.parameters.responseMode!=='onReceived'))throw Error('MAINTENANCE_TX_ACK_DRIFT');graph(w,b.webhook,[[b.start]]);
  node(w,b.derive,'code');graph(w,b.derive,[[b.subscriber,b.wa]]);node(w,b.wa,'httpRequest');
  const condition=node(w,b.branch,'if').parameters.conditions?.conditions;
  if(condition?.length!==1||!condition[0].leftValue.includes(`$('${b.derive}').item.json.body`)||condition[0].operator?.operation!=='true')throw Error('MAINTENANCE_TX_SLICE_DRIFT');
  const claim=node(w,b.claim,'postgres'),finish=node(w,b.finish,'postgres'),http=node(w,b.http,'httpRequest');
  if(claim.parameters.query!==`SELECT * FROM public.shrigma_flow_email_claim_tx('${brand}',$1::jsonb);`||!claim.credentials?.postgres||finish.parameters.query!==`SELECT * FROM public.shrigma_email_finish_${brand}($1::uuid,$2::uuid,public.shrigma_email_transport_outcome($3::jsonb),$4::jsonb);`)throw Error('MAINTENANCE_TX_SQL_DRIFT');
  if(http.retryOnFail!==false||http.onError!=='continueRegularOutput'||http.parameters.method!=='POST'||http.parameters.jsonBody!==`={{ $('${b.claim}').item.json.payload }}`||!http.credentials?.httpBasicAuth||http.parameters.options?.response?.response?.fullResponse!==true||http.parameters.options?.response?.response?.neverError!==true||http.parameters.options?.redirect?.redirect?.followRedirects!==false)throw Error('MAINTENANCE_TX_TRANSPORT_DRIFT');
  const sub=node(w,b.subscriber,'httpRequest');if(sub.parameters.method!=='POST'||!sub.credentials?.httpBasicAuth||!sub.parameters.jsonBody?.includes('preconfirm_subscriptions'))throw Error('MAINTENANCE_TX_SUBSCRIBER_DRIFT');
  graph(w,b.claim,[[b.winner]]);graph(w,b.winner,[[b.http]]);graph(w,b.http,[[b.finish]]);graph(w,b.finish,[[b.accepted]]);graph(w,b.accepted,[[b.cleanup]]);
  node(w,b.cleanup,'httpRequest');
 }
 return w;
}
function make(name,type,parameters,extra={}){return {id:name.toLowerCase().replace(/[^a-z0-9]+/g,'-'),name,type:'n8n-nodes-base.'+type,typeVersion:type==='if'?2.2:type==='code'?2:type==='respondToWebhook'?1.4:2.6,position:[0,0],parameters,...extra};}
function boolean(name,expression){return make(name,'if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:'maintenance-scope',leftValue:expression,rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}});}
function link(w,from,groups){w.connections[from]={main:groups.map(g=>g.map(edge))};}
function patchTxProducer(workflow,guard){
 source(workflow,guard);const w=clone(workflow);
 for(const [brand,b] of Object.entries(BRANDS)){
  const prefix='Maintenance TX '+b.label,entry=prefix+' entrada',legacy=prefix+' ACK legado',email=prefix+' email',normalize=prefix+' corpo',valid=prefix+' válido',admit=prefix+' persistir',response=prefix+' resposta',ack=prefix+' ACK';
  node(w,b.webhook,'webhook').parameters.responseMode='responseNode';
  // Reuse the exact existing slice expression, changing only where body is read.
  const check=node(w,b.branch,'if').parameters.conditions.conditions[0].leftValue.replace(`$('${b.derive}').item.json.body`,'$json.body');
  const pg=clone(node(w,b.claim,'postgres'));Object.assign(pg,{id:admit.toLowerCase().replace(/[^a-z0-9]+/g,'-'),name:admit,retryOnFail:false,onError:'continueRegularOutput'});pg.parameters={operation:'executeQuery',query:`SELECT crm_maintenance_candidate.tx_admit_v1('${brand}',$1::jsonb) AS receipt;`,options:{queryBatching:'independently',queryReplacement:'={{ [JSON.stringify($json.body)] }}'}};
  w.nodes.push(boolean(entry,check),make(legacy,'respondToWebhook',{respondWith:'json',responseBody:'={{ {message:"Workflow was started"} }}',options:{responseCode:200}}),boolean(email,check),
   make(normalize,'code',{mode:'runOnceForEachItem',jsCode:protocol.source()+`try{return {json:{ok:true,body:normalizeJSON('${brand}',JSON.stringify($json.body))}};}catch{return {json:{ok:false}};}`}),
   boolean(valid,'={{ $json.ok === true }}'),pg,
   make(response,'code',{mode:'runOnceForEachItem',jsCode:protocol.source()+`return {json:receiptResponse($json,'${brand}')};`}),
   make(ack,'respondToWebhook',{respondWith:'json',responseBody:'={{ $json.body }}',options:{responseCode:'={{ $json.status }}'}}));
  link(w,b.webhook,[[entry]]);link(w,entry,[[b.start],[legacy]]);link(w,legacy,[[b.start]]);
  // The WA node and its input remain exactly the original branch. Inbox affects email only.
  link(w,b.derive,[[email,b.wa]]);link(w,email,[[normalize],[b.subscriber]]);link(w,normalize,[[valid]]);link(w,valid,[[admit],[response]]);link(w,admit,[[response]]);link(w,response,[[ack]]);
 }
 return w;
}
function buildTxConsumer(workflow,guard){
 source(workflow,guard);const w={name:'Growth · Retomada retida de pedidos · CANDIDATO OFF',active:false,nodes:[],connections:{},settings:{executionOrder:'v1',timezone:workflow.settings?.timezone||'America/Sao_Paulo',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false,callerPolicy:'workflowsFromSameOwner',availableInMCP:false}};
 const tick=make('Maintenance TX minuto','scheduleTrigger',{rule:{interval:[{field:'cronExpression',expression:'* * * * *'}]}});tick.typeVersion=1.2;w.nodes.push(tick);
 for(const [brand,b] of Object.entries(BRANDS)){
  const prefix='Maintenance TX '+b.label,turn=prefix+' turnos',next=prefix+' próximo',needs=prefix+' assinante ausente';
  const pg=clone(node(workflow,b.claim,'postgres'));Object.assign(pg,{id:next.toLowerCase().replace(/[^a-z0-9]+/g,'-'),name:next,retryOnFail:false});delete pg.onError;pg.parameters={operation:'executeQuery',query:'SELECT * FROM crm_maintenance_candidate.tx_next_v1($1::text);',options:{queryBatching:'independently',queryReplacement:`={{ ['${brand}'] }}`}};
  const names=[b.subscriber,b.claim,b.winner,b.http,b.finish,b.accepted,b.cleanup],copies=names.map(n=>clone(workflow.nodes.find(x=>x.name===n)));
  copies.forEach((n,i)=>{n.id='maintenance-tx-'+brand+'-'+i;n.retryOnFail=false;});
  const sub=copies.find(n=>n.name===b.subscriber);sub.parameters.jsonBody=`={{ {email:$json.body.email,name:$json.body.name,status:"enabled",lists:${brand==='fish'?'[3,17]':'[7,16]'},preconfirm_subscriptions:true} }}`;sub.onError='continueRegularOutput';
  const claim=copies.find(n=>n.name===b.claim);delete claim.onError;claim.parameters={operation:'executeQuery',query:'SELECT * FROM crm_maintenance_candidate.tx_claim_v1($1::uuid);',options:{queryBatching:'independently',queryReplacement:`={{ [$('${next}').item.json.event_id] }}`}};
  const finish=copies.find(n=>n.name===b.finish);finish.parameters.query='SELECT * FROM crm_maintenance_candidate.tx_finish_v1($1::uuid,$2::uuid,$3::jsonb,$4::jsonb);';finish.parameters.options.queryBatching='independently';
  const cleanup=copies.find(n=>n.name===b.cleanup);cleanup.parameters.jsonBody=`={{ {query:"subscribers.email = '"+String($('${b.claim}').item.json.context.email).replace(/'/g,"''")+"'",action:"remove",target_list_ids:${brand==='fish'?'[9]':'[10]'}} }}`;
  w.nodes.push(make(turn,'code',{jsCode:`return Array.from({length:10},()=>({json:{brand:'${brand}'},pairedItem:{item:0}}));`}),pg,boolean(needs,'={{ $json.subscriber_needed === true }}'),...copies);
  link(w,turn,[[next]]);link(w,next,[[needs]]);link(w,needs,[[b.subscriber],[b.claim]]);link(w,b.subscriber,[[b.claim]]);
  for(const n of [b.claim,b.winner,b.http,b.finish,b.accepted])w.connections[n]=clone(workflow.connections[n]);
 }
 link(w,tick.name,[Object.values(BRANDS).map(b=>'Maintenance TX '+b.label+' turnos')]);
 return w;
}
module.exports={TARGET,BRANDS,digest,patchTxProducer,buildTxConsumer};
