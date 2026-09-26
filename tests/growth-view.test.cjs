'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync(require.resolve('../growth-view.js'),'utf8');
const manager={schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',allowedPanels:['growth']};
const master={schema:'shrigma_access_identity_v1',role:'master',panel:'todos',allowedPanels:['cx','growth','organico','influs']};
const response=body=>({ok:true,status:200,json:async()=>body});
const deferred=()=>{let done;const promise=new Promise(r=>done=r);return {promise,done};};
function boot({credential='synthetic-growth-key',fetcher=async()=>response(manager),sessionReady=false,sessionKey=''}={}){
 const {document,window}=parseHTML('<html><body><div id="crm-view-controls" hidden><select id="crm-view-select"><option value="manager">Visão da gerência CRM</option><option value="owner">Visão do dono</option></select></div><form id="draft"><input value="conteúdo não salvo"></form><iframe id="preview"></iframe></body></html>');
 const select=document.getElementById('crm-view-select');let selected='manager';
 Object.defineProperty(select,'value',{configurable:true,get:()=>selected,set:v=>{selected=v;}});
 const calls=[],timers=new Map(),storage=new Map([['journal','uncertain-original']]),state={dirty:true,pending:'original-operation',caps:['draft'],actor:'same-actor'};
 let sequence=0;
 const ctx=vm.createContext({document,window,URL,AbortController,Promise,console,CX_API_URL:'https://fixture.invalid/identity',
  shrigmaChave:area=>area==='growth'?credential:'',GrowthAccess:{ready:()=>sessionReady,current:()=>sessionKey},
  fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);},
  setTimeout:(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;},clearTimeout:id=>timers.delete(id),
  localStorage:{getItem:k=>storage.get(k),setItem:()=>{assert.fail('view must not write storage');},removeItem:()=>{assert.fail('view must not remove storage');}},
  GB:{state},SHRIGMA_OPERATOR_SESSION:{growth:{caps:state.caps,label:'same-label'}}});
 vm.runInContext(source,ctx);
 const api=vm.runInContext('GrowthView',ctx);
 return {api,document,window,select,calls,timers,storage,state,controls:document.getElementById('crm-view-controls'),
  setKey:k=>{credential=k;},setSession:(ready,k)=>{sessionReady=ready;sessionKey=k;},
  toggle:value=>{select.value=value;select.dispatchEvent(new window.Event('change'));}};
}
test('master is confirmed once per key; toggling changes only presentation and preserves open work',async()=>{
 const x=boot({fetcher:async()=>response(master)}),form=x.document.getElementById('draft'),iframe=x.document.getElementById('preview'),before=JSON.stringify(x.state);
 const pending=x.api.init();assert.equal(x.document.body.dataset.crmView,'manager');assert.equal(x.controls.hidden,true);await pending;
 assert.equal(x.controls.hidden,false);assert.equal(x.select.disabled,false);assert.equal(x.api.current(),'manager');
 x.toggle('owner');assert.equal(x.document.body.dataset.crmView,'owner');
 await x.api.init();await x.api.resolve();x.window.dispatchEvent(new x.window.Event('shrigma:access-ready'));await Promise.resolve();
 assert.equal(x.api.current(),'owner');assert.equal(x.calls.length,1);
 x.toggle('manager');assert.equal(x.api.current(),'manager');assert.equal(x.calls.length,1);
 assert.equal(x.document.getElementById('draft'),form);assert.equal(x.document.getElementById('preview'),iframe);assert.equal(form.querySelector('input').value,'conteúdo não salvo');
 assert.equal(JSON.stringify(x.state),before);assert.equal(x.storage.get('journal'),'uncertain-original');
 const call=x.calls[0],url=new URL(call.url);assert.equal(url.searchParams.get('access'),'1');assert.equal(url.searchParams.get('painel'),'growth');assert.equal(url.searchParams.has('k'),false);
 assert.equal(call.options.headers.Authorization,'Bearer synthetic-growth-key');assert.equal(call.options.method,undefined);assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');assert.equal(x.timers.size,0);
});
test('manager, malformed or foreign identities cannot enable owner view even through a forced change event',async()=>{
 for(const value of [manager,null,{}, {...master,schema:'other'}, {...master,panel:'growth'}, {...master,allowedPanels:['growth']}, {...master,allowedPanels:['cx','growth','organico','growth']}, {...master,allowedPanels:['cx','growth','organico','influs','extra']}, {...manager,panel:'cx',allowedPanels:['cx']}, {...manager,role:'owner'}, {...manager,owner:'master',permissions:{growth:{caps:['master','draft']}}}]){
  const x=boot({fetcher:async()=>response(value)});await x.api.init();x.toggle('owner');
  assert.equal(x.api.current(),'manager');assert.equal(x.document.body.dataset.crmView,'manager');assert.equal(x.controls.hidden,true);assert.equal(x.select.disabled,true);assert.equal(x.calls.length,1);
 }
});
test('no key makes no request; a ready Growth session is authoritative and cannot fall back to an older key',async()=>{
 const x=boot({credential:''});await x.api.init();assert.equal(x.calls.length,0);assert.equal(x.api.current(),'manager');
 x.setKey('synthetic-old-key');x.setSession(true,'');await x.api.resolve();assert.equal(x.calls.length,0);
 x.setSession(true,'synthetic-session-key');await x.api.resolve();assert.equal(x.calls.length,1);assert.equal(x.calls[0].options.headers.Authorization,'Bearer synthetic-session-key');
});
test('network, denial, invalid JSON and unavailable responses fail closed without repeating that key',async()=>{
 for(const fetcher of [async()=>{throw Error('private transport text');},async()=>({ok:false,status:403}),async()=>({ok:false,status:502}),async()=>({ok:true,status:200,json:async()=>{throw Error('invalid JSON');}})]){
  const x=boot({fetcher});await x.api.init();await x.api.resolve();x.toggle('owner');assert.equal(x.api.current(),'manager');assert.equal(x.controls.hidden,true);assert.equal(x.calls.length,1);assert.equal(x.timers.size,0);assert.doesNotMatch(x.document.body.textContent,/private transport/);
 }
});
test('ten-second deadline covers both fetch and JSON body even when cancellation is ignored',async()=>{
 for(const fetcher of [()=>new Promise(()=>{}),async()=>({ok:true,status:200,json:()=>new Promise(()=>{})})]){
  const x=boot({fetcher}),pending=x.api.init();await Promise.resolve();await Promise.resolve();
  const timer=[...x.timers.values()][0];assert.equal(timer.ms,10000);timer.fn();await pending;
  assert.equal(x.calls[0].options.signal.aborted,true);assert.equal(x.controls.hidden,true);assert.equal(x.api.current(),'manager');assert.equal(x.timers.size,0);await x.api.resolve();assert.equal(x.calls.length,1);
 }
});
test('late master response from an old key cannot override a newer manager identity',async()=>{
 const first=deferred(),second=deferred();const x=boot({fetcher:(url,o)=>o.headers.Authorization.endsWith('synthetic-growth-key')?first.promise:second.promise});
 const a=x.api.init();x.setKey('synthetic-new-key');const b=x.api.resolve();second.done(response(manager));await b;first.done(response(master));await a;
 assert.equal(x.calls.length,2);assert.equal(x.controls.hidden,true);assert.equal(x.api.current(),'manager');
});
test('changing a key while its response is pending or after owner selection immediately fails closed on use',async()=>{
 const old=deferred(),x=boot({fetcher:()=>old.promise}),pending=x.api.init();x.setKey('synthetic-new-key');old.done(response(master));await pending;
 assert.equal(x.controls.hidden,true);assert.equal(x.api.current(),'manager');assert.equal(x.calls.length,1);
 const y=boot({fetcher:async()=>response(master)});await y.api.init();y.toggle('owner');y.setKey('synthetic-new-key');y.toggle('owner');
 assert.equal(y.api.current(),'manager');assert.equal(y.controls.hidden,true);assert.equal(y.calls.length,1);
});
test('access-ready discovers a newly available key while repeated initialization keeps a single listener',async()=>{
 const x=boot({credential:'',fetcher:async()=>response(master)});await x.api.init();await x.api.init();x.setKey('synthetic-arriving-key');
 x.window.dispatchEvent(new x.window.Event('shrigma:access-ready'));await x.api.resolve();assert.equal(x.calls.length,1);assert.equal(x.controls.hidden,false);assert.equal(x.api.current(),'manager');
 x.toggle('owner');x.setKey('');await x.api.resolve();assert.equal(x.controls.hidden,true);assert.equal(x.api.current(),'manager');assert.equal(x.document.body.dataset.crmView,'manager');
});
