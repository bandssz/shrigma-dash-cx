'use strict';
// Root integration only: execute the exact compiled normalizer/UI/mount suffix.
// The earlier legacy scripts are outside this test. DOM and read callbacks are
// synthetic RAM fixtures; no browser, server, transport or authority is implied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Document } = require('../organic-v2/fake-dom.cjs');
const root = path.resolve(__dirname, '../..');

test('compiled Organic normalizer precedes consumer/mount; malformed reads stay unavailable and no adapter is assumed', async () => {
  const files = ['ui/organic-v2/organic-contract-v1-0-2.js', 'ui/organic-v2/organic-v2.js', 'ui/root-mounts/organic-v2-mount.js'];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/panel-build/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.organico.scripts.slice(-3), files);
  files.forEach(file => assert.equal(manifest.organico.scripts.filter(p => p === file).length, 1));
  const bundle = fs.readFileSync(path.join(root, 'assets/panels/organico.js'), 'utf8');
  const assignments = ['ShrigmaOrganicContractV102=api', 'ShrigmaOrganicV2=api', 'ShrigmaOrganicRootMount=api'];
  const positions = assignments.map(s => bundle.indexOf(s));
  assert.ok(positions[0] > 0 && positions[0] < positions[1] && positions[1] < positions[2]);
  const start = bundle.lastIndexOf('(function(root,factory)', positions[0]);
  assert.ok(start >= 0);
  const context = vm.createContext({ AbortController });
  vm.runInContext(bundle.slice(start), context, { timeout: 1000, filename: 'organico.js:compiled-component-suffix' });
  assert.equal(context.ShrigmaOrganicContractV102.version, '1.0.2-proposed');
  assert.equal(typeof context.ShrigmaOrganicV2.create, 'function');
  assert.equal(typeof context.ShrigmaOrganicRootMount.create, 'function');
  const hash = crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 12);
  const html = fs.readFileSync(path.join(root, 'organico.html'), 'utf8');
  assert.ok(html.includes('assets/panels/organico.js?v=' + hash));

  const doc = new Document();
  const element = doc.createElement('div'); doc.body.appendChild(element);
  const mount = context.ShrigmaOrganicRootMount.create({ element, document: doc, component: context.ShrigmaOrganicV2, getScopeHint: () => 'aristo' });
  await mount.activate({ filters: { period: { from: '2026-10-01', to: '2026-10-05' }, model: 'last_click' } });
  assert.match(element.textContent, /Dados indisponíveis/);
  assert.equal(element.querySelector('.sov2'), null);

  const reads = []; let contextReads = 0;
  await mount.setGateway({
    context() { contextReads++; return Promise.resolve({ contextRevision: 'fixture-r1', sessionRevision: 'fixture-s1', effectiveBrand: 'aristo', principalReference: 'fixture-principal', role: 'read', sourceRevision: 'fixture-source', capabilities: { 'link.create': { available: false, reason: 'Somente leitura sintética.' }, 'link.archive': { available: false, reason: 'Somente leitura sintética.' } }, pendingOperations: [], operationJournal: { state: 'complete', revision: 'fixture-journal' } }); },
    read(request) {
      reads.push(request.resource);
      // Deliberately missing required collectedAt/cacheAt/error: this is not
      // a typed empty catalog and must never become a known zero.
      return Promise.resolve({ state: 'ready', contextRevision: 'fixture-r1', brandId: 'aristo', source: 'own_verified', coverage: 'complete', freshness: 'fresh', data: { items: [] } });
    }
  });
  assert.equal(contextReads, 1);
  assert.equal(new Set(reads).size, 5);
  assert.match(element.textContent, /Resposta fora do contrato 1\.0\.2 \(envelope_malformed\)/);
  assert.doesNotMatch(element.textContent, /Normalizador do contrato 1\.0\.2 ausente/);
  mount.dispose();
  assert.equal(element.childNodes.length, 0);
});
