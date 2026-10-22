'use strict';
// Percurso 1 (duas marcas, duas abas): a segunda aba abre na marca salva na
// preferência e troca de marca. Preservar sem conteúdo do usuário não pode criar
// a preparação vazia que depois trava a primeira aba com "Outra aba alterou".
// Página real + fontes do manifesto em DOM local; localStorage compartilhado.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{parseHTML}=require('linkedom');
const F=require('./growth-segment-fixture.cjs'),root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/panel-build/manifest.json'))).growth;
const slot=(area,brand)=>'shrigma_growth_editor_v1:'+area+':'+brand;
const other={fish:'aristo',aristo:'fish'};

// Duas abas = dois contextos de GBS sobre o mesmo armazenamento.
function sharedStorage(entries=[]){const map=new Map(entries);return {map,storage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)}};}
function gbsTab(storage){const context=vm.createContext({localStorage:storage});vm.runInContext(fs.readFileSync(path.join(root,'growth-brand-state.js'),'utf8'),context);return s=>vm.runInContext(s,context);}

for(const brand of ['fish','aristo'])for(const area of ['campaign','template']){
 const empty=area==='campaign'?{brand,subject:'',_campaign:null}:{editando:null,rascunho:null};
 const real=area==='campaign'?{brand,subject:'Conteúdo da primeira aba',_campaign:null}:{editando:null,rascunho:{id:'t1',marca:brand,nome:'Template da primeira aba'}};
 test(`GBS ${brand}/${area}: preservar a preparação vazia que não existia não cria slot nem trava a outra aba`,()=>{
  const {map,storage}=sharedStorage(),a=gbsTab(storage),b=gbsTab(storage),key=slot(area,brand);
  assert.equal(a(`GBS.read('${area}','${brand}')`),null);assert.equal(b(`GBS.read('${area}','${brand}')`),null);
  b(`GBS.save('${area}','${brand}',${JSON.stringify(empty)},${JSON.stringify(empty)})`);
  assert.equal(map.has(key),false,'preservar vazio não cria a preparação');
  a(`GBS.save('${area}','${brand}',${JSON.stringify(real)},${JSON.stringify(empty)})`);
  assert.deepEqual(JSON.parse(map.get(key)).value,real);
 });
 test(`GBS ${brand}/${area} (aceite): conteúdo real de outra aba continua bloqueando a sobrescrita`,()=>{
  const {map,storage}=sharedStorage(),a=gbsTab(storage),b=gbsTab(storage),key=slot(area,brand);
  a(`GBS.read('${area}','${brand}')`);b(`GBS.read('${area}','${brand}')`);
  a(`GBS.save('${area}','${brand}',${JSON.stringify(real)},${JSON.stringify(empty)})`);const written=map.get(key);
  const stale=area==='campaign'?{...real,subject:'Edição da segunda aba'}:{...real,rascunho:{...real.rascunho,nome:'Edição da segunda aba'}};
  assert.throws(()=>b(`GBS.save('${area}','${brand}',${JSON.stringify(stale)},${JSON.stringify(empty)})`),/Outra aba alterou/);
  assert.equal(map.get(key),written);
  // Preservar o vazio que esta aba leu não apaga o conteúdo real da outra aba.
  b(`GBS.save('${area}','${brand}',${JSON.stringify(empty)},${JSON.stringify(empty)})`);assert.equal(map.get(key),written);
 });
 test(`GBS ${brand}/${area}: preservar exatamente o que foi lido não regrava nem acusa conflito`,()=>{
  const key=slot(area,brand),raw=JSON.stringify({version:1,area,brand,value:real}),{map,storage}=sharedStorage([[key,raw]]),a=gbsTab(storage),b=gbsTab(storage);
  a(`GBS.read('${area}','${brand}')`);b(`GBS.read('${area}','${brand}')`);
  const edited=area==='campaign'?{...real,subject:'Edição da primeira aba'}:{...real,rascunho:{...real.rascunho,nome:'Edição da primeira aba'}};
  a(`GBS.save('${area}','${brand}',${JSON.stringify(edited)})`);const written=map.get(key);
  b(`GBS.save('${area}','${brand}',${JSON.stringify(real)})`);assert.equal(map.get(key),written,'a aba sem alteração não sobrescreve');
  assert.throws(()=>b(`GBS.save('${area}','${brand}',${JSON.stringify({...edited,extra:'x'})})`),/Outra aba alterou/);assert.equal(map.get(key),written);
 });
}

// Painel inteiro em duas abas.
function payload(capabilities){return {_escopo:'growth',_painel:'growth',gerado_em:'2026-09-28T12:00:00Z',capabilities,
 ...Object.fromEntries(['crm_campanha','crm_fluxo','crm_conversao','crm_campanha_receita','crm_campanha_grupo','crm_diario','crm_intradia','crm_carrinho','crm_galho','crm_regra_galho','crm_teste','crm_teste_braco','crm_credencial','wa_saude'].map(k=>[k,[]])),
 crm_base:['fish','aristo'].map(marca=>({marca,dia:'2026-09-28',coletado_em:'2026-09-28T12:00:00Z',total:marca==='fish'?12:34,segmentos:{}}))};}
async function boot({brand='fish',section='base',storage=null}={}){
 const f=F.fixture(),html=fs.readFileSync(path.join(root,'growth.html'),'utf8'),{document,window}=parseHTML(html);
 const localStorage=storage||f.storage;
 const selectProto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
 dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const capabilities=structuredClone(f.api.capabilities),requests=[];
 const NativeDate=Date;class FixedDate extends Date{constructor(...a){super(...(a.length?a:['2026-09-28T12:10:00Z']));}static now(){return Date.parse('2026-09-28T12:10:00Z');}}
 const context=vm.createContext({document,window,URL,URLSearchParams,Date:FixedDate,Intl,AbortSignal,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,navigator:{locks:f.locks},console,
  localStorage,location:{hash:'#marca='+brand+'&sec='+section,search:''},history:{replaceState(){}},
  addEventListener(){},setInterval(){return 1;},clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
  Image:class{},Blob:class{},prompt:()=>null,confirm:()=>false,
  fetch:async(url,init)=>{requests.push({url,init});const u=new URL(url);
   if(u.hostname==='segments.example.test')return f.fetch(url,init);
   const body=payload(capabilities);if(u.searchParams.get('action')==='cache_growth')body._cache_gerado_em=new NativeDate(FixedDate.now()).toISOString();return {status:200,ok:true,json:async()=>body};}});
 const run=code=>vm.runInContext(code,context);
 for(const script of manifest.scripts)vm.runInContext(fs.readFileSync(path.join(root,script),'utf8'),context,{filename:script});
 run("shrigmaGuardaChave('growth','synthetic-manager-key');SHRIGMA_OPERATOR_SESSION.growth={caps:['read_content','draft'],label:'Synthetic manager'};");
 for(const script of document.querySelectorAll('script:not([src])'))vm.runInContext(script.textContent,context,{filename:'growth-inline.js'});
 const x={f,document,window,run,requests,storage:localStorage,q:s=>document.querySelector(s)};
 await settled(x);return x;
}
async function settled(x){for(let i=0;i<300;i++){if(!x.run('LOADING||CRM_SEGMENT_SYNC||CRM_AUDIENCE_CREATE_BUSY||CRM_SEGMENT_VIEW?.contextStatus().busy'))return;await new Promise(r=>setTimeout(r,2));}assert.fail('Local panel did not settle');}
async function changeBrand(x,brand){x.q('[data-marca="'+brand+'"]').click();if(x.q('#brand-change-confirm').open)x.q('#brand-change-accept').click();await settled(x);}
const type=(x,name,value)=>{const el=x.q(`[name="${name}"]`);el.value=value;el.dispatchEvent(new x.window.Event('input',{bubbles:true}));};

for(const brand of ['fish','aristo']){
 test(`D-2abas ${brand}: segunda aba troca de marca sem gravar campanha/template vazios e a primeira continua salvando`,async()=>{
  const shared=sharedStorage().storage;
  const first=await boot({brand,storage:shared});
  const second=await boot({brand,storage:shared});
  assert.equal(second.run('MARCA'),brand);
  await changeBrand(second,other[brand]);assert.equal(second.run('MARCA'),other[brand]);
  assert.equal(shared.getItem(slot('campaign',brand)),null,'campanha vazia não foi criada pela segunda aba');
  assert.equal(shared.getItem(slot('template',brand)),null,'template vazio não foi criado pela segunda aba');
  assert.equal(shared.getItem(slot('ab',brand)),null);
  // Primeira aba: campanha salva localmente sem acusar outra aba.
  type(first,'subject','Assunto da primeira aba');
  assert.doesNotMatch(first.q('[data-ce-status]').textContent,/Outra aba/);
  assert.equal(JSON.parse(shared.getItem(slot('campaign',brand))).value.subject,'Assunto da primeira aba');
  // Primeira aba: template aberto é preservado ao trocar de marca.
  first.run("GRU.novoTemplate('email')");assert.ok(first.run('GRU.state.rascunho'));
  await changeBrand(first,other[brand]);
  assert.equal(first.run('MARCA'),other[brand],first.q('#brand-context-status').textContent);
  assert.equal(JSON.parse(shared.getItem(slot('template',brand))).value.rascunho.marca,brand);
  for(const x of [first,second])assert.equal(x.requests.filter(r=>r.init?.method==='POST').length,0);
  assert.equal([...['fish','aristo']].map(b=>shared.getItem('shrigma_campaign_operation_v1:'+b)).filter(Boolean).length,0);
 });
 test(`D-2abas ${brand} (aceite): campanha real gravada pela outra aba ainda bloqueia a sobrescrita`,async()=>{
  const shared=sharedStorage().storage;
  const first=await boot({brand,storage:shared}),second=await boot({brand,storage:shared});
  type(second,'subject','Conteúdo real da segunda aba');const written=shared.getItem(slot('campaign',brand));
  assert.equal(JSON.parse(written).value.subject,'Conteúdo real da segunda aba');
  type(first,'subject','Edição concorrente');
  assert.match(first.q('[data-ce-status]').textContent,/Outra aba alterou/);
  assert.equal(shared.getItem(slot('campaign',brand)),written);
  for(const x of [first,second])assert.equal(x.requests.filter(r=>r.init?.method==='POST').length,0);
 });
}
