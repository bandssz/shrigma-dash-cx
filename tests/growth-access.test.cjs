'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),A=require('../growth-access'),locks=require('./campaign-lock-fixture.cjs');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'growth.html'),'utf8');
const access=extra=>JSON.stringify({schema:'shrigma_panel_access_v1',panel:'growth',role:'read',key:'synthetic-reader',...extra});
function boot({legacy='',onRead=()=>{}}={}){
 const {document,window}=parseHTML(html.match(/<form id="growth-acesso"[\s\S]*?<\/form>/)[0]+'<button id="btn-atualizar">Atualizar</button><section id="campaign-composer"></section>');
 let focused=null;window.HTMLElement.prototype.focus=function(){if(!this.closest('fieldset')?.disabled)focused=this;};Object.defineProperty(document,'activeElement',{get:()=>focused});
 const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const store=new Map([['shrigma_tpl_key','synthetic-writer'],['shrigma_campaign_operation_v1:unrelated','preserve-exact']]),writes=[],calls=[],reads=[];
 if(legacy)store.set('shrigma_k_growth',legacy);
 const ctx=vm.createContext({document,window,console,Date,Intl,URL,URLSearchParams,AbortSignal,setTimeout,clearTimeout,navigator:{locks:locks()},confirm:()=>{throw Error('unexpected confirmation');},
  localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>{writes.push(k);store.set(k,v);},removeItem:k=>{writes.push(k);store.delete(k);}},
  shrigmaChave:()=>store.get('shrigma_k_growth')||'',GMP:{openEmail:()=>{}},__onRead:()=>{reads.push(true);return onRead();},
  fetch:async(url,init={})=>{calls.push({url,init});return {ok:true,status:200,json:async()=>({templates:[],events:[],flows:[]})};}});
 for(const f of ['growth-access.js','growth-templates-api.js','growth-drafts-ui.js','growth-control.js','growth-builder.js','campaign-contract.js','growth-campaign-api.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
 const run=s=>vm.runInContext(s,ctx),api=run('GrowthAccess.bind({document,readExisting:()=>shrigmaChave("growth"),onRead:__onRead})'),q=s=>document.querySelector(s);
 return {api,run,ctx,q,store,writes,calls,reads,document,window,focused:()=>focused,submit:()=>q('#growth-acesso').onsubmit({preventDefault(){}})};
}
const file=(x,text)=>{const f=x.q('#growth-acesso-arquivo');Object.defineProperty(f,'files',{configurable:true,value:[{size:typeof text==='string'?text.length:100,text:()=>typeof text==='function'?text():Promise.resolve(text)}]});return f.onchange();};
test('access file accepts only the exact Growth reader contract, not campaign JSON or writer/master roles',()=>{
 assert.deepEqual(A.parseFile(access()),{key:'synthetic-reader'});
 for(const p of [access({role:'write'}),access({role:'master'}),access({panel:'influs'}),access({author:'Operator'}),access({endpoint:'https://example.test'}),access({key:''}),access({key:'one two'}),'[]','null','{}','not json',' '.repeat(8193)])assert.throws(()=>A.parseFile(p));
});
test('transport errors cannot render a URL or credential; only fixed local error messages are exposed',()=>{
 const error=Error('GET https://fixture.test/?k=synthetic-secret failed');assert.doesNotMatch(A.readError(error),/synthetic-secret|fixture.test/);
 assert.match(A.readError({name:'TimeoutError'}),/demorou/);assert.equal(A.readError(Error('Consulta indisponível (HTTP 503).')),'Consulta indisponível (HTTP 503).');
});
test('file import is not authentication; explicit Enter reads once and never persists/promotes a new key',async()=>{
 let done;const x=boot({onRead:()=>new Promise(r=>done=r)});x.api.show();await file(x,access());assert.equal(x.api.current(),'');assert.equal(x.reads.length,0);assert.equal(x.focused(),x.q('#growth-chave'));
 const pending=x.submit();await x.submit();assert.equal(x.reads.length,1);assert.equal(x.api.current(),'synthetic-reader');assert.equal(x.run('GTA.chaveLeitura()'),'synthetic-reader');assert.equal(x.q('#growth-chave').value,'');assert.equal(x.q('#growth-acesso').hidden,true);assert.deepEqual(x.writes,[]);done();await pending;
 assert.equal(x.store.has('shrigma_k_mestre'),false);assert.equal(x.store.get('shrigma_tpl_key'),'synthetic-writer');assert.equal(x.q('#growth-acesso-campos').disabled,false);
});
test('empty, invalid JSON, wrong role and cancelled asynchronous import produce no read or write',async()=>{
 const x=boot();x.api.show();await x.submit();assert.equal(x.reads.length,0);assert.equal(x.q('#growth-chave').getAttribute('aria-invalid'),'true');
 await file(x,access({role:'write'}));await x.submit();assert.equal(x.reads.length,0);
 let done;const pending=file(x,()=>new Promise(r=>done=r));x.q('#growth-acesso-cancelar').click();done(access());await pending;assert.equal(x.q('#growth-chave').value,'');assert.equal(x.q('#growth-acesso').hidden,true);assert.equal(x.api.current(),'');assert.equal(x.reads.length,0);assert.deepEqual(x.writes,[]);
});
test('automatic refresh requesting access again preserves typed input and an import in progress',async()=>{
 const x=boot();x.api.show();x.q('#growth-chave').value='partially-typed';x.api.show();assert.equal(x.q('#growth-chave').value,'partially-typed');
 let done;const pending=file(x,()=>new Promise(r=>done=r));x.api.show();done(access());await pending;assert.equal(x.q('#growth-chave').value,'synthetic-reader');assert.equal(x.reads.length,0);assert.equal(x.api.current(),'');assert.equal(x.q('#growth-acesso-campos').disabled,false);
});
test('legacy reads stay compatible, rejection cannot fall back to stale storage or erase pending/write state',async()=>{
 const x=boot({legacy:'legacy-reader'});assert.equal(x.run('GTA.chaveLeitura()'),'legacy-reader');x.api.show();x.q('#growth-chave').value='synthetic-reader';await x.submit();
 x.api.reject('legacy-reader','stale');assert.equal(x.api.current(),'synthetic-reader');x.api.reject('synthetic-reader','Chave recusada');assert.equal(x.run('GTA.chaveLeitura()'),'');assert.equal(x.q('#growth-acesso').hidden,false);
 assert.equal(x.store.get('shrigma_k_growth'),'legacy-reader');assert.equal(x.store.get('shrigma_tpl_key'),'synthetic-writer');assert.equal(x.store.get('shrigma_campaign_operation_v1:unrelated'),'preserve-exact');assert.deepEqual(x.writes,[]);
});
test('cancel/Escape retains existing access and read failure does not expose the key or leave controls disabled',async()=>{
 const x=boot({legacy:'legacy-reader',onRead:()=>{throw Error('synthetic-reader');}});x.api.show();x.q('#growth-chave').value='replacement';x.q('#growth-acesso').onkeydown({key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(x.api.current(),'legacy-reader');assert.equal(x.reads.length,0);
 x.api.show();x.q('#growth-chave').value='synthetic-reader';await x.submit();assert.equal(x.q('#growth-acesso').hidden,false);assert.equal(x.q('#growth-acesso-campos').disabled,false);assert.doesNotMatch(x.document.body.textContent,/synthetic-reader/);assert.deepEqual(x.writes,[]);
});
test('templates, history and canvas read the new session reader while their writes keep a distinct explicit key',async()=>{
 const x=boot({legacy:'legacy-reader'});x.api.show();x.q('#growth-chave').value='synthetic-reader';await x.submit();
 x.run('GRU.caps={endpoint:"https://fixture.test/templates"};GC.caps={endpoint:"https://fixture.test/templates",pode:{read_content:true,list_history:true}};GC.render=()=>{};GB.endpoint=()=>"https://fixture.test/templates"');
 await x.run('GRU.cliente().listar("fish")');await x.run('GC.carregarConteudo({marca:"fish"})');await x.run('GC.carregarHistorico({marca:"fish"},"fixture")');await x.run('GB.request("fluxos_listar")');
 assert.equal(x.calls.length,4);for(const c of x.calls){assert.notEqual(c.init.method,'POST');assert.equal(new URL(c.url).searchParams.get('k'),'synthetic-reader');}
 await x.run('GRU.cliente("separate-synthetic-writer").rascunho({name:"fixture"},{idempotency_key:"fixture"})');assert.equal(JSON.parse(x.calls.at(-1).init.body).k,'separate-synthetic-writer');assert.deepEqual(x.writes,[]);
});
test('cancelled campaign can be listed and reopened with session read key only; no commercial action is sent',async()=>{
 const x=boot();x.api.show();x.q('#growth-chave').value='synthetic-reader';await x.submit();
 const d={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Fixture cancelada',subject:'Fixture',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[1000],template_id:1,html:'https://fishermans.com.br/products/fixture {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/fixture {{ UnsubscribeURL }}',tags:[],send_at:'2099-01-01T15:00:00.000Z'};
 const campaign={id:1000,version:'fixture-cancelled',status:'cancelled',sent:0,started_at:null,send_at:d.send_at,definition:d};
 x.ctx.fetch=async(url,init={})=>{x.calls.push({url,init});const action=new URL(url).searchParams.get('acao');const body=action==='campanha_catalogo'?{brand:'fish',current:true,lists:[{id:1000,name:'Lista técnica vazia',brand:'fish',available:true}],templates:[{id:1,name:'Fixture',type:'campaign',available:true}]}:action==='campanha_listar'?{campaigns:[campaign]}:{campaign};return {ok:true,status:200,json:async()=>structuredClone(body)};};
 x.ctx.payload={capabilities:{campaigns:{contract_version:'crm-campaign-v1',brands:['fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true},endpoints:{campaigns:'https://fixture.test/campaigns'}}};x.run('GCE.mount({marca:"fish",api:payload})');
 async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI did not finish');}
 x.q('[data-ce-refresh]').click();await until(()=>x.q('[data-ce-open="1000"]'));x.q('[data-ce-open="1000"]').click();await until(()=>/Cancelada/.test(x.q('[data-ce-server-state]').textContent));
 assert.match(x.q('[data-ce-server-state]').textContent,/0 enviados/);assert.equal(x.q('[name=name]').value,'Fixture cancelada');
 for(const action of ['save','validate','schedule','cancel'])assert.equal(x.q(`[data-ce-${action}]`).disabled,true);
 assert.equal(x.calls.length,4);assert.ok(x.calls.every(c=>c.init.method==='GET'&&new URL(c.url).searchParams.get('k')==='synthetic-reader'));
 assert.ok(!x.writes.includes('shrigma_k_growth')&&!x.writes.includes('shrigma_k_mestre')&&!x.writes.includes('shrigma_tpl_key'));assert.equal(x.store.get('shrigma_campaign_operation_v1:unrelated'),'preserve-exact');
});
