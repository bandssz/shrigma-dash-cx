/* Teste de integração em DOM local, sem abrir navegador ou fazer chamadas externas.
   Dependência de desenvolvimento: npm install --prefix ../growth-test-tools linkedom@0.18.12 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
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
 const store=new Map([['shrigma_k_growth','synthetic-test-key']]);
 const requests=[],downloads=[],hashes=[];let response=payload,code=200;
 const NativeDate=Date;class FixedDate extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-08T01:10:00Z']));}static now(){return new NativeDate('2026-09-08T01:10:00Z').valueOf();}}
 const context=vm.createContext({document,window,Date:FixedDate,Intl,URL,URLSearchParams,AbortSignal,console,__downloads:downloads,
 Image:class{set src(x){}},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
 location:{reload:()=>{throw Error('unexpected reload');},hash:opts.hash||''},history:{replaceState:(a,b,url)=>hashes.push(url)},
 Blob:class{constructor(parts){this.text=parts.join('');}},prompt:()=>null,confirm:()=>false,
 addEventListener:()=>{},setInterval:()=>0,clearInterval:()=>{},setTimeout,clearTimeout,
 fetch:async(url)=>{requests.push(url);return {status:code,ok:code>=200&&code<300,json:async()=>structuredClone(response)};},});
 for(const script of document.querySelectorAll('script')){
  const src=script.getAttribute('src');
  const code=src?fs.readFileSync(path.join(root,src.split('?')[0]),'utf8'):script.textContent;
  vm.runInContext(code,context,{filename:src||'growth-inline.js'});
 }
 const run=code=>vm.runInContext(code,context);
 // Exportação: captura o CSV em vez de criar um download real.
 run('GT.baixar=(nome,texto)=>{__downloads.push({nome,texto});return true;}');
 for(let i=0;i<10&&run('LOADING');i++)await new Promise(setImmediate);
 return {document,window,run,requests,store,downloads,hashes,setResponse:(r,status=200)=>{response=r;code=status;}};
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
 assert.equal(linhas.length,3);assert.match(linhas[0],/^\uFEFFPeça;Marca;Enviado em/);assert.match(linhas[0],/recorte_marca;recorte_canal;periodo_inicio;periodo_fim;referencia_consulta;busca$/);
 assert.match(linhas[1],/^"Zebra; ""aspas""";O Aristocrata;/);
 // abertura não medida → vazio; CTOR sem abertura → vazio; receita indivisível → vazio + sim
 assert.match(linhas[1],/;500;490;98;;4,08;;0;0;0;;;sim;;não;Consolidada;E-mail;2026-09-01;2026-09-07;07\/09\/2026, 22:10;zebra$/);
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
 assert.match(texto,/pedido-pago;aristo_confirmacao_exemplo;O Aristocrata;pt_BR;PENDING;MARKETING;UTILITY;sim;mapeado no fluxo;ok;/);
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
 root().querySelector('#drafts-novo').click();
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
test('faixa de fontes prefere crm_fontes da API: coleta atrasada fica velha, evento fica neutro, ausente vira sem dado',async()=>{
 const p=fixture();
 p.crm_fontes=[{fonte:'shopify_conversao',rotulo:'Venda (Shopify)',tipo:'coleta',coletado_em:'2026-09-07T22:00:00Z',cadencia_seg:86400,status:'ok'},
  {fonte:'listmonk_snapshot',rotulo:'E-mail (Listmonk)',tipo:'coleta',coletado_em:'2026-09-07T20:00:00Z',cadencia_seg:1800,status:'atrasado'},
  {fonte:'wa_status_meta',rotulo:'Status WhatsApp (Meta)',tipo:'evento',coletado_em:'2026-09-08T01:00:00Z',cadencia_seg:null,status:'evento'},
  {fonte:'inventario_operacao',rotulo:'Inventario',tipo:'coleta',coletado_em:null,cadencia_seg:300,status:null}];
 const x=await boot(p);
 const f=[...x.document.querySelectorAll('#fontes .fonte')];
 assert.deepEqual(f.map(n=>n.querySelector('b').textContent),['Consulta','Venda','E-mail','WhatsApp','Inventário']);
 assert.deepEqual(f.map(n=>n.dataset.estado),['ok','ok','velho','ok','falta']);
 assert.match(f[2].title,/ATRASADA/);assert.match(f[3].textContent,/último evento/);assert.match(f[3].title,/não indica saúde/i);
 assert.match(f[4].textContent,/sem dado/);
});
test('saúde dos fluxos: chips só com dado da API, alerta destacado, filtro por marca, ausência não vira saúde',async()=>{
 const p=fixture();
 p.wa_fluxo_saude=[{chave:'aceite:aristo',brand:'aristo',nome:'Aceite → status Meta · aristo',verificado_em:'2026-09-08T01:00:00Z',n_aceites:40,n_status:0,estado:'alerta',motivo:'40 aceites sem status',alerta_desde:'2026-09-07T23:00:00Z'},
  {chave:'gatilho:fish:pedido-pago',brand:'fish',nome:'Gatilho → WhatsApp · fish · pedido-pago',verificado_em:'2026-09-08T01:00:00Z',n_gatilho:12,n_saida:12,estado:'ok',motivo:null}];
 const x=await boot(p);
 let chips=[...x.document.querySelectorAll('#fluxo-saude .fluxo-chip')];
 assert.equal(chips.length,2);assert.equal(chips[0].dataset.estado,'alerta');assert.match(chips[0].textContent,/· alerta$/);assert.match(chips[0].title,/40 aceites sem status/);
 assert.equal(chips[1].dataset.estado,'ok');assert.match(chips[1].title,/Sem ocorrência/);
 x.document.querySelector('[data-marca="fish"]').click();
 chips=[...x.document.querySelectorAll('#fluxo-saude .fluxo-chip')];assert.equal(chips.length,1);assert.equal(chips[0].dataset.estado,'ok');
 const y=await boot(fixture());
 assert.equal(y.document.querySelector('#fluxo-saude').innerHTML,'');
});
