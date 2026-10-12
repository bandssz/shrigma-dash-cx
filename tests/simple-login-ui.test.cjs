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
 const make=(cookie=master.cookie.split(';')[0])=>{const x=shell(http,{host:HOST,area:'gestao',cookie}),dialog=x.el('simple-password-dialog');Object.defineProperty(dialog,'open',{get(){return this.hasAttribute('open');}});dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.dispatchEvent(new x.window.Event('close'));};return x;};
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
 x.el('entry-nav').querySelector('[data-view="afiliados"]').click();assert.match(x.el('entry-frame').querySelector('iframe').src,/view=afiliados/);
});
test('own-password dialog changes the real account and requires a fresh login',async t=>{
 const f=await fixture(t);await f.auth.simpleAccounts.create({context:f.context,email:'analista@synthetic.invalid',password:PASS,jobTitle:'analista',fronts:['growth'],brands:['fish']});
 const login=await f.auth.login({email:'analista@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST}),x=f.make(login.cookie.split(';')[0]);await until(()=>!x.el('entry-shell').hidden,'person shell');
 x.el('entry-password').click();x.input('simple-current-password',PASS);x.input('simple-new-password',NEW_PASS);await x.submit('simple-password-form');await until(()=>!x.el('entry-login').hidden&&x.el('entry-message').textContent.includes('Senha alterada'),'password changed');
 assert.equal(x.el('simple-current-password').value,'');assert.equal(x.el('simple-new-password').value,'');assert.equal(x.calls.filter(c=>c.path==='/auth/password').length,1);
 await assert.rejects(f.auth.login({email:'analista@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST}),e=>e.code==='AUTH_INVALID');assert((await f.auth.login({email:'analista@synthetic.invalid',password:NEW_PASS,host:HOST,origin:'https://'+HOST})).cookie);
});
