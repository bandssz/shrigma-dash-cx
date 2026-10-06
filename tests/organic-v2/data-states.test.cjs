'use strict';
// Estados de dados: retrato antigo, parcial, vazio confirmado, indisponível vs desconhecido,
// modelos alternativos de atribuição, peça/pedido sem vínculo e foco por teclado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, PERIOD } = require('./harness.cjs');

test('retrato antigo: marcado, coleta e cache separados; cache não vira data de coleta', async () => {
  const t = setup();
  const orig = t.server.fixtures.aristo.posts;
  t.server.fixtures.aristo.posts = req => Object.assign(orig(req), { freshness: 'stale', collectedAt: null, cacheAt: '2026-10-05T12:00:00.000Z' });
  await t.syncNow();
  const tags = t.tags('posts');
  assert.ok(tags.includes('stale'));
  assert.ok(tags.includes('cache'));
  const collected = t.section('posts').querySelector('[data-ov-tag="collected"]');
  assert.equal(collected.textContent, 'Coleta sem data');
  assert.match(t.text('[data-ov-summary="posts"]'), /retrato antigo/);
});

test('parcial e métricas ausentes: aparece "indisponível", nunca zero', async () => {
  const t = setup();
  const orig = t.server.fixtures.aristo.posts;
  t.server.fixtures.aristo.posts = req => Object.assign(orig(req), { coverage: 'partial' });
  await t.syncNow();
  assert.ok(t.tags('posts').includes('partial'));
  const metrics = t.section('posts').querySelector('.sov2-metrics').textContent;
  assert.match(metrics, /salvos: indisponível/);
  assert.doesNotMatch(metrics, /salvos: 0/);
  assert.match(t.text('[data-ov-section="stories"]'), /cliques no link: indisponível/);
});

test('vazio confirmado versus vazio com cobertura incompleta', async () => {
  const t = setup();
  t.server.fixtures.aristo.posts = () => ({ state: 'empty', coverage: 'complete', freshness: 'fresh', source: 'own_verified', data: null });
  t.server.fixtures.aristo.stories = () => ({ state: 'ready', coverage: 'partial', freshness: 'fresh', source: 'own_verified', data: { items: [] } });
  await t.syncNow();
  assert.ok(t.tags('posts').includes('empty-confirmed'));
  assert.match(t.text('[data-ov-section="posts"]'), /vazio confirmado/);
  assert.ok(t.tags('stories').includes('empty-incomplete'));
  assert.match(t.text('[data-ov-section="stories"]'), /não significa zero/);
});

test('indisponível declarado versus desconhecido por falha de leitura (sem vazar detalhe interno)', async () => {
  const t = setup();
  t.server.fixtures.aristo.posts = () => ({ state: 'unavailable', data: null, error: 'Coletor do Instagram sem dados no período.' });
  t.modes.read.stories = 'throw';
  await t.syncNow();
  assert.equal(t.state('posts'), 'unavailable');
  assert.match(t.text('[data-ov-section="posts"]'), /Coletor do Instagram sem dados/);
  assert.equal(t.state('stories'), 'error');
  assert.ok(t.tags('stories').includes('unknown'));
  assert.doesNotMatch(t.text(), /detalhe interno/);
  assert.match(t.text('[data-ov-summary="stories"]'), /desconhecido/);
});

test('falha ao atualizar mantém leitura anterior da mesma marca marcada e fecha gravação', async () => {
  const t = setup();
  await t.syncNow();
  t.modes.read.links = 'throw';
  await t.syncNow();
  assert.ok(t.tags('links').includes('refresh-failed'));
  assert.match(t.state('links'), /refresh-failed/);
  assert.match(t.q('[data-ov-url="l1"]').value, /utm_campaign=20261001_x/, 'link anterior continua visível');
  assert.equal(t.q('[data-ov-form="link-create"] button[type="submit"]').disabled, true);
  assert.ok(t.qa('[data-ov-action="copy"]').every(b => b.disabled));
});

test('atribuição: modelos alternativos exibidos um de cada vez, sem soma, com filtro do gateway', async () => {
  const t = setup();
  await t.syncNow();
  const sec = () => t.text('[data-ov-section="attribution-aggregate"]');
  assert.match(sec(), /123,45/);
  assert.doesNotMatch(sec(), /222,22/);
  assert.equal(t.q('[data-ov-model="last_click"]').getAttribute('aria-pressed'), 'true');
  t.q('[data-ov-model="last_non_direct"]').focus();
  await t.click('[data-ov-model="last_non_direct"]');
  const lastReq = t.calls.read.filter(c => c.req.resource === 'attribution-aggregate').at(-1).req;
  assert.equal(lastReq.filters.model, 'last_non_direct');
  assert.match(sec(), /222,22/);
  assert.doesNotMatch(sec(), /123,45/);
  assert.doesNotMatch(sec(), /345,67/, 'nenhuma soma dos dois modelos');
  assert.equal(t.q('[data-ov-model="last_non_direct"]').getAttribute('aria-pressed'), 'true');
  assert.equal(t.doc.activeElement.getAttribute('data-ov-model'), 'last_non_direct', 'foco permanece no botão escolhido');
  assert.ok(t.tags('attribution-aggregate').includes('fresh'));
  assert.ok(t.section('attribution-aggregate').querySelector('[data-ov-tag="models-alternative"]'));
  assert.ok(t.section('attribution-aggregate').querySelector('[data-ov-tag="sources-not-additive"]'));
});

test('atribuição com modelo diferente do pedido não é exibida', async () => {
  const t = setup();
  const orig = t.server.fixtures.aristo['attribution-aggregate'];
  t.server.fixtures.aristo['attribution-aggregate'] = req => { const e = orig(req); e.data.model = 'last_non_direct'; return e; };
  await t.syncNow();
  assert.equal(t.state('attribution-aggregate'), 'unavailable');
  assert.doesNotMatch(t.text('[data-ov-section="attribution-aggregate"]'), /222,22|123,45/);
});

test('peça sem vínculo fica desconhecida; pedido por pedido bloqueado com motivo', async () => {
  const t = setup();
  await t.syncNow();
  assert.match(t.text('[data-ov-section="attribution-aggregate"]'), /desconhecida \(sem vínculo\)/);
  assert.equal(t.state('attribution-order-if-admitted'), 'unavailable');
  const orders = t.text('[data-ov-section="attribution-order-if-admitted"]');
  assert.match(orders, /bloqueado\/desconhecido/);
  assert.match(orders, /DTO por pedido não admitido para aristo/);
  assert.doesNotMatch(orders, /123,45/, 'não deriva pedido do agregado');
});

test('pedido admitido: só campos do contrato, só o modelo escolhido, sem PII', async () => {
  const t = setup();
  t.server.fixtures.aristo['attribution-order-if-admitted'] = () => ({ state: 'ready', coverage: 'complete', freshness: 'fresh', source: 'own_verified', data: { currency: 'BRL', items: [
    { orderReference: 'ORD-1', model: 'last_click', amountMinor: 9990, source: 'shopify', window: '30d', customerEmail: 'pessoa@exemplo.com', customerName: 'Fulano' },
    { orderReference: 'ORD-2', model: 'last_non_direct', amountMinor: 5000, source: 'shopify', window: '30d' }
  ] } });
  await t.syncNow();
  const orders = t.text('[data-ov-section="attribution-order-if-admitted"]');
  assert.match(orders, /ORD-1/);
  assert.match(orders, /99,90/);
  assert.doesNotMatch(orders, /ORD-2/);
  assert.doesNotMatch(orders, /pessoa@exemplo|Fulano/);
});

test('topo único mostra marca, período, estado por seção e revisão da fonte', async () => {
  const t = setup();
  await t.syncNow();
  assert.equal(t.text('[data-ov-brand]'), 'O Aristocrata');
  assert.equal(t.q('[data-ov-period="from"]').value, PERIOD.from);
  assert.equal(t.q('[data-ov-period="to"]').value, PERIOD.to);
  assert.equal(t.qa('[data-ov-summary]').length, 5);
  assert.match(t.text('[data-ov-source]'), /src-1/);
  assert.match(t.text('[data-ov-summary="attribution-order-if-admitted"]'), /indisponível/);
});

test('período inválido no formulário não dispara leitura', async () => {
  const t = setup();
  await t.syncNow();
  const before = t.calls.context;
  t.q('[data-ov-period="from"]').value = '2026-10-09';
  t.q('[data-ov-period="to"]').value = '2026-10-01';
  t.q('[data-ov-form="period"]').dispatchEvent({ type: 'submit' }); await t.flush();
  assert.equal(t.calls.context, before);
  assert.match(t.text('[data-ov-message]'), /Período inválido/);
});

test('rev2: rótulos legíveis nos blocos genéricos e no estado do link, sem alterar valores', async () => {
  const t = setup();
  await t.syncNow();
  const attr = t.text('[data-ov-section="attribution-aggregate"]');
  assert.match(attr, /Receita/);
  assert.match(attr, /02\/10\/2026/);
  assert.doesNotMatch(attr, /revenueMinor|checkedAt/);
  assert.match(t.text('[data-ov-link-row="l1"]'), /Ativo/);
});

test('rev2: sync não sobrescreve o período enquanto a pessoa edita o campo', async () => {
  const t = setup();
  await t.syncNow();
  const from = t.q('[data-ov-period="from"]');
  from.focus();
  from.value = '2026-09-2';
  await t.syncNow();
  assert.equal(from.value, '2026-09-2');
  assert.equal(t.q('[data-ov-period="to"]').value, PERIOD.to);
});
