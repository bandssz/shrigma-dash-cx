'use strict';
// One existing source, one authenticated brand, READ only. No arbitrary URL,
// producer, SQL, issuer, invite, credential fallback or write route.
const {FIXED_DESTINATIONS, forward} = require('./proxy.cjs');
const {verifyCredential} = require('./backend-credential-attestation.cjs');
const {project} = require('./afiliados-read-contract.cjs');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const fail = (code, status = 403) => { throw Object.assign(new Error(code), {code, status}); };
const validDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
function decision(method, query, body) {
  if (!(query instanceof URLSearchParams)) fail('AFFILIATE_ARGUMENTS_INVALID', 400);
  if (method === 'GET') {
    if (body !== undefined || [...query.keys()].join(',') !== 'brand' || !['fish','aristo'].includes(query.get('brand'))) fail('AFFILIATE_ARGUMENTS_INVALID', 400);
    return {brand: query.get('brand')};
  }
  if (method !== 'POST') fail('METHOD_DENIED', 405);
  if (query.toString() || !plain(body) || Object.keys(body).sort().join(',') !== 'brand,expected_binding,fim,ini' || !['fish','aristo'].includes(body.brand) || !validDay(body.ini) || !validDay(body.fim) || body.ini > body.fim || typeof body.expected_binding !== 'string' || !/^[a-f0-9]{64}$/.test(body.expected_binding)) fail('AFFILIATE_ARGUMENTS_INVALID', 400);
  return {...body};
}
function createReader({auth, upstreams, fetchImpl = globalThis.fetch, verify = verifyCredential, now = Date.now} = {}) {
  if (!auth?.affiliateReadContext || !auth?.getUpstreamCredential || !auth?.authorizeBrand || !(upstreams?.tts instanceof URL) || upstreams.tts.href !== FIXED_DESTINATIONS.tts || typeof verify !== 'function' || typeof fetchImpl !== 'function') throw new Error('AFFILIATE_READ_CONFIG_INVALID');
  function availability(context, brand) {
    const state = auth.affiliateReadContext(context, {brand});
    return {schema: 'shrigma-affiliate-read-availability-v1', brand, readLinked: state.readLinked === true, binding: state.readLinked ? state.binding : null, readOnly: true};
  }
  async function read(context, request, origin) {
    const {brand, ini, fim, expected_binding} = request;
    const before = availability(context, brand);
    if (!before.readLinked) fail('AFFILIATE_READ_BINDING_MISSING', 503);
    if (before.binding !== expected_binding) fail('AFFILIATE_READ_BINDING_CHANGED', 409);
    const boundContext = {...context, area: 'influs', edit: false, brand, slot: 'tts-read'};
    const user = auth.authorizeBrand({...context, area: 'influs', edit: false}, brand);
    const credential = auth.getUpstreamCredential(boundContext);
    if (!credential) fail('AFFILIATE_READ_BINDING_MISSING', 503);
    const assertCurrent = () => {
      const current = availability(context, brand);
      if (!current.readLinked || current.binding !== before.binding || auth.getUpstreamCredential(boundContext) !== credential) fail('AFFILIATE_READ_BINDING_CHANGED', 409);
    };
    // A shorter, per-read budget leaves time for the UI's final session check.
    // The legacy source timeout and every commercial path remain unchanged.
    const deadline = AbortSignal.timeout(30000);
    const boundedFetch = (url, options = {}) => fetchImpl(url, {...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline});
    assertCurrent();
    try {
      const proof = await verify({slot: 'tts-read', expectedOwner: user.email, bearer: credential}, {fetchImpl: boundedFetch});
      if (proof?.ok !== true || proof.slot !== 'tts-read' || proof.area !== 'influs' || proof.identityVerified !== true || proof.status !== 'partial' || proof.readOnlyProven !== false) throw new Error('unconfirmed');
    }
    catch (_) { fail('AFFILIATE_SOURCE_IDENTITY_UNCONFIRMED', 503); }
    assertCurrent();
    const result = await forward({route: 'tts', method: 'POST', query: new URLSearchParams(), body: {ini, fim}, user, credential, upstreams, origin, fetchImpl: boundedFetch});
    assertCurrent();
    if (result.status !== 200) fail('AFFILIATE_SOURCE_READ_REFUSED', result.status >= 400 && result.status <= 599 ? result.status : 502);
    const body = project(result.body, {brand, ini, fim, credential});
    assertCurrent();
    const stamp = now(); if (!Number.isSafeInteger(stamp)) fail('AFFILIATE_CLOCK_INVALID', 500);
    return {status: 200, body: {...body, _affiliate_read: {schema: 'shrigma-affiliate-read-receipt-v1', brand, binding: before.binding, checkedAt: new Date(stamp).toISOString(), source: 'original-tiktok-panel-read', readOnly: true}}};
  }
  return Object.freeze({availability, read});
}
module.exports = {decision, createReader, validDay};
