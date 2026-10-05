'use strict';
// Configuração do serviço de leitura isolado. Nasce DESLIGADO.
const DB_USER='crm_audience_reader';
const fail=()=>{throw Error('CRM_AUDIENCE_READ_CONFIG');};
function config(env){
 const enabled=env.CRM_AUDIENCE_READ_ENABLED??'false';if(!['false','true'].includes(enabled))fail();
 const read=k=>{const v=env[k];if(typeof v!=='string'||!v||v.trim()!==v||/[\r\n\0]/.test(v))fail();return v;};
 const revision=read('CRM_AUDIENCE_REVISION');if(!/^[a-f0-9]{40}$/.test(revision))fail();
 if(enabled==='false')return Object.freeze({enabled:false,revision,port:8080,pg:null});
 const host=read('CRM_PG_HOST');if(!/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(host)||host.includes('..'))fail();
 const user=read('CRM_PG_USER');if(user!==DB_USER)fail();
 const database=read('CRM_PG_DATABASE');if(database!=='listmonk')fail();
 return Object.freeze({enabled:true,revision,port:8080,pg:Object.freeze({
  host,port:5432,database,user,password:read('CRM_PG_PASSWORD'),ssl:false,max:4,
  connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:8000,
  application_name:'crm-audience-read'
 })});
}
module.exports={config,DB_USER};
