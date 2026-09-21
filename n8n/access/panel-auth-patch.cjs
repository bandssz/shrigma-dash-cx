'use strict';
const IDS={builder:'forPBbJojntCcLGN',shared:'mfP48DvaKeCt2r2p',cache:'Opom9DypMMhycd7S',influs:'SVM6ojSUrFZkZd0L',tts:'ZRPkPSaMRw35uZQj'};
const ORIGIN='https://bandssz.github.io';
function requestAccess(input,area){
 const headers=input?.headers||{},b=input?.body||{},q=input?.query||{};
 const auth=headers.authorization,hasHeader=Object.hasOwn(headers,'authorization');
 const raw=hasHeader?(typeof auth==='string'&&auth.startsWith('Bearer ')?auth.slice(7):''):(area==='shared'||area==='cache'?q.k:b.k);
 const originOK=!headers.origin||headers.origin==='https://bandssz.github.io';
 const k=originOK&&typeof raw==='string'&&/^[a-z0-9-]{8,128}$/.test(raw)?raw:'';
 const pedido=area==='shared'?(typeof q.painel==='string'?q.painel:''):area==='cache'?'cx':'influs';
 return {k,pedido,transport:hasHeader?'header':'legacy',accessOnly:q.access==='1',originOK};
}
function patchWorkflow(fresh,{expectedVersionId,area,serviceCredential}={}){
 if(!IDS[area]||fresh?.id!==IDS[area]||!expectedVersionId||fresh.versionId!==expectedVersionId)throw Error('Fresh workflow identity/version required');
 const w=structuredClone(fresh),node=name=>{const a=w.nodes.filter(n=>n.name===name);if(a.length!==1)throw Error('Node changed: '+name);return a[0];};
 if(w.nodes.some(n=>n.name==='Identidade de acesso'))throw Error('Already installed; reconcile before editing');
 if(area==='builder'){
  const key=node('Chave do CX'),http=node('API de leitura (painel=cx)');
  if(!key.parameters.query.includes("WHERE painel = 'cx' AND ativo ORDER BY")||!http.parameters.url.includes('?k={{ $json.chave }}&'))throw Error('Cache service credential contract changed');
  if(!serviceCredential||typeof serviceCredential.id!=='string'||typeof serviceCredential.name!=='string')throw Error('Vault credential reference required');
  key.parameters.query='SELECT extract(epoch from now())*1000 AS ms';
  http.parameters.url=http.parameters.url.replace('?k={{ $json.chave }}&','?');http.parameters.authentication='genericCredentialType';http.parameters.genericAuthType='httpHeaderAuth';
  http.credentials={...http.credentials,httpHeaderAuth:{id:serviceCredential.id,name:serviceCredential.name}};
  w.settings={...w.settings,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveExecutionProgress:false,saveManualExecutions:false};
  return w;
 }
 const val=node('Valida chave'),auth=node(area==='shared'?'Busca painel':area==='cache'?'Chave':'Painel da chave');
 if(val.type!=='n8n-nodes-base.code'||auth.type!=='n8n-nodes-base.postgres'||!auth.parameters.query.includes('crm_dash_chave'))throw Error('Auth contract changed');
 const fn='const a=('+requestAccess.toString()+')($json,'+JSON.stringify(area)+');\n';
 if(area==='influs'){
  // Keep the existing write credential in its current server-side node, never export it as source.
  const declaration=val.parameters.jsCode.match(/const ESCRITA\s*=\s*(['"])[^'"\r\n]+\1;/)?.[0];
  if(!declaration)throw Error('Existing writer declaration changed');
  val.parameters.jsCode=declaration+'\n'+fn+"const b=$json.body||{};return [{json:{...a,acao:String(b.acao||''),body:b,ehEscrita:a.originOK&&typeof b.k==='string'&&b.k===ESCRITA}}];";
 }else val.parameters.jsCode=fn+"return [{json:{...a,body:$json.body||{}}}];";
 auth.parameters.query='SELECT * FROM public.shrigma_panel_auth_v1($1::text,$2::text,$3::text)';
 auth.parameters.options={...auth.parameters.options,queryReplacement:'={{ [$json.k, $json.pedido, $json.transport] }}'};
 auth.alwaysOutputData=true;
 if(area==='shared'){
  const route=w.connections['Autorizado?']?.main;
  if(route?.[0]?.length!==1||route[0][0].node!=='Consulta payload')throw Error('Payload routing changed');
  const test={id:'panel-access-only-v1',name:'Somente identidade?',type:'n8n-nodes-base.if',typeVersion:2.2,position:[800,-300],parameters:{conditions:{options:{caseSensitive:true,version:2},conditions:[{id:'access-only',leftValue:"={{ $('Valida chave').first().json.accessOnly }}",rightValue:'',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}};
  const response={id:'panel-access-identity-v1',name:'Identidade de acesso',type:'n8n-nodes-base.respondToWebhook',typeVersion:1.4,position:[1050,-450],parameters:{respondWith:'json',responseBody:"={{ JSON.stringify({schema:'shrigma_access_identity_v1',role:$json.painel==='todos'?'master':'manager',panel:$json.painel,owner:$json.dono,allowedPanels:$json.painel==='todos'?['cx','growth','organico','influs']:[$json.painel]}) }}",options:{}}};
  w.nodes.push(test,response);route[0]=[{node:test.name,type:'main',index:0}];w.connections[test.name]={main:[[{node:response.name,type:'main',index:0}],[{node:'Consulta payload',type:'main',index:0}]]};
 }
 for(const n of w.nodes){
  if(n.type==='n8n-nodes-base.respondToWebhook'){
   const o=n.parameters.options||(n.parameters.options={});const entries=o.responseHeaders?.entries||[];
   const names=['access-control-allow-origin','cache-control','pragma','referrer-policy','x-content-type-options'];
   o.responseHeaders={entries:[...entries.filter(h=>!names.includes(h.name.toLowerCase())),{name:'Access-Control-Allow-Origin',value:ORIGIN},{name:'Cache-Control',value:'no-store, private'},{name:'Pragma',value:'no-cache'},{name:'Referrer-Policy',value:'no-referrer'},{name:'X-Content-Type-Options',value:'nosniff'}]};
  }
 }
 w.settings={...w.settings,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveExecutionProgress:false,saveManualExecutions:false};
 return w;
}
module.exports={IDS,ORIGIN,requestAccess,patchWorkflow};
