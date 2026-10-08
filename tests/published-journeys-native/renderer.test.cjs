'use strict';
// Disposable, explicit synthetic READ responses. No real fetch, identities,
// provider, SQL or runtime filesystem. The real canonical canvas is exercised.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const vm=require('node:vm');
const inputRoot=process.env.PUBLISHED_JOURNEY_SOURCE?path.resolve(process.env.PUBLISHED_JOURNEY_SOURCE):path.resolve(__dirname,'../..');
const C=require(path.join(inputRoot,'growth-canvas.js')),P=require(path.join(inputRoot,'growth-published-flows.js'));
function response(){const steps=[{key:'ea',name:'Mensagem email',channel:'email',wait_min:30,enabled:true,template_name:'Publicado'},{key:'wa',name:'Alternativa A',channel:'whatsapp',variant:'a',wait_min:30,enabled:true,template_name:'Publicado A'},{key:'wb',name:'Alternativa B',channel:'whatsapp',variant:'b',wait_min:30,enabled:true,template_name:'Publicado B'}];return {checked_at:'2026-10-06T12:00:00Z',flows:[{key:'fish:synthetic',brand:'fish',name:'Jornada sintética',trigger:'Evento sintético',version:6,published_version:4,published:{steps},draft:{steps:[{key:'draft-never-read'}]},enabled:false,runtime_ready:true,available_steps:steps,journey_kind:null}]};}
const origin='https://crm.shrigma.com.br';
const api=()=>({capabilities:{endpoints:{templates:origin+'/api/templates'},workflows:{published_read_contract:P.VERSION,published_read:true,published_read_scope:'master-brand-scoped'}}});
const context=(a=api(),brand='fish')=>({api:a,marca:brand,section:'regua',tab:'fluxos'});
const reply=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
test('published graph reuses the canonical real projection, with arrows, parallel arms, published version and no draft substitution',()=>{
 const b=response(),before=structuredClone(b),m=P.normalize(b,'fish',C);assert.equal(m.state,'loaded');assert.deepEqual(m.flows[0].graph,C.graph(b.flows[0],b.flows[0].published));assert.deepEqual(b,before);assert.equal(m.flows[0].version,4);assert.equal(m.write,false);
 const g=m.flows[0].graph;assert(g.edges.some(e=>e.from==='trigger'&&e.to.startsWith('wait:')));assert(!g.edges.some(e=>e.from==='step:wa'&&e.to==='step:wb'));
 const h=P.html(m);assert.match(h,/marker-end/);assert.match(h,/configuração pausada/);assert.doesNotMatch(h,/draft-never-read|data-flow-node|Adicionar etapa|Publicar|<button|<input/);
});
test('absent, invalid, observed-only or unpublished data never generates presumed graph or unknown zero',()=>{
 for(const b of [null,{}, {flows:[],checked_at:null},{crm_fluxo:[{flow:'cart',enviados:3}]}, {...response(),flows:[{...response().flows[0],published:null,published_version:4}]}]){const m=P.normalize(b,'fish',C);assert.equal(m.state,'unavailable');assert.doesNotMatch(P.html(m),/marker-end/);}
 const b=response();b.flows[0].published=null;b.flows[0].published_version=null;const m=P.normalize(b,'fish',C);assert.equal(m.flows[0].reason,'not_published');assert.doesNotMatch(P.html(m),/marker-end/);
});
test('missing waits, unknown binding or kind, duplicate steps and unsafe geometry refuse the whole graph',()=>{
 const changes=[b=>delete b.flows[0].published.steps[0].wait_min,b=>b.flows[0].available_steps=[],b=>b.flows[0].journey_kind='future-engine',b=>b.flows[0].published.steps.push(b.flows[0].published.steps[0]),b=>b.flows[0].published.layout={nodes:{trigger:{x:Infinity,y:2}}}];
 for(const change of changes){const b=structuredClone(response());change(b);assert.equal(P.normalize(b,'fish',C).state,'unavailable');}
});
test('actual order event branches remain independent; NPS uses its own canonical existing projection',()=>{
 const b=response(),f=b.flows[0];f.journey_kind='order';f.available_steps=f.published.steps=[{key:'received',name:'Recebido',entry_key:'received',entry_label:'Recebido',channel:'email',wait_min:0,enabled:true},{key:'paid',name:'Pago',entry_key:'paid',entry_label:'Pago',channel:'email',wait_min:0,enabled:true}];let m=P.normalize(b,'fish',C);assert.equal(m.state,'loaded');assert(!m.flows[0].graph.edges.some(e=>e.from==='entry:received'&&e.to==='entry:paid'));
 f.journey_kind='nps';f.available_steps=f.published.steps=[{key:'mail0',name:'Pesquisa',piece:'nps-d0',channel:'email',wait_min:0,enabled:true},{key:'mail3',name:'Lembrete',piece:'nps-d3',channel:'email',wait_min:4320,enabled:true}];m=P.normalize(b,'fish',C);assert.equal(m.state,'loaded');assert.deepEqual(m.flows[0].graph,C.graph(f,f.published));
});
test('brand and server-supplied labels are preserved without introducing another brand or executable markup',()=>{
 const b=response(),second=structuredClone(b.flows[0]);second.brand='aristo';second.key='aristo:synthetic';second.name='Outra marca';b.flows.push(second);b.flows[0].name='<script>bad</script>';const m=P.normalize(b,'fish',C);assert.equal(m.state,'unavailable');b.flows.pop();const h=P.html(P.normalize(b,'fish',C));assert.doesNotMatch(h,/<script>|Outra marca/);assert.match(h,/&lt;script&gt;/);
});
test('no explicit independent READ admission means no I/O; legacy editor/template-read capabilities cannot enable it',async()=>{
 let calls=0;const client=P.create({canvas:C,origin,fetchImpl:async()=>{calls++;throw Error('not expected');}});
 for(const a of [null,{}, {capabilities:{workflows:{editor:true},endpoints:{templates:origin+'/api/templates'},templates:{read_content:true,read_contract:'crm-template-read-v1'}}}, {capabilities:{...api().capabilities,endpoints:{templates:'https://elsewhere.example/api/templates'}}}]){client.sync(context(a));assert.equal(await client.refresh(),false);}
 assert.equal(calls,0);client.dispose();
});
test('admitted transport is one bounded same-origin GET, without bearer, writes, automatic replay or storage',async()=>{
 let calls=0;const c=P.create({canvas:C,origin,fetchImpl:async(url,o)=>{calls++;assert.equal(url,origin+'/api/templates?acao=fluxos_listar&marca=fish');assert.equal(o.method,'GET');assert.equal(o.credentials,'same-origin');assert.equal(o.redirect,'error');assert.deepEqual(o.headers,{Accept:'application/json'});return reply(response());}});
 c.sync(context());assert.equal(await c.refresh(),true);assert.equal(c.state().model.state,'loaded');assert.equal(calls,1);c.dispose();assert.equal(c.state().model.state,'unavailable');
});
test('late brand response, capability withdrawal and dispose discard even an accepted response',async()=>{
 for(const change of [c=>c.sync(context(api(),'aristo')),c=>c.sync(context({})),c=>c.sync({...context(),section:'visao'}),c=>c.dispose()]){
  let resolve;const c=P.create({canvas:C,origin,fetchImpl:()=>new Promise(r=>resolve=r)});c.sync(context());const p=c.refresh();change(c);resolve(reply(response()));assert.equal(await p,false);assert.equal(c.state().model.state,'unavailable');
 }
});
test('failed refresh withdraws prior graph; busy calls do not issue duplicates; no failure replays a GET automatically',async()=>{
 let calls=0,resolve;const c=P.create({canvas:C,origin,fetchImpl:async()=>{calls++;if(calls===1)return reply(response());return new Promise(r=>resolve=r);}});c.sync(context());assert.equal(await c.refresh(),true);const pending=c.refresh();assert.equal(await c.refresh(),false);assert.equal(c.state().model.state,'unavailable');resolve(new Response('{}',{status:503}));assert.equal(await pending,false);assert.equal(calls,2);c.dispose();
});
test('current transformation and all existing page IDs/functions remain intact',()=>{
 const files=inputRoot,builderPath=path.join(inputRoot,'services/dashboard-operational/build.cjs');
 // The sealed builder lacks its public/entry.js dependency; only transform is exercised,
 // with the unrelated read-only shell stylesheet stubbed. This is not a full build.
 const box={module:{exports:{}},__dirname:path.dirname(builderPath),process,Buffer,require:id=>id==='./public/entry.js'?{readOnlyStyles:()=>':root{}'}:require(id)};
 vm.runInNewContext(fs.readFileSync(builderPath,'utf8'),box);const B=box.module.exports;
 const raw=fs.readFileSync(path.join(files,'growth.html'),'utf8'),html=B.transform(raw,'growth.html');
 assert.match(html,/GFU\.render\(\{\.\.\.ctx,configuredReadOnly:true,workflowsModel:/);
 assert.match(html,/GPR\.sync\(\{api:API,marca:MARCA,section:SEC,tab:GC\.activeTab\}\)/);
 const expectedIds=require('./original-html-ids.json');
 const ids=x=>[...x.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(ids(raw),expectedIds);
 assert.equal(raw.split('GFU.render({...ctx,workflowsModel:').length,2);
 for(const f of ['renderJornadas','limpaConsultaCRM','carregar','render'])assert(raw.includes('function '+f+'('));
 const manifest=JSON.parse(fs.readFileSync(path.join(files,'tools/panel-build/manifest.json'),'utf8'));
 assert(manifest.growth.scripts.indexOf('growth-canvas.js')<manifest.growth.scripts.indexOf('growth-published-flows.js'));
 assert(manifest.growth.scripts.indexOf('growth-published-flows.js')<manifest.growth.scripts.indexOf('growth-flows-ui.js'));
 assert(manifest.growth.css.includes('growth-published-flows.css'));
 const ui=fs.readFileSync(path.join(files,'growth-flows-ui.js'),'utf8');assert.match(ui,/GFU.renderConfigured\(\);.*GPR.mount/);assert.match(ui,/observedOnly\?\{\.\.\.GFU.ctx.api,crm_fluxo_def:null\}/);
 const canonical=JSON.parse(fs.readFileSync(path.join(__dirname,'original-panel-manifest.json'),'utf8'));
 for(const area of Object.keys(canonical))for(const kind of ['scripts','css'])assert.deepEqual(manifest[area][kind].filter(x=>!x.startsWith('growth-published-flows.')),canonical[area][kind]);
});

test('strict brand-scoped contract admits relative same-origin endpoint and rejects old all-brand scope',()=>{
 const a=api();a.capabilities.endpoints.templates='/api/templates';assert.equal(P.admission(a,origin),origin+'/api/templates');a.capabilities.workflows.published_read_scope='master-all-brands';assert.equal(P.admission(a,origin),null);
 for(const endpoint of ['/api/templates?key=bad','/api/templates#bad','https://elsewhere.example/api/templates']){const a=api();a.capabilities.endpoints.templates=endpoint;assert.equal(P.admission(a,origin),null);}
});
test('aristo request is explicitly scoped and valid empty differs from unavailable',async()=>{
 let seen;const c=P.create({canvas:C,origin,fetchImpl:async u=>{seen=u;return reply({flows:[],checked_at:'2026-10-08T12:00:00Z'});}});c.sync(context(api(),'aristo'));assert.equal(await c.refresh(),true);assert.match(seen,/marca=aristo$/);assert.equal(c.state().model.state,'loaded');assert.match(P.html(c.state().model),/Nenhuma jornada publicada retornada/);c.dispose();assert.match(P.html(c.state().model),/indisponível/);
});
test('API replacement with identical endpoint invalidates pending and confirmed graphs',async()=>{
 let resolve;const c=P.create({canvas:C,origin,fetchImpl:()=>new Promise(r=>resolve=r)});c.sync(context());const pending=c.refresh();c.sync(context());resolve(reply(response()));assert.equal(await pending,false);assert.equal(c.state().model.state,'unavailable');
});
test('no draft/history access even through getters',()=>{
 const b=response();Object.defineProperty(b.flows[0],'draft',{get(){throw Error('draft read');}});Object.defineProperty(b,'crm_fluxo',{get(){throw Error('history read');}});assert.equal(P.normalize(b,'fish',C).state,'loaded');
});
function browserHarness(fetchImpl){
 const listeners={},timers=new Map();let serial=0,root=null;const classes={};
 const node=()=>({id:'',innerHTML:'',className:'',children:[],setAttribute(){},appendChild(c){this.children.push(c);if(c.id==='jpr-published')root=c;},remove(){root=null;},querySelector(sel){return sel==='[data-jpr-read]'?{addEventListener:(n,f)=>this.click=f}:sel==='#jpr-published'?root:null;}});
 const ctx={window:{fetch:fetchImpl,location:{origin},addEventListener:(n,f)=>listeners[n]=f},document:{getElementById:()=>root,createElement:node},AbortController,TextDecoder,Uint8Array,URL,setTimeout:(f,n)=>{const id=++serial;timers.set(id,{f,n});return id;},clearTimeout:id=>timers.delete(id),module:{exports:{}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(inputRoot,'growth-canvas.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(inputRoot,'growth-published-flows.js'),'utf8'),ctx);return {ctx,P:ctx.module.exports,listeners,timers,node,get root(){return root;},context:(brand='fish')=>vm.runInContext('('+JSON.stringify(context(api(),brand))+')',ctx),async settle(){await new Promise(r=>setImmediate(r));}};
}
test('VM browser mount is explicit; reload, context change and pagehide clear rendered graph',async()=>{
 let calls=0;const h=browserHarness(async()=>{calls++;return reply(response());}),root=h.node();
 h.P.mount(h.context(),root);assert.equal(calls,0);assert.match(h.root.innerHTML,/Consultar fluxogramas/);await h.root.click();assert.match(h.root.innerHTML,/marker-end/);h.P.clear();assert.doesNotMatch(h.root.innerHTML,/marker-end/);h.P.sync(h.context());await h.root.click();assert.equal(calls,2);h.P.sync(h.context('aristo'));assert.doesNotMatch(h.root.innerHTML,/marker-end/);h.listeners.pagehide();assert.doesNotMatch(h.root.innerHTML,/marker-end/);
});
test('VM deadline exits busy even if fetch or body ignores abort; no automatic repeat',async()=>{
 for(const kind of ['fetch','body']){let calls=0;const h=browserHarness(async()=>{calls++;if(kind==='fetch')return new Promise(()=>{});return {ok:true,body:{getReader:()=>({read:()=>new Promise(()=>{}),releaseLock(){}})}};});h.P.mount(h.context(),h.node());const pending=h.root.click();await h.settle();const timer=[...h.timers.values()][0];assert.equal(timer.n,20000);timer.f();await pending;assert.doesNotMatch(h.root.innerHTML,/Consultando…/);assert.doesNotMatch(h.root.innerHTML,/marker-end/);assert.equal(calls,1);}
});
test('response size bounded and denied session cannot produce graph',async()=>{
 for(const fetchImpl of [async()=>new Response('{}',{status:403}),async()=>({ok:true,body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(1048577)}),cancel:async()=>{},releaseLock(){}})}})]){const c=P.create({canvas:C,origin,fetchImpl});c.sync(context());assert.equal(await c.refresh(),false);assert.equal(c.state().model.state,'unavailable');}
});

test('configured current UI mounts published renderer without bypassing configured/history path',()=>{
 const calls=[],root={},ctx={module:{exports:{}},require:()=>({obj:()=>false}),document:{querySelector:()=>root},GPR:{sync:c=>calls.push(['sync',c]),mount:(c,r)=>calls.push(['mount',r])}};
 vm.runInNewContext(fs.readFileSync(path.join(inputRoot,'growth-flows-ui.js'),'utf8'),ctx);const U=ctx.module.exports;U.renderConfigured=()=>calls.push(['configured']);U.render({configuredReadOnly:true,marca:'fish',api:{}});assert.deepEqual(calls.map(x=>x[0]),['sync','configured','mount']);assert.equal(calls[2][1],root);
});
test('missing workflow gate for manager view performs no GET',async()=>{
 let calls=0;const c=P.create({canvas:C,origin,fetchImpl:()=>{calls++;throw Error();}});c.sync(context({capabilities:{endpoints:{templates:'/api/templates'},workflows:{published_read:false,published_read_contract:P.VERSION,published_read_scope:'master-brand-scoped'}}}));assert.equal(await c.refresh(),false);assert.equal(calls,0);
});
test('HTML reload and withdrawn credential call clear before returning',()=>{
 const raw=fs.readFileSync(path.join(inputRoot,'growth.html'),'utf8');
 for(const header of ['function limpaConsultaCRM(){','async function carregar({retryIdentity=false}={}){'])assert(raw.split(header)[1].trimStart().startsWith("if(typeof GPR!=='undefined')GPR.clear()"));
 assert(raw.split('function render(){')[1].trimStart().startsWith("if(typeof GPR!=='undefined')GPR.sync({api:CRM_LEITURA_BLOQUEADA?null:API"));
 const scripts=raw.split('<script>').slice(1).map(x=>x.split('</script>')[0]);assert(scripts.length>0);for(const script of scripts)new vm.Script(script);
});
