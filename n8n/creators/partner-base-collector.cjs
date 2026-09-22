/* Maps a Shopify order node to one commission-base row.
   Shared by the n8n collector node and the tests, so the arithmetic that decides what a partner is
   owed is exercised against real order payloads instead of living only inside a workflow. */
'use strict';
const dinheiro = (x) => { const v = Number(((x || {}).shopMoney || {}).amount); return Number.isFinite(v) ? v : 0; };
const MARCA = { aristocrata: 'aristo', fishermans: 'fish' };

// Brazil day of the order, matching the ledger's grain (America/Sao_Paulo, UTC-3 all year).
function diaBrasilia(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function linhaDeBase(pedido, marcaLoja) {
  const marca = MARCA[marcaLoja] || marcaLoja;
  const dia = diaBrasilia(pedido.createdAt);
  if (!marca || !dia || !pedido.id) return null;
  const subtotal = dinheiro(pedido.subtotalPriceSet);
  const frete = dinheiro(pedido.totalShippingPriceSet);
  const reembolsoTotal = dinheiro(pedido.totalRefundedSet);
  // itemizado: a parte do reembolso que a Shopify amarra a linhas de produto
  let reembolsoItens = 0;
  for (const r of ((pedido.refunds || []))) {
    for (const li of (((r || {}).refundLineItems || {}).nodes || [])) reembolsoItens += dinheiro(li.subtotalSet);
  }
  return {
    marca,
    order_id: String(pedido.id),
    pedido_nome: String(pedido.name || ''),
    dia,
    moeda: String(pedido.currencyCode || ''),
    subtotal_apos_descontos: Number(subtotal.toFixed(2)),
    frete: Number(frete.toFixed(2)),
    reembolso_total: Number(reembolsoTotal.toFixed(2)),
    reembolso_itens: Number(reembolsoItens.toFixed(2)),
    cancelado: Boolean(pedido.cancelledAt),
    status_financeiro: String(pedido.displayFinancialStatus || ''),
    itens_truncados: Boolean((((pedido.lineItems || {}).pageInfo || {}).hasNextPage)),
  };
}

/* The same arithmetic the SQL applies, kept here so a test can state the expected number without a
   database. Refunds are assumed to hit shipping first: that is the conservative reading, and it is
   the only one that lands every real refunded order of both brands on the right answer, including
   the two whose refund carries no line items at all. */
function baseElegivel(linha) {
  if (!linha) return null;
  if (linha.cancelado) return { base_elegivel: 0, base_exata: linha.reembolso_total === 0 || Math.abs((linha.reembolso_itens + Math.min(linha.reembolso_total, linha.frete)) - linha.reembolso_total) < 0.01 };
  const produtosReembolsados = Math.max(linha.reembolso_itens, linha.reembolso_total - linha.frete, 0);
  const base = Math.max(linha.subtotal_apos_descontos - produtosReembolsados, 0);
  const exata = linha.reembolso_total === 0
    || Math.abs((linha.reembolso_itens + Math.min(linha.reembolso_total, linha.frete)) - linha.reembolso_total) < 0.01;
  return { base_elegivel: Number(base.toFixed(2)), base_exata: exata };
}

function comissao(base, taxa) {
  if (base == null || !Number.isFinite(Number(base))) return null;
  return Number((Number(base) * Number(taxa)).toFixed(2));
}

if (typeof module !== 'undefined') module.exports = { linhaDeBase, baseElegivel, comissao, diaBrasilia };
