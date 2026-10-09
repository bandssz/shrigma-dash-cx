'use strict';
// Percurso 4 — operação e UX dos percursos CRM (marcas/públicos, campanha, templates).
// DOM local (vm + linkedom), sem navegador, rede, credencial real ou transporte externo.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto'),{parseHTML}=require('linkedom');
const root=path.resolve(__dirname,'..');
const tick=()=>new Promise(r=>setTimeout(r,2));
async function until(check,label='estado esperado'){for(let i=0;i<300;i++){if(check())return;await tick();}assert.fail('UI não chegou ao '+label);}
// Compara foco por rótulo: assert com nós do linkedom gera mensagens enormes quando falha.
const focusOf=doc=>{const a=doc.activeElement;return !a||a===doc.body?'body':a.id||(a.dataset?.gs?'gs:'+a.dataset.gs:a.dataset?.ca?'ca:'+a.dataset.ca:a.tagName);};
const gate=()=>{let release,entered;const barrier=new Promise(r=>release=r),started=new Promise(r=>entered=r);return {barrier,started,release,entered};};

/* ---------- 2 · leitura de campanha não fala como escrita ---------- */
{
 global.CampaignContract=require('../campaign-contract');global.CampaignTracking=require('../n8n/growth/campaign-tracking');
 const A=require('../growth-campaign-api'),createLocks=require('./campaign-lock-fixture.cjs');
 const END='https://campaign.example.test/operations',NOW=Date.parse('2026-09-19T12:00:00Z');
 const API={capabilities:{campaigns:{contract_version:A.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'},endpoints:{campaigns:END}}};
 const definition=brand=>({schema_version:A.VERSION,brand,channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Nome legível',subject:'Assunto',from_email:brand==='fish'?'Fish <contato@fishermans.com.br>':'Aristo <contato@oaristocrata.com>',reply_to:brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com',list_ids:[125],template_id:1,html:`https://${brand==='fish'?'fishermans.com.br':'oaristocrata.com'}/products/kit {{ UnsubscribeURL }}`,text:`https://${brand==='fish'?'fishermans.com.br':'oaristocrata.com'}/products/kit {{ UnsubscribeURL }}`,tags:[],send_at:'2026-09-20T15:00:00Z'});
 const catalog=brand=>({brand,current:true,lists:[{id:125,name:'Clientes recorrentes',brand,available:true}],templates:[{id:1,name:'Modelo principal',type:'campaign',available:true,version:'t1'}],initiatives:[]});
 function client(brand,handler){
  const data=new Map(),calls=[];let n=0;
  const c=A.createClient({locks:createLocks(),capabilities:A.caps(API),brand,storage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},readKey:()=>'synthetic-read-secret',writeKey:()=>'synthetic-write-secret',now:()=>NOW,uuid:()=>`fixture-operation-${++n}`,keyFingerprint:async k=>createHash('sha256').update(k).digest('hex'),
   fetch:async(url,init)=>{const request=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push({method:init.method,request});const r=await handler(request);return {status:r.status,json:async()=>r.body};}});
  return {c,calls,data};
 }
 for(const brand of ['fish','aristo'])test('D-UX2: '+brand+' · falha de leitura (catálogo, lista, campanha) diz que a leitura não foi confirmada e pode ser repetida; escrita mantém o recibo',async()=>{
  const read=client(brand,()=>({status:503,body:{error:'SERVICE_UNAVAILABLE'}}));
  for(const work of [()=>read.c.catalog(),()=>read.c.list(),()=>read.c.reopen(100)]){
   const err=await work().then(()=>null,e=>e);assert.ok(err,'leitura deveria falhar');
   assert.match(err.message,/Leitura não confirmada\. Nada foi alterado; tente carregar novamente\./);assert.doesNotMatch(err.message,/Consulte a operação/);
  }
  assert.ok(read.calls.every(c=>c.method==='GET'));assert.equal(read.data.size,0,'leitura falha não grava diário');
  // Mensagem do servidor continua prevalecendo, e 401/403 continuam como acesso.
  const told=client(brand,()=>({status:503,body:{error:'X',message:'Mensagem do serviço.'}}));assert.equal((await told.c.catalog().catch(e=>e)).message,'Mensagem do serviço.');
  const denied=client(brand,()=>({status:403,body:{error:'CAPABILITY_MISSING'}}));assert.equal((await denied.c.catalog().catch(e=>e)).message,'Esta chave não tem permissão para a ação.');
  // Escrita: texto pensado para recibo permanece idêntico.
  const write=client(brand,r=>r.acao==='campanha_catalogo'?{status:200,body:catalog(brand)}:{status:503,body:{error:'SERVICE_UNAVAILABLE'}});
  await write.c.catalog();const err=await write.c.save(definition(brand)).catch(e=>e);
  assert.equal(err.message,'Resultado não confirmado. Consulte a operação antes de repetir.');assert.equal(write.c.locked(),true);
 });
}

/* ---------- editor de campanha (3 e 4) ---------- */
{
 const audienceFixture=require('./campaign-audience-fixture.cjs'),createLocks=require('./campaign-lock-fixture.cjs'),C=require('../campaign-contract'),Editor=require('../growth-campaign-editor');
 const END='https://campaign.example.test/operations';
 const fullCaps={contract_version:C.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'};
 const def=(brand,send_at)=>{const host=brand==='fish'?'fishermans.com.br':'oaristocrata.com';return {schema_version:C.VERSION,brand,channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Campanha de exemplo',subject:'Assunto',from_email:brand==='fish'?'Fish <contato@fishermans.com.br>':'Aristo <contato@oaristocrata.com>',reply_to:'contato@'+host,list_ids:[125],template_id:1,html:`https://${host}/products/kit {{ UnsubscribeURL }}`,text:`https://${host}/products/kit {{ UnsubscribeURL }}`,tags:[],send_at};};
 function boot({brand='fish',send_at=null,caps=fullCaps}={}){
  const {document,window}=parseHTML('<section id="campaign-composer"></section>'),store=new Map(),calls=[];
  const proto=Object.getPrototypeOf(document.createElement('select'));
  Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
  const d=def(brand,send_at);store.set('shrigma_growth_editor_v1:campaign:'+brand,JSON.stringify({version:1,area:'campaign',brand,value:Editor.fromDefinition(d)}));store.set('write-slot','synthetic-write-secret');store.set('read-slot','synthetic-read-secret');
  const catalog={brand,current:true,lists:[{id:125,name:'Clientes recorrentes',brand,available:true}],templates:[{id:1,name:'Modelo principal',type:'campaign',available:true,version:'t1'}],initiatives:[]};
  let current=null;const clock=Date.now();
  const context=vm.createContext({document,window,console,Date,Intl,URL,URLSearchParams,AbortSignal,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,navigator:{locks:createLocks()},shrigmaChave:p=>p==='growth'?store.get('read-slot'):'',
   localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},GTA:{CHAVE_ESCRITA:'write-slot',CHAVE_LEITURA:'read-slot'},GMP:{openEmail:()=>{}},confirm:()=>{throw Error('native confirm');},__api:{capabilities:{campaigns:caps,endpoints:{campaigns:END}}},
   fetch:async(url,init)=>{const req=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push(req);let body;
    if(req.acao==='campanha_catalogo')body=catalog;else if(req.acao==='campanha_listar')body={campaigns:current?[current]:[]};else if(req.acao==='campanha_obter')body={campaign:current};
    else if(req.acao==='campanha_salvar'){current={id:100,version:'v1',status:'draft',sent:0,started_at:null,send_at:req.definition.send_at,definition:req.definition};body={campaign:current};}
    else if(req.acao==='campanha_validar')body={campaign:current,validation:{policy:C.VERSION,version:current.version,ok:true,audience:audienceFixture(current,clock)}};
    else throw Error('rota inesperada '+req.acao);
    return {status:200,json:async()=>structuredClone(body)};}});
  for(const file of ['n8n/growth/campaign-tracking.js','campaign-contract.js','growth-brand-state.js','growth-campaign-api.js','growth-utm.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  vm.runInContext('GCE.mount({marca:'+JSON.stringify(brand)+',api:__api})',context);
  require('./campaign-dialog-fixture.cjs')(document,window);
  return {document,window,calls,store,run:c=>vm.runInContext(c,context),q:s=>document.querySelector(s)};
 }
 async function saveAndValidate(x){
  x.q('[data-ce-refresh]').click();await until(()=>x.q('[data-ce-list]'),'catálogo');
  x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled,'campanha salva');
  x.q('[data-ce-validate]').click();await until(()=>/pessoas podem receber/.test(x.q('[data-ce-audience]').textContent),'conferência');
 }
 for(const brand of ['fish','aristo'])test('D-UX3: '+brand+' · rascunho conferido sem data de envio pede para preencher data/hora em Brasília, não "15 minutos"',async()=>{
  const x=boot({brand});assert.equal(x.q('[name=send_at]').value,'');
  await saveAndValidate(x);
  const warning=x.q('.ce-audience-warning')?.textContent||'';
  assert.match(warning,/Preencha a data e a hora de envio \(horário de Brasília\)/);assert.doesNotMatch(warning,/15 minutos/);
  assert.equal(x.q('[data-ce-schedule]').disabled,true);assert.ok(x.calls.every(c=>c.acao!=='campanha_agendar'));
 });
 test('D-UX3 (controle): data preenchida mas próxima demais continua com o aviso de 15 minutos',async()=>{
  const x=boot({send_at:new Date(Date.now()+5*60e3).toISOString()});await saveAndValidate(x);
  assert.match(x.q('.ce-audience-warning').textContent,/Agende com pelo menos 15 minutos de antecedência/);assert.equal(x.q('[data-ce-schedule]').disabled,true);
 });
 for(const brand of ['fish','aristo'])test('D-UX4: '+brand+' · campanhas anunciadas só para leitura dizem que o acesso é de leitura em vez de pedir chave',async()=>{
  const caps={...fullCaps,save:false,validate:false,schedule:false,cancel:false};
  const x=boot({brand,caps});
  assert.equal(x.q('[data-ce-remote]').hidden,false);
  for(const a of ['save','validate','schedule','cancel','new'])assert.equal(x.q(`[data-ce-${a}]`).hidden,true,a);
  assert.match(x.q('[data-ce-key-state]').textContent,/Seu acesso a campanhas é de leitura/);assert.doesNotMatch(x.q('[data-ce-key-state]').textContent,/Informe a chave/);
  assert.equal(x.q('[data-ce-refresh]').hidden,false);assert.equal(x.calls.length,0);
  // Lista vazia não aponta para "Preparar novo rascunho", que este acesso não oferece.
  x.q('[data-ce-refresh]').click();await until(()=>x.q('.ce-campaign-list'),'lista de campanhas');
  assert.equal(x.q('.ce-campaign-list').textContent,'Nenhuma campanha salva nesta marca.');assert.ok(x.calls.every(c=>['campanha_catalogo','campanha_listar'].includes(c.acao)));
  // Controle: com escrita anunciada o pedido de chave continua igual.
  const y=boot({brand});assert.equal(y.q('[data-ce-key-state]').textContent,'Acesso legado disponível neste navegador.');assert.equal(y.q('[data-ce-save]').hidden,false);
  y.q('[data-ce-refresh]').click();await until(()=>y.q('.ce-campaign-list'),'lista de campanhas');assert.match(y.q('.ce-campaign-list').textContent,/Use Preparar novo rascunho para começar\./);
 });
}

/* ---------- públicos personalizados (1 · estado, 4 e 5) ---------- */
{
 const {fixture,api}=require('./growth-segment-fixture.cjs'),UI=require('../growth-segment-ui.js');
 function boot(f=fixture(),{fetch=f.fetch}={}){
  const {document,window}=parseHTML('<html><body><button id="outside">Criar público</button><section id="segments"></section></body></html>');
  const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
  const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
  let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
  const element=document.querySelector('#segments'),ui=UI.create({element,document,key:()=>'synthetic-actor-one',storage:f.storage,fetch,locks:f.locks});
  const q=s=>element.querySelector(s),input=(s,v,e='change')=>{q(s).value=v;q(s).dispatchEvent(new window.Event(e,{bubbles:true}));};
  return {f,ui,element,document,window,q,input,focus:el=>{focused=el;}};
 }
 const fill=(x,brand)=>{x.input('[data-gs-name]','Público de '+brand,'input');x.input('[data-gs-list]',brand==='fish'?'11':'21');};
 const settled=async x=>until(()=>!x.ui.contextStatus().busy,'público ocioso');
 const patchList=(f,patch)=>async(url,init)=>{const r=await f.fetch(url,init),body=await r.json();const acao=init.method==='POST'?JSON.parse(init.body).acao:new URL(url).searchParams.get('acao');if(acao==='segmentos_listar')patch(body);return {status:r.status,json:async()=>body};};
 for(const brand of ['fish','aristo']){
  test('D-UX4: '+brand+' · anúncio somente de leitura explica Salvar/Contar desabilitados e não oferece exclusão',async()=>{
   const x=boot(),readOnly=structuredClone(api);readOnly.capabilities.segments.save=false;readOnly.capabilities.segments.count=false;
   await x.ui.sync({api:readOnly,brand});fill(x,brand);
   assert.equal(x.q('[data-gs="archive"]'),null);
   for(const a of ['save','count']){assert.equal(x.q(`[data-gs="${a}"]`).disabled,true,a);assert.equal(x.q(`[data-gs="${a}"]`).getAttribute('aria-describedby'),'gs-access-note',a);}
   assert.match(x.q('#gs-access-note').textContent,/Seu acesso a públicos é de leitura: consultar está disponível; salvar, arquivar e contar não estão liberados\./);
   assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);
  });
  test('D-UX4: '+brand+' · permissão pessoal sem rascunho ou sem contagem explica só o que falta',async()=>{
   const f=fixture(),x=boot(f,{fetch:patchList(f,b=>{b.capabilities.draft=false;})});await x.ui.sync({api,brand});fill(x,brand);
   assert.equal(x.q('[data-gs="save"]').disabled,true);assert.equal(x.q('[data-gs="save"]').getAttribute('aria-describedby'),'gs-access-note');
   assert.equal(x.q('[data-gs="count"]').disabled,false);assert.equal(x.q('[data-gs="count"]').hasAttribute('aria-describedby'),false);
   assert.match(x.q('#gs-access-note').textContent,/consultar e contar estão disponíveis; salvar e arquivar não estão liberados/);
   const g=fixture(),y=boot(g,{fetch:patchList(g,b=>{b.capabilities.count=false;})});await y.ui.sync({api,brand});fill(y,brand);
   assert.equal(y.q('[data-gs="save"]').disabled,false);assert.equal(y.q('[data-gs="count"]').disabled,true);assert.match(y.q('#gs-access-note').textContent,/Contar público não está liberado para este acesso/);
  });
  test('D-UX4 (controle): '+brand+' · acesso completo e catálogo vencido não alegam acesso de leitura',async()=>{
   const x=boot();await x.ui.sync({api,brand});fill(x,brand);assert.ok(!x.q('#gs-access-note'));assert.equal(x.q('[data-gs="save"]').hasAttribute('aria-describedby'),false);
   const f=fixture();f.control.catalogPatch={current:false};const y=boot(f,{fetch:patchList(f,b=>{b.capabilities.draft=false;b.capabilities.count=false;})});await y.ui.sync({api,brand});
   assert.ok(!y.q('#gs-access-note'));
  });
  test('D-UX5: '+brand+' · Voltar ou Esc na confirmação de público fecham sem efeito e devolvem o foco a quem abriu',async()=>{
   const x=boot();await x.ui.sync({api,brand});fill(x,brand);x.q('[data-gs="save"]').click();await settled(x);const posts=()=>x.f.calls.filter(c=>c.method==='POST').length,before=posts();
   for(const close of ['back','escape']){
    x.focus(x.q('[data-gs="archive"]'));x.q('[data-gs="archive"]').click();
    assert.equal(x.q('[data-gs-dialog]').hasAttribute('open'),true);assert.equal(focusOf(x.document),'gs:back');
    if(close==='back')x.q('[data-gs="back"]').click();else{const e=new x.window.Event('cancel',{cancelable:true});x.q('[data-gs-dialog]').oncancel(e);assert.equal(e.defaultPrevented,true);}
    assert.equal(x.q('[data-gs-dialog]').hasAttribute('open'),false);assert.equal(focusOf(x.document),'gs:archive',close);assert.ok(x.document.activeElement===x.q('[data-gs="archive"]'));assert.equal(posts(),before);
   }
   // Confirmação aberta por um botão fora do editor devolve o foco a ele.
   x.input('[data-gs-name]','Alteração local','input');const outside=x.document.getElementById('outside');x.focus(outside);x.q('[data-gs="new"]').click();
   assert.equal(x.ui.contextStatus().confirming,true);x.q('[data-gs="back"]').click();assert.equal(focusOf(x.document),'outside');assert.equal(x.q('[data-gs-name]').value,'Alteração local');
  });
 }
 test('D-UX1 (estado): públicos expõem leitura e confirmação separadas da escrita',async()=>{
  const x=boot();await x.ui.sync({api,brand:'fish'});fill(x,'fish');
  const s0=x.ui.contextStatus();assert.equal(s0.reading,false);assert.equal(s0.confirming,false);
  let g=gate();x.f.control.before=async b=>{if(b.acao==='segmentos_listar'){x.f.control.before=null;g.entered();await g.barrier;}};
  x.q('[data-gs="refresh"]').click();await g.started;let s=x.ui.contextStatus();assert.equal(s.navigationBlocked,true);assert.equal(s.reading,true);assert.equal(s.confirming,false);g.release();await settled(x);
  g=gate();x.f.control.before=async b=>{if(b.acao==='segmento_contar'){x.f.control.before=null;g.entered();await g.barrier;}};
  x.q('[data-gs="count"]').click();await g.started;assert.equal(x.ui.contextStatus().reading,true);g.release();await settled(x);
  g=gate();x.f.control.before=async b=>{if(b.acao==='segmento_criar'){x.f.control.before=null;g.entered();await g.barrier;}};
  x.q('[data-gs="save"]').click();await g.started;s=x.ui.contextStatus();assert.equal(s.navigationBlocked,true);assert.equal(s.reading,false);g.release();await settled(x);
  x.q('[data-gs="archive"]').click();s=x.ui.contextStatus();assert.equal(s.confirming,true);assert.equal(s.reading,false);x.q('[data-gs="back"]').click();
 });
}

/* ---------- público salvo da campanha (1 · estado e 4) ---------- */
{
 const A=require('./growth-campaign-audience-fixture.cjs'),UI=require('../growth-campaign-audience-ui.js'),GSC=require('../growth-segment-client.js');
 const uiApi=patch=>{const a=structuredClone(A.api);Object.assign(a.capabilities.campaign_audience,patch);a.capabilities.segments={contract_version:'crm-audience-v2',brands:['fish','aristo'],read:true,save:true,count:true,operation:true};a.capabilities.endpoints.segments='https://segments.example.test/api';return a;};
 const campaign=(brand,id)=>({id,version:'a'.repeat(32),status:'draft',sent:0,started_at:null,send_at:null,definition:{brand,name:'Campanha '+brand}});
 function mount(brand,id,patch={}){const f=A.fixture(),{document}=parseHTML('<div id="a"></div>'),element=document.getElementById('a');const ui=UI.create({element,key:()=>'synthetic-manager-key',storage:f.storage,fetch:f.fetch,locks:f.locks,Client:A.C,SegmentClient:GSC});ui.sync({api:uiApi(patch),brand,campaign:campaign(brand,id),clean:true,blocked:false});return {f,ui,element,q:s=>element.querySelector(s)};}
 for(const [brand,id] of [['fish',100],['aristo',200]]){
  test('D-UX4: '+brand+' · público salvo sem conferir/usar anunciados explica os botões desabilitados',()=>{
   const x=mount(brand,id,{inspect:false,bind:false,release:false});
   assert.equal(x.q('[data-ca="inspect"]').disabled,true);assert.equal(x.q('[data-ca="inspect"]').getAttribute('aria-describedby'),'ca-access-note');assert.equal(x.q('[data-ca="bind"]').getAttribute('aria-describedby'),'ca-access-note');
   assert.match(x.q('#ca-access-note').textContent,/Seu acesso a públicos salvos é de leitura: consultar o vínculo está disponível; conferir e usar outro público não estão liberados\./);
   const y=mount(brand,id,{bind:false,release:false});assert.equal(y.q('[data-ca="inspect"]').hasAttribute('aria-describedby'),false);assert.match(y.q('#ca-access-note').textContent,/usar outro público nesta campanha não está liberado/);
   const z=mount(brand,id);assert.ok(!z.q('#ca-access-note'));assert.equal(z.q('[data-ca="bind"]').hasAttribute('aria-describedby'),false);
   assert.equal(x.f.calls.length+y.f.calls.length+z.f.calls.length,0);
  });
  test('D-UX5: '+brand+' · Voltar ou Esc na confirmação do público salvo fecham sem efeito e devolvem o foco a quem abriu',async()=>{
   const f=A.fixture(),{document,window}=parseHTML('<html><body><div id="a"></div></body></html>'),element=document.getElementById('a');
   const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
   let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
   const b=A.bound(A.intent(brand,id));b.campaign_version='a'.repeat(32);f.rows.set(id,b);
   const ui=UI.create({element,key:()=>'synthetic-manager-key',storage:f.storage,fetch:f.fetch,locks:f.locks,Client:A.C,SegmentClient:GSC});
   ui.sync({api:uiApi(),brand,campaign:campaign(brand,id),clean:true,blocked:false});assert.equal(await ui.confirmBindingRead(),true);
   const q=s=>element.querySelector(s);
   for(const close of ['back','escape']){
    const release=q('[data-ca="release"]');assert.equal(release.disabled,false);release.focus();release.click();await tick();
    assert.equal(q('[data-ca-dialog]').hasAttribute('open'),true);assert.ok(document.activeElement===q('[data-ca-no]'),close+': foco em '+focusOf(document));
    if(close==='back')q('[data-ca-no]').click();else{const e=new window.Event('cancel',{cancelable:true});q('[data-ca-dialog]').oncancel(e);assert.equal(e.defaultPrevented,true);}
    await tick();assert.ok(!q('[data-ca-dialog]')?.hasAttribute('open'));assert.ok(document.activeElement===q('[data-ca="release"]'),close+': foco em '+focusOf(document));
   }
   assert.deepEqual(f.calls.map(c=>c.method),['GET']);
  });
  test('D-UX1 (estado): '+brand+' · leitura do vínculo aparece como leitura, não como operação',async()=>{
   const x=mount(brand,id),g=gate();x.f.control.before=async p=>{if(p.acao===A.C.ACTIONS.read){x.f.control.before=null;g.entered();await g.barrier;}};
   const done=x.ui.confirmBindingRead();await g.started;const s=x.ui.contextStatus();assert.equal(s.activeOperation,true);assert.equal(s.reading,true);assert.equal(s.confirming,false);
   g.release();assert.equal(await done,true);assert.equal(x.ui.contextStatus().reading,false);
  });
 }
}

/* ---------- 5 · confirmação de publicação de template ---------- */
{
 function setup(brand,caps={templates:{draft:true,validate:true,submit:true,submit_email:true}}){
  const {document,window}=parseHTML('<html><body><section id="control-drafts"></section></body></html>'),values=new Map(),calls=[];let focused;
  window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
  Object.defineProperty(document,'activeElement',{get:()=>focused?.isConnected?focused:document.body});
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},locks={request:async(k,o,fn)=>fn({})};
  const ctx=vm.createContext({document,window,localStorage:storage,crypto:webcrypto,TextEncoder,URL,URLSearchParams,Date,Intl,console,navigator:{locks},setInterval:()=>1,shrigmaChaveOperador:()=>'synthetic-manager',confirm:()=>{throw Error('native confirm');},fetch:async(url,options={})=>{calls.push({url,options});throw Error('sem rede');}});
  for(const f of ['growth-email-expressions.js','whatsapp-template-contract.js','growth-email-contract.js','growth-drafts.js','growth-templates-api.js','growth-template-journal.js','growth-table.js','growth-message-preview.js','growth-brand-state.js','growth-drafts-ui.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
  const run=s=>vm.runInContext(s,ctx);run('globalThis.ui=GRU;globalThis.gr=GR;globalThis.gta=GTA');
  ctx.ui.render({marca:brand,api:{capabilities:{...caps,endpoints:{templates:'https://example.invalid/templates'}}}});
  return {ui:ctx.ui,gr:ctx.gr,gta:ctx.gta,document,window,calls,$:s=>document.querySelector(s)};
 }
 for(const brand of ['fish','aristo'])test('aceite D-UX4: '+brand+' · templates sem escrita anunciada não mostram botão morto e dizem que salvar é só neste dispositivo',()=>{
  const s=setup(brand,{templates:{read_content:true}});s.$('#drafts-novo-email').click();
  for(const id of ['d-servidor','d-validar','d-submeter'])assert.ok(!s.$('#'+id),id);
  assert.match(s.$('#draft-editor').textContent,/Salvamento apenas neste dispositivo · não publica nem envia\./);assert.equal(s.$('#d-salvar').disabled,false);assert.equal(s.calls.length,0);
 });
 for(const brand of ['fish','aristo'])for(const channel of ['whatsapp','email'])test('D-UX5: '+brand+' · '+channel+' · Esc e Cancelar fecham a publicação sem efeito e devolvem o foco a "Publicar"',()=>{
  const s=setup(brand),r=s.gr.novo({marca:brand,canal:channel,nome:'synthetic_template',corpo:'Olá, conteúdo de exemplo.',assunto:'Assunto',preheader:'Resumo',...(channel==='email'?{from_email:brand==='fish'?'Fishermans <contato@fishermans.com.br>':'O Aristocrata <contato@oaristocrata.com>',reply_to:brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com'}:{})});
  s.ui.abrir(r,null);s.ui.state.rascunho.servidor={draft_id:'saved',version:4,estado:'validado',hash:s.gta.hash(s.gr.conteudo(s.ui.state.rascunho)),salvo_em:'2026-09-26T12:00:00Z'};s.ui.render();
  for(const close of ['escape','cancel']){
   s.$('#d-submeter').focus();s.$('#d-submeter').click();assert.ok(s.$('#d-confirmar'));assert.equal(s.document.activeElement.id,'d-confirm-texto');
   if(close==='escape'){const e=new s.window.Event('keydown',{bubbles:true,cancelable:true});e.key='Escape';s.$('#d-confirm-texto').dispatchEvent(e);assert.equal(e.defaultPrevented,true);}
   else{s.$('#d-confirm-cancel').focus();s.$('#d-confirm-cancel').click();}
   assert.ok(!s.$('#d-confirmar'),close);assert.equal(s.ui.state.confirmando,false);assert.equal(s.document.activeElement.id,'d-submeter',close);
  }
  assert.equal(s.calls.length,0);
 });
}

/* ---------- 1 · troca de marca na página real ---------- */
{
 const F=require('./growth-segment-fixture.cjs'),manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/panel-build/manifest.json'))).growth;
 const CAMPAIGN_END='https://campaign.example.test/operations';
 const campaignCaps=c=>{c.campaigns={contract_version:'crm-campaign-v1',brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'};c.endpoints.campaigns=CAMPAIGN_END;};
 function payload(capabilities){return {_escopo:'growth',_painel:'growth',gerado_em:'2026-09-28T12:00:00Z',capabilities,
  ...Object.fromEntries(['crm_campanha','crm_fluxo','crm_conversao','crm_campanha_receita','crm_campanha_grupo','crm_diario','crm_intradia','crm_carrinho','crm_galho','crm_regra_galho','crm_teste','crm_teste_braco','crm_credencial','wa_saude'].map(k=>[k,[]])),
  crm_base:['fish','aristo'].map(marca=>({marca,dia:'2026-09-28',coletado_em:'2026-09-28T12:00:00Z',total:marca==='fish'?12:34,segmentos:{}}))};}
 async function boot({brand='fish',section='base',extraCaps=null,respond=null,operatorCaps=['read_content','draft']}={}){
  const f=F.fixture(),{document,window}=parseHTML(fs.readFileSync(path.join(root,'growth.html'),'utf8'));
  const selectProto=Object.getPrototypeOf(document.createElement('select'));
  Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
  const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
  dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
  Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
  let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
  window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
  const capabilities=structuredClone(f.api.capabilities);if(extraCaps)extraCaps(capabilities);
  const requests=[],response=payload(capabilities);
  const NativeDate=Date;class FixedDate extends Date{constructor(...a){super(...(a.length?a:['2026-09-28T12:10:00Z']));}static now(){return Date.parse('2026-09-28T12:10:00Z');}}
  const context=vm.createContext({document,window,URL,URLSearchParams,Date:FixedDate,Intl,AbortSignal,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,navigator:{locks:f.locks},console,
   localStorage:f.storage,location:{hash:'#marca='+brand+'&sec='+section,search:''},history:{replaceState(){}},
   addEventListener(){},setInterval(){return 1;},clearInterval(){},setTimeout,clearTimeout,queueMicrotask,Image:class{},Blob:class{},prompt:()=>null,confirm:()=>false,
   fetch:async(url,init)=>{requests.push({url,init});const u=new URL(url);
    if(respond){const custom=await respond(u,init);if(custom)return custom;}
    if(u.hostname==='segments.example.test')return f.fetch(url,init);
    const body=structuredClone(response);if(u.searchParams.get('action')==='cache_growth')body._cache_gerado_em=new NativeDate(FixedDate.now()).toISOString();return {status:200,ok:true,json:async()=>body};}});
  const run=code=>vm.runInContext(code,context);
  for(const script of manifest.scripts)vm.runInContext(fs.readFileSync(path.join(root,script),'utf8'),context,{filename:script});
  run("shrigmaGuardaChave('growth','synthetic-manager-key');SHRIGMA_OPERATOR_SESSION.growth={caps:"+JSON.stringify(operatorCaps)+",label:'Synthetic manager'};");
  for(const script of document.querySelectorAll('script:not([src])'))vm.runInContext(script.textContent,context,{filename:'growth-inline.js'});
  const x={f,document,window,run,requests,q:s=>document.querySelector(s)};await settled(x);return x;
 }
 async function settled(x){for(let i=0;i<300;i++){if(!x.run('LOADING||CRM_SEGMENT_SYNC||CRM_AUDIENCE_CREATE_BUSY||CRM_SEGMENT_VIEW?.contextStatus().busy||GCE.contextStatus().navigationBlocked'))return;await tick();}assert.fail('painel local não estabilizou');}
 const notice=x=>x.q('#brand-context-status').textContent;
 const READING=/Há uma leitura em andamento \(catálogo, campanhas ou públicos\)\. Aguarde terminar para trocar de marca; nada foi alterado\./;
 const fill=(x,brand)=>{const i=x.q('[data-gs-name]');i.value='Preparação '+brand;i.dispatchEvent(new x.window.Event('input',{bubbles:true}));const s=x.q('[data-gs-list]');s.value=brand==='fish'?'11':'21';s.dispatchEvent(new x.window.Event('change',{bubbles:true}));};
 for(const [from,to] of [['fish','aristo'],['aristo','fish']]){
  test('D-UX1: '+from+' · lista de públicos em leitura recusa a troca pedindo para aguardar a leitura',async()=>{
   const g=gate();let hold=true;const x=await boot({brand:from,section:'visao'});
   x.f.control.before=async b=>{if(hold&&b.acao==='segmentos_listar'&&b.brand===from){hold=false;g.entered();await g.barrier;}};
   x.q('[data-s="base"]').click();await g.started;
   x.q('[data-marca="'+to+'"]').click();assert.equal(x.run('MARCA'),from);assert.match(notice(x),READING);assert.doesNotMatch(notice(x),/Conclua a operação|confirmação aberta/);
   g.release();await settled(x);x.q('[data-marca="'+to+'"]').click();if(x.q('#brand-change-confirm').open)x.q('#brand-change-accept').click();await settled(x);assert.equal(x.run('MARCA'),to);
   assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);
  });
  test('D-UX1: '+from+' · catálogo de campanha em leitura recusa a troca pedindo para aguardar a leitura',async()=>{
   const g=gate();let hold=true;
   const catalog={brand:from,current:true,lists:[{id:125,name:'Clientes',brand:from,available:true}],templates:[],initiatives:[]};
   const x=await boot({brand:from,section:'camp',extraCaps:campaignCaps,respond:async u=>{
    if(u.hostname!=='campaign.example.test')return null;const acao=u.searchParams.get('acao');
    if(acao==='campanha_catalogo'){if(hold){hold=false;g.entered();await g.barrier;}return {status:200,json:async()=>structuredClone(catalog)};}
    if(acao==='campanha_listar')return {status:200,json:async()=>({campaigns:[]})};return {status:503,json:async()=>({error:'synthetic'})};}});
   x.q('[data-ce-refresh]').click();await g.started;
   x.q('[data-marca="'+to+'"]').click();assert.equal(x.run('MARCA'),from);assert.match(notice(x),READING);assert.equal(x.run('GCE.contextStatus().reading'),true);
   g.release();await settled(x);assert.equal(x.run('GCE.contextStatus().reading'),false);
   x.q('[data-marca="'+to+'"]').click();if(x.q('#brand-change-confirm').open)x.q('#brand-change-accept').click();await settled(x);assert.equal(x.run('MARCA'),to);
   assert.equal(x.requests.filter(r=>r.init?.method==='POST').length,0);
  });
 }
 for(const brand of ['fish','aristo'])test('aceite D-UX4: '+brand+' · operador sem permissão de rascunho vê "Criar público" desabilitado com o motivo ao lado',async()=>{
  const x=await boot({brand,operatorCaps:['read_content']});
  assert.equal(x.q('#crm-audience-create').disabled,true);assert.equal(x.q('#crm-audience-create-status').hidden,false);
  assert.equal(x.q('#crm-audience-create-status').textContent,'A criação de públicos não está disponível neste acesso.');
  assert.equal(x.f.calls.length,0);assert.equal(x.requests.filter(r=>r.init?.method==='POST').length,0);
 });
 test('D-UX1 (controle): escrita de público em andamento mantém "Conclua a operação"; confirmação aberta pede para fechá-la',async()=>{
  const x=await boot();fill(x,'fish');const g=gate();
  x.f.control.before=async b=>{if(b.acao==='segmento_criar'){x.f.control.before=null;g.entered();await g.barrier;}};
  x.q('[data-gs="save"]').click();await g.started;
  x.q('[data-marca="aristo"]').click();assert.equal(x.run('MARCA'),'fish');assert.match(notice(x),/^Conclua a operação ou feche a confirmação aberta antes de trocar de marca\.$/);
  g.release();await settled(x);
  x.q('[data-gs="archive"]').click();assert.equal(x.q('[data-gs-dialog]').open,true);
  assert.equal(x.run('trocaMarca("aristo")'),false);assert.equal(x.run('MARCA'),'fish');assert.equal(notice(x),'Feche a confirmação aberta antes de trocar de marca.');
  x.q('[data-gs="back"]').click();assert.equal(x.f.calls.filter(c=>c.method==='POST').length,1);
 });
}
