'use strict';
const {createServer}=require('./server.cjs');
function config(env){
 if(!/^[a-f0-9]{40}$/.test(env.CRM_READ_REVISION||'')||env.PGUSER!=='crm_panel_reader'||env.PGDATABASE!=='listmonk'||!env.PGHOST||!env.PGPASSWORD)throw Error('CRM_READ_CONFIGURATION');
 const port=Number(env.PORT||8080),pgPort=Number(env.PGPORT||5432);if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(pgPort)||pgPort<1||pgPort>65535)throw Error('CRM_READ_PORT');
 return {port,enabled:env.CRM_READ_ENABLED==='true',revision:env.CRM_READ_REVISION,pg:{host:env.PGHOST,port:pgPort,database:env.PGDATABASE,user:env.PGUSER,password:env.PGPASSWORD,max:4,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:8000,query_timeout:8500,application_name:'crm-panel-read'}};
}
function start(env=process.env,{Pool=require('pg').Pool}={}){
 const c=config(env),pool=new Pool(c.pg);pool.on('error',()=>process.stderr.write('CRM_READ_DATABASE_UNAVAILABLE\n'));
 const app=createServer({pool,revision:c.revision,enabled:c.enabled});app.server.listen(c.port,'0.0.0.0');
 let stopping;const stop=()=>stopping||=(async()=>{await app.stop();await pool.end();})();process.once('SIGTERM',stop);process.once('SIGINT',stop);return {app,stop};
}
if(require.main===module){try{start();}catch{process.stderr.write('CRM_READ_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={config,start};
