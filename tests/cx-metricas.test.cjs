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

// ---------- por agente (18/09): descarte fora, maduro por dia, janela que cai para o maduro ----------
test('agenteAgg: descarte não é trabalho; resolutivos/dia divide pelos dias maduros; % só com base ≥ 30', () => {
  const rows = [
    { marca: 'aristocrata', dia: '2026-09-01', agente_id: 'a', agente_nome: 'Ana', fechados: 50, descartes: 20, efetivos: 30, maduros: 30, resolutivos: 24, voltaram: 6, msgs_humanas: 60, msgs_cliente: 150, csat_avaliados: 30, csat_bom: 15, csat_ruim: 9 },
    { marca: 'aristocrata', dia: '2026-09-02', agente_id: 'a', agente_nome: 'Ana', fechados: 40, descartes: 0, efetivos: 40, maduros: 0, resolutivos: 0, voltaram: 0, msgs_humanas: 80, msgs_cliente: 160, csat_avaliados: 10, csat_bom: 5, csat_ruim: 1 },
    { marca: 'fishermans', dia: '2026-09-01', agente_id: 'b', agente_nome: 'Bia', fechados: 10, descartes: 1, efetivos: 9, maduros: 9, resolutivos: 9, voltaram: 0, msgs_humanas: 9, msgs_cliente: 9, csat_avaliados: 2, csat_bom: 2, csat_ruim: 0 },
  ];
  const [ana, bia] = M.agenteAgg(rows, { marca: 'todas', ini: '2026-09-01', fim: '2026-09-02' });
  assert.equal(ana.nome, 'Ana');
  assert.equal(ana.fechados, 90); assert.equal(ana.descartes, 20); assert.equal(ana.efetivos, 70);
  assert.equal(ana.dias, 2); assert.equal(ana.diasMaduros, 1);
  assert.equal(ana.resolutivosDia, 24, 'só o dia maduro entra no divisor');
  assert.equal(ana.fechadosDia, 35, 'efetivos por dia com fechamento');
  assert.equal(ana.pctVoltou, 20);
  assert.equal(ana.msgsClientePorAt, 310 / 70);
  assert.equal(ana.pctCsatBom, 50); assert.equal(ana.pctCsatRuim, 25);
  assert.equal(ana.pctDescartes, (20 / 90) * 100);
  assert.equal(bia.pctVoltou, null, 'base < 30 não vira %'); assert.equal(bia.pctCsatBom, null); assert.equal(bia.pctDescartes, null);
  assert.equal(bia.resolutivosDia, 9);
});
test('agenteTime: chegam por dia útil (seg–sex), Olivas fora, saldo contra o que o time resolve', () => {
  const ag = M.agenteAgg([
    { marca: 'aristocrata', dia: '2026-09-01', agente_id: 'a', agente_nome: 'Ana', fechados: 60, descartes: 0, efetivos: 60, maduros: 60, resolutivos: 40, voltaram: 20, msgs_humanas: 120, msgs_cliente: 300, csat_avaliados: 40, csat_bom: 20, csat_ruim: 10 },
  ], { marca: 'todas', ini: '2026-08-31', fim: '2026-09-04' });   // seg–sex = 5 dias úteis
  const handoff = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].flatMap((d) => [
    { marca: 'aristocrata', canal: 'whatsapp', dia: d, tickets: 100, chegam_humano: 50, wismo: 10 },
    { marca: 'olivas', canal: 'whatsapp', dia: d, tickets: 5, chegam_humano: 5, wismo: 0 }]);
  const t = M.agenteTime(ag, handoff, { marca: 'todas', ini: '2026-08-31', fim: '2026-09-04' });
  assert.equal(t.diasUteis, 5);
  assert.equal(t.chegam, 250, 'domingo 30/08 fora da janela; Olivas fora');
  assert.equal(t.chegamDia, 50);
  assert.equal(t.resolutivosDia, 8);
  assert.equal(t.pctVoltou, (20 / 60) * 100); assert.equal(t.pctCsatBom, 50);
});
test('agenteTime: votos de agentes com base curta entram no CSAT do time antes da guarda de amostra', () => {
  const f = { marca: 'todas', ini: '2026-09-01', fim: '2026-09-01' };
  const row = (id, avaliados, bom, ruim) => ({ marca: 'aristocrata', dia: '2026-09-01', agente_id: id,
    agente_nome: id, fechados: 40, descartes: 0, efetivos: 40, maduros: 40, resolutivos: 35, voltaram: 5,
    msgs_humanas: 80, msgs_cliente: 80, csat_avaliados: avaliados, csat_bom: bom, csat_ruim: ruim });
  const agrega = (rows) => {
    const agentes = M.agenteAgg(rows, f);
    return { agentes, time: M.agenteTime(agentes, [], f) };
  };
  const boas = agrega([row('a', 20, 20, 0), row('b', 20, 20, 0)]);
  assert.ok(boas.agentes.every((a) => a.pctCsatBom === null && a.pctCsatRuim === null), 'base individual curta continua sem percentual');
  assert.equal(boas.time.csatAvaliados, 40);
  assert.equal(boas.time.csatBom, 40);
  assert.equal(boas.time.pctCsatBom, 100, '40 votos bons não viram zero só porque nenhum agente tem 30');
  assert.equal(boas.time.pctCsatRuim, 0);

  const mista = agrega([row('a', 10, 4, 3), row('b', 40, 20, 10)]);
  assert.equal(mista.time.csatAvaliados, 50);
  assert.equal(mista.time.csatBom, 24);
  assert.equal(mista.time.csatRuim, 13);
  assert.equal(mista.time.pctCsatBom, 48, 'peso é quantidade de votos, incluindo a base curta');
  assert.equal(mista.time.pctCsatRuim, 26, 'ruins também preservados; neutros ficam no denominador');

  const curta = agrega([row('a', 10, 4, 3), row('b', 19, 9, 5)]);
  assert.equal(curta.time.csatAvaliados, 29);
  assert.equal(curta.time.pctCsatBom, null, 'time com menos de 30 também continua sem percentual');
  assert.equal(curta.time.pctCsatRuim, null);
  const limite = agrega([row('a', 10, 4, 3), row('b', 20, 11, 6)]);
  assert.equal(limite.time.pctCsatBom, 50, '30 votos liberam a apresentação do consolidado');
  assert.equal(limite.time.pctCsatRuim, 30);
  const vazio = agrega([row('a', 0, 0, 0)]);
  assert.equal(vazio.time.pctCsatBom, null, 'ausência de votos não é satisfação zero');
  assert.equal(vazio.time.pctCsatRuim, null);
});
test('cxJanelaMadura: corta no teto de 7 dias; sem 3 dias úteis maduros cai para 10 dias úteis e avisa', () => {
  const hoje = '2026-09-10';
  assert.deepEqual(M.cxJanelaMadura({ ini: '2026-08-20', fim: '2026-09-09' }, hoje), { ini: '2026-08-20', fim: '2026-09-03', caiu: false, cortou: true, teto: '2026-09-03' });
  const q = M.cxJanelaMadura({ ini: '2026-09-03', fim: '2026-09-09' }, hoje);
  assert.equal(q.caiu, true); assert.equal(q.fim, '2026-09-03'); assert.equal(q.ini, '2026-08-21');
  assert.equal(M.cxDiasUteis(q.ini, q.fim).length, 10);
  assert.equal(M.cxJanelaMadura({ ini: '2026-08-01', fim: '2026-08-31' }, hoje).cortou, false);
});

// --- Idade da leitura do Reclame AQUI (21/09/2026) ---------------------------------
// O RA recusa leitura de servidor (Cloudflare devolve desafio), então a coleta só avança
// quando alguém roda o favorito. O painel precisa marcar a idade em vez de exibir número velho
// como se fosse de hoje.
test('raIdade classifica hoje e ontem como leitura fresca', () => {
  const hoje = M.raIdade('2026-09-21', '2026-09-21');
  assert.equal(hoje.dias, 0);
  assert.equal(hoje.velha, false);
  assert.equal(hoje.classe, 'nota');
  const ontem = M.raIdade('2026-09-20', '2026-09-21');
  assert.equal(ontem.dias, 1);
  assert.equal(ontem.velha, false, 'um dia ainda é leitura corrente');
  assert.equal(ontem.classe, 'nota');
});

test('raIdade marca leitura de dois dias ou mais como velha', () => {
  const doisDias = M.raIdade('2026-09-19', '2026-09-21');
  assert.equal(doisDias.dias, 2);
  assert.equal(doisDias.velha, true);
  assert.equal(doisDias.classe, 'alerta', 'dois dias já vira etiqueta de alerta');
  const semana = M.raIdade('2026-09-14', '2026-09-21');
  assert.equal(semana.dias, 7);
  assert.equal(semana.velha, true);
});

test('raIdade aceita timestamp completo e ignora o horário', () => {
  const a = M.raIdade('2026-09-18T11:37:54.756Z', '2026-09-21T23:59:00.000Z');
  assert.equal(a.dia, '2026-09-18');
  assert.equal(a.dias, 3);
  assert.equal(a.velha, true);
});

test('raIdade devolve null sem leitura e não inventa data', () => {
  assert.equal(M.raIdade(null, '2026-09-21'), null);
  assert.equal(M.raIdade('', '2026-09-21'), null);
  assert.equal(M.raIdade(undefined, '2026-09-21'), null);
});

test('raIdade sem hoje explícito usa o dia corrente em São Paulo', () => {
  const hoje = M.cxHojeSP();
  assert.match(hoje, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(M.raIdade(hoje).dias, 0, 'leitura do dia corrente não pode aparecer como atrasada');
});
