'use strict';
// Actual candidate imports and SQLite stores. No module replacement, PG
// fixture, environment mutation, source pack, production data or provider.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const RUNTIME=path.resolve(__dirname,'../services/dashboard-operational');
const Factory=require(path.join(RUNTIME,'identity-store-factory.cjs'));
const Auth=require(path.join(RUNTIME,'auth.cjs')),Server=require(path.join(RUNTIME,'server.cjs')),Boot=require(path.join(RUNTIME,'bootstrap.cjs'));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const token='synthetic-factory-bootstrap-only',password='synthetic-factory-password-only';
const hosts={managerHost:'manager.synthetic.invalid',areaHosts:{growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'}};
function config(dbPath){return {dbPath,...hosts,allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'master@synthetic.invalid',bootstrapTokenSha256:sha(token),encryptionKey:Buffer.alloc(32,27)};}
function settings(dbPath){return {...config(dbPath),mode:'synthetic',upstreamProfile:'production',port:3000,host:'127.0.0.1',publicDir:RUNTIME,upstreams:{},allowedUpstreamHosts:[]};}
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-real-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
async function scenario(auth){
 const host=hosts.managerHost,origin='https://'+host;
 auth.beginBootstrap({email:'master@synthetic.invalid',token,host,origin});
 await auth.completeBootstrap({email:'master@synthetic.invalid',token,password,host,origin});
 const master=await auth.login({email:'master@synthetic.invalid',password,host,origin});
 const context={host,origin,method:'POST',cookieHeader:master.cookie.split(';')[0],csrf:master.csrf};
 const invite=auth.createInvite({context,email:'reader@synthetic.invalid',areas:['growth'],brand:'fish'});
 const crm=hosts.areaHosts.growth;
 await auth.acceptInvite({token:invite.token,password,host:crm,origin:'https://'+crm});
 await assert.rejects(auth.acceptInvite({token:invite.token,password,host:crm,origin:'https://'+crm}),error=>error.code==='INVITE_DENIED');
 const login=await auth.login({email:'reader@synthetic.invalid',password,host:crm,origin:'https://'+crm});
 const reader={host:crm,origin:'https://'+crm,method:'GET',cookieHeader:login.cookie.split(';')[0],csrf:login.csrf,area:'growth',brand:'fish'};
 assert.equal(auth.session(reader).authenticated,true);assert.equal(auth.authorizeBrand(reader,'fish').brand,'fish');
 assert.throws(()=>auth.authorizeBrand(reader,'aristo'),error=>error.code==='BRAND_DENIED');
 auth.setUpstreamCredential({context,userId:invite.userId,slot:'growth-read',bearer:'SYNTHETIC_FACTORY_KEY_ONLY'});
 assert.equal(auth.getUpstreamCredential({...reader,slot:'growth-read'}),'SYNTHETIC_FACTORY_KEY_ONLY');
 auth.setGrants({context,userId:invite.userId,permissions:{growth:{read:true,edit:false}}});
 auth.revokeUser({context,userId:invite.userId});assert.equal(auth.session(reader).authenticated,false);
 return auth.users({context}).map(user=>({email:user.email,state:user.state,permissions:user.permissions,brand:user.brand}));
}
test('actual Auth default SQLite and owned factory SQLite preserve the same real identity flow',async t=>{
 const dir=temporary(t),direct=Auth.createAuth(config(path.join(dir,'default.sqlite'))),lease=Factory.openIdentityStore({dbPath:path.join(dir,'leased.sqlite')}),owned=Auth.createAuth(config(path.join(dir,'leased.sqlite')),lease);
 t.after(()=>{direct.close();owned.close();});
 assert.deepEqual(await scenario(owned),await scenario(direct));owned.close();owned.close();assert.equal(lease.closeCount,1);assert.equal(lease.isClosed,true);
 assert.equal(fs.statSync(path.join(dir,'default.sqlite')).mode&0o777,0o600);assert.equal(fs.statSync(path.join(dir,'leased.sqlite')).mode&0o777,0o600);
});
test('forged and reused private leases refuse without closing the existing Auth owner',t=>{
 const dir=temporary(t),lease=Factory.openIdentityStore({dbPath:path.join(dir,'owned.sqlite')}),auth=Auth.createAuth(config(path.join(dir,'owned.sqlite')),lease);t.after(()=>auth.close());
 assert.throws(()=>Auth.createAuth(config(':memory:'),{...lease}),error=>error.code==='DASHBOARD_IDENTITY_FACTORY_LEASE_REFUSED');
 assert.throws(()=>Auth.createAuth(config(':memory:'),lease),error=>error.code==='DASHBOARD_IDENTITY_FACTORY_LEASE_REFUSED');
 assert.equal(lease.closeCount,0);assert.equal(auth.session({host:hosts.managerHost}).authenticated,false);auth.close();assert.equal(lease.closeCount,1);
});
test('real server startup refusal after Auth initialization closes its owned lease exactly once before listen',t=>{
 const dir=temporary(t),cfg=settings(path.join(dir,'refused.sqlite')),lease=Factory.openIdentityStore({dbPath:cfg.dbPath});
 assert.throws(()=>Server.initializeRuntime({...cfg,upstreamProfile:'invalid'},lease),error=>error.code==='RUNTIME_FACTORY_STARTUP_REFUSED');
 assert.equal(lease.isClosed,true);assert.equal(lease.closeCount,1);lease.close();assert.equal(lease.closeCount,1);
});
test('a fresh genuine SQLite lease cannot masquerade as another configured database path',t=>{
 const dir=temporary(t),actual=path.join(dir,'actual.sqlite'),other=path.join(dir,'must-not-be-touched.sqlite'),lease=Factory.openIdentityStore({dbPath:actual});
 assert.throws(()=>Auth.createAuth(config(other),lease),error=>error.code==='DASHBOARD_IDENTITY_FACTORY_PATH_REFUSED');
 assert.equal(lease.isClosed,true);assert.equal(lease.closeCount,1);assert.equal(fs.existsSync(other),false);
});
test('actual HTTP server constructor before listen and shared shutdown close the real Auth lease once',async t=>{
 const dir=temporary(t),cfg=settings(path.join(dir,'http.sqlite')),lease=Factory.openIdentityStore({dbPath:cfg.dbPath}),runtime=Server.initializeRuntime(cfg,lease);t.after(()=>runtime.close());
 assert.equal(runtime.server.listening,false);assert.equal(runtime.server.address(),null);
 const first=runtime.close(),second=runtime.close();assert.equal(first,second);await first;
 assert.equal(runtime.server.listening,false);assert.equal(lease.closeCount,1);assert.equal(lease.isClosed,true);
});
test('owned native listen synchronous refusal drains and closes its Auth lease once before binding',async t=>{
 const dir=temporary(t),cfg={...settings(path.join(dir,'listen-refused.sqlite')),port:-1},lease=Factory.openIdentityStore({dbPath:cfg.dbPath}),runtime=Server.initializeRuntime(cfg,lease);t.after(()=>runtime.close());
 assert.throws(()=>runtime.listen(),error=>error.code==='RUNTIME_FACTORY_LISTEN_REFUSED');
 const first=runtime.close(),second=runtime.close();assert.equal(first,second);await first;
 assert.equal(runtime.server.listening,false);assert.equal(runtime.server.address(),null);assert.equal(lease.closeCount,1);assert.equal(lease.isClosed,true);
 assert.throws(()=>runtime.listen(),error=>error.code==='RUNTIME_FACTORY_LISTEN_REFUSED');assert.equal(lease.closeCount,1);
});
test('copied bootstrap uses the same actual source constructor after its admission boundary',async t=>{
 const dir=temporary(t),dbPath=path.join(dir,'boot.sqlite');
 const env={DASHBOARD_MODE:'synthetic',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_DB_PATH:dbPath,DASHBOARD_MANAGER_HOST:hosts.managerHost,DASHBOARD_AREA_HOSTS:JSON.stringify(hosts.areaHosts),DASHBOARD_EMAIL_DOMAINS:JSON.stringify(['synthetic.invalid']),DASHBOARD_ADMIN_EMAIL:'master@synthetic.invalid',DASHBOARD_BOOTSTRAP_SHA256:sha(token),DASHBOARD_ENCRYPTION_KEY:Buffer.alloc(32,27).toString('hex')};
 const artifact={runtimeDir:RUNTIME,publicDir:RUNTIME};
 const runtime=Boot.initializeArtifactRuntime(artifact,env,{dbPath});t.after(()=>runtime.close());assert.equal(runtime.server.listening,false);assert.equal(runtime.auth.session({host:hosts.managerHost}).authenticated,false);await runtime.close();
});
test('explicit PG selection without an admitted config refuses before Auth, SQLite creation or listen',t=>{
 const dir=temporary(t),dbPath=path.join(dir,'must-not-exist.sqlite');
 const env={DASHBOARD_MODE:'synthetic',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_DB_PATH:dbPath,DASHBOARD_MANAGER_HOST:hosts.managerHost,DASHBOARD_AREA_HOSTS:JSON.stringify(hosts.areaHosts),DASHBOARD_EMAIL_DOMAINS:JSON.stringify(['synthetic.invalid']),DASHBOARD_ADMIN_EMAIL:'master@synthetic.invalid',DASHBOARD_BOOTSTRAP_SHA256:sha(token),DASHBOARD_ENCRYPTION_KEY:Buffer.alloc(32,27).toString('hex')};
 assert.throws(()=>Boot.initializeArtifactRuntime({runtimeDir:RUNTIME,publicDir:RUNTIME},env,{dialect:'postgres-pg17-v1',pgOptions:{connection:{},admission:{}}}),error=>error.code==='RUNTIME_FACTORY_STARTUP_REFUSED');
 assert.equal(fs.existsSync(dbPath),false);assert.deepEqual(fs.readdirSync(dir),[]);
});
