'use strict';
const fail=()=>{throw Error('GRAPH_SERVICE_CONFIG');};
function config(env){
 const read=k=>{const v=env[k];if(typeof v!=='string'||!v||v.trim()!==v||/[\r\n\0]/.test(v))fail();return v;};
 const enabled=env.CRM_FLOWS_ENABLED??'false';if(!['false','true'].includes(enabled))fail();
 const revision=read('CRM_FLOWS_REVISION');if(!/^[a-f0-9]{40}$/.test(revision))fail();
 const token=read('CRM_FLOWS_TOKEN');if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))fail();
 const host=read('CRM_PG_HOST');if(!/^[a-z][a-z0-9_-]{0,100}$/.test(host))fail();
 const user=read('CRM_PG_USER');if(!/^[a-z][a-z0-9_]{0,62}$/.test(user))fail();
 const database=read('CRM_PG_DATABASE');if(database!=='listmonk')fail();
 const listmonkOrigin=read('CRM_LISTMONK_ORIGIN');let u;try{u=new URL(listmonkOrigin);}catch{fail();}
 if(u.origin!==listmonkOrigin||u.href!=='https://email.shrigma.com.br/')fail();
 const listmonkAuthorization=read('CRM_LISTMONK_AUTHORIZATION');if(!/^Basic [A-Za-z0-9+/]+=*$/.test(listmonkAuthorization))fail();
 const cacheTarget=read('CRM_LISTMONK_CACHE_TARGET');if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cacheTarget))fail();
 const shops={},oauth={},collectorWorkflowIds={};
 for(const brand of ['fish','aristo']){
  const p='CRM_'+brand.toUpperCase()+'_',shop=read(p+'SHOP');if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))fail();
  const id=read(p+'SHOP_ID');if(!/^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/.test(id))fail();
  shops[brand]={id,myshopifyDomain:shop};oauth[brand]={clientId:read(p+'CLIENT_ID'),clientSecret:read(p+'CLIENT_SECRET')};
  collectorWorkflowIds[brand]=read(p+'COLLECTOR');if(!/^[A-Za-z0-9]{8,32}$/.test(collectorWorkflowIds[brand]))fail();
 }
 if(shops.fish.id===shops.aristo.id||shops.fish.myshopifyDomain===shops.aristo.myshopifyDomain||collectorWorkflowIds.fish===collectorWorkflowIds.aristo)fail();
 return {enabled:enabled==='true',revision,token,shops,oauth,collectorWorkflowIds,listmonkOrigin,listmonkAuthorization,cacheTarget,pg:{host,port:5432,database,user,password:read('CRM_PG_PASSWORD'),ssl:false,max:4,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:10000,application_name:'crm-flows'}};
}
module.exports={config};
