'use strict';
// Aggregate accounting only. Never exports values, arbitrary property names,
// rows, identities, samples or hashes of business data.
const ROOT=Object.freeze(['contract','schema_version','brand','brands','painel','_painel','_escopo','preview','synthetic','gerado_em','_cache_gerado_em','crm_attribution','_attribution_legacy','crm_diario','crm_intradia','crm_campanha','crm_fluxo','crm_conversao','crm_contato','crm_publico','crm_modelo','crm_lista','crm_carrinho','crm_familia_campanha','crm_campanha_receita','crm_campanha_grupo','crm_reenvio','crm_falha','crm_fontes','crm_ab','crm_teste','crm_testes','crm_teste_ab','crm_pix','crm_utm_orfa','crm_arvore_snapshot','crm_wa_envios','wa_saude','wa_fluxo_saude','wa_template','wa_fluxo','crm_collection_receipt','crm_automacao','flow_attribution','capabilities','coleta','saude','clientes','conciliacao','shopify','meta','metadata','data','daily','quality','coverage']);
const ATTRIBUTION=Object.freeze(['schema_version','default_model','money_basis','generated_at','window_days','daily','quality','coverage','campaigns','flows','totals','reconciliation','hourly','conv','pieces','dispatches','dispatch_daily','pix_daily','dispatch_evidence','pix_charge']);
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8'),type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
function account(object,known,prefix){
 const fields=Object.keys(object),rows=[],unknown={fields:0,memberBytes:0};let members=0;
 for(const key of fields){const value=object[key],valueBytes=bytes(value),memberBytes=bytes(key)+1+valueBytes;members+=memberBytes;if(known.includes(key))rows.push({path:prefix+key,memberBytes,valueBytes,type:type(value),...(Array.isArray(value)?{items:value.length}:{})});else{unknown.fields++;unknown.memberBytes+=memberBytes;}}
 const overheadBytes=2+Math.max(0,fields.length-1),serializedBytes=members+overheadBytes;
 return{rows,unknown,overheadBytes,serializedBytes};
}
function measure(value,{sourceBytes,sourceKind}={}){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||!Number.isSafeInteger(sourceBytes)||sourceBytes<0||!['home','full'].includes(sourceKind))throw Error('PAYLOAD_MEASUREMENT_ARGUMENTS');
 const root=account(value,ROOT,''),attribution=value.crm_attribution&&Object.getPrototypeOf(value.crm_attribution)===Object.prototype?account(value.crm_attribution,ATTRIBUTION,'crm_attribution.'):null;
 return{schema:'crm-read-payload-shape-v1',sourceKind,sourceBytes,serializedBytes:root.serializedBytes,exactSourceMatch:sourceBytes===root.serializedBytes,sourceSerializationDeltaBytes:sourceBytes-root.serializedBytes,rootOverheadBytes:root.overheadBytes,root:root.rows,unknownRoot:root.unknown,...(attribution?{attribution:attribution.rows,unknownAttribution:attribution.unknown,attributionOverheadBytes:attribution.overheadBytes}:{}),rowsAndValuesExported:false};
}
// Compact aggregate header; the response body and upstream headers stay intact.
function headerValue(shape){
 if(shape?.schema!=='crm-read-payload-shape-v1')throw Error('PAYLOAD_MEASUREMENT_SHAPE');
 const minimal={schema:'crm-read-payload-shape-header-v1',unavailable:true};
 if(shape.unavailable===true)return Buffer.from(JSON.stringify(minimal)).toString('base64url');
 const rows=(values,known,prefix)=>values.map(r=>{if(!known.some(k=>prefix+k===r.path)||!['memberBytes','valueBytes'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0)||!['null','array','object','string','number','boolean'].includes(r.type)||r.items!==undefined&&(!Number.isSafeInteger(r.items)||r.items<0))throw Error('PAYLOAD_MEASUREMENT_SHAPE');return[r.path,r.memberBytes,r.valueBytes,r.type,...(r.items===undefined?[]:[r.items])];});
 const compact={schema:'crm-read-payload-shape-header-v1',kind:shape.sourceKind,sourceBytes:shape.sourceBytes,serializedBytes:shape.serializedBytes,deltaBytes:shape.sourceSerializationDeltaBytes,rootOverhead:shape.rootOverheadBytes,exact:shape.exactSourceMatch,root:rows(shape.root,ROOT,''),unknownRoot:shape.unknownRoot,...(shape.attribution?{attribution:rows(shape.attribution,ATTRIBUTION,'crm_attribution.'),unknownAttribution:shape.unknownAttribution,attributionOverhead:shape.attributionOverheadBytes}:{}),captureMs:shape.captureMs};
 const value=Buffer.from(JSON.stringify(compact)).toString('base64url');return Buffer.byteLength(value)<=6144?value:Buffer.from(JSON.stringify(minimal)).toString('base64url');
}
module.exports=Object.freeze({measure,headerValue,ROOT,ATTRIBUTION});
