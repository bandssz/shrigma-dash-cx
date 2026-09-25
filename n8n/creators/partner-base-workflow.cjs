'use strict';
const fs=require('node:fs'),path=require('node:path');
// New isolated Growth workflow: it does not patch any existing collector or utility.
function build({shops,postgresCredential,apiVersion='2026-07',maintenanceTrigger=null}){
 if(!/^20\d{2}-(01|04|07|10)$/.test(apiVersion)||!postgresCredential?.id)throw Error('Verified API version and vault credentials required');
 if(!Array.isArray(shops)||shops.length!==2||new Set(shops.map(s=>s.marca)).size!==2||shops.some(s=>!['aristo','fish'].includes(s.marca)||!s.credential?.id||!/^https:\/\/[a-z0-9-]+\.myshopify\.com$/.test(s.origin)))throw Error('Verified aristo/fish stores required');
 if(maintenanceTrigger&&(!/^[a-z0-9-]{16,128}$/.test(maintenanceTrigger.path)||!maintenanceTrigger.credential?.id))throw Error('Authenticated maintenance trigger required');
 const lib=fs.readFileSync(path.join(__dirname,'partner-base-collector.cjs'),'utf8').replace(/^module\.exports.*$/m,'');
 const node=(name,type,parameters,x,y=0,extra={})=>({id:name.replace(/[^a-zA-Z0-9]/g,'-'),name,type:'n8n-nodes-base.'+type,typeVersion:type==='httpRequest'?4.2:type==='postgres'?2.6:type==='code'?2:type==='scheduleTrigger'?1.2:type==='splitInBatches'?3:1,position:[x,y],parameters,...extra});
 const nodes=[
  node('Diário 06:27','scheduleTrigger',{rule:{interval:[{field:'cronExpression',expression:'27 6 * * *'}]}},0),
  node('Executar internamente','executeWorkflowTrigger',{inputSource:'passthrough'},0,160),
  node('Janela de coleta','code',{jsCode:String.raw`const input=$json.body||$json;const today=new Date(Date.now()-3*3600000).toISOString().slice(0,10);const until=input.until||today;const since=input.since||new Date(Date.parse(until+'T12:00:00Z')-366*86400000).toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(since)||!/^\d{4}-\d{2}-\d{2}$/.test(until))throw Error('Invalid collection window');return [{json:{since,until}}];`},200),
  node('Pedidos pendentes','postgres',{operation:'executeQuery',query:'SELECT public.crm_partner_base_pendente_v1($1::date,$2::date) AS pedidos',options:{queryReplacement:'={{ [$json.since,$json.until] }}'}},400,0,{credentials:{postgres:postgresCredential}}),
  node('Há pedidos','if',{conditions:{boolean:[{value1:'={{ Array.isArray($json.pedidos) && $json.pedidos.length > 0 }}',value2:true}]}},500),
  node('Nenhum pedido','code',{jsCode:'return [{json:{ok:true,pedidos:0,commission_payable:false}}];'},700,-200),
  node('Separar pedidos','code',{jsCode:'return ($json.pedidos||[]).map(p=>({json:p}));'},600),
  node('Um pedido por vez','splitInBatches',{batchSize:1,options:{}},800),
  node('Pedido em coleta','code',{jsCode:lib+'\nreturn [{json:{estado:begin($json)}}];'},1000,160),
  node('Próxima consulta','code',{jsCode:lib+'\nreturn [{json:{estado:$json.estado,request:request($json.estado)}}];'},1200,160),
  node('Marca Aristo','if',{conditions:{string:[{value1:'={{ $json.estado.marca }}',operation:'equal',value2:'aristo'}]}},1400,160),
  node('Conferir resposta','code',{jsCode:lib+'\nconst estado=$("Próxima consulta").item.json.estado;try{const r=$json;if(r.statusCode!==200)throw Error("Shopify financial HTTP request failed");return [{json:{estado:accept(estado,r.body),failed:false}}];}catch{return [{json:{failed:true,marca:estado.marca,order_id:estado.order_id}}];}'},1800,160),
  node('Coleta válida','if',{conditions:{boolean:[{value1:'={{ $json.failed }}',value2:false}]}},1900,160),
  node('Concluir coleta','code',{jsCode:'const results=$input.all().map(i=>i.json);const failed=results.filter(r=>r.failed).length;if(failed)throw Error(failed+" pedido(s) sem leitura financeira confirmada; snapshots anteriores preservados.");return [{json:{ok:true,pedidos:results.length,commission_payable:false}}];'},1000,-200),
  node('Pedido completo','if',{conditions:{boolean:[{value1:'={{ $json.estado.done }}',value2:true}]}},2000,160),
  node('Registrar falha','postgres',{operation:'executeQuery',query:'SELECT true AS failed, public.crm_partner_base_failure_v1($1::jsonb) AS resultado',options:{queryReplacement:'={{ [JSON.stringify({marca:$json.marca,order_id:$json.order_id})] }}'}},2200,320,{credentials:{postgres:postgresCredential}}),
  node('Gravar base','postgres',{operation:'executeQuery',query:'SELECT public.crm_partner_base_ingest_v1($1::jsonb) AS resultado',options:{queryReplacement:'={{ [JSON.stringify({rows:[$json.estado.row]})] }}'}},2200,0,{credentials:{postgres:postgresCredential}}),
 ];
 for(const [i,marca]of ['aristo','fish'].entries()){
  const shop=shops.find(s=>s.marca===marca);
  nodes.push(node('Shopify '+marca,'httpRequest',{method:'POST',url:shop.origin+'/admin/api/'+apiVersion+'/graphql.json',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json.request) }}',options:{timeout:60000,response:{response:{fullResponse:true,neverError:false,responseFormat:'json'}},redirect:{redirect:{followRedirects:false}}}},1600,i*240,{credentials:{httpHeaderAuth:shop.credential},retryOnFail:true,maxTries:3,waitBetweenTries:2000,onError:'continueRegularOutput'}));
 }
 const connections={},edge=(a,b,out=0)=>{connections[a]??={main:[]};connections[a].main[out]=[{node:b,type:'main',index:0}];};
 for(const [a,b]of [['Diário 06:27','Janela de coleta'],['Executar internamente','Janela de coleta'],['Janela de coleta','Pedidos pendentes'],['Pedidos pendentes','Há pedidos'],['Separar pedidos','Um pedido por vez'],['Pedido em coleta','Próxima consulta'],['Próxima consulta','Marca Aristo'],['Shopify aristo','Conferir resposta'],['Shopify fish','Conferir resposta'],['Conferir resposta','Coleta válida'],['Gravar base','Um pedido por vez']])edge(a,b);
 edge('Há pedidos','Separar pedidos');edge('Há pedidos','Nenhum pedido',1);edge('Um pedido por vez','Pedido em coleta',1);edge('Um pedido por vez','Concluir coleta');edge('Coleta válida','Pedido completo');edge('Coleta válida','Registrar falha',1);edge('Registrar falha','Um pedido por vez');edge('Marca Aristo','Shopify aristo');edge('Marca Aristo','Shopify fish',1);edge('Pedido completo','Gravar base');edge('Pedido completo','Próxima consulta',1);
 if(maintenanceTrigger){nodes.push(node('Manutenção autenticada','webhook',{path:maintenanceTrigger.path,httpMethod:'POST',authentication:'headerAuth',responseMode:'lastNode',options:{}},0,320,{credentials:{httpHeaderAuth:maintenanceTrigger.credential},webhookId:maintenanceTrigger.path}));edge('Manutenção autenticada','Janela de coleta');}
 return {name:'Growth — Shopify · base financeira de parceiros',nodes,connections,settings:{executionOrder:'v1',callerPolicy:'workflowsFromSameOwner',timezone:'America/Sao_Paulo',executionTimeout:1800,saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveManualExecutions:false,availableInMCP:false}};
}
module.exports={build};
