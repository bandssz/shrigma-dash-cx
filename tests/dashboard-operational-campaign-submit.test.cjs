'use strict';
// Disposable identity SQLite and loopback HTTP only. The origin uses the real
// campaign contract/service with synthetic storage/provider; it sends nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { createAuth } = require('../services/dashboard-operational/auth.cjs');
const { createServer } = require('../services/dashboard-operational/server.cjs');
const { SANDBOX_DESTINATIONS, SANDBOX_CAMPAIGN_DESTINATION, SANDBOX_HOST, REVIEWED_DYNAMIC, DYNAMIC_MANIFEST_SCHEMA } = require('../services/dashboard-operational/proxy.cjs');
const { IDENTITY_URL } = require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const { createService } = require('../n8n/growth/campaign-service.js');
const C = require('../n8n/growth/campaign-contract.js');
const T = require('../n8n/growth/campaign-tracking.js');

const hosts = { manager: 'manager.submit.synthetic.invalid', growth: 'crm.submit.synthetic.invalid', organico: 'organico.submit.synthetic.invalid', influs: 'influs.submit.synthetic.invalid' };
const PASSWORD = 'Synthetic campaign manager password 2026!';
const CAPS = ['read_content', 'draft', 'validate', 'submit'];
const iso = value => new Date(value).toISOString();
const clone = value => structuredClone(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const version = value => crypto.createHash('md5').update(String(value)).digest('hex');

function call(port, host, pathname, { method = 'GET', body, cookie, csrf, origin = 'https://' + host, metadata } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, Connection: 'close', ...metadata };
    if (origin !== null) headers.Origin = origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(raw); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, json, raw });
      });
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(Error('SYNTHETIC_HTTP_TIMEOUT')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const session = response => ({ cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.json.csrf, userId: response.json.user.id });
const selector = key => '/auth/campaign-delivery?brand=fish&idempotency_key=' + encodeURIComponent(key);
const command = (action, row, key, extra = {}) => ({ acao: 'campanha_' + action, brand: 'fish', id: row.id, expected_version: row.version, idempotency_key: key, ...(action === 'agendar' || action === 'cancelar' ? { confirm: action } : {}), ...extra });

function originFixture(now) {
  const operations = new Map(), validations = new Map(), effects = { save: 0, validate: 0, schedule: 0, cancel: 0, create: 0 };
  const catalog = { brand: 'fish', current: true, lists: [{ id: 125, brand: 'fish', available: true }], templates: [{ id: 1, type: 'campaign', available: true }], initiatives: [] };
  const definition = C.prepare({ schema_version: C.VERSION, brand: 'fish', channel: 'email', initiative: { key: 'submit-fixture', name: 'Submit fixture' }, utm_campaign: 'fish-submit-fixture', name: 'Submit fixture', subject: 'Synthetic fixture subject', from_email: 'contato@fishermans.com.br', reply_to: 'contato@fishermans.com.br', list_ids: [125], template_id: 1, html: '<a href="https://fishermans.com.br/products/fixture">Fixture</a>{{ UnsubscribeURL }}', text: 'https://fishermans.com.br/products/fixture {{ UnsubscribeURL }}', tags: [], send_at: iso(now() + 3600000) }, { catalog, tracking: T, trackingId: 7, now: now() }).definition;
  let row = { id: 7, version: version('initial'), status: 'draft', sent: 0, started_at: null, send_at: definition.send_at, definition };
  let sequence = 0;
  const store = {
    async claim(p) {
      const key = p.actor + ':' + p.key;
      if (operations.has(key)) return { ...operations.get(key), acquired: false };
      const o = { ...p, id: crypto.randomUUID(), lease: crypto.randomUUID(), state: 'pending', providerId: null, response: null, created_at: iso(now()), updated_at: iso(now()), acquired: true };
      operations.set(key, o); return o;
    },
    async getOperation(actor, key) {
      const o = operations.get(actor + ':' + key);
      return o ? clone({ id: o.id, operation_key: o.key, brand: o.brand, action: o.action, state: o.state, providerId: o.providerId, response: o.response, created_at: o.created_at, updated_at: o.updated_at }) : null;
    },
    async finish(id, lease, result) {
      const o = [...operations.values()].find(value => value.id === id);
      assert.equal(o.lease, lease); assert.equal(o.state, 'pending');
      Object.assign(o, clone(result), { updated_at: iso(now()) });
    },
    async setProviderId() { throw Error('Creation is outside this fixture'); },
    async invalidateValidation(id) { validations.delete(id); },
    async getValidation(id) { return clone(validations.get(id) || null); }
  };
  const provider = {
    async get(id) { assert.equal(id, 7); return clone(row); },
    async list() { return [clone(row)]; },
    async catalog() { return clone(catalog); },
    async createDraft() { effects.create++; throw Error('Existing drafts only'); },
    async updateDraft(id, prepared, { expectedVersion }) {
      assert.equal(id, 7); assert.equal(expectedVersion, row.version);
      assert.equal(row.status, 'draft'); assert.equal(row.sent, 0); assert.equal(row.started_at, null);
      effects.save++; row = { ...row, version: version(++sequence), definition: clone(prepared.definition), send_at: prepared.definition.send_at }; return clone(row);
    },
    async reviewAudience(id, { expectedVersion }) {
      assert.equal(id, 7); assert.equal(expectedVersion, row.version); effects.validate++;
      const audience = { policy: 'listmonk-6.1-regular-v1', brand: 'fish', list_ids: [125], eligible_count: 3, unique_members_count: 5, excluded_blocklisted_count: 1, excluded_subscription_count: 1, native_disabled_count: 0, review_id: crypto.randomUUID(), campaign_id: 7, campaign_version: row.version, frozen: false, checked_at: iso(now()), expires_at: iso(now() + 300000) };
      const validation = { policy: C.VERSION, version: row.version, ok: true, validated_at: iso(now()), audience };
      validations.set(id, validation); return { campaign: clone(row), validation: clone(validation) };
    },
    async schedule(id, { expectedVersion, audienceReviewId }) {
      assert.equal(id, 7); assert.equal(expectedVersion, row.version);
      const validation = validations.get(id); assert.equal(audienceReviewId, validation.audience.review_id);
      C.audienceReview(validation.audience, row, { now: now() }); effects.schedule++;
      row = { ...row, version: version(++sequence), status: 'scheduled' };
      return { ...clone(row), audience: { ...clone(validation.audience), rechecked_at: iso(now()) } };
    },
    async cancel(id, { expectedVersion }) {
      assert.equal(id, 7); assert.equal(expectedVersion, row.version); effects.cancel++;
      row = { ...row, version: version(++sequence), status: 'cancelled' }; return clone(row);
    }
  };
  return { service: createService({ store, provider, now }), operations, effects, row: () => clone(row), setRow: value => { row = clone(value); }, definition };
}

async function fixture(t, { enabled = true, createMode = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-submit-http-')), dbPath = path.join(dir, 'identity.sqlite');
  let clock = Date.now(), auth, server;
  const config = { dbPath, managerHost: hosts.manager, areaHosts: { growth: hosts.growth, organico: hosts.organico, influs: hosts.influs }, allowedEmailDomains: ['synthetic.invalid'], bootstrapAdminEmail: 'admin@synthetic.invalid', bootstrapTokenSha256: sha('synthetic-submit-bootstrap'), encryptionKey: crypto.randomBytes(32), now: () => clock, ...(enabled ? { crmCampaignSubmitWrite: true } : {}) };
  auth = createAuth(config);
  const inspect = fn => { const db = new DatabaseSync(dbPath); try { return fn(db); } finally { db.close(); } };
  const origin = (createMode?require('./dashboard-operational-campaign-create-fixture.cjs').createOrigin:originFixture)(() => clock), credentials = new Map(), calls = [];
  let behavior = null;
  const fetchImpl = async (value, options) => {
    const url = new URL(value); assert.equal(url.origin + url.pathname, SANDBOX_CAMPAIGN_DESTINATION);
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Origin, undefined);
    let payload, bearer;
    if (options.method === 'POST') {
      assert.equal(url.search, ''); assert.equal(options.headers.Authorization, undefined);
      payload = JSON.parse(options.body); bearer = payload.k; delete payload.k;
    } else {
      assert.equal(options.method, 'GET'); bearer = options.headers.Authorization?.slice(7);
      payload = Object.fromEntries(url.searchParams); if (payload.id !== undefined) payload.id = Number(payload.id);
    }
    const credential = credentials.get(bearer); assert.ok(credential, 'Origin must receive the attested individual writer');
    calls.push({ method: options.method, command: clone(payload), actor: credential.actor });
    if (options.method === 'POST') {
      const table=createMode&&payload.acao==='campanha_salvar'&&!Object.hasOwn(payload,'id')?'crm_campaign_create_v1':'crm_campaign_delivery_v1';
      const saved = inspect(db => db.prepare('SELECT * FROM '+table+' WHERE remote_key=?').get(payload.idempotency_key));
      assert.ok(saved); assert.equal(saved.phase, 'uncertain', 'The dispatch intent commits before origin I/O');
      assert.notEqual(saved.client_key, payload.idempotency_key);
    }
    const dispatch = () => origin.service.handle({ actor: credential.actor, caps: CAPS }, payload);
    const result = behavior ? await behavior({ payload, options, dispatch }) : await dispatch();
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
  };
  const settings = { mode: 'operational', upstreamProfile: 'crm-sandbox', crmCampaignSubmitWrite: enabled, crmDraftWrite: false, crmAudienceDraft: false, allowedEmailDomains: config.allowedEmailDomains, bootstrapAdminEmail: config.bootstrapAdminEmail, managerHost: hosts.manager, areaHosts: config.areaHosts, upstreams: { ...SANDBOX_DESTINATIONS, ...(enabled ? { campaigns: SANDBOX_CAMPAIGN_DESTINATION } : {}) }, allowedUpstreamHosts: [SANDBOX_HOST], publicDir: dir };
  const start = async options => { server = createServer(settings, { auth, fetchImpl, ...options }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); };
  t.after(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); try { auth.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  const get = (host, pathname, context = {}) => call(server.address().port, host, pathname, context);
  const post = (host, pathname, body, context = {}) => call(server.address().port, host, pathname, { ...context, method: 'POST', body });
  assert.equal((await post(hosts.manager, '/auth/bootstrap/complete', { email: config.bootstrapAdminEmail, token: 'synthetic-submit-bootstrap', password: PASSWORD })).status, 200);
  const adminLogin = await post(hosts.manager, '/auth/login', { email: config.bootstrapAdminEmail, password: PASSWORD }); assert.equal(adminLogin.status, 200);
  const admin = session(adminLogin), adminContext = { host: hosts.manager, origin: 'https://' + hosts.manager, method: 'POST', cookieHeader: admin.cookie, csrf: admin.csrf };
  let managerNumber=0;
  const manager = async (email, { writer = true, number = createMode?++managerNumber:1 } = {}) => {
    const invited = await post(hosts.manager, '/auth/users', { action: 'invite', role: 'manager', email, areas: ['growth'], permissions: { growth: { read: true, edit: false } } }, admin); assert.equal(invited.status, 201);
    const token = new URLSearchParams(new URL(invited.json.inviteUrl).hash.slice(1)).get('invite');
    assert.equal((await post(hosts.growth, '/auth/invite/accept', { token, password: PASSWORD })).status, 200);
    if (enabled) auth.setGrants({ context: adminContext, userId: invited.json.userId, permissions: { growth: { read: true, edit: true } } });
    const logged = await post(hosts.growth, '/auth/login', { email, password: PASSWORD }); assert.equal(logged.status, 200);
    const person = { ...session(logged), email, bearer: number.toString(16).repeat(64), principalId: 'dcrmw-' + number.toString(16).repeat(32) };
    if (enabled && writer) {
      const identityFetch = async (url, options) => {
        assert.equal(url, IDENTITY_URL); assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer ' + person.bearer);
        const identity = { schema: 'shrigma_access_identity_v1', role: 'manager', panel: 'growth', owner: email, allowedPanels: ['growth'], permissions: { growth: { who: 'panel:' + person.principalId, label: email, caps: CAPS }, influs: null } };
        const response = new Response(JSON.stringify(identity), { headers: { 'content-type': 'application/json' } }); Object.defineProperty(response, 'url', { value: IDENTITY_URL }); return response;
      };
      await auth.installCampaignWriter({ context: adminContext, userId: person.userId, bearer: person.bearer, principalId: person.principalId, expiresAt: clock + 14 * 86400000, fetchImpl: identityFetch });
      credentials.set(person.bearer, { actor: 'panel:' + person.principalId, owner: email });
    }
    return person;
  };
  return { config, settings, origin, calls, inspect, auth: () => auth, admin, adminContext, get, post, manager, behavior: value => { behavior = value; }, advance: value => { clock += value; }, restart: async () => { await new Promise(resolve => server.close(resolve)); auth.close(); auth = createAuth(config); await start(); } };
}

function dto(response, action, key, state = 'succeeded') {
  assert.equal(response.status, state === 'pending' ? 202 : state === 'rejected' ? 409 : 200, response.raw);
  assert.deepEqual(Object.keys(response.json).sort(), ['action', 'attemptKey', 'campaign', 'schema', 'state', 'validation']);
  assert.equal(response.json.schema, 'crm-campaign-bff-operation-v1'); assert.equal(response.json.action, 'campanha_' + action);
  assert.equal(response.json.attemptKey, key); assert.equal(response.json.state, state);
  for (const hidden of ['operation_key', 'credentialMac', 'receipt_sha256', 'encrypted_key', 'UnsubscribeURL', 'RAW_SECRET']) assert.equal(response.raw.includes(hidden), false);
  return response.json;
}

// Importing the fixture does not register or execute this HTTP suite.
module.exports = { fixture, originFixture, hosts, call, session, command, dto, C, T };
if (require.main === module) {
test('attested individual writer completes update-save, validate, schedule and cancel through local HTTP receipts', async t => {
  const f = await fixture(t), a = await f.manager('a@synthetic.invalid'), b = await f.manager('b@synthetic.invalid', { number: 2 });
  const before = f.inspect(db => ({ admin: db.prepare("SELECT * FROM users WHERE role='superadmin'").get(), grants: db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(f.admin.userId) }));
  const feature = await f.get(hosts.growth, '/auth/session', a); assert.equal(feature.json.features.campaignSubmitWrite, true);
  const saveKey = 'http-submit-save-000001', save = command('salvar', f.origin.row(), saveKey, { definition: { ...f.origin.definition, subject: 'Updated synthetic subject' } });
  const saved = dto(await f.post(hosts.growth, '/api/campaigns', save, a), 'salvar', saveKey);
  assert.equal(saved.campaign.status, 'draft'); assert.equal(saved.campaign.sendAt, f.origin.definition.send_at); assert.equal(f.origin.effects.save, 1); assert.equal(f.origin.effects.create, 0);
  dto(await f.get(hosts.growth, selector(saveKey), a), 'salvar', saveKey);
  const validateKey = 'http-submit-validate-0001', validate = command('validar', f.origin.row(), validateKey);
  const validated = dto(await f.post(hosts.growth, '/api/campaigns', validate, a), 'validar', validateKey);
  assert.ok(validated.validation); assert.equal(validated.validation.version, f.origin.row().version);
  assert.deepEqual(Object.keys(validated.validation).sort(), ['audience', 'ok', 'policy', 'validatedAt', 'version']);
  const reviewId = validated.validation.audience.review_id;
  assert.match(reviewId, /^[a-f0-9-]{36}$/);
  const scheduleKey = 'http-submit-schedule-0001', schedule = command('agendar', f.origin.row(), scheduleKey, { audience_review_id: reviewId });
  const scheduled = dto(await f.post(hosts.growth, '/api/campaigns', schedule, a), 'agendar', scheduleKey); assert.equal(scheduled.campaign.status, 'scheduled');
  assert.equal((await f.get(hosts.growth, selector(scheduleKey), b)).status, 404);
  const cancelKey = 'http-submit-cancel-000001', cancel = command('cancelar', f.origin.row(), cancelKey);
  const cancelled = dto(await f.post(hosts.growth, '/api/campaigns', cancel, a), 'cancelar', cancelKey); assert.equal(cancelled.campaign.status, 'cancelled');
  dto(await f.get(hosts.growth, '/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=' + cancelKey, a), 'cancelar', cancelKey);
  assert.deepEqual(f.origin.effects, { save: 1, validate: 1, schedule: 1, cancel: 1, create: 0 });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 4);
  const journal = f.inspect(db => db.prepare('SELECT * FROM crm_campaign_delivery_v1 ORDER BY created_at,client_key').all());
  assert.equal(journal.length, 4); assert.ok(journal.every(row => row.phase === 'succeeded' && row.client_key !== row.remote_key));
  const encryptedSave = journal.find(row => row.action === 'salvar'); assert.match(encryptedSave.definition_ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(JSON.stringify(journal).includes('Updated synthetic subject'), false); assert.equal(JSON.stringify(journal).includes('UnsubscribeURL'), false);
  assert.equal(JSON.stringify([saved, validated, scheduled, cancelled]).includes(a.bearer), false);
  for (const row of journal) assert.equal(JSON.stringify([saved, validated, scheduled, cancelled]).includes(row.remote_key), false);
  const publicRead = await f.get(hosts.growth, '/api/campaigns?acao=campanha_obter&brand=fish&id=7', a); assert.equal(publicRead.status, 200); assert.equal(publicRead.json.campaign.status, 'cancelled');
  assert.deepEqual(f.inspect(db => ({ admin: db.prepare("SELECT * FROM users WHERE role='superadmin'").get(), grants: db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(f.admin.userId) })), before);
});

test('bare origin 404 or timeout remains durable pending after restart and never repeats the POST', async t => {
  for (const mode of ['404', 'timeout']) {
    await t.test(mode, async sub => {
      const f = await fixture(sub), a = await f.manager('uncertain@synthetic.invalid'); let posts = 0;
      f.behavior(async ({ options, dispatch }) => { if (options.method === 'POST') { posts++; if (mode === 'timeout') throw Error('RAW_SECRET_TRANSPORT'); return { status: 404, body: { error: 'NOT_FOUND' } }; } return dispatch(); });
      const key = 'http-submit-uncertain-0001', q = command('validar', f.origin.row(), key);
      dto(await f.post(hosts.growth, '/api/campaigns', q, a), 'validar', key, 'pending');
      assert.equal(posts, 1); assert.equal(f.origin.effects.validate, 0); await f.restart();
      for (let i = 0; i < 2; i++) dto(await f.get(hosts.growth, selector(key), a), 'validar', key, 'pending');
      dto(await f.post(hosts.growth, '/api/campaigns', q, a), 'validar', key, 'pending');
      assert.equal((await f.post(hosts.growth, '/api/campaigns', { ...q, idempotency_key: 'http-submit-new-key-00001' }, a)).status, 409);
      assert.equal(posts, 1); assert.equal(f.inspect(db => db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase), 'uncertain');
    });
  }
});

test('writer attestation, individual session, Origin, CSRF and exact command fields protect the boundary', async t => {
  const f = await fixture(t), a = await f.manager('writer@synthetic.invalid'), readOnly = await f.manager('reader@synthetic.invalid', { writer: false });
  const key = 'http-submit-auth-0000001', q = command('validar', f.origin.row(), key);
  assert.equal((await f.get(hosts.growth, '/auth/session', readOnly)).json.features.campaignSubmitWrite, false);
  const before = f.calls.length;
  for (const context of [{ cookie: a.cookie }, { ...a, origin: 'https://foreign.invalid' }, { ...a, origin: null }]) assert.equal((await f.post(hosts.growth, '/api/campaigns', q, context)).status, 403);
  assert.equal((await f.post(hosts.growth, '/api/campaigns', q, readOnly)).status, 403);
  assert.equal((await f.post(hosts.manager, '/auth/users', { action: 'credential', userId: a.userId, slot: 'growth-campaign', bearer: 'browser-supplied-writer' }, f.admin)).status, 403);
  for (const body of [{ ...q, bearer: a.bearer }, { ...q, k: a.bearer }, { ...q, confirm: 'validar' }, { ...q, acao: 'campanha_recuperar' }, { ...q, brand: 'influs' }, command('salvar', f.origin.row(), key, { definition: f.origin.definition, id: undefined })]) {
    const rejected = await f.post(hosts.growth, '/api/campaigns', body, a); assert.ok([400,403].includes(rejected.status), rejected.raw);
  }
  assert.equal(f.calls.length, before);
  dto(await f.post(hosts.growth, '/api/campaigns', q, a), 'validar', key);
  assert.equal((await f.get(hosts.growth, selector(key), { cookie: a.cookie })).status, 403);
  assert.equal((await f.get(hosts.growth, selector(key), { ...a, origin: 'https://foreign.invalid' })).status, 403);
  const metadata = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  dto(await f.get(hosts.growth, selector(key), { ...a, origin: null, metadata }), 'validar', key);
  const called = f.calls.length; f.advance(14 * 86400000 + 1);
  const fresh = await f.post(hosts.growth, '/auth/login', { email: a.email, password: PASSWORD }); assert.equal(fresh.status, 200);
  assert.equal((await f.get(hosts.growth, '/auth/session', session(fresh))).json.features.campaignSubmitWrite, false);
  assert.equal((await f.post(hosts.growth, '/api/campaigns', { ...q, idempotency_key: 'http-submit-expired-0001' }, session(fresh))).status, 403);
  assert.equal(f.calls.length, called);
});

test('gate remains unavailable when OFF and rejects production, managed read and other write profiles', async t => {
  const off = await fixture(t, { enabled: false }), a = await off.manager('off@synthetic.invalid');
  assert.equal(Object.hasOwn(off.auth(), 'installCampaignWriter'), false);
  assert.equal((await off.post(hosts.growth, '/api/campaigns', command('validar', off.origin.row(), 'http-submit-off-0000001'), a)).status, 403);
  assert.equal((await off.get(hosts.growth, selector('http-submit-off-0000001'), a)).status, 403); assert.equal(off.calls.length, 0);
  const f = await fixture(t);
  const attempted = [
    { ...f.settings, mode: 'synthetic' },
    { ...f.settings, crmDraftWrite: true },
    { ...f.settings, crmAudienceDraft: true },
    { ...f.settings, crmManagedRead: { issuerId: crypto.randomUUID(), namespaceId: crypto.randomUUID() } },
    { ...f.settings, upstreamProfile: 'production', upstreams: { campaigns: REVIEWED_DYNAMIC.routes.campaigns }, allowedUpstreamHosts: [new URL(REVIEWED_DYNAMIC.routes.campaigns).hostname], dynamicRouteManifest: { schema: DYNAMIC_MANIFEST_SCHEMA, sourceRevision: REVIEWED_DYNAMIC.sourceRevision, routes: { campaigns: REVIEWED_DYNAMIC.routes.campaigns } } }
  ];
  for (const [index, settings] of attempted.entries()) assert.throws(() => createServer(settings, { auth: f.auth(), fetchImpl: () => { throw Error('NO_FETCH_ALLOWED'); } }), 'Invalid profile ' + index + ' must fail before origin I/O');
  assert.throws(() => createAuth({ ...f.config, crmManagedRead: { issuerId: crypto.randomUUID(), namespaceId: crypto.randomUUID() } }), { code: 'CAMPAIGN_WRITE_CONFIG_INVALID' });
  assert.equal(f.calls.length, 0);
});
}
