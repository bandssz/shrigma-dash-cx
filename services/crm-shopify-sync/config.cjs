'use strict';
const fs=require('node:fs');
const fail=code=>{throw Error(code);};
const SECRET_KEYS=['CRM_SHOPIFY_SYNC_KEY','PGPASSWORD','CRM_SHOPIFY_FISH_CLIENT_ID','CRM_SHOPIFY_FISH_CLIENT_SECRET','CRM_SHOPIFY_ARISTO_CLIENT_ID','CRM_SHOPIFY_ARISTO_CLIENT_SECRET'];
function privateSecrets(env){
 const file=env.CRM_SHOPIFY_SYNC_SECRETS_FILE;if(!file)return env;
 if(typeof file!=='string'||!file.startsWith('/')||file.length>512||SECRET_KEYS.some(k=>env[k]))fail('CRM_SHOPIFY_SYNC_SECRETS');
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.size<10||stat.size>4096||(stat.mode&0o077)!==0)fail('CRM_SHOPIFY_SYNC_SECRETS');
  const value=JSON.parse(fs.readFileSync(fd,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==SECRET_KEYS.slice().sort().join(',')||SECRET_KEYS.some(k=>typeof value[k]!=='string'||!value[k]))fail('CRM_SHOPIFY_SYNC_SECRETS');
  return {...env,...value};
 }catch{fail('CRM_SHOPIFY_SYNC_SECRETS');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function config(env){
 env=privateSecrets(env);
 const port=Number(env.PORT||8080),pgPort=Number(env.PGPORT||5432),maxBytes=Number(env.CRM_SHOPIFY_MAX_BYTES||40*1024*1024),pollMs=Number(env.CRM_SHOPIFY_POLL_MS||5000),leaseSeconds=Number(env.CRM_SHOPIFY_LEASE_SECONDS||90),ingestTimeoutMs=Number(env.CRM_SHOPIFY_INGEST_TIMEOUT_MS||30000);
 if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(pgPort)||pgPort<1||pgPort>65535||!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>128*1024*1024||!Number.isInteger(pollMs)||pollMs<1000||pollMs>60000||!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>300)fail('CRM_SHOPIFY_SYNC_LIMIT');
 if(!Number.isInteger(ingestTimeoutMs)||ingestTimeoutMs<30000||ingestTimeoutMs>180000||(ingestTimeoutMs>30000&&leaseSeconds*1000<ingestTimeoutMs+30000))fail('CRM_SHOPIFY_SYNC_LIMIT');
 if(env.PGUSER!=='crm_shopify_sync'||env.PGDATABASE!=='listmonk'||!env.PGHOST||!env.PGPASSWORD||!/^[a-f0-9]{40}$/.test(env.CRM_SHOPIFY_SYNC_REVISION||'')||!/^[A-Za-z0-9._:-]{1,80}$/.test(env.CRM_SHOPIFY_PRODUCER_REVISION||'')||!/^[A-Za-z0-9_.:-]{32,256}$/.test(env.CRM_SHOPIFY_SYNC_KEY||''))fail('CRM_SHOPIFY_SYNC_CONFIGURATION');
 const brands={};for(const name of ['fish','aristo']){const upper=name.toUpperCase(),shop=env[`CRM_SHOPIFY_${upper}_SHOP`],clientId=env[`CRM_SHOPIFY_${upper}_CLIENT_ID`],clientSecret=env[`CRM_SHOPIFY_${upper}_CLIENT_SECRET`],workflowId=env[`CRM_SHOPIFY_${upper}_WORKFLOW_ID`];if(!/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(shop||'')||typeof clientId!=='string'||clientId.length<8||clientId.length>256||typeof clientSecret!=='string'||clientSecret.length<16||clientSecret.length>512||!/^[A-Za-z0-9_-]{8,64}$/.test(workflowId||''))fail('CRM_SHOPIFY_SYNC_BRAND');brands[name]={shop,clientId,clientSecret,workflowId};}
 return Object.freeze({port,enabled:env.CRM_SHOPIFY_SYNC_ENABLED==='true',revision:env.CRM_SHOPIFY_SYNC_REVISION,producerRevision:env.CRM_SHOPIFY_PRODUCER_REVISION,key:env.CRM_SHOPIFY_SYNC_KEY,maxBytes,pollMs,leaseSeconds,ingestTimeoutMs,pg:{host:env.PGHOST,port:pgPort,database:env.PGDATABASE,user:env.PGUSER,password:env.PGPASSWORD,max:3,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:30000,query_timeout:32000,application_name:'crm-shopify-sync'},brands});
}
module.exports={config,privateSecrets,SECRET_KEYS};
