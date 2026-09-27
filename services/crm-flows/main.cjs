'use strict';
const {Pool}=require('pg'),{config}=require('./config.cjs'),{createTokenProvider}=require('./oauth.cjs'),{createServer}=require('./server.cjs');
const {createWorker}=require('../../n8n/growth/journey-graph-worker.cjs'),{createWorkerHttp}=require('../../n8n/growth/journey-graph-worker-http.cjs');
function start(env=process.env){
 const c=config(env),pool=new Pool(c.pg);
 pool.on('error',()=>process.stderr.write('GRAPH_SERVICE_DATABASE_UNAVAILABLE\n'));
 const adapters=createWorkerHttp({listmonkOrigin:c.listmonkOrigin,listmonkAuthorization:c.listmonkAuthorization,cacheTarget:c.cacheTarget,shops:c.shops,shopifyTokenFor:createTokenProvider(c)});
 const worker=createWorker({pool,enabled:c.enabled,actor:'worker:graph-cart-v1',cacheTarget:c.cacheTarget,shops:c.shops,collectorWorkflowIds:c.collectorWorkflowIds,shopifyRequest:adapters.shopifyRequest,sendTx:adapters.sendTx,
  // These operations are internal and already authenticated by the HTTP boundary.
  // The worker independently enforces SQL controls and fixed ownership per effect.
  authorizeWorker:async({query,actor})=>actor==='worker:graph-cart-v1'&&(await query('SELECT current_user AS role')).rows[0]?.role===c.pg.user});
 const app=createServer({worker,token:c.token,revision:c.revision,enabled:c.enabled});
 // The process never self-enrolls, opens epochs or schedules ticks. Only the
 // reviewed n8n integration may invoke the fixed internal operations.
 app.server.listen(8080,'0.0.0.0');let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;try{await app.stop();await pool.end();}catch{process.exitCode=1;}};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);return {app,stop};
}
if(require.main===module){try{start();}catch{process.stderr.write('GRAPH_SERVICE_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={start};
