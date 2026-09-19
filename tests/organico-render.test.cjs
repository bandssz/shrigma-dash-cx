/* Fixtures sinteticas. Executa as funcoes reais do HTML sem rede ou dados de clientes. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.resolve(__dirname,'../organico.html'),'utf8');
function trecho(inicio,fim){
 const a=html.indexOf(inicio),b=html.indexOf(fim,a);
 assert(a>=0&&b>a,`trecho do front nao encontrado: ${inicio}`);
 return html.slice(a,b);
}
function boot(linhas=[]){
 const elements=new Map(),requests=[],venda=[];
 const $=s=>{if(!elements.has(s))elements.set(s,{innerHTML:'',textContent:''});return elements.get(s);};
 const context=vm.createContext({console,Intl,API:{cx_organico_receita:linhas},PER:{ini:'2026-09-01',fim:'2026-09-19'},CMP:false,
  G:{anterior:()=>({ini:'2026-08-13',fim:'2026-08-31'})},MARCA:'todas',
  $: $,document:{querySelectorAll:()=>[]},posts:()=>[],stories:()=>[],conta:()=>[],classifica:x=>x,
  agregado:()=>({eq:null,mediana:null}),daMarca:()=>true,chip:()=>'',varia:(a,b)=>b?Math.round(100*(a-b)/b):null,
  nf:n=>n==null?'—':Number(n).toLocaleString('pt-BR'),pc:n=>n==null?'—':String(n)+'%',
  esc:s=>String(s??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])),
  renderVenda:rows=>venda.push(rows),troca:()=>{},render:()=>{},shrigmaFrescor:()=>{},
  chaveLeitura:()=> 'synthetic-key&other=x',CX_API_URL:'https://example.invalid/read',
  shrigmaMarcaMestra:()=>{},shrigmaEsqueceChave:()=>{},avisoTela:(t,d)=>{throw Error(t+': '+d);},window:{},
  fetch:async url=>{requests.push(url);return {status:200,ok:true,json:async()=>({cx_organico_receita:[]})};},
 });
 for(const source of [
  trecho('function grupoReceitaOrganico(r){','// Conversao por UTM:'),
  trecho('function pintaKPIs(){','/* ---------- grade:'),
  trecho('async function carrega(){',"document.querySelectorAll('#seg-marca button')"),
 ])vm.runInContext(source,context);
 return {context,elements,requests,venda,run:s=>vm.runInContext(s,context)};
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
 for(const [value,expected] of [[0,/R\$ 0,00/],[null,/sem dado/],[undefined,/sem dado/],['',/sem dado/],['erro',/sem dado/]]){
  const x=boot([row({receita_ultimo:value})]);x.run('pintaKPIs()');assert.match(receitaCard(x),expected);
 }
 const x=boot([row(),row({receita_ultimo:null}),row({utm_medium:'dm',receita_ultimo:null})]);
 x.run('pintaKPIs()');const card=receitaCard(x);
 assert.match(card,/sem dado/);assert.match(card,/Automação DM: receita indisponível/);
 assert.doesNotMatch(card,/R\$ 100,00/);
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
 assert.equal(x.requests.length,1);
 const url=new URL(x.requests[0]);
 assert.equal(url.searchParams.get('painel'),'organico');
 assert.equal(url.searchParams.get('k'),'synthetic-key&other=x');
 assert.equal(url.searchParams.get('other'),null);
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
