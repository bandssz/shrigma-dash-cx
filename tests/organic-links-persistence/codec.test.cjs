'use strict';
// Codec puro: montagem da URL no backend, datas, hash do intento original, recibo, projeção e envelope 1.0.2 conferido
// pelo normalizador REAL (CRM_C2_ORGANIC_LINKS_CONTEXT obrigatório).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const codec = require(path.join(__dirname, '..', '..', 'services', 'dashboard-operational', 'domain', 'organic-links-persistence', 'codec.cjs'));
const { loadNormalizer } = require('./normalizer-context.cjs');

const base = { brand: 'fish', destination: 'https://fishermans.com.br/products/kit-duas-aguas', origin: 'instagram_social', surface: 'story', campaign: 'kit_duas_aguas', date: '2026-09-16' };

test('URL montada no backend igual à planilha legada, com e sem data, preservando query canônica do destino', () => {
  assert.equal(codec.buildLink(base).value.url, 'https://fishermans.com.br/products/kit-duas-aguas?utm_source=instagram_social&utm_medium=story&utm_campaign=20260916_kit_duas_aguas');
  const sem = codec.buildLink(Object.assign({}, base, { date: null, campaign: 'bio_fixa', destination: 'https://fishermans.com.br/?ref=x' })).value;
  assert.equal(sem.url, 'https://fishermans.com.br/?ref=x&utm_source=instagram_social&utm_medium=story&utm_campaign=bio_fixa');
  assert.equal(sem.utmCampaign, 'bio_fixa');
  const www = codec.buildLink(Object.assign({}, base, { brand: 'aristo', destination: 'https://www.oaristocrata.com/products/x', surface: 'direct' })).value;
  assert.equal(www.url, 'https://www.oaristocrata.com/products/x?utm_source=instagram_social&utm_medium=direct&utm_campaign=20260916_kit_duas_aguas');
});

test('regras adversariais do destino e listas fechadas', () => {
  const r = o => codec.buildLink(Object.assign({}, base, o)).reason || 'ok';
  assert.equal(r({ brand: 'olivas' }), 'brand_not_admitted');
  assert.equal(r({ brand: '__proto__' }), 'brand_not_admitted');
  assert.equal(r({ destination: 'https://fishermans.com.br.evil.example/x' }), 'destination_host_not_admitted');
  assert.equal(r({ destination: 'https://xfishermans.com.br/x' }), 'destination_host_not_admitted');
  assert.equal(r({ destination: 'https://a:b@fishermans.com.br/x' }), 'destination_credentials');
  assert.equal(r({ destination: 'https://fishermans.com.br:443/x' }), 'destination_not_canonical');
  assert.equal(r({ destination: 'https://fishermans.com.br/x?UTM_Medium=a' }), 'destination_has_utm');
  assert.equal(r({ destination: 'https://fishermans.com.br/x?q=1&%75tm_term=z' }), 'destination_has_utm');
  assert.equal(r({ destination: 'https://fishermans.com.br/x\ny' }), 'destination_invalid');
  assert.equal(r({ destination: 'javascript:alert(1)' }), 'destination_invalid');
  assert.equal(r({ destination: 'https://fishermans.com.br/' + 'a'.repeat(2000) }), 'destination_invalid');
  assert.equal(r({ origin: 'Instagram_social' }), 'origin_invalid');
  assert.equal(r({ surface: 'stories' }), 'surface_invalid');
  assert.equal(r({ campaign: 'kit=1' }), 'campaign_invalid');
  assert.equal(r({ campaign: 'a'.repeat(61) }), 'campaign_invalid');
  assert.equal(r({ campaign: 'ab' }), 'ok');
});

test('datas reais AAAA-MM-DD sem relógio atual', () => {
  for (const ok of ['2024-02-29', '2026-12-31', '2026-01-01']) assert.equal(codec.validDate(ok), true, ok);
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '1999-12-31', '2026-1-01', '2026-10-05T00:00:00Z', '', null, 20261005]) assert.equal(codec.validDate(bad), false, String(bad));
  assert.equal(codec.buildLink(Object.assign({}, base, { date: '2026-02-29' })).reason, 'date_invalid');
});

test('hash do intento original: estável, sensível a cada campo do vínculo e ao recordId alocado', () => {
  const x = { kind: 'link.create', effectiveBrand: 'fish', recordId: 'r-1', expectedRecordRevision: null, payload: { destination: base.destination, origin: 'instagram_social', surface: 'story', campaign: 'k1', date: null } };
  const reordered = { payload: { date: null, campaign: 'k1', surface: 'story', origin: 'instagram_social', destination: base.destination }, recordId: 'r-1', effectiveBrand: 'fish', kind: 'link.create', expectedRecordRevision: null };
  assert.equal(codec.intentHash(x), codec.intentHash(reordered));
  assert.match(codec.intentHash(x), /^[0-9a-f]{64}$/);
  for (const patch of [{ recordId: 'r-2' }, { effectiveBrand: 'aristo' }, { payload: Object.assign({}, x.payload, { campaign: 'k2' }) }, { payload: Object.assign({}, x.payload, { date: '2026-10-05' }) }]) {
    assert.notEqual(codec.intentHash(Object.assign({}, x, patch)), codec.intentHash(x), JSON.stringify(patch));
  }
  const ar = { kind: 'link.archive', effectiveBrand: 'fish', recordId: 'r-1', expectedRecordRevision: 1, payload: {} };
  assert.notEqual(codec.intentHash(ar), codec.intentHash(Object.assign({}, ar, { expectedRecordRevision: 2 })));
});

test('recibo determinístico e projeção pública sem ator/operação', () => {
  const op = { operationId: 'op-1', brand: 'fish', kind: 'link.create', intentHash: 'a'.repeat(64), outcome: 'confirmed', reason: null, resultRevision: 1 };
  assert.equal(codec.receiptReference(op), codec.receiptReference(Object.assign({}, op)));
  assert.notEqual(codec.receiptReference(op), codec.receiptReference(Object.assign({}, op, { outcome: 'rejected', reason: 'url_conflict_active', resultRevision: null })));
  const p = codec.publicLink({ link_id: 'l1', brand: 'fish', destination: 'd', url: 'u', origin: 'o', surface: 's', campaign: 'c', campaign_date: null, utm_campaign: 'c', state: 'active', revision: 1,
    created_at: '2026-10-06T12:00:00.000Z', actor_reference: 'segredo', created_operation_id: 'op-1' });
  assert.doesNotMatch(JSON.stringify(p), /segredo|op-1/);
});

test('envelope 1.0.2 (confirmado, recusado, incerto) é aceito pelo normalizador REAL com o intento original', () => {
  const N = loadNormalizer();
  const intent = { kind: 'link.archive', contextRevision: 'ctx-r1', effectiveBrand: 'fish', payload: {}, recordId: 'l1', expectedRecordRevision: 1 };
  const binding = { effectiveBrand: 'fish', kind: 'link.archive', recordId: 'l1', expectedRecordRevision: 1, payload: {} };
  const link = { id: 'l1', brandId: 'fish', destination: 'https://fishermans.com.br/x', url: 'https://fishermans.com.br/x?utm_source=youtube&utm_medium=feed&utm_campaign=ab', origin: 'youtube', surface: 'feed',
    campaign: 'ab', date: null, utmCampaign: 'ab', state: 'archived', revision: 2, createdAt: '2026-10-06T12:00:00.000Z' };
  const cases = [
    [{ outcome: 'confirmed', operationId: 'op-9', binding, receiptReference: 'olr1-' + 'b'.repeat(40), link, reason: null }, 'confirmed'],
    [{ outcome: 'rejected', operationId: 'op-9', binding, receiptReference: 'olr1-' + 'c'.repeat(40), link: null, reason: 'revision_conflict' }, 'rejected'],
    [{ outcome: 'uncertain', operationId: 'op-9', binding }, 'uncertain']
  ];
  for (const [res, state] of cases) {
    const n = N.normalizeOperation(Object.assign({ operationId: 'op-9' }, intent), codec.toOperationEnvelope(res, 'ctx-r1'));
    assert.equal(n.state, 'valid', state);
    assert.equal(n.value.opState, state);
  }
  const foreign = N.normalizeOperation(Object.assign({ operationId: 'op-9' }, intent), codec.toOperationEnvelope(Object.assign({}, cases[0][0], { operationId: 'op-x' }), 'ctx-r1'));
  assert.equal(foreign.reason, 'operation_id_mismatch');
  assert.equal(codec.toOperationEnvelope({ outcome: 'refused', reason: 'authority_denied' }, 'ctx-r1'), null, 'recusa pré-SQL não vira envelope de operação');
});
