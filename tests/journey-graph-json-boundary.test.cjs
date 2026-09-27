'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const W=require('../n8n/growth/journey-graph-workflow.cjs'),G=require('../n8n/growth/journey-graph-contract.js');
const {fixture,id}=require('./fixtures/journey-graph-runtime.cjs');
const clean=x=>JSON.parse(JSON.stringify(x));
const headers={authorization:'Bearer synthetic-manager-key'};
const request=(brand='fish')=>({method:'POST',request:{headers,body:{action:'create',brand,request_id:id(1),definition:fixture({connect:async()=>{throw Error("No database calls allowed");}},brand).graph}}});
function context(extra={}){return {Object,JSON,...extra};}
function bundled(expression,variables={},extra={}){return vm.runInNewContext('(function(){'+W.BUNDLE+'\nreturn '+expression+';})()',context({...variables,...extra}));}
test('real foreign-realm object is rejected by the strict path; bounded JSON generates identical proofs in both brands',()=>{
 const foreign=vm.runInNewContext('('+JSON.stringify(request())+')');assert.equal(W.API.parse(foreign).route,'response');
 for(const brand of ['fish','aristo']){const input=request(brand),f=fixture({connect:async()=>{throw Error("No database calls allowed");}},brand),original=W.API.parse(input),r={_private:true,auth:{who:'panel:synthetic'},catalog:f.catalog};
  const parsed=bundled('GraphHttp.parseJSON(text)',{text:JSON.stringify(input)});assert.deepEqual(clean(parsed),original);
  const result=bundled('GraphHttp.prepareJSON(entry,result)',{entry:JSON.stringify(parsed),result:JSON.stringify(r)});assert.equal(result.route,'commit');assert.deepEqual(clean(result),W.API.prepare(original,r));
 }
});
test('JSON-only boundary never relies on unstable bridge prototype or descriptors; object APIs stay strict',()=>{
 const reflection=new Proxy(Object,{get(target,key){if(['getPrototypeOf','getOwnPropertyDescriptors'].includes(key))return ()=>{throw Error('bridge reflection unavailable');};return Reflect.get(target,key);}}),f=fixture({connect:async()=>{throw Error("No database calls allowed");}}),entry=W.API.parse(request()),r={_private:true,auth:{who:'panel:synthetic'},catalog:f.catalog};
 const result=bundled('GraphHttp.prepareJSON(entry,result)',{entry:JSON.stringify(entry),result:JSON.stringify(r)},{Object:reflection});assert.equal(result.route,'commit');assert.deepEqual(clean(result),W.API.prepare(entry,r));
 class Graph{};Object.assign(Graph.prototype,f.graph);assert.equal(G.validateGraph(new Graph(),{catalog:f.catalog}).ok,false);
 const custom=Object.assign(Object.create({secret:true}),f.graph);assert.equal(G.validateGraph(custom,{catalog:f.catalog}).ok,false);
 let reads=0;const getter={...f.graph};Object.defineProperty(getter,'name',{enumerable:true,get(){reads++;return 'not read';}});assert.equal(G.validateGraph(getter,{catalog:f.catalog}).ok,false);assert.equal(reads,0);
 assert.equal(G.validateGraphJSON(new String(JSON.stringify(f.graph)),JSON.stringify(f.catalog)).ok,false);
});
test('malformed JSON, malicious keys, incorrect root, excessive data and all existing graph restrictions fail closed',()=>{
 const f=fixture({connect:async()=>{throw Error("No database calls allowed");}}),good=JSON.stringify(f.graph),catalog=JSON.stringify(f.catalog);
 for(const text of ['{','[]','null','1e999',good.replace('"name":','"__proto__":{},"name":'),good.replace('"name":','"constructor":{},"name":'),' '.repeat(131073),JSON.stringify({...f.graph,enabled:true})])assert.equal(G.validateGraphJSON(text,catalog).ok,false);
 assert.equal(G.validateGraphJSON(good,JSON.stringify(fixture({connect:async()=>{throw Error("No database calls allowed");}},'aristo').catalog)).ok,false);
 const broken=clean(f.graph);broken.edges.pop();assert.equal(G.validateGraphJSON(JSON.stringify(broken),catalog).ok,false);
 const bad=request();bad.request.body.actor='panel:other';assert.equal(W.API.parseJSON(JSON.stringify(bad)).route,'response');
 for(const text of ['{','[]','null',JSON.stringify(request()).replace('"action":','"prototype":{},"action":'),' '.repeat(262145)])assert.equal(W.API.parseJSON(text).route,'response');
 const publish=request();publish.request.body.action='publish';assert.equal(W.API.parseJSON(JSON.stringify(publish)).route,'response');
});
test('generated three JSON nodes execute the n8n representation and preserve response/unknown identity without transport',()=>{
 const w=W.buildWorkflow({webhookPath:'synthetic-graph-drafts',postgresCredential:{id:'synthetic',name:'Fixture'}}),run=(name,$json,entry)=>vm.runInNewContext('(function(){'+w.nodes.find(n=>n.name===name).parameters.jsCode+'})()',context({$json,$:()=>({first:()=>({json:entry})})}))[0].json;
 const entry=run('Entrada',request());assert.equal(entry.route,'read');const prepared=run('Preparar',{result:{_private:true,auth:{who:'panel:synthetic'},catalog:fixture({connect:async()=>{throw Error("No database calls allowed");}}).catalog}},entry);assert.equal(prepared.route,'commit');
 const receipt={status:201,body:{contract:W.VERSION,authorizes_publish:false,authorizes_send:false,receipt:{paused:true,published_revision:null}}};assert.deepEqual(clean(run('Conferir',{result:receipt},entry)),W.API.finish(entry,receipt));
 const unknown=run('Conferir',{result:null},entry);assert.equal(unknown.response.status,202);assert.equal(unknown.response.body.request_id,entry.request.request_id);assert.equal(unknown.response.body.retry_same_request_only,true);
 assert.ok(w.nodes.every(n=>!['n8n-nodes-base.httpRequest','n8n-nodes-base.scheduleTrigger'].includes(n.type)));
});
