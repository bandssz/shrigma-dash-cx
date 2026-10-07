'use strict';
// Projection of the existing authenticated CRM reader. No database or issuer.
const GF=require('./journey-read/growth-flows.js');
const error=(code,status=502)=>{throw Object.assign(Error(code),{code,status});};
function projectJourneyRead(result,brand,{now=()=>new Date().toISOString()}={}){
 if(!['fish','aristo'].includes(brand))error('BRAND_DENIED',403);
 if(result?.status!==200)return {status:result?.status||503,body:{contract:'shrigma-crm-journey-read-v1',brand,source:'unavailable',definitions:[],configuredCount:null,operational:false}};
 const api=result.body;
 if(!GF.obj(api)||api._escopo!==undefined&&api._escopo!=='growth'||api._escopo===undefined&&api._painel!=='growth'||api._painel!==undefined&&api._painel!=='growth')error('JOURNEY_SCOPE_UNCONFIRMED');
 const declared=api.crm_fluxo_def,has=Object.hasOwn(api,'crm_fluxo_def')&&declared!==null;
 if(has&&(!GF.obj(declared)||!Array.isArray(declared.fluxos)))error('JOURNEY_SOURCE_INVALID');
 if(has&&declared.fluxos.length>GF.configuredLimits.flows)error('JOURNEY_SOURCE_LIMIT');
 if(has&&declared.fluxos.some(f=>!GF.obj(f)||!['fish','aristo','olivas'].includes(f.marca)))error('JOURNEY_SCOPE_UNCONFIRMED');
 const scoped={...api,crm_fluxo_def:has?{...declared,fluxos:declared.fluxos.filter(f=>f.marca===brand)}:null};
 for(const k of ['crm_fluxo','crm_wa_envios','crm_operacao','wa_fluxo_saude'])if(Array.isArray(api[k]))scoped[k]=api[k].filter(r=>GF.obj(r)&&r.marca===brand);
 const readAt=now(),found=GF.configuredRead(scoped,{marca:brand,now:Date.parse(readAt)}),definitions=found.definidos;
 const state=found.source.state,valid=['loaded','empty'].includes(state),source=state==='absent'?'definitions-unavailable':valid?'declared':found.invalidosDef?'partial':state;
 return {status:200,body:{contract:'shrigma-crm-journey-read-v1',brand,source,definitionState:state,readAt,cacheGeneratedAt:GF.iso(api._cache_gerado_em),definitionGeneratedAt:found.source.generatedAt,definitionFreshness:found.source.freshness,definitionExpiresAt:found.source.expiresAt,configuredCount:valid?definitions.length:null,invalidDefinitionCount:found.invalidosDef,observedFlowCount:found.observados.length,definitions,readOnly:true,originalTransitionsOnly:true,authorizesEdit:false,authorizesSend:false,operational:false}};
}
function journeySummary(result){
 const b=result.body;
 return {status:result.status,contract:b?.contract,brand:b?.brand,source:b?.source,definitionState:b?.definitionState||null,cacheGeneratedAt:b?.cacheGeneratedAt||null,definitionGeneratedAt:b?.definitionGeneratedAt||null,definitionFreshness:b?.definitionFreshness||'unknown',definitionExpiresAt:b?.definitionExpiresAt||null,configuredCount:b?.configuredCount??null,invalidDefinitionCount:b?.invalidDefinitionCount??null,observedFlowCount:b?.observedFlowCount??null,readOnly:true,operational:false};
}
module.exports={projectJourneyRead,journeySummary};
