/* Fixtures sinteticas. Executa as funcoes reais do HTML sem rede ou dados de clientes. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.resolve(__dirname,'../organico.html'),'utf8');
const OLegacy=require('../organico-legacy.js');
function trecho(inicio,fim){
 const a=html.indexOf(inicio),b=html.indexOf(fim,a);
 assert(a>=0&&b>a,`trecho do front nao encontrado: ${inicio}`);
 return html.slice(a,b);
}
function boot(linhas=[]){
 const elements=new Map(),requests=[],headers=[],venda=[];
 // Elemento falso com o mínimo que os módulos reais tocam ao renderizar dentro do KPI.
 const $=s=>{if(!elements.has(s))elements.set(s,{innerHTML:'',textContent:'',title:'',hidden:false,
  querySelectorAll:()=>[],querySelector:()=>null,setAttribute(){},classList:{toggle(){},add(){},remove(){}}});return elements.get(s);};
 const context=vm.createContext({console,Intl,OLegacy,API:{cx_organico_receita:linhas},PER:{ini:'2026-09-01',fim:'2026-09-19'},CMP:false,
  G:{anterior:()=>({ini:'2026-08-13',fim:'2026-08-31'})},MARCA:'todas',
  $: $,document:{querySelectorAll:()=>[]},posts:()=>[],stories:()=>[],conta:()=>[],classifica:x=>x,
  agregado:()=>({eq:null,mediana:null}),daMarca:()=>true,chip:()=>'',varia:(a,b)=>b?Math.round(100*(a-b)/b):null,
  nf:n=>n==null?'—':Number(n).toLocaleString('pt-BR'),pc:n=>n==null?'—':String(n)+'%',
  esc:s=>String(s??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])),
  renderVenda:rows=>venda.push(rows),troca:()=>{},render:()=>{},shrigmaFrescor:()=>{},
  CARGA_ORGANICO:false,ACESSO_ORGANICO:{setBusy:()=>{},show:()=>{},reject:()=>{}},AbortController,setTimeout,clearTimeout,
  chaveLeitura:()=> 'synthetic-key&other=x',CX_API_URL:'https://example.invalid/read',CX_CACHE_URL:'https://example.invalid/cache',Number,
  shrigmaMarcaMestra:()=>{},shrigmaEsqueceChave:()=>{},avisoTela:(t,d)=>{if(t!=='Carregando dados…')throw Error(t+': '+d);},window:{},
  fetch:async(url,init)=>{requests.push(url);headers.push(init.headers);return {status:200,ok:true,json:async()=>({_escopo:'organico',cx_organico_receita:[]})};},
 });
 for(const source of [
  trecho('function grupoReceitaOrganico(r){','// Conversao por UTM:'),
  trecho('function pintaKPIs(){','/* ---------- grade:'),
  trecho('// ORGANICO_CACHE_READ_BEGIN','// ORGANICO_CACHE_READ_END'),
  trecho('async function carrega(){',"document.querySelectorAll('#seg-marca button')"),
 ])vm.runInContext(source,context);
 return {context,elements,requests,headers,venda,run:s=>vm.runInContext(s,context)};
}
const row=(overrides={})=>({dia:'2026-09-19',marca:'aristocrata',rede:'instagram',utm_medium:'social',
 superficie_utm:'story',produto_utm:'produto-teste',receita_ultimo:100,pedidos_ultimo:1,...overrides});
function receitaCard(x){return x.elements.get('#area-kpis').innerHTML.split('Receita histórica de story · reels · post')[1];}

test('KPI editorial exclui DM, bio e superficie desconhecida sem retirar essas linhas de Venda',()=>{
 const linhas=[row(),row({utm_medium:'dm',receita_ultimo:200}),row({utm_medium:'dm-automation',receita_ultimo:300}),
  row({superficie_utm:'bio',receita_ultimo:400}),row({superficie_utm:null,produto_utm:'link_in_bio',receita_ultimo:500}),
  row({superficie_utm:null,receita_ultimo:600}),row({superficie_utm:'live',receita_ultimo:700}),
  row({dia:'2026-08-20',receita_ultimo:50})];
 const x=boot(linhas);x.run('pintaKPIs()');const card=receitaCard(x);
 assert.match(card,/R\$ 100,00/);
 assert.match(card,/Automação DM: R\$ 500,00/);
 assert.match(card,/Bio \(pode ter mídia\): R\$ 900,00/);
 assert.match(card,/Outras superfícies \/ não identificadas: R\$ 1\.300,00/);
 assert.equal(x.venda[0].length,7);
 assert.equal(x.venda[0].reduce((a,r)=>a+r.receita_ultimo,0),2800);
});

test('zero medido permanece zero; nulo, ausente e invalido nao se tornam receita zero',()=>{
 for(const [value,expected] of [[0,/R\$ 0,00/],[null,/sem dado/],[undefined,/sem dado/],['',/sem dado/],['erro',/sem dado/],[false,/sem dado/],[[],/sem dado/]]){
  const x=boot([row({receita_ultimo:value})]);x.run('pintaKPIs()');assert.match(receitaCard(x),expected);
 }
 const x=boot([row(),row({receita_ultimo:null}),row({utm_medium:'dm',receita_ultimo:null})]);
 x.run('pintaKPIs()');const card=receitaCard(x);
 assert.match(card,/sem dado/);assert.match(card,/Automação DM: receita indisponível/);
 assert.doesNotMatch(card,/R\$ 100,00/);
});

test('ausência ou formato inválido da projeção histórica não vira lista vazia disponível',()=>{
 for(const value of [undefined,null,{},'invalid']){
  const x=boot();x.context.API.cx_organico_receita=value;x.run('pintaKPIs()');
  assert.equal(x.venda[0],null);assert.match(receitaCard(x),/sem dado/);
 }
 const empty=boot([]);empty.run('pintaKPIs()');assert.equal(empty.venda[0].length,0);
});

test('filtro financeiro usa os aliases reais de marca e conserva o período sem incluir outra marca',()=>{
 const rows=[row({marca:'aristo'}),row({marca:'aristocrata'}),row({marca:'fish'}),row({marca:'fishermans'}),row({marca:null}),row({marca:'olivas'}),row({marca:'aristo',dia:'2026-08-10'})];
 for(const [brand,expected] of [['aristo',['aristo','aristocrata']],['fish',['fish','fishermans']],['olivas',['olivas']]]){
  const x=boot(rows);x.context.MARCA=brand;x.run('pintaKPIs()');
  assert.deepEqual([...x.venda[0]].map(r=>r.marca),expected);assert.ok(x.venda[0].every(r=>r.dia==='2026-09-19'));
 }
 const all=boot(rows);all.run('pintaKPIs()');assert.equal(all.venda[0].length,6);
});

test('cartão histórico não transforma contagem de pedidos ausente em zero',()=>{
 const x=boot([row({pedidos_ultimo:null}),row({pedidos_ultimo:2})]);x.run('pintaKPIs()');
 assert.match(receitaCard(x),/Pedidos indisponíveis/);assert.doesNotMatch(receitaCard(x),/2 pedidos|0 pedidos/);
 const zero=boot([row({pedidos_ultimo:0})]);zero.run('pintaKPIs()');assert.match(receitaCard(zero),/0 pedidos/);
});

test('somente superficies editoriais explicitas entram no KPI, sem inferir campanha ou source',()=>{
 const x=boot();
 for(const superficie of ['story','stories','reels','reel','post','feed','carrossel',' STORY ']){
  x.context.r=row({superficie_utm:superficie});assert.equal(x.run('grupoReceitaOrganico(r)'),'editorial');
 }
 for(const fields of [{superficie_utm:null,utm_source:'instagram_social',utm_medium:'story'},
  {superficie_utm:null,utm_campaign:'20260919_story'}, {superficie_utm:'live'}]){
  x.context.r=row(fields);assert.equal(x.run('grupoReceitaOrganico(r)'),'outra');
 }
 x.context.r=row({utm_medium:' DM ',superficie_utm:'story'});assert.equal(x.run('grupoReceitaOrganico(r)'),'dm');
});

test('leitura do painel sempre solicita escopo organico e codifica a chave sem ampliar acesso',async()=>{
 const x=boot();await x.run('carrega()');
 // Sem carimbo de cache a leitura cai para a API viva: as duas chamadas valem a mesma regra.
 assert.equal(x.requests.length,2,'cache primeiro, API viva como reserva');
 assert.ok(x.requests[0].startsWith('https://example.invalid/cache'),'o cache vem antes');
 assert.ok(x.requests[1].startsWith('https://example.invalid/read'),'a API viva vem depois');
 x.requests.forEach((pedido,i)=>{
  const url=new URL(pedido);
  assert.equal(url.searchParams.get('painel'),'organico');
  assert.equal(url.searchParams.has('k'),false);
  assert.equal(url.searchParams.get('other'),null);
  assert.equal(x.headers[i].Authorization,'Bearer synthetic-key&other=x');
 });
});

test('um cache fresco encerra a leitura sem tocar na API viva',async()=>{
 const x=boot();
 x.context.fetch=async(url,init)=>{x.requests.push(url);x.headers.push(init.headers);
  return {status:200,ok:true,json:async()=>({_escopo:'organico',cx_organico_receita:[],_cache_gerado_em:new Date().toISOString()})};};
 await x.run('carrega()');
 assert.equal(x.requests.length,1,'cache válido não dispara a consulta de 3 a 6 s');
 assert.ok(x.requests[0].includes('/cache'));
 assert.equal(x.run('ORIGEM_LEITURA'),'cache');
});

test('uma chave recusada no cache não é reapresentada à API viva',async()=>{
 const x=boot();
 x.context.fetch=async url=>{x.requests.push(url);return {status:401,ok:false,json:async()=>null};};
 x.context.ACESSO_ORGANICO={setBusy:()=>{},show:()=>{},reject:()=>{x.context.recusou=true;}};
 x.context.avisoTela=()=>{};
 await x.run('carrega()');
 assert.equal(x.requests.length,1,'401 no cache encerra a carga');
 assert.equal(x.context.recusou,true);
});

test('agenda uma unica leitura a cada dez minutos e ignora os ciclos com aba oculta',()=>{
 const timers=[],document={hidden:false};let calls=0;
 const context=vm.createContext({document,setInterval:(fn,ms)=>timers.push({fn,ms}),carrega:()=>{calls++;},
  $:()=>({textContent:''}),Date,REFRESH_SEG:1});
 vm.runInContext(trecho("setInterval(()=>{$('#relogio')",'</script>'),context);
 assert.equal(calls,1,'a carga inicial continua imediata');
 assert.deepEqual(timers.map(t=>t.ms),[1000,600000],'a configuracao global nao acelera a leitura local');
 const refresh=timers[1].fn;
 document.hidden=true;refresh();refresh();assert.equal(calls,1);
 document.hidden=false;refresh();assert.equal(calls,2);
 assert.equal(timers.length,2,'o ciclo nao agenda timers adicionais');
});

/* O card do topo e a aba Stories precisam falar o mesmo número. */
const ledgerFixture=()=>({
 organico_attribution:{schema_version:1,window_days:30,source_system:'shopify',currency:'BRL',piece_identity_available:false,
  rule_version:'organico-utm-20260919-v1',
  daily:[{marca:'aristo',dia:'2026-09-15',model:'last_click',classification:'editorial',detail_level:'utm',rede:'instagram',
   superficie:'story',utm_source:'instagram_social',utm_medium:'story',utm_campaign:'20260915_semana',utm_content:null,utm_term:null,
   utm_raw_available:true,utm_provenance:'shopify',piece_status:'nao_identificada',pedidos:293,receita_liquida:43119.56}],
  quality:[{marca:'aristo',dia:'2026-09-15',pagos_elegiveis:300,ultima_sessao_desconhecida:0,origem_nao_direta_desconhecida:0}],
  coverage:[{marca:'aristo',dia:'2026-09-15',checked_at:'2026-09-15T18:00:00Z'}]},
 cx_story:[],cx_post:[],cx_organico_receita:[]});

test('o KPI de receita do topo lê o mesmo ledger da aba Stories, não a projeção anterior',()=>{
 const OA=require('../organico-attribution.js'),OS=require('../organico-stories.js');
 const x=boot();
 Object.assign(x.context,{OA,OS,API:ledgerFixture(),MARCA:'aristo',PER:{ini:'2026-09-14',fim:'2026-09-20'},
  G:{anterior:()=>({ini:'2026-09-07',fim:'2026-09-13'}),mediana:()=>null},CMP:false,
  classifica:l=>l,agregado:()=>({posts:0,alcance:0,qualificado:0,eq:null,mediana:null})});
 x.run('pintaKPIs()');
 const html=x.elements.get('#area-kpis').innerHTML;
 assert.match(html,/Receita de Stories/,'o rótulo deixa de prometer reels e post, que não carregam link');
 assert.match(html,/43\.119,56/,'mostra o número do ledger');
 const cartao=html.slice(html.indexOf('Receita de Stories'));
 assert.doesNotMatch(cartao.slice(0,300),/sem dado/,'o valor do próprio cartão não pode ser "sem dado" com receita no ledger');
 assert.match(html,/293 pedidos/);
 assert.match(html,/mesma fonte da aba Stories/);
 assert.match(html,/Projeção anterior para story: sem dado/,'a projeção antiga vira detalhe, não o número principal');
 // o mesmo valor que a aba Stories publica
 const v=OS.select(x.context.API,'aristo','2026-09-14','2026-09-20','last_click');
 assert.equal(v.storyRevenue,43119.56);
});

test('sem o ledger na página o card cai para a projeção anterior e explica a ausência',()=>{
 const x=boot();
 Object.assign(x.context,{API:{cx_organico_receita:[],cx_post:[],cx_story:[]},MARCA:'aristo',PER:{ini:'2026-09-14',fim:'2026-09-20'},
  G:{anterior:()=>({ini:'2026-09-07',fim:'2026-09-13'}),mediana:()=>null},CMP:false,
  classifica:l=>l,agregado:()=>({posts:0,alcance:0,qualificado:0,eq:null,mediana:null})});
 x.run('pintaKPIs()');
 const html=x.elements.get('#area-kpis').innerHTML;
 assert.match(html,/Receita histórica de story/);
 assert.match(html,/não reconhece os links com medium=story/,'a ausência é explicada, não fica só "sem dado"');
});
