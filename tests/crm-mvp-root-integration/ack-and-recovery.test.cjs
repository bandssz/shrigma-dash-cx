'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Explicit public source roots: no Auth, runtime substitution or transport.
assert.equal(typeof process.env.CRM_CONTEXT_DIRECTORY, 'string');
const K = require(path.join(process.env.CRM_CONTEXT_DIRECTORY, 'domain/audience-slices/kernel.cjs'));
const D = require(path.join(process.env.CRM_CONTEXT_DIRECTORY, 'services/dashboard-operational/domain/deliverability/policy.cjs'));
const B = require('../../services/dashboard-operational/domain/crm-mvp-controls/boundary.cjs');

const uuid = n => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fingerprint = n => String(n).repeat(64);
const now = 200000;
const clone = x => structuredClone(x);

function scenario({brand = 'fish', operation = 10, members = [30], distribution = 1} = {}) {
  const d = {schema: K.VERSION, brand, id: uuid(distribution), revision: 1,
    key: fingerprint(1), identity_contract: K.IDENTITY, algorithm: K.ALGORITHM};
  const plan = {schema: K.VERSION, brand, distribution_id: d.id,
    distribution_revision: 1, key_hash: K.keyHash(d),
    slices: [{id: uuid(2), name: 'QA synthetic full slice', from_bp: 0, to_bp: 10000}]};
  const snapshot = {schema: 'crm-audience-slice-source-v1', brand,
    audience_id: uuid(3), audience_revision: 1, definition_hash: fingerprint(2),
    snapshot_id: uuid(4), source_hash: fingerprint(3),
    observed_at: new Date(now).toISOString(), expires_at: new Date(now + 45000).toISOString(),
    complete: true, identity_complete: true, members: members.map(uuid)};
  const claims = {schema: 'crm-audience-slice-claims-v1', brand, distribution_id: d.id,
    distribution_revision: 1, key_hash: plan.key_hash, revision: 1, complete: true, claims: []};
  const selection = {plan, distribution: d, slice_id: uuid(2), snapshot, claims};
  const before = K.select({...selection, now});
  assert.equal(before.state, 'prepared');
  const campaign = {brand, campaign_id: 80, campaign_version: 1,
    content_hash: fingerprint(4), audience_definition_hash: fingerprint(2)};
  const guards = {brand, campaign_id: 80, campaign_version: 1,
    content_hash: fingerprint(4), definition_hash: fingerprint(2), members_hash: before.members_hash,
    observed_at: snapshot.observed_at, expires_at: snapshot.expires_at,
    content_current: true, consent_current: true, bounce_current: true, frequency_current: true};
  const policy = D.createPolicy({brand, softBounceAttempts: 3, providers: ['synthetic'],
    verifyClassifiedEvent: e => e, clock: () => now});
  const evidence = {brand, membersHash: before.members_hash, campaignId: 80,
    campaignVersion: 1, ledgerRevision: 1, revision: 1, observedAt: now,
    expiresAt: now + 45000, authority: 'admitted', suspension: 'clear',
    members: members.map(n => ({subjectId: uuid(n), recipientRef: fingerprint(n === 30 ? 5 : 6),
      consent: 'current', consentRevision: 1, capping: 'clear', cappingRevision: 1,
      bounce: 'current', policyState: policy.initialState(), policyRevision: 0}))};
  return {operationId: uuid(operation), selection, before, campaign, beforeCampaign: campaign, guards, evidence};
}

// Contract simulator only. It is NOT a central database, authority or durable proof.
// Registered records are explicit; a missing record never becomes registered.
function centralContractFixture({normalizeScope = false, loseAck = false} = {}) {
  const registrations = new Map(), results = new Map(), memberReservations = new Set();
  const metrics = {inspect: 0, reserve: 0, commits: 0, evaluated: 0, outcome: 0};
  const operationKey = i => `${i.brand}/${i.operationId}/${i.attemptId}`;
  const identity = live => ({brand: live.selection.plan.brand, operationId: live.operationId, attemptId: live.operationId});
  let beforeEvaluation = () => {}, returnScope = s => s, returnReceipt = r => r;
  const adapter = {
    contractVersion: B.VERSION,
    async inspectOperation(i) {
      metrics.inspect++;
      const key = operationKey(i);
      return clone(results.get(key) || registrations.get(key) || {...i, state: 'absent'});
    },
    async reserveOperation(i) {
      metrics.reserve++;
      const key = operationKey(i), record = registrations.get(key);
      if (results.has(key)) return clone(results.get(key));
      if (!record || record.reservationAttempted || record.revision !== i.expectedOperationRevision)
        return {...i, state: 'refused'};
      record.reservationAttempted = true; // one-time fence survives boundary recreation in this fixture only.
      beforeEvaluation(record.live);
      metrics.evaluated++;
      const decision = i.evaluate(clone(record.live));
      if (decision.state !== 'eligible-for-reservation') return {...i, state: 'refused'};
      const recipients = record.live.evidence.members.map(m => `${i.brand}/${m.recipientRef}`);
      if (recipients.some(k => memberReservations.has(k))) return {...i, state: 'refused'};
      recipients.forEach(k => memberReservations.add(k));
      const scope = normalizeScope
        ? Object.fromEntries(Object.entries(decision.scope).sort(([a], [b]) => a.localeCompare(b)))
        : decision.scope;
      const result = {brand: i.brand, operationId: i.operationId, attemptId: i.attemptId,
        state: 'reserved', revision: 2, outcomeWriteState: 'idle', scope: clone(returnScope(scope)),
        reservedMemberCount: decision.scope.memberCount, reservedMembersHash: decision.scope.membersHash,
        capacityEvidenceHash: decision.scope.evidenceHash, atomic: true, idempotent: true,
        durable: true, reservation: true, receiptHash: fingerprint(7)};
      results.set(key, result); metrics.commits++;
      if (loseAck) throw new Error('QA synthetic lost response after memory commit');
      return returnReceipt(clone(result));
    },
    async recordOutcome(i) {
      metrics.outcome++;
      const record = results.get(operationKey(i));
      if (!record || !record.reservation || record.revision !== i.expectedOperationRevision || record.outcomeWriteState !== 'idle') return null;
      const state = i.outcome === 'unknown' ? 'uncertain' : i.outcome;
      if (['accepted', 'rejected_before_send'].includes(record.state) && record.state !== state) return null;
      record.state = state; record.revision++;
      return clone(record);
    }
  };
  return {adapter, metrics, identity,
    register(live) {
      const i = identity(live);
      registrations.set(operationKey(i), {...i, state: 'registered', durable: true,
        reservationAttempted: false, revision: 1, receiptHash: fingerprint(8), live: clone(live)});
      return i;
    },
    options: () => ({enabled: true, kernel: K, deliverability: D, adapter, clock: () => now}),
    beforeEvaluation: f => {beforeEvaluation = f;},
    mutateReturnedScope: f => {returnScope = f;},
    mutateReturnedReceipt: f => {returnReceipt = f;}
  };
}

test('QA: default OFF cannot consult, reserve or record through an otherwise complete adapter', async () => {
  const f = centralContractFixture(), i = f.register(scenario());
  const b = B.create({...f.options(), enabled: false});
  for (const result of [await b.reserve(i), await b.consult(i), await b.recordOutcome(i, 'accepted')]) {
    assert.equal(result.state, 'closed'); assert.equal(result.authorizesSend, false);
  }
  assert.deepEqual(f.metrics, {inspect: 0, reserve: 0, commits: 0, evaluated: 0, outcome: 0});
});

test('QA: missing registration never acquires a synthetic reserve capability', async () => {
  const f = centralContractFixture(), b = B.create(f.options());
  const result = await b.reserve(f.identity(scenario()));
  assert.equal(result.state, 'closed'); assert.equal(f.metrics.reserve, 0); assert.equal(f.metrics.commits, 0);
});

test('QA: durable acknowledgement of equal scope survives storage field reordering', async () => {
  const f = centralContractFixture({normalizeScope: true}), i = f.register(scenario());
  const result = await B.create(f.options()).reserve(i);
  // A JSON object has no semantic property order. The scope's keys/values did not change.
  assert.equal(f.metrics.commits, 1);
  assert.equal(result.state, 'reserved', 'a confirmed equal scoped receipt must not become an unknown ACK');
  assert.equal(result.authorizesSend, false);
});

test('QA: changed evidence scope remains unconfirmed, retaining the original operation', async () => {
  const f = centralContractFixture(), i = f.register(scenario());
  f.mutateReturnedScope(s => ({...s, evidenceHash: fingerprint(9)}));
  const result = await B.create(f.options()).reserve(i);
  assert.equal(result.state, 'closed'); assert.equal(result.operationId, i.operationId);
  assert.equal(result.action, 'consult_original'); assert.equal(result.automaticReplay, false);
});

test('QA: lost response and boundary recreation never reserve the original operation twice', async () => {
  const f = centralContractFixture({loseAck: true}), i = f.register(scenario());
  const original = await B.create(f.options()).reserve(i);
  assert.equal(original.action, 'consult_original'); assert.equal(original.newAttemptAllowed, false);
  const restarted = B.create(f.options());
  assert.equal((await restarted.consult(i)).state, 'reserved');
  assert.equal((await restarted.reserve(i)).state, 'reserved');
  assert.equal(f.metrics.reserve, 1); assert.equal(f.metrics.commits, 1);
  const wrongBrand = {...i, brand: 'aristo'};
  assert.equal((await restarted.consult(wrongBrand)).state, 'closed');
  assert.equal((await restarted.recordOutcome(wrongBrand, 'accepted')).state, 'closed');
  assert.equal((await restarted.recordOutcome(i, 'unknown')).state, 'uncertain');
  assert.equal((await restarted.recordOutcome(i, 'accepted')).state, 'accepted');
  assert.equal((await restarted.recordOutcome(i, 'unknown')).state, 'closed');
});

test('QA: revocation or capping change after review vetoes the first transactional evaluation', async () => {
  for (const field of ['consent', 'capping']) {
    const f = centralContractFixture(), live = scenario(), i = f.register(live), b = B.create(f.options());
    assert.equal(b.decide(live).state, 'eligible-for-reservation');
    f.beforeEvaluation(current => {current.evidence.members[0][field] = 'revoked';});
    assert.equal((await b.reserve(i)).state, 'closed');
    assert.equal(f.metrics.evaluated, 1); assert.equal(f.metrics.commits, 0);
  }
});

test('QA: overlapping selections in different distributions cannot consume the same member twice', async () => {
  const f = centralContractFixture(), b = B.create(f.options());
  const a = f.register(scenario({operation: 11, distribution: 1, members: [30]}));
  const c = f.register(scenario({operation: 12, distribution: 9, members: [30, 31]}));
  assert.equal((await b.reserve(a)).state, 'reserved');
  assert.equal((await b.reserve(c)).state, 'closed');
  assert.equal(f.metrics.evaluated, 2); assert.equal(f.metrics.commits, 1);
  // This proves contract cooperation with a strict MEMORY adapter, not production atomicity.
});


test('QA: missing or invalid reservation ACK revision cannot confirm a reservation', async () => {
  for (const revision of [undefined, 0, '2', -1]) {
    const f = centralContractFixture(), i = f.register(scenario());
    f.mutateReturnedReceipt(r => {if (revision === undefined) delete r.revision; else r.revision = revision; return r;});
    const result = await B.create(f.options()).reserve(i);
    assert.equal(f.metrics.commits, 1);
    assert.equal(result.state, 'closed', 'a receipt without a positive typed revision must remain unconfirmed');
    assert.equal(result.action, 'consult_original');
  }
});

test('QA: changing caller identity during lookup cannot replace the captured original', async () => {
  const f = centralContractFixture(), mutable = f.register(scenario()), expected = clone(mutable);
  const read = f.adapter.inspectOperation; let release;
  const delay = new Promise(resolve => {release = resolve;});
  f.adapter.inspectOperation = async i => {await delay; return read(i);};
  const pending = B.create(f.options()).reserve(mutable);
  mutable.brand = 'aristo'; mutable.operationId = uuid(90); mutable.attemptId = uuid(90);
  release();
  const result = await pending;
  assert.equal(result.state, 'reserved'); assert.equal(result.operationId, expected.operationId);
  assert.equal(result.attemptId, expected.attemptId); assert.equal(f.metrics.commits, 1);
});

test('QA: lost outcome ACK after commit is recovered without a second writer, including recreation', async () => {
  const f = centralContractFixture(), i = f.register(scenario()), b = B.create(f.options());
  assert.equal((await b.reserve(i)).state, 'reserved');
  const write = f.adapter.recordOutcome;
  f.adapter.recordOutcome = async input => {await write(input); throw new Error('QA synthetic outcome ACK lost after memory commit');};
  const unknown = await b.recordOutcome(i, 'accepted');
  assert.equal(unknown.action, 'consult_original');
  assert.equal((await b.recordOutcome(i, 'accepted')).state, 'accepted');
  assert.equal((await B.create(f.options()).recordOutcome(i, 'accepted')).state, 'accepted');
  assert.equal(f.metrics.outcome, 1);
  assert.equal((await b.recordOutcome(i, 'rejected_before_send')).state, 'accepted');
  assert.equal(f.metrics.outcome, 1);
});

test('QA: partial member receipt cannot confirm the all-member reservation', async () => {
  const f = centralContractFixture(), i = f.register(scenario({members: [30, 31]}));
  f.mutateReturnedReceipt(r => ({...r, reservedMemberCount: 1}));
  const result = await B.create(f.options()).reserve(i);
  assert.equal(result.state, 'closed'); assert.equal(result.action, 'consult_original');
  assert.equal(f.metrics.commits, 1);
});

test('QA: a hard bounce in one member vetoes the whole selection before reservation', async () => {
  const f = centralContractFixture(), live = scenario({members: [30, 31]});
  const policy = D.createPolicy({brand: 'fish', softBounceAttempts: 3, providers: ['synthetic'],
    verifyClassifiedEvent: e => e, clock: () => now});
  const member = live.evidence.members[1];
  const token = await policy.admitEvent({schema: D.EVENT_VERSION, brand: 'fish', providerId: 'synthetic',
    recipientRef: member.recipientRef, eventId: 'qa-hard', attemptId: 'qa-original',
    classification: 'hard_bounce', occurredAt: now}, {});
  member.policyState = policy.apply(member.policyState, token).state;
  member.policyRevision = member.policyState.revision;
  const i = f.register(live), b = B.create(f.options());
  assert.equal(b.decide(live).reason, 'bounce_veto');
  assert.equal((await b.reserve(i)).state, 'closed'); assert.equal(f.metrics.commits, 0);
});
