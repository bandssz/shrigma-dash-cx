'use strict';
const PATH='crm-panel-read-v1',ORIGIN='https://bandssz.github.io';
function credential(value){
 if(!value||typeof value.id!=='string'||!value.id||typeof value.name!=='string'||!value.name)throw Error('Reviewed Postgres credential reference required');
 return {postgres:{id:value.id,name:value.name}};
}
function headers(){return {responseHeaders:{entries:[
 {name:'Access-Control-Allow-Origin',value:ORIGIN},{name:'Access-Control-Allow-Headers',value:'Authorization, Content-Type'},
 {name:'Access-Control-Allow-Methods',value:'GET, OPTIONS'},{name:'Cache-Control',value:'no-store, private'},
 {name:'Pragma',value:'no-cache'},{name:'Referrer-Policy',value:'no-referrer'},{name:'X-Content-Type-Options',value:'nosniff'}
]}};}
function buildWorkflow({postgresCredential,name='CRM · Leitura rápida de identidade e cache'}={}){
 const credentials=credential(postgresCredential);
 const get={id:'crm-read-fast-get-v1',webhookId:'be7b10e3-7774-4e4b-98fa-9161f37f925e',name:'GET CRM',type:'n8n-nodes-base.webhook',typeVersion:2,position:[0,0],parameters:{httpMethod:'GET',path:PATH,responseMode:'responseNode',options:{}}};
 const read={id:'crm-read-fast-sql-v1',name:'Autentica e lê CRM',type:'n8n-nodes-base.postgres',typeVersion:2.6,position:[260,0],credentials,parameters:{operation:'executeQuery',query:'SELECT status_code,body FROM public.shrigma_crm_read_fast_v1($1::text,$2::text,$3::jsonb)',options:{queryReplacement:"={{ [$json.headers?.authorization ?? null, $json.headers?.origin ?? null, JSON.stringify($json.query || {})] }}"}}};
 const respond={id:'crm-read-fast-response-v1',name:'Resposta CRM',type:'n8n-nodes-base.respondToWebhook',typeVersion:1.4,position:[520,0],parameters:{respondWith:'json',responseBody:'={{ JSON.stringify($json.body) }}',options:{...headers(),responseCode:'={{ $json.status_code }}'}}};
 const options={id:'crm-read-fast-options-v1',webhookId:'020fd31b-d338-4cbe-b1f6-e58246127029',name:'OPTIONS CRM',type:'n8n-nodes-base.webhook',typeVersion:2,position:[0,220],parameters:{httpMethod:'OPTIONS',path:PATH,responseMode:'responseNode',options:{}}};
 const preflight={id:'crm-read-fast-preflight-v1',name:'Resposta OPTIONS',type:'n8n-nodes-base.respondToWebhook',typeVersion:1.4,position:[260,220],parameters:{respondWith:'noData',options:{...headers(),responseCode:204}}};
 return {name,active:false,nodes:[get,read,respond,options,preflight],connections:{[get.name]:{main:[[{node:read.name,type:'main',index:0}]]},[read.name]:{main:[[{node:respond.name,type:'main',index:0}]]},[options.name]:{main:[[{node:preflight.name,type:'main',index:0}]]}},settings:{callerPolicy:'workflowsFromSameOwner',availableInMCP:false,executionOrder:'v1',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveExecutionProgress:false,saveManualExecutions:false}};
}
module.exports={PATH,ORIGIN,buildWorkflow};
