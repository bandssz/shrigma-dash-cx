'use strict';
// Runs only against the clean candidate tree/image, with synthetic values.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
function syntheticEnv(sha){return {CRM_FLOWS_ENABLED:'false',CRM_FLOWS_REVISION:sha,CRM_FLOWS_TOKEN:'x'.repeat(43),CRM_PG_HOST:'synthetic_database',CRM_PG_USER:'crm_graph_worker',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'synthetic-password',CRM_LISTMONK_ORIGIN:'https://email.shrigma.com.br',CRM_LISTMONK_AUTHORIZATION:'Basic c3ludGhldGljOnN5bnRoZXRpYw==',CRM_LISTMONK_CACHE_TARGET:'synthetic-instance',CRM_FISH_SHOP:'synthetic-fish.myshopify.com',CRM_FISH_SHOP_ID:'gid://shopify/Shop/1',CRM_ARISTO_SHOP:'synthetic-aristo.myshopify.com',CRM_ARISTO_SHOP_ID:'gid://shopify/Shop/2',CRM_FISH_CLIENT_ID:'synthetic-fish',CRM_FISH_CLIENT_SECRET:'synthetic-fish-secret',CRM_ARISTO_CLIENT_ID:'synthetic-aristo',CRM_ARISTO_CLIENT_SECRET:'synthetic-aristo-secret',CRM_FISH_COLLECTOR:'syntheticFish',CRM_ARISTO_COLLECTOR:'syntheticAristo'};}
async function guard(directory){
 const filename=path.resolve(directory,'services/crm-flows/main.cjs'),localRequire=createRequire(filename),C=localRequire('./config.cjs'),env=syntheticEnv('a'.repeat(40));
 assert.equal(C.WORKER_DB_USER,'crm_graph_worker');assert.equal(C.config(env).enabled,false);
 for(const user of ['postgres','synthetic','central_leitor',undefined])assert.throws(()=>C.config({...env,CRM_PG_USER:user}));
 const module={exports:{}};let worker;
 // Even a misconfigured pool cannot authorize a different effective SQL role.
 const imports={pg:{Pool:class{on(){}}},'./config.cjs':{...C,config:()=>{const c=C.config(env);c.pg.user='postgres';return c;}},'./server.cjs':{createServer:()=>({server:{listen(){}}})},'../../n8n/growth/journey-graph-worker.cjs':{createWorker:options=>{worker=options;return {};}}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,require:name=>Object.hasOwn(imports,name)?imports[name]:localRequire(name),process:{once(){}}},{filename});module.exports.start(env);
 for(const role of ['crm_graph_worker','postgres','synthetic','central_leitor'])assert.equal(await worker.authorizeWorker({actor:'worker:graph-cart-v1',query:async()=>({rows:[{role}]})}),role==='crm_graph_worker');
 assert.equal(await worker.authorizeWorker({actor:'panel:synthetic',query:async()=>{throw Error('must not query');}}),false);
}
if(require.main===module)guard(process.argv[2]).catch(()=>{process.stderr.write('CRM_IMAGE_DEDICATED_ROLE_REQUIRED\n');process.exitCode=1;});
module.exports={syntheticEnv,guard};
