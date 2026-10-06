'use strict';
// Ciclo de vida: montagem isolada, sync coalescido, dispose, troca de marca, resposta atrasada e capability.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, PERIOD, Organic, flush } = require('./harness.cjs');
const { Document } = require('./fake-dom.cjs');

const RES = ['posts', 'stories', 'attribution-aggregate', 'attribution-order-if-admitted', 'links'];
const readsOf = (t, r) => t.calls.read.filter(c => c.req.resource === r).length;

test('create exige element/document e monta só um nó próprio dentro do element', () => {
  const doc = new Document();
  assert.throws(() => Organic.create({ document: doc, gateway: {} }), TypeError);
  assert.throws(() => Organic.create({ element: doc.createElement('div'), gateway: {} }), TypeError);
  const t = setup();
  assert.equal(t.host.childNodes.length, 1);
  assert.equal(t.host.firstChild.getAttribute('class'), 'sov2');
  assert.equal(t.doc.body.listenerCount(), 0, 'nenhum listener global');
  assert.equal(t.host.listenerCount(), 0, 'nenhum listener no element do host');
  assert.equal(Organic.contractVersion, '1.0.1-proposed');
  assert.equal(t.calls.context, 0, 'create não lê sozinho; o host chama sync');
});

test('syncs concorrentes equivalentes compartilham uma leitura e nunca chamam mutação', async () => {
  const t = setup();
  t.hold('context');
  const a = t.inst.sync({ filters: { period: PERIOD } });
  const b = t.inst.sync({ filters: { period: PERIOD } });
  const c = t.inst.sync({ filters: { period: PERIOD, brand: 'fish' } }); // marca não é filtro do cliente
  assert.equal(a, b); assert.equal(a, c);
  t.release('context'); await a; await flush();
  assert.equal(t.calls.context, 1);
  for (const r of RES) assert.equal(readsOf(t, r), 1, r + ' lido uma vez');
  assert.ok(t.calls.read.every(c => !('brand' in c.req.filters) && c.req.expectedContextRevision === 'r1'));
  await t.syncNow();
  assert.equal(t.calls.context, 2, 'sync explícito posterior relê');
  for (const r of RES) assert.equal(readsOf(t, r), 2);
  assert.equal(t.mutationCalls(), 0);
});

test('sync com filtro diferente invalida o anterior: abort e resposta antiga ignorada', async () => {
  const t = setup();
  t.hold('read:posts');
  const first = t.inst.sync({ filters: { period: PERIOD } });
  await flush();
  const signal = t.calls.read.find(c => c.req.resource === 'posts').signal;
  const second = t.inst.sync({ filters: { period: { from: '2026-10-01', to: '2026-10-03' } } });
  assert.notEqual(first, second);
  assert.equal(signal.aborted, true, 'leitura antiga abortada');
  await flush();
  t.release('read:posts'); await Promise.all([first, second]); await flush();
  assert.match(t.text('[data-ov-section="posts"]'), /Post aristo 2026-10-03/);
  assert.doesNotMatch(t.text('[data-ov-section="posts"]'), /2026-10-05/);
});

test('dispose remove DOM e listeners, invalida respostas pendentes e não lê de novo', async () => {
  const t = setup();
  const root = t.host.firstChild;
  t.hold('read:links');
  const p = t.inst.sync({ filters: { period: PERIOD } });
  await flush();
  t.inst.dispose();
  assert.equal(t.host.childNodes.length, 0);
  assert.equal(root.listenerCount(), 0);
  t.release('read:links'); await p; await flush();
  assert.equal(t.host.childNodes.length, 0, 'resposta tardia não remonta nada');
  const before = t.calls.context;
  await t.inst.sync({ filters: { period: PERIOD } });
  assert.equal(t.calls.context, before);
  t.inst.dispose(); // idempotente
  assert.equal(t.mutationCalls(), 0);
});

test('troca de marca durante leitura: resposta atrasada não repovoa a nova marca', async () => {
  const t = setup();
  t.hold('read:posts');
  const p1 = t.inst.sync({ filters: { period: PERIOD } });
  await flush();
  t.setCtx({ effectiveBrand: 'fish', contextRevision: 'r2', principalReference: 'p-ana' });
  const p2 = t.inst.sync({ filters: { period: PERIOD } }); // equivalente: compartilha e se recupera
  assert.equal(p1, p2);
  t.release('read:posts'); await p1; await flush();
  assert.equal(t.q('[data-ov-brand]').getAttribute('data-ov-brand'), 'fish');
  assert.match(t.text('[data-ov-section="posts"]'), /Post fish/);
  assert.doesNotMatch(t.text(), /Post aristo|aristo-p1|oaristocrata\.com\/products\/x/);
  assert.equal(t.calls.context, 2, 'uma única releitura de contexto após a divergência');
});

test('troca de marca entre syncs limpa a marca anterior imediatamente e ignora resposta velha', async () => {
  const t = setup();
  await t.syncNow();
  assert.match(t.text('[data-ov-section="posts"]'), /Post aristo/);
  t.hold('read:posts');
  const old = t.inst.sync({ filters: { period: { from: '2026-10-01', to: '2026-10-04' } } });
  await flush();
  t.setCtx({ effectiveBrand: 'fish', contextRevision: 'r2' });
  t.hold('read:stories');
  const next = t.inst.sync({ filters: { period: PERIOD } });
  await flush();
  assert.doesNotMatch(t.text('[data-ov-section="stories"]'), /aristo/, 'dados da marca anterior removidos já na troca de contexto');
  assert.match(t.text('[data-ov-message]'), /Marca alterada/);
  t.release('read:stories'); await flush();
  t.release('read:posts'); await Promise.all([old, next]); await flush();
  assert.match(t.text('[data-ov-section="posts"]'), /Post fish/);
  assert.doesNotMatch(t.text(), /Post aristo/);
});

test('envelope de outra marca é descartado e item de outra marca não aparece', async () => {
  const t = setup();
  const orig = t.server.fixtures.aristo.posts;
  t.server.fixtures.aristo.posts = req => { const e = orig(req); e.data.items.push({ id: 'intruso', brandId: 'fish', title: 'Post intruso', source: 'own_verified' }); return e; };
  t.server.fixtures.aristo.stories = () => ({ state: 'ready', brandId: 'fish', coverage: 'complete', freshness: 'fresh', data: { items: [{ id: 'fs', brandId: 'fish' }] } });
  await t.syncNow();
  assert.doesNotMatch(t.text(), /Post intruso/);
  assert.ok(t.tags('posts').includes('brand-dropped'));
  assert.equal(t.state('stories'), 'discarded');
  assert.match(t.text('[data-ov-summary="posts"]'), /parcial/);
});

test('retirada de capability fecha ações e descarta revisão preparada; papel Mestre não abre gravação', async () => {
  const t = setup();
  await t.syncNow();
  assert.equal(t.q('[data-ov-form="link-create"] button[type="submit"]').disabled, false);
  await t.review();
  assert.equal(t.q('[data-ov-op]').getAttribute('data-ov-op'), 'prepared');
  t.setCtx({ contextRevision: 'r2', role: 'master', capabilities: { 'link.create': { available: false, reason: 'Escrita não admitida para este papel.' } } });
  await t.syncNow();
  assert.equal(t.q('[data-ov-op]').getAttribute('data-ov-op'), '', 'operação do contexto antigo descartada');
  assert.equal(t.q('[data-ov-form="link-create"] button[type="submit"]').disabled, true);
  assert.match(t.text('[data-ov-cap]'), /Escrita não admitida para este papel/);
  assert.ok(t.qa('[data-ov-action="archive"]').every(b => b.disabled));
  assert.equal(t.calls.submit.length, 0);
  t.draft({ campaign: 'x' });
  t.q('[data-ov-form="link-create"]').dispatchEvent({ type: 'submit' }); await flush();
  assert.equal(t.calls.beginMutation.length, 1, 'formulário fechado não prepara nova operação');
});

test('contexto sem marca (revogação) limpa todos os dados e fecha ações', async () => {
  const t = setup();
  await t.syncNow();
  assert.match(t.text(), /Post aristo/);
  t.setCtx({ effectiveBrand: null, contextRevision: 'r9', capabilities: {} });
  await t.syncNow();
  for (const r of RES) assert.equal(t.state(r), 'forbidden');
  assert.doesNotMatch(t.text(), /Post aristo|oaristocrata\.com\/products\/x/);
  assert.equal(t.q('[data-ov-form="link-create"] button[type="submit"]').disabled, true);
});

test('rascunho é preservado no mesmo contexto e descartado ao trocar de marca', async () => {
  const t = setup();
  await t.syncNow();
  t.draft({ campaign: 'rascunho_a' });
  await t.syncNow();
  assert.equal(t.q('[data-ov-draft="campaign"]').value, 'rascunho_a');
  t.setCtx({ effectiveBrand: 'fish', contextRevision: 'r2' });
  await t.syncNow();
  assert.equal(t.q('[data-ov-draft="campaign"]').value, '');
});

test('gateway ausente: tudo indisponível e nenhuma ação aberta', async () => {
  const t = setup(null, { gateway: null });
  await t.inst.sync({ filters: { period: PERIOD } }); await flush();
  for (const r of RES) assert.equal(t.state(r), 'unavailable');
  assert.equal(t.q('[data-ov-form="link-create"] button[type="submit"]').disabled, true);
  assert.match(t.text('[data-ov-cap]'), /não instalada/);
});
