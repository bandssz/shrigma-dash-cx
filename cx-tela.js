// ================== CX · TELA DOS BLOCOS NOVOS ==================
// Pinta: os seis números e os motivos (Visão geral) e as abas Chat, Reclame Aqui, NPS e Comentários —
// todas no mesmo padrão: cartões de três camadas dirigindo um gráfico, uma tabela embaixo.
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
    const sc = cxSerieCsatMarcas(d, rows, marcas, j); rotulosX = sc.rotulosX; series = sc.series; marcos = sc.marcos;
    alvoRef = { y: 80, rot: "alvo 80%" };
  } else if (s.k === "kai_resolve") {
    const sk = cxSerieKaiMarcas(d, marcas, j); rotulosX = sk.rotulosX; series = sk.series; marcos = sk.marcos;
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
// ---------- padrão das abas: cartões de três camadas → um gráfico ----------
// Toda aba segue o mesmo desenho (Plausible/Intercom): rótulo · valor · variação nos cartões, o resto
// no title; o cartão ativo dirige o único gráfico da aba; uma tabela embaixo. estado[chave] guarda a
// escolha e CX_BLOCOS[bloco] sabe repintar o gráfico quando o cartão muda.
const CX_BLOCOS = {};
function cxPintaCartoes(bloco, cartoes) {
  const b = CX_BLOCOS[bloco]; const alvo = $(b.area); if (!alvo) return;
  const ativo = estado[b.chave];
  alvo.innerHTML = cartoes.map((c) => {
    const st = c.status || null;
    const val = typeof c.val === "string" && c.val ? c.val : "—";
    const chip = c.chip || `<span class="mini">${c.sub || ""}</span>`;
    return `<button type="button" class="six2${st ? " st-" + st : ""}${ativo === c.k ? " ativo" : ""}" data-bloco="${bloco}" data-m="${c.k}" title="${String(c.info || "").replace(/"/g, "&quot;")}" aria-pressed="${ativo === c.k}">
      <span class="six2-rot"><i class="st-dot${st ? "" : " st-nulo"}"></i>${c.rot}</span>
      <span class="six2-val">${val}</span>
      <span class="six2-chip">${chip}</span>
    </button>`;
  }).join("");
}
function cxGraficoBloco(bloco, r) {
  const b = CX_BLOCOS[bloco]; const el = $(b.g); if (!el) return;
  el.innerHTML = r.html;
  const t = $(b.tit); if (t && r.tit) t.textContent = r.tit;
  const s = $(b.sub); if (s) s.textContent = r.sub || "";
}
// "N fora do alvo · N em atenção" (ou "tudo no alvo") para o rótulo da seção
function cxResumoStatus(cartoes) {
  const comAlvo = cartoes.filter((c) => c.status);
  if (!comAlvo.length) return "";
  const nFora = comAlvo.filter((c) => c.status === "ruim").length, nAt = comAlvo.filter((c) => c.status === "atencao").length;
  return (nFora ? `<span class="tag st-ruim-tag"><i class="st-dot st-ruim"></i>${nFora} fora do alvo</span>` : "") +
    (nAt ? `<span class="tag nota"><i class="st-dot st-atencao"></i>${nAt} em atenção</span>` : "") +
    (!nFora && !nAt ? `<span class="tag nota"><i class="st-dot st-bom"></i>tudo no alvo</span>` : "");
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".six2[data-bloco]"); if (!btn) return;
  const b = CX_BLOCOS[btn.dataset.bloco]; if (!b) return;
  estado[b.chave] = btn.dataset.m;
  document.querySelectorAll(`${b.area} .six2`).forEach((x) => { const on = x === btn; x.classList.toggle("ativo", on); x.setAttribute("aria-pressed", on); });
  if (estado.dados) b.grafico(estado.dados);
});
// chips: pontos (NPS), contagem com direção e duração
function cxChipPts(atual, anterior, dir) {
  if (!estado.comparar || typeof atual !== "number" || typeof anterior !== "number") return "";
  const d = atual - anterior; if (Math.abs(d) < 0.5) return `<span class="chip d-neutro">＝ · ant. ${fmtNum(anterior)}</span>`;
  const classe = dir === "neutro" ? "d-neutro" : (dir === "alto") === (d > 0) ? "d-bom" : "d-ruim";
  return `<span class="chip ${classe}">${d > 0 ? "▲" : "▼"} ${fmtNum(Math.abs(d))} pts · ant. ${fmtNum(anterior)}</span>`;
}
// durações: diferença em tempo, não em % (1,8h contra 6min daria ">500%")
function cxChipDur(atual, anterior) {
  if (!estado.comparar || typeof atual !== "number" || typeof anterior !== "number") return "";
  const d = atual - anterior; if (Math.abs(d) < Math.max(60, anterior * 0.05)) return `<span class="chip d-neutro">＝ · ant. ${fmtDur(anterior)}</span>`;
  return `<span class="chip ${d > 0 ? "d-ruim" : "d-bom"}">${d > 0 ? "▲" : "▼"} ${fmtDur(Math.abs(d))} · ant. ${fmtDur(anterior)}</span>`;
}
function cxPorMarcaTxt(marcas, fn) { return marcas.map((m) => `${ROTULOS[m]} ${fn(m)}`).join(" · "); }
const CX_SUB_SEMANA = "12 semanas até o fim do período · ponto claro = semana em andamento";

// ---------- séries compartilhadas (Visão geral e abas) ----------
function cxMarcosSemanas(d, semanas) {
  return (d.cx_marco || []).map((m) => ({ i: semanas.indexOf(cxSegunda(cxDia(m.dia))), rot: fmtDia(cxDia(m.dia)), title: `${fmtDia(cxDia(m.dia))} — ${m.titulo}` })).filter((m) => m.i >= 0);
}
const cxLbl = (m) => ({ nome: ROTULOS[m], cor: corHex(m) });
// Kai resolve sozinho por semana, uma linha por marca
function cxSerieKaiMarcas(d, marcas, j) {
  const segHoje = cxSegunda(hojeRef());
  const ss = marcas.map((m) => ({ m, k: serieSemanalKai(d.cx_desfecho, m, j.ini, j.fim) }));
  const c = cxCortaVazioInicial(ss[0].k.semanas, ss.map((x) => x.k.pontos.map((p) => p.n))); const corte = ss[0].k.semanas.length - c.semanas.length;
  return { rotulosX: c.semanas.map(fmtDia), marcos: cxMarcosSemanas(d, c.semanas),
    series: ss.map((x) => Object.assign(cxLbl(x.m), { pontos: x.k.pontos.slice(corte).map((p) => ({ y: p.y, rot: "semana de " + fmtDia(p.semana), n: `${fmtNum(p.n)} com desfecho`, parcial: p.semana === segHoje })) })) };
}
// CSAT bom por semana, uma linha por marca
function cxSerieCsatMarcas(d, rows, marcas, j) {
  const segHoje = cxSegunda(hojeRef());
  const ss = marcas.map((m) => ({ m, c: serieSemanalCsat3(rows, { marca: m, ini: j.ini, fim: j.fim }) }));
  const c = cxCortaVazioInicial(ss[0].c.semanas, ss.map((x) => x.c.tickets)); const corte = ss[0].c.semanas.length - c.semanas.length;
  return { rotulosX: c.semanas.map(fmtDia), marcos: cxMarcosSemanas(d, c.semanas),
    series: ss.map((x) => Object.assign(cxLbl(x.m), { pontos: x.c.pctBom.slice(corte).map((y, i) => ({ y, rot: "semana de " + fmtDia(c.semanas[i]), n: `${fmtNum(x.c.tickets.slice(corte)[i])} contatos`, parcial: c.semanas[i] === segHoje })) })) };
}
// CSAT em três níveis por semana (barras 100%), no escopo
function cxBarrasCsat3(rows, f) {
  const c3b = serieSemanalCsat3(rows, f);
  const cc = cxCortaVazioInicial(c3b.semanas, [c3b.tickets]); const corte = c3b.semanas.length - cc.semanas.length;
  const g = (k) => c3b[k].slice(corte);
  return cxgBarras({ rotulosX: cc.semanas.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: "CSAT por semana em três níveis",
    series: [{ nome: "Ruim", cor: "var(--ruim)", valores: g("ruim") }, { nome: "Neutro", cor: "var(--borda-forte)", valores: g("neutro") }, { nome: "Bom", cor: "var(--bom)", valores: g("bom") }],
    topo: g("pctBom").map((p) => (typeof p === "number" ? Math.round(p) + "%" : "")), vazio: "Sem semana com 30+ avaliações." });
}
// quem fechou por semana (Kai · pessoa · ninguém), barras 100%
function cxBarrasQuemFechou(d, marca, j) {
  const semanas = cxSemanas(j.ini, j.fim); const acc = {};
  for (const l of d.cx_desfecho || []) { const dia = cxDia(l.dia); if (dia < j.ini || dia > j.fim || l.canal === "email") continue; if (marca !== "todas" && l.marca !== marca) continue;
    const s = cxSegunda(dia); const a = acc[s] || (acc[s] = { kai: 0, pessoa: 0, ninguem: 0 }); a.kai += Number(l.resolvido_kai || 0); a.ninguem += Number(l.escalado_sem_resposta || 0); a.pessoa += Number(l.escalado || 0) - Number(l.escalado_sem_resposta || 0); }
  const g = (kk) => semanas.map((s) => (acc[s] ? Math.max(0, acc[s][kk]) : 0));
  const c = cxCortaVazioInicial(semanas, [g("kai"), g("pessoa"), g("ninguem")]);
  return cxgBarras({ rotulosX: c.semanas.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: "Quem fechou o ticket por semana",
    series: [{ nome: "Kai", cor: "var(--bom)", valores: c.colunas[0] }, { nome: "Pessoa", cor: "var(--borda-forte)", valores: c.colunas[1] }, { nome: "Ninguém respondeu", cor: "var(--ruim)", valores: c.colunas[2] }] });
}
// contatos por semana por motivo (4 grupos, cores fixas)
const CX_COR_GRUPO = { wismo: "#2a78d6", "pre-venda": "#1baf7a", resolucao: "#eb6834", outros: "#9c968c" };
function cxBarrasMotivos(rows, f) {
  const s2 = serieSemanalMotivos(rows, f);
  const c2 = cxCortaVazioInicial(s2.semanas, s2.series.map((s) => s.valores));
  return cxgBarras({ rotulosX: c2.semanas.map(fmtDia), fmt: fmtNum, aria: "Contatos por semana por motivo",
    series: s2.series.map((s, i) => ({ nome: s.nome, cor: CX_COR_GRUPO[s.k], valores: c2.colunas[i] })) });
}
// série diária de um campo do snapshot, uma linha por marca (fila, 1ª resposta…)
function cxSerieDiariaMarcas(snapshot, marcas, ini, fim, campo, transf) {
  const dias = [...new Set((snapshot || []).filter((l) => l.dia >= ini && l.dia <= fim).map((l) => l.dia))].sort();
  const series = marcas.map((m) => {
    const pts = serieDiaria(snapshot || [], m, ini, fim, campo);
    const porX = new Map(pts.map((p) => [p.x, p.y]));
    return Object.assign(cxLbl(m), { pontos: dias.map((dd, i) => ({ y: porX.has(i) ? (transf ? transf(porX.get(i)) : porX.get(i)) : null, rot: fmtDia(dd) })) });
  });
  return { rotulosX: dias.map(fmtDia), series, dias };
}
function cxJanelaTendencia(fim, semanas) { return { ini: diasAtras(7 * semanas - 1, fim), fim }; }
function cxMarcasSerie() { return estado.marca === "todas" ? MARCAS.filter((m) => m !== "olivas") : [estado.marca]; }
function fmtHoras(h) { return typeof h !== "number" ? "—" : h < 1 ? Math.round(h * 60) + "min" : fmtDec(h, h < 10 ? 1 : 0) + "h"; }

// ---------- Aba Chat e e-mail: seis números → um gráfico ----------
estado.metricaChat = estado.metricaChat || "csat_bom";
CX_BLOCOS.chat = { area: "#area-chat", g: "#g-chat", tit: "#g-chat-tit", sub: "#g-chat-sub", chave: "metricaChat", grafico: (d) => pintaGraficoChat(d) };
Object.assign(DIRECAO, { sem_resposta: "baixo", fila: "baixo", primeira_resposta: "baixo" });
let CX_CHAT_DADOS = null;
function pintaChat(d, escopo, porMarca) {
  if (!$("#area-chat")) return;
  const rows = d.cx_csat || [];
  const marca = estado.marca, todas = marca === "todas";
  const marcas = todas ? MARCAS.filter((m) => m !== "olivas") : [marca];
  const per = cxPeriodoComDado(rows, marca);
  const a = (escopo && escopo.atual) || {}, antB = (escopo && escopo.anterior) || {}; const ant = antB.__semHistorico ? {} : antB;
  const hoje = hojeRef();
  const pm = (m, campo) => porMarca[m] && porMarca[m].atual ? porMarca[m].atual[campo] : null;

  // CSAT (só chat) e Kai × pessoa
  const cs = per.vazio ? null : csatAgg(rows, Object.assign({}, per.f, { canais: CX_CANAIS_KAI }));
  const csAnt = per.vazio || !per.fAnt ? null : csatAgg(rows, Object.assign({}, per.fAnt, { canais: CX_CANAIS_KAI }));
  const kp = per.vazio ? null : csatKaiVsPessoa(rows, per.f);
  // desfecho (cx_desfecho, período resolvido em pintaDesfecho)
  const kr = kaiResolve(marca, PER_DESF.ini, PER_DESF.fim); let krAnt = null;
  if (estado.comparar) { const r = rangeAnterior(PER_DESF.ini, PER_DESF.fim); krAnt = kaiResolve(marca, r.ini, r.fim); }
  const semResp = (mm, ini, fim) => { const ls = desfechoAgg(d, mm, ini, fim).filter((x) => x.canal !== "email"); const s = ls.reduce((t, x) => t + (x.escalado_sem_resposta || 0), 0); const dec = ls.reduce((t, x) => t + (x.resolvido_kai || 0) + (x.escalado || 0), 0); return { s, dec, pct: dec >= MIN_BASE ? (s / dec) * 100 : null }; };
  const sr = semResp(marca, PER_DESF.ini, PER_DESF.fim); let srAnt = null;
  if (estado.comparar) { const r = rangeAnterior(PER_DESF.ini, PER_DESF.fim); srAnt = semResp(marca, r.ini, r.fim); }
  const saldo = typeof a.novos === "number" && typeof a.fechados === "number" ? a.fechados - a.novos : null;
  const pn = anteriorProgressivo("novos", marca, ant); // "hoje" compara com ontem até a mesma hora
  const temCom = typeof a.primeira_resposta_comercial_seg === "number";
  const pr = temCom ? a.primeira_resposta_comercial_seg : a.primeira_resposta_seg, prAnt = temCom ? ant.primeira_resposta_comercial_seg : ant.primeira_resposta_seg;
  const filaAgora = PER.fim >= hoje;

  const cartoes = [
    { k: "contatos", rot: "Contatos", val: fmtNum(a.novos), chip: chipHtml("novos", a.novos, pn.valor), sub: `resolvidos ${fmtNum(a.fechados)}${pn.mesmaHora ? " · vs ontem até a mesma hora" : ""}`,
      info: `Tickets novos em todos os canais (e-mail incluso) no período.${pn.mesmaHora ? " A variação compara com ontem até a mesma hora." : ""}\nResolvidos ${fmtNum(a.fechados)} · saldo ${saldo === null ? "—" : (saldo > 0 ? "+" : "") + fmtNum(saldo)}.` + (todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => fmtNum(pm(m, "novos")))}` : "") },
    { k: "csat_bom", rot: "CSAT · bom", val: cs && cs.baseOk ? fmtPct0(cs.pctBom) : (cs && cs.avaliadas ? `<span class="six-curto">${fmtNum(cs.bom)} de ${fmtNum(cs.avaliadas)}</span>` : "—"), status: cs && cs.baseOk ? cxStatus("csat_bom", cs.pctBom) : null,
      chip: cs && cs.baseOk ? cxChipPP("csat_bom", cs.pctBom, csAnt && csAnt.baseOk ? csAnt.pctBom : null) : "", sub: cs ? `${fmtNum(cs.avaliadas)} avaliações · responderam ${fmtPct0(cs.pctResposta)}` : "sem cx_csat",
      info: `Fatia de “bom” entre quem avaliou (três opções: ruim / neutro / bom), só chat, com 30+ avaliações. Alvo ≥ 80%.` + (cs ? `\nRuim ${fmtPct0(cs.pctRuim)} · neutro ${fmtPct0(cs.pctNeutro)} · bom ${fmtPct0(cs.pctBom)} · ${fmtNum(cs.avaliadas)} de ${fmtNum(cs.tickets)} responderam.` : "") +
        (kp ? `\nKai fechou sozinho: bom ${kp.kai.baseOk ? fmtPct0(kp.kai.pctBom) : fmtNum(kp.kai.bom) + " de " + fmtNum(kp.kai.avaliadas)} (resp. ${fmtPct0(kp.kai.pctResposta)}) · passou por pessoa: bom ${kp.pessoa.baseOk ? fmtPct0(kp.pessoa.pctBom) : fmtNum(kp.pessoa.bom) + " de " + fmtNum(kp.pessoa.avaliadas)} (resp. ${fmtPct0(kp.pessoa.pctResposta)}). Não são comparáveis entre si.` : "") +
        (todas && !per.vazio ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => { const x = csatAgg(rows, Object.assign({}, per.f, { marca: m, canais: CX_CANAIS_KAI })); return x.baseOk ? fmtPct0(x.pctBom) : "—"; })}` : "") },
    { k: "kai_resolve", rot: "Kai resolve sozinho", val: typeof kr.pct === "number" ? fmtDec(kr.pct) + "%" : (kr.decididos ? `<span class="six-curto">${fmtNum(kr.kai)} de ${fmtNum(kr.decididos)}</span>` : "—"),
      chip: cxChipPP("kai_resolve", kr.pct, krAnt && krAnt.pct, 1), sub: `${fmtNum(kr.kai)} de ${fmtNum(kr.decididos)} com desfecho`,
      info: `Tickets que o Kai fechou sozinho ÷ tickets com desfecho (Kai ou transferido para pessoa — processingTeam/processingUser). E-mail fora. Quebra de série em 29/08.` + (todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => { const x = kaiResolve(m, PER_DESF.ini, PER_DESF.fim); return typeof x.pct === "number" ? fmtDec(x.pct) + "%" : "—"; })}` : "") },
    { k: "sem_resposta", rot: "Ninguém respondeu", val: typeof sr.pct === "number" ? fmtDec(sr.pct) + "%" : (sr.dec ? `<span class="six-curto">${fmtNum(sr.s)} de ${fmtNum(sr.dec)}</span>` : "—"), status: typeof sr.pct === "number" ? (sr.pct >= 10 ? "ruim" : sr.pct >= 5 ? "atencao" : "bom") : null,
      chip: cxChipPP("sem_resposta", sr.pct, srAnt && srAnt.pct, 1), sub: `${fmtNum(sr.s)} tickets`,
      info: `Transferido para time ou agente e fechado sem nenhuma resposta pública de pessoa: a régua fechou na fila. Faixa: até 5% ok, até 10% atenção.` + (todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => { const x = semResp(m, PER_DESF.ini, PER_DESF.fim); return typeof x.pct === "number" ? fmtDec(x.pct) + "%" : "—"; })}` : "") },
    { k: "fila", rot: filaAgora ? "Fila agora" : "Fila no fim do período", val: fmtNum(a.fila_aberta), chip: chipHtml("fila_aberta", a.fila_aberta, ant.fila_aberta), sub: todas ? marcas.concat(["olivas"]).map((m) => `${CX_SIGLA[m]} ${fmtNum(pm(m, "fila_aberta"))}`).join(" · ") : "tickets abertos",
      info: `Tickets abertos ${filaAgora ? "na última coleta" : "no fim do período"}, todos os canais.` + (estado.comparar && typeof ant.fila_aberta === "number" ? `\nAntes: ${fmtNum(ant.fila_aberta)}.` : "") + (todas ? `\n\nPor marca: ${cxPorMarcaTxt(MARCAS, (m) => fmtNum(pm(m, "fila_aberta")))}` : "") },
    { k: "primeira_resposta", rot: temCom ? "1ª resposta · expediente" : "1ª resposta", val: fmtDur(pr), chip: cxChipDur(pr, prAnt), sub: temCom ? `seg–sex 8h–18h · ${fmtNum(a.amostra_comercial)} tickets` : "mediana até a 1ª resposta humana",
      info: (temCom ? `Mediana do tempo até a primeira resposta humana, contando só horário comercial (seg–sex 8h–18h).\nEspera total do cliente, relógio corrido: ${fmtDur(a.primeira_resposta_seg)}` + (typeof a.resolucao_comercial_seg === "number" ? ` · resolução em expediente ${fmtDur(a.resolucao_comercial_seg)}.` : ".") : "Mediana do tempo até a primeira resposta humana, relógio corrido.") +
        (todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => fmtDur(temCom ? pm(m, "primeira_resposta_comercial_seg") : pm(m, "primeira_resposta_seg")))}` : "") },
  ];
  CX_CHAT_DADOS = { per, marcas };
  const rot = $("#chat-rot");
  if (rot) rot.innerHTML = (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    (cs && cs.pctResposta !== null && cs.pctResposta < 25 ? cxTag(`resposta à pesquisa ${fmtPct0(cs.pctResposta)}`, "alerta", "Taxa de resposta abaixo de 25%. Em agosto era 42–46% no Aristocrata e 32–35% na Fishermans; caiu depois das mudanças de 29/08 no Kai. No Instagram o botão de nota não renderiza: o envio lá é perdido.") : "") +
    cxResumoStatus(cartoes);
  cxPintaCartoes("chat", cartoes);
  pintaGraficoChat(d);
}
function pintaGraficoChat(d) {
  if (!CX_CHAT_DADOS || !$("#g-chat")) return;
  const k = estado.metricaChat; const { per, marcas } = CX_CHAT_DADOS; const rows = d.cx_csat || [];
  const fimDesf = PER_DESF.fim >= hojeRef() ? diasAtras(1, hojeRef()) : PER_DESF.fim;
  const j = cxJanelaTendencia(per.vazio ? PER.fim : per.f.fim, 12), jd = cxJanelaTendencia(fimDesf, 12);
  let r;
  if (k === "contatos") r = { tit: "Contatos no chat · por semana e motivo", sub: "só chat — e-mail não recebe tag de motivo · cores fixas por grupo", html: per.vazio ? `<div class="vazio mini">Sem cx_csat na API.</div>` : cxBarrasMotivos(rows, { marca: per.f.marca, ini: j.ini, fim: j.fim }) };
  else if (k === "csat_bom") r = { tit: "CSAT · ruim, neutro e bom · por semana", sub: "número no topo = fatia de bom · só chat", html: per.vazio ? `<div class="vazio mini">Sem cx_csat na API.</div>` : cxBarrasCsat3(rows, { marca: per.f.marca, ini: j.ini, fim: j.fim }) };
  else if (k === "kai_resolve") { const s = cxSerieKaiMarcas(d, marcas, jd); r = { tit: "Kai resolve sozinho · por semana", sub: CX_SUB_SEMANA + " · linha tracejada = quebra de série", html: cxgLinhas({ rotulosX: s.rotulosX, series: s.series, pct: true, fmt: (v) => Math.round(v) + "%", marcos: s.marcos, aria: "Kai resolve sozinho" }) }; }
  else if (k === "sem_resposta") r = { tit: "Quem fechou · por semana", sub: "Kai · pessoa · transferido e ninguém respondeu · só chat", html: cxBarrasQuemFechou(d, estado.marca, jd) };
  else if (k === "fila") { const j8 = cxJanelaTendencia(PER.fim, 8); const s = cxSerieDiariaMarcas(d.snapshot_1d, marcas, j8.ini, j8.fim, "fila_aberta"); r = { tit: "Fila · por dia", sub: "8 semanas até o fim do período · tickets abertos na coleta do dia", html: cxgLinhas({ rotulosX: s.rotulosX, series: s.series, fmt: fmtNum, aria: "Fila por dia", vazio: "Sem série diária no intervalo." }) }; }
  else { const j8 = cxJanelaTendencia(PER.fim, 8); const campo = d.snapshot_1d.some((l) => typeof l.primeira_resposta_comercial_seg === "number") ? "primeira_resposta_comercial_seg" : "primeira_resposta_seg"; const s = cxSerieDiariaMarcas(d.snapshot_1d, marcas, j8.ini, j8.fim, campo, (v) => v / 3600); r = { tit: "1ª resposta · por dia", sub: "8 semanas até o fim do período · mediana em horas" + (campo.includes("comercial") ? " · só horário comercial" : ""), html: cxgLinhas({ rotulosX: s.rotulosX, series: s.series, fmt: fmtHoras, aria: "Primeira resposta por dia", vazio: "Sem série diária no intervalo." }) }; }
  cxGraficoBloco("chat", r);
}

// ---------- Aba Reclame Aqui: critérios do RA1000 como cartões → série por leitura; tabela por marca ----------
estado.metricaRa = estado.metricaRa || "resposta_pct";
CX_BLOCOS.ra = { area: "#area-ra-num", g: "#g-ra", tit: "#g-ra-tit", sub: "#g-ra-sub", chave: "metricaRa", grafico: (d) => pintaGraficoRaAba(d) };
Object.assign(CX_ALVOS, {
  ra_nota: { alvo: 7, base: 6, dir: "alto", rot: "alvo ≥ 7" }, ra_voltaria: { alvo: 70, base: 60, dir: "alto", rot: "alvo ≥ 70%" },
  ra_avaliacoes: { alvo: 50, base: 30, dir: "alto", rot: "alvo ≥ 50" }, ra_aguardando: { alvo: 1, base: 10, dir: "baixo", rot: "alvo 0" },
});
Object.assign(DIRECAO, { ra_nota: "alto", ra_voltaria: "alto", ra_avaliacoes: "alto", ra_aguardando: "baixo" });
const CX_RA_CARTOES = [
  { k: "nota", m: "ra_nota", rot: "Nota média", tipo: "nota", info: "Nota média das avaliações na página da marca. Critério RA1000: ≥ 7." },
  { k: "resposta_pct", m: "ra_resposta", rot: "Respondidas", tipo: "pct", info: "Índice de resposta: reclamações respondidas pela marca. Critério RA1000: ≥ 90%. O que derruba é o que fica aguardando." },
  { k: "solucao_pct", m: "ra_solucao", rot: "Índice de solução", tipo: "pct", info: "Reclamações que o consumidor marcou como resolvidas. Critério RA1000: ≥ 90%." },
  { k: "voltaria_pct", m: "ra_voltaria", rot: "Voltaria a fazer negócio", tipo: "pct", info: "Consumidores que dizem que voltariam a fazer negócio. Critério RA1000: ≥ 70%." },
  { k: "avaliacoes", m: "ra_avaliacoes", rot: "Avaliações", tipo: "int", info: "Quantidade de avaliações no período de referência do RA. Critério RA1000: 50 ou mais." },
  { k: "aguardando", m: "ra_aguardando", rot: "Aguardando resposta", tipo: "int", info: "Reclamações ainda sem resposta da marca. Cada uma pesa no índice de resposta; alvo é zero." },
];
let CX_RA_DADOS = null;
function pintaRaAba(d) {
  if (!$("#area-ra-num")) return;
  const marcas = estado.marca === "todas" ? MARCAS.filter((m) => m !== "olivas") : [estado.marca];
  const todas = marcas.length > 1;
  const lidos = marcas.map((m) => ({ m, l: raUltimo(d.cx_ra, m, cxRaFim(PER.fim)), ant: estado.comparar ? raUltimo(d.cx_ra, m, PER.cFim) : null })).filter((x) => x.l);
  const rot = $("#ra-rotulo"), tab = $("#area-ra"), tabRot = $("#ra-tab-rot");
  CX_RA_DADOS = { marcas };
  if (!lidos.length) {
    if (rot) rot.innerHTML = cxTag("sem coleta", "alerta", "cx_ra_dia está vazia. O bookmarklet ainda não gravou nenhuma leitura da página da marca no Reclame AQUI.");
    cxPintaCartoes("ra", CX_RA_CARTOES.map((c) => ({ k: c.k, rot: c.rot, val: "—", sub: "sem leitura", info: c.info })));
    if (tab) tab.innerHTML = `<div class="vazio">Sem leitura do Reclame AQUI ainda. Quando o bookmarklet gravar a primeira, aqui aparecem os cinco critérios do RA1000 por marca, o que está aguardando resposta e o tempo médio de resposta.</div>`;
    if (tabRot) tabRot.innerHTML = "";
    pintaGraficoRaAba(d); return;
  }
  const num = (l, c) => l && l[c] !== null && l[c] !== undefined ? Number(l[c]) : null;
  const fmtV = (c, v) => typeof v !== "number" ? "—" : c.tipo === "pct" ? fmtDec(v) + "%" : c.tipo === "nota" ? fmtDec(v) : fmtNum(v);
  // com as duas marcas: a pior (alvo alto) ou a soma (aguardando)
  const agrega = (c, src) => { const vs = lidos.map((x) => num(x[src], c.k)).filter((v) => typeof v === "number"); if (!vs.length) return null; return c.k === "aguardando" ? vs.reduce((s, v) => s + v, 0) : Math.min(...vs); };
  const cartoes = CX_RA_CARTOES.map((c) => {
    const v = agrega(c, "l"), va = agrega(c, "ant");
    const chip = c.tipo === "pct" ? cxChipPP(c.m, v, va, 1) : (typeof va === "number" && estado.comparar ? (c.tipo === "nota" ? chipHtml("csat", v, va, (x) => fmtDec(x)) : cxChipPts(v, va, DIRECAO[c.m])) : "");
    const sub = todas ? (c.k === "aguardando" ? "as duas marcas" : "pior marca") : `leitura de ${fmtDia(cxDia(lidos[0].l.dia))}`;
    return { k: c.k, rot: c.rot, val: fmtV(c, v), status: cxStatus(c.m, v), chip, sub, info: c.info + (todas ? `\n\nPor marca: ${lidos.map((x) => `${ROTULOS[x.m]} ${fmtV(c, num(x.l, c.k))}`).join(" · ")}` : "") + `\n\nLeitura de ${fmtDia(cxDia(lidos[0].l.dia))}, metatags da página pública (bookmarklet).` };
  });
  const maisRecente = lidos.map((x) => cxDia(x.l.dia)).sort().pop();
  if (rot) rot.innerHTML = `<span class="tag nota">leitura de ${fmtDia(maisRecente)}</span>` + cxResumoStatus(cartoes);
  cxPintaCartoes("ra", cartoes);
  pintaGraficoRaAba(d);
  // tabela por marca: os cinco critérios + o que pesa
  if (tabRot) tabRot.innerHTML = lidos.map(({ m, l }) => { const av = raAvalia(l); return `<span class="tag ${av.ra1000 ? "nota" : "alerta"}">${CX_SIGLA[m]} · ${av.ra1000 ? "critérios RA1000 ✓" : `faltam ${av.faltam} de 5`}</span>`; }).join("");
  const cel = (c, v, bate) => `<td class="num ${typeof v === "number" ? (bate ? "vd" : "vm") : ""}">${fmtV(c, v)}</td>`;
  if (tab) tab.innerHTML = `<div class="rolagem"><table class="comparativo ra-tab">
    <thead><tr><th>Marca</th>${CX_RA_CARTOES.slice(0, 5).map((c) => `<th class="num" title="${c.info.replace(/"/g, "&quot;")}">${c.rot}<span class="mini meta"> ≥ ${c.tipo === "pct" ? CX_ALVOS[c.m].alvo + "%" : CX_ALVOS[c.m].alvo}</span></th>`).join("")}<th class="num" title="Reclamações sem resposta da marca">Aguardando</th><th class="num" title="Tempo médio de resposta, em dias">Tempo resp.</th><th class="num">Reclamações</th><th class="num" title="Nota que o consumidor dá à marca">Nota consumidor</th></tr></thead>
    <tbody>${lidos.map(({ m, l }) => { const av = raAvalia(l); return `<tr>
      <td><span class="ponto" style="--cor:${corHex(m)}"></span> <span class="nome">${ROTULOS[m]}</span><div class="mini">${fmtDia(cxDia(l.dia))}${l.fonte && l.fonte !== "metatag" ? " · " + l.fonte : ""}</div></td>
      ${av.crit.map((c, i) => cel(CX_RA_CARTOES[i], c.v, c.bate)).join("")}
      <td class="num ${num(l, "aguardando") > 0 ? "vm" : ""}">${fmtNum(num(l, "aguardando"))}</td>
      <td class="num">${l.tempo_resposta_dias != null ? fmtDec(Number(l.tempo_resposta_dias), 0) + " d" : "—"}</td>
      <td class="num">${fmtNum(num(l, "reclamacoes"))}</td>
      <td class="num">${l.nota_consumidor != null ? fmtDec(Number(l.nota_consumidor)) : "—"}</td></tr>`; }).join("")}</tbody></table></div>`;
}
function pintaGraficoRaAba(d) {
  if (!CX_RA_DADOS || !$("#g-ra")) return;
  const c = CX_RA_CARTOES.find((x) => x.k === estado.metricaRa) || CX_RA_CARTOES[1];
  const s = serieRa(d.cx_ra, CX_RA_DADOS.marcas, c.k);
  const fmt = c.tipo === "pct" ? (v) => Math.round(v) + "%" : c.tipo === "nota" ? (v) => fmtDec(v, 0) : fmtNum;
  let html;
  if (!s.dias.length) html = `<div class="vazio mini">Sem leitura ainda. A série começa quando o bookmarklet gravar a primeira.</div>`;
  else if (s.dias.length < 2) html = `<div class="vazio mini">Uma leitura só (${fmtDia(s.dias[0])}): ${s.series.map((x) => `${ROTULOS[x.marca]} <b>${typeof x.pontos[0].y === "number" ? (c.tipo === "pct" ? fmtDec(x.pontos[0].y) + "%" : c.tipo === "nota" ? fmtDec(x.pontos[0].y) : fmtNum(x.pontos[0].y)) : "—"}</b>`).join(" · ")}. A curva aparece a partir da segunda leitura.</div>`;
  else html = cxgLinhas({ rotulosX: s.dias.map(fmtDia), pct: c.tipo === "pct", yMax: c.tipo === "nota" ? 10 : undefined, fmt, aria: c.rot,
    series: s.series.map((x) => Object.assign(cxLbl(x.marca), { pontos: x.pontos.map((p) => ({ y: p.y, rot: fmtDia(p.dia) })) })),
    alvo: c.k === "aguardando" ? null : { y: CX_ALVOS[c.m].alvo, rot: "alvo " + (c.tipo === "pct" ? CX_ALVOS[c.m].alvo + "%" : CX_ALVOS[c.m].alvo) } });
  cxGraficoBloco("ra", { tit: c.rot + " · por leitura", sub: "uma leitura por dia, quando o bookmarklet roda · uma linha por marca", html });
}

// ---------- Aba NPS: cinco números → série semanal; tabela por marca + área apontada ----------
estado.metricaNps = estado.metricaNps || "nps";
CX_BLOCOS.nps = { area: "#area-nps-num", g: "#g-nps", tit: "#g-nps-tit", sub: "#g-nps-sub", chave: "metricaNps", grafico: (d) => pintaGraficoNpsAba(d) };
Object.assign(DIRECAO, { nps_prom: "alto", nps_detr: "baixo" });
function npsSemanal(votos, marcas, ini, fim) {
  const semanas = cxSemanas(ini, fim); const acc = {};
  for (const v of votos || []) {
    const m = NPS_MARCA[v.marca] || v.marca; const dd = new Date(new Date(v.data).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    if (dd < ini || dd > fim) continue; const s = cxSegunda(dd);
    const a = acc[m + "|" + s] || (acc[m + "|" + s] = { n: 0, prom: 0, detr: 0, soma: 0 }); a.n++; a.soma += Number(v.score || 0);
    if (v.bucket === "promotor") a.prom++; if (v.bucket === "detrator") a.detr++;
  }
  const get = (m, s) => acc[m + "|" + s] || { n: 0, prom: 0, detr: 0, soma: 0 };
  const tot = semanas.map((s) => marcas.reduce((t, m) => { const a = get(m, s); t.n += a.n; t.prom += a.prom; t.detr += a.detr; return t; }, { n: 0, prom: 0, detr: 0 }));
  return { semanas, get, tot };
}
function pintaNpsAba(d) {
  if (!$("#area-nps-num")) return;
  const marca = estado.marca, todas = marca === "todas";
  const g = calculaNps(d.nps, marca, PER.ini, PER.fim), ga = estado.comparar ? calculaNps(d.nps, marca, PER.cIni, PER.cFim) : { n: 0 };
  const marcasVoto = todas ? MARCAS.filter((m) => calculaNps(d.nps, m, PER.ini, PER.fim).n) : [marca];
  const okAnt = ga.n >= 10;
  const pct = (x, n) => (n ? (x / n) * 100 : null);
  const porMarca = (fn) => todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcasVoto, (m) => fn(calculaNps(d.nps, m, PER.ini, PER.fim)))}` : "";
  const cartoes = [
    { k: "nps", rot: "NPS", val: g.n ? String(g.nps) : "—", status: g.n >= 10 ? (g.nps >= 50 ? "bom" : g.nps >= 30 ? "atencao" : "ruim") : null, chip: g.n >= 10 && okAnt ? cxChipPts(g.nps, ga.nps, "alto") : "", sub: g.n ? `${fmtNum(g.n)} votos` : "sem votos no período",
      info: `% promotores (9–10) − % detratores (0–6). Faixa: ≥ 50 bom, 30–49 atenção, < 30 fora. Chip só com 10+ votos nos dois períodos.` + porMarca((x) => x.n ? String(x.nps) : "—") },
    { k: "nota", rot: "Nota média", val: g.n ? fmtDec(g.media) + "<small class=\"six-de\">/10</small>" : "—", chip: g.n >= 10 && okAnt ? chipHtml("csat", g.media, ga.media, (v) => fmtDec(v)) : "", sub: g.n ? `${fmtNum(g.n)} votos` : "",
      info: `Média das notas de 0 a 10.` + porMarca((x) => x.n ? fmtDec(x.media) : "—") },
    { k: "prom", rot: "Promotores", val: g.n ? fmtPct0(pct(g.prom, g.n)) : "—", chip: g.n >= 10 && okAnt ? cxChipPP("nps_prom", pct(g.prom, g.n), pct(ga.prom, ga.n)) : "", sub: g.n ? `${fmtNum(g.prom)} deram 9 ou 10` : "",
      info: `Notas 9 e 10.` + porMarca((x) => x.n ? fmtPct0(pct(x.prom, x.n)) : "—") },
    { k: "detr", rot: "Detratores", val: g.n ? fmtPct0(pct(g.detr, g.n)) : "—", chip: g.n >= 10 && okAnt ? cxChipPP("nps_detr", pct(g.detr, g.n), pct(ga.detr, ga.n)) : "", sub: g.n ? `${fmtNum(g.detr)} deram 0 a 6` : "",
      info: `Notas de 0 a 6. Passivos (7 e 8) ficam fora das duas contas.` + porMarca((x) => x.n ? fmtPct0(pct(x.detr, x.n)) : "—") },
    { k: "votos", rot: "Votos", val: g.n ? fmtNum(g.n) : "0", chip: chipHtml("respostas", g.n, ga.n || null), sub: PER.rotulo,
      info: `Respostas à pesquisa pós-entrega no período.` + porMarca((x) => fmtNum(x.n)) },
  ];
  const rot = $("#nps-rotulo");
  if (rot) rot.innerHTML = (g.n && g.n < 10 ? cxTag("amostra pequena", "nota", "Menos de 10 votos no período: leia a contagem, não a taxa.") : "") + cxResumoStatus(cartoes);
  cxPintaCartoes("nps", cartoes);
  pintaGraficoNpsAba(d);
}
function pintaGraficoNpsAba(d) {
  if (!$("#g-nps")) return;
  const k = estado.metricaNps; const j = cxJanelaTendencia(PER.fim, 12); const marcas = cxMarcasSerie();
  const segHoje = cxSegunda(hojeRef());
  const ns = npsSemanal(d.nps, marcas, j.ini, j.fim);
  const c = cxCortaVazioInicial(ns.semanas, [ns.tot.map((t) => t.n)]); const corte = ns.semanas.length - c.semanas.length; const semanas = c.semanas;
  const rotulosX = semanas.map(fmtDia); let r;
  const linhaMarcas = (fn, opts, tit, sub) => ({ tit, sub, html: cxgLinhas(Object.assign({ rotulosX, aria: tit, vazio: "Sem semana com 10+ votos no intervalo.",
    series: marcas.map((m) => Object.assign(cxLbl(m), { pontos: semanas.map((s) => { const a = ns.get(m, s); return { y: a.n >= 10 ? fn(a) : null, rot: "semana de " + fmtDia(s), n: `${fmtNum(a.n)} votos`, parcial: s === segHoje }; }) })) }, opts)) });
  if (k === "nota") r = linhaMarcas((a) => a.soma / a.n, { yMax: 10, fmt: (v) => fmtDec(v, 0) }, "Nota média · por semana", CX_SUB_SEMANA + " · semana com menos de 10 votos fica em branco");
  else if (k === "prom" || k === "detr") { const tot = ns.tot.slice(corte); r = { tit: "Promotores · passivos · detratores · por semana", sub: "fatia dos votos da semana · número no topo = NPS", html: cxgBarras({ rotulosX, pct: true, fmt: (v) => Math.round(v) + "%", aria: "Distribuição do NPS por semana", vazio: "Sem voto no intervalo.",
      series: [{ nome: "Detratores", cor: "var(--ruim)", valores: tot.map((t) => t.detr) }, { nome: "Passivos", cor: "var(--borda-forte)", valores: tot.map((t) => t.n - t.prom - t.detr) }, { nome: "Promotores", cor: "var(--bom)", valores: tot.map((t) => t.prom) }],
      topo: tot.map((t) => (t.n >= 10 ? String(Math.round(((t.prom - t.detr) / t.n) * 100)) : "")) }) }; }
  else if (k === "votos") r = { tit: "Votos · por semana", sub: "respostas à pesquisa pós-entrega · uma cor por marca", html: cxgBarras({ rotulosX, fmt: fmtNum, aria: "Votos por semana", vazio: "Sem voto no intervalo.", series: marcas.map((m) => Object.assign(cxLbl(m), { valores: semanas.map((s) => ns.get(m, s).n) })) }) };
  else r = linhaMarcas((a) => Math.round(((a.prom - a.detr) / a.n) * 100), { yMax: 100, fmt: (v) => String(Math.round(v)) }, "NPS · por semana", CX_SUB_SEMANA + " · semana com menos de 10 votos fica em branco");
  cxGraficoBloco("nps", r);
}

// ---------- Aba Comentários: cinco números → série semanal; tabela por marca + pendências ----------
estado.metricaSocial = estado.metricaSocial || "total";
CX_BLOCOS.social = { area: "#area-social-num", g: "#g-social", tit: "#g-social-tit", sub: "#g-social-sub", chave: "metricaSocial", grafico: (d) => pintaGraficoSocialAba(d) };
Object.assign(DIRECAO, { soc_resp: "alto", soc_neg: "baixo", soc_tempo: "baixo" });
function socialAgg(d, marcas, ini, fim) {
  const a = { total: 0, respondidos: 0, aguardando: 0, pos: 0, neg: 0, neu: 0, ocultos: 0, apagados: 0 };
  for (const l of d.social || []) { if (l.dia < ini || l.dia > fim || !marcas.includes(l.marca)) continue; for (const k of Object.keys(a)) a[k] += Number(l[k] || 0); }
  let num = 0, den = 0;
  for (const t of d.social_tempo || []) { if (t.dia < ini || t.dia > fim || !marcas.includes(t.marca)) continue; num += Number(t.mediana_seg || 0) * Number(t.respondidos || 0); den += Number(t.respondidos || 0); }
  a.tempoSeg = den ? num / den : null; a.tempoN = den;
  a.clas = a.pos + a.neg + a.neu;
  a.pctResp = a.total ? (a.respondidos / a.total) * 100 : null; a.pctNeg = a.clas ? (a.neg / a.clas) * 100 : null;
  return a;
}
function pintaSocialAba(d) {
  if (!$("#area-social-num")) return;
  const todas = estado.marca === "todas"; const marcas = todas ? MARCAS : [estado.marca];
  const a = socialAgg(d, marcas, PER.ini, PER.fim), an = estado.comparar ? socialAgg(d, marcas, PER.cIni, PER.cFim) : null;
  const comDados = marcas.filter((m) => socialAgg(d, [m], PER.ini, PER.fim).total);
  const porMarca = (fn) => todas && comDados.length ? `\n\nPor marca: ${cxPorMarcaTxt(comDados, (m) => fn(socialAgg(d, [m], PER.ini, PER.fim)))}` : "";
  const cartoes = [
    { k: "total", rot: "Comentários", val: fmtNum(a.total), chip: chipHtml("respostas", a.total, an && an.total || null), sub: PER.rotulo + " · orgânico + anúncios", info: "Comentários novos em posts e anúncios da marca no Instagram e no Facebook." + porMarca((x) => fmtNum(x.total)) },
    { k: "resp", rot: "Respondidos pela marca", val: a.total ? fmtPct0(a.pctResp) : "—", status: a.total >= 10 ? (a.pctResp >= 80 ? "bom" : a.pctResp >= 50 ? "atencao" : "ruim") : null, chip: a.total ? cxChipPP("soc_resp", a.pctResp, an && an.total ? an.pctResp : null) : "", sub: a.total ? `${fmtNum(a.respondidos)} de ${fmtNum(a.total)}` : "",
      info: "Comentários com resposta pública da conta da marca (bot da Replient ou pessoa). Faixa: ≥ 80% bom, 50–79% atenção." + porMarca((x) => x.total ? fmtPct0(x.pctResp) : "—") },
    { k: "aguardando", rot: "Aguardando resposta", val: fmtNum(a.aguardando), status: a.total ? (a.aguardando === 0 ? "bom" : a.aguardando <= 5 ? "atencao" : "ruim") : null, chip: an ? cxChipPts(a.aguardando, an.aguardando, "baixo") : "", sub: "precisavam de resposta",
      info: "Comentários que pediam resposta (pergunta, reclamação, intenção de compra) e ainda não têm. Alvo é zero." + porMarca((x) => fmtNum(x.aguardando)) },
    { k: "neg", rot: "Negativos", val: a.clas ? fmtPct0(a.pctNeg) : "—", chip: a.clas ? cxChipPP("soc_neg", a.pctNeg, an && an.clas ? an.pctNeg : null) : "", sub: a.clas ? `${fmtNum(a.neg)} de ${fmtNum(a.clas)} classificados` : (a.total ? `${fmtNum(a.total)} na fila de classificação` : ""),
      info: "Fatia de comentários classificados como negativos (classificação própria, OpenAI). Positivo " + (a.clas ? fmtPct0((a.pos / a.clas) * 100) : "—") + " · neutro " + (a.clas ? fmtPct0((a.neu / a.clas) * 100) : "—") + "." + porMarca((x) => x.clas ? fmtPct0(x.pctNeg) : "—") },
    { k: "tempo", rot: "Tempo até responder", val: a.tempoSeg !== null ? fmtDur(a.tempoSeg) : "—", chip: a.tempoSeg !== null && an ? cxChipDur(a.tempoSeg, an.tempoSeg) : "", sub: a.tempoN ? `mediana · ${fmtNum(a.tempoN)} respondidos` : "",
      info: "Mediana do tempo entre o comentário e a resposta da marca, ponderada pelo volume do dia. Até 10 minutos é o bot da Replient; acima disso é pessoa." + porMarca((x) => x.tempoSeg !== null ? fmtDur(x.tempoSeg) : "—") },
  ];
  const rot = $("#social-rotulo");
  if (rot) rot.innerHTML = (!a.total ? cxTag("nenhum comentário no período", "nota") : "") + cxResumoStatus(cartoes);
  cxPintaCartoes("social", cartoes);
  pintaGraficoSocialAba(d);
}
function pintaGraficoSocialAba(d) {
  if (!$("#g-social")) return;
  const k = estado.metricaSocial; const j = cxJanelaTendencia(PER.fim, 12);
  const s0 = serieSemanalSocial(d.social, estado.marca, j.ini, j.fim);
  const cs = cxCortaVazioInicial(s0.semanas, [s0.total]); const corte = s0.semanas.length - cs.semanas.length;
  const s = Object.fromEntries(Object.entries(s0).map(([kk, v]) => [kk, Array.isArray(v) ? v.slice(corte) : v]));
  const rotulosX = s.semanas.map(fmtDia); const segHoje = cxSegunda(hojeRef()); let r;
  if (k === "neg") r = { tit: "Sentimento · por semana", sub: "fatia dos comentários classificados · classificação própria (OpenAI)", html: cxgBarras({ rotulosX, pct: true, fmt: (v) => Math.round(v) + "%", aria: "Sentimento por semana", vazio: "Sem comentário classificado no intervalo.",
    series: [{ nome: "Negativo", cor: "var(--ruim)", valores: s.neg }, { nome: "Neutro", cor: "var(--borda-forte)", valores: s.neu }, { nome: "Positivo", cor: "var(--bom)", valores: s.pos }] }) };
  else if (k === "resp") r = { tit: "Respondidos pela marca · por semana", sub: CX_SUB_SEMANA, html: cxgLinhas({ rotulosX, pct: true, fmt: (v) => Math.round(v) + "%", aria: "Respondidos por semana", vazio: "Sem comentário no intervalo.", alvo: { y: 80, rot: "alvo 80%" },
    series: [{ nome: "Respondidos", cor: corHex(estado.marca), pontos: s.semanas.map((sem, i) => ({ y: s.total[i] ? (s.respondidos[i] / s.total[i]) * 100 : null, rot: "semana de " + fmtDia(sem), n: `${fmtNum(s.respondidos[i])} de ${fmtNum(s.total[i])}`, parcial: sem === segHoje })) }] }) };
  else if (k === "tempo") {
    const marcas = estado.marca === "todas" ? MARCAS : [estado.marca]; const acc = {};
    for (const t of d.social_tempo || []) { if (t.dia < j.ini || t.dia > j.fim || !marcas.includes(t.marca)) continue; const sem = cxSegunda(t.dia); const x = acc[sem] || (acc[sem] = { num: 0, den: 0 }); x.num += Number(t.mediana_seg || 0) * Number(t.respondidos || 0); x.den += Number(t.respondidos || 0); }
    r = { tit: "Tempo até responder · por semana", sub: "mediana em horas, ponderada pelo volume · até 10 min é o bot", html: cxgLinhas({ rotulosX, fmt: fmtHoras, aria: "Tempo de resposta por semana", vazio: "Sem resposta medida no intervalo.",
      series: [{ nome: "Mediana", cor: corHex(estado.marca), pontos: s.semanas.map((sem) => ({ y: acc[sem] && acc[sem].den ? acc[sem].num / acc[sem].den / 3600 : null, rot: "semana de " + fmtDia(sem), n: acc[sem] ? `${fmtNum(acc[sem].den)} respondidos` : undefined, parcial: sem === segHoje })) }] }) };
  } else r = { tit: k === "aguardando" ? "Comentários · respondidos × sem resposta · por semana" : "Comentários · por semana", sub: "respondidos pela marca × sem resposta · orgânico + anúncios", html: cxgBarras({ rotulosX, fmt: fmtNum, aria: "Comentários por semana", vazio: "Sem comentário no intervalo.",
    series: [{ nome: "Respondidos pela marca", cor: corHex(estado.marca), valores: s.respondidos }, { nome: "Sem resposta", cor: "#c9463d", valores: s.semResposta }] }) };
  cxGraficoBloco("social", r);
}

// ---------- interação dos blocos ----------
document.addEventListener("click", (e) => {
  const b = e.target.closest(".seg-canal button");
  if (!b) return;
  estado.canalMotivo = b.dataset.canal;
  document.querySelectorAll(".seg-canal button").forEach((x) => x.classList.toggle("ativo", x.dataset.canal === estado.canalMotivo));
  if (estado.dados) pintaMotivos(estado.dados);
});

// ---------- abas ----------
// A aba vive no hash (#aba=chat): link copiado abre no lugar certo. Filtros continuam globais.
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

// Painéis recolhíveis: um clique do usuário vale mais que qualquer regra de abrir sozinho.
document.addEventListener("toggle", (e) => { if (e.target && e.target.classList && e.target.classList.contains("dobra-painel")) e.target.dataset.tocado = "1"; }, true);
