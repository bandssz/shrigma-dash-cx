'use strict';
// Pure patch of the deployed v1 registry. Does not publish or change shared login.
const {createProtocol}=require('./ab-registry.cjs');
const {sha256Bytes,stable,canonical,digest}=require('./template-operation-receipt.cjs');
const cryptoSource=[sha256Bytes,stable,canonical,digest].map(f=>f.toString()).join('\n');
const protocolSource=`const AB=(${createProtocol.toString()})();`;
const currentBuilder=`${protocolSource}\nif($input.all().length!==1||$json.ok!==true)throw Error('AB_INVALID_CONTEXT');\nconst plan=$json.ab_read?AB.read($json.data,$json.actor_sha256):{mode:'write',payload:AB.request($json.data,$json.actor_sha256)};\nreturn [{json:AB.query(plan.mode,plan.payload)}];`;
function authTail(readOnly){return `const data=$json.${readOnly?'query':'body'}||{};\nconst key=${readOnly?"$json.headers?.['x-ab-write-key']":"data.k"};\nconst ok=typeof key==='string'&&key===CHAVE;\nreturn [{json:{ok,ab_read:${readOnly},data:ok?data:{},actor_sha256:ok?digest({scope:'ab-registry-v1',credential:CHAVE}):null}}];`;}
function patchWorkflow(fresh,{expectedVersion}={}){
 if(!fresh||!expectedVersion||fresh.versionId!==expectedVersion)throw Error('Fresh A/B version required');
 if(fresh.active&&(fresh.activeVersionId!==fresh.versionId||fresh.activeVersion&&(JSON.stringify(fresh.nodes)!==JSON.stringify(fresh.activeVersion.nodes)||JSON.stringify(fresh.connections)!==JSON.stringify(fresh.activeVersion.connections))))throw Error('A/B saved and active differ');
 const workflow=JSON.parse(JSON.stringify(fresh));
 const node=name=>{const xs=workflow.nodes.filter(n=>n.name===name);if(xs.length!==1)throw Error('A/B node drift: '+name);return xs[0];};
 if(workflow.nodes.length!==14||node('Monta SQL').parameters.jsCode!==currentBuilder||node('Grava').parameters.query!=='={{ $json.sql }}'||node('Grava').parameters.options.queryReplacement!=='={{ $json.parameters }}')throw Error('A/B registry contract drift');
 for(const [name,readOnly] of [['Valida chave',false],['Valida consulta AB',true]]){
  const n=node(name),source=n.parameters.jsCode,match=source.match(/^(const CHAVE = (?:'[^'\n]+'|"[^"\n]+");)\n/);
  if(!match||source!==match[1]+'\n'+cryptoSource+'\n'+authTail(readOnly))throw Error('A/B authentication drift');
  n.parameters.jsCode=match[1]+'\n'+cryptoSource+'\n'+`const raw=$json.${readOnly?'query':'body'}||{};
const key=${readOnly?"$json.headers?.['x-ab-write-key']":"raw.k"};
const ok=typeof key==='string'&&key.length>0&&key.length<=4096;
const legacy=ok&&key===CHAVE;
const {k,...data}=raw;
return [{json:{ok,ab_read:${readOnly},data:ok?data:{},actor_sha256:legacy?digest({scope:'ab-registry-v1',credential:CHAVE}):'0'.repeat(64),operator_key:ok&&!legacy?key:null}}];`;
 }
 node('Monta SQL').parameters.jsCode=currentBuilder.replace('return [{json:AB.query(plan.mode,plan.payload)}];',`const query=$json.operator_key?{sql:'SELECT public.crm_ab_operator_registry_v1($1::text,$2::text,$3::jsonb) AS result',parameters:[$json.operator_key,plan.mode,JSON.stringify(plan.payload)]}:AB.query(plan.mode,plan.payload);
return [{json:query}];`);
 workflow.settings={...workflow.settings,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false};
 return {workflow,changed:['Valida chave','Valida consulta AB','Monta SQL'],contract:'ab_registry_v1',access:'crm_operator_or_legacy'};
}
module.exports={patchWorkflow,currentBuilder,authTail};
