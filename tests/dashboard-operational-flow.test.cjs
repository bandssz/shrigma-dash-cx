'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {build}=require('../services/dashboard-operational/build.cjs');
const {createAuth,totpAt}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');

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

test('complete isolated flow: TOTP admin, invite, team scope, CSRF and revoke',async t=>{
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
 assert.equal(begin.status,200);
 const password='Example-only Admin Password 2026!';
 const complete=await post(HOSTS.manager,'/auth/bootstrap/complete',{email:'admin@example.test',token:bootstrap,password,totp:totpAt(begin.json.totpSecret,Date.now())});
 assert.equal(complete.status,200);
 const login=await post(HOSTS.manager,'/auth/login',{email:'admin@example.test',password,totp:totpAt(begin.json.totpSecret,Date.now())});
 assert.equal(login.status,200);
 const adminCookie=login.headers['set-cookie'][0].split(';')[0],adminCsrf=login.json.csrf;
 assert.deepEqual(login.json.user.areas,['growth','organico','influs']);
 assert.equal((await call(port,HOSTS.manager,'/cx/',{cookie:adminCookie})).status,404);
 const identity=await call(port,HOSTS.manager,'/api/cx?access=1&painel=growth',{cookie:adminCookie});
 assert.equal(identity.status,200);assert.equal(identity.json.role,'master');assert.deepEqual(identity.json.allowedPanels,['growth','organico','influs']);
 assert.equal((await call(port,HOSTS.manager,'/api/cache?painel=organico',{cookie:adminCookie})).status,200);
 assert.equal((await call(port,HOSTS.manager,'/api/cx?access=1&painel=cx',{cookie:adminCookie})).status,403);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:'crm@example.test',areas:['growth'],permissions:{growth:{read:true,edit:false}}},{cookie:adminCookie})).status,403);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:'crm@example.test',areas:['growth'],permissions:{growth:{read:true,edit:true}}},{cookie:adminCookie,csrf:adminCsrf})).status,403);
 const invite=await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:'crm@example.test',areas:['growth'],permissions:{growth:{read:true,edit:false}}},{cookie:adminCookie,csrf:adminCsrf});
 assert.equal(invite.status,201);
 const inviteUrl=new URL(invite.json.inviteUrl);assert.equal(inviteUrl.hostname,HOSTS.growth);
 const token=new URLSearchParams(inviteUrl.hash.slice(1)).get('invite');
 assert.equal((await post(HOSTS.growth,'/auth/invite/accept',{token,password:'Example-only Manager Password 2026!'})).status,200);
 const manager=await post(HOSTS.growth,'/auth/login',{email:'crm@example.test',password:'Example-only Manager Password 2026!'});
 assert.equal(manager.status,200);
 const managerCookie=manager.headers['set-cookie'][0].split(';')[0];
 assert.equal((await call(port,HOSTS.growth,'/api/cx?access=1&painel=growth',{cookie:managerCookie})).json.role,'manager');
 assert.equal((await call(port,HOSTS.growth,'/api/cx?access=1&painel=influs',{cookie:managerCookie})).status,403);
 assert.equal((await call(port,HOSTS.growth,'/influs.html',{cookie:managerCookie})).status,404);
 assert.equal((await call(port,HOSTS.influs,'/auth/session',{cookie:managerCookie})).json.authenticated,false);
 assert.equal((await post(HOSTS.growth,'/api/organico-links',{acao:'salvar',k:'ui-'+'a'.repeat(32)},{cookie:managerCookie,csrf:manager.json.csrf})).status,403);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'revoke',userId:invite.json.userId},{cookie:adminCookie,csrf:adminCsrf})).status,200);
 assert.equal((await call(port,HOSTS.growth,'/auth/session',{cookie:managerCookie})).json.authenticated,false);
});
