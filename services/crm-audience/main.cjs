'use strict';
const {config}=require('./config.cjs'),{createTransaction}=require('./transaction.cjs'),{createServer}=require('./server.cjs');
const {createAudienceStore}=require('../../n8n/growth/segment-audience-store.cjs'),{createAudienceAPI}=require('../../n8n/growth/segment-audience-api.cjs');
const {createSegmentCampaignBinding}=require('../../n8n/growth/segment-campaign-binding.cjs'),{createCampaignBindingAPI}=require('../../n8n/growth/segment-campaign-binding-api.cjs');
const Counter=require('../../n8n/growth/segment-audience-listmonk.cjs');
function start(env=process.env,{Pool=require('pg').Pool}={}){
 const c=config(env),pool=new Pool(c.pg),transaction=createTransaction({pool,statementTimeoutMs:c.pg.statement_timeout});
 pool.on('error',()=>process.stderr.write('CRM_AUDIENCE_DATABASE_UNAVAILABLE\n'));
 const refreshCatalog=({query,brand})=>query('SELECT crm_audience_v2.refresh_native_catalog($1::text)',[brand]);
 const segments=createAudienceAPI({store:createAudienceStore({transaction,countProvider:Counter.countAudience,refreshCatalog})});
 const binding=createCampaignBindingAPI({store:createSegmentCampaignBinding({transaction,countProvider:Counter.countAudience,refreshCatalog})});
 const app=createServer({segments,binding,revision:c.revision,enabled:c.enabled,bindingEnabled:c.bindingEnabled});
 app.server.listen(c.port,'0.0.0.0');let stopping=false,stopPromise;
 const stop=()=>{if(!stopPromise)stopPromise=(async()=>{stopping=true;try{await app.stop();await transaction.drain();await pool.end();}catch{process.exitCode=1;}})();return stopPromise;};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 return Object.freeze({app,transaction,stop,isStopping:()=>stopping});
}
if(require.main===module){try{start();}catch{process.stderr.write('CRM_AUDIENCE_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={start};
