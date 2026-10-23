'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs');
const PASSWORD='synthetic-account-password-2026',NEW_PASSWORD='synthetic-changed-password-2026';
const HOST='gerencial.synthetic.invalid',ORIGIN='https://'+HOST,TOKEN='synthetic-bootstrap-token';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function context(login){return {host:HOST,origin:ORIGIN,method:'POST',csrf:login.csrf,cookieHeader:login.cookie.split(';')[0]};}
async function fixture({legacy=false,adminWrite=false,qa=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-simple-login-')),dbPath=path.join(directory,'dashboard.sqlite');
 let time=Date.parse('2026-10-12T18:00:00Z');
 const options={dbPath,managerHost:HOST,areaHosts:{growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid',...(qa?['shrigma.com.br']:[])],bootstrapAdminEmail:'administrador@synthetic.invalid',bootstrapTokenSha256:sha(TOKEN),encryptionKey:Buffer.alloc(32,7),now:()=>time,...(!legacy?{simpleReadMode:true}:{})};
 let auth=createAuth(options);
 await auth.completeBootstrap({email:options.bootstrapAdminEmail,token:TOKEN,password:PASSWORD,host:HOST,origin:ORIGIN});
 if(adminWrite){const db=new DatabaseSync(dbPath);db.prepare('UPDATE grants SET can_edit=1 WHERE area=?').run('growth');db.close();}
 if(legacy){auth.close();auth=createAuth({...options,simpleReadMode:true});}
 const login=await auth.login({email:options.bootstrapAdminEmail,password:PASSWORD,host:HOST,origin:ORIGIN,ip:'synthetic'});
 return {options,get auth(){return auth;},dbPath,admin:context(login),adminLogin:login,setTime:t=>{time=t;},reopen(simpleReadMode){auth.close();auth=createAuth({...options,simpleReadMode});},close(){auth.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
test('journey model selections append atomically with draft revision and survive restart without changing legacy payload',async()=>{
 const f=await fixture({adminWrite:true}),engine=require(runtime+'/public/crm-preview/journey-engine.js'),Input=require(runtime+'/model-piece-input.cjs');
 try{
  const db=new DatabaseSync(f.dbPath),before={};
  for(const brand of ['aristo','fish']){
   const draft=engine.createDraft({brand,id:'persisted-model-'+brand}),store={schema:engine.SCHEMA,drafts:[draft],runs:[]};
   const initial=f.auth.simpleAccounts.labSave({context:f.admin,brand,expected_revision:0,store});assert.deepEqual(initial.modelRefs,[]);
   const old=JSON.stringify(db.prepare('SELECT * FROM simple_journey_lab_revision_v1 WHERE brand=?').all(brand));before[brand]=old;
   const piece=f.auth.simpleAccounts.modelPieces.append({context:f.admin,brand,body:{acao:'rascunho',idempotency_key:crypto.randomUUID(),rascunho:Input.prepare({name:'Peça '+brand,subject:'Assunto',format:'html',content:'<h1>'+brand+'</h1>'},brand)}}).operation.response.body.draft_id;
   const refs=[{draftId:draft.id,stepId:draft.steps[0].id,pieceId:piece,version:1}];
   const saved=f.auth.simpleAccounts.labSave({context:f.admin,brand,expected_revision:1,store,modelRefs:refs});assert.equal(saved.revision,2);assert.deepEqual(saved.store,store);assert.deepEqual(saved.modelRefs,refs);
   assert.deepEqual(engine.readStore(db.prepare('SELECT payload_json FROM simple_journey_lab_revision_v1 WHERE brand=? AND revision=2').get(brand).payload_json),store);
   assert.equal(JSON.stringify(db.prepare('SELECT * FROM simple_journey_lab_revision_v1 WHERE brand=? AND revision=1').all(brand)),old);
   for(const bad of [[refs[0],refs[0]],[{...refs[0],version:2}],[{...refs[0],stepId:'wrong'}],[{...refs[0],recipient:'client@external.invalid'}]])assert.throws(()=>f.auth.simpleAccounts.labSave({context:f.admin,brand,expected_revision:2,store,modelRefs:bad}));
   assert.equal(db.prepare('SELECT count(*) n FROM simple_journey_lab_revision_v1 WHERE brand=?').get(brand).n,2);assert.equal(db.prepare('SELECT count(*) n FROM simple_journey_lab_models_v1 WHERE brand=?').get(brand).n,2);
   assert.throws(()=>f.auth.simpleAccounts.labSave({context:f.admin,brand,expected_revision:1,store,modelRefs:refs}),e=>e.code==='LAB_VERSION_CHANGED');
  }
  db.close();f.reopen(true);
  for(const brand of ['aristo','fish']){const saved=f.auth.simpleAccounts.labRead({context:f.admin,brand});assert.equal(saved.modelRefs.length,1);assert.equal(saved.revision,2);assert.equal(saved.store.drafts[0].brand,brand);}
  const aristo=f.auth.simpleAccounts.labRead({context:f.admin,brand:'aristo'}),fish=f.auth.simpleAccounts.labRead({context:f.admin,brand:'fish'});
  assert.throws(()=>f.auth.simpleAccounts.labSave({context:f.admin,brand:'aristo',expected_revision:2,store:aristo.store,modelRefs:[{...aristo.modelRefs[0],pieceId:fish.modelRefs[0].pieceId}]}),e=>e.code==='PIECE_NOT_FOUND');
  // A previous client saves the unchanged, backwards-compatible payload. Its
  // absent selection metadata is not inferred from an older revision.
  const legacy=f.auth.simpleAccounts.labSave({context:f.admin,brand:'aristo',expected_revision:2,store:aristo.store});assert.deepEqual(legacy.modelRefs,[]);assert.deepEqual(legacy.store,aristo.store);
 }finally{f.close();}
});
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
test('paid QA retains external receipts across scenarios and resolves history or fences an absent mutation',async()=>{
 const f=await fixture({adminWrite:true});try{
  const api=f.auth.simpleAccounts,brand='aristo',read=mutationId=>api.paidQaRead({context:f.admin,brand,...(mutationId?{mutationId}:{})}),mutate=(action,args={},id=crypto.randomUUID())=>api.paidQaMutate({context:f.admin,brand,expected_revision:read().revision,mutationId:id,action,...args});
  const firstId=crypto.randomUUID(),created=mutate('create',{name:'Recibos cumulativos',waitMinutes:[0,60]},firstId),draftId=created.qa.definitions[0].id,started=mutate('start',{draftId,personId:'pessoa-1'}),roundId=started.qa.rounds[0].id;
  let r=mutate('advance',{roundId,minutes:0,payment:'paid',mailEvidence:'ses',afterEntry:'none'});assert.equal(r.qa.rounds[0].run.attempts.length,0);r=mutate('advance',{roundId,minutes:60,payment:'paid',mailEvidence:'empty',afterEntry:'none'});assert.equal(r.qa.rounds[0].run.attempts.length,0);assert.equal(r.qa.rounds[0].decisions.at(-1).code,'daily-limit');assert.equal(r.qa.rounds[0].receipts.length,1);
  r=mutate('advance',{roundId,minutes:1440,payment:'paid',mailEvidence:'ses',afterEntry:'none'});assert.equal(r.qa.rounds[0].run.attempts.length,0);assert.equal(r.qa.rounds[0].receipts.length,2);assert.equal(r.qa.rounds[0].decisions.at(-1).code,'daily-limit');
  const historical=read(firstId);assert.equal(historical.mutationReceipt.confirmed,true);assert.equal(historical.mutationReceipt.revision,1);assert(historical.revision>1);assert.throws(()=>mutate('create',{name:'Não reutilizar ID',waitMinutes:[0]},firstId),{code:'PAID_QA_MUTATION_REUSED'});
  const late=crypto.randomUUID(),expected=read().revision,fence=mutate('resolve',{originalMutationId:late});assert.equal(fence.revision,expected+1);assert.deepEqual(fence.mutationReceipt,{mutationId:late,confirmed:false,revision:null});assert.throws(()=>api.paidQaMutate({context:f.admin,brand,expected_revision:expected,mutationId:late,action:'create',name:'Chegou tarde',waitMinutes:[0]}),{code:'PAID_QA_VERSION_CHANGED'});assert.deepEqual(read().qa.definitions.map(d=>d.id),[draftId]);
 }finally{f.close();}
});
test('paid QA sidecar saves, simulates, crosses brands, reopens and stays outside legacy TEST drafts',async()=>{
 const f=await fixture({adminWrite:true});try{
  const api=()=>f.auth.simpleAccounts,mutate=(brand,action,args)=>api().paidQaMutate({context:f.admin,brand,expected_revision:api().paidQaRead({context:f.admin,brand}).revision,mutationId:crypto.randomUUID(),action,...args});
  const ids={};for(const brand of ['aristo','fish']){const created=mutate(brand,'create',{name:'Pedido pago QA '+brand,waitMinutes:[0,60,1440]});ids[brand]=created.qa.definitions[0].id;assert.equal(created.revision,1);assert.equal(created.executes,false);assert.equal(created.sends,0);assert.deepEqual(api().labRead({context:f.admin,brand}).store,{schema:Lab.SCHEMA,drafts:[],runs:[]});const started=mutate(brand,'start',{draftId:ids[brand],personId:'mesma-pessoa'});const roundId=started.qa.rounds[0].id;const first=mutate(brand,'advance',{roundId,minutes:60,payment:'paid',mailEvidence:'empty',afterEntry:'none'});assert.equal(first.qa.rounds[0].run.attempts.length,brand==='aristo'?1:0);assert.equal(first.qa.rounds[0].decisions.at(-1).code,'daily-limit');const updated=mutate(brand,'update',{draftId:ids[brand],name:'Nova revisão '+brand,waitMinutes:[0,1440]});assert.equal(updated.qa.definitions[0].revision,2);assert.equal(updated.qa.rounds[0].run.draft.revision,1);assert.throws(()=>api().paidQaMutate({context:f.admin,brand,expected_revision:0,mutationId:crypto.randomUUID(),action:'create',name:'Não repetir',waitMinutes:[0]}),{code:'PAID_QA_VERSION_CHANGED'});}
  const before=api().paidQaRead({context:f.admin,brand:'aristo'});f.reopen(true);assert.deepEqual(api().paidQaRead({context:f.admin,brand:'aristo'}),before);assert.deepEqual(api().labRead({context:f.admin,brand:'aristo'}).store.drafts,[]);assert.equal(before.qa.rounds[0].realSends,0);assert.equal(fs.readdirSync(path.join(path.dirname(f.dbPath),'paid-qa-backups')).length,1);
 }finally{f.close();}
});
test('paid QA requires current cookie, QA identity, brand, WRITE and CSRF without accepting contact or transport fields',async()=>{
 const f=await fixture({adminWrite:true,qa:true});try{
  const ordinary=await f.auth.simpleAccounts.create({context:f.admin,email:'ordinary@synthetic.invalid',password:PASSWORD,jobTitle:'CRM',fronts:['growth'],brands:['aristo'],writeFronts:['growth']}),ordinaryLogin=await f.auth.login({email:ordinary.user.email,password:PASSWORD,host:HOST,origin:ORIGIN});assert.throws(()=>f.auth.simpleAccounts.paidQaRead({context:context(ordinaryLogin),brand:'aristo'}),{code:'PAID_QA_RESTRICTED'});
  const qa=await f.auth.simpleAccounts.create({context:f.admin,email:'editor-qa-aristo@shrigma.com.br',password:PASSWORD,jobTitle:'QA',fronts:['growth'],brands:['aristo']}),login=await f.auth.login({email:qa.user.email,password:PASSWORD,host:HOST,origin:ORIGIN}),ctx=context(login),base={context:ctx,brand:'aristo',expected_revision:0,mutationId:crypto.randomUUID(),action:'create',name:'QA',waitMinutes:[0]};assert.equal(f.auth.simpleAccounts.paidQaRead({context:ctx,brand:'aristo'}).revision,0);assert.throws(()=>f.auth.simpleAccounts.paidQaRead({context:ctx,brand:'fish'}),{code:'BRAND_DENIED'});assert.throws(()=>f.auth.simpleAccounts.paidQaMutate(base),{code:'PRODUCT_WRITE_DENIED'});
  const adminBase={...base,context:f.admin};assert.throws(()=>f.auth.simpleAccounts.paidQaMutate({...adminBase,context:{...f.admin,csrf:'wrong'}}),{code:'CSRF_DENIED'});assert.throws(()=>f.auth.simpleAccounts.paidQaMutate({...adminBase,context:{...f.admin,method:'GET'}}),{code:'PAID_QA_COOKIE_REQUIRED'});assert.throws(()=>f.auth.simpleAccounts.paidQaRead({context:{...f.admin,nativeBearer:'synthetic'},brand:'aristo'}),{code:'PAID_QA_COOKIE_REQUIRED'});for(const extra of [{recipient:'customer@external.invalid'},{send:true},{policy:{maxEmailsPerPersonDay:2}},{rounds:[]}])assert.throws(()=>f.auth.simpleAccounts.paidQaMutate({...adminBase,...extra}),{code:'PAID_QA_ARGUMENTS'});
  f.auth.simpleAccounts.update({context:f.admin,userId:qa.user.id,jobTitle:'QA',fronts:['growth'],brands:['aristo'],active:false});assert.throws(()=>f.auth.simpleAccounts.paidQaRead({context:ctx,brand:'aristo'}),{code:'SESSION_REQUIRED'});
 }finally{f.close();}
});
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

(function reviewRegistryUnitCases(){
'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),{create}=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/journey-activation-review.cjs');
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,state TEXT);INSERT INTO users VALUES('owner','superadmin','active'),('analyst','manager','active'),('reader','manager','active'),('other','manager','active')");let edit=true,revision=1,name='Reativação de teste';const context={method:'POST',id:'analyst'},snapshots=[];
 const registry=create({db,now:()=>Date.parse('2026-10-17T01:00:00Z'),authorize:c=>{const u=db.prepare('SELECT * FROM users WHERE id=?').get(c.id);if(!u||u.state!=='active'||c.admin&&u.role!=='superadmin'||c.brand&&!['fish','aristo'].includes(c.brand))throw Object.assign(Error('denied'),{code:'DENIED',status:403});return {...u,permissions:{growth:{edit:edit&&u.id!=='reader'}},productWriteFronts:['growth']};},getSnapshot:(c,brand,draftId,v)=>{if(v!==revision)throw Object.assign(Error('changed'),{code:'DRAFT_CHANGED'});const x={labRevision:revision,draft:{id:draftId,brand,revision,name,mode:'test',productionEnabled:false,trigger:'manual_event',audienceRef:null,exitOnPurchase:true,steps:[{id:'s1',enabled:true,waitMinutes:0,subject:'[TESTE] Revisão',templateName:'Modelo'}]},sendWindow:{timeZone:'America/Sao_Paulo',start:'09:00',end:'19:00',days:[1,2,3,4,5,6,7]},models:[{stepId:'s1',pieceId:'synthetic',version:1,htmlSha256:'a'.repeat(64)}]};snapshots.push(x);return x;}});
 const command=(brand='aristo')=>({context,brand,draftId:'synthetic-'+brand,version:revision,requestId:crypto.randomUUID(),expectedUserId:'analyst'});
 return {db,registry,context,command,snapshots,edit:b=>edit=b,change:()=>{revision++;name='Revisão posterior';}};}
test('both brands reach the unique owner inbox without activating or changing original users',t=>{const f=fixture(t),before=JSON.stringify(f.db.prepare('SELECT * FROM users').all());for(const brand of ['aristo','fish']){const r=f.registry.append(f.command(brand));a.equal(r.record.state,'review_requested');a.equal(r.record.commercialActivation,false);a.equal(r.record.sends,false);a.equal(r.record.enrolls,false);a.equal(r.record.destination,'project-owner-inbox');a.equal(r.record.proposal.pendingRequirements.length,6);}const inbox=f.registry.inbox({context:{id:'owner',method:'GET'}});a.equal(inbox.records.length,2);a.equal(inbox.commercialActivation,false);a.equal(JSON.stringify(f.db.prepare('SELECT * FROM users').all()),before);a(f.db.prepare('SELECT owner_id FROM simple_journey_activation_review_v1').all().every(r=>r.owner_id==='owner'));});
test('same intent recovers the frozen original even after the draft changes; a second intent cannot duplicate the revision',t=>{const f=fixture(t),c=f.command(),first=f.registry.append(c),second=f.registry.append({...c,requestId:crypto.randomUUID()});a.deepEqual(second.record,first.record);a.equal(second.duplicate,true);a.deepEqual(f.registry.read({context:f.context,brand:'aristo',draftId:c.draftId,version:c.version}).record,first.record);f.change();const recovered=f.registry.append(c);a.deepEqual(recovered.record,first.record);a.equal(recovered.duplicate,true);a.equal(f.snapshots.length,1);a.equal(f.registry.append(f.command()).record.version,2);a.equal(f.db.prepare('SELECT count(*) n FROM simple_journey_activation_review_v1').get().n,2);});
test('own reads never disclose another analyst or brand, and native callers cannot write',t=>{const f=fixture(t),c=f.command();f.registry.append(c);a.throws(()=>f.registry.read({context:{id:'other',method:'GET'},brand:'aristo',requestId:c.requestId}),{code:'JOURNEY_REVIEW_NOT_FOUND'});a.throws(()=>f.registry.read({context:f.context,brand:'fish',requestId:c.requestId}),{code:'JOURNEY_REVIEW_NOT_FOUND'});for(const patch of [{context:{id:'reader',method:'POST'},expectedUserId:'reader'},{context:{id:'analyst',method:'GET'}},{context:{id:'owner',method:'POST',nativeBearer:'SYNTHETIC'},expectedUserId:'owner'},{expectedUserId:'other'}])a.throws(()=>f.registry.append({...f.command(),...patch}));a.equal(f.db.prepare('SELECT count(*) n FROM simple_journey_activation_review_v1').get().n,1);});
test('owner reader requires the actual active superadmin and explicitly bounds native brand scope',t=>{const f=fixture(t);f.registry.append(f.command('aristo'));f.registry.append(f.command('fish'));a.throws(()=>f.registry.inbox({context:f.context}));a.throws(()=>f.registry.inbox({context:{id:'owner',nativeBearer:'SYNTHETIC'}}),{code:'JOURNEY_REVIEW_COOKIE_REQUIRED'});const scoped=f.registry.inbox({context:{id:'owner',nativeBearer:'SYNTHETIC'},nativeRead:true,brands:['aristo']});a.equal(scoped.records.length,1);a.equal(scoped.records[0].brand,'aristo');a.deepEqual(f.registry.inbox({context:{id:'owner'},brands:[]}).records,[]);f.db.exec("UPDATE users SET state='inactive' WHERE id='owner'");a.throws(()=>f.registry.append(f.command('fish')),{code:'JOURNEY_REVIEW_OWNER_UNAVAILABLE'});});
test('failing insert rolls back atomically and does not reserve an uncertain operation',t=>{const f=fixture(t);f.db.exec("CREATE TRIGGER fail_review BEFORE INSERT ON simple_journey_activation_review_v1 BEGIN SELECT RAISE(ABORT,'synthetic');END");a.throws(()=>f.registry.append(f.command()));a.equal(f.db.isTransaction,false);a.equal(f.db.prepare('SELECT count(*) n FROM simple_journey_activation_review_v1').get().n,0);});
test('stored payload corruption is refused instead of showing a different proposal',t=>{const f=fixture(t),c=f.command();f.registry.append(c);f.db.exec("UPDATE simple_journey_activation_review_v1 SET payload_json='{}'");a.throws(()=>f.registry.read({context:f.context,brand:'aristo',requestId:c.requestId}),{code:'JOURNEY_REVIEW_INTEGRITY'});a.throws(()=>f.registry.inbox({context:{id:'owner'}}),{code:'JOURNEY_REVIEW_INTEGRITY'});});
test('native brand filter applies before the limit so another brand cannot hide the inbox',t=>{const f=fixture(t);for(const brand of ['aristo','fish'])for(let i=0;i<70;i++)f.registry.append({...f.command(brand),draftId:'synthetic-'+brand+'-'+i});const scoped=f.registry.inbox({context:{id:'owner',nativeBearer:'SYNTHETIC'},nativeRead:true,brands:['aristo']});a.equal(scoped.records.length,70);a.equal(scoped.more,false);a(scoped.records.every(r=>r.brand==='aristo'));});

})();
