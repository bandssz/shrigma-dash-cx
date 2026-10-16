'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs');
const PASSWORD='synthetic-account-password-2026',NEW_PASSWORD='synthetic-changed-password-2026';
const HOST='gerencial.synthetic.invalid',ORIGIN='https://'+HOST,TOKEN='synthetic-bootstrap-token';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function context(login){return {host:HOST,origin:ORIGIN,method:'POST',csrf:login.csrf,cookieHeader:login.cookie.split(';')[0]};}
async function fixture({legacy=false,adminWrite=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-simple-login-')),dbPath=path.join(directory,'dashboard.sqlite');
 let time=Date.parse('2026-10-12T18:00:00Z');
 const options={dbPath,managerHost:HOST,areaHosts:{growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'administrador@synthetic.invalid',bootstrapTokenSha256:sha(TOKEN),encryptionKey:Buffer.alloc(32,7),now:()=>time,...(!legacy?{simpleReadMode:true}:{})};
 let auth=createAuth(options);
 await auth.completeBootstrap({email:options.bootstrapAdminEmail,token:TOKEN,password:PASSWORD,host:HOST,origin:ORIGIN});
 if(adminWrite){const db=new DatabaseSync(dbPath);db.prepare('UPDATE grants SET can_edit=1 WHERE area=?').run('growth');db.close();}
 if(legacy){auth.close();auth=createAuth({...options,simpleReadMode:true});}
 const login=await auth.login({email:options.bootstrapAdminEmail,password:PASSWORD,host:HOST,origin:ORIGIN,ip:'synthetic'});
 return {options,get auth(){return auth;},dbPath,admin:context(login),adminLogin:login,setTime:t=>{time=t;},reopen(simpleReadMode){auth.close();auth=createAuth({...options,simpleReadMode});},close(){auth.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
test('writing is an explicit subset of fronts and never expands the sibling Influs front',async()=>{
 const f=await fixture();try{
  const created=await f.auth.simpleAccounts.create({context:f.admin,email:'writer@synthetic.invalid',password:PASSWORD,jobTitle:'analista de Afiliados',fronts:['influs','afiliados'],brands:['fish'],writeFronts:['afiliados']});
  const login=await f.auth.login({email:created.user.email,password:PASSWORD,host:HOST,origin:ORIGIN}),ctx=context(login);assert.deepEqual(created.user.writeFronts,['afiliados']);
  assert.equal(f.auth.authorizeBrand({...ctx,area:'influs',productFront:'afiliados',edit:true},'fish').id,created.user.id);
  assert.throws(()=>f.auth.authorizeBrand({...ctx,area:'influs',productFront:'influs',edit:true},'fish'),e=>e.code==='PRODUCT_WRITE_DENIED');
  assert.throws(()=>f.auth.authorizeBrand({...ctx,area:'influs',edit:true},'fish'),e=>e.code==='PRODUCT_WRITE_DENIED');
  await assert.rejects(f.auth.simpleAccounts.create({context:f.admin,email:'bad@synthetic.invalid',password:PASSWORD,jobTitle:'analista',fronts:['afiliados'],brands:['fish'],writeFronts:['growth']}),e=>e.code==='WRITE_FRONTS_INVALID');
 }finally{f.close();}
});
test('existing READ accounts remain READ and attempts persist after restart without private source fields',async()=>{
 const f=await fixture();try{
  const read=await f.auth.simpleAccounts.create({context:f.admin,email:'reader@synthetic.invalid',password:PASSWORD,jobTitle:'analista',fronts:['afiliados'],brands:['fish']});assert.deepEqual(read.user.writeFronts,[]);
  const created=await f.auth.simpleAccounts.create({context:f.admin,email:'writer@synthetic.invalid',password:PASSWORD,jobTitle:'analista',fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados']}),login=await f.auth.login({email:created.user.email,password:PASSWORD,host:HOST,origin:ORIGIN}),ctx=context(login),requestId=crypto.randomUUID(),candidateId=crypto.randomUUID(),binding=sha('synthetic-write-binding');
  const row=f.auth.simpleAccounts.reserveAffiliateEdit({context:ctx,requestId,brand:'fish',candidateId,expectedVersion:1,binding});assert.equal(row.user_id,created.user.id);f.reopen(true);
  const old=f.auth.simpleAccounts.affiliateEdit({context:ctx,requestId,brand:'fish',candidateId});assert.equal(old.state,'reserved');assert.equal(old.binding,binding);
  assert.throws(()=>f.auth.simpleAccounts.reserveAffiliateEdit({context:ctx,requestId:crypto.randomUUID(),brand:'fish',candidateId,expectedVersion:1,binding}),e=>e.code==='AFFILIATE_OPERATION_UNCERTAIN');
  const pending=f.auth.simpleAccounts.pendingAffiliateEdits({context:ctx,brand:'fish'});assert.equal(pending.length,1);assert(!Object.hasOwn(pending[0],'binding'));assert(!Object.hasOwn(pending[0],'user_id'));
  f.auth.simpleAccounts.finishAffiliateEdit(old,'confirmed');assert.deepEqual(f.auth.simpleAccounts.pendingAffiliateEdits({context:ctx,brand:'fish'}),[]);
 }finally{f.close();}
});
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

const Lab=require(runtime+'/public/crm-preview/journey-engine.js');
function labStore(brand='aristo'){const draft=Lab.duplicate({brand,key:brand+':carrinho',name:'Carrinho sintético',published_version:1,published:{steps:[{channel:'email',wait_min:60,enabled:true,template_name:'Primeiro'},{channel:'email',wait_min:1440,enabled:true,template_name:'Segundo'}]}},{brand,id:'synthetic-draft'});return {schema:Lab.SCHEMA,drafts:[draft],runs:[]};}
test('server test drafts reopen after restart, isolate account and brand, and compare revision atomically',async()=>{
 const f=await fixture();try{
  const row=await f.auth.simpleAccounts.create({context:f.admin,email:'crm@synthetic.invalid',password:PASSWORD,jobTitle:'gestor de CRM',fronts:['growth'],brands:['fish','aristo'],writeFronts:['growth']});
  const login=await f.auth.login({email:row.user.email,password:PASSWORD,host:HOST,origin:ORIGIN}),ctx=context(login),store=labStore();
  assert.equal(f.auth.simpleAccounts.labRead({context:ctx,brand:'aristo'}).revision,0);
  const saved=f.auth.simpleAccounts.labSave({context:ctx,brand:'aristo',expected_revision:0,store});assert.equal(saved.revision,1);assert.equal(saved.executes,false);assert.deepEqual(saved.store,store);
  assert.throws(()=>f.auth.simpleAccounts.labSave({context:ctx,brand:'aristo',expected_revision:0,store}),e=>e.code==='LAB_VERSION_CHANGED'&&e.status===409);
  assert.equal(f.auth.simpleAccounts.labRead({context:ctx,brand:'fish'}).revision,0);
  assert.equal(f.auth.simpleAccounts.labRead({context:f.admin,brand:'aristo'}).revision,0);
  f.reopen(true);assert.deepEqual(f.auth.simpleAccounts.labRead({context:ctx,brand:'aristo'}).store,store);
  const changed=structuredClone(store);changed.drafts[0]=Lab.saveDraft(store.drafts[0],{...store.drafts[0],name:'Nova revisão'});
  assert.equal(f.auth.simpleAccounts.labSave({context:ctx,brand:'aristo',expected_revision:1,store:changed}).revision,2);
 }finally{f.close();}
});
test('server test persistence refuses READ-only, wrong brand, missing CSRF, revoked session and real contact fields',async()=>{
 const f=await fixture();try{
  const row=await f.auth.simpleAccounts.create({context:f.admin,email:'readonly-crm@synthetic.invalid',password:PASSWORD,jobTitle:'gestor de CRM',fronts:['growth'],brands:['aristo']});
  const login=await f.auth.login({email:row.user.email,password:PASSWORD,host:HOST,origin:ORIGIN}),ctx=context(login),store=labStore();
  assert.throws(()=>f.auth.simpleAccounts.labSave({context:ctx,brand:'aristo',expected_revision:0,store}),e=>e.code==='PRODUCT_WRITE_DENIED');
  assert.throws(()=>f.auth.simpleAccounts.labRead({context:ctx,brand:'fish'}),e=>e.code==='BRAND_DENIED');
  assert.throws(()=>f.auth.simpleAccounts.labSave({context:{...f.admin,csrf:'invalid'},brand:'aristo',expected_revision:0,store}),e=>e.code==='CSRF_DENIED');
  for(const mutate of [d=>d.recipient='synthetic@example.invalid',d=>d.productionEnabled=true,d=>d.steps[0].to='synthetic@example.invalid']){const bad=structuredClone(store);mutate(bad.drafts[0]);assert.throws(()=>f.auth.simpleAccounts.labSave({context:f.admin,brand:'aristo',expected_revision:0,store:bad}));}
  f.auth.simpleAccounts.update({context:f.admin,userId:row.user.id,jobTitle:row.user.jobTitle,fronts:['growth'],brands:['aristo'],active:false});
  assert.throws(()=>f.auth.simpleAccounts.labRead({context:ctx,brand:'aristo'}),e=>e.code==='SESSION_REQUIRED');
  assert.equal(f.auth.simpleAccounts.labRead({context:f.admin,brand:'aristo'}).revision,0);
 }finally{f.close();}
});

test('journey saves append revisions and preserve a legacy baseline across CAS, restart and ACK recovery',async()=>{const f=await fixture({adminWrite:true});try{const store=labStore(),id=f.adminLogin.user.id,baseline={user_id:id,brand:'aristo',revision:3,payload_json:JSON.stringify(store),created_at:1,updated_at:2};let db=new DatabaseSync(f.dbPath);db.prepare('INSERT INTO simple_journey_lab_v1 VALUES(?,?,?,?,?,?)').run(...Object.values(baseline));db.close();assert.equal(f.auth.simpleAccounts.labRead({context:f.admin,brand:'aristo'}).revision,3);const changed=structuredClone(store);changed.drafts[0]=Lab.saveDraft(store.drafts[0],{...store.drafts[0],name:'Revisão append-only'});const command={context:f.admin,brand:'aristo',expected_revision:3,store:changed};assert.equal(f.auth.simpleAccounts.labSave(command).revision,4);assert.throws(()=>f.auth.simpleAccounts.labSave(command),{code:'LAB_VERSION_CHANGED'});const recovered=f.auth.simpleAccounts.labRead({context:f.admin,brand:'aristo'});assert.equal(recovered.revision,4);assert.deepEqual(recovered.store,changed);f.reopen(true);assert.deepEqual(f.auth.simpleAccounts.labRead({context:f.admin,brand:'aristo'}).store,changed);assert.equal(f.auth.simpleAccounts.labSave({...command,expected_revision:4}).revision,5);db=new DatabaseSync(f.dbPath);assert.deepEqual({...db.prepare('SELECT * FROM simple_journey_lab_v1').get()},baseline);assert.equal(db.prepare('SELECT COUNT(*) n FROM simple_journey_lab_revision_v1').get().n,2);db.prepare('UPDATE simple_journey_lab_v1 SET updated_at=99').run();db.close();assert.throws(()=>f.auth.simpleAccounts.labRead({context:f.admin,brand:'aristo'}),{code:'LAB_BASELINE_CHANGED'});assert.throws(()=>f.auth.simpleAccounts.labSave({...command,expected_revision:5}),{code:'LAB_BASELINE_CHANGED'});}finally{f.close();}});
test('an old rollback writer creating a formerly absent baseline is detected without losing revisions',async()=>{const f=await fixture({adminWrite:true});try{const store=labStore(),id=f.adminLogin.user.id;f.auth.simpleAccounts.labSave({context:f.admin,brand:'aristo',expected_revision:0,store});const db=new DatabaseSync(f.dbPath),before=JSON.stringify(db.prepare('SELECT * FROM simple_journey_lab_revision_v1').all());db.prepare('INSERT INTO simple_journey_lab_v1 VALUES(?,?,?,?,?,?)').run(id,'aristo',1,JSON.stringify(store),1,1);assert.throws(()=>f.auth.simpleAccounts.labRead({context:f.admin,brand:'aristo'}),{code:'LAB_BASELINE_CHANGED'});assert.throws(()=>f.auth.simpleAccounts.labSave({context:f.admin,brand:'aristo',expected_revision:1,store}),{code:'LAB_BASELINE_CHANGED'});assert.equal(JSON.stringify(db.prepare('SELECT * FROM simple_journey_lab_revision_v1').all()),before);db.close();}finally{f.close();}});
test('journey WRITE requires current growth edit for superadmin and a profiled manager',async()=>{const f=await fixture();try{const store=labStore();assert.throws(()=>f.auth.simpleAccounts.labSave({context:f.admin,brand:'aristo',expected_revision:0,store}),{code:'PRODUCT_WRITE_DENIED'});const created=await f.auth.simpleAccounts.create({context:f.admin,email:'revoked-writer@synthetic.invalid',password:PASSWORD,jobTitle:'CRM',fronts:['growth'],brands:['aristo'],writeFronts:['growth']}),login=await f.auth.login({email:created.user.email,password:PASSWORD,host:HOST,origin:ORIGIN}),ctx=context(login);assert.equal(f.auth.simpleAccounts.labSave({context:ctx,brand:'aristo',expected_revision:0,store}).revision,1);const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE grants SET can_edit=0 WHERE user_id=? AND area=?').run(created.user.id,'growth');db.close();assert.throws(()=>f.auth.simpleAccounts.labSave({context:ctx,brand:'aristo',expected_revision:1,store}),{code:'PRODUCT_WRITE_DENIED'});assert.equal(f.auth.simpleAccounts.labRead({context:ctx,brand:'aristo'}).revision,1);}finally{f.close();}});

test('actual cookie HTTP route saves and reopens a server test draft while refusing missing CSRF',async()=>{
 const f=await fixture({adminWrite:true}),{Readable,Writable}=require('node:stream'),{createServer}=require(runtime+'/server.cjs'),engine=require(runtime+'/public/crm-preview/journey-engine.js');
 const server=createServer({...f.options,mode:'demo',publicDir:path.join(runtime,'public')},{auth:f.auth,fetchImpl:()=>{throw Error('NO_REMOTE_WRITE')}});
 try{
  const request=async(method,url,body,csrf=f.admin.csrf)=>{
   const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=url;req.headers={host:HOST,origin:ORIGIN,cookie:f.admin.cookieHeader,...(csrf?{'x-csrf-token':csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'})};req.socket={remoteAddress:'synthetic'};
   const chunks=[],res=new Writable({write(chunk,_encoding,cb){chunks.push(chunk);cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(r=>res.once('finish',r));server.emit('request',req,res);await done;return {status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())};
  };
  const d=engine.createDraft({brand:'aristo',id:'synthetic-server-draft'}),store={schema:engine.SCHEMA,drafts:[d],runs:[]};
  const empty=await request('GET','/api/journey-lab?brand=aristo');assert.equal(empty.status,200,JSON.stringify(empty));assert.equal(empty.body.revision,0);
  const denied=await request('POST','/api/journey-lab',{brand:'aristo',expected_revision:0,store},'');assert.equal(denied.status,403);
  const saved=await request('POST','/api/journey-lab',{brand:'aristo',expected_revision:0,store});assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.body.revision,1);
  const reopened=await request('GET','/api/journey-lab?brand=aristo');assert.deepEqual(reopened.body.store,store);assert.equal(reopened.body.executes,false);
  const conflict=await request('POST','/api/journey-lab',{brand:'aristo',expected_revision:0,store});assert.equal(conflict.status,409);assert.equal(conflict.body.error,'LAB_VERSION_CHANGED');
 }finally{server.close();f.close();}
});
