// ================== RENDER ==================
// Hierarquia de decisão: alertas → 4 KPIs grandes → marcas lado a lado → pessoas/NPS.
// Toda a matemática vive em dados.js. URL params: ?marca=aristocrata&janela=7d

const estado = {
  marca: new URLSearchParams(location.search).get("marca") || "todas",
  janela: new URLSearchParams(location.search).get("janela") || "dia",
  agente: "todos",
  dados: null,
};

const CORES_HEX = { aristocrata: "#b9822d", fishermans: "#22808d", olivas: "#6f7f33", todas: "#55524c" };
const corHex = (m) => CORES_HEX[m] || CORES_HEX.todas;
const $ = (s) => document.querySelector(s);
const NPS_DIAS = { dia: 1, "7d": 7, "30d": 30 };
const JAN_ROT = { dia: "hoje", "7d": "últimos 7 dias", "30d": "últimos 30 dias" };

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
function pinta() {
  const d = estado.dados;
  const hoje = hojeRef();
  const porMarca = {};
  for (const m of MARCAS) porMarca[m] = periodoMarca(d, m, estado.janela, hoje);
  const grupo = consolida(porMarca);
  const escopo = estado.marca === "todas" ? grupo : porMarca[estado.marca];

  pintaFrescor(d);
  pintaAlertas(porMarca, d);
  pintaKpis(escopo, porMarca);
  pintaComparativo(porMarca, d);
  pintaRanking(d, hoje);
  pintaNps(d, hoje);
  $("#rotulo-janela").textContent = JAN_ROT[estado.janela];
}

function pintaFrescor(d) {
  const ult = d.snapshot_1d.map((l) => l.coletado_em).sort().pop();
  if (!ult) return;
  const min = Math.round((Date.now() - new Date(ult).getTime()) / 60000);
  const el = $("#frescor");
  el.textContent = "coleta há " + (min < 60 ? min + " min" : Math.round(min / 60) + " h");
  el.classList.toggle("velho", min > 75);
}

// alertas: só o que exige ação — nada de ruído
function pintaAlertas(porMarca, d) {
  const avisos = [];
  const ult = d.snapshot_1d.map((l) => l.coletado_em).sort().pop();
  if (ult && Date.now() - new Date(ult).getTime() > 75 * 60000)
    avisos.push("Coleta atrasada — painel pode estar defasado.");
  for (const m of MARCAS) {
    const a = porMarca[m].atual;
    if (!a) continue;
    if (typeof a.primeira_resposta_seg === "number" && a.primeira_resposta_seg > 12 * 3600)
      avisos.push(`${ROTULOS[m]} com 1ª resposta em ${fmtDur(a.primeira_resposta_seg)}.`);
    if (typeof a.csat === "number" && a.csat < 70 && (a.csat_votos || 0) >= 5)
      avisos.push(`CSAT de ${ROTULOS[m]} em ${Math.round(a.csat)}.`);
  }
  $("#faixa-alertas").innerHTML = avisos.length
    ? `<div class="alerta">⚠ ${avisos.join("  ·  ")}</div>` : "";
}

function chipHtml(metrica, atual, anterior) {
  const dl = delta(metrica, atual, anterior);
  return dl.texto ? `<span class="chip ${dl.classe}">${dl.texto}</span>` : "";
}

function pintaKpis(p, porMarca) {
  const a = (p && p.atual) || {};
  const ant = (p && p.anterior) || {};
  const todas = estado.marca === "todas";
  const saldo = typeof a.novos === "number" && typeof a.fechados === "number" ? a.fechados - a.novos : null;
  const saldoAnt = typeof ant.novos === "number" && typeof ant.fechados === "number" ? ant.fechados - ant.novos : null;

  // detalhes contextuais
  const filaSub = todas
    ? MARCAS.map((m) => {
        const f = porMarca[m].atual && porMarca[m].atual.fila_aberta;
        return `${ROTULOS[m].split(" ").pop()[0]} ${fmtNum(f)}`;
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

  const kpi = (rot, valHtml, sub, chip) =>
    `<div class="kpi"><div class="kpi-rot">${rot}</div><div class="kpi-val">${valHtml}</div>
     <div class="kpi-rodape"><span class="kpi-sub">${sub}</span>${chip || ""}</div></div>`;

  $("#area-kpis").innerHTML =
    kpi("Saldo · " + JAN_ROT[estado.janela],
        `<span class="${saldo === null ? "" : saldo >= 0 ? "vd" : "vm"}">${saldo === null ? "—" : (saldo > 0 ? "+" : "") + fmtNum(saldo)}</span>`,
        `entraram ${fmtNum(a.novos)} · resolvidos ${fmtNum(a.fechados)}`,
        chipHtml("fechados", a.fechados, ant.fechados)) +
    kpi("Fila agora", fmtNum(a.fila_aberta), filaSub,
        chipHtml("fila_aberta", a.fila_aberta, ant.fila_aberta)) +
    kpi("1ª resposta", fmtDur(a.primeira_resposta_seg), respSub,
        chipHtml("primeira_resposta_seg", a.primeira_resposta_seg, ant.primeira_resposta_seg)) +
    kpi("CSAT", typeof a.csat === "number" ? Math.round(a.csat) : "—",
        `cobertura ${typeof a.csat_cobertura === "number" ? Math.round(a.csat_cobertura) + "%" : "—"} · ${fmtNum(a.csat_votos)} votos${a.aprox ? " · ≈" : ""}`,
        chipHtml("csat", a.csat, ant.csat));
  $("#aviso-aprox").hidden = !(a && a.aprox);
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

function pintaComparativo(porMarca, d) {
  const painel = $("#painel-comparativo");
  if (estado.marca !== "todas") { painel.hidden = true; return; }
  painel.hidden = false;
  $("#comp-rotulo").textContent = (porMarca.aristocrata.rotuloComp || "") +
    (Object.values(porMarca).some((p) => p.atual && p.atual.aprox) ? " · ≈" : "");

  const seta = (metrica, atual, anterior) => {
    const dl = delta(metrica, atual, anterior);
    if (!dl.texto || dl.texto === "＝") return "";
    return `<span class="seta ${dl.classe}">${dl.texto.split(" ")[0]}</span>`;
  };
  $("#tabela-comparativo tbody").innerHTML = MARCAS.map((m) => {
    const a = porMarca[m].atual || {};
    const ant = porMarca[m].anterior || {};
    const saldo = typeof a.novos === "number" && typeof a.fechados === "number" ? a.fechados - a.novos : null;
    return `<tr>
      <td><div class="pessoa"><span class="ponto" style="--cor:${corHex(m)}"></span>
        <span class="nome">${ROTULOS[m]}</span>
        ${a.incompleto ? '<span class="selo-incompleto">coleta incompleta</span>' : ""}</div></td>
      <td class="num ${saldo === null ? "" : saldo >= 0 ? "vd" : "vm"}">${saldo === null ? "—" : (saldo > 0 ? "+" : "") + fmtNum(saldo)}</td>
      <td class="num">${fmtNum(a.fila_aberta)} ${seta("fila_aberta", a.fila_aberta, ant.fila_aberta)}</td>
      <td class="num">${fmtNum(a.trabalhados)} ${seta("trabalhados", a.trabalhados, ant.trabalhados)}</td>
      <td class="num">${fmtDur(a.primeira_resposta_seg)} ${seta("primeira_resposta_seg", a.primeira_resposta_seg, ant.primeira_resposta_seg)}</td>
      <td class="num">${typeof a.csat === "number" ? Math.round(a.csat) : "—"} ${seta("csat", a.csat, ant.csat)}</td>
      <td class="num">${fmtPct(a.kai_deflexao)} ${seta("kai_deflexao", a.kai_deflexao, ant.kai_deflexao)}</td>
      <td class="num">${fmtNum(a.respostas)}</td>
      <td class="cel-spark">${sparkSvg(m, corHex(m), 110, 26)}</td>
    </tr>`;
  }).join("");
}

function pintaRanking(d, hoje) {
  const linhas = rankingAgentes(d, estado.marca, estado.janela, hoje);
  const sel = $("#sel-agente");
  const atual = estado.agente;
  const nomes = [...new Map(linhas.map((a) => [a.agente_id, a.nome])).entries()];
  sel.innerHTML = `<option value="todos">Todos os agentes</option>` +
    nomes.map(([id, n]) => `<option value="${id}" ${id === atual ? "selected" : ""}>${n}</option>`).join("");

  const filtradas = atual === "todos" ? linhas : linhas.filter((a) => a.agente_id === atual);
  const maxTrab = Math.max(...linhas.map((a) => a.trabalhados || 0), 1);
  $("#ranking-rotulo").textContent = JAN_ROT[estado.janela] + (linhas.some((a) => a.aprox) ? " · ≈" : "");

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
      <td class="num">${fmtDur(a.resposta_mediana_seg)}</td>
      <td class="num">${fmtDur(a.horas_ativas_seg)}</td>
    </tr>`).join("") ||
    `<tr><td colspan="7" class="vazio-tabela">Nenhuma atividade de agente no período.</td></tr>`;
}

function pintaNps(d, hoje) {
  const dias = NPS_DIAS[estado.janela];
  $("#nps-rotulo").textContent = JAN_ROT[estado.janela] + " · votos no Listmonk";
  const marcas = estado.marca === "todas" ? ["todas", ...MARCAS] : [estado.marca];
  $("#area-nps").innerHTML = marcas.map((mca) => {
    const n = calculaNps(d.nps, mca, dias, hoje);
    const nAnt = calculaNps(d.nps, mca, dias, diasAtras(dias, hoje));
    const rot = mca === "todas" ? "Grupo" : ROTULOS[mca];
    if (!n.n) return `<div class="nps-cartao">
      <div class="cab"><span class="ponto" style="--cor:${corHex(mca)}"></span><h3>${rot}</h3><span class="nps-score">—</span></div>
      <p class="mini">Sem votos no período.</p></div>`;
    const pc = (x) => (x / n.n) * 100;
    return `<div class="nps-cartao">
      <div class="cab"><span class="ponto" style="--cor:${corHex(mca)}"></span><h3>${rot}</h3>
        ${nAnt.n >= 3 ? chipHtml("csat", n.nps, nAnt.nps) : ""}
        <span class="nps-score">${n.nps}</span></div>
      <div class="nps-dist">
        <i class="p" style="width:${pc(n.prom)}%"></i>
        <i class="pa" style="width:${pc(n.pass)}%"></i>
        <i class="d" style="width:${pc(n.detr)}%"></i>
      </div>
      <div class="nps-leg"><span>${n.prom} prom.</span><span>${n.pass} pass.</span><span>${n.detr} detr.</span><span>${n.n} votos</span></div>
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
