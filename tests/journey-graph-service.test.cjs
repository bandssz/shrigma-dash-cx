'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const {createServer,MAX_BODY}=require('../services/crm-flows/server.cjs'),{config}=require('../services/crm-flows/config.cjs'),{createTokenProvider}=require('../services/crm-flows/oauth.cjs');
const {createWorker}=require('../n8n/growth/journey-graph-worker.cjs');
const token='x'.repeat(43),revision='a'.repeat(40);
async function harness(t,overrides={}){
 const calls=[];const worker=Object.fromEntries(['captureHandoff','sourceOperation','tickRequest','tickOperation','reconcile','inspect'].map(k=>[k,async p=>{calls.push({action:k,input:p});return {ok:true};}]));
 const app=createServer({worker:{...worker,...overrides},token,revision});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());
 const request=(path,body={},extra={})=>new Promise((resolve,reject)=>{
  const raw=typeof body==='string'?body:JSON.stringify(body),req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path,method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra.headers},...extra},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(data)}));});req.on('error',reject);req.end(extra.method==='GET'?'':raw);
 });return {app,calls,request};
}
test('fixed internal routes require one bearer and reject query/body authentication before worker I/O',async t=>{
 const x=await harness(t);
 for(const [url,extra,status]of [ ['/internal/tick',{headers:{'Content-Type':'application/json'}},401],['/internal/tick?key='+token,{},404],['/internal/tick',{headers:{Authorization:['Bearer '+token,'Bearer '+token],'Content-Type':'application/json'}},401],['/internal/tick',{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:'https://example.invalid'}},403],['/internal/tick',{method:'GET'},404] ])assert.equal((await x.request(url,{token},extra)).status,status);
 assert.equal(x.calls.length,0);assert.equal((await x.request('/internal/tick',{brand:'fish',limit:1,request_id:'91000000-0000-4000-8000-000000000001'})).status,200);assert.deepEqual(x.calls,[{action:'tickRequest',input:{brand:'fish',limit:1,request_id:'91000000-0000-4000-8000-000000000001'}}]);
 const health=await x.request('/healthz','',{method:'GET',headers:{}});assert.equal(health.status,200);assert.equal(health.body.execution_enabled,false);assert.equal(health.headers['cache-control'],'no-store');assert.equal(health.headers['access-control-allow-origin'],undefined);
});
test('source and tick recovery routes are distinct authenticated reads and never call their mutation methods',async t=>{
 const x=await harness(t),source={brand:'fish',workflow_id:'syntheticFish',execution_id:'123',batch_index:0},tick={brand:'fish',request_id:'91000000-0000-4000-8000-000000000001'};
 assert.equal((await x.request('/internal/source-operation',source)).status,200);assert.equal((await x.request('/internal/tick-operation',tick)).status,200);assert.deepEqual(x.calls,[{action:'sourceOperation',input:source},{action:'tickOperation',input:tick}]);
});
test('inspect requires one bearer, exact POST route and an empty JSON object before worker I/O',async t=>{
 const x=await harness(t);
 for(const [url,body,extra,status]of [
  ['/internal/inspect',{}, {headers:{'Content-Type':'application/json'}},401],
  ['/internal/inspect',{}, {headers:{Authorization:['Bearer '+token,'Bearer '+token],'Content-Type':'application/json'}},401],
  ['/internal/inspect',{}, {headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:'https://example.invalid'}},403],
  ['/internal/inspect?token='+token,{}, {},404],['/internal/inspect',{}, {method:'GET'},404],
  ['/internal/inspect',{}, {headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'}},415],
  ['/internal/inspect',{}, {headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Encoding':'gzip'}},415],
  ['/internal/inspect',{}, {headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':MAX_BODY+1}},413],
  ['/internal/inspect','{',{},400],['/internal/inspect',[],{},400],['/internal/inspect',null,{},400],
  ['/internal/inspect',{brand:'fish'},{},400],['/internal/inspect',{email:'synthetic@example.invalid'},{},400],
  ['/internal/inspect','{"__proto__":{}}',{},400]
 ])assert.equal((await x.request(url,body,extra)).status,status);
 assert.deepEqual(x.calls,[]);
 const r=await x.request('/internal/inspect',{});assert.equal(r.status,200);assert.deepEqual(x.calls,[{action:'inspect',input:{}}]);
 assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['access-control-allow-origin'],undefined);
});
test('OFF inspect reaches the real worker using SELECT-only storage and never captures, ticks, reconciles or sends',async t=>{
 const sqlCalls=[],actions=[],effects=[];let role='crm_graph_worker';
 const forbidden=action=>async()=>{effects.push(action);throw Error('forbidden side effect');};
 const pool={connect:forbidden('connect'),query:async(sql,params)=>{
  sqlCalls.push({sql,params});if(sql==='SELECT current_user AS role')return {rows:[{role}]};
  assert.match(sql,/^SELECT\s+\(SELECT count\(\*\)::int/);assert.match(sql,/owned_entries/);assert.match(sql,/pending_intents/);assert.match(sql,/unapplied_receipts/);
  assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|CALL)\b/i);
  assert.equal(params.length,1);assert.ok(['fish','aristo'].includes(params[0]));
  return {rows:[{owned_entries:params[0]==='fish'?2:3,pending_intents:1,unapplied_receipts:0}]};
 }};
 const worker=createWorker({pool,enabled:false,cacheTarget:'synthetic-instance',collectorWorkflowIds:{fish:'syntheticFish',aristo:'syntheticAristo'},
  readSource:forbidden('readSource'),shopifyRequest:forbidden('shopifyRequest'),sendTx:forbidden('sendTx'),
  authorizeWorker:async({query,actor,brand,action})=>{actions.push({actor,brand,action});return actor==='worker:graph-cart-v1'&&(await query('SELECT current_user AS role')).rows[0].role==='crm_graph_worker';}});
 const x=await harness(t,{inspect:worker.inspect,captureHandoff:forbidden('captureHandoff'),sourceOperation:forbidden('sourceOperation'),tickRequest:forbidden('tickRequest'),tickOperation:forbidden('tickOperation'),reconcile:forbidden('reconcile')});
 const r=await x.request('/internal/inspect',{});assert.equal(r.status,200);
 assert.deepEqual(r.body,{contract:'journey_graph_worker_v1',enabled:false,admissions:false,publish:false,panel_activation:false,brands:{
  fish:{storage_available:true,execution_open:false,owned_entries:2,pending_intents:1,unapplied_receipts:0},
  aristo:{storage_available:true,execution_open:false,owned_entries:3,pending_intents:1,unapplied_receipts:0}
 }});
 assert.deepEqual(actions.map(x=>[x.brand,x.action]),[['fish','inspect'],['aristo','inspect']]);assert.equal(sqlCalls.length,4);assert.deepEqual(effects,[]);
 role='postgres';const denied=await x.request('/internal/inspect',{});assert.equal(denied.status,503);assert.deepEqual(denied.body,{error:'GRAPH_WORKER_UNAUTHORIZED'});assert.equal(sqlCalls.length,5);assert.deepEqual(effects,[]);
});
test('inspect storage failures remain private without suggesting reconciliation or calling another operation',async t=>{
 let calls=0;const x=await harness(t,{inspect:async()=>{calls++;throw Error('synthetic private database detail');}});
 const r=await x.request('/internal/inspect',{});assert.equal(r.status,503);assert.deepEqual(r.body,{error:'GRAPH_SERVICE_UNCONFIRMED'});assert.equal(calls,1);assert.deepEqual(x.calls,[]);
});
test('input limits and malformed JSON never reach the worker; untrusted exception details stay private',async t=>{
 const x=await harness(t,{tickRequest:async()=>{throw Error('synthetic private customer payload');}});
 assert.equal((await x.request('/internal/source','{')).status,400);assert.equal((await x.request('/internal/source',[])).status,400);
 assert.equal((await x.request('/internal/source',{}, {headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'}})).status,415);
 assert.equal((await x.request('/internal/source',{}, {headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':MAX_BODY+1}})).status,413);
 assert.equal(x.calls.length,0);const r=await x.request('/internal/tick',{brand:'fish'});assert.equal(r.status,503);assert.equal(r.body.error,'GRAPH_SERVICE_UNCONFIRMED');assert.equal(JSON.stringify(r.body).includes('customer'),false);
});
test('bounded concurrency does not queue or repeat mutations and shutdown waits for an in-flight command',async t=>{
 let release,started;const ready=new Promise(r=>started=r),pending=new Promise(r=>release=r),x=await harness(t,{tickRequest:async()=>{started();await pending;return {ok:true};}});
 const a=x.request('/internal/tick',{brand:'fish'});await ready;
 const b=x.request('/internal/tick',{brand:'aristo'});while(x.app.active()<2)await new Promise(r=>setImmediate(r));
 assert.equal((await x.request('/internal/tick',{brand:'fish'})).status,503);let stopped=false;const stop=x.app.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);release();assert.equal((await a).status,200);assert.equal((await b).status,200);await stop;assert.equal(stopped,true);
});
test('disconnected caller does not let shutdown close the pool before its command finishes',async t=>{
 let release,entered;const started=new Promise(r=>entered=r),pending=new Promise(r=>release=r),x=await harness(t,{tickRequest:async()=>{entered();await pending;return {ok:true};}});
 const req=http.request({hostname:'127.0.0.1',port:x.app.server.address().port,path:'/internal/tick',method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}},()=>{});req.on('error',()=>{});req.end(JSON.stringify({brand:'fish'}));await started;req.destroy();
 await new Promise(r=>setImmediate(r));let stopped=false;const stop=x.app.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);assert.equal(x.app.active(),1);release();await stop;assert.equal(stopped,true);assert.equal(x.app.active(),0);
});
function env(){return {CRM_FLOWS_REVISION:revision,CRM_FLOWS_TOKEN:token,CRM_PG_HOST:'comunicacao_postgres',CRM_PG_USER:'crm_graph_worker',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'synthetic-password',CRM_LISTMONK_ORIGIN:'https://email.shrigma.com.br',CRM_LISTMONK_AUTHORIZATION:'Basic c3ludGhldGljOnN5bnRoZXRpYw==',CRM_LISTMONK_CACHE_TARGET:'synthetic-instance',CRM_FISH_SHOP:'synthetic-fish.myshopify.com',CRM_FISH_SHOP_ID:'gid://shopify/Shop/1',CRM_ARISTO_SHOP:'synthetic-aristo.myshopify.com',CRM_ARISTO_SHOP_ID:'gid://shopify/Shop/2',CRM_FISH_CLIENT_ID:'synthetic-fish',CRM_FISH_CLIENT_SECRET:'synthetic-fish-secret',CRM_ARISTO_CLIENT_ID:'synthetic-aristo',CRM_ARISTO_CLIENT_SECRET:'synthetic-aristo-secret',CRM_FISH_COLLECTOR:'syntheticFish',CRM_ARISTO_COLLECTOR:'syntheticAristo'};}
test('fixed configuration starts disabled, separates shops and never includes raw environment values in errors',()=>{
 const c=config(env());assert.equal(c.enabled,false);assert.equal(c.pg.max,4);assert.notEqual(c.shops.fish.id,c.shops.aristo.id);
 for(const patch of [{CRM_FLOWS_ENABLED:'yes'},{CRM_LISTMONK_ORIGIN:'https://example.invalid'},{CRM_PG_DATABASE:'chatwoot'},{CRM_FLOWS_TOKEN:'short'},{CRM_FISH_SHOP_ID:'gid://shopify/Shop/2'},{CRM_PG_PASSWORD:'synthetic\nsecret'},{CRM_ARISTO_SHOP:'synthetic-fish.myshopify.com'}])assert.throws(()=>config({...env(),...patch}),e=>e.message==='GRAPH_SERVICE_CONFIG');
});
test('only the dedicated SQL user is configurable; connection limits and TLS policy remain fixed',()=>{
 const c=config(env());assert.equal(c.pg.user,'crm_graph_worker');assert.deepEqual({port:c.pg.port,ssl:c.pg.ssl,max:c.pg.max,connectionTimeoutMillis:c.pg.connectionTimeoutMillis,idleTimeoutMillis:c.pg.idleTimeoutMillis,statement_timeout:c.pg.statement_timeout},{port:5432,ssl:false,max:4,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:10000});
 for(const user of ['postgres','central_leitor','synthetic','crm_graph_worker_other','CRM_GRAPH_WORKER',' crm_graph_worker','crm_graph_worker ',undefined])assert.throws(()=>config({...env(),CRM_PG_USER:user}),e=>e.message==='GRAPH_SERVICE_CONFIG');
});
test('main independently authorizes only the dedicated current_user and fixed worker actor',async()=>{
 const filename=require.resolve('../services/crm-flows/main.cjs'),realRequire=createRequire(filename),module={exports:{}};let workerOptions,poolOptions,listening=false;
 const imports={
  pg:{Pool:class{constructor(options){poolOptions=options;}on(){}async end(){}}},
  './server.cjs':{createServer:()=>({server:{listen(){listening=true;}},async stop(){}})},
  '../../n8n/growth/journey-graph-worker.cjs':{createWorker:options=>{workerOptions=options;return {};}}
 };
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,require:name=>Object.hasOwn(imports,name)?imports[name]:realRequire(name),process:{once(){}}},{filename});
 const running=module.exports.start(env(),{leaseFactory:options=>{assert.equal(options.enabled,false);return {async start(){},async stop(){}};}});assert.equal(listening,true);assert.equal(poolOptions.user,'crm_graph_worker');assert.equal(workerOptions.enabled,false);
 let queries=0;const call=async(role,actor='worker:graph-cart-v1')=>workerOptions.authorizeWorker({actor,query:async sql=>{queries++;assert.equal(sql,'SELECT current_user AS role');return {rows:[{role}]};}});
 assert.equal(await call('crm_graph_worker'),true);
 for(const role of ['postgres','central_leitor','synthetic','crm_graph_worker_other',null])assert.equal(await call(role),false);
 const before=queries;assert.equal(await call('crm_graph_worker','panel:synthetic'),false);assert.equal(queries,before);await running.stop();
});
test('OAuth is isolated per brand, single-flight, bounded, renewable and has no automatic retry',async()=>{
 const c=config(env());let now=0;const calls=[];
 const provider=createTokenProvider({...c,clock:()=>now,fetchImpl:async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'error');return new Response(JSON.stringify({access_token:'synthetic-token-'+calls.length,expires_in:3600}));}});
 const [a,b]=await Promise.all([provider('fish'),provider('fish')]);assert.equal(a,b);assert.equal(calls.length,1);assert.notEqual(await provider('aristo'),a);assert.equal(calls.length,2);assert.match(calls[0].url,/synthetic-fish\.myshopify\.com\/admin\/oauth\/access_token$/);
 now=3600000;assert.notEqual(await provider('fish'),a);assert.equal(calls.length,3);
 let failed=0;const unavailable=createTokenProvider({...c,fetchImpl:async()=>{failed++;return new Response('private',{status:500});}});await assert.rejects(unavailable('fish'),e=>e.code==='GRAPH_SERVICE_AUTH_UNAVAILABLE');assert.equal(failed,1);
 const oversized=createTokenProvider({...c,fetchImpl:async()=>new Response('x'.repeat(17000))});await assert.rejects(oversized('fish'),e=>e.code==='GRAPH_SERVICE_AUTH_UNAVAILABLE');
 const ctrl=new AbortController();ctrl.abort();await assert.rejects(provider('fish',{signal:ctrl.signal}),e=>e.code==='GRAPH_SERVICE_AUTH_ABORTED');assert.equal(calls.length,3);
});
