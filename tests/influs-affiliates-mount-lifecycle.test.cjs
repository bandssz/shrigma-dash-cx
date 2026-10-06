'use strict';
// Independent negative proof; only synthetic metadata callbacks, no business records or network.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const source = process.env.CRM_C1_FILES_DIRECTORY || path.join(__dirname, '..');
const C1 = require(path.join(source, 'ui/affiliates-v2/affiliates-v2.js'));
const { Document } = require(path.join(source, 'tests/affiliates-v2/mini-dom.cjs'));
const Mount = require('../influs-affiliates-mount.js');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(r => setImmediate(r)); };
const ctx = { contextRevision: 'qa-only-context', effectiveBrand: 'fish', sessionRevision: 'qa-only-session', principalReference: 'qa-only-principal', role: 'read', sourceRevision: 'qa-only-source', capabilities: {}, pendingOperations: [] };
const envelope = { state: 'unavailable', contextRevision: 'qa-only-context', brandId: 'fish', source: 'unknown', coverage: 'unknown', freshness: 'unknown', collectedAt: null, cacheAt: null, data: null, error: 'Sem fonte operacional nesta prova sintética.' };
function setup() {
  const document = new Document(), element = document.createElement('section'); document.body.appendChild(element);
  const state = { active: true };
  const mount = Mount.bind({ document, element, view: C1, getSelection: () => 'fish', isActive: () => state.active, getFilters: () => ({ period: { start: '2026-10-01', end: '2026-10-06' } }) });
  return { element, state, mount };
}
test('sair durante contexto em voo deve impedir novas leituras de recurso', async () => {
  const s = setup(); let resolveContext, reads = 0;
  const pending = new Promise(resolve => { resolveContext = resolve; });
  const first = s.mount.setGateway({ context: () => pending, read: () => { reads++; return envelope; } }, { selection: 'fish', effectiveBrand: 'fish' });
  await flush(); s.state.active = false; await s.mount.sync(); resolveContext(ctx); await first; await flush();
  try { assert.equal(reads, 0, 'A montagem inativa continuou encaminhando leituras depois da saída.'); }
  finally { s.mount.dispose(); }
});
test('sync inativo deve dispor projeção e listeners do componente já montado', async () => {
  const s = setup();
  try {
    await s.mount.setGateway({ context: () => ctx, read: () => envelope }, { selection: 'fish', effectiveBrand: 'fish' });
    assert.ok(s.element.querySelector('.saf2'));
    s.state.active = false; await s.mount.sync();
    assert.equal(s.element.querySelector('.saf2') === null, true, 'O componente continua retendo a projeção/listeners fora da seção ativa.');
  } finally { s.mount.dispose(); }
});
test('HTML notifica saída de canal ou seção antes de qualquer render legado', () => {
  const fs = require('node:fs'), html = fs.readFileSync(path.join(__dirname, '../influs.html'), 'utf8');
  assert.match(html, /CANAL=c;if\(AFFILIATES_MOUNT\)AFFILIATES_MOUNT.sync\(\);\s*document.querySelectorAll\('#canais button'\)/);
  assert.match(html, /SEC=b.dataset.s;if\(AFFILIATES_MOUNT\)AFFILIATES_MOUNT.sync\(\);\$\('#sec-'\+SEC\)/);
  assert.doesNotMatch(html, /if\(c==='crm'&&AFFILIATES_MOUNT\)AFFILIATES_MOUNT.sync\(\)/);
});
