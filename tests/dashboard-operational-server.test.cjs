'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createServer,fileForHost,safeRequestPath}=require('../services/dashboard-operational/server.cjs');
const {AuthError}=require('../services/dashboard-operational/auth.cjs');
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
test('encoded traversal and ambiguous raw paths are rejected before file lookup',()=>{
  for(const raw of ['//evil.invalid','/%2e%2e/private','/%2fadmin','/a\\b'])assert.throws(()=>safeRequestPath(raw));
  assert.equal(fileForHost('/cx/',HOSTS.manager,settings),null);
  assert.equal(fileForHost('/organico/',HOSTS.growth,settings),null);
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
  const server=createServer({...settings,mode:'operational',upstreams:{cx:new URL('https://trusted.example.test/read')}},{auth,fetchImpl});
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
