/* Read-only financial collector. Authenticated transport is supplied by the n8n vault.
   No customer fields, access tokens, payment details or HTTP bodies are persisted. */
'use strict';
const MARCA = { aristocrata: 'aristo', fishermans: 'fish' };
const MONEY = '{ shopMoney { amount currencyCode } }';
const ORDER_QUERY = `query PartnerOrder($id: ID!) { order(id: $id) {
 id name createdAt updatedAt cancelledAt displayFinancialStatus currencyCode taxesIncluded test
 subtotalPriceSet ${MONEY} totalShippingPriceSet ${MONEY} totalRefundedSet ${MONEY} refunds { id }
} }`;
const CONNECTIONS = {
 lineItems: ['Order', `id quantity originalTotalSet ${MONEY} discountAllocations { allocatedAmountSet ${MONEY} }`],
 shippingLines: ['Order', `id discountedPriceSet ${MONEY}`],
 refundLineItems: ['Refund', `id quantity lineItem { id } subtotalSet ${MONEY} totalTaxSet ${MONEY}`],
 refundShippingLines: ['Refund', `id subtotalAmountSet ${MONEY} taxAmountSet ${MONEY}`],
 transactions: ['Refund', `id kind status amountSet ${MONEY}`],
};
function connectionQuery(field) {
 const spec = CONNECTIONS[field];
 if (!spec) throw Error('Unknown financial connection');
 return `query PartnerFinancialPage($id: ID!, $after: String) { node(id: $id) { ... on ${spec[0]} {
 id ${field}(first: 100, after: $after) { nodes { ${spec[1]} } pageInfo { hasNextPage endCursor } }
 } } }`;
}
function cents(value, currency) {
 const m = value?.shopMoney, raw = String(m?.amount ?? '');
 if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || (m.currencyCode && m.currencyCode !== currency)) throw Error('Invalid financial amount or currency');
 const parts = raw.split('.'), n = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
 if (!Number.isSafeInteger(n)) throw Error('Financial amount outside range');
 return n;
}
const reais = n => n / 100;
const completeConnection = c => Array.isArray(c?.nodes) && c?.pageInfo?.hasNextPage === false;
function diaBrasilia(iso) {
 const t = Date.parse(iso);
 return Number.isFinite(t) ? new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10) : null;
}
function linhaDeBase(pedido, marcaLoja, coletadoEm = null) {
 const marca = MARCA[marcaLoja] || marcaLoja, dia = diaBrasilia(pedido?.createdAt);
 if (!['aristo', 'fish'].includes(marca) || !dia || !/^gid:\/\/shopify\/Order\/\d+$/.test(pedido?.id || '')) return null;
 const moeda = pedido.currencyCode;
 if (moeda !== 'BRL') throw Error('Only BRL commission bases are supported');
 const money = x => cents(x, moeda), refunds = pedido.refunds;
 if (!Array.isArray(refunds)) throw Error('Missing refund list');
 let ritens = 0, rfrete = 0, ritax = 0, rftax = 0, transacoes = 0;
 let completo = completeConnection(pedido.lineItems) && completeConnection(pedido.shippingLines)
  && typeof pedido.taxesIncluded === 'boolean' && typeof pedido.test === 'boolean'
  && Number.isFinite(Date.parse(pedido.updatedAt));
 const itens = (pedido.lineItems?.nodes || []).map(li => {
  if (!li.id || !Number.isInteger(li.quantity) || li.quantity < 0 || !Array.isArray(li.discountAllocations)) throw Error('Invalid order line');
  const valor = money(li.originalTotalSet) - li.discountAllocations.reduce((n, d) => n + money(d.allocatedAmountSet), 0);
  if (valor < 0) throw Error('Discount greater than line value');
  return { id: li.id, quantidade: li.quantity, subtotal_apos_descontos: reais(valor) };
 });
 const fretes = (pedido.shippingLines?.nodes || []).map(s => ({ id: s.id, valor_apos_descontos: reais(money(s.discountedPriceSet)) }));
 const reembolsos = refunds.map(r => {
  completo &&= completeConnection(r.refundLineItems) && completeConnection(r.refundShippingLines) && completeConnection(r.transactions);
  let ri = 0, rf = 0, ti = 0, tf = 0, tx = 0;
  for (const li of r.refundLineItems?.nodes || []) { ri += money(li.subtotalSet); if (li.totalTaxSet) ti += money(li.totalTaxSet); else completo = false; }
  for (const s of r.refundShippingLines?.nodes || []) { rf += money(s.subtotalAmountSet); tf += money(s.taxAmountSet); }
  for (const t of r.transactions?.nodes || []) {
   if (t.kind === 'REFUND' && t.status === 'SUCCESS') tx += money(t.amountSet);
   else if (t.kind === 'REFUND') completo = false;
  }
  // Reconcile each refund independently: unrelated discrepancies cannot cancel each other.
  if (ri + rf + ti + tf !== tx) completo = false;
  ritens += ri; rfrete += rf; ritax += ti; rftax += tf; transacoes += tx;
  return { id: r.id || null, itens: reais(ri), frete: reais(rf), imposto_itens: reais(ti), imposto_frete: reais(tf), transacoes_confirmadas: reais(tx) };
 });
 const sub = money(pedido.subtotalPriceSet), rtotal = money(pedido.totalRefundedSet);
 completo &&= itens.reduce((n, x) => n + Math.round(x.subtotal_apos_descontos * 100), 0) === sub && transacoes === rtotal;
 return {
  marca, order_id: pedido.id, pedido_nome: String(pedido.name || ''), dia, moeda,
  subtotal_apos_descontos: reais(sub), frete: reais(money(pedido.totalShippingPriceSet)),
  reembolso_total: reais(rtotal), reembolso_itens: reais(ritens), reembolso_frete: reais(rfrete),
  reembolso_imposto_itens: reais(ritax), reembolso_imposto_frete: reais(rftax),
  impostos_inclusos: pedido.taxesIncluded === true, pedido_teste: pedido.test === true,
  cancelado: Boolean(pedido.cancelledAt), status_financeiro: String(pedido.displayFinancialStatus || ''),
  itens_truncados: !completeConnection(pedido.lineItems), detalhes_completos: completo,
  fonte_atualizada_em: pedido.updatedAt || null, coletado_em: coletadoEm, itens, fretes, reembolsos,
 };
}
function baseElegivel(linha) {
 if (!linha) return null;
 const c = k => Math.round(Number(linha[k] || 0) * 100);
 const rtotal = c('reembolso_total'), ri = c('reembolso_itens'), rf = c('reembolso_frete');
 const ti = c('reembolso_imposto_itens'), tf = c('reembolso_imposto_frete');
 const exata = linha.detalhes_completos === true && !linha.itens_truncados && ri + rf + ti + tf === rtotal;
 // Only confirmed shipping refunds are exempted. Unknown components reduce the provisional base.
 const produtos = Math.max(ri + (linha.impostos_inclusos ? ti : 0), rtotal - rf - tf - (linha.impostos_inclusos ? 0 : ti), 0);
 const elegivel = !linha.cancelado && !linha.pedido_teste && ['PAID', 'PARTIALLY_REFUNDED'].includes(linha.status_financeiro);
 return { base_elegivel: elegivel ? reais(Math.max(c('subtotal_apos_descontos') - produtos, 0)) : 0, base_exata: exata };
}
function comissao(base, taxa) {
 if (base == null || !Number.isFinite(Number(base)) || !Number.isFinite(Number(taxa))) return null;
 return Number((Number(base) * Number(taxa)).toFixed(2));
}
function orderGid(id) {
 const s = String(id);
 if (/^\d+$/.test(s)) return 'gid://shopify/Order/' + s;
 if (/^gid:\/\/shopify\/Order\/\d+$/.test(s)) return s;
 throw Error('Invalid Shopify order id');
}
// Serializable state machine shared by tests, the async caller and n8n HTTP Request nodes.
function begin(order, started = new Date().toISOString(), maxPages = 100) {
 const marca = MARCA[order.marca] || order.marca;
 if (!['aristo', 'fish'].includes(marca) || !Number.isInteger(maxPages) || maxPages < 1) throw Error('Invalid collector configuration');
 return { marca, order_id: String(order.order_id), dia: order.dia || null, id: orderGid(order.order_id), started, maxPages, stage: 'summary', jobs: [], done: false };
}
function request(state) {
 if (state.done) throw Error('Collection already complete');
 if (state.stage === 'summary' || state.stage === 'verify') return { query: ORDER_QUERY, variables: { id: state.id } };
 const job = state.jobs[0];
 return { query: connectionQuery(job.field), variables: { id: job.id, after: job.after || null } };
}
function accept(state, result) {
 if (result?.errors?.length || !result?.data) throw Error('Shopify financial response incomplete');
 if (state.stage === 'summary') {
  const order = result.data.order;
  if (!order || order.id !== state.id || !Array.isArray(order.refunds) || !Number.isFinite(Date.parse(order.updatedAt))) throw Error('Order unavailable or incomplete');
  state.order = order;
  state.jobs = ['lineItems', 'shippingLines'].map(field => ({ id: state.id, field, nodes: [], cursors: [], pages: 0 }));
  const seen = new Set();
  for (const r of order.refunds) {
   if (!/^gid:\/\/shopify\/Refund\/\d+$/.test(r.id || '') || seen.has(r.id)) throw Error('Invalid refund identity');
   seen.add(r.id);
   for (const field of ['refundLineItems', 'refundShippingLines', 'transactions']) state.jobs.push({ id: r.id, field, nodes: [], cursors: [], pages: 0 });
  }
  state.stage = 'connection';
 } else if (state.stage === 'connection') {
  const job = state.jobs[0], node = result.data.node, c = node?.[job.field];
  if (node?.id !== job.id || !Array.isArray(c?.nodes) || typeof c.pageInfo?.hasNextPage !== 'boolean') throw Error('Financial page incomplete');
  const ids = new Set(job.nodes.map(n => n.id));
  for (const n of c.nodes) {
   if (!n?.id || ids.has(n.id)) throw Error('Duplicate or missing financial row id');
   ids.add(n.id); job.nodes.push(n);
  }
  job.pages++;
  if (c.pageInfo.hasNextPage) {
   if (job.pages >= state.maxPages) throw Error('Financial pagination limit reached');
   job.after = c.pageInfo.endCursor;
   if (!job.after || job.cursors.includes(job.after)) throw Error('Financial pagination did not advance');
   job.cursors.push(job.after);
  } else {
   const target = job.id === state.id ? state.order : state.order.refunds.find(r => r.id === job.id);
   target[job.field] = { nodes: job.nodes, pageInfo: { hasNextPage: false } };
   state.jobs.shift();
   if (!state.jobs.length) state.stage = 'verify';
  }
 } else if (state.stage === 'verify') {
  const last = result.data.order, first = state.order;
  if (!last || last.id !== state.id || last.updatedAt !== first.updatedAt || JSON.stringify(last.refunds?.map(r => r.id)) !== JSON.stringify(first.refunds.map(r => r.id))) throw Error('Order changed during collection; retry next run');
  state.row = linhaDeBase(first, state.marca, state.started);
  if (!state.row || (state.dia && state.row.dia !== state.dia)) throw Error('Order outside collector scope');
  state.row.order_id = state.order_id;
  state.done = true;
 } else throw Error('Invalid collection state');
 return state;
}
// graphql returns a parsed envelope. Its caller supplies authenticated HTTPS and request limits.
async function collectOrder({ orderId, marca, dia, graphql, now = () => new Date().toISOString(), maxPages = 100 }) {
 if (typeof graphql !== 'function') throw Error('Invalid collector transport');
 const state = begin({ order_id: orderId, marca, dia }, now(), maxPages);
 while (!state.done) {
  let result;
  try { result = await graphql(request(state)); } catch { throw Error('Shopify financial request failed'); }
  accept(state, result);
 }
 return state.row;
}
module.exports = { linhaDeBase, baseElegivel, comissao, diaBrasilia, collectOrder, connectionQuery, ORDER_QUERY, orderGid, begin, request, accept };
