/* Pure patch of the Growth journey route, on a freshly exported workflow.
 * Does not write n8n or alter authentication, templates, connections or settings.
 */
'use strict';
const ANCHOR="if(['fluxos_listar','fluxo_salvar','fluxo_validar','fluxo_publicar','fluxo_estado'].includes(acao)){";
const STATE="...(acao==='fluxo_estado'?{enabled:b.enabled}:{})";
const READ=`// FLOW_OPERATION_RECEIPT_V1: GET only; no replay and no writes.
if(acao==='fluxo_operacao'){
 if(method!=='GET')return [out(405,{erro:'metodo_invalido'})];
 return [{json:{_step:'pg_leitura',flow_api:true,
  sql:'SELECT public.shrigma_flow_operation_v1($1::text,$2::jsonb,$3::jsonb) AS result',
  sqlParameters:[auth.who,JSON.stringify(auth.caps),JSON.stringify({operation_action:q.operation_action,idempotency_key:q.idempotency_key})]}}];
}

`;
function patch(workflow,{expectedVersion}={}){
 if(workflow?.id!=='y6qJRcWcSfEZzwgZ'||!expectedVersion||workflow.versionId!==expectedVersion)throw Error('FLOW_PATCH_VERSION_MISMATCH');
 const out=JSON.parse(JSON.stringify(workflow)),nodes=out.nodes.filter(n=>n.name==='Prepara');
 if(nodes.length!==1||out.nodes.find(n=>n.name==='PG leitura')?.parameters?.options?.queryReplacement!=='={{ $json.sqlParameters || [] }}')throw Error('FLOW_PATCH_RUNTIME_MISMATCH');
 const code=nodes[0].parameters.jsCode;
 if(code.includes('FLOW_OPERATION_RECEIPT_V1')||code.split(ANCHOR).length!==2||code.split(STATE).length!==2)throw Error('FLOW_PATCH_ANCHOR_MISMATCH');
 nodes[0].parameters.jsCode=code.replace(ANCHOR,READ+ANCHOR).replace(STATE,"...(acao==='fluxo_estado'?{enabled:b.enabled,confirm:b.confirm}:{})");
 return out;
}
module.exports={patch,ANCHOR,STATE,READ};
