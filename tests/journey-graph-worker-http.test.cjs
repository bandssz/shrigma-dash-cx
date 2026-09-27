'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createWorkerHttp,createWorkerPool}=require('../n8n/growth/journey-graph-worker-http.cjs'),{IDENTITY_QUERY,API_VERSION}=require('../n8n/growth/journey-graph-purchase.cjs');
const shops={fish:{id:'gid://shopify/Shop/1',myshopifyDomain:'synthetic-fish.myshopify.com'},aristo:{id:'gid://shopify/Shop/2',myshopifyDomain:'synthetic-aristo.myshopify.com'}};
const config={listmonkOrigin:'https://email.example.invalid',listmonkAuthorization:'Basic c3ludGhldGlj',cacheTarget:'synthetic-instance',shops,shopifyTokenFor:async brand=>'synthetic-'+brand};
const input=brand=>({brand,shop:shops[brand].myshopifyDomain,apiVersion:API_VERSION,document:IDENTITY_QUERY,variables:{checkout:'gid://shopify/AbandonedCheckout/1'},maxResponseBytes:262144});
test('fixed HTTPS destinations and independent brand credentials; no redirect or extra query accepted',async()=>{
 const seen=[],a=createWorkerHttp({...config,fetchImpl:async(url,o)=>{seen.push({url,o});return new Response(JSON.stringify({data:true}),{status:200});}});
 for(const brand of ['fish','aristo']){await a.shopifyRequest(input(brand));assert.equal(seen.at(-1).url,'https://'+shops[brand].myshopifyDomain+'/admin/api/'+API_VERSION+'/graphql.json');assert.equal(seen.at(-1).o.headers['X-Shopify-Access-Token'],'synthetic-'+brand);}
 await a.sendTx({template_id:1},{timeoutMs:100,retry:false,redirect:'error'});assert.equal(seen.at(-1).url,'https://email.example.invalid/api/tx');assert.equal(seen.at(-1).o.headers.Authorization,config.listmonkAuthorization);assert.equal(seen.at(-1).o.redirect,'error');
 await a.nativeCreate({name:'synthetic'},{cacheTarget:'synthetic-instance'});await a.nativeRead(4,{cacheTarget:'synthetic-instance'});assert.equal(seen.at(-1).o.method,'GET');assert.equal(seen.at(-1).url,'https://email.example.invalid/api/templates/4');
 await assert.rejects(a.shopifyRequest({...input('fish'),shop:shops.aristo.myshopifyDomain}),/INPUT/);await assert.rejects(a.shopifyRequest({...input('fish'),document:'mutation { nope }'}),/INPUT/);assert.throws(()=>a.nativeRead(1,{cacheTarget:'other-instance'}),/INPUT/);
});
test('stream and header limits are enforced before JSON parse, never retried',async()=>{
 for(const response of [()=>new Response('x'.repeat(80)),()=>new Response('{}',{headers:{'content-length':'1000'}})]){
  let calls=0;const a=createWorkerHttp({...config,fetchImpl:async()=>{calls++;return response();}});await assert.rejects(a.sendTx({}, {maxResponseBytes:32,timeoutMs:100}),/LIMIT/);assert.equal(calls,1);
 }
});
test('pre-abort, in-flight abort and timeout cancel requests; errors never expose provider text',async()=>{
 let calls=0,captured;const fetchImpl=async(_,o)=>{calls++;captured=o.signal;return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('private token body')),{once:true}));};
 const a=createWorkerHttp({...config,fetchImpl}),pre=new AbortController();pre.abort();await assert.rejects(a.sendTx({}, {signal:pre.signal,timeoutMs:20}),/ABORTED/);assert.equal(calls,0);
 const live=new AbortController(),p=a.sendTx({}, {signal:live.signal,timeoutMs:100});live.abort();await assert.rejects(p,e=>e.code==='GRAPH_WORKER_HTTP_ABORTED'&&!e.message.includes('private'));assert.equal(captured.aborted,true);
 await assert.rejects(a.sendTx({}, {timeoutMs:10}),/TIMEOUT|ABORTED/);assert.equal(captured.aborted,true);assert.equal(calls,2);
});
test('async token acquisition observes the outer signal without making a request after cancellation',async()=>{
 let calls=0,tokenSignal;const a=createWorkerHttp({...config,shopifyTokenFor:async(brand,{signal})=>{tokenSignal=signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve('late-token'),{once:true}));},fetchImpl:async()=>{calls++;return new Response('{}');}}),c=new AbortController(),p=a.shopifyRequest({...input('fish'),signal:c.signal});c.abort();await assert.rejects(p,/ABORTED/);assert.equal(tokenSignal.aborted,true);assert.equal(calls,0);
});
test('pool options remain bounded and idle errors are redacted; creating pool performs no query',()=>{
 let settings,event,callback,notice;class Pool{constructor(s){settings=s;}on(e,cb){event=e;callback=cb;}}
 createWorkerPool({connectionString:'postgres://synthetic@localhost/fixture',Pool,onError:c=>notice=c});assert.equal(settings.max,4);assert.equal(settings.statement_timeout,8000);assert.equal(settings.connectionTimeoutMillis,3000);assert.equal(event,'error');callback(Error('synthetic private connection info'));assert.equal(notice,'GRAPH_WORKER_DATABASE_UNAVAILABLE');
 assert.throws(()=>createWorkerHttp({...config,listmonkOrigin:'http://email.example.invalid'}),/CONFIG/);assert.throws(()=>createWorkerHttp({...config,listmonkOrigin:'https://email.example.invalid/other'}),/CONFIG/);
});
test('invalid JSON preserves explicit rejection status while an invalid success remains unknown',async()=>{
 const {classify}=require('../n8n/growth/journey-graph-delivery.cjs');
 for(const status of [400,401,403,404,422,200,500]){
  let calls=0;const a=createWorkerHttp({...config,fetchImpl:async()=>{calls++;return new Response('Synthetic non-JSON reply',{status});}}),r=await a.sendTx({}, {timeoutMs:100});assert.equal(r.statusCode,status);assert.equal(r.body,null);assert.equal(classify(r),status>=400&&status<500?'rejected':'outcome_unknown');assert.equal(calls,1);
 }
});
