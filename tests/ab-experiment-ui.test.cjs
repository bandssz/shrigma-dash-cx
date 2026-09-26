'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const UI=require('../growth-ab-experiment-ui.js'),Client=require('../growth-ab-experiment-client.js'),{setup}=require('./ab-experiment-api-fixture.cjs'),{uuid}=require('./ab-experiment-fixture.cjs');
async function fixture(brand='fish'){
 const x=await setup(),{document,window}=parseHTML('<html><body><div id="root"></div></body></html>'),values=new Map(),calls=[];let key='manager',busy=false,n=7000;
 // Linkedom omits the browser's select.value setter. Use actual option selection.
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const f={...x,document,window,values,calls,brand,setKey:k=>key=k,failRead:false,loseReceipt:false,storageFailure:false};
 f.storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>{if(f.storageFailure)throw Error('storage');values.set(k,v);}};
 const locks={request:async(k,o,fn)=>{if(busy)return fn(null);busy=true;try{return await fn({});}finally{busy=false;}}};
 f.client=(opts={})=>Client.create({brand,endpoint:'https://synthetic.invalid/ab',getKey:()=>key,locks,storage:f.storage,uuid:()=>uuid(++n),fetch:async(url,init)=>{
  const p=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams),method=p.method,access=p.k||init.headers['X-AB-Write-Key'];delete p.method;delete p.k;calls.push({method,verb:init.method});
  if(f.failRead&&['list','get'].includes(method))throw Error('read unavailable');if(method==='mutate'&&f.beforeMutate)await f.beforeMutate();const r=await x.api(method,p,access);
  if(f.loseReceipt&&method==='operation'&&r.body.operation.state==='completed')throw Error('lost receipt');return {status:r.status,json:async()=>r.body};
 },...Object.fromEntries(Object.entries(opts).filter(([,v])=>v!==undefined))});
 f.enable=()=>x.db.exec("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9',verified_at=now()");
 f.protocol=()=>x.protocol(brand,brand==='fish'?1:2);
 f.mount=()=>{f.ui?.destroy();f.clientInstance=f.client();f.ui=UI.mount({element:document.querySelector('#root'),brand,client:f.clientInstance,storage:f.storage,getKeyIdentity:()=>key,uuid:()=>uuid(brand==='fish'?1:2),reviewer:{pending:()=>false,consult:async()=>{},review:async p=>Object.fromEntries(await Promise.all(p.arms.map(async a=>[a.arm,(await x.db.query('SELECT fixture_audience_review($1) v',[a.campaign_id])).rows[0].v.audience.review_id])))}});const dialog=document.querySelector('dialog');dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');return f.ui;};
 f.q=s=>document.querySelector(s);f.posts=()=>calls.filter(c=>c.verb==='POST').length;
 f.prepared=async()=>{await f.enable();const p=await f.protocol(),c=f.client(),r=await c.mutate(p,p);await c.apply(r.operation_id,()=>true);values.set('shrigma_ab_experiment_draft_v2:'+brand,JSON.stringify({version:1,brand,draft:null,selected_id:p.test_id}));f.mount();await f.ui.ready;return p;};
 return f;
}
const ev={preventDefault(){}};
async function form(f){const p=await f.protocol();f.q('[data-abx-new]').onclick();for(const [name,value]of Object.entries({name:p.name,hypothesis:p.hypothesis,a:p.arms[0].campaign_id,b:p.arms[1].campaign_id,window_hours:24,minimum_per_arm:10,minimum_effect_pp:1}))f.q(`[name="${name}"]`).value=value;f.q('[data-abx-form]').oninput();return p;}
test('Fish and Aristo show brand/counts/effect in human confirmation; cancel is zero writes and schedule is one exact operation',async()=>{
 for(const brand of ['fish','aristo']){const f=await fixture(brand);try{
  await f.prepared();await f.q('[data-abx-review]').onclick();assert.equal(f.ui.state.review.arms.length,2);const before=f.posts();
  let pending=f.q('[data-abx-schedule]').onclick();assert.ok(f.q('dialog').hasAttribute('open'));const text=f.q('[data-abx-confirm-text]').textContent;assert.ok(text.includes(brand==='fish'?'Fishermans':'O Aristocrata'));assert.match(text,/500 pessoas elegíveis de 500 alocadas/);assert.match(text,/mensagens poderão ser enviadas/);assert.equal(f.ui.contextStatus().blocked,true);
  f.q('[data-abx-no]').onclick();await pending;assert.equal(f.posts(),before);assert.equal(f.ui.state.selected.state,'prepared');
  pending=f.q('[data-abx-schedule]').onclick();f.q('[data-abx-yes]').onclick();f.q('[data-abx-yes]').onclick();await pending;assert.equal(f.posts(),before+1);assert.equal(f.ui.state.selected.state,'scheduled');assert.equal(f.clientInstance.inspect().pending,null);
 }finally{f.ui?.destroy();await f.db.close();}}
});
test('lost receipt survives reload; another selection or refresh cannot cause POST and recovery restores exactly once',async()=>{
 const f=await fixture();try{
  await f.enable();f.mount();await f.ui.ready;await form(f);f.loseReceipt=true;
  const pending=f.q('[data-abx-form]').onsubmit(ev);f.q('[data-abx-yes]').onclick();await pending;assert.equal(f.posts(),1);assert.equal(f.clientInstance.inspect().pending.phase,'unknown');const id=f.clientInstance.inspect().pending.id;
  f.mount();await f.ui.ready;assert.equal(f.ui.contextStatus().pending,true);assert.equal(f.q('[data-abx-new]').disabled,true);assert.equal(f.q('[data-abx-select]').disabled,true);await f.ui.refresh();assert.equal(f.posts(),1);
  await f.q('[data-abx-recover]').onclick();assert.equal(f.posts(),1);assert.equal(f.clientInstance.inspect().pending.id,id);f.loseReceipt=false;
  await f.q('[data-abx-recover]').onclick();assert.equal(f.posts(),1);assert.equal(f.clientInstance.inspect().pending,null);assert.equal(f.ui.state.selected.state,'prepared');assert.equal(f.ui.state.dirty,false);
 }finally{f.ui?.destroy();await f.db.close();}
});
test('draft survives failed reads/reload and failed discard; changed access or another tab cancels confirmation before mutation',async()=>{
 const f=await fixture();try{
  await f.enable();f.mount();await f.ui.ready;await form(f);const saved=f.values.get('shrigma_ab_experiment_draft_v2:fish');f.failRead=true;await f.ui.refresh();assert.equal(f.values.get('shrigma_ab_experiment_draft_v2:fish'),saved);assert.equal(f.ui.state.dirty,true);
  f.mount();await f.ui.ready;assert.equal(f.ui.state.draft.name,JSON.parse(saved).draft.name);f.failRead=false;await f.ui.refresh();
  let pending=f.q('[data-abx-form]').onsubmit(ev);f.setKey('rotated');f.q('[data-abx-yes]').onclick();await pending;assert.equal(f.posts(),0);assert.match(f.ui.state.error,/acesso.*mudou/);
  pending=f.q('[data-abx-form]').onsubmit(ev);const event=new f.window.Event('storage');event.key='shrigma_ab_experiment_draft_v2:fish';f.window.dispatchEvent(event);f.q('[data-abx-yes]').onclick();await pending;assert.equal(f.posts(),0);assert.equal(f.ui.state.dirty,true);
  f.mount();await f.ui.ready;f.storageFailure=true;pending=f.q('[data-abx-discard]').onclick();f.q('[data-abx-yes]').onclick();await pending;assert.equal(f.ui.state.dirty,true);assert.equal(f.ui.state.draft.name,JSON.parse(saved).draft.name);assert.equal(f.values.get('shrigma_ab_experiment_draft_v2:fish'),saved);
 }finally{f.ui?.destroy();await f.db.close();}
});
test('OFF, missing confirmation UI and corrupt local draft never mutate or discard retained bytes',async()=>{
 const f=await fixture();try{
  f.mount();await f.ui.ready;assert.equal(f.q('[data-abx-new]').disabled,true);assert.match(f.q('#root').textContent,/não está habilitado/);assert.equal(f.posts(),0);
  await f.enable();await f.ui.refresh();await form(f);delete f.q('dialog').showModal;await f.q('[data-abx-form]').onsubmit(ev);assert.equal(f.posts(),0);assert.match(f.ui.state.error,/não abriu/);
  f.values.set('shrigma_ab_experiment_draft_v2:fish','{bad');f.mount();await f.ui.ready;assert.equal(f.q('[data-abx-new]').disabled,true);assert.equal(f.values.get('shrigma_ab_experiment_draft_v2:fish'),'{bad');assert.equal(f.posts(),0);
 }finally{f.ui?.destroy();await f.db.close();}
});
test('standard campaign reviewer only validates exact saved variants, honors pending state and never schedules/sends',async()=>{
 const calls=[];let held=false,key='manager';
 // The fixture's real immutable protocol is enough; no recipient data leaves SQL.
 const f=await fixture();try{const cfg=await f.protocol();let current;
 const client={locked:()=>held,reopen:async id=>{calls.push(['reopen',id]);const a=cfg.arms.find(a=>a.campaign_id===id);current={id,version:a.expected_version,definition:{brand:'fish'}};return {campaign:current};},validate:async d=>{calls.push(['validate',d.brand]);return {validation:{audience:{review_id:uuid(current.id),campaign_id:current.id,campaign_version:current.version}}};},consult:async()=>calls.push(['consult'])};
 const r=UI.createCampaignReviewer({client,guard:()=>true,preserve:()=>true,getKeyIdentity:()=>key});assert.deepEqual(await r.review(cfg),{a:uuid(100),b:uuid(101)});assert.equal(calls.length,4);held=true;await assert.rejects(r.review(cfg),/pendente/);await r.consult();assert.deepEqual(calls.at(-1),['consult']);
 }finally{await f.db.close();}
});
test('composition stays OFF by default, uses only current manager access and preserves active UI across root renders',()=>{
 const Panel=require('../growth-ab-experiment-panel.js'),calls=[],element={hidden:false};let key='manager',current={blocked:false,dirty:false,pending:false};
 const campaign={locked:()=>false},view={contextStatus:()=>current,preserve:()=>calls.push('preserve-ab'),destroy:()=>calls.push('destroy')};
 const adapter=Panel.create({getManagerKey:()=>key,restoreBrand:()=>true,campaignContext:{status:()=>({}),preserve:()=>calls.push('preserve-campaign')},campaignAPI:{caps:()=>({endpoint:'https://synthetic.invalid/campaign',brands:['fish','aristo'],read:true,validate:true,operation:true}),createClient:opts=>{calls.push(opts);return campaign;}},experimentClient:{create:opts=>{calls.push(opts);return {inspect:()=>({pending:null})}; }},experimentUI:{createCampaignReviewer:opts=>{calls.push(opts);return {};},mount:opts=>{calls.push(opts);return view;}}});
 assert.equal(adapter.render({element,marca:'fish'}),null);assert.equal(element.hidden,true);assert.equal(calls.length,0);
 adapter.render({element,marca:'fish',activation:{enabled:true,endpoint:'https://synthetic.invalid/ab'}});assert.equal(element.hidden,false);assert.equal(calls[1].writeKey(),'manager');assert.equal(calls[0].getKey(),'manager');key='rotated';assert.equal(calls[1].writeKey(),'rotated');
 current.blocked=true;assert.equal(adapter.render({element,marca:'aristo',activation:{enabled:true,endpoint:'https://changed.invalid/ab'}}),view);assert.equal(calls.length,4);assert.equal(adapter.destroy(),false);
 assert.equal(adapter.render({element,marca:'fish'}),view,'routine render cannot replace a pending same-brand panel');assert.equal(calls.length,4);
});
test('leaving a supported brand hides the previous view, preserves durable state and remounts Fish; pending work blocks that transition',()=>{
 const Panel=require('../growth-ab-experiment-panel.js');
 for(const unsupported of ['todas','olivas']){
  const element={hidden:true},stored=new Map([['journal','immutable-receipt']]),calls=[];let current={};
  const view={contextStatus:()=>current,preserve:()=>assert.fail('No draft write on a clean brand transition'),destroy:()=>calls.push('unmount')};
  const adapter=Panel.create({getManagerKey:()=> 'manager',restoreBrand:()=>true,storage:{getItem:k=>stored.get(k),setItem:()=>assert.fail('Journal must not change'),removeItem:()=>assert.fail('Journal must not clear')},campaignContext:{status:()=>({}),preserve(){}},campaignAPI:{caps:()=>({endpoint:'https://synthetic.invalid/campaign',brands:['fish','aristo'],read:true,validate:true,operation:true}),createClient:()=>({})},experimentClient:{create:()=>({inspect:()=>({pending:null})})},experimentUI:{createCampaignReviewer:()=>({}),mount:({brand})=>{calls.push(brand);return view;}}});
  const activation={enabled:true,endpoint:'https://synthetic.invalid/ab'};
  adapter.render({element,marca:'aristo',activation});current={pending:true};assert.equal(adapter.render({element,marca:unsupported,activation}),view);assert.deepEqual(calls,['aristo']);
  current={};assert.equal(adapter.render({element,marca:unsupported,activation}),null);assert.equal(element.hidden,true);assert.deepEqual(calls,['aristo','unmount']);
  adapter.render({element,marca:'fish',activation});assert.equal(element.hidden,false);assert.deepEqual(calls,['aristo','unmount','fish']);assert.equal(stored.get('journal'),'immutable-receipt');
 }
});

test('defined prepare rejection preserves the original campaign versions after reload; refresh never silently adopts newer content',async()=>{
 const f=await fixture();try{
  await f.enable();f.mount();await f.ui.ready;await form(f);const before=JSON.parse(f.values.get('shrigma_ab_experiment_draft_v2:fish'));
  f.beforeMutate=()=>f.db.exec('UPDATE crm_ab_runtime_v2 SET enabled=false');const attempt=f.q('[data-abx-form]').onsubmit(ev);f.q('[data-abx-yes]').onclick();await attempt;
  assert.equal(f.posts(),1);assert.equal(f.clientInstance.inspect().pending,null);assert.equal(f.ui.state.dirty,true);f.beforeMutate=null;
  f.mount();await f.ui.ready;assert.deepEqual(f.ui.state.draft.campaign_versions,before.draft.campaign_versions);
  await f.db.exec("UPDATE campaigns SET subject='New content' WHERE id=100");await f.enable();await f.ui.refresh();await f.q('[data-abx-form]').onsubmit(ev);
  assert.equal(f.posts(),1);assert.match(f.ui.state.error,/versão.*mudou/);assert.deepEqual(f.ui.state.draft.campaign_versions,before.draft.campaign_versions);
 }finally{f.ui?.destroy();await f.db.close();}
});

test('reload or an already-mounted Aristo page restores pending Fish before receipt GET/apply, without a second POST',async()=>{
 for(const mode of ['reload','other-tab']){const f=await fixture('fish');try{
  await f.enable();const p=await f.protocol();let receipt;
  if(mode==='reload')receipt=await f.client().mutate(p,p);
  const otherDraft=JSON.stringify({opaque:'Aristo preparation stays untouched'});f.values.set('unrelated-campaign-preparation:aristo',otherDraft);
  const Panel=require('../growth-ab-experiment-panel.js');let header='aristo',preserved=0;
  const adapter=Panel.create({experimentClient:{create:opts=>f.client(opts)},experimentUI:UI,getManagerKey:()=> 'manager',restoreBrand:(b,why)=>{assert.equal(why.operation_id,receipt.operation_id);header=b;return true;},storage:f.storage,campaignContext:{status:()=>({}),preserve:()=>preserved++},campaignAPI:{caps:()=>({endpoint:'https://synthetic.invalid/campaign',brands:['fish','aristo'],read:true,validate:true,operation:true}),createClient:()=>({locked:()=>false,reopen:async()=>{},validate:async()=>{},consult:async()=>{}})}});
  const args={element:f.q('#root'),marca:'aristo',activation:{enabled:true,endpoint:'https://synthetic.invalid/ab'}};
  let view=adapter.render(args);f.ui=view;await view.ready;
  if(mode==='other-tab'){assert.equal(view.state.brand,'aristo');receipt=await f.client().mutate(p,p);await view.refresh();await f.q('[data-abx-recover]').onclick();view=adapter.render({...args,marca:header});f.ui=view;await view.ready;}
  assert.equal(header,'fish');assert.equal(view.state.brand,'fish');assert.match(f.q('#root').textContent,/Fishermans/);assert.equal(preserved,1);assert.equal(adapter.contextStatus().pending,true);
  await f.q('[data-abx-recover]').onclick();assert.equal(f.posts(),1);assert.equal(adapter.contextStatus().pending,false);assert.equal(view.state.selected.test_id,p.test_id);assert.equal(view.state.selected.brand,'fish');assert.equal(f.values.get('unrelated-campaign-preparation:aristo'),otherDraft);
  assert.equal(f.client().inspect().operations[0].id,receipt.operation_id);assert.deepEqual(f.client().inspect().operations[0].request_payload,p);
 }finally{f.ui?.destroy();await f.db.close();}}
});

test('transport deficit is explained without claiming a detected crash or removing legitimate optouts from the denominator',async()=>{
 const f=await fixture();try{
  const p=await f.prepared();await f.db.exec(`UPDATE crm_ab_experiment_v2 SET state='scheduled',transport_bound=true,tracking_continuous=true,window_start=now()-interval '25 hours',window_end=now()-interval '1 hour';SELECT set_config('shrigma.ab_schedule_v2','${p.test_id}',false);UPDATE campaigns SET status='finished',sent=CASE id WHEN 100 THEN 500 ELSE 499 END WHERE id IN(100,101);SELECT set_config('shrigma.ab_schedule_v2','',false);UPDATE crm_ab_arm_v2 SET finished_at=now()-interval '2 hours'`);
  await f.ui.refresh();assert.equal(f.ui.state.result.reason,'transport_not_fully_accounted');assert.equal(f.ui.state.result.winner,null);const heading=[...f.q('[data-abx-detail]').querySelectorAll('h4')].find(h=>h.textContent==='Envios não comprovados · sem vencedora');assert.ok(heading);assert.match(heading.getAttribute('title'),/contagem de envios.*Descadastros legítimos.*não confirma falha/);assert.match(heading.getAttribute('aria-label'),/Envios não comprovados.*Descadastros legítimos/);assert.doesNotMatch(f.q('[data-abx-detail]').textContent,/Descadastros legítimos|transporte|processo/);assert.deepEqual(f.ui.state.result.arms.map(a=>a.allocated),[500,500]);
 }finally{f.ui?.destroy();await f.db.close();}
});
