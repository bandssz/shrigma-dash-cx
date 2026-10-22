'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const path=require('node:path'),ROOT=path.resolve(__dirname,'..');
const {fixture,hosts}=require('./helpers/crm-managed-read-auth-fixture.cjs');
const B=require(path.join(ROOT,'services/dashboard-operational/crm-manager-read-bridge.cjs'));
const P=require(path.join(ROOT,'services/dashboard-operational/proxy.cjs'));
const S=require(path.join(ROOT,'services/dashboard-operational/server.cjs'));
function request(server,ctx){return new Promise(resolve=>{
 const req=Readable.from([]);req.method='GET';req.url='/api/campaigns?acao=campanha_catalogo&brand=fish';req.headers={host:ctx.host,cookie:ctx.cookieHeader};req.socket={remoteAddress:'127.0.0.1'};
 const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>{res.headers[k]=v;};res.getHeader=k=>res.headers[k];res.end=bytes=>{res.writableEnded=true;resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};res.destroy=()=>{res.destroyed=true;resolve({status:500,body:{error:'SYNTHETIC_DESTROYED'}});};server.emit('request',req,res);
});}
for(const mode of ['fetch','body'])test('deadline response retains admission until uncooperative '+mode+' work settles',async()=>{
  const f=await fixture();
  try{
   const invitation=f.invite('manager@synthetic.invalid');await f.accept(invitation);
   const login=await f.login('manager@synthetic.invalid'),ctx=f.reader(login),client=f.client(),operation=f.queued(login.user.id),prepared=await f.prepare(client,operation);
   await f.commit(client,operation,prepared.prepared);
   let pendingWork=0,dispatched=0;const finish=[];
   const fetchImpl=()=>{dispatched++;pendingWork++;return mode==='fetch'?new Promise((resolve,reject)=>{finish.push(()=>{pendingWork--;reject(Error('SYNTHETIC_LATE_FETCH_FAILURE'));});}):Promise.resolve({status:200,headers:{get:name=>name==='content-type'?'application/json':null},body:{getReader:()=>({read:()=>new Promise(resolve=>{finish.push(()=>{pendingWork--;resolve({done:true});});}),cancel:()=>{},releaseLock:()=>{}})}});};
   const upstreams=Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)]));
   const settings={...f.config,mode:'operational',upstreamProfile:'production',upstreams,allowedUpstreamHosts:['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host'],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns,campaigns_media:B.DESTINATIONS.campaigns_media}},crmManagedReadUi:true,publicDir:__dirname};
   const server=S.createServer(settings,{auth:f.auth,managedCrmRuntime:{kick:async()=>{},close:async()=>{}},fetchImpl});
   const original=globalThis.setTimeout,clear=globalThis.clearTimeout;const replies=[];
   try{
    globalThis.setTimeout=(callback,delay)=>{assert.equal(delay,25000);queueMicrotask(callback);return{};};globalThis.clearTimeout=()=>{};
    for(let n=0;n<5;n++)replies.push((await request(server,ctx)).status);
   }finally{globalThis.setTimeout=original;globalThis.clearTimeout=clear;}
   assert.equal(server.listening,false);
   assert.deepEqual({mode,replies,dispatched,pendingWork},{mode,replies:[502,502,502,502,429],dispatched:4,pendingWork:4});
   for(const settle of finish)settle();await new Promise(resolve=>setImmediate(resolve));assert.equal(pendingWork,0);
   let resumed;
   try{globalThis.setTimeout=(callback,delay)=>{assert.equal(delay,25000);queueMicrotask(callback);return{};};globalThis.clearTimeout=()=>{};resumed=await request(server,ctx);}finally{globalThis.setTimeout=original;globalThis.clearTimeout=clear;}
   assert.equal(resumed.status,502);assert.equal(dispatched,5);assert.equal(pendingWork,1);finish.at(-1)();await new Promise(resolve=>setImmediate(resolve));assert.equal(pendingWork,0);
  }finally{f.close();}
});
