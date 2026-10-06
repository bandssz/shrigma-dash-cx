'use strict';
// Testes dirigidos da frente C1 (ShrigmaAffiliatesV2). Fixtures 100% sintéticas, gateway em memória
// com SOMENTE os métodos de contr/GATEWAY-AFILIADOS-v1.json (1.0.1-proposed). Sem rede, transporte,
// armazenamento ou timers. Provam comportamento de interface; não provam integração nem operação.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Document, Event } = require('./mini-dom.cjs');

const MODULE = path.join(__dirname, '..', '..', 'ui', 'affiliates-v2', 'affiliates-v2.js');
const CSS = path.join(__dirname, '..', '..', 'ui', 'affiliates-v2', 'affiliates-v2.css');
const SOURCE = fs.readFileSync(MODULE, 'utf8');
const CONTRACT_METHODS = ['context', 'read', 'beginMutation', 'submit', 'receipt'];
const KINDS = ['creator.create', 'creator.update', 'creator.archive', 'sample.record-manual', 'sample.update-manual', 'task.create', 'task.update', 'content.record-manual', 'content.update-manual'];

// Carrega como script de navegador num realm isolado, sem fetch/localStorage/navigator definidos.
function loadUMD() {
  const sandbox = vm.createContext({});
  vm.runInContext(SOURCE, sandbox, { filename: 'affiliates-v2.js' });
  return sandbox.ShrigmaAffiliatesV2;
}
const A = loadUMD();

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const flush = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
function deferred() { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; }
const allCaps = () => Object.fromEntries(KINDS.map((k) => [k, { available: true }]));
const CTX = (o = {}) => ({ contextRevision: 'r1', sessionRevision: 's1', effectiveBrand: 'brand-a', principalReference: 'p-1', role: 'write', sourceRevision: 'src-1', capabilities: allCaps(), pendingOperations: [], ...o });

const CREATORS = () => [
  { id: 'c-1', provider: 'tiktok', brandId: 'brand-a', providerId: 'tt-001', displayName: 'Ana Sintética', handle: 'ana', ownerReference: 'resp-1', stage: 'Prospecção', revision: 3 },
  { id: 'c-2', provider: 'instagram', brandId: 'brand-a', providerId: 'ig-002', displayName: 'Bruno Sintético', handle: '@ana', ownerReference: 'resp-2', stage: 'Negociação', revision: 1 },
  { id: 'c-3', provider: 'tiktok', brandId: 'brand-a', providerId: 'tt-003', displayName: 'Caio Sintético', handle: 'caio', ownerReference: 'resp-1', stage: 'Prospecção', revision: 7 }
];
const PERF = (o = {}) => ({ period: '2026-09', currency: 'BRL', source: 'own_verified', coverage: 'complete', estimatedMinor: 12345, accruedMinor: null, settledMinor: null, settlementProof: null, policyVersion: 'pol-3', returnsMinor: null, ...o });
function E(rev, data, o = {}) {
  return { state: 'ready', contextRevision: rev, brandId: 'brand-a', source: 'own_verified', coverage: 'complete', collectedAt: '2026-10-06T12:00:00Z', cacheAt: null, freshness: 'fresh', data, error: null, ...o };
}
function defaultReads() {
  return {
    creators: (q) => E(q.expectedContextRevision, { items: CREATORS(), completeness: 'complete' }),
    samples: (q) => E(q.expectedContextRevision, { items: [{ id: 's-1', creatorId: 'c-1', sku: 'SKU-1', manualStatus: 'separada', dueAt: '2026-10-10', revision: 1, source: 'own_declared' }] }),
    products: (q) => E(q.expectedContextRevision, { items: [{ id: 'p-1', sku: 'SKU-1', label: 'Produto sintético 1', source: 'own_verified' }] }),
    content: (q) => E(q.expectedContextRevision, { items: [{ id: 'k-1', creatorId: 'c-1', provider: 'tiktok', kind: 'video', url: 'https://example.invalid/v/1', publishedAt: '2026-10-01', source: 'own_declared', revision: 2 }] }),
    tasks: (q) => E(q.expectedContextRevision, { items: [{ id: 't-1', creatorId: 'c-1', label: 'Enviar briefing', state: 'aberta', dueAt: '2026-10-08', ownerReference: 'resp-1', revision: 1 }, { id: 't-2', creatorId: 'c-1', label: 'Cobrar vídeo', state: 'aberta', dueAt: '2026-10-12', revision: 1 }] }),
    'own-performance': (q) => E(q.expectedContextRevision, PERF()),
    'creator-profile': (q) => E(q.expectedContextRevision, { creator: CREATORS().find((c) => c.id === q.filters.creatorId) })
  };
}
// Gateway sintético em memória. Proxy recusa qualquer propriedade fora do contrato.
function makeGateway(cfg = {}) {
  const calls = [];
  const st = { ctx: cfg.ctx || CTX(), reads: Object.assign(defaultReads(), cfg.reads || {}) };
  const impl = {
    context() { calls.push({ m: 'context' }); const c = typeof st.ctx === 'function' ? st.ctx() : st.ctx; if (c instanceof Error) return Promise.reject(c); return c && typeof c.then === 'function' ? c : Promise.resolve(clone(c)); },
    read(q, o) {
      calls.push({ m: 'read', q: clone(q), signal: !!(o && o.signal) });
      let r = st.reads[q.resource]; if (typeof r === 'function') r = r(q);
      if (r instanceof Error) return Promise.reject(r);
      return r && typeof r.then === 'function' ? r : Promise.resolve(clone(r));
    }
  };
  if (cfg.mutations !== false) {
    const m = cfg.mutations || {};
    impl.beginMutation = (intent) => { calls.push({ m: 'beginMutation', intent: clone(intent) }); return m.begin ? m.begin(intent) : Promise.resolve({ operationId: 'op-1', contextRevision: intent.expectedContextRevision, state: 'prepared', binding: { effectiveBrand: st.ctx.effectiveBrand, kind: intent.kind }, receiptReference: null, result: null, reason: null }); };
    impl.submit = (a) => { calls.push({ m: 'submit', a: clone(a) }); return m.submit ? m.submit(a) : Promise.resolve({ operationId: a.operationId, contextRevision: a.expectedContextRevision, state: 'confirmed', binding: { effectiveBrand: st.ctx.effectiveBrand }, receiptReference: 'rcp-1', result: { ok: true }, reason: null }); };
    impl.receipt = (a) => { calls.push({ m: 'receipt', a: clone(a) }); return m.receipt ? m.receipt(a) : Promise.resolve({ operationId: a.operationId, contextRevision: a.expectedContextRevision, state: 'pending', binding: { effectiveBrand: st.ctx.effectiveBrand }, receiptReference: null, result: null, reason: null }); };
  }
  const gateway = new Proxy(impl, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (!CONTRACT_METHODS.includes(k)) throw new Error('Método fora do contrato acessado: ' + String(k));
      return t[k];
    },
    set() { throw new Error('Gateway é somente leitura para o módulo.'); }
  });
  return { gateway, calls, st, count: (m) => calls.filter((c) => c.m === m).length };
}
function mount(cfg) {
  const document = new Document();
  const element = document.createElement('div');
  document.body.appendChild(element);
  const g = makeGateway(cfg);
  const inst = A.create({ element, document, gateway: g.gateway });
  const $ = (s) => element.querySelector(s), $$ = (s) => element.querySelectorAll(s);
  const ids = (sel) => $$(sel).map((n) => n.getAttribute('data-saf2-creator-id'));
  const act = (sel) => { const el = $(sel); assert.ok(el, 'elemento ausente: ' + sel); el.click(); return el; };
  const typeInto = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); };
  const choose = (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); };
  const key = (el, k) => el.dispatchEvent(new Event('keydown', { key: k }));
  return { document, element, inst, g, $, $$, ids, act, typeInto, choose, key, text: () => element.textContent };
}

// ------------------------------------------------------------------ contrato, UMD e limites
test('UMD expõe create no global e no CommonJS e só usa métodos do contrato', async () => {
  assert.equal(typeof A.create, 'function');
  assert.equal(A.contractVersion, '1.0.1-proposed');
  const cjs = require(MODULE);
  assert.equal(typeof cjs.create, 'function');
  const x = mount();
  await x.inst.sync({ filters: { period: '2026-09' } }); await flush();
  const used = new Set(x.g.calls.map((c) => c.m));
  for (const m of used) assert.ok(CONTRACT_METHODS.includes(m), m);
  assert.deepEqual([...used].sort(), ['context', 'read']);
  const resources = new Set(x.g.calls.filter((c) => c.m === 'read').map((c) => c.q.resource));
  assert.deepEqual([...resources].sort(), ['content', 'creators', 'own-performance', 'products', 'samples', 'tasks']);
  for (const c of x.g.calls.filter((c) => c.m === 'read')) { assert.equal(c.q.expectedContextRevision, 'r1'); assert.equal(c.q.filters.period, '2026-09'); assert.ok(c.signal); }
  assert.throws(() => A.create({ element: x.element, document: x.document, gateway: {} }), /context\/read/);
});

test('fonte não usa transporte, armazenamento, credencial, UUID próprio, innerHTML nem taxa fixa', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /localStorage/, /sessionStorage/, /indexedDB/i, /\bcookie/i, /randomUUID/, /innerHTML/, /\beval\s*\(/, /new Function/, /navigator\./, /setTimeout|setInterval/, /\b0\.0[57]\b/, /[57]\s*%/, /document\.querySelector/, /window\./])
    assert.doesNotMatch(code, re, String(re));
  const css = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  css.replace(/([^{}]+)\{/g, (_, s) => { s = s.trim(); if (!s.startsWith('@')) selectors.push(...s.split(',').map((x) => x.trim())); return ''; });
  assert.ok(selectors.length > 20);
  for (const s of selectors) {
    assert.match(s, /^\.saf2(\b|[ .:[])/, 'seletor fora do prefixo: ' + s);
    assert.doesNotMatch(s, /(^|[\s>+~])(:root|body|html)(?![\w-])/, 'seletor global: ' + s);
  }
});

// ------------------------------------------------------------------ CRM: tabela, kanban, identidade
test('Tabela e Kanban mostram os mesmos IDs com os mesmos filtros; handle igual não une pessoas', async () => {
  const x = mount();
  await x.inst.sync({}); await flush();
  const table = x.ids('[data-saf2-view="table"] [data-saf2-creator-id]');
  assert.deepEqual(table, ['c-1', 'c-2', 'c-3']);
  const dupTags = x.$$('[data-saf2-view="table"] .saf2-tag').filter((t) => /handle repetido · não unido/.test(t.textContent));
  assert.equal(dupTags.length, 2, 'os dois registros com o mesmo handle continuam separados e sinalizados');
  assert.match(dupTags[0].getAttribute('title'), /não unidos/);
  assert.match(x.text(), /Enviar briefing/, 'próximo passo vem da tarefa de prazo mais próximo');
  x.act('[data-saf2-act="view"][data-view="kanban"]');
  const kanban = x.ids('[data-saf2-view="kanban"] [data-saf2-creator-id]');
  assert.deepEqual([...kanban].sort(), [...table].sort());
  x.choose(x.$('[data-saf2-filter="stage"]'), 'Prospecção');
  const kf = x.ids('[data-saf2-view="kanban"] [data-saf2-creator-id]').sort();
  x.act('[data-saf2-act="view"][data-view="table"]');
  const tf = x.ids('[data-saf2-view="table"] [data-saf2-creator-id]').sort();
  assert.deepEqual(kf, ['c-1', 'c-3']); assert.deepEqual(tf, kf);
  x.choose(x.$('[data-saf2-filter="owner"]'), 'resp-2');
  assert.equal(x.$('[data-saf2-state="filtered-empty"]').textContent.includes('3 na leitura'), true);
});

test('teclado e foco: setas nas abas, perfil foca o título, Escape devolve o foco ao gatilho', async () => {
  const x = mount();
  await x.inst.sync({}); await flush();
  const tab = x.$('[data-saf2-key="tab-table"]'); tab.focus();
  x.key(tab, 'ArrowRight');
  assert.equal(x.document.activeElement.getAttribute('data-saf2-key'), 'tab-kanban');
  assert.ok(x.$('[data-saf2-view="kanban"]'));
  x.key(x.document.activeElement, 'Home');
  assert.equal(x.document.activeElement.getAttribute('data-saf2-key'), 'tab-table');
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  assert.equal(x.document.activeElement.getAttribute('data-saf2-key'), 'profile-title');
  assert.match(x.$('[data-saf2-profile="c-1"]').textContent, /Produto sintético 1/, 'produto vinculado pela amostra');
  x.act('[data-saf2-act="open-form"][data-kind="task.create"]');
  assert.equal(x.document.activeElement.getAttribute('data-saf2-key'), 'field:task.create::c-1:label', 'formulário foca o primeiro campo');
  x.key(x.document.activeElement, 'Escape');
  assert.ok(!x.$('[data-saf2-form]'));
  assert.equal(x.document.activeElement.getAttribute('data-saf2-key'), 'profile-title');
  x.key(x.document.activeElement, 'Escape');
  assert.ok(!x.$('[data-saf2-profile]'));
  assert.equal(x.document.activeElement.getAttribute('data-saf2-key'), 'open:c-1');
});

// ------------------------------------------------------------------ estados honestos
test('vazio confirmado × vazio parcial/antigo × indisponível × malformado × outra marca', async () => {
  const cases = [
    [(q) => E(q.expectedContextRevision, null, { state: 'empty' }), 'empty-confirmed'],
    [(q) => E(q.expectedContextRevision, { items: [] }, { state: 'empty', coverage: 'partial' }), 'empty-unconfirmed'],
    [(q) => E(q.expectedContextRevision, { items: [] }, { freshness: 'stale' }), 'empty-unconfirmed'],
    [(q) => E(q.expectedContextRevision, null, { state: 'unavailable', error: 'coletor pausado' }), 'unavailable'],
    [(q) => E(q.expectedContextRevision, { rows: [] }), 'error'],
    [(q) => E(q.expectedContextRevision, { items: [] }, { state: 'hmm' }), 'error'],
    [(q) => E(q.expectedContextRevision, { items: CREATORS() }, { brandId: 'brand-b' }), 'error'],
    [() => Promise.reject(new Error('timeout sintético')), 'error']
  ];
  for (const [creators, expected] of cases) {
    const x = mount({ reads: { creators } });
    await x.inst.sync({}); await flush();
    const st = x.$('#saf2-panel [data-saf2-state]');
    assert.ok(st, 'estado ausente para ' + expected);
    assert.equal(st.getAttribute('data-saf2-state'), expected);
    assert.doesNotMatch(st.textContent, /\b0\b/, 'ausência não vira zero');
    assert.ok(!x.$('[data-saf2-view]'));
  }
});

test('parcial e antigo aparecem com origem/cobertura e fecham escrita; malformado é omitido sem zerar', async () => {
  const x = mount({ reads: {
    creators: (q) => E(q.expectedContextRevision, { items: [...CREATORS(), { displayName: 'sem id' }] }, { freshness: 'stale' }),
    samples: (q) => E(q.expectedContextRevision, null, { state: 'unavailable' })
  } });
  await x.inst.sync({ filters: { period: '2026-09' } }); await flush();
  const src = x.$('[data-saf2-source="creators"]').textContent;
  for (const s of ['Origem: Própria verificada', 'Marca: brand-a', 'Cobertura: parcial', 'Frescor: antiga', 'Período: 2026-09', 'Coleta parcial — não é o universo completo', 'Dados antigos — somente leitura', '1 registro(s) malformado(s) omitido(s)'])
    assert.ok(src.includes(s), s);
  const novo = x.$('[data-saf2-act="open-form"][data-kind="creator.create"]');
  assert.ok(novo.disabled);
  assert.match(x.text(), /Ações fechadas: .*Fonte antiga/);
  const sampleCell = x.$('[data-saf2-creator-id="c-1"]').querySelectorAll('td')[6];
  assert.equal(sampleCell.textContent, '—', 'amostras indisponíveis não viram 0');
});

// ------------------------------------------------------------------ financeiro: estimado, apurado, liquidado
test('comissão estimada do próprio seller nunca vira liquidada nem paga; nada é somado', async () => {
  const scenario = async (perf) => {
    const x = mount({ reads: { 'own-performance': (q) => E(q.expectedContextRevision, PERF(perf)) } });
    await x.inst.sync({}); await flush();
    return x.$('[data-saf2-perf="program"]');
  };
  let p = await scenario({ source: 'own_declared', estimatedMinor: 12345, accruedMinor: 200, settledMinor: 5000, settlementProof: 'proof-1' });
  assert.match(p.querySelector('[data-saf2-commission="estimated"]').textContent, /ESTIMADA.*123,45/);
  assert.doesNotMatch(p.textContent, /Paga —/);
  assert.match(p.querySelector('[data-saf2-commission="settled"]').textContent, /Sem prova de liquidação própria/);
  assert.doesNotMatch(p.textContent, /125,45|176,45|52,00/, 'nenhuma soma entre lentes');
  p = await scenario({ settledMinor: 5000, settlementProof: null });
  assert.doesNotMatch(p.textContent, /Paga —/);
  p = await scenario({ settledMinor: 5000, settlementProof: 'liq-77' });
  assert.match(p.textContent, /Paga — liquidação comprovada \(liq-77\)/);
  p = await scenario({ source: 'market_estimated', estimatedMinor: 999900, settledMinor: 1, settlementProof: 'x' });
  assert.ok(!p.querySelector('[data-saf2-commission="settled"]'));
  assert.ok(!p.querySelector('[data-saf2-commission="accrued"]'));
  assert.match(p.textContent, /não é receita própria, comissão devida nem pagamento/);
  p = await scenario({ estimatedMinor: null, accruedMinor: 12.5, currency: null });
  assert.equal(p.querySelector('[data-saf2-commission="estimated"]').getAttribute('data-saf2-value-kind'), 'missing');
  assert.equal(p.querySelector('[data-saf2-commission="accrued"]').getAttribute('data-saf2-value-kind'), 'malformed');
  assert.doesNotMatch(p.textContent, /R\$\s?0,00/);
  p = await scenario({ policyVersion: null });
  assert.match(p.textContent, /Política: indisponível/);
});

// ------------------------------------------------------------------ marca, ator, período, respostas tardias
test('concorrência: sync equivalente é coalescido e resposta de período antigo é descartada', async () => {
  const held = deferred();
  let first = true;
  const x = mount({ reads: { creators: (q) => { if (first) { first = false; return held.p; } return E(q.expectedContextRevision, { items: CREATORS() }); } } });
  const a = x.inst.sync({ filters: { period: 'P1' } }), b = x.inst.sync({ filters: { period: 'P1' } });
  assert.equal(a, b, 'mesma promessa para sync equivalente concorrente');
  await flush();
  assert.equal(x.g.count('context'), 1);
  await x.inst.sync({ filters: { period: 'P2' } }); await flush();
  held.res(E('r1', { items: [{ id: 'old-x', provider: 'tiktok', brandId: 'brand-a', providerId: 'o', displayName: 'Período antigo', stage: 'Prospecção', revision: 1 }] }));
  await a; await flush();
  assert.ok(!x.$('[data-saf2-creator-id="old-x"]'));
  assert.deepEqual(x.ids('[data-saf2-view="table"] [data-saf2-creator-id]'), ['c-1', 'c-2', 'c-3']);
  assert.match(x.$('[data-saf2-source="creators"]').textContent, /Período: P2/);
  // Enquanto o período P3 carrega, os dados de P2 não ficam na tela rotulados como P3.
  const p3 = deferred();
  x.g.st.reads.creators = () => p3.p;
  const s3 = x.inst.sync({ filters: { period: 'P3' } }); await flush();
  assert.ok(!x.$('[data-saf2-creator-id]'), 'nada de P2 sob o rótulo P3');
  assert.equal(x.$('#saf2-panel [data-saf2-state]').getAttribute('data-saf2-state'), 'loading');
  p3.res(E('r1', { items: CREATORS().slice(0, 1) })); await s3; await flush();
  assert.deepEqual(x.ids('[data-saf2-view="table"] [data-saf2-creator-id]'), ['c-1']);
});

test('troca de marca limpa projeção e rascunho; envelope de revisão antiga é descartado', async () => {
  const x = mount();
  await x.inst.sync({}); await flush();
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  x.act('[data-saf2-act="open-form"][data-kind="creator.update"]');
  x.typeInto(x.$('[data-saf2-field="displayName"]'), 'Rascunho da marca A');
  x.g.st.ctx = CTX({ effectiveBrand: 'brand-b', contextRevision: 'rb1' });
  x.g.st.reads.creators = (q) => E(q.expectedContextRevision, { items: [{ id: 'b-9', provider: 'tiktok', brandId: 'brand-b', providerId: 'tt-9', displayName: 'Criador B', stage: 'Prospecção', revision: 1 }] }, { brandId: 'brand-b' });
  for (const r of ['samples', 'products', 'content', 'tasks']) x.g.st.reads[r] = (q) => E(q.expectedContextRevision, { items: [] }, { brandId: 'brand-b', state: 'empty' });
  x.g.st.reads['own-performance'] = (q) => E(q.expectedContextRevision, null, { brandId: 'brand-b', state: 'unavailable' });
  await x.inst.sync({}); await flush();
  assert.ok(!x.$('[data-saf2-creator-id="c-1"]'));
  assert.ok(!x.$('[data-saf2-form]'));
  assert.ok(!x.$('[data-saf2-profile]'));
  assert.doesNotMatch(x.text(), /Rascunho da marca A|Ana Sintética/);
  x.g.st.ctx = CTX();
  x.g.st.reads = defaultReads();
  await x.inst.sync({}); await flush();
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  x.act('[data-saf2-act="open-form"][data-kind="creator.update"]');
  assert.equal(x.$('[data-saf2-field="displayName"]').value, 'Ana Sintética', 'rascunho não volta de outra marca');
  x.g.st.reads.creators = () => E('r-velha', { items: [{ id: 'velho-1', provider: 'tiktok', brandId: 'brand-a', providerId: 'v', displayName: 'Revisão velha', stage: 'Prospecção', revision: 1 }] });
  await x.inst.sync({}); await flush();
  assert.ok(!x.$('[data-saf2-creator-id="velho-1"]'), 'envelope de revisão antiga não é aplicado');
  assert.equal(x.$('[data-saf2-source="creators"] [title="Resposta de outro contexto descartada."]').textContent, 'Última atualização falhou — leitura anterior, somente leitura');
});

test('revogação limpa dados e fecha ações; resposta tardia não restaura acesso', async () => {
  const late = deferred();
  let n = 0;
  const x = mount({ reads: { creators: (q) => (++n === 2 ? late.p : E(q.expectedContextRevision, { items: CREATORS() })) } });
  await x.inst.sync({}); await flush();
  assert.ok(x.$('[data-saf2-creator-id="c-1"]'));
  const pending = x.inst.sync({ filters: { period: 'x' } }); await flush();
  x.g.st.reads.creators = (q) => ({ state: 'forbidden', contextRevision: 'r2', error: 'acesso revogado (sintético)' });
  await x.inst.sync({ filters: { period: 'y' } }); await flush();
  assert.ok(!x.$('[data-saf2-creator-id]'));
  assert.ok(x.$('[data-saf2-state="revoked"]'));
  assert.equal(x.$$('[data-saf2-act="open-form"]').length, 0);
  late.res(E('r1', { items: CREATORS() }));
  await pending; await flush();
  assert.ok(!x.$('[data-saf2-creator-id]'), 'resposta atrasada não repõe dados');
});

// ------------------------------------------------------------------ capacidades e ações fechadas
test('capacidade ausente, papel de leitura ou adapter ausente fecham a ação e explicam', async () => {
  const caps = allCaps(); delete caps['creator.create']; caps['task.create'] = { available: false, reason: 'Integração de tarefas não admitida' };
  let x = mount({ ctx: CTX({ capabilities: caps }) });
  await x.inst.sync({}); await flush();
  const novo = x.$('[data-saf2-act="open-form"][data-kind="creator.create"]');
  assert.ok(novo.disabled); assert.match(novo.getAttribute('title'), /Capacidade não informada/);
  novo.click(); assert.ok(!x.$('[data-saf2-form]'));
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  assert.ok(x.$('[data-saf2-act="open-form"][data-kind="task.create"]').disabled);
  assert.match(x.$('[data-saf2-profile]').textContent, /Integração de tarefas não admitida/);
  assert.equal(x.$('[data-saf2-act="open-form"][data-kind="sample.record-manual"]').disabled, false);

  x = mount({ ctx: CTX({ role: 'read' }) });
  await x.inst.sync({}); await flush();
  assert.match(x.text(), /Papel sem escrita \(read\)/);
  assert.ok(x.$$('[data-saf2-act="open-form"]').every((b) => b.disabled));

  x = mount({ mutations: false });
  await x.inst.sync({}); await flush();
  assert.match(x.text(), /Adapter de escrita do integrador não instalado/);
  assert.ok(x.$$('[data-saf2-act="open-form"]').every((b) => b.disabled));
  assert.equal(x.g.count('beginMutation'), 0);
});

// ------------------------------------------------------------------ rascunho e dispose
test('rascunho persiste no mesmo ator/marca (inclusive nova revisão) e dispose encerra tudo', async () => {
  const x = mount();
  await x.inst.sync({}); await flush();
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  x.act('[data-saf2-act="open-form"][data-kind="creator.update"]');
  x.typeInto(x.$('[data-saf2-field="displayName"]'), 'Ana editada');
  x.g.st.ctx = CTX({ contextRevision: 'r2' });
  await x.inst.sync({}); await flush();
  assert.equal(x.$('[data-saf2-field="displayName"]').value, 'Ana editada');
  x.act('[data-saf2-act="form-cancel"]');
  x.act('[data-saf2-act="open-form"][data-kind="creator.update"]');
  assert.equal(x.$('[data-saf2-field="displayName"]').value, 'Ana editada');
  assert.ok(x.document.totalListeners() > 0);
  const held = deferred();
  x.g.st.ctx = () => held.p;
  const late = x.inst.sync({ filters: { period: 'z' } });
  x.inst.dispose();
  assert.equal(x.element.childNodes.length, 0);
  assert.equal(x.document.totalListeners(), 0);
  held.res(CTX({ contextRevision: 'r3' }));
  await late; await flush();
  assert.equal(x.element.childNodes.length, 0, 'nada renderiza após dispose');
  const before = x.g.calls.length;
  await x.inst.sync({}); x.inst.dispose();
  assert.equal(x.g.calls.length, before, 'sync após dispose não chama o gateway');
});

// ------------------------------------------------------------------ mutações: incerto, recibo, confirmação
async function openUpdateAndConfirm(x, value) {
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  x.act('[data-saf2-act="open-form"][data-kind="creator.update"]');
  x.typeInto(x.$('[data-saf2-field="ownerReference"]'), value);
  x.act('[data-saf2-act="form-review"]');
  x.act('[data-saf2-act="form-confirm"]'); await flush();
}

test('resultado desconhecido preserva a operação original, não repete e consulta só o recibo', async () => {
  let receiptState = 'pending';
  const x = mount({ mutations: {
    submit: () => Promise.reject(new Error('ACK perdido (sintético)')),
    receipt: (a) => Promise.resolve({ operationId: a.operationId, contextRevision: a.expectedContextRevision, state: receiptState, binding: { effectiveBrand: 'brand-a' }, receiptReference: receiptState === 'confirmed' ? 'rcp-9' : null, result: null, reason: null })
  } });
  await x.inst.sync({}); await flush();
  await openUpdateAndConfirm(x, 'resp-9');
  const intent = x.g.calls.find((c) => c.m === 'beginMutation').intent;
  assert.deepEqual(intent, { kind: 'creator.update', payload: { ownerReference: 'resp-9' }, expectedContextRevision: 'r1', recordId: 'c-1', expectedRecordRevision: 3 });
  assert.equal(x.$('[data-saf2-op="op-1"]').getAttribute('data-saf2-op-state'), 'uncertain');
  assert.equal(x.$('[data-saf2-form]').getAttribute('data-saf2-form'), 'creator.update');
  assert.ok(x.$$('[data-saf2-act="open-form"]').every((b) => b.disabled), 'nova gravação bloqueada');
  assert.ok(!x.$('[data-saf2-act="form-confirm"]'), 'sem botão para reenviar');
  x.act('[data-saf2-act="receipt"][data-op="op-1"]'); await flush();
  assert.equal(x.g.count('beginMutation'), 1); assert.equal(x.g.count('submit'), 1); assert.equal(x.g.count('receipt'), 1);
  assert.equal(x.g.calls.find((c) => c.m === 'receipt').a.operationId, 'op-1');
  assert.ok(x.$$('[data-saf2-act="open-form"]').every((b) => b.disabled));
  const ctxCalls = x.g.count('context');
  receiptState = 'confirmed';
  x.act('[data-saf2-act="receipt"][data-op="op-1"]'); await flush();
  assert.equal(x.$('[data-saf2-op="op-1"]').getAttribute('data-saf2-op-state'), 'confirmed');
  assert.match(x.$('[data-saf2-op="op-1"]').textContent, /recibo rcp-9/);
  assert.ok(x.g.count('context') > ctxCalls, 'confirmação dispara releitura');
  assert.equal(x.g.count('beginMutation'), 1); assert.equal(x.g.count('submit'), 1);
});

test('preparação sem resposta não submete; libera só após contexto lido depois e mostra pendência do servidor', async () => {
  const x = mount({ mutations: { begin: () => Promise.reject(new Error('timeout')) } });
  await x.inst.sync({}); await flush();
  await openUpdateAndConfirm(x, 'resp-7');
  assert.equal(x.g.count('submit'), 0);
  assert.match(x.text(), /Nada foi submetido por esta tela/);
  assert.ok(x.$('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled);
  x.g.st.ctx = CTX({ pendingOperations: [{ operationId: 'op-srv-1' }] });
  await x.inst.sync({}); await flush();
  assert.equal(x.$('[data-saf2-op="op-srv-1"]').getAttribute('data-saf2-op-state'), 'pending');
  assert.ok(x.$('[data-saf2-act="receipt"][data-op="op-srv-1"]'));
  assert.ok(x.$('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled, 'pendência do servidor bloqueia nova gravação');
  x.g.st.ctx = CTX({ pendingOperations: [] });
  await x.inst.sync({}); await flush();
  assert.equal(x.$('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled, false);
});

test('sucesso confirmado seguido de falha de leitura continua confirmado, com atualização pendente separada', async () => {
  const x = mount();
  await x.inst.sync({}); await flush();
  x.g.st.reads.creators = () => Promise.reject(new Error('leitura caiu (sintético)'));
  await openUpdateAndConfirm(x, 'resp-5');
  const op = x.$('[data-saf2-op="op-1"]');
  assert.equal(op.getAttribute('data-saf2-op-state'), 'confirmed');
  assert.match(op.textContent, /recibo rcp-1/);
  assert.match(op.textContent, /Atualização da leitura pendente/);
  assert.match(x.$('[data-saf2-source="creators"]').textContent, /Última atualização falhou/);
  assert.ok(x.$('[data-saf2-creator-id="c-1"]'), 'leitura anterior continua visível');
  assert.ok(x.$('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled, 'leitura falha não abre escrita');
  assert.equal(x.g.count('submit'), 1);
});

test('Kanban: mover exige revisão, intent nomeado e confirmação; tela não move sozinha', async () => {
  let stage = 'Prospecção';
  const x = mount({ reads: { creators: (q) => E(q.expectedContextRevision, { items: CREATORS().map((c) => (c.id === 'c-1' ? { ...c, stage, revision: stage === 'Prospecção' ? 3 : 4 } : c)) }) } });
  await x.inst.sync({}); await flush();
  x.act('[data-saf2-act="view"][data-view="kanban"]');
  x.choose(x.$('[data-saf2-move-target="c-1"]'), 'Negociação');
  x.act('[data-saf2-act="move-review"][data-id="c-1"]');
  assert.equal(x.document.activeElement.getAttribute('data-saf2-key'), 'form-confirm');
  const colOf = (id) => x.$('[data-saf2-creator-id="' + id + '"]').parentNode.parentNode.getAttribute('aria-label');
  assert.match(colOf('c-1'), /^Prospecção/);
  assert.equal(x.g.count('beginMutation'), 0);
  stage = 'Negociação';
  x.act('[data-saf2-act="form-confirm"]'); await flush();
  const intent = x.g.calls.find((c) => c.m === 'beginMutation').intent;
  assert.deepEqual(intent, { kind: 'creator.update', payload: { stage: 'Negociação' }, expectedContextRevision: 'r1', recordId: 'c-1', expectedRecordRevision: 3 });
  assert.match(colOf('c-1'), /^Negociação/, 'só muda após confirmação e releitura do servidor');
});

test('recusa do servidor mantém o rascunho e a tela no estado lido', async () => {
  const x = mount({ mutations: { submit: (a) => Promise.resolve({ operationId: a.operationId, contextRevision: 'r1', state: 'rejected', binding: { effectiveBrand: 'brand-a' }, receiptReference: null, result: null, reason: 'revisão divergente' }) } });
  await x.inst.sync({}); await flush();
  await openUpdateAndConfirm(x, 'resp-3');
  assert.match(x.$('[data-saf2-form]').textContent, /Recusada pelo servidor: revisão divergente/);
  assert.equal(x.$('[data-saf2-field="ownerReference"]').value, 'resp-3');
  assert.equal(x.$('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled, false, 'recusa final não deixa pendência');
});

test('registro manual de amostra deixa claro que não confirma envio no TikTok e envia creatorId do perfil', async () => {
  const x = mount();
  await x.inst.sync({}); await flush();
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  x.act('[data-saf2-act="open-form"][data-kind="sample.record-manual"]');
  assert.match(x.$('[data-saf2-form]').textContent, /Não confirma envio, aprovação ou amostra no TikTok/);
  x.act('[data-saf2-act="form-review"]');
  assert.match(x.$('[data-saf2-form]').textContent, /SKU é obrigatório/);
  x.choose(x.$('[data-saf2-field="sku"]'), 'SKU-1');
  x.typeInto(x.$('[data-saf2-field="manualStatus"]'), 'separada');
  x.act('[data-saf2-act="form-review"]');
  x.act('[data-saf2-act="form-confirm"]'); await flush();
  const intent = x.g.calls.find((c) => c.m === 'beginMutation').intent;
  assert.deepEqual(intent, { kind: 'sample.record-manual', payload: { sku: 'SKU-1', manualStatus: 'separada', creatorId: 'c-1' }, expectedContextRevision: 'r1' });
});

// ------------------------------------------------------------------ revisão 2 da entrega
test('perfil mostra responsável, próximo passo e prazo; sem leitura de tarefas fica indisponível, não vazio', async () => {
  let x = mount();
  await x.inst.sync({}); await flush();
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  assert.equal(x.$('[data-saf2-profile] [data-saf2-next]').textContent, 'Enviar briefing · aberta');
  assert.equal(x.$('[data-saf2-profile] [data-saf2-due]').textContent, '08/10/2026');
  assert.match(x.$('[data-saf2-profile]').textContent, /Responsávelresp-1/);
  x = mount({ reads: { tasks: (q) => E(q.expectedContextRevision, null, { state: 'unavailable' }) } });
  await x.inst.sync({}); await flush();
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  assert.match(x.$('[data-saf2-profile] [data-saf2-next]').textContent, /^Indisponível/);
  assert.equal(x.$('[data-saf2-profile] [data-saf2-due]').textContent, '—');
});

test('troca de período mantém o perfil aberto, relê com o novo período e descarta perfil do período anterior', async () => {
  const held = deferred();
  let firstProfile = true;
  const x = mount({ reads: { 'creator-profile': (q) => {
    if (firstProfile) { firstProfile = false; return E(q.expectedContextRevision, { creator: { ...CREATORS()[0], displayName: 'Ana período P0' } }); }
    if (q.filters.period === 'P1') return held.p;
    return E(q.expectedContextRevision, { creator: { ...CREATORS()[0], displayName: 'Ana período ' + q.filters.period } });
  } } });
  await x.inst.sync({ filters: { period: 'P0' } }); await flush();
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  const p1 = x.inst.sync({ filters: { period: 'P1' } }); await flush();
  assert.ok(x.$('[data-saf2-profile="c-1"]'), 'perfil continua aberto durante a troca');
  assert.doesNotMatch(x.$('[data-saf2-profile]').textContent, /Ana período P0/, 'nada do perfil do período anterior');
  assert.match(x.$('[data-saf2-profile]').textContent, /Carregando perfil…/);
  await x.inst.sync({ filters: { period: 'P2' } }); await flush();
  held.res(E('r1', { creator: { ...CREATORS()[0], displayName: 'Ana período velho' } }));
  await p1; await flush();
  assert.equal(x.$('#saf2-profile-title').textContent, 'Ana período P2');
  const profileReads = x.g.calls.filter((c) => c.m === 'read' && c.q.resource === 'creator-profile').map((c) => c.q.filters.period);
  assert.deepEqual(profileReads, ['P0', 'P1', 'P2']);
  assert.ok(x.g.calls.filter((c) => c.m === 'read' && c.q.resource === 'own-performance' && c.q.filters.creatorId === 'c-1').every((c) => c.q.filters.period));
});

test('troca de sessão ou de ator descarta rascunho; mesma sessão preserva', async () => {
  for (const change of [{ sessionRevision: 's2' }, { principalReference: 'p-2' }]) {
    const x = mount();
    await x.inst.sync({}); await flush();
    x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
    x.act('[data-saf2-act="open-form"][data-kind="creator.update"]');
    x.typeInto(x.$('[data-saf2-field="displayName"]'), 'Rascunho do ator 1');
    x.g.st.ctx = CTX(change);
    await x.inst.sync({}); await flush();
    assert.ok(!x.$('[data-saf2-form]'), JSON.stringify(change));
    x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
    x.act('[data-saf2-act="open-form"][data-kind="creator.update"]');
    assert.equal(x.$('[data-saf2-field="displayName"]').value, 'Ana Sintética', 'rascunho não passa para ' + JSON.stringify(change));
  }
});

test('dispose durante gravação em voo: resposta tardia não renderiza nem dispara recibo, reenvio ou releitura', async () => {
  const sub = deferred();
  const x = mount({ mutations: { submit: () => sub.p } });
  await x.inst.sync({}); await flush();
  x.act('[data-saf2-act="open-profile"][data-id="c-1"]'); await flush();
  x.act('[data-saf2-act="open-form"][data-kind="creator.update"]');
  x.typeInto(x.$('[data-saf2-field="ownerReference"]'), 'resp-8');
  x.act('[data-saf2-act="form-review"]');
  x.act('[data-saf2-act="form-confirm"]'); await flush();
  assert.equal(x.g.count('submit'), 1);
  const before = x.g.calls.length;
  x.inst.dispose();
  sub.res({ operationId: 'op-1', contextRevision: 'r1', state: 'confirmed', receiptReference: 'rcp-x', result: {}, reason: null });
  await flush();
  assert.equal(x.element.childNodes.length, 0);
  assert.equal(x.g.calls.length, before, 'nenhuma chamada ao gateway após dispose');
});

// ------------------------------------------------------------------ DOM real opcional (CI do integrador)
test('smoke com linkedom quando disponível', { skip: (() => { try { require.resolve('linkedom'); return false; } catch (_) { return 'linkedom não instalado neste ambiente'; } })() }, async () => {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML('<html><body><div id="m"></div></body></html>');
  const g = makeGateway();
  const inst = A.create({ element: document.getElementById('m'), document, gateway: g.gateway });
  await inst.sync({}); await flush();
  const ids = [...document.querySelectorAll('[data-saf2-view="table"] [data-saf2-creator-id]')].map((n) => n.getAttribute('data-saf2-creator-id'));
  assert.deepEqual(ids, ['c-1', 'c-2', 'c-3']);
  inst.dispose();
  assert.equal(document.getElementById('m').childNodes.length, 0);
});
