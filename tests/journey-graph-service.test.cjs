'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createServer,MAX_BODY}=require('../services/crm-flows/server.cjs'),{config}=require('../services/crm-flows/config.cjs'),{createTokenProvider}=require('../services/crm-flows/oauth.cjs');
const token='x'.repeat(43),revision='a'.repeat(40);
async function harness(t,overrides={}){
 const calls=[];const worker=Object.fromEntries(['captureHandoff','tick','reconcile'].map(k=>[k,async p=>{calls.push({action:k,input:p});return {ok:true};}]));
 const app=createServer({worker:{...worker,...overrides},token,revision});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());
 const request=(path,body={},extra={})=>new Promise((resolve,reject)=>{
  const raw=typeof body==='string'?body:JSON.stringify(body),req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path,method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra.headers},...extra},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(data)}));});req.on('error',reject);req.end(extra.method==='GET'?'':raw);
 });return {app,calls,request};
}
test('fixed internal routes require one bearer and reject query/body authentication before worker I/O',async t=>{
 const x=await harness(t);
 for(const [url,extra,status]of [ ['/internal/tick',{headers:{'Content-Type':'application/json'}},401],['/internal/tick?key='+token,{},404],['/internal/tick',{headers:{Authorization:['Bearer '+token,'Bearer '+token],'Content-Type':'application/json'}},401],['/internal/tick',{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:'https://example.invalid'}},403],['/internal/tick',{method:'GET'},404] ])assert.equal((await x.request(url,{token},extra)).status,status);
 assert.equal(x.calls.length,0);assert.equal((await x.request('/internal/tick',{brand:'fish',limit:1})).status,200);assert.deepEqual(x.calls,[{action:'tick',input:{brand:'fish',limit:1}}]);
 const health=await x.request('/healthz','',{method:'GET',headers:{}});assert.equal(health.status,200);assert.equal(health.body.execution_enabled,false);assert.equal(health.headers['cache-control'],'no-store');assert.equal(health.headers['access-control-allow-origin'],undefined);
});
test('input limits and malformed JSON never reach the worker; untrusted exception details stay private',async t=>{
 const x=await harness(t,{tick:async()=>{throw Error('synthetic private customer payload');}});
 assert.equal((await x.request('/internal/source','{')).status,400);assert.equal((await x.request('/internal/source',[])).status,400);
 assert.equal((await x.request('/internal/source',{}, {headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'}})).status,415);
 assert.equal((await x.request('/internal/source',{}, {headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':MAX_BODY+1}})).status,413);
 assert.equal(x.calls.length,0);const r=await x.request('/internal/tick',{brand:'fish'});assert.equal(r.status,503);assert.equal(r.body.error,'GRAPH_SERVICE_UNCONFIRMED');assert.equal(JSON.stringify(r.body).includes('customer'),false);
});
test('bounded concurrency does not queue or repeat mutations and shutdown waits for an in-flight command',async t=>{
 let release,started;const ready=new Promise(r=>started=r),pending=new Promise(r=>release=r),x=await harness(t,{tick:async()=>{started();await pending;return {ok:true};}});
 const a=x.request('/internal/tick',{brand:'fish'});await ready;
 const b=x.request('/internal/tick',{brand:'aristo'});while(x.app.active()<2)await new Promise(r=>setImmediate(r));
 assert.equal((await x.request('/internal/tick',{brand:'fish'})).status,503);let stopped=false;const stop=x.app.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);release();assert.equal((await a).status,200);assert.equal((await b).status,200);await stop;assert.equal(stopped,true);
});
function env(){return {CRM_FLOWS_REVISION:revision,CRM_FLOWS_TOKEN:token,CRM_PG_HOST:'comunicacao_postgres',CRM_PG_USER:'crm_graph_worker',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'synthetic-password',CRM_LISTMONK_ORIGIN:'https://email.shrigma.com.br',CRM_LISTMONK_AUTHORIZATION:'Basic c3ludGhldGljOnN5bnRoZXRpYw==',CRM_LISTMONK_CACHE_TARGET:'synthetic-instance',CRM_FISH_SHOP:'synthetic-fish.myshopify.com',CRM_FISH_SHOP_ID:'gid://shopify/Shop/1',CRM_ARISTO_SHOP:'synthetic-aristo.myshopify.com',CRM_ARISTO_SHOP_ID:'gid://shopify/Shop/2',CRM_FISH_CLIENT_ID:'synthetic-fish',CRM_FISH_CLIENT_SECRET:'synthetic-fish-secret',CRM_ARISTO_CLIENT_ID:'synthetic-aristo',CRM_ARISTO_CLIENT_SECRET:'synthetic-aristo-secret',CRM_FISH_COLLECTOR:'syntheticFish',CRM_ARISTO_COLLECTOR:'syntheticAristo'};}
test('fixed configuration starts disabled, separates shops and never includes raw environment values in errors',()=>{
 const c=config(env());assert.equal(c.enabled,false);assert.equal(c.pg.max,4);assert.notEqual(c.shops.fish.id,c.shops.aristo.id);
 for(const patch of [{CRM_FLOWS_ENABLED:'yes'},{CRM_LISTMONK_ORIGIN:'https://example.invalid'},{CRM_PG_DATABASE:'chatwoot'},{CRM_FLOWS_TOKEN:'short'},{CRM_FISH_SHOP_ID:'gid://shopify/Shop/2'},{CRM_PG_PASSWORD:'synthetic\nsecret'},{CRM_ARISTO_SHOP:'synthetic-fish.myshopify.com'}])assert.throws(()=>config({...env(),...patch}),e=>e.message==='GRAPH_SERVICE_CONFIG');
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
