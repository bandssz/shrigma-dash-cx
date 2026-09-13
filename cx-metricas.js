// ================== CX · MÉTRICAS NOVAS (camada de dados) ==================
// Funções puras sobre os blocos novos da API do painel de CX:
//   cx_csat    — view cx_csat_dia: marca × canal × dia × motivo × escalado
//                (tickets, csat_enviado, avaliadas, bom, neutro, ruim, kai_pode_atender, abertos)
//   cx_pedidos — cx_pedido_dia: marca × dia × pedidos (Shopify)
//   cx_ra      — cx_ra_dia: marca × dia × índices do Reclame Aqui (metatags da brand page)
// Nenhum DOM aqui — testável com `node --test tests/cx-metricas.test.cjs`.
//
// Regras que este arquivo respeita (não mude sem entender):
// 1. CSAT do Gleap tem TRÊS opções (2 ruim / 6 neutro / 10 bom). Nunca vira média:
//    o que se mostra é % bom / % neutro / % ruim sobre avaliadas.
// 2. Percentual só com base >= MIN_BASE (30) avaliadas. Abaixo disso devolve null e a
//    tela mostra a contagem.
// 3. Escalado = transferência real (processingTeam/processingUser). E-mail é SEMPRE
//    escalado pelo roteamento e não recebe tag de motivo: sai de qualquer conta de Kai
//    e de qualquer conta de motivo. Entra só no volume total de contatos.
// 4. Contatos por 100 pedidos usa pedidos CRIADOS no mesmo intervalo. Em janela curta
//    (< 7 dias) a razão é frágil: WISMO de hoje é sobre pedido de semana passada.
// 5. Delta entre períodos só quando os dois lados têm dado. Ausência nunca vira queda.

const CX_MIN_BASE = 30;

// ordem fixa (não é ranking): quem lê aprende a posição de cada motivo
const CX_MOTIVOS = [
  { k: "wismo",        r: "Cadê meu pedido",  curto: "WISMO" },
  { k: "pre-venda",    r: "Pré-venda",        curto: "Pré-venda" },
  { k: "problema",     r: "Problema",         curto: "Problema" },
  { k: "troca",        r: "Troca",            curto: "Troca" },
  { k: "cancelamento", r: "Cancelamento",     curto: "Cancel." },
  { k: "outros",       r: "Outros",           curto: "Outros" },
  { k: "sem-tag",      r: "Sem tag",          curto: "Sem tag" },
];
const CX_ROTULO_MOTIVO = Object.fromEntries(CX_MOTIVOS.map((m) => [m.k, m.r]));

// Kai não roda em e-mail; widget é resíduo (< 1%) mas é chat, fica.
const CX_CANAIS_KAI = ["whatsapp", "instagram", "widget"];

function cxDia(v) { return String(v || "").slice(0, 10); }

// filtro comum: {marca:'todas'|m, ini, fim, canais:[...]|null, escalado:true|false|null, motivo:k|null}
function cxFiltra(rows, f) {
  const out = [];
  for (const l of rows || []) {
    if (!l) continue;
    const dia = cxDia(l.dia);
    if (dia < f.ini || dia > f.fim) continue;
    if (f.marca && f.marca !== "todas" && l.marca !== f.marca) continue;
    if (f.canais && !f.canais.includes(l.canal)) continue;
    if (f.escalado === true && l.escalado !== true) continue;
    if (f.escalado === false && l.escalado !== false) continue;
    if (f.motivo && l.motivo !== f.motivo) continue;
    out.push(l);
  }
  return out;
}

const CX_CAMPOS = ["tickets", "csat_enviado", "avaliadas", "bom", "neutro", "ruim", "kai_pode_atender", "abertos"];
function cxSoma(rows) {
  const a = { tickets: 0, csat_enviado: 0, avaliadas: 0, bom: 0, neutro: 0, ruim: 0, kai_pode_atender: 0, abertos: 0, linhas: 0 };
  for (const l of rows) { a.linhas++; for (const k of CX_CAMPOS) a[k] += Number(l[k] || 0); }
  return a;
}

// agregado + percentuais prontos; pct = null quando a base é curta
function csatAgg(rows, f) {
  const a = cxSoma(cxFiltra(rows, f));
  const n = a.avaliadas;
  const ok = n >= CX_MIN_BASE;
  a.baseOk = ok;
  a.pctBom = ok ? (a.bom / n) * 100 : null;
  a.pctNeutro = ok ? (a.neutro / n) * 100 : null;
  a.pctRuim = ok ? (a.ruim / n) * 100 : null;
  // resposta = avaliadas / tickets (denominador é o contato, não o "csat enviado":
  // a tag é limpa para re-rating, então "enviado" subconta)
  a.pctResposta = a.tickets ? (n / a.tickets) * 100 : null;
  return a;
}

// CSAT do Kai sozinho × passou por pessoa, só nos canais em que o Kai atende
function csatKaiVsPessoa(rows, f) {
  const base = Object.assign({}, f, { canais: CX_CANAIS_KAI });
  return {
    kai: csatAgg(rows, Object.assign({}, base, { escalado: false })),
    pessoa: csatAgg(rows, Object.assign({}, base, { escalado: true })),
    todos: csatAgg(rows, base),
  };
}

// Volume e CSAT por motivo, com delta de volume contra o período anterior.
// Só canais do Kai: e-mail não tem tag (vira 'sem-tag' e é reportado à parte).
function porMotivo(rows, f, fAnt) {
  const base = Object.assign({}, f, { canais: f.canais || CX_CANAIS_KAI });
  const tot = csatAgg(rows, base);
  const ant = fAnt ? csatAgg(rows, Object.assign({}, fAnt, { canais: base.canais })) : null;
  const linhas = CX_MOTIVOS.map((m) => {
    const a = csatAgg(rows, Object.assign({}, base, { motivo: m.k }));
    const kai = csatAgg(rows, Object.assign({}, base, { motivo: m.k, escalado: false }));
    const pes = csatAgg(rows, Object.assign({}, base, { motivo: m.k, escalado: true }));
    const aa = ant ? csatAgg(rows, Object.assign({}, fAnt, { canais: base.canais, motivo: m.k })) : null;
    return {
      motivo: m.k, rotulo: m.r, curto: m.curto,
      tickets: a.tickets, share: tot.tickets ? (a.tickets / tot.tickets) * 100 : null,
      anterior: aa ? aa.tickets : null,
      delta: aa && aa.tickets > 0 ? ((a.tickets - aa.tickets) / aa.tickets) * 100 : null,
      avaliadas: a.avaliadas, bom: a.bom, neutro: a.neutro, ruim: a.ruim, pctResposta: a.pctResposta,
      pctBom: a.pctBom, pctNeutro: a.pctNeutro, pctRuim: a.pctRuim, baseOk: a.baseOk,
      kaiTickets: kai.tickets, kaiShare: a.tickets ? (kai.tickets / a.tickets) * 100 : null,
      kaiBom: kai.pctBom, kaiAvaliadas: kai.avaliadas,
      pessoaBom: pes.pctBom, pessoaAvaliadas: pes.avaliadas,
    };
  }).filter((l) => l.tickets > 0 || l.anterior > 0);
  // e-mail à parte: volume que existe mas não tem motivo
  const email = csatAgg(rows, Object.assign({}, f, { canais: ["email"] }));
  return { linhas, total: tot, anterior: ant, email };
}

// segunda-feira (ymd) da semana de um dia — mesma regra de app.js/growth
function cxSegunda(ymd) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Série semanal de CSAT (bom %) e taxa de resposta, no intervalo. Semana parcial marcada.
function serieCsatSemanal(rows, f, hoje) {
  const sel = cxFiltra(rows, Object.assign({}, f, { canais: f.canais || CX_CANAIS_KAI }));
  const por = {};
  for (const l of sel) {
    const s = cxSegunda(cxDia(l.dia));
    const a = por[s] || (por[s] = { semana: s, tickets: 0, avaliadas: 0, bom: 0, dias: new Set() });
    a.tickets += Number(l.tickets || 0); a.avaliadas += Number(l.avaliadas || 0); a.bom += Number(l.bom || 0);
    a.dias.add(cxDia(l.dia));
  }
  return Object.values(por).sort((x, y) => (x.semana < y.semana ? -1 : 1)).map((a) => ({
    semana: a.semana, tickets: a.tickets, avaliadas: a.avaliadas,
    pctBom: a.avaliadas >= CX_MIN_BASE ? (a.bom / a.avaliadas) * 100 : null,
    pctResposta: a.tickets ? (a.avaliadas / a.tickets) * 100 : null,
    parcial: a.dias.size < 7 && (hoje ? cxSegunda(hoje) === a.semana : false),
  }));
}

// ---------- contatos por pedido ----------
function somaPedidos(pedidos, marca, ini, fim) {
  let n = 0, dias = 0;
  for (const p of pedidos || []) {
    const dia = cxDia(p.dia);
    if (dia < ini || dia > fim) continue;
    if (marca !== "todas" && p.marca !== marca) continue;
    if (typeof p.pedidos === "number") { n += p.pedidos; dias++; }
  }
  return { pedidos: dias ? n : null, dias };
}

// contatos = TODOS os canais (e-mail inclusive). wismo = tag wismo (só chat: e-mail não tem tag,
// então o WISMO de e-mail fica de fora e a taxa é piso, não teto).
function contatosPorPedido(csatRows, pedidos, f) {
  const tudo = csatAgg(csatRows, Object.assign({}, f, { canais: null, escalado: null, motivo: null }));
  const wismo = csatAgg(csatRows, Object.assign({}, f, { canais: CX_CANAIS_KAI, escalado: null, motivo: "wismo" }));
  const ped = somaPedidos(pedidos, f.marca || "todas", f.ini, f.fim);
  const nDias = Math.round((new Date(f.fim + "T12:00Z") - new Date(f.ini + "T12:00Z")) / 864e5) + 1;
  return {
    contatos: tudo.tickets, wismo: wismo.tickets, pedidos: ped.pedidos, diasPedidos: ped.dias, dias: nDias,
    contatosDia: nDias ? tudo.tickets / nDias : null,
    wismoDia: nDias ? wismo.tickets / nDias : null,
    por100: ped.pedidos ? (tudo.tickets / ped.pedidos) * 100 : null,
    wismoRate: ped.pedidos ? (wismo.tickets / ped.pedidos) * 100 : null,
    wismoShare: tudo.tickets ? (wismo.tickets / tudo.tickets) * 100 : null,
    janelaCurta: nDias < 7,
  };
}

// ---------- Reclame Aqui ----------
// linha mais recente por marca até `fim` (a mais recente disponível se o período não tem)
function raUltimo(rows, marca, fim) {
  let melhor = null;
  for (const r of rows || []) {
    if (!r || r.marca !== marca) continue;
    const dia = cxDia(r.dia);
    if (fim && dia > fim) continue;
    if (!melhor || dia > cxDia(melhor.dia)) melhor = r;
  }
  return melhor;
}
// critérios RA1000 (blog do Reclame AQUI, confirmados 08/2026)
const CX_RA1000 = [
  ["nota", "Nota média", 7, 10, "nota"],
  ["resposta_pct", "Respondidas", 90, 100, "pct"],
  ["solucao_pct", "Índice de solução", 90, 100, "pct"],
  ["voltaria_pct", "Voltaria a fazer negócio", 70, 100, "pct"],
  ["avaliacoes", "Avaliações", 50, null, "int"],
];
function raAvalia(linha) {
  if (!linha) return null;
  const crit = CX_RA1000.map(([c, rot, min, max, tipo]) => {
    const v = linha[c] === null || linha[c] === undefined ? null : Number(linha[c]);
    return { c, rot, min, max, tipo, v, bate: typeof v === "number" && !Number.isNaN(v) && v >= min };
  });
  return { crit, ra1000: crit.every((x) => x.bate), faltam: crit.filter((x) => !x.bate).length };
}

// dias distintos com linha no intervalo (para não comparar contra período sem histórico)
function cxDiasComDado(rows, f) {
  const s = new Set();
  for (const l of cxFiltra(rows, { marca: f.marca, ini: f.ini, fim: f.fim })) s.add(cxDia(l.dia));
  return s.size;
}

// ---------- delta genérico ----------
function cxDelta(atual, anterior) {
  if (typeof atual !== "number" || typeof anterior !== "number" || anterior === 0) return null;
  return ((atual - anterior) / Math.abs(anterior)) * 100;
}

if (typeof module !== "undefined") {
  module.exports = { CX_MIN_BASE, CX_MOTIVOS, CX_ROTULO_MOTIVO, CX_CANAIS_KAI, CX_RA1000,
    cxFiltra, csatAgg, csatKaiVsPessoa, porMotivo, serieCsatSemanal, cxSegunda,
    somaPedidos, contatosPorPedido, raUltimo, raAvalia, cxDelta, cxDiasComDado };
}
