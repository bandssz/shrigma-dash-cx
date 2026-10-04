'use strict';
// Loopback HTTP + disposable SQLite/PGlite only. No real environment or backend.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {EventEmitter}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {build}=require('../services/dashboard-operational/build.cjs');
const {createManagerRuntime}=require('../services/dashboard-operational/crm-manager-runtime.cjs');
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
function call(port,host,pathname,{method='GET',body,cookie,csrf,origin='https://'+host}={}){return new Promise((resolve,reject)=>{
 const headers={Host:host};if(origin!==null)headers.Origin=origin;if(body!==undefined)headers['Content-Type']='application/json';if(cookie)headers.Cookie=cookie;if(csrf)headers['X-CSRF-Token']=csrf;
 const req=http.request({hostname:'127.0.0.1',port,path:pathname,method,headers},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(raw);}catch{}resolve({status:res.statusCode,headers:res.headers,json,raw});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
});}
test('HTTP admin creates two managed CRM accounts, verifies their private origin identities and revokes only one',async t=>{
 const origin=await createFixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'manager-http-fixture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));build(dir);
 const dbPath=path.join(dir,'identity.sqlite'),bootstrap=crypto.randomBytes(32).toString('base64url');
 const auth=createAuth({dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['example.test'],bootstrapAdminEmail:'admin@example.test',bootstrapTokenSha256:sha(bootstrap),encryptionKey:crypto.randomBytes(32),crmManagedRead:{issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId}});const pendingFixtureReleases=[];let managedCrmRuntime;t.after(async()=>{for(const release of pendingFixtureReleases)release();await managedCrmRuntime?.close();auth.close();});
 const inspect=fn=>{const db=new DatabaseSync(dbPath);try{return fn(db);}finally{db.close();}};
 const backend=FIXED_DESTINATIONS['crm-read'],privateReads=[];
 const fetchImpl=async(url,options)=>{
  const target=new URL(url);assert.equal(target.origin+target.pathname,backend);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers.Origin,undefined);
  const bearer=options.headers.Authorization.slice('Bearer '.length),operator=(await origin.db.query('SELECT public.shrigma_panel_operator_v1($1,$2) AS body',[bearer,'growth'])).rows[0].body;privateReads.push({action:target.searchParams.get('action'),bearer,owner:operator?.label});
  if(!operator)return new Response('{"error":"denied"}',{status:401,headers:{'content-type':'application/json'}});
  const identity={schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:operator.label,allowedPanels:['growth'],permissions:{growth:operator,influs:null}};
  const response=new Response(JSON.stringify(target.searchParams.get('action')==='identity'?identity:{crm_diario:[{marca:'fish',dia:'2026-10-04',enviados:0}],crm_campanha:[]}),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:target.href});return response;
 };
 let heldPrepare=null,heldRenew=null,heldRevoke=null;const rpcCalls=[],leaseQueries=[],released=[],rpcQuery=async(sql,args)=>{assert.equal(args.length,1);const command=JSON.parse(args[0]);assert.equal(sql,gateway.QUERIES[command.action]);if(command.action==='renew_read'){
  const row=inspect(db=>db.prepare('SELECT phase,commit_operation_id,candidate_ciphertext FROM crm_manager_operations_v1 WHERE operation_id=?').get(command.operationId));assert.equal(row.phase,'prepare_uncertain');assert.ok(row.commit_operation_id&&row.candidate_ciphertext);assert.ok(auth.managedCrmJournal.pendingOperations(8).includes(command.operationId));if(heldRenew)await heldRenew;
 }if(command.action==='prepare_read'&&heldPrepare)await heldPrepare;if(command.action==='revoke_read'&&heldRevoke)await heldRevoke;return {rows:[{body:await origin.call(command)}]};};
 // The synthetic lease models only the exact reviewed admission query and
 // health transaction. All four RPC bodies still execute the real PGlite SQL.
 const pool={connect:async()=>{
  const client=new EventEmitter();let readOnly=false,closed=false;
  client.connectionParameters={host:gateway.PG_HOST,port:gateway.PG_PORT,database:gateway.DATABASE,user:gateway.ROLE,password:'SYNTHETIC_HTTP_FIXTURE_ONLY',ssl:false};client.connection={stream:{destroy(){}}};
  client.query=async(sql,args)=>{
   assert.equal(closed,false);leaseQueries.push(sql);
   if(sql===gateway.admissionSql(false)){assert.equal(args,undefined);assert.equal(readOnly,false);return {rows:[{database_ok:true,session_ok:true,actor_ok:true,version_ok:true,role_ok:true,memberships_ok:true,rpc_ok:true,table_scope_ok:true,tls_ok:true}]};}
   if(sql==='BEGIN READ ONLY'){assert.equal(args,undefined);assert.equal(readOnly,false);await origin.db.exec(sql);readOnly=true;return {command:'BEGIN',rows:[]};}
   if(sql==='ROLLBACK'){assert.equal(args,undefined);assert.equal(readOnly,true);await origin.db.exec(sql);readOnly=false;return {command:'ROLLBACK',rows:[]};}
   assert.ok(Object.values(gateway.QUERIES).includes(sql));assert.equal(args.length,1);const q=JSON.parse(args[0]);assert.equal(args[0],gateway.canonical(q));assert.equal(q.issuerId,issuerA.issuerId);assert.equal(q.namespaceId,issuerA.namespaceId);if(readOnly)assert.equal(q.action,'status');return rpcQuery(sql,args);
  };
  client.release=bad=>{assert.equal(closed,false);assert.equal(readOnly,false);closed=true;released.push(bad);};return client;
 }};
 const app=gateway.createServer({pool,issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId,allowedEmailDomains:['example.test'],provisionerToken:'S'.repeat(43),revision:'a'.repeat(40),enabled:true});t.after(()=>app.stop());
 const beforeHealth=(await origin.db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_operation_v1')).rows[0].n,probeReq=new EventEmitter(),probeRes=new EventEmitter();probeReq.method='GET';probeReq.url='/healthz';probeReq.headers={};probeReq.socket={remoteAddress:'127.0.0.1'};probeRes.writeHead=status=>{probeRes.status=status;};probeRes.end=bytes=>{probeRes.writableEnded=true;probeRes.body=JSON.parse(bytes);};
 await app.handle(probeReq,probeRes);assert.equal(probeRes.status,200);assert.equal(probeRes.body.ready,true);assert.equal(probeRes.body.policy.connectionVerified,true);assert.deepEqual(leaseQueries,[gateway.admissionSql(false),'BEGIN READ ONLY',gateway.QUERIES.status,'ROLLBACK']);assert.deepEqual(released,[false]);assert.equal((await origin.db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_operation_v1')).rows[0].n,beforeHealth);await origin.unchanged();
 managedCrmRuntime=createManagerRuntime({auth,issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId,allowedEmailDomains:['example.test'],provisionerToken:'S'.repeat(43)},{requestImpl:rpcBridge(app,rpcCalls),fetchImpl});
 const server=createServer({mode:'operational',crmManagedRead:{issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId,provisionerToken:'S'.repeat(43)},managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},upstreams:{'crm-read':new URL(backend)},allowedUpstreamHosts:[new URL(backend).hostname],publicDir:path.join(dir,'public')},{auth,fetchImpl,managedCrmRuntime});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port,post=(host,p,b,c={})=>call(port,host,p,{...c,method:'POST',body:b});
 assert.equal((await post(hosts.manager,'/auth/bootstrap/complete',{email:'admin@example.test',token:bootstrap,password:'Synthetic master password 2026!'})).status,200);
 const login=await post(hosts.manager,'/auth/login',{email:'admin@example.test',password:'Synthetic master password 2026!'});assert.equal(login.status,200);
 const admin={cookie:login.headers['set-cookie'][0].split(';')[0],csrf:login.json.csrf},adminId=login.json.user.id;
 const baseline=()=>inspect(db=>({user:db.prepare('SELECT * FROM users WHERE id=?').get(adminId),grants:db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(adminId),slot:db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').all(adminId)}));const before=baseline();
 const managers=[];
 for(const email of ['a@example.test','b@example.test']){
  let releasePrepare;heldPrepare=new Promise(resolve=>{releasePrepare=resolve;pendingFixtureReleases.push(resolve);});
  const invite=await post(hosts.manager,'/auth/users',{action:'invite',role:'manager',email,brand:'fish',areas:['growth'],permissions:{growth:{read:true,edit:false}},requestedAccess:'edit'},admin);assert.equal(invite.status,201);const token=new URLSearchParams(new URL(invite.json.inviteUrl).hash.slice(1)).get('invite');
  assert.equal((await post(hosts.organico,'/auth/invite/accept',{token,password:'Synthetic manager password 2026!'})).status,403);
  assert.equal((await post(hosts.growth,'/auth/invite/accept',{token,password:'Synthetic manager password 2026!'})).status,200);
  const m=await post(hosts.growth,'/auth/login',{email,password:'Synthetic manager password 2026!'});assert.equal(m.status,200);assert.equal(m.json.user.permissions.growth.edit,false);const credentials={cookie:m.headers['set-cookie'][0].split(';')[0],csrf:m.json.csrf};
  assert.equal((await call(port,hosts.growth,'/api/crm-read?action=cache_growth&painel=growth',credentials)).status,503);
  const preparing=managedCrmRuntime.kick();releasePrepare();heldPrepare=null;assert.deepEqual(await preparing,{ready:1,pending:0,expired:0,revoked:0});const read=await call(port,hosts.growth,'/api/crm-read?action=cache_growth&painel=growth',credentials);assert.equal(read.status,200);assert.equal(read.json.brand,'fish');assert.equal(privateReads.at(-1).owner,email);
  assert.equal((await call(port,hosts.organico,'/auth/session',credentials)).json.authenticated,false);assert.equal((await call(port,hosts.growth,'/organico/',credentials)).status,404);
  managers.push({id:invite.json.userId,email,credentials});
 }
 assert.equal((await post(hosts.manager,'/auth/users',{action:'crm_reconcile'},{cookie:admin.cookie})).status,403);
 assert.equal((await post(hosts.growth,'/auth/users',{action:'crm_reconcile'},managers[0].credentials)).status,403);
 assert.equal((await post(hosts.manager,'/auth/users',{action:'crm_reconcile',userId:managers[0].id},admin)).status,400);
 assert.equal((await post(hosts.manager,'/auth/users',{action:'crm_reconcile'},admin)).status,202);
 const users=await call(port,hosts.manager,'/auth/users',admin);assert.equal(users.status,200);for(const m of managers)assert.equal(users.json.users.find(u=>u.id===m.id).crmAccess.ready,true);
 const keys=privateReads.filter(r=>r.action==='identity').map(r=>r.bearer);assert.equal(new Set(keys).size,2);for(const key of keys){assert.ok(!users.raw.includes(key));assert.ok(rpcCalls.every(wire=>!wire.includes(key)));}
 // A renewal is a durable manual intent; old read access remains usable until
 // the new generation is committed, and a replay cannot replace that intent.
 const renewBody={action:'crm_renew',userId:managers[0].id},rpcBefore=rpcCalls.length,renewCount=()=>inspect(db=>db.prepare("SELECT COUNT(*) n FROM crm_manager_operations_v1 WHERE kind='renew'").get().n);
 for(const [host,body,credentials,status] of [[hosts.manager,renewBody,{cookie:admin.cookie},403],[hosts.manager,renewBody,{...admin,origin:'https://wrong.http.synthetic.invalid'},403],[hosts.manager,renewBody,{...admin,origin:null},403],[hosts.growth,renewBody,managers[0].credentials,403],[hosts.manager,{action:'crm_renew'},admin,400],[hosts.manager,{...renewBody,operationId:crypto.randomUUID()},admin,400],[hosts.manager,{...renewBody,userId:'not-a-uuid'},admin,400],[hosts.manager,{...renewBody,userId:adminId},admin,404]])assert.equal((await post(host,'/auth/users',body,credentials)).status,status);
 assert.equal(renewCount(),0);assert.equal(rpcCalls.length,rpcBefore);
 let releaseRenew;heldRenew=new Promise(resolve=>{releaseRenew=resolve;pendingFixtureReleases.push(resolve);});
 const requested=await post(hosts.manager,'/auth/users',renewBody,admin);assert.equal(requested.status,202);assert.deepEqual(requested.json,{ok:true});assert.equal(renewCount(),1);
 const persisted=inspect(db=>db.prepare("SELECT * FROM crm_manager_operations_v1 WHERE kind='renew'").get());assert.equal(persisted.phase,'prepare_uncertain');
 const pending=await call(port,hosts.manager,'/auth/users',admin),renewalDto=pending.json.users.find(u=>u.id===managers[0].id).crmAccess;assert.equal(renewalDto.ready,true);assert.equal(renewalDto.canRenew,false);assert.equal(renewalDto.renewalPhase,'prepare_uncertain');
 assert.equal((await post(hosts.manager,'/auth/users',renewBody,admin)).status,409);assert.deepEqual(inspect(db=>db.prepare("SELECT * FROM crm_manager_operations_v1 WHERE kind='renew'").get()),persisted);
 const oldRead=await call(port,hosts.growth,'/api/crm-read?action=cache_growth&painel=growth',managers[0].credentials);assert.equal(oldRead.status,200);assert.equal(oldRead.json.brand,'fish');assert.equal(privateReads.at(-1).owner,managers[0].email);
 const renewing=managedCrmRuntime.kick();releaseRenew();heldRenew=null;assert.deepEqual(await renewing,{ready:1,pending:0,expired:0,revoked:0});
 const renewedUsers=await call(port,hosts.manager,'/auth/users',admin),renewed=renewedUsers.json.users.find(u=>u.id===managers[0].id).crmAccess;assert.equal(renewed.generation,2);assert.equal(renewed.ready,true);assert.equal(renewed.renewalPhase,null);assert.equal(renewed.canRenew,true);
 assert.equal((await fetchImpl(backend+'?action=identity&painel=growth',{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+keys[0]}})).status,401);
 assert.equal((await call(port,hosts.growth,'/api/crm-read?action=cache_growth&painel=growth',managers[0].credentials)).status,200);
 for(const value of [persisted.operation_id,persisted.commit_operation_id,persisted.candidate_ciphertext,persisted.candidate_digest,persisted.principal_id,keys[0],keys[1]])assert.ok(!pending.raw.includes(value)&&!renewedUsers.raw.includes(value));
 assert.equal((await post(hosts.manager,'/auth/users',{action:'revoke',userId:managers[0].id},{cookie:admin.cookie})).status,403);
 let releaseRevoke;heldRevoke=new Promise(resolve=>{releaseRevoke=resolve;pendingFixtureReleases.push(resolve);});
 const revoked=await post(hosts.manager,'/auth/users',{action:'revoke',userId:managers[0].id},admin);assert.equal(revoked.json.crmRevocationPending,true);assert.equal((await call(port,hosts.growth,'/auth/session',managers[0].credentials)).json.authenticated,false);
 const revoking=managedCrmRuntime.kick();releaseRevoke();heldRevoke=null;assert.deepEqual(await revoking,{ready:0,pending:0,expired:0,revoked:1});const still=await call(port,hosts.growth,'/api/crm-read?action=cache_growth&painel=growth',managers[1].credentials);assert.equal(still.status,200);assert.equal(still.json.brand,'fish');assert.equal(privateReads.at(-1).owner,managers[1].email);
 assert.deepEqual(await managedCrmRuntime.kick(),{ready:0,pending:0,expired:0,revoked:0});
 const originRevoked=await fetchImpl(backend+'?action=identity&painel=growth',{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+keys[0]}});assert.equal(originRevoked.status,401);
 assert.ok(released.length>1);assert.ok(released.every(v=>v===false));assert.equal(leaseQueries.filter(q=>q===gateway.admissionSql(false)).length,released.length);assert.deepEqual(baseline(),before);await origin.unchanged();assert.equal((await call(port,hosts.manager,'/cx/',admin)).status,404);
});
