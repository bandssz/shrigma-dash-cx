'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const service=path.resolve(__dirname,'../services/dashboard-operational');
const {sessionBrandScope}=require(path.join(service,'public/entry.js'));
const {bindOperationalBrand}=require(path.join(service,'build.cjs'));
const manager=brand=>({role:'manager',email:'person@synthetic.invalid',areas:['growth'],permissions:{growth:{read:true,edit:true}},brand,brands:[brand],brandAccess:'single'});
const master={role:'superadmin',email:'owner@synthetic.invalid',areas:['growth','organico','influs'],permissions:{growth:{read:true,edit:false}},brand:null,brands:['fish','aristo'],brandAccess:'all'};
const session=user=>({authenticated:true,user,uiKey:'ui-'+'a'.repeat(32),csrf:'c'.repeat(43),features:{}});
function dom(html){
 const {document,window}=parseHTML(html);window.HTMLElement.prototype.focus=function(){};
 // linkedom does not implement native multi-select selectedness. Preserve
 // independent options in this fixture, as browsers do for select[multiple].
 Object.defineProperty(window.HTMLOptionElement.prototype,'selected',{configurable:true,get(){return this.hasAttribute('selected');},set(value){if(value&&!this.parentElement?.hasAttribute('multiple'))for(const o of this.parentElement?.querySelectorAll('option')||[])o.removeAttribute('selected');this.toggleAttribute('selected',Boolean(value));}});
 for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===String(value));}});
 return {document,window,$:id=>document.getElementById(id)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('CRM visual preview is explicit and preserves brand, screen and period through navigation and exit',()=>{
 const root=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||service,source=fs.readFileSync(path.join(root,'public/crm-preview/app.js'),'utf8'),html=fs.readFileSync(path.join(root,'public/crm-preview/index.html'),'utf8');
 for(const ui of [null,'other','previa']){
  const d=dom(html),urls=[],params=new URLSearchParams({brand:'aristo',view:'audiences',channel:'email'});if(ui)params.set('ui',ui);
  const context={document:d.document,window:{},location:{pathname:'/app/crm/',search:'?'+params},history:{replaceState(a,b,url){urls.push(url);}},URLSearchParams};
  vm.runInNewContext(source.slice(0,source.indexOf('function crmAllowed'))+'\ncrmPeriod={get:()=>({ini:"2026-10-01",fim:"2026-10-16",preset:"thisMonth"})};crmPersist();crmState.brand="fish";crmState.view="home";crmPersist();',context);
  const last=new URL(urls.at(-1),'https://synthetic.invalid');assert.equal(last.searchParams.get('brand'),'fish');assert.equal(last.searchParams.get('view'),'home');assert.equal(last.searchParams.get('ini'),'2026-10-01');
  if(ui==='previa'){
   assert.equal(d.document.documentElement.dataset.crmUi,'previa');assert.equal(last.searchParams.get('ui'),'previa');assert.equal(d.document.querySelectorAll('.crm-preview-banner').length,1);assert.match(d.document.querySelector('.crm-preview-banner').textContent,/dados reais.*salvas no CRM/);
   const exit=new URL(d.$('crm-preview-exit').getAttribute('href'),'https://synthetic.invalid');assert.equal(exit.searchParams.has('ui'),false);for(const key of ['brand','view','ini','fim','preset','channel'])assert.equal(exit.searchParams.get(key),last.searchParams.get(key));
   const logo=new URL(d.document.querySelector('.workspace-logo').getAttribute('href'),'https://synthetic.invalid');assert.equal(logo.searchParams.get('ui'),'previa');assert.equal(logo.searchParams.get('brand'),'fish');assert.equal(logo.searchParams.get('view'),'home');
   context.Event=d.window.Event;vm.runInNewContext('let crmDraftUI=null;crmState.abDirty=true;const click=new Event("click",{cancelable:true});document.getElementById("crm-preview-exit").dispatchEvent(click);globalThis.held=click.defaultPrevented;',context);assert.equal(context.held,true);assert.match(d.$('crm-context-note').textContent,/Salve ou descarte/);
  }else{assert.equal(d.document.documentElement.dataset.crmUi,undefined);assert.equal(d.document.querySelector('.crm-preview-banner'),null);assert.equal(last.searchParams.has('ui'),false);assert.equal(d.document.querySelector('.workspace-logo').getAttribute('href'),'./');}
 }
});
async function settle(check){for(let i=0;i<30;i++){if(check())return;await tick();}assert.fail('Synthetic UI did not settle');}

test('presentation requires an exact single-brand corporate grant and preserves master all',()=>{
 assert.deepEqual(sessionBrandScope(master),{brand:null,brands:['fish','aristo'],brandAccess:'all'});
 for(const brand of ['fish','aristo'])assert.deepEqual(sessionBrandScope(manager(brand)),{brand,brands:[brand],brandAccess:'single'});
 for(const user of [{...manager('fish'),brand:null,brands:[],brandAccess:'reprovision_required'},{...manager('fish'),brands:['fish','aristo']},{...manager('fish'),brands:['aristo']},{...manager('fish'),brand:'unknown',brands:['unknown']},{...master,brand:'fish'},{...master,brands:['fish','fish']},{...master,brandAccess:'single'}])assert.equal(sessionBrandScope(user),null);
});

test('actual admin form requires brand and submits email, sector and direct read/edit choice without granting unverified native edit',async()=>{
 for(const [area,brand,requestedAccess] of [['growth','fish','read'],['growth','aristo','edit'],['organico','fish','edit'],['organico','aristo','read'],['influs','fish','read'],['influs','aristo','edit'],['afiliados','fish','read'],['afiliados','aristo','edit']]){
  const d=dom(fs.readFileSync(path.join(service,'public/entry.html'),'utf8'));d.document.body.dataset.accessPanel='todos';
  const backendArea=area==='afiliados'?'influs':area;
  const calls=[],hosts={growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
  d.window.localStorage={removeItem(){},getItem(){return null;}};d.window.sessionStorage={removeItem(){}};
  const fetch=async(url,options={})=>{calls.push({url,body:options.body&&JSON.parse(options.body)});const payload=url==='/auth/session'?{...session(master),areaHosts:hosts}:options.method==='POST'?{inviteUrl:'https://'+hosts[backendArea]+'/#invite='+'i'.repeat(32)}:{users:[]};return new Response(JSON.stringify(payload),{status:options.method==='POST'?201:200});};
  const context={document:d.document,window:d.window,location:{hash:'',pathname:'/',search:'',origin:'https://gerencial.synthetic.invalid'},history:{replaceState(){}},fetch,URL,URLSearchParams,Headers,AbortController,Response,setTimeout,clearTimeout,navigator:{}};
  vm.runInNewContext(fs.readFileSync(path.join(service,'public/entry.js'),'utf8'),context);await settle(()=>d.$('entry-shell').hidden===false);
  d.$('admin-email').value=' PERSON@SYNTHETIC.INVALID ';d.$('admin-area').value=area;d.$('admin-access').value=requestedAccess;
  d.$('admin-invite-form').dispatchEvent(new d.window.Event('submit',{cancelable:true}));await tick();assert.equal(calls.some(v=>v.body?.action==='invite'),false);assert.match(d.$('admin-message').textContent,/Escolha a marca/);
  d.$('admin-brand').value=brand;d.$('admin-invite-form').dispatchEvent(new d.window.Event('submit',{cancelable:true}));await settle(()=>calls.some(v=>v.body?.action==='invite')&&d.$('admin-invite-form').getAttribute('aria-busy')==='false');
  const body=calls.find(v=>v.body?.action==='invite').body;assert.deepEqual(body,{action:'invite',email:'person@synthetic.invalid',brands:[brand],productFront:area,role:'manager',areas:[backendArea],permissions:{[backendArea]:{read:true,edit:false}},requestedAccess});
  assert.match(d.$('admin-message').textContent,new RegExp('Convite com '+(requestedAccess==='edit'?'Edição':'Leitura')+' criado'));assert.doesNotMatch(d.$('admin-message').textContent,/solicitar edição|aprovação adicional/i);assert.equal(d.$('admin-brand').value,'');assert.equal(d.$('admin-invite-result').hidden,false);assert.equal(d.$('admin-brand').disabled,false);
 }
});

function guardFixture(user,{status=200,body={ok:true},simpleRead=false,sessionPending=false}={}){
 const d=dom('<html><body><div id="seg-marca"><button data-marca="todas">Todas</button><button data-marca="fish">Fishermans</button><button data-marca="aristo">Aristocrata</button><button data-marca="olivas">Olivas</button></div></body></html>');
 const calls=[],requests=[],messages=[],events=[],window={parent:{postMessage:(...v)=>messages.push(v)},dispatchEvent:event=>events.push(event),fetch:async(url,options)=>{calls.push(String(url));requests.push({url:String(url),options});if(url==='/auth/session'&&sessionPending)return new Promise(()=>{});if(url==='/auth/session')return new Response(JSON.stringify({...session(user),features:{simpleRead}}),{status:200});assert.ok(window.ShrigmaBrandAccess,'scope is resolved before API response');return new Response(JSON.stringify(body),{status});}};
 const context={window,document:d.document,location:{origin:'https://crm.synthetic.invalid',href:'https://crm.synthetic.invalid/growth.html'},navigator:{},setTimeout:sessionPending?(fn=>{queueMicrotask(fn);return 1;}):setTimeout,clearTimeout:sessionPending?(()=>{}):clearTimeout,URL,URLSearchParams,Headers,Response,Request,FormData,CustomEvent:d.window.CustomEvent,HTMLFormElement:d.window.HTMLFormElement};
 vm.runInNewContext(fs.readFileSync(path.join(service,'public/guard.compiled.js'),'utf8'),context);
 return {...d,calls,requests,messages,events,window};
}

test('guard applies own-brand UI before API response, master retains Consolidada and Olivas; missing grant never reaches API',async()=>{
 for(const brand of ['fish','aristo']){const f=guardFixture(manager(brand));assert.equal((await f.window.fetch('/api/cx?painel=growth')).status,200);assert.deepEqual([...f.document.querySelectorAll('#seg-marca button')].map(b=>b.dataset.marca),[brand]);assert.equal(f.document.querySelector('button').disabled,true);assert.equal(f.events[0].detail.brand,brand);assert.equal(f.calls.length,2);}
 const all=guardFixture(master);assert.equal((await all.window.fetch('/api/cx?painel=growth')).status,200);assert.equal(all.document.querySelectorAll('button').length,4);assert.equal(all.document.querySelector('[data-marca="olivas"]').disabled,false);
 const old=guardFixture({...manager('fish'),brand:null,brands:[],brandAccess:'reprovision_required'});assert.equal((await old.window.fetch('/api/cx?painel=growth')).status,401);assert.deepEqual(old.calls,['/auth/session']);
});

test('brand contract failures emit closed human-readable notice metadata without echoing backend body',async()=>{
 for(const code of ['BRAND_READ_CONTRACT_NOT_READY','BRAND_RESPONSE_UNSCOPED']){const f=guardFixture(manager('fish'),{status:code==='BRAND_RESPONSE_UNSCOPED'?502:503,body:{error:code,private:'private-canary'}});const response=await f.window.fetch('/api/cx?painel=growth');assert.equal(response.status,code==='BRAND_RESPONSE_UNSCOPED'?502:503);assert.deepEqual(JSON.parse(JSON.stringify(f.messages[0][0])),{type:'shrigma:brand-read-unavailable',code});assert.doesNotMatch(JSON.stringify(f.messages),/private-canary/);}
});

test('operational transform resets a stale other-brand preference inside each panel lexical scope without modifying legacy HTML',()=>{
 const definitions={growth:{anchor:"let API=null,MARCA='todas',CANAL='todos',SEC='visao',METRICA='receita',CMP=true,LOADING=false;",result:'if(API)render();'},organico:{anchor:"let API=null,MARCA='todas',PER=G.preset('mes',HOJE),CMP=true,SEC='grade',AGREG='semana',FILTRO='todos';",result:'if(API)render();'},influs:{anchor:"let MARCA='todas', SEC='creators';",result:"if(typeof INFLU!=='undefined'&&INFLU)renderTudo();"}};
 const bundle=fs.readFileSync(path.resolve(service,'../../assets/panels/growth.js'),'utf8');
 const start=bundle.indexOf('const CRMWorkspace='),end=bundle.indexOf(';typeof module',start);
 assert.ok(start>=0&&end>start,'the fixture requires the actual compiled workspace');
 const workspace=bundle.slice(start,end)+';';
 for(const [area,{anchor}]of Object.entries(definitions)){
  let handler;
  const labels=new Map(['crm-brand-label','crm-active-brand'].map(id=>[id,{textContent:'Todas as marcas'}]));
  const document={body:{dataset:{}},getElementById:id=>labels.get(id)||null,querySelectorAll:()=>[]};
  const context=vm.createContext({window:{addEventListener:(name,cb)=>{assert.equal(name,'shrigma:brand-access');handler=cb;}},document,G:{preset:()=>({})},HOJE:'2026-10-04',pintaMarca(){},render(){},renderTudo(){}});
  if(area==='growth')vm.runInContext(workspace,context);
  vm.runInContext(bindOperationalBrand(anchor,area+'.html')+'\nglobalThis.currentBrand=()=>MARCA;',context);
  handler({detail:{brandAccess:'single',brand:'aristo'}});assert.equal(context.currentBrand(),'aristo');
  if(area==='growth'){
   for(const id of ['crm-brand-label','crm-active-brand'])assert.equal(labels.get(id).textContent,'O Aristocrata');
   assert.equal(document.body.dataset.crmSection,'visao');
  }
  handler({detail:{brandAccess:'all',brand:null}});assert.equal(context.currentBrand(),'aristo');
  handler({detail:{brandAccess:'single',brand:'olivas'}});assert.equal(context.currentBrand(),'aristo');
  if(area==='growth')for(const id of ['crm-brand-label','crm-active-brand'])assert.equal(labels.get(id).textContent,'O Aristocrata');
  assert.equal(bindOperationalBrand(anchor,'cx.html'),anchor);assert.throws(()=>bindOperationalBrand(anchor+anchor,area+'.html'),/contract changed/);
 }
});

test('actual compiled campaign editor presents only its corporate brand and refuses a forged switch without I/O',async()=>{
 const {createCampaignEditor}=require(path.join(service,'public/campaign-edit.compiled.js'));
 for(const own of ['fish','aristo']){
  const d=dom(fs.readFileSync(path.join(service,'public/entry.html'),'utf8')),dialog=d.$('entry-campaign-dialog');dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};
  const calls=[],s={...session(manager(own)),features:{campaignSubmitWrite:true,campaignCreate:false}},controller=createCampaignEditor({document:d.document,getSession:()=>s,storage:{getItem(){return null;},setItem(){}},locks:{request:async(name,opt,fn)=>fn({name})},createClient:()=>({}),request:async q=>{calls.push(q);assert.equal(q.method,'GET');const u=new URL(q.path,'https://synthetic.invalid');assert.equal(u.searchParams.get('brand'),own);return {status:200,body:u.searchParams.get('acao')==='campanha_catalogo'?{brand:own,current:true,lists:[],templates:[]}:{campaigns:[]}};}});
  assert.equal(await controller.open(),true);assert.deepEqual([...d.$('campaign-brand').querySelectorAll('option')].map(o=>o.value),[own]);assert.equal(d.$('campaign-brand').disabled,true);const before=calls.length;
  const injected=d.document.createElement('option');injected.value=own==='fish'?'aristo':'fish';injected.textContent='Other';d.$('campaign-brand').append(injected);d.$('campaign-brand').value=injected.value;d.$('campaign-brand').dispatchEvent(new d.window.Event('change'));await tick();assert.equal(calls.length,before);assert.equal(d.$('campaign-brand').value,own);assert.match(d.$('campaign-status').textContent,/vinculado à sua marca/);controller.close();
 }
 const d=dom(fs.readFileSync(path.join(service,'public/entry.html'),'utf8'));let calls=0;const old=createCampaignEditor({document:d.document,getSession:()=>({...session(manager('fish')),user:{...manager('fish'),brand:null,brands:[],brandAccess:'reprovision_required'},features:{campaignSubmitWrite:true}}),request:async()=>{calls++;},storage:{getItem(){return null;},setItem(){}},createClient:()=>({})});assert.equal(await old.open(),false);assert.equal(calls,0);
});

test('central form selects all three brands and submits a single scoped invitation',async()=>{
 const d=dom(fs.readFileSync(path.join(service,'public/entry.html'),'utf8'));d.document.body.dataset.accessPanel='todos';
 const calls=[],hosts={growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
 d.window.localStorage={removeItem(){},getItem(){return null;}};d.window.sessionStorage={removeItem(){}};
 const fetch=async(url,o={})=>{const body=o.body&&JSON.parse(o.body);calls.push({url,body});return new Response(JSON.stringify(url==='/auth/session'?{...session({...master,viewBrands:['fish','aristo','olivas']}),areaHosts:hosts}:o.method==='POST'?{inviteUrl:'https://'+hosts.influs+'/#invite='+'i'.repeat(32)}:{users:[]}),{status:o.method==='POST'?201:200});};
 vm.runInNewContext(fs.readFileSync(path.join(service,'public/entry.compiled.js'),'utf8'),{document:d.document,window:d.window,location:{hash:'',pathname:'/',search:'',origin:'https://gerencial.synthetic.invalid'},history:{replaceState(){}},fetch,URL,URLSearchParams,Headers,AbortController,Response,setTimeout,clearTimeout,navigator:{}});
 await settle(()=>d.$('entry-shell').hidden===false);d.$('admin-email').value='three@synthetic.invalid';d.$('admin-area').value='afiliados';d.$('admin-access').value='edit';
 d.$('admin-brand-all').click();assert.deepEqual([...d.$('admin-brand').querySelectorAll('option')].filter(o=>o.selected).map(o=>o.value),['fish','aristo','olivas']);
 d.$('admin-invite-form').dispatchEvent(new d.window.Event('submit',{cancelable:true}));await settle(()=>calls.some(c=>c.body?.action==='invite'));
 const sent=calls.filter(c=>c.body?.action==='invite');assert.equal(sent.length,1);assert.deepEqual(sent[0].body.brands,['fish','aristo','olivas']);assert.equal(sent[0].body.productFront,'afiliados');assert.equal(Object.hasOwn(sent[0].body,'brand'),false);assert.equal(sent[0].body.permissions.influs.edit,false);
 assert.deepEqual(sessionBrandScope({...manager('fish'),brand:null,brands:['fish','aristo','olivas'],brandAccess:'multiple'}),{brand:null,brands:['fish','aristo','olivas'],brandAccess:'multiple'});
});

test('multi-brand guard keeps only delegated selectors and carries the chosen brand only on aggregate GET',async()=>{
 const f=guardFixture({...manager('fish'),brand:null,brands:['fish','olivas'],brandAccess:'multiple'});
 await f.window.fetch('/api/cache?painel=growth');assert.deepEqual([...f.document.querySelectorAll('#seg-marca button')].map(b=>b.dataset.marca),['fish','olivas']);
 assert.equal(f.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),'fish');
 f.document.querySelector('[data-marca="olivas"]').classList.add('ativo');await f.window.fetch('/api/cache?painel=growth');assert.equal(f.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),'olivas');
 await f.window.fetch('/api/templates?acao=templates_listar&brand=fish');assert.equal(f.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),null);
 await f.window.fetch('/api/cache',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}});assert.equal(f.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),null);
 const m=guardFixture({...master,viewBrands:['fish','aristo','olivas']});await m.window.fetch('/api/cache?painel=growth');assert.equal(m.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),null);m.document.querySelector('[data-marca="olivas"]').classList.add('ativo');await m.window.fetch('/api/cache?painel=growth');assert.equal(m.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),'olivas');
});

test('simple Master selects a concrete brand for cache and CRM reads while legacy keeps aggregation',async()=>{
 const f=guardFixture(master,{simpleRead:true});await f.window.fetch('/api/crm-read?action=cache_growth&painel=growth');
 assert.equal(f.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),'fish');assert.equal(f.window.ShrigmaSimpleRead,true);assert.equal(f.document.querySelector('[data-marca="todas"]'),null);
 f.document.querySelector('[data-marca="aristo"]').classList.add('ativo');await f.window.fetch('/api/cache?painel=organico');assert.equal(f.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),'aristo');
 const legacy=guardFixture(master);await legacy.window.fetch('/api/crm-read?action=cache_growth&painel=growth');assert.equal(legacy.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),null);
});

test('first read resolves the real session and concrete brand before any source call',async()=>{
 const f=guardFixture(master,{simpleRead:true});assert.equal(f.window.ShrigmaSimpleRead,undefined);assert.equal(await f.window.ShrigmaPrepareRead(),true);assert.equal(f.window.ShrigmaSimpleRead,true);assert.equal(f.events[0].detail.brand,'fish');assert.deepEqual(f.calls,['/auth/session']);
 await f.window.fetch('/api/crm-read?action=cache_growth&painel=growth');assert.equal(f.requests.at(-1).options.headers.get('X-Shrigma-View-Brand'),'fish');assert.equal(f.calls.filter(x=>x==='/auth/session').length,1);
});

test('pending session reaches the preparation deadline without querying a source',async()=>{
 const f=guardFixture(master,{simpleRead:true,sessionPending:true});assert.equal(await f.window.ShrigmaPrepareRead(),false);assert.deepEqual(f.calls,['/auth/session']);assert.equal(f.window.ShrigmaSimpleRead,undefined);
});
