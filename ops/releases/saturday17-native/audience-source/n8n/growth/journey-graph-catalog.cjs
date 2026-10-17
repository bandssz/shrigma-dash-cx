/* Trusted server reader. Planning only; no source enrollment, payload, transport or activation. */
'use strict';
const G=require('./journey-graph-contract.js');
const VERSION='journey_graph_catalog_v1',ENABLED=false;
const fail=code=>{throw Object.assign(Error(code),{code});};
function validateCatalog(c,brand){
 const probe={version:G.VERSION,brand,name:'Catálogo',nodes:[{id:'entry',type:'trigger',event:'cart.abandoned'},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'entry',port:'next',to:'end'}]};
 const v=G.validateGraph(probe,{catalog:c});if(!v.ok&&v.errors[0]?.code!=='GRAPH_TRIGGER_UNAVAILABLE')fail('GRAPH_CATALOG_UNCONFIRMED');
 if(c?.brand!==brand||c?.messages.some(m=>m.channel!=='email'||!/^snapshot_[a-f0-9]{48}$/.test(m.release)))fail('GRAPH_CATALOG_UNCONFIRMED');
 return c;
}
async function read({brand,query},name){
 if(!['fish','aristo'].includes(brand)||typeof query!=='function')fail('GRAPH_CATALOG_ADAPTER_REQUIRED');
 const r=await query('SELECT crm_graph_candidate.'+name+'($1::text) AS result',[brand]);
 if(!Array.isArray(r?.rows)||r.rows.length!==1||!r.rows[0].result)fail('GRAPH_CATALOG_UNCONFIRMED');
 return r.rows[0].result;
}
async function catalogFor(options){return validateCatalog(await read(options,'catalog_v1'),options.brand);}
// Trusted composition for a worker whose purchase adapter uses this exact policy.
// Existing public SQL catalogs and their capability remain unchanged.
function withObservedPurchase(catalog,{observationPolicy}={}){
 if(observationPolicy!=='cart_customer_order_observation_v1')fail('GRAPH_CATALOG_POLICY_UNCONFIRMED');
 validateCatalog(catalog,catalog?.brand);const c=JSON.parse(JSON.stringify(catalog)),key='purchase.observed_for_cart';
 if(c.fields.some(f=>f.key===key))fail('GRAPH_CATALOG_POLICY_COLLISION');
 const trigger=c.triggers.find(t=>t.key==='cart.abandoned');if(!trigger?.available)fail('GRAPH_CATALOG_POLICY_UNCONFIRMED');
 trigger.fields.push(key);c.fields.push({key,type:'boolean',available:true,max_age_seconds:5});return c;
}
async function catalogUIFor(options){
 const result=await read(options,'catalog_ui_v1');validateCatalog(result.catalog,options.brand);
 const r=result.readiness;
 if(r?.draft_only!==true||['publish','runtime','transport','source_complete','immutable_release','template_variables_bound'].some(k=>r[k]!==false)||!Array.isArray(result.unsupported))fail('GRAPH_CATALOG_UNCONFIRMED');
 for(const [group,entries]of Object.entries({triggers:result.catalog.triggers,fields:result.catalog.fields,messages:result.catalog.messages})){
  const labels=result.labels?.[group];if(!labels||Array.isArray(labels)||Object.keys(labels).length!==entries.length||entries.some(e=>typeof labels[e.key]!=='string'||!labels[e.key].trim()||labels[e.key].length>160||/[\u0000-\u001f\u007f]/.test(labels[e.key])))fail('GRAPH_CATALOG_UNCONFIRMED');
 }
 if(typeof result.checked_at!=='string'||!Number.isFinite(Date.parse(result.checked_at)))fail('GRAPH_CATALOG_UNCONFIRMED');
 return result;
}
module.exports={VERSION,ENABLED,catalogFor,catalogUIFor,withObservedPurchase};
