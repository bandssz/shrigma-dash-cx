'use strict';
// Optional native parameters on the EXISTING authenticated maintenance utility.
// No endpoint, credential, auth rule, SQL text or permission is introduced here.
const WORKFLOW_ID='ygVyBPjJqGqt2V5E';
function nativeArguments(body){
 if(body==null||!Object.prototype.hasOwnProperty.call(body,'args'))return [];
 if(!Array.isArray(body.args)||body.args.length>128||body.args.some(x=>x!==null&&!['string','number','boolean'].includes(typeof x))||body.args.some(x=>typeof x==='number'&&!Number.isFinite(x)))throw Error('SQL_ARGS_INVALID');
 return body.args;
}
const EXPRESSION='={{ ('+nativeArguments.toString()+')($json.body) }}';
function ensure(ok,message){if(!ok)throw Error(message);}
function patchUtility(fresh,{expectedVersionId}={}){
 ensure(fresh?.id===WORKFLOW_ID&&expectedVersionId&&fresh.versionId===expectedVersionId,'Fresh utility identity and version required');
 ensure(Array.isArray(fresh.nodes),'Expected utility nodes');
 const workflow=structuredClone(fresh),sql=workflow.nodes.filter(n=>n.name==='SQL'),auth=workflow.nodes.filter(n=>n.name==='Chave confere?'),webhook=workflow.nodes.filter(n=>n.name==='Webhook');
 ensure(sql.length===1&&sql[0].type==='n8n-nodes-base.postgres'&&sql[0].typeVersion===2.6&&sql[0].parameters?.operation==='executeQuery'&&sql[0].parameters.query==='={{ $json.body.q }}','Current native SQL node changed');
 ensure(auth.length===1&&auth[0].type==='n8n-nodes-base.if'&&webhook.length===1&&webhook[0].type==='n8n-nodes-base.webhook'&&webhook[0].parameters?.httpMethod==='POST','Existing authenticated POST route required');
 ensure(JSON.stringify(workflow.connections?.Webhook?.main)===JSON.stringify([[{node:'Chave confere?',type:'main',index:0}]])&&JSON.stringify(workflow.connections?.['Chave confere?']?.main)===JSON.stringify([[{node:'SQL',type:'main',index:0}],[{node:'Nega 401',type:'main',index:0}]]),'Existing auth gate routing changed');
 const options=sql[0].parameters.options;
 ensure(options&&typeof options==='object'&&!Array.isArray(options),'Current SQL options changed');
 if(Object.prototype.hasOwnProperty.call(options,'queryReplacement')){
  ensure(options.queryReplacement===EXPRESSION,'Existing parameter contract differs');return {workflow,changes:[]};
 }
 options.queryReplacement=EXPRESSION;
 return {workflow,changes:[{node:'SQL',field:'options.queryReplacement'}]};
}
module.exports={WORKFLOW_ID,EXPRESSION,nativeArguments,patchUtility};
