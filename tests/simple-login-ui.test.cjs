'use strict';
// Real compiled UI and gateway handler in a local DOM; no browser or provider.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {artifact,transport,shell,until}=require('./helpers/claude-portal-pages.cjs');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{createServer}=require(runtime+'/server.cjs'),{FIXED_DESTINATIONS}=require(runtime+'/proxy.cjs');
const HOST='gerencial.synthetic.invalid',PASS='synthetic-password-2026',NEW_PASS='synthetic-new-password-2026';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'simple-login-ui-')),boot='synthetic-bootstrap-token',areaHosts={growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:HOST,areaHosts,allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(boot).digest('hex'),encryptionKey:Buffer.alloc(32,9),simpleReadMode:true});
 await auth.completeBootstrap({email:'admin@synthetic.invalid',token:boot,password:PASS,host:HOST,origin:'https://'+HOST});const master=await auth.login({email:'admin@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST});
 const context={host:HOST,origin:'https://'+HOST,method:'POST',cookieHeader:master.cookie.split(';')[0],csrf:master.csrf};
 const upstreams=Object.fromEntries(['crm-read','cx','cache','influ','tts'].map(k=>[k,new URL(FIXED_DESTINATIONS[k])]));
 const app=createServer({mode:'operational',simpleReadMode:true,simpleReadSources:{},managerHost:HOST,areaHosts,allowedEmailDomains:['synthetic.invalid'],upstreams,allowedUpstreamHosts:[...new Set(Object.values(upstreams).map(u=>u.hostname))],publicDir:path.join(artifact(),'public')},{auth,fetchImpl:()=>{throw Error('NO_PROVIDER_IN_UI_TEST');}});
 t.after(()=>{app.removeAllListeners();auth.close();fs.rmSync(dir,{recursive:true,force:true});});const http=transport(app);
 const make=(cookie=master.cookie.split(';')[0],options={})=>{const x=shell(http,{host:HOST,area:'gestao',cookie,...options}),dialog=x.el('simple-password-dialog');Object.defineProperty(dialog,'open',{get(){return this.hasAttribute('open');}});dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.dispatchEvent(new x.window.Event('close'));};return x;};
 return {auth,http,context,make};
}
const tick=(x,id,value)=>{const field=x.el(id).querySelector('input[value="'+value+'"]');field.checked=true;field.setAttribute('checked','');};
test('administrator creates a password account from the actual compiled form, without invitation or custody',async t=>{
 const f=await fixture(t),x=f.make();await until(()=>!x.el('entry-shell').hidden,'simple shell');
 assert.equal(x.el('admin-invite-form').hidden,true);assert.equal(x.el('entry-password').hidden,false);
 x.el('entry-manage').click();await until(()=>!x.el('admin-panel').hidden&&x.el('admin-users').textContent.includes('administrador'),'users');
 x.input('simple-email','gestor@synthetic.invalid');x.input('simple-title','gestor de CRM');x.input('simple-password',PASS);for(const front of ['growth','organico','afiliados'])tick(x,'simple-fronts',front);for(const brand of ['fish','aristo'])tick(x,'simple-brands',brand);
 await x.submit('simple-user-form');await until(()=>x.el('admin-message').textContent.includes('Usuário criado'),'created');
 const writes=x.calls.filter(c=>c.path==='/auth/simple/users'&&c.method==='POST');assert.equal(writes.length,1);assert.deepEqual(writes[0].body.fronts,['growth','organico','afiliados']);assert.deepEqual(writes[0].body.brands,['fish','aristo']);assert.equal(x.el('simple-password').value,'');
 assert.equal(x.el('admin-invite-result').hidden,true);assert.equal(x.el('admin-crm-reconcile').hidden,true);assert(![...x.values.values()].some(v=>String(v).includes(PASS)));
});
test('multi-front person opens the central shell with four separate navigation entries',async t=>{
 const f=await fixture(t);await f.auth.simpleAccounts.create({context:f.context,email:'analista@synthetic.invalid',password:PASS,jobTitle:'analista',fronts:['growth','organico','influs','afiliados'],brands:['fish','aristo']});
 const login=await f.auth.login({email:'analista@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST}),x=f.make(login.cookie.split(';')[0]);await until(()=>!x.el('entry-shell').hidden,'person shell');
 assert.equal(x.el('entry-owner').textContent,'analista');assert.equal(x.el('entry-manage').hidden,true);assert.deepEqual([...x.el('entry-nav').querySelectorAll('button')].map(b=>b.textContent),['CRM','Orgânico','Influs','Afiliados']);
 x.el('entry-nav').querySelector('[data-view="afiliados"]').click();assert.match(x.el('entry-frame').querySelector('iframe').src,/\/app\/afiliados\//);
});
test('compiled admin form grants WRITE only to selected READ fronts and reopens the persisted access',async t=>{
 const f=await fixture(t),x=f.make();await until(()=>!x.el('entry-shell').hidden,'simple shell');x.el('entry-manage').click();await until(()=>!x.el('admin-panel').hidden,'users');
 const read=x.el('simple-fronts').querySelector('input[value="afiliados"]'),write=x.el('simple-write-fronts').querySelector('input[value="afiliados"]'),crmWrite=x.el('simple-write-fronts').querySelector('input[value="growth"]');assert.equal(write.disabled,true);
 tick(x,'simple-fronts','afiliados');read.dispatchEvent(new x.window.Event('change',{bubbles:true}));assert.equal(write.disabled,false);assert.equal(crmWrite.disabled,true);tick(x,'simple-write-fronts','afiliados');
 read.checked=false;read.removeAttribute('checked');read.dispatchEvent(new x.window.Event('change',{bubbles:true}));assert.equal(write.disabled,true);assert.equal(write.checked,false);
 tick(x,'simple-fronts','afiliados');read.dispatchEvent(new x.window.Event('change',{bubbles:true}));tick(x,'simple-write-fronts','afiliados');tick(x,'simple-brands','fish');x.input('simple-email','writer@synthetic.invalid');x.input('simple-title','analista de Afiliados');x.input('simple-password',PASS);
 await x.submit('simple-user-form');await until(()=>x.el('admin-message').textContent.includes('Usuário criado'),'created');const calls=x.calls.filter(c=>c.path==='/auth/simple/users'&&c.method==='POST');assert.equal(calls.length,1);assert.deepEqual(calls[0].body.fronts,['afiliados']);assert.deepEqual(calls[0].body.writeFronts,['afiliados']);
 const row=[...x.el('admin-users').querySelectorAll('.user-row')].find(r=>r.textContent.includes('writer@synthetic.invalid')),fields=row.querySelectorAll('fieldset');assert.equal(fields[1].querySelector('input[value="afiliados"]').checked,true);assert.equal(fields[1].querySelector('input[value="growth"]').disabled,true);
});
test('own-password dialog changes the real account and requires a fresh login',async t=>{
 const f=await fixture(t);await f.auth.simpleAccounts.create({context:f.context,email:'analista@synthetic.invalid',password:PASS,jobTitle:'analista',fronts:['growth'],brands:['fish']});
 const login=await f.auth.login({email:'analista@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST}),x=f.make(login.cookie.split(';')[0]);await until(()=>!x.el('entry-shell').hidden,'person shell');
 x.el('entry-password').click();x.input('simple-current-password',PASS);x.input('simple-new-password',NEW_PASS);await x.submit('simple-password-form');await until(()=>!x.el('entry-login').hidden&&x.el('entry-message').textContent.includes('Senha alterada'),'password changed');
 assert.equal(x.el('simple-current-password').value,'');assert.equal(x.el('simple-new-password').value,'');assert.equal(x.calls.filter(c=>c.path==='/auth/password').length,1);
 await assert.rejects(f.auth.login({email:'analista@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST}),e=>e.code==='AUTH_INVALID');assert((await f.auth.login({email:'analista@synthetic.invalid',password:NEW_PASS,host:HOST,origin:'https://'+HOST})).cookie);
});

test('CRM WRITE account works in both brands; DOM reset and deactivate invalidate actual sessions',async t=>{
 const f=await fixture(t),x=f.make();await until(()=>!x.el('entry-shell').hidden,'shell');x.el('entry-manage').click();await until(()=>!x.el('admin-panel').hidden,'admin');
 x.input('simple-email','crm@synthetic.invalid');x.input('simple-title','CRM');x.input('simple-password',PASS);tick(x,'simple-fronts','growth');x.el('simple-fronts').dispatchEvent(new x.window.Event('change',{bubbles:true}));tick(x,'simple-write-fronts','growth');for(const b of ['fish','aristo'])tick(x,'simple-brands',b);
 await x.submit('simple-user-form');await until(()=>x.el('admin-message').textContent.includes('Usuário criado'),'created');
 const login=await f.auth.login({email:'crm@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST}),ctx={...f.context,cookieHeader:login.cookie.split(';')[0],csrf:login.csrf,area:'growth',productFront:'growth',edit:true};
 for(const brand of ['fish','aristo'])assert.equal(f.auth.authorizeBrand(ctx,brand).email,'crm@synthetic.invalid');assert.throws(()=>f.auth.authorizeBrand(ctx,'olivas'));
 const row=()=>[...x.el('admin-users').querySelectorAll('.user-row')].find(r=>r.textContent.includes('crm@synthetic.invalid'));let form=row().querySelector('.simple-password-reset');form.querySelector('input').value=NEW_PASS;form.dispatchEvent(new x.window.Event('submit',{cancelable:true}));await until(()=>x.el('admin-message').textContent.includes('Senha resetada'),'reset');
 assert.throws(()=>f.auth.authorizeBrand(ctx,'fish'));await assert.rejects(f.auth.login({email:'crm@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST}));
 const fresh=await f.auth.login({email:'crm@synthetic.invalid',password:NEW_PASS,host:HOST,origin:'https://'+HOST});form=row().querySelector('.simple-user-editor');const active=form.querySelector('input[type="checkbox"]:not(fieldset input)');active.checked=false;form.dispatchEvent(new x.window.Event('submit',{cancelable:true}));await until(()=>x.el('admin-message').textContent.includes('Acesso atualizado'),'deactivated');
 assert(row().textContent.includes('Inativo'));assert.throws(()=>f.auth.authorizeBrand({...ctx,cookieHeader:fresh.cookie.split(';')[0]},'fish'));assert.equal(x.calls.filter(c=>c.path==='/auth/simple/users'&&c.method==='POST').length,3);
});
test('lost reset ACK reopens current list without replay and never claims the new password is proven',async t=>{
 const f=await fixture(t);await f.auth.simpleAccounts.create({context:f.context,email:'crm@synthetic.invalid',password:PASS,jobTitle:'CRM',fronts:['growth'],brands:['fish']});
 const x=f.make(undefined,{loseAck:(method,b)=>method==='POST'&&b?.action==='reset'});await until(()=>!x.el('entry-shell').hidden,'shell');x.el('entry-manage').click();await until(()=>x.el('admin-users').textContent.includes('crm@synthetic.invalid'),'users');
 const form=x.el('admin-users').querySelector('.simple-password-reset');form.querySelector('input').value=NEW_PASS;const reads=x.calls.filter(c=>c.path==='/auth/users').length;form.dispatchEvent(new x.window.Event('submit',{cancelable:true}));await until(()=>x.el('admin-message').textContent.includes('não foi confirmada'),'uncertain');
 assert(x.el('admin-message').textContent.includes('lista não comprova a senha'));assert.equal(x.calls.filter(c=>c.path==='/auth/simple/users'&&c.method==='POST').length,1);assert.equal(x.calls.filter(c=>c.path==='/auth/users').length,reads+1);assert(!x.el('admin-message').textContent.includes('Senha resetada'));assert((await f.auth.login({email:'crm@synthetic.invalid',password:NEW_PASS,host:HOST,origin:'https://'+HOST})).cookie);
});
test('expired administrative cookie returns simple account mutations to login',async t=>{
 const f=await fixture(t),x=f.make();await until(()=>!x.el('entry-shell').hidden,'shell');x.el('entry-manage').click();await until(()=>!x.el('admin-panel').hidden,'admin');
 await f.auth.logout(f.context);x.input('simple-email','crm@synthetic.invalid');x.input('simple-title','CRM');x.input('simple-password',PASS);tick(x,'simple-fronts','growth');tick(x,'simple-brands','fish');await x.submit('simple-user-form');
 await until(()=>!x.el('entry-login').hidden&&x.el('entry-message').textContent.includes('sessão expirou'),'login');assert.equal(x.el('admin-panel').hidden,true);assert.equal(x.calls.filter(c=>c.path==='/auth/simple/users').at(-1).status,401);
});
test('compiled owner inbox displays both brand requests as text and clears them on logout without activation',async t=>{
 const f=await fixture(t),created=await f.auth.simpleAccounts.create({context:f.context,email:'lifecycle@synthetic.invalid',password:PASS,jobTitle:'CRM',fronts:['growth'],writeFronts:['growth'],brands:['fish','aristo']}),login=await f.auth.login({email:created.user.email,password:PASS,host:HOST,origin:'https://'+HOST}),context={...f.context,cookieHeader:login.cookie.split(';')[0],csrf:login.csrf},engine=require(runtime+'/public/crm-preview/journey-engine.js');
 const ids=[];for(const brand of ['aristo','fish']){const draft=engine.createDraft({brand,id:'synthetic-owner-review-'+brand});draft.name='Reativação <script>pendente</script>';draft.steps[0].subject='[TESTE] <img src=x onerror=alert(1)>';f.auth.simpleAccounts.labSave({context,brand,expected_revision:0,store:{schema:engine.SCHEMA,drafts:[draft],runs:[]}});const r=f.auth.simpleAccounts.journeyActivationReview.append({context,brand,draftId:draft.id,version:1,requestId:crypto.randomUUID(),expectedUserId:login.user.id});ids.push(r.record.requestId);}
 const x=f.make();await until(()=>!x.el('entry-shell').hidden,'owner shell');x.el('entry-manage').click();await until(()=>!x.el('admin-journey-reviews').hidden,'review button');x.el('admin-journey-reviews').click();await until(()=>x.el('admin-journey-inbox').querySelectorAll('[data-journey-review-id]').length===2,'owner inbox');
 const box=x.el('admin-journey-inbox');assert.deepEqual([...box.querySelectorAll('[data-journey-review-id]')].map(e=>e.dataset.journeyReviewId).sort(),ids.sort());assert(box.textContent.includes('lifecycle@synthetic.invalid'));assert(box.textContent.includes('O Aristocrata'));assert(box.textContent.includes('Fishermans'));assert(box.textContent.includes('não ativa jornadas'));assert.equal(box.querySelector('script,img,form'),null);assert.equal(box.querySelector('button'),null);const calls=x.calls.filter(c=>c.path==='/api/journey-activation-inbox');assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].status,200);
 x.el('entry-logout').click();await until(()=>!x.el('entry-login').hidden,'logout');assert.equal(box.textContent,'');assert.equal(box.hidden,true);assert.equal(x.el('admin-journey-reviews').hidden,true);
});
test('logout during an owner inbox read allows a fresh login to consult without stale content',async t=>{
 const f=await fixture(t),originalGet=f.http.get;let release,entered;const gate=new Promise(r=>entered=r);f.http.get=async(...args)=>{const result=await originalGet(...args);if(args[1]==='/api/journey-activation-inbox')await new Promise(r=>{release=r;entered();});return result;};
 const x=f.make();await until(()=>!x.el('entry-shell').hidden,'owner shell');x.el('entry-manage').click();await until(()=>!x.el('admin-journey-reviews').hidden,'review button');x.el('admin-journey-reviews').click();await gate;assert.equal(x.el('admin-journey-reviews').disabled,true);x.el('entry-logout').click();await until(()=>!x.el('entry-login').hidden,'logout');assert.equal(x.el('admin-journey-reviews').disabled,false);assert.equal(x.el('admin-journey-inbox').textContent,'');
 await x.login('admin@synthetic.invalid',PASS);x.el('entry-manage').click();await until(()=>!x.el('admin-journey-reviews').hidden,'new review button');assert.equal(x.el('admin-journey-reviews').disabled,false);release();await new Promise(r=>setImmediate(r));assert.equal(x.el('admin-journey-inbox').textContent,'');assert.equal(x.el('admin-journey-inbox').hidden,true);f.http.get=originalGet;x.el('admin-journey-reviews').click();await until(()=>x.el('admin-journey-inbox').textContent.includes('Nenhuma solicitação'),'new owner read');assert.equal(x.el('admin-journey-reviews').disabled,false);
});
