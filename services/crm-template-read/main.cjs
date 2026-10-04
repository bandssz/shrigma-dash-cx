'use strict';
// Entrada do listener de leitura de templates (`node main.cjs`). Com
// CRM_TEMPLATE_READ_ENABLED=false (padrão) não carrega o driver pg, não cria
// pool nem abre conexão: só /healthz responde e /template-read devolve 503.
const {config}=require('./config.cjs'),{createReadServer}=require('./server.cjs'),S=require('./store.cjs');
function start(env=process.env,{Pool=null,port=null,host='0.0.0.0'}={}){
 const c=config(env);let pool=null,transaction=null,handler=null;
 if(c.enabled){
  const P=Pool||require('pg').Pool;pool=new P(c.pg);pool.on?.('error',()=>process.stderr.write('CRM_TEMPLATE_READ_DATABASE_UNAVAILABLE\n'));
  transaction=S.createReadTransaction({pool,statementTimeoutMs:c.pg.statement_timeout});handler=S.createTemplateReadStore({transaction});
 }
 const app=createReadServer({handler,revision:c.revision,enabled:c.enabled});
 app.server.listen(port??c.port,host);let stopPromise;
 const stop=()=>{if(!stopPromise)stopPromise=(async()=>{try{await app.stop();if(transaction)await transaction.drain();if(pool)await pool.end();}catch{process.exitCode=1;}})();return stopPromise;};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 return Object.freeze({app,pool,stop});
}
if(require.main===module){try{start();}catch{process.stderr.write('CRM_TEMPLATE_READ_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={start};
