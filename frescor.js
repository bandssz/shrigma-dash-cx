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
  const o = Object.assign({ limiteParadoH: 26, limiteFrescoMin: 90, nomes: {} }, opts || {});   // nomes: bloco → nome que uma pessoa entende ("cx_ra" → "Reclame Aqui")
  const agora = Date.now();
  const blocos = [], semConfirmacao=[];
  if(Array.isArray(o.collections)){
    for(const s of o.collections){
      const t=Date.parse(s.checked_at||'');
      if(Number.isFinite(t))blocos.push({nome:s.name,min:Math.max(0,Math.round((agora-t)/60000))});
      else if(s.required)semConfirmacao.push(s.name);
    }
  }else{
  for (const [nome, rows] of Object.entries(payload)) {
    if (!Array.isArray(rows) || !rows.length || nome.startsWith('_')) continue;
    let max = null;
    for (const r of rows) { const t = Date.parse(r?.coletado_em||''); if (Number.isFinite(t) && (max===null || t > max)) max = t; }
    if (max!==null) blocos.push({ nome: o.nomes[nome] || nome, min: Math.max(0,Math.round((agora-max)/60000)) });
  }
  }
  if (!blocos.length) { el.textContent = semConfirmacao.length?'coleta sem confirmação':'coleta —'; el.title=semConfirmacao.join('\n');el.classList.toggle('velho',semConfirmacao.length>0); return; }
  blocos.sort((a, b) => a.min - b.min);
  const fmt = (m) => m < 60 ? m + ' min' : m < 48 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d';
  const fresco = blocos[0], parados = blocos.filter((b) => b.min > o.limiteParadoH * 60);
  el.textContent = 'coleta há ' + fmt(fresco.min) + (semConfirmacao.length?` · ${semConfirmacao[0]} sem confirmação`:parados.length ? ` · ${parados[0].nome} sem atualização há ${fmt(parados[0].min)}` : '');
  el.classList.toggle('velho', semConfirmacao.length>0 || parados.length > 0 || fresco.min > o.limiteFrescoMin);
  el.title = [...blocos.map((b) => `${b.nome}: há ${fmt(b.min)}`),...semConfirmacao.map(n=>n+': sem confirmação de coleta')].join('\n');
}
if(typeof module!=='undefined')module.exports=shrigmaFrescor;
