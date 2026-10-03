'use strict';
// Entrada própria do serviço de leitura (mesma imagem, app separado:
// `node read-main.cjs`). Com CRM_AUDIENCE_READ_ENABLED=false não cria pool
// nem abre conexão: só /healthz responde e /audience-read devolve 503.
const {config}=require('./read-config.cjs'),{createReadServer}=require('./read-server.cjs'),R=require('./read-store.cjs');
function start(env=process.env,{Pool=null,port=null,host='0.0.0.0'}={}){
 const c=config(env);let pool=null,transaction=null,handler=null;
 if(c.enabled){
  const P=Pool||require('pg').Pool;pool=new P(c.pg);pool.on?.('error',()=>process.stderr.write('CRM_AUDIENCE_READ_DATABASE_UNAVAILABLE\n'));
  transaction=R.createReadTransaction({pool,statementTimeoutMs:c.pg.statement_timeout});handler=R.createAudienceReadStore({transaction});
 }
 const app=createReadServer({handler,revision:c.revision,enabled:c.enabled});
 app.server.listen(port??c.port,host);let stopPromise;
 const stop=()=>{if(!stopPromise)stopPromise=(async()=>{try{await app.stop();if(transaction)await transaction.drain();if(pool)await pool.end();}catch{process.exitCode=1;}})();return stopPromise;};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 return Object.freeze({app,pool,stop});
}
if(require.main===module){try{start();}catch{process.stderr.write('CRM_AUDIENCE_READ_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={start};
