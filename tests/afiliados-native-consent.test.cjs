'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const runtime = process.env.DASHBOARD_ACCESS_TEST_RUNTIME || path.resolve(__dirname, '../services/dashboard-operational');
const delegationFile = path.join(runtime, 'crm-native-delegation.cjs');
const {createDelegationStore} = require(delegationFile);
const {createAffiliateNativeConsentStore, TABLE, SCHEMA} = require(runtime + '/afiliados-native-consent.cjs');
const h = x => crypto.createHash('sha256').update(x).digest('hex');
const O = 'synthetic-owner', OTHER = 'synthetic-other-owner', HOST = 'manager.synthetic.invalid';
function fixture(t, {brands = ['fish', 'aristo'], scopes = ['crm.read'], health = false} = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY);');
  db.prepare('INSERT INTO users VALUES(?)').run(O); db.prepare('INSERT INTO users VALUES(?)').run(OTHER);
  let clock = 1780000000000, consentCalls = 0, bindingCalls = 0;
  const identities = new Map([[O, {role: 'superadmin', active: true, revision: h('owner-revision'), canEditGrowth: true}],
    [OTHER, {role: 'superadmin', active: true, revision: h('other-revision'), canEditGrowth: true}]]);
  const browser = {host: HOST, method: 'POST', origin: 'https://' + HOST, csrf: 'synthetic-original-csrf', userId: O};
  const consent = context => {
    consentCalls++;
    if (!context || context.nativeBearer !== undefined || context.method !== 'POST' || context.host !== HOST ||
        context.origin !== 'https://' + HOST || context.csrf !== 'synthetic-original-csrf') throw Object.assign(new Error('SYNTHETIC_ORIGINAL_CSRF_REFUSED'), {code: 'SYNTHETIC_ORIGINAL_CSRF_REFUSED'});
    return {userId: context.userId, sessionHash: h('synthetic-session:' + context.userId)};
  };
  const mac = value => crypto.createHmac('sha256', 'ephemeral-fixture-secret').update(value).digest('hex');
  const identity = id => identities.get(id), now = () => clock;
  const connections = createDelegationStore({db, managerHost: HOST, consent, identity, mac, now});
  const issued = connections.issue({context: browser, brands, scopes, expiresDays: 1});
  const bindingByBrand = new Map(['fish', 'aristo'].map(brand => [brand, {
    ownerId: O, ownerRevision: identities.get(O).revision,
    credentialBindingHash: h('synthetic-slot:' + brand), resourceHash: h('synthetic-resource:' + brand)}]));
  let bindingHook = (_ctx, brand) => ({...bindingByBrand.get(brand)});
  const currentBinding = (ctx, brand) => { bindingCalls++; return bindingHook(ctx, brand); };
  if (health) connections.permitDeliveryHealth({context: browser, connectionId: issued.connection.id, binding: {
    schema: 'shrigma-delivery-health-consent-v1', ownerId: O, ownerRevision: identities.get(O).revision,
    brand: 'fish', crmBindingHash: h('crm'), profileRevision: 1, credentialBindingHash: h('health-slot'), resourceHash: h('health-resource'), queryHash: h('health-query')}});
  const store = createAffiliateNativeConsentStore({db, connections, consent, identity, currentBinding, mac, now});
  const native = brand => ({context: connections.context(issued.token, {scope: 'crm.read', brand}), connectionId: issued.connection.id, brand});
  const request = (brand = 'fish', prior = null) => ({context: browser, connectionId: issued.connection.id, brand, optIn: true, expectedReceiptHash: prior});
  const originalState = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'crm_native_%' ORDER BY name").all()
    .map(r => [r.name, JSON.stringify(db.prepare('SELECT * FROM ' + r.name + ' ORDER BY rowid').all())]));
  return {db, connections, issued, store, browser, native, request, originalState, identities, bindingByBrand, consent,
    bindingHook: hook => {bindingHook = hook;}, advance: n => {clock += n;}, clock: () => clock,
    calls: () => ({consentCalls, bindingCalls})};
}
const refuses = (fn, code) => assert.throws(fn, error => error.code === code);
const rows = f => f.db.prepare('SELECT * FROM ' + TABLE + ' ORDER BY brand,version').all();
const permit = f => f.store.permitRead(f.request());

test('actual original delegation source is pinned; this is synthetic SQLite, not production authority', () => {
  assert.equal(h(fs.readFileSync(delegationFile)), '5f4b3342e43f15c332475d2b9b03ccfbc48d336d3936a1802d171a6ec8ad2230');
});
test('crm.read real authentication alone never authorizes Affiliate READ', t => {
  const f = fixture(t); assert.equal(f.connections.authenticate(f.issued.token, {scope: 'crm.read', brand: 'fish'}).id, f.issued.connection.id);
  refuses(() => f.store.verify(f.native('fish')), 'AFFILIATE_NATIVE_CURRENT_CONSENT_REQUIRED'); assert.equal(rows(f).length, 0);
});
test('own browser receipt permits same native connection and brand; scopes/health/audit stay byte-identical', t => {
  const f = fixture(t, {health: true}), before = f.originalState();
  const healthQ = {context: f.connections.context(f.issued.token, {scope: 'crm.delivery-health', brand: 'fish'}), connectionId: f.issued.connection.id, brand: 'fish'};
  const healthBefore = f.connections.deliveryHealthConsent(healthQ), receipt = permit(f), proof = f.store.verify(f.native('fish'));
  assert.equal(receipt.version, 1); assert.equal(proof.schema, SCHEMA); assert.equal(proof.readOnly, true);
  assert.equal(proof.receiptHash, receipt.receiptHash); assert.deepEqual(f.originalState(), before);
  assert.deepEqual(f.connections.deliveryHealthConsent(healthQ), healthBefore);
  const stored = JSON.stringify(rows(f)); assert.equal(stored.includes(f.issued.token), false); assert.equal(stored.includes('ephemeral-fixture-secret'), false);
});
test('inspection returns only a version CAS and cannot grant an absent receipt', t => {
  const f = fixture(t), q = {context: f.browser, connectionId: f.issued.connection.id, brand: 'fish'};
  const first = f.store.inspect(q); assert.deepEqual(first, {schema: SCHEMA, connectionId: q.connectionId, brand: 'fish', version: 0, receiptHash: null});
  assert.equal(Object.hasOwn(first, 'authorized'), false); const receipt = permit(f);
  assert.equal(f.store.inspect(q).receiptHash, receipt.receiptHash);
});
test('opt-in, exact request keys and original POST/CSRF are all mandatory', t => {
  const f = fixture(t);
  for (const mutate of [q => q.optIn = false, q => q.optIn = 'true']) {
    const q = f.request(); mutate(q); refuses(() => f.store.permitRead(q), 'AFFILIATE_NATIVE_EXPLICIT_CONSENT_REQUIRED');
  }
  for (const context of [{...f.browser, method: 'GET'}, {...f.browser, nativeBearer: f.issued.token}, {...f.browser, csrf: ''}])
    refuses(() => f.store.permitRead({...f.request(), context}), 'AFFILIATE_NATIVE_BROWSER_CONSENT_REQUIRED');
  refuses(() => f.store.permitRead({...f.request(), context: {...f.browser, csrf: 'forged'}}), 'SYNTHETIC_ORIGINAL_CSRF_REFUSED');
  for (const extra of ['ownerId', 'binding', 'credential', 'resourceHash', 'scopes'])
    refuses(() => f.store.permitRead({...f.request(), [extra]: 'forged'}), 'AFFILIATE_NATIVE_INPUT_REFUSED');
  assert.equal(rows(f).length, 0);
});
test('connection owner and existing brand/scope must match; no brand or scope expansion', t => {
  const f = fixture(t, {brands: ['fish']});
  refuses(() => f.store.permitRead(f.request('aristo')), 'AFFILIATE_NATIVE_CONNECTION_REFUSED');
  refuses(() => f.store.permitRead({...f.request(), context: {...f.browser, userId: OTHER}}), 'AFFILIATE_NATIVE_CONNECTION_REFUSED');
  const noRead = fixture(t, {scopes: ['db.inspect']}); refuses(() => noRead.store.permitRead(noRead.request()), 'AFFILIATE_NATIVE_CONNECTION_REFUSED');
  assert.equal(rows(f).length, 0); assert.equal(rows(noRead).length, 0);
});
test('owner inactive, non-superadmin or stale revision closes consent and native read', t => {
  const f = fixture(t); permit(f);
  for (const change of [{active: false}, {role: 'manager'}, {revision: h('new-owner-revision')}]) {
    const before = {...f.identities.get(O)}; Object.assign(f.identities.get(O), change);
    assert.throws(() => f.store.permitRead(f.request()), e => /^AFFILIATE_NATIVE_/.test(e.code));
    assert.throws(() => f.store.verify({context: {host: HOST, nativeBearer: f.issued.token}, connectionId: f.issued.connection.id, brand: 'fish'}));
    f.identities.set(O, before);
  }
  assert.equal(rows(f).length, 1);
});
test('binding comes only from real private hook and must match owner/revision/exact hashes', t => {
  const f = fixture(t), base = {...f.bindingByBrand.get('fish')};
  for (const value of [null, {...base, ownerId: OTHER}, {...base, ownerRevision: h('stale')}, {...base, credentialBindingHash: 'forged'}, {...base, secret: 'never accepted'}]) {
    f.bindingHook(() => value); refuses(() => permit(f), 'AFFILIATE_NATIVE_BINDING_REFUSED');
  }
  f.bindingHook(() => Promise.resolve(base)); refuses(() => permit(f), 'AFFILIATE_NATIVE_BINDING_REFUSED'); assert.equal(rows(f).length, 0);
});
test('same receipt is not silently renewed and duplicate initial CAS cannot rearm it', t => {
  const f = fixture(t), receipt = permit(f), before = JSON.stringify(rows(f));
  refuses(() => permit(f), 'AFFILIATE_NATIVE_RECEIPT_CHANGED');
  refuses(() => f.store.permitRead(f.request('fish', receipt.receiptHash)), 'AFFILIATE_NATIVE_CONSENT_ALREADY_CURRENT');
  assert.equal(JSON.stringify(rows(f)), before);
});
test('rotated key requires new browser consent and prior-version CAS; history is untouched', t => {
  const f = fixture(t), first = permit(f), old = JSON.stringify(rows(f)[0]), original = f.originalState();
  f.bindingByBrand.get('fish').credentialBindingHash = h('rotated-private-key-binding');
  refuses(() => f.store.verify(f.native('fish')), 'AFFILIATE_NATIVE_CURRENT_CONSENT_REQUIRED');
  refuses(() => f.store.permitRead(f.request()), 'AFFILIATE_NATIVE_RECEIPT_CHANGED');
  const second = f.store.permitRead(f.request('fish', first.receiptHash));
  assert.equal(second.version, 2); assert.notEqual(second.receiptHash, first.receiptHash); assert.equal(JSON.stringify(rows(f)[0]), old);
  assert.equal(rows(f)[1].prior_receipt_hash, first.receiptHash); assert.deepEqual(f.originalState(), original);
  assert.equal(f.store.verify(f.native('fish')).receiptHash, second.receiptHash);
  // Returning to a former private binding must NOT fall back to its old receipt.
  f.bindingByBrand.get('fish').credentialBindingHash = h('synthetic-slot:fish');
  refuses(() => f.store.verify(f.native('fish')), 'AFFILIATE_NATIVE_CURRENT_CONSENT_REQUIRED');
});
test('different brand needs its own receipt; current resource drift closes only affected brand', t => {
  const f = fixture(t); permit(f);
  refuses(() => f.store.verify(f.native('aristo')), 'AFFILIATE_NATIVE_CURRENT_CONSENT_REQUIRED');
  f.store.permitRead(f.request('aristo')); f.bindingByBrand.get('fish').resourceHash = h('different-resource');
  refuses(() => f.store.verify(f.native('fish')), 'AFFILIATE_NATIVE_CURRENT_CONSENT_REQUIRED');
  assert.equal(f.store.verify(f.native('aristo')).brand, 'aristo');
});
test('original revoke and expiry remain definitive without modifying receipt or leases', t => {
  const f = fixture(t); permit(f); const before = JSON.stringify(rows(f));
  f.connections.revoke({context: f.browser, connectionId: f.issued.connection.id});
  refuses(() => f.store.verify({context: {host: HOST, nativeBearer: f.issued.token}, connectionId: f.issued.connection.id, brand: 'fish'}), 'NATIVE_AUTH_REQUIRED');
  assert.equal(JSON.stringify(rows(f)), before);
  const expired = fixture(t); permit(expired); expired.advance(86400000);
  refuses(() => expired.store.verify({context: {host: HOST, nativeBearer: expired.issued.token}, connectionId: expired.issued.connection.id, brand: 'fish'}), 'NATIVE_AUTH_REQUIRED');
});
test('native token, connection ID and host are checked by the original API and own contract', t => {
  const f = fixture(t); permit(f);
  refuses(() => f.store.verify({context: {...f.native('fish').context, nativeBearer: 'fake'}, connectionId: f.issued.connection.id, brand: 'fish'}), 'NATIVE_AUTH_REQUIRED');
  refuses(() => f.store.verify({...f.native('fish'), connectionId: crypto.randomUUID()}), 'AFFILIATE_NATIVE_CONNECTION_REFUSED');
  refuses(() => f.store.verify({...f.native('fish'), context: {...f.native('fish').context, host: 'other.synthetic.invalid'}}), 'AFFILIATE_NATIVE_CONNECTION_REFUSED');
  refuses(() => f.store.verify({context: f.browser, connectionId: f.issued.connection.id, brand: 'fish'}), 'AFFILIATE_NATIVE_AUTH_REQUIRED');
});
test('MAC tampering or a fabricated newest receipt refuses, never recovers an old version', t => {
  const f = fixture(t); permit(f); const r = rows(f)[0];
  f.db.prepare('UPDATE ' + TABLE + ' SET resource_hash=?').run(h('tampered'));
  refuses(() => f.store.verify(f.native('fish')), 'AFFILIATE_NATIVE_RECEIPT_INVALID');
  f.db.prepare('UPDATE ' + TABLE + ' SET resource_hash=?').run(r.resource_hash);
  f.db.prepare('INSERT INTO ' + TABLE + ' SELECT connection_id,brand,2,actor_id,owner_revision,session_hash,connection_hash,credential_binding_hash,resource_hash,?,happened_at,expires_at,binding_mac FROM ' + TABLE).run(h('fake-prior'));
  refuses(() => f.store.verify(f.native('fish')), 'AFFILIATE_NATIVE_RECEIPT_INVALID'); assert.equal(rows(f).length, 2);
});
test('private binding/session drift during consent rolls back with zero receipt and old state intact', t => {
  const f = fixture(t), original = f.originalState(); let n = 0;
  f.bindingHook((_ctx, brand) => ({...f.bindingByBrand.get(brand), resourceHash: h('change-' + (++n))}));
  refuses(() => permit(f), 'AFFILIATE_NATIVE_CURRENT_CHANGED'); assert.equal(rows(f).length, 0); assert.deepEqual(f.originalState(), original);
  f.bindingHook((_ctx, brand) => ({...f.bindingByBrand.get(brand)})); assert.equal(permit(f).version, 1);
});
test('withRead checks receipt before/after one real callback and does not reveal token to it', async t => {
  const f = fixture(t); permit(f); let calls = 0;
  const out = await f.store.withRead(f.native('fish'), proof => {calls++; assert.equal(Object.isFrozen(proof), true); assert.equal(JSON.stringify(proof).includes(f.issued.token), false); return {synthetic: 'format-only-read'};});
  assert.deepEqual(out, {synthetic: 'format-only-read'}); assert.equal(calls, 1);
});
for (const mode of ['key', 'resource', 'owner', 'revoke', 'expiry', 'withdraw-binding']) test('withRead discards response after await drift: ' + mode, async t => {
  const f = fixture(t); permit(f); let release, calls = 0;
  const pending = f.store.withRead(f.native('fish'), async () => {calls++; await new Promise(r => {release = r;}); return {mustNotEscape: true};});
  if (mode === 'key') f.bindingByBrand.get('fish').credentialBindingHash = h('rotated');
  if (mode === 'resource') f.bindingByBrand.get('fish').resourceHash = h('rotated-resource');
  if (mode === 'owner') f.identities.get(O).active = false;
  if (mode === 'revoke') f.connections.revoke({context: f.browser, connectionId: f.issued.connection.id});
  if (mode === 'expiry') f.advance(86400000);
  if (mode === 'withdraw-binding') f.bindingHook(() => null);
  release(); await assert.rejects(pending); assert.equal(calls, 1); assert.equal(rows(f).length, 1);
});
test('withRead does not invoke callback without consent or retry a callback failure', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(f.store.withRead(f.native('fish'), () => {calls++;})); assert.equal(calls, 0);
  permit(f); await assert.rejects(f.store.withRead(f.native('fish'), () => {calls++; throw new Error('SYNTHETIC_READ_FAILED');}), /SYNTHETIC_READ_FAILED/);
  assert.equal(calls, 1); assert.equal(rows(f).length, 1);
});
test('input does not accept aliases/getters/unsafe clocks; no failed transaction remains open', t => {
  const f = fixture(t), getter = {...f.request()}; Object.defineProperty(getter, 'optIn', {get() {throw new Error('must not execute');}, enumerable: true});
  refuses(() => f.store.permitRead(getter), 'AFFILIATE_NATIVE_INPUT_REFUSED');
  refuses(() => f.store.permitRead({...f.request(), brand: 'todas'}), 'AFFILIATE_NATIVE_INPUT_REFUSED');
  f.advance(-1780000000001); refuses(() => permit(f), 'AFFILIATE_NATIVE_CLOCK_REFUSED'); assert.equal(rows(f).length, 0);
  f.advance(1780000000001); assert.equal(permit(f).version, 1);
});
test('factory uses only the existing identity DB; original store is mandatory', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  refuses(() => createAffiliateNativeConsentStore({db, connections: {authenticate(){},list(){},context(){}}, consent(){},identity(){},currentBinding(){},mac(){},now(){return 0;}}), 'AFFILIATE_NATIVE_ORIGINAL_STORE_REQUIRED');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n, 0);
});
