/* Frescor da coleta, compartilhado pelas quatro paginas.
   Por que existe: Growth e Organico mostravam `gerado_em` (hora em que a API montou o JSON,
   sempre "agora") e o CX olhava um bloco so. O snapshot do Listmonk ficou 12 dias morto e
   a tela parecia fresca porque as tabelas ainda tinham linhas.
   Regra: para cada bloco (array) do payload, o `coletado_em` mais recente. A etiqueta mostra a
   idade do bloco mais FRESCO (o quao vivo e o painel) e fica vermelha se QUALQUER bloco
   coletado estiver parado ha mais de `limiteParadoH` horas (a cadencia mais lenta e diaria).
   So `coletado_em` conta: `atualizado_em`/`criado_em` sao tabelas de cadastro manual. */
function shrigmaFrescor(payload, el, opts) {
  if (!el || !payload) return;
  const o = Object.assign({ limiteParadoH: 26, limiteFrescoMin: 90 }, opts || {});
  const agora = Date.now();
  const blocos = [];
  for (const [nome, rows] of Object.entries(payload)) {
    if (!Array.isArray(rows) || !rows.length || nome.startsWith('_')) continue;
    let max = null;
    for (const r of rows) { const t = r && r.coletado_em; if (t && (!max || t > max)) max = t; }
    if (max) blocos.push({ nome, min: Math.round((agora - new Date(max).getTime()) / 60000) });
  }
  if (!blocos.length) { el.textContent = 'coleta —'; el.classList.remove('velho'); return; }
  blocos.sort((a, b) => a.min - b.min);
  const fmt = (m) => m < 60 ? m + ' min' : m < 48 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d';
  const fresco = blocos[0], parados = blocos.filter((b) => b.min > o.limiteParadoH * 60);
  el.textContent = 'coleta há ' + fmt(fresco.min) + (parados.length ? ` · ${parados[0].nome} parado há ${fmt(parados[0].min)}` : '');
  el.classList.toggle('velho', parados.length > 0 || fresco.min > o.limiteFrescoMin);
  el.title = blocos.map((b) => `${b.nome}: há ${fmt(b.min)}`).join('\n');
}
