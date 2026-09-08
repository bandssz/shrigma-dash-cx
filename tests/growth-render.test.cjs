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
async function boot(payload=fixture()){
 const html=fs.readFileSync(path.join(root,'growth.html'),'utf8'),{document,window}=parseHTML(html);
 // linkedom não implementa setters de select/layout; apenas completar a API do DOM,
 // sem simular resultados de métricas ou comportamento da aplicação.
 const selectProto=Object.getPrototypeOf(document.querySelector('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 window.HTMLElement.prototype.scrollIntoView=function(){};
 window.HTMLElement.prototype.getBoundingClientRect=function(){return {top:0,width:1200,height:100};};
 const store=new Map([['shrigma_k_growth','synthetic-test-key']]);
 const requests=[];let response=payload,code=200;
 const NativeDate=Date;class FixedDate extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-08T01:10:00Z']));}static now(){return new NativeDate('2026-09-08T01:10:00Z').valueOf();}}
 const context=vm.createContext({document,window,Date:FixedDate,Intl,URL,URLSearchParams,AbortSignal,console,
 Image:class{set src(x){}},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
 location:{reload:()=>{throw Error('unexpected reload');}},prompt:()=>null,confirm:()=>false,
 addEventListener:()=>{},setInterval:()=>0,clearInterval:()=>{},setTimeout,clearTimeout,
 fetch:async(url)=>{requests.push(url);return {status:code,ok:code>=200&&code<300,json:async()=>structuredClone(response)};},});
 for(const script of document.querySelectorAll('script')){
  const src=script.getAttribute('src');
  const code=src?fs.readFileSync(path.join(root,src.split('?')[0]),'utf8'):script.textContent;
  vm.runInContext(code,context,{filename:src||'growth-inline.js'});
 }
 const run=code=>vm.runInContext(code,context);
 for(let i=0;i<10&&run('LOADING');i++)await new Promise(setImmediate);
 return {document,window,run,requests,store,setResponse:(r,status=200)=>{response=r;code=status;}};
}
test('front completo carrega, filtra canal/marca e mantém sombra fora dos disparos',async()=>{
 const x=await boot();assert.equal(x.document.querySelector('#load-state').hidden,true);
 assert.equal(x.document.querySelectorAll('#area-kpis .kpi').length,4);
 assert.equal(x.document.querySelectorAll('.channel-card').length,2);
 assert(x.requests[0].includes('painel=growth'));
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,'192');
 x.document.querySelector('[data-canal="whatsapp"]').click();
 assert.equal(x.document.querySelector('#area-kpis .kpi-val').textContent,'42');
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
