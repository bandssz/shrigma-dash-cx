// Monta 1 upsert por item (marca, fonte) do coletor de canal + a linha de crm_tts_coleta_log no mesmo
// statement (CTE), para o frescor do painel. Colunas fixas por tabela; VALUES escapados.
const q = s => (s === null || s === undefined) ? 'NULL' : "'" + String(s).split("'").join("''") + "'";
const n = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? 'NULL' : String(Number(v));
const t = v => v ? q(v) + '::timestamptz' : 'NULL';
const d = v => v ? q(v) + '::date' : 'NULL';
const js = v => (v === null || v === undefined) ? 'NULL' : q(typeof v === 'string' ? v : JSON.stringify(v)) + '::jsonb';
const arr = v => Array.isArray(v) ? (v.length ? 'ARRAY[' + v.map(q).join(',') + ']::text[]' : "'{}'::text[]") : 'NULL';

const TABELAS = {
  canal:  { tabela: 'crm_tts_canal_dia', log: 'canal_dia', pk: ['marca', 'dia', 'superficie', 'origem'], cols: {
    marca: q, dia: d, superficie: q, origem: q, gmv: n, receita_bruta: n, gmv_max_pct: n, gmv_ads: n, pedidos: n, sku_pedidos: n,
    unidades: n, compradores: n, reembolso: n, visitantes: n, visualizacoes: n, conversao_pct: n } },
  lives:  { tabela: 'crm_tts_live_dia', log: 'canal_live', pk: ['marca', 'live_id'], cols: {
    marca: q, live_id: q, dia: d, username: q, origem: q, titulo: q, inicio_em: t, fim_em: t, duracao_min: n, gmv: n, gmv_24h: n, ticket_medio: n,
    pedidos: n, pedidos_criados: n, unidades: n, compradores: n, produtos_vendidos: n, clique_pedido_pct: n, visualizacoes: n, espectadores: n, cliques: n,
    impressoes_produto: n, ctr_pct: n, curtidas: n, comentarios: n, novos_seguidores: n, tempo_medio_s: n },
    // gmv_24h chega -1 (NULL aqui) enquanto a API não fecha as 24h; não apagar um valor já gravado
    preservar: ['gmv_24h'] },
  live_produtos: { tabela: 'crm_tts_live_produto', log: 'canal_live_produto', pk: ['marca', 'live_id', 'product_id'], cols: {
    marca: q, live_id: q, product_id: q, nome: q, gmv_direto: n, pedidos: n, pedidos_criados: n, compradores: n, unidades: n, ticket_medio: n, taxa_pagamento: n,
    impressoes: n, cliques: n, ctr_pct: n, clique_pedido_pct: n, carrinho: n, gpm: n } },
  videos: { tabela: 'crm_tts_video_dia', log: 'canal_video', pk: ['marca', 'dia', 'video_id'], cols: {
    marca: q, dia: d, video_id: q, username: q, origem: q, titulo: q, publicado_em: t, gmv: n, gpm: n, pedidos: n, unidades: n, compradores: n,
    visualizacoes: n, ctr_pct: n, duracao_s: n, produtos: js, hashtags: arr, janela_dias: n } },
};

const out = [];
for (const item of $input.all()) {
  const j = item.json;
  const def = TABELAS[j.fonte];
  const log = `INSERT INTO crm_tts_coleta_log (marca, fonte, iniciado_em, terminado_em, paginas, linhas, ok, erro)
    VALUES (${q(j.marca)}, ${q(def ? def.log : j.fonte)}, ${t(j.iniciado_em)}, now(), ${n(j.paginas)}, ${n((j.rows || []).length)}, ${j.erro ? 'false' : 'true'}, ${q(j.erro)})`;
  if (!def || !j.rows || !j.rows.length) {
    out.push({ json: { marca: j.marca, fonte: j.fonte, linhas: 0, erro: j.erro || null, sql: log } });
    continue;
  }
  const cols = Object.keys(def.cols);
  const values = j.rows.map(r => '(' + cols.map(c => def.cols[c](r[c])).join(',') + ')').join(',\n');
  const preservar = def.preservar || [];
  const set = cols.filter(c => !def.pk.includes(c))
    .map(c => preservar.includes(c) ? `${c} = COALESCE(EXCLUDED.${c}, ${def.tabela}.${c})` : `${c} = EXCLUDED.${c}`)
    .concat(['atualizado_em = now()']).join(', ');
  const sql = `WITH log AS (${log} RETURNING 1)
INSERT INTO ${def.tabela} (${cols.join(', ')}) VALUES
${values}
ON CONFLICT (${def.pk.join(', ')}) DO UPDATE SET ${set}`;
  out.push({ json: { marca: j.marca, fonte: j.fonte, linhas: j.rows.length, erro: null, sql } });
}
return out;
