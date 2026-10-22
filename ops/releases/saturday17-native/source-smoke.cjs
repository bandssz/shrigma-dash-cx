'use strict';
const a=require('node:assert/strict');
const kind=process.env.SMOKE_SOURCE,revision=process.env.SMOKE_REVISION;
a(['audience','campaign'].includes(kind));a.match(revision,/^[a-f0-9]{40}$/);a.equal(process.getuid(),1000);
let queries=0;class Pool{on(){}query(){queries++;throw Error('SYNTHETIC_DATABASE_FORBIDDEN');}connect(){queries++;throw Error('SYNTHETIC_DATABASE_FORBIDDEN');}async end(){}}
async function main(){
 let started;
 if(kind==='audience'){
  const env={CRM_AUDIENCE_ENABLED:'false',CRM_AUDIENCE_REVISION:revision,CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS:'v1',CRM_PG_HOST:'synthetic.invalid',CRM_PG_USER:'crm_audience_api',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'synthetic-only'};
  a.equal(require('/app/services/crm-audience/config.cjs').config(env).nativeFreezeEnabled??false,false);
  started=require('/app/services/crm-audience/main.cjs').start(env,{Pool});
 }else{
  const env={CRM_CAMPAIGN_ENABLED:'false',CRM_CAMPAIGN_REVISION:revision,PGHOST:'synthetic.invalid',PGUSER:'crm_campaign_api',PGDATABASE:'listmonk',PGPASSWORD:'synthetic-only',LISTMONK_ORIGIN:'https://email.shrigma.com.br',LISTMONK_USERNAME:'synthetic-only',LISTMONK_TOKEN:'synthetic-only'};
  a.equal(require('/app/services/crm-campaign/main.cjs').config(env).enabled,false);
  started=require('/app/services/crm-campaign/main.cjs').start(env,{Pool});
 }
 try{if(!started.app.server.listening)await new Promise(r=>started.app.server.once('listening',r));const response=await fetch('http://127.0.0.1:8080/healthz');a.equal(response.status,200);const body=await response.json();a.equal(body.revision,revision);a.equal(queries,0);console.log(JSON.stringify({schema:'crm-native-internal-source-smoke-v1',kind,revision,uid:process.getuid(),node:process.version,startup:true,defaultClosed:true,queries,productionIdentityUsed:false,productionDatabaseUsed:false}));}finally{await started.stop();}
}
main().catch(e=>{console.error(JSON.stringify({error:'SYNTHETIC_SOURCE_STARTUP_FAILED',cause:e.message}));process.exitCode=1;});
