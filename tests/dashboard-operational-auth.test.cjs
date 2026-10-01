'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createAuth,AuthError,CREDENTIAL_SLOTS,totpAt}=require('../services/dashboard-operational/auth.cjs');

const hosts={manager:'dashboard.shrigma.test',growth:'crm.shrigma.test',organico:'organico.shrigma.test',influs:'influs.shrigma.test'};
const bootstrap='synthetic-bootstrap-token-for-tests';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const cookieHeader=value=>value.split(';')[0];
const origin=host=>'https://'+host;
const error=(code,status)=>e=>e instanceof AuthError&&e.code===code&&e.status===status;

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-auth-test-')),dbPath=path.join(dir,'auth.sqlite');
 let clock=Date.UTC(2026,8,30,12,0,0);
 const config={dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},
  allowedEmailDomains:['shrigma.test'],bootstrapAdminEmail:'owner@shrigma.test',bootstrapTokenSha256:hash(bootstrap),encryptionKey:Buffer.alloc(32,7),now:()=>clock};
 const auth=createAuth(config);
 return {auth,config,dbPath,get clock(){return clock;},advance(ms){clock+=ms;},close(){auth.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
async function activateAdmin(f){
 const ctx={email:'owner@shrigma.test',token:bootstrap,host:hosts.manager,origin:origin(hosts.manager)};
 const enrollment=f.auth.beginBootstrap(ctx);
 assert.match(enrollment.totpSecret,/^[A-Z2-7]+$/);
 await f.auth.completeBootstrap({...ctx,password:'test-owner-passphrase-2026',totp:totpAt(enrollment.totpSecret,f.clock)});
 const login=await f.auth.login({email:ctx.email,password:'test-owner-passphrase-2026',totp:totpAt(enrollment.totpSecret,f.clock),host:hosts.manager,origin:ctx.origin,ip:'192.0.2.10'});
 const context={cookieHeader:cookieHeader(login.cookie),host:hosts.manager,origin:ctx.origin,method:'POST',csrf:login.csrf};
 return {login,context,secret:enrollment.totpSecret};
}

test('bootstrap requires the configured token and TOTP, never resets an active admin',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.auth.beginBootstrap({email:'owner@shrigma.test',token:'wrong',host:hosts.manager,origin:origin(hosts.manager)}),error('BOOTSTRAP_DENIED',403));
  const enrollment=f.auth.beginBootstrap({email:'owner@shrigma.test',token:bootstrap,host:hosts.manager,origin:origin(hosts.manager)});
  await assert.rejects(f.auth.completeBootstrap({email:'owner@shrigma.test',token:bootstrap,password:'test-owner-passphrase-2026',totp:'000000',host:hosts.manager,origin:origin(hosts.manager)}),error('TOTP_INVALID',401));
  const {login,context,secret}=await activateAdmin(f);
  assert.match(login.cookie,/^__Host-shrigma_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800$/);
  assert.match(login.uiKey,/^ui-[a-f0-9]{32}$/);
  const session=f.auth.session({cookieHeader:cookieHeader(login.cookie),host:hosts.manager});
  assert.equal(session.authenticated,true);assert.equal(session.user.role,'superadmin');assert.deepEqual(session.user.areas,['growth','organico','influs']);assert.equal(session.uiKey,login.uiKey);
  assert.equal(session.user.permissions.growth.edit,false);assert.equal(session.user.permissions.influs.edit,false);
  assert.equal(Object.hasOwn(session.user.permissions,'cx'),false);
  await assert.rejects(f.auth.login({email:'owner@shrigma.test',password:'test-owner-passphrase-2026',totp:totpAt(secret,f.clock),host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.12'}),error('AUTH_INVALID',401));
  f.auth.setGrants({context,userId:login.user.id,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}});
  assert.equal(f.auth.session({cookieHeader:cookieHeader(login.cookie),host:hosts.manager}).authenticated,false);
  f.advance(30000);
  const updated=await f.auth.login({email:'owner@shrigma.test',password:'test-owner-passphrase-2026',totp:totpAt(secret,f.clock),host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.10'});
  assert.equal(updated.user.permissions.growth.edit,true);assert.equal(updated.user.permissions.influs.edit,false);
  assert.throws(()=>f.auth.beginBootstrap({email:'owner@shrigma.test',token:bootstrap,host:hosts.manager,origin:origin(hosts.manager)}),error('BOOTSTRAP_DENIED',403));
  f.auth.close();const reopened=createAuth(f.config);
  try{assert.equal(reopened.session({cookieHeader:cookieHeader(updated.cookie),host:hosts.manager}).authenticated,true);assert.throws(()=>reopened.beginBootstrap({email:'owner@shrigma.test',token:bootstrap,host:hosts.manager,origin:origin(hosts.manager)}),error('BOOTSTRAP_DENIED',403));}finally{reopened.close();}
  assert.throws(()=>createAuth({...f.config,bootstrapAdminEmail:'different@shrigma.test'}),error('ADMIN_CONFIG_DRIFT',500));
  assert.throws(()=>createAuth({...f.config,encryptionKey:Buffer.alloc(32,8)}),error('CREDENTIAL_UNAVAILABLE',503));
  const bytes=fs.readFileSync(f.dbPath);assert.equal(bytes.includes(Buffer.from(bootstrap)),false);assert.equal(bytes.includes(Buffer.from('test-owner-passphrase-2026')),false);assert.equal(bytes.includes(Buffer.from(enrollment.totpSecret)),false);
 }finally{try{f.close();}catch{}}
});

test('invite, area grants, CSRF, encrypted per-slot bearers and revocation',async()=>{
 const f=fixture();try{
  const admin=await activateAdmin(f),context=admin.context;
  assert.throws(()=>f.auth.createInvite({context:{...context,origin:'https://other.test'},email:'gestor@shrigma.test',areas:['growth']}),error('ORIGIN_DENIED',403));
  assert.throws(()=>f.auth.createInvite({context:{...context,csrf:'bad'},email:'gestor@shrigma.test',areas:['growth']}),error('CSRF_DENIED',403));
  assert.throws(()=>f.auth.createInvite({context,email:'gestor@other.test',areas:['growth']}),error('EMAIL_DOMAIN_DENIED',400));
  assert.throws(()=>f.auth.createInvite({context,email:'gestor@shrigma.test',areas:['cx']}),error('GRANTS_INVALID',400));
  assert.throws(()=>f.auth.createInvite({context,email:'gestor@shrigma.test',areas:['growth','organico']}),error('GRANTS_INVALID',400));
  assert.throws(()=>f.auth.createInvite({context,email:'gestor@shrigma.test',areas:['organico'],permissions:{organico:{read:true,edit:true}}}),error('GRANTS_INVALID',400));
  const invitation=f.auth.createInvite({context,email:'gestor@shrigma.test',areas:['growth'],permissions:{growth:{read:true,edit:true}}});
  assert.equal(invitation.host,hosts.growth);assert.equal(f.auth.users({context}).length,2);
  await assert.rejects(f.auth.acceptInvite({token:invitation.token,password:'short',host:hosts.growth,origin:origin(hosts.growth)}),error('PASSWORD_INVALID',400));
  await f.auth.acceptInvite({token:invitation.token,password:'gestor-synthetic-password',host:hosts.growth,origin:origin(hosts.growth)});
  await assert.rejects(f.auth.acceptInvite({token:invitation.token,password:'gestor-synthetic-password',host:hosts.growth,origin:origin(hosts.growth)}),error('INVITE_DENIED',403));
  const manager=await f.auth.login({email:'gestor@shrigma.test',password:'gestor-synthetic-password',host:hosts.growth,origin:origin(hosts.growth),ip:'192.0.2.11'});
  assert.deepEqual(manager.user.areas,['growth']);assert.equal(manager.user.permissions.growth.edit,true);
  assert.notEqual(manager.uiKey,admin.login.uiKey);
  const managerCtx={cookieHeader:cookieHeader(manager.cookie),host:hosts.growth,origin:origin(hosts.growth),method:'POST',csrf:manager.csrf,area:'growth',edit:true};
  assert.equal(f.auth.authorize(managerCtx).email,'gestor@shrigma.test');
  assert.throws(()=>f.auth.authorize({...managerCtx,area:'organico'}),error('AREA_DENIED',403));
  assert.throws(()=>f.auth.authorize({...managerCtx,csrf:'bad'}),error('CSRF_DENIED',403));
  assert.equal(f.auth.session({cookieHeader:cookieHeader(manager.cookie),host:hosts.organico}).authenticated,false);
  assert.throws(()=>f.auth.getUpstreamCredential({...managerCtx,slot:'growth-read'}),error('CREDENTIAL_DENIED',403));
  assert.equal(f.auth.getUpstreamCredential({...managerCtx,slot:'growth-campaign'}),null);
  const bearer='individual-test-upstream-bearer-111';
  f.auth.setUpstreamCredential({context,userId:invitation.userId,slot:'growth-campaign',bearer});
  assert.equal(f.auth.getUpstreamCredential({...managerCtx,slot:'growth-campaign'}),bearer);
  assert.equal(fs.readFileSync(f.dbPath).includes(Buffer.from(bearer)),false);
  assert.throws(()=>f.auth.setGrants({context,userId:invitation.userId,permissions:{growth:{read:true,edit:true},influs:{read:true,edit:false}}}),error('GRANTS_INVALID',400));
  assert.equal(f.auth.session({cookieHeader:cookieHeader(manager.cookie),host:hosts.growth}).authenticated,true);
  const tamper=new DatabaseSync(f.dbPath);
  try{tamper.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,0)').run(invitation.userId,'organico');}finally{tamper.close();}
  assert.equal(f.auth.session({cookieHeader:cookieHeader(manager.cookie),host:hosts.growth}).authenticated,false);
  await assert.rejects(f.auth.login({email:'gestor@shrigma.test',password:'gestor-synthetic-password',host:hosts.growth,origin:origin(hosts.growth),ip:'192.0.2.11'}),error('AUTH_INVALID',401));
  const restore=new DatabaseSync(f.dbPath);
  try{restore.prepare('DELETE FROM grants WHERE user_id=? AND area=?').run(invitation.userId,'organico');}finally{restore.close();}
  assert.equal(f.auth.session({cookieHeader:cookieHeader(manager.cookie),host:hosts.growth}).authenticated,true);
  const second=f.auth.createInvite({context,email:'outro@shrigma.test',areas:['growth'],permissions:{growth:{read:true,edit:true}}});
  assert.throws(()=>f.auth.setUpstreamCredential({context,userId:second.userId,slot:'growth-campaign',bearer}),error('CREDENTIAL_REUSED',409));
  // Reusing a bearer in another slot for the same person is permitted; a
  // second person cannot receive that bearer in any slot.
  f.auth.setUpstreamCredential({context,userId:invitation.userId,slot:'growth-audience',bearer});
  assert.throws(()=>f.auth.setUpstreamCredential({context,userId:second.userId,slot:'growth-audience',bearer}),error('CREDENTIAL_REUSED',409));
  assert.throws(()=>f.auth.setUpstreamCredential({context,userId:invitation.userId,slot:'cx-read',bearer}),error('CREDENTIAL_INVALID',400));
  f.auth.setRequestedAccess({context,userId:invitation.userId,requestedAccess:'edit'});
  assert.equal(f.auth.users({context}).find(user=>user.id===invitation.userId).requestedAccess,'edit');
  f.auth.setRequestedAccess({context,userId:invitation.userId,requestedAccess:'read'});
  assert.equal(f.auth.users({context}).find(user=>user.id===invitation.userId).permissions.growth.edit,false);
  assert.equal(f.auth.session({cookieHeader:cookieHeader(manager.cookie),host:hosts.growth}).authenticated,false);
  const downgraded=new DatabaseSync(f.dbPath);
  try{assert.equal(downgraded.prepare('SELECT COUNT(*) AS n FROM upstream_credentials WHERE user_id=?').get(invitation.userId).n,0);}finally{downgraded.close();}
  f.auth.setGrants({context,userId:invitation.userId,permissions:{growth:{read:true,edit:false}}});
  assert.equal(f.auth.session({cookieHeader:cookieHeader(manager.cookie),host:hosts.growth}).authenticated,false);
  const viewOnly=await f.auth.login({email:'gestor@shrigma.test',password:'gestor-synthetic-password',host:hosts.growth,origin:origin(hosts.growth),ip:'192.0.2.11'});
  assert.throws(()=>f.auth.authorize({cookieHeader:cookieHeader(viewOnly.cookie),host:hosts.growth,method:'POST',origin:origin(hosts.growth),csrf:viewOnly.csrf,area:'growth',edit:true}),error('GRANT_DENIED',403));
  f.auth.revokeUser({context,userId:invitation.userId});
  assert.equal(f.auth.session({cookieHeader:cookieHeader(viewOnly.cookie),host:hosts.growth}).authenticated,false);
  await assert.rejects(f.auth.login({email:'gestor@shrigma.test',password:'gestor-synthetic-password',host:hosts.growth,origin:origin(hosts.growth),ip:'192.0.2.11'}),error('AUTH_INVALID',401));
 }finally{f.close();}
});

test('legacy GET edits require exact Origin, CSRF and an edit grant',async()=>{
 const f=fixture();try{
  const admin=await activateAdmin(f);
  const base={cookieHeader:cookieHeader(admin.login.cookie),host:hosts.manager,method:'GET',area:'growth'};
  assert.equal(f.auth.authorize(base).email,'owner@shrigma.test');
  const edit={...base,edit:true};
  assert.throws(()=>f.auth.authorize(edit),error('ORIGIN_DENIED',403));
  assert.throws(()=>f.auth.authorize({...edit,origin:'https://other.shrigma.test',csrf:admin.login.csrf}),error('ORIGIN_DENIED',403));
  assert.throws(()=>f.auth.authorize({...edit,origin:origin(hosts.manager)}),error('CSRF_DENIED',403));
  assert.throws(()=>f.auth.authorize({...edit,origin:origin(hosts.manager),csrf:admin.login.csrf}),error('GRANT_DENIED',403));

  f.auth.setGrants({context:admin.context,userId:admin.login.user.id,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}});
  f.advance(30000);
  const granted=await f.auth.login({email:'owner@shrigma.test',password:'test-owner-passphrase-2026',totp:totpAt(admin.secret,f.clock),host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.10'});
  const permitted={...edit,cookieHeader:cookieHeader(granted.cookie)};
  assert.throws(()=>f.auth.authorize(permitted),error('ORIGIN_DENIED',403));
  assert.throws(()=>f.auth.authorize({...permitted,origin:origin(hosts.manager)}),error('CSRF_DENIED',403));
  assert.equal(f.auth.authorize({...permitted,origin:origin(hosts.manager),csrf:granted.csrf}).email,'owner@shrigma.test');
 }finally{f.close();}
});

test('login rate limits, host binding, and absolute session expiry',async()=>{
 const f=fixture();try{
  const admin=await activateAdmin(f);
  const invite=f.auth.createInvite({context:admin.context,email:'colega@shrigma.test',areas:['growth']});
  await f.auth.acceptInvite({token:invite.token,password:'colleague-test-password',host:hosts.growth,origin:origin(hosts.growth)});
  await assert.rejects(f.auth.login({email:'owner@shrigma.test',password:'test-owner-passphrase-2026',totp:'000000',host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.55'}),error('AUTH_INVALID',401));
  for(let i=0;i<4;i++)await assert.rejects(f.auth.login({email:'owner@shrigma.test',password:'wrong-passphrase-value',host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.55'}),error('AUTH_INVALID',401));
  await assert.rejects(f.auth.login({email:'owner@shrigma.test',password:'test-owner-passphrase-2026',totp:'000000',host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.55'}),error('AUTH_RATE_LIMIT',429));
  const colleague=await f.auth.login({email:'colega@shrigma.test',password:'colleague-test-password',host:hosts.growth,origin:origin(hosts.growth),ip:'192.0.2.55'});
  assert.equal(colleague.user.email,'colega@shrigma.test');
  assert.throws(()=>f.auth.authorize({cookieHeader:cookieHeader(admin.login.cookie),host:hosts.manager,method:'POST',origin:'https://crm.shrigma.test',csrf:admin.login.csrf,admin:true}),error('ORIGIN_DENIED',403));
  f.advance(31*60*1000);assert.equal(f.auth.session({cookieHeader:cookieHeader(admin.login.cookie),host:hosts.manager}).authenticated,false);
  assert.throws(()=>f.auth.authorize({cookieHeader:cookieHeader(admin.login.cookie),host:hosts.manager,method:'GET',admin:true}),error('SESSION_REQUIRED',401));
 }finally{f.close();}
});

test('credential slots are fixed and scoped to their own area',()=>{
 assert.deepEqual(Object.keys(CREDENTIAL_SLOTS).filter(x=>x.startsWith('cx')),[]);
 for(const [slot,rule] of Object.entries(CREDENTIAL_SLOTS)){assert.match(slot,/^(growth|organico|influs|tts)-/);assert.ok(['growth','organico','influs'].includes(rule.area));}
});

test('password hashing has a bounded queue and recovers after concurrent attempts',async()=>{
 const f=fixture();try{
  const admin=await activateAdmin(f);
  const attempts=Array.from({length:12},(_,i)=>f.auth.login({email:`unknown${i}@shrigma.test`,password:'synthetic-wrong-password',host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.50'}));
  const results=await Promise.allSettled(attempts);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,0);
  assert.equal(results.filter(r=>r.reason?.code==='AUTH_BUSY').length,3);
  assert.equal(results.filter(r=>r.reason?.code==='AUTH_INVALID').length,9);
  f.advance(30000);
  const retry=await f.auth.login({email:'owner@shrigma.test',password:'test-owner-passphrase-2026',totp:totpAt(admin.secret,f.clock),host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.50'});
  assert.equal(retry.user.role,'superadmin');
 }finally{f.close();}
});

test('parallel guesses against one account cannot outrun the rate limit',async()=>{
 const f=fixture();try{
  const attempts=Array.from({length:7},()=>f.auth.login({email:'owner@shrigma.test',password:'synthetic-wrong-password',host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.80'}));
  const results=await Promise.allSettled(attempts);
  assert.equal(results.filter(r=>r.reason?.code==='AUTH_INVALID').length,5);
  assert.equal(results.filter(r=>r.reason?.code==='AUTH_RATE_LIMIT').length,2);
 }finally{f.close();}
});

test('login pruning bounds stale buckets and the global ceiling stops new email guesses before scrypt',async()=>{
 const f=fixture();try{
  const tamper=new DatabaseSync(f.dbPath);
  try{
   tamper.prepare('INSERT INTO login_limits(bucket,attempts,first_at,locked_until) VALUES(?,?,?,?)').run('stale-random-email',1,f.clock-30*60*1000,0);
   tamper.prepare('INSERT INTO login_limits(bucket,attempts,first_at,locked_until) VALUES(?,?,?,?)').run(hash('login-global-v1'),119,f.clock,0);
  }finally{tamper.close();}
  const attempt={email:'unknown@shrigma.test',password:'synthetic-wrong-password',host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.80'};
  await assert.rejects(f.auth.login(attempt),error('AUTH_INVALID',401));
  const check=new DatabaseSync(f.dbPath);
  try{assert.equal(check.prepare('SELECT 1 FROM login_limits WHERE bucket=?').get('stale-random-email'),undefined);}
  finally{check.close();}
  await assert.rejects(f.auth.login({...attempt,email:'other@shrigma.test'}),error('AUTH_RATE_LIMIT',429));
  const count=new DatabaseSync(f.dbPath);
  try{assert.equal(count.prepare('SELECT COUNT(*) AS n FROM login_limits').get().n,3);}finally{count.close();}
  f.advance(15*60*1000+1);
  await assert.rejects(f.auth.login({...attempt,email:'other@shrigma.test'}),error('AUTH_INVALID',401));
 }finally{f.close();}
});

test('invalid password types cannot create unbounded per-email limit records',async()=>{
 const f=fixture();try{
  const host=hosts.manager,originUrl=origin(host);
  let limited=0;
  for(let i=0;i<130;i++){
   try{await f.auth.login({email:`random${i}@shrigma.test`,password:null,host,origin:originUrl,ip:'192.0.2.81'});assert.fail('login unexpectedly accepted');}
   catch(e){assert.ok(e instanceof AuthError);if(e.code==='AUTH_RATE_LIMIT')limited++;else assert.equal(e.code,'AUTH_INVALID');}
  }
  assert.equal(limited,10);
  const inspect=new DatabaseSync(f.dbPath);
  try{assert.ok(inspect.prepare('SELECT COUNT(*) AS n FROM login_limits').get().n<=241);}finally{inspect.close();}
 }finally{f.close();}
});

test('successful login and new invitation purge expired sessions and spent invite tokens',async()=>{
 const f=fixture();try{
  const admin=await activateAdmin(f);
  const first=f.auth.createInvite({context:admin.context,email:'first@shrigma.test',areas:['growth']});
  await f.auth.acceptInvite({token:first.token,password:'first-manager-password',host:hosts.growth,origin:origin(hosts.growth)});
  f.advance(31*60*1000);
  const renewed=await f.auth.login({email:'owner@shrigma.test',password:'test-owner-passphrase-2026',totp:totpAt(admin.secret,f.clock),host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.10'});
  const context={cookieHeader:cookieHeader(renewed.cookie),host:hosts.manager,origin:origin(hosts.manager),method:'POST',csrf:renewed.csrf};
  f.auth.createInvite({context,email:'second@shrigma.test',areas:['influs']});
  const inspect=new DatabaseSync(f.dbPath);
  try{
   assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);
   assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM invites').get().n,1);
  }finally{inspect.close();}
 }finally{f.close();}
});
