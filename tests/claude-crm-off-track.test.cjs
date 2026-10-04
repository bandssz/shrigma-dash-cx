'use strict';
/* Trilha OFF do CRM (A/B operacional, RFM, conversão por comprador único e fluxos novos).
   DOM local (linkedom) + leitura dos módulos; sem rede, sem gate ligado, sem POST. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require(require.resolve('linkedom',{paths:[path.resolve(__dirname,'../../growth-test-tools/node_modules')]}));
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'growth.html'),'utf8');

const fixture=()=>({
 _painel:'growth',_escopo:'growth',gerado_em:'2026-09-08T01:00:00Z',
 crm_wa_cobertura:{inicio:'2026-06-10',fim:'2026-09-07'},crm_wa_envios:[],
 crm_fluxo:[{dia:'2026-09-07',marca:'fish',canal:'email',flow:'carrinho',piece:'carrinho-30min',enviados:50,pedidos_ultimo:1,receita_ultimo:100}],
 crm_conversao:[{dia:'2026-09-07',marca:'fish',canal:'email',utm_medium:'campanha',utm_campaign:'lancamento',utm_content:'primeiro',pedidos_ultimo:1,receita_ultimo:100,coletado_em:'2026-09-08T00:40:00Z'}],
 crm_campanha:[{marca:'fish',canal:'email',tipo:'enviada',campanha_id:1,nome:'Campanha exemplo',enviado_em:'2026-09-07T14:00:00Z',enviados:100,entregues:98,abriram:30,clicaram:10,hard:2,complaints:0,coletado_em:'2026-09-08T00:40:00Z'}],
 // Retrato de análise (legado): não é a fonte versionada de envio.
 crm_base:[{marca:'fish',dia:'2026-09-07',coletado_em:'2026-09-07T03:00:00Z',total:10,ativos:9,compradores:4,segmentos:{rfm:{campeao:1,leal:1,um_x:2}}},
  {marca:'aristo',dia:'2026-09-07',coletado_em:'2026-09-07T03:00:00Z',total:8,ativos:8,compradores:3,segmentos:{rfm:{campeao:2,dormant:1}}}],
 crm_campanha_receita:[],crm_campanha_grupo:[],crm_diario:[],crm_intradia:[],crm_carrinho:[],crm_galho:[],crm_regra_galho:[],crm_teste:[],crm_teste_braco:[],crm_credencial:[],wa_saude:[],
});

async function boot(payload=fixture()){
 const {document,window}=parseHTML(html);
 const selectProto=Object.getPrototypeOf(document.querySelector('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 window.HTMLElement.prototype.scrollIntoView=function(){};
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.blur=function(){focused=null;};
 Object.defineProperty(document,'activeElement',{configurable:true,get(){return focused&&focused.isConnected?focused:document.body;}});
 window.HTMLElement.prototype.getBoundingClientRect=function(){return {top:0,width:1200,height:100};};
 const dialog=document.querySelector('#brand-change-confirm');
 Object.defineProperty(dialog,'open',{get(){return this.hasAttribute('open');}});
 dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.onclose?.();};
 const store=new Map([['shrigma_k_growth','synthetic-test-key']]),calls=[];
 const NativeDate=Date;class FixedDate extends NativeDate{constructor(...a){super(...(a.length?a:['2026-09-08T01:10:00Z']));}static now(){return new NativeDate('2026-09-08T01:10:00Z').valueOf();}}
 const locks={request:async(k,o,fn)=>fn({name:k})};
 const ctx=vm.createContext({document,window,Date:FixedDate,Intl,URL,URLSearchParams,AbortSignal,AbortController,crypto:require('node:crypto').webcrypto,TextEncoder,navigator:{locks},console,
  Image:class{set src(x){}},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
  location:{reload:()=>{throw Error('unexpected reload');},hash:''},history:{replaceState:()=>{}},Blob:class{constructor(p){this.text=p.join('');}},prompt:()=>null,confirm:()=>false,
  addEventListener:()=>{},setInterval:()=>1,clearInterval:()=>{},setTimeout,clearTimeout,
  fetch:async(url,init)=>{calls.push({url,init});const body=structuredClone(payload);if(String(url).includes('action=cache_growth'))body._cache_gerado_em=new NativeDate(FixedDate.now()).toISOString();return {status:200,ok:true,json:async()=>body};}});
 for(const script of document.querySelectorAll('script')){
  const src=script.getAttribute('src');
  vm.runInContext(src?fs.readFileSync(path.join(root,src.split('?')[0]),'utf8'):script.textContent,ctx,{filename:src||'growth-inline.js'});
 }
 const run=c=>vm.runInContext(c,ctx);
 for(let i=0;i<10&&run('LOADING');i++)await new Promise(setImmediate);
 assert.ok(run('!!API'),'leitura sintética carregada');
 return {document,window,run,calls};
}
// Visível = nenhum ancestral (nem o próprio nó) com hidden e fora de <details> fechado (exceto o summary).
function visible(node){
 for(let n=node,child=null;n&&n.nodeType===1;child=n,n=n.parentElement){
  if(n.hasAttribute('hidden'))return false;
  if(n.tagName==='DETAILS'&&!n.hasAttribute('open')&&child&&child.tagName!=='SUMMARY')return false;
 }
 return true;
}
function visibleText(el){
 const out=[];const walk=n=>{if(n.nodeType===3){if(visible(n.parentElement))out.push(n.textContent);return;}if(n.nodeType!==1)return;for(const c of n.childNodes)walk(c);};
 walk(el);return out.join(' ').replace(/\s+/g,' ').trim();
}
const posts=x=>x.calls.filter(c=>(c.init?.method||'GET').toUpperCase()!=='GET');

/* ---------- Defeito OFF-1: aba Testes A/B promete o teste operacional desligado ---------- */
test('OFF-1: Testes A/B com a capacidade desligada diz que está desligado e não exibe instruções de execução, nas duas marcas',async()=>{
 const x=await boot();
 for(const brand of ['fish','aristo']){
  x.run(`trocaMarca(${JSON.stringify(brand)});abrirSecaoCRM('camp')`);
  x.document.querySelector('[data-crm-campaign="tests"]').click();
  const tab=x.document.querySelector('#crm-campaign-tests');
  assert.equal(tab.hidden,false);
  assert.equal(x.document.querySelector('#ab-experiment-panel').hidden,true,brand+': painel operacional fica oculto');
  const text=visibleText(tab);
  assert.doesNotMatch(text,/Executar teste com campanhas salvas|o teste divide esse público em duas variantes/,brand+': não promete execução desligada');
  assert.match(text,/Teste com campanhas salvas · desligado nesta versão/,brand+': estado desligado explícito');
  assert.match(text,/Nada é dividido, agendado ou enviado por aqui/,brand);
 }
 assert.equal(posts(x).length,0);
});

test('OFF-1: com capacidade A/B válida a instrução operacional volta e o aviso de desligado some (sem POST)',async()=>{
 const p=fixture();p.capabilities={endpoints:{ab_experiment:'https://synthetic.invalid/ab'},ab_experiment:{contract_version:'crm-ab-email-v2',audience_mode:'saved-audience-v1',enabled:true,operation:true,brands:['fish']}};
 const x=await boot(p);
 x.run(`trocaMarca('fish');abrirSecaoCRM('camp')`);x.document.querySelector('[data-crm-campaign="tests"]').click();
 const tab=x.document.querySelector('#crm-campaign-tests');
 assert.equal(x.document.querySelector('#ab-experiment-panel').hidden,false);
 assert.match(visibleText(tab),/Executar teste com campanhas salvas/);
 assert.doesNotMatch(visibleText(tab),/desligado nesta versão/);
 // Marca fora da capacidade: volta ao estado desligado, sem expor a marca anterior.
 x.run(`trocaMarca('aristo')`);
 assert.equal(x.document.querySelector('#ab-experiment-panel').hidden,true);
 assert.match(visibleText(tab),/desligado nesta versão/);
 assert.equal(posts(x).length,0);
});

/* ---------- Defeito OFF-2: Automações cita "Construir fluxo" oculto como disponível ---------- */
test('OFF-2: sem capacidade de fluxos novos, Automações e Início não prometem construção de fluxo',async()=>{
 const x=await boot();
 const home=x.document.querySelector('[data-crm-go="regua"]');
 assert.doesNotMatch(home.textContent,/constru/i,'cartão do Início não promete construção');
 x.run(`abrirSecaoCRM('regua')`);
 assert.equal(x.document.querySelector('#control-tab-graph').hidden,true);
 const intro=visibleText(x.document.querySelector('#sec-regua .crm-section-intro'));
 assert.doesNotMatch(intro,/Construir fluxo prepara/);
 assert.match(intro,/Construir fluxo está desligado nesta versão/);
 assert.equal(posts(x).length,0);
});

test('OFF-2: com capacidade de rascunho de fluxos a aba aparece e a introdução deixa de dizer desligado',async()=>{
 const p=fixture();p.capabilities={endpoints:{journey_graph:'https://synthetic.invalid/graph'},journeys:{graph_drafts:'journey_graph_draft_api_v1'}};
 const x=await boot(p);x.run(`trocaMarca('fish');abrirSecaoCRM('regua')`);
 assert.equal(x.document.querySelector('#control-tab-graph').hidden,false);
 const intro=visibleText(x.document.querySelector('#sec-regua .crm-section-intro'));
 assert.match(intro,/Construir fluxo prepara novos caminhos/);assert.doesNotMatch(intro,/desligado/);
});

/* ---------- Defeito OFF-3: "ped./1000 envios" sem ressalva pode ser lido como taxa de compradores ---------- */
test('OFF-3: Campanhas × Automações rotula pedidos por envio como não sendo taxa de compradores',async()=>{
 const x=await boot();x.run(`abrirSecaoCRM('regua')`);x.document.querySelector('#control-tab-history').click();
 const block=x.document.querySelector('#email-comparison-block');
 assert.match(block.querySelector('#area-cvr').textContent,/ped\.\/1000 envios/);
 const tag=block.querySelector('.painel-cab [data-metric-scope="pedidos-por-envio"]');
 assert.ok(tag,'etiqueta de escopo no cabeçalho');
 assert.match(tag.textContent,/não é taxa de compradores/);
 assert.match(tag.getAttribute('title'),/data da compra/);assert.match(tag.getAttribute('title'),/data do envio/);
 assert.match(tag.getAttribute('title'),/pessoas compradoras/);
});

/* ---------- Aceite: na build atual os quatro recursos aparecem desligados/indisponíveis ---------- */
test('aceite: build atual mostra A/B operacional, RFM de envio, conversão por comprador e fluxos novos como desligados',async()=>{
 const x=await boot();
 // RFM: somente retrato de análise; nenhum cartão oferece "Usar este perfil".
 x.run(`trocaMarca('todas');abrirSecaoCRM('base')`);
 const rfm=x.document.querySelector('#area-arvore [data-ga-rfm]');
 const create=[...rfm.querySelectorAll('[data-ga-rfm-create]')];
 assert.ok(create.length>=2,'cartões do retrato de análise renderizados');
 assert.ok(create.every(b=>b.disabled&&/Disponível apenas para análise/.test(b.textContent)));
 assert.deepEqual([...new Set(create.map(b=>b.dataset.gaRfmBrand))].sort(),['aristo','fish']);
 assert.ok([...rfm.querySelectorAll('.ga-rfm-card')].every(c=>/ainda não utilizável em campanhas/.test(c.textContent)));
 // Conversão por comprador único: nenhuma métrica de compradores; a métrica existente nega essa leitura.
 x.run(`trocaMarca('fish');CRMWorkspace.setReport('conversion');abrirSecaoCRM('resultados')`);
 const conv=x.document.querySelector('#crm-report-conversion');
 assert.doesNotMatch(visibleText(conv),/compradores únicos|taxa de compradores|comprador único/i);
 assert.deepEqual([...x.document.querySelectorAll('#tab-conv thead th')].map(t=>t.textContent.trim()),['Peça','Canal','Pedidos','Receita','Assist.','R$ assist.','% novos']);
 // Fluxos novos: aba oculta; Jornadas segue "Somente leitura".
 x.run(`abrirSecaoCRM('regua')`);
 assert.equal(x.document.querySelector('#control-tab-graph').hidden,true);
 assert.equal(x.document.querySelector('#control-graph').children.length,0);
 x.document.querySelector('#control-tab-fluxos').click();
 assert.match(x.document.querySelector('#control-fluxos').textContent,/Somente leitura/);
 // A/B operacional: painel oculto e estado desligado explícito.
 x.run(`abrirSecaoCRM('camp')`);x.document.querySelector('[data-crm-campaign="tests"]').click();
 assert.equal(x.document.querySelector('#ab-experiment-panel').hidden,true);
 assert.match(visibleText(x.document.querySelector('#crm-campaign-tests')),/desligado nesta versão/);
 assert.equal(posts(x).length,0,'nenhuma escrita');
});

test('aceite: defaults OFF dos módulos e serviços da trilha (sem ligar nada)',()=>{
 const AB=require('../growth-ab-experiment-panel.js');
 assert.equal(AB.ACTIVATION.enabled,false);
 assert.equal(AB.activation({},'fish').enabled,false);
 assert.equal(AB.activation({capabilities:{ab_experiment:{contract_version:'crm-ab-email-v2',audience_mode:'saved-audience-v1',enabled:true,operation:true,brands:['fish','aristo']},endpoints:{ab_experiment:'http://insecure.invalid/ab'}}},'fish').enabled,false,'endpoint sem https não liga');
 for(const f of ['n8n/growth/segment-audience-contract.js','n8n/growth/journey-graph-contract.js','n8n/growth/journey-graph-runtime.cjs','n8n/growth/journey-graph-lifecycle-contract.cjs','n8n/growth/ab-audience-prepare.cjs','n8n/growth/ab-audience-review.cjs','n8n/growth/segment-audience-api.cjs','n8n/growth/segment-campaign-binding.cjs'])
  assert.match(fs.readFileSync(path.join(root,f),'utf8'),/\bENABLED=false\b/,f);
 const Audience=require('../services/crm-audience/config.cjs');
 const a=Audience.config({CRM_AUDIENCE_REVISION:'a'.repeat(40),CRM_PG_HOST:'db',CRM_PG_USER:'crm_audience_api',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'synthetic'});
 assert.deepEqual([a.enabled,a.abEnabled,a.regularEnabled,a.bindingEnabled,a.graphLifecycleEnabled,a.graphActivationEnabled],[false,false,false,false,false,false]);
 const Flows=require('../services/crm-flows/config.cjs');
 const env={CRM_FLOWS_REVISION:'b'.repeat(40),CRM_FLOWS_TOKEN:'t'.repeat(43),CRM_PG_HOST:'db',CRM_PG_USER:'crm_graph_worker',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'synthetic',
  CRM_LISTMONK_ORIGIN:'https://email.shrigma.com.br',CRM_LISTMONK_AUTHORIZATION:'Basic c3ludGhldGlj',CRM_LISTMONK_CACHE_TARGET:'cache-test'};
 for(const [b,n] of [['FISH',1],['ARISTO',2]])Object.assign(env,{[`CRM_${b}_SHOP`]:`synthetic-${n}.myshopify.com`,[`CRM_${b}_SHOP_ID`]:`gid://shopify/Shop/${n}`,[`CRM_${b}_CLIENT_ID`]:'client-'+n,[`CRM_${b}_CLIENT_SECRET`]:'secret-'+n,[`CRM_${b}_COLLECTOR`]:'Collector'+n+'abc'});
 assert.equal(Flows.config(env).enabled,false,'executor de fluxos default OFF');
 const {createWorker}=require('../services/crm-shopify-sync/worker.cjs');
 return assert.rejects(()=>createWorker().parseRfm({customerFile:'/x',paidOrdersFile:'/y',input:{}}),/CRM_SHOPIFY_RFM_DISABLED/).then(()=>{
  const sql=fs.readFileSync(path.join(root,'n8n/growth/recipient-conversion-evidence.sql'),'utf8');
  assert.match(sql,/enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql,/INSERT INTO crm_email_conversion_candidate\.capture_control_v1\(brand\) VALUES\('fish'\),\('aristo'\);/);
  assert.match(sql,/'authorizes_send',false/);
  assert.doesNotMatch(sql,/UPDATE crm_email_conversion_candidate\.capture_control_v1/,'instalação não liga a captura');
 });
});

/* ---------- Defeito OFF-4: RFM pronto em "Todas as marcas" oferece botão que não faz nada ---------- */
function rfmCatalog(brand,now){const hash=(brand==='fish'?'a':'b').repeat(64),category_counts=Object.fromEntries(['campeao','leal','um_x','um_x_lapsando','dormant','needs_attention','ex_campeao_at_risk'].map(t=>[t,t==='campeao'?2:0]));
 return {brand,current:true,fields:[{key:'relationship.rfm',available:true,source_hash:hash}],rfm_snapshot:{brand,current:true,history_complete:true,source_hash:hash,operation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',started_at:new Date(now-120000).toISOString(),observed_at:new Date(now-60000).toISOString(),expires_at:new Date(now+3600000).toISOString(),customers:3,resolved:2,unresolved:1,category_counts,category_scope:'shopify_customers',semantics_version:'shopify-customer-rfm-v4'}};}
test('OFF-4: com fonte RFM sintética pronta, "Todas as marcas" não oferece "Usar este perfil"; a marca escolhida oferece só o próprio perfil',()=>{
 const A=require('../growth-audience.js'),now=Date.parse('2026-10-03T12:00:00Z');
 const {document}=parseHTML('<div id="a"></div>'),el=document.querySelector('#a'),created=[];
 const ui=A.mount({element:el,onCreateRfm:p=>created.push(p)}),catalogs=[rfmCatalog('fish',now),rfmCatalog('aristo',now)];
 ui.update({api:{},brand:'todas',catalogs,now});
 let buttons=[...el.querySelectorAll('[data-ga-rfm-create]')];
 assert.equal(buttons.length,14);
 assert.ok(buttons.every(b=>b.disabled&&/Selecione a marca para usar este perfil/.test(b.textContent)),'nenhum botão habilitado sem marca única');
 buttons[0].click();assert.equal(created.length,0);
 for(const brand of ['fish','aristo']){
  ui.update({api:{},brand,catalogs,now});buttons=[...el.querySelectorAll('[data-ga-rfm-create]')];
  assert.equal(buttons.length,7);assert.ok(buttons.every(b=>b.dataset.gaRfmBrand===brand&&!b.disabled&&b.textContent==='Usar este perfil'));
  buttons[0].click();assert.equal(created.at(-1).brand,brand);
 }
 assert.equal(created.length,2);
});
test('OFF-4: o handler do painel recusa perfil RFM quando a marca selecionada é "todas" (por isso o botão não pode ficar habilitado)',()=>{
 const start=html.indexOf('onCreateRfm:async preset=>{'),end=html.indexOf('}});',start);
 assert.ok(start>0&&end>start);
 assert.match(html.slice(start,end),/before\.brand!==preset\.brand\)return false/);
});
