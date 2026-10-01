'use strict';
const {config,WORKER_DB_USER}=require('./config.cjs'),{createTokenProvider}=require('./oauth.cjs'),{createServer}=require('./server.cjs');
const {createWorker}=require('../../n8n/growth/journey-graph-worker.cjs'),{createWorkerHttp}=require('../../n8n/growth/journey-graph-worker-http.cjs');
const {createGraphWorkerLease}=require('../../n8n/growth/journey-graph-worker-lease.cjs');
function start(env=process.env,{PoolImpl,serverFactory=createServer,leaseFactory=createGraphWorkerLease}={}){
 const c=config(env),heartbeat=env.CRM_GRAPH_WORKER_HEARTBEAT_ENABLED??'false';if(!['false','true'].includes(heartbeat))throw Error('GRAPH_SERVICE_CONFIG');
 const PoolConstructor=PoolImpl??require('pg').Pool;
 const pool=new PoolConstructor(c.pg);
 pool.on('error',()=>process.stderr.write('GRAPH_SERVICE_DATABASE_UNAVAILABLE\n'));
 const adapters=createWorkerHttp({listmonkOrigin:c.listmonkOrigin,listmonkAuthorization:c.listmonkAuthorization,cacheTarget:c.cacheTarget,shops:c.shops,shopifyTokenFor:createTokenProvider(c)});
 const worker=createWorker({pool,enabled:c.enabled,actor:'worker:graph-cart-v1',cacheTarget:c.cacheTarget,shops:c.shops,collectorWorkflowIds:c.collectorWorkflowIds,shopifyRequest:adapters.shopifyRequest,sendTx:adapters.sendTx,
  // These operations are internal and already authenticated by the HTTP boundary.
  // Require the dedicated SQL role independently of the configured username.
  // The worker also enforces SQL controls and fixed ownership per effect.
  authorizeWorker:async({query,actor})=>actor==='worker:graph-cart-v1'&&(await query('SELECT current_user AS role')).rows[0]?.role===WORKER_DB_USER});
 const lease=leaseFactory({pool,enabled:heartbeat==='true',runtimeIdentity:()=>({contract:'journey_graph_worker_runtime_v1',execution_enabled:c.enabled,revision:c.revision,
  cache_target:c.cacheTarget,listmonk_origin:c.listmonkOrigin,shops:c.shops,collector_workflow_ids:c.collectorWorkflowIds,
  shopify_client_ids:{fish:c.oauth.fish.clientId,aristo:c.oauth.aristo.clientId},node:{version:process.versions.node,platform:process.platform,arch:process.arch,timezone:env.TZ??''},
  database:{host:c.pg.host,port:c.pg.port,database:c.pg.database,user:c.pg.user,max:c.pg.max,statement_timeout:c.pg.statement_timeout,application_name:c.pg.application_name},
  adapters:{worker:'journey_graph_worker_v1',http:'journey_graph_worker_http_v1',source:'cart_customer_order_observation_v1'}})});
 const app=serverFactory({worker,token:c.token,revision:c.revision,enabled:c.enabled});
 // The process never self-enrolls, opens epochs or schedules ticks. Only the
 // reviewed n8n integration may invoke the fixed internal operations.
 app.server.listen(8080,'0.0.0.0');lease.start().catch(()=>process.stderr.write('GRAPH_WORKER_LEASE_UNAVAILABLE\n'));let stopPromise;
 const stop=()=>{if(!stopPromise)stopPromise=(async()=>{try{await lease.stop();await app.stop();await pool.end();}catch{process.exitCode=1;}})();return stopPromise;};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);return {app,lease,stop};
}
if(require.main===module){try{start();}catch{process.stderr.write('GRAPH_SERVICE_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={start};
