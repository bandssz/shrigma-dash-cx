'use strict';
const DB_USER='crm_audience_api';
const fail=()=>{throw Error('CRM_AUDIENCE_CONFIG');};
function config(env){
 const read=k=>{const v=env[k];if(typeof v!=='string'||!v||v.trim()!==v||/[\r\n\0]/.test(v))fail();return v;};
 const enabled=env.CRM_AUDIENCE_ENABLED??'false';if(!['false','true'].includes(enabled))fail();
 const bindingEnabled=env.CRM_AUDIENCE_BINDING_ENABLED??'false';if(!['false','true'].includes(bindingEnabled))fail();
 const regularEnabled=env.CRM_AUDIENCE_REGULAR_ENABLED??'false';if(!['false','true'].includes(regularEnabled))fail();
 const abEnabled=env.CRM_AUDIENCE_AB_ENABLED??'false';if(!['false','true'].includes(abEnabled))fail();
 const graphLifecycleEnabled=env.CRM_AUDIENCE_GRAPH_LIFECYCLE_ENABLED??'false';if(!['false','true'].includes(graphLifecycleEnabled))fail();
 const productSemantics=env.CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS??'v1';if(!['v1','v2'].includes(productSemantics))fail();
 const revision=read('CRM_AUDIENCE_REVISION');if(!/^[a-f0-9]{40}$/.test(revision))fail();
 const host=read('CRM_PG_HOST');if(!/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(host)||host.includes('..'))fail();
 const user=read('CRM_PG_USER');if(user!==DB_USER)fail();
 const database=read('CRM_PG_DATABASE');if(database!=='listmonk')fail();
 return Object.freeze({enabled:enabled==='true',bindingEnabled:bindingEnabled==='true',regularEnabled:regularEnabled==='true',abEnabled:abEnabled==='true',graphLifecycleEnabled:graphLifecycleEnabled==='true',productSemantics,revision,port:8080,pg:Object.freeze({
  host,port:5432,database,user,password:read('CRM_PG_PASSWORD'),ssl:false,max:4,
  connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:10000,
  application_name:'crm-audience'
 })});
}
module.exports={config,DB_USER};
