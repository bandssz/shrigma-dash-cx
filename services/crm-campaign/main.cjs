'use strict';
const {createServer}=require('./server.cjs');
const {nativeTransport}=require('./transport.cjs');
const {mediaTransport,createMediaExecutor}=require('./media.cjs');
const {createAbandonExecutor}=require('./abandon.cjs');
function config(env){
 if(!/^[a-f0-9]{40}$/.test(env.CRM_CAMPAIGN_REVISION||'')||env.PGUSER!=='crm_campaign_api'||env.PGDATABASE!=='listmonk'||!env.PGHOST||!env.PGPASSWORD)throw Error('CRM_CAMPAIGN_CONFIGURATION');
 const port=Number(env.PORT||8080),pgPort=Number(env.PGPORT||5432);if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(pgPort)||pgPort<1||pgPort>65535)throw Error('CRM_CAMPAIGN_PORT');
 if(!['','true','false'].includes(env.CRM_CAMPAIGN_MEDIA_ENABLED||''))throw Error('CRM_CAMPAIGN_MEDIA_CONFIGURATION');
 if(!['','true','false'].includes(env.CRM_CAMPAIGN_ABANDON_ENABLED||''))throw Error('CRM_CAMPAIGN_ABANDON_CONFIGURATION');
 return {port,enabled:env.CRM_CAMPAIGN_ENABLED==='true',mediaEnabled:env.CRM_CAMPAIGN_MEDIA_ENABLED==='true',abandonEnabled:env.CRM_CAMPAIGN_ABANDON_ENABLED==='true',revision:env.CRM_CAMPAIGN_REVISION,pg:{host:env.PGHOST,port:pgPort,database:env.PGDATABASE,user:env.PGUSER,password:env.PGPASSWORD,max:4,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:12000,query_timeout:12500,application_name:'crm-campaign'},native:{origin:env.LISTMONK_ORIGIN,username:env.LISTMONK_USERNAME,token:env.LISTMONK_TOKEN}};
}
function start(env=process.env,{Pool=require('pg').Pool}={}){
 const c=config(env),native=nativeTransport(c.native),media=mediaTransport(c.native),pool=new Pool(c.pg);pool.on('error',()=>process.stderr.write('CRM_CAMPAIGN_DATABASE_UNAVAILABLE\n'));
 const app=createServer({pool,native,revision:c.revision,enabled:c.enabled,mediaEnabled:c.mediaEnabled,abandonEnabled:c.abandonEnabled,abandonExecutor:c.abandonEnabled?createAbandonExecutor({pool}):null,mediaExecutor:createMediaExecutor({pool,native:media})});app.server.listen(c.port,'0.0.0.0');
 let stopping;const stop=()=>stopping||=(async()=>{await app.stop();await pool.end();})();process.once('SIGTERM',stop);process.once('SIGINT',stop);return {app,stop};
}
if(require.main===module){try{start();}catch{process.stderr.write('CRM_CAMPAIGN_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={config,start};
