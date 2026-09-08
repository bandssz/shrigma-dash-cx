const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const G = require('../growth-data.js');

const DIA = '2026-09-07';
const campanha = (overrides = {}) => ({
  marca: 'fish', canal: 'email', campanha_id: 1, nome: 'Campanha fictícia',
  enviado_em: DIA + 'T12:00:00Z', tipo: 'enviada', publico: 100,
  enviados: 100, entregues: 100, abriram: 20, clicaram: 10, hard: 0, complaints: 0,
  ...overrides,
});
const conversao = (overrides = {}) => ({
  marca: 'fish', canal: 'email', dia: DIA, utm_medium: 'campanha',
  utm_campaign: 'campanha-ficticia', utm_content: 'peca-a',
  pedidos_ultimo: 1, receita_ultimo: 100, pedidos_assistido: 2,
  receita_assistida: 50, clientes_novos: 1, clientes_recorrentes: 0,
  ...overrides,
});

test('mês passado e limites de data são iguais em Brasília, UTC e Tóquio', () => {
  const modulePath = path.resolve(__dirname, '../growth-data.js');
  for (const TZ of ['America/Sao_Paulo', 'UTC', 'Asia/Tokyo']) {
    const script = `const G=require(${JSON.stringify(modulePath)});process.stdout.write(JSON.stringify([
      G.preset('mesant','2026-09-07'),G.preset('mesant','2026-01-01'),
      G.preset('mesant','2024-03-03'),G.addDias('2026-08-31',1)]));`;
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ }, encoding: 'utf8',
    }));
    assert.deepEqual(actual, [
      { ini: '2026-08-01', fim: '2026-08-31' },
      { ini: '2025-12-01', fim: '2025-12-31' },
      { ini: '2024-02-01', fim: '2024-02-29' }, '2026-09-01',
    ], TZ);
  }
  assert.equal(G.diaBR('2026-09-08T00:30:00Z'), DIA);
});

test('delta não transforma ausência em queda e preserva zero medido', () => {
  for (const missing of [null, undefined, '', NaN, Infinity]) {
    assert.equal(G.delta(missing, 12, true), null);
    assert.equal(G.delta(12, missing, true), null);
  }
  assert.equal(G.delta(0, 12, true), -100);
  assert.equal(G.delta(12, 0, true), null);
  assert.equal(G.delta(12, 10, false), null);
  assert.equal(G.delta(12, 10, true), 20);
});

test('régua distingue canal na mesma peça e mantém o legado SES como e-mail', () => {
  const row = { marca: 'fish', dia: DIA, flow: 'pedido', piece: 'pago', pedidos_ultimo: null };
  const api = { crm_fluxo: [
    { ...row, canal: 'email', enviados: 5 },
    { ...row, canal: 'whatsapp', enviados: 9 },
    { ...row, enviados: 2 },
    { ...row, marca: 'aristo', canal: 'whatsapp', enviados: 50 },
    { ...row, dia: '2026-09-06', canal: 'whatsapp', enviados: 60 },
  ] };
  const all = G.regua(api, 'fish', DIA, DIA);
  assert.equal(all.length, 2);
  assert.equal(all.find(r => r.canal === 'email').enviados, 7);
  assert.equal(all.find(r => r.canal === 'whatsapp').enviados, 9);
  assert.equal(G.regua(api, 'fish', DIA, DIA, 'email')[0].enviados, 7);
  assert.equal(G.regua(api, 'fish', DIA, DIA, 'whatsapp')[0].pedidos, 0);
});

test('campanha × régua calcula apenas e-mail e não incorpora volume WhatsApp', () => {
  const api = {
    crm_campanha: [campanha(), campanha({ campanha_id: 2, canal: 'whatsapp', enviados: 900 })],
    crm_fluxo: [
      { marca: 'fish', dia: DIA, canal: 'email', flow: 'pedido', piece: 'pago', enviados: 10, pedidos_ultimo: 2, receita_ultimo: 20 },
      { marca: 'fish', dia: DIA, canal: 'whatsapp', flow: 'pedido', piece: 'pago', enviados: 900, pedidos_ultimo: 300, receita_ultimo: 9000 },
    ],
    crm_conversao: [conversao(), conversao({ canal: 'whatsapp', pedidos_ultimo: 900 })],
  };
  assert.deepEqual(G.campVsRegua(api, 'fish', DIA, DIA), {
    campanha: { env: 100, ped: 1, rec: 100, porMil: 10 },
    regua: { env: 10, ped: 2, rec: 20, porMil: 200 },
  });
});

test('receita do gráfico e KPI têm o mesmo recorte CRM, marca, período e canal', () => {
  const api = { crm_conversao: [
    conversao(), conversao({ canal: 'whatsapp', receita_ultimo: 200 }),
    conversao({ utm_medium: 'organico', receita_ultimo: 900 }),
    conversao({ canal: 'google', receita_ultimo: 700 }),
    conversao({ canal: null, receita_ultimo: 800 }),
    conversao({ marca: 'aristo', receita_ultimo: 500 }),
    conversao({ dia: '2026-09-06', receita_ultimo: 600 }),
  ] };
  for (const [canal, value] of [['todos', 300], ['email', 100], ['whatsapp', 200]]) {
    const conv = G.conversao(api, 'fish', DIA, DIA, 'peca', canal);
    assert.equal(G.totais([], conv).receita, value);
    assert.equal(G.serie(api, 'fish', DIA, DIA, 'receita', canal)[0].v, value);
  }
  assert.equal(G.conversao(api, 'fish', DIA, DIA, 'campanha').length, 1);
  assert.equal(G.conversao(api, 'fish', DIA, DIA, 'peca').length, 2);
});

test('série histórica Listmonk não aparece como cliques WhatsApp', () => {
  const api = { crm_diario: [
    { marca: 'fish', dia: DIA, janela: '1d', cliques: 12 },
    { marca: 'fish', dia: DIA, janela: '1d', canal: 'whatsapp', cliques: 3 },
    { marca: 'fish', dia: DIA, janela: '1d', canal: 'google', cliques: 900 },
    { marca: 'fish', dia: DIA, janela: '1d', canal: 'email', utm_medium: 'organico', cliques: 800 },
  ] };
  assert.equal(G.serie(api, 'fish', DIA, DIA, 'cliques', 'email')[0].v, 12);
  assert.equal(G.serie(api, 'fish', DIA, DIA, 'cliques', 'whatsapp')[0].v, 3);
  assert.equal(G.serie(api, 'fish', DIA, DIA, 'cliques')[0].v, 15);
  assert.equal(G.serie({}, 'fish', DIA, DIA, 'cliques', 'whatsapp')[0].v, null);
});

test('intradia sem canal fica indisponível; dimensão explícita permite comparação até a mesma hora', () => {
  const old = { crm_intradia: [{ marca: 'fish', dia: DIA, hora: 10, receita: 100 }] };
  for (const canal of ['todos', 'email', 'whatsapp'])
    assert.equal(G.serieHora(old, 'fish', DIA, 'receita', 10, canal), null);
  const api = { crm_intradia: [
    ...old.crm_intradia,
    { marca: 'fish', dia: DIA, hora: 10, canal: 'email', receita: 20 },
    { marca: 'fish', dia: DIA, hora: 10, canal: 'whatsapp', receita: 30 },
    { marca: 'fish', dia: DIA, hora: 11, canal: 'whatsapp', receita: 40 },
    { marca: 'fish', dia: DIA, hora: 10, canal: 'email', utm_medium: 'organico', receita: 900 },
  ] };
  const wa = G.serieHora(api, 'fish', DIA, 'receita', 10, 'whatsapp');
  assert.equal(wa[10].v, 30);
  assert.equal(wa[11].v, null);
  assert.equal(G.serieHora(api, 'fish', DIA, 'receita', 10)[10].v, 50);
});

test('cliques NULL não viram CTR zero e clique medido zero continua zero', () => {
  for (const [clicaram, expected] of [[null, null], [0, 0]]) {
    const cs = G.campanhas({ crm_campanha: [campanha({ clicaram })] }, 'fish', DIA, DIA);
    assert.equal(cs[0].ctr_pct, expected);
    assert.equal(G.totais(cs, []).ctr, expected);
    assert.equal(G.totais(cs, []).clicaram, expected);
  }
});

test('abertura, CTR e CTOR usam bases próprias quando a cobertura é parcial', () => {
  const cs = G.campanhas({ crm_campanha: [
    campanha({ campanha_id: 1, abriram: 20, clicaram: null }),
    campanha({ campanha_id: 2, abriram: null, clicaram: 5 }),
    campanha({ campanha_id: 3, abriram: 10, clicaram: 2 }),
  ] }, 'fish', DIA, DIA);
  const tot = G.totais(cs, []);
  assert.equal(tot.abriram, 30);
  assert.equal(tot.clicaram, 7);
  assert.equal(tot.abertura, 15);
  assert.equal(tot.ctr, 3.5);
  assert.equal(tot.ctor, 20);
  assert.equal(tot.baseAbertura, 200);
  assert.equal(tot.baseCliques, 200);
  assert.equal(tot.medidasConjuntas, 1);
});

test('grupos UTM preservam receita acumulada e não colidem entre marcas', () => {
  const api = {
    crm_campanha: [campanha(), campanha({ campanha_id: 2 }), campanha({ marca: 'aristo' })],
    crm_campanha_grupo: [
      { marca: 'fish', grupo: 'mesmo-id-local', campanha_ids: [1, 2], pedidos: 3, receita: 300 },
      { marca: 'aristo', grupo: 'mesmo-id-local', campanha_ids: [1], pedidos: 4, receita: 400 },
    ],
  };
  const cs = G.campanhas(api, 'todas', DIA, DIA);
  assert.equal(cs.length, 2);
  assert.equal(cs.find(c => c.marca === 'fish').enviados, 200);
  assert.equal(cs.find(c => c.marca === 'fish').rec.receita, 300);
  assert.equal(cs.find(c => c.marca === 'aristo').rec.receita, 400);
  assert.equal(G.campanhas(api, 'todas', DIA, DIA, false).length, 3);
});

test('grupo com clique parcial não mostra taxa sobre o total enviado', () => {
  const api = {
    crm_campanha: [campanha(), campanha({ campanha_id: 2, clicaram: null })],
    crm_campanha_grupo: [{ marca: 'fish', grupo: 'grupo-a', campanha_ids: [1, 2], receita: 300 }],
  };
  const cs = G.campanhas(api, 'fish', DIA, DIA);
  assert.equal(cs[0].enviados, 200);
  assert.equal(cs[0].abertura_pct, 20);
  assert.equal(cs[0].ctr_pct, null);
  assert.equal(cs[0].ctor_pct, null);
  assert.equal(G.totais(cs, []).ctr, null);
});

test('agendadas não entram nos totais e os filtros de campanha/fila isolam canal', () => {
  const api = { crm_campanha: [
    campanha(), campanha({ campanha_id: 2, canal: 'whatsapp' }),
    campanha({ campanha_id: 3, tipo: 'agendada' }),
    campanha({ campanha_id: 4, tipo: 'agendada', canal: 'whatsapp' }),
  ] };
  assert.equal(G.campanhas(api, 'fish', DIA, DIA, true, 'email').length, 1);
  assert.equal(G.campanhas(api, 'fish', DIA, DIA, true, 'whatsapp').length, 1);
  assert.equal(G.fila(api, 'fish', 'email')[0].campanha_id, 3);
  assert.equal(G.fila(api, 'fish', 'whatsapp')[0].campanha_id, 4);
});

test('A/B busca marca + ID local e não transforma clique ausente em fracasso', () => {
  const api = { crm_campanha: [
    campanha({ marca: 'aristo', clicaram: 70 }), campanha({ clicaram: 10 }),
  ] };
  assert.deepEqual(G.metricaDoBraco(api, { marca: 'fish', metrica_primaria: 'ctr' }, { campanha_id: 1 }), {
    n: 100, x: 10, rot: 'CTR',
  });
  const missing = { crm_campanha: [campanha({ clicaram: null })] };
  for (const metrica_primaria of ['ctr', 'ctor'])
    assert.equal(G.metricaDoBraco(missing, { marca: 'fish', metrica_primaria }, { campanha_id: 1 }), null);
});
