'use strict';
const MARKER='TEMPLATE_RESPONSE_STEP_V1';
function normalizeResponse(item){
 const json=item?.json;
 if(!json||typeof json!=='object'||Array.isArray(json))return item;
 const own=key=>Object.prototype.hasOwnProperty.call(json,key);
 if(own('_step')||own('sql')||own('sqlParameters')||!own('_http')||!own('_body')||!Number.isInteger(json._http)||json._http<200||json._http>599)return item;
 return {...item,json:{...json,_step:'resposta'}};
}
// Keep the published wrapper byte-for-byte recognizable by future builders.
const PREFIX='// '+MARKER+': route explicit HTTP responses through the existing response branch.\nconst __templatePreparedOutput=(()=>{\n';
const SUFFIX='\n})();\nif(!Array.isArray(__templatePreparedOutput))throw new Error("Template output contract changed");\nreturn __templatePreparedOutput.map('+normalizeResponse.toString()+');\n';
function finalizePrepareCode(code){
 if(typeof code!=='string'||!code.trim())throw Error('Expected Prepare Code source');
 if(code.includes(MARKER)){
  if(code.split(MARKER).length!==2||!code.startsWith(PREFIX)||!code.endsWith(SUFFIX))throw Error('Unrecognized template response wrapper');
  return code;
 }
 return PREFIX+code+SUFFIX;
}
function assertResponseRoute(workflow){
 const node=(name,type)=>{
  const matches=workflow?.nodes?.filter(n=>n.name===name);
  if(matches?.length!==1||matches[0].type!==type||matches[0].disabled)throw Error('Expected one enabled '+name+' node');
  return matches[0];
 };
 node('Prepara','n8n-nodes-base.code');
 const response=node('Responde','n8n-nodes-base.respondToWebhook');
 const outgoing=workflow.connections?.Prepara?.main;
 if(outgoing?.length!==1||outgoing[0]?.length!==1)throw Error('Prepare routing changed');
 const target=outgoing[0][0];
 if(target.type!=='main'||target.index!==0)throw Error('Prepare connection changed');
 const branch=node(target.node,'n8n-nodes-base.switch');
 const condition=branch.parameters?.rules?.values?.[0]?.conditions?.conditions;
 if(condition?.length!==1||condition[0].leftValue!=='={{ $json._step }}'||condition[0].rightValue!=='resposta'||condition[0].operator?.type!=='string'||condition[0].operator?.operation!=='equals')throw Error('Response route changed');
 const targets=workflow.connections?.[branch.name]?.main?.[0];
 if(targets?.length!==1||targets[0].node!=='Responde'||targets[0].type!=='main'||targets[0].index!==0)throw Error('Response connection changed');
 if(response.parameters?.respondWith!=='json'||response.parameters.options?.responseCode!=='={{ $json._http }}'||!['={{ $json._body }}','={{ JSON.stringify($json._body) }}'].includes(response.parameters.responseBody))throw Error('Response contract changed');
}
module.exports={MARKER,PREFIX,SUFFIX,normalizeResponse,finalizePrepareCode,assertResponseRoute};
