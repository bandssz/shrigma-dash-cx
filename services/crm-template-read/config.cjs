'use strict';
// Configuração do listener de leitura de templates. Nasce DESLIGADO: com
// CRM_TEMPLATE_READ_ENABLED ausente ou 'false' nenhuma variável de banco é lida
// (não precisa de host, usuário nem segredo PostgreSQL) e nenhum pool é criado.
const DB_USER='crm_template_reader',DB_NAME='listmonk';
const fail=()=>{throw Error('CRM_TEMPLATE_READ_CONFIG');};
function config(env){
 const enabled=env.CRM_TEMPLATE_READ_ENABLED??'false';if(!['false','true'].includes(enabled))fail();
 const read=k=>{const v=env[k];if(typeof v!=='string'||!v||v.trim()!==v||/[\r\n\0]/.test(v))fail();return v;};
 const revision=read('CRM_TEMPLATE_READ_REVISION');if(!/^[a-f0-9]{40}$/.test(revision))fail();
 if(enabled==='false')return Object.freeze({enabled:false,revision,port:8080,pg:null});
 const host=read('CRM_PG_HOST');if(!/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(host)||host.includes('..'))fail();
 const user=read('CRM_PG_USER');if(user!==DB_USER)fail();
 const database=read('CRM_PG_DATABASE');if(database!==DB_NAME)fail();
 return Object.freeze({enabled:true,revision,port:8080,pg:Object.freeze({
  host,port:5432,database,user,password:read('CRM_PG_PASSWORD'),ssl:false,max:4,
  connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:8000,
  application_name:'crm-template-read'
 })});
}
module.exports={config,DB_USER,DB_NAME};
