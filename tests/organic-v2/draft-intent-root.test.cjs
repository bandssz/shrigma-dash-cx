'use strict';
// Root source-only regression tests: local draft ownership and archived-result guard.
// Memory gateway/DOM only; no production/native delivery evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./harness.cjs');
const phase = t => t.q('[data-ov-op]').getAttribute('data-ov-op');

test('Root2 unchanged duplicate input events still close only the confirmed original draft', async () => {
  const t = setup();
  try {
    await t.syncNow(); await t.review();
    const campaign = t.q('[data-ov-draft="campaign"]');
    campaign.dispatchEvent({ type: 'input' }); campaign.dispatchEvent({ type: 'change' });
    await t.click('[data-ov-action="op-confirm"]');
    assert.equal(phase(t), 'confirmed');
    assert.equal(campaign.value, ''); assert.equal(t.calls.submit.length, 1);
  } finally { t.inst.dispose(); }
});

test('Root2 editing then restoring prepared text creates a later draft and preserves it', async () => {
  const t = setup();
  try {
    await t.syncNow(); await t.review(); t.hold('submit', { eager: true });
    t.q('[data-ov-action="op-confirm"]').click(); await t.flush();
    t.draft({ campaign: 'edited-later' }); t.draft({ campaign: 'kit_novo' });
    t.release('submit'); await t.flush();
    assert.equal(phase(t), 'confirmed');
    assert.equal(t.q('[data-ov-draft="campaign"]').value, 'kit_novo');
    assert.equal(t.calls.beginMutation.length, 1); assert.equal(t.calls.submit.length, 1);
  } finally { t.inst.dispose(); }
});

test('Root2 receipt confirmation after lost ACK preserves a newer draft and same attempt', async () => {
  const t = setup();
  try {
    await t.syncNow(); await t.review(); t.modes.submit = 'lose-ack';
    await t.click('[data-ov-action="op-confirm"]'); assert.equal(phase(t), 'uncertain');
    t.draft({ campaign: 'receipt-new-draft' }); await t.click('[data-ov-action="receipt"]');
    assert.equal(phase(t), 'confirmed');
    assert.equal(t.q('[data-ov-draft="campaign"]').value, 'receipt-new-draft');
    assert.equal(t.calls.beginMutation.length, 1); assert.equal(t.calls.submit.length, 1);
    assert.deepEqual(t.calls.receipt.map(x => x.operationId), ['op-1']);
  } finally { t.inst.dispose(); }
});

test('Root2 archived result refuses copy even if an obsolete copy control is presented', async () => {
  const t = setup();
  try {
    t.server.links.aristo.push({ id: 'archived-root', brandId: 'aristo', destination: 'https://oaristocrata.com/products/novo', url: 'https://oaristocrata.com/products/novo?utm_source=instagram_social&utm_medium=story&utm_campaign=20261005_kit_novo', state: 'archived', revision: 5 });
    await t.syncNow(); await t.review(); await t.click('[data-ov-action="op-confirm"]');
    assert.equal(phase(t), 'confirmed'); assert.ok(t.q('[data-ov-op-state="archived-existing"]'));
    assert.equal(t.q('[data-ov-action="copy-result"]'), null);
    const obsolete = t.doc.createElement('button'); obsolete.setAttribute('data-ov-action', 'copy-result');
    t.host.firstChild.appendChild(obsolete); obsolete.click(); await t.flush();
    assert.deepEqual(t.doc.clipboardWrites, []);
    assert.equal(t.calls.submit.length, 1);
  } finally { t.inst.dispose(); }
});
