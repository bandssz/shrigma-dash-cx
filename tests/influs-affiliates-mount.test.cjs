'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const source = process.env.CRM_C1_FILES_DIRECTORY || path.join(__dirname, '..');
const A = require(path.join(source, 'ui/affiliates-v2/affiliates-v2.js'));
const { Document } = require(path.join(source, 'tests/affiliates-v2/mini-dom.cjs'));
const M = require('../influs-affiliates-mount.js');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
function setup() {
  const document = new Document(), element = document.createElement('section'); document.body.appendChild(element);
  const state = { selection: 'fish', active: true, period: 'P0' };
  const mount = M.bind({ document, element, view: A, getSelection: () => state.selection, isActive: () => state.active, getFilters: () => ({ period: state.period }) });
  return { document, element, state, mount, q: s => element.querySelector(s) };
}
function fixture(brand = 'server-fish') {
  // RAM-only DTO fixture. No transport, auth, storage or mutation implementation.
  const calls = [], creator = { id: 'fixture-creator', brandId: brand, displayName: 'Synthetic creator', provider: 'synthetic', providerId: 'fixture-p1', revision: 1 };
  const context = { contextRevision: 'fixture-c1', sessionRevision: 'fixture-s1', effectiveBrand: brand, principalReference: 'fixture-a1', role: 'write', sourceRevision: 'fixture-src', capabilities: { 'creator.create': true }, pendingOperations: [] };
  const gateway = {
    context: async () => { calls.push('context'); return context; },
    read: async query => {
      calls.push(query);
      const data = query.resource === 'creator-profile' ? { creator } : query.resource === 'own-performance' ? { period: query.filters.period, currency: 'BRL' } : { items: query.resource === 'creators' ? [creator] : [] };
      return { state: 'ready', contextRevision: context.contextRevision, brandId: brand, source: 'own_verified', coverage: 'complete', freshness: 'fresh', collectedAt: '2026-10-06T12:00:00Z', cacheAt: null, error: null, data };
    }
  };
  return { calls, gateway, context, creator };
}
test('missing gateway and consolidated selection stay unavailable with no fabricated data', async () => {
  const x = setup(); try {
    await x.mount.sync(); assert.match(x.element.textContent, /indisponível/); assert.match(x.element.textContent, /Nenhum resultado foi interpretado como zero/); assert.equal(x.q('[data-saf2-creator-id]'), null);
    const f = fixture(); x.state.selection = 'todas'; await x.mount.setGateway(f.gateway, { selection: 'fish', effectiveBrand: 'server-fish' });
    assert.match(x.element.textContent, /Selecione uma marca/); assert.equal(f.calls.length, 0);
  } finally { x.mount.dispose(); }
});
test('explicit binding is mandatory; selected alias cannot invent a server brand', async () => {
  const x = setup(), f = fixture(); try {
    assert.throws(() => x.mount.setGateway(f.gateway), TypeError);
    assert.throws(() => x.mount.setGateway(f.gateway, { selection: 'fish' }), TypeError);
    await x.mount.setGateway(f.gateway, { selection: 'aristo', effectiveBrand: 'server-fish' });
    assert.equal(f.calls.length, 0); assert.match(x.element.textContent, /indisponível/);
  } finally { x.mount.dispose(); }
});
test('real C1 view renders injected reads while every mutation remains closed', async () => {
  const x = setup(), f = fixture(); try {
    f.gateway.beginMutation = f.gateway.submit = f.gateway.receipt = () => { assert.fail('mount must not delegate a mutation or operation method'); };
    await x.mount.setGateway(f.gateway, { selection: 'fish', effectiveBrand: 'server-fish' }); await flush();
    assert.match(x.element.textContent, /Synthetic creator/); assert.ok(f.calls.some(c => c.resource === 'tasks'));
    assert.equal(x.q('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled, true);
  } finally { x.mount.dispose(); }
});
test('foreign authoritative context is refused before any resource read', async () => {
  const x = setup(), f = fixture('foreign-brand'); try {
    await x.mount.setGateway(f.gateway, { selection: 'fish', effectiveBrand: 'server-fish' }); await flush();
    assert.deepEqual(f.calls, ['context']); assert.equal(x.q('[data-saf2-creator-id]'), null); assert.match(x.element.textContent, /Não foi possível confirmar/);
  } finally { x.mount.dispose(); }
});
test('brand change removes the old projection and requires a new matching binding', async () => {
  const x = setup(), f = fixture(); try {
    await x.mount.setGateway(f.gateway, { selection: 'fish', effectiveBrand: 'server-fish' }); await flush();
    const n = f.calls.length; x.state.selection = 'aristo'; await x.mount.sync();
    assert.equal(f.calls.length, n); assert.doesNotMatch(x.element.textContent, /Synthetic creator/); assert.match(x.element.textContent, /indisponível/);
    const g = fixture('server-aristo'); await x.mount.setGateway(g.gateway, { selection: 'aristo', effectiveBrand: 'server-aristo' }); await flush(); assert.match(x.element.textContent, /Synthetic creator/);
  } finally { x.mount.dispose(); }
});
test('period refresh and identical binding retain profile and use updated filters', async () => {
  const x = setup(), f = fixture(), b = { selection: 'fish', effectiveBrand: 'server-fish' }; try {
    await x.mount.setGateway(f.gateway, b); await flush(); x.q('[data-saf2-act="open-profile"]').click(); await flush();
    x.state.period = 'P1'; await x.mount.sync(); await flush();
    assert.ok(x.q('[data-saf2-profile="fixture-creator"]')); assert.ok(f.calls.some(c => c.resource === 'creator-profile' && c.filters.period === 'P1'));
    await x.mount.setGateway(f.gateway, b); await flush(); assert.ok(x.q('[data-saf2-profile="fixture-creator"]'));
  } finally { x.mount.dispose(); }
});
test('brand change and dispose reject a late read without repopulating or replaying', async () => {
  const x = setup(), f = fixture(); let resolveRead;
  const original = f.gateway.read;
  f.gateway.read = q => q.resource === 'creators' ? new Promise(r => { resolveRead = r; }) : original(q);
  const p = x.mount.setGateway(f.gateway, { selection: 'fish', effectiveBrand: 'server-fish' }); await flush();
  x.state.selection = 'aristo'; await x.mount.sync();
  resolveRead(await original({ resource: 'creators', filters: { period: 'P0' } })); await p; await flush();
  assert.doesNotMatch(x.element.textContent, /Synthetic creator/); const n = f.calls.length; x.mount.dispose(); await x.mount.sync();
  assert.equal(x.element.textContent, ''); assert.equal(f.calls.length, n);
});
test('HTML keeps native Creators and old channels, compiles inline hooks, and installs no gateway', () => {
  const fs = require('node:fs'), crypto = require('node:crypto'), vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '../influs.html'), 'utf8');
  const creators = html.slice(html.indexOf('  <div class="sec ativa" id="sec-creators">'), html.indexOf('  <div class="sec" id="sec-afil">'));
  assert.equal(crypto.createHash('sha256').update(creators).digest('hex'), 'af0bf2f2f2c7d41baf796d212b8ceb30d1a92feab7ce4b24959d543cd6a2e79a');
  for (const id of ['canal-parceiros', 'canal-tiktok', 'canal-meli', 'canal-shopee', 'area-candidaturas', 'area-partners']) assert.ok(html.includes('id="' + id + '"'));
  assert.match(html, /let CANAL='parceiros'/);
  assert.match(html, /MARCA=b.dataset.marca;if\(AFFILIATES_MOUNT\)AFFILIATES_MOUNT.sync\(\);pintaMarca\(\);renderTudo\(\)/, 'brand invalidates C1 before a legacy rendering failure can interrupt the handler');
  assert.match(html, /if\(SEC==='afil'&&CANAL==='crm'\)return AFFILIATES_MOUNT\?AFFILIATES_MOUNT.sync\(\):Promise.resolve\(\)/);
  assert.doesNotMatch(html, /\.setGateway\(/);
  const inline = [...html.matchAll(/<script\s*>([\s\S]*?)<\/script>/g)]; assert.ok(inline.length > 0);
  for (const block of inline) assert.doesNotThrow(() => new vm.Script(block[1]));
});
