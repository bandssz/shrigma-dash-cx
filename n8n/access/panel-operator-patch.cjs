'use strict';
const IDS={shared:'mfP48DvaKeCt2r2p',influs:'SVM6ojSUrFZkZd0L',campaign:'tHER2Ecq2VHcBHOQ',templates:'y6qJRcWcSfEZzwgZ'};
function patchWorkflow(fresh,{expectedVersionId,area}={}){
 if(fresh?.id!==IDS[area]||fresh.versionId!==expectedVersionId)throw Error('Fresh workflow required');
 const w=structuredClone(fresh),node=name=>{const n=w.nodes.filter(n=>n.name===name);if(n.length!==1)throw Error('Node drift: '+name);return n[0];};
 if(area==='shared'){
  const n=node('Busca painel');if(n.parameters.query!=='SELECT * FROM public.shrigma_panel_auth_v1($1::text,$2::text,$3::text)')throw Error('Shared auth changed');
  n.parameters.query="SELECT a.*,jsonb_build_object('growth',public.shrigma_panel_operator_v1($1,'growth'),'influs',public.shrigma_panel_operator_v1($1,'influs')) AS permissions FROM public.shrigma_panel_auth_v1($1::text,$2::text,$3::text) a";
  const r=node('Identidade de acesso');if(!r.parameters.responseBody.includes("owner:$json.dono,"))throw Error('Identity changed');r.parameters.responseBody=r.parameters.responseBody.replace('owner:$json.dono,','owner:$json.dono,permissions:$json.permissions||{},');
 }else if(area==='influs'){
  const n=node('Painel da chave');if(!n.parameters.query.includes('shrigma_panel_auth_v1'))throw Error('Influs auth changed');
  n.parameters.query="SELECT a.*,public.shrigma_panel_operator_v1($1,'influs') AS operator FROM (SELECT 1) seed LEFT JOIN LATERAL public.shrigma_panel_auth_v1($1::text,$2::text,$3::text) a ON true";
  const gate=node('Decide acesso');if(!gate.parameters.jsCode.includes('v.acao ==='))throw Error('Gate changed');
  gate.parameters.jsCode="const v=$('Valida chave').first().json;const a=$input.first().json||{},op=a.operator;const writer=v.ehEscrita||(v.originOK&&Array.isArray(op?.caps)&&op.caps.includes('creators_edit'));const ok=v.acao==='listar'?(!!a.painel||writer):writer;return [{json:{ok,acao:v.acao,body:{...v.body,...(writer&&op?{autor:op.label}: {})}}}];";
 }else{
  const n=node(area==='campaign'?'Autentica':'Autenticação entrada'),field=area==='campaign'?'query':'jsCode';
  if(!n.parameters[field].includes('shrigma_template_auth_v2'))throw Error('CRM auth changed');
  n.parameters[field]=n.parameters[field].replaceAll('shrigma_template_auth_v2','shrigma_crm_operator_auth_v1');
 }
 return w;
}
module.exports={IDS,patchWorkflow};
