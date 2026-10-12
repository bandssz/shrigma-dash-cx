"use strict";
// Actual adapter; HTTP/session/private-binding values below are synthetic.
// No external calls, fabricated real actor/grant, cookie string or service credential.
// Run: node --test operacao/candidatos/afiliados-session-read.test.cjs
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {create,CONTRACT}=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'))+'/public/afiliados-session-read.cjs');
const period={ini:'2026-10-01',fim:'2026-10-12'};
const ID='11111111-1111-4111-8111-111111111111',SECOND='22222222-2222-4222-8222-222222222222';
function session(brand='fish') {return {authenticated:true,csrf:'synthetic-csrf',uiKey:'ui-'+(brand==='fish'?'a':'b').repeat(32),
  user:{id:ID,role:'manager',brandAccess:'single',brand,brands:[brand],areas:['influs'],permissions:{influs:{read:true,edit:true}}},features:{affiliateRead:true}};}
function payload(brand='fish') {return {brand,brands:[brand],brandAccess:'single',janela:{...period},kpis:[],amostras:[],fila:[]};}
function response(data,status=200) {return {ok:status===200,status,json:async()=>data};}
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture({state=session(),fetch,refresh}={}) {
  const f={state,calls:[],refreshes:[],invalidations:[],linked:true,bindings:{fish:'a'.repeat(64),aristo:'b'.repeat(64)}};
  f.availability=brand=>({schema:CONTRACT.schema,brand,readLinked:f.linked,binding:f.linked?f.bindings[brand]:null,readOnly:true});
  f.adapter=create({getSession:()=>f.state,onInvalidate:e=>f.invalidations.push(e),
    refreshSession:async options=>{f.refreshes.push(options);if(refresh)return refresh(f,options);},
    fetchImpl:async(url,options)=>{f.calls.push({url,options});if(fetch){const r=await fetch(f,url,options);if(r!==undefined)return r;}
      return response(options.method==='GET'?f.availability(new URL(url,'https://synthetic.invalid').searchParams.get('brand')):payload(JSON.parse(options.body).brand));}});
  f.ready=brand=>f.adapter.ready(brand||f.state.user.brand);return f;
}
const posts=f=>f.calls.filter(c=>c.options.method==='POST');

test('dedicated contract preserves legacy tts and exposes no WRITE/credential API',()=>{
  assert.equal(CONTRACT.proposed,undefined);assert.equal(CONTRACT.route,'/api/affiliate-read');assert.equal(CONTRACT.write,false);assert.equal(CONTRACT.deadlineMs,35000);
  assert.deepEqual(CONTRACT.requestFields,['brand','ini','fim','expected_binding']);assert.equal(CONTRACT.expectedBindingAuthenticates,false);
  const f=fixture();assert.equal(f.adapter.current('read'),'');assert.equal(f.adapter.current('write'),'');assert.equal(f.adapter.write,undefined);assert.equal(f.adapter.submit,undefined);
  assert(Object.isFrozen(f.adapter));
});

test('installed session/Influs read+edit cannot activate Afiliados without own opt-in',async()=>{
  const state=session();delete state.features.affiliateRead;const f=fixture({state});assert.equal(await f.ready(),false);
  assert.equal(f.calls.length,0);assert.equal(f.adapter.current('read'),'');await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_READ_NOT_READY'});
});

test('feature alone is not a grant: genuine availability must report own readLinked and hex64 binding',async()=>{
  const f=fixture();f.linked=false;assert.equal(await f.ready(),false);assert.equal(f.adapter.current('read'),'');assert.equal(posts(f).length,0);
  for(const bad of ['A'.repeat(64),'a'.repeat(63),null,'token',3]) {
    const s=fixture({fetch:(f,url,o)=>o.method==='GET'?response({...f.availability('fish'),binding:bad}):undefined});
    await assert.rejects(s.ready(),{code:'AFFILIATE_AVAILABILITY_INVALID'});assert.equal(s.adapter.current('read'),'');
  }
});

test('session identity/effective brand mismatch or missing fields fails closed, with no availability/data lookup',async()=>{
  for(const change of [s=>s.authenticated=false,s=>delete s.csrf,s=>delete s.uiKey,s=>s.user.id='actor-created-by-ui',
    s=>s.user.brands.push('aristo'),s=>s.user.brandAccess='all',s=>s.user.role='analyst-not-in-contract']) {
    const state=session();change(state);const f=fixture({state});assert.equal(await f.ready('fish'),false);assert.equal(f.calls.length,0);
  }
  const foreign=fixture();assert.equal(await foreign.ready('aristo'),false);assert.equal(foreign.calls.length,0);
});

for(const brand of ['fish','aristo'])test('ready/read for '+brand+' uses availability + captured brand/version and legitimate cookie policy',async()=>{
  const f=fixture({state:session(brand)});assert.equal(await f.ready(),true);const reference=f.adapter.current('read');assert.match(reference,/^affiliate-session:ui-/);
  const data=await f.adapter.read(period);assert.equal(data.brand,brand);assert.equal(f.refreshes.length,3);
  assert.equal(f.calls.filter(c=>c.options.method==='GET').length,3);assert.equal(posts(f).length,1);
  const {url,options}=posts(f)[0];assert.equal(url,'/api/affiliate-read');
  assert.deepEqual(JSON.parse(options.body),{brand,...period,expected_binding:f.bindings[brand]});
  assert.deepEqual(options.headers,{Accept:'application/json','Content-Type':'application/json'});
  assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  assert(!JSON.stringify(options).includes(reference));assert(!Object.hasOwn(options.headers,'Cookie'));assert(!Object.hasOwn(options.headers,'Authorization'));
  assert(f.calls.every(c=>!c.url.includes('/api/tts')));
});

test('master does not borrow anything: own opt-in plus explicit brand availability still required',async()=>{
  const s=session();s.user={...s.user,role:'superadmin',brandAccess:'all',brand:null,brands:['fish','aristo']};
  const f=fixture({state:s});f.linked=false;assert.equal(await f.ready('fish'),false);f.linked=true;assert.equal(await f.ready('fish'),true);
  assert.equal((await f.adapter.read(period)).brand,'fish');delete s.features.affiliateRead;assert.equal(f.adapter.current('read'),'');
});

test('caller cannot transport brand/actor/action/key/version or invent a route through read parameters',async()=>{
  const f=fixture();await f.ready();const count=f.calls.length;
  for(const p of [{...period,brand:'aristo'},{...period,k:'key'},{...period,actor:ID},{...period,acao:'revisar'},{...period,expected_binding:'a'.repeat(64)},
    {ini:'2026-02-30',fim:period.fim},{ini:'2026-11-01',fim:period.fim},Object.create(period)])
    await assert.rejects(f.adapter.read(p),{code:'AFFILIATE_WINDOW_INVALID'});
  await assert.rejects(f.adapter.read(period,{endpoint:'https://outside.invalid'}),{code:'AFFILIATE_READ_OPTIONS_INVALID'});
  await assert.rejects(f.adapter.ready('todas'),{code:'AFFILIATE_BRAND_REQUIRED'});assert.equal(f.calls.length,count);
});

test('binding changed before POST prevents any data query; expected_binding never authenticates',async()=>{
  const f=fixture();await f.ready();f.bindings.fish='c'.repeat(64);
  await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_BINDING_REPLACED'});assert.equal(posts(f).length,0);assert.equal(f.adapter.current('read'),'');
});

test('post-read binding change discards received data, and only fresh ready can bind new version',async()=>{
  const f=fixture({fetch:(f,url,o)=>{if(o.method==='POST')f.bindings.fish='c'.repeat(64);}});await f.ready();
  await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_BINDING_REPLACED'});assert.equal(posts(f).length,1);assert.equal(f.adapter.current('read'),'');
  assert.equal(await f.ready(),true);
});

test('fresh pre-read session revocation blocks provider/data lookup even if last availability was linked',async()=>{
  const f=fixture({refresh:async f=>{if(f.refreshes.length===2)f.state.features.affiliateRead=false;}});await f.ready();
  await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_BINDING_REPLACED'});assert.equal(posts(f).length,0);assert.equal(f.adapter.current('read'),'');
});

test('fresh post-read revocation discards the response',async()=>{
  const f=fixture({refresh:async f=>{if(f.refreshes.length===3)f.state.features.affiliateRead=false;}});await f.ready();
  await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_BINDING_REPLACED'});assert.equal(posts(f).length,1);assert.equal(f.adapter.current('read'),'');
});

for(const changed of ['brand','principal','csrf','revoked'])test('pending data is aborted after server-session '+changed+' epoch',async()=>{
  const d=deferred(),f=fixture({fetch:(f,u,o)=>o.method==='POST'?d.promise:undefined});await f.ready();const first=f.adapter.current('read');
  const work=f.adapter.read(period);await new Promise(r=>setImmediate(r));assert.equal(posts(f).length,1);
  if(changed==='brand')f.state=session('aristo');if(changed==='principal')f.state.user.id=SECOND;
  if(changed==='csrf')f.state.csrf='synthetic-new-session-csrf';if(changed==='revoked')f.state.features.affiliateRead=false;
  assert.notEqual(f.adapter.current('read'),first);assert.equal(posts(f)[0].options.signal.aborted,true);
  await assert.rejects(work,{code:'AFFILIATE_READ_ABORTED'});d.resolve(response(payload()));
  assert(f.invalidations.every(x=>Object.keys(x).sort().join(',')==='code,epoch'));
});

test('late old 401 cannot reject the newer brand/binding',async()=>{
  const d=deferred(),f=fixture({fetch:(f,u,o)=>o.method==='POST'?d.promise:undefined});await f.ready();const first=f.adapter.current('read');
  const work=f.adapter.read(period);await new Promise(r=>setImmediate(r));f.state=session('aristo');assert.equal(await f.ready(),true);const next=f.adapter.current('read');
  await assert.rejects(work,{code:'AFFILIATE_READ_ABORTED'});d.resolve(response(undefined,401));
  assert.equal(f.adapter.reject('read',first),false);assert.equal(f.adapter.current('read'),next);
});

for(const status of [401,403])test(status+' rejects only this READ context and unchanged source binding stays closed',async()=>{
  const f=fixture({fetch:(f,u,o)=>o.method==='POST'?response(undefined,status):undefined});await f.ready();const first=f.adapter.current('read');
  await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_ACCESS_REJECTED',status});assert.equal(f.adapter.current('read'),'');
  assert.equal(await f.ready(),false);f.bindings.fish='c'.repeat(64);assert.equal(await f.ready(),true);assert.notEqual(f.adapter.current('read'),first);
  assert.equal(f.adapter.reject('write',f.adapter.current('read')),false);
});

test('availability wrong brand/schema/fields/types/readOnly never becomes ready',async()=>{
  for(const change of [p=>p.brand='aristo',p=>p.schema='unknown',p=>p.extra=true,p=>p.readLinked='true',p=>{p.readLinked=false;p.binding='a'.repeat(64);},p=>delete p.readOnly,p=>p.readOnly=false]) {
    const f=fixture({fetch:f=>{const p=f.availability('fish');change(p);return response(p);}});
    await assert.rejects(f.ready(),{code:'AFFILIATE_AVAILABILITY_INVALID'});assert.equal(f.adapter.current('read'),'');
  }
});

test('private/free upstream errors are not copied into exceptions',async()=>{
  for(const fetch of [()=>{throw Error('synthetic-private-error');},()=>response({error:'synthetic-private-error'},503),
    ()=>({ok:true,status:200,json:async()=>{throw Error('synthetic-private-error');}})]) {
    const f=fixture({fetch});await assert.rejects(f.ready(),e=>{assert.match(e.code,/^AFFILIATE_(READ_UNAVAILABLE|RESPONSE_INVALID)$/);assert.equal(e.message,e.code);return true;});
  }
});

test('data response brand/window mismatch is rejected instead of relabelled',async()=>{
  for(const change of [p=>p.brand='aristo',p=>p.brands.push('aristo'),p=>p.brandAccess='all',p=>p.janela.fim='2026-10-11',p=>delete p.brand]) {
    const p=payload();change(p);const f=fixture({fetch:(f,u,o)=>o.method==='POST'?response(p):undefined});await f.ready();
    await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_RESPONSE_UNSCOPED'});
  }
});

test('failed post-read fresh-session callback never accepts an unconfirmed response',async()=>{
  const f=fixture({refresh:async f=>{if(f.refreshes.length===3)throw Error('synthetic-private-error');}});await f.ready();
  await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_SESSION_UNCONFIRMED'});assert.equal(posts(f).length,1);
});

test('already aborted ready/read do not call transport, and dispose closes pending direct reads',async()=>{
  const f=fixture(),c=new AbortController();c.abort();await assert.rejects(f.adapter.ready('fish',{signal:c.signal}),{code:'AFFILIATE_READ_ABORTED'});assert.equal(f.calls.length,0);
  const d=deferred(),g=fixture({fetch:(f,u,o)=>o.method==='POST'?d.promise:undefined});await g.ready();
  await assert.rejects(g.adapter.read(period,{signal:c.signal}),{code:'AFFILIATE_READ_ABORTED'});assert.equal(posts(g).length,0);
  const work=g.adapter.read(period);await new Promise(r=>setImmediate(r));g.adapter.dispose();await assert.rejects(work,{code:'AFFILIATE_READ_ABORTED'});d.resolve(response(payload()));
  assert.equal(g.adapter.current('read'),'');assert.equal(await g.ready(),false);
});

test('actual compiled guard refreshes session/CSRF and uses only own READ body without bearer',async()=>{
  const guard=fs.readFileSync(path.join(process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),'public/guard.compiled.js'),'utf8');
  let realm;const state=session(),calls=[],location={origin:'https://dash.synthetic.invalid',href:'https://dash.synthetic.invalid/influs.html?view=afiliados'};
  const nativeFetch=async(url,options)=>{
    calls.push({url:String(url),options});const u=new URL(url,location.origin);
    const data=u.pathname==='/auth/session'?state:options.method==='GET'?{schema:CONTRACT.schema,brand:u.searchParams.get('brand'),readLinked:true,binding:'a'.repeat(64),readOnly:true}:payload();
    const reply=new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});reply.json=async()=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(data))+')',realm);return reply;
  };
  const window={fetch:nativeFetch,dispatchEvent(){},open(){}};window.parent=window;
  const context=vm.createContext({window,location,document:{querySelectorAll(){return[];},body:{dataset:{}},addEventListener(){}},navigator:{},URL,Headers,Request,Response,FormData,URLSearchParams,CustomEvent,AbortController,setTimeout,clearTimeout,HTMLFormElement:class{}});
  realm=context;
  new vm.Script(guard,{filename:'actual-compiled-guard.js'}).runInContext(context);
  const adapter=window.ShrigmaAffiliateAccess;
  assert.equal(await adapter.prepareSelection('todas'),'fish');assert.equal(await adapter.ready('fish'),true);await adapter.read(vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(period))+')',context));
  const post=calls.find(x=>x.options.method==='POST');assert(post);assert.equal(post.options.credentials,'same-origin');
  assert.equal(post.options.headers.get('X-CSRF-Token'),'synthetic-csrf');assert.equal(post.options.headers.get('Authorization'),null);assert.equal(post.options.headers.get('Cookie'),null);
  assert.deepEqual(JSON.parse(post.options.body),{brand:'fish',...period,expected_binding:'a'.repeat(64)});
  assert.equal(calls.filter(c=>c.url.includes('/auth/session')).length,4);assert(calls.every(c=>!c.url.includes('/api/tts')));
});

test('fresh ready for unchanged context/source keeps UI reference/cache epoch and emits no invalidation',async()=>{
  const f=fixture();assert.equal(await f.ready(),true);const first=f.adapter.current('read'),notifications=f.invalidations.length;
  assert.equal(await f.ready(),true);assert.equal(f.adapter.current('read'),first);assert.equal(f.invalidations.length,notifications);
  await f.adapter.read(period);assert.equal(f.adapter.current('read'),first);assert.equal(f.invalidations.length,notifications);
});

test('ready with changed source binding invalidates exactly the prior bound UI reference',async()=>{
  const f=fixture();await f.ready();const first=f.adapter.current('read'),notifications=f.invalidations.length;
  f.bindings.fish='c'.repeat(64);assert.equal(await f.ready(),true);assert.notEqual(f.adapter.current('read'),first);
  assert.equal(f.invalidations.length,notifications+1);
});

for(const initial of ['fish','todas',undefined])test('prepareSelection resolves manager Aristo from genuine session despite initial '+initial,async()=>{
  const f=fixture({state:session('aristo')});assert.equal(await f.adapter.prepareSelection(initial),'aristo');
  assert.equal(f.refreshes.length,1);assert.equal(f.calls.length,0);assert.equal(f.adapter.current('read'),'');
  await assert.rejects(f.adapter.read(period),{code:'AFFILIATE_READ_NOT_READY'});
});

test('prepareSelection Master preserves an admitted UI choice or defaults to fish, with no business lookup/grant',async()=>{
  const s=session();s.user={...s.user,role:'superadmin',brandAccess:'all',brand:null,brands:['fish','aristo']};const f=fixture({state:s});
  assert.equal(await f.adapter.prepareSelection('aristo'),'aristo');assert.equal(await f.adapter.prepareSelection('fish'),'fish');
  for(const requested of ['todas','olivas',undefined])assert.equal(await f.adapter.prepareSelection(requested),'fish');
  assert.equal(f.calls.length,0);assert.equal(f.adapter.current('read'),'');
});

test('prepareSelection uses refreshed session, never an earlier manager brand',async()=>{
  const f=fixture({refresh:async f=>{f.state=session('aristo');}});
  assert.equal(await f.adapter.prepareSelection('fish'),'aristo');assert.equal(f.calls.length,0);assert.equal(f.adapter.current('read'),'');
});

test('prepareSelection denied/invalid session returns null; refresh failure is finite and no data lookup occurs',async()=>{
  for(const change of [s=>s.authenticated=false,s=>s.features.affiliateRead=false,s=>delete s.user.id,s=>s.user.brands=['fish','aristo']]){
    const state=session();change(state);const f=fixture({state});assert.equal(await f.adapter.prepareSelection('fish'),null);assert.equal(f.calls.length,0);
  }
  const f=fixture({refresh:async()=>{throw Error('synthetic-private-error');}});
  await assert.rejects(f.adapter.prepareSelection('fish'),{code:'AFFILIATE_SESSION_UNCONFIRMED'});assert.equal(f.calls.length,0);
});

test('prepareSelection new effective session invalidates bound data without creating a new READ binding',async()=>{
  const f=fixture();await f.ready();const old=f.adapter.current('read');f.state=session('aristo');
  assert.equal(await f.adapter.prepareSelection('fish'),'aristo');assert.equal(f.adapter.current('read'),'');assert.equal(f.calls.length,1);
  assert.equal(f.adapter.reject('read',old),false);
});

test('actual guard follows one newer CSRF refresh before a POST, without false 401 or replay',async()=>{
 const guard=fs.readFileSync(path.join(process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),'public/guard.compiled.js'),'utf8');
 const old=deferred(),state=session(),calls=[],location={origin:'https://dash.synthetic.invalid',href:'https://dash.synthetic.invalid/influs.html'};let realm,sessionReads=0;
 const reply=data=>{const r=new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});r.json=async()=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(data))+')',realm);return r;};
 const nativeFetch=async(url,options)=>{calls.push({url:String(url),options});if(String(url)==='/auth/session'){sessionReads++;return sessionReads===1?old.promise:reply(state);}return reply({ok:true});};
 const window={fetch:nativeFetch,dispatchEvent(){},open(){}};window.parent=window;
 realm=vm.createContext({window,location,document:{querySelectorAll(){return[];},body:{dataset:{}},addEventListener(){}},navigator:{},URL,Headers,Request,Response,FormData,URLSearchParams,CustomEvent,AbortController,setTimeout,clearTimeout,HTMLFormElement:class{}});
 new vm.Script(guard).runInContext(realm);
 const work=window.fetch('/api/influ',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao:'listar',...period})});
 const selected=await window.ShrigmaAffiliateAccess.prepareSelection('fish');assert.equal(selected,'fish');old.resolve(reply(state));const result=await work;
 assert.equal(result.status,200);const posts=calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].options.headers.get('X-CSRF-Token'),'synthetic-csrf');assert.equal(sessionReads,2);
});
