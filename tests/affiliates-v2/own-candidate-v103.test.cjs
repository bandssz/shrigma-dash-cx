'use strict';
// Teste focal do normalizador 1.0.3 e do leitor ShrigmaAffiliatesV103 (cadastro próprio, plataforma não vinculada).
// Normalizador e leitor REAIS desta entrega; normalizador 330b, leitor base r5 e MiniDOM lidos no lugar e
// conferidos por pin. MiniDOM não prova layout visual. Gateway sintético em RAM; gravações sempre OFF.
// Ambiente: C1_AFFILIATES_ROOT = caminho absoluto da raiz Afiliados (padrão: diretório atual).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = process.env.C1_AFFILIATES_ROOT || process.cwd();
assert.ok(path.isAbsolute(ROOT), 'C1_AFFILIATES_ROOT deve ser absoluto');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PINNED = {
  normalizer102: ['tests/affiliates-v2/fixtures/contract-v102.cjs', '330b00b3e241223f53ebfade63099da33f1f5de55e6fb6908a500a11c027a420'],
  readerR5: ['tests/affiliates-v2/fixtures/reader-v102-profile.cjs', '9ac8cac7b38c9ca6065c2490eeab662834384dd6703ca9ca65f1043905091ce1'],
  miniDom: ['tests/affiliates-v2/mini-dom.cjs', 'd7ff99dba627013337a6c4a1f458da3242eeecb3c86d585e2e0f4e5a6083f75c']
};
function verifyPins() {
  const out = {};
  for (const [k, [rel, want]] of Object.entries(PINNED)) {
    const full = path.join(ROOT, rel), st = fs.lstatSync(full), b = fs.readFileSync(full);
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'arquivo regular: ' + rel);
    assert.equal(sha(b), want, 'pin: ' + rel);
    out[k] = { path: full, bytes: b };
  }
  return out;
}
const PIN = verifyPins();
const N102 = require(PIN.normalizer102.path);
const { Document } = require(PIN.miniDom.path);
const N103_PATH = path.join(__dirname, '..', '..', 'ui', 'affiliates-v2', 'affiliates-contract-v1.0.3.js');
const READER_PATH = path.join(__dirname, '..', '..', 'ui', 'affiliates-v2', 'affiliates-v103.js');
const N = require(N103_PATH);
function loadUMD(src, name) { const sb = vm.createContext({}); vm.runInContext(src, sb); return sb[name]; }
const V103 = loadUMD(fs.readFileSync(READER_PATH, 'utf8'), 'ShrigmaAffiliatesV103');
const V3 = loadUMD(PIN.readerR5.bytes.toString('utf8'), 'ShrigmaAffiliatesV3');
const N103_GLOBAL = loadUMD(fs.readFileSync(N103_PATH, 'utf8'), 'ShrigmaAffiliatesContractV103');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const P = { start: '2026-09-01', end: '2026-09-30' };
const U1 = '5e0c7a10-0000-4000-8000-000000000001', U2 = '5e0c7a10-0000-4000-8000-000000000002', U3 = '5e0c7a10-0000-4000-8000-000000000003';
const KINDS = ['creator.create', 'creator.update', 'creator.archive', 'sample.record-manual', 'sample.update-manual', 'task.create', 'task.update', 'content.record-manual', 'content.update-manual'];
const CTX = (o = {}) => ({ contextRevision: 'r1', sessionRevision: 's1', effectiveBrand: 'aristo', effectiveBrandLabel: 'O Aristocrata', principalReference: 'p-1', role: 'write',
  capabilities: Object.fromEntries(KINDS.map((k) => [k, { available: false, reason: 'Mutação não admitida por Root.' }])),
  stageCatalog: null, taskStateCatalog: null,
  operationJournal: { state: 'complete', revision: 'j1', preparationRecovery: 'quiescent', reason: null }, pendingOperations: [], ...o });
const own = (id, version, name, handle, stage, brand = 'aristo') => ({ id, identityKind: 'own_candidate_record', identitySource: 'crm_partner_candidate_v1', sourceRecordId: id, sourceRecordRevision: version, provider: null, brandId: brand, providerId: null, displayName: name, handle, ownerReference: null, stage, revision: version });
const bound = (id, provider, providerId, name, handle, revision) => ({ id, identityKind: 'provider_bound', provider, brandId: 'aristo', providerId, displayName: name, handle, ownerReference: null, stage: 'novo', revision });
const OWN = () => [own(U1, 3, 'Ana Sintética', 'ana', 'aprovado_piloto'), own(U2, 7, 'Ana Sintética', 'ana', 'em_analise'), own(U3, 1, 'Bruno Sintético', null, 'novo')];
const BOUND = () => [bound('c-1', 'tiktok', 'tt-001', 'Ana Sintética', 'ana', 3), bound(7, 'instagram', 'ig-7', 'Bruno Sintético', null, 2)];
function E(q, data, o = {}) {
  const d = data === null ? null : { ...data };
  if (d && q.filters.period && !('period' in d) && q.resource !== 'creators' && q.resource !== 'products') d.period = clone(q.filters.period);
  return { state: 'ready', contextRevision: q.expectedContextRevision, brandId: 'aristo', source: 'own_declared', coverage: 'complete', freshness: 'fresh', collectedAt: '2026-10-06T12:00:00Z', cacheAt: null, data: d, error: null, ...o };
}
const UNAV = (q) => E(q, null, { state: 'unavailable', error: 'Sem fonte própria nesta leitura.' });
const readsFor = (list) => ({
  creators: (q) => E(q, { items: list() }),
  samples: UNAV, products: UNAV, content: UNAV, tasks: UNAV, 'own-performance': UNAV,
  'creator-profile': (q) => E(q, { creator: list().find((c) => c.id === q.filters.creatorId), references: { samples: null, products: null, content: null, tasks: null } })
});
function mount(A, normalizer, cfg = {}) {
  const document = new Document(), element = document.createElement('div');
  document.body.appendChild(element);
  const calls = [], violations = [];
  let reads = cfg.reads || readsFor(OWN);
  const impl = {
    context() { calls.push({ m: 'context' }); return Promise.resolve(clone(cfg.ctx || CTX())); },
    read(q) { calls.push({ m: 'read', q: clone(q) }); return Promise.resolve(clone(reads[q.resource](q))); }
  };
  const gateway = new Proxy(impl, { get(t, k) { if (typeof k === 'symbol') return undefined; if (!['context', 'read', 'receipt'].includes(k)) { violations.push(String(k)); throw new Error('fora do contrato'); } return t[k]; } });
  const inst = A.create({ element, document, gateway, normalizer });
  return { inst, calls, violations, setReads(r) { reads = r; }, $: (s) => element.querySelector(s), $$: (s) => element.querySelectorAll(s) };
}
async function ready(A, normalizer, cfg) { const x = mount(A, normalizer, cfg); await x.inst.sync({ filters: { period: P } }); await flush(); return x; }
const env = (items, o = {}) => ({ state: 'ready', contextRevision: 'r1', brandId: 'aristo', source: 'own_declared', coverage: 'complete', freshness: 'fresh', collectedAt: null, cacheAt: null, error: null, data: { items }, ...o });
const prof = (creator) => ({ state: 'ready', contextRevision: 'r1', brandId: 'aristo', source: 'own_declared', coverage: 'complete', freshness: 'fresh', collectedAt: null, cacheAt: null, error: null, data: { period: P, creator, references: { samples: null, products: null, content: null, tasks: null } } });
const listOK = (items) => N.envelope(env(items), CTX(), 'creators', { period: P });
const profOK = (c, id = c && c.id) => N.envelope(prof(c), CTX(), 'creator-profile', { period: P, creatorId: id });

// ---------- normalizador 1.0.3 ----------
test('pins e superfície: 1.0.3 tem a mesma API pública do 1.0.2, só muda versão e identidade do criador', () => {
  assert.equal(N.version, '1.0.3-proposed'); assert.equal(N103_GLOBAL.version, '1.0.3-proposed');
  assert.deepEqual(Object.keys(N), Object.keys(N102)); assert.ok(Object.isFrozen(N));
});

test('normalizador: cadastro próprio e vínculo de provedor explícitos são aceitos; identidade parcial, ausente ou inferida fecha', () => {
  assert.deepEqual(listOK(OWN()).env.items, OWN());
  assert.deepEqual(listOK(BOUND()).env.items, BOUND());
  assert.deepEqual(profOK(OWN()[0]).env.data.creator, OWN()[0]);
  const o = () => OWN()[0];
  const drop = (k) => { const c = o(); delete c[k]; return c; };
  const refused = {
    'sem identityKind': drop('identityKind'), 'identityKind desconhecido': { ...o(), identityKind: 'handle' },
    'provider inventado': { ...o(), provider: 'tiktok' }, 'providerId parcial': { ...o(), providerId: 'tt-1' }, 'provider ausente': drop('provider'), 'providerId ausente': drop('providerId'),
    'id diferente do UUID': { ...o(), id: U2 }, 'id em outra caixa': { ...o(), id: U1.toUpperCase() }, 'revisão diferente da version': { ...o(), revision: 4 },
    'sourceRecordId não UUID': { ...o(), id: 'ana', sourceRecordId: 'ana' }, 'version texto': { ...o(), sourceRecordRevision: '3', revision: '3' }, 'version zero': { ...o(), sourceRecordRevision: 0, revision: 0 },
    'fonte diferente': { ...o(), identitySource: 'tiktok_affiliate' }, 'sem fonte': drop('identitySource'), 'outra marca': { ...o(), brandId: 'fish' }, 'sem nome': { ...o(), displayName: '' },
    'social sem provider': { ...BOUND()[0], provider: null }, 'social sem providerId': { ...BOUND()[0], providerId: null },
    'social com campos do próprio': { ...BOUND()[0], sourceRecordId: U1 }, 'próprio rotulado social': { ...o(), identityKind: 'provider_bound' }
  };
  for (const [label, c] of Object.entries(refused)) {
    assert.ok(listOK([c]).error, 'lista: ' + label);
    assert.ok(profOK(c, c.id === undefined ? U1 : c.id).error, 'perfil: ' + label);
  }
  assert.equal(listOK([OWN()[0], BOUND()[0]]).error, 'Coleção mistura modos de identidade de criador.');
  assert.ok(profOK(OWN()[0], U2).error, 'perfil precisa do mesmo ID pedido');
  // Contrato 1.0.2 legado (sem identityKind) não é aceito por 1.0.3; o 1.0.2 continua aceitando seus bytes.
  const legacy102 = { id: 'c-1', provider: 'tiktok', brandId: 'aristo', providerId: 'tt-1', displayName: 'Ana', handle: 'ana', ownerReference: null, stage: null, revision: 3 };
  assert.ok(listOK([legacy102]).error);
  assert.ok(N102.envelope(env([legacy102]), CTX(), 'creators', { period: P }).env);
});

test('normalizador: vazio antigo/parcial não é vazio comprovado; demais recursos idênticos ao 1.0.2', () => {
  assert.equal(listOK([]).error, 'Vazio exige estado empty explícito no contrato 1.0.2.');
  assert.ok(N.envelope(env([], { state: 'empty', coverage: 'partial' }), CTX(), 'creators', {}).error);
  assert.ok(N.envelope(env([], { state: 'empty' }), CTX(), 'creators', {}).env);
  const fixtures = [
    ['samples', { period: P }, E({ resource: 'samples', filters: { period: P }, expectedContextRevision: 'r1' }, { items: [{ id: 's-1', creatorId: U1, sku: 'SKU', manualStatus: 'ok', revision: 1 }] })],
    ['tasks', { period: P }, E({ resource: 'tasks', filters: { period: P }, expectedContextRevision: 'r1' }, { items: [{ id: 't-1', creatorId: U1, label: 'L', state: 'aberta', open: true, terminal: false, revision: 1 }] })],
    ['tasks', { period: P }, E({ resource: 'tasks', filters: { period: P }, expectedContextRevision: 'r1' }, { items: [] }, { state: 'empty', coverage: 'partial' })],
    ['products', {}, E({ resource: 'products', filters: {}, expectedContextRevision: 'r1' }, { items: [{ id: 'p-1', sku: 'SKU', label: 'Produto' }] })],
    ['content', { period: P }, E({ resource: 'content', filters: { period: P }, expectedContextRevision: 'r1' }, { items: [{ id: 'x', creatorId: U1, provider: 'tiktok', kind: 'video', revision: 1 }] })],
    ['own-performance', { period: P, creatorId: U1 }, E({ resource: 'own-performance', filters: { period: P }, expectedContextRevision: 'r1' }, { lenses: [] }, { state: 'empty' })],
    ['samples', { period: P }, { state: 'forbidden', error: 'x' }], ['samples', { period: P, creatorId: U1 }, null], ['samples', { period: P }, { ...E({ resource: 'samples', filters: { period: P }, expectedContextRevision: 'r1' }, { items: [] }), brandId: 'fish' }]
  ];
  const ctxCat = CTX({ taskStateCatalog: { revision: 't', items: [{ value: 'aberta', label: 'Aberta', open: true, terminal: false }] } });
  for (const [res, f, e] of fixtures) for (const c of [CTX(), ctxCat, { role: 'x' }]) assert.deepEqual(N.envelope(clone(e), c, res, f), N102.envelope(clone(e), c, res, f), res);
  for (const c of [CTX(), CTX({ pendingOperations: [42, 42, 'a'] }), {}, null]) {
    assert.deepEqual(N.context(clone(c)), N102.context(clone(c))); assert.deepEqual(N.journal(clone(c)), N102.journal(clone(c)));
  }
  const tenv = N.envelope(fixtures[1][2], ctxCat, 'tasks', { period: P }).env;
  assert.deepEqual(N.nextStep(tenv, U1), N102.nextStep(tenv, U1));
  const op = { operationId: 9, state: 'pending', contextRevision: 'r1', binding: { effectiveBrand: 'aristo', contextRevision: 'r1', kind: 'creator.update', recordId: U1, expectedRecordRevision: 3 } };
  assert.equal(N.operation(op, 'r1', 'aristo', 9), N102.operation(op, 'r1', 'aristo', 9));
  assert.deepEqual(N.recovery({ principalReference: 'p-1', effectiveBrand: 'aristo', sessionRevision: 's1', journalRevision: 'j0' }, CTX()), N102.recovery({ principalReference: 'p-1', effectiveBrand: 'aristo', sessionRevision: 's1', journalRevision: 'j0' }, CTX()));
  assert.deepEqual(N.filters({ period: P, creatorId: U1 }, 'creator-profile'), N102.filters({ period: P, creatorId: U1 }, 'creator-profile'));
});

// ---------- leitor v103 ----------
test('leitor: exige normalizador 1.0.3 e não lê nada com o 1.0.2', async () => {
  const x = await ready(V103, N102);
  assert.deepEqual(x.calls, []);
  assert.match(x.$('[data-saf3-state="unsupported"]').textContent, /versão divergente \(1\.0\.2-proposed\); esperado 1\.0\.3-proposed/);
});

test('leitor: lista do cadastro próprio mostra "Plataforma não vinculada", UUID tipado e mesmo handle sem união', async () => {
  const x = await ready(V103, N);
  const rows = x.$$('[data-saf3-view="table"] tbody tr');
  assert.deepEqual(rows.map((r) => r.getAttribute('data-saf3-creator-id')), OWN().map((c) => 'string:' + c.id));
  for (const tr of rows) {
    const tds = tr.querySelectorAll('td');
    assert.equal(tds.length, 8);
    assert.equal(tds[1].textContent, 'Plataforma não vinculada');
    assert.ok(tds[1].querySelector('[data-saf3-platform="unlinked"]'));
    assert.equal(tr.querySelectorAll('[data-saf3-act="open-profile"]').length, 1);
    assert.ok(!/null|undefined|tiktok/i.test(tr.textContent), 'nenhuma plataforma inventada');
  }
  const dup = x.$$('[data-saf3-view="table"] .saf3-tag').filter((t) => t.textContent === 'handle repetido · não unido');
  assert.equal(dup.length, 2);
  assert.equal(dup[0].getAttribute('title'), 'Mesmo @handle em registros distintos: identidade é o cadastro próprio (UUID + marca + versão).');
  const providerOptions = x.$('[data-saf3-filter="provider"]').querySelectorAll('option').map((o) => o.textContent);
  assert.deepEqual(providerOptions, ['Todos os provedores'], 'filtro não inventa plataforma');
  x.$('[data-saf3-act="view"][data-view="kanban"]').click(); await flush();
  const cards = x.$$('[data-saf3-view="kanban"] .saf3-card');
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c) => c.textContent.includes('Plataforma não vinculada')));
  assert.deepEqual(x.violations, []);
});

test('leitor: perfil do cadastro próprio lê o UUID exato, mostra a mesma identidade/revisão e plataforma não vinculada, sem ação nova', async () => {
  const x = await ready(V103, N);
  const mark = x.calls.length;
  x.$('[data-saf3-act="open-profile"][data-id="string:' + U2 + '"]').click(); await flush();
  const reads = x.calls.slice(mark).filter((c) => c.m === 'read').map((c) => c.q);
  assert.deepEqual(reads.map((r) => [r.resource, r.filters.creatorId]), [['creator-profile', U2], ['own-performance', U2]]);
  const panel = x.$('[data-saf3-profile="string:' + U2 + '"]');
  assert.ok(panel);
  assert.equal(panel.querySelector('[data-saf3-identity="own_candidate_record"]').textContent, U2 + ' (revisão 7)');
  assert.equal(panel.querySelector('dd[data-saf3-platform="unlinked"]').textContent, 'Plataforma não vinculada — cadastro próprio, sem conta social vinculada.');
  assert.ok(!panel.textContent.includes('Provedor / ID no provedor'));
  assert.ok(panel.querySelectorAll('[data-saf3-ref] [data-saf3-state="unavailable"]').length === 4, 'amostras/produtos/conteúdo/tarefas indisponíveis');
  const acts = new Set(x.$$('[data-saf3-act]').map((b) => b.getAttribute('data-saf3-act')));
  assert.deepEqual([...acts].sort(), ['close-profile', 'open-form', 'open-profile', 'refresh', 'view'].sort(), 'nenhuma ação nova');
  // Prévia continua existente (papel write), mas a confirmação segue desligada e nada chega ao gateway.
  x.$('[data-saf3-act="open-form"][data-kind="creator.archive"]').click(); await flush();
  assert.match(x.$('[data-saf3-preview="creator.archive"]').textContent, new RegExp(U2 + ' / 7'), 'prévia usa o mesmo UUID e revisão');
  assert.equal(x.$('[data-saf3-act="form-confirm"]').disabled, true, 'gravações desligadas');
  x.$('[data-saf3-act="form-confirm"]').click(); await flush();
  assert.ok(x.calls.every((c) => c.m === 'context' || c.m === 'read'));
  assert.deepEqual(x.violations, []);
});

test('leitor: perfil incoerente com a lista (revisão ou modo de identidade) é descartado', async () => {
  const variants = {
    revisão: (c) => ({ ...c, revision: 8, sourceRecordRevision: 8 }),
    modo: () => bound(U2, 'tiktok', 'tt-9', 'Ana Sintética', 'ana', 7)
  };
  for (const [label, change] of Object.entries(variants)) {
    const reads = readsFor(OWN);
    reads['creator-profile'] = (q) => E(q, { creator: change(OWN().find((c) => c.id === q.filters.creatorId)), references: { samples: null, products: null, content: null, tasks: null } });
    const x = await ready(V103, N, { reads });
    x.$('[data-saf3-act="open-profile"][data-id="string:' + U2 + '"]').click(); await flush();
    const panel = x.$('[data-saf3-profile="string:' + U2 + '"]');
    assert.match(panel.querySelector('[data-saf3-state="error"]').textContent, /Perfil incoerente com a lista atual/, label);
    assert.equal(panel.querySelector('[data-saf3-identity]').textContent, U2 + ' (revisão 7)', label + ': mostra só o registro listado');
    assert.ok(!panel.textContent.includes('tt-9') && !panel.textContent.includes('revisão 8'), label);
    x.inst.dispose();
  }
});

test('leitor: troca de modo entre leituras descarta perfil, formulário e filtro de plataforma; social continua igual ao leitor r5', async () => {
  const x = await ready(V103, N);
  x.$('[data-saf3-act="open-profile"][data-id="string:' + U1 + '"]').click(); await flush();
  assert.ok(x.$('[data-saf3-profile]'));
  x.$('[data-saf3-act="open-form"][data-kind="creator.archive"]').click(); await flush();
  assert.ok(x.$('[data-saf3-form="creator.archive"]'));
  x.setReads(readsFor(BOUND));
  await x.inst.sync({ filters: { period: P } }); await flush();
  assert.equal(x.$('[data-saf3-profile]'), null, 'perfil do modo anterior descartado');
  assert.equal(x.$('[data-saf3-form]'), null, 'formulário do modo anterior descartado');
  assert.ok(x.$$('.saf3-notice').some((n) => /modo de identidade dos criadores mudou/.test(n.textContent)));
  const profileReads = x.calls.filter((c) => c.m === 'read' && c.q.resource === 'creator-profile');
  assert.equal(profileReads.length, 1, 'perfil antigo não foi relido no novo modo');
  // Modo social: tabela idêntica ao leitor r5 com o DTO 1.0.2 equivalente.
  const strip = () => BOUND().map((c) => { const y = { ...c }; delete y.identityKind; return y; });
  const base = await ready(V3, N102, { reads: readsFor(strip) });
  for (const id of ['string:c-1', 'number:7']) {
    const a = base.$('[data-saf3-view="table"] [data-saf3-creator-id="' + id + '"]').querySelectorAll('td').map((t) => t.textContent);
    const b = x.$('[data-saf3-view="table"] [data-saf3-creator-id="' + id + '"]').querySelectorAll('td').map((t) => t.textContent);
    assert.deepEqual(b, a, id);
  }
  assert.deepEqual(x.$('[data-saf3-filter="provider"]').querySelectorAll('option').map((o) => o.textContent), ['Todos os provedores', 'instagram', 'tiktok']);
  assert.deepEqual([x.violations, base.violations], [[], []]);
});

test('leitor: lista mista ou vazio antigo/parcial não viram lista nem vazio comprovado; dispose encerra', async () => {
  const mixed = readsFor(() => [OWN()[0], BOUND()[0]]);
  const x = await ready(V103, N, { reads: mixed });
  assert.match(x.$('#saf3-panel [data-saf3-state="error"]').textContent, /mistura modos de identidade/);
  assert.equal(x.$$('[data-saf3-view="table"] tbody tr').length, 0);
  for (const o of [{ state: 'empty', coverage: 'partial' }, { state: 'empty', coverage: 'unknown' }]) {
    const y = await ready(V103, N, { reads: { ...readsFor(OWN), creators: (q) => E(q, { items: [] }, o) } });
    assert.equal(y.$('#saf3-panel [data-saf3-state]').getAttribute('data-saf3-state'), 'error', JSON.stringify(o));
  }
  const stale = await ready(V103, N, { reads: { ...readsFor(OWN), creators: (q) => E(q, { items: [] }, { state: 'empty', freshness: 'stale' }) } });
  assert.equal(stale.$('#saf3-panel [data-saf3-state]').getAttribute('data-saf3-state'), 'empty-unconfirmed');
  const partial = await ready(V103, N, { reads: { ...readsFor(OWN), creators: (q) => E(q, { items: OWN() }, { coverage: 'partial', freshness: 'stale' }) } });
  assert.ok(partial.$('[data-saf3-source="creators"]').textContent.includes('Coleta parcial — não é o universo completo'));
  const before = partial.calls.length;
  partial.inst.dispose(); await partial.inst.sync({ filters: { period: P } }); await flush();
  assert.equal(partial.calls.length, before, 'nada é invocado após dispose');
  assert.deepEqual(verifyPins().readerR5.bytes, PIN.readerR5.bytes, 'leitor r5 intacto');
});
