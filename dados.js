// ================== CAMADA DE DADOS ==================
// Funções puras: recebem o payload da API e devolvem números prontos.
// Nenhum DOM aqui — dá pra testar com `node teste_dados.js`.
//
// Regras que este arquivo respeita (não mude sem entender):
// 1. NULL do banco = coleta falhou. Nunca vira 0. Propaga como null e a tela mostra "—".
// 2. Contagens (novos, fechados, respostas...) SOMAM entre dias/marcas.
// 3. Medianas e CSAT NÃO somam. Quando não existe a linha de janela exata
//    (cx_snapshot com janela='7d'/'30d'), aproximamos com média ponderada por
//    volume e marcamos aprox=true (a tela mostra "≈").
// 4. Janela exata, quando existe, sempre vence a aproximação.

const MARCAS = ["aristocrata", "fishermans", "olivas"];
const ROTULOS = { aristocrata: "O Aristocrata", fishermans: "Fishermans", olivas: "Olivas do Campo" };
// NPS grava marca como 'aristo'/'fish' (padrão do fluxo Listmonk)
const NPS_MARCA = { aristo: "aristocrata", fish: "fishermans", olivas: "olivas" };

// métrica -> direção boa ('baixo' = cair é bom, 'alto' = subir é bom, 'neutro')
const DIRECAO = {
  novos: "neutro", fechados: "alto", trabalhados: "alto", respostas: "neutro",
  fila_aberta: "baixo", primeira_resposta_seg: "baixo", csat: "alto",
  csat_cobertura: "alto", kai_deflexao: "alto",
};

// ---------- utilidades ----------
function soma(vals) {
  const v = vals.filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}
// média ponderada; pesos sem valor são ignorados
function mediaPond(pares) {
  let num = 0, den = 0;
  for (const [valor, peso] of pares) {
    if (typeof valor === "number" && typeof peso === "number" && peso > 0) {
      num += valor * peso; den += peso;
    }
  }
  return den > 0 ? num / den : null;
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function diasAtras(n, base) {
  const d = base ? new Date(base) : new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return ymd(d);
}

// ---------- agregação de marca ----------
// linhas: cx_snapshot janela='1d' de UMA marca, dentro do intervalo [ini, fim] (ymd inclusivo)
function agregaDias(linhas) {
  if (!linhas.length) return null;
  const ult = linhas[linhas.length - 1]; // linha mais recente do período
  return {
    novos: soma(linhas.map((l) => l.novos)),
    fechados: soma(linhas.map((l) => l.fechados)),
    trabalhados: soma(linhas.map((l) => l.trabalhados)),
    respostas: soma(linhas.map((l) => l.respostas)),
    // tempos/qualidade: ponderados por volume do dia (aproximação, ver regra 3)
    primeira_resposta_seg: mediaPond(linhas.map((l) => [l.primeira_resposta_seg, l.novos])),
    primeira_resposta_comercial_seg: mediaPond(linhas.map((l) => [l.primeira_resposta_comercial_seg, l.amostra_comercial])),
    resolucao_comercial_seg: mediaPond(linhas.map((l) => [l.resolucao_comercial_seg, l.amostra_comercial])),
    amostra_comercial: soma(linhas.map((l) => l.amostra_comercial)),
    csat: mediaPond(linhas.map((l) => [l.csat, l.csat_votos])),
    csat_cobertura: mediaPond(linhas.map((l) => [Number(l.csat_cobertura), l.fechados])),
    csat_votos: soma(linhas.map((l) => l.csat_votos)),
    kai_deflexao: mediaPond(linhas.map((l) => [Number(l.kai_deflexao), l.ia_perguntas])),
    fila_aberta: ult.fila_aberta, // foto do momento: só faz sentido a mais recente
    aprox: linhas.length > 1,     // 1 dia = exato; vários dias = medianas aproximadas
    dias: linhas.length,
    incompleto: linhas.some((l) => l.coletas_ok < l.coletas_total),
  };
}

function filtraDias(snapshot1d, marca, ini, fim) {
  return snapshot1d
    .filter((l) => l.marca === marca && l.dia >= ini && l.dia <= fim)
    .sort((a, b) => (a.dia < b.dia ? -1 : 1));
}

// janela exata (linha 7d/30d da consolidação noturna), se existir para o fim do período
function janelaExata(janelas, marca, jan, fim) {
  const l = janelas.find((x) => x.marca === marca && x.janela === jan && x.dia === fim);
  if (!l) return null;
  return {
    novos: l.novos, fechados: l.fechados, trabalhados: l.trabalhados, respostas: l.respostas,
    primeira_resposta_seg: l.primeira_resposta_seg,
    primeira_resposta_comercial_seg: l.primeira_resposta_comercial_seg,
    resolucao_comercial_seg: l.resolucao_comercial_seg, amostra_comercial: l.amostra_comercial,
    csat: l.csat, csat_cobertura: Number(l.csat_cobertura), csat_votos: l.csat_votos,
    kai_deflexao: Number(l.kai_deflexao), fila_aberta: l.fila_aberta,
    aprox: false, dias: jan === "7d" ? 7 : 30,
    incompleto: l.coletas_ok < l.coletas_total,
  };
}

// Período atual + anterior para (marca, janela). hoje = ymd de referência.
function periodoMarca(dados, marca, janela, hoje) {
  const s1 = dados.snapshot_1d;
  if (janela === "dia") {
    const atual = agregaDias(filtraDias(s1, marca, hoje, hoje));
    const ontem = diasAtras(1, hoje);
    const anterior = agregaDias(filtraDias(s1, marca, ontem, ontem));
    return { atual, anterior, rotuloComp: "vs ontem (dia completo)" };
  }
  const n = janela === "7d" ? 7 : 30;
  // período atual termina ONTEM (último dia fechado); hoje parcial distorceria a comparação
  const fimAtual = diasAtras(1, hoje);
  const atual =
    janelaExata(dados.janelas, marca, janela, fimAtual) ||
    agregaDias(filtraDias(s1, marca, diasAtras(n, hoje), fimAtual));
  const anterior =
    janelaExata(dados.janelas, marca, janela, diasAtras(n, fimAtual)) ||
    agregaDias(filtraDias(s1, marca, diasAtras(2 * n, hoje), diasAtras(n + 1, hoje)));
  // fila do período atual: usar a foto mais recente (linha 1d de hoje), não a de ontem
  const hojeRow = filtraDias(s1, marca, hoje, hoje)[0];
  if (atual && hojeRow && typeof hojeRow.fila_aberta === "number") atual.fila_aberta = hojeRow.fila_aberta;
  return { atual, anterior, rotuloComp: janela === "7d" ? "vs 7 dias anteriores" : "vs 30 dias anteriores" };
}

// visão consolidada = soma das marcas (contagens) + ponderações (qualidade)
function consolida(porMarca) {
  const ms = MARCAS.map((m) => porMarca[m]).filter((p) => p && p.atual);
  if (!ms.length) return null;
  function junta(lado) {
    const ps = ms.map((p) => p[lado]).filter(Boolean);
    if (!ps.length) return null;
    return {
      novos: soma(ps.map((p) => p.novos)),
      fechados: soma(ps.map((p) => p.fechados)),
      trabalhados: soma(ps.map((p) => p.trabalhados)),
      respostas: soma(ps.map((p) => p.respostas)),
      primeira_resposta_seg: mediaPond(ps.map((p) => [p.primeira_resposta_seg, p.novos])),
      primeira_resposta_comercial_seg: mediaPond(ps.map((p) => [p.primeira_resposta_comercial_seg, p.amostra_comercial])),
      resolucao_comercial_seg: mediaPond(ps.map((p) => [p.resolucao_comercial_seg, p.amostra_comercial])),
      amostra_comercial: soma(ps.map((p) => p.amostra_comercial)),
      csat: mediaPond(ps.map((p) => [p.csat, p.csat_votos])),
      csat_cobertura: mediaPond(ps.map((p) => [p.csat_cobertura, p.fechados])),
      csat_votos: soma(ps.map((p) => p.csat_votos)),
      kai_deflexao: mediaPond(ps.map((p) => [p.kai_deflexao, p.novos])),
      fila_aberta: soma(ps.map((p) => p.fila_aberta)),
      aprox: true,
      incompleto: ps.some((p) => p.incompleto),
    };
  }
  return { atual: junta("atual"), anterior: junta("anterior"), rotuloComp: ms[0].rotuloComp };
}

// ---------- agentes ----------
function rankingAgentes(dados, marca, janela, hoje) {
  const src = dados.agentes_1d;
  let ini, fim;
  if (janela === "dia") { ini = hoje; fim = hoje; }
  else if (janela === "7d") { ini = diasAtras(7, hoje); fim = diasAtras(1, hoje); }
  else { ini = diasAtras(30, hoje); fim = diasAtras(1, hoje); }

  // janela exata por agente, quando existir
  if (janela !== "dia") {
    const exatas = dados.agentes_janelas.filter(
      (a) => a.janela === (janela === "7d" ? "7d" : "30d") && a.dia === fim && (marca === "todas" || a.marca === marca)
    );
    if (exatas.length) return agrupaAgentes(exatas, false);
  }
  const linhas = src.filter(
    (a) => a.dia >= ini && a.dia <= fim && (marca === "todas" || a.marca === marca)
  );
  return agrupaAgentes(linhas, janela !== "dia");
}

function agrupaAgentes(linhas, aprox) {
  const por = {};
  for (const l of linhas) {
    const chave = l.agente_id + "|" + (l.marca || "");
    por[chave] = por[chave] || { agente_id: l.agente_id, nome: l.agente_nome, marca: l.marca, linhas: [] };
    por[chave].linhas.push(l);
  }
  const out = Object.values(por).map((g) => ({
    agente_id: g.agente_id, nome: g.nome, marca: g.marca, aprox,
    trabalhados: soma(g.linhas.map((l) => l.trabalhados)),
    respostas: soma(g.linhas.map((l) => l.respostas)),
    fechados: soma(g.linhas.map((l) => l.fechados)),
    csat: mediaPond(g.linhas.map((l) => [l.csat, l.respostas])),
    resposta_mediana_seg: mediaPond(g.linhas.map((l) => [l.resposta_mediana_seg, l.respostas])),
    primeira_resposta_seg: mediaPond(g.linhas.map((l) => [l.primeira_resposta_seg, l.trabalhados])),
    fechamento_seg: mediaPond(g.linhas.map((l) => [l.fechamento_seg, l.fechados])),
    horas_ativas_seg: soma(g.linhas.map((l) => l.horas_ativas_seg)),
  }));
  return out
    .filter((a) => (a.trabalhados || 0) + (a.respostas || 0) > 0)
    .sort((a, b) => (b.trabalhados || 0) - (a.trabalhados || 0));
}


// ---------- períodos por intervalo arbitrário (seletor estilo Shopify) ----------
function diffDias(ini, fim) {
  return Math.round((new Date(fim + "T12:00Z") - new Date(ini + "T12:00Z")) / 86400000);
}
// agrega uma marca num intervalo [ini, fim]; usa janela exata quando o intervalo coincide
function agregaRange(dados, marca, ini, fim, hoje) {
  const len = diffDias(ini, fim) + 1;
  const ontem = diasAtras(1, hoje);
  if (fim === ontem && (len === 7 || len === 30)) {
    const ex = janelaExata(dados.janelas, marca, len + "d", fim);
    if (ex) return ex;
  }
  const ag = agregaDias(filtraDias(dados.snapshot_1d, marca, ini, fim));
  // fila: se o intervalo alcança hoje, usa a foto mais recente
  if (ag && fim >= hoje) {
    const h = filtraDias(dados.snapshot_1d, marca, hoje, hoje)[0];
    if (h && typeof h.fila_aberta === "number") ag.fila_aberta = h.fila_aberta;
  }
  return ag;
}
// comparação automática: mesmo tamanho, imediatamente anterior
function rangeAnterior(ini, fim) {
  const len = diffDias(ini, fim) + 1;
  return { ini: diasAtras(len, ini), fim: diasAtras(1, ini) };
}
function rankingAgentesRange(dados, marca, ini, fim, hoje) {
  const len = diffDias(ini, fim) + 1;
  const ontem = diasAtras(1, hoje);
  if (fim === ontem && (len === 7 || len === 30)) {
    const exatas = dados.agentes_janelas.filter((a) =>
      a.janela === len + "d" && a.dia === fim && (marca === "todas" || a.marca === marca));
    if (exatas.length) return agrupaAgentes(exatas, false);
  }
  const linhas = dados.agentes_1d.filter((a) =>
    a.dia >= ini && a.dia <= fim && (marca === "todas" || a.marca === marca));
  return agrupaAgentes(linhas, len > 1);
}
// ---------- NPS ----------
// NPS num intervalo [ini, fim] (ymd de São Paulo), com nota média 0-10
function calculaNps(votos, marca, ini, fim) {
  const sel = votos.filter((v) => {
    const m = NPS_MARCA[v.marca] || v.marca;
    if (marca !== "todas" && m !== marca) return false;
    const spYmdVoto = new Date(new Date(v.data).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    return spYmdVoto >= ini && spYmdVoto <= fim;
  });
  const n = sel.length;
  if (!n) return { n: 0, nps: null, media: null, prom: 0, pass: 0, detr: 0 };
  const prom = sel.filter((v) => v.bucket === "promotor").length;
  const detr = sel.filter((v) => v.bucket === "detrator").length;
  const media = sel.reduce((a, v) => a + (v.score || 0), 0) / n;
  return { n, prom, detr, pass: n - prom - detr,
    nps: Math.round(((prom - detr) / n) * 100), media: Math.round(media * 10) / 10 };
}


// ---------- séries para o gráfico comparativo ----------
// intradiária: pontos {x: minutos desde 00:00 SP, y} do dia pedido
function serieIntradia(intradia, marca, diaYmd, metrica) {
  // por marca: bucket(10min) -> último valor; depois forward-fill na união dos
  // buckets e soma — sem isso, a visão "todas" afundaria quando uma marca
  // pulasse uma coleta.
  const porMarca = {};
  for (const p of intradia || []) {
    const sp = new Date(new Date(p.ts).getTime() - 3 * 3600 * 1000);
    if (sp.toISOString().slice(0, 10) !== diaYmd) continue;
    if (marca !== "todas" && p.marca !== marca) continue;
    const b = Math.round((sp.getUTCHours() * 60 + sp.getUTCMinutes()) / 10) * 10;
    const val = p[metrica];
    if (typeof val !== "number") continue;
    (porMarca[p.marca] = porMarca[p.marca] || {})[b] = val;
  }
  const marcasSerie = Object.keys(porMarca);
  if (!marcasSerie.length) return [];
  const buckets = [...new Set(marcasSerie.flatMap((m) => Object.keys(porMarca[m]).map(Number)))].sort((a, b) => a - b);
  const ultimo = {};
  return buckets.map((b) => {
    let soma = 0;
    for (const m of marcasSerie) {
      if (porMarca[m][b] !== undefined) ultimo[m] = porMarca[m][b];
      soma += ultimo[m] || 0;
    }
    return { x: b, y: soma };
  });
}

// último valor acumulado de um dia até determinado minuto (comparação "mesma hora")
function valorMesmaHora(intradia, marca, diaYmd, metrica, minutoLimite) {
  const serie = serieIntradia(intradia, marca, diaYmd, metrica);
  let ult = null;
  for (const p of serie) if (p.x <= minutoLimite) ult = p.y;
  return ult; // null = sem pontos naquele dia até aquele horário
}
// diária: um ponto por dia no intervalo [ini, fim]
function serieDiaria(snapshot1d, marca, ini, fim, metrica) {
  const dias = [...new Set(snapshot1d.filter((l) => l.dia >= ini && l.dia <= fim).map((l) => l.dia))].sort();
  return dias.map((dd, i) => {
    const ls = snapshot1d.filter((l) => l.dia === dd && (marca === "todas" || l.marca === marca));
    const vals = ls.map((l) => l[metrica]).filter((v) => typeof v === "number");
    return { x: i, y: vals.length ? vals.reduce((a, b) => a + b, 0) : null, dia: dd };
  }).filter((p) => p.y !== null);
}
// ---------- formatação ----------
function fmtNum(v) { return typeof v === "number" ? Math.round(v).toLocaleString("pt-BR") : "—"; }
function fmtPct(v) { return typeof v === "number" ? v.toFixed(1).replace(".", ",") + "%" : "—"; }
function fmtDur(seg) {
  if (typeof seg !== "number") return "—";
  if (seg < 90) return Math.round(seg) + "s";
  if (seg < 5400) return (seg / 60).toFixed(0) + "min";
  return (seg / 3600).toFixed(1).replace(".", ",") + "h";
}
// delta: devolve {texto, classe} conforme a direção boa da métrica
function delta(metrica, atual, anterior) {
  if (typeof atual !== "number" || typeof anterior !== "number" || anterior === 0)
    return { texto: "", classe: "d-neutro" };
  const p = ((atual - anterior) / Math.abs(anterior)) * 100;
  if (Math.abs(p) < 0.5) return { texto: "＝", classe: "d-neutro" };
  const seta = p > 0 ? "▲" : "▼";
  const pctTxt = Math.abs(p) > 500 ? ">500%" : Math.abs(p).toFixed(0) + "%";
  const dir = DIRECAO[metrica] || "neutro";
  let classe = "d-neutro";
  if (dir === "alto") classe = p > 0 ? "d-bom" : "d-ruim";
  if (dir === "baixo") classe = p > 0 ? "d-ruim" : "d-bom";
  return { texto: `${seta} ${pctTxt}`, classe };
}

// exporta para node (testes) sem quebrar o navegador
if (typeof module !== "undefined") {
  module.exports = { serieIntradia, serieDiaria, valorMesmaHora, diffDias, agregaRange, rangeAnterior, rankingAgentesRange, MARCAS, ROTULOS, agregaDias, filtraDias, periodoMarca, consolida,
    rankingAgentes, calculaNps, fmtNum, fmtPct, fmtDur, delta, diasAtras };
}
