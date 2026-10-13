'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom'),L=require('../growth-journey-lab.js'),UI=require('../growth-journey-lab-ui.js');
function fixture(values=new Map(),{allow=true,onSource,withLock}={}){
 const {document,window}=parseHTML('<main id="host"></main>'),host=document.getElementById('host');
 Object.defineProperty(window.HTMLInputElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(v){this.toggleAttribute('checked',Boolean(v))}});
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||''},set(v){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(v))}});
 const calls=[],storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v))},session={authenticated:true,user:{id:'synthetic-account',brands:['fish','aristo'],permissions:{growth:{read:allow}}}};let count=0;
 const fetchImpl=async(url,options)=>{calls.push({url,method:options.method});let data;if(url==='/auth/session')data=JSON.parse(JSON.stringify(session));else{const brand=new URL(url,'https://synthetic.invalid').searchParams.get('marca');if(url.includes('fluxos_capacidade'))data={contract:'crm-published-journey-read-v1',brand,read:true,readOnly:true,write:false};else{onSource?.(session);data={checked_at:'2026-10-13T03:30:00Z',flows:[{brand,key:brand+':carrinho',name:'Carrinho',version:6,published_version:6,published:{steps:[{channel:'email',wait_min:60,enabled:true,template_name:'Email one'},{channel:'email',wait_min:1440,enabled:true,template_name:'Email two'}]}}]};}}return {ok:true,json:async()=>data};};
 const app=UI.create({host,engine:L,storage,fetchImpl,uuid:()=>String(++count),now:()=>0,...(withLock?{withLock}:{})});app.sync({brand:'aristo',section:'regua',tab:'lab'});return {app,host,window,values,calls,session,q:s=>host.querySelector(s)};
}
test('real controls duplicate, edit, save and reopen the local draft without any POST',async()=>{
 const f=fixture();await f.app.read();f.q('[data-lab-copy]').click();assert.match(f.host.textContent,/Cópia de teste criada/);f.q('[data-lab-name]').value='Cópia ajustada';f.q('[data-lab-step="0"] [data-lab-wait]').value='30';f.q('[data-lab-save]').click();assert.match(f.host.textContent,/revisão 2/);assert.equal(f.q('[data-lab-name]').value,'Cópia ajustada');
 const reopened=fixture(f.values);await reopened.app.read();assert.equal(reopened.q('[data-lab-name]').value,'Cópia ajustada');assert.equal(reopened.q('[data-lab-step="0"] [data-lab-wait]').value,'30');assert(f.calls.every(c=>c.method==='GET'));assert(reopened.calls.every(c=>c.method==='GET'));
});
test('saved run survives UI recreation and an uncertain step cannot repeat',async()=>{
 const f=fixture();await f.app.read();f.q('[data-lab-copy]').click();f.q('[data-lab-start]').click();f.q('[data-lab-result]').value='uncertain';f.q('[data-lab-advance="60"]').click();assert.match(f.host.textContent,/Incerto · sem nova tentativa/);assert.match(f.host.textContent,/Envios reais: 0/);
 const reopened=fixture(f.values);await reopened.app.read();reopened.q('[data-lab-advance="1440"]').click();const s=L.readStore([...f.values.values()][0]);assert.equal(s.runs[0].attempts.length,1);assert.equal(s.runs[0].status,'uncertain');assert.equal(s.runs[0].realSends,0);
});
test('brand change has a separate draft namespace and cannot show the previous brand',async()=>{
 const f=fixture();await f.app.read();f.q('[data-lab-copy]').click();f.q('[data-lab-name]').value='Aristo only';f.q('[data-lab-save]').click();f.app.sync({brand:'fish',section:'regua',tab:'lab'});assert(!f.host.textContent.includes('Aristo only'));await f.app.read();assert.equal(f.q('[data-lab-name]'),null);f.q('[data-lab-copy]').click();assert.match(f.host.textContent,/Fishermans/);assert.equal(f.values.size,2);
});
test('denied READ never queries the published definition or creates a draft',async()=>{
 const f=fixture(new Map(),{allow:false});await f.app.read();assert.equal(f.calls.length,1);assert.equal(f.q('[data-lab-copy]').disabled,true);assert.equal(f.values.size,0);assert.match(f.host.textContent,/Nenhuma régua foi alterada/);
});
test('corrupt local journal is preserved and does not become a clean retry',async()=>{
 const values=new Map([['shrigma:journey-lab:v1:synthetic-account:aristo','corrupt']]),f=fixture(values);await f.app.read();assert.match(f.host.textContent,/conteúdo guardado foi preservado/);assert.equal(f.q('[data-lab-copy]').disabled,true);assert.equal(values.values().next().value,'corrupt');
});
test('failed session reread invalidates old controls but preserves saved bytes',async()=>{
 const f=fixture();await f.app.read();f.q('[data-lab-copy]').click();const before=[...f.values.values()][0];f.session.user.permissions.growth.read=false;await f.app.read();assert.equal(f.q('[data-lab-copy]').disabled,true);assert.equal(f.q('[data-lab-start]'),null);assert.equal(f.app.state().drafts,0);assert.equal([...f.values.values()][0],before);
});
test('session switch during source query cannot inherit the previous account journal',async()=>{
 const f=fixture(new Map(),{onSource:s=>{s.user.id='other-account'}});await f.app.read();assert.equal(f.q('[data-lab-copy]').disabled,true);assert.equal(f.app.state().drafts,0);assert.equal(f.values.size,0);assert.equal(f.calls.filter(c=>c.url==='/auth/session').length,2);
});
test('two tabs preserve an uncertainty and reject stale editor revision',async()=>{
 const values=new Map(),a=fixture(values);await a.app.read();a.q('[data-lab-copy]').click();const b=fixture(values);await b.app.read();a.q('[data-lab-start]').click();a.q('[data-lab-result]').value='uncertain';a.q('[data-lab-advance="60"]').click();b.q('[data-lab-name]').value='New draft';b.q('[data-lab-save]').click();let stored=L.readStore([...values.values()][0]);assert.equal(stored.runs[0].attempts.length,1);assert.equal(stored.runs[0].status,'uncertain');assert.equal(stored.drafts[0].revision,2);
 a.q('[data-lab-name]').value='Stale';a.q('[data-lab-save]').click();assert.match(a.host.textContent,/mudou em outra aba/);stored=L.readStore([...values.values()][0]);assert.equal(stored.drafts[0].name,'New draft');assert.equal(stored.runs[0].status,'uncertain');
});
test('trace limit is checked before writing and cannot erase valid local history',async()=>{
 const f=fixture();await f.app.read();f.q('[data-lab-copy]').click();f.q('[data-lab-start]').click();const key=[...f.values.keys()][0],s=L.readStore(f.values.get(key));s.runs[0].trace=Array.from({length:200},()=>({at:0,kind:'wait_data'}));const before=JSON.stringify(s);f.values.set(key,before);f.q('[data-lab-stale]').checked=true;f.q('[data-lab-advance="60"]').click();assert.equal(f.values.get(key),before);assert.match(f.host.textContent,/histórico anterior foi preservado/);
});
test('history reopens the entered revision and a repeated event never creates another run',async()=>{
 const f=fixture();await f.app.read();f.q('[data-lab-copy]').click();f.q('[data-lab-start]').click();f.q('[data-lab-result]').value='uncertain';f.q('[data-lab-advance="60"]').click();let saved=L.readStore([...f.values.values()][0]);const first=saved.runs[0].eventId;
 f.q('[data-lab-name]').value='New draft revision';f.q('[data-lab-save]').click();f.q('[data-lab-repeat]').click();saved=L.readStore([...f.values.values()][0]);assert.equal(saved.runs.length,1);assert.equal(saved.runs[0].draft.revision,1);assert.equal(saved.runs[0].attempts.length,1);
 f.q('[data-lab-start]').click();assert.equal(f.q('[data-lab-history]').querySelectorAll('option').length,2);f.q('[data-lab-history]').value=first;f.q('[data-lab-history]').dispatchEvent(new f.window.Event('change'));assert.match(f.host.textContent,/Incerto · sem nova tentativa/);assert.match(f.host.textContent,/revisão 1/);assert.equal(L.readStore([...f.values.values()][0]).runs.length,2);
});
