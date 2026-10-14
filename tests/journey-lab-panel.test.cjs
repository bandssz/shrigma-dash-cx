'use strict';
// Compiled CRM page + real local auth/router, synthetic provider only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {artifact,transport,panel,until}=require('./helpers/claude-portal-pages.cjs');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{createServer}=require(runtime+'/server.cjs'),{FIXED_DESTINATIONS}=require(runtime+'/proxy.cjs'),{DESTINATION}=require(runtime+'/crm-published-journey-read.cjs');
const HOST='crm.synthetic.invalid',MANAGER='gerencial.synthetic.invalid',PASS='synthetic-lab-password-2026';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journey-lab-panel-')),areaHosts={growth:HOST,organico:'organic.synthetic.invalid',influs:'influ.synthetic.invalid'},boot='synthetic-bootstrap';
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:MANAGER,areaHosts,allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(boot).digest('hex'),encryptionKey:Buffer.alloc(32,9),simpleReadMode:true});
 await auth.completeBootstrap({email:'admin@synthetic.invalid',token:boot,password:PASS,host:MANAGER,origin:'https://'+MANAGER});const admin=await auth.login({email:'admin@synthetic.invalid',password:PASS,host:MANAGER,origin:'https://'+MANAGER});
 const context={host:MANAGER,origin:'https://'+MANAGER,method:'POST',cookieHeader:admin.cookie.split(';')[0],csrf:admin.csrf};
 await auth.simpleAccounts.create({context,email:'analista@synthetic.invalid',password:PASS,jobTitle:'gestor de CRM',fronts:['growth'],brands:['aristo']});
 const login=await auth.login({email:'analista@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST});
 const upstreams=Object.fromEntries(['crm-read','cx','cache','influ','tts'].map(k=>[k,new URL(FIXED_DESTINATIONS[k])])),calls=[];
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);calls.push({url:u.href,method:options.method});assert.equal(options.headers.Authorization,'Bearer synthetic-source-key-for-lab');
  let value;if(u.origin+u.pathname===DESTINATION){
   const brand=u.searchParams.get('marca');assert(['fish','aristo'].includes(brand));assert.equal(options.method,'GET');
   const steps=[{key:'email:first',channel:'email',enabled:true,wait_min:60,template_name:'Synthetic first'},{key:'email:second',channel:'email',enabled:true,wait_min:1440,template_name:'Synthetic second'}];
   value={checked_at:'2026-10-13T03:30:00Z',flows:[{brand,key:brand+':carrinho',name:'Carrinho',trigger:'Checkout abandonado',version:6,published_version:6,enabled:true,runtime_ready:true,journey_kind:null,available_steps:steps.map(s=>({key:s.key,name:s.template_name,channel:s.channel})),published:{steps}}]};
  }else value={_escopo:'growth',_painel:'growth',gerado_em:'2026-10-13T03:30:00Z',_cache_gerado_em:'2026-10-13T03:30:00Z',crm_diario:[],crm_campanha:[],crm_fluxo:[],crm_conversao:[],capabilities:{}};
  return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 };
 const app=createServer({mode:'operational',simpleReadMode:true,simpleReadSources:{growth:'synthetic-source-key-for-lab'},managerHost:MANAGER,areaHosts,allowedEmailDomains:['synthetic.invalid'],upstreams,allowedUpstreamHosts:[...new Set(Object.values(upstreams).map(u=>u.hostname))],publicDir:path.join(artifact(),'public')},{auth,fetchImpl});
 t.after(()=>{app.removeAllListeners();auth.close();fs.rmSync(dir,{recursive:true,force:true});});return {http:transport(app),cookie:login.cookie.split(';')[0],calls};
}
test('actual compiled CRM laboratory opens through its tab, copies, saves and reopens without provider WRITE',async t=>{
 const f=await fixture(t),values=new Map(),x=await panel(f.http,{host:HOST,cookie:f.cookie,values});
 x.run("abrirSecaoCRM('regua',{tab:'fluxos'});");x.q('#control-tab-lab').click();assert.equal(x.q('#control-lab').hidden,false);assert.equal(x.q('#control-tab-lab').getAttribute('aria-selected'),'true');
 x.q('[data-lab-read]').click();await until(()=>x.q('[data-lab-copy]')&&!x.q('[data-lab-copy]').disabled,()=>JSON.stringify({lab:x.q('#control-lab').textContent,requests:x.requests,calls:f.calls}));
 x.q('[data-lab-copy]').click();await until(()=>x.q('[data-lab-name]'),'copy');Object.defineProperty(Object.getPrototypeOf(x.q('[data-lab-name]')),'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(v){this.toggleAttribute('checked',Boolean(v))}});x.q('[data-lab-name]').value='Cart copy from actual panel';x.q('[data-lab-save]').click();await until(()=>x.q('[data-lab-revision]')?.dataset.labRevision==='2','saved revision');
 x.q('[data-lab-start]').click();await until(()=>x.q('.lab-clock'),'started');x.q('[data-lab-advance="60"]').click();await until(()=>x.q('.lab-results').textContent.includes('Registro sintético confirmado'),'first stage');
 const y=await panel(f.http,{host:HOST,cookie:f.cookie,values});y.run("MARCA='aristo';SEC='regua';GC.setTab('lab');render();");y.q('[data-lab-read]').click();await until(()=>y.q('[data-lab-name]'),'reopened');assert.equal(y.q('[data-lab-name]').value,'Cart copy from actual panel');assert.match(y.q('.lab-results').textContent,/Registro sintético confirmado/);assert.match(y.q('#control-lab').textContent,/Envios reais: 0/);
 assert(f.calls.filter(c=>c.url.startsWith(DESTINATION)).every(c=>c.method==='GET'));assert(x.requests.every(r=>r.method==='GET'));assert(y.requests.every(r=>r.method==='GET'));
});
