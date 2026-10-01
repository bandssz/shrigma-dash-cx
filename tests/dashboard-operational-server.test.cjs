'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createServer,fileForHost,safeRequestPath,settingsFromEnv}=require('../services/dashboard-operational/server.cjs');
const {AuthError}=require('../services/dashboard-operational/auth.cjs');
const {FIXED_DESTINATIONS,DYNAMIC_MANIFEST_SCHEMA,REVIEWED_DYNAMIC}=require('../services/dashboard-operational/proxy.cjs');
const HOSTS={manager:'gerencial.shrigma.com.br',growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'};
const settings={mode:'synthetic',managerHost:HOSTS.manager,areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},upstreams:{}};
function request(port,host,pathname,method='GET',body,headersExtra={}){
  return new Promise((resolve,reject)=>{
    const headers={Host:host,Origin:'https://'+host,'Content-Type':'application/json','X-CSRF-Token':'test',...headersExtra};
    const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});
    req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
test('host routing, CX removal and isolated synthetic API enforcement',async t=>{
  const publicDir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-op-public-'));
  t.after(()=>fs.rmSync(publicDir,{recursive:true,force:true}));
  for(const name of ['gestao/index.html','crm/index.html','organico/index.html','creators/index.html','growth.html','organico.html','influs.html']){
    const file=path.join(publicDir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'<!doctype html><title>'+name+'</title>');
  }
  const auth={
    session:()=>({authenticated:false}),
    authorize:ctx=>{if(!ctx.cookieHeader)throw new AuthError('SESSION_REQUIRED',401);if(ctx.area&&ctx.host!==HOSTS[ctx.area])throw new AuthError('AREA_DENIED',403);return {role:'manager',areas:[ctx.area],permissions:{[ctx.area]:{read:true,edit:false}}};},
    getUpstreamCredential:()=>null
  };
  const server=createServer({...settings,publicDir},{auth});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  const root=await request(port,HOSTS.manager,'/');assert.equal(root.status,200);assert.match(root.body,/gestao\/index.html/);
  const team=await request(port,HOSTS.growth,'/');assert.equal(team.status,200);assert.match(team.body,/crm\/index.html/);
  assert.equal((await request(port,HOSTS.growth,'/organico/')).status,404);
  assert.equal((await request(port,HOSTS.manager,'/cx/')).status,404);
  assert.equal((await request(port,HOSTS.manager,'/index.js')).status,404);
  assert.equal((await request(port,HOSTS.manager,'/growth.html')).status,401);
  assert.equal((await request(port,'evil.invalid','/')).status,421);
  assert.equal((await request(port,HOSTS.growth,'/api/cx?painel=cx')).status,403);
  assert.equal((await request(port,HOSTS.growth,'/api/cache?painel=growth')).status,401);
  const identity=await request(port,HOSTS.growth,'/api/cx?access=1&painel=growth','GET',undefined,{Cookie:'test-session'});
  assert.equal(identity.status,200);
  assert.deepEqual(JSON.parse(identity.body).allowedPanels,['growth']);
  assert.equal((await request(port,HOSTS.growth,'/api/cx?access=1&painel=influs','GET',undefined,{Cookie:'test-session'})).status,403);
  const health=await request(port,HOSTS.manager,'/healthz');assert.equal(health.status,200);assert.equal(JSON.parse(health.body).mode,'synthetic');
  assert.match(root.headers['content-security-policy'],/frame-ancestors 'self'/);
});
test('completed malformed logins do not create a shared-proxy attempt ceiling',async t=>{
  const publicDir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-login-gate-'));
  t.after(()=>fs.rmSync(publicDir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(publicDir,'entry.js'),'// public test asset');
  let loginCalls=0,lastIp;
  const auth={
    session:()=>({authenticated:false}),
    login:async({ip})=>{loginCalls++;lastIp=ip;throw new AuthError('AUTH_INVALID',401);}
  };
  const server=createServer({...settings,publicDir},{auth});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  for(let i=0;i<32;i++){
    const result=await request(port,HOSTS.manager,'/auth/login','POST',undefined,{
      'X-Forwarded-For':`198.51.100.${i+1}`,
      Forwarded:`for=203.0.113.${i+1}`
    });
    assert.equal(result.status,400);
    assert.equal(JSON.parse(result.body).error,'INVALID_JSON');
  }
  assert.equal(loginCalls,0);
  assert.equal((await request(port,HOSTS.manager,'/entry.js')).status,200);
  assert.equal((await request(port,HOSTS.manager,'/auth/session')).status,200);
  assert.equal((await request(port,HOSTS.manager,'/healthz')).status,200);
  const retry=await request(port,HOSTS.manager,'/auth/login','POST',{email:'random@shrigma.com.br',password:'invalid'},{'X-Forwarded-For':'192.0.2.201'});
  assert.equal(retry.status,401);assert.equal(loginCalls,1);assert.equal(lastIp,'127.0.0.1');
});
test('login gate ignores spoofed forwarding headers and caps only concurrent requests before JSON parsing',async t=>{
  const publicDir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-login-pending-'));
  t.after(()=>fs.rmSync(publicDir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(publicDir,'entry.js'),'// public test asset');
  let started=0,signal,rejects=[];
  const reached=new Promise(resolve=>signal=resolve);
  const auth={
    login:()=>{
      if(++started===8)signal();
      if(started>8)throw new AuthError('AUTH_INVALID',401);
      return new Promise((resolve,reject)=>rejects.push(reject));
    },
    session:()=>({authenticated:false})
  };
  const server=createServer({...settings,publicDir},{auth});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port,body={email:'random@shrigma.com.br',password:'invalid'};
  const pending=Array.from({length:8},(_,i)=>request(port,HOSTS.manager,'/auth/login','POST',body,{'X-Forwarded-For':`198.51.100.${i+1}`,Forwarded:`for=203.0.113.${i+1}`}));
  await reached;
  const blocked=await request(port,HOSTS.manager,'/auth/login','POST',undefined,{'X-Forwarded-For':'192.0.2.200'});
  assert.equal(blocked.status,429);
  assert.equal(JSON.parse(blocked.body).error,'AUTH_BUSY');
  assert.equal(started,8);
  assert.equal((await request(port,HOSTS.manager,'/entry.js')).status,200);
  assert.equal((await request(port,HOSTS.manager,'/healthz')).status,200);
  for(const reject of rejects)reject(new AuthError('AUTH_INVALID',401));
  for(const result of await Promise.all(pending))assert.equal(result.status,401);
  assert.equal((await request(port,HOSTS.manager,'/auth/login','POST',body)).status,401);
  assert.equal((await request(port,HOSTS.manager,'/auth/login','POST')).status,400);
  assert.equal(started,9);
});
test('partial login bodies time out and release concurrency slots before the server request timeout',async t=>{
  const publicDir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-login-timeout-'));
  t.after(()=>fs.rmSync(publicDir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(publicDir,'entry.js'),'// public test asset');
  let started=0,signal,loginCalls=0;
  const reached=new Promise(resolve=>signal=resolve);
  const auth={login:async()=>{loginCalls++;throw new AuthError('AUTH_INVALID',401);}};
  const server=createServer({...settings,publicDir},{auth,loginBodyTimeoutMs:1000});
  server.on('request',req=>{if(req.method==='POST'&&req.url==='/auth/login'&&++started===8)signal();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  const slow=Array.from({length:8},()=>{
    const req=http.request({hostname:'127.0.0.1',port,path:'/auth/login',method:'POST',headers:{Host:HOSTS.manager,Origin:'https://'+HOSTS.manager,'Content-Type':'application/json','Content-Length':'100'}},res=>res.resume());
    req.on('error',()=>{});
    const closed=new Promise(resolve=>req.once('close',resolve));
    req.write('{');
    return closed;
  });
  await reached;
  assert.equal((await request(port,HOSTS.manager,'/auth/login','POST',{email:'random@shrigma.com.br',password:'invalid'})).status,429);
  assert.equal((await request(port,HOSTS.manager,'/entry.js')).status,200);
  assert.equal((await request(port,HOSTS.manager,'/healthz')).status,200);
  assert.equal(loginCalls,0);
  await Promise.all(slow);
  assert.equal((await request(port,HOSTS.manager,'/auth/login','POST',{email:'random@shrigma.com.br',password:'invalid'})).status,401);
  assert.equal(loginCalls,1);
});
test('login body deadline ends before password verification begins',async t=>{
  const auth={login:async()=>{
    await new Promise(resolve=>setTimeout(resolve,700));
    return {cookie:'test-session',user:{role:'manager'},csrf:'test-csrf',uiKey:'test-ui'};
  }};
  const server=createServer({...settings,publicDir:path.join(__dirname,'../services/dashboard-operational/public')},{auth,loginBodyTimeoutMs:500});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await request(server.address().port,HOSTS.manager,'/auth/login','POST',{email:'random@shrigma.com.br',password:'invalid'});
  assert.equal(result.status,200);
  assert.equal(JSON.parse(result.body).authenticated,true);
});
test('encoded traversal and ambiguous raw paths are rejected before file lookup',()=>{
  for(const raw of ['//evil.invalid','/%2e%2e/private','/%2fadmin','/a\\b'])assert.throws(()=>safeRequestPath(raw));
  assert.equal(fileForHost('/cx/',HOSTS.manager,settings),null);
  assert.equal(fileForHost('/organico/',HOSTS.growth,settings),null);
  for(const file of ['/growth-diagnostico.html','/growth-control.js','/growth-delivery.js','/growth-diagnostic.js','/growth-diagnostic-ui.js']){
    assert.equal(fileForHost(file,HOSTS.growth,settings),file);
    assert.equal(fileForHost(file,HOSTS.manager,settings),file);
    assert.equal(fileForHost(file,HOSTS.organico,settings),null);
    assert.equal(fileForHost(file,HOSTS.influs,settings),null);
  }
});

test('operational startup pins each full destination and its reviewed source revision',()=>{
  const configured={cx:FIXED_DESTINATIONS.cx},fixedHost=new URL(FIXED_DESTINATIONS.cx).hostname;
  const env={DASHBOARD_MODE:'operational',DASHBOARD_MANAGER_HOST:HOSTS.manager,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs}),DASHBOARD_EMAIL_DOMAINS:'["shrigma.com.br"]',DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([fixedHost]),DASHBOARD_UPSTREAMS:JSON.stringify(configured)};
  assert.equal(settingsFromEnv(env).upstreams.cx.href,FIXED_DESTINATIONS.cx);
  assert.throws(()=>settingsFromEnv({...env,DASHBOARD_UPSTREAMS:JSON.stringify({cx:FIXED_DESTINATIONS.cache})}),/Unapproved upstream destination/);
  assert.throws(()=>settingsFromEnv({...env,DASHBOARD_UPSTREAMS:JSON.stringify({cx:FIXED_DESTINATIONS.cx+'/other'})}),error=>error.message==='Unapproved upstream destination');
  const dynamic={segments:REVIEWED_DYNAMIC.routes.segments};
  const manifest={schema:DYNAMIC_MANIFEST_SCHEMA,sourceRevision:REVIEWED_DYNAMIC.sourceRevision,routes:dynamic};
  const dynamicEnv={...env,DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([new URL(dynamic.segments).hostname]),DASHBOARD_UPSTREAMS:JSON.stringify(dynamic),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify(manifest)};
  assert.equal(settingsFromEnv(dynamicEnv).upstreams.segments.href,dynamic.segments);
  assert.throws(()=>settingsFromEnv({...dynamicEnv,DASHBOARD_DYNAMIC_ROUTE_MANIFEST:undefined}),/Unreviewed dynamic upstream manifest/);
  assert.throws(()=>settingsFromEnv({...dynamicEnv,DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({...manifest,sourceRevision:'0'.repeat(40)})}),/Unreviewed dynamic upstream manifest/);
  assert.throws(()=>settingsFromEnv({...dynamicEnv,DASHBOARD_UPSTREAMS:JSON.stringify({segments:REVIEWED_DYNAMIC.routes.campaign_audience}),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({...manifest,routes:{segments:REVIEWED_DYNAMIC.routes.campaign_audience}})}),/Unapproved upstream destination/);
  const auth={};
  assert.throws(()=>createServer({...settings,mode:'operational',upstreams:{cx:new URL(FIXED_DESTINATIONS.cache)},allowedUpstreamHosts:[fixedHost]},{auth}),/Unapproved upstream destination/);
  assert.doesNotThrow(()=>createServer({...settings,mode:'synthetic',upstreams:{}},{auth}));
});

test('operational gateway bounds simultaneous upstream calls per user',async t=>{
  let release,notify;
  const gate=new Promise(resolve=>release=resolve),fourReached=new Promise(resolve=>notify=resolve);
  let started=0;
  const auth={authorize:()=>({id:'manager-one',role:'manager',areas:['growth']}),getUpstreamCredential:()=> 'individual-read-key-1234'};
  const fetchImpl=async()=>{
    if(++started===4)notify();
    await gate;
    return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}});
  };
  const server=createServer({...settings,mode:'operational',upstreams:{cx:new URL(FIXED_DESTINATIONS.cx)},allowedUpstreamHosts:[new URL(FIXED_DESTINATIONS.cx).hostname]},{auth,fetchImpl});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port,route='/api/cx?painel=growth';
  const active=Array.from({length:4},()=>request(port,HOSTS.growth,route));
  await fourReached;
  assert.equal((await request(port,HOSTS.growth,route)).status,429);
  assert.equal(started,4);
  release();
  for(const result of await Promise.all(active))assert.equal(result.status,200);
  assert.equal((await request(port,HOSTS.growth,route)).status,200);
});
