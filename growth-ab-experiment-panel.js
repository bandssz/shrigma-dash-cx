/* Growth composition uses the verified server capability; defaults OFF.
 * Existing drafts and operation receipts survive capability withdrawal. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GABExperimentPanel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const ACTIVATION=Object.freeze({enabled:false,endpoint:null});
 function activation(api,brand){
  const c=api?.capabilities?.ab_experiment;let endpoint=null;
  try{const u=new URL(api.capabilities.endpoints.ab_experiment);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash)endpoint=u.href;}catch{}
  if(c?.contract_version!=='crm-ab-email-v2'||c?.audience_mode!=='saved-audience-v1'||c?.enabled!==true||c?.operation!==true||!Array.isArray(c.brands)||!c.brands.length||c.brands.length>2||new Set(c.brands).size!==c.brands.length||c.brands.some(b=>!['fish','aristo'].includes(b))||!c.brands.includes(brand)||!endpoint)return ACTIVATION;
  return Object.freeze({enabled:true,endpoint,audience_mode:'saved-audience-v1'});
 }
 function create({experimentClient,experimentUI,campaignAPI,getManagerKey,restoreBrand,campaignContext,storage,locks,fetch,uuid}={}){
  if(!experimentClient?.create||!experimentUI?.mount||!campaignAPI?.createClient||typeof getManagerKey!=='function'||typeof restoreBrand!=='function'||typeof campaignContext?.status!=='function'||typeof campaignContext?.preserve!=='function')throw Error('Growth A/B integration dependencies required');
  let view=null,brand=null,target=null;
  function status(){return view?.contextStatus()||{blocked:false,dirty:false,pending:false};}
  function render({element,marca,api,activation=ACTIVATION}={}){
   // A global render may run while a confirmation is open. Keep the same mounted
   // clients and frozen endpoints; never replace the pending operation's context.
   const current=status(),foreign=!!current.pendingBrand&&current.pendingBrand!==brand;
   if(view&&(current.blocked||!foreign&&(current.dirty||current.pending)))return view;
   if(view&&foreign&&current.dirty)view.preserve();
   if(activation.enabled!==true){view?.destroy();if(target)target.hidden=true;if(element)element.hidden=true;view=null;brand=null;target=null;return null;}
   if(view&&target===element&&brand===marca&&!foreign)return view;
   if(!element||!['fish','aristo'].includes(marca)){
    // A clean view may leave the supported brands. Unmount listeners without
    // clearing durable drafts or receipts, and never expose its prior brand.
    view?.destroy();if(target)target.hidden=true;if(element)element.hidden=true;
    view=null;brand=null;target=null;return null;
   }
   const key=()=>{const k=getManagerKey();if(typeof k!=='string'||!k)throw Error('Entre no CRM para continuar.');return k;};
   let client=experimentClient.create({brand:marca,endpoint:activation.endpoint,audienceMode:activation.audience_mode==='saved-audience-v1',getKey:key,storage,locks,fetch,uuid});
   const operation=client.inspect().pending;
   if(operation&&operation.request_payload.brand!==marca){
    const original=operation.request_payload.brand,c=campaignContext.status();
    if(c.blocked||c.pending)throw Error('Preserve a operação da campanha antes de abrir a marca da tentativa A/B.');
    campaignContext.preserve();
    if(restoreBrand(original,{reason:'pending_ab_operation',operation_id:operation.id})!==true)throw Error('Abra a marca original da tentativa A/B para consultar o recibo. Nenhuma nova ação será enviada.');
    marca=original;client=experimentClient.create({brand:marca,endpoint:activation.endpoint,audienceMode:activation.audience_mode==='saved-audience-v1',getKey:key,storage,locks,fetch,uuid});
   }
   const caps=campaignAPI.caps(api);if(!caps.endpoint||!caps.brands.includes(marca)||!caps.read||!caps.validate||!caps.operation)throw Error('A conferência das campanhas ainda não está disponível.');
   const guard=()=>{const c=campaignContext.status();return !c.blocked&&!c.dirty&&!c.pending;};
   const campaign=campaignAPI.createClient({brand:marca,capabilities:caps,storage,locks,fetch,readKey:key,writeKey:key,uuid});
   const reviewer=experimentUI.createCampaignReviewer({client:campaign,getKeyIdentity:key,guard,preserve:async()=>{if(!guard())return false;await campaignContext.preserve();return guard();}});
   view?.destroy();element.hidden=false;target=element;brand=marca;view=experimentUI.mount({element,brand,client,reviewer,storage,getKeyIdentity:key,uuid,onRecoverBrand:()=>render({element,marca:brand,api,activation})});return view;
  }
  return Object.freeze({render,contextStatus:status,preserve:()=>view?.preserve(),destroy:()=>{const s=status();if(s.blocked||s.dirty||s.pending)return false;view?.destroy();view=null;return true;}});
 }
 return Object.freeze({ACTIVATION,activation,create});
});
