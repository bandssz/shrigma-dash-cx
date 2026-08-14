// ================== RENDER ==================
// Este arquivo só pinta a tela. Toda a matemática vive em dados.js.
// Estado da página = 3 filtros. URL params permitem abrir o monitor já filtrado:
//   index.html?marca=aristocrata&janela=7d

const estado = {
  marca: new URLSearchParams(location.search).get("marca") || "todas",
  janela: new URLSearchParams(location.search).get("janela") || "dia",
  agente: "todos",
  dados: null,
};

const CORES_HEX = { aristocrata: "#b9822d", fishermans: "#22808d", olivas: "#6f7f33", todas: "#55524c" };
function corHex(m) { return CORES_HEX[m] || CORES_HEX.todas; }
const CORES = { aristocrata: "var(--aristocrata)", fishermans: "var(--fishermans)", olivas: "var(--olivas)", todas: "var(--todas)" };
const $ = (s) => document.querySelector(s);

// ---------- carga ----------
async function carrega() {
  try {
    const r = await fetch(CX_API_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    estado.dados = await r.json();
    pinta();
  } catch (e) {
    $("#area-marcas").innerHTML =
      `<div class="erro-carga">Sem dados agora (${e.message}). A página tenta de novo em ${REFRESH_SEG}s — se persistir, confira o workflow “CX — Dashboard · API de leitura” no n8n.</div>`;
  }
}

// "hoje" = dia (São Paulo) da linha 1d mais recente — não o relógio do navegador
function hojeRef() {
  const s = estado.dados.snapshot_1d;
  return s.length ? s[s.length - 1].dia : new Date().toISOString().slice(0, 10);
}

// ---------- pintura ----------
function pinta() {
  const d = estado.dados;
  const hoje = hojeRef();
  pintaFrescor(d);
  pintaMarcas(d, hoje);
  pintaRanking(d, hoje);
  pintaNps(d, hoje);
  $("#rotulo-janela").textContent = { dia: "hoje", "7d": "últimos 7 dias", "30d": "últimos 30 dias" }[estado.janela];
}

function pintaFrescor(d) {
  const ult = d.snapshot_1d.map((l) => l.coletado_em).sort().pop();
  if (!ult) return;
  const min = Math.round((Date.now() - new Date(ult).getTime()) / 60000);
  const el = $("#frescor");
  el.textContent = "coleta há " + (min < 60 ? min + " min" : Math.round(min / 60) + " h");
  // coleta roda a cada 30 min: acima de 75 min algo está errado
  el.classList.toggle("velho", min > 75);
}


// sparkline dupla (novos vs fechados) dos últimos 14 dias — SVG puro
function sparkline(d, marca, cor) {
  const hoje = hojeRef();
  const ini = diasAtras(13, hoje);
  const linhas = marca === "todas"
    ? null : filtraDias(d.snapshot_1d, marca, ini, hoje);
  let novos, fechados;
  if (marca === "todas") {
    const dias = [...new Set(d.snapshot_1d.filter(l => l.dia >= ini).map(l => l.dia))].sort();
    novos = dias.map(dd => d.snapshot_1d.filter(l => l.dia === dd).reduce((a,l) => a + (l.novos||0), 0));
    fechados = dias.map(dd => d.snapshot_1d.filter(l => l.dia === dd).reduce((a,l) => a + (l.fechados||0), 0));
  } else {
    novos = linhas.map(l => l.novos ?? 0);
    fechados = linhas.map(l => l.fechados ?? 0);
  }
  if (novos.length < 2) return "";
  const max = Math.max(...novos, ...fechados, 1);
  const W = 100, H = 30, pad = 2;
  const pts = (arr) => arr.map((v, i) =>
    `${(i / (arr.length - 1)) * W},${H - pad - (v / max) * (H - 2 * pad)}`).join(" ");
  return `<div class="spark"><div class="rot">novos × resolvidos · 14 dias</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts(novos)}" fill="none" stroke="${cor}" stroke-opacity=".3" stroke-width="1.6"/>
      <polyline points="${pts(fechados)}" fill="none" stroke="${cor}" stroke-width="1.6"/>
    </svg></div>`;
}

function cartaoMarca(nome, rotulo, p, cor) {
  const a = p.atual || {};
  const saldo = typeof a.novos === "number" && typeof a.fechados === "number" ? a.fechados - a.novos : null;
  const max = Math.max(a.novos || 0, a.fechados || 0, 1);
  const m = (metrica, rot, valorFmt, unidade) => {
    const dl = delta(metrica, a[metrica], (p.anterior || {})[metrica]);
    return `<div class="metrica"><span class="rot">${rot}</span>
      <span class="val">${valorFmt}${unidade ? `<small> ${unidade}</small>` : ""}</span>
      <span class="chip ${dl.classe}">${dl.texto || "&nbsp;"}</span></div>`;
  };
  return `<article class="cartao" style="--cor:${cor}">
    <div class="cartao-cab"><span class="ponto"></span><h2>${rotulo}</h2>
      ${a.incompleto ? '<span class="selo-incompleto">coleta incompleta</span>' : ""}
      <span class="comp">${p.rotuloComp}${a.aprox ? " · ≈" : ""}</span></div>
    <div class="balanca">
      <div class="topo-b">
        <span class="saldo ${saldo === null ? "" : saldo >= 0 ? "pos" : "neg"}">${saldo === null ? "—" : (saldo > 0 ? "+" : "") + fmtNum(saldo)}</span>
        <span class="saldo-rot">${saldo === null ? "sem dados" : saldo >= 0 ? "fila vazando" : "fila enchendo"}</span>
      </div>
      <div class="barras">
        <div class="lado entra"><i style="width:${((a.novos || 0) / max) * 100}%"></i></div>
        <div class="lado sai"><i style="width:${((a.fechados || 0) / max) * 100}%"></i></div>
      </div>
      <div class="legenda"><span>entraram <b>${fmtNum(a.novos)}</b></span><span><b>${fmtNum(a.fechados)}</b> resolvidos</span></div>
    </div>
    <div class="metricas">
      ${m("fila_aberta", "Fila agora", fmtNum(a.fila_aberta))}
      ${m("primeira_resposta_seg", "1ª resposta", fmtDur(a.primeira_resposta_seg))}
      ${m("csat", "CSAT", typeof a.csat === "number" ? Math.round(a.csat) : "—",
          typeof a.csat_cobertura === "number" ? Math.round(a.csat_cobertura) + "% cob." : "")}
      ${m("kai_deflexao", "Kai segura", fmtPct(a.kai_deflexao))}
      ${m("trabalhados", "Trabalhados", fmtNum(a.trabalhados))}
      ${m("respostas", "Respostas", fmtNum(a.respostas))}
      ${m("fechados", "Fechados", fmtNum(a.fechados))}
      ${m("novos", "Novos", fmtNum(a.novos))}
    </div>
    ${sparkline(estado.dados, nome, corHex(nome))}
  </article>`;
}

function pintaMarcas(d, hoje) {
  const alvo = $("#area-marcas");
  const porMarca = {};
  for (const mca of MARCAS) porMarca[mca] = periodoMarca(d, mca, estado.janela, hoje);

  let html = "";
  let temAprox = false;
  if (estado.marca === "todas") {
    const c = consolida(porMarca);
    if (c && c.atual) { html += cartaoMarca("todas", "Consolidada — 3 marcas", c, CORES.todas); temAprox ||= c.atual.aprox; }
    for (const mca of MARCAS) {
      const p = porMarca[mca];
      if (p.atual) { html += cartaoMarca(mca, ROTULOS[mca], p, CORES[mca]); temAprox ||= p.atual.aprox; }
    }
  } else {
    const p = porMarca[estado.marca];
    html = p.atual
      ? cartaoMarca(estado.marca, ROTULOS[estado.marca], p, CORES[estado.marca])
      : `<div class="erro-carga">Sem snapshot para ${ROTULOS[estado.marca]} neste período.</div>`;
    temAprox = p.atual && p.atual.aprox;
  }
  alvo.innerHTML = html;
  $("#aviso-aprox").hidden = !temAprox;
}

function pintaRanking(d, hoje) {
  const linhas = rankingAgentes(d, estado.marca, estado.janela, hoje);

  // popular o filtro de agente (mantendo a seleção)
  const sel = $("#sel-agente");
  const atual = estado.agente;
  const nomes = [...new Map(linhas.map((a) => [a.agente_id, a.nome])).entries()];
  sel.innerHTML = `<option value="todos">Todos os agentes</option>` +
    nomes.map(([id, n]) => `<option value="${id}" ${id === atual ? "selected" : ""}>${n}</option>`).join("");

  const filtradas = atual === "todos" ? linhas : linhas.filter((a) => a.agente_id === atual);
  const maxTrab = Math.max(...linhas.map((a) => a.trabalhados || 0), 1);
  $("#ranking-rotulo").textContent =
    (estado.janela === "dia" ? "hoje" : estado.janela === "7d" ? "últimos 7 dias" : "últimos 30 dias") +
    (linhas.some((a) => a.aprox) ? " · CSAT e tempos ≈" : "");

  $("#tabela-ranking tbody").innerHTML = filtradas.map((a) => `
    <tr class="${a.agente_id === atual ? "destaque" : ""}" style="--cor-tag:${CORES[a.marca] || "var(--mudo)"}">
      <td><div class="pessoa"><span class="avatar">${(a.nome || "?").split(" ").map(x=>x[0]).slice(0,2).join("").toUpperCase()}</span><span class="nome">${a.nome || a.agente_id}</span></div></td>
      <td><span class="marca-tag">${(ROTULOS[a.marca] || a.marca || "").split(" ").pop()}</span></td>
      <td class="num">${fmtNum(a.trabalhados)}<span class="prog"><i style="width:${((a.trabalhados || 0) / maxTrab) * 100}%"></i></span></td>
      <td class="num">${fmtNum(a.respostas)}</td>
      <td class="num">${fmtNum(a.fechados)}</td>
      <td class="num">${typeof a.csat === "number" ? Math.round(a.csat) : "—"}</td>
      <td class="num">${fmtDur(a.resposta_mediana_seg)}</td>
    </tr>`).join("") ||
    `<tr><td colspan="7" style="color:var(--mudo)">Nenhuma atividade de agente no período.</td></tr>`;
}

function pintaNps(d, hoje) {
  const alvo = $("#area-nps");
  const marcas = estado.marca === "todas" ? ["todas", ...MARCAS] : [estado.marca];
  alvo.innerHTML = marcas.map((mca) => {
    const n = calculaNps(d.nps, mca, 30, hoje);
    const rot = mca === "todas" ? "Grupo" : ROTULOS[mca];
    if (!n.n) return `<div class="nps-cartao" style="--cor:${CORES[mca]}">
      <div class="cab"><h3>${rot}</h3><span class="nps-score">—</span></div>
      <p class="mini">Sem votos no período — normal para marca recém-lançada.</p></div>`;
    const pc = (x) => (x / n.n) * 100;
    return `<div class="nps-cartao" style="--cor:${CORES[mca]}">
      <div class="cab"><h3>${rot}</h3><span class="nps-score">${n.nps}</span></div>
      <div class="nps-dist">
        <i class="p" style="width:${pc(n.prom)}%"></i>
        <i class="pa" style="width:${pc(n.pass)}%"></i>
        <i class="d" style="width:${pc(n.detr)}%"></i>
      </div>
      <div class="nps-leg"><span>${n.prom} promotores</span><span>${n.pass} passivos</span><span>${n.detr} detratores</span><span>${n.n} votos</span></div>
    </div>`;
  }).join("");
}

// ---------- interação ----------
function ligaFiltros() {
  $("#seg-marca").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    estado.marca = b.dataset.marca; estado.agente = "todos";
    [...$("#seg-marca").children].forEach((x) => x.classList.toggle("ativo", x === b));
    pinta();
  });
  $("#seg-janela").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    estado.janela = b.dataset.janela;
    [...$("#seg-janela").children].forEach((x) => x.classList.toggle("ativo", x === b));
    pinta();
  });
  $("#sel-agente").addEventListener("change", (e) => { estado.agente = e.target.value; pinta(); });

  // refletir params da URL nos botões (modo monitor)
  for (const b of $("#seg-marca").children) b.classList.toggle("ativo", b.dataset.marca === estado.marca);
  for (const b of $("#seg-janela").children) b.classList.toggle("ativo", b.dataset.janela === estado.janela);
}

function relogio() {
  const f = () => ($("#relogio").textContent =
    new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }));
  f(); setInterval(f, 15000);
}

ligaFiltros();
relogio();
carrega();
if (typeof module === "undefined" || !module.exports) setInterval(carrega, REFRESH_SEG * 1000);
