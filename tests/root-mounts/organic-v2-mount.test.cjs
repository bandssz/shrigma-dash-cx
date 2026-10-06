'use strict';
// Synthetic transport callbacks live ONLY in this test; no adapter or authority is shipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const Mount = require('../../ui/root-mounts/organic-v2-mount.js');
const Organic = require('../../ui/organic-v2/organic-v2.js');
const { Document, flush, submit } = require('./dom-fixture.cjs');
const period = { period: { from: '2026-10-01', to: '2026-10-05' } };
function setup() {
  const document = new Document(), element = document.createElement('div');
  document.body.appendChild(element);
  let scope = 'fish';
  const host = Mount.create({ element, document, component: Organic, getScopeHint: () => scope });
  return { host, element, scope: value => { scope = value; } };
}
function context(brand = 'fish') {
  return { contextRevision: 'fixture-only-context', effectiveBrand: brand, sessionRevision: 'fixture-only-session',
    principalReference: 'fixture-only-principal', role: 'read', sourceRevision: 'fixture-only-source',
    capabilities: {}, pendingOperations: [] };
}
function unavailable(brand = 'fish') {
  return { state: 'unavailable', contextRevision: 'fixture-only-context', brandId: brand,
    source: 'unknown', coverage: 'unknown', freshness: 'unknown', collectedAt: null, cacheAt: null, data: null, error: 'Fixture sem fonte operacional.' };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('gateway ausente ou incompleto não cria o componente nem realiza I/O', async () => {
  const s = setup(), before = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  try {
    await s.host.activate({ filters: period }); await s.host.setGateway({}); await s.host.sync({ filters: period });
    assert.match(s.element.textContent, /Dados indisponíveis/);
    assert.equal(s.element.querySelector('.sov2'), null);
  } finally { s.host.dispose(); globalThis.fetch = before; }
});

test('injeção enquanto aba oculta não consulta; ativação encaminha o adapter original', async () => {
  const s = setup(), calls = [];
  const adapter = {
    context() { assert.equal(this, adapter); calls.push('context'); return context(); },
    read(args) { assert.equal(this, adapter); calls.push(args); return unavailable(); }
  };
  await s.host.setGateway(adapter); assert.deepEqual(calls, []);
  await s.host.activate({ filters: period }); await flush();
  assert.equal(calls[0], 'context'); assert.equal(calls.length, 6);
  for (const request of calls.slice(1)) {
    assert.equal(request.expectedContextRevision, 'fixture-only-context');
    assert.deepEqual(request.filters.period, period.period);
    assert.equal(Object.hasOwn(request.filters, 'brand'), false);
  }
  assert.ok(s.element.querySelector('.sov2')); s.host.dispose();
});

test('contexto de marca divergente não é reescrito nem lê recursos', async () => {
  const s = setup(); let reads = 0;
  await s.host.setGateway({ context: () => context('aristo'), read: () => { reads++; return unavailable('aristo'); } });
  await s.host.activate({ filters: period }); await flush();
  assert.equal(reads, 0); assert.match(s.element.textContent, /marca ou o acesso mudou/i);
  assert.equal(s.element.querySelector('[data-ov-brand="aristo"]'), null); s.host.dispose();
});

test('troca de marca retira gateway e invalida leitura tardia até nova injeção Root', async () => {
  const s = setup(), late = deferred(); let contexts = 0, reads = 0;
  await s.host.setGateway({ context: () => { contexts++; return context(); }, read: () => { reads++; return late.promise; } });
  const first = s.host.activate({ filters: period }); await flush(); assert.equal(reads, 5);
  s.scope('aristo'); await s.host.sync({ filters: period });
  const blocked = s.element.textContent; late.resolve(unavailable()); await first; await flush();
  assert.equal(s.element.textContent, blocked); assert.equal(s.element.querySelector('.sov2'), null);
  await s.host.sync({ filters: period }); assert.equal(contexts, 1); assert.equal(reads, 5); s.host.dispose();
});

test('saída durante contexto em voo descarta resultado sem nova leitura', async () => {
  const s = setup(), late = deferred(); let reads = 0;
  await s.host.setGateway({ context: () => late.promise, read: () => { reads++; return unavailable(); } });
  const first = s.host.activate({ filters: period }); await flush();
  s.host.leave(); late.resolve(context()); await first; await flush();
  assert.equal(reads, 0); assert.equal(s.element.textContent, ''); s.host.dispose();
});

test('retirar adapter preserva mensagem indisponível após resposta antiga', async () => {
  const s = setup(), late = deferred();
  await s.host.setGateway({ context: () => late.promise, read: () => unavailable() });
  const first = s.host.activate({ filters: period }); await flush();
  await s.host.setGateway(null); const blocked = s.element.textContent;
  late.resolve(context()); await first; await flush();
  assert.equal(s.element.textContent, blocked); assert.match(blocked, /Dados indisponíveis/); s.host.dispose();
});

test('dispose é terminal e idempotente; retorno à aba antes dele relê contexto', async () => {
  const s = setup(); let calls = 0;
  const adapter = { context: () => { calls++; return context(); }, read: () => unavailable() };
  await s.host.setGateway(adapter); await s.host.activate({ filters: period });
  s.host.leave(); await s.host.activate({ filters: period }); assert.equal(calls, 2);
  s.host.dispose(); s.host.dispose(); await s.host.setGateway(adapter); await s.host.activate({ filters: period });
  assert.equal(calls, 2); assert.equal(s.element.textContent, '');
});

test('janela inválida fecha consulta e montagem nunca envia mutação', async () => {
  const s = setup(); let reads = 0, writes = 0;
  await s.host.setGateway({ context: () => context(), read: () => { reads++; return unavailable(); },
    beginMutation: () => { writes++; }, submit: () => { writes++; }, receipt: () => { writes++; } });
  await s.host.activate({ filters: { period: { from: '2026-02-30', to: '2026-03-01' } } });
  assert.equal(reads, 0); assert.match(s.element.textContent, /Período indisponível/);
  await s.host.sync({ filters: period }); assert.equal(reads, 5); assert.equal(writes, 0); s.host.dispose();
});

test('refresh legado sem filtros não sobrescreve período selecionado dentro do módulo real', async () => {
  const s = setup(), seen = [];
  await s.host.setGateway({ context: () => context(), read: args => { seen.push(args.filters.period); return unavailable(); } });
  await s.host.activate({ filters: period });
  const form = s.element.querySelector('[data-ov-form="period"]'), dates = form.querySelectorAll('input');
  dates[0].value = '2026-10-02'; dates[1].value = '2026-10-06'; submit(form); await flush();
  seen.length = 0; await s.host.sync();
  assert.equal(seen.length, 5);
  for (const p of seen) assert.deepEqual(p, { from: '2026-10-02', to: '2026-10-06' });
  s.host.dispose();
});
