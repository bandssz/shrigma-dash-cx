'use strict';
// Real password auth and SQLite. No external network, backend or real identity.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const ROOT=path.resolve(process.env.BRAND_IDENTITY_SOURCE_ROOT||path.join(__dirname,'..'));
const {createAuth,AuthError,AREA_BRANDS}=require(path.join(ROOT,'services/dashboard-operational/auth.cjs'));
const hosts={manager:'gerencial.shrigma.test',growth:'crm.shrigma.test',organico:'organico.shrigma.test',influs:'influs.shrigma.test'};
const origin=host=>'https://'+host,sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const password='Synthetic corporation password 2026!';
const denied=(code,status)=>e=>e instanceof AuthError&&e.code===code&&e.status===status;
async function fixture(t,{source=createAuth}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brand-identity-')),dbPath=path.join(dir,'identity.sqlite'),encryptionKey=crypto.randomBytes(32);
 const config={dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'owner@synthetic.invalid',bootstrapTokenSha256:sha('synthetic-bootstrap'),encryptionKey};
 let auth=source(config);await auth.completeBootstrap({email:config.bootstrapAdminEmail,token:'synthetic-bootstrap',password,host:hosts.manager,origin:origin(hosts.manager)});
 const l=await auth.login({email:config.bootstrapAdminEmail,password,host:hosts.manager,origin:origin(hosts.manager)}),ctx={host:hosts.manager,origin:origin(hosts.manager),method:'POST',cookieHeader:l.cookie.split(';')[0],csrf:l.csrf};
 const db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON');
 const invite=(email='fish@synthetic.invalid',brand='fish',area='growth',requestedAccess='read',permissions)=>auth.createInvite({context:ctx,email,areas:[area],brand,requestedAccess,...(permissions?{permissions}:{})});
 const accept=i=>auth.acceptInvite({token:i.token,password,host:i.host,origin:origin(i.host)});
 const login=async(email='fish@synthetic.invalid',area='growth')=>{const s=await auth.login({email,password,host:hosts[area],origin:origin(hosts[area])});return {host:hosts[area],origin:origin(hosts[area]),method:'GET',cookieHeader:s.cookie.split(';')[0],csrf:s.csrf};};
 t.after(()=>{auth.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {config,db,ctx,l,invite,accept,login,get auth(){return auth;},restart(newSource=createAuth,beforeOpen){auth.close();if(beforeOpen)beforeOpen(db);auth=newSource(config);}};
}

test('master keeps all areas and both supported brands; manager requires explicit canonical brand',async t=>{
 const f=await fixture(t);
 assert.deepEqual(f.l.user.brands,['fish','aristo']);assert.equal(f.l.user.brand,null);assert.equal(f.l.user.brandAccess,'all');
 for(const area of ['growth','organico','influs'])for(const brand of ['fish','aristo'])assert.equal(f.auth.authorizeBrand({...f.ctx,method:'GET',area},brand).role,'superadmin');
 for(const brand of [undefined,null,'todas','olivas','Fish',''])assert.throws(()=>f.auth.createInvite({context:f.ctx,email:'bad@synthetic.invalid',areas:['growth'],brand}),denied('BRAND_INVALID',400));
 assert.deepEqual(AREA_BRANDS,{growth:['fish','aristo'],organico:['fish','aristo'],influs:['fish','aristo']});
});

test('each manager sees its own brand in every area and direct authorization denies other brands',async t=>{
 const f=await fixture(t);
 for(const area of ['growth','organico','influs']){
  const email=area+'@synthetic.invalid',i=f.invite(email,'fish',area,'edit');await f.accept(i);const ctx=await f.login(email,area);
  const s=f.auth.session(ctx);assert.equal(s.authenticated,true);assert.equal(s.user.brand,'fish');assert.deepEqual(s.user.brands,['fish']);assert.equal(s.user.brandAccess,'single');assert.deepEqual(s.user.areas,[area]);assert.equal(s.user.permissions[area].edit,false);
  assert.equal(f.auth.authorizeBrand({...ctx,area},'fish').id,i.userId);
  assert.throws(()=>f.auth.authorizeBrand({...ctx,area},'aristo'),denied('BRAND_DENIED',403));
  assert.throws(()=>f.auth.authorize({...ctx,area,brand:'aristo'}),denied('BRAND_DENIED',403));
  assert.throws(()=>f.auth.authorizeBrand({...ctx,area},undefined),denied('BRAND_REQUIRED',400));
  const user=f.auth.users({context:f.ctx}).find(u=>u.id===i.userId);assert.equal(user.requestedAccess,'edit');assert.equal(user.permissions[area].edit,false);assert.equal(user.brand,'fish');
 }
});

test('brand/area changes cannot reuse an existing identity or its credentials and pending receipts',async t=>{
 const f=await fixture(t),i=f.invite();await f.accept(i);const ctx=await f.login();
 assert.throws(()=>f.auth.setGrants({context:f.ctx,userId:i.userId,permissions:{influs:{read:true,edit:false}}}),denied('AREA_CHANGE_REQUIRES_REINVITE',409));
 f.auth.revokeUser({context:f.ctx,userId:i.userId});
 assert.throws(()=>f.invite('fish@synthetic.invalid','aristo'),denied('BRAND_CHANGE_REQUIRES_NEW_IDENTITY',409));
 assert.throws(()=>f.invite('fish@synthetic.invalid','fish','influs'),denied('BRAND_CHANGE_REQUIRES_NEW_IDENTITY',409));
 const same=f.invite();assert.equal(same.userId,i.userId);await f.accept(same);const renewed=await f.login();assert.equal(f.auth.session(renewed).user.brand,'fish');assert.equal(f.auth.session(ctx).authenticated,false);
});

test('tampering a brand grant or transferring another subject ciphertext is denied before credential use',async t=>{
 const f=await fixture(t),a=f.invite(),b=f.invite('aristo@synthetic.invalid','aristo');await f.accept(a);await f.accept(b);
 const ac=await f.login(),bc=await f.login('aristo@synthetic.invalid');
 f.auth.setUpstreamCredential({context:f.ctx,userId:a.userId,slot:'growth-campaign-read',bearer:'synthetic-a-credential'});
 f.auth.setUpstreamCredential({context:f.ctx,userId:b.userId,slot:'growth-campaign-read',bearer:'synthetic-b-credential'});
 const args={...ac,area:'growth',edit:false,slot:'growth-campaign-read',brand:'fish'};
 assert.equal(f.auth.getUpstreamCredential(args),'synthetic-a-credential');
 assert.throws(()=>f.auth.getUpstreamCredential({...args,brand:'aristo'}),denied('BRAND_DENIED',403));
 assert.throws(()=>f.auth.getUpstreamCredential({...args,brand:undefined}),denied('BRAND_REQUIRED',400));
 const alien=f.db.prepare("SELECT encrypted_key,key_digest FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign-read'").get(b.userId);
 f.db.prepare("UPDATE upstream_credentials SET encrypted_key=?,key_digest=? WHERE user_id=? AND slot='growth-campaign-read'").run(alien.encrypted_key,alien.key_digest,a.userId);
 assert.throws(()=>f.auth.getUpstreamCredential(args),denied('CREDENTIAL_UNAVAILABLE',503));
 assert.equal(f.auth.getUpstreamCredential({...bc,area:'growth',edit:false,slot:'growth-campaign-read',brand:'aristo'}),'synthetic-b-credential');
 const original=f.db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(a.userId);
 f.db.prepare("UPDATE user_brand_grants_v1 SET brand='aristo' WHERE user_id=?").run(a.userId);
 assert.equal(f.auth.session(ac).authenticated,false);
 await assert.rejects(f.login(),denied('BRAND_REPROVISION_REQUIRED',403));
 assert.equal(f.auth.users({context:f.ctx}).find(u=>u.id===a.userId).brandAccess,'reprovision_required');
 f.db.prepare('UPDATE user_brand_grants_v1 SET brand=? WHERE user_id=?').run(original.brand,a.userId);
 assert.equal(f.auth.session(ac).authenticated,true);
});

test('upgrade preserves legacy users/session/credentials exactly without inferring a broad or default brand',async t=>{
 const f=await fixture(t);
 const i=f.auth.createInvite({context:f.ctx,email:'legacy@synthetic.invalid',areas:['growth'],brand:'fish',requestedAccess:'edit'});await f.accept(i);
 const ctx=await f.login('legacy@synthetic.invalid');f.auth.setUpstreamCredential({context:f.ctx,userId:i.userId,slot:'growth-campaign-read',bearer:'synthetic-legacy-credential'});
 const tables=['users','grants','sessions','invites','access_requests','upstream_credentials'];
 const before=Object.fromEntries(tables.map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
 // Restore the schema actually present before the additive upgrade. No
 // identity, session, invitation, grant or credential record is removed.
 f.restart(createAuth,db=>db.exec('DROP TABLE IF EXISTS upstream_brand_bindings_v1; DROP TABLE IF EXISTS user_brand_lifecycles_v1; DROP TABLE IF EXISTS user_brand_grants_v1;'));
 for(const table of tables)assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),before[table]);
 assert.equal(f.auth.session(ctx).authenticated,false);
 await assert.rejects(f.login('legacy@synthetic.invalid'),denied('BRAND_REPROVISION_REQUIRED',403));
 const user=f.auth.users({context:f.ctx}).find(u=>u.id===i.userId);assert.equal(user.brandAccess,'reprovision_required');assert.deepEqual(user.brands,[]);assert.equal(user.brand,null);
 assert.equal(f.auth.session(f.ctx).authenticated,true);assert.equal(f.auth.session(f.ctx).user.brandAccess,'all');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM user_brand_grants_v1').get().n,0);
 f.auth.revokeUser({context:f.ctx,userId:i.userId});const fresh=f.invite('legacy@synthetic.invalid','aristo');await f.accept(fresh);const newCtx=await f.login('legacy@synthetic.invalid');assert.equal(f.auth.session(newCtx).user.brand,'aristo');
});
