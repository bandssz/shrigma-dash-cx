/* Painel de CX (index.html) em DOM local, sem navegador e sem chamadas externas.
   Fixture sintética: nenhum número aqui é real.
   Dependência de desenvolvimento: npm install --prefix ../growth-test-tools linkedom@0.18.12 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseHTML } = require(require.resolve('linkedom', { paths: [path.resolve(__dirname, '../../growth-test-tools/node_modules')] }));
const root = path.resolve(__dirname, '..');

const HOJE = '2026-09-10';
const diasAtrasT = (n) => { const d = new Date(HOJE + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const dias = (n) => Array.from({ length: n }, (_, i) => { const d = new Date(HOJE + 'T12:00Z'); d.setUTCDate(d.getUTCDate() - i); return d.toISOString().slice(0, 10); });
const snap = (marca, dia, o = {}) => ({ marca, janela: '1d', dia, novos: 100, fechados: 90, trabalhados: 80, respostas: 300,
  primeira_resposta_seg: 600, csat: 66, csat_cobertura: 40, csat_votos: 40, kai_deflexao: 50, ia_perguntas: 10, fila_aberta: 12,
  coletas_ok: 3, coletas_total: 3, coletado_em: HOJE + 'T14:00:00Z', primeira_resposta_comercial_seg: 500, resolucao_comercial_seg: 3000, amostra_comercial: 30, ...o });
// desfecho maduro (14/09): linha transferida = 40 com resposta humana (20 sem ninguém); linha do Kai = 15 fechadas por ele, 2 por inatividade
const csat = (marca, dia, motivo, escalado, o = {}) => { const t = o.tickets ?? 60, resp = escalado ? Math.min(40, t) : 0;
  return { marca, canal: 'whatsapp', dia, motivo, escalado, tickets: t, csat_enviado: 50, avaliadas: 40, bom: 20, neutro: 10, ruim: 10, kai_pode_atender: 0, abertos: 0,
    fechados: escalado ? resp : 17, resposta_humana: resp, kai_fechou: escalado ? 0 : 15, fechado_inatividade: escalado ? 0 : 2, ...o }; };
const desf = (marca, dia, canal = 'whatsapp') => ({ dia, marca, canal, tickets: 100, resolvido_kai: 30, escalado: 60, escalado_sem_resposta: 5,
  promessa_vazia: 3, inatividade: 5, pendente: 2, so_outros: 5, outros_corrigido: 10, nunca_outros: 85, csat_enviado: 80, pend_cliente: 1, pend_bot: 1, pend_agente: 0, pend_vazio: 0 });

function fixture(o = {}) {
  const ds = dias(45);
  return {
    _painel: 'cx', gerado_em: HOJE + 'T14:05:00Z',
    // a API devolve o snapshot em ordem crescente de dia; hojeRef() lê o último
    snapshot_1d: [...ds].reverse().flatMap((d) => [snap('aristocrata', d), snap('fishermans', d, { novos: 40, fechados: 38 })]),
    janelas: [], agentes_1d: [], agentes_janelas: [], nps: [], intradia: [], social: [], social_autoria: [], social_tempo: [],
    social_atencao: [], social_oportunidade: [], nps_frustracoes: [], manual: [], crm_credencial: [],
    cx_esforco: [], cx_reabertura: [], cx_marco: [{ dia: '2026-08-29', titulo: 'Quebra de série', detalhe: 'teste' }],
    cx_desfecho: ds.flatMap((d) => [desf('aristocrata', d), desf('fishermans', d), desf('aristocrata', d, 'email')]),
    cx_csat: ds.flatMap((d) => [
      csat('aristocrata', d, 'wismo', true), csat('aristocrata', d, 'wismo', false, { tickets: 20, avaliadas: 4, bom: 4, neutro: 0, ruim: 0 }),
      csat('aristocrata', d, 'outros', true, { tickets: 40, avaliadas: 30, bom: 27, neutro: 2, ruim: 1 }),
      csat('aristocrata', d, 'sem-tag', true, { canal: 'email', tickets: 25, avaliadas: 0, bom: 0, neutro: 0, ruim: 0, csat_enviado: 0 }),
      csat('fishermans', d, 'pre-venda', true, { tickets: 30, avaliadas: 30, bom: 30, neutro: 0, ruim: 0 }),
    ]),
    // 1ª resposta humana medida ticket a ticket (view cx_tempo_dia): mediana em expediente por dia
    cx_tempo: ds.flatMap((d) => [{ marca: 'aristocrata', canal: 'whatsapp', dia: d, tickets: 120, respondidos: 70, transferidos_sem_resposta: 30, com_tempo: 70, p50_comercial_seg: 3000, p90_comercial_seg: 20000, p50_relogio_seg: 9000, ate_1h: 42, ate_4h: 60 },
      { marca: 'fishermans', canal: 'whatsapp', dia: d, tickets: 30, respondidos: 30, transferidos_sem_resposta: 0, com_tempo: 30, p50_comercial_seg: 600, p90_comercial_seg: 3000, p50_relogio_seg: 700, ate_1h: 30, ate_4h: 30 }]),
    cx_tempo_agente: ds.flatMap((d) => [{ marca: 'aristocrata', dia: d, agente_id: 'u1', agente_nome: 'Leticia Franca', canal: 'whatsapp', respondidos: 50, p50_comercial_seg: 2400, p50_relogio_seg: 8000, ate_1h: 35 },
      { marca: 'fishermans', dia: d, agente_id: 'u2', agente_nome: 'Adão M', canal: 'whatsapp', respondidos: 30, p50_comercial_seg: 600, p50_relogio_seg: 700, ate_1h: 30 }]),
    // fechamentos (view cx_fechamento_dia / cx_fechamento_agente_dia): por dia do fechamento; maduros = 7 dias corridos.
    // Dias antigos (> 7 dias) vêm maduros; os 7 últimos, imaturos (maduros 0) — como a view devolve na vida real.
    cx_fechamento: ds.flatMap((d) => { const mad = d <= diasAtrasT(7); return [
      { marca: 'aristocrata', canal: 'whatsapp', dia: d, fechados: 100, por_pessoa: 60, por_kai: 40, por_sistema: 0, maduros: mad ? 100 : 0, resolutivos: mad ? 70 : 0, voltaram: mad ? 30 : 5, voltaram_humano: mad ? 20 : 3,
        pessoa_maduros: mad ? 60 : 0, pessoa_resolutivos: mad ? 48 : 0, kai_maduros: mad ? 40 : 0, kai_resolutivos: mad ? 22 : 0, fcr_base: mad ? 50 : 0, fcr: mad ? 35 : 0, msgs_humanas_p50: 3, msgs_humanas_media: 3.4, msgs_cliente_p50: 6 },
      { marca: 'fishermans', canal: 'whatsapp', dia: d, fechados: 20, por_pessoa: 20, por_kai: 0, por_sistema: 0, maduros: mad ? 20 : 0, resolutivos: mad ? 19 : 0, voltaram: mad ? 1 : 0, voltaram_humano: mad ? 1 : 0,
        pessoa_maduros: mad ? 20 : 0, pessoa_resolutivos: mad ? 19 : 0, kai_maduros: 0, kai_resolutivos: 0, fcr_base: mad ? 20 : 0, fcr: mad ? 18 : 0, msgs_humanas_p50: 2, msgs_humanas_media: 2.1, msgs_cliente_p50: 4 }]; }),
    cx_fechamento_agente: ds.flatMap((d) => { const mad = d <= diasAtrasT(7); return [
      { marca: 'aristocrata', dia: d, agente_id: 'u1', agente_nome: 'Leticia Franca', fechados: 60, maduros: mad ? 60 : 0, resolutivos: mad ? 48 : 0, voltaram: mad ? 12 : 2, voltaram_humano: mad ? 8 : 1, fcr_base: mad ? 50 : 0, fcr: mad ? 35 : 0, msgs_humanas_p50: 3, msgs_humanas_media: 3.4, msgs_cliente_p50: 6 },
      { marca: 'fishermans', dia: d, agente_id: 'u2', agente_nome: 'Adão M', fechados: 20, maduros: mad ? 20 : 0, resolutivos: mad ? 19 : 0, voltaram: mad ? 1 : 0, voltaram_humano: mad ? 1 : 0, fcr_base: mad ? 20 : 0, fcr: mad ? 18 : 0, msgs_humanas_p50: 2, msgs_humanas_media: 2.1, msgs_cliente_p50: 4 }]; }),
    // tempo de resposta dentro da conversa (view cx_resposta_agente_dia): Leticia mediana 5 min (90% em até 8), Adão 20 min
    cx_resposta_agente: ds.flatMap((d) => [{ marca: 'aristocrata', dia: d, agente_id: 'u1', agente_nome: 'Leticia Franca', respostas: 40, p50_comercial_seg: 300, p90_comercial_seg: 900, p50_relogio_seg: 320, ate_8min: 36, ate_30min: 40 },
      { marca: 'fishermans', dia: d, agente_id: 'u2', agente_nome: 'Adão M', respostas: 20, p50_comercial_seg: 1200, p90_comercial_seg: 3600, p50_relogio_seg: 5000, ate_8min: 4, ate_30min: 15 }]),
    // trocas (view cx_troca_mes): HOJE = 10/09 → mês fechado = agosto, atual = setembro; 'em análise' é fila de agora
    cx_troca: [
      { marca: 'aristocrata', mes: '2026-07-01', tipo: 'Devolução', reversas: 25, abertas: 0, em_analise: 0, em_analise_7d: 0, canceladas: 10, finalizadas: 0, entregues: 15, analisadas: 25, valor_itens: 3000, valor_estorno: 1800, valor_troca: 0, frete_reverso: 200, dias_analise_p50: 0.5, dias_analise_p90: 2, dias_ate_entrega_p50: 9, segunda_solicitacao: 0, coletado_em: '2026-09-10T05:40:00Z' },
      { marca: 'aristocrata', mes: '2026-08-01', tipo: 'Devolução', reversas: 60, abertas: 40, em_analise: 40, em_analise_7d: 40, canceladas: 5, finalizadas: 0, entregues: 15, analisadas: 20, valor_itens: 8000, valor_estorno: 5000, valor_troca: 0, frete_reverso: 300, dias_analise_p50: 4, dias_analise_p90: 9, dias_ate_entrega_p50: 12, segunda_solicitacao: 0, coletado_em: '2026-09-10T05:40:00Z' },
      { marca: 'aristocrata', mes: '2026-08-01', tipo: 'Troca', reversas: 30, abertas: 17, em_analise: 17, em_analise_7d: 17, canceladas: 6, finalizadas: 0, entregues: 7, analisadas: 13, valor_itens: 4000, valor_estorno: 0, valor_troca: 3000, frete_reverso: 100, dias_analise_p50: 6, dias_analise_p90: 10, dias_ate_entrega_p50: 14, segunda_solicitacao: 0, coletado_em: '2026-09-10T05:40:00Z' },
      { marca: 'fishermans', mes: '2026-08-01', tipo: 'Troca', reversas: 30, abertas: 5, em_analise: 0, em_analise_7d: 0, canceladas: 8, finalizadas: 4, entregues: 20, analisadas: 30, valor_itens: 3500, valor_estorno: 0, valor_troca: 3200, frete_reverso: 250, dias_analise_p50: 1, dias_analise_p90: 3, dias_ate_entrega_p50: 10, segunda_solicitacao: 1, coletado_em: '2026-09-10T05:40:00Z' },
      { marca: 'aristocrata', mes: '2026-09-01', tipo: 'Devolução', reversas: 20, abertas: 20, em_analise: 20, em_analise_7d: 5, canceladas: 0, finalizadas: 0, entregues: 0, analisadas: 0, valor_itens: 2500, valor_estorno: 1500, valor_troca: 0, frete_reverso: 0, dias_analise_p50: null, dias_analise_p90: null, dias_ate_entrega_p50: null, segunda_solicitacao: 0, coletado_em: '2026-09-10T05:40:00Z' },
    ],
    cx_troca_motivo: [
      { marca: 'aristocrata', mes: '2026-08-01', motivo: 'Recebi um produto diferente do que pedi', submotivo: 'Kit com composição errada', tipo: 'Devolução', reversas: 35, valor_itens: 4200 },
      { marca: 'aristocrata', mes: '2026-08-01', motivo: 'Me arrependi', submotivo: 'Não era o que eu esperava', tipo: 'Troca', reversas: 25, valor_itens: 3000 },
      { marca: 'fishermans', mes: '2026-08-01', motivo: 'Comprei a linha errada', submotivo: '', tipo: 'Troca', reversas: 22, valor_itens: 2600 },
    ],
    cx_pedidos: [], cx_ra: [],
    ...o,
  };
}

async function boot(payload = fixture(), query = '?periodo=7d', hash = '') {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const { document, window } = parseHTML(html);
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { top: 0, left: 0, width: 1200, height: 100 }; };
  const store = new Map([['shrigma_k_cx', 'synthetic-test-key']]);
  const requests = [];
  const NativeDate = Date;
  class FixedDate extends NativeDate { constructor(...a) { super(...(a.length ? a : [HOJE + 'T15:10:00Z'])); } static now() { return new NativeDate(HOJE + 'T15:10:00Z').valueOf(); } }
  const context = vm.createContext({ document, window, Date: FixedDate, Intl, URL, URLSearchParams, console,
    MutationObserver: class { observe() {} }, Image: class { set src(x) {} },
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    location: { search: query, hash, pathname: '/index.html' }, history: { replaceState: () => {} }, addEventListener: () => {}, setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
    fetch: async (url) => { requests.push(url); return { status: 200, ok: true, json: async () => structuredClone(payload) }; } });
  context.window.avisoCredencial = () => {};
  for (const script of document.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    if (src && /alerta-credencial/.test(src)) continue;
    const code = src ? fs.readFileSync(path.join(root, src.split('?')[0]), 'utf8') : script.textContent;
    try { vm.runInContext(code, context, { filename: src || 'inline.js' }); } catch (e) { if (!src) continue; throw e; }
  }
  for (let i = 0; i < 10 && !vm.runInContext('estado.dados', context); i++) await new Promise(setImmediate);
  await new Promise(setImmediate);
  const run = (c) => vm.runInContext(c, context);
  const txt = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
  return { document, run, requests, txt };
}

test('os seis números aparecem, CSAT em três níveis e não em média, Kai por transferência', async () => {
  const x = await boot();
  assert.equal(x.document.querySelectorAll('#area-seis .six2').length, 6);
  const rots = x.txt('#area-seis .six2-rot');
  assert.deepEqual(rots, ['Contatos / 100 pedidos', 'WISMO / pedido', 'CSAT · bom', 'Kai resolve sozinho', 'Ninguém respondeu', 'Reclame Aqui · nota']);
  // sem cx_pedidos: valor é traço e a linha de apoio diz o porquê — nunca zero
  assert.equal(x.txt('#area-seis .six2-val')[0], '—');
  assert.match(x.txt('#area-seis .six2')[0], /1\.225 contatos · sem pedidos coletados/);
  // o corte por marca mora no ⓘ (title), não na tela
  assert.match(x.document.querySelectorAll('#area-seis .six2')[2].getAttribute('title'), /Por marca: O Aristocrata 69% · Fishermans 100%/);
  // CSAT bom = (20+4+27+30)/(40+4+30+30) = 81/104 = 78%
  assert.equal(x.txt('#area-seis .six2-val')[2], '78%');
  assert.ok(!/\b6[0-9]\b(?!%)/.test(x.txt('#area-seis .six2')[2]), 'a média 66 do snapshot não pode aparecer no cartão de CSAT');
  // Kai resolve sozinho = fechados pelo Kai ÷ TODOS os tickets de chat maduros (até D-2), consolidado: 15 ÷ (60+20+40+30) = 10,0%
  assert.equal(x.txt('#area-seis .six2-val')[3], '10,0%');
  assert.match(x.document.querySelector('#area-seis .six2[data-m="kai_resolve"]').getAttribute('title'), /TODOS os tickets/);
  // ninguém respondeu = transferidos sem resposta humana ÷ maduros = 20/150 = 13,3% (fora do alvo de 5%)
  assert.equal(x.txt('#area-seis .six2-val')[4], '13,3%');
  // RA sem coleta: traço, não zero
  assert.equal(x.txt('#area-seis .six2-val')[5], '—');
  // CSAT: taxa de resposta sempre visível no cartão
  assert.match(x.txt('#area-seis .six2')[2], /responderam \d+%/);
  assert.match(x.document.querySelector('#seis-rot').textContent, /1 fora do alvo/);
  // um gráfico só, dirigido pelo cartão ativo (padrão: contatos/100 pedidos → sem pedidos vira aviso)
  assert.match(x.document.querySelector('#g-geral').textContent, /Sem pedidos coletados/);
  x.document.querySelector('#area-seis .six2[data-m="csat_bom"]').click();
  assert.match(x.document.querySelector('#g-geral-tit').textContent, /CSAT · bom/);
  assert.ok(x.document.querySelectorAll('#g-geral polyline').length >= 1, 'linha de CSAT por marca');
  // aba Chat no mesmo padrão: seis cartões (o antigo cartão de CSAT-média não existe mais) e um gráfico só
  assert.deepEqual(x.txt('#area-chat .six2-rot'), ['Contatos', 'CSAT · bom', 'Kai resolve sozinho', 'Ninguém respondeu', 'Voltou em 7 dias', 'Fila no fim do período', '1ª resposta · expediente']);
  assert.equal(x.txt('#area-chat .six2-val')[1], '78%');
  // 1ª resposta em expediente vem de cx_tempo (ticket a ticket), dias completos: mediana ponderada ≈ 3000 s = 50min; 72 de 100 em até 1h
  assert.match(x.txt('#area-chat .six2-val')[6], /50min/);
  assert.match(x.document.querySelectorAll('#area-chat .six2')[6].getAttribute('title'), /com resposta humana 700 \(67%\)/);
  // voltou em 7 dias: só o 1º dia do período (03/09) está maduro → corta e avisa; Aris 12 de 60 e Fish 1 de 20 por dia → 13 ÷ 80 = 16,3%
  assert.equal(x.txt('#area-chat .six2-val')[4], '16,3%');
  assert.match(x.document.querySelector('#chat-rot').textContent, /voltou: até 03\/09/);
  assert.match(x.document.querySelector('#area-chat .six2[data-m="voltou"]').getAttribute('title'), /FCR \(1º fechamento por pessoa, um agente só, sem volta\): 76% de 70/);
  // tabela de agentes: fechados por dia contra a meta de 120, resolutivos só maduros (7d: nada maduro → contagem), CSAT do Gleap
  const tb = x.document.querySelector('#tabela-ranking tbody');
  assert.match(tb.textContent, /Leticia Franca/);
  assert.match(tb.textContent, /70% em até 1h/);
  const let1 = [...tb.querySelectorAll('tr')].find((tr) => /Leticia/.test(tr.textContent));
  assert.match(let1.children[1].textContent, /420\s*60\/dia · 7 dias/);
  assert.ok(let1.children[1].querySelector('.st-ruim'), '60/dia fica vermelho contra a meta de 120');
  // só 03/09 está maduro dentro do período: 48 resolutivos de 60 maduros = 80% (base ≥ 30); os outros 6 dias ainda maturam
  assert.match(let1.children[2].textContent, /80%\s*48 de 60 · voltaram 12/);
  assert.match(x.document.querySelector('#ranking-rotulo').textContent, /resolutivos maduros até/);
  assert.match(let1.children[4].textContent, /≈ 3/);
  // T. resposta em expediente: mediana ponderada 5min, 90% em até 8 min → verde; Adão 20min → vermelho
  assert.match(let1.children[5].textContent, /≈ 5min\s*90% em até 8 min · 280 resp\./);
  assert.ok(let1.children[5].querySelector('.st-bom'), '5 min bate a meta de 8');
  const adao = [...tb.querySelectorAll('tr')].find((tr) => /Adão/.test(tr.textContent));
  assert.ok(adao.children[5].querySelector('.st-ruim'), '20 min fica vermelho');
  assert.equal(x.txt('#area-chat .six2-val')[2], '10,0%');
  // ninguém respondeu = transferido sem resposta humana ÷ maduros: (60−40) + (40−40) + (30−30) = 20 ÷ 150 = 13,3%
  assert.equal(x.txt('#area-chat .six2-val')[3], '13,3%');
  assert.ok(x.document.querySelectorAll('#g-chat .g-barras rect').length > 0, 'padrão da aba Chat: CSAT semanal em barras de três níveis');
  x.document.querySelector('#area-chat .six2[data-m="kai_resolve"]').click();
  assert.match(x.document.querySelector('#g-chat-tit').textContent, /Kai resolve sozinho/);
  assert.ok(x.document.querySelectorAll('#g-chat polyline').length >= 1, 'o cartão clicado dirige o gráfico');
});

test('motivo × CSAT: ordem por volume, e-mail fora com etiqueta, base curta vira contagem', async () => {
  const x = await boot();
  const motivos = x.txt('#area-motivos tbody .mot-nome');
  // por volume: wismo 80/dia, outros 40/dia, pré-venda 30/dia
  assert.deepEqual(motivos, ['Cadê meu pedido', 'Outros', 'Pré-venda']);
  assert.match(x.document.querySelector('#motivos-rot').textContent, /175 por e-mail sem tag/);
  const linhas = x.txt('#area-motivos tbody tr');
  // Visão geral: 4 colunas (motivo, contatos, Δ, CSAT)
  assert.equal(x.document.querySelectorAll('#area-motivos thead th').length, 4);
  // Pré-venda (só Fishermans): 100% bom com 210 avaliações
  assert.match(linhas[2], /100%/);
  // o corte Kai × pessoa mora na aba Chat: WISMO com o Kai tem 28 avaliações → contagem, não percentual
  assert.match(x.txt('#area-motivos-kai tbody tr')[0], /28 aval\./);
  // WISMO tem 53% do chat e CSAT bom 55%, sem subir: não é 'atacar'; nada marcado nesta fixture
  assert.equal(x.document.querySelectorAll('#area-motivos tr.mot-atacar').length, 0);
  // "outros" com 27% do chat (40 de 150 por dia): etiqueta de alerta de classificação no cabeçalho
  assert.match(x.document.querySelector('#motivos-rot').textContent, /“outros” 27%/);
  // trocar canal para Instagram: sem linha → tabela vazia mas sem tela branca
  x.document.querySelector('#seg-canal-motivo [data-canal="instagram"]').click();
  assert.equal(x.document.querySelectorAll('#area-motivos tbody tr').length, 0);
  assert.match(x.document.querySelector('#area-motivos').textContent, /Todos os motivos/);
});

test('filtro de marca recorta os seis números e o CSAT; RA vazio mostra estado vazio, não zero', async () => {
  const x = await boot(fixture(), '?periodo=7d&marca=fishermans');
  assert.equal(x.txt('#area-seis .six2-val')[0], '—');        // sem pedidos → sem razão
  assert.equal(x.txt('#area-seis .six2-val')[2], '100%');     // só pré-venda, tudo bom
  assert.equal(x.txt('#area-seis .six2-val')[1], '—');
  // Kai × pessoa vive no ⓘ do cartão de CSAT da aba Chat
  assert.match(x.document.querySelector('#area-chat .six2[data-m="csat_bom"]').getAttribute('title'), /passou por pessoa/);
  assert.match(x.document.querySelector('#area-ra').textContent, /Sem leitura do Reclame AQUI/);
  assert.doesNotMatch(x.document.querySelector('#area-ra').textContent, /0%/);
  // cartões do RA sem leitura: traço, nunca zero
  assert.deepEqual([...new Set(x.txt('#area-ra-num .six2-val'))], ['—']);
  assert.match(x.document.querySelector('#ra-rotulo').textContent, /sem coleta/);
});

test('com pedidos e RA na API, os cartões viram razão por pedido e índices com critérios RA1000', async () => {
  const ds = dias(45);
  const x = await boot(fixture({
    cx_pedidos: ds.flatMap((d) => [{ marca: 'aristocrata', dia: d, pedidos: 500 }, { marca: 'fishermans', dia: d, pedidos: 100 }]),
    // aguardando = régua de 6 meses da página; pendentes_agora = fila real (o que o time vê no RA Empresas)
    cx_ra: [{ marca: 'aristocrata', dia: HOJE, nota: 7.0, resposta_pct: 86.2, solucao_pct: 85.0, voltaria_pct: 57.2, avaliacoes: 486, aguardando: 103, pendentes_agora: 260, periodo_ini: '2026-03-01', periodo_fim: '2026-08-31', tempo_resposta_dias: 16 },
            { marca: 'fishermans', dia: HOJE, nota: 8.1, resposta_pct: 99.5, solucao_pct: 71.0, voltaria_pct: 80, avaliacoes: 60, aguardando: 0, pendentes_agora: 2, periodo_ini: '2026-03-01', periodo_fim: '2026-08-31', tempo_resposta_dias: 2 }],
  }), '?periodo=7d&marca=aristocrata');
  // Aristocrata 7d: 145 contatos/dia (60+20+40+25) → 1.015 ÷ 3.500 pedidos = 29,0
  assert.equal(x.txt('#area-seis .six2-val')[0], '29,0');
  // WISMO 80/dia → 560 ÷ 3.500 = 16,0%
  assert.equal(x.txt('#area-seis .six2-val')[1], '16,0%');
  // RA: a nota da empresa como número, a composição do RA1000 embaixo com ✓/✗
  assert.equal(x.txt('#area-seis .six2-val')[5], '7,0/10');
  const comp = x.document.querySelector('#area-seis .six2[data-m="ra_nota"] .six2-comp').textContent;
  assert.match(comp, /resp\. 86% ✗/); assert.match(comp, /486 aval\. ✓/); assert.match(comp, /260 sem resposta/); assert.doesNotMatch(comp, /103/);
  assert.ok(x.document.querySelectorAll('#g-geral polyline').length >= 1, 'com pedidos o gráfico padrão traça a razão por semana');
  x.document.querySelector('#area-seis .six2[data-m="ra_nota"]').click();
  assert.match(x.document.querySelector('#g-geral-tit').textContent, /por leitura/);
  // aba RA: seis critérios como cartões, tabela por marca com o veredito
  assert.deepEqual(x.txt('#area-ra-num .six2-val'), ['7,0', '86,2%', '85,0%', '57,2%', '486', '260']);
  assert.match(x.document.querySelector('#area-ra-num .six2[data-m="pendentes_agora"] .six2-chip').textContent, /fila real · na régua: 103/);
  assert.match(x.document.querySelector('#ra-tab-rot').textContent, /faltam 3 de 5/);
  assert.match(x.document.querySelector('#ra-rotulo').textContent, /régua do RA: 01\/03–31\/08/);
  assert.match(x.document.querySelector('#ra-rotulo').textContent, /2 fora do alvo.*2 em atenção/);
  assert.match(x.document.querySelector('#area-ra').textContent, /16 d/);
  assert.match(x.document.querySelector('#area-ra').textContent, /260\s*régua 103/);
  assert.match(x.document.querySelector('#g-ra').textContent, /Uma leitura só/);
});

test('período sem dado em cx_csat cai para a última janela existente e diz que caiu', async () => {
  const f = fixture();
  f.cx_csat = f.cx_csat.filter((l) => l.dia <= '2026-09-05');
  const x = await boot(f, '?periodo=hoje');
  assert.match(x.document.querySelector('#seis-rot').textContent, /período sem dado — mostrando 05\/09/);
  assert.equal(x.document.querySelectorAll('#area-seis .six2').length, 6);
  assert.notEqual(x.txt('#area-seis .six2-val')[2], '—');
});

test('sem o bloco cx_csat na API, o painel avisa e o resto continua', async () => {
  const f = fixture(); delete f.cx_csat;
  const x = await boot(f);
  assert.match(x.document.querySelector('#area-seis').textContent, /ainda não devolve/);
  assert.equal(x.document.querySelectorAll('#area-chat .six2').length, 7);
  assert.match(x.document.querySelector('#area-desfecho').textContent, /Kai resolve sozinho/);
  assert.equal(x.txt('#area-chat .six2-val')[2], '—', 'sem cx_csat não há desfecho maduro: traço, nunca zero');
});

test('abas: visão geral por padrão, hash abre a aba certa e o clique troca sem refazer a página', async () => {
  const x = await boot();
  const visiveis = () => [...x.document.querySelectorAll('.aba-pane')].filter((p) => !p.hidden).map((p) => p.dataset.aba);
  assert.deepEqual(visiveis(), ['geral']);
  assert.equal(x.document.querySelector('#abas-cx .ativo').dataset.aba, 'geral');
  x.document.querySelector('#abas-cx [data-aba="chat"]').click();
  assert.deepEqual(visiveis(), ['chat']);
  assert.equal(x.document.querySelectorAll('#area-chat .six2').length, 7, 'a aba escondida já estava pintada');
  const y = await boot(fixture(), '?periodo=7d', '#aba=ra');
  assert.deepEqual([...y.document.querySelectorAll('.aba-pane')].filter((p) => !p.hidden).map((p) => p.dataset.aba), ['ra']);
  // aba Trocas: grão mensal — mês fechado (ago) nos cartões, fila em análise de agora, tabela mês × marca e motivos
  assert.deepEqual(x.txt('#area-trocas-num .six2-rot'), ['Reversas · ago/26', 'set/26 até hoje', 'Em análise agora', 'Até aprovar', 'Devolução (dinheiro)', 'Valor em reversa · ago/26']);
  assert.deepEqual(x.txt('#area-trocas-num .six2-val'), ['120', '20', '77', '≈ 4,0 d', '50%', 'R$ 11.200']);
  assert.match(x.document.querySelector('#area-trocas-num .six2[data-m="analise"] .six2-chip').textContent, /62 há mais de 7 dias/);
  assert.ok(x.document.querySelector('#area-trocas-num .six2[data-m="analise"]').classList.contains('st-ruim'), '62 paradas há mais de 7 dias é vermelho');
  assert.match(x.document.querySelector('#trocas-rotulo').textContent, /leitura de 10\/09/);
  assert.match(x.document.querySelector('#area-trocas').textContent, /ago\/26.*O Aristocrata.*90/s);
  assert.match(x.document.querySelector('#area-trocas-motivo').textContent, /Recebi um produto diferente do que pedi/);
  assert.ok(x.document.querySelectorAll('#g-trocas .g-barras rect, #g-trocas rect').length > 0, 'gráfico padrão: reversas por mês em barras');
  // um gráfico por aba, dirigido pelo cartão ativo
  assert.equal(x.document.querySelectorAll('.aba-pane[data-aba="geral"] svg').length, 0, 'sem pedidos, a visão geral mostra aviso em vez de gráfico');
  assert.equal(x.document.querySelectorAll('.aba-pane[data-aba="chat"] svg').length, 1);
  x.document.querySelector('#area-chat .six2[data-m="contatos"]').click();
  assert.match(x.document.querySelector('#g-chat-tit').textContent, /por semana e motivo/);
  assert.equal(x.document.querySelectorAll('#g-chat rect').length > 0, true);
  assert.match(x.document.querySelector('#g-ra').textContent, /Sem leitura ainda/);
  // NPS e Comentários: cinco cartões cada, tabela por marca
  assert.equal(x.document.querySelectorAll('#area-nps-num .six2').length, 5);
  assert.equal(x.document.querySelectorAll('#area-social-num .six2').length, 5);
  const z = await boot(fixture(), '?periodo=7d', '#aba=inexistente');
  assert.deepEqual([...z.document.querySelectorAll('.aba-pane')].filter((p) => !p.hidden).map((p) => p.dataset.aba), ['geral']);
});
