'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {FIXED_DESTINATIONS}=require('../services/dashboard-operational/proxy.cjs');

const hosts={manager:'manager.canary.test',growth:'crm.canary.test',organico:'organico.canary.test',influs:'influs.canary.test'};
// Independent expected destinations catch path drift, not just host drift.
const expectedTargets={
 cache:'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-cache-a91f3c7e2d4b',
 'tts-cobranca':'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-cobranca-painel-a3ac4c25d1e85399'
};
const origin=host=>'https://'+host;

function request(port,host,pathname,{method='GET',body,cookie,csrf,extraHeaders={}}={}){
 return new Promise((resolve,reject)=>{
  const headers={Host:host,Origin:origin(host),...extraHeaders};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(cookie)headers.Cookie=cookie;
  if(csrf)headers['X-CSRF-Token']=csrf;
  const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
    const raw=Buffer.concat(chunks).toString('utf8');
    let json;try{json=JSON.parse(raw);}catch{}
    resolve({status:res.statusCode,headers:res.headers,json});
   });
  });
  req.on('error',reject);
  req.end(body===undefined?undefined:JSON.stringify(body));
 });
}

test('operational canary binds every request to its user, area, slot and pinned upstream',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-canary-'));
 const bootstrap='synthetic-bootstrap-token-canary-2026';
 const now=Date.UTC(2026,8,30,12,0,0);
 const auth=createAuth({
  dbPath:path.join(directory,'identity.sqlite'),managerHost:hosts.manager,
  areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},
  allowedEmailDomains:['canary.test'],bootstrapAdminEmail:'owner@canary.test',
  bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),
  encryptionKey:Buffer.alloc(32,17),now:()=>now
 });
 const upstreams={cache:FIXED_DESTINATIONS.cache,'tts-cobranca':FIXED_DESTINATIONS['tts-cobranca']};
 const calls=[];
 const crmCache={crm_diario:[{marca:'fish',dia:'2026-09-30',enviados:12},{marca:'aristo',dia:'2026-09-30',enviados:99}],crm_campanha:[]};
 const fetchImpl=async(url,options)=>{
  calls.push({url:url.href,method:options.method,headers:{...options.headers},body:options.body});
  return new Response(JSON.stringify(url.searchParams.get('painel')==='growth'?crmCache:{ok:true}),{status:200,headers:{'content-type':'application/json'}});
 };
 const server=createServer({
  mode:'operational',managerHost:hosts.manager,
  areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},
  upstreams,allowedUpstreamHosts:[...new Set(Object.values(upstreams).map(value=>new URL(value).hostname))],
  publicDir:directory
 },{auth,fetchImpl});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const post=(host,pathname,body,credentials={})=>request(port,host,pathname,{method:'POST',body,...credentials});
  const begin=await post(hosts.manager,'/auth/bootstrap/begin',{email:'owner@canary.test',token:bootstrap});
  assert.equal(begin.status,200);assert.deepEqual(begin.json,{ready:true});
  const adminPassword='Synthetic Admin Passphrase 2026!';
  assert.equal((await post(hosts.manager,'/auth/bootstrap/complete',{email:'owner@canary.test',token:bootstrap,password:adminPassword})).status,200);
  const adminLogin=await post(hosts.manager,'/auth/login',{email:'owner@canary.test',password:adminPassword});
  assert.equal(adminLogin.status,200);
  const admin={cookie:adminLogin.headers['set-cookie'][0].split(';')[0],csrf:adminLogin.json.csrf};

  async function invite(email,area,brand,password){
   const made=await post(hosts.manager,'/auth/users',{action:'invite',role:'manager',email,brand,areas:[area]},{...admin});
   assert.equal(made.status,201);
   const token=new URLSearchParams(new URL(made.json.inviteUrl).hash.slice(1)).get('invite');
   assert.equal((await post(hosts[area],'/auth/invite/accept',{token,password})).status,200);
   const login=await post(hosts[area],'/auth/login',{email,password});
   assert.equal(login.status,200);
   assert.equal(login.json.user.brand,brand);assert.deepEqual(login.json.user.brands,[brand]);assert.equal(login.json.user.brandAccess,'single');
   return {id:made.json.userId,cookie:login.headers['set-cookie'][0].split(';')[0],csrf:login.json.csrf,uiKey:login.json.uiKey};
  }
  const growth=await invite('crm@canary.test','growth','fish','Synthetic CRM Passphrase 2026!');
  const influs=await invite('creators@canary.test','influs','aristo','Synthetic Creators Passphrase 2026!');

  const organico=await invite('organic@canary.test','organico','fish','Synthetic Organic Passphrase 2026!');

  const adminGrowthKey='SyntheticAdminGrowthRead2026';
  const growthKey='SyntheticManagerGrowthRead2026';
  const influsKey='SyntheticManagerInflusRead2026';
  const adminInflusKey='SyntheticAdminInflusRead2026';
  for(const [userId,slot,bearer] of [
   [adminLogin.json.user.id,'growth-read',adminGrowthKey],
   [adminLogin.json.user.id,'influs-read',adminInflusKey],
   [growth.id,'growth-read',growthKey],
   [influs.id,'influs-read',influsKey]
  ]){
   const provisioned=await post(hosts.manager,'/auth/users',{action:'credential',userId,slot,bearer},{...admin});
   assert.equal(provisioned.status,200);
   assert.equal(JSON.stringify(provisioned.json).includes(bearer),false);
  }

  const browserHeaders={Authorization:'Bearer browser-supplied-token','X-AB-Write-Key':'browser-write-token','X-Fake-Upstream-Key':'browser-fake-token'};
  const cachePath='/api/cache?painel=growth';
  const masterCache=await request(port,hosts.manager,cachePath,{cookie:admin.cookie,extraHeaders:browserHeaders});
  assert.equal(masterCache.status,200);assert.deepEqual(masterCache.json,crmCache);
  const managerCache=await request(port,hosts.growth,cachePath,{cookie:growth.cookie,extraHeaders:browserHeaders});
  assert.equal(managerCache.status,200);assert.equal(managerCache.json.brand,'fish');
  assert.deepEqual(managerCache.json.crm_diario,[crmCache.crm_diario[0]]);assert.deepEqual(managerCache.json.crm_campanha,[]);
  assert.equal((await request(port,hosts.manager,'/api/cache?painel=influs',{cookie:admin.cookie,extraHeaders:browserHeaders})).status,200);
  // Legacy mixed aggregates are available to the master only. Single-brand
  // Influs/Orgânico cannot establish ownership and must stop before transport.
  for(const [area,member]of [['influs',influs],['organico',organico]]){
   const before=calls.length;
   const denied=await request(port,hosts[area],'/api/cache?painel='+area,{cookie:member.cookie,extraHeaders:browserHeaders});
   assert.equal(denied.status,503);assert.equal(denied.json.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(calls.length,before);
  }
  assert.deepEqual(calls.map(call=>call.url),[
   expectedTargets.cache+'?painel=growth',
   expectedTargets.cache+'?painel=growth',
   expectedTargets.cache+'?painel=influs'
  ]);
  assert.deepEqual(calls.map(call=>call.headers.Authorization),[
   'Bearer '+adminGrowthKey,'Bearer '+growthKey,'Bearer '+adminInflusKey
  ]);
  for(const call of calls){
   assert.equal(call.method,'GET');
   assert.deepEqual(Object.keys(call.headers).sort(),['Accept','Authorization']);
   assert.equal(call.body,undefined);
  }

  const beforeDenied=calls.length;
  assert.equal((await request(port,hosts.growth,'/api/cache?painel=influs',{cookie:growth.cookie})).status,403);
  assert.equal((await request(port,hosts.influs,'/api/cache?painel=growth',{cookie:influs.cookie})).status,403);
  assert.equal((await request(port,hosts.growth,cachePath+'&k=browser-key',{cookie:growth.cookie})).status,403);
  assert.equal((await post(hosts.influs,'/api/tts-cobranca',{acao:'resolver',k:influs.uiKey},{cookie:influs.cookie,csrf:influs.csrf})).status,403);
  assert.equal((await post(hosts.influs,'/api/tts-cobranca',{acao:'ler',k:influs.uiKey},{cookie:influs.cookie})).status,403);
  assert.equal(calls.length,beforeDenied);

  const scopedRead=await post(hosts.influs,'/api/tts-cobranca',{acao:'ler',k:influs.uiKey},{cookie:influs.cookie,csrf:influs.csrf,extraHeaders:browserHeaders});
  assert.equal(scopedRead.status,503);assert.equal(scopedRead.json.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(calls.length,beforeDenied);
  const read=await post(hosts.manager,'/api/tts-cobranca',{acao:'ler',k:adminLogin.json.uiKey},{...admin,extraHeaders:browserHeaders});
  assert.equal(read.status,200);
  assert.equal(calls.length,beforeDenied+1);
  assert.equal(calls.at(-1).url,expectedTargets['tts-cobranca']);
  assert.deepEqual(Object.keys(calls.at(-1).headers).sort(),['Accept','Content-Type']);
  assert.deepEqual(JSON.parse(calls.at(-1).body),{acao:'ler',k:adminInflusKey});

  const revoked=await post(hosts.manager,'/auth/users',{action:'revoke',userId:growth.id},{...admin});
  assert.equal(revoked.status,200);
  assert.equal((await request(port,hosts.growth,'/auth/session',{cookie:growth.cookie})).json.authenticated,false);
  assert.equal((await request(port,hosts.growth,cachePath,{cookie:growth.cookie})).status,401);
  assert.equal(calls.length,beforeDenied+1);
  assert.equal((await request(port,hosts.influs,'/api/cache?painel=influs',{cookie:influs.cookie})).status,503);
  assert.equal(calls.length,beforeDenied+1);
  assert.equal((await request(port,hosts.manager,'/api/cache?painel=influs',{cookie:admin.cookie})).status,200);
 }finally{
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  auth.close();fs.rmSync(directory,{recursive:true,force:true});
 }
});
