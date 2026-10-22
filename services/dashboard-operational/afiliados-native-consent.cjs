'use strict';
const crypto = require('node:crypto');

// Local nucleus, not mounted or an operational grant. Root must inject the
// original delegation store and genuine consent/identity/currentBinding hooks.
// currentBinding(context, brand) is synchronous and returns EXACTLY ownerId,
// ownerRevision, credentialBindingHash, resourceHash from the private real slot.
// Nothing below accepts those fields, credentials or capabilities from a body.
// inspect/permitRead require an original browser POST/CSRF. expectedReceiptHash
// is only a version CAS: null for first consent, latest receipt hash thereafter.
// Old receipts are append-only here. READ always selects the latest version;
// it never renews, overwrites, reseals or falls back to an older version.
const SCHEMA = 'shrigma-affiliate-native-read-consent-v1';
const TABLE = 'shrigma_affiliate_native_read_consent_v1';
const BRANDS = Object.freeze(['fish', 'aristo']);
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const deny = (code, status = 403) => { throw Object.assign(new Error(code), {code, status}); };
const isHash = x => typeof x === 'string' && HASH.test(x);
function dataObject(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length && keys.every(k =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, k) || {}, 'value'));
}

function createAffiliateNativeConsentStore({db, connections, consent, identity, currentBinding, mac, now = Date.now} = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function' ||
      ['authenticate', 'list', 'context'].some(k => typeof connections?.[k] !== 'function') ||
      [consent, identity, currentBinding, mac, now].some(f => typeof f !== 'function')) deny('AFFILIATE_NATIVE_CONFIG_REFUSED', 500);
  // The identity DB and original tables must already exist. Never create a DB,
  // users, a delegation, an actor, token or a scope on behalf of the caller.
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1 ||
      ['users', 'crm_native_connections_v1'].some(name =>
        !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))) deny('AFFILIATE_NATIVE_ORIGINAL_STORE_REQUIRED', 500);
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),
    brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),
    version INTEGER NOT NULL CHECK(version>=1),
    actor_id TEXT NOT NULL REFERENCES users(id), owner_revision TEXT NOT NULL,
    session_hash TEXT NOT NULL, connection_hash TEXT NOT NULL,
    credential_binding_hash TEXT NOT NULL, resource_hash TEXT NOT NULL,
    prior_receipt_hash TEXT, happened_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    binding_mac TEXT NOT NULL, PRIMARY KEY(connection_id,brand,version),
    CHECK(happened_at>=0 AND expires_at>happened_at),
    CHECK((version=1 AND prior_receipt_hash IS NULL) OR (version>1 AND prior_receipt_hash IS NOT NULL)))`);

  function time() { const value = now(); if (!Number.isSafeInteger(value) || value < 0) deny('AFFILIATE_NATIVE_CLOCK_REFUSED', 500); return value; }
  function sign(value) { const result = mac(value); if (!isHash(result)) deny('AFFILIATE_NATIVE_MAC_REFUSED', 500); return result; }
  function seal(r) { return sign(JSON.stringify([SCHEMA, r.connection_id, r.brand, r.version,
    r.actor_id, r.owner_revision, r.session_hash, r.connection_hash, r.credential_binding_hash,
    r.resource_hash, r.prior_receipt_hash, r.happened_at, r.expires_at])); }
  function receiptHash(r) { return hash(JSON.stringify([seal(r), r.binding_mac])); }
  function latest(connectionId, brand) {
    const r = db.prepare(`SELECT * FROM ${TABLE} WHERE connection_id=? AND brand=? ORDER BY version DESC LIMIT 1`).get(connectionId, brand);
    if (!r) return null;
    if (!isHash(r.binding_mac) || !Number.isSafeInteger(r.version) || r.version < 1 ||
        !isHash(r.owner_revision) || !isHash(r.session_hash) || !isHash(r.connection_hash) ||
        !isHash(r.credential_binding_hash) || !isHash(r.resource_hash) ||
        (r.version === 1 ? r.prior_receipt_hash !== null : !isHash(r.prior_receipt_hash)) ||
        !Number.isSafeInteger(r.happened_at) || !Number.isSafeInteger(r.expires_at) || r.happened_at < 0 ||
        r.expires_at <= r.happened_at || !crypto.timingSafeEqual(Buffer.from(r.binding_mac, 'hex'), Buffer.from(seal(r), 'hex'))) deny('AFFILIATE_NATIVE_RECEIPT_INVALID');
    return r;
  }
  function query(value, issuing = false) {
    const keys = issuing ? ['context', 'connectionId', 'brand', 'optIn', 'expectedReceiptHash'] : ['context', 'connectionId', 'brand'];
    if (!dataObject(value, keys) || typeof value.connectionId !== 'string' || !UUID.test(value.connectionId) || !BRANDS.includes(value.brand)) deny('AFFILIATE_NATIVE_INPUT_REFUSED', 400);
    if (issuing && (value.optIn !== true || value.expectedReceiptHash !== null && !isHash(value.expectedReceiptHash))) deny('AFFILIATE_NATIVE_EXPLICIT_CONSENT_REQUIRED');
    return value;
  }
  function owner(userId) {
    const value = identity(userId);
    if (!value || value.role !== 'superadmin' || value.active !== true || !isHash(value.revision)) deny('AFFILIATE_NATIVE_OWNER_REQUIRED');
    return value;
  }
  function rowFor(connectionId, ownerId, context) {
    const row = db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=? AND user_id=?').get(connectionId, ownerId);
    if (!row || row.host !== context?.host || row.revoked_at !== null ||
        !Number.isSafeInteger(row.expires_at) || row.expires_at <= time()) deny('AFFILIATE_NATIVE_CONNECTION_REFUSED');
    return row;
  }
  function connectionHash(r) {
    return hash(JSON.stringify([r.id, r.token_hash, r.user_id, r.host, r.label, r.brands_json,
      r.scopes_json, r.auth_revision, r.source_session_hash, r.created_at, r.expires_at, r.revoked_at, r.binding_mac]));
  }
  function browserCurrent(q) {
    if (q.context?.nativeBearer !== undefined || q.context?.method !== 'POST' ||
        typeof q.context?.csrf !== 'string' || !q.context.csrf) deny('AFFILIATE_NATIVE_BROWSER_CONSENT_REQUIRED');
    const proof = consent(q.context); // Original authentication, origin and CSRF.
    if (!dataObject(proof, ['userId', 'sessionHash']) || typeof proof.userId !== 'string' || !proof.userId || !isHash(proof.sessionHash)) deny('AFFILIATE_NATIVE_BROWSER_CONSENT_REQUIRED');
    const currentOwner = owner(proof.userId), rows = connections.list(q.context);
    const view = Array.isArray(rows) ? rows.find(r => r.id === q.connectionId) : null;
    if (!view || view.revoked !== false || !Array.isArray(view.scopes) || !view.scopes.includes('crm.read') ||
        !Array.isArray(view.brands) || !view.brands.includes(q.brand) || view.expiresAt <= time()) deny('AFFILIATE_NATIVE_CONNECTION_REFUSED');
    const row = rowFor(q.connectionId, proof.userId, q.context);
    if (q.context.origin !== 'https://' + row.host || row.auth_revision !== currentOwner.revision ||
        view.expiresAt !== row.expires_at) deny('AFFILIATE_NATIVE_CONNECTION_REFUSED');
    return {row, owner: currentOwner, proof};
  }
  function binding(context, brand, ownerId, currentOwner) {
    const b = currentBinding(context, brand);
    if (!dataObject(b, ['ownerId', 'ownerRevision', 'credentialBindingHash', 'resourceHash']) ||
        b.ownerId !== ownerId || b.ownerRevision !== currentOwner.revision ||
        !isHash(b.credentialBindingHash) || !isHash(b.resourceHash)) deny('AFFILIATE_NATIVE_BINDING_REFUSED');
    return b;
  }
  function inspect(value) {
    const q = query(value), {row} = browserCurrent(q), r = latest(row.id, q.brand);
    // A version reference is not readiness, authority or a capability.
    return Object.freeze({schema: SCHEMA, connectionId: row.id, brand: q.brand,
      version: r ? r.version : 0, receiptHash: r ? receiptHash(r) : null});
  }
  function permitRead(value) {
    const q = query(value, true);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = browserCurrent(q), {row, owner: currentOwner, proof} = current;
      const b = binding(q.context, q.brand, row.user_id, currentOwner), previous = latest(row.id, q.brand);
      const priorHash = previous ? receiptHash(previous) : null;
      if (q.expectedReceiptHash !== priorHash) deny('AFFILIATE_NATIVE_RECEIPT_CHANGED', 409);
      const connection = connectionHash(row);
      if (previous && previous.connection_hash === connection && previous.actor_id === row.user_id &&
          previous.owner_revision === b.ownerRevision && previous.credential_binding_hash === b.credentialBindingHash &&
          previous.resource_hash === b.resourceHash && previous.expires_at > time()) deny('AFFILIATE_NATIVE_CONSENT_ALREADY_CURRENT', 409);
      // Recheck genuine hooks inside the same write transaction before insertion.
      const final = browserCurrent(q), finalBinding = binding(q.context, q.brand, final.row.user_id, final.owner);
      if (connectionHash(final.row) !== connection || final.proof.sessionHash !== proof.sessionHash ||
          finalBinding.ownerId !== b.ownerId || finalBinding.ownerRevision !== b.ownerRevision ||
          finalBinding.credentialBindingHash !== b.credentialBindingHash || finalBinding.resourceHash !== b.resourceHash) deny('AFFILIATE_NATIVE_CURRENT_CHANGED', 409);
      const r = {connection_id: row.id, brand: q.brand, version: previous ? previous.version + 1 : 1,
        actor_id: proof.userId, owner_revision: currentOwner.revision, session_hash: proof.sessionHash,
        connection_hash: connection, credential_binding_hash: b.credentialBindingHash,
        resource_hash: b.resourceHash, prior_receipt_hash: priorHash, happened_at: time(), expires_at: row.expires_at};
      if (!Number.isSafeInteger(r.version) || r.version > 2147483647 || r.happened_at >= r.expires_at) deny('AFFILIATE_NATIVE_RECEIPT_REFUSED');
      r.binding_mac = seal(r);
      db.prepare(`INSERT INTO ${TABLE} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.connection_id, r.brand, r.version,
        r.actor_id, r.owner_revision, r.session_hash, r.connection_hash, r.credential_binding_hash,
        r.resource_hash, r.prior_receipt_hash, r.happened_at, r.expires_at, r.binding_mac);
      db.exec('COMMIT');
      return Object.freeze({schema: SCHEMA, connectionId: row.id, brand: q.brand, version: r.version,
        receiptHash: receiptHash(r), readOnly: true, expiresAt: r.expires_at});
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function verify(value) {
    const q = query(value);
    if (typeof q.context?.nativeBearer !== 'string') deny('AFFILIATE_NATIVE_AUTH_REQUIRED', 401);
    // crm.read authenticates the existing connection; it grants NO Affiliate READ.
    const proof = connections.authenticate(q.context.nativeBearer, {scope: 'crm.read', brand: q.brand});
    if (proof.id !== q.connectionId || typeof proof.userId !== 'string') deny('AFFILIATE_NATIVE_CONNECTION_REFUSED');
    const currentOwner = owner(proof.userId), row = rowFor(q.connectionId, proof.userId, q.context);
    if (row.auth_revision !== currentOwner.revision || proof.host !== row.host) deny('AFFILIATE_NATIVE_CONNECTION_REFUSED');
    const b = binding(q.context, q.brand, row.user_id, currentOwner), r = latest(row.id, q.brand);
    if (!r || r.actor_id !== row.user_id || r.owner_revision !== currentOwner.revision ||
        r.connection_hash !== connectionHash(row) || r.credential_binding_hash !== b.credentialBindingHash ||
        r.resource_hash !== b.resourceHash || r.expires_at !== row.expires_at || r.expires_at <= time() || r.happened_at > time()) deny('AFFILIATE_NATIVE_CURRENT_CONSENT_REQUIRED');
    return Object.freeze({schema: SCHEMA, connectionId: row.id, brand: q.brand, readOnly: true,
      ownerId: row.user_id, ownerRevision: r.owner_revision, credentialBindingHash: r.credential_binding_hash,
      resourceHash: r.resource_hash, receiptHash: receiptHash(r), version: r.version, expiresAt: r.expires_at});
  }
  async function withRead(value, read) {
    if (typeof read !== 'function') deny('AFFILIATE_NATIVE_READ_CALLBACK_REQUIRED', 500);
    const before = verify(value);
    let result;
    try { result = await read(before); }
    finally {
      const after = verify(value);
      if (JSON.stringify(before) !== JSON.stringify(after)) deny('AFFILIATE_NATIVE_CURRENT_CHANGED', 409);
    }
    return result; // Caller owns the original READ/projection, no retry or sending.
  }
  return Object.freeze({inspect, permitRead, verify, withRead});
}
module.exports = Object.freeze({createAffiliateNativeConsentStore, SCHEMA, TABLE});
