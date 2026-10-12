'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs');
const PASSWORD='synthetic-account-password-2026',NEW_PASSWORD='synthetic-changed-password-2026';
const HOST='gerencial.synthetic.invalid',ORIGIN='https://'+HOST,TOKEN='synthetic-bootstrap-token';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function context(login){return {host:HOST,origin:ORIGIN,method:'POST',csrf:login.csrf,cookieHeader:login.cookie.split(';')[0]};}
async function fixture({legacy=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-simple-login-')),dbPath=path.join(directory,'dashboard.sqlite');
 let time=Date.parse('2026-10-12T18:00:00Z');
 const options={dbPath,managerHost:HOST,areaHosts:{growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'administrador@synthetic.invalid',bootstrapTokenSha256:sha(TOKEN),encryptionKey:Buffer.alloc(32,7),now:()=>time,...(!legacy?{simpleReadMode:true}:{})};
 let auth=createAuth(options);
 await auth.completeBootstrap({email:options.bootstrapAdminEmail,token:TOKEN,password:PASSWORD,host:HOST,origin:ORIGIN});
 if(legacy){auth.close();auth=createAuth({...options,simpleReadMode:true});}
 const login=await auth.login({email:options.bootstrapAdminEmail,password:PASSWORD,host:HOST,origin:ORIGIN,ip:'synthetic'});
 return {get auth(){return auth;},dbPath,admin:context(login),adminLogin:login,setTime:t=>{time=t;},reopen(simpleReadMode){auth.close();auth=createAuth({...options,simpleReadMode});},close(){auth.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
test('existing Master hash, ID and historical tables survive activation of simple access',async()=>{
 const f=await fixture({legacy:true});
 try{
  const db=new DatabaseSync(f.dbPath);const row=db.prepare("SELECT id,password_hash FROM users WHERE role='superadmin'").get();
  assert.match(row.password_hash,/^scrypt\$/);assert.equal(row.id,f.adminLogin.user.id);
  assert(db.prepare("SELECT 1 FROM sqlite_master WHERE name='upstream_credentials'").get());
  assert.equal(f.auth.session(f.admin).authenticated,true);db.close();
 }finally{f.close();}
});
test('Master password change remains compatible with the previous login implementation',async()=>{
 const f=await fixture({legacy:true});
 try{
  await f.auth.simpleAccounts.changePassword({context:f.admin,currentPassword:PASSWORD,password:NEW_PASSWORD});
  const db=new DatabaseSync(f.dbPath);assert.match(db.prepare("SELECT password_hash FROM users WHERE role='superadmin'").get().password_hash,/^scrypt\$/);db.close();
  f.reopen(false);
  const login=await f.auth.login({email:f.adminLogin.user.email,password:NEW_PASSWORD,host:HOST,origin:ORIGIN,ip:'synthetic'});
  assert.equal(login.user.id,f.adminLogin.user.id);
 }finally{f.close();}
});
test('a password reset while an old-password login is verifying cannot create a session',async()=>{
 const f=await fixture(),b=(await import(require('node:url').pathToFileURL(runtime+'/bcrypt.mjs').href)).default,original=b.compare;
 let release,entered;const paused=new Promise(r=>{entered=r;}),resume=new Promise(r=>{release=r;});
 try{
  const created=await f.auth.simpleAccounts.create({context:f.admin,email:'race@synthetic.invalid',password:PASSWORD,jobTitle:'gestor de CRM',fronts:['growth'],brands:['fish']});
  let once=true;b.compare=async(...args)=>{const result=await original(...args);if(once&&args[0]===PASSWORD){once=false;entered();await resume;}return result;};
  const pending=f.auth.login({email:created.user.email,password:PASSWORD,host:HOST,origin:ORIGIN,ip:'synthetic'});
  await paused;await f.auth.simpleAccounts.resetPassword({context:f.admin,userId:created.user.id,password:NEW_PASSWORD});release();
  await assert.rejects(pending,e=>e.code==='AUTH_INVALID');
  const db=new DatabaseSync(f.dbPath);assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(created.user.id).n,0);db.close();
 }finally{release?.();b.compare=original;f.close();}
});
test('one person can read selected fronts and brands at the central portal without an individual upstream credential',async()=>{
 const f=await fixture();
 try{
  const created=await f.auth.simpleAccounts.create({context:f.admin,email:'gestor@synthetic.invalid',password:PASSWORD,jobTitle:'gestor de CRM',fronts:['growth','organico','afiliados'],brands:['fish','aristo']});
  const login=await f.auth.login({email:created.user.email,password:PASSWORD,host:HOST,origin:ORIGIN,ip:'synthetic'}),ctx=context(login);
  assert.match(login.cookie,/Secure; HttpOnly; SameSite=Strict; Max-Age=604800/);
  assert.deepEqual(login.user.productFronts,['growth','organico','afiliados']);assert.equal(login.user.jobTitle,'gestor de CRM');
  assert.equal(f.auth.authorizeBrand({...ctx,method:'GET',area:'growth',productFront:'growth'},'fish').id,created.user.id);
  assert.throws(()=>f.auth.authorizeBrand({...ctx,method:'GET',area:'growth'},'olivas'),e=>e.code==='BRAND_DENIED');
  assert.throws(()=>f.auth.authorize({...ctx,method:'GET',area:'influs',productFront:'influs'}),e=>e.code==='PRODUCT_DENIED');
  assert.throws(()=>f.auth.authorize({...ctx,area:'growth',edit:true}),e=>e.code==='GRANT_DENIED');
  assert.throws(()=>f.auth.simpleAccounts.list({context:ctx}),e=>e.code==='ADMIN_REQUIRED');
  const db=new DatabaseSync(f.dbPath);assert.equal(db.prepare('SELECT count(*) AS n FROM upstream_credentials WHERE user_id=?').get(created.user.id).n,0);
  assert.match(db.prepare('SELECT password_hash FROM users WHERE id=?').get(created.user.id).password_hash,/^\$2b\$12\$/);db.close();
  f.setTime(Date.parse('2026-10-15T18:00:00Z'));assert.equal(f.auth.session(ctx).authenticated,true);
  f.setTime(Date.parse('2026-10-20T18:00:00Z'));assert.equal(f.auth.session(ctx).authenticated,false);
 }finally{f.close();}
});
test('reset, own password change and disabling immediately invalidate sessions; list never exposes hashes',async()=>{
 const f=await fixture();
 try{
  const created=await f.auth.simpleAccounts.create({context:f.admin,email:'analista@synthetic.invalid',password:PASSWORD,jobTitle:'analista de Afiliados',fronts:['afiliados'],brands:['fish']});
  const signIn=password=>f.auth.login({email:created.user.email,password,host:HOST,origin:ORIGIN,ip:'synthetic'});
  let user=context(await signIn(PASSWORD));
  await f.auth.simpleAccounts.resetPassword({context:f.admin,userId:created.user.id,password:NEW_PASSWORD});
  assert.equal(f.auth.session(user).authenticated,false);
  await assert.rejects(signIn(PASSWORD),e=>e.code==='AUTH_INVALID');
  user=context(await signIn(NEW_PASSWORD));
  await assert.rejects(f.auth.simpleAccounts.changePassword({context:user,currentPassword:'synthetic-wrong-password',password:PASSWORD}),e=>e.code==='PASSWORD_CURRENT_INVALID');
  await f.auth.simpleAccounts.changePassword({context:user,currentPassword:NEW_PASSWORD,password:PASSWORD});
  assert.equal(f.auth.session(user).authenticated,false);user=context(await signIn(PASSWORD));
  f.auth.simpleAccounts.update({context:f.admin,userId:created.user.id,jobTitle:'analista de Afiliados',fronts:['afiliados'],brands:['fish'],active:false});
  assert.equal(f.auth.session(user).authenticated,false);await assert.rejects(signIn(PASSWORD),e=>e.code==='AUTH_INVALID');
  const serialized=JSON.stringify(f.auth.simpleAccounts.list({context:f.admin}));
  assert(!serialized.includes('password_hash'));assert(!serialized.includes(PASSWORD));assert(!serialized.includes('encrypted_key'));
 }finally{f.close();}
});
test('admin actions require origin and CSRF, reject duplicates and bcrypt truncation',async()=>{
 const f=await fixture();
 const input={email:'gestor@synthetic.invalid',password:PASSWORD,jobTitle:'gestor de CRM',fronts:['growth'],brands:['fish']};
 try{
  await assert.rejects(f.auth.simpleAccounts.create({...input,context:{...f.admin,origin:'https://foreign.invalid'}}),e=>e.code==='ORIGIN_DENIED');
  await assert.rejects(f.auth.simpleAccounts.create({...input,context:{...f.admin,csrf:'invalid'}}),e=>e.code==='CSRF_DENIED');
  await assert.rejects(f.auth.simpleAccounts.create({...input,context:f.admin,password:'é'.repeat(40)}),e=>e.code==='PASSWORD_INVALID');
  await assert.rejects(f.auth.simpleAccounts.create({...input,context:f.admin,fronts:['growth','growth']}),e=>e.code==='FRONTS_INVALID');
  await f.auth.simpleAccounts.create({...input,context:f.admin});
  await assert.rejects(f.auth.simpleAccounts.create({...input,context:f.admin}),e=>e.code==='EMAIL_EXISTS');
  assert.throws(()=>f.auth.simpleAccounts.update({context:f.admin,userId:f.adminLogin.user.id,jobTitle:'gestor',fronts:['growth'],brands:['fish'],active:false}),e=>e.code==='SIMPLE_USER_NOT_FOUND');
 }finally{f.close();}
});
test('simple sessions keep logout and the existing attempt limit',async()=>{
 const f=await fixture();
 try{
  const created=await f.auth.simpleAccounts.create({context:f.admin,email:'gestor@synthetic.invalid',password:PASSWORD,jobTitle:'gestor de CRM',fronts:['growth'],brands:['fish']});
  const login=await f.auth.login({email:created.user.email,password:PASSWORD,host:HOST,origin:ORIGIN,ip:'synthetic'}),ctx=context(login);
  assert.match(f.auth.logout(ctx).cookie,/Max-Age=0/);assert.equal(f.auth.session(ctx).authenticated,false);
  for(let i=0;i<5;i++)await assert.rejects(f.auth.login({email:created.user.email,password:'synthetic-wrong-password',host:HOST,origin:ORIGIN,ip:'synthetic'}),e=>e.code==='AUTH_INVALID');
  await assert.rejects(f.auth.login({email:created.user.email,password:PASSWORD,host:HOST,origin:ORIGIN,ip:'synthetic'}),e=>e.code==='AUTH_RATE_LIMIT');
 }finally{f.close();}
});
