const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../cx-metricas.js');

// fixture sintética: dois dias, duas marcas, três canais
const linha = (o) => ({ marca: 'aristocrata', canal: 'whatsapp', dia: '2026-09-01', motivo: 'wismo', escalado: true,
  tickets: 0, csat_enviado: 0, avaliadas: 0, bom: 0, neutro: 0, ruim: 0, kai_pode_atender: 0, abertos: 0, ...o });
const ROWS = [
  linha({ tickets: 100, csat_enviado: 80, avaliadas: 40, bom: 20, neutro: 10, ruim: 10 }),
  linha({ escalado: false, tickets: 50, csat_enviado: 40, avaliadas: 10, bom: 8, neutro: 1, ruim: 1 }),
  linha({ motivo: 'pre-venda', tickets: 30, avaliadas: 30, bom: 30 }),
  linha({ canal: 'email', motivo: 'sem-tag', tickets: 25 }),
  linha({ dia: '2026-08-31', tickets: 200, avaliadas: 100, bom: 30, neutro: 30, ruim: 40 }),
  linha({ marca: 'fishermans', tickets: 10, avaliadas: 5, bom: 5 }),
];
const F = { marca: 'aristocrata', ini: '2026-09-01', fim: '2026-09-01' };

test('csatAgg soma três níveis e só dá percentual com base >= 30', () => {
  const a = M.csatAgg(ROWS, { ...F, canais: ['whatsapp'] });
  assert.equal(a.tickets, 180);
  assert.equal(a.avaliadas, 80);
  assert.equal(Math.round(a.pctBom), 73); // (20+8+30)/80
  assert.equal(Math.round(a.pctRuim), 14);
  const curta = M.csatAgg(ROWS, { ...F, escalado: false });
  assert.equal(curta.avaliadas, 10);
  assert.equal(curta.pctBom, null, 'base curta não vira percentual');
  assert.equal(curta.pctResposta, 20, 'resposta é sobre tickets, não sobre csat enviado');
});

test('e-mail fica fora do Kai e do motivo, mas entra nos contatos', () => {
  const kp = M.csatKaiVsPessoa(ROWS, F);
  assert.equal(kp.todos.tickets, 180);
  assert.equal(kp.pessoa.tickets, 130);
  assert.equal(kp.kai.tickets, 50);
  const pm = M.porMotivo(ROWS, F);
  assert.equal(pm.email.tickets, 25);
  assert.ok(!pm.linhas.some((l) => l.motivo === 'sem-tag'), 'sem-tag do e-mail não aparece como motivo do chat');
  const cpp = M.contatosPorPedido(ROWS, [{ marca: 'aristocrata', dia: '2026-09-01', pedidos: 500 }], F);
  assert.equal(cpp.contatos, 205, 'contatos = todos os canais');
  assert.equal(cpp.por100, 41);
  assert.equal(cpp.wismo, 150);
  assert.equal(cpp.wismoRate, 30);
  assert.equal(cpp.janelaCurta, true);
});

test('sem pedidos, a razão é null e sobra contatos/dia — nunca zero', () => {
  const cpp = M.contatosPorPedido(ROWS, [], F);
  assert.equal(cpp.pedidos, null);
  assert.equal(cpp.por100, null);
  assert.equal(cpp.wismoRate, null);
  assert.equal(cpp.contatosDia, 205);
});

test('porMotivo: ordem fixa, share e delta contra período anterior', () => {
  const pm = M.porMotivo(ROWS, F, { marca: 'aristocrata', ini: '2026-08-31', fim: '2026-08-31' });
  assert.deepEqual(pm.linhas.map((l) => l.motivo), ['wismo', 'pre-venda']);
  const w = pm.linhas[0];
  assert.equal(w.tickets, 150);
  assert.equal(w.anterior, 200);
  assert.equal(w.delta, -25);
  assert.equal(Math.round(w.share), 83);
  assert.equal(w.kaiTickets, 50);
  assert.equal(w.pessoaBom, 50);
  assert.equal(w.kaiBom, null, 'Kai com 10 avaliadas não vira %');
  const pv = pm.linhas[1];
  assert.equal(pv.anterior, 0);
  assert.equal(pv.delta, null, 'sem base anterior não há delta');
});

test('série semanal: semana começa na segunda e semana parcial é marcada', () => {
  assert.equal(M.cxSegunda('2026-09-06'), '2026-08-31'); // domingo -> segunda anterior
  assert.equal(M.cxSegunda('2026-08-31'), '2026-08-31');
  const s = M.serieCsatSemanal(ROWS, { marca: 'aristocrata', ini: '2026-08-31', fim: '2026-09-01' }, '2026-09-01');
  assert.equal(s.length, 1);
  assert.equal(s[0].semana, '2026-08-31');
  assert.equal(s[0].parcial, true);
  assert.equal(Math.round(s[0].pctBom), 49); // (30+20+8+30)/(100+40+10+30)
});

test('RA: última linha por marca e critérios RA1000', () => {
  const ra = [
    { marca: 'aristocrata', dia: '2026-09-10', nota: 7.0, resposta_pct: 86.2, solucao_pct: 85.0, voltaria_pct: 57.2, avaliacoes: 486 },
    { marca: 'aristocrata', dia: '2026-09-11', nota: 7.1, resposta_pct: 91, solucao_pct: 90, voltaria_pct: 70, avaliacoes: 490 },
    { marca: 'fishermans', dia: '2026-09-11', nota: 8, resposta_pct: 99.5, solucao_pct: 71, voltaria_pct: 80, avaliacoes: 60 },
  ];
  const u = M.raUltimo(ra, 'aristocrata', '2026-09-12');
  assert.equal(u.dia, '2026-09-11');
  assert.equal(M.raAvalia(u).ra1000, true);
  const ate = M.raUltimo(ra, 'aristocrata', '2026-09-10');
  assert.equal(M.raAvalia(ate).faltam, 3);
  assert.equal(M.raAvalia(M.raUltimo(ra, 'fishermans')).faltam, 1);
  assert.equal(M.raUltimo(ra, 'olivas'), null);
  assert.equal(M.raAvalia(null), null);
});

test('delta nunca inventa direção com dado ausente', () => {
  assert.equal(M.cxDelta(10, null), null);
  assert.equal(M.cxDelta(10, 0), null);
  assert.equal(M.cxDelta(15, 10), 50);
});

test('desfecho maduro: 2 dias de expediente (sex/sáb/dom não contam), Kai é fatia de TODOS os tickets, semana em maturação é parcial', () => {
  const { desfechoMaduro, serieSemanalDesfecho, cxFimMaduro } = require('../cx-metricas.js');
  // hoje = segunda 14/09: dias de expediente completos antes = qui 10 e qua 09 → maduro até terça 08
  assert.equal(cxFimMaduro('9999-12-31', '2026-09-14'), '2026-09-08');
  assert.equal(cxFimMaduro('9999-12-31', '2026-09-17'), '2026-09-14', 'quarta: seg e ter completos → maduro até segunda');
  const row = (dia, escalado, o) => ({ marca: 'aristocrata', canal: 'whatsapp', dia, motivo: 'wismo', escalado, tickets: 50, avaliadas: 0, bom: 0, neutro: 0, ruim: 0, ...o });
  const rows = ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'].flatMap((d) => [
    row(d, true, { resposta_humana: 20, kai_fechou: 0, fechado_inatividade: 0 }),   // 50 transferidos: 20 com pessoa, 30 sem ninguém
    row(d, false, { resposta_humana: 0, kai_fechou: 10, fechado_inatividade: 5 }),  // 50 não transferidos: 10 Kai, 5 inatividade, 35 abertos
    row(d, false, { canal: 'email', resposta_humana: 0, kai_fechou: 0, fechado_inatividade: 0 }),
  ]);
  const r = desfechoMaduro(rows, { marca: 'aristocrata', ini: '2026-09-06', fim: '2026-09-10' }, '2026-09-14');
  assert.equal(r.fim, '2026-09-08', 'corta no último dia maduro');
  assert.equal(r.tickets, 300, 'e-mail fora, 3 dias × 100');
  assert.equal(r.kai, 30); assert.equal(r.pessoa, 60); assert.equal(r.semResp, 90);
  assert.equal(Math.round(r.pctKai), 10); assert.equal(Math.round(r.pctSemResp), 30); assert.equal(Math.round(r.pctAberto * 10) / 10, 40);
  const so = desfechoMaduro(rows, { marca: 'aristocrata', ini: '2026-09-09', fim: '2026-09-10' }, '2026-09-14');
  assert.equal(so.maduro, false, 'período só com dias imaturos não tem desfecho');
  const s = serieSemanalDesfecho(rows, { marca: 'aristocrata', ini: '2026-08-31', fim: '2026-09-14' }, '2026-09-14');
  assert.deepEqual(s.semanas, ['2026-08-31', '2026-09-07', '2026-09-14']);
  assert.equal(s.pontos[0].parcial, false, 'semana de 31/08 fechou toda antes do teto');
  assert.equal(s.pontos[1].tickets, 200); assert.equal(s.pontos[1].parcial, true, 'semana de 07/09 passa do teto (08/09): parcial');
  assert.equal(s.pontos[2].y, null, 'semana atual sem dia maduro');
});
