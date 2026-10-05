'use strict';
// Production compiled browser-shell proof. Real DOM and exact compiled scripts; all fetches
// terminate in synthetic session data or the local campaign core/provider.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {parseHTML}=require('linkedom');
const ROOT=path.resolve(__dirname,'..');
const {originFixture}=require(path.join(ROOT,'tests/dashboard-operational-campaign-submit.test.cjs'));
const PUB=path.join(ROOT,'services/dashboard-operational/public');
const CAPS=['read_content','draft','validate','submit'];
const copy=v=>JSON.parse(JSON.stringify(v));
const projection=c=>({id:c.id,version:c.version,status:c.status,sent:c.sent,startedAt:c.started_at,sendAt:c.send_at});
async function until(check,label){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)assert.fail('Shell did not settle: '+label);await new Promise(resolve=>setImmediate(resolve));}for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));}
function shell({requested='growth',role='manager',areas=['growth'],feature=true,edit=true,brand='fish',userPatch={}}={}){
  const html=fs.readFileSync(path.join(PUB,'entry.html'),'utf8').replaceAll('__PANEL__',requested).replaceAll('__LABEL__','Synthetic shell');
  const {document,window:domWindow}=parseHTML(html),calls=[],values=new Map(),locks=[];
  const stamp=Date.parse('2026-10-03T12:00:00Z'),origin=originFixture(()=>stamp),receipts=new Map();
  const state={authenticated:true,uiKey:'ui-'+ '1'.repeat(32),csrf:'c'.repeat(43),user:{id:'11111111-1111-4111-8111-111111111111',email:'shell@synthetic.invalid',role,areas,brand:role==='superadmin'?null:brand,brands:role==='superadmin'?['fish','aristo']:[brand],brandAccess:role==='superadmin'?'all':'single',permissions:{growth:{read:true,edit},organico:{read:true,edit:false},influs:{read:true,edit:false}}},features:{audienceDraft:false,...(feature?{campaignSubmitWrite:true}:{})}};
  state.user={...state.user,...userPatch};
  if(role==='superadmin')state.areaHosts={growth:'crm.shell.synthetic.invalid',organico:'organico.shell.synthetic.invalid',influs:'influs.shell.synthetic.invalid'};
  let focus=document.body;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focus});
  domWindow.HTMLElement.prototype.focus=function(){focus=this;};
  Object.defineProperty(domWindow.HTMLInputElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(v){this.toggleAttribute('checked',Boolean(v));}});
  for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(v){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===String(v));}});
  const dialog=document.getElementById('entry-campaign-dialog');
  Object.defineProperty(dialog,'open',{configurable:true,get:()=>dialog.hasAttribute('open')});
  dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.dispatchEvent(new domWindow.Event('close'));};
  class ClockDate extends Date{constructor(...args){super(...(args.length?args:[stamp]));}static now(){return stamp;}}
  const originUrl='https://'+(requested==='todos'?'manager':requested==='organico'?'organico':'crm')+'.shell.synthetic.invalid';
  const context={document,location:new URL(originUrl+'/'),history:{replaceState(){}},navigator:{locks:{request(name,options,callback){locks.push(name);return Promise.resolve(callback({name,mode:'exclusive'}));}},clipboard:{writeText:async()=>{}}},localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},sessionStorage:{getItem:()=>null,removeItem(){}},Date:ClockDate,URL,URLSearchParams,Headers,AbortController,TextEncoder,Event:domWindow.Event,crypto:crypto.webcrypto,setTimeout,clearTimeout,confirm:()=>false,addEventListener:domWindow.addEventListener.bind(domWindow)};
  context.window=context;context.parent=context;
  const sandbox=vm.createContext(context);
  function response(status,body){return {status,ok:status>=200&&status<300,async json(){sandbox.__encoded=JSON.stringify(body);try{return vm.runInContext('JSON.parse(__encoded)',sandbox);}finally{delete sandbox.__encoded;}}};}
  context.fetch=async(value,options={})=>{
    const url=new URL(value,originUrl),method=options.method||'GET',headers=new Headers(options.headers),body=options.body===undefined?undefined:JSON.parse(options.body);
    assert.equal(url.origin,originUrl);assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(headers.has('authorization'),false);
    calls.push({method,path:url.pathname+url.search,headers:Object.fromEntries(headers),body});
    if(url.pathname==='/auth/session'){assert.equal(method,'GET');return response(200,state);}
    assert.equal(headers.get('x-csrf-token'),state.csrf);
    if(url.pathname==='/auth/campaign-delivery'){
      assert.equal(method,'GET');const row=receipts.get(url.searchParams.get('idempotency_key'));return row?response(200,row):response(404,{error:'NOT_FOUND'});
    }
    assert.equal(url.pathname,'/api/campaigns');
    const command=method==='POST'?body:Object.fromEntries(url.searchParams);if(method==='GET'&&command.id!==undefined)command.id=Number(command.id);
    const result=await origin.service.handle({actor:'panel:dcrmw-'+ '1'.repeat(32),caps:CAPS},command);
    if(method==='GET')return response(result.status,result.body);
    assert.equal(result.status,200);
    const v=result.body.validation,dto={schema:'crm-campaign-bff-operation-v1',action:command.acao,attemptKey:command.idempotency_key,state:'succeeded',campaign:projection(result.body.campaign),validation:v?{policy:v.policy,version:v.version,ok:v.ok,validatedAt:v.validated_at,audience:v.audience}:null};
    receipts.set(command.idempotency_key,dto);return response(200,dto);
  };
  const scripts=[...document.querySelectorAll('script[src]')].map(n=>n.getAttribute('src'));
  assert.deepEqual(scripts,['/campaign-bff-client.js','/campaign-edit.js','/entry.js']);
  const publicNames={'/campaign-bff-client.js':'campaign-bff-client.js','/campaign-edit.js':'campaign-edit.compiled.js','/entry.js':'entry.compiled.js'};
  for(const script of scripts)vm.runInContext(fs.readFileSync(path.join(PUB,publicNames[script]),'utf8'),sandbox,{filename:publicNames[script],timeout:1000});
  assert.equal(typeof sandbox.ShrigmaCampaignBffClient.createCampaignBffClient,'function');assert.equal(typeof sandbox.ShrigmaCampaignEdit.createCampaignEditor,'function');
  for(const name of ['KEY','VERSION','ACTIONS','createCampaignEditor','inviteUrlForArea','readOnlyStyles'])assert.equal(Object.hasOwn(sandbox,name),false,'IIFE must keep helper bindings private');
  return {document,window:domWindow,dialog,origin,calls,values,locks,state,element:id=>document.getElementById(id),input(id,value){const el=document.getElementById(id);el.value=value;el.dispatchEvent(new domWindow.Event('input',{bubbles:true}));},confirm(){const el=document.getElementById('campaign-confirm');el.checked=true;el.dispatchEvent(new domWindow.Event('change',{bubbles:true}));}};
}

test('compiled browser shell exposes the gated dialog and carries CSRF through all four actions',async()=>{
  const s=shell();await until(()=>!s.element('entry-shell').hidden,'manager shell');
  assert.equal(s.state.user.brandAccess,'single');assert.equal(s.element('entry-brand').textContent,'Fishermans');
  assert.equal(s.element('entry-campaign-open').hidden,false);s.element('entry-campaign-open').click();
  await until(()=>s.dialog.open&&!s.element('campaign-validate').disabled,'open existing draft');
  s.input('campaign-subject','Compiled browser subject');
  for(const [action,effect]of [['save','save'],['validate','validate'],['schedule','schedule'],['cancel','cancel']]){
    if(action==='schedule'||action==='cancel')s.confirm();
    assert.equal(s.element('campaign-'+action).disabled,false,action+' must be available');s.element('campaign-'+action).click();
    await until(()=>s.origin.effects[effect]===1&&!s.element('campaign-consult').disabled,action+' completed');
  }
  assert.deepEqual(s.origin.effects,{save:1,validate:1,schedule:1,cancel:1,create:0});
  const posts=s.calls.filter(c=>c.method==='POST');assert.equal(posts.length,4);assert.equal(new Set(posts.map(c=>c.body.idempotency_key)).size,4);
  assert.ok(s.calls.filter(c=>c.path.startsWith('/api/campaigns')).every(c=>c.headers['x-csrf-token']===s.state.csrf));
  assert.ok(s.locks.every(name=>name==='shrigma-campaign-bff:'+s.state.uiKey+':fish'));
  s.element('campaign-close').click();assert.equal(s.dialog.open,false);assert.equal(s.document.activeElement.id,'entry-campaign-open');
});
for(const [label,args]of [
  ['OFF manager',{feature:false}],['read manager',{feature:false,edit:false}],['OFF superadmin',{requested:'todos',role:'superadmin',areas:['growth','organico','influs'],feature:false}],['read superadmin',{requested:'todos',role:'superadmin',areas:['growth','organico','influs'],edit:false}],['cross-area manager',{requested:'organico',areas:['organico']}]
])test('compiled shell keeps campaign writes closed for '+label,async()=>{
  const s=shell(args);await until(()=>!s.element('entry-shell').hidden,label+' shell');
  assert.equal(s.element('entry-brand').textContent,args.role==='superadmin'?'Visão gerencial · todas as marcas':'Fishermans');
  assert.equal(s.element('entry-campaign-open').hidden,true);s.element('entry-campaign-open').click();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(s.dialog.open,false);assert.equal(s.calls.filter(c=>c.path.startsWith('/api/')).length,0);assert.deepEqual(s.origin.effects,{save:0,validate:0,schedule:0,cancel:0,create:0});
});


test('compiled shell admits the server-enabled scoped MASTER without impersonating a manager',async()=>{
 const s=shell({requested:'todos',role:'superadmin',areas:['growth','organico','influs']});await until(()=>!s.element('entry-shell').hidden,'authorized MASTER shell');
 assert.equal(s.state.user.role,'superadmin');assert.equal(s.element('entry-brand').textContent,'Visão gerencial · todas as marcas');assert.equal(s.element('entry-campaign-open').hidden,false);
 s.element('entry-campaign-open').click();await until(()=>s.dialog.open&&!s.element('campaign-validate').disabled,'MASTER reads existing draft');
 assert.equal(s.element('campaign-brand').disabled,false);assert.deepEqual([...s.element('campaign-brand').querySelectorAll('option')].map(o=>o.value),['fish','aristo']);
 assert.equal(s.calls.some(c=>c.method==='POST'),false);assert.ok(s.calls.some(c=>c.path.includes('campanha_catalogo')&&c.path.includes('brand=fish')));
 assert.deepEqual(s.origin.effects,{save:0,validate:0,schedule:0,cancel:0,create:0});s.element('campaign-close').click();
});

test('compiled shell refuses forged MASTER brand or area scope before any campaign I/O',async()=>{
 for(const userPatch of [{brand:'fish'},{brandAccess:'single'},{brands:['fish']},{brands:['fish','fish']},{areas:['growth']},{areas:['growth','organico','organico']},{areas:['cx','growth','organico','influs']}]){
  const s=shell({requested:'todos',role:'superadmin',areas:['growth','organico','influs'],userPatch});await until(()=>s.calls.some(c=>c.path==='/auth/session'),'rejected MASTER session');
  assert.equal(s.element('entry-shell').hidden,true);assert.equal(s.element('entry-campaign-open').hidden,true);s.element('entry-campaign-open').click();await new Promise(r=>setImmediate(r));
  assert.equal(s.dialog.open,false);assert.equal(s.calls.some(c=>c.method==='POST'||c.path.startsWith('/api/')),false);assert.deepEqual(s.origin.effects,{save:0,validate:0,schedule:0,cancel:0,create:0});
 }
});
