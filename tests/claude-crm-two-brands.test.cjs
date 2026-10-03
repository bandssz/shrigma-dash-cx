'use strict';
// Percurso 1 (duas marcas, públicos salvos): página real + fontes do manifesto
// em DOM local. Sem navegador, rede, credencial real ou transporte externo.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{parseHTML}=require('linkedom');
const F=require('./growth-segment-fixture.cjs'),root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/panel-build/manifest.json'))).growth;
function payload(capabilities){return {_escopo:'growth',_painel:'growth',gerado_em:'2026-09-28T12:00:00Z',capabilities,
 ...Object.fromEntries(['crm_campanha','crm_fluxo','crm_conversao','crm_campanha_receita','crm_campanha_grupo','crm_diario','crm_intradia','crm_carrinho','crm_galho','crm_regra_galho','crm_teste','crm_teste_braco','crm_credencial','wa_saude'].map(k=>[k,[]])),
 crm_base:['fish','aristo'].map(marca=>({marca,dia:'2026-09-28',coletado_em:'2026-09-28T12:00:00Z',total:marca==='fish'?12:34,segmentos:{}}))};}
const fingerprint=async key=>Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex');
async function boot({version='crm-segment-v1',brand='fish',section='base',setupFixture=null,extraCaps=null,respond=null}={}){
 const f=F.fixture({version}),html=fs.readFileSync(path.join(root,'growth.html'),'utf8'),{document,window}=parseHTML(html);
 if(setupFixture)await setupFixture(f);
 const selectProto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
 dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const capabilities=structuredClone(f.api.capabilities);if(extraCaps)extraCaps(capabilities);
 const intervals=[],requests=[];let response=payload(capabilities);
 const NativeDate=Date;class FixedDate extends Date{constructor(...a){super(...(a.length?a:['2026-09-28T12:10:00Z']));}static now(){return Date.parse('2026-09-28T12:10:00Z');}}
 const context=vm.createContext({document,window,URL,URLSearchParams,Date:FixedDate,Intl,AbortSignal,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,navigator:{locks:f.locks},console,
  localStorage:f.storage,location:{hash:'#marca='+brand+'&sec='+section,search:''},history:{replaceState(){}},
  addEventListener(){},setInterval(fn,ms){intervals.push({fn,ms});return intervals.length;},clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
  Image:class{},Blob:class{},prompt:()=>null,confirm:()=>false,
  fetch:async(url,init)=>{requests.push({url,init});const u=new URL(url);
   if(respond){const custom=await respond(u,init);if(custom)return custom;}
   if(u.hostname==='segments.example.test')return f.fetch(url,init);
   const body=structuredClone(response);if(u.searchParams.get('action')==='cache_growth')body._cache_gerado_em=new NativeDate(FixedDate.now()).toISOString();return {status:200,ok:true,json:async()=>body};}});
 const run=code=>vm.runInContext(code,context);
 for(const script of manifest.scripts)vm.runInContext(fs.readFileSync(path.join(root,script),'utf8'),context,{filename:script});
 run("shrigmaGuardaChave('growth','synthetic-manager-key');SHRIGMA_OPERATOR_SESSION.growth={caps:['read_content','draft'],label:'Synthetic manager'};");
 for(const script of document.querySelectorAll('script:not([src])'))vm.runInContext(script.textContent,context,{filename:'growth-inline.js'});
 const x={f,document,window,run,requests,intervals,q:s=>document.querySelector(s),setResponse:v=>{response=v;},response:()=>structuredClone(response)};
 await settled(x);return x;
}
async function settled(x){for(let i=0;i<300;i++){if(!x.run('LOADING||CRM_SEGMENT_SYNC||CRM_AUDIENCE_CREATE_BUSY||CRM_SEGMENT_VIEW?.contextStatus().busy'))return;await new Promise(r=>setTimeout(r,2));}assert.fail('Local panel did not settle');}
function fill(x,brand){const input=x.q('[data-gs-name]');input.value='Preparação '+brand;input.dispatchEvent(new x.window.Event('input',{bubbles:true}));const select=x.q('[data-gs-list]');select.value=brand==='fish'?'11':'21';select.dispatchEvent(new x.window.Event('change',{bubbles:true}));}
async function changeBrand(x,brand,{confirm=true}={}){x.q('[data-marca="'+brand+'"]').click();if(confirm&&x.q('#brand-change-confirm').open)x.q('#brand-change-accept').click();await settled(x);}
const editorSlot=brand=>'shrigma_segment_editor_v1:'+brand;
const visibleSegmentText=x=>['#crm-segments-status','#crm-segments-editor'].map(s=>x.q(s)).filter(n=>!n.hidden).map(n=>n.textContent).join(' ');

// D1 — uma preparação de público preservada (de outro acesso ou antiga) numa
// marca não pode travar a troca de marca do painel inteiro.
for(const kind of ['outro acesso','rascunho antigo'])test('D1: preparação preservada de '+kind+' em Fishermans não impede abrir O Aristocrata e voltar com o registro intacto',async()=>{
 let original;
 const version=kind==='outro acesso'?'crm-segment-v1':'crm-audience-v2';
 const x=await boot({version,setupFixture:async f=>{
  const actor=await fingerprint(kind==='outro acesso'?'synthetic-other-manager':'synthetic-manager-key');
  const draft=version==='crm-segment-v1'?{schema_version:version,brand:'fish',name:'Preparação preservada',rule:{op:'and',rules:[{op:'in_list',list_id:11}]}}:{schema_version:version,brand:'fish',name:'Preparação antiga preservada',rule:{op:'condition',field:'purchase.amount',operator:'gte',value:'123.45'}};
  original=JSON.stringify({version:1,brand:'fish',endpoint:f.api.capabilities.endpoints.segments,actor,draft,base:structuredClone(draft),server:null,...(version==='crm-audience-v2'?{draft_catalog_hash:null,draft_currency:null,draft_timezone:null}:{})});
  f.storage.setItem(editorSlot('fish'),original);
 }});
 assert.match(x.q('#crm-segments-status').textContent,kind==='outro acesso'?/outro acesso.*preservada/:/rascunho antigo/);
 await changeBrand(x,'aristo');
 assert.equal(x.run('MARCA'),'aristo',x.q('#brand-context-status').textContent);
 assert.equal(x.q('#crm-segments-editor').hidden,false);assert.ok(x.q('[data-gs-list]').textContent.includes('Lista principal aristo'));assert.ok(!x.q('[data-gs-list]').textContent.includes('fish'));
 fill(x,'aristo');assert.equal(x.f.storage.getItem(editorSlot('fish')),original);
 await changeBrand(x,'fish');assert.equal(x.run('MARCA'),'fish');
 assert.equal(x.f.storage.getItem(editorSlot('fish')),original);
 assert.match(visibleSegmentText(x),kind==='outro acesso'?/outro acesso.*preservada/:/rascunho antigo/);assert.doesNotMatch(visibleSegmentText(x),/Preparação aristo|Lista principal aristo/);
 assert.equal(JSON.parse(x.f.storage.getItem(editorSlot('aristo'))).draft.name,'Preparação aristo');
 assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);assert.ok(x.f.calls.every(c=>c.body.brand==='aristo'||c.body.brand==='fish'));
});
test('D1 (aceite): memória não gravada após conflito com outra aba continua prendendo a marca e o conteúdo aberto',async()=>{
 const x=await boot();fill(x,'fish');const other=JSON.stringify({synthetic:'other-tab'});x.f.storage.setItem(editorSlot('fish'),other);
 const input=x.q('[data-gs-name]');input.value='Edição ainda não gravada';input.dispatchEvent(new x.window.Event('input',{bubbles:true}));
 assert.match(x.q('[data-gs-status]').textContent,/Outra aba alterou/);
 await changeBrand(x,'aristo');assert.equal(x.run('MARCA'),'fish');assert.equal(x.f.storage.getItem(editorSlot('fish')),other);
 assert.equal(x.q('[data-gs-name]').value,'Edição ainda não gravada');assert.equal(x.run("restoreABExperimentBrand('aristo')"),false);
 assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);
});

// D2 — permissão negada na leitura de públicos/vínculo aparece como permissão,
// não como falha genérica de consulta, e continua bloqueando o avanço.
for(const [status,code,pattern] of [[403,'SEGMENT_ACCESS_DENIED',/acesso não permite/],[401,'SEGMENT_UNAUTHORIZED',/acesso não foi confirmado/]])
 for(const brand of ['fish','aristo'])test('D2: '+brand+' · '+status+' na lista de públicos mostra o motivo de acesso sem POST',async()=>{
  const x=await boot({brand,respond:async(u)=>u.hostname==='segments.example.test'&&u.searchParams.get('acao')==='segmentos_listar'?{status,json:async()=>({error:code})}:null});
  assert.match(visibleSegmentText(x),pattern);assert.doesNotMatch(visibleSegmentText(x),/tentar consultar novamente/);
  assert.equal(x.q('[data-gs="save"]'),null);assert.equal(x.requests.filter(r=>r.init?.method==='POST').length,0);
 });
{
 const {parseHTML}=require('linkedom'),A=require('./growth-campaign-audience-fixture.cjs'),UI=require('../growth-campaign-audience-ui.js'),GSC=require('../growth-segment-client.js');
 const uiApi=()=>{const a=structuredClone(A.api);a.capabilities.segments={contract_version:'crm-audience-v2',brands:['fish','aristo'],read:true,save:true,count:true,operation:true};a.capabilities.endpoints.segments='https://segments.example.test/api';return a;};
 const campaign=(brand,id)=>({id,version:'a'.repeat(32),status:'draft',sent:0,started_at:null,definition:{brand,name:'Campanha só lista '+brand}});
 for(const [status,code,pattern] of [[403,'SEGMENT_ACCESS_DENIED',/acesso não permite/],[401,'SEGMENT_UNAUTHORIZED',/acesso não foi confirmado/]])
  for(const [brand,id] of [['fish',100],['aristo',200]])test('D2: '+brand+' · '+status+' na leitura do vínculo informa acesso e mantém o caminho legado fechado',async()=>{
   const f=A.fixture(),{document}=parseHTML('<div id="a"></div>'),element=document.getElementById('a');
   f.control.patch=(r,p)=>p.acao===A.C.ACTIONS.read?{status,body:{error:code}}:r;
   const ui=UI.create({element,key:()=>'synthetic-manager-key',storage:f.storage,fetch:f.fetch,locks:f.locks,Client:A.C,SegmentClient:GSC});
   ui.sync({api:uiApi(),brand,campaign:campaign(brand,id),clean:true,blocked:false});
   assert.equal(await ui.confirmBindingRead(),false);
   const s=ui.contextStatus();assert.equal(s.legacyBlocked,true);assert.equal(s.readConfirmed,false);assert.equal(s.canValidate,false);
   assert.match(element.querySelector('[data-ca-status]').textContent,pattern);
   assert.deepEqual(f.calls.map(c=>c.method),['GET']);
  });
}

// D3 — contador de Público na navegação não pode exibir a contagem da marca anterior.
test('D3: contador de Público calculado em Fishermans não aparece em O Aristocrata após trocar de marca em outra seção',async()=>{
 const x=await boot({section:'visao'}),p=x.response();p.crm_base[0].segmentos={rfm:{campeao:3,leal:2}};x.setResponse(p);await x.run('carregar()');
 x.q('[data-s="base"]').click();await settled(x);const fish=x.q('#n-arv').textContent;assert.ok(Number(fish)>0);
 x.q('[data-s="visao"]').click();await settled(x);await changeBrand(x,'aristo');assert.equal(x.run('MARCA'),'aristo');
 const aristo=x.run("String(GAudience.rows(API,{brand:'aristo',catalogs:[]}).length)");assert.notEqual(aristo,fish);
 assert.ok(['',aristo].includes(x.q('#n-arv').textContent),'contador exibido: '+x.q('#n-arv').textContent);
 x.q('[data-s="base"]').click();await settled(x);assert.equal(x.q('#n-arv').textContent,aristo);
 await changeBrand(x,'fish');assert.equal(x.q('#n-arv').textContent,fish);
});

// Campanha com resultado incerto em Fishermans: diário preservado nas trocas e aviso com a marca certa.
const CAMPAIGN_END='https://campaign.example.test/operations';
const campaignCaps=c=>{c.campaigns={contract_version:'crm-campaign-v1',brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'};c.endpoints.campaigns=CAMPAIGN_END;};
const fishDefinition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Campanha incerta',subject:'Assunto fish',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[125],template_id:1,html:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',tags:[],send_at:'2030-09-20T15:00:00Z'};
async function bootPendingCampaign(section){
 let journal;
 const x=await boot({section,extraCaps:campaignCaps,setupFixture:async f=>{
  journal=JSON.stringify({version:1,brand:'fish',endpoint:CAMPAIGN_END,campaign:null,validation:null,operation:{phase:'uncertain',actorFingerprint:'f'.repeat(64),key:'existing-operation-key',request:{acao:'campanha_salvar',brand:'fish',definition:fishDefinition,idempotency_key:'existing-operation-key'}}});
  f.storage.setItem('shrigma_campaign_operation_v1:fish',journal);
 },respond:async u=>u.hostname==='campaign.example.test'?{status:503,json:async()=>({error:'synthetic_unavailable'})}:null});
 return {x,journal};
}
test('aceite: tentativa incerta de campanha em Fishermans fica preservada ao alternar Fishermans → O Aristocrata → Fishermans, sem POST',async()=>{
 const {x,journal}=await bootPendingCampaign('camp');
 assert.equal(x.run('GCE.contextStatus().pending'),true);assert.equal(x.q('[data-ce-save]').disabled,true);
 await changeBrand(x,'aristo');assert.equal(x.run('MARCA'),'aristo');assert.match(x.q('#brand-context-status').textContent,/Fishermans continua preservada/);
 assert.equal(x.q('[name=brand]').value,'aristo');assert.equal(x.q('[name=list_ids]').value,'');assert.equal(x.run('GCE.contextStatus().pending'),false);
 assert.equal(x.f.storage.getItem('shrigma_campaign_operation_v1:fish'),journal);
 await changeBrand(x,'fish');assert.equal(x.run('GCE.contextStatus().pending'),true);assert.equal(x.f.storage.getItem('shrigma_campaign_operation_v1:fish'),journal);
 assert.equal(x.requests.filter(r=>r.init?.method==='POST').length,0);
});
test('D4: aviso da tentativa incerta cita a marca da campanha, não a marca exibida antes da troca',async()=>{
 const {x,journal}=await bootPendingCampaign('camp');
 x.q('[data-s="visao"]').click();await settled(x);
 await changeBrand(x,'aristo');assert.match(x.q('#brand-context-status').textContent,/Fishermans continua preservada/);
 await changeBrand(x,'todas');assert.equal(x.run('MARCA'),'todas');
 assert.doesNotMatch(x.q('#brand-context-status').textContent,/O Aristocrata continua preservada/);
 assert.match(x.q('#brand-context-status').textContent,/Fishermans continua preservada/);
 assert.equal(x.f.storage.getItem('shrigma_campaign_operation_v1:fish'),journal);assert.equal(x.requests.filter(r=>r.init?.method==='POST').length,0);
});

// Aceite: leitura de públicos em andamento numa marca não deixa resposta tardia pintar a outra.
test('aceite: leitura de públicos de Fishermans em andamento segura a troca; depois O Aristocrata mostra só as próprias listas',async()=>{
 let release,entered;const barrier=new Promise(r=>release=r),started=new Promise(r=>entered=r);let hold=true;
 const x=await boot({section:'visao'});
 x.f.control.before=async body=>{if(hold&&body.acao==='segmentos_listar'&&body.brand==='fish'){hold=false;entered();await barrier;}};
 x.q('[data-s="base"]').click();await started;
 x.q('[data-marca="aristo"]').click();assert.equal(x.run('MARCA'),'fish');assert.match(x.q('#brand-context-status').textContent,/leitura em andamento.*Aguarde/);
 release();await settled(x);assert.ok(x.q('[data-gs-list]').textContent.includes('Lista principal fish'));
 await changeBrand(x,'aristo');assert.equal(x.run('MARCA'),'aristo');
 assert.ok(x.q('[data-gs-list]').textContent.includes('Lista principal aristo'));assert.ok(!x.q('#crm-segments-editor').textContent.includes('Lista principal fish'));
 assert.deepEqual(x.f.calls.map(c=>c.body.brand),['fish','aristo']);assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);
});
{
 const {parseHTML}=require('linkedom'),A=require('./growth-campaign-audience-fixture.cjs'),UI=require('../growth-campaign-audience-ui.js'),GSC=require('../growth-segment-client.js');
 const uiApi=()=>{const a=structuredClone(A.api);a.capabilities.campaign_audience.validate=true;a.capabilities.segments={contract_version:'crm-audience-v2',brands:['fish','aristo'],read:true,save:true,count:true,operation:true};a.capabilities.endpoints.segments='https://segments.example.test/api';return a;};
 for(const [brand,id] of [['fish',100],['aristo',200]])for(const drift of ['fonte vencida','campanha mudou'])test('aceite: '+brand+' · vínculo existente com '+drift+' mantém o caminho legado e a conferência fechados',async()=>{
  const f=A.fixture(),{document}=parseHTML('<div id="a"></div>'),element=document.getElementById('a'),b=A.bound(A.intent(brand,id));
  if(drift==='fonte vencida')b.semantic_context.current=false;else f.control.currentVersion='c'.repeat(32);
  f.rows.set(id,b);
  const ui=UI.create({element,key:()=>'synthetic-manager-key',storage:f.storage,fetch:f.fetch,locks:f.locks,Client:A.C,SegmentClient:GSC});
  ui.sync({api:uiApi(),brand,campaign:{id,version:drift==='fonte vencida'?b.campaign_version:'c'.repeat(32),status:'draft',sent:0,started_at:null,definition:{brand,name:'Campanha vinculada'}},clean:true,blocked:false});
  assert.equal(await ui.confirmBindingRead(),true);
  const s=ui.contextStatus();assert.equal(s.bound,true);assert.equal(s.legacyBlocked,true);assert.equal(s.canValidate,false);assert.equal(s.canSchedule,false);
  await ui.validate();assert.deepEqual(f.calls.map(c=>c.method),['GET']);
  const saved=JSON.parse(f.store.get(A.C.SLOT+brand+':'+id));assert.equal(saved.binding.audience_revision,b.audience_revision);assert.equal(saved.binding.binding_hash,b.binding_hash);
 });
}
