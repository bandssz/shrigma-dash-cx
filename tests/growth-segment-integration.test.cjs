'use strict';
// The manifest sources and the real page run in a local DOM. No generated
// assets, browser, API, credentials or external transport are used here.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{parseHTML}=require('linkedom');
const F=require('./growth-segment-fixture.cjs'),root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/panel-build/manifest.json'))).growth;
function payload(capabilities){return {_escopo:'growth',_painel:'growth',gerado_em:'2026-09-28T12:00:00Z',capabilities,
 ...Object.fromEntries(['crm_campanha','crm_fluxo','crm_conversao','crm_campanha_receita','crm_campanha_grupo','crm_diario','crm_intradia','crm_carrinho','crm_galho','crm_regra_galho','crm_teste','crm_teste_braco','crm_credencial','wa_saude'].map(k=>[k,[]])),
 crm_base:['fish','aristo'].map(marca=>({marca,dia:'2026-09-28',coletado_em:'2026-09-28T12:00:00Z',total:marca==='fish'?12:34,segmentos:{}}))};}
async function boot({version='crm-segment-v1',enabled=true,manager=true,brand='fish',section='base'}={}){
 const f=F.fixture({version}),html=fs.readFileSync(path.join(root,'growth.html'),'utf8'),{document,window}=parseHTML(html);
 const selectProto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
 dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const intervals=[],requests=[],hashes=[];let response=payload(enabled?f.api.capabilities:undefined);
 const NativeDate=Date;class FixedDate extends Date{constructor(...a){super(...(a.length?a:['2026-09-28T12:10:00Z']));}static now(){return Date.parse('2026-09-28T12:10:00Z');}}
 const context=vm.createContext({document,window,URL,URLSearchParams,Date:FixedDate,Intl,AbortSignal,TextEncoder,crypto:webcrypto,navigator:{locks:f.locks},console,
 localStorage:f.storage,location:{hash:'#marca='+brand+'&sec='+section,search:''},history:{replaceState:(_a,_b,url)=>hashes.push(url)},
 addEventListener(){},setInterval(fn,ms){intervals.push({fn,ms});return intervals.length;},clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
 Image:class{},Blob:class{},prompt:()=>null,confirm:()=>false,
 fetch:async(url,init)=>{requests.push({url,init});const u=new URL(url);if(u.hostname==='segments.example.test'||u.hostname==='changed.example.test')return f.fetch(url,init);
  const body=structuredClone(response);if(u.pathname.includes('cx-dash-cache'))body._cache_gerado_em=new NativeDate(FixedDate.now()).toISOString();return {status:200,ok:true,json:async()=>body};}});
 const run=code=>vm.runInContext(code,context);
 for(const script of manifest.scripts)vm.runInContext(fs.readFileSync(path.join(root,script),'utf8'),context,{filename:script});
 run("shrigmaGuardaChave('growth','synthetic-manager-key');"+(manager?"SHRIGMA_OPERATOR_SESSION.growth={caps:['read_content','draft'],label:'Synthetic manager'};":''));
 for(const script of document.querySelectorAll('script:not([src])'))vm.runInContext(script.textContent,context,{filename:'growth-inline.js'});
 const x={f,document,window,run,requests,intervals,hashes,q:s=>document.querySelector(s),setResponse:v=>{response=v;},response:()=>structuredClone(response)};
 await settled(x);return x;
}
async function settled(x){for(let i=0;i<200;i++){if(!x.run('LOADING||CRM_SEGMENT_SYNC||CRM_SEGMENT_VIEW?.contextStatus().blocked'))return;await new Promise(r=>setTimeout(r,2));}assert.fail('Local panel did not settle');}
function fill(x,brand){const input=x.q('[data-gs-name]');input.value='Preparação '+brand;input.dispatchEvent(new x.window.Event('input',{bubbles:true}));const select=x.q('[data-gs-list]');select.value=brand==='fish'?'11':'21';select.dispatchEvent(new x.window.Event('change',{bubbles:true}));}
async function changeBrand(x,brand,{confirm=true}={}){x.q('[data-marca="'+brand+'"]').click();if(confirm&&x.q('#brand-change-confirm').open)x.q('#brand-change-accept').click();await settled(x);}

test('manifest loads segment contracts before client/UI and scopes their CSS to Growth',()=>{
 const all=JSON.parse(fs.readFileSync(path.join(root,'tools/panel-build/manifest.json'))),files=['n8n/growth/segment-contract.js','n8n/growth/segment-audience-contract.js','growth-segment-client.js','growth-segment-ui.js'];
 for(const file of files)assert.equal(manifest.scripts.filter(s=>s===file).length,1);
 assert.ok(files.map(f=>manifest.scripts.indexOf(f)).every((n,i,a)=>!i||n>a[i-1]));assert.ok(manifest.css.includes('growth-segment.css'));
 for(const [area,m]of Object.entries(all))if(area!=='growth')assert.ok(![...m.scripts,...m.css].some(s=>s.includes('segment')));
});
for(const brand of ['fish','aristo']){
 test(brand+': absent capability and a reader without manager permission keep the current audience view without segment I/O',async()=>{
  for(const options of [{enabled:false},{manager:false}]){const x=await boot({brand,...options});assert.equal(x.q('#crm-segments-panel').hidden,true);assert.equal(x.q('#sec-base').classList.contains('ativa'),true);assert.ok(x.q('#area-arvore [data-ga-row]'));assert.equal(x.run('CRM_SEGMENT_VIEW'),null);assert.equal(x.f.calls.length,0);}
 });
 for(const version of ['crm-segment-v1','crm-audience-v2'])test(brand+': '+version+' mounts only on Público and uses the current manager session for its own endpoint',async()=>{
  const x=await boot({version,brand,section:'visao'});assert.equal(x.f.calls.length,0);x.q('[data-s="base"]').click();await settled(x);
  assert.equal(x.q('#crm-segments-panel').hidden,false);assert.equal(x.q('#crm-segments-editor').hidden,false);assert.equal(x.f.calls.length,1);assert.equal(x.f.calls[0].actor,'Bearer synthetic-manager-key');assert.equal(x.f.calls[0].body.brand,brand);assert.equal(x.f.calls[0].body.acao,'segmentos_listar');
  assert.ok(x.q('#area-arvore [data-ga-row]'));assert.ok(x.q('[data-gs-list]').textContent.includes('Lista principal '+brand));assert.match(x.q('#crm-segments-editor').textContent,/Confira no editor da campanha se o uso deste público e o agendamento estão disponíveis/);
  assert.equal(!!x.q('[data-gs="add-condition"]'),version==='crm-audience-v2');assert.equal(x.requests.filter(r=>r.init.method==='POST').length,0);
  for(const [k,v]of x.f.store)assert.doesNotMatch(k+v,/synthetic-manager-key/);assert.ok(x.requests.every(r=>!r.url.includes('synthetic-manager-key')));
 });
}
test('polling, channel changes and navigation keep the same draft, focus and current audience controls',async()=>{
 const x=await boot();fill(x,'fish');const input=x.q('[data-gs-name]');input.focus();const audienceSearch=x.q('[data-ga-search]');audienceSearch.value='base';audienceSearch.oninput({target:audienceSearch});const before=x.f.calls.length;
 await x.intervals.find(i=>i.ms===60000).fn();await settled(x);assert.equal(x.q('[data-gs-name]'),input);assert.equal(x.document.activeElement,input);assert.equal(input.value,'Preparação fish');assert.equal(x.q('[data-ga-search]'),audienceSearch);assert.equal(audienceSearch.value,'base');assert.equal(x.f.calls.length,before);
 x.q('[data-s="camp"]').click();x.q('[data-canal="email"]').click();x.q('[data-s="base"]').click();await settled(x);assert.equal(x.q('[data-gs-name]').value,'Preparação fish');assert.equal(x.run('CRM_SEGMENT_VIEW.contextStatus().dirty'),true);assert.equal(x.f.calls.length,before);
});
test('read-disabled, unknown contract, another brand and invalid endpoint never mount or fetch segments',async()=>{
 const changes=[c=>c.segments.read=false,c=>c.segments.contract_version='future-contract',c=>c.segments.brands=['aristo'],c=>c.endpoints.segments='http://segments.example.test/api',c=>c.endpoints.segments='https://segments.example.test/api?token=forbidden',c=>delete c.endpoints.segments];
 for(const change of changes){const x=await boot({section:'visao'}),p=x.response();change(p.capabilities);x.setResponse(p);await x.run('carregar()');x.q('[data-s="base"]').click();await settled(x);assert.equal(x.q('#crm-segments-panel').hidden,true);assert.equal(x.run('CRM_SEGMENT_VIEW'),null);assert.equal(x.f.calls.length,0);assert.ok(x.q('#area-arvore [data-ga-row]'));}
});
test('dirty brand changes require the existing confirmation and restore separate Fish/Aristo drafts',async()=>{
 const x=await boot();fill(x,'fish');await changeBrand(x,'aristo',{confirm:false});assert.equal(x.run('MARCA'),'fish');assert.equal(x.q('#brand-change-confirm').open,true);x.q('#brand-change-cancel').click();assert.equal(x.q('[data-gs-name]').value,'Preparação fish');
 await changeBrand(x,'aristo');assert.equal(x.run('MARCA'),'aristo');assert.equal(x.q('[data-gs-name]').value,'');assert.ok(!x.q('[data-gs-list]').textContent.includes('fish'));fill(x,'aristo');await changeBrand(x,'fish');assert.equal(x.q('[data-gs-name]').value,'Preparação fish');assert.equal(x.q('[data-gs-list]').value,'11');assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);
});
test('uncertain segment saves prevent both ordinary and A/B brand restoration, without any automatic retry',async()=>{
 const x=await boot();fill(x,'fish');x.f.control.lose=true;x.q('[data-gs="save"]').click();await settled(x);assert.equal(x.run('CRM_SEGMENT_VIEW.contextStatus().pending'),true);
 x.q('[data-marca="aristo"]').click();assert.equal(x.run('MARCA'),'fish');assert.match(x.q('#brand-context-status').textContent,/tentativa de público sem confirmação/);assert.equal(x.run("restoreABExperimentBrand('aristo')"),false);
 await x.run('carregar()');await settled(x);assert.equal(x.f.calls.filter(c=>c.method==='POST').length,1);assert.ok(x.q('[data-gs="consult"]'));assert.equal(x.f.calls.every(c=>c.body.brand==='fish'),true);
});
test('capability revocation preserves the draft and hides the candidate; consolidated and excluded brands never load it',async()=>{
 const x=await boot();fill(x,'fish');const saved=x.f.store.get('shrigma_segment_editor_v1:fish'),before=x.f.calls.length,p=x.response();delete p.capabilities;x.setResponse(p);await x.run('carregar()');await settled(x);
 assert.equal(x.q('#crm-segments-panel').hidden,true);assert.equal(x.f.store.get('shrigma_segment_editor_v1:fish'),saved);assert.equal(x.f.calls.length,before);assert.ok(x.q('#area-arvore [data-ga-row]'));
 for(const brand of ['todas','olivas']){const y=await boot({brand});assert.equal(y.q('#crm-segments-panel').hidden,true);assert.equal(y.f.calls.length,0);}
});
test('changed endpoint or session cannot silently move the preserved preparation into another context',async()=>{
 for(const kind of ['endpoint','key']){const x=await boot();fill(x,'fish');const saved=x.f.store.get('shrigma_segment_editor_v1:fish'),before=x.f.calls.length;
  if(kind==='endpoint'){const p=x.response();p.capabilities.endpoints.segments='https://changed.example.test/api';x.setResponse(p);}else x.run("shrigmaGuardaChave('growth','synthetic-different-manager');");
  await x.run('carregar()');for(let i=0;i<100&&x.run('LOADING||CRM_SEGMENT_SYNC');i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(x.f.store.get('shrigma_segment_editor_v1:fish'),saved);assert.equal(x.f.calls.length,before);assert.equal(x.q('#crm-segments-editor').hidden,true);assert.match(x.q('#crm-segments-status').textContent,/preservada/);
 }
});
