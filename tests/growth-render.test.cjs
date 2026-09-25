/* Teste de integração em DOM local, sem abrir navegador ou fazer chamadas externas.
   Dependência de desenvolvimento: npm install --prefix ../growth-test-tools linkedom@0.18.12 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),Receipt=require('../n8n/growth/template-operation-receipt.cjs');
const {parseHTML}=require(require.resolve('linkedom',{paths:[path.resolve(__dirname,'../../growth-test-tools/node_modules')]}));
const root=path.resolve(__dirname,'..');
const fixture=()=>({
 _painel:'growth',_escopo:'growth',gerado_em:'2026-09-08T01:00:00Z',
 crm_wa_cobertura:{inicio:'2026-06-10',fim:'2026-09-07'},
 crm_wa_envios:[{dia:'2026-09-07',marca:'fish',canal:'whatsapp',flow:'carrinho',piece:'carrinho-30min',registros:142,aceitos:42,entregues:40,lidos:12,falhas:1,pendentes_entrega:1,sem_disparo_confirmado:100},
 {dia:'2026-09-07',marca:'aristo',canal:'whatsapp',flow:'transacional',piece:'pedido-pago',registros:102,aceitos:0,entregues:0,lidos:0,falhas:0,pendentes_entrega:0,sem_disparo_confirmado:102},
 {dia:'2026-09-07',marca:'fish',canal:'whatsapp',flow:'teste-motor',piece:'teste',registros:7,aceitos:7,entregues:7,lidos:7,falhas:0,pendentes_entrega:0,sem_disparo_confirmado:0}],
 crm_fluxo:[{dia:'2026-09-07',marca:'fish',canal:'whatsapp',flow:'carrinho',piece:'carrinho-30min',enviados:142,pedidos_ultimo:2,receita_ultimo:300},
 {dia:'2026-09-07',marca:'fish',canal:'email',flow:'carrinho',piece:'carrinho-30min',enviados:50,pedidos_ultimo:1,receita_ultimo:100}],
 crm_conversao:[{dia:'2026-09-07',marca:'fish',canal:'whatsapp',utm_medium:'fluxo',utm_campaign:'carrinho',utm_content:'carrinho-30min',pedidos_ultimo:2,receita_ultimo:300,coletado_em:'2026-09-08T00:40:00Z'},
 {dia:'2026-09-07',marca:'fish',canal:'email',utm_medium:'campanha',utm_campaign:'lancamento',utm_content:'primeiro',pedidos_ultimo:1,receita_ultimo:100,coletado_em:'2026-09-08T00:40:00Z'}],
 crm_campanha:[{marca:'fish',canal:'email',tipo:'enviada',campanha_id:1,nome:'Campanha exemplo',enviado_em:'2026-09-07T14:00:00Z',enviados:100,entregues:98,abriram:30,clicaram:10,hard:2,complaints:0,coletado_em:'2026-09-08T00:40:00Z'}],
 crm_campanha_receita:[],crm_campanha_grupo:[],crm_diario:[],crm_intradia:[],crm_carrinho:[],crm_galho:[],crm_regra_galho:[],crm_teste:[],crm_teste_braco:[],crm_credencial:[],wa_saude:[],
});
async function boot(payload=fixture(),opts={}){
 const html=fs.readFileSync(path.join(root,'growth.html'),'utf8'),{document,window}=parseHTML(html);
 // linkedom não implementa setters de select/layout; apenas completar a API do DOM,
 // sem simular resultados de métricas ou comportamento da aplicação.
 const selectProto=Object.getPrototypeOf(document.querySelector('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 window.HTMLElement.prototype.scrollIntoView=function(){};
 // linkedom não rastreia foco: registrar focus() e expor activeElement permite testar a preservação.
 let focado=null;window.HTMLElement.prototype.focus=function(){focado=this;};window.HTMLElement.prototype.blur=function(){focado=null;};
 Object.defineProperty(document,'activeElement',{configurable:true,get(){return focado&&focado.isConnected?focado:document.body;}});
 window.HTMLElement.prototype.getBoundingClientRect=function(){return {top:0,width:1200,height:100};};
 const store=new Map(opts.noReadKey?[]:[['shrigma_k_growth','synthetic-test-key']]);
 const requests=[],downloads=[],hashes=[],calls=[],uiActions=[];let response=payload,code=200;
 const NativeDate=Date;class FixedDate extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-08T01:10:00Z']));}static now(){return new NativeDate('2026-09-08T01:10:00Z').valueOf();}}
 const heldLocks=new Set(),locks={request:async(key,opts,fn)=>{if(heldLocks.has(key))return fn(null);heldLocks.add(key);try{return await fn({name:key});}finally{heldLocks.delete(key);}}};
 const cryptoProvider=opts.cryptoProvider||webcrypto;
 const context=vm.createContext({document,window,Date:FixedDate,Intl,URL,URLSearchParams,AbortSignal,crypto:cryptoProvider,TextEncoder,navigator:{locks},console,__downloads:downloads,
 __trackUiAction:(name,promise)=>uiActions.push({name,promise}),
 Image:class{set src(x){}},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
 location:{reload:()=>{throw Error('unexpected reload');},hash:opts.hash||''},history:{replaceState:(a,b,url)=>hashes.push(url)},
 Blob:class{constructor(parts){this.text=parts.join('');}},prompt:opts.prompt||(()=>null),confirm:()=>false,
 addEventListener:()=>{},setInterval:()=>0,clearInterval:()=>{},setTimeout,clearTimeout,
 fetch:async(url,init)=>{requests.push(url);calls.push({url,init});if(opts.fetchMock){const r=await opts.fetchMock(url,init);if(r)return r;}
  // The 10-minute cache serves the same payload stamped with its generation time; the panel reads it first and only falls back to the live API on a miss.
  const body=structuredClone(response);if(typeof url==='string'&&url.includes('cx-dash-cache')&&body&&typeof body==='object'&&!Array.isArray(body))body._cache_gerado_em=new NativeDate(FixedDate.now()).toISOString();
  return {status:code,ok:code>=200&&code<300,json:async()=>body};},});
 for(const script of document.querySelectorAll('script')){
  const src=script.getAttribute('src');
  const code=src?fs.readFileSync(path.join(root,src.split('?')[0]),'utf8'):script.textContent;
  vm.runInContext(code,context,{filename:src||'growth-inline.js'});
 }
 const run=code=>vm.runInContext(code,context);
 // DOM click() does not return its async listener's promise. Track the real
 // public action without replacing its work, so native WebCrypto may finish
 // whenever the runner schedules it, rather than after a fixed number of ticks.
 run(`for(const name of ['salvarServidor','validarServidor','submeter','verificarSubmissao','verificarSubmissoes','consultarOperacao']){
   const original=GRU[name];GRU[name]=function(...args){const pending=original.apply(this,args);__trackUiAction(name,pending);return pending;};
 }`);
 // Exportação: captura o CSV em vez de criar um download real.
 run('GT.baixar=(nome,texto)=>{__downloads.push({nome,texto});return true;}');
 for(let i=0;i<10&&run('LOADING');i++)await new Promise(setImmediate);
 return {document,window,run,requests,calls,store,downloads,hashes,uiActions,setResponse:(r,status=200)=>{response=r;code=status;}};
}
test('front completo carrega, filtra canal/marca e mantém sombra fora dos disparos',async()=>{
 const x=await boot();assert.equal(x.document.querySelector('#load-state').hidden,true);
 assert.equal(x.document.querySelectorAll('#area-kpis .kpi').length,5);
 assert.deepEqual([...x.document.querySelectorAll('#area-kpis .kpi-rot')].map(n=>n.textContent),['Disparos registrados','Receita atribuída','Pedidos atribuídos','Entrega WhatsApp','CTR das campanhas de e-mail']);
 assert.equal(x.document.querySelectorAll('.channel-card').length,2);
 assert(x.requests[0].includes('painel=growth'));
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,'192');
 x.document.querySelector('[data-canal="whatsapp"]').click();
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,'42');
 assert.deepEqual([...x.document.querySelectorAll('#area-kpis .kpi-rot')].map(n=>n.textContent),['Aceitos pela Meta','Entregues','Falhas na entrega','Receita atribuída','Pedidos atribuídos']);
 assert.deepEqual([...x.document.querySelectorAll('#area-kpis .kpi-val')].slice(0,3).map(n=>n.textContent),['42','40','1']);
 assert.equal(x.document.querySelectorAll('.channel-card').length,1);
 assert.equal(x.document.querySelector('#campaign-email-block').hidden,true);
 assert.equal(x.document.querySelector('[data-canal="whatsapp"]').getAttribute('aria-pressed'),'true');
 x.document.querySelector('[data-marca="aristo"]').click();
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,'0');
 assert.match(x.document.querySelector('.channel-card').textContent,/102/);
 assert(!/NaN|Infinity/.test(x.document.body.textContent));
});
test('automações preservam canal e seleção de fluxo altera somente a tabela',async()=>{
 const x=await boot();x.document.querySelector('[data-open-flows="whatsapp"]').click();
 assert.equal(x.run('SEC'),'regua');assert.equal(x.run('CANAL'),'whatsapp');
 const before=x.document.querySelector('#area-kpis').textContent;
 const sel=x.document.querySelector('#sel-flow');sel.value='transacional';sel.dispatchEvent(new x.window.Event('change'));
 assert.equal(x.document.querySelectorAll('#tab-regua tbody tr').length,1);
 assert.match(x.document.querySelector('#tab-regua tbody').textContent,/pedido-pago/);
 assert.equal(x.document.querySelector('#area-kpis').textContent,before);
 assert(!/teste-motor/.test(x.document.querySelector('#tab-regua tbody').textContent));
});
test('falha de atualização preserva o último dado e permite nova tentativa',async()=>{
 const x=await boot();const before=x.document.querySelector('#area-kpis').textContent;
 x.setResponse({},500);await x.run('carregar()');
 assert.match(x.document.querySelector('#faixa-alertas').textContent,/últimos dados/);
 assert.equal(x.document.querySelector('#area-kpis').textContent,before);
 assert.equal(x.document.querySelector('#btn-atualizar').disabled,false);
 x.setResponse(fixture());await x.run('carregar()');
 assert(!x.document.querySelector('#tentar-novamente'));
});
test('ausência de WA não vira zero nem derruba os indicadores de e-mail',async()=>{
 const p=fixture();delete p.crm_wa_envios;delete p.crm_wa_cobertura;
 const x=await boot(p);assert.equal(x.document.querySelector('#wa-coverage').hidden,false);
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,'—');
 x.document.querySelector('[data-canal="email"]').click();
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,'150');
 assert.equal(x.document.querySelector('#wa-coverage').hidden,true);
});
test('acompanhamento mostra histórico por peça e atalho filtra marca, canal e fluxo',async()=>{
 const p=fixture();p.crm_wa_envios.forEach(r=>r.erros_sincronos=0);
 p.crm_wa_envios[0].ultimo_registro_em='2026-09-07T15:30:00Z';
 p.crm_wa_envios[0].ultimo_status_em='2026-09-08T00:30:00Z';
 const x=await boot(p),section=x.document.querySelector('#automation-attention');
 assert.equal(section.querySelectorAll('.attention-row').length,1);
 assert.deepEqual([...section.querySelectorAll('.attention-stat strong')].map(n=>n.textContent),['1','0','1']);
 assert.match(section.textContent,/Histórico do período/);assert.match(section.textContent,/não informa se o fluxo está ligado/);
 assert.match(section.querySelector('.attention-time').textContent,/07\/09\/2026, 12:30/);
 const period=x.run('JSON.stringify(PER)');
 section.querySelector('[data-attention-flow]').click();
 assert.equal(x.run('SEC'),'regua');assert.equal(x.run('CANAL'),'whatsapp');assert.equal(x.run('MARCA'),'fish');
 assert.equal(x.document.querySelector('#sel-flow').value,'carrinho');
 assert.equal(x.document.querySelectorAll('#tab-regua tbody tr').length,1);
 assert.equal(x.run('JSON.stringify(PER)'),period);
});
test('sombra sem erro não vira atenção e acompanhamento de e-mail é informativo',async()=>{
 const p=fixture();p.crm_wa_envios.forEach(r=>r.erros_sincronos=0);
 const x=await boot(p);x.document.querySelector('[data-marca="aristo"]').click();
 let section=x.document.querySelector('#automation-attention');
 assert.equal(section.querySelectorAll('.attention-row').length,0);
 assert.match(section.textContent,/Isso não confirma que os fluxos estejam ligados/);
 section.querySelector('[data-attention-email]').click();
 assert.equal(x.run('CANAL'),'email');assert.equal(x.run('SEC'),'regua');assert.equal(x.run('MARCA'),'aristo');
 section=x.document.querySelector('#automation-attention');
 assert.equal(section.querySelectorAll('.attention-stats').length,0);
 assert.match(section.textContent,/entrega e falhas individuais ainda não são medidas/);
 assert.equal(section.querySelectorAll('.attention-occurrence,.alerta-ruim').length,0);
});
test('acompanhamento informa campos e janela ausentes sem renderizar zero falso',async()=>{
 const p=fixture();delete p.crm_wa_envios[0].falhas;
 const x=await boot(p);let section=x.document.querySelector('#automation-attention');
 assert.equal(section.querySelector('.attention-stat strong').textContent,'—');
 assert.match(section.textContent,/Algumas contagens não foram informadas/);
 assert.match(section.textContent,/Contagem incompleta/);
 x.run("PER={ini:'2026-06-01',fim:'2026-09-07'};render();");
 section=x.document.querySelector('#automation-attention');
 assert([...section.querySelectorAll('.attention-stat strong')].every(n=>n.textContent==='—'));
 assert.match(section.textContent,/não está totalmente coberto/);
});
test('identificadores de peça e fluxo são escapados no novo acompanhamento',async()=>{
 const p=fixture();p.crm_wa_envios[0].piece='<img src=x onerror=bad()>',p.crm_wa_envios[0].flow='" onclick="bad()';
 const x=await boot(p),section=x.document.querySelector('#automation-attention');
 assert.equal(section.querySelectorAll('img,[onclick]').length,0);
 assert.match(section.textContent,/<img src=x onerror=bad\(\)>/);
});
if(process.env.GROWTH_LIVE_PAYLOAD)test('payload Growth real renderiza todos os canais sem erro e reconcilia WA',async()=>{
 const p=JSON.parse(fs.readFileSync(process.env.GROWTH_LIVE_PAYLOAD,'utf8'));
 const x=await boot(p);
 assert(!x.document.querySelector('#tentar-novamente'));
 x.run("PER={ini:'2026-06-10',fim:'2026-09-07'};document.querySelectorAll('#presets button').forEach(b=>b.classList.remove('ativo'));setCanal('whatsapp');");
 const expected=p.crm_wa_envios.filter(r=>r.flow!=='teste-motor').reduce((n,r)=>n+r.aceitos,0);
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,expected.toLocaleString('pt-BR'));
 for(const canal of ['todos','email','whatsapp'])for(const marca of ['todas','fish','aristo','olivas']){
  x.run(`MARCA=${JSON.stringify(marca)};setCanal(${JSON.stringify(canal)});`);
  assert(!/NaN|Infinity|undefined/.test(x.document.querySelector('#area-kpis').textContent));
 }
});
test('operação atual integra marca e canal e permanece independente do histórico',async()=>{
 const p=fixture();p.crm_operacao=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
 const x=await boot(p);x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="workflows"]').click();
 assert.equal(x.document.querySelector('#control-workflows').hidden,false);
 x.document.querySelector('[data-marca="fish"]').click();x.document.querySelector('[data-canal="whatsapp"]').click();
 assert.equal(x.document.querySelectorAll('[data-control-workflow]').length,2);
 const before=x.document.querySelector('#control-workflows').textContent;
 x.run("PER={ini:'2026-07-01',fim:'2026-07-02'};render();");
 assert.equal(x.document.querySelector('#control-workflows').textContent,before);
 assert.equal(x.document.querySelector('#control-workflows').hidden,false);
 assert.match(before,/independente do período/);
});
test('atalho de ocorrência volta ao histórico mesmo após abrir templates',async()=>{
 const p=fixture();p.crm_operacao=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
 const x=await boot(p);x.document.querySelector('[data-control-tab="templates"]').click();
 x.document.querySelector('[data-attention-flow]').click();
 assert.equal(x.document.querySelector('#control-history').hidden,false);
 assert.equal(x.document.querySelector('#control-templates').hidden,true);
 assert.equal(x.document.querySelector('#sel-flow').value,'carrinho');
});

/* ---------- P0 (09/09/2026) ---------- */
test('faixa de fontes mostra um horário por origem, marca inventário ausente e consulta que falhou',async()=>{
 const x=await boot();
 const fontes=[...x.document.querySelectorAll('#fontes .fonte')];
 assert.deepEqual(fontes.map(f=>f.querySelector('b').textContent),['Consulta','WhatsApp','Venda','E-mail','Inventário']);
 assert.match(fontes[0].textContent,/às 22:10/); // 01:10Z = 22:10 em Brasília, mesmo dia BRT
 assert.equal(fontes[0].dataset.estado,'ok');
 assert.match(fontes[2].textContent,/coletada até 21:40/);
 assert.equal(fontes[4].dataset.estado,'falta');assert.match(fontes[4].textContent,/sem dado/);
 assert(fontes.every(f=>f.title.length>20));
 x.setResponse({},500);await x.run('carregar()');
 const consulta=x.document.querySelector('#fontes .fonte');
 assert.equal(consulta.dataset.estado,'ruim');assert.match(consulta.textContent,/falhou · exibindo 22:10/);
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,'192');
});
test('e-mail: KPI de CTR informa a base medida e o card lista o que é lacuna',async()=>{
 const x=await boot();x.document.querySelector('[data-canal="email"]').click();
 assert.equal(x.document.querySelectorAll('#area-kpis .kpi').length,4);
 assert.match(x.document.querySelector('#area-kpis .kpi:last-child').textContent,/1 de 1 peças medidas/);
 const gaps=[...x.document.querySelectorAll('.measure-gaps li')];
 assert.deepEqual(gaps.map(g=>g.dataset.gap),['ok','lacuna','lacuna']);
 assert.match(gaps[1].textContent,/entrega individual não medida/);
 assert.match(gaps[1].title,/não como 0% ou 100%/);
});
test('atalhos dos KPIs levam à tabela certa preservando marca e período',async()=>{
 const x=await boot();x.document.querySelector('[data-marca="fish"]').click();const period=x.run('JSON.stringify(PER)');
 x.document.querySelector('[data-kpi-jump="conv"]').click();
 assert.equal(x.run('SEC'),'camp');assert.equal(x.run('MARCA'),'fish');assert.equal(x.run('JSON.stringify(PER)'),period);
 x.document.querySelector('[data-s="visao"]').click();
 x.document.querySelector('[data-kpi-jump="flows:whatsapp"]').click();
 assert.equal(x.run('SEC'),'regua');assert.equal(x.run('CANAL'),'whatsapp');assert.equal(x.run('MARCA'),'fish');
 assert.equal(x.document.querySelector('#control-history').hidden,false);
});
test('campanhas: ordenação por cabeçalho, busca com vazio específico e linha aberta sobrevive à reconsulta',async()=>{
 const p=fixture();p.crm_campanha.push({marca:'aristo',canal:'email',tipo:'enviada',campanha_id:7,nome:'Zebra maior',enviado_em:'2026-09-06T14:00:00Z',enviados:500,entregues:490,abriram:null,clicaram:20,hard:0,complaints:0,utm_campaign:'zebra',utm_content:'a'});
 const x=await boot(p);
 const nomes=()=>[...x.document.querySelectorAll('#tab-camp tbody tr:not(.det) strong')].map(n=>n.textContent);
 assert.deepEqual(nomes(),['Campanha exemplo','Zebra maior']); // padrão: mais recente primeiro
 x.document.querySelector('#tab-camp th[data-sort="enviados"]').click();
 assert.deepEqual(nomes(),['Zebra maior','Campanha exemplo']);
 assert.equal(x.document.querySelector('#tab-camp th[data-sort="enviados"]').getAttribute('aria-sort'),'descending');
 x.document.querySelector('#tab-camp th[data-sort="enviados"]').click();
 assert.deepEqual(nomes(),['Campanha exemplo','Zebra maior']);
 // abertura não medida ordena por último nas duas direções
 x.document.querySelector('#tab-camp th[data-sort="abertura_pct"]').click();assert.deepEqual(nomes(),['Campanha exemplo','Zebra maior']);
 x.document.querySelector('#tab-camp th[data-sort="abertura_pct"]').click();assert.deepEqual(nomes(),['Campanha exemplo','Zebra maior']);
 const mais=x.document.querySelector('#tab-camp .mais');mais.click();
 assert.equal(mais.closest('tr').nextElementSibling.hidden,false);
 await x.run('carregar()');
 const depois=x.document.querySelector('#tab-camp .mais');
 assert.equal(depois.getAttribute('aria-expanded'),'true');assert.equal(depois.closest('tr').nextElementSibling.hidden,false);assert.equal(depois.textContent,'–');
 const busca=x.document.querySelector('#camp-busca');busca.value='ZEBRA';busca.dispatchEvent(new x.window.Event('input'));
 assert.deepEqual(nomes(),['Zebra maior']);assert.match(x.document.querySelector('#camp-contagem').textContent,/1 de 2/);
 busca.value='nada-disso';busca.dispatchEvent(new x.window.Event('input'));
 assert.match(x.document.querySelector('#tab-camp tbody').textContent,/Nenhuma peça contém "nada-disso"/);
 x.document.querySelector('#tab-camp [data-limpar]').click();
 assert.equal(nomes().length,2);assert.equal(busca.value,'');
});
test('exportação CSV sai igual à tela: filtro, recorte, ausente vazio, indivisível em branco e sem chave',async()=>{
 const p=fixture();p.crm_campanha.push({marca:'aristo',canal:'email',tipo:'enviada',campanha_id:7,nome:'Zebra; "aspas"',enviado_em:'2026-09-06T14:00:00Z',enviados:500,entregues:490,abriram:null,clicaram:20,hard:0,complaints:0,utm_campaign:'zebra',utm_content:'a'});
 p.crm_campanha_receita=[{marca:'aristo',campanha_id:7,pedidos:3,receita:900,utm_ambiguo:true}];
 const x=await boot(p);x.document.querySelector('[data-canal="email"]').click();
 const busca=x.document.querySelector('#camp-busca');busca.value='zebra';busca.dispatchEvent(new x.window.Event('input'));
 x.document.querySelector('#camp-export').click();
 assert.equal(x.downloads.length,1);
 const {nome,texto}=x.downloads[0];
 assert.equal(nome,'growth-campanhas-consolidada-e-mail-2026-09-01_2026-09-07.csv');
 const linhas=texto.split('\r\n');
 assert.equal(linhas.length,3);assert.match(linhas[0],/^\uFEFFPeça;Marca;Enviado em/);assert.match(linhas[0],/recorte_marca;recorte_canal;periodo_inicio;periodo_fim;modelo_atribuicao;referencia_consulta;busca$/);
 assert.match(linhas[1],/^"Zebra; ""aspas""";O Aristocrata;/);
 // abertura não medida → vazio; CTOR sem abertura → vazio; receita indivisível → vazio + sim
 assert.match(linhas[1],/;500;490;98;;4,08;;0;0;0;;;sim;;não;Consolidada;E-mail;2026-09-01;2026-09-07;Fonte anterior não reconciliada;07\/09\/2026, 22:10;zebra$/);
 assert.doesNotMatch(texto,/synthetic-test-key|shrigma_k/);
 x.document.querySelector('[data-s="camp"]').click();
 x.document.querySelector('#conv-export').click();
 assert.equal(x.downloads.length,2);assert.match(x.downloads[1].nome,/^growth-conversao-peca-/);
 assert.match(x.downloads[1].texto,/lancamento;primeiro;lancamento;1;100/);
});
test('automações: busca, ordenação, exportação e vazio específico com fluxo selecionado',async()=>{
 const x=await boot();x.document.querySelector('[data-open-flows="whatsapp"]').click();
 const pecas=()=>[...x.document.querySelectorAll('#tab-regua tbody .flow-name')].map(n=>n.textContent);
 assert.deepEqual(pecas(),['carrinho-30min','pedido-pago']);
 x.document.querySelector('#tab-regua th[data-sort="enviados"]').click();assert.deepEqual(pecas(),['carrinho-30min','pedido-pago']);
 x.document.querySelector('#tab-regua th[data-sort="enviados"]').click();assert.deepEqual(pecas(),['pedido-pago','carrinho-30min']);
 const busca=x.document.querySelector('#regua-busca');busca.value='pedido';busca.dispatchEvent(new x.window.Event('input'));
 assert.deepEqual(pecas(),['pedido-pago']);
 x.document.querySelector('#regua-export').click();
 assert.equal(x.downloads.length,1);assert.match(x.downloads[0].nome,/^growth-automacoes-consolidada-whatsapp-proprio-/);
 assert.match(x.downloads[0].texto,/pedido-pago;transacional;O Aristocrata;whatsapp;0;0;0;0;0;102;/);
 assert.doesNotMatch(x.downloads[0].texto,/carrinho-30min|teste-motor/);
 const sel=x.document.querySelector('#sel-flow');sel.value='carrinho';sel.dispatchEvent(new x.window.Event('change'));
 assert.match(x.document.querySelector('#tab-regua tbody').textContent,/Nenhuma peça de "carrinho" contém "pedido"/);
 assert.equal(x.document.querySelector('#regua-export').disabled,true);
 x.document.querySelector('#tab-regua [data-flows-clear]').click();
 assert.equal(pecas().length,2);assert.equal(busca.value,'');
 await x.run('carregar()');assert.equal(x.run("GUI.flowsState.sort"),'enviados');
});
test('operação atual: filtros de estado e modo com vazio específico, busca mantém foco na reconsulta e exporta sem versões',async()=>{
 const p=fixture();p.crm_operacao=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
 const x=await boot(p);x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="workflows"]').click();
 const cards=()=>[...x.document.querySelectorAll('[data-control-workflow]')].map(c=>c.dataset.controlWorkflow);
 assert.equal(cards().length,4);
 const modo=x.document.querySelector('#control-wf-modo');modo.value='sombra';modo.dispatchEvent(new x.window.Event('change'));
 assert.deepEqual(cards(),['aristo_tx']);assert.match(x.document.querySelector('#control-workflows .gt-contagem').textContent,/1 de 4/);
 const estado=x.document.querySelector('#control-wf-estado');estado.value='inativas';estado.dispatchEvent(new x.window.Event('change'));
 assert.deepEqual(cards(),[]);
 assert.match(x.document.querySelector('#control-workflows .vazio').textContent,/Nenhuma automação inativa em modo sombra\. Modo sombra ou inativo não significa/);
 x.document.querySelector('#control-workflows .vazio [data-clear="wf"]').click();
 assert.equal(cards().length,4);
 const busca=x.document.querySelector('#control-workflow-search');busca.value='rastreio';busca.dispatchEvent(new x.window.Event('input'));
 assert.deepEqual(cards(),['fish_tx','aristo_tx']);
 assert.equal(x.document.activeElement?.id,'control-workflow-search');
 x.run('GC.render({api:API,marca:MARCA,canal:CANAL,exportMeta})');
 assert.equal(x.document.activeElement?.id,'control-workflow-search');assert.equal(x.document.querySelector('#control-workflow-search').value,'rastreio');
 x.document.querySelector('#control-wf-export').click();
 const {nome,texto}=x.downloads[0];
 assert.match(nome,/^growth-automacoes-operacao-consolidada-e-mail-e-whatsapp\.csv$/);
 assert.doesNotMatch(nome,/2026-09-01/);
 assert.match(texto.split('\r\n')[0],/coleta_inventario$/);assert.doesNotMatch(texto,/version_id|active_version_id/);
 assert.match(texto,/Pedido pago e rastreio Aristocrata;aristo_tx;O Aristocrata;WhatsApp;sim;sim;não;config;Pedido pago=sombra \| Rastreio=sombra;none;all;ok;Consulta atual;;/);
 assert.equal(texto.split('\r\n').length-2,2);
});
test('templates: filtros por status, categoria e uso, ordenação por peça e exportação sem id',async()=>{
 const p=fixture();p.crm_operacao=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
 p.crm_operacao.templates[1].status='PENDING';p.crm_operacao.templates[1].category='MARKETING';p.crm_operacao.templates[1].category_matches_expected=false;
 const x=await boot(p);x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="templates"]').click();
 const keys=()=>[...x.document.querySelectorAll('[data-control-template]')].map(r=>r.dataset.controlTemplate);
 assert.deepEqual(keys(),['fish_native','fish_paid','aristo_paid']); // padrão: peça A→Z, marcas juntas
 x.document.querySelector('#control-template-table th[data-sort="piece"]').click(); // já é piece asc → vira desc
 assert.deepEqual(keys(),['fish_paid','aristo_paid','fish_native']);
 x.document.querySelector('#control-template-table th[data-sort="status"]').click();
 assert.deepEqual(keys(),['fish_paid','fish_native','aristo_paid']);
 const uso=x.document.querySelector('#control-tpl-uso');uso.value='native_pending';uso.dispatchEvent(new x.window.Event('change'));
 assert.deepEqual(keys(),['fish_native']);
 const cat=x.document.querySelector('#control-tpl-categoria');cat.value='MARKETING';cat.dispatchEvent(new x.window.Event('change'));
 assert.match(x.document.querySelector('#control-templates .vazio').textContent,/Nenhum template MARKETING com integração pendente neste recorte/);
 x.document.querySelector('#control-templates .vazio [data-clear="tpl"]').click();
 assert.equal(keys().length,3);
 cat.value='divergente';cat.dispatchEvent(new x.window.Event('change'));
 assert.deepEqual([...x.document.querySelectorAll('[data-control-template]')].map(r=>r.dataset.controlTemplate),['aristo_paid']);
 x.document.querySelector('#control-tpl-export').click();
 const {texto}=x.downloads[0];
 assert.doesNotMatch(texto.split('\r\n')[0],/;id;|^id;/);
 assert.match(texto,/pedido-pago;aristo_confirmacao_exemplo;O Aristocrata;pt_BR;PENDING;MARKETING;UTILITY;sim;mapeado no fluxo;;;;;ok;/); // vínculo/métricas/cobertura vazios sem mapped_in e crm_wa_template
 assert.equal(x.downloads[0].texto.split('\r\n').length-2,1);
});
test('hash da URL abre a tela pedida e é atualizado ao mudar filtros, sem chave',async()=>{
 const x=await boot(fixture(),{hash:'#marca=fish&canal=whatsapp&p=30&sec=regua&aba=templates&flow=carrinho&k=nao-deve-entrar'});
 assert.equal(x.run('MARCA'),'fish');assert.equal(x.run('CANAL'),'whatsapp');assert.equal(x.run('SEC'),'regua');
 assert.equal(x.document.querySelector('#presets button.ativo').dataset.p,'30');
 assert.equal(x.document.querySelector('#control-templates').hidden,false);
 assert.equal(x.document.querySelector('#sel-flow').value,'carrinho');
 x.document.querySelector('[data-marca="aristo"]').click();
 const ultimo=x.hashes[x.hashes.length-1];
 assert.match(ultimo,/^#marca=aristo&canal=whatsapp&p=30&sec=regua&aba=templates/);
 assert.doesNotMatch(x.hashes.join(' '),/synthetic-test-key|k=/);
 // canal do filtro (segmento) vence a preferência salva quando o hash está presente
 const y=await boot(fixture(),{hash:'#canal=email'});
 assert.equal(y.run('CANAL'),'email');assert.equal(y.document.querySelectorAll('#area-kpis .kpi').length,4);
});
/* ---------- Entrega 2: rascunhos locais ---------- */
test('rascunhos: criar, salvar só no navegador, sobreviver ao refresh, exportar, importar e excluir — sem publicar/ativar',async()=>{
 const x=await boot();x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="drafts"]').click();
 const root=()=>x.document.querySelector('#control-drafts');
 assert.equal(root().hidden,false);assert.match(root().textContent,/Rascunhos salvos só neste dispositivo/);assert.match(root().textContent,/Nenhum rascunho neste dispositivo/);
 x.run('trocaMarca("fish")');root().querySelector('#drafts-novo').click();
 const set=(sel,v)=>{const el=root().querySelector(sel);el.value=v;el.dispatchEvent(new x.window.Event('input'));el.dispatchEvent(new x.window.Event('change'));};
 set('#d-nome','fish_rastreio_v3');set('#d-corpo','Olá {{1}}, seu pedido {{2}} saiu.');
 assert.equal(root().querySelectorAll('[data-exemplo]').length,2);
 set('[data-exemplo="1"]','Ana');set('[data-exemplo="2"]','#123');
 assert.match(root().querySelector('#d-preview').textContent,/Olá Ana, seu pedido #123 saiu\./);
 assert.match(root().querySelector('.draft-preview-head').textContent,/não é o template publicado/);
 root().querySelector('#d-botao-add').click();set('[data-botao-campo="tipo"]','url');set('[data-botao-campo="texto"]','Acompanhar');set('[data-botao-campo="valor"]','https://wa.me/5541');
 assert.match(root().querySelector('#d-checagens').textContent,/wa\.me/);
 set('[data-botao-campo="valor"]','https://fishermans.com.br/suporte');
 assert.match(root().querySelector('#d-checagens').textContent,/Checagens locais ok/);
 assert.equal([...root().querySelectorAll('button')].filter(b=>/publicar|submeter|ativar|enviar/i.test(b.textContent)).length,0);
 root().querySelector('#d-salvar').click();
 assert.match(root().textContent,/salvo neste dispositivo/);
 assert.equal(root().querySelectorAll('[data-draft]').length,1);
 assert.match(x.store.get('shrigma_growth_rascunhos'),/fish_rastreio_v3/);
 assert.equal(x.requests.length,1); // nenhuma chamada nova à API por causa do rascunho
 await x.run('carregar()');
 assert.equal(root().querySelectorAll('[data-draft]').length,1);assert.equal(root().hidden,false);
 root().querySelector('[data-draft-export]').click();
 const exp=x.downloads[x.downloads.length-1];
 assert.equal(exp.nome,'rascunho-whatsapp-fish-fish_rastreio_v3.json');
 assert.match(exp.texto,/"tipo": "shrigma-growth-rascunho"/);assert.doesNotMatch(exp.texto,/synthetic-test-key|shrigma_k/);
 x.run(`GRU.importaTexto(${JSON.stringify(exp.texto.replace('fish_rastreio_v3','fish_rastreio_v4'))})`);
 assert.equal(root().querySelector('#d-nome').value,'fish_rastreio_v4');assert.match(root().textContent,/importado como novo rascunho/);
 root().querySelector('#d-salvar').click();assert.equal(root().querySelectorAll('[data-draft]').length,2);
 root().querySelector('[data-draft-delete]').click(); // confirm() do teste devolve false → nada apaga
 assert.equal(root().querySelectorAll('[data-draft]').length,2);
 x.run('confirm=()=>true');root().querySelector('[data-draft-delete]').click();
 assert.equal(root().querySelectorAll('[data-draft]').length,1);
});
test('rascunho com nome igual a template do catálogo é avisado sem ser tratado como o template',async()=>{
 const p=fixture();p.crm_operacao=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
 const x=await boot(p);x.store.set('shrigma_growth_rascunhos',JSON.stringify([{id:'r1',canal:'whatsapp',marca:'fish',nome:'fish_confirmacao_exemplo',corpo:'Oi.',botoes:[],exemplos:{},atualizado_em:'2026-09-08T01:00:00Z'}]));
 x.run('GRU.render({api:API})');
 const card=x.document.querySelector('[data-draft="r1"]');
 assert.match(card.textContent,/Existe um template com este nome no catálogo da Meta \(status APPROVED/);
 assert.match(card.textContent,/não traz o corpo dele para comparar/);
 assert.equal(card.querySelectorAll('.control-verified').length,0);
});
test('hash aba=drafts abre a aba de rascunhos',async()=>{
 const x=await boot(fixture(),{hash:'#sec=regua&aba=drafts'});
 assert.equal(x.document.querySelector('#control-drafts').hidden,false);
});
/* ---------- R2 (10/09/2026): crm_fontes e saúde dos fluxos ---------- */
test('faixa de fontes (F02): tabela explícita de estados — erro sinaliza falha e guarda o último sucesso, status ausente não herda ok, evento é neutro, linha inválida é contada',async()=>{
 const p=fixture();
 p.crm_fontes=[{fonte:'shopify_conversao',rotulo:'Venda (Shopify)',tipo:'coleta',coletado_em:'2026-09-07T22:00:00Z',cadencia_seg:86400,status:'ok'},
  {fonte:'listmonk_snapshot',rotulo:'E-mail (Listmonk)',tipo:'coleta',coletado_em:'2026-09-07T20:00:00Z',cadencia_seg:1800,status:'atrasado'},
  {fonte:'wa_status_meta',rotulo:'Status WhatsApp (Meta)',tipo:'evento',coletado_em:'2026-09-08T01:00:00Z',cadencia_seg:null,status:'evento'},
  {fonte:'inventario_operacao',rotulo:'Inventario',tipo:'coleta',coletado_em:null,cadencia_seg:300,status:null},
  {fonte:'wa_saude',rotulo:'Saúde canal',tipo:'coleta',coletado_em:'2026-09-07T23:00:00Z',cadencia_seg:3600,status:'error',erro:'timeout'}, // F02: erro com hora antiga
  {fonte:'wa_fluxo_saude',rotulo:'Saúde fluxos',tipo:'coleta',coletado_em:'2026-09-08T00:00:00Z',cadencia_seg:3600,status:'weird'},         // status fora da tabela
  null,'texto'];                                                                                                                             // F06
 const x=await boot(p);
 const f=[...x.document.querySelectorAll('#fontes .fonte')];
 assert.deepEqual(f.map(n=>n.querySelector('b').textContent),['Consulta','Venda','E-mail','WhatsApp','Inventário','Saúde canal','Saúde fluxos','Fontes']);
 assert.deepEqual(f.map(n=>n.dataset.estado),['ok','ok','velho','evento','falta','ruim','desconhecido','desconhecido']);
 assert.match(f[2].title,/marcou esta coleta como atrasada \(cadência declarada 30 min\)/);assert.doesNotMatch(f[2].title,/2×/);
 assert.match(f[3].textContent,/último evento/);assert.match(f[3].title,/não indica saúde; silêncio não é falha/i);
 assert.match(f[4].textContent,/sem dado/);
 assert.match(f[5].textContent,/falhou · último sucesso/);assert.match(f[5].title,/FALHOU \(timeout\)\. A hora exibida é do último sucesso/);
 assert.match(f[6].textContent,/status não informado/);assert.match(f[6].title,/recebido: weird/);
 assert.match(f[7].textContent,/2 registro\(s\) inválido\(s\) ignorado\(s\)/);
 const y=await boot({...fixture(),crm_fontes:[{fonte:'shopify_conversao',tipo:'coleta',coletado_em:'2026-09-07T22:00:00Z'}]}); // sem status: não é ok
 assert.equal(y.document.querySelector('#fontes .fonte:nth-child(2)').dataset.estado,'desconhecido');
});
test('saúde dos fluxos (F07/F06): chips são botões com detalhe visível por clique/teclado, alerta destacado, estado desconhecido não vira "sem ocorrência", linha inválida contada, filtro por marca, ausência não vira saúde',async()=>{
 const p=fixture();
 p.wa_fluxo_saude=[{chave:'aceite:aristo',brand:'aristo',nome:'Aceite → status Meta · aristo',verificado_em:'2026-09-08T01:00:00Z',n_aceites:40,n_status:0,estado:'alerta',motivo:'40 aceites sem status',alerta_desde:'2026-09-07T23:00:00Z'},
  {chave:'gatilho:fish:pedido-pago',brand:'fish',nome:'Gatilho → WhatsApp · fish · pedido-pago',verificado_em:'2026-09-08T01:00:00Z',n_gatilho:12,n_saida:12,estado:'ok',motivo:null},
  {chave:'x:fish',brand:'fish',nome:'Sem estado',verificado_em:null,estado:null,motivo:null},null,42];
 const x=await boot(p);
 let chips=[...x.document.querySelectorAll('#fluxo-saude .fluxo-chip')];
 assert.equal(chips.length,4);assert.equal(chips[0].tagName,'BUTTON');assert.equal(chips[0].dataset.estado,'alerta');assert.match(chips[0].textContent,/· alerta$/);assert.equal(chips[0].getAttribute('aria-expanded'),'false');
 const det=()=>x.document.getElementById(chips[0].getAttribute('aria-controls'));
 assert.equal(det().hidden,true);chips[0].click();assert.equal(det().hidden,false);assert.equal(chips[0].getAttribute('aria-expanded'),'true');
 assert.match(det().textContent,/40 aceites sem status · verificado 22:00 · em alerta desde 20:00/);
 chips[1].click();assert.match(x.document.getElementById(chips[1].getAttribute('aria-controls')).textContent,/Sem ocorrência na última verificação/);
 assert.equal(chips[2].dataset.estado,'desconhecido');assert.match(chips[2].textContent,/estado \?/);chips[2].click();assert.match(x.document.getElementById(chips[2].getAttribute('aria-controls')).textContent,/Estado não informado pela verificação · verificado —/);
 assert.match(chips[3].textContent,/2 registro\(s\) inválido\(s\)/);
 await x.run('carregar()'); // redesenho preserva o detalhe aberto
 chips=[...x.document.querySelectorAll('#fluxo-saude .fluxo-chip')];assert.equal(chips[0].getAttribute('aria-expanded'),'true');assert.equal(x.document.getElementById(chips[0].getAttribute('aria-controls')).hidden,false);
 x.document.querySelector('[data-marca="fish"]').click();
 chips=[...x.document.querySelectorAll('#fluxo-saude .fluxo-chip')];assert.equal(chips.filter(c=>c.tagName==='BUTTON').length,2);assert.equal(chips[0].dataset.estado,'ok');
 const y=await boot(fixture());
 assert.equal(y.document.querySelector('#fluxo-saude').innerHTML,'');
});
/* ---------- R3 (10/09/2026): mapped_in + crm_wa_template ---------- */
test('templates (F01/F03/F04/F05/F06): vínculo diz se o modo é configurado ou só o último observado; métrica desconhecida vira "—", nunca zero; teste-motor fora da soma; CSV exporta o que a tela mostra; linha inválida não derruba a tela',async()=>{
 const p=fixture();p.crm_operacao=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
 const t=p.crm_operacao.templates,w=p.crm_operacao.workflows;
 t[0].mapped_in=[{workflow_key:'fish_tx',piece:'pedido-pago',mode_key:'modo_pedido_pago'}];   // fish_tx: consulta atual, modo real
 t[1].mapped_in=[{workflow_key:'aristo_tx',piece:'pedido-pago',mode_key:'modo_pedido_pago'},null,{piece:'x'}]; // F06: vínculos malformados
 t[2].mapped_in=[];
 w.find(x=>x.key==='aristo_tx').collection_status='error';w.find(x=>x.key==='aristo_tx').collection_error_code='timeout'; // F03: modo preservado de leitura antiga
 p.crm_wa_template=[{dia:'2026-09-06',marca:'fish',flow:'transacional',piece:'pedido-pago',template_ref:t[0].id,registros:10,aceitos:9,entregues:7,lidos:3,falhas:1,sem_disparo_confirmado:1},
  {dia:'2026-09-07',marca:'fish',flow:'transacional',piece:'pedido-pago',template_ref:t[0].id,registros:5,aceitos:5,entregues:4,lidos:1,falhas:0,sem_disparo_confirmado:0},
  {dia:'2026-09-07',marca:'fish',flow:'teste-motor',piece:'teste',template_ref:t[0].id,registros:7,aceitos:7,entregues:7,lidos:7,falhas:0,sem_disparo_confirmado:0}, // F04: fora da soma
  {dia:'2026-08-01',marca:'fish',flow:'transacional',piece:'pedido-pago',template_ref:t[0].id,registros:99,aceitos:99,entregues:99,lidos:0,falhas:0,sem_disparo_confirmado:0},  // fora do período
  {dia:'2026-09-07',marca:'aristo',flow:'transacional',piece:'pedido-pago',template_ref:t[1].id,registros:3,aceitos:null,entregues:2,lidos:0,falhas:0}, // F01: aceitos desconhecido
  null,'lixo']; // F06
 const x=await boot(p);x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="templates"]').click();
 const row=k=>x.document.querySelector(`[data-control-template="${k}"]`);
 const fishLinks=[...row('fish_paid').querySelectorAll('.control-template-link')];
 assert.equal(fishLinks.length,1);assert.equal(fishLinks[0].textContent,'Pedido pago e rastreio Fishermans · pedido-pago · modo configurado: real');assert.equal(fishLinks[0].dataset.tone,'verified');
 const ariLinks=[...row('aristo_paid').querySelectorAll('.control-template-link')];
 assert.equal(ariLinks.length,2);assert.match(ariLinks[0].textContent,/^Pedido pago e rastreio Aristocrata · pedido-pago · último modo observado: sombra · consulta com falha \(0[78]\/09\/2026, \d\d:\d\d\)$/);assert.equal(ariLinks[0].dataset.tone,'warning');
 assert.match(ariLinks[1].textContent,/2 vínculo\(s\) em formato inválido ignorado\(s\)/);
 const met=k=>row(k).querySelector('.control-template-metrics');
 assert.equal(met('fish_paid').tagName,'DETAILS');assert.equal(met('fish_paid').querySelector('summary').textContent,'15 registros · 14 aceitos · 11 entregues · 1 falhas · cobertura não declarada'); // 01–07/09, sem agosto, sem teste-motor
 assert.match(met('fish_paid').querySelector('p').textContent,/1 linha\(s\) de teste fora da soma/);assert.match(met('fish_paid').querySelector('p').textContent,/2 linha\(s\) da coleção em formato inválido/);
 assert.equal(met('aristo_paid').querySelector('summary').textContent,'3 registros · — aceitos · 2 entregues · cobertura não declarada · parte não medida'); // F01: null não vira 0
 assert.equal(row('fish_native').querySelector('.control-template-link'),null);
 assert.equal(met('fish_native').querySelector('summary').textContent,'Sem linha no período · cobertura não declarada'); // F01: vazio sem cobertura não é zero
 x.document.querySelector('#control-tpl-export').click();
 const csv=x.downloads[0].texto,cab=csv.split('\r\n')[0];assert.match(cab,/Vinculado a;Aceitos no período;Entregues no período;Cobertura das métricas/);
 assert.match(csv,/;Pedido pago e rastreio Fishermans · pedido-pago · modo configurado: real;14;11;não declarada;/); // F05: CSV = tela
 assert.doesNotMatch(csv,/fish_tx:pedido-pago/);
 assert.match(csv,/último modo observado: sombra · consulta com falha[^;]*;;2;não declarada;/); // F01: aceitos desconhecido = célula vazia
 assert.match(csv,/fish_card_exemplo;[^\r\n]*;;;não declarada;/); // vazio sem cobertura: célula vazia, não 0
 // com cobertura declarada, vazio no período coberto é zero legítimo
 p.crm_wa_template_cobertura={inicio:'2026-06-10',fim:'2026-09-07'};const z=await boot(p);z.document.querySelector('[data-s="regua"]').click();z.document.querySelector('[data-control-tab="templates"]').click();
 assert.equal(z.document.querySelector('[data-control-template="fish_native"] .control-template-metrics summary').textContent,'Sem registro no período (0)');
 z.document.querySelector('#control-tpl-export').click();assert.match(z.downloads[0].texto,/fish_card_exemplo;[^\r\n]*;0;0;declarada 2026-06-10 a 2026-09-07;/);
 const y=await boot(fixture());y.document.querySelector('[data-s="regua"]').click();y.document.querySelector('[data-control-tab="templates"]').click();
 assert.equal(y.document.querySelectorAll('.control-template-metrics').length,0); // sem crm_wa_template na resposta, sem coluna inventada
});
/* ---------- Fase A (11/09/2026): templates ponta a ponta atrás de capabilities ---------- */
const CONTRATO=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-templates-contract.synthetic.json'),'utf8'));
const TPL_END='https://exemplo.invalid/webhook/crm-template-api-x';
async function deadline(promise,label,diagnose,timeoutMs=10000){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{let state='';try{state=diagnose?.()||'';}catch(_){state='Diagnostic unavailable';}reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}. ${state}`));},timeoutMs);})]);}
 finally{clearTimeout(timer);}
}
async function clickAction(x,element,action){
 assert.ok(element,`Missing button for ${action}`);const before=x.uiActions.length;element.click();
 const invoked=x.uiActions.slice(before).find(entry=>entry.name===action);
 assert.ok(invoked&&typeof invoked.promise?.then==='function',`Click did not invoke async ${action}`);
 await deadline(invoked.promise,action,()=>x.run('JSON.stringify({ocupado:GRU.state.ocupado,operacoes:GRU.journal()?.inspect().operations.map(x=>({phase:x.phase,applied:x.applied}))})'));
}
async function waitFor(condition,label,timeoutMs=10000){
 const started=Date.now();while(!condition()){
   if(Date.now()-started>=timeoutMs)throw Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
   await new Promise(resolve=>setTimeout(resolve,5));
 }
}
// The synthetic operation store uses the real read-only receipt projection.
// Lost POST responses can be reconciled by GET; GET never consumes a mutation response.
function apiFalsa(){
 const filas={},pedidos=[],operations=new Map(),actor='chave-felipe',claimId='30000000-0000-4000-8000-000000000001';
 const json=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>structuredClone(body)});
 const confirma=(request,status,raw)=>{
   const p={acao:request.acao,rascunho:request.rascunho??null,draft_id:request.draft_id??null,expected_version:request.expected_version??null,confirm:request.confirm??null};
   const body={...structuredClone(raw),who:actor};
   if(request.acao==='validar'){body.draft_id=request.draft_id;body.version=request.expected_version;}
   if(request.acao==='submeter'){body.draft_id=request.draft_id;body.operation_id=claimId;body.submission_id='s_'+claimId.replace(/-/g,'');}
   const row={receipts:[{idempotency_key:request.idempotency_key,acao:request.acao,actor,request_payload:p,response:{status,body}}],claims:[]};
   if(request.acao==='submeter')row.claims.push({claim_id:claimId,idempotency_key:request.idempotency_key,acao:'submeter',actor,request_payload:p,draft_id:request.draft_id,version:request.expected_version,state:status<300?'succeeded':'rejected',response:{_http:status,_body:body}});
   operations.set(request.idempotency_key,row);return body;
 };
 return {pedidos,confirma,responde(acao,status,body){(filas[acao]=filas[acao]||[]).push({status,body});},
  mock:async(url,init)=>{if(!url.startsWith(TPL_END))return null;const params=new URL(url).searchParams,request=init?.body?JSON.parse(init.body):null,acao=init?.method==='POST'?request.acao:params.get('acao');
   pedidos.push({acao,url,body:request,headers:init?.headers||{},init});
   const r=(filas[acao]||[]).shift();
   if(acao==='operacao')return r?json(r.status,r.body):json(200,Receipt.operationReceipt({operation_key:params.get('idempotency_key'),operation_action:params.get('operacao'),who:actor},operations.get(params.get('idempotency_key'))||{receipts:[],claims:[]}));
   if(!r)return json(500,{erro:'fila vazia'});
   if(request&&(r.status>=200&&r.status<300||acao==='validar'&&r.status===422))return json(r.status,confirma(request,r.status,r.body));
   return json(r.status,r.body);
  }};
}
const comCaps=(templates)=>{const p=fixture();p.crm_operacao=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));p.capabilities={...CONTRATO.capabilities,templates:{...CONTRATO.capabilities.templates,...templates},endpoints:{templates:TPL_END}};return p;};

test('the UI harness waits for the action promise while native crypto is still pending, with a useful deadline',async()=>{
 const api=apiFalsa();let release,entered,finished=false;
 const barrier=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const cryptoProvider={randomUUID:()=>webcrypto.randomUUID(),subtle:{digest:async(...args)=>{entered();await barrier;return webcrypto.subtle.digest(...args);}}};
 const x=await boot(comCaps({submit:true}),{fetchMock:api.mock,cryptoProvider});x.store.set('shrigma_tpl_key','ESCRITA-TESTE');
 x.run("trocaMarca('fish');GRU.state.rascunho=GR.novo({id:'delayed-worker-template',nome:'fixture_template',corpo:'Conteúdo sintético.'});GRU.state.editando=GRU.state.rascunho.id;GRU.render()");
 api.responde('rascunho',201,{draft_id:'d_delayed',version:1,estado:'rascunho'});
 const pending=clickAction(x,x.document.querySelector('#d-servidor'),'salvarServidor');pending.then(()=>{finished=true;},()=>{});
 try{
  await deadline(started,'synthetic crypto barrier');assert.equal(finished,false);assert.equal(api.pedidos.some(p=>p.body),false);assert.equal(x.run('GRU.state.ocupado'),'rascunho');
 }finally{release();}
 await pending;assert.equal(finished,true);assert.equal(api.pedidos.filter(p=>p.body).length,1);assert.equal(x.run('GRU.journal().inspect().operations[0].applied'),true);
 await assert.rejects(deadline(new Promise(()=>{}),'synthetic hung action',()=>'{"ocupado":"rascunho"}',5),/Timed out after 5ms waiting for synthetic hung action.*ocupado/);
});

test('sem capabilities nada muda: nenhum botão de servidor, rascunho segue só neste dispositivo',async()=>{
 const x=await boot();x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="drafts"]').click();
 const root=x.document.querySelector('#control-drafts');root.querySelector('#drafts-novo').click();
 assert.match(root.textContent,/Rascunhos salvos só neste dispositivo/);
 assert.equal([...root.querySelectorAll('button')].filter(b=>/servidor|validar|submeter|publicar|ativar/i.test(b.textContent)).length,0);
 assert.equal(root.querySelector('#drafts-filtro'),null);assert.equal(root.querySelector('.draft-steps'),null);
 const y=await boot({...fixture(),capabilities:CONTRATO.capabilities}); // declaradas, mas sem endpoint
 y.document.querySelector('[data-s="regua"]').click();y.document.querySelector('[data-control-tab="drafts"]').click();
 const ry=y.document.querySelector('#control-drafts');ry.querySelector('#drafts-novo').click();
 assert.match(ry.textContent,/não informou o endereço da API de templates/);assert.equal(ry.querySelector('#d-servidor'),null);
});
test('ciclo completo: salvar no servidor → alterar bloqueia → validar (422 e depois ok) → submeter com palavra digitada → acompanhar até publicado · não ativo',async()=>{
 const api=apiFalsa();
 const x=await boot(comCaps({submit:true}),{fetchMock:api.mock});x.store.set('shrigma_tpl_key','ESCRITA-TESTE');x.run('GRU.render()');
 x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="drafts"]').click();
 const root=()=>x.document.querySelector('#control-drafts');
 assert.match(root().textContent,/com envio ao servidor/);assert.match(root().textContent,/Chave de escrita: informada/);
 x.run('trocaMarca("fish")');root().querySelector('#drafts-novo').click();
 const set=(sel,v)=>{const el=root().querySelector(sel);el.value=v;el.dispatchEvent(new x.window.Event('input'));el.dispatchEvent(new x.window.Event('change'));};
 set('#d-nome','fish_rastreio_v3');set('#d-corpo','Olá {{1}}, seu pedido {{2}} saiu.');set('[data-exemplo="1"]','Ana');set('[data-exemplo="2"]','#123');
 x.run("GRU.state.rascunho.botoes=[{tipo:'url',texto:'Acompanhar pedido',valor:'https://conta.fishermans.com.br/'}];GRU.render()");
 assert.equal(root().querySelector('#d-validar'),null);assert.equal(root().querySelector('#d-submeter'),null); // nada no servidor ainda
 // 1) salvar no servidor
 api.responde('rascunho',201,CONTRATO.rascunho_response);
 await clickAction(x,root().querySelector('#d-servidor'),'salvarServidor');
 const p1=api.pedidos.find(p=>p.acao==='rascunho');assert.equal(p1.body.k,'ESCRITA-TESTE');assert.equal(p1.body.draft_id,undefined);
 assert.match(p1.body.idempotency_key,/^[0-9a-f-]{36}$/);assert.equal(p1.headers['Idempotency-Key'],p1.body.idempotency_key);
 assert.deepEqual(Object.keys(p1.body.rascunho).sort(),['assunto','botoes','cabecalho','canal','categoria','corpo','exemplos','idioma','marca','nome','peca','rodape']);
 assert.equal(p1.body.rascunho.corpo,'Olá {{1}}, seu pedido {{2}} saiu.');
 assert.match(root().textContent,/salvo no servidor como v1/);assert.match(root().querySelector('.draft-card .control-badge').textContent,/Rascunho no servidor · não submetido/);
 assert.equal(root().querySelector('.draft-steps [data-st="atual"]').dataset.passo,'rascunho');
 assert.ok(root().querySelector('#d-validar'));assert.equal(root().querySelector('#d-submeter'),null); // valida antes de submeter
 assert.match(x.store.get('shrigma_growth_rascunhos'),/d_01J0000000000000000000EX/);assert.doesNotMatch(x.store.get('shrigma_growth_rascunhos'),/ESCRITA-TESTE/);
 // 2) alterar conteúdo bloqueia validar; voltar ao conteúdo salvo libera
 set('#d-corpo','Olá {{1}}, seu pedido {{2}} saiu!');
 assert.match(root().querySelector('#draft-editor .control-badge').textContent,/Alterado após salvar no servidor \(v1\)/);assert.equal(root().querySelector('#d-validar'),null);
 set('#d-corpo','Olá {{1}}, seu pedido {{2}} saiu.');assert.ok(root().querySelector('#d-validar'));
 // 3) validar: primeiro a API recusa (422), depois aceita
 api.responde('validar',422,CONTRATO.validar_422);
 await clickAction(x,root().querySelector('#d-validar'),'validarServidor');
 assert.match(root().querySelector('#d-checagens').textContent,/API: Corpo com 1025 caracteres; limite 1024\. \(corpo\)/);assert.match(root().textContent,/recusada com recibo/);
 assert.equal(root().querySelector('#d-submeter'),null);assert.equal(root().querySelector('.draft-steps [data-st="atual"]').dataset.passo,'rascunho');
 api.responde('validar',200,{...CONTRATO.validar_ok,avisos:[{codigo:'UTILITY_OFFER_WORDING',mensagem:'Tom promocional.'}]});
 await clickAction(x,root().querySelector('#d-validar'),'validarServidor');
 assert.match(root().textContent,/Validado pela API com 1 aviso/);assert.ok(root().querySelector('#d-submeter'));assert.equal(root().querySelector('.draft-steps [data-st="atual"]').dataset.passo,'validado');
 // 4) submeter: confirmação textual obrigatória
 root().querySelector('#d-submeter').click();
 const conf=()=>root().querySelector('#d-confirmar');assert.ok(conf());assert.match(conf().textContent,/Submeter à Meta o rascunho v1/);assert.match(conf().textContent,/Tom promocional/);assert.match(conf().textContent,/vira "publicado · não ativo"\. Nenhum workflow muda/);
 assert.equal(conf().querySelector('#d-confirm-ok').disabled,true);
 set('#d-confirm-texto','errado');assert.equal(conf().querySelector('#d-confirm-ok').disabled,true);
 set('#d-confirm-texto',' Submeter ');assert.equal(conf().querySelector('#d-confirm-ok').disabled,false);
 api.responde('submeter',202,CONTRATO.submeter_202);
 await clickAction(x,conf().querySelector('#d-confirm-ok'),'submeter');
 const ps=api.pedidos.find(p=>p.acao==='submeter');assert.equal(ps.body.confirm,'submeter');assert.equal(ps.body.expected_version,1);assert.equal(ps.body.draft_id,'d_01J0000000000000000000EX');
 assert.equal(conf(),null);assert.match(root().querySelector('#draft-editor .control-badge').textContent,/Submetido · aguardando Meta desde 09\/09, 17:01/);
 assert.ok(root().querySelector('#d-verificar'));assert.ok(root().querySelector('#drafts-verificar'));
 assert.equal([...root().querySelectorAll('button')].filter(b=>/publicar|ativar/i.test(b.textContent)).length,0);
 // 5) acompanhar: PENDING não muda nada; APPROVED vira publicado · não ativo (nunca "aprovado" antes da API dizer)
 api.responde('submissao',200,CONTRATO.submissao_get);
 await clickAction(x,root().querySelector('#d-verificar'),'verificarSubmissao');
 assert.match(root().textContent,/Ainda aguardando \(PENDING\)/);assert.match(root().querySelector('#draft-editor .control-badge').textContent,/Submetido/);
 assert.match(api.pedidos.find(p=>p.acao==='submissao').url,/submission_id=s_30000000000040008000000000000001/);
 api.responde('submissao',200,{estado:'submetido',provider_status:'PAUSED',rejected_reason:null,checked_at:'2026-09-09T20:20:00Z'}); // C03: status fora do trio não vira aprovação
 await clickAction(x,root().querySelector('#d-verificar'),'verificarSubmissao');
 assert.match(root().textContent,/Provedor devolveu "PAUSED": não é aprovação nem rejeição/);assert.equal(root().querySelector('.draft-card').dataset.estado,'submetido');
 api.responde('submissao',200,{estado:'publicado',provider_status:'APPROVED',rejected_reason:null,checked_at:'2026-09-09T20:30:00Z'});
 await clickAction(x,root().querySelector('#d-verificar'),'verificarSubmissao');
 assert.match(root().textContent,/Publicado pelo provedor \(APPROVED\)\. Publicado não é ativo: nenhum workflow mudou/);
 assert.equal(root().querySelector('.draft-card').dataset.estado,'publicado');assert.match(root().querySelector('.draft-card .control-badge').textContent,/^Publicado · não ativo \(sem workflow mapeado\)$/);
 assert.equal(root().querySelector('.draft-steps [data-st="atual"]').dataset.passo,'publicado');assert.equal(root().querySelector('#d-verificar'),null);
 // histórico com who/when de cada passo
 const hist=root().querySelector('.draft-historico').textContent;
 for(const t of ['rascunho','validar','submit','publicado','chave-felipe','provedor via API'])assert.match(hist,new RegExp(t));
 // nenhuma URL ou corpo levou a chave de leitura para a API de templates fora do parâmetro k do GET, e a de escrita nunca foi para URL
 assert.ok(api.pedidos.every(p=>!p.url.includes('ESCRITA-TESTE')));
 assert.equal(api.pedidos.filter(p=>p.body).every(p=>p.body.k==='ESCRITA-TESTE'),true);
 // filtro por estado
 set('#drafts-filtro','submetido');assert.match(root().textContent,/Nenhum rascunho neste estado/);set('#drafts-filtro','publicado');assert.equal(root().querySelectorAll('[data-draft]').length,1);
});
test('409/502 without a durable receipt stay frozen; a later exact GET recovers without POST replay',async()=>{
 for(const status of [409,502]){
  const api=apiFalsa(),x=await boot(comCaps({submit:true}),{fetchMock:api.mock});x.store.set('shrigma_tpl_key','ESCRITA-TESTE');
  x.run("GR.guarda(GR.novo({id:'pending-template',nome:'fixture_template',corpo:'Conteúdo sintético.'}));GRU.render()");
  x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="drafts"]').click();
  const root=()=>x.document.querySelector('#control-drafts');root().querySelector('[data-draft-edit]').click();
  api.responde('rascunho',status,CONTRATO.erros[String(status)]);await clickAction(x,root().querySelector('#d-servidor'),'salvarServidor');
  assert.match(root().textContent,/Operação sem confirmação/);const sent=api.pedidos.find(p=>p.acao==='rascunho');assert.ok(sent);
  assert.equal(x.run('GRU.state.rascunho.servidor?.draft_id'),undefined);
  await x.run('GRU.salvarServidor(GRU.state.rascunho)');
  assert.equal(api.pedidos.filter(p=>p.acao==='rascunho').length,1,'uncertain attempts never replay POST');
  await clickAction(x,root().querySelector('[data-template-operacao]'),'consultarOperacao');
  assert.equal(api.pedidos.filter(p=>p.acao==='rascunho').length,1);assert.match(root().textContent,/Operação sem confirmação/);
  if(status===502){
   api.confirma(sent.body,201,{draft_id:'d_recovered',version:1,estado:'rascunho',salvo_em:'2026-09-11T12:00:00Z'});
   await clickAction(x,root().querySelector('[data-template-operacao]'),'consultarOperacao');
   assert.equal(x.run('GRU.state.rascunho.servidor.draft_id'),'d_recovered');assert.match(root().textContent,/salvo no servidor como v1/);
   assert.equal(api.pedidos.filter(p=>p.acao==='rascunho').length,1);assert.equal(x.run('GRU.journal().inspect().blocked'),false);
  }
  for(const call of api.pedidos.filter(p=>p.acao==='operacao')){assert.equal(call.headers['X-Template-Key'],'ESCRITA-TESTE');assert.ok(!call.url.includes('ESCRITA-TESTE'));}
 }
});
test('opening an older confirmed template receipt never lowers the current revision or replays a POST',async()=>{
 const api=apiFalsa(),x=await boot(comCaps({submit:true}),{fetchMock:api.mock});x.store.set('shrigma_tpl_key','ESCRITA-TESTE');
 x.run("trocaMarca('fish');GRU.state.rascunho=GR.novo({id:'versioned-template',nome:'fixture_template',corpo:'Primeira versão sintética.'});GRU.state.editando=GRU.state.rascunho.id;GRU.render()");
 api.responde('rascunho',201,{draft_id:'d_versioned',version:1,estado:'rascunho'});await x.run('GRU.salvarServidor(GRU.state.rascunho)');
 const firstId=x.run('GRU.journal().inspect().operations[0].id');
 x.run('GRU.state.rascunho.corpo="Segunda versão sintética."');api.responde('rascunho',200,{draft_id:'d_versioned',version:2,estado:'rascunho'});await x.run('GRU.salvarServidor(GRU.state.rascunho)');
 const before=x.run('JSON.stringify(GR.lista()[0])'),posts=api.pedidos.filter(p=>p.body).length;
 await x.run(`GRU.consultarOperacao(${JSON.stringify(firstId)})`);
 assert.equal(x.run('GRU.state.rascunho.servidor.version'),2);assert.equal(x.run('JSON.stringify(GR.lista()[0])'),before);assert.equal(api.pedidos.filter(p=>p.body).length,posts);
 assert.equal(x.run('GRU.journal().inspect().operations.every(op=>op.applied===true)'),true);
});
test('editing during a pending save keeps the new text local and dirty after the frozen original receipt arrives',async()=>{
 const api=apiFalsa();let release,entered;
 const reached=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 const x=await boot(comCaps({submit:true}),{fetchMock:async(url,init)=>{if(url.startsWith(TPL_END)&&init?.method==='POST'){entered();await barrier;}return api.mock(url,init);}});x.store.set('shrigma_tpl_key','ESCRITA-TESTE');
 x.run("trocaMarca('fish');GRU.state.rascunho=GR.novo({id:'edited-template',nome:'fixture_template',corpo:'Texto enviado sintético.'});GRU.state.editando=GRU.state.rascunho.id;GRU.render()");
 api.responde('rascunho',201,{draft_id:'d_edited',version:1,estado:'rascunho'});const pending=x.run('GRU.salvarServidor(GRU.state.rascunho)');await reached;
 x.run('GRU.state.rascunho.corpo="Nova edição local durante a espera."');release();await pending;
 assert.equal(api.pedidos.find(p=>p.body).body.rascunho.corpo,'Texto enviado sintético.');assert.equal(x.run('GR.lista()[0].corpo'),'Nova edição local durante a espera.');
 assert.equal(x.run('GTA.situacao(GR.lista()[0]).sujo'),true);assert.equal(x.run('GRU.journal().inspect().operations[0].applied'),true);
 assert.equal(x.document.querySelector('#d-validar'),null);
});
test('unauthorized operation preflight performs no POST and creates no local reservation',async()=>{
 const api=apiFalsa(),x=await boot(comCaps({submit:true}),{fetchMock:api.mock});x.store.set('shrigma_tpl_key','ESCRITA-TESTE');
 x.run("GR.guarda(GR.novo({id:'unauthorized-template',nome:'fixture_template',corpo:'Conteúdo sintético.'}));GRU.render()");
 x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="drafts"]').click();x.document.querySelector('[data-draft-edit]').click();
 api.responde('operacao',401,{erro:'invalid_key'});await clickAction(x,x.document.querySelector('#d-servidor'),'salvarServidor');
 assert.equal(api.pedidos.some(p=>p.body),false);assert.equal(x.run('GRU.journal().inspect().operations.length'),0);
 assert.match(x.document.querySelector('#control-drafts').textContent,/Nada foi enviado/);
});
test('aba Templates: publicado ≠ ativo pelo manifesto; conteúdo publicado só com read_content e ao pedir; histórico com who/when',async()=>{
 const api=apiFalsa();
 const p=comCaps({});const t=p.crm_operacao.templates;
 t[0].mapped_in=[{workflow_key:'fish_tx',piece:'pedido-pago',mode_key:'modo_pedido_pago'}];   // fish_tx ativo, modo real
 t[1].mapped_in=[{workflow_key:'aristo_tx',piece:'pedido-pago',mode_key:'modo_pedido_pago'}]; // aristo_tx em sombra
 t[2].mapped_in=[];
 const x=await boot(p,{fetchMock:api.mock});x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="templates"]').click();
 const row=k=>x.document.querySelector(`[data-control-template="${k}"]`);
 assert.match(row('fish_paid').querySelector('.control-template-pub').textContent,/Publicado · ativo em modo real \(fish_tx\)/);
 assert.match(row('aristo_paid').querySelector('.control-template-pub').textContent,/Publicado · não ativo \(nenhum workflow em modo real\)/);
 assert.match(row('fish_native').querySelector('.control-template-pub').textContent,/Publicado · não ativo \(sem workflow mapeado\)/);
 assert.equal(x.document.querySelectorAll('.control-template-preview').length,0); // nada carregado sem pedir
 api.responde('listar',200,{api_version:'2026-09-1',templates:[{...CONTRATO.listar.templates[0],key:'fish_paid',name:'fish_confirmacao_exemplo',brand:'fish'}]});
 x.document.querySelector('#control-tpl-conteudo').click();await waitFor(()=>row('fish_paid').querySelector('.control-template-preview'),'published template preview');
 assert.match(api.pedidos[0].url,/\?acao=listar$/);assert.equal(api.pedidos[0].headers.Authorization,'Bearer synthetic-test-key'); // leitura: chave de leitura do painel, sem marca no recorte "todas"
 const prev=row('fish_paid').querySelector('.control-template-preview');assert.ok(prev);assert.match(prev.querySelector('summary').textContent,/Prévia publicada · v3 · 07\/09\/2026/);
 assert.match(prev.textContent,/Olá Ana, o pedido #48213 está a caminho/);assert.match(prev.textContent,/↗ Acompanhar pedido/);
 assert.match(row('aristo_paid').textContent,/Conteúdo publicado não veio na resposta da API/);
 api.responde('historico',200,CONTRATO.historico);prev.querySelector('[data-tpl-historico]').click();await waitFor(()=>row('fish_paid').querySelector('.control-template-hist')?.textContent.includes('chave-exemplo'),'template history receipt');
 assert.match(api.pedidos[1].url,/acao=historico&key=fish_paid$/);
 assert.match(row('fish_paid').querySelector('.control-template-hist').textContent,/chave-exemplo · submit v2→v3 · ok/);
 const y=await boot(comCaps({read_content:false}));y.document.querySelector('[data-s="regua"]').click();y.document.querySelector('[data-control-tab="templates"]').click();
 assert.equal(y.document.querySelector('#control-tpl-conteudo'),null);
 const csv=x.document.querySelector('#control-tpl-export');csv.click();assert.match(x.downloads[x.downloads.length-1].texto,/Publicado \/ ativo/);
});
/* ---------- Fase C (11/09/2026): aba Fluxos · leitura ---------- */
test('aba Fluxos: sem crm_fluxo_def mostra só o observado, com gatilho "não declarado"; com definição mostra etapas em ordem; busca, origem, marca, CSV e hash; nenhum botão de edição',async()=>{
 const p=fixture();p.crm_operacao=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
 p.crm_operacao.templates[1].mapped_in=[{workflow_key:'aristo_tx',piece:'pedido-pago',mode_key:'modo_pedido_pago'}];
 const x=await boot(p);x.document.querySelector('[data-s="regua"]').click();x.document.querySelector('[data-control-tab="fluxos"]').click();
 const root=()=>x.document.querySelector('#control-fluxos');
 assert.equal(root().hidden,false);assert.match(root().textContent,/A API ainda não declara a definição dos fluxos/);
 let cards=[...root().querySelectorAll('.flow-card')];
 assert.deepEqual(cards.map(c=>c.dataset.flow),['aristo|transacional','fish|carrinho']);assert.ok(cards.every(c=>c.dataset.origem==='observado'));
 assert.match(cards[1].textContent,/Gatilho: não declarado pela API/);assert.match(cards[1].textContent,/ordem alfabética, não a sequência do fluxo/);
 assert.match(cards[0].querySelector('.flow-badges').textContent,/Modo sombra/); // aristo_tx em sombra na fixture, consulta atual
 assert.match(cards[0].textContent,/Pedido pago e rastreio Aristocrata · modo configurado: sombra/);assert.match(cards[0].textContent,/aristo_confirmacao_exemplo · APPROVED/);
 assert.match(cards[1].querySelector('.flow-badges').textContent,/Workflow não declarado no manifesto/);
 assert.match(cards[1].textContent,/E-mail · carrinho-30min/);assert.match(cards[1].textContent,/50 aceitos pela API/);assert.match(cards[1].textContent,/42 aceitos · 40 entregues/);
 assert.equal([...root().querySelectorAll('button')].filter(b=>/editar|publicar|ativar|salvar|criar|nova etapa/i.test(b.textContent)).length,0);
 x.document.querySelector('[data-marca="fish"]').click();cards=[...root().querySelectorAll('.flow-card')];assert.deepEqual(cards.map(c=>c.dataset.flow),['fish|carrinho']);
 x.document.querySelector('[data-marca="todas"]').click();
 // com definição declarada
 const DEF=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-fluxo-def.synthetic.json'),'utf8'));
 const y=await boot({...p,...DEF});y.document.querySelector('[data-s="regua"]').click();y.document.querySelector('[data-control-tab="fluxos"]').click();
 const ry=()=>y.document.querySelector('#control-fluxos');
 assert.match(ry().textContent,/Definição declarada pela API/);assert.match(ry().textContent,/2 definição\(ões\) de fluxo em formato inválido ignorada\(s\): quebrado/);
 cards=[...ry().querySelectorAll('.flow-card')];
 assert.deepEqual(cards.map(c=>c.dataset.flow+'/'+c.dataset.origem),['fish|carrinho/definido','aristo|pix-nao-pago/definido','aristo|transacional/observado']);
 const carrinho=cards[0];
 assert.match(carrinho.querySelector('.flow-trigger').textContent,/Gatilho: checkout_abandonado — Checkout criado sem pedido pago em 30 min/);assert.match(carrinho.querySelector('.flow-trigger').textContent,/chave do evento checkout_id · reentrada: só depois de terminar · sai ao ocorrer: pedido_pago, checkout_recuperado/);
 assert.deepEqual([...carrinho.querySelectorAll('.flow-step')].map(s=>s.dataset.tipo),['espera','mensagem','espera','condicao','mensagem','fim']);
 assert.deepEqual([...carrinho.querySelectorAll('.flow-step strong')].map(s=>s.textContent),['Espera 30 min','WhatsApp · carrinho-30min','Espera 1 dia(s)','Condição','E-mail · carrinho-24h','Fim']);
 assert.match(carrinho.textContent,/se whatsapp_lido → fim · se nao_lido → email-24h/);assert.match(carrinho.querySelector('.flow-badges').textContent,/Modo real.*v3 · ativa/);
 assert.match(carrinho.textContent,/exemplo_carrinho_30 · não encontrado no catálogo da Meta desta coleta/);
 assert.match(cards[1].querySelector('.flow-badges').textContent,/Modo sombra.*v1 · não ativa.*Rascunho pendente/);
 // busca e filtro de origem
 const set=(sel,v)=>{const el=ry().querySelector(sel);el.value=v;el.dispatchEvent(new y.window.Event('input'));el.dispatchEvent(new y.window.Event('change'));};
 set('#fluxos-busca','pix');assert.equal(ry().querySelectorAll('.flow-card').length,1);assert.equal(y.document.activeElement.id,'fluxos-busca');
 set('#fluxos-busca','');set('#fluxos-origem','observados');assert.deepEqual([...ry().querySelectorAll('.flow-card')].map(c=>c.dataset.origem),['observado']);
 set('#fluxos-origem','todas');
 ry().querySelector('#fluxos-export').click();
 const dl=y.downloads[y.downloads.length-1];assert.match(dl.nome,/^growth-fluxos-/);
 const linhas=dl.texto.split('\r\n');assert.match(linhas[0],/^\uFEFFOrigem;Marca;Fluxo;Gatilho;Modo;Versão;Etapa;Tipo;Canal;Peça;Template;Espera;Condições;Workflow\(s\);Volume no período/);
 assert.equal(linhas.filter(l=>l.startsWith('definição declarada')).length,8);assert.equal(linhas.filter(l=>l.startsWith('observado no motor')).length,1);
 assert.match(dl.texto,/definição declarada;fish;Carrinho abandonado;checkout_abandonado · reentrada apos_fim · sai em pedido_pago, checkout_recuperado;real;v3 · ativa;1;espera;;;;30 min;;;/);
 assert.doesNotMatch(dl.texto,/synthetic-test-key/);
 const z=await boot(fixture(),{hash:'#sec=regua&aba=fluxos'});assert.equal(z.document.querySelector('#control-fluxos').hidden,false);
});

test('WhatsApp preview updates examples and PIX card without live payment actions',async()=>{
 const x=await boot(fixture(),{hash:'#sec=regua&aba=drafts'});
 x.run('trocaMarca("fish")');x.document.querySelector('#drafts-novo').click();
 const set=(id,v)=>{const el=x.document.querySelector(id);el.value=v;el.dispatchEvent(new x.window.Event('input'));};
 set('#d-corpo','Olá *{{1}}*! Seu pedido está pronto.');set('[data-exemplo="1"]','Ana <teste>');
 assert.equal(x.document.querySelector('.mp-chat-head strong').textContent,'Fishermans');
 assert.equal(x.document.querySelector('.draft-bubble-body strong').textContent,'Ana <teste>');
 x.document.querySelector('#d-botao-add').click();set('[data-botao-campo="tipo"]','order_details');
 assert.match(x.document.querySelector('.mp-payment').textContent,/Dados ilustrativos/);
 assert.match(x.document.querySelector('#d-preview').textContent,/Copiar código Pix/);
 assert.equal(x.document.querySelectorAll('#d-preview a[href]').length,0);
});
test('email preview opens isolated HTML with devices, images opt-in and restored focus',async()=>{
 const x=await boot(fixture(),{hash:'#sec=regua&aba=drafts'});
 x.run('trocaMarca("fish")');x.document.querySelector('#drafts-novo-email').click();
 const set=(id,v)=>{const el=x.document.querySelector(id);el.value=v;el.dispatchEvent(new x.window.Event('input'));};
 set('#d-assunto','Sua compra');set('#d-corpo','<h1>Olá {{ .Tx.Data.first_name }}</h1><img src="https://example.com/photo.png"><script>alert(1)</script><a href="https://example.com/pay" onclick="alert(1)">Pagar</a>');
 const open=x.document.querySelector('#d-preview-open');open.focus();open.click();
 const modal=x.document.querySelector('#message-preview-dialog'),frame=modal.querySelector('iframe');
 assert.equal(frame.getAttribute('sandbox'),'');assert.equal(frame.getAttribute('referrerpolicy'),'no-referrer');
 const source=frame.getAttribute('srcdoc');assert.match(source,/Olá/);assert.match(source,/\.Tx\.Data\.first_name/);assert.doesNotMatch(source,/<script|onclick=|href="https/);assert.match(source,/img-src &#39;none&#39;/);
 modal.querySelector('[data-mp-device="mobile"]').click();assert.equal(modal.querySelector('.mp-mail-stage').dataset.device,'mobile');
 const images=modal.querySelector('[data-mp-images]');images.checked=true;images.dispatchEvent(new x.window.Event('change'));assert.match(modal.querySelector('iframe').getAttribute('srcdoc'),/img-src https:/);
 modal.querySelector('[data-mp-close]').click();assert.equal(x.document.querySelector('#message-preview-dialog'),null);assert.equal(x.document.activeElement,open);
 assert.equal(x.requests.length,1);
});


test('Growth opens an accessible inline key form when prompt is unavailable, and submits with Enter semantics',async()=>{
 const x=await boot(fixture(),{noReadKey:true,prompt:()=>{throw Error('prompt() is not supported');}});
 assert.equal(x.run('LOADING'),false);assert.equal(x.requests.length,0);assert.equal(x.document.querySelector('#load-state').hidden,true);
 const form=x.document.querySelector('#growth-acesso'),field=x.document.querySelector('#growth-chave');
 assert.equal(form.hidden,false);assert.equal(field.getAttribute('type'),'password');assert.equal(x.document.activeElement,field);
 assert.equal(x.document.querySelector('label[for="growth-chave"]').textContent,'Chave de acesso');
 let prevented=0;await form.onsubmit({preventDefault(){prevented++;}});assert.equal(x.requests.length,0);assert.match(x.document.querySelector('#growth-acesso-msg').textContent,/Informe/);
 field.value='  synthetic-inline&key  ';await form.onsubmit({preventDefault(){prevented++;}});
 assert.equal(prevented,2);assert.equal(field.value,'');assert.equal(form.hidden,true);assert.equal(x.run('LOADING'),false);
 assert.equal(x.requests.length,1);const url=new URL(x.requests[0]);assert.equal(url.searchParams.has('k'),false);assert.equal(x.calls[0].init.headers.Authorization,'Bearer synthetic-inline&key');assert.equal(url.searchParams.get('painel'),'growth');
 assert.equal(x.store.has('shrigma_k_growth'),false);assert.equal(x.store.has('shrigma_k_mestre'),false);assert.equal(x.run('GTA.chaveLeitura()'),'synthetic-inline&key');assert.equal(x.document.querySelector('#load-state').hidden,true);
 assert.ok(x.document.querySelectorAll('#area-kpis .kpi-val').length>0,'real render functions paint fixture data');
 assert.ok(x.hashes.every(h=>!h.includes('synthetic-inline')),'key never enters page navigation');
});
test('Growth keeps a session key when storage cannot persist it and reopens inline access on401/403',async()=>{
 for(const status of [401,403]){
  const x=await boot(fixture(),{noReadKey:true,prompt:()=>{throw Error('unsupported');}});
  x.run('shrigmaGuardaChave=()=>{}');const form=x.document.querySelector('#growth-acesso'),field=x.document.querySelector('#growth-chave');
  field.value='synthetic-session-only';await form.onsubmit({preventDefault(){}});assert.equal(x.store.has('shrigma_k_growth'),false);assert.equal(x.store.has('shrigma_k_mestre'),false);assert.equal(x.run('chave()'),'synthetic-session-only');
  x.setResponse({},status);await x.run('carregar()');assert.equal(form.hidden,false);assert.equal(x.run('chave()'),'');assert.equal(x.run('LOADING'),false);assert.equal(field.value,'');
  assert.match(x.document.querySelector('#growth-acesso-msg').textContent,/recusada/);assert.equal(x.document.querySelector('#btn-atualizar').disabled,false);
 }
});
test('new reader is never promoted to shared master even when the response reports todos',async()=>{
 const x=await boot({...fixture(),_painel:'todos'},{noReadKey:true});x.document.querySelector('#growth-chave').value='synthetic-session-reader';await x.document.querySelector('#growth-acesso').onsubmit({preventDefault(){}});
 assert.equal(x.store.has('shrigma_k_growth'),false);assert.equal(x.store.has('shrigma_k_mestre'),false);assert.equal(x.run('GTA.chaveLeitura()'),'synthetic-session-reader');
});
test('Growth connection errors do not print request URL or reader key',async()=>{
 const x=await boot(fixture(),{noReadKey:true,fetchMock:async url=>{throw Error('failed request '+url);}});x.document.querySelector('#growth-chave').value='synthetic-session-reader';await x.document.querySelector('#growth-acesso').onsubmit({preventDefault(){}});
 assert.match(x.document.querySelector('#faixa-alertas').textContent,/consulta falhou/);assert.doesNotMatch(x.document.body.textContent,/synthetic-session-reader/);assert.doesNotMatch(x.document.querySelector('#faixa-alertas').textContent,/\?k=/);assert.equal(x.run('LOADING'),false);
});
test('Growth rejects a response from another scope or an error envelope and preserves the previous data',async()=>{
 const x=await boot();const before=x.document.querySelector('#area-kpis').textContent;
 for(const payload of [{...fixture(),_escopo:'influs'}, {...fixture(),erro:'synthetic-private-error'}, {...fixture(),error:'synthetic-private-error'}]){
  x.setResponse(payload);await x.run('carregar()');assert.equal(x.document.querySelector('#area-kpis').textContent,before);assert.match(x.document.querySelector('#faixa-alertas').textContent,/não retornou os dados de Growth/);assert.doesNotMatch(x.document.body.textContent,/synthetic-private-error/);
 }
});

test('brand switch preserves template preparation, filters cards, and does not convert brands or operation journals',async()=>{
 const x=await boot();x.run('trocaMarca("fish")');
 x.run(`GR.guarda(GR.novo({id:'fish-local',marca:'fish',nome:'fish_template',corpo:'Fish'}));GR.guarda(GR.novo({id:'aristo-local',marca:'aristo',nome:'aristo_template',corpo:'Aristo'}));GRU.render();GRU.abrir(GR.novo({id:'working-fish',marca:'fish',nome:'incompleto',corpo:'Fish local https://fishermans.com.br/'}),null)`);
 const snapshot=x.run('JSON.stringify(GRU.state.rascunho)');
 x.document.querySelector('[data-marca="aristo"]').click();assert.equal(x.run('MARCA'),'fish');
 x.run('confirm=()=>true');x.document.querySelector('[data-marca="aristo"]').click();
 assert.equal(x.run('MARCA'),'aristo');assert.equal(x.document.querySelectorAll('[data-draft="fish-local"]').length,0);assert.ok(x.document.querySelector('[data-draft="aristo-local"]'));
 x.document.querySelector('[data-marca="fish"]').click();assert.equal(x.run('JSON.stringify(GRU.state.rascunho)'),snapshot);
 assert.equal(x.document.querySelector('#d-marca').disabled,true);
});
test('journey dirty, busy or unresolved state keeps the header and preference on the original brand',async()=>{
 const x=await boot();x.run('trocaMarca("fish")');
 for(const state of [{dirty:true},{busy:true},{pending:{id:'same-attempt'}}]){
  x.run(`Object.assign(GB.state,{dirty:false,busy:false,pending:null},${JSON.stringify(state)})`);
  x.document.querySelector('[data-marca="aristo"]').click();
  assert.equal(x.run('MARCA'),'fish');assert.equal(x.document.querySelector('#seg-marca .ativo').dataset.marca,'fish');assert.equal(JSON.parse(x.store.get('shrigma_growth_pref')).marca,'fish');
  assert.equal(x.document.querySelector('#brand-context-status').hidden,false);
 }
});
test('A/B brand and channel stay aligned, selection survives refresh, and changing channel explicitly clears incompatible arms',async()=>{
 const p=fixture();p.crm_campanha.push({...p.crm_campanha[0],marca:'aristo',campanha_id:2,nome:'Aristo e-mail'},{...p.crm_campanha[0],marca:'aristo',canal:'whatsapp',campanha_id:3,nome:'Aristo WA'});
 const x=await boot(p);x.run('trocaMarca("aristo")');x.document.querySelector('#btn-novo').click();
 assert.equal(x.document.querySelector('#f-marca').value,'aristo');assert.equal(x.document.querySelector('#f-marca').disabled,true);
 assert.deepEqual([...x.document.querySelector('#f-ca').options].map(o=>o.value),['','2']);
 x.document.querySelector('#f-id').value='aristo-test';x.document.querySelector('#f-ca').value='2';await x.run('carregar()');assert.equal(x.document.querySelector('#f-ca').value,'2');
 const change=()=>{const c=x.document.querySelector('#f-canal');c.value='whatsapp';c.dispatchEvent(new x.window.Event('change'));};
 change();assert.equal(x.document.querySelector('#f-canal').value,'email');assert.equal(x.document.querySelector('#f-ca').value,'2');
 x.run('confirm=()=>true');change();assert.equal(x.document.querySelector('#f-ca').value,'');assert.deepEqual([...x.document.querySelector('#f-ca').options].map(o=>o.value),['','3']);
 x.document.querySelector('#f-ca').value='3';x.run('trocaMarca("fish");trocaMarca("aristo")');assert.equal(x.document.querySelector('#f-id').value,'aristo-test');assert.equal(x.document.querySelector('#f-ca').value,'3');
});
test('storage failure during a brand switch keeps the current editor, header and unsaved content',async()=>{
 const x=await boot();x.run('trocaMarca("fish");GRU.abrir(GR.novo({marca:"fish",nome:"não perder",corpo:"Conteúdo local"}),null);confirm=()=>true;localStorage.setItem=()=>{throw Error("Dispositivo sem espaço")}');
 x.document.querySelector('[data-marca="aristo"]').click();assert.equal(x.run('MARCA'),'fish');assert.equal(x.run('GRU.state.rascunho.corpo'),'Conteúdo local');assert.match(x.document.querySelector('#brand-context-status').textContent,/sem espaço/);
});

test('a late A/B receipt for Fish does not close or clear the open Aristo preparation',async()=>{
 const x=await boot();x.run('trocaMarca("fish")');await x.run('reconciliaTestesAB()');
 x.run(`AB_PROVA_LEITURA={startedAt:Date.now(),completedAt:Date.now()};AB_CHAVE_SESSAO='synthetic-writer';AB_JOURNAL={inspect:()=>({blocked:false,operations:[{phase:'uncertain',server:{},expected:{acao:'criar',teste:{teste_id:'fish-old',marca:'fish'}}}]}),reconcileRemote:()=>new Promise(resolve=>globalThis.finishAB=resolve)};`);
 const pending=x.run('reconciliaTestesAB()');
 x.run(`trocaMarca('aristo');document.getElementById('btn-novo').click();document.getElementById('f-id').value='aristo-new';AB_JOURNAL.inspect=()=>({blocked:false,operations:[]});finishAB({changed:true,confirmed:[{phase:'confirmed',expected:{acao:'criar',teste:{teste_id:'fish-old',marca:'fish'}}}]})`);
 await pending;assert.equal(x.document.querySelector('#form-teste').hidden,false);assert.equal(x.document.querySelector('#f-id').value,'aristo-new');assert.equal(x.run('MARCA'),'aristo');
});
test('returning to a template keeps local content but cannot lower a newer reconciled server revision',async()=>{
 const x=await boot();x.run(`trocaMarca('fish');GRU.abrir(GR.novo({id:'receipt-progress',marca:'fish',nome:'local',corpo:'Minha edição',servidor:{draft_id:'same-id',version:1,estado:'rascunho'}}),null);confirm=()=>true;trocaMarca('aristo');GR.guarda(GR.novo({id:'receipt-progress',marca:'fish',nome:'local',corpo:'Conteúdo do recibo',servidor:{draft_id:'same-id',version:2,estado:'validado'}}));trocaMarca('fish');`);
 assert.equal(x.run('GRU.state.rascunho.corpo'),'Minha edição');assert.equal(x.run('GRU.state.rascunho.servidor.version'),2);assert.equal(x.run('GRU.state.rascunho.servidor.draft_id'),'same-id');
});
test('a template preparation cannot silently inherit a different server draft identity',async()=>{
 const x=await boot();x.run(`trocaMarca('fish');GRU.abrir(GR.novo({id:'same-local-id',marca:'fish',nome:'local',corpo:'Minha edição',servidor:{draft_id:'original-server-id',version:1}}),null);confirm=()=>true;trocaMarca('aristo');GR.guarda(GR.novo({id:'same-local-id',marca:'fish',nome:'other',servidor:{draft_id:'different-server-id',version:5}}));trocaMarca('fish');`);
 assert.equal(x.run('GRU.state.rascunho.servidor.draft_id'),'original-server-id');assert.equal(x.run('GRU.state.rascunho.corpo'),'Minha edição');assert.match(x.run('GRU.contextError'),/vínculo/);assert.equal(x.run('GRU.prontaEscrita(GRU.state.rascunho)'),false);
});
