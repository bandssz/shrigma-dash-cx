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

// ---------- 1. Os seis números ----------
function pintaSeisNumeros(d) {
  const alvo = $("#area-seis");
  if (!alvo) return;
  const rows = d.cx_csat || [];
  const marca = estado.marca;
  const todas = marca === "todas";
  const per = cxPeriodoComDado(rows, marca);
  const rot = $("#seis-rot");
  if (per.vazio) {
    alvo.innerHTML = `<div class="vazio">A API ainda não devolve <code>cx_csat</code>. Os seis números entram quando o bloco existir.</div>`;
    if (rot) rot.innerHTML = cxTag("bloco cx_csat ausente", "alerta", "A API de leitura precisa devolver a view cx_csat_dia. Enquanto isso, o resto do painel segue funcionando.");
    return;
  }
  if (rot) rot.innerHTML = (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    (per.semHist ? cxTag("sem histórico para comparar", "nota", "O período de comparação tem menos de 80% dos dias coletados (cx_ticket começa em 16/07). Os chips de variação ficam de fora.") : "") +
    (per.f.fim >= hojeRef() && diffDias(per.f.ini, per.f.fim) < 2 ? cxTag("dia em andamento", "nota", "Ticket aberto hoje ainda vai receber nota e motivo. Números de hoje mudam até amanhã.") : "");

  const marcas = todas ? MARCAS.filter((m) => m !== "olivas") : [marca];
  const cpp = contatosPorPedido(rows, d.cx_pedidos, per.f);
  const cppAnt = per.fAnt ? contatosPorPedido(rows, d.cx_pedidos, per.fAnt) : null;
  const porMarcaCpp = Object.fromEntries(marcas.map((m) => [m, contatosPorPedido(rows, d.cx_pedidos, Object.assign({}, per.f, { marca: m }))]));
  const subMarcas = (f) => todas ? marcas.map((m) => `${CX_SIGLA[m]} <b>${f(porMarcaCpp[m])}</b>`).join(" · ") : "";
  const temPed = typeof cpp.pedidos === "number";
  const semPed = cxTag("sem pedidos", "alerta", "cx_pedido_dia está vazia: a coleta de pedidos da Shopify ainda não roda. Quando existir, este cartão vira a razão por pedido.");
  const janCurta = cpp.janelaCurta ? cxTag("janela curta", "nota", "Em menos de 7 dias a razão é frágil: o WISMO de hoje é sobre pedidos de dias anteriores.") : "";

  const t1 = temPed
    ? cxTile({ rot: "Contatos / 100 pedidos", val: fmtDec(cpp.por100), tags: janCurta, metrica: "contatos_por_pedido", valor: cpp.por100,
        sub: `${fmtNum(cpp.contatos)} contatos · ${fmtNum(cpp.pedidos)} pedidos`,
        chip: cxChip("contatos_por_pedido", cpp.por100, cppAnt && cppAnt.por100, fmtDec),
        ref: subMarcas((x) => fmtDec(x.por100)) || "todos os canais, e-mail incluso",
        title: "Contatos (todos os canais) ÷ pedidos criados no mesmo período × 100. Linha de base ago 1–15: Aristocrata 20, Fishermans 17. Alvo: abaixo de 12." })
    : cxTile({ rot: "Contatos / dia", val: fmtDec(cpp.contatosDia, 0), tags: semPed,
        sub: `${fmtNum(cpp.contatos)} contatos em ${cpp.dias} dia${cpp.dias > 1 ? "s" : ""}`,
        chip: cxChip("contatos_dia", cpp.contatosDia, cppAnt && cppAnt.contatosDia, (v) => fmtDec(v, 0)),
        ref: subMarcas((x) => fmtDec(x.contatosDia, 0) + "/dia") || "todos os canais, e-mail incluso",
        title: "Vai virar 'contatos por 100 pedidos' (alvo < 12) quando a coleta de pedidos existir. Hoje mostra a média diária de contatos de todos os canais." });

  const t2 = temPed
    ? cxTile({ rot: "WISMO / pedido", val: fmtDec(cpp.wismoRate) + "%", tags: janCurta, metrica: "wismo_rate", valor: cpp.wismoRate,
        sub: `${fmtNum(cpp.wismo)} “cadê meu pedido” · ${fmtNum(cpp.pedidos)} pedidos`,
        chip: cxChipPP("wismo_rate", cpp.wismoRate, cppAnt && cppAnt.wismoRate, 1),
        ref: subMarcas((x) => fmtDec(x.wismoRate) + "%") || "só chat: e-mail não recebe tag",
        title: "Tickets com tag wismo (WhatsApp, Instagram e widget) ÷ pedidos criados × 100. E-mail não recebe tag, então é piso. Base ago 1–15: Aristocrata 8%, Fishermans 2%. Alvo: abaixo de 4%." })
    : cxTile({ rot: "WISMO · fatia", val: fmtPct0(cpp.wismoShare), tags: semPed,
        sub: `${fmtNum(cpp.wismo)} “cadê meu pedido” · ${fmtDec(cpp.wismoDia, 0)}/dia`,
        chip: cxChipPP("wismo_share", cpp.wismoShare, cppAnt && cppAnt.wismoShare),
        ref: subMarcas((x) => fmtPct0(x.wismoShare)) || "só chat: e-mail não recebe tag",
        title: "Vai virar 'WISMO por pedido' (alvo < 4%) quando a coleta de pedidos existir. Hoje mostra a fatia dos contatos que é 'cadê meu pedido'." });

  // CSAT em três níveis (todos os canais do Kai; e-mail não tem CSAT)
  const cs = csatAgg(rows, Object.assign({}, per.f, { canais: CX_CANAIS_KAI }));
  const csAnt = per.fAnt ? csatAgg(rows, Object.assign({}, per.fAnt, { canais: CX_CANAIS_KAI })) : null;
  const t3 = cxTile({ rot: "CSAT · bom", metrica: "csat_bom", valor: cs.baseOk ? cs.pctBom : null,
    val: cs.baseOk ? fmtPct0(cs.pctBom) : `<span class="six-curto">${fmtNum(cs.bom)}<small> de ${fmtNum(cs.avaliadas)}</small></span>`,
    tags: cxTag("3 níveis", "nota", "O Gleap só tem três opções (ruim / neutro / bom). Média não existe aqui: o número é a fatia de 'bom' entre quem avaliou. Só chat: e-mail não tem CSAT."),
    barra: cxBarra3(cs, "fina"),
    sub: `responderam ${fmtPct0(cs.pctResposta)} · ${fmtNum(cs.avaliadas)} votos`,
    chip: cs.baseOk ? cxChipPP("csat_bom", cs.pctBom, csAnt && csAnt.baseOk ? csAnt.pctBom : null) : "",
    ref: todas ? marcas.map((m) => { const a = csatAgg(rows, Object.assign({}, per.f, { marca: m, canais: CX_CANAIS_KAI })); return `${CX_SIGLA[m]} <b>${a.baseOk ? fmtPct0(a.pctBom) : fmtNum(a.bom) + "/" + fmtNum(a.avaliadas)}</b>`; }).join(" · ")
               : `neutro ${fmtPct0(cs.pctNeutro)} · ruim ${fmtPct0(cs.pctRuim)}`,
    title: "Base ago 1–15: Aristocrata 53% bom, Fishermans 65%. Benchmark do handoff: 80–85% é média de mercado, 90%+ é referência." });

  // Kai resolve sozinho (mesmo denominador do bloco de desfecho)
  const kr = kaiResolve(marca, PER_DESF.ini, PER_DESF.fim);
  let krAnt = null;
  if (estado.comparar) { const a = rangeAnterior(PER_DESF.ini, PER_DESF.fim); krAnt = kaiResolve(marca, a.ini, a.fim); }
  const t4 = cxTile({ rot: "Kai sozinho",
    val: kr.pct === null ? (kr.decididos ? `<span class="six-curto">${fmtNum(kr.kai)}<small> de ${fmtNum(kr.decididos)}</small></span>` : "—") : fmtDec(kr.pct) + "%",
    tags: cxTag("por transferência", "nota", "Escalado = ticket transferido para time ou agente (processingTeam/processingUser). Ticket aberto, abandonado ou com promessa vazia fica fora do denominador. E-mail fora: o Kai não roda lá."),
    sub: `${fmtNum(kr.kai)} fechou sozinho · ${fmtNum(kr.decididos)} com desfecho`,
    chip: cxChipPP("kai_resolve", kr.pct, krAnt && krAnt.pct, 1),
    ref: todas ? marcas.map((m) => { const k = kaiResolve(m, PER_DESF.ini, PER_DESF.fim); return `${CX_SIGLA[m]} <b>${k.pct === null ? fmtNum(k.kai) + "/" + fmtNum(k.decididos) : fmtDec(k.pct) + "%"}</b>`; }).join(" · ") : "",
    title: "Objetivo-norte: resolvido sem humano com cliente satisfeito. Quebra de série em 29/08 (8 alterações no Kai): não compare antes com depois sem cortar ali." });

  // Reclame Aqui: última leitura por marca
  const ra = marcas.map((m) => ({ m, l: raUltimo(d.cx_ra, m, cxRaFim(per.f.fim)) }));
  const raAnt = (m) => per.fAnt ? raUltimo(d.cx_ra, m, per.fAnt.fim) : null;
  const tileRa = (rot, campo, metrica, title) => {
    const com = ra.filter((x) => x.l && typeof Number(x.l[campo]) === "number" && x.l[campo] !== null);
    if (!com.length) return cxTile({ rot, val: "—", tags: cxTag("sem coleta", "alerta", "cx_ra_dia está vazia. A coleta diária das metatags da página da marca no Reclame AQUI ainda não roda."), sub: "Reclame AQUI", title });
    const pior = com.reduce((a, x) => (Number(x.l[campo]) < Number(a.l[campo]) ? x : a));
    const v = Number(pior.l[campo]);
    const ant = raAnt(pior.m);
    const idade = Math.round((new Date(hojeRef() + "T12:00Z") - new Date(cxDia(pior.l.dia) + "T12:00Z")) / 864e5);
    return cxTile({ rot, val: fmtDec(v) + "%", metrica, valor: v,
      tags: idade > 2 ? cxTag(`coleta há ${idade} d`, "alerta", "Última leitura do Reclame AQUI é de " + fmtDia(cxDia(pior.l.dia))) : "",
      sub: todas ? `pior: ${ROTULOS[pior.m]}` : `leitura de ${fmtDia(cxDia(pior.l.dia))}`,
      chip: cxChipPP(metrica, v, ant ? Number(ant[campo]) : null, 1),
      ref: todas ? com.map((x) => `${CX_SIGLA[x.m]} <b>${fmtDec(Number(x.l[campo]))}%</b>`).join(" · ") : (pior.l.aguardando != null ? `${fmtNum(Number(pior.l.aguardando))} aguardando resposta` : ""),
      title });
  };
  const t5 = tileRa("RA · resposta", "resposta_pct", "ra_resposta", "Índice de resposta na página da marca no Reclame AQUI. Base 12/09: Aristocrata 86,2%, Fishermans 99,5%. Alvo RA1000: 90% nas duas.");
  const t6 = tileRa("RA · solução", "solucao_pct", "ra_solucao", "Índice de solução no Reclame AQUI. Base 12/09: Aristocrata 85,0%, Fishermans 71,0%. Alvo RA1000: 90% nas duas.");

  alvo.innerHTML = t1 + t2 + t3 + t4 + t5 + t6;
  pintaLeituraRapida([
    { rot: "Contatos/100 pedidos", metrica: "contatos_por_pedido", v: temPed ? cpp.por100 : null, fmt: (x) => fmtDec(x) },
    { rot: "WISMO/pedido", metrica: "wismo_rate", v: temPed ? cpp.wismoRate : null, fmt: (x) => fmtDec(x) + "%" },
    { rot: "CSAT bom", metrica: "csat_bom", v: cs.baseOk ? cs.pctBom : null, fmt: fmtPct0 },
    ...ra.filter((x) => x.l).flatMap((x) => [
      { rot: `RA resposta ${CX_SIGLA[x.m]}`, metrica: "ra_resposta", v: Number(x.l.resposta_pct), fmt: (y) => fmtDec(y) + "%" },
      { rot: `RA solução ${CX_SIGLA[x.m]}`, metrica: "ra_solucao", v: Number(x.l.solucao_pct), fmt: (y) => fmtDec(y) + "%" }]),
  ], { kai: kr, outros: null });
}

/* Uma linha, em português, com o que está fora do alvo — é o que a liderança lê primeiro.
   Só usa os alvos declarados; sem alvo, não opina. */
function pintaLeituraRapida(itens) {
  const el = $("#leitura-rapida");
  if (!el) return;
  const fora = itens.filter((i) => cxStatus(i.metrica, i.v) === "ruim");
  const aten = itens.filter((i) => cxStatus(i.metrica, i.v) === "atencao");
  const ok = itens.filter((i) => cxStatus(i.metrica, i.v) === "bom");
  const semDado = itens.filter((i) => typeof i.v !== "number").length;
  const li = (i, cls) => `<span class="lr-item ${cls}"><i class="st-dot"></i>${i.rot} <b>${i.fmt(i.v)}</b> <small>(${CX_ALVOS[i.metrica].rot})</small></span>`;
  el.innerHTML = `<span class="lr-rot">${PER.rotulo}</span>` +
    (fora.length ? `<span class="lr-grupo"><span class="lr-tit">Fora do alvo</span>${fora.map((i) => li(i, "st-ruim")).join("")}</span>` : "") +
    (aten.length ? `<span class="lr-grupo"><span class="lr-tit">Atenção</span>${aten.map((i) => li(i, "st-atencao")).join("")}</span>` : "") +
    (ok.length ? `<span class="lr-grupo"><span class="lr-tit">No alvo</span>${ok.map((i) => li(i, "st-bom")).join("")}</span>` : "") +
    (!fora.length && !aten.length && !ok.length ? `<span class="mini">sem alvo avaliável no período</span>` : "") +
    (semDado ? `<span class="mini lr-sem">${semDado} sem dado</span>` : "");
  el.hidden = false;
}

// ---------- 2. Por que o cliente chama — e como sai (motivo × CSAT) ----------
estado.canalMotivo = "todos";
function pintaMotivos(d) {
  const alvo = $("#area-motivos");
  if (!alvo) return;
  const rows = d.cx_csat || [];
  const per = cxPeriodoComDado(rows, estado.marca);
  const rot = $("#motivos-rot");
  if (per.vazio) { alvo.innerHTML = `<div class="vazio">Sem <code>cx_csat</code> na API.</div>`; if (rot) rot.innerHTML = ""; return; }
  const canais = estado.canalMotivo === "todos" ? null : [estado.canalMotivo];
  const pm = porMotivo(rows, Object.assign({}, per.f, { canais }), per.fAnt ? Object.assign({}, per.fAnt, { canais }) : null);
  const outros = pm.linhas.find((l) => l.motivo === "outros");
  if (rot) rot.innerHTML = `${fmtNum(pm.total.tickets)} contatos no chat ` +
    (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    (outros && outros.share >= 25 ? cxTag(`“outros” ${fmtPct0(outros.share)}`, "alerta", "Um em cada quatro contatos sem motivo conhecido: o classificador não está dando conta. É o primeiro motivo a atacar — não dá para reduzir o que não se nomeia.") : "") +
    (pm.email.tickets ? cxTag(`${fmtNum(pm.email.tickets)} por e-mail sem tag`, "nota", "E-mail entra no total de contatos, mas a classificação silenciosa não grava tag de motivo lá. Fora desta tabela e do CSAT.") : "") +
    cxTag("CSAT em 3 níveis", "nota", "Barra: ruim | neutro | bom. Percentual só com 30+ avaliações; abaixo disso, contagem.");

  /* Ordem por volume: a pergunta é "onde atacar", e o maior vem primeiro. A linha marcada
     "atacar" é motivo com fatia >= 20% que esta subindo OU com CSAT bom abaixo de 50%:
     grande e piorando, ou grande e mal resolvido. Regra no title. */
  const linhas = [...pm.linhas].sort((a, b) => b.tickets - a.tickets);
  const maxT = Math.max(...linhas.map((l) => l.tickets), 1);
  const atacar = (l) => l.share >= 20 && ((typeof l.delta === "number" && l.delta > 10) || (l.baseOk && l.pctBom < 50));
  const pctOuN = (pctB, n) => typeof pctB === "number" ? `<strong class="tabn">${fmtPct0(pctB)}</strong>` : (n ? `<span class="mini">${fmtNum(n)} aval.</span>` : "<span class='mini'>—</span>");
  const csatCel = (a) => `<div class="csat-cel">${cxBarra3(a)}${a.baseOk ? `<strong class="tabn">${fmtPct0(a.pctBom)}</strong>` : `<span class="mini">${fmtNum(a.avaliadas)} aval.</span>`}</div>`;
  const dlHtml = (l) => {
    if (!estado.comparar || typeof l.delta !== "number") return "<span class='mini'>—</span>";
    const dl = delta("novos", l.tickets, l.anterior);
    if (!dl.texto) return "<span class='mini'>—</span>";
    const cls = l.motivo === "pre-venda" ? "d-neutro" : l.delta > 0 ? "d-ruim" : l.delta < 0 ? "d-bom" : "d-neutro";
    return `<span class="chip ${cls}" title="antes: ${fmtNum(l.anterior)}">${dl.texto}</span>`;
  };
  alvo.innerHTML = `<div class="rolagem"><table class="motivos">
    <thead><tr>
      <th>Motivo</th>
      <th class="num" title="Contatos do motivo no chat e fatia do total">Contatos</th>
      <th class="num" title="Variação do volume contra o período anterior. Pré-venda subir é neutro (é venda), o resto subir é ruim.">Δ volume</th>
      <th class="num" title="Fatia dos contatos do motivo que o Kai fechou sozinho (transferência real)">Kai sozinho</th>
      <th title="Barra: ruim | neutro | bom entre quem avaliou. Número = fatia de bom. Só com 30+ avaliações.">CSAT</th>
      <th class="num" title="Quem avaliou ÷ contatos do motivo">Resp.</th>
      <th class="num esc" title="CSAT bom quando o Kai fechou sozinho · quando passou por pessoa">bom Kai · pessoa</th>
    </tr></thead>
    <tbody>${linhas.map((l) => `<tr class="${atacar(l) ? "mot-atacar" : ""}">
        <td><span class="mot-nome">${l.rotulo}</span>${atacar(l) ? `<span class="tag alerta mot-tag" title="Fatia ≥ 20% e (volume subindo > 10% ou CSAT bom < 50%): grande e piorando, ou grande e mal resolvido">atacar</span>` : ""}</td>
        <td class="num"><div class="cont-cel"><strong class="tabn">${fmtNum(l.tickets)}</strong><span class="mot-barra"><i style="width:${(l.tickets / maxT) * 100}%"></i></span><span class="mini tabn">${fmtPct0(l.share)}</span></div></td>
        <td class="num">${dlHtml(l)}</td>
        <td class="num">${l.tickets ? `<span class="tabn">${fmtPct0(l.kaiShare)}</span>` : "—"}</td>
        <td>${csatCel(l)}</td>
        <td class="num"><span class="mini tabn">${fmtPct0(l.pctResposta)}</span></td>
        <td class="num esc">${pctOuN(l.kaiBom, l.kaiAvaliadas)} <span class="mini">·</span> ${pctOuN(l.pessoaBom, l.pessoaAvaliadas)}</td>
      </tr>`).join("")}
    </tbody>
    <tfoot><tr>
      <td>Todos os motivos</td>
      <td class="num"><div class="cont-cel"><strong class="tabn">${fmtNum(pm.total.tickets)}</strong></div></td>
      <td class="num">${estado.comparar && pm.anterior ? (cxChip("novos", pm.total.tickets, pm.anterior.tickets) || "") : ""}</td>
      <td class="num"><span class="tabn">${fmtPct0(pm.total.tickets ? ((pm.linhas.reduce((s, l) => s + l.kaiTickets, 0)) / pm.total.tickets) * 100 : null)}</span></td>
      <td>${csatCel(pm.total)}</td>
      <td class="num"><span class="mini tabn">${fmtPct0(pm.total.pctResposta)}</span></td>
      <td class="num esc"></td>
    </tr></tfoot>
  </table></div>`;
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
  const serie = serieCsatSemanal(rows, { marca: per.f.marca, ini: iniSerie, fim: fimSerie }, hojeRef());
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
      <div class="kp-rot">bom · por semana <span class="mini">12 semanas até ${fmtDia(fimSerie)} · linha tracejada = quebra de série</span></div>
      ${cxGraficoSemanal(serie, marcos, corHex(estado.marca))}
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
  const b = e.target.closest("#seg-canal-motivo button");
  if (!b) return;
  document.querySelectorAll("#seg-canal-motivo button").forEach((x) => x.classList.toggle("ativo", x === b));
  estado.canalMotivo = b.dataset.canal;
  if (estado.dados) pintaMotivos(estado.dados);
});

// ---------- abas ----------
// A aba vive no hash (#aba=csat): link copiado abre no lugar certo. Filtros continuam globais.
// Tudo é pintado sempre (as abas escondidas também) — trocar de aba é instantâneo e não refaz conta.
const CX_ABAS = ["geral", "csat", "operacao", "reputacao"];
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

// Painéis recolhíveis: um clique do usuário vale mais que a regra "abre se fora do alvo".
document.addEventListener("toggle", (e) => { if (e.target && e.target.classList && e.target.classList.contains("dobra-painel")) e.target.dataset.tocado = "1"; }, true);
