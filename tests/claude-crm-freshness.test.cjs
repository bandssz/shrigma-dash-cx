'use strict';
// Item 5 — frescor/cache e fluxos de leitura já operacionais do painel CRM (growth.html).
// Página real + fontes do manifesto em DOM local (vm + linkedom). Sem navegador, rede,
// credencial real ou transporte externo. Relógio fixo; o runner roda em TZ=UTC de propósito:
// todo rótulo de horário precisa sair em Brasília independentemente do fuso do aparelho.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{parseHTML}=require('linkedom');
const root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/panel-build/manifest.json'))).growth;
const NOW='2026-09-08T01:10:00Z'; // 07/09/2026 22:10 em Brasília

function fixture(){
 return {_painel:'growth',_escopo:'growth',gerado_em:'2026-09-08T01:00:00Z',
  crm_wa_cobertura:{inicio:'2026-06-10',fim:'2026-09-07'},crm_wa_envios:[],
  crm_fluxo:[{dia:'2026-09-07',marca:'fish',canal:'email',flow:'carrinho',piece:'carrinho-30min',enviados:50,pedidos_ultimo:1,receita_ultimo:100}],
  crm_conversao:[
   {dia:'2026-09-07',marca:'fish',canal:'email',utm_medium:'campanha',utm_campaign:'lancamento',utm_content:'primeiro',pedidos_ultimo:1,receita_ultimo:100,coletado_em:'2026-09-08T00:40:00Z'},
   {dia:'2026-09-06',marca:'aristo',canal:'email',utm_medium:'campanha',utm_campaign:'semana',utm_content:'um',pedidos_ultimo:2,receita_ultimo:300,coletado_em:'2026-09-06T15:05:00Z'}],
  crm_campanha:[
   {marca:'fish',canal:'email',tipo:'enviada',campanha_id:1,nome:'Fish truncada',enviado_em:'2026-09-07T14:00:00Z',enviados:100,publico:400,truncado:true,entregues:98,abriram:30,clicaram:10,hard:0,complaints:0,coletado_em:'2026-09-08T00:40:00Z'},
   {marca:'aristo',canal:'email',tipo:'enviada',campanha_id:2,nome:'Aristo inteira',enviado_em:'2026-09-06T14:00:00Z',enviados:200,publico:200,entregues:198,abriram:50,clicaram:20,hard:0,complaints:0,coletado_em:'2026-09-08T00:40:00Z'}],
  ...Object.fromEntries(['crm_campanha_receita','crm_campanha_grupo','crm_diario','crm_intradia','crm_carrinho','crm_galho','crm_regra_galho','crm_teste','crm_teste_braco','crm_credencial','wa_saude'].map(k=>[k,[]]))};
}
const attributionV2=(coverageDays)=>({schema_version:2,generated_at:'2026-09-08T01:00:00Z',
 coverage:coverageDays.map(([brand,day])=>({brand,day,checked_at:'2026-09-08T00:50:00Z'})),quality:[],reconciliation:[],hourly:[],campaigns:[],
 daily:[{marca:'fish',dia:'2026-09-07',model:'last_click',grain:'piece',dimension:['email','campanha','lancamento','primeiro','',''],pedidos:1,receita:100,assistidos:0,receita_assistida:0,novos:1,recorrentes:0},
  {marca:'fish',dia:'2026-09-07',model:'last_click',grain:'total',dimension:[],pedidos:1,receita:100,assistidos:0,receita_assistida:0,novos:1,recorrentes:0}]});

async function boot({payload=fixture(),hash='#marca=fish&sec=visao',respond=null}={}){
 const html=fs.readFileSync(path.join(root,'growth.html'),'utf8'),{document,window}=parseHTML(html);
 const selectProto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
 dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const store=new Map([['shrigma_k_growth','synthetic-test-key']]),requests=[],downloads=[];
 let response=payload,status=200,cacheAt=NOW;
 const held=new Set(),locks={request:async(key,opts,fn)=>{if(typeof opts==='function')fn=opts;if(held.has(key))return fn(null);held.add(key);try{return await fn({name:key});}finally{held.delete(key);}}};
 const NativeDate=Date;let clock=Date.parse(NOW);
 class FixedDate extends NativeDate{constructor(...a){super(...(a.length?a:[clock]));}static now(){return clock;}}
 const context=vm.createContext({document,window,URL,URLSearchParams,Date:FixedDate,Intl,AbortSignal,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,navigator:{locks},console,
  localStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
  location:{hash,search:'',reload(){throw Error('unexpected reload');}},history:{replaceState(){}},
  addEventListener(){},setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
  Image:class{set src(_){}},Blob:class{constructor(p){this.text=p.join('');}},prompt:()=>null,confirm:()=>false,structuredClone,
  fetch:async(url,init)=>{requests.push({url,init});const u=new URL(url);
   if(respond){const custom=await respond(u,init);if(custom)return custom;}
   const body=response===null?null:structuredClone(response);
   if(body&&u.searchParams.get('action')==='cache_growth'&&body._cache_gerado_em===undefined)body._cache_gerado_em=cacheAt;
   return {status,ok:status>=200&&status<300,json:async()=>body};}});
 const run=code=>vm.runInContext(code,context);
 for(const script of manifest.scripts)vm.runInContext(fs.readFileSync(path.join(root,script),'utf8'),context,{filename:script});
 run("GT.baixar=(nome,texto)=>{globalThis.__downloads.push({nome,texto});return true;}");context.__downloads=downloads;
 for(const script of document.querySelectorAll('script:not([src])'))vm.runInContext(script.textContent,context,{filename:'growth-inline.js'});
 run("GT.baixar=(nome,texto)=>{__downloads.push({nome,texto});return true;}");
 const x={document,window,run,requests,downloads,store,q:s=>document.querySelector(s),
  setResponse:(r,s=200)=>{response=r;status=s;},setCacheAt:v=>{cacheAt=v;},setNow:v=>{clock=Date.parse(v);}};
 await settled(x);return x;
}
async function settled(x){for(let i=0;i<300;i++){if(!x.run('LOADING'))return;await new Promise(r=>setTimeout(r,2));}assert.fail('painel local não estabilizou');}
const text=(x,s)=>x.q(s)?.textContent||'';

test('harness: página real com fontes do manifesto carrega Fishermans',async()=>{
 const x=await boot();assert.equal(x.run('MARCA'),'fish');assert.ok(x.run('API'));assert.match(text(x,'#atualizado-em'),/Dados de 07\/09\/2026, 22:10 BRT/);
});

/* ---------- D1 · alertas de dados de outra marca/seção não ficam na tela ---------- */
test('D1: alerta de dados de Fishermans (Início) não permanece como atual depois de abrir Resultados e trocar para O Aristocrata',async()=>{
 const x=await boot();assert.match(text(x,'#faixa-alertas'),/#1 enviou 100 de 400/);
 x.run("abrirSecaoCRM('resultados')");x.run("trocaMarca('aristo')");assert.equal(x.run('MARCA'),'aristo');
 assert.doesNotMatch(text(x,'#faixa-alertas'),/#1 enviou|não saíram inteiros/,'alerta de truncamento da Fishermans exibido com O Aristocrata selecionada');
 x.run("abrirSecaoCRM('visao')");assert.doesNotMatch(text(x,'#faixa-alertas'),/#1 enviou/);
 x.run("trocaMarca('fish')");assert.match(text(x,'#faixa-alertas'),/#1 enviou 100 de 400/);
});

/* ---------- D2 · falha resolvida não continua anunciada fora do Início ---------- */
test('D2: em Resultados, a faixa "Não foi possível atualizar" some quando a leitura seguinte dá certo',async()=>{
 const x=await boot();x.run("CRMWorkspace.setReport('email');abrirSecaoCRM('resultados')");
 x.setResponse({},503);await x.run('carregar()');assert.match(text(x,'#faixa-alertas'),/Não foi possível atualizar os dados\. Os últimos dados recebidos continuam na tela/);
 assert.ok(x.q('#tentar-novamente'));
 x.setResponse(fixture());await x.run('carregar()');assert.equal(x.run('CONSULTA.falhou'),false);
 assert.doesNotMatch(text(x,'#faixa-alertas'),/Não foi possível atualizar/,'falha antiga anunciada sobre dados já atualizados');assert.equal(x.q('#tentar-novamente'),null);
});
test('D2b: no Início a falha não some ao trocar de período enquanto os dados continuam antigos; Tentar novamente limpa ao dar certo',async()=>{
 const x=await boot();x.setResponse({},503);await x.run('carregar()');
 x.q('#presets [data-p="30"]').click();assert.match(text(x,'#faixa-alertas'),/Não foi possível atualizar os dados/);assert.match(text(x,'#faixa-alertas'),/#1 enviou 100 de 400/);
 x.setResponse(fixture());x.q('#tentar-novamente').click();await settled(x);assert.doesNotMatch(text(x,'#faixa-alertas'),/Não foi possível atualizar/);
});

/* ---------- D3 · cabeçalho diz de quando são os dados exibidos após falha ---------- */
test('D3: falha de atualização mantém a leitura anterior e o cabeçalho diz de quando são os dados exibidos',async()=>{
 const x=await boot();const kpis=text(x,'#area-kpis');x.setNow('2026-09-08T01:40:00Z');x.setResponse(null,503);await x.run('carregar()');
 assert.equal(text(x,'#area-kpis'),kpis);assert.match(text(x,'#atualizado-em'),/Atualização falhou · exibindo dados de 07\/09\/2026, 22:10 BRT/);
});

/* ---------- D4 · cache acima de 20 min: sem tela branca, etiqueta de retrato antigo ---------- */
test('D4: primeira leitura com cache acima de 20 min mostra o último retrato e diz que caiu (sem tela branca)',async()=>{
 const p=fixture();p._cache_gerado_em='2026-09-08T00:45:00Z';const x=await boot({payload:p});
 assert.ok(x.run('API'),'painel ficou sem dado com um retrato válido disponível');assert.equal(x.requests.length>=1,true);
 assert.ok(x.q('#area-kpis .kpi'));assert.match(text(x,'#atualizado-em'),/Dados de 07\/09\/2026, 21:45 BRT · retrato antigo/);
 assert.match(x.q('#atualizado-em').title,/mais de 20 minutos/);assert.match(text(x,'#faixa-alertas'),/último retrato disponível, de 07\/09\/2026, 21:45 BRT/);
 // A próxima preparação dentro do prazo substitui o retrato e remove a ressalva.
 x.setResponse(fixture());await x.run('carregar()');assert.match(text(x,'#atualizado-em'),/^Dados de 07\/09\/2026, 22:10 BRT$/);assert.doesNotMatch(text(x,'#faixa-alertas'),/retrato/);
});
test('D4 (futuro): retrato com data no futuro não é exibido como retrato antigo',async()=>{
 const p=fixture();p._cache_gerado_em='2026-09-09T12:00:00Z';const x=await boot({payload:p});
 assert.equal(x.run('API'),null,'data no futuro não pode virar retrato antigo');assert.doesNotMatch(text(x,'#atualizado-em'),/retrato antigo/);
});
test('D4 (aceite): retrato vencido nunca substitui uma leitura mais nova já na tela; payload inválido continua sem dado',async()=>{
 const x=await boot();const p=fixture();p._cache_gerado_em='2026-09-08T00:45:00Z';p.crm_campanha=[];x.setResponse(p);await x.run('carregar()');
 assert.equal(x.run('API._cache_gerado_em'),NOW);assert.match(text(x,'#atualizado-em'),/Atualização falhou/);assert.match(text(x,'#faixa-alertas'),/ainda não estão disponíveis/);
 const y=await boot({payload:{...fixture(),_escopo:'cx',_cache_gerado_em:'2026-09-08T00:45:00Z'}});assert.equal(y.run('API'),null);assert.equal(text(y,'#atualizado-em'),'Dados indisponíveis');
});

/* ---------- D5 · rótulo "venda coletada até" em Brasília e da marca selecionada ---------- */
test('D5: legenda do gráfico mostra a coleta de venda da marca selecionada, com data e horário de Brasília',async()=>{
 const x=await boot();x.run("CRMWorkspace.setReport('overview');abrirSecaoCRM('resultados')");
 assert.match(text(x,'#legenda-graf'),/venda coletada até 07\/09\/2026, 21:40 BRT/);
 x.run("trocaMarca('aristo')");assert.match(text(x,'#legenda-graf'),/venda coletada até 06\/09\/2026, 12:05 BRT/,'Aristocrata herdou a coleta da Fishermans');
});

/* ---------- D6 · Início não apresenta total parcial de atribuição como completo ---------- */
test('D6: no Início, receita e pedidos atribuídos de período com cobertura parcial levam a etiqueta de cobertura',async()=>{
 const partial=fixture();partial.crm_attribution=attributionV2([['fish','2026-09-07']]);
 const x=await boot({payload:partial});const kpi=[...x.document.querySelectorAll('#area-kpis .kpi')].find(k=>/Receita atribuída/.test(k.textContent));
 assert.match(kpi.querySelector('.kpi-val').textContent,/100/);assert.match(kpi.textContent,/Cobertura parcial · 1 de 7 dias/,'total parcial apresentado como completo');
 assert.match(kpi.querySelector('[title*="dias sem conciliação"]')?.title||'',/ficam fora/);
 const full=fixture();full.crm_attribution=attributionV2(['01','02','03','04','05','06','07'].map(d=>['fish','2026-09-'+d]));
 const y=await boot({payload:full});const fk=[...y.document.querySelectorAll('#area-kpis .kpi')].find(k=>/Receita atribuída/.test(k.textContent));
 assert.match(fk.querySelector('.kpi-val').textContent,/100/);assert.doesNotMatch(fk.textContent,/Cobertura parcial/);
 const none=fixture();none.crm_attribution=attributionV2([]);const z=await boot({payload:none});
 const nk=[...z.document.querySelectorAll('#area-kpis .kpi')].find(k=>/Receita atribuída/.test(k.textContent));assert.equal(nk.querySelector('.kpi-val').textContent,'—');
});

/* ---------- D7 · sem conciliação no recorte não vira "sem conversão" ---------- */
test('D7: Resultados sem nenhum dia conciliado na marca dizem que a atribuição não foi conciliada, não que não houve venda',async()=>{
 const p=fixture();p.crm_attribution={...attributionV2([['aristo','2026-09-07']]),daily:[]};const x=await boot({payload:p});
 x.run("CRMWorkspace.setReport('conversion');abrirSecaoCRM('resultados')");
 assert.doesNotMatch(text(x,'#tab-conv tbody'),/Sem conversão atribuída/,'ausência de conciliação apresentada como zero venda');
 assert.match(text(x,'#tab-conv tbody'),/sem conciliação/i);
 x.run("CRMWorkspace.setReport('overview');abrirSecaoCRM('resultados')");
 assert.doesNotMatch(text(x,'#area-top'),/Sem conversão atribuída/);assert.match(text(x,'#area-top'),/sem conciliação/i);
 // Com o dia conciliado e nenhuma venda, o vazio é um zero medido e continua dito como tal.
 x.run("trocaMarca('aristo');PER={ini:'2026-09-07',fim:'2026-09-07'};render()");assert.match(text(x,'#area-top'),/Sem conversão atribuída no período/);
});

/* ---------- D8 · carrinho sem carrinhos no recorte não vira NaN nem 0% ---------- */
test('D8: Automações › histórico com dia coletado sem carrinhos não mostra NaN nem 0% de resgate inventado',async()=>{
 const p=fixture();p.crm_carrinho=[{dia:'2026-09-07',marca:'fish',carrinhos:0,valor_em_jogo:0,com_consent:0,voltaram_72h:0,receita_voltaram:0,recuperados:0,receita_recuperada:0}];
 const x=await boot({payload:p});x.run("abrirSecaoCRM('regua',{tab:'history'})");assert.equal(x.run('GC.activeTab'),'history');
 const area=text(x,'#area-carrinho');assert.doesNotMatch(area,/NaN|Infinity/,'percentual sem base exibido como NaN');
 assert.doesNotMatch(area,/0% do resgate é do CRM/,'participação sem base exibida como zero');assert.match(area,/0 de 0 carrinhos/);
});

/* ---------- aceite · leitura única em andamento e troca de marca durante a leitura ---------- */
test('aceite: atualizações concorrentes viram uma leitura; resposta que chega depois de trocar a marca é desenhada na marca atual',async()=>{
 let release;const x=await boot();const before=x.requests.length;
 // segura a próxima leitura do cache até a troca de marca
 const original=x.run('fetch');x.run('globalThis').fetch=async(url,init)=>{await new Promise(r=>{release=r;});return original(url,init);};
 const first=x.run('carregar()');const second=x.run('carregar()');await second;
 assert.equal(x.run('LOADING'),true);x.run("trocaMarca('aristo')");release();await first;await settled(x);
 assert.equal(x.requests.length-before,1,'duas leituras simultâneas');assert.equal(x.run('MARCA'),'aristo');
 assert.equal(x.q('#area-kpis .kpi-val').textContent,'200');assert.doesNotMatch(text(x,'#faixa-alertas'),/#1 enviou/);
});
test('aceite: exportação de campanhas sai igual à tela da marca selecionada e com o recorte no CSV',async()=>{
 const x=await boot();x.run("CRMWorkspace.setReport('email');abrirSecaoCRM('resultados')");x.run("trocaMarca('aristo')");
 const rows=[...x.document.querySelectorAll('#tab-camp tbody tr:not(.det)')].map(r=>r.querySelector('strong')?.textContent);assert.deepEqual(rows,['Aristo inteira']);
 x.q('#camp-export').click();const csv=x.downloads.at(-1).texto;assert.match(csv,/Aristo inteira/);assert.doesNotMatch(csv,/Fish truncada/);assert.match(csv,/O Aristocrata;E-mail e WhatsApp;2026-09-01;2026-09-07/);
});
