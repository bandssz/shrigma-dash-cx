'use strict';
// Coletor de pedidos por cupom (DVGW6ZSjTB3CO49k) — revisão de 26/09/2026.
//
// O que muda, e por quê:
// 1. Guarda também pedido NÃO pago (EXPIRED, PENDING, VOIDED...) com pago=false. O relatório da
//    Shopify conta esses pedidos; sem eles no ledger a tela não consegue explicar a diferença.
//    Receita, ROI e comissão continuam só com pago=true (todas as leituras já filtram por pago).
// 2. Janela da busca em UTC explícito (00:00 de Brasília = 03:00Z) e com aspas; sem aspas a Shopify
//    interpreta a data de outro jeito e pedidos do dia seguinte entravam no corte.
// 3. Erro GraphQL deixa de ser "zero pedidos": grava saúde ok=false por marca e para a paginação.
//    Saúde ok=true só na última página, com o número de páginas lidas.
// 4. Percentual de comissão vem do termo vigente NA DATA do pedido (crm_influ_termo). Antes a
//    recoleta de 45 dias aplicava o percentual atual a pedidos de meses anteriores.
//    Sem termo cadastrado: comportamento anterior (percentual do cadastro).
//    Pedido anterior ao primeiro termo: mantém o percentual já apurado.
const WORKFLOW_ID = 'DVGW6ZSjTB3CO49k';
const MARCAS = { aristo: 'Shopify aristo', fish: 'Shopify fish' };

const QUERY = 'query($after: String, $q: String!) { orders(first: 250, after: $after, query: $q, sortKey: CREATED_AT) '
  + '{ pageInfo { hasNextPage endCursor } nodes { id createdAt displayFinancialStatus discountCodes '
  + 'currentSubtotalPriceSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } } '
  + 'netPaymentSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } } } } }';

const JANELA = `// Janela da coleta. Sem entrada => recoleta rolante de 45 dias: e o que pega
// reembolso e chargeback que aconteceram DEPOIS do pedido. O upsert em
// (marca, order_id) torna a sobreposicao inofensiva.
// Backfill: disparar manualmente com { "desde": "2026-05-19", "ate": "2026-08-18" }.
// q_ini/q_fim: mesmos dias em UTC explicito (00:00 de Brasilia = 03:00Z), fim exclusivo.
const e = $json || {};   // do webhook ja normalizado em 'Valida chave'
const DATA = /^\\d{4}-\\d{2}-\\d{2}$/;
const hoje = new Date();
const d = DATA.test(String(e.desde || '')) ? e.desde : new Date(hoje.getTime() - 45*864e5).toISOString().slice(0,10);
const a = DATA.test(String(e.ate || ''))   ? e.ate   : new Date(hoje.getTime() + 864e5).toISOString().slice(0,10);
if (d > a) throw new Error('janela invalida: desde depois de ate');
const depois = s => { const x = new Date(s + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0,10); };
return [{ json: { desde: d, ate: a, q_ini: d + 'T03:00:00Z', q_fim: depois(a) + 'T03:00:00Z', after: null, pagina: 1 } }];`;

function jsonBody() {
  return '={{ JSON.stringify({ query: ' + JSON.stringify(QUERY) + ', variables: { after: $json.after, '
    + "q: \"created_at:>='\" + $('Janela').first().json.q_ini + \"' created_at:<'\" + $('Janela').first().json.q_fim + \"'\" } }) }}";
}

function montaCode(marca) {
  const node = MARCAS[marca];
  return `// Lane de CUPOM apenas. A lane de UTM fica desligada de proposito: nenhum influ
// usa utm_content=<slug> hoje, todo UTM nos pedidos e de midia paga (ID de anuncio
// do Meta). Ligar o resolvedor por UTM agora so criaria falso positivo.
// Revisao 26/09/2026: guarda pedido nao pago (pago=false), registra saude por marca e
// aplica o percentual do termo vigente na data do pedido. Ver n8n/influs/coletor-pedidos-patch.cjs.
const MARCA = '${marca}';
const src = $('${node}').first().json;
const pagina = $runIndex + 1;
const J = $('Janela').first().json;
const q = s => "'" + String(s ?? '').split("'").join("''") + "'";
const n = v => (v === null || v === undefined || v === '') ? 'NULL' : Number(v);
const saude = (ok, det, itens) => \`INSERT INTO crm_influ_saude (lane,marca,ok,detalhe,em,itens)
VALUES ('coleta_pedidos',\${q(MARCA)},\${ok},\${q(String(det).slice(0,300))},now(),\${n(itens)})
ON CONFLICT (lane,marca) DO UPDATE SET ok=EXCLUDED.ok, detalhe=EXCLUDED.detalhe, em=EXCLUDED.em, itens=EXCLUDED.itens\`;
// Shopify devolve HTTP 200 com 'errors' (permissao, throttle, query invalida). Isso NAO e
// "nenhum pedido": grava a falha e para a paginacao desta marca.
const lista = src?.data?.orders;
if (src?.errors || !lista || !Array.isArray(lista.nodes)) {
  const msg = src?.errors ? JSON.stringify(src.errors[0]?.message || src.errors) : 'resposta sem orders';
  return [{ json: { after: null, hasNext: false, desde: J.desde, ate: J.ate, marca: MARCA, n: 0,
    sql: saude(false, 'pagina ' + pagina + ': ' + msg, pagina - 1) + '; SELECT 0 AS gravados' } }];
}
const ords = lista.nodes;
const DIA_BR = ts => new Intl.DateTimeFormat('en-CA',
  { timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit' })
  .format(new Date(ts));   // createdAt vem em UTC; dia comercial e Brasilia

const rows = [];
for (const o of ords) {
  const codes = (o.discountCodes || []).map(c => String(c).toUpperCase()).filter(Boolean);
  if (!codes.length) continue;                      // sem cupom nao e desta lane
  // So PAID e PARTIALLY_REFUNDED sao receita. REFUNDED, EXPIRED, PENDING, VOIDED... entram com
  // pago=false: a linha existe para auditoria e para explicar o relatorio da Shopify, que conta
  // o pedido na criacao; fica fora da receita, do ROI e da comissao.
  const pago = o.displayFinancialStatus === 'PAID' || o.displayFinancialStatus === 'PARTIALLY_REFUNDED';
  rows.push({
    marca: MARCA,
    order_id: String(o.id).split('/').pop(),
    dia: DIA_BR(o.createdAt),
    todos: codes.join(','),
    receita: o.currentSubtotalPriceSet?.shopMoney?.amount ?? null,
    frete: o.totalShippingPriceSet?.shopMoney?.amount ?? null,
    net: o.netPaymentSet?.shopMoney?.amount ?? null,
    reemb: o.totalRefundedSet?.shopMoney?.amount ?? null,
    pago, status: o.displayFinancialStatus || ''
  });
}

const pi = lista.pageInfo || {};
const cursor = { after: pi.endCursor || null, hasNext: !!pi.hasNextPage, desde: J.desde, ate: J.ate };
const fimOk = cursor.hasNext ? '' : saude(true, pagina + ' pagina(s) lidas, janela ' + J.desde + ' a ' + J.ate, pagina) + ';\\n';

if (!rows.length) return [{ json: { ...cursor, sql: fimOk + 'SELECT 0 AS gravados', n: 0, marca: MARCA } }];

// O de-para influ vive no BANCO, nao aqui: um CTE resolve o cupom contra crm_cupom.
// Cupom nao reconhecido NAO e descartado - grava influ='(desconhecido)' e vira fila
// no painel. Pedido historico usa codigo aposentado (ex RAIZ12) e a receita nao pode sumir.
const vals = rows.map(r => \`(\${q(r.marca)},\${q(r.order_id)},\${q(r.dia)}::date,\${q(r.todos)},\`
  + \`\${n(r.receita)},\${n(r.frete)},\${n(r.net)},\${n(r.reemb)},\${r.pago},\${q(r.status)})\`).join(',');

const sql = fimOk + \`
WITH bruto (marca,order_id,dia,todos_cupons,receita_base,frete,net_payment,reembolsado,pago,status_financeiro) AS (
  VALUES \${vals}
),
-- primeiro cupom da ordem que resolve para um influ ATIVO no de-para
res AS (
  SELECT b.*, x.codigo AS cupom_influ, x.influ, x.n_influs
  FROM bruto b
  LEFT JOIN LATERAL (
    SELECT c.codigo, c.influ, count(*) OVER () AS n_influs
    FROM unnest(string_to_array(b.todos_cupons, ',')) WITH ORDINALITY AS u(cod, ord)
    JOIN crm_cupom c ON c.marca = b.marca AND c.codigo = u.cod
                   AND c.tipo IN ('influ','pendente')
    ORDER BY u.ord LIMIT 1
  ) x ON true
),
-- Fora da lane SO se o cupom for reconhecidamente nao-influ (CRM, campanha, cortesia...).
-- 'pendente' e cupom de influ ainda sem dono: excluir aqui apagava a receita dele em silencio.
naoinflu AS (
  SELECT r.* FROM res r WHERE r.influ IS NULL AND EXISTS (
    SELECT 1 FROM unnest(string_to_array(r.todos_cupons, ',')) u(cod)
    JOIN crm_cupom c ON c.marca = r.marca AND c.codigo = u.cod
      AND c.tipo NOT IN ('influ','pendente')
  )
),
alvo AS (
  SELECT r.* FROM res r WHERE r.influ IS NOT NULL
  UNION ALL
  -- cupom nenhum reconhecido: pode ser codigo aposentado. Entra como desconhecido.
  SELECT r.* FROM res r WHERE r.influ IS NULL
    AND NOT EXISTS (SELECT 1 FROM naoinflu x WHERE x.marca=r.marca AND x.order_id=r.order_id)
),
-- Percentual: termo vigente na data do pedido. Sem termo nenhum = percentual do cadastro.
-- Pedido anterior ao primeiro termo = mantem o percentual ja apurado (nao reescreve historico).
pct AS (
  SELECT a.*, i.comissao_pct AS pct_cadastro, tv.comissao_pct AS pct_termo, (tv.vigente_desde IS NOT NULL) AS tem_termo_na_data,
         EXISTS (SELECT 1 FROM crm_influ_termo t WHERE t.marca=a.marca AND t.influ=a.influ) AS tem_termo,
         e.comissao_pct_aplicada AS pct_existente
  FROM alvo a
  LEFT JOIN crm_influ i ON i.marca=a.marca AND i.influ=a.influ
  LEFT JOIN LATERAL (SELECT t.comissao_pct, t.vigente_desde FROM crm_influ_termo t
                     WHERE t.marca=a.marca AND t.influ=a.influ AND t.vigente_desde <= a.dia
                     ORDER BY t.vigente_desde DESC LIMIT 1) tv ON true
  LEFT JOIN crm_influ_pedido e ON e.marca=a.marca AND e.order_id=a.order_id
),
ins AS (
  INSERT INTO crm_influ_pedido (marca,order_id,dia,influ,via,cupom_usado,todos_cupons,
    receita_base,frete,net_payment,reembolsado,comissao_pct_aplicada,comissao,pago,
    status_financeiro,conflito_influ,coletado_em,atualizado_em)
  SELECT a.marca, a.order_id, a.dia,
         COALESCE(a.influ, CASE WHEN a.cupom_influ IS NOT NULL
                            THEN '(pendente)' ELSE '(desconhecido)' END), 'cupom',
         COALESCE(a.cupom_influ, split_part(a.todos_cupons,',',1)), a.todos_cupons,
         a.receita_base, a.frete, a.net_payment, a.reembolsado,
         p.pct_final,
         CASE WHEN a.pago THEN a.receita_base * p.pct_final END,
         a.pago, a.status_financeiro,
         CASE WHEN a.n_influs > 1 THEN 'mais de um cupom de influ no pedido' END,
         now(), now()
  FROM pct a
  CROSS JOIN LATERAL (SELECT CASE WHEN a.tem_termo_na_data THEN a.pct_termo
                                  WHEN a.tem_termo THEN a.pct_existente
                                  ELSE a.pct_cadastro END AS pct_final) p
  ON CONFLICT (marca, order_id) DO UPDATE SET
    dia=EXCLUDED.dia, influ=EXCLUDED.influ, cupom_usado=EXCLUDED.cupom_usado,
    todos_cupons=EXCLUDED.todos_cupons, receita_base=EXCLUDED.receita_base,
    frete=EXCLUDED.frete, net_payment=EXCLUDED.net_payment, reembolsado=EXCLUDED.reembolsado,
    comissao_pct_aplicada=EXCLUDED.comissao_pct_aplicada, comissao=EXCLUDED.comissao,
    pago=EXCLUDED.pago, status_financeiro=EXCLUDED.status_financeiro,
    conflito_influ=EXCLUDED.conflito_influ, atualizado_em=now()
  RETURNING 1
)
SELECT (SELECT count(*) FROM ins) AS gravados,
       (SELECT count(*) FROM naoinflu) AS fora_da_lane,
       (SELECT count(*) FROM alvo WHERE influ IS NULL) AS cupom_desconhecido\`;

return [{ json: { ...cursor, sql, n: rows.length, marca: MARCA } }];`;
}

// Confere que o workflow vivo e o que foi revisado antes de trocar qualquer no.
function patchWorkflow(fresh, { expectedVersionId } = {}) {
  if (fresh?.id !== WORKFLOW_ID) throw Error('Workflow errado');
  if (!expectedVersionId || fresh.versionId !== expectedVersionId || fresh.activeVersionId !== expectedVersionId)
    throw Error('Versao do coletor mudou desde a revisao');
  const w = structuredClone(fresh);
  const byName = name => { const x = w.nodes.find(n => n.name === name); if (!x) throw Error('No ausente: ' + name); return x; };
  const janela = byName('Janela');
  if (!janela.parameters.jsCode.includes('recoleta rolante de 45 dias')) throw Error('Janela divergente');
  janela.parameters.jsCode = JANELA;
  for (const [marca, shopNode] of Object.entries(MARCAS)) {
    const s = byName(shopNode), m = byName('Monta upsert ' + marca), g = byName('Grava ' + marca);
    if (!/financial_status:paid OR financial_status:partially_refunded OR financial_status:refunded/.test(s.parameters.jsonBody))
      throw Error('Busca Shopify divergente: ' + marca);
    if (!m.parameters.jsCode.includes("const MARCA = '" + marca + "'") || !m.parameters.jsCode.includes('ON CONFLICT (marca, order_id)'))
      throw Error('Upsert divergente: ' + marca);
    if (g.parameters.query !== '={{ $json.sql }}') throw Error('Grava divergente: ' + marca);
    s.parameters.jsonBody = jsonBody();
    m.parameters.jsCode = montaCode(marca);
  }
  return w;
}

module.exports = { WORKFLOW_ID, QUERY, JANELA, jsonBody, montaCode, patchWorkflow };
