'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {build}=require('../services/dashboard-operational/build.cjs');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {FIXED_DESTINATIONS,DYNAMIC_MANIFEST_SCHEMA,REVIEWED_DYNAMIC}=require('../services/dashboard-operational/proxy.cjs');

const HOSTS={manager:'dashboard-op-gerencial.tazdb8.easypanel.host',growth:'dashboard-op-crm.tazdb8.easypanel.host',organico:'dashboard-op-organico.tazdb8.easypanel.host',influs:'dashboard-op-influs.tazdb8.easypanel.host'};
function call(port,host,pathname,{method='GET',body,cookie,csrf}={}){
 return new Promise((resolve,reject)=>{
  const headers={Host:host,Origin:'https://'+host};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(cookie)headers.Cookie=cookie;
  if(csrf)headers['X-CSRF-Token']=csrf;
  const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers},res=>{
   const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>{
    const raw=Buffer.concat(chunks).toString('utf8');let json;
    try{json=JSON.parse(raw);}catch{}
    resolve({status:res.statusCode,headers:res.headers,raw,json});
   });
  });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
}

test('complete isolated flow: password admin, invite, team scope, CSRF and revoke',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-op-flow-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 build(directory);
 const bootstrap=crypto.randomBytes(32).toString('base64url');
 const auth=createAuth({dbPath:path.join(directory,'identity.sqlite'),managerHost:HOSTS.manager,areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},allowedEmailDomains:['example.test'],bootstrapAdminEmail:'admin@example.test',bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex')});
 t.after(()=>auth.close());
 const server=createServer({mode:'synthetic',managerHost:HOSTS.manager,areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},upstreams:{},publicDir:path.join(directory,'public')},{auth});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port,post=(host,pathname,body,credentials={})=>call(port,host,pathname,{...credentials,method:'POST',body});
 const begin=await post(HOSTS.manager,'/auth/bootstrap/begin',{email:'admin@example.test',token:bootstrap});
 assert.equal(begin.status,200);assert.deepEqual(begin.json,{ready:true});
 const password='Example-only Admin Password 2026!';
 const complete=await post(HOSTS.manager,'/auth/bootstrap/complete',{email:'admin@example.test',token:bootstrap,password});
 assert.equal(complete.status,200);
 const login=await post(HOSTS.manager,'/auth/login',{email:'admin@example.test',password});
 assert.equal(login.status,200);
 const adminCookie=login.headers['set-cookie'][0].split(';')[0],adminCsrf=login.json.csrf;
 assert.deepEqual(login.json.user.areas,['growth','organico','influs']);
 const ownerSession=await call(port,HOSTS.manager,'/auth/session',{cookie:adminCookie});
 assert.deepEqual(ownerSession.json.areaHosts,{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs});
 assert.equal((await call(port,HOSTS.manager,'/cx/',{cookie:adminCookie})).status,404);
 const identity=await call(port,HOSTS.manager,'/api/cx?access=1&painel=growth',{cookie:adminCookie});
 assert.equal(identity.status,200);assert.equal(identity.json.role,'master');assert.deepEqual(identity.json.allowedPanels,['growth','organico','influs']);
 assert.equal((await call(port,HOSTS.manager,'/api/cache?painel=organico',{cookie:adminCookie})).status,200);
 assert.equal((await call(port,HOSTS.manager,'/api/cx?access=1&painel=cx',{cookie:adminCookie})).status,403);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:'crm@example.test',areas:['growth'],permissions:{growth:{read:true,edit:false}}},{cookie:adminCookie})).status,403);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:'crm@example.test',areas:['growth'],permissions:{growth:{read:true,edit:true}}},{cookie:adminCookie,csrf:adminCsrf})).status,403);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:'crm@example.test',areas:['growth'],requestedAccess:'write',permissions:{growth:{read:true,edit:false}}},{cookie:adminCookie,csrf:adminCsrf})).status,400);
 const invite=await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:'crm@example.test',areas:['growth'],requestedAccess:'edit',permissions:{growth:{read:true,edit:false}}},{cookie:adminCookie,csrf:adminCsrf});
 assert.equal(invite.status,201);
 const pending=await call(port,HOSTS.manager,'/auth/users',{cookie:adminCookie});
 assert.equal(pending.status,200);
 assert.deepEqual(pending.json.users.find(user=>user.id===invite.json.userId).permissions,{growth:{read:true,edit:false}});
 assert.equal(pending.json.users.find(user=>user.id===invite.json.userId).requestedAccess,'edit');
 const inviteUrl=new URL(invite.json.inviteUrl);assert.equal(inviteUrl.hostname,HOSTS.growth);
 const token=new URLSearchParams(inviteUrl.hash.slice(1)).get('invite');
 assert.equal((await post(HOSTS.growth,'/auth/invite/accept',{token,password:'Example-only Manager Password 2026!'})).status,200);
 const manager=await post(HOSTS.growth,'/auth/login',{email:'crm@example.test',password:'Example-only Manager Password 2026!'});
 assert.equal(manager.status,200);
 assert.equal(manager.json.user.permissions.growth.edit,false);
 const managerCookie=manager.headers['set-cookie'][0].split(';')[0];
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:managerCookie})).status,403);
 assert.equal(Object.hasOwn((await call(port,HOSTS.growth,'/auth/session',{cookie:managerCookie})).json,'areaHosts'),false);
 assert.equal((await call(port,HOSTS.growth,'/api/cx?access=1&painel=growth',{cookie:managerCookie})).json.role,'manager');
 assert.equal((await call(port,HOSTS.growth,'/api/cx?access=1&painel=influs',{cookie:managerCookie})).status,403);
 assert.equal((await call(port,HOSTS.growth,'/influs.html',{cookie:managerCookie})).status,404);
 assert.equal((await call(port,HOSTS.influs,'/auth/session',{cookie:managerCookie})).json.authenticated,false);
 assert.equal((await post(HOSTS.growth,'/api/organico-links',{acao:'salvar',k:'ui-'+'a'.repeat(32)},{cookie:managerCookie,csrf:manager.json.csrf})).status,403);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'access_request',userId:invite.json.userId,requestedAccess:'read'},{cookie:adminCookie,csrf:adminCsrf})).status,200);
 const readOnly=await call(port,HOSTS.manager,'/auth/users',{cookie:adminCookie});
 assert.equal(readOnly.json.users.find(user=>user.id===invite.json.userId).requestedAccess,'read');
 assert.equal((await call(port,HOSTS.growth,'/auth/session',{cookie:managerCookie})).json.authenticated,false);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'access_request',userId:invite.json.userId,requestedAccess:'edit'},{cookie:adminCookie,csrf:adminCsrf})).status,200);
 const requestedAgain=await call(port,HOSTS.manager,'/auth/users',{cookie:adminCookie});
 assert.equal(requestedAgain.json.users.find(user=>user.id===invite.json.userId).requestedAccess,'edit');
 assert.equal(requestedAgain.json.users.find(user=>user.id===invite.json.userId).permissions.growth.edit,false);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'revoke',userId:invite.json.userId},{cookie:adminCookie,csrf:adminCsrf})).status,200);
 const revoked=await call(port,HOSTS.manager,'/auth/users',{cookie:adminCookie});
 assert.equal(revoked.json.users.find(user=>user.id===invite.json.userId).requestedAccess,'read');
});

test('CRM-only operational canary forwards only an individual read and stops at revocation',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-op-crm-read-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const bootstrap=crypto.randomBytes(32).toString('base64url');
 const identity={dbPath:path.join(directory,'identity.sqlite'),managerHost:HOSTS.manager,
  areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},
  allowedEmailDomains:['example.test'],bootstrapAdminEmail:'admin@example.test',
  bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),
  encryptionKey:crypto.randomBytes(32).toString('hex')};
 const auth=createAuth(identity);t.after(()=>auth.close());
 const backend=FIXED_DESTINATIONS['crm-read'],backendHost=new URL(backend).hostname;
 const mediaBackend=REVIEWED_DYNAMIC.routes.campaigns_media,mediaHost=new URL(mediaBackend).hostname;
 const credential='growth-read-individual-1234',mediaCredential='media-read-individual-1234';
 let upstreamCalls=0,mediaCalls=0;
 const fetchImpl=async(url,options)=>{
  if(url.href===mediaBackend+'?brand=fish&page=1&per_page=24'){
   mediaCalls++;
   assert.equal(options.method,'GET');
   assert.equal(options.headers.Authorization,'Bearer '+mediaCredential);
   assert.equal(Object.hasOwn(options.headers,'Origin'),false);
   return new Response(JSON.stringify({contract:'crm-media-v1',brand:'fish',items:[],total:0,page:1,per_page:24,next_page:null}),{status:200,headers:{'Content-Type':'application/json'}});
  }
  upstreamCalls++;
  assert.equal(url.href,backend+'?action=cache_growth&painel=growth');
  assert.equal(options.method,'GET');
  assert.equal(options.headers.Authorization,'Bearer '+credential);
  assert.equal(Object.hasOwn(options.headers,'Origin'),false);
  return new Response(JSON.stringify({panel:'growth',items:[]}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const server=createServer({mode:'operational',managerHost:HOSTS.manager,
  areaHosts:identity.areaHosts,upstreams:{'crm-read':new URL(backend),campaigns_media:new URL(mediaBackend)},
  allowedUpstreamHosts:[backendHost,mediaHost],
  dynamicRouteManifest:{schema:DYNAMIC_MANIFEST_SCHEMA,sourceRevision:REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns_media:mediaBackend}},
  publicDir:directory},{auth,fetchImpl});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port,post=(host,pathname,body,credentials={})=>call(port,host,pathname,{...credentials,method:'POST',body});
 const begin=await post(HOSTS.manager,'/auth/bootstrap/begin',{email:identity.bootstrapAdminEmail,token:bootstrap});
 assert.equal(begin.status,200);assert.deepEqual(begin.json,{ready:true});
 const adminPassword='Example-only Admin Password 2026!';
 assert.equal((await post(HOSTS.manager,'/auth/bootstrap/complete',{
  email:identity.bootstrapAdminEmail,token:bootstrap,password:adminPassword})).status,200);
 const login=await post(HOSTS.manager,'/auth/login',{
  email:identity.bootstrapAdminEmail,password:adminPassword});
 assert.equal(login.status,200);
 const admin={cookie:login.headers['set-cookie'][0].split(';')[0],csrf:login.json.csrf};
 const invite=await post(HOSTS.manager,'/auth/users',{
  action:'invite',role:'manager',email:'crm@example.test',areas:['growth'],
  permissions:{growth:{read:true,edit:false}}},admin);
 assert.equal(invite.status,201);
 const token=new URLSearchParams(new URL(invite.json.inviteUrl).hash.slice(1)).get('invite');
 const managerPassword='Example-only Manager Password 2026!';
 assert.equal((await post(HOSTS.growth,'/auth/invite/accept',{token,password:managerPassword})).status,200);
 const manager=await post(HOSTS.growth,'/auth/login',{email:'crm@example.test',password:managerPassword});
 assert.equal(manager.status,200);
 const managerCookie=manager.headers['set-cookie'][0].split(';')[0];
 const readPath='/api/crm-read?action=cache_growth&painel=growth';
 assert.equal((await call(port,HOSTS.growth,readPath,{cookie:managerCookie})).status,503);
 assert.equal(upstreamCalls,0);
 assert.equal((await post(HOSTS.manager,'/auth/users',{
  action:'credential',userId:invite.json.userId,slot:'growth-read',bearer:credential},admin)).status,200);
 const read=await call(port,HOSTS.growth,readPath,{cookie:managerCookie});
 assert.equal(read.status,200);assert.deepEqual(read.json,{panel:'growth',items:[]});assert.equal(upstreamCalls,1);
 assert.equal((await call(port,HOSTS.growth,'/api/crm-read?action=identity&painel=growth',{cookie:managerCookie})).status,200);
 assert.equal(upstreamCalls,1);
 assert.equal((await call(port,HOSTS.influs,readPath,{cookie:managerCookie})).status,401);
 assert.equal((await call(port,HOSTS.growth,'/api/campaigns?acao=campanha_listar&brand=fish',{cookie:managerCookie})).status,503);
 const mediaPath='/api/campaigns_media?brand=fish&page=1&per_page=24';
 assert.equal((await call(port,HOSTS.growth,mediaPath,{cookie:managerCookie})).status,503);
 assert.equal(mediaCalls,0);
 assert.equal((await post(HOSTS.manager,'/auth/users',{
  action:'credential',userId:invite.json.userId,slot:'growth-campaign-read',bearer:mediaCredential},admin)).status,200);
 const media=await call(port,HOSTS.growth,mediaPath,{cookie:managerCookie});
 assert.equal(media.status,200);
 assert.equal(media.json.contract,'crm-media-v1');assert.equal(mediaCalls,1);
 assert.equal((await call(port,HOSTS.influs,mediaPath,{cookie:managerCookie})).status,401);
 assert.equal((await call(port,HOSTS.growth,'/api/campaigns_media?brand=fish&filename=unreviewed',{cookie:managerCookie})).status,403);
 assert.equal((await post(HOSTS.growth,'/api/campaigns_media',{brand:'fish',file:'synthetic'},{cookie:managerCookie,csrf:manager.json.csrf})).status,403);
 assert.equal(mediaCalls,1);
 assert.equal((await post(HOSTS.growth,'/api/campaigns',{acao:'campanha_salvar',brand:'fish'},{cookie:managerCookie,csrf:manager.json.csrf})).status,403);
 assert.equal(upstreamCalls,1);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'revoke',userId:invite.json.userId},admin)).status,200);
 assert.equal((await call(port,HOSTS.growth,readPath,{cookie:managerCookie})).status,401);
 assert.equal(upstreamCalls,1);
 assert.equal((await call(port,HOSTS.growth,mediaPath,{cookie:managerCookie})).status,401);
 assert.equal(mediaCalls,1);
});
