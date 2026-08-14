// ================== RENDER ==================
// Hierarquia de decisão: alertas → 4 KPIs grandes → marcas lado a lado → pessoas/NPS.
// Toda a matemática vive em dados.js. URL params: ?marca=aristocrata&janela=7d

const estado = {
  marca: new URLSearchParams(location.search).get("marca") || "todas",
  preset: (() => {
    const q = new URLSearchParams(location.search);
    const mapaAntigo = { dia: "hoje", "7d": "7d", "30d": "30d" };
    return q.get("periodo") || mapaAntigo[q.get("janela")] || "hoje";
  })(), // hoje|ontem|7d|30d|mes|mes-1|custom
  ini: null, fim: null,          // resolvidos em resolverPeriodo()
  comparar: true,
  compAuto: true, cIni: null, cFim: null,
  agente: "todos",
  dados: null,
};
function resolverPeriodo(hoje) {
  const p = estado.preset;
  let ini, fim, rotulo;
  if (p === "hoje") { ini = fim = hoje; rotulo = "hoje"; }
  else if (p === "ontem") { ini = fim = diasAtras(1, hoje); rotulo = "ontem"; }
  else if (p === "7d") { ini = diasAtras(7, hoje); fim = diasAtras(1, hoje); rotulo = "últimos 7 dias"; }
  else if (p === "30d") { ini = diasAtras(30, hoje); fim = diasAtras(1, hoje); rotulo = "últimos 30 dias"; }
  else if (p === "mes") { ini = hoje.slice(0, 8) + "01"; fim = hoje; rotulo = "este mês (parcial)"; }
  else if (p === "mes-1") {
    const d1 = new Date(hoje.slice(0, 8) + "01T12:00Z"); d1.setUTCMonth(d1.getUTCMonth() - 1);
    ini = d1.toISOString().slice(0, 8) + "01";
    const dfim = new Date(hoje.slice(0, 8) + "01T12:00Z"); dfim.setUTCDate(0);
    fim = dfim.toISOString().slice(0, 10); rotulo = "mês passado";
  } else { // custom
    ini = estado.ini || hoje; fim = estado.fim || hoje;
    if (ini > fim) [ini, fim] = [fim, ini];
    rotulo = ini === fim ? fmtDia(ini) : fmtDia(ini) + " – " + fmtDia(fim);
  }
  estado.ini = ini; estado.fim = fim;
  const auto = rangeAnterior(ini, fim);
  const cIni = estado.compAuto ? auto.ini : (estado.cIni || auto.ini);
  const cFim = estado.compAuto ? auto.fim : (estado.cFim || auto.fim);
  const rotComp = estado.compAuto ? "vs período anterior" : "vs " + fmtDia(cIni) + " – " + fmtDia(cFim);
  return { ini, fim, cIni, cFim, rotulo, rotComp };
}
function fmtDia(ymd) { return ymd.slice(5).split("-").reverse().join("/"); }

const CORES_HEX = { aristocrata: "#b9822d", fishermans: "#22808d", olivas: "#6f7f33", todas: "#55524c" };
const corHex = (m) => CORES_HEX[m] || CORES_HEX.todas;
const $ = (s) => document.querySelector(s);

// ---------- chave de acesso ----------
// A API exige ?k=<chave>. A chave fica só neste dispositivo (localStorage),
// nunca no código. Errou a chave → a API devolve 401 e o painel pede de novo.
function chave() { try { return localStorage.getItem("cx_chave") || ""; } catch (e) { return ""; } }
function pedeChave(erro) {
  if ($("#gate")) { $("#gate .gate-erro").textContent = erro || ""; return; }
  const div = document.createElement("div");
  div.id = "gate";
  div.innerHTML = `<form class="gate-card">
      <h2>Painel CX · Grupo Shrigma</h2>
      <p>Digite a chave de acesso do time.</p>
      <input type="password" autofocus autocomplete="current-password" aria-label="Chave de acesso">
      <button type="submit">Entrar</button>
      <p class="gate-erro">${erro || ""}</p>
    </form>`;
  document.body.appendChild(div);
  div.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    try { localStorage.setItem("cx_chave", div.querySelector("input").value.trim()); } catch (err) {}
    div.remove();
    carrega();
  });
}

// ---------- carga ----------
async function carrega() {
  if (!chave()) { pedeChave(); return; }
  try {
    const r = await fetch(CX_API_URL + "?k=" + encodeURIComponent(chave()), { cache: "no-store" });
    if (r.status === 401 || r.status === 403) {
      try { localStorage.removeItem("cx_chave"); } catch (e) {}
      pedeChave("Chave incorreta — tente de novo.");
      return;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    estado.dados = await r.json();
    pinta();
  } catch (e) {
    $("#area-kpis").innerHTML =
      `<div class="erro-carga">Sem dados agora (${e.message}). Nova tentativa em ${REFRESH_SEG}s — se persistir, confira o workflow “CX — Dashboard · API de leitura” no n8n.</div>`;
  }
}

function hojeRef() {
  const s = estado.dados.snapshot_1d;
  return s.length ? s[s.length - 1].dia : new Date().toISOString().slice(0, 10);
}

// ---------- pintura ----------
let PER = null; // período resolvido do render atual
function pinta() {
  const d = estado.dados;
  const hoje = hojeRef();
  PER = resolverPeriodo(hoje);
  const porMarca = {};
  const lenComp = diffDias(PER.cIni, PER.cFim) + 1;
  for (const m of MARCAS) {
    let anterior = estado.comparar ? agregaRange(d, m, PER.cIni, PER.cFim, hoje) : null;
    // honestidade: se o período de comparação não tem histórico suficiente no banco,
    // não comparamos — % contra dado parcial é mentira com casas decimais.
    if (anterior && lenComp > 1 && (anterior.dias || 0) < lenComp * 0.8) anterior = { __semHistorico: true };
    porMarca[m] = {
      atual: agregaRange(d, m, PER.ini, PER.fim, hoje),
      anterior,
      rotuloComp: estado.comparar ? PER.rotComp : "",
    };
  }
  const porMarcaCons = {};
  for (const m of MARCAS) porMarcaCons[m] = {
    atual: porMarca[m].atual,
    anterior: porMarca[m].anterior && porMarca[m].anterior.__semHistorico ? null : porMarca[m].anterior,
    rotuloComp: porMarca[m].rotuloComp,
  };
  const grupo = consolida(porMarcaCons);
  if (grupo && estado.comparar && !grupo.anterior) grupo.anterior = { __semHistorico: true };
  const escopo = estado.marca === "todas" ? grupo : porMarca[estado.marca];

  pintaFrescor(d);
  pintaAlertas(porMarca, d);
  pintaKpis(escopo, porMarca);
  pintaGrafico(d, hoje);
  pintaComparativo(porMarca, d);
  pintaRanking(d, hoje);
  pintaNps(d, hoje);
  pintaFrustracoes(d);
  pintaRa(d);
  pintaSocial(d);
  $("#rotulo-janela").textContent = PER.rotulo;
  $("#btn-periodo").innerHTML = PER.rotulo.charAt(0).toUpperCase() + PER.rotulo.slice(1) + ' <span class="caret">▾</span>';
  const chk = $("#chk-comparar"); if (chk) chk.checked = estado.comparar;
}

function pintaFrescor(d) {
  const ult = d.snapshot_1d.map((l) => l.coletado_em).sort().pop();
  if (!ult) return;
  const min = Math.round((Date.now() - new Date(ult).getTime()) / 60000);
  const el = $("#frescor");
  if (!dentroDoExpediente()) {
    el.textContent = "coleta retoma às 06h";
    el.classList.remove("velho");
    return;
  }
  el.textContent = "coleta há " + (min < 60 ? min + " min" : Math.round(min / 60) + " h");
  el.classList.toggle("velho", min > 25);
}

// alertas: sempre sobre AGORA/HOJE, independente do período selecionado na tela
function dentroDoExpediente() {
  const sp = new Date(Date.now() - 3 * 3600 * 1000);
  const h = sp.getUTCHours();
  return h >= 6 && h < 23; // janela do coletor (06–23h SP)
}
function pintaAlertas(_, d) {
  const avisos = [];
  const hoje = hojeRef();
  const ult = d.snapshot_1d.map((l) => l.coletado_em).sort().pop();
  if (ult && Date.now() - new Date(ult).getTime() > 25 * 60000 && dentroDoExpediente())
    avisos.push("Coleta atrasada — painel pode estar defasado.");
  for (const m of MARCAS) {
    const a = agregaRange(d, m, hoje, hoje, hoje);
    if (!a) continue;
    if (typeof a.primeira_resposta_seg === "number" && a.primeira_resposta_seg > 12 * 3600)
      avisos.push(`${ROTULOS[m]} com 1ª resposta em ${fmtDur(a.primeira_resposta_seg)} hoje.`);
    if (typeof a.csat === "number" && a.csat < 70 && (a.csat_votos || 0) >= 5)
      avisos.push(`CSAT de ${ROTULOS[m]} em ${Math.round(a.csat)} hoje.`);
  }
  $("#faixa-alertas").innerHTML = avisos.length
    ? `<div class="alerta">⚠ ${avisos.join("  ·  ")}</div>` : "";
}

function chipHtml(metrica, atual, anterior, fmt) {
  if (!estado.comparar) return "";
  const dl = delta(metrica, atual, anterior);
  if (!dl.texto) return "";
  const ant = typeof anterior === "number" ? " · ant. " + (fmt || fmtNum)(anterior) : "";
  return `<span class="chip ${dl.classe}">${dl.texto}${ant}</span>`;
}
// contagens acumuladas do dia comparam com ontem ATÉ A MESMA HORA (estilo Shopify);
// taxas e tempos (CSAT, 1ª resposta, deflexão, fila) comparam com o dia anterior inteiro.
const METRICAS_ACUMULADAS = ["novos", "fechados", "trabalhados", "respostas"];
function mesmaHoraAgora() {
  const sp = new Date(Date.now() - 3 * 3600 * 1000);
  return sp.getUTCHours() * 60 + sp.getUTCMinutes();
}
// devolve {valor, mesmaHora:boolean} para comparar uma métrica no modo "hoje"
function anteriorProgressivo(metrica, marca, antCheio) {
  const base = antCheio ? antCheio[metrica] : null;
  if (!(PER.ini === PER.fim && estado.comparar)) return { valor: base, mesmaHora: false };
  if (!METRICAS_ACUMULADAS.includes(metrica)) return { valor: base, mesmaHora: false };
  const v = valorMesmaHora(estado.dados.intradia, marca, PER.cIni, metrica, mesmaHoraAgora());
  return v === null ? { valor: null, mesmaHora: false, cheio: base } : { valor: v, mesmaHora: true, cheio: base };
}

function pintaKpis(p, porMarca) {
  const a = (p && p.atual) || {};
  const antBruto = (p && p.anterior) || {};
  const semHist = antBruto.__semHistorico === true;
  const ant = semHist ? {} : antBruto;
  const todas = estado.marca === "todas";
  const marcaRef = estado.marca;
  const umDia = PER.ini === PER.fim;
  const temCom = typeof a.primeira_resposta_comercial_seg === "number";
  const saldo = typeof a.novos === "number" && typeof a.fechados === "number" ? a.fechados - a.novos : null;

  // comparação progressiva (contagens): ontem até a mesma hora, quando a série existir
  const pn = anteriorProgressivo("novos", marcaRef, ant);
  const pf = anteriorProgressivo("fechados", marcaRef, ant);
  const saldoAntProg = typeof pn.valor === "number" && typeof pf.valor === "number" ? pf.valor - pn.valor : null;
  const saldoAntCheio = typeof ant.novos === "number" && typeof ant.fechados === "number" ? ant.fechados - ant.novos : null;
  const usaMesmaHora = pn.mesmaHora && pf.mesmaHora;

  const filaSub = todas
    ? MARCAS.map((m) => {
        const f = porMarca[m].atual && porMarca[m].atual.fila_aberta;
        return `${{aristocrata:"A",fishermans:"F",olivas:"O"}[m]} ${fmtNum(f)}`;
      }).join(" · ")
    : "abertos neste momento";
  let respSub = "mediana até a 1ª resposta";
  if (todas) {
    let pior = null;
    for (const m of MARCAS) {
      const v = porMarca[m].atual && porMarca[m].atual.primeira_resposta_seg;
      if (typeof v === "number" && (!pior || v > pior.v)) pior = { m, v };
    }
    if (pior) respSub = `pior: ${ROTULOS[pior.m]} · ${fmtDur(pior.v)}`;
  }

  const kpi = (rot, valHtml, sub, chip, ref) =>
    `<div class="kpi"><div class="kpi-rot">${rot}</div><div class="kpi-val">${valHtml}</div>
     <div class="kpi-rodape"><span class="kpi-sub">${sub}</span>${chip || ""}</div>
     ${ref ? `<div class="kpi-ref">${ref}</div>` : ""}</div>`;

  // linhas de referência "ontem fechou em..." (o total do período anterior sempre visível)
  const avisoHist = estado.comparar && semHist
    ? `<span class="mini">sem histórico completo do período de comparação</span>` : "";
  const rotAntDia = estado.compAuto ? (estado.preset === "hoje" ? "ontem" : "dia anterior") : fmtDia(PER.cIni);
  const refSaldo = estado.comparar && umDia && saldoAntCheio !== null
    ? `${rotAntDia} fechou em <b>${(saldoAntCheio > 0 ? "+" : "") + fmtNum(saldoAntCheio)}</b> (${fmtNum(ant.novos)} novos · ${fmtNum(ant.fechados)} resolvidos)` : "";
  const rotMH = usaMesmaHora ? " · até a mesma hora" : "";

  $("#area-kpis").innerHTML =
    kpi("Saldo · " + PER.rotulo,
        `<span class="${saldo === null ? "" : saldo >= 0 ? "vd" : "vm"}">${saldo === null ? "—" : (saldo > 0 ? "+" : "") + fmtNum(saldo)}</span>`,
        `entraram ${fmtNum(a.novos)} · resolvidos ${fmtNum(a.fechados)}${rotMH ? "" : ""}`,
        umDia ? chipHtml("fechados", a.fechados, pf.valor) : chipHtml("fechados", a.fechados, ant.fechados),
        refSaldo || avisoHist || (estado.comparar && !umDia && saldoAntCheio !== null
          ? `período anterior: <b>${(saldoAntCheio > 0 ? "+" : "") + fmtNum(saldoAntCheio)}</b>` : "")) +
    kpi(PER.fim >= hojeRef() ? "Fila agora" : "Fila no fim do período", fmtNum(a.fila_aberta), filaSub,
        chipHtml("fila_aberta", a.fila_aberta, ant.fila_aberta),
        estado.comparar && typeof ant.fila_aberta === "number" ? `${umDia ? rotAntDia : "antes"}: <b>${fmtNum(ant.fila_aberta)}</b>` : "") +
    kpi(temCom ? "1ª resposta · expediente" : "1ª resposta",
        fmtDur(temCom ? a.primeira_resposta_comercial_seg : a.primeira_resposta_seg),
        temCom ? `seg–sex 8h–18h · ${fmtNum(a.amostra_comercial)} tickets` : respSub,
        temCom
          ? chipHtml("primeira_resposta_comercial_seg", a.primeira_resposta_comercial_seg, ant.primeira_resposta_comercial_seg, fmtDur)
          : chipHtml("primeira_resposta_seg", a.primeira_resposta_seg, ant.primeira_resposta_seg, fmtDur),
        temCom && typeof a.primeira_resposta_seg === "number"
          ? `espera total do cliente: <b>${fmtDur(a.primeira_resposta_seg)}</b>${typeof a.resolucao_comercial_seg === "number" ? ` · resolução em expediente <b>${fmtDur(a.resolucao_comercial_seg)}</b>` : ""}`
          : (todas ? "" : respSub === "mediana até a 1ª resposta" ? "" : respSub)) +
    kpi("CSAT", typeof a.csat === "number" ? Math.round(a.csat) : "—",
        `cobertura ${typeof a.csat_cobertura === "number" ? Math.round(a.csat_cobertura) + "%" : "—"} · ${fmtNum(a.csat_votos)} votos${a.aprox ? " · ≈" : ""}`,
        chipHtml("csat", a.csat, ant.csat),
        "");
  $("#aviso-aprox").hidden = !(a && a.aprox);
  // rótulo global da comparação
  const compEl = $("#comp-rotulo");
  if (compEl && estado.comparar && umDia)
    compEl.dataset.mh = usaMesmaHora ? "1" : "0";
}
// sparkline dupla (novos × resolvidos), SVG puro
function sparkSvg(marca, cor, w, h) {
  const d = estado.dados;
  const hoje = hojeRef();
  const ini = diasAtras(13, hoje);
  let novos, fechados;
  if (marca === "todas") {
    const dias = [...new Set(d.snapshot_1d.filter((l) => l.dia >= ini).map((l) => l.dia))].sort();
    const somaDia = (dd, c) => d.snapshot_1d.filter((l) => l.dia === dd).reduce((acc, l) => acc + (l[c] || 0), 0);
    novos = dias.map((dd) => somaDia(dd, "novos"));
    fechados = dias.map((dd) => somaDia(dd, "fechados"));
  } else {
    const linhas = filtraDias(d.snapshot_1d, marca, ini, hoje);
    novos = linhas.map((l) => l.novos ?? 0);
    fechados = linhas.map((l) => l.fechados ?? 0);
  }
  if (novos.length < 2) return "";
  const max = Math.max(...novos, ...fechados, 1);
  const pts = (arr) => arr.map((v, i) =>
    `${(i / (arr.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts(novos)}" fill="none" stroke="${cor}" stroke-opacity=".3" stroke-width="1.6"/>
      <polyline points="${pts(fechados)}" fill="none" stroke="${cor}" stroke-width="1.6"/></svg>`;
}


// ---------- gráfico comparativo (estilo Shopify) ----------
estado.metrica = "fechados";
estado.comparar = true;

function linhaSvg(pts, xMax, yMax, W, H, cor, tracejada) {
  if (pts.length < 2) return "";
  const px = (p) => `${(p.x / xMax) * W},${H - 4 - (p.y / yMax) * (H - 10)}`;
  return `<polyline points="${pts.map(px).join(" ")}" fill="none" stroke="${cor}"
    stroke-width="2" ${tracejada ? 'stroke-dasharray="5 4" stroke-opacity=".55"' : ""} />`;
}


// ---------- tooltip do gráfico ----------
let GRAF = null; // estado da última pintura, para o hover
function fmtHoraMin(m) { return String(Math.floor(m / 60)).padStart(2, "0") + "h" + String(m % 60).padStart(2, "0"); }
function pontoProximo(serie, xAlvo) {
  if (!serie || !serie.length) return null;
  let melhor = serie[0];
  for (const p of serie) if (Math.abs(p.x - xAlvo) < Math.abs(melhor.x - xAlvo)) melhor = p;
  return melhor;
}
function ligaTooltip() {
  const area = $("#area-grafico");
  area.addEventListener("mousemove", (e) => {
    if (!GRAF) return;
    const svg = area.querySelector("svg.grafico");
    const tipEl = area.querySelector(".graf-tip");
    const guia = area.querySelector(".graf-guia");
    if (!svg || !tipEl) return;
    const r = svg.getBoundingClientRect();
    if (r.width < 10) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const xAlvo = frac * GRAF.xMax;
    const pa = pontoProximo(GRAF.atual, xAlvo);
    if (!pa) return;
    const pb = estado.comparar ? pontoProximo(GRAF.anterior, pa.x) : null; // ancora no MESMO horário do ponto atual
    const rotX = GRAF.umDia ? fmtHoraMin(pa.x) : fmtDia((GRAF.atual[pa.x] || pa).dia || "");
    tipEl.innerHTML = `<b>${rotX}</b><span>${GRAF.rotAtual}: <b>${fmtNum(pa.y)}</b></span>` +
      (pb ? `<span>${GRAF.rotAnterior}: <b>${fmtNum(pb.y)}</b>${GRAF.umDia && pb.x !== pa.x ? " (" + fmtHoraMin(pb.x) + ")" : ""}</span>` : "");
    const px = (pa.x / GRAF.xMax) * r.width;
    tipEl.hidden = false;
    tipEl.style.left = Math.min(px + 12, r.width - 150) + "px";
    tipEl.style.top = "8px";
    guia.hidden = false;
    guia.style.left = px + "px";
    guia.style.height = r.height + "px";
  });
  area.addEventListener("mouseleave", () => {
    const t = area.querySelector(".graf-tip"), g = area.querySelector(".graf-guia");
    if (t) t.hidden = true; if (g) g.hidden = true;
  });
}
function pintaGrafico(d, hoje) {
  const alvo = $("#area-grafico");
  const leg = $("#grafico-legenda");
  const cor = corHex(estado.marca);
  const met = estado.metrica;
  const W = 640, H = 170;
  const umDia = PER.ini === PER.fim;
  let atual = [], anterior = [], xMax, rotAtual = PER.rotulo, rotAnterior, eixoIni, eixoFim;

  if (umDia) {
    atual = serieIntradia(d.intradia, estado.marca, PER.ini, met);
    anterior = estado.comparar ? serieIntradia(d.intradia, estado.marca, PER.cIni, met) : [];
    xMax = 1440; rotAnterior = estado.compAuto ? "dia anterior" : fmtDia(PER.cIni);
    eixoIni = "00h"; eixoFim = "24h";
    if (atual.length < 2) {
      GRAF = null;
      alvo.innerHTML = `<p class="mini">A curva intradiária existe a partir das coletas de 10 em 10 min
        (histórico desde 14/08). Para dias sem pontos, use um intervalo de vários dias.</p>`;
      leg.innerHTML = ""; return;
    }
  } else {
    atual = serieDiaria(d.snapshot_1d, estado.marca, PER.ini, PER.fim, met)
      .map((p, i) => ({ x: i, y: p.y, dia: p.dia }));
    anterior = estado.comparar
      ? serieDiaria(d.snapshot_1d, estado.marca, PER.cIni, PER.cFim, met).map((p, i) => ({ x: i, y: p.y }))
      : [];
    xMax = Math.max(atual.length, anterior.length, 2) - 1;
    rotAnterior = estado.compAuto ? "período anterior" : fmtDia(PER.cIni) + "–" + fmtDia(PER.cFim);
    eixoIni = atual[0] ? fmtDia(atual[0].dia) : "";
    eixoFim = atual.length ? fmtDia(atual[atual.length - 1].dia) : "";
    if (atual.length < 2) { alvo.innerHTML = `<p class="mini">Sem série suficiente no período.</p>`; leg.innerHTML = ""; return; }
  }

  const yMax = Math.max(...atual.map((p) => p.y), ...anterior.map((p) => p.y), 1);
  const ultimo = atual[atual.length - 1];
  alvo.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="grafico">
      <line x1="0" y1="${H - 4}" x2="${W}" y2="${H - 4}" stroke="var(--borda)" />
      ${linhaSvg(anterior, xMax, yMax, W, H, "#9c968c", true)}
      ${linhaSvg(atual, xMax, yMax, W, H, cor, false)}
      <circle cx="${(ultimo.x / xMax) * W}" cy="${H - 4 - (ultimo.y / yMax) * (H - 10)}" r="3.5" fill="${cor}" />
    </svg>
    <div class="grafico-eixo"><span>${eixoIni}</span><span>${eixoFim}</span></div>
    <div class="graf-tip" hidden></div><div class="graf-guia" hidden></div>`;
  GRAF = { atual, anterior, xMax, umDia, rotAtual, rotAnterior };
  const antUlt = anterior.length ? anterior[anterior.length - 1] : null;
  leg.innerHTML = `<span><i class="leg-linha" style="background:${cor}"></i>${rotAtual} · <b>${fmtNum(ultimo.y)}</b></span>` +
    (estado.comparar && antUlt
      ? `<span><i class="leg-linha tracejada"></i>${rotAnterior} · <b>${fmtNum(antUlt.y)}</b></span>` : "") +
    `<span class="mini">pico ${fmtNum(yMax)}</span>`;
}
function pintaComparativo(porMarca, d) {
  const painel = $("#painel-comparativo");
  if (estado.marca !== "todas") { painel.hidden = true; return; }
  painel.hidden = false;
  const rotMH2 = PER.ini === PER.fim && estado.comparar && valorMesmaHora(d.intradia, "todas", PER.cIni, "fechados", mesmaHoraAgora()) !== null
    ? " · contagens até a mesma hora" : "";
  $("#comp-rotulo").textContent = ((estado.comparar && porMarca.aristocrata.rotuloComp) || "") + rotMH2 +
    (Object.values(porMarca).some((p) => p.atual && p.atual.aprox) ? " · ≈" : "");

  const seta = (metrica, atual, anterior) => {
    const dl = delta(metrica, atual, anterior);
    if (!dl.texto || dl.texto === "＝") return "";
    return `<span class="seta ${dl.classe}">${dl.texto.split(" ")[0]}</span>`;
  };
  $("#tabela-comparativo tbody").innerHTML = MARCAS.map((m) => {
    const a = porMarca[m].atual || {};
    const antB = porMarca[m].anterior || {};
    const ant = antB.__semHistorico ? {} : antB;
    const saldo = typeof a.novos === "number" && typeof a.fechados === "number" ? a.fechados - a.novos : null;
    return `<tr>
      <td><div class="pessoa"><span class="ponto" style="--cor:${corHex(m)}"></span>
        <span class="nome">${ROTULOS[m]}</span>
        ${a.incompleto ? '<span class="selo-incompleto">coleta incompleta</span>' : ""}</div></td>
      <td class="num ${saldo === null ? "" : saldo >= 0 ? "vd" : "vm"}">${saldo === null ? "—" : (saldo > 0 ? "+" : "") + fmtNum(saldo)}</td>
      <td class="num">${fmtNum(a.fila_aberta)} ${seta("fila_aberta", a.fila_aberta, ant.fila_aberta)}</td>
      <td class="num">${fmtNum(a.trabalhados)} ${seta("trabalhados", a.trabalhados, anteriorProgressivo("trabalhados", m, ant).valor)}</td>
      <td class="num">${fmtDur(a.primeira_resposta_comercial_seg)} ${seta("primeira_resposta_comercial_seg", a.primeira_resposta_comercial_seg, ant.primeira_resposta_comercial_seg)}</td>
      <td class="num">${fmtDur(a.primeira_resposta_seg)}</td>
      <td class="num">${typeof a.csat === "number" ? Math.round(a.csat) : "—"} ${seta("csat", a.csat, ant.csat)}</td>
      <td class="num">${fmtPct(a.kai_deflexao)} ${seta("kai_deflexao", a.kai_deflexao, ant.kai_deflexao)}</td>
      <td class="num">${fmtNum(a.respostas)}</td>
      <td class="cel-spark">${sparkSvg(m, corHex(m), 110, 26)}</td>
    </tr>`;
  }).join("");
}

function pintaRanking(d, hoje) {
  const linhas = rankingAgentesRange(d, estado.marca, PER.ini, PER.fim, hoje);
  const sel = $("#sel-agente");
  const atual = estado.agente;
  const nomes = [...new Map(linhas.map((a) => [a.agente_id, a.nome])).entries()];
  sel.innerHTML = `<option value="todos">Todos os agentes</option>` +
    nomes.map(([id, n]) => `<option value="${id}" ${id === atual ? "selected" : ""}>${n}</option>`).join("");

  const filtradas = atual === "todos" ? linhas : linhas.filter((a) => a.agente_id === atual);
  const maxTrab = Math.max(...linhas.map((a) => a.trabalhados || 0), 1);
  $("#ranking-rotulo").textContent = PER.rotulo + (linhas.some((a) => a.aprox) ? " · ≈" : "");

  $("#tabela-ranking tbody").innerHTML = filtradas.map((a) => `
    <tr class="${a.agente_id === atual ? "destaque" : ""}" style="--cor-tag:${corHex(a.marca)}">
      <td><div class="pessoa">
        <span class="avatar">${(a.nome || "?").trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase()}</span>
        <div><div class="nome">${a.nome || a.agente_id}</div>
        <div class="pessoa-marca">${ROTULOS[a.marca] || a.marca || ""}</div></div>
      </div></td>
      <td class="num">${fmtNum(a.trabalhados)}<span class="prog"><i style="width:${((a.trabalhados || 0) / maxTrab) * 100}%"></i></span></td>
      <td class="num">${fmtNum(a.fechados)}</td>
      <td class="num">${fmtNum(a.respostas)}</td>
      <td class="num">${typeof a.csat === "number" ? Math.round(a.csat) : "—"}</td>
      <td class="num">${fmtDur(a.primeira_resposta_seg)}</td>
      <td class="num">${fmtDur(a.resposta_mediana_seg)}</td>
      <td class="num">${fmtDur(a.fechamento_seg)}</td>
      <td class="num">${fmtDur(a.horas_ativas_seg)}</td>
    </tr>`).join("") ||
    `<tr><td colspan="9" class="vazio-tabela">Nenhuma atividade de agente no período.</td></tr>`;
}


// RA1000: critérios oficiais (blog do Reclame AQUI, confirmados 08/2026)
const RA1000 = [
  ["nota", "Nota média", 7, 10],
  ["resposta", "Respondidas", 90, 100],
  ["solucao", "Índice de solução", 90, 100],
  ["voltaria", "Voltaria a fazer negócio", 70, 100],
  ["avaliacoes", "Avaliações", 50, null],
];
function pintaRa(d) {
  const linhas = (d.manual || []).filter((m) => m.fonte === "reclame_aqui");
  const alvo = $("#area-ra");
  if (!linhas.length) {
    $("#ra-rotulo").textContent = "";
    alvo.innerHTML = `<p class="mini">Sem coleta ainda. Toda segunda: abrir a página da marca no
      Reclame AQUI e clicar no favorito “→ Painel CX” (bookmarklet).</p>`;
    return;
  }
  const porMarca = {};
  for (const l of linhas) {
    const m = l.marca;
    if (!porMarca[m] || l.semana_inicio > porMarca[m].semana_inicio) porMarca[m] = l;
  }
  const marcas = (estado.marca === "todas" ? MARCAS : [estado.marca]).filter((m) => porMarca[m]);
  if (!marcas.length) { alvo.innerHTML = `<p class="mini">Sem coleta para esta marca ainda.</p>`; return; }
  $("#ra-rotulo").textContent = "semana de " + porMarca[marcas[0]].semana_inicio.slice(0, 10).split("-").reverse().join("/");
  alvo.innerHTML = marcas.map((m) => {
    const ex = (porMarca[m].dados || {}).extraido;
    if (!ex) return `<div class="ra-marca"><div class="cab"><span class="ponto" style="--cor:${corHex(m)}"></span>
      <h3>${ROTULOS[m]}</h3></div><p class="mini">Dados brutos recebidos — extração em calibração.</p></div>`;
    const ok = RA1000.every(([c, , min]) => typeof ex[c] === "number" && ex[c] >= min);
    return `<div class="ra-marca">
      <div class="cab"><span class="ponto" style="--cor:${corHex(m)}"></span><h3>${ROTULOS[m]}</h3>
        <span class="chip ${ok ? "d-bom" : ""}">${ok ? "critérios RA1000 ✓" : "em construção"}</span></div>
      ${RA1000.map(([c, rot, min, max]) => {
        const v = ex[c];
        const tem = typeof v === "number";
        const bate = tem && v >= min;
        const pct = tem ? Math.min(100, (v / (max || Math.max(v, min * 1.4))) * 100) : 0;
        return `<div class="ra-linha">
          <span class="ra-rot">${rot}</span>
          <span class="ra-barra"><i class="${bate ? "ok" : ""}" style="width:${pct}%"></i><em style="left:${max ? (min / max) * 100 : 70}%"></em></span>
          <span class="ra-val ${bate ? "vd" : "vm"}">${tem ? (max === 100 ? v.toFixed(1).replace(".", ",") + "%" : (c === "nota" ? v.toFixed(1).replace(".", ",") : fmtNum(v))) : "—"}</span>
          <span class="ra-meta">meta ${max === 100 ? min + "%" : min}</span>
        </div>`;
      }).join("")}
    </div>`;
  }).join("");
}

// Comentários orgânicos via Meta Graph (volume, respondidos, ocultos, sentimento próprio).
// Independe da Replient: quando a API deles sair, entra como fonte adicional.
function pintaSocial(d) {
  const alvo = $("#area-social");
  const linhas = (d.social || []).filter((l) => l.dia >= PER.ini && l.dia <= PER.fim);
  const marcas = estado.marca === "todas" ? MARCAS : [estado.marca];
  $("#social-rotulo").textContent = PER.rotulo + " · coleta automática a cada 15 min · orgânico + anúncios";

  const agg = {};
  for (const l of linhas) {
    if (!marcas.includes(l.marca)) continue;
    const a = (agg[l.marca] = agg[l.marca] || { total: 0, respondidos: 0, ocultos: 0, apagados: 0, pos: 0, neg: 0, neu: 0, sem: 0, aguardando: 0 });
    for (const k of ["total", "respondidos", "ocultos", "aguardando", "apagados"]) a[k] += Number(l[k] || 0);
    a.pos += Number(l.pos || 0); a.neg += Number(l.neg || 0);
    a.neu += Number(l.neu || 0); a.sem += Number(l.sem_classificacao || 0);
  }
  const comDados = marcas.filter((m) => agg[m] && agg[m].total);
  if (!comDados.length) {
    alvo.innerHTML = `<p class="mini">Nenhum comentário no período selecionado.</p>`;
    $("#area-social-urgentes").innerHTML = ""; return;
  }
  alvo.innerHTML = comDados.map((m) => {
    const a = agg[m];
    const taxa = a.total ? (a.respondidos / a.total) * 100 : null;
    const clas = a.pos + a.neg + a.neu;
    const pc = (x) => (clas ? (x / clas) * 100 : 0);
    return `<div class="soc-marca">
      <div class="cab"><span class="ponto" style="--cor:${corHex(m)}"></span><h3>${ROTULOS[m]}</h3>
        ${a.aguardando ? `<span class="chip d-ruim">${a.aguardando} aguardando resposta</span>` : ""}</div>
      <div class="soc-grade">
        <div class="metrica"><span class="rot">Comentários</span><span class="val">${fmtNum(a.total)}</span></div>
        <div class="metrica"><span class="rot">Respondidos pela marca</span><span class="val">${fmtNum(a.respondidos)}<small> ${taxa !== null ? Math.round(taxa) + "%" : ""}</small></span></div>
        <div class="metrica"><span class="rot">Ocultados / apagados</span><span class="val">${fmtNum(a.ocultos)}<small> / ${fmtNum(a.apagados)}</small></span></div>
        <div class="metrica"><span class="rot">Sentimento</span><span class="val">${clas ? `<span class="vd">${Math.round(pc(a.pos))}%</span><small> pos · </small><span class="vm">${Math.round(pc(a.neg))}%</span><small> neg</small>` : "—"}</span></div>
      </div>
      ${clas ? `<div class="soc-barra">
        <i class="p" style="width:${pc(a.pos)}%"></i><i class="pa" style="width:${pc(a.neu)}%"></i><i class="d" style="width:${pc(a.neg)}%"></i>
      </div>` : ""}
      ${a.sem ? `<div class="mini soc-nota">${a.sem} ainda na fila de classificação</div>` : ""}
    </div>`;
  }).join("");

  // tempo mediano de resposta aos comentários (no período)
  const tempos = (d.social_tempo || []).filter((t) => t.dia >= PER.ini && t.dia <= PER.fim && marcas.includes(t.marca));
  if (tempos.length) {
    const num = tempos.reduce((s, t) => s + Number(t.mediana_seg || 0) * Number(t.respondidos || 0), 0);
    const den = tempos.reduce((s, t) => s + Number(t.respondidos || 0), 0);
    if (den) alvo.insertAdjacentHTML("beforeend",
      `<div class="soc-tempo">Tempo mediano até a marca responder: <b>${fmtDur(num / den)}</b>
       <span class="mini">(${fmtNum(den)} comentários respondidos)</span></div>`);
  }

  // duas filas distintas: problema (atenção) e dinheiro (oportunidade)
  const fila = (titulo, itens, classe, sub) => itens.length
    ? `<div class="soc-urg"><div class="soc-urg-cab ${classe}">${titulo} <span class="mini">${sub}</span></div>
        ${itens.slice(0, 5).map((u) => `<div class="soc-urg-item">
          <span class="ponto" style="--cor:${corHex(u.marca)}"></span>
          <div><div class="soc-urg-txt">${(u.texto || "").replace(/</g, "&lt;")}</div>
          <div class="mini">@${u.autor || "?"} · ${u.rede} · ${u.categoria || "—"}${u.sentimento === "negativo" ? ' · <span class="vm">negativo</span>' : ""}</div></div>
        </div>`).join("")}</div>`
    : "";
  const at = (d.social_atencao || []).filter((u) => marcas.includes(u.marca));
  const op = (d.social_oportunidade || []).filter((u) => marcas.includes(u.marca));
  $("#area-social-urgentes").innerHTML =
    fila("⚠ Precisam de atenção", at, "urg-ruim", "negativos ou reclamações sem resposta da marca · 14 dias") +
    fila("💰 Oportunidades sem resposta", op, "urg-bom", "intenção de compra, preço ou dúvida de produto · 7 dias") +
    (!at.length && !op.length ? `<div class="soc-urg-ok mini">Nada pendente: sem reclamação e sem oportunidade esperando resposta. ✓</div>`
      : (!at.length ? `<div class="soc-urg-ok mini">Nenhuma reclamação sem resposta. ✓</div>` : ""));
}

function pintaNps(d, hoje) {
  $("#nps-rotulo").textContent = PER.rotulo + " · votos no Listmonk";
  const marcas = estado.marca === "todas" ? ["todas", ...MARCAS] : [estado.marca];
  $("#area-nps").innerHTML = marcas.map((mca) => {
    const n = calculaNps(d.nps, mca, PER.ini, PER.fim);
    const nAnt = calculaNps(d.nps, mca, PER.cIni, PER.cFim);
    const rot = mca === "todas" ? "Grupo" : ROTULOS[mca];
    if (!n.n) return `<div class="nps-cartao">
      <div class="cab"><span class="ponto" style="--cor:${corHex(mca)}"></span><h3>${rot}</h3><span class="nps-score">—</span></div>
      <p class="mini">Sem votos no período.</p></div>`;
    const pc = (x) => (x / n.n) * 100;
    return `<div class="nps-cartao">
      <div class="cab"><span class="ponto" style="--cor:${corHex(mca)}"></span><h3>${rot}</h3>
        ${n.n < 5 ? '<span class="chip">amostra pequena</span>' : (nAnt.n >= 5 ? chipHtml("csat", n.media, nAnt.media, (v) => v.toFixed(1).replace(".", ",")) : "")}
        <span class="nps-score">${typeof n.media === "number" ? n.media.toFixed(1).replace(".", ",") : "—"}<small>/10</small></span></div>
      <div class="nps-dist">
        <i class="p" style="width:${pc(n.prom)}%"></i>
        <i class="pa" style="width:${pc(n.pass)}%"></i>
        <i class="d" style="width:${pc(n.detr)}%"></i>
      </div>
      <div class="nps-leg"><span>NPS <b>${n.nps}</b></span><span>${n.prom} prom.</span><span>${n.pass} pass.</span><span>${n.detr} detr.</span><span>${n.n} votos</span></div>
    </div>`;
  }).join("");
}


// Principais frustrações do NPS: área da taxonomia da empresa + tema específico.
// Fonte: area escolhida pelo cliente (31% preenchem) + classificação do texto livre.
function pintaFrustracoes(d) {
  const alvo = $("#area-frustracoes");
  const marcasAlvo = estado.marca === "todas" ? ["aristo", "fish", "olivas"]
    : { aristocrata: "aristo", fishermans: "fish", olivas: "olivas" }[estado.marca];
  const lista = (d.nps_frustracoes || []).filter((f) => {
    const okMarca = Array.isArray(marcasAlvo) ? marcasAlvo.includes(f.marca) : f.marca === marcasAlvo;
    return okMarca && f.dia >= PER.ini && f.dia <= PER.fim;
  });
  if (!lista.length) { alvo.innerHTML = ""; return; }
  const porTema = {};
  for (const f of lista) {
    const k = (f.area || "?") + "|" + (f.tema || "?");
    porTema[k] = (porTema[k] || 0) + Number(f.n || 0);
  }
  const top = Object.entries(porTema).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = top[0][1];
  const total = Object.values(porTema).reduce((s, x) => s + x, 0);
  alvo.innerHTML = `<div class="frust">
    <div class="frust-cab">O que desagradou <span class="mini">${fmtNum(total)} menções de detratores e passivos</span></div>
    ${top.map(([k, n]) => {
      const [area, tema] = k.split("|");
      return `<div class="frust-linha">
        <span class="frust-tema">${tema}<span class="frust-area">${area}</span></span>
        <span class="frust-barra"><i style="width:${(n / max) * 100}%"></i></span>
        <span class="frust-n">${fmtNum(n)}</span></div>`;
    }).join("")}</div>`;
}

// ---------- interação ----------
function ligaFiltros() {
  $("#seg-marca").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    estado.marca = b.dataset.marca; estado.agente = "todos";
    [...$("#seg-marca").children].forEach((x) => x.classList.toggle("ativo", x === b));
    pinta();
  });
  // seletor de período
  const pop = $("#pop-periodo");
  $("#btn-periodo").addEventListener("click", () => { pop.hidden = !pop.hidden; });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !e.target.closest(".periodo-wrap")) pop.hidden = true;
  });
  $("#lista-presets").addEventListener("click", (e) => {
    const li = e.target.closest("li"); if (!li) return;
    [...$("#lista-presets").children].forEach((x) => x.classList.toggle("ativo", x === li));
    if (li.dataset.p !== "custom") {
      estado.preset = li.dataset.p;
      pop.hidden = true; pinta();
      // reflete o intervalo resolvido nos calendários
      $("#dt-ini").value = PER.ini; $("#dt-fim").value = PER.fim;
    }
  });
  for (const id of ["dt-ini", "dt-fim"]) $("#" + id).addEventListener("change", () => {
    estado.preset = "custom";
    [...$("#lista-presets").children].forEach((x) => x.classList.toggle("ativo", x.dataset.p === "custom"));
  });
  $("#chk-comparar-pop").addEventListener("change", (e) => { estado.comparar = e.target.checked; });
  for (const r of document.querySelectorAll('input[name="modo-comp"]')) r.addEventListener("change", (e) => {
    estado.compAuto = e.target.value === "auto";
    $("#dt-cini").disabled = $("#dt-cfim").disabled = estado.compAuto;
  });
  $("#btn-aplicar").addEventListener("click", () => {
    if (estado.preset === "custom") { estado.ini = $("#dt-ini").value || estado.ini; estado.fim = $("#dt-fim").value || estado.fim; }
    estado.comparar = $("#chk-comparar-pop").checked;
    if (!estado.compAuto) { estado.cIni = $("#dt-cini").value || null; estado.cFim = $("#dt-cfim").value || null; }
    pop.hidden = true; pinta();
  });
  $("#sel-metrica").addEventListener("change", (e) => { estado.metrica = e.target.value; pinta(); });
  $("#chk-comparar").addEventListener("change", (e) => { estado.comparar = e.target.checked; $("#chk-comparar-pop").checked = e.target.checked; pinta(); });
  $("#sel-agente").addEventListener("change", (e) => { estado.agente = e.target.value; pinta(); });
  for (const b of $("#seg-marca").children) b.classList.toggle("ativo", b.dataset.marca === estado.marca);
  for (const li of $("#lista-presets").children) li.classList.toggle("ativo", li.dataset.p === estado.preset);
}

function relogio() {
  const f = () => ($("#relogio").textContent =
    new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }));
  f(); setInterval(f, 15000);
}

ligaFiltros();
ligaTooltip();
relogio();
carrega();
if (typeof module === "undefined" || !module.exports) setInterval(carrega, REFRESH_SEG * 1000);
