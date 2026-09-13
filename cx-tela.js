// ================== CX · TELA DOS BLOCOS NOVOS ==================
// Pinta: os seis números, motivo × CSAT, CSAT em três níveis, Reclame Aqui.
// Toda a matemática está em cx-metricas.js; aqui só HTML. Depende dos globais de app.js
// (estado, PER, PER_DESF, desfechoAgg) e de dados.js (MARCAS, ROTULOS, fmt*, delta, DIRECAO).
//
// Princípios da tela (não mude sem entender):
// - Painel é para bater o olho: ressalva vira etiqueta no cabeçalho com detalhe no `title`,
//   nunca parágrafo embaixo de tabela.
// - Sem dado no período: cai para a última janela que existe e DIZ que caiu.
// - Base curta (< 30 avaliadas) mostra contagem, nunca percentual.
// - Texto nunca veste a cor da série; a cor fica na barra/ponto ao lado.

// direções para os chips de delta (cair é bom / subir é bom)
Object.assign(DIRECAO, {
  contatos_por_pedido: "baixo", wismo_rate: "baixo", contatos_dia: "baixo", wismo_share: "baixo",
  csat_bom: "alto", csat_ruim: "baixo", kai_resolve: "alto", ra_resposta: "alto", ra_solucao: "alto",
});
const CX_SIGLA = { aristocrata: "A", fishermans: "F", olivas: "O" };

// filtros do período atual e do anterior, no formato de cx-metricas
function cxF(marca, ini, fim) { return { marca: marca || estado.marca, ini: ini || PER.ini, fim: fim || PER.fim }; }
function cxFAnt(marca, rows) {
  if (!estado.comparar) return null;
  const f = cxF(marca, PER.cIni, PER.cFim);
  const len = diffDias(f.ini, f.fim) + 1;
  // honestidade: comparar contra período com menos de 80% dos dias coletados é mentira com casas decimais
  if (rows && len > 1 && cxDiasComDado(rows, f) < len * 0.8) return null;
  return f;
}

// Quando o período pedido não tem linha em cx_csat (ex.: "hoje" antes da coleta), usa a última
// janela de mesmo tamanho que existe. Devolve {f, fAnt, caiu:boolean, rotulo}.
function cxPeriodoComDado(rows, marca) {
  const f = cxF(marca);
  if (cxFiltra(rows, f).length) {
    const fAnt = cxFAnt(marca, rows);
    return { f, fAnt, caiu: false, semHist: estado.comparar && !fAnt };
  }
  const dias = [...new Set((rows || []).filter((l) => marca === "todas" || l.marca === marca).map((l) => cxDia(l.dia)))].sort();
  if (!dias.length) return { f, fAnt: null, caiu: false, vazio: true };
  const len = diffDias(f.ini, f.fim) + 1;
  const fim = dias[dias.length - 1];
  const ini = diasAtras(len - 1, fim);
  const ant = rangeAnterior(ini, fim);
  return { f: { marca, ini, fim }, fAnt: estado.comparar ? { marca, ini: ant.ini, fim: ant.fim } : null, caiu: true,
    rotulo: `período sem dado — mostrando ${fmtDia(ini)}${ini !== fim ? " a " + fmtDia(fim) : ""}` };
}

// RA é leitura de estado: se o período alcança ontem/hoje, vale a leitura mais recente que existir;
// só um período fechado no passado fixa o teto na data final.
function cxRaFim(fim) { return fim >= diasAtras(1, hojeRef()) ? null : fim; }

// ---------- peças de HTML ----------
function cxTag(texto, classe, title) {
  return `<span class="tag ${classe || "nota"}"${title ? ` title="${title.replace(/"/g, "&quot;")}"` : ""}>${texto}</span>`;
}
function cxChip(metrica, atual, anterior, fmt) {
  if (!estado.comparar) return "";
  const dl = delta(metrica, atual, anterior);
  if (!dl.texto) return "";
  const ant = typeof anterior === "number" ? " · ant. " + (fmt || fmtNum)(anterior) : "";
  return `<span class="chip ${dl.classe}">${dl.texto}${ant}</span>`;
}
// taxas comparam em pontos percentuais: "de 2,9% para 24,9%" é +22 pp, não ">500%"
function cxChipPP(metrica, atual, anterior, casas) {
  if (!estado.comparar || typeof atual !== "number" || typeof anterior !== "number") return "";
  const d = atual - anterior;
  if (Math.abs(d) < 0.5) return `<span class="chip d-neutro">＝ · ant. ${fmtDec(anterior, casas === undefined ? 0 : casas)}%</span>`;
  const dir = DIRECAO[metrica] || "neutro";
  const classe = dir === "neutro" ? "d-neutro" : (dir === "alto") === (d > 0) ? "d-bom" : "d-ruim";
  return `<span class="chip ${classe}">${d > 0 ? "▲" : "▼"} ${fmtDec(Math.abs(d), casas === undefined ? 0 : casas)} pp · ant. ${fmtDec(anterior, casas === undefined ? 0 : casas)}%</span>`;
}
function fmtPct0(v) { return typeof v === "number" ? Math.round(v) + "%" : "—"; }
function fmtDec(v, casas) { return typeof v === "number" ? v.toFixed(casas === undefined ? 1 : casas).replace(".", ",") : "—"; }
// barra de três níveis (ruim | neutro | bom), com 2px de respiro entre segmentos via CSS
function cxBarra3(a, classe) {
  if (!a || !a.avaliadas) return `<div class="b3 ${classe || ""} vazia" aria-hidden="true"></div>`;
  const n = a.avaliadas, p = (x) => (x / n) * 100;
  return `<div class="b3 ${classe || ""}" role="img" aria-label="${Math.round(p(a.bom))}% bom, ${Math.round(p(a.neutro))}% neutro, ${Math.round(p(a.ruim))}% ruim">
    <i class="s-ruim" style="width:${p(a.ruim)}%" title="ruim: ${fmtNum(a.ruim)}"></i><i class="s-neutro" style="width:${p(a.neutro)}%" title="neutro: ${fmtNum(a.neutro)}"></i><i class="s-bom" style="width:${p(a.bom)}%" title="bom: ${fmtNum(a.bom)}"></i>
  </div>`;
}
// Alvos do plano de CX (handoff de 12/09) e faixa de atenção = linha de base de ago 1–15.
// status: 'bom' dentro do alvo · 'atencao' entre alvo e base · 'ruim' pior que a base · null sem alvo.
const CX_ALVOS = {
  contatos_por_pedido: { alvo: 12, base: 20, dir: "baixo", rot: "alvo < 12" },
  wismo_rate:          { alvo: 4,  base: 8,  dir: "baixo", rot: "alvo < 4%" },
  csat_bom:            { alvo: 80, base: 60, dir: "alto",  rot: "alvo ≥ 80%" },
  ra_resposta:         { alvo: 90, base: 80, dir: "alto",  rot: "alvo ≥ 90%" },
  ra_solucao:          { alvo: 90, base: 80, dir: "alto",  rot: "alvo ≥ 90%" },
};
function cxStatus(metrica, v) {
  const a = CX_ALVOS[metrica];
  if (!a || typeof v !== "number") return null;
  if (a.dir === "baixo") return v < a.alvo ? "bom" : v <= a.base ? "atencao" : "ruim";
  return v >= a.alvo ? "bom" : v >= a.base ? "atencao" : "ruim";
}
const CX_STATUS_ROT = { bom: "no alvo", atencao: "atenção", ruim: "fora do alvo" };
function cxTile(o) {
  const st = o.metrica ? cxStatus(o.metrica, o.valor) : null;
  const alvo = o.metrica && CX_ALVOS[o.metrica] ? `<span class="tag alvo" title="${CX_ALVOS[o.metrica].rot} · faixa de atenção até a linha de base de ago 1–15">${CX_ALVOS[o.metrica].rot}</span>` : "";
  return `<div class="six${o.classe ? " " + o.classe : ""}${st ? " st-" + st : ""}"${o.title ? ` title="${o.title.replace(/"/g, "&quot;")}"` : ""}>
    <div class="six-rot">${st ? `<i class="st-dot" title="${CX_STATUS_ROT[st]}"></i>` : ""}${o.rot}</div>
    <div class="six-tags">${alvo}${o.tags || ""}</div>
    <div class="six-val">${o.val}</div>
    ${o.barra || ""}
    <div class="six-rodape"><span class="six-sub">${o.sub || ""}</span>${o.chip || ""}</div>
    ${o.ref ? `<div class="six-ref">${o.ref}</div>` : ""}
  </div>`;
}

// ---------- Kai resolve (mesmo critério do bloco de desfecho) ----------
function kaiResolve(marca, ini, fim) {
  const linhas = desfechoAgg(estado.dados || {}, marca, ini, fim).filter((x) => x.canal !== "email");
  const kai = linhas.reduce((s, x) => s + (x.resolvido_kai || 0), 0);
  const esc = linhas.reduce((s, x) => s + (x.escalado || 0), 0);
  const t = kai + esc;
  return { kai, esc, decididos: t, pct: t >= MIN_BASE ? (kai / t) * 100 : null };
}

// ---------- 1. Os seis números (padrão Plausible: rótulo · valor · variação; o resto no ⓘ) ----------
// Clicar num cartão troca o único gráfico da Visão geral. estado.metricaGeral guarda a escolha.
estado.metricaGeral = estado.metricaGeral || "contatos_por_pedido";
const CX_SEIS = [
  { k: "contatos_por_pedido", rot: "Contatos / 100 pedidos", fmt: (v) => fmtDec(v), casas: 1, pct: false },
  { k: "wismo_rate",          rot: "WISMO / pedido",         fmt: (v) => fmtDec(v) + "%", casas: 1, pct: true },
  { k: "csat_bom",            rot: "CSAT · bom",             fmt: fmtPct0, casas: 0, pct: true },
  { k: "kai_resolve",         rot: "Kai resolve sozinho",    fmt: (v) => fmtDec(v) + "%", casas: 1, pct: true },
  { k: "ra_resposta",         rot: "RA · resposta",          fmt: (v) => fmtDec(v) + "%", casas: 1, pct: true },
  { k: "ra_solucao",          rot: "RA · solução",           fmt: (v) => fmtDec(v) + "%", casas: 1, pct: true },
];
const CX_INFO = {
  contatos_por_pedido: "Contatos de todos os canais (e-mail incluso) ÷ pedidos criados no mesmo período × 100.\nAlvo < 12. Base ago 1–15: Aristocrata 20, Fishermans 42.",
  wismo_rate: "Tickets com tag wismo (só chat: e-mail não recebe tag) ÷ pedidos criados × 100. É piso.\nAlvo < 4%. Base ago 1–15: Aristocrata 7,8%, Fishermans 5,3%.",
  csat_bom: "O Gleap tem três opções (ruim / neutro / bom). O número é a fatia de bom entre quem avaliou, só chat, com 30+ avaliações.\nAlvo ≥ 80%. Base ago 1–15: Aristocrata 53%, Fishermans 65%.",
  kai_resolve: "Tickets que o Kai fechou sozinho ÷ tickets com desfecho (Kai ou transferido para pessoa). E-mail fora. Quebra de série em 29/08.\nSem alvo declarado: acompanhar a tendência.",
  ra_resposta: "Índice de resposta na página da marca no Reclame AQUI (metatags, via bookmarklet).\nAlvo RA1000 ≥ 90%.",
  ra_solucao: "Índice de solução no Reclame AQUI.\nAlvo RA1000 ≥ 90%.",
};
let CX_SEIS_DADOS = null; // valores por métrica/marca do último render, para o gráfico e o ⓘ

function pintaSeisNumeros(d) {
  const alvo = $("#area-seis");
  if (!alvo) return;
  const rows = d.cx_csat || [];
  const marca = estado.marca, todas = marca === "todas";
  const per = cxPeriodoComDado(rows, marca);
  const rot = $("#seis-rot");
  if (per.vazio) {
    alvo.innerHTML = `<div class="vazio">A API ainda não devolve <code>cx_csat</code>.</div>`;
    if (rot) rot.innerHTML = cxTag("bloco cx_csat ausente", "alerta", "A API de leitura precisa devolver a view cx_csat_dia.");
    return;
  }
  const marcas = todas ? MARCAS.filter((m) => m !== "olivas") : [marca];
  const porMarca = (fn) => Object.fromEntries(marcas.map((m) => [m, fn(m)]));

  // valores atuais e anteriores, por métrica, no escopo e por marca
  const cpp = contatosPorPedido(rows, d.cx_pedidos, per.f), cppAnt = per.fAnt ? contatosPorPedido(rows, d.cx_pedidos, per.fAnt) : null;
  const cs = csatAgg(rows, Object.assign({}, per.f, { canais: CX_CANAIS_KAI })), csAnt = per.fAnt ? csatAgg(rows, Object.assign({}, per.fAnt, { canais: CX_CANAIS_KAI })) : null;
  const kr = kaiResolve(marca, PER_DESF.ini, PER_DESF.fim); let krAnt = null;
  if (estado.comparar) { const a = rangeAnterior(PER_DESF.ini, PER_DESF.fim); krAnt = kaiResolve(marca, a.ini, a.fim); }
  const raU = porMarca((m) => raUltimo(d.cx_ra, m, cxRaFim(per.f.fim)));
  const raAnt = porMarca((m) => per.fAnt ? raUltimo(d.cx_ra, m, per.fAnt.fim) : null);
  const raPior = (campo, src) => { const vs = marcas.map((m) => src[m] && src[m][campo] != null ? Number(src[m][campo]) : null).filter((v) => typeof v === "number"); return vs.length ? Math.min(...vs) : null; };
  const temPed = typeof cpp.pedidos === "number";
  const V = {
    contatos_por_pedido: { v: temPed ? cpp.por100 : null, ant: cppAnt && cppAnt.por100, sub: temPed ? `${fmtNum(cpp.contatos)} contatos · ${fmtNum(cpp.pedidos)} pedidos` : `${fmtNum(cpp.contatos)} contatos · sem pedidos coletados`,
      marcas: porMarca((m) => contatosPorPedido(rows, d.cx_pedidos, Object.assign({}, per.f, { marca: m })).por100) },
    wismo_rate: { v: temPed ? cpp.wismoRate : null, ant: cppAnt && cppAnt.wismoRate, sub: `${fmtNum(cpp.wismo)} “cadê meu pedido”`,
      marcas: porMarca((m) => contatosPorPedido(rows, d.cx_pedidos, Object.assign({}, per.f, { marca: m })).wismoRate) },
    csat_bom: { v: cs.baseOk ? cs.pctBom : null, ant: csAnt && csAnt.baseOk ? csAnt.pctBom : null, sub: `${fmtNum(cs.avaliadas)} avaliações · responderam ${fmtPct0(cs.pctResposta)}`, curto: !cs.baseOk && cs.avaliadas ? `${fmtNum(cs.bom)} de ${fmtNum(cs.avaliadas)}` : null,
      marcas: porMarca((m) => { const a = csatAgg(rows, Object.assign({}, per.f, { marca: m, canais: CX_CANAIS_KAI })); return a.baseOk ? a.pctBom : null; }) },
    kai_resolve: { v: kr.pct, ant: krAnt && krAnt.pct, sub: `${fmtNum(kr.kai)} de ${fmtNum(kr.decididos)} com desfecho`, curto: kr.pct === null && kr.decididos ? `${fmtNum(kr.kai)} de ${fmtNum(kr.decididos)}` : null,
      marcas: porMarca((m) => kaiResolve(m, PER_DESF.ini, PER_DESF.fim).pct) },
    ra_resposta: { v: raPior("resposta_pct", raU), ant: raPior("resposta_pct", raAnt), sub: marcas.length > 1 ? "pior marca" : (raU[marca] ? "leitura de " + fmtDia(cxDia(raU[marca].dia)) : "sem leitura"), marcas: porMarca((m) => raU[m] ? Number(raU[m].resposta_pct) : null) },
    ra_solucao: { v: raPior("solucao_pct", raU), ant: raPior("solucao_pct", raAnt), sub: marcas.length > 1 ? "pior marca" : (raU[marca] ? "leitura de " + fmtDia(cxDia(raU[marca].dia)) : "sem leitura"), marcas: porMarca((m) => raU[m] ? Number(raU[m].solucao_pct) : null) },
  };
  CX_SEIS_DADOS = { V, per, marcas };

  const nFora = CX_SEIS.filter((s) => cxStatus(s.k, V[s.k].v) === "ruim").length;
  const nAt = CX_SEIS.filter((s) => cxStatus(s.k, V[s.k].v) === "atencao").length;
  if (rot) rot.innerHTML = (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    (per.semHist ? cxTag("sem histórico para comparar", "nota", "O período de comparação tem menos de 80% dos dias coletados.") : "") +
    (nFora ? `<span class="tag st-ruim-tag"><i class="st-dot st-ruim"></i>${nFora} fora do alvo</span>` : "") +
    (nAt ? `<span class="tag nota"><i class="st-dot st-atencao"></i>${nAt} em atenção</span>` : "") +
    (!nFora && !nAt ? `<span class="tag nota"><i class="st-dot st-bom"></i>tudo no alvo</span>` : "");

  alvo.innerHTML = CX_SEIS.map((s) => {
    const x = V[s.k]; const st = cxStatus(s.k, x.v);
    const info = CX_INFO[s.k] + (todas ? "\n\nPor marca: " + marcas.map((m) => `${ROTULOS[m]} ${typeof x.marcas[m] === "number" ? s.fmt(x.marcas[m]) : "—"}`).join(" · ") : "") + "\n\n" + x.sub;
    const val = typeof x.v === "number" ? s.fmt(x.v) : (x.curto ? `<span class="six-curto">${x.curto}</span>` : "—");
    return `<button type="button" class="six2${st ? " st-" + st : ""}${estado.metricaGeral === s.k ? " ativo" : ""}" data-m="${s.k}" title="${info.replace(/"/g, "&quot;")}" aria-pressed="${estado.metricaGeral === s.k}">
      <span class="six2-rot">${st ? `<i class="st-dot"></i>` : `<i class="st-dot st-nulo"></i>`}${s.rot}</span>
      <span class="six2-val">${val}</span>
      <span class="six2-chip">${typeof x.v === "number" ? (cxChipPP(s.k, x.v, x.ant, s.casas) || `<span class="mini">${x.sub}</span>`) : `<span class="mini">${x.sub}</span>`}</span>
    </button>`;
  }).join("");
  pintaGraficoGeral(d);
}

// o único gráfico da Visão geral: a métrica do cartão ativo, por semana, uma linha por marca
function pintaGraficoGeral(d) {
  const el = $("#g-geral"), tit = $("#g-geral-tit");
  if (!el || !CX_SEIS_DADOS) return;
  const s = CX_SEIS.find((x) => x.k === estado.metricaGeral) || CX_SEIS[0];
  const { per, marcas } = CX_SEIS_DADOS;
  const rows = d.cx_csat || [];
  const j = cxJanelaTendencia(per.f.fim, 12);
  const segHoje = cxSegunda(hojeRef());
  let series = [], rotulosX = [], alvoRef = null, baseRef = null, marcos = [], vazio = null, pct = s.pct && s.k !== "wismo_rate";
  const lbl = (m) => ({ nome: ROTULOS[m], cor: corHex(m) });
  if (s.k === "contatos_por_pedido" || s.k === "wismo_rate") {
    const w = s.k === "wismo_rate";
    const base = serieSemanalPor100(rows, d.cx_pedidos, marcas, j.ini, j.fim);
    const wis = w ? serieSemanalPor100(cxFiltra(rows, { marca: "todas", ini: j.ini, fim: j.fim, canais: CX_CANAIS_KAI, motivo: "wismo" }), d.cx_pedidos, marcas, j.ini, j.fim) : null;
    const src = w ? wis : base;
    const c = cxCortaVazioInicial(base.semanas, base.series.map((x) => x.pontos.map((p) => p.contatos))); const corte = base.semanas.length - c.semanas.length;
    rotulosX = c.semanas.map(fmtDia);
    if (!src.series.some((x) => x.pontos.some((p) => p.pedidos))) vazio = "Sem pedidos coletados no intervalo.";
    series = src.series.map((x) => Object.assign(lbl(x.marca), { pontos: x.pontos.slice(corte).map((p) => ({ y: p.y, rot: "semana de " + fmtDia(p.semana), n: p.pedidos ? `${fmtNum(p.contatos)} ${w ? "wismo" : "contatos"} · ${fmtNum(p.pedidos)} pedidos` : undefined, parcial: p.semana === segHoje })) }));
    alvoRef = { y: CX_ALVOS[s.k].alvo, rot: "alvo " + (w ? "4%" : "12") }; baseRef = { y: CX_ALVOS[s.k].base, rot: "base " + (w ? "8%" : "20") };
  } else if (s.k === "csat_bom") {
    const ss = marcas.map((m) => ({ m, c: serieSemanalCsat3(rows, { marca: m, ini: j.ini, fim: j.fim }) }));
    const c = cxCortaVazioInicial(ss[0].c.semanas, ss.map((x) => x.c.tickets)); const corte = ss[0].c.semanas.length - c.semanas.length;
    rotulosX = c.semanas.map(fmtDia);
    series = ss.map((x) => Object.assign(lbl(x.m), { pontos: x.c.pctBom.slice(corte).map((y, i) => ({ y, rot: "semana de " + fmtDia(c.semanas[i]), n: `${fmtNum(x.c.tickets.slice(corte)[i])} contatos`, parcial: c.semanas[i] === segHoje })) }));
    alvoRef = { y: 80, rot: "alvo 80%" };
    marcos = (d.cx_marco || []).map((m) => ({ i: c.semanas.indexOf(cxSegunda(cxDia(m.dia))), rot: fmtDia(cxDia(m.dia)), title: `${fmtDia(cxDia(m.dia))} — ${m.titulo}` })).filter((m) => m.i >= 0);
  } else if (s.k === "kai_resolve") {
    const ss = marcas.map((m) => ({ m, k: serieSemanalKai(d.cx_desfecho, m, j.ini, j.fim) }));
    const c = cxCortaVazioInicial(ss[0].k.semanas, ss.map((x) => x.k.pontos.map((p) => p.n))); const corte = ss[0].k.semanas.length - c.semanas.length;
    rotulosX = c.semanas.map(fmtDia);
    series = ss.map((x) => Object.assign(lbl(x.m), { pontos: x.k.pontos.slice(corte).map((p) => ({ y: p.y, rot: "semana de " + fmtDia(p.semana), n: `${fmtNum(p.n)} com desfecho`, parcial: p.semana === segHoje })) }));
    marcos = (d.cx_marco || []).map((m) => ({ i: c.semanas.indexOf(cxSegunda(cxDia(m.dia))), rot: fmtDia(cxDia(m.dia)), title: `${fmtDia(cxDia(m.dia))} — ${m.titulo}` })).filter((m) => m.i >= 0);
  } else {
    const campo = s.k === "ra_resposta" ? "resposta_pct" : "solucao_pct";
    const r = serieRa(d.cx_ra, marcas, campo);
    rotulosX = r.dias.map(fmtDia);
    if (r.dias.length < 2) vazio = r.dias.length ? `Uma leitura só (${fmtDia(r.dias[0])}): ${r.series.map((x) => `${ROTULOS[x.marca]} ${fmtDec(x.pontos[0].y)}%`).join(" · ")}. A curva aparece a partir da segunda leitura do bookmarklet.` : "Sem leitura do Reclame AQUI ainda.";
    series = r.series.map((x) => Object.assign(lbl(x.marca), { pontos: x.pontos.map((p) => ({ y: p.y, rot: fmtDia(p.dia) })) }));
    alvoRef = { y: 90, rot: "alvo 90%" };
  }
  if (tit) tit.textContent = s.rot + (s.k.startsWith("ra_") ? " · por leitura" : " · por semana");
  el.innerHTML = vazio && (!series.length || series.every((x) => x.pontos.filter((p) => typeof p.y === "number").length < 2))
    ? `<div class="vazio mini">${vazio}</div>`
    : cxgLinhas({ rotulosX, series, pct, fmt: s.k === "contatos_por_pedido" ? (v) => fmtDec(v, 0) : s.k === "wismo_rate" ? (v) => fmtDec(v, 0) + "%" : (v) => Math.round(v) + "%", alvo: alvoRef, base: baseRef, marcos, aria: s.rot,
        yMax: s.k === "wismo_rate" ? null : undefined });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("#area-seis .six2"); if (!b) return;
  estado.metricaGeral = b.dataset.m;
  document.querySelectorAll("#area-seis .six2").forEach((x) => { const on = x === b; x.classList.toggle("ativo", on); x.setAttribute("aria-pressed", on); });
  if (estado.dados) pintaGraficoGeral(estado.dados);
});

// ---------- 2. Por que o cliente chama — e como sai (motivo × CSAT) ----------
// Visão geral: 4 colunas (motivo, contatos, Δ, CSAT). Aba Chat: o corte Kai × pessoa.
estado.canalMotivo = "todos";
function pintaMotivos(d) {
  const rows = d.cx_csat || [];
  const per = cxPeriodoComDado(rows, estado.marca);
  const canais = estado.canalMotivo === "todos" ? null : [estado.canalMotivo];
  const pm = per.vazio ? null : porMotivo(rows, Object.assign({}, per.f, { canais }), per.fAnt ? Object.assign({}, per.fAnt, { canais }) : null);
  const linhas = pm ? [...pm.linhas].sort((a, b) => b.tickets - a.tickets) : [];
  const maxT = Math.max(...linhas.map((l) => l.tickets), 1);
  const atacar = (l) => l.share >= 20 && ((typeof l.delta === "number" && l.delta > 10) || (l.baseOk && l.pctBom < 50));
  const pctOuN = (pctB, n) => typeof pctB === "number" ? `<strong class="tabn">${fmtPct0(pctB)}</strong>` : (n ? `<span class="mini">${fmtNum(n)} aval.</span>` : "<span class='mini'>—</span>");
  const csatCel = (a) => `<div class="csat-cel">${cxBarra3(a)}${a.baseOk ? `<strong class="tabn">${fmtPct0(a.pctBom)}</strong>` : `<span class="mini">${fmtNum(a.avaliadas)} aval.</span>`}</div>`;
  const contCel = (l) => `<div class="cont-cel"><strong class="tabn">${fmtNum(l.tickets)}</strong><span class="mot-barra"><i style="width:${(l.tickets / maxT) * 100}%"></i></span><span class="mini tabn">${fmtPct0(l.share)}</span></div>`;
  const dlHtml = (l) => {
    if (!estado.comparar || typeof l.delta !== "number") return "<span class='mini'>—</span>";
    const dl = delta("novos", l.tickets, l.anterior); if (!dl.texto) return "<span class='mini'>—</span>";
    const cls = l.motivo === "pre-venda" ? "d-neutro" : l.delta > 0 ? "d-ruim" : l.delta < 0 ? "d-bom" : "d-neutro";
    return `<span class="chip ${cls}" title="antes: ${fmtNum(l.anterior)}">${dl.texto}</span>`;
  };
  const nome = (l) => `<span class="mot-nome">${l.rotulo}</span>${atacar(l) ? `<span class="tag alerta mot-tag" title="Fatia ≥ 20% e (volume subindo > 10% ou CSAT bom < 50%)">atacar</span>` : ""}`;
  const cab = (pmx) => pmx ? `${fmtNum(pmx.total.tickets)} contatos no chat ` + (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    ((pmx.linhas.find((l) => l.motivo === "outros") || {}).share >= 25 ? cxTag(`“outros” ${fmtPct0(pmx.linhas.find((l) => l.motivo === "outros").share)}`, "alerta", "Um em cada quatro contatos sem motivo conhecido: o classificador não está dando conta.") : "") +
    (pmx.email.tickets ? cxTag(`${fmtNum(pmx.email.tickets)} por e-mail sem tag`, "nota", "E-mail entra no total de contatos, mas não recebe tag de motivo.") : "") : "";

  // Visão geral — 4 colunas
  const a1 = $("#area-motivos"), r1 = $("#motivos-rot");
  if (a1) {
    if (!pm) { a1.innerHTML = `<div class="vazio">Sem <code>cx_csat</code> na API.</div>`; if (r1) r1.innerHTML = ""; }
    else {
      if (r1) r1.innerHTML = cab(pm);
      a1.innerHTML = `<div class="rolagem"><table class="motivos">
        <thead><tr><th>Motivo</th><th class="num" title="Contatos do motivo no chat e fatia do total">Contatos</th><th class="num" title="Variação do volume contra o período anterior">Δ volume</th><th title="ruim | neutro | bom entre quem avaliou; número = fatia de bom (30+ avaliações)">CSAT</th></tr></thead>
        <tbody>${linhas.map((l) => `<tr class="${atacar(l) ? "mot-atacar" : ""}"><td>${nome(l)}</td><td class="num">${contCel(l)}</td><td class="num">${dlHtml(l)}</td><td>${csatCel(l)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>Todos os motivos</td><td class="num"><div class="cont-cel"><strong class="tabn">${fmtNum(pm.total.tickets)}</strong></div></td><td class="num">${estado.comparar && pm.anterior ? (cxChip("novos", pm.total.tickets, pm.anterior.tickets) || "") : ""}</td><td>${csatCel(pm.total)}</td></tr></tfoot>
      </table></div>`;
    }
  }
  // Aba Chat — Kai × pessoa por motivo
  const a2 = $("#area-motivos-kai"), r2 = $("#motivos-kai-rot");
  if (a2) {
    if (!pm) a2.innerHTML = `<div class="vazio">Sem <code>cx_csat</code> na API.</div>`;
    else {
      if (r2) r2.innerHTML = cab(pm);
      a2.innerHTML = `<div class="rolagem"><table class="motivos">
        <thead><tr><th>Motivo</th><th class="num">Contatos</th><th class="num" title="Fatia dos contatos do motivo que o Kai fechou sozinho (transferência real)">Kai sozinho</th><th class="num" title="Quem avaliou ÷ contatos">Resp.</th><th class="num" title="CSAT bom quando o Kai fechou sozinho">bom · Kai</th><th class="num" title="CSAT bom quando passou por pessoa">bom · pessoa</th></tr></thead>
        <tbody>${linhas.map((l) => `<tr><td>${nome(l)}</td><td class="num">${contCel(l)}</td><td class="num">${l.tickets ? `<span class="tabn">${fmtPct0(l.kaiShare)}</span>` : "—"}</td><td class="num"><span class="mini tabn">${fmtPct0(l.pctResposta)}</span></td><td class="num">${pctOuN(l.kaiBom, l.kaiAvaliadas)}</td><td class="num">${pctOuN(l.pessoaBom, l.pessoaAvaliadas)}</td></tr>`).join("")}</tbody>
      </table></div>`;
    }
  }
}

// ---------- 3. CSAT em três níveis: distribuição, tendência semanal, Kai × pessoa ----------
function pintaCsat(d) {
  const alvo = $("#area-csat");
  if (!alvo) return;
  const rows = d.cx_csat || [];
  const per = cxPeriodoComDado(rows, estado.marca);
  const rot = $("#csat-rot");
  if (per.vazio) { alvo.innerHTML = `<div class="vazio">Sem <code>cx_csat</code> na API.</div>`; if (rot) rot.innerHTML = ""; return; }
  const kp = csatKaiVsPessoa(rows, per.f);
  const kpAnt = per.fAnt ? csatKaiVsPessoa(rows, per.fAnt) : null;
  const a = kp.todos;
  if (rot) rot.innerHTML = `${fmtNum(a.avaliadas)} avaliações · ${fmtNum(a.tickets)} contatos no chat ` +
    (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    (a.pctResposta !== null && a.pctResposta < 25 ? cxTag(`resposta ${fmtPct0(a.pctResposta)}`, "alerta", "Taxa de resposta abaixo de 25%. Em agosto era 42–46% no Aristocrata e 32–35% na Fishermans; caiu depois das mudanças de 29/08 no Kai. Instagram não responde (botão não funciona lá).") : "") +
    cxTag("só chat", "nota", "WhatsApp, Instagram e widget. E-mail não tem CSAT. No Instagram o botão de nota não renderiza: o envio lá é perdido.");

  // série semanal: janela de 12 semanas terminando no fim do período, com marco de quebra
  const fimSerie = per.f.fim;
  const iniSerie = diasAtras(7 * 12 - 1, fimSerie);
  const c3b = serieSemanalCsat3(rows, { marca: per.f.marca, ini: iniSerie, fim: fimSerie });
  const cc = cxCortaVazioInicial(c3b.semanas, [c3b.tickets]); const cortC = c3b.semanas.length - cc.semanas.length;
  const c3 = { semanas: cc.semanas, ruim: c3b.ruim.slice(cortC), neutro: c3b.neutro.slice(cortC), bom: c3b.bom.slice(cortC), pctBom: c3b.pctBom.slice(cortC) };
  const marcos = (d.cx_marco || []).map((m) => ({ dia: cxDia(m.dia), titulo: m.titulo, detalhe: m.detalhe })).filter((m) => m.dia >= iniSerie && m.dia <= fimSerie);

  const tileKp = (rotulo, x, xAnt, sub) => `<div class="kp">
      <div class="kp-rot">${rotulo}</div>
      <div class="kp-val">${x.baseOk ? fmtPct0(x.pctBom) : (x.avaliadas ? `<span class="six-curto">${fmtNum(x.bom)}<small> de ${fmtNum(x.avaliadas)}</small></span>` : "—")}</div>
      ${cxBarra3(x, "fina")}
      <div class="kp-sub">${fmtNum(x.tickets)} contatos · resp. ${fmtPct0(x.pctResposta)} ${x.baseOk ? cxChipPP("csat_bom", x.pctBom, xAnt && xAnt.baseOk ? xAnt.pctBom : null) : ""}</div>
      <div class="mini">${sub}</div>
    </div>`;

  alvo.innerHTML = `
    <div class="csat-hero">
      <div class="csat-big">
        <div class="kp-rot">bom</div>
        <div class="csat-num">${a.baseOk ? fmtPct0(a.pctBom) : (a.avaliadas ? `${fmtNum(a.bom)}<small> de ${fmtNum(a.avaliadas)}</small>` : "—")}</div>
        ${a.baseOk ? cxChipPP("csat_bom", a.pctBom, kpAnt && kpAnt.todos.baseOk ? kpAnt.todos.pctBom : null) : ""}
      </div>
      ${cxBarra3(a, "grossa")}
      <div class="b3-legenda">
        <span><i class="s-ruim"></i> Ruim <b>${fmtPct0(a.pctRuim)}</b> <small>${fmtNum(a.ruim)}</small></span>
        <span><i class="s-neutro"></i> Neutro <b>${fmtPct0(a.pctNeutro)}</b> <small>${fmtNum(a.neutro)}</small></span>
        <span><i class="s-bom"></i> Bom <b>${fmtPct0(a.pctBom)}</b> <small>${fmtNum(a.bom)}</small></span>
        <span class="resp">responderam <b>${fmtPct0(a.pctResposta)}</b> <small>${fmtNum(a.avaliadas)} de ${fmtNum(a.tickets)}</small></span>
      </div>
    </div>
    <div class="csat-kp">
      ${tileKp("Kai fechou sozinho", kp.kai, kpAnt && kpAnt.kai, "quem o Kai resolve responde menos à pesquisa")}
      ${tileKp("Passou por pessoa", kp.pessoa, kpAnt && kpAnt.pessoa, "chega o caso difícil: a nota mede a experiência, não só o atendimento")}
    </div>
    <div class="csat-serie">
      <div class="kp-rot">ruim · neutro · bom, por semana <span class="mini">12 semanas até ${fmtDia(fimSerie)} · número = fatia de bom</span></div>
      ${cxgBarras({ rotulosX: c3.semanas.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: "CSAT por semana em três níveis",
        series: [{ nome: "Ruim", cor: "var(--ruim)", valores: c3.ruim }, { nome: "Neutro", cor: "var(--borda-forte)", valores: c3.neutro }, { nome: "Bom", cor: "var(--bom)", valores: c3.bom }],
        topo: c3.pctBom.map((p) => (typeof p === "number" ? Math.round(p) + "%" : "")), vazio: "Sem semana com 30+ avaliações." })}
    </div>`;
}

// gráfico de linha semanal (SVG puro): uma série, eixo 0–100, marcos como linha vertical
function cxGraficoSemanal(serie, marcos, cor) {
  const pts = serie.filter((s) => typeof s.pctBom === "number");
  if (pts.length < 2) return `<div class="vazio mini">Sem semanas com 30+ avaliações para traçar.</div>`;
  const W = 520, H = 190, PL = 30, PR = 44, PT = 12, PB = 22;
  const iw = W - PL - PR, ih = H - PT - PB;
  const n = serie.length;
  const x = (i) => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => PT + ih - (v / 100) * ih;
  const idx = new Map(serie.map((s, i) => [s.semana, i]));
  const linha = pts.map((s) => `${x(idx.get(s.semana)).toFixed(1)},${y(s.pctBom).toFixed(1)}`).join(" ");
  const grade = [25, 50, 75].map((g) => `<line x1="${PL}" x2="${W - PR}" y1="${y(g)}" y2="${y(g)}" class="grade"/><text x="${PL - 6}" y="${y(g) + 3.5}" class="eixo" text-anchor="end">${g}</text>`).join("");
  const marcoSvg = marcos.map((m) => {
    const seg = cxSegunda(m.dia);
    const i = idx.get(seg);
    if (i === undefined) return "";
    const off = ((new Date(m.dia + "T12:00Z") - new Date(seg + "T12:00Z")) / 864e5) / 7;
    const xx = x(i) + (n > 1 ? off * (iw / (n - 1)) : 0);
    return `<g class="marco"><title>${fmtDia(m.dia)} — ${m.titulo}${m.detalhe ? "\n" + m.detalhe : ""}</title><line x1="${xx}" x2="${xx}" y1="${PT}" y2="${PT + ih}"/><text x="${xx + 4}" y="${PT + 9}">${fmtDia(m.dia)}</text></g>`;
  }).join("");
  const ult = pts[pts.length - 1];
  const dots = pts.map((s) => `<circle cx="${x(idx.get(s.semana))}" cy="${y(s.pctBom)}" r="${s === ult ? 4 : 3}" class="${s.parcial ? "parcial" : ""}" style="fill:${cor}"><title>semana de ${fmtDia(s.semana)}${s.parcial ? " (parcial)" : ""}\nbom ${fmtPct0(s.pctBom)} · ${fmtNum(s.avaliadas)} avaliações\nresposta ${fmtPct0(s.pctResposta)}</title></circle>`).join("");
  const rotIni = fmtDia(serie[0].semana), rotFim = fmtDia(serie[n - 1].semana);
  return `<svg viewBox="0 0 ${W} ${H}" class="g-semanal" role="img" aria-label="CSAT bom por semana">
    ${grade}
    <line x1="${PL}" x2="${W - PR}" y1="${y(0)}" y2="${y(0)}" class="base"/>
    ${marcoSvg}
    <polyline points="${linha}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text x="${x(idx.get(ult.semana)) + 7}" y="${y(ult.pctBom) + 4}" class="fim">${fmtPct0(ult.pctBom)}</text>
    <text x="${PL}" y="${H - 6}" class="eixo">${rotIni}</text>
    <text x="${W - PR}" y="${H - 6}" class="eixo" text-anchor="end">${rotFim}</text>
  </svg>`;
}

// ---------- 4. Reclame Aqui · rumo ao RA1000 ----------
function pintaRaNovo(d) {
  const alvo = $("#area-ra");
  if (!alvo) return;
  const marcas = (estado.marca === "todas" ? MARCAS : [estado.marca]).filter((m) => m !== "olivas" || estado.marca === "olivas");
  const rot = $("#ra-rotulo");
  const linhas = marcas.map((m) => ({ m, l: raUltimo(d.cx_ra, m, cxRaFim(PER.fim)) })).filter((x) => x.l);
  if (!linhas.length) {
    if (rot) rot.innerHTML = cxTag("sem coleta", "alerta", "cx_ra_dia está vazia. A coleta diária das metatags da página da marca no Reclame AQUI ainda não roda no n8n.");
    alvo.innerHTML = `<div class="vazio">Sem leitura do Reclame AQUI ainda. Quando a coleta diária das metatags entrar, aqui aparecem os cinco critérios do RA1000 por marca, o que está aguardando resposta e o tempo médio de resposta.</div>`;
    return;
  }
  const maisRecente = linhas.map((x) => cxDia(x.l.dia)).sort().pop();
  // resumo no título: resposta/solução por marca; o painel abre sozinho se alguma estiver fora do alvo
  const foraAlvo = linhas.some(({ l }) => cxStatus("ra_resposta", Number(l.resposta_pct)) === "ruim" || cxStatus("ra_solucao", Number(l.solucao_pct)) === "ruim");
  const painelRa = $("#painel-ra"); if (painelRa && painelRa.tagName === "DETAILS" && foraAlvo && !painelRa.dataset.tocado) painelRa.open = true;
  if (rot) rot.innerHTML = linhas.map(({ m, l }) => `${CX_SIGLA[m]} resp. <b>${fmtDec(Number(l.resposta_pct))}%</b> · sol. <b>${fmtDec(Number(l.solucao_pct))}%</b>${l.aguardando != null && Number(l.aguardando) > 0 ? ` · <span class="vm">${fmtNum(Number(l.aguardando))} aguardando</span>` : ""}`).join(" &nbsp;|&nbsp; ")
    + ` · leitura de ${fmtDia(maisRecente)}` + cxTag(foraAlvo ? "fora do alvo" : "no alvo", foraAlvo ? "alerta" : "nota", "Alvo RA1000: resposta e solução ≥ 90% nas duas marcas. Fonte: metatags da página pública da marca (bookmarklet).");
  alvo.innerHTML = linhas.map(({ m, l }) => {
    const av = raAvalia(l);
    const ant = estado.comparar ? raUltimo(d.cx_ra, m, PER.cFim) : null;
    return `<div class="ra-marca">
      <div class="cab"><span class="ponto" style="--cor:${corHex(m)}"></span><h3>${ROTULOS[m]}</h3>
        <span class="mini">${fmtDia(cxDia(l.dia))}${l.fonte && l.fonte !== "metatag" ? " · " + l.fonte : ""}</span>
        <span class="chip ${av.ra1000 ? "d-bom" : ""}">${av.ra1000 ? "critérios RA1000 ✓" : `faltam ${av.faltam} de 5`}</span></div>
      ${av.crit.map((c) => {
        const pct = typeof c.v === "number" ? Math.min(100, (c.v / (c.max || Math.max(c.v, c.min * 1.4))) * 100) : 0;
        const txt = typeof c.v !== "number" ? "—" : c.tipo === "pct" ? fmtDec(c.v) + "%" : c.tipo === "nota" ? fmtDec(c.v) : fmtNum(c.v);
        const dl = ant && typeof c.v === "number" && ant[c.c] != null ? delta("csat", c.v, Number(ant[c.c])) : null;
        return `<div class="ra-linha">
          <span class="ra-rot">${c.rot}</span>
          <span class="ra-barra"><i class="${c.bate ? "ok" : ""}" style="width:${pct}%"></i><em style="left:${c.max ? (c.min / c.max) * 100 : 70}%"></em></span>
          <span class="ra-val ${c.bate ? "vd" : "vm"}">${txt}${dl && dl.texto && dl.texto !== "＝" ? `<span class="seta ${dl.classe}">${dl.texto.split(" ")[0]}</span>` : ""}</span>
          <span class="ra-meta">meta ${c.tipo === "pct" ? c.min + "%" : c.min}</span>
        </div>`; }).join("")}
      <div class="ra-extra">
        ${l.aguardando != null ? `<span title="Reclamações ainda sem resposta da marca — é o que derruba o índice de resposta"><b class="${Number(l.aguardando) > 0 ? "vm" : ""}">${fmtNum(Number(l.aguardando))}</b> aguardando resposta</span>` : ""}
        ${l.tempo_resposta_dias != null ? `<span><b>${fmtDec(Number(l.tempo_resposta_dias), 0)} d</b> tempo médio de resposta</span>` : ""}
        ${l.reclamacoes != null ? `<span><b>${fmtNum(Number(l.reclamacoes))}</b> reclamações</span>` : ""}
        ${l.nota_consumidor != null ? `<span><b>${fmtDec(Number(l.nota_consumidor))}</b> nota do consumidor</span>` : ""}
      </div>
    </div>`;
  }).join("");
}

// ---------- interação dos blocos novos ----------
document.addEventListener("click", (e) => {
  const b = e.target.closest(".seg-canal button");
  if (!b) return;
  
  estado.canalMotivo = b.dataset.canal;
  document.querySelectorAll(".seg-canal button").forEach((x) => x.classList.toggle("ativo", x.dataset.canal === estado.canalMotivo));
  if (estado.dados) pintaMotivos(estado.dados);
});

// ---------- abas ----------
// A aba vive no hash (#aba=csat): link copiado abre no lugar certo. Filtros continuam globais.
// Tudo é pintado sempre (as abas escondidas também) — trocar de aba é instantâneo e não refaz conta.
const CX_ABAS = ["geral", "chat", "ra", "nps", "social"];
function cxAbaDoHash() {
  const m = /(?:^|[#&])aba=([a-z]+)/.exec(location.hash || "");
  return m && CX_ABAS.includes(m[1]) ? m[1] : "geral";
}
function cxMostraAba(aba, gravar) {
  document.querySelectorAll(".aba-pane").forEach((p) => { p.hidden = p.dataset.aba !== aba; });
  document.querySelectorAll("#abas-cx [role=tab]").forEach((b) => {
    const on = b.dataset.aba === aba; b.classList.toggle("ativo", on); b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (gravar) { const h = aba === "geral" ? "" : "#aba=" + aba; if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h); }
}
document.addEventListener("click", (e) => { const b = e.target.closest("#abas-cx [role=tab]"); if (b) cxMostraAba(b.dataset.aba, true); });
window.addEventListener("hashchange", () => cxMostraAba(cxAbaDoHash(), false));
cxMostraAba(cxAbaDoHash(), false);

// ---------- gráficos das abas ----------
const CX_COR_GRUPO = { wismo: "#2a78d6", "pre-venda": "#1baf7a", resolucao: "#eb6834", outros: "#9c968c" };
function cxJanelaTendencia(fim, semanas) { return { ini: diasAtras(7 * semanas - 1, fim), fim }; }
function cxMarcasSerie() { return estado.marca === "todas" ? MARCAS.filter((m) => m !== "olivas") : [estado.marca]; }

// Visão geral: contatos por 100 pedidos por dia (por marca) + contatos por semana por motivo
function pintaTendencias(d) {
  const el2 = $("#g-motivos"); if (!el2) return;
  const rows = d.cx_csat || [];
  const per = cxPeriodoComDado(rows, estado.marca);
  if (per.vazio) { el2.innerHTML = `<div class="vazio mini">Sem cx_csat na API.</div>`; return; }
  const j2 = cxJanelaTendencia(per.f.fim, 12);
  const s2 = serieSemanalMotivos(rows, { marca: per.f.marca, ini: j2.ini, fim: j2.fim });
  const c2 = cxCortaVazioInicial(s2.semanas, s2.series.map((s) => s.valores));
  const r = $("#g-motivos-rot"); if (r) r.innerHTML = cxTag("12 semanas", "nota", "Semana começa na segunda; a última pode estar parcial.");
  el2.innerHTML = cxgBarras({ rotulosX: c2.semanas.map(fmtDia), fmt: fmtNum, aria: "Contatos por semana por motivo",
    series: s2.series.map((s, i) => ({ nome: s.nome, cor: CX_COR_GRUPO[s.k], valores: c2.colunas[i] })) });
}

// Chat: Kai resolve por semana + quem fechou por semana (barras 100%)
function pintaGraficosChat(d) {
  const el1 = $("#g-kai"), el2 = $("#g-desfecho");
  if (!el1 || !el2) return;
  const fim = PER_DESF.fim >= hojeRef() ? diasAtras(1, hojeRef()) : PER_DESF.fim;
  const j = cxJanelaTendencia(fim, 12);
  const k = serieSemanalKai(d.cx_desfecho, estado.marca, j.ini, j.fim);
  const marcos = (d.cx_marco || []).map((m) => { const s = cxSegunda(cxDia(m.dia)); const i = k.semanas.indexOf(s); return i < 0 ? null : { i, rot: fmtDia(cxDia(m.dia)), title: `${fmtDia(cxDia(m.dia))} — ${m.titulo}` }; }).filter(Boolean);
  const ck = cxCortaVazioInicial(k.semanas, [k.pontos.map((p) => p.n)]); const cortK = k.semanas.length - ck.semanas.length;
  marcos.forEach((m) => { m.i -= cortK; }); const marcosOk = marcos.filter((m) => m.i >= 0);
  k.semanas = ck.semanas; k.pontos = k.pontos.slice(cortK);
  el1.innerHTML = cxgLinhas({ rotulosX: k.semanas.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: "Kai resolve sozinho por semana", marcos: marcosOk,
    series: [{ nome: "Kai sozinho", cor: corHex(estado.marca), pontos: k.pontos.map((p) => ({ y: p.y, rot: "semana de " + fmtDia(p.semana), n: `${fmtNum(p.n)} com desfecho` })) }] });
  // quem fechou: kai / pessoa / ninguém, por semana
  const acc = {};
  for (const l of d.cx_desfecho || []) { const dia = cxDia(l.dia); if (dia < j.ini || dia > j.fim || l.canal === "email") continue; if (estado.marca !== "todas" && l.marca !== estado.marca) continue;
    const s = cxSegunda(dia); const a = acc[s] || (acc[s] = { kai: 0, pessoa: 0, ninguem: 0 }); a.kai += Number(l.resolvido_kai || 0); a.ninguem += Number(l.escalado_sem_resposta || 0); a.pessoa += Number(l.escalado || 0) - Number(l.escalado_sem_resposta || 0); }
  const g = (kk) => k.semanas.map((s) => (acc[s] ? Math.max(0, acc[s][kk]) : 0));
  el2.innerHTML = cxgBarras({ rotulosX: k.semanas.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: "Quem fechou o ticket por semana",
    series: [{ nome: "Kai", cor: "var(--bom)", valores: g("kai") }, { nome: "Pessoa", cor: "var(--borda-forte)", valores: g("pessoa") }, { nome: "Ninguém respondeu", cor: "var(--ruim)", valores: g("ninguem") }] });
}

// Reclame Aqui: índices por dia, por marca
function pintaGraficoRa(d) {
  const a = $("#g-ra-resposta"), b = $("#g-ra-solucao");
  if (!a || !b) return;
  const marcas = cxMarcasSerie();
  const linha = (campo, el) => {
    const s = serieRa(d.cx_ra, marcas, campo);
    if (!s.dias.length) { el.innerHTML = `<div class="vazio mini">Sem leitura ainda. A série começa quando o bookmarklet gravar a primeira.</div>`; return; }
    if (s.dias.length < 2) { el.innerHTML = `<div class="vazio mini">Primeira leitura em ${fmtDia(s.dias[0])}: ${s.series.map((x) => `${ROTULOS[x.marca]} <b>${fmtDec(x.pontos[0].y)}%</b>`).join(" · ")}. A curva aparece a partir da segunda leitura.</div>`; return; }
    el.innerHTML = cxgLinhas({ rotulosX: s.dias.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: campo,
      series: s.series.map((x) => ({ nome: ROTULOS[x.marca], cor: corHex(x.marca), pontos: x.pontos.map((p) => ({ y: p.y, rot: fmtDia(p.dia) })) })), alvo: { y: 90, rot: "alvo 90%" } });
  };
  linha("resposta_pct", a); linha("solucao_pct", b);
}

// NPS por semana por marca
function pintaGraficoNps(d) {
  const el = $("#g-nps"); if (!el) return;
  const j = cxJanelaTendencia(PER.fim, 12);
  const marcas = cxMarcasSerie();
  const s0 = serieSemanalNps(d.nps, marcas, j.ini, j.fim, NPS_MARCA);
  const cn = cxCortaVazioInicial(s0.semanas, s0.series.map((x) => x.pontos.map((p) => p.n))); const cortN = s0.semanas.length - cn.semanas.length;
  const s = { semanas: cn.semanas, series: s0.series.map((x) => ({ marca: x.marca, pontos: x.pontos.slice(cortN) })) };
  $("#g-nps-rot").innerHTML = cxTag("12 semanas", "nota", "Semana começa na segunda; NPS = % promotores − % detratores.");
  el.innerHTML = cxgLinhas({ rotulosX: s.semanas.map(fmtDia), yMax: 100, fmt: (v) => String(Math.round(v)), aria: "NPS por semana",
    series: s.series.map((x) => ({ nome: ROTULOS[x.marca], cor: corHex(x.marca), pontos: x.pontos.map((p) => ({ y: p.y, rot: "semana de " + fmtDia(p.semana), n: `${fmtNum(p.n)} votos` })) })),
    vazio: "Sem semana com 10+ votos no intervalo." });
}

// Comentários por semana: respondidos × sem resposta; sentimento
function pintaGraficoSocial(d) {
  const a = $("#g-social-resp"), b = $("#g-social-sent"); if (!a || !b) return;
  const j = cxJanelaTendencia(PER.fim, 12);
  const s0 = serieSemanalSocial(d.social, estado.marca, j.ini, j.fim);
  const cs = cxCortaVazioInicial(s0.semanas, [s0.total]); const cortS = s0.semanas.length - cs.semanas.length;
  const s = Object.fromEntries(Object.entries(s0).map(([k, v]) => [k, Array.isArray(v) ? v.slice(cortS) : v]));
  a.innerHTML = cxgBarras({ rotulosX: s.semanas.map(fmtDia), fmt: fmtNum, aria: "Comentários por semana",
    series: [{ nome: "Respondidos pela marca", cor: corHex(estado.marca), valores: s.respondidos }, { nome: "Sem resposta", cor: "#c9463d", valores: s.semResposta }] });
  b.innerHTML = cxgBarras({ rotulosX: s.semanas.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: "Sentimento por semana",
    series: [{ nome: "Negativo", cor: "var(--ruim)", valores: s.neg }, { nome: "Neutro", cor: "var(--borda-forte)", valores: s.neu }, { nome: "Positivo", cor: "var(--bom)", valores: s.pos }],
    vazio: "Sem comentário classificado no intervalo." });
}

// Painéis recolhíveis: um clique do usuário vale mais que a regra "abre se fora do alvo".
document.addEventListener("toggle", (e) => { if (e.target && e.target.classList && e.target.classList.contains("dobra-painel")) e.target.dataset.tocado = "1"; }, true);
