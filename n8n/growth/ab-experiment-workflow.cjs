'use strict';
// Pure candidate builder: no network, secret, mutation or shared workflow patch.
const C=require('../../growth-ab-experiment-contract.js');
const library=`const C=(${C.createContract.toString()})();`;
function prepareCode(readOnly,origin){return `${library}
const out=(status,error)=>[{json:{ok:false,status,body:{error}}}];
if($input.all().length!==1)return out(422,'AB_V2_REQUEST');
const origin=${JSON.stringify(origin)},supplied=$json.headers?.origin;
if(supplied&&supplied!==origin)return out(403,'AB_V2_ORIGIN');
const raw=$json.${readOnly?'query':'body'};
if(!raw||typeof raw!=='object'||Array.isArray(raw)||JSON.stringify(raw).length>32768)return out(422,'AB_V2_REQUEST');
const key=${readOnly?"$json.headers?.['x-ab-write-key']":"raw.k"};
if(typeof key!=='string'||!key||key.length>4096)return out(401,'AB_V2_MANAGER_REQUIRED');
const {k,method,...p}=raw;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
if(!['fish','aristo'].includes(p.brand))return out(422,'AB_V2_REQUEST');
try{
 if(${readOnly}){
  if(k!==undefined||!['capabilities','list','get','campaigns','operation'].includes(method))throw Error();
  const allowed=['brand',...(method==='get'?['test_id']:method==='operation'?['operation_id','action']:[])];
  if(Object.keys(p).some(k=>!allowed.includes(k))||method==='get'&&!uuid(p.test_id)||method==='operation'&&(!uuid(p.operation_id)||!['prepare','review','schedule','cancel','close'].includes(p.action)))throw Error();
 }else{
  if(method!=='mutate'||Object.keys(p).some(k=>!['brand','operation_id','request_payload'].includes(k))||!uuid(p.operation_id)||p.request_payload?.brand!==p.brand)throw Error();
  p.request_payload=C.request(p.request_payload);
 }
 return [{json:{ok:true,sql:'SELECT public.crm_ab_api_v2($1::text,$2::text,$3::jsonb) AS result',parameters:[key,method,JSON.stringify(p)]}}];
}catch{return out(422,'AB_V2_REQUEST');}`;}
const finishCode=`${library}
const fail=()=>[{json:{status:503,body:{error:'AB_V2_OUTCOME_UNKNOWN'}}}];
if($input.all().length!==1)return fail();
const r=$json.result;if(!r||!Number.isInteger(r.status)||r.status<200||r.status>499||!r.body||typeof r.body!=='object'||Array.isArray(r.body))return fail();
if(r.status!==200&&(!/^AB_V2_[A-Z_]+$/.test(r.body.error||'')))return fail();
try{if(r.body.measurement)r.body.result=C.result(r.body.experiment.protocol,r.body.measurement);return [{json:{status:r.status,body:r.body}}];}catch{return fail();}`;
function buildWorkflow({postgres,allowedOrigin,path='growth-ab-email-v2'}={}){
 if(!postgres||typeof postgres.id!=='string'||!postgres.id||typeof postgres.name!=='string'||!postgres.name||Object.keys(postgres).some(k=>!['id','name'].includes(k)))throw Error('Existing PostgreSQL credential reference required');
 let origin;try{origin=new URL(allowedOrigin);if(origin.protocol!=='https:'||origin.origin!==allowedOrigin)throw Error();}catch{throw Error('Exact HTTPS dashboard origin required');}
 if(typeof path!=='string'||!/^growth-ab-email-v2(?:-[a-z0-9-]+)?$/.test(path))throw Error('Dedicated Growth A/B path required');
 const nodes=[],connections={};
 const add=(name,type,parameters,position,typeVersion=1,extra={})=>{nodes.push({id:'abv2-'+nodes.length,name,type:'n8n-nodes-base.'+type,typeVersion,position,parameters,...extra});};
 const link=(from,to,index=0)=>{connections[from]??={main:[]};connections[from].main[index]??=[];connections[from].main[index].push({node:to,type:'main',index:0});};
 const responseHeaders={entries:[{name:'Access-Control-Allow-Origin',value:allowedOrigin},{name:'Access-Control-Allow-Headers',value:'Content-Type,X-AB-Write-Key'},{name:'Access-Control-Allow-Methods',value:'GET,POST,OPTIONS'},{name:'Cache-Control',value:'no-store'}]};
 add('Ler experimento','webhook',{httpMethod:'GET',path,responseMode:'responseNode',options:{}},[0,0],2);
 add('Alterar experimento','webhook',{httpMethod:'POST',path,responseMode:'responseNode',options:{}},[0,200],2);
 add('Permitir origem','webhook',{httpMethod:'OPTIONS',path,responseMode:'responseNode',options:{}},[0,400],2);
 add('Preparar leitura','code',{jsCode:prepareCode(true,allowedOrigin)},[200,0],2);
 add('Preparar ação','code',{jsCode:prepareCode(false,allowedOrigin)},[200,200],2);
 add('Entrada válida?','if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict'},conditions:[{id:'ok',leftValue:'={{ $json.ok }}',rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}},[420,100],2);
 add('Controle Growth','postgres',{operation:'executeQuery',query:'={{ $json.sql }}',options:{queryReplacement:'={{ $json.parameters }}'}},[640,0],2.6,{credentials:{postgres},onError:'continueErrorOutput'});
 add('Conferir resposta','code',{jsCode:finishCode},[860,0],2);
 add('Resultado incerto','code',{jsCode:"return [{json:{status:503,body:{error:'AB_V2_OUTCOME_UNKNOWN'}}}];"},[860,200],2);
 add('Responder','respondToWebhook',{respondWith:'json',responseBody:'={{ $json.body }}',options:{responseCode:'={{ $json.status }}',responseHeaders}},[1080,100],1.4);
 add('Responder origem','respondToWebhook',{respondWith:'noData',options:{responseCode:204,responseHeaders}},[200,400],1.4);
 link('Ler experimento','Preparar leitura');link('Alterar experimento','Preparar ação');link('Permitir origem','Responder origem');
 link('Preparar leitura','Entrada válida?');link('Preparar ação','Entrada válida?');link('Entrada válida?','Controle Growth');link('Entrada válida?','Responder',1);
 link('Controle Growth','Conferir resposta');link('Controle Growth','Resultado incerto',1);link('Conferir resposta','Responder');link('Resultado incerto','Responder');
 return {name:'CRM — A/B e-mail v2 · candidato desativado',active:false,nodes,connections,settings:{executionOrder:'v1',timezone:'America/Sao_Paulo',executionTimeout:120,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false}};
}
module.exports={buildWorkflow,prepareCode,finishCode};
