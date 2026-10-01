'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync(require.resolve('../growth-view.js'),'utf8');
const manager={schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',allowedPanels:['growth']};
const master={schema:'shrigma_access_identity_v1',role:'master',panel:'todos',allowedPanels:['cx','growth','organico','influs']};
const response=body=>({ok:true,status:200,json:async()=>body});
const deferred=()=>{let done;const promise=new Promise(r=>done=r);return {promise,done};};
function boot({credential='synthetic-growth-key',fetcher=async()=>response(manager),sessionReady=false,sessionKey='',hydrate=false,embedded=false}={}){
 const {document,window}=parseHTML('<html><body><div id="crm-view-controls" hidden><select id="crm-view-select"><option value="manager">Visão da gerência CRM</option><option value="owner">Visão do dono</option></select></div><form id="draft"><input value="conteúdo não salvo"></form><iframe id="preview"></iframe></body></html>');
 const select=document.getElementById('crm-view-select');let selected='manager';
 Object.defineProperty(select,'value',{configurable:true,get:()=>selected,set:v=>{selected=v;}});
 const calls=[],timers=new Map(),storage=new Map([['journal','uncertain-original']]),state={dirty:true,pending:'original-operation',caps:['draft'],actor:'same-actor'};
 let sequence=0;const operators={growth:{caps:state.caps,label:'same-label'}},readKeys=new Map(),readyEvents=[];
 window.addEventListener('shrigma:operator-ready',()=>readyEvents.push(true));
 const ctx=vm.createContext({document,window,URL,AbortController,Promise,console,CRM_READ_API_URL:'https://fixture.invalid/crm-panel-read-v1',
  shrigmaChave:area=>area==='growth'?credential:'',GrowthAccess:{ready:()=>sessionReady,current:()=>sessionKey},
  fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);},
  setTimeout:(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;},clearTimeout:id=>timers.delete(id),
  localStorage:{getItem:k=>storage.get(k),setItem:()=>{assert.fail('view must not write storage');},removeItem:()=>{assert.fail('view must not remove storage');}},
  GB:{state},SHRIGMA_OPERATOR_SESSION:operators,SHRIGMA_EMBEDDED:embedded,
  ...(hydrate?{shrigmaGuardaChave:(area,k)=>readKeys.set(area,k)}:{})});
 vm.runInContext(source,ctx);
 const api=vm.runInContext('GrowthView',ctx);
 return {api,document,window,select,calls,timers,storage,state,operators,readKeys,readyEvents,controls:document.getElementById('crm-view-controls'),
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
 const call=x.calls[0],url=new URL(call.url);assert.equal(url.searchParams.get('action'),'identity');assert.equal(url.searchParams.get('painel'),'growth');assert.equal(url.searchParams.has('k'),false);
 assert.equal(call.options.headers.Authorization,'Bearer synthetic-growth-key');assert.equal(call.options.method,undefined);assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');assert.equal(x.timers.size,0);
});
const editable={...manager,permissions:{growth:{who:'panel:synthetic-manager',label:'Synthetic manager',caps:['read_content','draft','validate','submit','list_history','submission']}}};
test('direct identity installs only its validated grant, emits once and keeps work and credentials out of storage and URLs',async()=>{
 const x=boot({hydrate:true,fetcher:async()=>response(editable)}),before=JSON.stringify(x.state);
 await x.api.init();assert.deepEqual(Array.from(x.operators.growth.caps),[...editable.permissions.growth.caps]);assert.equal(x.readKeys.get('growth'),'synthetic-growth-key');
 await x.api.resolve();assert.equal(x.readyEvents.length,1);assert.equal(x.calls.length,1);assert.equal(JSON.stringify(x.state),before);assert.equal(x.storage.get('journal'),'uncertain-original');
 assert.equal(new URL(x.calls[0].url).searchParams.has('k'),false);
 x.setKey('');await x.api.resolve();assert.equal(x.operators.growth,undefined);assert.equal(x.storage.get('journal'),'uncertain-original');
});
test('foreign identity or malformed permission cannot install a direct operator grant',async()=>{
 const p=editable.permissions.growth;
 for(const identity of [{...editable,panel:'cx',allowedPanels:['cx']},...[
  {...p,who:'synthetic-manager'},{...p,who:'panel:bad actor'},{...p,label:''},{...p,label:'bad\u0000label'},
  {...p,caps:['draft','draft']},{...p,caps:['draft','owner']},{...p,extra:true},null
 ].map(value=>({...editable,permissions:{growth:value}}))]){
  const x=boot({hydrate:true,fetcher:async()=>response(identity)});delete x.operators.growth;await x.api.init();
  assert.equal(x.operators.growth,undefined);assert.equal(x.readKeys.size,0);assert.equal(x.readyEvents.length,0);
 }
});
test('a late old credential cannot grant editing to the next direct read-only session',async()=>{
 const old=deferred(),readOnly={...editable,permissions:{growth:{...editable.permissions.growth,caps:['read_content']}}};
 const x=boot({hydrate:true,fetcher:(_u,o)=>o.headers.Authorization.endsWith('synthetic-growth-key')?old.promise:Promise.resolve(response(readOnly))});
 delete x.operators.growth;const pending=x.api.init();x.setKey('synthetic-readonly-key');await x.api.resolve();old.done(response(editable));await pending;
 assert.deepEqual(Array.from(x.operators.growth.caps),['read_content']);assert.equal(x.readKeys.get('growth'),'synthetic-readonly-key');assert.equal(x.readyEvents.length,1);
});
test('embedded identity resolution preserves the parent-owned permission object across key changes',async()=>{
 const x=boot({hydrate:true,embedded:true,fetcher:async()=>response(editable)}),parent=x.operators.growth;
 await x.api.init();x.setKey('synthetic-new-key');await x.api.resolve();x.setKey('');await x.api.resolve();
 assert.equal(x.operators.growth,parent);assert.equal(x.readKeys.size,0);assert.equal(x.readyEvents.length,0);
});
test('explicit retry recovers a failed identity once; late timed-out JSON cannot install editing',async()=>{
 const late=deferred();let attempt=0;const x=boot({hydrate:true,fetcher:async()=>++attempt===1?{ok:true,status:200,json:()=>late.promise}:response(editable)});delete x.operators.growth;
 const pending=x.api.init();await Promise.resolve();await Promise.resolve();[...x.timers.values()][0].fn();await pending;
 assert.equal(x.operators.growth,undefined);await x.api.resolve();assert.equal(x.calls.length,1);
 await x.api.resolve({retry:true});assert.equal(x.calls.length,2);assert.equal(x.operators.growth.label,'Synthetic manager');
 const granted=x.operators.growth;late.done({...editable,permissions:{growth:{...editable.permissions.growth,label:'Late discarded'}}});await Promise.resolve();await Promise.resolve();
 assert.equal(x.operators.growth,granted);assert.equal(x.readyEvents.length,1);
});
test('a valid identity without its direct permission can recover only on an explicit retry',async()=>{
 let attempt=0;const x=boot({hydrate:true,fetcher:async()=>response(++attempt===1?manager:editable)});delete x.operators.growth;
 await x.api.init();await x.api.resolve();assert.equal(x.calls.length,1);assert.equal(x.operators.growth,undefined);
 await x.api.resolve({retry:true});assert.equal(x.calls.length,2);assert.equal(x.operators.growth.label,'Synthetic manager');assert.equal(x.readyEvents.length,1);
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
