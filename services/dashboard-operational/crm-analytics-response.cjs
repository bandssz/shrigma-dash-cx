'use strict';

// This projection follows the authenticated, brand-scoped source validation.
// Preserve whole analytical relations: date fallback, both attribution models,
// duplicate detection and historical UTM ownership depend on their full scope.
const CONSUMERS=Object.freeze({
 'campaigns-read-v1':'campaigns',
 'results-read-v2':'results',
 'journeys-read-v1':'journeys'
});
const COMMON=Object.freeze(['brand','brands','brandAccess','_escopo','_painel',
 'preview','synthetic','gerado_em','_cache_gerado_em','read_issues',
 'crm_attribution','crm_diario','crm_familia_campanha']);
const RELATIONS=Object.freeze({campaigns:['crm_campanha'],
 results:['crm_wa_envios'],journeys:['crm_fluxo','crm_carrinho','crm_wa_envios','cart_contract']});

function project(value,consumer){
 const view=Object.hasOwn(CONSUMERS,consumer)?CONSUMERS[consumer]:null;
 if(!view||!value||typeof value!=='object'||!['aristo','fish'].includes(value.brand)||
  !Array.isArray(value.brands)||value.brands.length!==1||value.brands[0]!==value.brand)
  throw Object.assign(Error('ANALYTICS_RESPONSE_SCOPE_DENIED'),{code:'ANALYTICS_RESPONSE_SCOPE_DENIED',status:502});
 const out={};
 for(const key of [...COMMON,...RELATIONS[view]])if(Object.hasOwn(value,key))out[key]=value[key];
 out.contract='shrigma-crm-analytics-read-v1';out.view=view;
 out.capabilities={read:true,send:false};
 return out;
}
function encode(value,acceptEncoding=''){
 const encodings=new Map();
 for(const part of String(acceptEncoding).toLowerCase().split(',')){
  const [name,...parameters]=part.trim().split(';').map(x=>x.trim());if(!name)continue;let q=1;
  for(const parameter of parameters){const m=/^q=(.*)$/.exec(parameter);if(m)q=Math.min(q,/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(m[1])?Number(m[1]):0);}
  encodings.set(name,Math.min(encodings.get(name)??1,q));
 }
 const identity=(encodings.get('identity')??encodings.get('*')??1)>0;
 const gzip=(encodings.get('gzip')??encodings.get('*')??0)>0;
 if(!identity&&!gzip)throw Object.assign(Error('ANALYTICS_ENCODING_UNAVAILABLE'),{code:'ANALYTICS_ENCODING_UNAVAILABLE',status:406});
 const bytes=Buffer.from(JSON.stringify(value));
 if(gzip){const compressed=require('node:zlib').gzipSync(bytes,{level:1});if(!identity||compressed.length<bytes.length)return {bytes:compressed,encoding:'gzip'};}
 return {bytes,encoding:null};
}
module.exports={CONSUMERS,project,encode};
