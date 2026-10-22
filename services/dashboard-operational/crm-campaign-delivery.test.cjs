'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createCampaignDelivery } = require('./crm-campaign-delivery.cjs');
const { createService } = require('../../n8n/growth/campaign-service.js');
const C = require('../../n8n/growth/campaign-contract.js');
const T = require('../../n8n/growth/campaign-tracking.js');
const USER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const REVIEW = '20000000-0000-4000-8000-000000000001';
const A = 'a'.repeat(32), B = 'b'.repeat(32), D = 'd'.repeat(32);
const MAC = 'c'.repeat(64);
const START = Date.parse('2026-10-03T12:00:00.000Z');
const iso = t => new Date(t).toISOString();
const clone = value => structuredClone(value);
const request = (action = 'agendar', extra = {}) => ({ acao: 'campanha_' + action, brand: 'fish', id: 7, expected_version: A, idempotency_key: 'browser-attempt-key-0001', confirm: action, ...(action === 'agendar' ? { audience_review_id: REVIEW } : {}), ...extra });
const poll = q => ({ brand: q.brand, idempotency_key: q.idempotency_key });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, { filename = ':memory:', action = 'agendar' } = {}) {
  const db = new DatabaseSync(filename); t.after(() => { if (db.isOpen) db.close(); });
  let clock = START, allowed = true, mac = MAC;
  const calls = [], effects = { schedule: 0, cancel: 0 }, ops = new Map();
  const catalog = { brand: 'fish', current: true, lists: [{ id: 125, brand: 'fish', available: true }], templates: [{ id: 1, type: 'campaign', available: true }], initiatives: [] };
  const definition = C.prepare({ schema_version: C.VERSION, brand: 'fish', channel: 'email', initiative: { key: 'isolated-draft', name: 'Isolated draft' }, utm_campaign: 'fish-isolated', name: 'Isolated draft', subject: 'Fixture', from_email: 'contato@fishermans.com.br', reply_to: 'contato@fishermans.com.br', list_ids: [125], template_id: 1, html: '<a href="https://fishermans.com.br/products/fixture">Fixture</a>{{ UnsubscribeURL }}', text: 'https://fishermans.com.br/products/fixture {{ UnsubscribeURL }}', tags: [], send_at: iso(START + 3600000) }, { catalog, tracking: T, trackingId: 7, now: START }).definition;
  let row = { id: 7, version: A, status: action === 'cancelar' ? 'scheduled' : 'draft', sent: 0, started_at: null, send_at: definition.send_at, definition };
  const audience = { policy: 'listmonk-6.1-regular-v1', brand: 'fish', list_ids: [125], eligible_count: 3, unique_members_count: 5, excluded_blocklisted_count: 1, excluded_subscription_count: 1, native_disabled_count: 0, review_id: REVIEW, campaign_id: 7, campaign_version: A, frozen: false, checked_at: iso(START), expires_at: iso(START + 300000) };
  const validation = { policy: C.VERSION, version: A, ok: true, validated_at: iso(START), audience };
  const store = {
    async claim(p) {
      const key = p.actor + ':' + p.key;
      if (ops.has(key)) return { ...ops.get(key), acquired: false };
      const value = { ...p, id: crypto.randomUUID(), lease: crypto.randomUUID(), state: 'pending', providerId: null, response: null, created_at: iso(clock), updated_at: iso(clock), acquired: true }; ops.set(key, value); return value;
    },
    async getOperation(actor, key) {
      const o = ops.get(actor + ':' + key); if (!o) return null;
      return clone({ id: o.id, operation_key: o.key, brand: o.brand, action: o.action, state: o.state, providerId: o.providerId, response: o.response, created_at: o.created_at, updated_at: o.updated_at });
    },
    async finish(id, lease, result) { const o = [...ops.values()].find(v => v.id === id); assert.equal(o.lease, lease); Object.assign(o, result, { updated_at: iso(clock) }); },
    async getValidation() { return clone(validation); }, async invalidateValidation() {validation.ok=false;}
  };
  const provider = {
    async get() { return clone(row); }, async catalog() { return clone(catalog); },
    async schedule(id, { expectedVersion, audienceReviewId }) {
      effects.schedule++; assert.equal(id, 7); assert.equal(expectedVersion, row.version); assert.equal(audienceReviewId, validation.audience.review_id);
      row = { ...row, version: row.version===A?B:D, status: 'scheduled' };
      return { ...clone(row), audience: { ...clone(validation.audience), rechecked_at: iso(clock) } };
    },
    async cancel(id, { expectedVersion }) {
      effects.cancel++; assert.equal(id, 7); assert.equal(expectedVersion, row.version); row = { ...row, version:row.version===A?B:'e'.repeat(32), status: 'cancelled' }; return clone(row);
    },
    async updateDraft(id,p,{expectedVersion}){assert.equal(id,7);assert.equal(expectedVersion,row.version);row={...row,version:B,definition:clone(p.definition),send_at:p.definition.send_at};return clone(row);},
    async reviewAudience(id){assert.equal(id,7);Object.assign(validation,{version:row.version,ok:true,validated_at:iso(clock),audience:{...clone(audience),review_id:crypto.randomUUID(),campaign_version:row.version,checked_at:iso(clock),expires_at:iso(clock+300000)}});return {campaign:clone(row),validation:clone(validation)};}
  };
  const service = createService({ store, provider, now: () => clock });
  const authorize = context => {
    if (!allowed) throw Error('PRIVATE_AUTH_CANARY');
    return { userId: context.userId || USER, role: 'manager', slot: 'growth-campaign', canEdit: true, credentialMac: mac, caps: ['read_content', 'draft', 'validate', 'submit'] };
  };
  const baseTransport = async (context, q) => {
    assert.equal(db.isTransaction, false, 'No private RPC inside identity/journal transaction');
    if (q.method === 'POST') assert.equal(db.prepare('SELECT phase FROM crm_campaign_delivery_v1 WHERE user_id=? AND remote_key=?').get(context.userId || USER, q.command.idempotency_key).phase, 'uncertain', 'durable dispatch precedes origin call');
    calls.push(clone(q));
    return service.handle({ actor: context.userId || USER, caps: ['read_content', 'draft', 'validate', 'submit'] }, q.command);
  };
  let transport = baseTransport;
  const cipherKey=crypto.randomBytes(32);
  const encrypt=value=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',cipherKey,iv),out=Buffer.concat([cipher.update(value),cipher.final()]);return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),out.toString('base64url')].join('.');};
  const decrypt=value=>{const [,i,a,b]=value.split('.'),cipher=crypto.createDecipheriv('aes-256-gcm',cipherKey,Buffer.from(i,'base64url'));cipher.setAuthTag(Buffer.from(a,'base64url'));return Buffer.concat([cipher.update(Buffer.from(b,'base64url')),cipher.final()]).toString();};
  const make = (overrides = {}) => createCampaignDelivery({ db, authorize, transport: (c, q) => transport(c, q), now: () => clock, encrypt,decrypt,prepareDefinition:(def,{catalog,id,now})=>C.prepare(def,{catalog,tracking:T,trackingId:id,now}).definition,...overrides });
  return { db, make, service, store, provider, calls, effects, ops, baseTransport, context: { userId: USER }, row: () => row, setRow: value => { row = value; }, clock: value => { clock = value; }, allowed: value => { allowed = value; }, mac: value => { mac = value; }, transport: value => { transport = value; }, audience, validation };
}
test('real campaign core schedules and cancels only their explicit actions; public results contain no body/key/receipt', async t => {
  for (const action of ['agendar', 'cancelar']) {
    const f = fixture(t, { action }), q = request(action), result = await f.make().submit(f.context, q);
    assert.equal(result.state, 'succeeded'); assert.equal(result.campaign.status, action === 'agendar' ? 'scheduled' : 'cancelled');
    assert.deepEqual(Object.keys(result), ['state', 'campaign']); assert.equal(Object.isFrozen(result.campaign), true);
    const local = f.db.prepare('SELECT * FROM crm_campaign_delivery_v1').get();
    assert.notEqual(local.remote_key, q.idempotency_key); assert.match(local.remote_key, /^bff-[a-f0-9]{64}$/);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1); assert.equal(f.effects.schedule + f.effects.cancel, 1);
    for (const hidden of [q.idempotency_key, local.remote_key, MAC, local.remote_operation_id, '{{ UnsubscribeURL }}']) assert.equal(JSON.stringify(result).includes(hidden), false);
  }
});
test('lost ACK after the effect resumes STATUS after SQLite restart; worker changes do not falsify historical success', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-delivery-only-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, { filename: path.join(directory, 'journal.sqlite') }), q = request();
  f.transport(async (c, r) => { const value = await f.baseTransport(c, r); if (r.method === 'POST') throw Error('SECRET_LOST_ACK'); return value; });
  assert.equal((await f.make().submit(f.context, q)).state, 'pending');
  assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase, 'uncertain');
  f.setRow({ ...f.row(), version: D, status: 'finished', sent: 3, started_at: iso(START + 3600000) }); f.clock(START + 7200000);
  f.db.close(); const restored = new DatabaseSync(path.join(directory, 'journal.sqlite')); t.after(() => restored.close());
  const readOnlyTransport = async (context, r) => { assert.equal(r.method, 'GET'); f.calls.push(clone(r)); return f.service.handle({ actor: context.userId, caps: ['read_content'] }, r.command); };
  const restarted = f.make({ db: restored, transport: readOnlyTransport });
  const before = f.calls.length, result = await restarted.reconcile(f.context, poll(q));
  assert.equal(f.calls[before].command.acao, 'campanha_operacao'); assert.equal(result.state, 'succeeded'); assert.equal(result.campaign.status, 'finished'); assert.equal(result.campaign.version, D); assert.equal(f.effects.schedule, 1);
});
test('timeout before origin + missing receipt stays uncertain across explicit calls and never posts again', async t => {
  const f = fixture(t), q = request(); let posts = 0;
  f.transport(async (c, r) => { if (r.method === 'POST') { posts++; throw Error('PRIVATE_TRANSPORT_CANARY'); } return f.baseTransport(c, r); });
  const delivery = f.make(); assert.equal((await delivery.submit(f.context, q)).state, 'pending');
  for (let i = 0; i < 3; i++) assert.equal((await delivery.reconcile(f.context, poll(q))).state, 'pending');
  assert.equal((await delivery.submit(f.context, q)).state, 'pending'); assert.equal(posts, 1); assert.equal(f.effects.schedule, 0);
  await assert.rejects(delivery.submit(f.context, { ...q, idempotency_key: 'browser-attempt-key-0002' }), { code: 'CAMPAIGN_DELIVERY_PENDING', status: 409 });
});
test('payload and current writer binding are immutable; another user cannot poll this journal', async t => {
  const f = fixture(t), q = request(), delivery = f.make();
  f.transport(async (c, r) => r.method === 'POST' ? { status: 404, body: { error: 'NOT_FOUND' } } : f.baseTransport(c, r));
  await delivery.submit(f.context, q);
  await assert.rejects(delivery.submit(f.context, { ...q, audience_review_id: crypto.randomUUID() }), { code: 'CAMPAIGN_DELIVERY_CONFLICT' });
  await assert.rejects(delivery.reconcile({ userId: OTHER }, poll(q)), { code: 'CAMPAIGN_DELIVERY_UNKNOWN' });
  f.mac('e'.repeat(64));
  await assert.rejects(delivery.reconcile(f.context, poll(q)), { code: 'CAMPAIGN_EDIT_DENIED' });
  await assert.rejects(delivery.submit(f.context, q), { code: 'CAMPAIGN_DELIVERY_CONFLICT' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM crm_campaign_delivery_v1').get().n, 1);
});
test('coalesced calls and two factories share one durable dispatch claim', async t => {
  const f = fixture(t), q = request(), barrier = deferred(); let reads = 0;
  f.transport(async (c, r) => { if (r.command.acao === 'campanha_obter' && ++reads <= 2) await barrier.promise; return f.baseTransport(c, r); });
  const a = f.make(), b = f.make(), calls = [a.submit(f.context, q), a.submit(f.context, q), b.submit(f.context, q)]; barrier.resolve();
  const results = await Promise.all(calls); assert.equal(results.some(r => r.state === 'succeeded'), true);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1); assert.equal(f.effects.schedule, 1);
});
test('authoritative terminal rejection releases the brand; bare POST rejection does not', async t => {
  const f = fixture(t), q = request(), delivery = f.make(); f.validation.audience.expires_at = iso(START - 1);
  const rejected = await delivery.submit(f.context, q); assert.equal(rejected.state, 'rejected'); assert.equal(f.effects.schedule, 0);
  assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase, 'rejected');
  f.validation.audience.expires_at = iso(START + 300000);
  assert.equal((await delivery.submit(f.context, { ...q, idempotency_key: 'browser-attempt-key-0002' })).state, 'succeeded');
});
test('backend outcome_unknown stays locked even when current state looks scheduled', async t => {
  const f = fixture(t), q = request(), original = f.provider.schedule;
  f.provider.schedule = async (...args) => { await original(...args); throw Error('AFTER_EFFECT_PRIVATE'); };
  const delivery = f.make(); assert.equal((await delivery.submit(f.context, q)).state, 'pending');
  assert.equal(f.row().status, 'scheduled'); assert.equal((await delivery.reconcile(f.context, poll(q))).state, 'pending');
  await assert.rejects(delivery.submit(f.context, { ...q, idempotency_key: 'browser-attempt-key-0002' }), { code: 'CAMPAIGN_DELIVERY_PENDING' });
  assert.equal(f.effects.schedule, 1);
});
test('source CAS recheck rejects a change between BFF preflight and POST without a provider effect', async t => {
  const f = fixture(t), q = request();
  f.transport(async (c, r) => { if (r.method === 'POST') f.setRow({ ...f.row(), version: D }); return f.baseTransport(c, r); });
  assert.equal((await f.make().submit(f.context, q)).state, 'rejected'); assert.equal(f.effects.schedule, 0);
});
test('preflight protects started/wrong-version/near-schedule and historical cancellation remains valid after its old time', async t => {
  for (const mutation of [r => ({ ...r, sent: 1 }), r => ({ ...r, started_at: iso(START) }), r => ({ ...r, version: D }), r => ({ ...r, send_at: iso(START + 14 * 60000) })]) {
    const f = fixture(t); f.setRow(mutation(f.row())); const d = f.make(), q = request();
    assert.equal((await d.submit(f.context, q)).state, 'rejected'); assert.equal((await d.reconcile(f.context, poll(q))).state, 'rejected'); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  }
  const f = fixture(t, { action: 'cancelar' }), q = request('cancelar'), d = f.make(); await d.submit(f.context, q); f.clock(START + 7200000);
  assert.equal((await d.reconcile(f.context, poll(q))).state, 'succeeded'); assert.equal(f.effects.cancel, 1);
});
test('forged receipt key/action/id/provider and inconsistent audience cannot close the attempt', async t => {
  for (const change of [o => { o.operation_key = 'unrelated-operation-key-01'; }, o => { o.action = 'cancelar'; }, o => { o.providerId = 8; }, o => { o.response.body.operation_id = crypto.randomUUID(); }, o => { o.response.body.campaign.id = 8; }, o => { o.response.body.audience.native_disabled_count = 1; }, o => { o.response.body.audience.campaign_version = D; }, o => { o.response.body.audience.expires_at = o.response.body.audience.rechecked_at; }]) {
    const f = fixture(t), q = request();
    f.transport(async (c, r) => { const value = await f.baseTransport(c, r); if (r.command.acao === 'campanha_operacao' && value.status === 200) change(value.body.operation); return value; });
    assert.equal((await f.make().submit(f.context, q)).state, 'pending'); assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase, 'uncertain');
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  }
});
test('current read outage retains confirmed intent; restored read confirms without another POST', async t => {
  const f = fixture(t), q = request(), d = f.make(); let gets = 0;
  f.transport(async (c, r) => { if (r.command.acao === 'campanha_obter' && ++gets > 1) throw Error('PRIVATE_READ_CANARY'); return f.baseTransport(c, r); });
  assert.equal((await d.submit(f.context, q)).state, 'pending'); assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase, 'confirmed');
  f.transport(f.baseTransport); assert.equal((await d.reconcile(f.context, poll(q))).state, 'succeeded'); assert.equal(f.effects.schedule, 1);
});
test('revocation during await prevents POST/promotion and preserves the attempt without raw errors', async t => {
  for (const at of ['preflight', 'post']) {
    const f = fixture(t), q = request();
    f.transport(async (c, r) => { const value = await f.baseTransport(c, r); if (at === 'preflight' && r.command.acao === 'campanha_obter' || at === 'post' && r.method === 'POST') f.allowed(false); return value; });
    let error; try { await f.make().submit(f.context, q); } catch (e) { error = e; }
    assert.equal(error.code, 'CAMPAIGN_EDIT_DENIED'); assert.equal(String(error).includes('PRIVATE'), false);
    assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase, at === 'preflight' ? 'queued' : 'uncertain'); assert.equal(f.effects.schedule, at === 'preflight' ? 0 : 1);
  }
});
test('read manager submission cap, wrong slot, no edit, Promise auth and caller fields are refused before any transport', async t => {
  const f = fixture(t), q = request(), base = { userId: USER, role: 'manager', slot: 'growth-campaign', canEdit: true, credentialMac: MAC, caps: ['read_content', 'draft', 'validate', 'submit'] };
  for (const a of [{ ...base, caps: ['read_content', 'list_history', 'submission'] }, { ...base, caps: ['read_content', 'submit'] }, { ...base, caps: ['read_content', 'validate', 'submit'] }, { ...base, caps: ['read_content', 'draft', 'submit'] }, { ...base, slot: 'crm-panel-read' }, { ...base, canEdit: false }, Promise.reject(Error('PRIVATE_REJECTION'))]) {
    await assert.rejects(f.make({ authorize: () => a }).submit(f.context, q), { code: 'CAMPAIGN_EDIT_DENIED' });
  }
  for (const input of [{ ...q, k: 'BROWSER_SECRET' }, { ...q, confirm: 'yes' }, { ...q, expected_version: 'invented-version' }, { ...q, brand: 'olivas' }, request('cancelar', { audience_review_id: REVIEW }), { ...q, acao: 'campanha_salvar' }]) await assert.rejects(f.make().submit(f.context, input), { code: 'CAMPAIGN_DELIVERY_INPUT' });
  assert.equal(f.calls.length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM crm_campaign_delivery_v1').get().n, 0);
});
test('no transport during construction or an open SQLite transaction', async t => {
  const f = fixture(t), d = f.make(); assert.equal(f.calls.length, 0); assert.deepEqual(Object.keys(d), ['submit', 'reconcile','describe']); assert.equal(Object.isFrozen(d), true);
  f.db.exec('BEGIN'); await assert.rejects(d.submit(f.context, request()), { code: 'CAMPAIGN_DELIVERY_TRANSACTION' });
  await assert.rejects(d.reconcile(f.context, poll(request())), { code: 'CAMPAIGN_DELIVERY_TRANSACTION' }); f.db.exec('ROLLBACK'); assert.equal(f.calls.length, 0);
});
test('save existing draft → review actual source → schedule → cancel preserves CAS and no effect until explicit schedule',async t=>{
 const f=fixture(t),d=f.make(),save={acao:'campanha_salvar',brand:'fish',id:7,expected_version:A,idempotency_key:'browser-save-existing-01',definition:{...f.row().definition,subject:'Changed isolated draft',send_at:iso(START+7200000)}};
 const saved=await d.submit(f.context,save);assert.equal(saved.state,'succeeded');assert.equal(saved.campaign.status,'draft');assert.equal(saved.campaign.sendAt,save.definition.send_at);assert.equal(f.effects.schedule,0);assert.equal(f.effects.cancel,0);
 const stored=f.db.prepare('SELECT definition_ciphertext FROM crm_campaign_delivery_v1').get();assert.match(stored.definition_ciphertext,/^v1\./);assert.equal(stored.definition_ciphertext.includes(save.definition.subject),false);
 const vq={acao:'campanha_validar',brand:'fish',id:7,expected_version:saved.campaign.version,idempotency_key:'browser-review-existing-01'};
 const reviewed=await d.submit(f.context,vq);assert.equal(reviewed.state,'succeeded');assert.equal(reviewed.validation.version,saved.campaign.version);assert.equal(f.effects.schedule,0);assert.equal(Object.isFrozen(reviewed.validation.audience.list_ids),true);
 const scheduled=await d.submit(f.context,request('agendar',{expected_version:reviewed.campaign.version,idempotency_key:'browser-schedule-existing-01',audience_review_id:reviewed.validation.audience.review_id}));assert.equal(scheduled.state,'succeeded');assert.equal(f.effects.schedule,1);
 const cancelled=await d.submit(f.context,request('cancelar',{expected_version:scheduled.campaign.version,idempotency_key:'browser-cancel-existing-01'}));assert.equal(cancelled.state,'succeeded');assert.equal(f.effects.cancel,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM crm_campaign_delivery_v1').get().n,4);
});
test('validation timeout+404 is durable and never repeats a review; review proof is historical after expiry',async t=>{
 const f=fixture(t),q={acao:'campanha_validar',brand:'fish',id:7,expected_version:A,idempotency_key:'browser-review-existing-01'},d=f.make();let posted=0;
 f.transport(async(c,r)=>{if(r.method==='POST'){posted++;throw Error('PRIVATE_REVIEW_TIMEOUT');}return f.baseTransport(c,r);});
 assert.equal((await d.submit(f.context,q)).state,'pending');assert.equal((await d.reconcile(f.context,poll(q))).state,'pending');assert.equal(posted,1);
 await assert.rejects(d.submit(f.context,{...q,idempotency_key:'browser-review-existing-02'}),{code:'CAMPAIGN_DELIVERY_PENDING'});
 const g=fixture(t),review=await g.make().submit(g.context,q);assert.equal(review.state,'succeeded');g.clock(START+300000);const old=await g.make().reconcile(g.context,poll(q));assert.equal(old.state,'succeeded');assert.equal(old.validation,null);
});
test('save lost ACK retains encrypted content and same private operation; does not update the provider a second time',async t=>{
 const f=fixture(t),d=f.make(),q={acao:'campanha_salvar',brand:'fish',id:7,expected_version:A,idempotency_key:'browser-save-existing-01',definition:{...f.row().definition,subject:'Private saved content'}};let posts=0;
 f.transport(async(c,r)=>{const value=await f.baseTransport(c,r);if(r.method==='POST'){posts++;throw Error('PRIVATE_SAVE_ACK');}return value;});
 assert.equal((await d.submit(f.context,q)).state,'pending');assert.equal((await d.reconcile(f.context,poll(q))).state,'succeeded');assert.equal(posts,1);
 await assert.rejects(d.submit(f.context,{...q,definition:{...q.definition,subject:'Different'}}),{code:'CAMPAIGN_DELIVERY_CONFLICT'});
});
test('forged saved definition and forged validation version keep the local journal locked',async t=>{
 for(const action of ['salvar','validar']){const f=fixture(t),q=action==='salvar'?{acao:'campanha_salvar',brand:'fish',id:7,expected_version:A,idempotency_key:'browser-save-existing-01',definition:f.row().definition}:{acao:'campanha_validar',brand:'fish',id:7,expected_version:A,idempotency_key:'browser-review-existing-01'};
 f.transport(async(c,r)=>{const value=await f.baseTransport(c,r);if(r.command.acao==='campanha_operacao'&&value.status===200){if(action==='salvar')value.body.operation.response.body.campaign.definition.subject='Forged';else value.body.operation.response.body.validation.version=D;}return value;});assert.equal((await f.make().submit(f.context,q)).state,'pending');assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase,'uncertain');}
});
test('real SQLite closure cannot leak a raw storage error through the public component boundary', async t => {
  const f = fixture(t), d = f.make(); f.db.close();
  for (const invoke of [() => d.submit(f.context, request()), () => d.reconcile(f.context, poll(request()))]) {
    await assert.rejects(invoke(), error => error.name === 'CampaignDeliveryError' && error.code === 'CAMPAIGN_DELIVERY_CONFIG' && Object.keys(error).sort().join(',') === 'code,name,status' && !String(error).includes('database'));
  }
  assert.throws(() => f.make(), { code: 'CAMPAIGN_DELIVERY_CONFIG' }); assert.equal(f.calls.length, 0);
});
