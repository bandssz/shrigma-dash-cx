/* A aritmética que decide quanto um parceiro recebe, exercida contra pedidos REAIS das duas lojas.
   A fixture tests/fixtures/partner-base-refunded-orders.json guarda só os campos financeiros e o
   número do pedido de todos os pedidos reembolsados e cancelados lidos em 21/09; o id da Shopify foi
   trocado por um sintético e nenhum dado de cliente entrou. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const C = require('../n8n/creators/partner-base-collector.cjs');
const REAIS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/partner-base-refunded-orders.json'), 'utf8'));
const base = (pedido, loja) => C.baseElegivel(C.linhaDeBase(pedido, loja));
const acha = (loja, nome) => REAIS[loja].find((o) => o.name === nome);

test('pedido pago e sem reembolso: a base é o subtotal, e o frete fica de fora', () => {
  const l = C.linhaDeBase({ id: 'gid://shopify/Order/1', name: '#1', createdAt: '2026-09-10T15:00:00Z',
    displayFinancialStatus: 'PAID', currencyCode: 'BRL',
    subtotalPriceSet: { shopMoney: { amount: '66.31' } }, totalShippingPriceSet: { shopMoney: { amount: '13.43' } },
    totalRefundedSet: { shopMoney: { amount: '0.00' } }, refunds: [] }, 'aristocrata');
  assert.equal(l.marca, 'aristo');
  assert.equal(l.subtotal_apos_descontos, 66.31);
  const b = C.baseElegivel(l);
  assert.equal(b.base_elegivel, 66.31, 'o frete de 13,43 não pode entrar na base');
  assert.equal(b.base_exata, true);
  assert.equal(C.comissao(b.base_elegivel, 0.07), 4.64);
});

test('reembolso itemizado zera a base, e continua exato', () => {
  // #71083: subtotal 34,90 + frete 8,15, reembolso total 43,05 com as linhas itemizadas
  const b = base(acha('aristocrata', '#71083'), 'aristocrata');
  assert.equal(b.base_elegivel, 0);
  assert.equal(b.base_exata, true);
});

test('reembolso integral sem linhas itemizadas também zera — é onde currentSubtotalPriceSet erraria', () => {
  // #46978 e F30536 foram reembolsados por ajuste, sem refundLineItems: a Shopify segue reportando
  // currentSubtotalPriceSet cheio. A regra do frete-primeiro é o que salva esses dois.
  const a = base(acha('aristocrata', '#46978'), 'aristocrata');
  assert.equal(a.base_elegivel, 0, 'pedido totalmente devolvido não pode gerar comissão');
  assert.equal(a.base_exata, false, 'reembolso não itemizado precisa aparecer como estimativa');
  const f = base(acha('fishermans', 'F30536'), 'fishermans');
  assert.equal(f.base_elegivel, 0);
  assert.equal(f.base_exata, false);
});

test('nenhum pedido reembolsado ou cancelado das duas lojas sobra com base a pagar', () => {
  const sobrando = [];
  for (const loja of Object.keys(REAIS)) for (const o of REAIS[loja]) {
    const b = base(o, loja);
    if (b.base_elegivel > 0) sobrando.push([loja, o.name, o.displayFinancialStatus, b.base_elegivel]);
  }
  assert.deepEqual(sobrando, [], 'todo pedido reembolsado ou cancelado real tem de chegar a zero');
});

test('a base nunca fica negativa nem é inventada acima do subtotal', () => {
  for (const loja of Object.keys(REAIS)) for (const o of REAIS[loja]) {
    const l = C.linhaDeBase(o, loja), b = C.baseElegivel(l);
    assert.ok(b.base_elegivel >= 0, `${o.name} ficou negativo`);
    assert.ok(b.base_elegivel <= l.subtotal_apos_descontos + 0.001, `${o.name} passou do subtotal`);
  }
});

test('reembolso só do frete não mexe na base do produto', () => {
  const l = C.linhaDeBase({ id: 'gid://shopify/Order/2', name: '#2', createdAt: '2026-09-10T15:00:00Z',
    displayFinancialStatus: 'PARTIALLY_REFUNDED', currencyCode: 'BRL',
    subtotalPriceSet: { shopMoney: { amount: '100.00' } }, totalShippingPriceSet: { shopMoney: { amount: '20.00' } },
    totalRefundedSet: { shopMoney: { amount: '20.00' } }, refunds: [{ refundLineItems: { nodes: [] } }] }, 'fishermans');
  const b = C.baseElegivel(l);
  assert.equal(b.base_elegivel, 100, 'devolver o frete não devolve o produto');
});

test('reembolso parcial de produto reduz a base na medida certa', () => {
  const l = C.linhaDeBase({ id: 'gid://shopify/Order/3', name: '#3', createdAt: '2026-09-10T15:00:00Z',
    displayFinancialStatus: 'PARTIALLY_REFUNDED', currencyCode: 'BRL',
    subtotalPriceSet: { shopMoney: { amount: '100.00' } }, totalShippingPriceSet: { shopMoney: { amount: '20.00' } },
    totalRefundedSet: { shopMoney: { amount: '30.00' } },
    refunds: [{ refundLineItems: { nodes: [{ subtotalSet: { shopMoney: { amount: '30.00' } } }] } }] }, 'fishermans');
  const b = C.baseElegivel(l);
  assert.equal(b.base_elegivel, 70);
  assert.equal(b.base_exata, false, 'reembolso de 30 com frete de 20 não fecha itemizado: fica estimado');
  assert.equal(C.comissao(70, 0.07), 4.9);
});

test('pedido cancelado não paga, mesmo sem reembolso registrado', () => {
  const l = C.linhaDeBase({ id: 'gid://shopify/Order/4', name: '#4', createdAt: '2026-09-10T15:00:00Z',
    cancelledAt: '2026-09-11T10:00:00Z', displayFinancialStatus: 'EXPIRED', currencyCode: 'BRL',
    subtotalPriceSet: { shopMoney: { amount: '214.00' } }, totalShippingPriceSet: { shopMoney: { amount: '0.00' } },
    totalRefundedSet: { shopMoney: { amount: '0.00' } }, refunds: [] }, 'fishermans');
  assert.equal(l.cancelado, true);
  assert.equal(C.baseElegivel(l).base_elegivel, 0);
});

test('o dia é o de Brasília, não o UTC', () => {
  assert.equal(C.diaBrasilia('2026-09-11T02:30:00Z'), '2026-09-10', 'madrugada UTC ainda é o dia anterior aqui');
  assert.equal(C.diaBrasilia('2026-09-11T03:30:00Z'), '2026-09-11');
  assert.equal(C.diaBrasilia('não é data'), null);
});

test('pedido com mais itens do que a página trouxe é marcado, não silenciado', () => {
  const l = C.linhaDeBase({ id: 'gid://shopify/Order/5', name: '#5', createdAt: '2026-09-10T15:00:00Z',
    displayFinancialStatus: 'PAID', currencyCode: 'BRL', subtotalPriceSet: { shopMoney: { amount: '10' } },
    totalShippingPriceSet: { shopMoney: { amount: '0' } }, totalRefundedSet: { shopMoney: { amount: '0' } },
    refunds: [], lineItems: { pageInfo: { hasNextPage: true } } }, 'aristocrata');
  assert.equal(l.itens_truncados, true);
});
