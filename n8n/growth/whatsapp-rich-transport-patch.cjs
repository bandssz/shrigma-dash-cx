'use strict';
const fs=require('node:fs');
const MARKER='WA_RICH_ORDER_TRANSPORT_GUARD_V1';
const ANCHOR="  if(!template||String(template.id)!==String(input.template_id)||template.name!==input.template_name||template.language!==input.language||template.status!=='APPROVED')return 'template_nao_aprovado_ou_divergente';";
const INSERT="\n  // "+MARKER+": the generic template sender cannot render the native order receipt.\n  if(template.sub_category==='RICH_ORDER_STATUS')return 'template_recibo_nativo_transporte_nao_integrado';";
const BEFORE_FIELDS='id,status,category,name,language,components';
function patch(workflow){
 const out=JSON.parse(JSON.stringify(workflow));
 function node(name,type){const found=out.nodes?.filter(n=>n.name===name&&n.type===type);if(found?.length!==1)throw Error('Unexpected node: '+name);return found[0];}
 const guard=node('Valida template UTILITY','n8n-nodes-base.code');
 const http=node('Meta /template UTILITY','n8n-nodes-base.httpRequest');
 const code=guard.parameters.jsCode;
 if(typeof code!=='string'||code.includes(MARKER)||code.split(ANCHOR).length!==2)throw Error('Contract changed or patch already present');
 // The existing caller must run the contract before a reservation can be made.
 if(!code.includes('WAT.runtime(input,response.body)')||!code.includes('utility_guard_ok:false'))throw Error('Guard caller changed');
 const fields=http.parameters?.queryParameters?.parameters?.filter(p=>p.name==='fields');
 if(fields?.length!==1||fields[0].value!==BEFORE_FIELDS||http.parameters.method&&http.parameters.method!=='GET')throw Error('Metadata reader changed');
 guard.parameters.jsCode=code.replace(ANCHOR,ANCHOR+INSERT);
 fields[0].value=BEFORE_FIELDS+',sub_category';
 return {workflow:out,changes:['Valida template UTILITY: reject native receipt on generic transport','Meta /template UTILITY: read sub_category'],marker:MARKER};
}
module.exports={patch,MARKER,ANCHOR,INSERT,BEFORE_FIELDS};
if(require.main===module){
 const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Expected fresh workflow input and private output');
 fs.writeFileSync(output,JSON.stringify(patch(JSON.parse(fs.readFileSync(input,'utf8'))),null,2),{mode:0o600});
}
