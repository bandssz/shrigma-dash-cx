'use strict';
// Loopback HTTP + disposable SQLite/PGlite only. No real environment or backend.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {EventEmitter}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {build}=require('../services/dashboard-operational/build.cjs');
const {createProvisioningClient}=require('../services/dashboard-operational/crm-manager-provisioning.cjs');
const {createManagerCoordinator:createCoordinator}=require('../services/dashboard-operational/crm-manager-coordinator.cjs');
const {createManagerDispatcher}=require('../services/dashboard-operational/crm-manager-dispatcher.cjs');
const {verifyManagedCrmCredential}=require('../services/dashboard-operational/crm-manager-attestation.cjs');
const gateway=require('../services/crm-manager-provisioner/server.cjs');
const {createFixture,issuerA}=require('./crm-manager-provision-postgres.test.cjs');
const {FIXED_DESTINATIONS}=require('../services/dashboard-operational/proxy.cjs');
const hosts={manager:'manager.http.synthetic.invalid',growth:'crm.http.synthetic.invalid',organico:'organico.http.synthetic.invalid',influs:'influs.http.synthetic.invalid'};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function rpcBridge(app,calls){return (url,opts,callback)=>{
 const clientReq=new EventEmitter();clientReq.setTimeout=()=>{};clientReq.destroy=()=>{};
 clientReq.end=wire=>{
  calls.push(wire);const req=new EventEmitter(),res=new EventEmitter(),incoming=new EventEmitter();incoming.destroy=()=>{};
  req.headers={host:gateway.HOST,...Object.fromEntries(Object.entries(opts.headers).map(([k,v])=>[k.toLowerCase(),String(v)]))};req.rawHeaders=Object.entries(req.headers).flat();req.method='POST';req.url=new URL(url).pathname;req.complete=false;
  res.writeHead=(status,headers)=>{incoming.statusCode=status;incoming.headers=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v)]));};res.end=bytes=>{res.writableEnded=true;callback(incoming);incoming.emit('data',Buffer.from(bytes));incoming.emit('end');};res.destroy=()=>{};
  app.handle(req,res).catch(e=>clientReq.emit('error',e));queueMicrotask(()=>{req.emit('data',Buffer.from(wire));req.complete=true;req.emit('end');});
 };return clientReq;
};}
function call(port,host,pathname,{method='GET',body,cookie,csrf}={}){return new Promise((resolve,reject)=>{
 const headers={Host:host,Origin:'https://'+host};if(body!==undefined)headers['Content-Type']='application/json';if(cookie)headers.Cookie=cookie;if(csrf)headers['X-CSRF-Token']=csrf;
 const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(raw);}catch{}resolve({status:res.statusCode,headers:res.headers,json,raw});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
});}
test('HTTP admin creates two managed CRM accounts, verifies their private origin identities and revokes only one',async t=>{
 const origin=await createFixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'manager-http-fixture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));build(dir);
 const dbPath=path.join(dir,'identity.sqlite'),bootstrap=crypto.randomBytes(32).toString('base64url');
 const auth=createAuth({dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['example.test'],bootstrapAdminEmail:'admin@example.test',bootstrapTokenSha256:sha(bootstrap),encryptionKey:crypto.randomBytes(32),crmManagedRead:{issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId}});t.after(()=>auth.close());
 const inspect=fn=>{const db=new DatabaseSync(dbPath);try{return fn(db);}finally{db.close();}};
 const backend=FIXED_DESTINATIONS['crm-read'],privateReads=[];
 const fetchImpl=async(url,options)=>{
  const target=new URL(url);assert.equal(target.origin+target.pathname,backend);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers.Origin,undefined);
  const bearer=options.headers.Authorization.slice('Bearer '.length),operator=(await origin.db.query('SELECT public.shrigma_panel_operator_v1($1,$2) AS body',[bearer,'growth'])).rows[0].body;privateReads.push({action:target.searchParams.get('action'),bearer});
  if(!operator)return new Response('{"error":"denied"}',{status:401,headers:{'content-type':'application/json'}});
  const identity={schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:operator.label,allowedPanels:['growth'],permissions:{growth:operator,influs:null}};
  const response=new Response(JSON.stringify(target.searchParams.get('action')==='identity'?identity:{panel:'growth',owner:operator.label,items:[]}),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:target.href});return response;
 };
 const server=createServer({mode:'operational',managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},upstreams:{'crm-read':new URL(backend)},allowedUpstreamHosts:[new URL(backend).hostname],publicDir:path.join(dir,'public')},{auth,fetchImpl});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port,post=(host,p,b,c={})=>call(port,host,p,{...c,method:'POST',body:b});
 assert.equal((await post(hosts.manager,'/auth/bootstrap/complete',{email:'admin@example.test',token:bootstrap,password:'Synthetic master password 2026!'})).status,200);
 const login=await post(hosts.manager,'/auth/login',{email:'admin@example.test',password:'Synthetic master password 2026!'});assert.equal(login.status,200);
 const admin={cookie:login.headers['set-cookie'][0].split(';')[0],csrf:login.json.csrf},adminId=login.json.user.id;
 const baseline=()=>inspect(db=>({user:db.prepare('SELECT * FROM users WHERE id=?').get(adminId),grants:db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(adminId),slot:db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').all(adminId)}));const before=baseline();
 const rpcCalls=[],pool={query:async(sql,args)=>{assert.equal(args.length,1);const command=JSON.parse(args[0]);assert.equal(sql,gateway.QUERIES[command.action]);return {rows:[{body:await origin.call(command)}]};}};
 const app=gateway.createServer({pool,issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId,allowedEmailDomains:['example.test'],provisionerToken:'S'.repeat(43),revision:'a'.repeat(40),enabled:true});t.after(()=>app.stop());
 const client=createProvisioningClient({issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId,allowedEmailDomains:['example.test'],provisionerToken:'S'.repeat(43),requestImpl:rpcBridge(app,rpcCalls)}),journal=auth.managedCrmJournal;
 const coordinator=createCoordinator({journal,client,getOperationState:journal.operationState,attest:args=>verifyManagedCrmCredential(args,{fetchImpl})});
 const dispatcher=createManagerDispatcher({getPendingOperations:journal.pendingOperations,coordinator});
 assert.deepEqual(await dispatcher.drain(),{ready:0,pending:0,expired:0,revoked:0});
 const managers=[];
 for(const email of ['a@example.test','b@example.test']){
  const invite=await post(hosts.manager,'/auth/users',{action:'invite',role:'manager',email,areas:['growth'],permissions:{growth:{read:true,edit:false}},requestedAccess:'edit'},admin);assert.equal(invite.status,201);const token=new URLSearchParams(new URL(invite.json.inviteUrl).hash.slice(1)).get('invite');
  assert.equal((await post(hosts.organico,'/auth/invite/accept',{token,password:'Synthetic manager password 2026!'})).status,403);
  assert.equal((await post(hosts.growth,'/auth/invite/accept',{token,password:'Synthetic manager password 2026!'})).status,200);
  const m=await post(hosts.growth,'/auth/login',{email,password:'Synthetic manager password 2026!'});assert.equal(m.status,200);assert.equal(m.json.user.permissions.growth.edit,false);const credentials={cookie:m.headers['set-cookie'][0].split(';')[0],csrf:m.json.csrf};
  assert.equal((await call(port,hosts.growth,'/api/crm-read?action=cache_growth&painel=growth',credentials)).status,503);
  assert.deepEqual(await dispatcher.drain(),{ready:1,pending:0,expired:0,revoked:0});const read=await call(port,hosts.growth,'/api/crm-read?action=cache_growth&painel=growth',credentials);assert.equal(read.status,200);assert.equal(read.json.owner,email);
  assert.equal((await call(port,hosts.organico,'/auth/session',credentials)).json.authenticated,false);assert.equal((await call(port,hosts.growth,'/organico/',credentials)).status,404);
  managers.push({id:invite.json.userId,email,credentials});
 }
 const users=await call(port,hosts.manager,'/auth/users',admin);assert.equal(users.status,200);for(const m of managers)assert.equal(users.json.users.find(u=>u.id===m.id).crmAccess.ready,true);
 const keys=privateReads.filter(r=>r.action==='identity').map(r=>r.bearer);assert.equal(new Set(keys).size,2);for(const key of keys){assert.ok(!users.raw.includes(key));assert.ok(rpcCalls.every(wire=>!wire.includes(key)));}
 assert.equal((await post(hosts.manager,'/auth/users',{action:'revoke',userId:managers[0].id},{cookie:admin.cookie})).status,403);
 const revoked=await post(hosts.manager,'/auth/users',{action:'revoke',userId:managers[0].id},admin);assert.equal(revoked.json.crmRevocationPending,true);assert.equal((await call(port,hosts.growth,'/auth/session',managers[0].credentials)).json.authenticated,false);
 assert.deepEqual(await dispatcher.drain(),{ready:0,pending:0,expired:0,revoked:1});const still=await call(port,hosts.growth,'/api/crm-read?action=cache_growth&painel=growth',managers[1].credentials);assert.equal(still.status,200);assert.equal(still.json.owner,managers[1].email);
 assert.deepEqual(await dispatcher.drain(),{ready:0,pending:0,expired:0,revoked:0});
 const originRevoked=await fetchImpl(backend+'?action=identity&painel=growth',{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+keys[0]}});assert.equal(originRevoked.status,401);
 assert.deepEqual(baseline(),before);await origin.unchanged();assert.equal((await call(port,hosts.manager,'/cx/',admin)).status,404);
});
