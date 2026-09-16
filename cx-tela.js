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
  ra_nota:             { alvo: 7,  base: 6,  dir: "alto",  rot: "alvo ≥ 7" },
  // transferido para pessoa e ninguém respondeu, sobre tickets de chat maduros — faixa nossa, não do handoff
  sem_resposta:        { alvo: 5,  base: 10, dir: "baixo", rot: "alvo < 5%" },
  // fechamentos (15/09, régua 150 desde 16/09): meta do N1 declarada pelo Felipe — fechamentos resolutivos 150/dia por agente, T. resposta < 8 min e CSAT > 75 (escala do Gleap).
  // "voltou" e FCR são faixas propostas (referência de mercado: reabertura < 15%, FCR ≥ 70%), não meta declarada.
  voltou:              { alvo: 15, base: 25, dir: "baixo", rot: "faixa < 15%" },
  fcr:                 { alvo: 70, base: 55, dir: "alto",  rot: "faixa ≥ 70%" },
  ag_fechados_dia:     { alvo: 150, base: 110, dir: "alto", rot: "meta 150/dia" },
  ag_csat:             { alvo: 75, base: 65, dir: "alto",  rot: "meta > 75" },
  ag_resposta_seg:     { alvo: 480, base: 900, dir: "baixo", rot: "meta < 8 min" },   // mediana em segundos de expediente
  // concessão sobre receita (16/09): meta do Head de CX ainda sem número declarado — faixa provisória até o Samuel fixar a dele.
  concessao_pct:       { alvo: 1,  base: 2,  dir: "baixo", rot: "faixa provisória < 1%" },
};
function cxStatus(metrica, v) {
  const a = CX_ALVOS[metrica];
  if (!a || typeof v !== "number") return null;
  if (a.dir === "baixo") return v < a.alvo ? "bom" : v <= a.base ? "atencao" : "ruim";
  return v >= a.alvo ? "bom" : v >= a.base ? "atencao" : "ruim";
}
const CX_STATUS_ROT = { bom: "no alvo", atencao: "atenção", ruim: "fora do alvo" };

// ---------- Kai resolve (mesmo critério do bloco de desfecho) ----------
// Kai resolve sozinho = desfecho maduro sobre TODOS os tickets de chat criados até D-2 (cx-metricas: desfechoMaduro).
// Se o período não tem dia maduro (ex.: "hoje"), cai para os 7 dias maduros mais recentes e diz que caiu.
function cxKai(rows, f, hoje) {
  let r = desfechoMaduro(rows, f, hoje);
  if (!r.maduro) { const fim = cxFimMaduro(f.fim, hoje); r = desfechoMaduro(rows, Object.assign({}, f, { ini: diasAtras(6, fim), fim }), hoje); r.caiu = true; }
  return r;
}
function cxKaiAnt(rows, f, hoje) {
  if (!estado.comparar || !f) return null;
  const k = cxKai(rows, f, hoje); if (k.caiu) return null;
  const len = diffDias(k.ini, k.fim) + 1; const ant = { ini: diasAtras(len, k.ini), fim: diasAtras(1, k.ini) };
  return desfechoMaduro(rows, Object.assign({}, f, ant), hoje);
}
// Fechamentos e volta em 7 dias (15/09): só fechamentos maduros (7 dias corridos). Período sem dia maduro cai
// para os 7 dias maduros mais recentes e diz que caiu — nunca "—" por imaturidade quando existe histórico.
function cxVolta(rows, f, hoje) {
  const teto = cxFimMaduroVolta(hoje);
  if (f.fim <= teto) return { a: fechamentoAgg(rows, f), ini: f.ini, fim: f.fim, caiu: false, cortou: false };
  if (f.ini <= teto) return { a: fechamentoAgg(rows, Object.assign({}, f, { fim: teto })), ini: f.ini, fim: teto, caiu: false, cortou: true };
  const ini = diasAtras(6, teto);
  return { a: fechamentoAgg(rows, Object.assign({}, f, { ini, fim: teto })), ini, fim: teto, caiu: true, cortou: false };
}
function cxVoltaAnt(rows, v, f) {
  if (!estado.comparar || v.caiu) return null;
  const len = diffDias(v.ini, v.fim) + 1;
  return fechamentoAgg(rows, Object.assign({}, f, { ini: diasAtras(len, v.ini), fim: diasAtras(1, v.ini) }));
}
// Razões por pedido só com dia COMPLETO: cx_pedido_dia de hoje é a foto das 01:20 (17 pedidos) e os contatos
// entram a cada 30 min — a razão de "hoje" dava 361 contatos/100 pedidos e WISMO 190%. Período que só tem hoje
// cai para ontem e diz que caiu.
function cxJanelaCompleta(f, hoje) {
  const ontem = diasAtras(1, hoje);
  if (f.fim < ontem) return { f, caiu: false };
  if (f.ini <= ontem) return { f: Object.assign({}, f, { fim: ontem }), caiu: false, cortou: true };
  return { f: Object.assign({}, f, { ini: ontem, fim: ontem }), caiu: true };
}
// CSAT sem avaliação no período (hoje cedo, ou dia parado): cai para a última janela de mesmo tamanho com avaliação
function cxCsatComAvaliacao(rows, f) {
  const a = csatAgg(rows, Object.assign({}, f, { canais: CX_CANAIS_KAI }));
  if (a.avaliadas) return { a, f, caiu: false };
  const dias = [...new Set(rows.filter((l) => (f.marca === "todas" || l.marca === f.marca) && Number(l.avaliadas) > 0 && cxDia(l.dia) < f.ini).map((l) => cxDia(l.dia)))].sort();
  if (!dias.length) return { a, f, caiu: false };
  const fim = dias[dias.length - 1], ini = diasAtras(diffDias(f.ini, f.fim), fim);
  const f2 = Object.assign({}, f, { ini, fim });
  return { a: csatAgg(rows, Object.assign({}, f2, { canais: CX_CANAIS_KAI })), f: f2, caiu: true };
}
function rangeAnteriorDe(f) { const r = rangeAnterior(f.ini, f.fim); return Object.assign({}, f, r); }
// variação absoluta (para razão como contatos/100 pedidos, que não é percentual)
function cxChipAbs(metrica, atual, anterior, casas) {
  if (!estado.comparar || typeof atual !== "number" || typeof anterior !== "number") return "";
  const d = atual - anterior; if (Math.abs(d) < 0.05) return `<span class="chip d-neutro">＝ · ant. ${fmtDec(anterior, casas)}</span>`;
  const dir = DIRECAO[metrica] || "neutro"; const classe = dir === "neutro" ? "d-neutro" : (dir === "alto") === (d > 0) ? "d-bom" : "d-ruim";
  return `<span class="chip ${classe}">${d > 0 ? "▲" : "▼"} ${fmtDec(Math.abs(d), casas)} · ant. ${fmtDec(anterior, casas)}</span>`;
}

// ---------- 1. Os seis números (padrão Plausible: rótulo · valor · variação; o resto no ⓘ) ----------
// Clicar num cartão troca o único gráfico da Visão geral. estado.metricaGeral guarda a escolha.
estado.metricaGeral = estado.metricaGeral || "contatos_por_pedido";
const CX_SEIS = [
  { k: "contatos_por_pedido", rot: "Contatos / 100 pedidos", fmt: (v) => fmtDec(v), casas: 1, pct: false },
  { k: "wismo_rate",          rot: "WISMO / pedido",         fmt: (v) => fmtDec(v) + "%", casas: 1, pct: true },
  { k: "csat_bom",            rot: "CSAT · bom",             fmt: fmtPct0, casas: 0, pct: true },
  { k: "kai_resolve",         rot: "Kai resolve sozinho",    fmt: (v) => fmtDec(v) + "%", casas: 1, pct: true },
  { k: "sem_resposta",        rot: "Ninguém respondeu",      fmt: (v) => fmtDec(v) + "%", casas: 1, pct: true },
  { k: "ra_nota",             rot: "Reclame Aqui · nota",    fmt: (v) => fmtDec(v), casas: 1, pct: false, nota: true },
];
const CX_INFO = {
  contatos_por_pedido: "Contatos de todos os canais (e-mail incluso) ÷ pedidos criados no mesmo período × 100. Só dias completos: os pedidos de hoje fecham na coleta das 01:20.\nAlvo < 12. Base ago 1–15: Aristocrata 20, Fishermans 42.",
  wismo_rate: "Tickets com tag wismo (só chat: e-mail não recebe tag) ÷ pedidos criados no mesmo período × 100. Não é a fatia dos contatos (essa está na tabela de motivos): é quantos “cadê meu pedido” chegam por pedido vendido. Só dias completos.\nAlvo < 4%. Base ago 1–15: Aristocrata 7,8%, Fishermans 5,3%.",
  csat_bom: "O Gleap tem três opções (ruim / neutro / bom). O número é a fatia de bom entre quem avaliou, só chat, com 30+ avaliações.\nAlvo ≥ 80%. Base ago 1–15: Aristocrata 53%, Fishermans 65%.",
  kai_resolve: "Tickets de chat que o Kai fechou sozinho (fechado, sem resposta humana, sem transferência, sem tag de inatividade) ÷ TODOS os tickets de chat com 2 dias de expediente de maturação (sex, sáb e dom não têm atendimento humano) — não só os que fecharam. O que falta para 100% é: pessoa respondeu · transferido e ninguém respondeu · ainda aberto. E-mail fora. Quebra de série em 29/08.\nSem alvo declarado: acompanhar a tendência.",
  sem_resposta: "Tickets de chat transferidos para time ou agente (processingTeam/processingUser) sem NENHUMA resposta pública de pessoa — abertos na fila ou fechados pela régua — ÷ todos os tickets de chat maduros (2 dias de expediente). É o número que a fila esconde.\nFaixa nossa: < 5% ok, até 10% atenção.",
  ra_nota: "Nota da empresa na página do Reclame AQUI (últimos 6 meses), lida pelas metatags. Embaixo, o que compõe o RA1000: respondidas ≥ 90%, solução ≥ 90%, voltaria a fazer negócio ≥ 70%, 50+ avaliações — ✓ bate, ✗ falta.\nCritério do selo para a nota: ≥ 7. Com as duas marcas, o cartão mostra a pior.",
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
  const hoje = hojeRef();
  const jc = cxJanelaCompleta(per.f, hoje); const fPed = jc.f;
  const fPedAnt = per.fAnt && !jc.caiu ? (jc.cortou ? rangeAnteriorDe(fPed) : per.fAnt) : null;
  const cpp = contatosPorPedido(rows, d.cx_pedidos, fPed), cppAnt = fPedAnt ? contatosPorPedido(rows, d.cx_pedidos, fPedAnt) : null;
  const csx = cxCsatComAvaliacao(rows, per.f); const cs = csx.a;
  const csAnt = per.fAnt && !csx.caiu ? csatAgg(rows, Object.assign({}, per.fAnt, { canais: CX_CANAIS_KAI })) : null;
  const kr = cxKai(rows, per.f, hoje), krAnt = cxKaiAnt(rows, per.f, hoje);
  const rotPed = jc.caiu ? "ontem" : jc.cortou ? `até ${fmtDia(fPed.fim)}` : "";
  const raU = porMarca((m) => raUltimo(d.cx_ra, m, cxRaFim(per.f.fim)));
  const raAnt = porMarca((m) => per.fAnt ? raUltimo(d.cx_ra, m, per.fAnt.fim) : null);
  const raPior = (campo, src) => { const vs = marcas.map((m) => src[m] && src[m][campo] != null ? Number(src[m][campo]) : null).filter((v) => typeof v === "number"); return vs.length ? Math.min(...vs) : null; };
  const temPed = typeof cpp.pedidos === "number";
  const V = {
    contatos_por_pedido: { v: temPed ? cpp.por100 : null, ant: cppAnt && cppAnt.por100, sub: (temPed ? `${fmtNum(cpp.contatos)} contatos · ${fmtNum(cpp.pedidos)} pedidos` : `${fmtNum(cpp.contatos)} contatos · sem pedidos coletados`) + (rotPed ? ` · ${rotPed}` : ""),
      marcas: porMarca((m) => contatosPorPedido(rows, d.cx_pedidos, Object.assign({}, fPed, { marca: m })).por100) },
    wismo_rate: { v: temPed ? cpp.wismoRate : null, ant: cppAnt && cppAnt.wismoRate, sub: `${fmtNum(cpp.wismo)} “cadê meu pedido”` + (rotPed ? ` · ${rotPed}` : ""),
      marcas: porMarca((m) => contatosPorPedido(rows, d.cx_pedidos, Object.assign({}, fPed, { marca: m })).wismoRate) },
    csat_bom: { v: cs.baseOk ? cs.pctBom : null, ant: csAnt && csAnt.baseOk ? csAnt.pctBom : null, sub: `${fmtNum(cs.avaliadas)} avaliações · responderam ${fmtPct0(cs.pctResposta)}` + (csx.caiu ? ` · ${fmtDia(csx.f.ini)}${csx.f.ini !== csx.f.fim ? "–" + fmtDia(csx.f.fim) : ""}` : ""), curto: !cs.baseOk && cs.avaliadas ? `${fmtNum(cs.bom)} de ${fmtNum(cs.avaliadas)}` : null,
      marcas: porMarca((m) => { const a = csatAgg(rows, Object.assign({}, csx.f, { marca: m, canais: CX_CANAIS_KAI })); return a.baseOk ? a.pctBom : null; }) },
    kai_resolve: { v: kr.pctKai, ant: krAnt && krAnt.pctKai, sub: `${fmtNum(kr.kai)} de ${fmtNum(kr.tickets)} tickets de chat até ${fmtDia(kr.fim)}`, curto: kr.pctKai === null && kr.tickets ? `${fmtNum(kr.kai)} de ${fmtNum(kr.tickets)}` : null,
      marcas: porMarca((m) => cxKai(rows, Object.assign({}, per.f, { marca: m }), hoje).pctKai) },
    sem_resposta: { v: kr.pctSemResp, ant: krAnt && krAnt.pctSemResp, sub: `${fmtNum(kr.semResp)} de ${fmtNum(kr.tickets)} tickets de chat até ${fmtDia(kr.fim)}`, curto: kr.pctSemResp === null && kr.tickets ? `${fmtNum(kr.semResp)} de ${fmtNum(kr.tickets)}` : null,
      marcas: porMarca((m) => cxKai(rows, Object.assign({}, per.f, { marca: m }), hoje).pctSemResp) },
    ra_nota: { v: raPior("nota", raU), ant: raPior("nota", raAnt), sub: marcas.length > 1 ? "pior marca" : (raU[marca] ? "leitura de " + fmtDia(cxDia(raU[marca].dia)) : "sem leitura"), marcas: porMarca((m) => raU[m] ? Number(raU[m].nota) : null),
      // composição do RA1000 da marca que dá a nota (a pior): resp · sol · voltaria · avaliações, com ✓/✗
      comp: (() => { const cands = marcas.filter((m) => raU[m]); if (!cands.length) return ""; const m = cands.sort((a, b) => Number(raU[a].nota) - Number(raU[b].nota))[0]; const av = raAvalia(raU[m]);
        const it = av.crit.filter((c) => c.c !== "nota").map((c) => `<span class="${c.bate ? "ok" : "falta"}" title="${c.rot}: meta ${c.tipo === "pct" ? c.min + "%" : c.min}">${c.c === "avaliacoes" ? fmtNum(c.v) + " aval." : (c.c === "resposta_pct" ? "resp. " : c.c === "solucao_pct" ? "sol. " : "volta ") + fmtDec(c.v, 0) + "%"} ${c.bate ? "✓" : "✗"}</span>`).join(" · ");
        // sem resposta: fila real (todas as ativas) somada nas marcas mostradas, não a régua de 6 meses — 102 na régua × 260 na fila (14/09)
        const pends = cands.map((x) => ({ m: x, p: raPendentes(raU[x]) })).filter((x) => typeof x.p.v === "number");
        const tot = pends.reduce((s, x) => s + x.p.v, 0), real = pends.every((x) => x.p.real), regua = pends.reduce((s, x) => s + (x.p.regua || 0), 0);
        const tit = (real ? "Reclamações ativas sem resposta agora (a fila do RA Empresas)." : "Aguardando resposta dentro da régua de 6 meses da página pública (leitura antiga, sem a fila real).") +
          (pends.length > 1 ? ` Por marca: ${pends.map((x) => `${CX_SIGLA[x.m]} ${fmtNum(x.p.v)}`).join(" · ")}.` : "") + (real ? ` Na régua de reputação (${raPeriodo(raU[m]) || "6 meses"}): ${fmtNum(regua)}.` : "");
        return `<span class="ra-comp">${it}${tot > 0 ? ` · <span class="falta" title="${tit}">${fmtNum(tot)} sem resposta${real ? "" : " (régua)"}</span>` : ""}</span>`; })() },
  };
  CX_SEIS_DADOS = { V, per, marcas };

  const nFora = CX_SEIS.filter((s) => cxStatus(s.k, V[s.k].v) === "ruim").length;
  const nAt = CX_SEIS.filter((s) => cxStatus(s.k, V[s.k].v) === "atencao").length;
  if (rot) rot.innerHTML = (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    (jc.caiu ? cxTag("pedidos: mostrando ontem", "nota", "Os pedidos de hoje só fecham na coleta das 01:20; a razão por pedido usa o último dia completo.") : "") +
    (!kr.caiu && kr.fim < per.f.fim ? cxTag(`Kai e ninguém respondeu: até ${fmtDia(kr.fim)}`, "nota", `Só tickets com ${CX_MATURACAO_DIAS} dias de expediente depois de criados (sex, sáb e dom não contam) — os últimos dias ainda estão maturando.`) : "") +
    (kr.caiu ? cxTag(`Kai: ${fmtDia(kr.ini)}–${fmtDia(kr.fim)}`, "nota", `Ticket precisa de ${CX_MATURACAO_DIAS} dias de expediente (sex, sáb e dom não contam) para ter desfecho; o período não tem dia maduro, então o Kai mostra os 7 dias maduros mais recentes.`) : "") +
    (csx.caiu ? cxTag("CSAT: sem avaliação no período", "nota", `Nenhuma avaliação no período; mostrando a última janela com avaliação (${fmtDia(csx.f.ini)}–${fmtDia(csx.f.fim)}).`) : "") +
    (per.semHist ? cxTag("sem histórico para comparar", "nota", "O período de comparação tem menos de 80% dos dias coletados.") : "") +
    (nFora ? `<span class="tag st-ruim-tag"><i class="st-dot st-ruim"></i>${nFora} fora do alvo</span>` : "") +
    (nAt ? `<span class="tag nota"><i class="st-dot st-atencao"></i>${nAt} em atenção</span>` : "") +
    (!nFora && !nAt ? `<span class="tag nota"><i class="st-dot st-bom"></i>tudo no alvo</span>` : "");

  alvo.innerHTML = CX_SEIS.map((s) => {
    const x = V[s.k]; const st = cxStatus(s.k, x.v);
    const info = CX_INFO[s.k] + (todas ? "\n\nPor marca: " + marcas.map((m) => `${ROTULOS[m]} ${typeof x.marcas[m] === "number" ? s.fmt(x.marcas[m]) : "—"}`).join(" · ") : "") + "\n\n" + x.sub;
    const val = typeof x.v === "number" ? s.fmt(x.v) : (x.curto ? `<span class="six-curto">${x.curto}</span>` : "—");
    const chip = typeof x.v === "number" ? (s.pct ? cxChipPP(s.k, x.v, x.ant, s.casas) : cxChipAbs(s.k, x.v, x.ant, s.casas)) : "";
    // CSAT: a taxa de resposta fica visível sempre — o número fala só por quem avaliou
    const extra = s.k === "csat_bom" && cs.tickets ? `<span class="six2-extra mini${cs.pctResposta !== null && cs.pctResposta < 25 ? " vm" : ""}" title="Quem avaliou ÷ contatos do chat. Abaixo de 25%, o CSAT fala por poucos — e por quem passou por pessoa, que responde mais.">responderam ${fmtPct0(cs.pctResposta)}</span>` : "";
    return `<button type="button" class="six2${st ? " st-" + st : ""}${estado.metricaGeral === s.k ? " ativo" : ""}${x.comp ? " six2-alto" : ""}" data-m="${s.k}" title="${info.replace(/"/g, "&quot;")}" aria-pressed="${estado.metricaGeral === s.k}">
      <span class="six2-rot">${st ? `<i class="st-dot"></i>` : `<i class="st-dot st-nulo"></i>`}${s.rot}</span>
      <span class="six2-val">${val}${s.nota && typeof x.v === "number" ? `<small class="six-de">/10</small>` : ""}</span>
      <span class="six2-chip">${chip || `<span class="mini">${x.sub}</span>`}</span>${extra}
      ${x.comp ? `<span class="six2-comp">${x.comp}</span>` : ""}
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
    const jf = j.fim >= hojeRef() ? diasAtras(1, hojeRef()) : j.fim;   // só dia completo: pedidos de hoje fecham à 01:20
    const base = serieSemanalPor100(rows, d.cx_pedidos, marcas, j.ini, jf);
    const wis = w ? serieSemanalPor100(cxFiltra(rows, { marca: "todas", ini: j.ini, fim: jf, canais: CX_CANAIS_KAI, motivo: "wismo" }), d.cx_pedidos, marcas, j.ini, jf) : null;
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
  } else if (s.k === "sem_resposta") {
    const sk = cxSerieKaiMarcas(d, marcas, j, "ySemResp"); rotulosX = sk.rotulosX; series = sk.series; marcos = sk.marcos;
    alvoRef = { y: 5, rot: "alvo 5%" }; baseRef = { y: 10, rot: "atenção 10%" };
  } else {
    const r = serieRa(d.cx_ra, marcas, "nota");
    rotulosX = r.dias.map(fmtDia);
    if (r.dias.length < 2) vazio = r.dias.length ? `Uma leitura só (${fmtDia(r.dias[0])}): ${r.series.map((x) => `${ROTULOS[x.marca]} ${fmtDec(x.pontos[0].y)}`).join(" · ")}. A curva aparece a partir da segunda leitura.` : "Sem leitura do Reclame AQUI ainda.";
    series = r.series.map((x) => Object.assign(lbl(x.marca), { pontos: x.pontos.map((p) => ({ y: p.y, rot: fmtDia(p.dia) })) }));
    alvoRef = { y: 7, rot: "alvo 7" };
  }
  if (tit) tit.textContent = s.rot + (s.k.startsWith("ra_") ? " · por leitura" : " · por semana");
  el.innerHTML = vazio && (!series.length || series.every((x) => x.pontos.filter((p) => typeof p.y === "number").length < 2))
    ? `<div class="vazio mini">${vazio}</div>`
    : cxgLinhas({ rotulosX, series, pct, fmt: s.k === "contatos_por_pedido" ? (v) => fmtDec(v, 0) : s.k === "ra_nota" ? (v) => fmtDec(v, 0) : s.k === "wismo_rate" ? (v) => fmtDec(v, 0) + "%" : (v) => Math.round(v) + "%", alvo: alvoRef, base: baseRef, marcos, aria: s.rot,
        yMax: s.k === "wismo_rate" ? null : s.k === "ra_nota" ? 10 : undefined });
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
  const diaEmAndamento = per.f.ini === per.f.fim && per.f.fim >= hojeRef();   // "hoje" contra ontem inteiro só dá seta para baixo de manhã
  const dlHtml = (l) => {
    if (!estado.comparar || typeof l.delta !== "number" || diaEmAndamento) return "<span class='mini'>—</span>";
    const dl = delta("novos", l.tickets, l.anterior); if (!dl.texto) return "<span class='mini'>—</span>";
    const cls = l.motivo === "pre-venda" ? "d-neutro" : l.delta > 0 ? "d-ruim" : l.delta < 0 ? "d-bom" : "d-neutro";
    return `<span class="chip ${cls}" title="antes: ${fmtNum(l.anterior)}">${dl.texto}</span>`;
  };
  const nome = (l) => `<span class="mot-nome">${l.rotulo}</span>${atacar(l) ? `<span class="tag alerta mot-tag" title="Fatia ≥ 20% e (volume subindo > 10% ou CSAT bom < 50%)">atacar</span>` : ""}`;
  const cab = (pmx) => pmx ? `${fmtNum(pmx.total.tickets)} contatos no chat ` + (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    (diaEmAndamento ? cxTag("dia em andamento · sem Δ", "nota", "Comparar um dia pela metade com o dia anterior inteiro só daria seta para baixo. A variação volta amanhã.") : "") +
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
  // Aba Chat — Kai × pessoa por motivo + o que custa fechar por pessoa (16/09: mensagens por fechamento e volta, por motivo)
  const a2 = $("#area-motivos-kai"), r2 = $("#motivos-kai-rot");
  if (a2) {
    if (!pm) a2.innerHTML = `<div class="vazio">Sem <code>cx_csat</code> na API.</div>`;
    else {
      const temFm = Array.isArray(d.cx_fechamento_motivo) && d.cx_fechamento_motivo.length > 0;
      const fm = temFm ? fechamentoPorMotivo(d.cx_fechamento_motivo, Object.assign({}, per.f, { canais })) : {};
      const fmCel = (l) => { const x = fm[l.motivo]; return !x || !x.fechados ? "<span class='mini'>—</span>" : `<strong class="tabn">${x.aproximado ? "≈ " : ""}${fmtDec(x.msgsHumanasP50, 0)}</strong><div class="mini">${fmtNum(x.fechados)} fech. · cliente ${fmtDec(x.msgsClienteP50, 0)}</div>`; };
      const vCel = (l) => { const x = fm[l.motivo]; return !x ? "<span class='mini'>—</span>" : typeof x.pctVoltou === "number" ? `<strong class="tabn${x.pctVoltou >= 25 ? " st-ruim" : x.pctVoltou >= 15 ? " st-atencao" : " st-bom"}">${fmtPct0(x.pctVoltou)}</strong><div class="mini">de ${fmtNum(x.maduros)} maduros</div>` : `<span class="mini">${fmtNum(x.maduros)} maduros</span>`; };
      if (r2) r2.innerHTML = cab(pm) + (temFm ? "" : cxTag("sem cx_fechamento_motivo", "nota", "A API ainda não devolve fechamentos por motivo; as duas últimas colunas ficam vazias."));
      a2.innerHTML = `<div class="rolagem"><table class="motivos">
        <thead><tr><th>Motivo</th><th class="num">Contatos</th><th class="num" title="Fatia dos contatos do motivo que o Kai FECHOU sozinho (sem resposta humana, sem transferência, sem tag de inatividade). Inclui tickets recentes, ainda maturando.">Kai fechou</th><th class="num" title="Quem avaliou ÷ contatos">Resp.</th><th class="num" title="CSAT bom quando o Kai fechou sozinho">bom · Kai</th><th class="num" title="CSAT bom quando passou por pessoa">bom · pessoa</th><th class="num" title="Mediana de mensagens humanas por fechamento feito por pessoa, neste motivo (o esforço); embaixo, fechamentos no período e mensagens do cliente">Msgs/fech.</th><th class="num" title="Fechamentos por pessoa deste motivo em que o cliente voltou em 7 dias (só maduros, base ≥ 30). Faixa < 15% / 25%">Voltou</th></tr></thead>
        <tbody>${linhas.map((l) => `<tr><td>${nome(l)}</td><td class="num">${contCel(l)}</td><td class="num">${l.tickets ? `<span class="tabn">${fmtPct0(l.kaiShare)}</span>` : "—"}</td><td class="num"><span class="mini tabn">${fmtPct0(l.pctResposta)}</span></td><td class="num">${pctOuN(l.kaiBom, l.kaiAvaliadas)}</td><td class="num">${pctOuN(l.pessoaBom, l.pessoaAvaliadas)}</td><td class="num">${fmCel(l)}</td><td class="num">${vCel(l)}</td></tr>`).join("")}</tbody>
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
function cxSerieKaiMarcas(d, marcas, j, campo) {
  const hoje = hojeRef(); const rows = d.cx_csat || []; const semResp = campo === "ySemResp";
  const ss = marcas.map((m) => ({ m, k: serieSemanalDesfecho(rows, { marca: m, ini: j.ini, fim: j.fim }, hoje) }));
  const c = cxCortaVazioInicial(ss[0].k.semanas, ss.map((x) => x.k.pontos.map((p) => p.tickets))); const corte = ss[0].k.semanas.length - c.semanas.length;
  return { rotulosX: c.semanas.map(fmtDia), marcos: cxMarcosSemanas(d, c.semanas),
    series: ss.map((x) => Object.assign(cxLbl(x.m), { pontos: x.k.pontos.slice(corte).map((p) => ({ y: semResp ? p.ySemResp : p.y, rot: "semana de " + fmtDia(p.semana), n: `${fmtNum(semResp ? p.semResp : p.kai)} de ${fmtNum(p.tickets)} tickets de chat`, parcial: p.parcial })) })) };
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
  const sd = serieSemanalDesfecho(d.cx_csat || [], { marca, ini: j.ini, fim: j.fim }, hojeRef());
  const g = (k) => sd.pontos.map((p) => p[k]);
  const c = cxCortaVazioInicial(sd.semanas, [g("kai"), g("pessoa"), g("semResp"), g("aberto")]);
  return cxgBarras({ rotulosX: c.semanas.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: "O que aconteceu com o ticket, por semana", vazio: "Sem ticket maduro no intervalo.",
    topo: sd.pontos.slice(sd.semanas.length - c.semanas.length).map((p) => (p.parcial ? "parcial" : "")),
    series: [{ nome: "Kai resolveu", cor: "var(--bom)", valores: c.colunas[0] }, { nome: "Pessoa respondeu", cor: "var(--borda-forte)", valores: c.colunas[1] }, { nome: "Transferido, ninguém respondeu", cor: "var(--ruim)", valores: c.colunas[2] }, { nome: "Ainda aberto / inatividade", cor: "#d9971e", valores: c.colunas[3] }] });
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
Object.assign(DIRECAO, { sem_resposta: "baixo", fila: "baixo", primeira_resposta: "baixo", voltou: "baixo", fcr: "alto" });
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
  const fBase = per.vazio ? cxF(marca) : per.f;
  const kr = cxKai(rows, fBase, hoje), krAnt = cxKaiAnt(rows, fBase, hoje);   // desfecho maduro: kai · pessoa · ninguém · aberto
  const saldo = typeof a.novos === "number" && typeof a.fechados === "number" ? a.fechados - a.novos : null;
  const pn = anteriorProgressivo("novos", marca, ant); // "hoje" compara com ontem até a mesma hora
  const filaAgora = PER.fim >= hoje;
  // 1ª resposta humana em EXPEDIENTE, por ticket (cx_tempo): dias completos; resposta tardia entra no dia do ticket
  const jt = cxJanelaCompleta(cxF(marca), hoje);
  const tp = tempoAgg(d.cx_tempo || [], jt.f), tpAnt = estado.comparar && !jt.caiu ? tempoAgg(d.cx_tempo || [], rangeAnteriorDe(jt.f)) : null;
  const temCom = tp.comTempo > 0;
  const pr = temCom ? tp.p50Comercial : a.primeira_resposta_seg, prAnt = temCom ? (tpAnt && tpAnt.comTempo ? tpAnt.p50Comercial : null) : ant.primeira_resposta_seg;
  // fechamentos por pessoa e volta do cliente em 7 dias (cx_fechamento): só maduros
  const temFech = Array.isArray(d.cx_fechamento) && d.cx_fechamento.length > 0;
  const vt = temFech ? cxVolta(d.cx_fechamento, cxF(marca), hoje) : null, vtAnt = vt ? cxVoltaAnt(d.cx_fechamento, vt, cxF(marca)) : null;
  const va = vt ? vt.a : null;

  const cartoes = [
    { k: "contatos", rot: "Contatos", val: fmtNum(a.novos), chip: chipHtml("novos", a.novos, pn.valor), sub: `resolvidos ${fmtNum(a.fechados)}${pn.mesmaHora ? " · vs ontem até a mesma hora" : ""}`,
      info: `Tickets novos em todos os canais (e-mail incluso) no período.${pn.mesmaHora ? " A variação compara com ontem até a mesma hora." : ""}\nResolvidos ${fmtNum(a.fechados)} · saldo ${saldo === null ? "—" : (saldo > 0 ? "+" : "") + fmtNum(saldo)}.` + (todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => fmtNum(pm(m, "novos")))}` : "") },
    { k: "csat_bom", rot: "CSAT · bom", val: cs && cs.baseOk ? fmtPct0(cs.pctBom) : (cs && cs.avaliadas ? `<span class="six-curto">${fmtNum(cs.bom)} de ${fmtNum(cs.avaliadas)}</span>` : "—"), status: cs && cs.baseOk ? cxStatus("csat_bom", cs.pctBom) : null,
      chip: cs && cs.baseOk ? cxChipPP("csat_bom", cs.pctBom, csAnt && csAnt.baseOk ? csAnt.pctBom : null) : "", sub: cs ? `${fmtNum(cs.avaliadas)} avaliações · responderam ${fmtPct0(cs.pctResposta)}` : "sem cx_csat",
      info: `Fatia de “bom” entre quem avaliou (três opções: ruim / neutro / bom), só chat, com 30+ avaliações. Alvo ≥ 80%.` + (cs ? `\nRuim ${fmtPct0(cs.pctRuim)} · neutro ${fmtPct0(cs.pctNeutro)} · bom ${fmtPct0(cs.pctBom)} · ${fmtNum(cs.avaliadas)} de ${fmtNum(cs.tickets)} responderam.` : "") +
        (kp ? `\nKai fechou sozinho: bom ${kp.kai.baseOk ? fmtPct0(kp.kai.pctBom) : fmtNum(kp.kai.bom) + " de " + fmtNum(kp.kai.avaliadas)} (resp. ${fmtPct0(kp.kai.pctResposta)}) · passou por pessoa: bom ${kp.pessoa.baseOk ? fmtPct0(kp.pessoa.pctBom) : fmtNum(kp.pessoa.bom) + " de " + fmtNum(kp.pessoa.avaliadas)} (resp. ${fmtPct0(kp.pessoa.pctResposta)}). Não são comparáveis entre si.` : "") +
        (todas && !per.vazio ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => { const x = csatAgg(rows, Object.assign({}, per.f, { marca: m, canais: CX_CANAIS_KAI })); return x.baseOk ? fmtPct0(x.pctBom) : "—"; })}` : "") },
    { k: "kai_resolve", rot: "Kai resolve sozinho", val: typeof kr.pctKai === "number" ? fmtDec(kr.pctKai) + "%" : (kr.tickets ? `<span class="six-curto">${fmtNum(kr.kai)} de ${fmtNum(kr.tickets)}</span>` : "—"),
      chip: cxChipPP("kai_resolve", kr.pctKai, krAnt && krAnt.pctKai, 1), sub: `${fmtNum(kr.kai)} de ${fmtNum(kr.tickets)} tickets de chat até ${fmtDia(kr.fim)}`,
      info: `Fechado pelo Kai, sem resposta humana, sem transferência e sem tag de inatividade ÷ TODOS os tickets de chat maduros (2 dias de expediente depois de criados; sex e sáb não contam). O resto: pessoa respondeu ${fmtPct0(kr.pctPessoa)} · transferido e ninguém respondeu ${fmtPct0(kr.pctSemResp)} · ainda aberto ou fechado por inatividade ${fmtPct0(kr.pctAberto)}. E-mail fora. Quebra de série em 29/08.` + (todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => { const x = cxKai(rows, Object.assign({}, fBase, { marca: m }), hoje); return typeof x.pctKai === "number" ? fmtDec(x.pctKai) + "%" : "—"; })}` : "") },
    { k: "sem_resposta", rot: "Ninguém respondeu", val: typeof kr.pctSemResp === "number" ? fmtDec(kr.pctSemResp) + "%" : (kr.tickets ? `<span class="six-curto">${fmtNum(kr.semResp)} de ${fmtNum(kr.tickets)}</span>` : "—"), status: typeof kr.pctSemResp === "number" ? (kr.pctSemResp >= 10 ? "ruim" : kr.pctSemResp >= 5 ? "atencao" : "bom") : null,
      chip: cxChipPP("sem_resposta", kr.pctSemResp, krAnt && krAnt.pctSemResp, 1), sub: `${fmtNum(kr.semResp)} tickets transferidos sem resposta humana`,
      info: `Transferido para time ou agente (processingTeam/processingUser) e sem NENHUMA resposta pública de pessoa — aberto na fila ou fechado pela régua. Denominador: todos os tickets de chat maduros (2 dias de expediente; sex e sáb não contam). Faixa: até 5% ok, até 10% atenção.` + (todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => { const x = cxKai(rows, Object.assign({}, fBase, { marca: m }), hoje); return typeof x.pctSemResp === "number" ? fmtDec(x.pctSemResp) + "%" : "—"; })}` : "") },
    { k: "voltou", rot: "Voltou em 7 dias", val: va && typeof va.pctVoltouPessoa === "number" ? fmtDec(va.pctVoltouPessoa) + "%" : (va && va.pessoaMaduros ? `<span class="six-curto">${fmtNum(va.pessoaMaduros - va.pessoaResolutivos)} de ${fmtNum(va.pessoaMaduros)}</span>` : "—"),
      status: va ? cxStatus("voltou", va.pctVoltouPessoa) : null, chip: va ? cxChipPP("voltou", va.pctVoltouPessoa, vtAnt && vtAnt.pctVoltouPessoa, 1) : "",
      sub: va ? `${fmtNum(va.pessoaMaduros)} fechamentos por pessoa até ${fmtDia(vt.fim)} · FCR ${fmtPct0(va.pctFcr)}` : "a API ainda não devolve cx_fechamento",
      info: `Fechamentos feitos por PESSOA em que o cliente escreveu de novo em até 7 dias corridos (resposta do CSAT não conta). Um ticket fechado três vezes conta três fechamentos — é o que o "Fechados" do Gleap esconde. Só fechamentos com 7 dias passados (maduros). Faixa proposta: < 15% ok, até 25% atenção.` +
        (va ? `\nResolutivos (fechou e não voltou): ${fmtPct0(va.pctResolutivoPessoa)} · voltou e alguém precisou trabalhar de novo: ${fmtNum(va.voltaramHumano)} · FCR (1º fechamento por pessoa, um agente só, sem volta): ${fmtPct0(va.pctFcr)} de ${fmtNum(va.fcrBase)} · Kai: voltou ${fmtPct0(va.pctVoltouKai)} de ${fmtNum(va.kaiMaduros)} · mensagens humanas por fechamento (mediana${va.aproximado ? " ≈" : ""}): ${va.msgsHumanasP50 === null ? "—" : fmtDec(va.msgsHumanasP50, 0)} · do cliente: ${va.msgsClienteP50 === null ? "—" : fmtDec(va.msgsClienteP50, 0)}.` : "") +
        (va && todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => { const x = fechamentoAgg(d.cx_fechamento, { marca: m, ini: vt.ini, fim: vt.fim }); return typeof x.pctVoltouPessoa === "number" ? fmtDec(x.pctVoltouPessoa) + "%" : "—"; })}` : "") },
    { k: "fila", rot: filaAgora ? "Fila agora" : "Fila no fim do período", val: fmtNum(a.fila_aberta), chip: chipHtml("fila_aberta", a.fila_aberta, ant.fila_aberta), sub: todas ? marcas.concat(["olivas"]).map((m) => `${CX_SIGLA[m]} ${fmtNum(pm(m, "fila_aberta"))}`).join(" · ") : "tickets abertos",
      info: `Tickets abertos ${filaAgora ? "na última coleta" : "no fim do período"}, todos os canais.` + (estado.comparar && typeof ant.fila_aberta === "number" ? `\nAntes: ${fmtNum(ant.fila_aberta)}.` : "") + (todas ? `\n\nPor marca: ${cxPorMarcaTxt(MARCAS, (m) => fmtNum(pm(m, "fila_aberta")))}` : "") },
    { k: "primeira_resposta", rot: temCom ? "1ª resposta · expediente" : "1ª resposta", val: temCom ? (tp.aproximado ? "≈ " : "") + fmtDur(pr) : fmtDur(pr), chip: cxChipDur(pr, prAnt), status: temCom ? (tp.pctAte1h >= 70 ? "bom" : tp.pctAte1h >= 50 ? "atencao" : "ruim") : null,
      sub: temCom ? `${fmtPct0(tp.pctAte1h)} em até 1h · ${fmtNum(tp.comTempo)} respondidos${jt.caiu ? " · ontem" : jt.cortou ? " · até " + fmtDia(jt.f.fim) : ""}` : "mediana até a 1ª resposta humana",
      info: (temCom ? `Mediana do tempo entre o ticket ser criado e a PRIMEIRA resposta de pessoa, contando só expediente (seg–qui 8h–18h; sex, sáb e dom não têm atendimento humano). Medido ticket a ticket em cx_ticket; ticket respondido dias depois entra no dia em que foi criado, por isso dias recentes ainda mudam. ${tp.aproximado ? "≈ mediana das medianas diárias, ponderada pelo volume. " : ""}Faixa: ≥ 70% em até 1h ok, ≥ 50% atenção.\nEm até 4h: ${fmtPct0(tp.pctAte4h)} · p90 ${fmtDur(tp.p90Comercial)} · relógio corrido (o que o cliente sente): ${fmtDur(tp.p50Relogio)}.\nTickets do período: ${fmtNum(tp.tickets)} · com resposta humana ${fmtNum(tp.respondidos)} (${fmtPct0(tp.pctRespondidos)}) · transferidos e ainda sem resposta ${fmtNum(tp.transfSemResp)}.` : "Mediana do tempo até a primeira resposta humana, relógio corrido (Gleap).") +
        (todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => { const x = tempoAgg(d.cx_tempo || [], Object.assign({}, jt.f, { marca: m })); return x.comTempo ? fmtDur(x.p50Comercial) + " · " + fmtPct0(x.pctAte1h) + " em 1h" : "—"; })}` : "") },
  ];
  CX_CHAT_DADOS = { per, marcas };
  const rot = $("#chat-rot");
  if (rot) rot.innerHTML = (per.caiu ? cxTag(per.rotulo, "alerta") : "") +
    (kr.caiu ? cxTag(`Kai e desfecho: ${fmtDia(kr.ini)}–${fmtDia(kr.fim)}`, "nota", "Ticket precisa de 2 dias de expediente (sex, sáb e dom não contam) para ter desfecho; o período não tem dia maduro, então esses dois cartões mostram os 7 dias maduros mais recentes.") : "") +
    (vt && (vt.caiu || vt.cortou) ? cxTag(vt.caiu ? `voltou: ${fmtDia(vt.ini)}–${fmtDia(vt.fim)}` : `voltou: até ${fmtDia(vt.fim)}`, "nota", `Fechamento só conta como resolutivo ou "voltou" depois de ${CX_VOLTA_DIAS} dias corridos; ${vt.caiu ? "o período não tem dia maduro, então o cartão mostra os 7 dias maduros mais recentes" : "os últimos dias do período ainda estão maturando"}.`) : "") +
    (cs && cs.pctResposta !== null && cs.pctResposta < 25 ? cxTag(`resposta à pesquisa ${fmtPct0(cs.pctResposta)}`, "alerta", "Taxa de resposta abaixo de 25%. Em agosto era 42–46% no Aristocrata e 32–35% na Fishermans; caiu depois das mudanças de 29/08 no Kai. No Instagram o botão de nota não renderiza: o envio lá é perdido.") : "") +
    cxResumoStatus(cartoes);
  cxPintaCartoes("chat", cartoes);
  pintaGraficoChat(d);
}
function pintaGraficoChat(d) {
  if (!CX_CHAT_DADOS || !$("#g-chat")) return;
  const k = estado.metricaChat; const { per, marcas } = CX_CHAT_DADOS; const rows = d.cx_csat || [];
  const j = cxJanelaTendencia(per.vazio ? PER.fim : per.f.fim, 12), jd = j;
  let r;
  if (k === "contatos") r = { tit: "Contatos no chat · por semana e motivo", sub: "só chat — e-mail não recebe tag de motivo · cores fixas por grupo", html: per.vazio ? `<div class="vazio mini">Sem cx_csat na API.</div>` : cxBarrasMotivos(rows, { marca: per.f.marca, ini: j.ini, fim: j.fim }) };
  else if (k === "csat_bom") r = { tit: "CSAT · ruim, neutro e bom · por semana", sub: "número no topo = fatia de bom · só chat", html: per.vazio ? `<div class="vazio mini">Sem cx_csat na API.</div>` : cxBarrasCsat3(rows, { marca: per.f.marca, ini: j.ini, fim: j.fim }) };
  else if (k === "kai_resolve") { const s = cxSerieKaiMarcas(d, marcas, jd); r = { tit: "Kai resolve sozinho · por semana", sub: "fatia de todos os tickets de chat da semana · ponto claro = semana ainda maturando · tracejado = quebra de série", html: cxgLinhas({ rotulosX: s.rotulosX, series: s.series, pct: true, fmt: (v) => Math.round(v) + "%", marcos: s.marcos, aria: "Kai resolve sozinho" }) }; }
  else if (k === "voltou") {
    const hoje = hojeRef(); const rows = d.cx_fechamento || [];
    const ss = marcas.map((m) => ({ m, s: serieSemanalVolta(rows, { marca: m, ini: jd.ini, fim: jd.fim }, hoje) }));
    const c = cxCortaVazioInicial(ss[0].s.semanas, ss.map((x) => x.s.pontos.map((p) => p.n))); const corte = ss[0].s.semanas.length - c.semanas.length;
    r = { tit: "Voltou em 7 dias · fechamentos por pessoa · por semana do fechamento", sub: "fatia dos fechamentos maduros da semana em que o cliente escreveu de novo · ponto claro = semana ainda maturando · semana com menos de 30 fechamentos fica em branco",
      html: cxgLinhas({ rotulosX: c.semanas.map(fmtDia), pct: true, fmt: (v) => Math.round(v) + "%", aria: "Voltou em 7 dias por semana", vazio: "Sem fechamento maduro no intervalo.", alvo: { y: CX_ALVOS.voltou.alvo, rot: "faixa 15%" },
        series: ss.map((x) => Object.assign(cxLbl(x.m), { pontos: x.s.pontos.slice(corte).map((p) => ({ y: p.y, rot: "semana de " + fmtDia(p.semana), n: `${fmtNum(p.n)} fechamentos por pessoa maduros`, parcial: p.parcial })) })) }) };
  }
  else if (k === "sem_resposta") r = { tit: "O que aconteceu com o ticket · por semana", sub: "todos os tickets de chat da semana · “parcial” = semana ainda maturando", html: cxBarrasQuemFechou(d, estado.marca, jd) };
  else if (k === "fila") {
    const j8 = cxJanelaTendencia(PER.fim, 8); const s = cxSerieDiariaMarcas(d.snapshot_1d, marcas, j8.ini, j8.fim, "fila_aberta");
    r = { tit: "Fila agora · quem espera pessoa", sub: "tickets abertos neste momento (cx_fila) · espera em horas de EXPEDIENTE desde a criação · embaixo, a fila por dia",
      html: cxFilaAgoraHtml(d) + cxgLinhas({ rotulosX: s.rotulosX, series: s.series, fmt: fmtNum, aria: "Fila por dia", vazio: "Sem série diária no intervalo." }) };
  }
  else {
    const j8 = cxJanelaTendencia(PER.fim >= hojeRef() ? diasAtras(1, hojeRef()) : PER.fim, 8);
    const st = serieDiariaTempo(d.cx_tempo || [], marcas, j8.ini, j8.fim);
    const series = st.series.map((x) => Object.assign(cxLbl(x.marca), { pontos: x.pontos.map((p) => ({ y: typeof p.y === "number" ? p.y / 3600 : null, rot: fmtDia(p.dia), n: p.n ? `${fmtNum(p.n)} respondidos · ${fmtPct0(p.ate1h)} em até 1h` : undefined })) }));
    r = { tit: "1ª resposta humana · por dia de criação do ticket", sub: "8 semanas até ontem · mediana em horas de EXPEDIENTE (seg–qui 8–18) · dia com menos de 5 respondidos e dia sem expediente ficam em branco",
      html: cxgLinhas({ rotulosX: st.dias.map(fmtDia), series, fmt: fmtHoras, aria: "Primeira resposta humana por dia", vazio: "Sem ticket respondido no intervalo.", alvo: { y: 1, rot: "alvo 1h" } }) };
  }
  cxGraficoBloco("chat", r);
}

// Fila agora: contagens + os 10 tickets há mais tempo esperando pessoa, com link para o Gleap
const CX_GLEAP_PROJETO = { aristocrata: "6970d219368e0dea0fc91c42", fishermans: "696f91650c6a7fc35f38be62", olivas: "6a7cd2828d7ed9d414771c36" };
function cxFilaAgoraHtml(d) {
  if (!d.cx_fila || !d.cx_fila.length) return `<div class="vazio mini">A API ainda não devolve <code>cx_fila</code>.</div>`;
  const agora = new Date(); const f = filaAgora(d.cx_fila, estado.marca, agora);
  // horas de expediente; acima de 2 dias úteis (20 h) vira "N d úteis" — 264 h não diz nada, 26 dias úteis diz
  const h = (seg) => typeof seg !== "number" ? "—" : seg >= 20 * 3600 ? fmtDec(seg / 36000, 0) + " d úteis" : fmtHoras(seg / 3600);
  const linha = (t) => `<tr><td><a href="https://app.gleap.io/projects/${CX_GLEAP_PROJETO[t.marca] || ""}/inbox/${t.ticket_id}" target="_blank" rel="noopener" class="tabn">${t.ticket_id.slice(-6)}</a></td><td><span class="ponto" style="--cor:${corHex(t.marca)}"></span> ${ROTULOS[t.marca] || t.marca}</td><td>${t.canal || "—"}</td><td>${CX_ROTULO_MOTIVO[t.motivo] || t.motivo || "sem tag"}</td><td class="num">${fmtDia(cxDia(t.criado_em))}</td><td class="num"><strong class="tabn ${t.espera > 40 * 3600 ? "vm" : ""}">${h(t.espera)}</strong><span class="mini"> · ${fmtDur(t.esperaRelogio)} corridas</span></td></tr>`;
  return `<div class="fila-agora">
    <div class="fila-stats">
      <div><span class="kp-rot">Esperando pessoa</span><strong class="tabn ${f.esperandoPessoa ? "vm" : ""}">${fmtNum(f.esperandoPessoa)}</strong><span class="mini">de ${fmtNum(f.total)} abertos</span></div>
      <div><span class="kp-rot">Espera mediana</span><strong class="tabn">${h(f.idadeMediana)}</strong><span class="mini">expediente · p90 ${h(f.idadeP90)}</span></div>
      <div><span class="kp-rot">Há mais de 1 dia útil</span><strong class="tabn ${f.maisDe1dia ? "vm" : ""}">${fmtNum(f.maisDe1dia)}</strong><span class="mini">${fmtNum(f.maisDe1semana)} há mais de uma semana útil</span></div>
      <div><span class="kp-rot">Com pessoa</span><strong class="tabn">${fmtNum(f.comPessoa)}</strong><span class="mini">já respondidos, ainda abertos</span></div>
      <div><span class="kp-rot">Com o Kai</span><strong class="tabn">${fmtNum(f.comKai)}</strong><span class="mini">abertos sem transferência</span></div>
    </div>
    ${f.top.length ? `<div class="rolagem"><table class="comparativo fila-tab"><thead><tr><th>Ticket</th><th>Marca</th><th>Canal</th><th>Motivo</th><th class="num">Criado</th><th class="num" title="Horas de expediente (seg–qui 8–18) desde a criação; entre parênteses, relógio corrido">Espera</th></tr></thead><tbody>${f.top.map(linha).join("")}</tbody></table></div>` : ""}
  </div>`;
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
  { k: "pendentes_agora", m: "ra_aguardando", rot: "Sem resposta agora", tipo: "int", info: "Reclamações ativas sem resposta da marca neste momento — o mesmo número da fila do RA Empresas (busca pública, status pendente). A régua de reputação conta só as da janela de 6 meses e por isso mostra menos. Alvo é zero." },
];
const CX_RA_CONTAGEM = new Set(["pendentes_agora", "aguardando"]);   // com as duas marcas soma, em vez de pegar a pior
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
  // pendentes_agora cai para a régua (aguardando) em leitura antiga sem o campo — e a leitura avisa
  const num = (l, c) => c === "pendentes_agora" ? raPendentes(l).v : (l && l[c] !== null && l[c] !== undefined ? Number(l[c]) : null);
  const fmtV = (c, v) => typeof v !== "number" ? "—" : c.tipo === "pct" ? fmtDec(v) + "%" : c.tipo === "nota" ? fmtDec(v) : fmtNum(v);
  // com as duas marcas: a pior (alvo alto) ou a soma (contagens)
  const agrega = (c, src) => { const vs = lidos.map((x) => num(x[src], c.k)).filter((v) => typeof v === "number"); if (!vs.length) return null; return CX_RA_CONTAGEM.has(c.k) ? vs.reduce((s, v) => s + v, 0) : Math.min(...vs); };
  const pendReal = lidos.every((x) => raPendentes(x.l).real);
  const reguaTot = lidos.map((x) => raPendentes(x.l).regua).filter((v) => typeof v === "number").reduce((s, v) => s + v, 0);
  const cartoes = CX_RA_CARTOES.map((c) => {
    const v = agrega(c, "l"), va = agrega(c, "ant");
    const chip = c.tipo === "pct" ? cxChipPP(c.m, v, va, 1) : (typeof va === "number" && estado.comparar ? (c.tipo === "nota" ? chipHtml("csat", v, va, (x) => fmtDec(x)) : cxChipPts(v, va, DIRECAO[c.m])) : "");
    let sub = todas ? (CX_RA_CONTAGEM.has(c.k) ? "as duas marcas" : "pior marca") : `leitura de ${fmtDia(cxDia(lidos[0].l.dia))}`;
    if (c.k === "pendentes_agora") sub = pendReal ? `fila real · na régua: ${fmtNum(reguaTot)}` : "régua de 6 meses (leitura antiga)";
    return { k: c.k, rot: c.rot, val: fmtV(c, v), status: cxStatus(c.m, v), chip, sub, info: c.info + (todas ? `\n\nPor marca: ${lidos.map((x) => `${ROTULOS[x.m]} ${fmtV(c, num(x.l, c.k))}`).join(" · ")}` : "") + `\n\nLeitura de ${fmtDia(cxDia(lidos[0].l.dia))}, página pública da marca (tarefa agendada / bookmarklet).` };
  });
  const maisRecente = lidos.map((x) => cxDia(x.l.dia)).sort().pop();
  const periodo = raPeriodo(lidos.map((x) => x.l).find((l) => raPeriodo(l)));
  if (rot) rot.innerHTML = `<span class="tag nota">leitura de ${fmtDia(maisRecente)}</span>` +
    (periodo ? cxTag(`régua do RA: ${periodo}`, "nota", "Nota, respondidas, solução, voltaria e avaliações são calculados pelo Reclame AQUI sobre uma janela fechada de 6 meses — o mês corrente só entra na virada. 'Sem resposta agora' é a fila real, todas as reclamações ativas.") : "") +
    cxResumoStatus(cartoes);
  cxPintaCartoes("ra", cartoes);
  pintaGraficoRaAba(d);
  // tabela por marca: os cinco critérios + o que pesa
  if (tabRot) tabRot.innerHTML = lidos.map(({ m, l }) => { const av = raAvalia(l); return `<span class="tag ${av.ra1000 ? "nota" : "alerta"}">${CX_SIGLA[m]} · ${av.ra1000 ? "critérios RA1000 ✓" : `faltam ${av.faltam} de 5`}</span>`; }).join("");
  const cel = (c, v, bate) => `<td class="num ${typeof v === "number" ? (bate ? "vd" : "vm") : ""}">${fmtV(c, v)}</td>`;
  if (tab) tab.innerHTML = `<div class="rolagem"><table class="comparativo ra-tab">
    <thead><tr><th>Marca</th>${CX_RA_CARTOES.slice(0, 5).map((c) => `<th class="num" title="${c.info.replace(/"/g, "&quot;")}">${c.rot}<span class="mini meta"> ≥ ${c.tipo === "pct" ? CX_ALVOS[c.m].alvo + "%" : CX_ALVOS[c.m].alvo}</span></th>`).join("")}<th class="num" title="Reclamações ativas sem resposta agora (fila do RA Empresas); embaixo, quantas dessas contam na régua de 6 meses">Sem resposta</th><th class="num" title="Tempo médio de resposta, em dias">Tempo resp.</th><th class="num">Reclamações</th><th class="num" title="Nota que o consumidor dá à marca">Nota consumidor</th></tr></thead>
    <tbody>${lidos.map(({ m, l }) => { const av = raAvalia(l); return `<tr>
      <td><span class="ponto" style="--cor:${corHex(m)}"></span> <span class="nome">${ROTULOS[m]}</span><div class="mini">${fmtDia(cxDia(l.dia))}${l.fonte && l.fonte !== "metatag" ? " · " + l.fonte : ""}</div></td>
      ${av.crit.map((c, i) => cel(CX_RA_CARTOES[i], c.v, c.bate)).join("")}
      ${(() => { const p = raPendentes(l); return `<td class="num ${p.v > 0 ? "vm" : ""}">${fmtNum(p.v)}${p.real && p.regua != null ? `<div class="mini">régua ${fmtNum(p.regua)}</div>` : (!p.real && p.v != null ? `<div class="mini">régua</div>` : "")}</td>`; })()}
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
    alvo: CX_RA_CONTAGEM.has(c.k) ? null : { y: CX_ALVOS[c.m].alvo, rot: "alvo " + (c.tipo === "pct" ? CX_ALVOS[c.m].alvo + "%" : CX_ALVOS[c.m].alvo) } });
  cxGraficoBloco("ra", { tit: c.rot + " · por leitura", sub: (c.k === "pendentes_agora" ? "fila real (todas as ativas), coletada desde 14/09 · " : "") + "uma leitura por dia, quando a tarefa agendada ou o bookmarklet roda · uma linha por marca", html });
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

// ---------- Aba Trocas (16/09): reversas do Troquecommerce → seis números mensais, série por mês, tabela mês × marca, motivos ----------
// Grão mensal de propósito: a decisão que este bloco serve (trocas + RA cabem em uma pessoa?) não precisa de dia.
// O período do painel (7d/30d) não se aplica aqui: os cartões leem o último mês FECHADO e o mês atual; a fila "em análise"
// é foto de agora (todas as reversas abertas), não conta do mês.
estado.metricaTrocas = estado.metricaTrocas || "reversas";
CX_BLOCOS.trocas = { area: "#area-trocas-num", g: "#g-trocas", tit: "#g-trocas-tit", sub: "#g-trocas-sub", chave: "metricaTrocas", grafico: (d) => pintaGraficoTrocasAba(d) };
Object.assign(DIRECAO, { tr_reversas: "baixo", tr_analise: "baixo", tr_dias: "baixo", tr_devolucao: "baixo", tr_valor: "baixo" });
const fmtBRL = (v) => typeof v === "number" ? "R$ " + Math.round(v).toLocaleString("pt-BR") : "—";
const fmtMes = (ymd) => { const m = String(ymd).slice(0, 7).split("-"); return ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(m[1]) - 1] + "/" + m[0].slice(2); };
function cxMesAtual(hoje) { return hoje.slice(0, 7) + "-01"; }
function cxMesAnterior(mes) { const d = new Date(mes + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7) + "-01"; }
let CX_TROCAS_DADOS = null;
function pintaTrocasAba(d) {
  if (!$("#area-trocas-num")) return;
  const rows = d.cx_troca || [], mot = d.cx_troca_motivo || [];
  const marcas = cxMarcasSerie(); const todas = marcas.length > 1;
  const hoje = hojeRef(); const mesAtual = cxMesAtual(hoje), mesAnt = cxMesAnterior(mesAtual), mesAnt2 = cxMesAnterior(mesAnt);
  const rot = $("#trocas-rotulo"), tab = $("#area-trocas"), tabMot = $("#area-trocas-motivo"), tabRot = $("#trocas-tab-rot");
  CX_TROCAS_DADOS = { marcas };
  if (!rows.length) {
    if (rot) rot.innerHTML = cxTag("sem coleta", "alerta", "A API ainda não devolve cx_troca. O coletor noturno CX — Trocas lê a API pública do Troquecommerce às 02:40.");
    cxPintaCartoes("trocas", [{ k: "reversas", rot: "Reversas no mês", val: "—", sub: "sem leitura" }]);
    if (tab) tab.innerHTML = `<div class="vazio">Sem leitura do Troquecommerce ainda.</div>`; if (tabMot) tabMot.innerHTML = ""; if (tabRot) tabRot.innerHTML = "";
    pintaGraficoTrocasAba(d); return;
  }
  const fechado = trocaAgg(rows, { marcas, mesIni: mesAnt, mesFim: mesAnt }), fechadoAnt = trocaAgg(rows, { marcas, mesIni: mesAnt2, mesFim: mesAnt2 });
  const atual = trocaAgg(rows, { marcas, mesIni: mesAtual, mesFim: mesAtual }), fila = trocaAgg(rows, { marcas });
  const diaDoMes = Number(hoje.slice(8, 10));
  const porMarca = (fn) => todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => fn(m))}` : "";
  const cartoes = [
    { k: "reversas", rot: `Reversas · ${fmtMes(mesAnt)}`, val: fmtNum(fechado.reversas), chip: fechadoAnt.reversas ? chipHtml("novos", fechado.reversas, fechadoAnt.reversas) : "", sub: `${fmtNum(fechado.troca)} trocas · ${fmtNum(fechado.devolucao)} devoluções`,
      info: `Reversas abertas pelo cliente no portal no último mês fechado (${fmtMes(mesAnt)}), as duas marcas. Chip contra ${fmtMes(mesAnt2)}.` + porMarca((m) => fmtNum(trocaAgg(rows, { marcas: [m], mesIni: mesAnt, mesFim: mesAnt }).reversas)) },
    { k: "ritmo", rot: `${fmtMes(mesAtual)} até hoje`, val: fmtNum(atual.reversas), sub: `em ${diaDoMes} dia${diaDoMes === 1 ? "" : "s"} · ${fmtNum(atual.troca)} trocas · ${fmtNum(atual.devolucao)} dev.`,
      info: `Reversas abertas no mês corrente até hoje. Não é projeção: leia junto com o dia do mês.` + porMarca((m) => fmtNum(trocaAgg(rows, { marcas: [m], mesIni: mesAtual, mesFim: mesAtual }).reversas)) },
    { k: "analise", rot: "Em análise agora", val: fmtNum(fila.emAnalise), status: fila.emAnalise === 0 ? "bom" : fila.emAnalise7d >= 10 ? "ruim" : "atencao", sub: `${fmtNum(fila.emAnalise7d)} há mais de 7 dias`,
      info: `Reversas que o cliente abriu e a loja ainda não aprovou nem cancelou — fila parada, foto de agora (todos os meses). Vermelho com 10+ paradas há mais de 7 dias.` + porMarca((m) => { const x = trocaAgg(rows, { marcas: [m] }); return `${fmtNum(x.emAnalise)} (${fmtNum(x.emAnalise7d)} > 7 d)`; }) },
    { k: "dias", rot: "Até aprovar", val: fechado.diasAnaliseP50 === null ? "—" : (fechado.aproximado ? "≈ " : "") + fmtDec(fechado.diasAnaliseP50) + " d", status: fechado.diasAnaliseP50 === null ? null : fechado.diasAnaliseP50 <= 2 ? "bom" : fechado.diasAnaliseP50 <= 5 ? "atencao" : "ruim",
      sub: `mediana · ${fmtNum(fechado.analisadas)} analisadas em ${fmtMes(mesAnt)}`,
      info: `Dias entre o cliente abrir a reversa e a loja tomar a primeira ação (aprovar, pedir algo ou cancelar), mediana das reversas do mês já analisadas. Faixa: até 2 dias ok, até 5 atenção. ≈ = mediana das medianas mensais por tipo, ponderada.` + porMarca((m) => { const x = trocaAgg(rows, { marcas: [m], mesIni: mesAnt, mesFim: mesAnt }); return x.diasAnaliseP50 === null ? "—" : fmtDec(x.diasAnaliseP50) + " d"; }) },
    { k: "devolucao", rot: "Devolução (dinheiro)", val: fmtPct0(fechado.pctDevolucao), chip: cxChipPP("tr_devolucao", fechado.pctDevolucao, fechadoAnt.pctDevolucao), sub: `${fmtNum(fechado.devolucao)} de ${fmtNum(fechado.reversas)} em ${fmtMes(mesAnt)}`,
      info: `Fatia das reversas do mês fechado que são devolução com estorno em dinheiro; o resto é troca (vira cupom) ou sem reembolso. Política v2 quer empurrar para troca.` + porMarca((m) => fmtPct0(trocaAgg(rows, { marcas: [m], mesIni: mesAnt, mesFim: mesAnt }).pctDevolucao)) },
    { k: "valor", rot: `Valor em reversa · ${fmtMes(mesAnt)}`, val: fmtBRL(fechado.valorEstorno + fechado.valorTroca), sub: `${fmtBRL(fechado.valorEstorno)} estorno · ${fmtBRL(fechado.valorTroca)} cupom`,
      info: `Soma do que as reversas do mês fechado (não canceladas) devolvem ao cliente: parcela em dinheiro + parcela em cupom de troca. Frete reverso pago pela loja: ${fmtBRL(fechado.freteReverso)}.` + porMarca((m) => { const x = trocaAgg(rows, { marcas: [m], mesIni: mesAnt, mesFim: mesAnt }); return fmtBRL(x.valorEstorno + x.valorTroca); }) },
  ];
  const leitura = fila.coletadoEm ? cxDia(fila.coletadoEm) : null;
  if (rot) rot.innerHTML = (leitura ? cxTag(`leitura de ${fmtDia(leitura)}`, "nota", "Última leitura da API pública do Troquecommerce (coletor noturno, 02:40).") : "") +
    cxTag("grão mensal", "nota", "Trocas não seguem o período do painel: cartões leem o último mês fechado e o mês atual; a fila em análise é foto de agora.") +
    cxResumoStatus(cartoes);
  cxPintaCartoes("trocas", cartoes);
  pintaGraficoTrocasAba(d);
  // tabela mês × marca (últimos 6 meses com dado)
  const meses = trocaMeses(rows, marcas).slice(-6).reverse();
  if (tabRot) tabRot.innerHTML = cxTag("fila em análise é de agora", "nota", "A coluna 'em análise' mostra quantas reversas daquele mês ainda estão paradas hoje, não quantas estavam no fim do mês.");
  if (tab) tab.innerHTML = `<div class="rolagem"><table class="comparativo troca-tab">
    <thead><tr><th>Mês</th><th>Marca</th><th class="num">Reversas</th><th class="num" title="viram cupom">Trocas</th><th class="num" title="dinheiro de volta">Devoluções</th><th class="num" title="ainda paradas hoje">Em análise</th><th class="num">Canceladas</th><th class="num" title="produto chegou de volta">Entregues</th><th class="num" title="mediana em dias até a primeira ação da loja">Até aprovar</th><th class="num" title="parcela em dinheiro, reversas não canceladas">Estorno</th><th class="num" title="parcela em cupom">Cupom</th></tr></thead>
    <tbody>${meses.flatMap((mes) => marcas.map((m) => { const x = trocaAgg(rows, { marcas: [m], mesIni: mes, mesFim: mes }); if (!x.reversas) return ""; return `<tr>
      <td>${fmtMes(mes)}${mes === mesAtual ? '<div class="mini">até hoje</div>' : ""}</td>
      <td><span class="ponto" style="--cor:${corHex(m)}"></span> <span class="nome">${ROTULOS[m]}</span></td>
      <td class="num"><strong class="tabn">${fmtNum(x.reversas)}</strong></td><td class="num">${fmtNum(x.troca)}</td><td class="num">${fmtNum(x.devolucao)}</td>
      <td class="num ${x.emAnalise ? "vm" : ""}">${fmtNum(x.emAnalise)}${x.emAnalise7d ? `<div class="mini">${fmtNum(x.emAnalise7d)} > 7 d</div>` : ""}</td>
      <td class="num">${fmtNum(x.canceladas)}</td><td class="num">${fmtNum(x.entregues)}</td>
      <td class="num">${x.diasAnaliseP50 === null ? "—" : `${x.aproximado ? "≈ " : ""}${fmtDec(x.diasAnaliseP50)} d<div class="mini">${fmtNum(x.analisadas)} de ${fmtNum(x.reversas)}</div>`}</td>
      <td class="num">${fmtBRL(x.valorEstorno)}</td><td class="num">${fmtBRL(x.valorTroca)}</td></tr>`; })).join("")}</tbody></table></div>`;
  // motivos: 3 meses fechados + atual
  const mIni = cxMesAnterior(cxMesAnterior(mesAnt));
  const motivos = trocaMotivos(mot, { marcas, mesIni: mIni, mesFim: mesAtual });
  if (tabMot) tabMot.innerHTML = !motivos.length ? `<div class="vazio mini">Sem motivo registrado no intervalo.</div>` : `<div class="rolagem"><table class="comparativo troca-mot">
    <thead><tr><th>Marca</th><th>Motivo (${fmtMes(mIni)}–${fmtMes(mesAtual)})</th><th class="num">Reversas</th><th class="num">Trocas</th><th class="num">Devoluções</th><th class="num" title="valor dos itens em reversa">Valor</th><th>Submotivos mais comuns</th></tr></thead>
    <tbody>${motivos.slice(0, 14).map((x) => `<tr><td><span class="ponto" style="--cor:${corHex(x.marca)}"></span> ${CX_SIGLA[x.marca] || x.marca}</td><td>${x.motivo}</td><td class="num"><strong class="tabn">${fmtNum(x.reversas)}</strong></td><td class="num">${fmtNum(x.troca || 0)}</td><td class="num">${fmtNum(x.devolucao || 0)}</td><td class="num">${fmtBRL(x.valor)}</td><td class="mini">${x.subTop.map(([s, n]) => `${s} (${fmtNum(n)})`).join(" · ") || "—"}</td></tr>`).join("")}</tbody></table></div>`;
}
function pintaGraficoTrocasAba(d) {
  if (!CX_TROCAS_DADOS || !$("#g-trocas")) return;
  const rows = d.cx_troca || []; const { marcas } = CX_TROCAS_DADOS; const k = estado.metricaTrocas;
  const meses = trocaMeses(rows, marcas).slice(-12);
  if (!meses.length) { cxGraficoBloco("trocas", { tit: "Reversas · por mês", sub: "", html: `<div class="vazio mini">Sem leitura do Troquecommerce ainda.</div>` }); return; }
  const rotulosX = meses.map(fmtMes); const hojeMes = cxMesAtual(hojeRef());
  const por = (m, mes) => trocaAgg(rows, { marcas: [m], mesIni: mes, mesFim: mes });
  let r;
  if (k === "dias") r = { tit: "Dias até aprovar · por mês", sub: "mediana das reversas do mês já analisadas · uma linha por marca · mês com menos de 5 analisadas fica em branco",
    html: cxgLinhas({ rotulosX, fmt: (v) => fmtDec(v, 0) + " d", aria: "Dias até aprovar por mês", vazio: "Sem reversa analisada.", alvo: { y: 2, rot: "faixa 2 d" },
      series: marcas.map((m) => Object.assign(cxLbl(m), { pontos: meses.map((mes) => { const x = por(m, mes); return { y: x.analisadas >= 5 ? x.diasAnaliseP50 : null, rot: fmtMes(mes), n: `${fmtNum(x.analisadas)} analisadas`, parcial: mes === hojeMes }; }) })) }) };
  else if (k === "devolucao") r = { tit: "Troca × devolução · por mês", sub: "fatia das reversas do mês · número no topo = % devolução (dinheiro)",
    html: cxgBarras({ rotulosX, pct: true, fmt: (v) => Math.round(v) + "%", aria: "Troca × devolução por mês", vazio: "Sem reversa.",
      series: [{ nome: "Devolução", cor: "var(--ruim)", valores: meses.map((mes) => trocaAgg(rows, { marcas, mesIni: mes, mesFim: mes }).devolucao) }, { nome: "Troca", cor: "var(--bom)", valores: meses.map((mes) => trocaAgg(rows, { marcas, mesIni: mes, mesFim: mes }).troca) }, { nome: "Outro", cor: "var(--borda-forte)", valores: meses.map((mes) => trocaAgg(rows, { marcas, mesIni: mes, mesFim: mes }).outro) }],
      topo: meses.map((mes) => { const x = trocaAgg(rows, { marcas, mesIni: mes, mesFim: mes }); return x.reversas ? fmtPct0(x.pctDevolucao) : ""; }) }) };
  else if (k === "valor") r = { tit: "Valor devolvido ao cliente · por mês", sub: "estorno em dinheiro + cupom de troca, reversas não canceladas · uma cor por marca",
    html: cxgBarras({ rotulosX, fmt: fmtBRL, aria: "Valor em reversa por mês", vazio: "Sem reversa.", series: marcas.map((m) => Object.assign(cxLbl(m), { valores: meses.map((mes) => { const x = por(m, mes); return x.valorEstorno + x.valorTroca; }) })) }) };
  else if (k === "analise") r = { tit: "Em análise hoje · por mês de abertura", sub: "reversas ainda paradas, pelo mês em que o cliente abriu · uma cor por marca",
    html: cxgBarras({ rotulosX, fmt: fmtNum, aria: "Em análise por mês de abertura", vazio: "Nenhuma reversa em análise.", series: marcas.map((m) => Object.assign(cxLbl(m), { valores: meses.map((mes) => por(m, mes).emAnalise) })) }) };
  else r = { tit: "Reversas · por mês", sub: "abertas pelo cliente no portal · uma cor por marca · último mês pode estar em andamento",
    html: cxgBarras({ rotulosX, fmt: fmtNum, aria: "Reversas por mês", vazio: "Sem reversa.", series: marcas.map((m) => Object.assign(cxLbl(m), { valores: meses.map((mes) => por(m, mes).reversas) })) }) };
  cxGraficoBloco("trocas", r);
}

// ---------- Concessão sobre receita (16/09): cx_concessao (ClickUp ÷ Shopify) e cx_concessao_tipo ----------
// Meta do Head de CX. Grão mensal, na aba Trocas (é o mesmo dinheiro saindo). Só ClickUp e só o que o financeiro já
// executou (regra na view). Faixa provisória de 1% até o Samuel fixar a meta dele.
estado.metricaConcessao = estado.metricaConcessao || "pct";
CX_BLOCOS.concessao = { area: "#area-concessao-num", g: "#g-concessao", tit: "#g-concessao-tit", sub: "#g-concessao-sub", chave: "metricaConcessao", grafico: (d) => pintaGraficoConcessaoAba(d) };
Object.assign(DIRECAO, { co_pct: "baixo", co_valor: "baixo", co_casos: "baixo", co_negados: "neutro", co_mil: "baixo" });
const fmtBRLk = (v) => typeof v === "number" ? (Math.abs(v) >= 100000 ? "R$ " + (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil" : fmtBRL(v)) : "—";
let CX_CONCESSAO_DADOS = null;
function pintaConcessaoAba(d) {
  if (!$("#area-concessao-num")) return;
  const rows = d.cx_concessao || [], tipos = d.cx_concessao_tipo || [];
  const marcas = cxMarcasSerie(); const todas = marcas.length > 1;
  const hoje = hojeRef(); const mesAtual = cxMesAtual(hoje), mesAnt = cxMesAnterior(mesAtual), mesAnt2 = cxMesAnterior(mesAnt);
  const rot = $("#concessao-rotulo"), tab = $("#area-concessao"), tabTipo = $("#area-concessao-tipo"), tabRot = $("#concessao-tab-rot");
  CX_CONCESSAO_DADOS = { marcas };
  if (!rows.length) {
    if (rot) rot.innerHTML = cxTag("sem coleta", "alerta", "A API ainda não devolve cx_concessao. Coletores noturnos: CX — Concessões (ClickUp, 01:50) e CX — Receita (Shopify, 01:40).");
    cxPintaCartoes("concessao", [{ k: "pct", rot: "Concessão · % da receita", val: "—", sub: "sem leitura" }]);
    if (tab) tab.innerHTML = `<div class="vazio">Sem leitura do ClickUp/Shopify ainda.</div>`; if (tabTipo) tabTipo.innerHTML = ""; if (tabRot) tabRot.innerHTML = "";
    pintaGraficoConcessaoAba(d); return;
  }
  const ag = (mIni, mFim, ms) => concessaoAgg(rows, { marcas: ms || marcas, mesIni: mIni, mesFim: mFim });
  const fechado = ag(mesAnt, mesAnt), fechadoAnt = ag(mesAnt2, mesAnt2), atual = ag(mesAtual, mesAtual), tudo = ag();
  const diaDoMes = Number(hoje.slice(8, 10));
  const porMarca = (fn) => todas ? `\n\nPor marca: ${cxPorMarcaTxt(marcas, (m) => fn(m))}` : "";
  const pctTxt = (x) => x.pct === null ? "—" : fmtDec(x.pct, 2) + "%";
  const cartoes = [
    { k: "pct", rot: `Concessão · ${fmtMes(mesAnt)}`, val: pctTxt(fechado), status: cxStatus("concessao_pct", fechado.pct), chip: cxChipPP("co_pct", fechado.pct, fechadoAnt.pct, 2),
      sub: fechado.pct === null ? (fechado.receitaFaltando ? "receita do mês incompleta" : "sem receita") : `${fmtBRLk(fechado.valorConcedido)} de ${fmtBRLk(fechado.receita)}`,
      info: `Reembolsos do ClickUp que o financeiro já executou (status feito, redigindo resposta, retorno concluído) ÷ receita Shopify do último mês fechado (${fmtMes(mesAnt)}). ${CX_ALVOS.concessao_pct.rot} — meta do Head de CX ainda por fixar. Chip contra ${fmtMes(mesAnt2)}.` + porMarca((m) => pctTxt(ag(mesAnt, mesAnt, [m]))) },
    { k: "ritmo", rot: `${fmtMes(mesAtual)} até hoje`, val: pctTxt(atual), status: cxStatus("concessao_pct", atual.pct), sub: atual.pct === null && atual.receitaFaltando ? `receita incompleta · ${fmtBRLk(atual.valorConcedido)} pagos em ${diaDoMes} dia${diaDoMes === 1 ? "" : "s"}` : `em ${diaDoMes} dia${diaDoMes === 1 ? "" : "s"} · ${fmtBRLk(atual.valorConcedido)} de ${fmtBRLk(atual.receita)}`,
      info: `Mesma conta no mês corrente. Lê-se com cuidado: o caso costuma ser pago semanas depois de aberto, então o mês em andamento sobe até fechar — veja "em andamento".` + porMarca((m) => pctTxt(ag(mesAtual, mesAtual, [m]))) },
    { k: "clickup", rot: `Pagos pelo financeiro · ${fmtMes(mesAnt)}`, val: fmtBRL(fechado.valorConcedido), chip: fechadoAnt.valorConcedido ? chipHtml("co_valor", fechado.valorConcedido, fechadoAnt.valorConcedido, fmtBRL) : "",
      sub: `${fmtNum(fechado.concedidos)} caso${fechado.concedidos === 1 ? "" : "s"} · ${fechado.ticketMedio === null ? "—" : fmtBRL(fechado.ticketMedio)} médio${fechado.semValor ? ` · ${fmtNum(fechado.semValor)} sem valor` : ""}`,
      info: `Soma de '➤Valor do reembolso' dos casos abertos no mês e já pagos. Cupom de cortesia (nível 1), quando registrado, entra pelo valor do cupom.` + porMarca((m) => fmtBRL(ag(mesAnt, mesAnt, [m]).valorConcedido)) },
    { k: "pendente", rot: "Em andamento agora", val: fmtBRL(tudo.valorAndamento), status: tudo.andamento === 0 ? "bom" : tudo.andamento >= 10 ? "ruim" : "atencao", sub: `${fmtNum(tudo.andamento)} caso${tudo.andamento === 1 ? "" : "s"} · foto de agora`,
      info: `Casos ainda em negociação, aguardando N2/Samuel, encaminhados ao financeiro ou com erro, todos os meses — dinheiro que provavelmente vai sair e ainda não está na %. Vermelho com 10+ casos parados.` + porMarca((m) => { const x = ag(null, null, [m]); return `${fmtBRL(x.valorAndamento)} (${fmtNum(x.andamento)})`; }) },
    { k: "negados", rot: `Negados · ${fmtMes(mesAnt)}`, val: fmtPct0(fechado.pctNegados), chip: cxChipPP("co_negados", fechado.pctNegados, fechadoAnt.pctNegados), sub: `${fmtNum(fechado.negados)} de ${fmtNum(fechado.negados + fechado.concedidos)} decididos`,
      info: `Fatia dos casos do mês já decididos (pagos + negados) em que o CX disse não. Não tem direção certa: muito alto pode ser política dura demais, muito baixo pode ser concessão fácil.` + porMarca((m) => { const x = ag(mesAnt, mesAnt, [m]); return `${fmtPct0(x.pctNegados)} (${fmtNum(x.negados)} de ${fmtNum(x.negados + x.concedidos)})`; }) },
    { k: "mil", rot: `Casos / 1.000 pedidos · ${fmtMes(mesAnt)}`, val: fechado.casosPorMilPedidos === null ? "—" : fmtDec(fechado.casosPorMilPedidos, 1), chip: typeof fechadoAnt.casosPorMilPedidos === "number" ? chipHtml("co_mil", fechado.casosPorMilPedidos, fechadoAnt.casosPorMilPedidos, (v) => fmtDec(v, 1)) : "", sub: `${fmtNum(fechado.casos)} casos · ${fmtNum(fechado.pedidos)} pedidos`,
      info: `Casos abertos na lista Reembolsos no mês por 1.000 pedidos criados na Shopify no mesmo mês — o volume normalizado, que permite comparar as marcas e os meses.` + porMarca((m) => { const x = ag(mesAnt, mesAnt, [m]); return x.casosPorMilPedidos === null ? "—" : fmtDec(x.casosPorMilPedidos, 1); }) },
  ];
  const leitura = tudo.coletadoEm ? cxDia(tudo.coletadoEm) : null;
  const fishSemRelatorio = rows.some((l) => l.marca === "fishermans" && Number(l.receita));
  if (rot) rot.innerHTML = (leitura ? cxTag(`leitura de ${fmtDia(leitura)}`, "nota", "Última leitura do ClickUp (01:50) e da receita Shopify (01:40).") : "") +
    cxTag("grão mensal", "nota", "Concessão não segue o período do painel: cartões leem o último mês fechado e o mês atual; 'em andamento' é foto de agora.") +
    cxTag("só o que o financeiro pagou", "nota", "Conta como concedido o caso do ClickUp em 'feito', 'redigindo resposta' ou 'retorno concluído'. Em negociação, ag. N2/Samuel, enc. financeiro e com erro ficam em 'em andamento'. Negado nunca entra. Estorno da Shopify fica fora de propósito: inclui cancelamento de pedido que não passou pelo CX.") +
    (fishSemRelatorio ? cxTag("Fish: receita = soma dos pedidos", "nota", "A loja Fishermans ainda não liberou o escopo read_reports; a receita é a soma dos pedidos não cancelados do dia, ~0,1% diferente do Analytics.") : "") +
    cxResumoStatus(cartoes);
  cxPintaCartoes("concessao", cartoes);
  pintaGraficoConcessaoAba(d);
  // tabela mês × marca (últimos 6 meses com dado)
  const meses = concessaoMeses(rows, marcas).slice(-6).reverse();
  if (tabRot) tabRot.innerHTML = cxTag("caso no mês em que foi aberto", "nota", "O caso conta no mês em que foi criado no ClickUp, não no mês do pagamento.");
  if (tab) tab.innerHTML = `<div class="rolagem"><table class="comparativo concessao-tab">
    <thead><tr><th>Mês</th><th>Marca</th><th class="num" title="total de vendas Shopify">Receita</th><th class="num" title="pedidos criados na Shopify">Pedidos</th><th class="num" title="casos abertos no mês na lista Reembolsos; embaixo, quantos foram negados">Casos</th><th class="num" title="casos por 1.000 pedidos">/ mil</th><th class="num" title="financeiro já executou (feito, redigindo resposta, retorno concluído)">Pagos</th><th class="num" title="ainda em negociação / N2 / Samuel / financeiro / com erro">Em andamento</th><th class="num" title="cupom de cortesia">N1</th><th class="num" title="compensação parcial">N2</th><th class="num" title="reembolso total">N3</th><th class="num" title="soma dos reembolsos pagos">Pago</th><th class="num" title="pago ÷ receita">% receita</th></tr></thead>
    <tbody>${meses.flatMap((mes) => marcas.map((m) => { const x = ag(mes, mes, [m]); if (!x.casos && !x.receita) return ""; const st = cxStatus("concessao_pct", x.pct); return `<tr>
      <td>${fmtMes(mes)}${mes === mesAtual ? '<div class="mini">até hoje</div>' : ""}</td>
      <td><span class="ponto" style="--cor:${corHex(m)}"></span> <span class="nome">${ROTULOS[m]}</span></td>
      <td class="num">${x.receitaFaltando ? `<span title="mês com dia sem receita coletada">${x.receita ? "≥ " + fmtBRLk(x.receita) : "—"}</span>` : fmtBRLk(x.receita)}</td>
      <td class="num">${x.pedidos ? fmtNum(x.pedidos) : "—"}</td>
      <td class="num">${fmtNum(x.casos)}${x.negados ? `<div class="mini">${fmtNum(x.negados)} negado${x.negados === 1 ? "" : "s"}</div>` : ""}</td>
      <td class="num">${x.casosPorMilPedidos === null ? "—" : fmtDec(x.casosPorMilPedidos, 1)}</td>
      <td class="num"><strong class="tabn">${fmtNum(x.concedidos)}</strong>${x.semValor ? `<div class="mini">${fmtNum(x.semValor)} sem valor</div>` : ""}</td>
      <td class="num ${x.andamento ? "vm" : ""}">${fmtNum(x.andamento)}${x.valorAndamento ? `<div class="mini">${fmtBRL(x.valorAndamento)}</div>` : ""}</td>
      <td class="num">${fmtNum(x.n1)}<div class="mini">${fmtBRL(x.valorN1)}</div></td><td class="num">${fmtNum(x.n2)}<div class="mini">${fmtBRL(x.valorN2)}</div></td><td class="num">${fmtNum(x.n3)}<div class="mini">${fmtBRL(x.valorN3)}</div></td>
      <td class="num"><strong>${fmtBRL(x.valorConcedido)}</strong></td>
      <td class="num"><strong class="tabn${st ? " st-" + st : ""}">${pctTxt(x)}</strong></td></tr>`; })).join("")}</tbody></table></div>`;
  // tipos de caso: 3 meses fechados + atual
  const mIni = cxMesAnterior(cxMesAnterior(mesAnt));
  const lista = concessaoTipos(tipos, { marcas, mesIni: mIni, mesFim: mesAtual });
  if (tabTipo) tabTipo.innerHTML = !lista.length ? `<div class="vazio mini">Sem tipo de caso registrado no intervalo.</div>` : `<div class="rolagem"><table class="comparativo concessao-tipo">
    <thead><tr><th>Marca</th><th>Tipo de caso (${fmtMes(mIni)}–${fmtMes(mesAtual)})</th><th class="num">Casos</th><th class="num" title="financeiro já executou">Pagos</th><th class="num" title="soma dos reembolsos pagos">Valor</th><th class="num" title="valor ÷ pagos">Médio</th></tr></thead>
    <tbody>${lista.slice(0, 14).map((x) => `<tr><td><span class="ponto" style="--cor:${corHex(x.marca)}"></span> ${CX_SIGLA[x.marca] || x.marca}</td><td>${x.tipo}</td><td class="num">${fmtNum(x.casos)}</td><td class="num"><strong class="tabn">${fmtNum(x.concedidos)}</strong></td><td class="num">${fmtBRL(x.valor)}</td><td class="num">${x.concedidos ? fmtBRL(x.valor / x.concedidos) : "—"}</td></tr>`).join("")}</tbody></table></div>`;
}
function pintaGraficoConcessaoAba(d) {
  if (!CX_CONCESSAO_DADOS || !$("#g-concessao")) return;
  const rows = d.cx_concessao || []; const { marcas } = CX_CONCESSAO_DADOS; const k = estado.metricaConcessao;
  const meses = concessaoMeses(rows, marcas).slice(-12);
  if (!meses.length) { cxGraficoBloco("concessao", { tit: "Concessão · % da receita por mês", sub: "", html: `<div class="vazio mini">Sem leitura do ClickUp/Shopify ainda.</div>` }); return; }
  const rotulosX = meses.map(fmtMes); const hojeMes = cxMesAtual(hojeRef());
  const por = (m, mes) => concessaoAgg(rows, { marcas: [m], mesIni: mes, mesFim: mes });
  const todos = (mes) => concessaoAgg(rows, { marcas, mesIni: mes, mesFim: mes });
  let r;
  if (k === "clickup") r = { tit: "Pago pelo financeiro · por mês", sub: "reembolsos do ClickUp já executados, pelo mês em que o caso foi aberto · uma cor por marca",
    html: cxgBarras({ rotulosX, fmt: fmtBRL, aria: "Valor pago por mês", vazio: "Sem caso pago.", series: marcas.map((m) => Object.assign(cxLbl(m), { valores: meses.map((mes) => por(m, mes).valorConcedido) })) }) };
  else if (k === "pendente" || k === "negados") r = { tit: "Casos do ClickUp · por mês de abertura", sub: "pagos, negados e ainda em andamento · as marcas escolhidas somadas · número no topo = % negados entre os decididos",
    html: cxgBarras({ rotulosX, fmt: fmtNum, aria: "Casos por mês", vazio: "Sem caso.",
      series: [{ nome: "Pagos", cor: "var(--ruim)", valores: meses.map((mes) => todos(mes).concedidos) }, { nome: "Em andamento", cor: "#d9971e", valores: meses.map((mes) => todos(mes).andamento) }, { nome: "Negados", cor: "var(--bom)", valores: meses.map((mes) => todos(mes).negados) }],
      topo: meses.map((mes) => { const x = todos(mes); return x.pctNegados === null ? "" : fmtPct0(x.pctNegados); }) }) };
  else if (k === "mil") r = { tit: "Casos por 1.000 pedidos · por mês", sub: "casos abertos na lista Reembolsos ÷ pedidos Shopify do mês · uma linha por marca",
    html: cxgLinhas({ rotulosX, fmt: (v) => fmtDec(v, 1), aria: "Casos por mil pedidos por mês", vazio: "Sem pedidos.",
      series: marcas.map((m) => Object.assign(cxLbl(m), { pontos: meses.map((mes) => { const x = por(m, mes); return { y: x.casosPorMilPedidos, rot: fmtMes(mes), n: `${fmtNum(x.casos)} casos · ${fmtNum(x.pedidos)} pedidos`, parcial: mes === hojeMes }; }) })) }) };
  else r = { tit: "Concessão · % da receita por mês", sub: "pago pelo financeiro ÷ receita Shopify · uma linha por marca · faixa < 1% é provisória até o Samuel fixar a meta · mês sem receita completa fica em branco",
    html: cxgLinhas({ rotulosX, fmt: (v) => fmtDec(v, 2) + "%", aria: "Concessão sobre receita por mês", vazio: "Sem receita ou sem caso.", alvo: { y: CX_ALVOS.concessao_pct.alvo, rot: "< 1%" },
      series: marcas.map((m) => Object.assign(cxLbl(m), { pontos: meses.map((mes) => { const x = por(m, mes); return { y: x.pct, rot: fmtMes(mes), n: `${fmtBRLk(x.valorConcedido)} de ${fmtBRLk(x.receita)}`, parcial: mes === hojeMes }; }) })) }) };
  cxGraficoBloco("concessao", r);
}

// ---------- abas ----------
// A aba vive no hash (#aba=chat): link copiado abre no lugar certo. Filtros continuam globais.
// Tudo é pintado sempre (as abas escondidas também) — trocar de aba é instantâneo e não refaz conta.
const CX_ABAS = ["geral", "chat", "ra", "nps", "social", "trocas"];
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
