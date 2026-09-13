// ================== CX · GRÁFICOS (SVG puro, sem biblioteca) ==================
// Duas formas, usadas em todas as abas: linhas no tempo e barras empilhadas por semana.
// Regras (dataviz): um eixo só; linha 2px; grade hairline sólida; ≥ 2 séries = legenda;
// rótulo direto só no último ponto; texto nunca veste a cor da série (a cor fica na marca).
// Sem dado = mensagem, nunca gráfico vazio nem zero inventado. Funções puras: devolvem HTML.

const CXG = {
  W: 640, H: 210, PL: 36, PR: 48, PT: 14, PB: 26,
  esc: (s) => String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
};

// ticks "redondos" para o eixo Y: 0, passo, 2·passo… até cobrir max
function cxgTicks(max, n) {
  if (!(max > 0)) return [0, 1];
  const bruto = max / (n || 4);
  const pot = Math.pow(10, Math.floor(Math.log10(bruto)));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((p) => p >= bruto) || pot * 10;
  const out = []; for (let v = 0; v <= max + 1e-9; v += passo) out.push(Math.round(v * 1000) / 1000);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + passo);
  return out;
}

/* Linhas no tempo.
   o = { series: [{ nome, cor, pontos: [{ x: 0..n-1, y, rot }] }], rotulosX: [..], yMax?, pct?: bool,
         alvo?: { y, rot }, base?: { y, rot }, marcos?: [{ i, rot, title }], fmt: (y)=>str, vazio?: str } */
function cxgLinhas(o) {
  const series = (o.series || []).filter((s) => s.pontos && s.pontos.some((p) => typeof p.y === "number"));
  if (!series.length) return `<div class="vazio mini">${CXG.esc(o.vazio || "Sem dado suficiente para traçar.")}</div>`;
  const { W, H, PL, PR, PT, PB } = CXG; const iw = W - PL - PR, ih = H - PT - PB;
  const n = Math.max(o.rotulosX ? o.rotulosX.length : 0, ...series.map((s) => s.pontos.length), 2);
  const todosY = series.flatMap((s) => s.pontos.map((p) => p.y)).filter((y) => typeof y === "number");
  const extra = [o.alvo && o.alvo.y, o.base && o.base.y].filter((v) => typeof v === "number");
  const yMax = o.pct ? 100 : (o.yMax || cxgTicks(Math.max(...todosY, ...extra, 1)).slice(-1)[0]);
  const ticks = o.pct ? [0, 25, 50, 75, 100] : cxgTicks(yMax);
  const x = (i) => PL + (i / (n - 1)) * iw, y = (v) => PT + ih - (Math.min(v, yMax) / yMax) * ih;
  const fmt = o.fmt || ((v) => String(v));
  const grade = ticks.map((t) => `<line x1="${PL}" x2="${W - PR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grade"/><text x="${PL - 6}" y="${(y(t) + 3.5).toFixed(1)}" class="eixo" text-anchor="end">${CXG.esc(fmt(t))}</text>`).join("");
  const ref = (r, cls) => r && typeof r.y === "number" ? `<line x1="${PL}" x2="${W - PR}" y1="${y(r.y).toFixed(1)}" y2="${y(r.y).toFixed(1)}" class="${cls}"/><text x="${W - PR + 4}" y="${(y(r.y) + 3.5).toFixed(1)}" class="ref-rot">${CXG.esc(r.rot || "")}</text>` : "";
  const marcos = (o.marcos || []).map((m) => `<g class="marco"><title>${CXG.esc(m.title || m.rot)}</title><line x1="${x(m.i).toFixed(1)}" x2="${x(m.i).toFixed(1)}" y1="${PT}" y2="${PT + ih}"/><text x="${(x(m.i) + 4).toFixed(1)}" y="${PT + 9}">${CXG.esc(m.rot)}</text></g>`).join("");
  const linhas = series.map((s) => {
    const pts = s.pontos.map((p, i) => ({ ...p, i })).filter((p) => typeof p.y === "number");
    const d = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
    const ult = pts[pts.length - 1];
    const dots = pts.map((p) => `<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="${p === ult ? 4 : 3}" style="fill:${s.cor}"${p.parcial ? ' class="parcial"' : ""}><title>${CXG.esc((p.rot || o.rotulosX && o.rotulosX[p.i] || "") + (p.parcial ? " (parcial)" : ""))}\n${CXG.esc(s.nome)}: ${CXG.esc(fmt(p.y))}${p.n !== undefined ? "\n" + CXG.esc(p.n) : ""}</title></circle>`).join("");
    const fim = ult && series.length <= 3 ? `<text x="${(x(ult.i) + 7).toFixed(1)}" y="${(y(ult.y) + 4).toFixed(1)}" class="fim">${CXG.esc(fmt(ult.y))}</text>` : "";
    return `<polyline points="${d}" fill="none" stroke="${s.cor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}${fim}`;
  }).join("");
  const rx = o.rotulosX || [];
  const eixoX = rx.length ? `<text x="${PL}" y="${H - 6}" class="eixo">${CXG.esc(rx[0])}</text><text x="${W - PR}" y="${H - 6}" class="eixo" text-anchor="end">${CXG.esc(rx[rx.length - 1])}</text>` : "";
  const legenda = series.length >= 2 ? `<div class="g-legenda">${series.map((s) => `<span><i class="leg-linha" style="background:${s.cor}"></i>${CXG.esc(s.nome)}</span>`).join("")}${o.alvo ? `<span><i class="leg-linha leg-alvo"></i>${CXG.esc(o.alvo.rot || "alvo")}</span>` : ""}</div>` : (o.alvo ? `<div class="g-legenda"><span><i class="leg-linha leg-alvo"></i>${CXG.esc(o.alvo.rot || "alvo")}</span></div>` : "");
  return `<svg viewBox="0 0 ${W} ${H}" class="g-linhas" role="img" aria-label="${CXG.esc(o.aria || "")}">${grade}${ref(o.base, "ref-base")}${ref(o.alvo, "ref-alvo")}${marcos}${linhas}${eixoX}</svg>${legenda}`;
}

/* Barras empilhadas por período (semanas). 100% quando o.pct.
   o = { rotulosX: [..], series: [{ nome, cor, valores: [..] }], pct?, fmt, topo?: [str] (rótulo no topo de cada barra), vazio? } */
function cxgBarras(o) {
  const series = (o.series || []).filter((s) => s.valores && s.valores.some((v) => v > 0));
  const n = (o.rotulosX || []).length;
  if (!series.length || !n) return `<div class="vazio mini">${CXG.esc(o.vazio || "Sem dado suficiente para traçar.")}</div>`;
  const { W, H, PL, PR, PT, PB } = CXG; const iw = W - PL - PR, ih = H - PT - PB;
  const totais = Array.from({ length: n }, (_, i) => series.reduce((s, x) => s + (x.valores[i] || 0), 0));
  const yMax = o.pct ? 100 : cxgTicks(Math.max(...totais, 1)).slice(-1)[0];
  const ticks = o.pct ? [0, 25, 50, 75, 100] : cxgTicks(yMax);
  const fmt = o.fmt || ((v) => String(v));
  const y = (v) => PT + ih - (v / yMax) * ih;
  const slot = iw / n, larg = Math.min(24, slot * 0.62), gap = 2;
  const grade = ticks.map((t) => `<line x1="${PL}" x2="${W - PR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grade"/><text x="${PL - 6}" y="${(y(t) + 3.5).toFixed(1)}" class="eixo" text-anchor="end">${CXG.esc(fmt(t))}</text>`).join("");
  let barras = "";
  for (let i = 0; i < n; i++) {
    const tot = totais[i]; if (!tot) continue;
    const cx = PL + slot * i + slot / 2; let acum = 0;
    series.forEach((s, k) => {
      const v = s.valores[i] || 0; if (!v) return;
      const h = ((o.pct ? (v / tot) * 100 : v) / yMax) * ih;
      const y1 = y(o.pct ? (acum / tot) * 100 : acum) - h;
      acum += v;
      const hReal = Math.max(0, h - (k < series.length - 1 ? gap : 0));
      barras += `<rect x="${(cx - larg / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${larg.toFixed(1)}" height="${hReal.toFixed(1)}" style="fill:${s.cor}"${k === series.length - 1 ? ' rx="3"' : ""}><title>${CXG.esc(o.rotulosX[i])}\n${CXG.esc(s.nome)}: ${CXG.esc(fmt(v))}${o.pct ? ` (${Math.round((v / tot) * 100)}%)` : ""}\ntotal ${CXG.esc(fmt(tot))}</title></rect>`;
    });
    if (o.topo && o.topo[i]) barras += `<text x="${cx.toFixed(1)}" y="${(y(o.pct ? 100 : tot) - 5).toFixed(1)}" class="topo" text-anchor="middle">${CXG.esc(o.topo[i])}</text>`;
  }
  const rx = o.rotulosX;
  const eixoX = `<text x="${PL}" y="${H - 6}" class="eixo">${CXG.esc(rx[0])}</text><text x="${W - PR}" y="${H - 6}" class="eixo" text-anchor="end">${CXG.esc(rx[n - 1])}</text>`;
  const legenda = `<div class="g-legenda">${series.map((s) => `<span><i class="leg-quad" style="background:${s.cor}"></i>${CXG.esc(s.nome)}</span>`).join("")}</div>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="g-barras" role="img" aria-label="${CXG.esc(o.aria || "")}">${grade}${barras}${eixoX}</svg>${legenda}`;
}

if (typeof module !== "undefined") module.exports = { cxgTicks, cxgLinhas, cxgBarras, CXG };
