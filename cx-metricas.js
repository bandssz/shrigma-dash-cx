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

// ---------- séries no tempo para as abas (todas puras) ----------
// grupos de motivo para o gráfico (7 motivos viram 4 séries; cores fixas na tela)
const CX_GRUPOS_MOTIVO = [
  { k: "wismo", r: "Cadê meu pedido", motivos: ["wismo"] },
  { k: "pre-venda", r: "Pré-venda", motivos: ["pre-venda"] },
  { k: "resolucao", r: "Problema · troca · cancel.", motivos: ["problema", "troca", "cancelamento"] },
  { k: "outros", r: "Outros / sem tag", motivos: ["outros", "sem-tag"] },
];
// semanas (segunda) cobrindo [ini, fim]
function cxSemanas(ini, fim) {
  const out = []; let s = cxSegunda(ini);
  while (s <= fim) { out.push(s); const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 7); s = d.toISOString().slice(0, 10); }
  return out;
}
function cxDiasIntervalo(ini, fim) {
  const out = []; let d = ini;
  while (d <= fim) { out.push(d); const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); }
  return out;
}
// contatos por 100 pedidos, por dia, por marca (todos os canais; dias sem pedido = null)
function serieDiariaPor100(csatRows, pedidos, marcas, ini, fim) {
  const dias = cxDiasIntervalo(ini, fim);
  const cont = {}, ped = {};
  for (const l of cxFiltra(csatRows, { marca: "todas", ini, fim })) { const k = l.marca + "|" + cxDia(l.dia); cont[k] = (cont[k] || 0) + Number(l.tickets || 0); }
  for (const p of pedidos || []) { const d = cxDia(p.dia); if (d < ini || d > fim || typeof p.pedidos !== "number") continue; ped[p.marca + "|" + d] = (ped[p.marca + "|" + d] || 0) + p.pedidos; }
  return { dias, series: marcas.map((m) => ({ marca: m, pontos: dias.map((d) => {
    const c = cont[m + "|" + d], pd = ped[m + "|" + d];
    return { dia: d, y: pd ? ((c || 0) / pd) * 100 : null, contatos: c || 0, pedidos: pd || null };
  }) })) };
}
// contatos por semana por grupo de motivo (só chat)
function serieSemanalMotivos(rows, f) {
  const semanas = cxSemanas(f.ini, f.fim);
  const sel = cxFiltra(rows, Object.assign({}, f, { canais: f.canais || CX_CANAIS_KAI }));
  const acc = {};
  for (const l of sel) { const s = cxSegunda(cxDia(l.dia)); const g = CX_GRUPOS_MOTIVO.find((x) => x.motivos.includes(l.motivo)) || CX_GRUPOS_MOTIVO[3]; acc[s + "|" + g.k] = (acc[s + "|" + g.k] || 0) + Number(l.tickets || 0); }
  return { semanas, series: CX_GRUPOS_MOTIVO.map((g) => ({ k: g.k, nome: g.r, valores: semanas.map((s) => acc[s + "|" + g.k] || 0) })) };
}
// CSAT por semana em três níveis (contagens) — para a barra 100%
function serieSemanalCsat3(rows, f) {
  const semanas = cxSemanas(f.ini, f.fim);
  const sel = cxFiltra(rows, Object.assign({}, f, { canais: f.canais || CX_CANAIS_KAI }));
  const acc = {};
  for (const l of sel) { const s = cxSegunda(cxDia(l.dia)); const a = acc[s] || (acc[s] = { ruim: 0, neutro: 0, bom: 0, tickets: 0 }); a.ruim += Number(l.ruim || 0); a.neutro += Number(l.neutro || 0); a.bom += Number(l.bom || 0); a.tickets += Number(l.tickets || 0); }
  const g = (k) => semanas.map((s) => (acc[s] ? acc[s][k] : 0));
  return { semanas, ruim: g("ruim"), neutro: g("neutro"), bom: g("bom"), tickets: g("tickets"),
    pctBom: semanas.map((s) => { const a = acc[s]; const n = a ? a.ruim + a.neutro + a.bom : 0; return n >= CX_MIN_BASE ? (a.bom / n) * 100 : null; }) };
}
// Kai resolve sozinho por semana (cx_desfecho: resolvido_kai ÷ (resolvido_kai + escalado), sem e-mail)
function serieSemanalKai(desfecho, marca, ini, fim) {
  const semanas = cxSemanas(ini, fim); const acc = {};
  for (const l of desfecho || []) {
    const d = cxDia(l.dia); if (d < ini || d > fim || l.canal === "email") continue;
    if (marca !== "todas" && l.marca !== marca) continue;
    const s = cxSegunda(d); const a = acc[s] || (acc[s] = { kai: 0, esc: 0 }); a.kai += Number(l.resolvido_kai || 0); a.esc += Number(l.escalado || 0);
  }
  return { semanas, pontos: semanas.map((s) => { const a = acc[s]; const t = a ? a.kai + a.esc : 0; return { semana: s, y: t >= CX_MIN_BASE ? (a.kai / t) * 100 : null, n: t }; }) };
}
// NPS por semana por marca (votos: {marca:'aristo'|'fish'|'olivas', score, bucket, data})
function serieSemanalNps(votos, marcas, ini, fim, mapaMarca) {
  const semanas = cxSemanas(ini, fim); const acc = {};
  for (const v of votos || []) {
    const m = (mapaMarca && mapaMarca[v.marca]) || v.marca;
    const d = new Date(new Date(v.data).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    if (d < ini || d > fim) continue;
    const s = cxSegunda(d); const a = acc[m + "|" + s] || (acc[m + "|" + s] = { n: 0, prom: 0, detr: 0 });
    a.n++; if (v.bucket === "promotor") a.prom++; if (v.bucket === "detrator") a.detr++;
  }
  return { semanas, series: marcas.map((m) => ({ marca: m, pontos: semanas.map((s) => { const a = acc[m + "|" + s]; return { semana: s, y: a && a.n >= 10 ? Math.round(((a.prom - a.detr) / a.n) * 100) : null, n: a ? a.n : 0 }; }) })) };
}
// comentários por semana: total, respondidos pela marca, sentimento (social: linhas por marca × rede × dia)
function serieSemanalSocial(social, marca, ini, fim) {
  const semanas = cxSemanas(ini, fim); const acc = {};
  for (const l of social || []) {
    const d = cxDia(l.dia); if (d < ini || d > fim) continue; if (marca !== "todas" && l.marca !== marca) continue;
    const s = cxSegunda(d); const a = acc[s] || (acc[s] = { total: 0, respondidos: 0, pos: 0, neg: 0, neu: 0 });
    a.total += Number(l.total || 0); a.respondidos += Number(l.respondidos || 0); a.pos += Number(l.pos || 0); a.neg += Number(l.neg || 0); a.neu += Number(l.neu || 0);
  }
  const g = (k) => semanas.map((s) => (acc[s] ? acc[s][k] : 0));
  return { semanas, total: g("total"), respondidos: g("respondidos"), semResposta: semanas.map((s) => (acc[s] ? Math.max(0, acc[s].total - acc[s].respondidos) : 0)), pos: g("pos"), neg: g("neg"), neu: g("neu") };
}
// Reclame Aqui no tempo: uma linha por (marca, dia)
function serieRa(rows, marcas, campo) {
  const dias = [...new Set((rows || []).map((r) => cxDia(r.dia)))].sort();
  return { dias, series: marcas.map((m) => ({ marca: m, pontos: dias.map((d) => { const r = (rows || []).find((x) => x.marca === m && cxDia(x.dia) === d); return { dia: d, y: r && r[campo] !== null && r[campo] !== undefined ? Number(r[campo]) : null }; }) })) };
}

// contatos por 100 pedidos, por SEMANA, por marca (dia a dia oscila com o fim de semana: poucos pedidos, mesma fila)
function serieSemanalPor100(csatRows, pedidos, marcas, ini, fim) {
  const semanas = cxSemanas(ini, fim); const cont = {}, ped = {};
  for (const l of cxFiltra(csatRows, { marca: "todas", ini, fim })) { const k = l.marca + "|" + cxSegunda(cxDia(l.dia)); cont[k] = (cont[k] || 0) + Number(l.tickets || 0); }
  for (const p of pedidos || []) { const d = cxDia(p.dia); if (d < ini || d > fim || typeof p.pedidos !== "number") continue; const k = p.marca + "|" + cxSegunda(d); ped[k] = (ped[k] || 0) + p.pedidos; }
  return { semanas, series: marcas.map((m) => ({ marca: m, pontos: semanas.map((s) => { const c = cont[m + "|" + s], pd = ped[m + "|" + s]; return { semana: s, y: pd ? ((c || 0) / pd) * 100 : null, contatos: c || 0, pedidos: pd || null }; }) })) };
}
// corta semanas iniciais sem nenhum dado (a API devolve 120 dias, mas cx_ticket começa em 16/07)
function cxCortaVazioInicial(semanas, colunas) {
  let i = 0; while (i < semanas.length - 1 && colunas.every((c) => !(c[i] > 0))) i++;
  return { semanas: semanas.slice(i), colunas: colunas.map((c) => c.slice(i)) };
}

if (typeof module !== "undefined") {
  module.exports = { CX_MIN_BASE, CX_MOTIVOS, CX_ROTULO_MOTIVO, CX_CANAIS_KAI, CX_RA1000,
    cxFiltra, csatAgg, csatKaiVsPessoa, porMotivo, serieCsatSemanal, cxSegunda,
    somaPedidos, contatosPorPedido, raUltimo, raAvalia, cxDelta, cxDiasComDado,
    CX_GRUPOS_MOTIVO, cxSemanas, cxDiasIntervalo, serieDiariaPor100, serieSemanalMotivos, serieSemanalCsat3, serieSemanalKai, serieSemanalNps, serieSemanalSocial, serieRa, serieSemanalPor100, cxCortaVazioInicial };
}
