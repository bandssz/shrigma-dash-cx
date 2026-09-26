'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync(require.resolve('../crm-entry.js'),'utf8');
const page=()=>fs.readFileSync(require.resolve('../crm/index.html'),'utf8');
function boot(identity,{fetchImpl}={}){
 const {document}=parseHTML(page()),events={},posts=[],calls=[],map=new Map([['shrigma_campaign_journal','pending-preserved']]);
 const loc=new URL('https://crm.example.test/crm/');
 const ctx=vm.createContext({document,location:loc,URL,AbortController,Promise,Error,console,
  CX_API_URL:'https://api.example.test/read',
  localStorage:{removeItem:k=>map.delete(k)},
  setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>2,clearInterval:()=>{},
  window:{addEventListener:(name,fn)=>events[name]=fn},
  fetch:async(url,options)=>{calls.push({url,options});return fetchImpl?fetchImpl(url,options):{status:200,ok:true,json:async()=>identity};}});
 vm.runInContext(source,ctx);
 return {document,events,calls,map,submit:async()=>{document.getElementById('entry-key').value='synthetic-crm-key';await document.getElementById('entry-form').onsubmit({preventDefault(){}});},posts};
}
const manager={schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',allowedPanels:['growth'],owner:'Gestor CRM',permissions:{growth:{caps:['campaign_read'],label:'Gestor CRM'}}};
test('CRM uses only a typed key while other area login documents keep their contract',()=>{
 const {document}=parseHTML(page());assert.equal(document.querySelector('input[type=file]'),null);assert.equal(document.getElementById('entry-key').type,'password');
 assert.match(page(),/assets\/panels\/crm-entry\.js/);assert.doesNotMatch(source,/entry-file|\.files\b|\.text\(\)/);
 for(const area of ['cx','organico','creators','gestao']){const html=fs.readFileSync(require.resolve('../'+area+'/index.html'),'utf8');assert.match(html,/id="entry-file"/);assert.match(html,/assets\/panels\/entry\.js/);}
});
test('manager enters CRM without file controls; logout preserves pending business state',async()=>{
 const x=boot(manager);await x.submit();const d=x.document;
 assert.equal(d.getElementById('entry-login').hidden,true);assert.equal(d.getElementById('entry-nav').hidden,true);assert.equal(d.querySelector('iframe').title,'CRM');assert.equal(d.getElementById('entry-key').value,'');
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].options.headers.Authorization,'Bearer synthetic-crm-key');assert.equal(new URL(x.calls[0].url).searchParams.has('k'),false);
 d.getElementById('entry-logout').click();assert.equal(d.querySelector('iframe'),null);assert.equal(d.getElementById('entry-login').hidden,false);assert.equal(x.map.get('shrigma_campaign_journal'),'pending-preserved');
});
test('only server master identity provides area navigation; malformed or other-area identities cannot enter CRM',async()=>{
 const master={...manager,role:'master',panel:'todos',allowedPanels:['cx','growth','organico','influs']};const x=boot(master);await x.submit();assert.equal(x.document.getElementById('entry-nav').hidden,false);assert.equal(x.document.querySelectorAll('#entry-nav button').length,4);assert.equal(x.document.querySelector('iframe').title,'CRM');
 for(const i of [{...manager,panel:'cx',allowedPanels:['cx']},{...manager,role:'master'}, {...manager,allowedPanels:['growth','growth']}, {...manager,schema:'untrusted'}]){const bad=boot(i);await bad.submit();assert.equal(bad.document.querySelector('iframe'),null);assert.match(bad.document.getElementById('entry-message').textContent,/não tem acesso/);}
});
test('CRM retains the same bounded identity request as the shared entry',()=>{
 const shared=fs.readFileSync(require.resolve('../panel-entry.js'),'utf8');const read=s=>s.slice(s.indexOf(' async function readIdentity('),s.indexOf(" document.getElementById('entry-logout')"));assert.equal(read(source),read(shared));assert.match(source,/ACCESS_WAIT_MS=60000/);
});

test('cancelling the login prevents a late response from opening a session, even when abort is ignored',async()=>{
 for(const phase of ['fetch','body']){
  let reply;const deferred=new Promise(r=>reply=r),x=boot(manager,{fetchImpl:phase==='fetch'?()=>deferred:async()=>({status:200,ok:true,json:()=>deferred})});
  const pending=x.submit();await Promise.resolve();await Promise.resolve();x.document.getElementById('entry-cancel').click();
  assert.equal(x.calls[0].options.signal.aborted,true);reply(phase==='fetch'?{status:200,ok:true,json:async()=>manager}:manager);await pending;
  assert.equal(x.document.querySelector('iframe'),null);assert.equal(x.document.getElementById('entry-login').hidden,false);assert.match(x.document.getElementById('entry-message').textContent,/Espera cancelada/);assert.equal(x.map.get('shrigma_campaign_journal'),'pending-preserved');
 }
});
