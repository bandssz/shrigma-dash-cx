/* Pure minimal patch of a fresh private export. Never logs, deploys or embeds a
 * secret into a source file. Generated exports must remain private. */
'use strict';
const {createProtocol}=require('./ab-registry.cjs');
const {sha256Bytes,stable,canonical,digest}=require('./template-operation-receipt.cjs');
const cryptoSource=[sha256Bytes,stable,canonical,digest].map(f=>f.toString()).join('\n');
const protocolSource=`const AB=(${createProtocol.toString()})();`;
const AUTH_TAIL=`const b = $json.body || {};
// Chave PROPRIA de escrita. A chave de leitura fica no localStorage de todo mundo
// que ja abriu o painel — nao serve para autorizar escrita.
return [{ json: { ok: String(b.k || '') === CHAVE, body: b } }];`;
function patchWorkflow(fresh,{expectedVersion,ids}={}){
 if(!fresh||!expectedVersion||fresh.versionId!==expectedVersion||!ids||!['get','options'].every(k=>typeof ids[k]==='string'&&/^[a-f0-9-]{36}$/.test(ids[k])))throw Error('Fresh version and unique webhook IDs required');
 if(fresh.active&&(fresh.activeVersionId!==fresh.versionId||fresh.activeVersion&&(fresh.activeVersion.versionId!==fresh.versionId||JSON.stringify(fresh.activeVersion.nodes)!==JSON.stringify(fresh.nodes)||JSON.stringify(fresh.activeVersion.connections)!==JSON.stringify(fresh.connections))))throw Error('Saved and active workflow differ');
 const w=JSON.parse(JSON.stringify(fresh));
 const node=name=>{const xs=w.nodes.filter(n=>n.name===name);if(xs.length!==1)throw Error('AB node drift: '+name);return xs[0];};
 const post=node('POST teste'),auth=node('Valida chave'),builder=node('Monta SQL'),pg=node('Grava'),result=node('Resposta'),out=node('200');
 if(w.nodes.length!==9||post.parameters.httpMethod!=='POST'||post.parameters.responseMode!=='responseNode'||!pg.type.endsWith('.postgres')||pg.parameters.query!=='={{ $json.sql }}'||!builder.parameters.jsCode.includes('DELETE FROM crm_teste_braco')||result.parameters.jsCode!=="return [{ json: { ok: true, gravado_em: new Date().toISOString() } }];")throw Error('Current A/B workflow differs from reviewed contract');
 const match=auth.parameters.jsCode.match(/^(const CHAVE = (?:'[^'\n]+'|"[^"\n]+");)\n([\s\S]+)$/);
 if(!match||match[2].trim()!==AUTH_TAIL)throw Error('Authentication source drift');
 const keyDeclaration=match[1];
 const authCode=(readOnly)=>`${keyDeclaration}\n${cryptoSource}\nconst data=$json.${readOnly?'query':'body'}||{};\nconst key=${readOnly?"$json.headers?.['x-ab-write-key']":"data.k"};\nconst ok=typeof key==='string'&&key===CHAVE;\nreturn [{json:{ok,ab_read:${readOnly},data:ok?data:{},actor_sha256:ok?digest({scope:'ab-registry-v1',credential:CHAVE}):null}}];`;
 auth.parameters.jsCode=authCode(false);
 builder.parameters.jsCode=`${protocolSource}\nif($input.all().length!==1||$json.ok!==true)throw Error('AB_INVALID_CONTEXT');\nconst plan=$json.ab_read?AB.read($json.data,$json.actor_sha256):{mode:'write',payload:AB.request($json.data,$json.actor_sha256)};\nreturn [{json:AB.query(plan.mode,plan.payload)}];`;
 pg.parameters.options={...pg.parameters.options,queryReplacement:'={{ $json.parameters }}'};pg.retryOnFail=false;pg.onError='continueErrorOutput';pg.alwaysOutputData=true;
 result.parameters.jsCode=`${protocolSource}\nreturn [{json:AB.response($input.all().length===1?$json.result:null)}];`;
 const headers={entries:[{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'content-type,x-ab-write-key'},{name:'Access-Control-Allow-Methods',value:'GET,POST,OPTIONS'},{name:'Cache-Control',value:'no-store'},{name:'Content-Type',value:'application/json'}]};
 out.parameters.responseBody='={{ JSON.stringify($json.body) }}';out.parameters.options={...out.parameters.options,responseHeaders:headers,responseCode:'={{ $json.status }}'};
 node('400').parameters.responseBody='={{ JSON.stringify({ok:false,code:"invalid_request",erro:"Requisição inválida; nenhuma gravação foi iniciada."}) }}';
 for(const name of ['400','401'])node(name).parameters.options.responseHeaders=headers;
 const get={...JSON.parse(JSON.stringify(post)),id:ids.get,name:'GET cadastro AB',webhookId:ids.get,parameters:{...post.parameters,httpMethod:'GET'}};
 const options={...JSON.parse(JSON.stringify(post)),id:ids.options,name:'OPTIONS cadastro AB',webhookId:ids.options,parameters:{...post.parameters,httpMethod:'OPTIONS'}};
 const readAuth={...JSON.parse(JSON.stringify(auth)),id:'ab-read-auth-v1',name:'Valida consulta AB',parameters:{jsCode:authCode(true)}};
 const optionsResponse={...JSON.parse(JSON.stringify(out)),id:'ab-options-response-v1',name:'204 cadastro AB',parameters:{respondWith:'noData',options:{responseCode:204,responseHeaders:headers}}};
 const failure={id:'ab-storage-failure-v1',name:'Falha de recibo AB',type:'n8n-nodes-base.code',typeVersion:2,position:[900,500],parameters:{jsCode:"return [{json:{status:503,body:{ok:false,code:'operation_uncertain',erro:'Resultado não comprovado. Consulte a mesma operação; não repita com outra chave.'}}}];"}};
 w.nodes.push(get,options,readAuth,optionsResponse,failure);
 const edge=name=>({node:name,type:'main',index:0});
 w.connections[get.name]={main:[[edge(readAuth.name)]]};w.connections[readAuth.name]={main:[[edge('Autorizado?')]]};
 w.connections[options.name]={main:[[edge(optionsResponse.name)]]};
 w.connections.Grava={main:[[edge('Resposta')],[edge(failure.name)]]};w.connections[failure.name]={main:[[edge('200')]]};
 // Query/key snapshots must not enter normal execution retention after cutover.
 w.settings={...w.settings,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false};
 return {workflow:w,contract:'ab_registry_v1',changed:['Valida chave','Monta SQL','Grava','Resposta','200','400','401'],added:[get.name,options.name,readAuth.name,optionsResponse.name,failure.name]};
}
module.exports={patchWorkflow,AUTH_TAIL};
