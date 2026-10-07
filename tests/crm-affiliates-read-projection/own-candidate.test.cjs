'use strict';
// Testes da projeção READ com identidade explícita de cadastro próprio (own_candidate_record) — C1.
// Módulo REAL + normalizador 1.0.3 REAL desta entrega por require comum; entradas anteriores lidas no
// lugar e conferidas por pin (normalizador 330b e projeção r7 fechada). DTOs sintéticos em RAM.
// Ambiente: C1_AFFILIATES_ROOT = caminho absoluto da raiz Afiliados (padrão: diretório atual).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.C1_AFFILIATES_ROOT || process.cwd();
assert.ok(path.isAbsolute(ROOT), 'C1_AFFILIATES_ROOT deve ser absoluto');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PINNED = {
  normalizer102: ['tests/affiliates-v2/fixtures/contract-v102.cjs', '330b00b3e241223f53ebfade63099da33f1f5de55e6fb6908a500a11c027a420'],
  projectionR7: ['tests/crm-affiliates-read-projection/fixtures/provider-bound-projection-v1.cjs', 'f2ae9fa732451e1930979e05640943a691b7d39f5be4ed9610ea4117f551d841']
};
function verifyPins() {
  const out = {};
  for (const [k, [rel, want]] of Object.entries(PINNED)) {
    const full = path.join(ROOT, rel), st = fs.lstatSync(full);
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'arquivo regular: ' + rel);
    assert.equal(sha(fs.readFileSync(full)), want, 'pin: ' + rel);
    out[k] = full;
  }
  return out;
}
const PIN = verifyPins();
const N102 = require(PIN.normalizer102);
const R7 = require(PIN.projectionR7);
const N = require(path.join(__dirname, '..', '..', 'ui', 'affiliates-v2', 'affiliates-contract-v1.0.3.js'));
const MODULE_PATH = path.join(__dirname, '..', '..', 'services', 'dashboard-operational', 'domain', 'affiliates-read-projection', 'projection.cjs');
const CACHE_BEFORE = new Set(Object.keys(require.cache));
const M = require(MODULE_PATH);
const CACHE_ADDED = Object.keys(require.cache).filter((k) => !CACHE_BEFORE.has(k));
const P = M.createProjection({ normalizer: N });
const P7 = R7.createProjection({ normalizer: N102 });

// ---------- fixtures sintéticos ----------
const PERIOD = { start: '2026-09-01', end: '2026-09-30' };
const U1 = '1a2b3c4d-0000-4000-8000-000000000001', U2 = '1a2b3c4d-0000-4000-8000-000000000002', U3 = '1a2b3c4d-0000-4000-8000-000000000003', U4 = '1A2B3C4D-0000-4000-8000-00000000000A';
const SENTINEL = 'SENTINELA-OC-4471';
const ctx = (brand = 'aristo', extra = {}) => Object.assign({ contextRevision: 'ctx-r1', effectiveBrand: brand, principalReference: 'p-1', role: 'read' }, extra);
const q = (resource = 'creators', filters = { period: { ...PERIOD } }, rev = 'ctx-r1') => ({ resource, filters, expectedContextRevision: rev });
function rows() {
  return [
    { id: U1, marca: 'aristo', name: 'Ana Sintética', handle: 'ana', source: 'manual', source_reference: 'cupom ANA10', state: 'aprovado_piloto', note: 'pix ' + SENTINEL, version: 3, created_at: '2026-09-02T10:00:00Z', updated_at: '2026-09-20T10:00:00Z' },
    { id: U2, marca: 'fish', name: 'Ana Sintética', handle: 'ana', source: 'formulario_site', source_reference: '', state: 'novo', note: '', version: 1, created_at: '2026-09-03T10:00:00Z', updated_at: '2026-09-19T10:00:00Z' },
    { id: U3, marca: 'aristo', name: 'Ana Sintética', handle: 'ana', source: 'manual', source_reference: 'anúncio 99', state: 'em_analise', note: 'tarefa: ligar', version: 7, created_at: '2026-09-04T10:00:00Z', updated_at: '2026-09-18T10:00:00Z' },
    { id: U4, marca: 'aristo', name: 'Bruno Sintético', handle: '', source: 'manual', source_reference: '', state: 'novo', note: '', version: 1, created_at: '2026-09-05T10:00:00Z', updated_at: '2026-09-17T10:00:00Z' }
  ];
}
function legacy(candidates = rows(), over = {}) {
  return Object.assign({
    janela: { ini: PERIOD.start, fim: PERIOD.end }, roi: [], influs: [], cupons: [{ marca: 'aristo', influ: 'ana', codigo: 'ANA10' }], custos: [], receita_cupom: [], termos: [],
    pilot: { schema: 'creator_pilot_v1', since: PERIOD.start, until: PERIOD.end, programs: [], candidates,
      sources: [{ marca: 'aristo', account_name: 'conta', state: 'ok', covers_period: true, since: PERIOD.start, until: PERIOD.end }],
      coupon_by_creator: [{ marca: 'aristo', influ: 'ana', paid_orders: 3, receita_cupom: 999 }], tracking_active: true, payout_active: false }
  }, over);
}
const obs = (brand = 'aristo', over = {}) => Object.assign({ contextRevision: 'ctx-r1', brandId: brand, period: { ...PERIOD }, coverage: 'complete', freshness: 'fresh', collectedAt: '2026-10-06T12:00:00.000Z', cacheAt: null }, over);
function ownArgs(over = {}) { return Object.assign({ query: q(), context: ctx(), legacy: legacy(), observation: obs(), identityMode: 'own_candidate_record' }, over); }
const own = (id, version, name, handle, stage, brand = 'aristo') => ({ id, identityKind: 'own_candidate_record', identitySource: 'crm_partner_candidate_v1', sourceRecordId: id, sourceRecordRevision: version, provider: null, brandId: brand, providerId: null, displayName: name, handle, ownerReference: null, stage, revision: version });
const OWN_U1 = own(U1, 3, 'Ana Sintética', 'ana', 'aprovado_piloto'), OWN_U3 = own(U3, 7, 'Ana Sintética', 'ana', 'em_analise'), OWN_U4 = own(U4, 1, 'Bruno Sintético', null, 'novo');
const binding = (sourceRecordId, sourceRecordRevision, creatorId, providerId) => ({ sourceKind: 'crm_partner_candidate_v1', sourceRecordId, sourceRecordRevision, creatorId, provider: 'tiktok', providerId });
const bindings = (items) => ({ revision: 'idb-1', brandId: 'aristo', items: items || [binding(U1, 3, 7, 'tt-001'), binding(U3, 1 + 6, 'c-3', 'tt-003'), binding(U4, 1, 'c-4', 'tt-004')] });
const MSG = {
  IDENTITY_MODE_INVALID: 'Leitura indisponível: modo de identidade do criador ausente, desconhecido ou em conflito.',
  BINDING_INVALID: 'Leitura indisponível: vínculo persistido de identidade ausente ou divergente.',
  OBSERVATION_INVALID: 'Leitura indisponível: metadados da leitura ausentes ou divergentes.',
  SOURCE_INVALID: 'Leitura indisponível: fonte legada sem janela, marca ou registros íntegros.',
  CREATOR_UNKNOWN: 'Perfil indisponível: criador não encontrado na leitura desta marca.',
  EMPTY_UNPROVEN: 'Leitura indisponível: ausência de registros não confirmada por leitura completa e atual.',
  BRAND_UNSUPPORTED: 'Leitura indisponível: marca efetiva sem projeção individual admitida.',
  TASKS_SOURCE_ABSENT: 'Tarefas indisponíveis: Root ainda não entregou leitura própria de tarefas.',
  TASKS_INVALID: 'Tarefas indisponíveis: snapshot próprio sem marca, período ou registros íntegros.'
};
function assertClosed(r, code, brand = 'aristo', label = code) {
  assert.deepEqual(r, { state: 'unavailable', brandId: brand, contextRevision: 'ctx-r1', source: 'unknown', coverage: 'unknown', freshness: 'unknown', collectedAt: null, cacheAt: null, data: null, error: MSG[code] }, label);
}
const norm = (dto, a) => N.envelope(dto, a.context, a.query.resource, a.query.filters);

// ---------- casos ----------
test('pins: normalizador 330b e projeção r7 lidos no lugar; módulo novo sem dependências', () => {
  assert.equal(N.version, '1.0.3-proposed'); assert.equal(N102.version, '1.0.2-proposed');
  assert.deepEqual(CACHE_ADDED, [require.resolve(MODULE_PATH)], 'o módulo não carrega nenhum outro módulo');
});

test('cadastro próprio: UUID e version literais viram id/revisão; plataforma null; normalizador 1.0.3 aceita', () => {
  const a = ownArgs(), r = P.projectLegacyRead(a);
  assert.deepEqual(r, { state: 'ready', brandId: 'aristo', contextRevision: 'ctx-r1', source: 'own_declared', coverage: 'complete', freshness: 'fresh', collectedAt: '2026-10-06T12:00:00.000Z', cacheAt: null, error: null, data: { items: [OWN_U1, OWN_U3, OWN_U4] } });
  assert.equal(r.data.items[2].id, U4, 'UUID literal preservado, inclusive caixa alta');
  for (const c of r.data.items) assert.deepEqual(Object.keys(c), ['id', 'identityKind', 'identitySource', 'sourceRecordId', 'sourceRecordRevision', 'provider', 'brandId', 'providerId', 'displayName', 'handle', 'ownerReference', 'stage', 'revision']);
  const n = norm(r, a);
  assert.ok(n.env && !n.error); assert.deepEqual(n.env.items, [OWN_U1, OWN_U3, OWN_U4]);
  assert.ok(N102.envelope(r, a.context, 'creators', a.query.filters).error, 'consumidor 1.0.2 não aceita cadastro sem provedor: exige 1.0.3');
  assert.ok(Object.isFrozen(r.data.items[0]));
});

test('mesmo handle/nome não une cadastros; UUID repetido em outra caixa fecha; outra marca nunca entra', () => {
  const r = P.projectLegacyRead(ownArgs());
  const anas = r.data.items.filter((c) => c.handle === 'ana');
  assert.equal(anas.length, 2); assert.notEqual(anas[0].id, anas[1].id); assert.deepEqual(anas.map((c) => c.revision), [3, 7]);
  assert.ok(!r.data.items.some((c) => c.id === U2), 'linha fish excluída em aristo');
  const fishArgs = ownArgs({ context: ctx('fish'), observation: obs('fish') });
  const f = P.projectLegacyRead(fishArgs);
  assert.deepEqual(f.data.items, [own(U2, 1, 'Ana Sintética', 'ana', 'novo', 'fish')]);
  assert.ok(norm(f, fishArgs).env);
  const dupCase = rows(); dupCase[3] = Object.assign({}, dupCase[0], { id: U1.toUpperCase(), version: 4 });
  assertClosed(P.projectLegacyRead(ownArgs({ legacy: legacy(dupCase) })), 'SOURCE_INVALID');
  for (const brand of ['todas', 'olivas']) assertClosed(P.projectLegacyRead(ownArgs({ context: ctx(brand), observation: obs(brand) })), 'BRAND_UNSUPPORTED', brand);
});

test('lista e perfil mantêm a mesma identidade e revisão; ID de outra caixa ou marca não abre perfil', () => {
  const list = P.projectLegacyRead(ownArgs());
  for (const c of list.data.items) {
    const a = ownArgs({ query: q('creator-profile', { period: { ...PERIOD }, creatorId: c.id }) });
    const pr = P.projectLegacyRead(a);
    assert.equal(pr.state, 'ready');
    assert.deepEqual(pr.data.creator, c, 'mesmo DTO da lista');
    assert.deepEqual(pr.data.references, { samples: null, products: null, content: null, tasks: null });
    assert.deepEqual(pr.data.period, PERIOD);
    const n = norm(pr, a); assert.ok(n.env); assert.equal(n.env.data.creator.revision, c.revision);
  }
  for (const creatorId of [U1.toUpperCase(), U2, 'ana', 7]) {
    assertClosed(P.projectLegacyRead(ownArgs({ query: q('creator-profile', { period: { ...PERIOD }, creatorId }) })), 'CREATOR_UNKNOWN', 'aristo', String(creatorId));
  }
});

test('modo explícito de Root: ausente, desconhecido, vindo do contexto/linhas ou em colisão fecha; social nunca cai no próprio', () => {
  const noMode = ownArgs(); delete noMode.identityMode;
  for (const a of [noMode, ownArgs({ identityMode: 'own' }), ownArgs({ identityMode: 'OWN_CANDIDATE_RECORD' }), ownArgs({ identityMode: null }),
    (() => { const x = ownArgs({ context: ctx('aristo', { identityMode: 'own_candidate_record' }) }); delete x.identityMode; return x; })(),
    ownArgs({ identityBindings: bindings() }), ownArgs({ identityBindings: null }), ownArgs({ identityBindings: undefined })]) {
    assertClosed(P.projectLegacyRead(a), 'IDENTITY_MODE_INVALID');
  }
  const rowMode = rows().map((r) => Object.assign(r, { identityKind: 'provider_bound', provider: 'tiktok', providerId: 'tt-' + r.version }));
  const rm = P.projectLegacyRead(ownArgs({ legacy: legacy(rowMode) }));
  assert.ok(rm.data.items.every((c) => c.identityKind === 'own_candidate_record' && c.provider === null && c.providerId === null), 'linha não escolhe modo nem plataforma');
  const social = (identityBindings) => ownArgs({ identityMode: 'provider_bound', identityBindings });
  for (const b of [undefined, null, bindings([binding(U1, 3, 7, 'tt-001')]), bindings([binding(U1, 2, 7, 'tt-001'), binding(U3, 7, 'c-3', 'tt-003'), binding(U4, 1, 'c-4', 'tt-004')]), Object.assign(bindings(), { brandId: 'fish' })]) {
    const r = P.projectLegacyRead(social(b));
    assertClosed(r, 'BINDING_INVALID');
    assert.ok(!JSON.stringify(r).includes('own_candidate_record') && !JSON.stringify(r).includes(U1));
  }
});

test('provider_bound continua igual à projeção r7, agora com identityKind explícito', () => {
  const b = bindings();
  const a = ownArgs({ identityMode: 'provider_bound', identityBindings: b });
  const r = P.projectLegacyRead(a);
  const old = P7.projectLegacyRead({ query: q(), context: ctx(), legacy: legacy(), observation: obs(), identityBindings: b });
  assert.equal(r.state, 'ready'); assert.equal(old.state, 'ready');
  assert.deepEqual(r.data.items.map((c) => { const x = Object.assign({}, c); delete x.identityKind; return x; }), old.data.items);
  assert.ok(r.data.items.every((c) => c.identityKind === 'provider_bound'));
  assert.deepEqual(Object.assign({}, r, { data: null }), Object.assign({}, old, { data: null }));
  assert.ok(norm(r, a).env);
  const pa = ownArgs({ identityMode: 'provider_bound', identityBindings: b, query: q('creator-profile', { period: { ...PERIOD }, creatorId: 7 }) });
  const pr = P.projectLegacyRead(pa);
  assert.deepEqual(pr.data.creator, r.data.items[0]); assert.ok(norm(pr, pa).env);
});

test('metadados herdados da fonte não confirmam cobertura/frescor; vazio antigo/parcial não é vazio comprovado', () => {
  for (const observation of [undefined, null, obs('aristo', { brandId: 'fish' }), obs('aristo', { contextRevision: 'ctx-r0' }), obs('aristo', { period: { start: '2026-08-01', end: '2026-08-31' } })]) {
    assertClosed(P.projectLegacyRead(ownArgs({ observation })), 'OBSERVATION_INVALID');
  }
  const r = P.projectLegacyRead(ownArgs({ observation: obs('aristo', { coverage: 'partial', freshness: 'stale', collectedAt: null }) }));
  assert.deepEqual([r.state, r.coverage, r.freshness, r.collectedAt], ['ready', 'partial', 'stale', null], 'covers_period/updated_at/tracking da fonte não sobem cobertura nem frescor');
  const onlyFish = legacy([rows()[1]]);
  const e = P.projectLegacyRead(ownArgs({ legacy: onlyFish }));
  assert.equal(e.state, 'empty'); assert.deepEqual(e.data, { items: [] });
  assert.ok(norm(e, ownArgs()).env);
  for (const o of [{ coverage: 'partial' }, { coverage: 'unknown' }, { freshness: 'stale' }, { freshness: 'unknown' }]) {
    assertClosed(P.projectLegacyRead(ownArgs({ legacy: onlyFish, observation: obs('aristo', o) })), 'EMPTY_UNPROVEN', 'aristo', JSON.stringify(o));
  }
});

test('nota, Pix, cupom, anúncio e financeiro não chegam ao cadastro próprio; entradas intactas', () => {
  const a = ownArgs(), before = structuredClone(a);
  const s = JSON.stringify(P.projectLegacyRead(a)) + JSON.stringify(P.projectLegacyRead(ownArgs({ query: q('creator-profile', { period: { ...PERIOD }, creatorId: U1 }) })));
  for (const bad of [SENTINEL, 'pix', 'cupom', 'ANA10', 'anúncio', 'receita', '999', 'tarefa: ligar', 'source_reference', 'updated_at', 'covers_period', 'tiktok']) assert.ok(!s.includes(bad), 'vazou: ' + bad);
  assert.deepEqual(a, before);
});

test('tarefas: FK pelo UUID próprio exato; modos misturados ou cadastro com plataforma inventada fecham', () => {
  const ctxT = ctx('aristo', { taskStateCatalog: { revision: 'tc', items: [{ value: 'aberta', label: 'Aberta', open: true, terminal: false }] } });
  const task = (over = {}) => Object.assign({ id: 't-1', brandId: 'aristo', creatorId: U1, label: 'Enviar briefing', state: 'aberta', dueAt: null, ownerReference: null, revision: 1 }, over);
  const snap = (items) => ({ state: 'ready', brandId: 'aristo', contextRevision: 'ctx-r1', source: 'own_declared', coverage: 'complete', freshness: 'fresh', collectedAt: null, cacheAt: null, error: null, data: { period: { ...PERIOD }, items } });
  const args = (over) => Object.assign({ query: q('tasks'), context: ctxT, snapshot: snap([task()]), knownCreators: [OWN_U1, OWN_U3] }, over);
  const ok = P.projectTaskRead(args());
  assert.equal(ok.state, 'ready'); assert.equal(ok.data.items[0].creatorId, U1); assert.equal(ok.data.items[0].open, true);
  assert.ok(N.envelope(ok, ctxT, 'tasks', { period: { ...PERIOD } }).env);
  assertClosed(P.projectTaskRead(args({ snapshot: null })), 'TASKS_SOURCE_ABSENT');
  const bound = { id: 7, identityKind: 'provider_bound', provider: 'tiktok', brandId: 'aristo', providerId: 'tt-1', displayName: 'X', handle: null, ownerReference: null, stage: null, revision: 1 };
  for (const [label, a] of Object.entries({
    'FK em outra caixa': args({ snapshot: snap([task({ creatorId: U1.toUpperCase() })]) }),
    'FK de cadastro fora da lista': args({ snapshot: snap([task({ creatorId: U4 })]) }),
    'modos misturados': args({ knownCreators: [OWN_U1, bound] }),
    'plataforma inventada': args({ knownCreators: [Object.assign({}, OWN_U1, { provider: 'tiktok' })] }),
    'providerId parcial': args({ knownCreators: [Object.assign({}, OWN_U1, { providerId: 'tt-1' })] }),
    'provider ausente': args({ knownCreators: [(() => { const c = Object.assign({}, OWN_U1); delete c.provider; return c; })()] }),
    'revisão diferente da version': args({ knownCreators: [Object.assign({}, OWN_U1, { revision: 4 })] }),
    'sem identityKind': args({ knownCreators: [(() => { const c = Object.assign({}, OWN_U1); delete c.identityKind; return c; })()] })
  })) assertClosed(P.projectTaskRead(a), 'TASKS_INVALID', 'aristo', label);
});

test('fábrica exige o normalizador 1.0.3 desta entrega; metadados OFF constantes', () => {
  const msg = /^Projeção requer o normalizador Root 1\.0\.3-proposed injetado\.$/;
  for (const normalizer of [N102, undefined, Object.assign({}, N, { envelope: undefined }), Object.assign({}, N, { version: '1.0.4-proposed' })]) {
    assert.throws(() => M.createProjection({ normalizer }), (e) => e instanceof TypeError && msg.test(e.message));
  }
  assert.deepEqual(Object.keys(M), ['createProjection', 'metadata']);
  assert.deepEqual(M.metadata, { schema: 'shrigma-affiliates-read-projection-v1', contractVersion: '1.1.0-source-proposed', normalizerVersion: '1.0.3-proposed', identityModes: ['own_candidate_record', 'provider_bound'], sourceOnly: true, operational: false, readAdmission: false, writeAuthorized: false, sendAuthorized: false });
  assert.ok(Object.isFrozen(M.metadata) && Object.isFrozen(M.metadata.identityModes));
  assert.deepEqual(Object.keys(P), ['planLegacyRead', 'projectLegacyRead', 'projectTaskRead']);
  assert.deepEqual(P.planLegacyRead({ query: q(), context: ctx() }).request.fields, { acao: 'listar', ini: '2026-09-01', fim: '2026-09-30', pilot: true, marca: 'aristo' }, 'mesmo seletor existente');
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  for (const token of [/\brequire\(/, /\bfetch\b/, /XMLHttpRequest/, /\bprocess\./, /Date\.now/, /new Date/, /Math\.random/, /randomUUID/, /setTimeout|setInterval/, /beginMutation|submit\(/]) assert.ok(!token.test(src), String(token));
  assert.equal(sha(fs.readFileSync(PIN.projectionR7)), PINNED.projectionR7[1], 'entrega r7 intacta');
  assert.deepEqual(verifyPins(), PIN);
});
