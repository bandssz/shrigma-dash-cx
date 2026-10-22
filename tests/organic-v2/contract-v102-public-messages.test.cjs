'use strict';
// C2 R6 — três mensagens públicas do Orgânico 1.0.2 (CR-C2-R4-3/4/5), só apresentação.
// Exercita o UMD candidato REAL (../../ui/organic-v2/organic-v2.js) com o normalizador REAL e o fake-dom REAL,
// ambos lidos por require comum do contexto pinado em CRM_C2_PUBLIC_MESSAGES_CONTEXT. Gateway, contexto, IDs,
// revisões e dias abaixo são SINTÉTICOS, literais e só em RAM: não são servidor, journal, autorização nem produção.
// Contexto ausente ou pin divergente FALHA (nunca skip). Sem rede, store, relógio, aleatório ou ID gerado.
// Execução: CRM_C2_PUBLIC_MESSAGES_CONTEXT=<ROOT-WORK/20261006-r6/context/current/files> node --test <este arquivo>
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PINS = {
  normalizer: 'a53fc473eb2afec76259dea7f157aea69da8c2990f86b025874cd146450b3bb8',
  fakeDom: 'b77c1be20e6141e2c8cd4cade2629b092cfa8ef61ba7651c8073b3e407447007'
};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

let loaded = null;
function real() {
  if (loaded) return loaded;
  const ctxDir = process.env.CRM_C2_PUBLIC_MESSAGES_CONTEXT;
  assert.ok(typeof ctxDir === 'string' && ctxDir !== '', 'CRM_C2_PUBLIC_MESSAGES_CONTEXT ausente: contexto pinado é obrigatório (falha, não skip)');
  const dir = path.resolve(ctxDir);
  const nPath = path.join(dir, 'ui', 'organic-v2', 'organic-contract-v1-0-2.js');
  const dPath = path.join(dir, 'tests', 'organic-v2', 'fake-dom.cjs');
  assert.equal(sha(fs.readFileSync(nPath)), PINS.normalizer, 'normalizador fora do pin');
  assert.equal(sha(fs.readFileSync(dPath)), PINS.fakeDom, 'fake-dom fora do pin');
  const N = require(nPath);
  assert.equal(N.version, '1.0.2-proposed');
  globalThis.ShrigmaOrganicContractV102 = N; // normalizador real exposto ANTES do componente
  const dom = require(dPath);
  const Organic = require(path.join(__dirname, '..', '..', 'ui', 'organic-v2', 'organic-v2.js'));
  loaded = { N, dom, Organic };
  return loaded;
}

// ---------- textos esperados (R6) ----------
const MISMATCH_TEXT = 'A resposta não corresponde à operação original; foi descartada.';
const GENERIC_INVALID_TEXT = 'Resposta inconsistente descartada; o resultado da operação original continua desconhecido.';
const CAP_UNCONFIRMED_TEXT = 'Permissão para criar links não confirmada.';
const PREPARE_LOST_TEXT = 'Preparação não confirmada. Esta tela não enviou confirmação para execução. Sem o identificador original, uma nova preparação permanece bloqueada até recuperação comprovada.';
// Textos existentes que este recorte NÃO altera (usados como guardas).
const CARRIED_BLOCK = 'Há operação anterior desta marca aguardando consulta de resultado; gravação fechada.';
const LOST_BLOCK = 'Uma preparação anterior desta marca ficou sem confirmação e sem ID; gravação fechada até Root comprovar a recuperação.';
const NO_ID_BEGIN_TEXT = 'Preparação sem resposta válida e sem ID. Nada foi executado por esta tela; gravação fechada até Root comprovar a recuperação.';

// ---------- fixture RAM: literais sintéticos ----------
const PERIOD = { from: '2026-10-01', to: '2026-10-05' };
const DAY = Object.freeze({ d1: '2026-10-01T15:00:00.000Z', d4: '2026-10-04T15:00:00.000Z', d5: '2026-10-05T15:00:00.000Z' });
const OP_IDS = Object.freeze(['op-1', 'op-2', 'op-3']);
const RECEIPTS = Object.freeze({ 'op-1': 'rcpt-op-1', 'op-2': 'rcpt-op-2', 'op-3': 'rcpt-op-3' });
const FOREIGN_ID = 'op-foreign';
const NEW_LINK = Object.freeze({ id: 'new-1', revision: 1, url: 'https://oaristocrata.com/products/novo?utm_source=instagram_social&utm_medium=story&utm_campaign=kit_novo' });
const DRAFT = Object.freeze({ destination: 'https://oaristocrata.com/products/novo', origin: 'instagram_social', surface: 'story', campaign: 'kit_novo', date: '2026-10-05' });

function pool(list, label) {
  let i = 0;
  return () => { if (i >= list.length) throw new Error('pool sintético esgotado: ' + label); return list[i++]; };
}
function baseContext() {
  return {
    contextRevision: 'r1', sessionRevision: 's1', effectiveBrand: 'aristo', principalReference: 'p-ana', role: 'write', sourceRevision: 'src-1',
    capabilities: { 'link.create': { available: true, reason: null }, 'link.archive': { available: true, reason: null } },
    pendingOperations: [], operationJournal: { state: 'complete', revision: 'journal-r1' }
  };
}
// Envelope POSITIVO completo: os dez campos declarados explicitamente.
function envelope(ctx, fields) {
  return { state: fields.state, contextRevision: ctx.contextRevision, brandId: ctx.effectiveBrand, source: fields.source, coverage: fields.coverage,
    collectedAt: fields.collectedAt, cacheAt: fields.cacheAt, freshness: fields.freshness, data: fields.data, error: fields.error };
}
function createGateway() {
  const server = {
    ctx: baseContext(),
    links: [{ id: 'l1', brandId: 'aristo', destination: 'https://oaristocrata.com/products/x', url: 'https://oaristocrata.com/products/x?utm_source=instagram_social&utm_medium=story&utm_campaign=x', origin: 'instagram_social', surface: 'story', state: 'active', revision: 3, createdAt: DAY.d1 }],
    journal: new Map(), takeOpId: pool(OP_IDS, 'operationId')
  };
  const calls = { context: 0, read: [], beginMutation: [], submit: [], receipt: [] };
  const modes = { begin: 'prepared', submit: 'ack', receipt: 'journal' };
  const copy = v => JSON.parse(JSON.stringify(v));
  function read(req) {
    const ctx = server.ctx;
    if (req.expectedContextRevision !== ctx.contextRevision) {
      return envelope(ctx, { state: 'unavailable', source: 'unknown', coverage: 'unknown', freshness: 'unknown', collectedAt: null, cacheAt: null, data: null, error: 'Contexto alterado; releia.' });
    }
    const ready = data => envelope(ctx, { state: 'ready', source: 'own_verified', coverage: 'complete', freshness: 'fresh', collectedAt: DAY.d4, cacheAt: DAY.d5, data, error: null });
    if (req.resource === 'posts' || req.resource === 'stories') return ready({ items: [] });
    if (req.resource === 'links') return ready({ items: server.links.filter(l => l.brandId === ctx.effectiveBrand).map(l => Object.assign({}, l)) });
    // Atribuição e pedido: indisponíveis declarados e bem formados (nenhuma leitura concede escrita).
    return envelope(ctx, { state: 'unavailable', source: 'unknown', coverage: 'unknown', freshness: 'unknown', collectedAt: null, cacheAt: null, data: null, error: 'Fonte sintética indisponível.' });
  }
  function opEnv(id) {
    const j = server.journal.get(id);
    return { operationId: id, contextRevision: server.ctx.contextRevision, state: j.state, binding: copy(j.binding),
      receiptReference: j.state === 'confirmed' ? RECEIPTS[id] : null, result: j.state === 'confirmed' ? copy(j.result) : null, reason: j.reason || null };
  }
  function execute(j) {
    const l = { id: NEW_LINK.id, brandId: j.binding.effectiveBrand, destination: j.binding.payload.destination, url: NEW_LINK.url, origin: j.binding.payload.origin,
      surface: j.binding.payload.surface, state: 'active', revision: NEW_LINK.revision, createdAt: DAY.d5 };
    server.links.push(l); j.result = Object.assign({}, l); j.state = 'confirmed';
  }
  const gateway = {
    context() { calls.context++; return Promise.resolve(copy(server.ctx)); },
    read(req) { calls.read.push(copy(req)); return Promise.resolve(read(req)); },
    beginMutation(req) {
      calls.beginMutation.push(copy(req));
      if (modes.begin === 'throw') return Promise.reject(new Error('sem ACK sintético'));
      if (modes.begin === 'no-id') return Promise.resolve({ state: 'prepared', contextRevision: server.ctx.contextRevision, binding: null });
      const id = server.takeOpId();
      server.journal.set(id, { state: 'prepared', binding: { effectiveBrand: server.ctx.effectiveBrand, kind: req.kind, recordId: null, expectedRecordRevision: null,
        payload: { destination: req.payload.destination, origin: req.payload.origin, surface: req.payload.surface, campaign: req.payload.campaign, date: req.payload.date } } });
      return Promise.resolve(opEnv(id));
    },
    submit(req) {
      calls.submit.push(req.operationId);
      const j = server.journal.get(req.operationId);
      if (!j) return Promise.resolve({ operationId: req.operationId, contextRevision: server.ctx.contextRevision, state: 'rejected', binding: null, receiptReference: null, result: null, reason: 'Operação inexistente.' });
      if (j.state === 'prepared') execute(j); // commit RAM antes de responder (resposta ruim não desfaz)
      if (modes.submit === 'lose-ack') return Promise.reject(new Error('ACK perdido sintético'));
      if (modes.submit === 'foreign-id') return Promise.resolve(Object.assign(opEnv(req.operationId), { operationId: FOREIGN_ID }));
      if (modes.submit === 'raw') {
        const e = new Error('<script>falha secreta</script>');
        return Promise.resolve({ operationId: req.operationId, contextRevision: server.ctx.contextRevision, state: 'confirmed',
          binding: { stack: e.stack, message: e.message, markup: '<b>detalhe interno</b>' }, receiptReference: null, result: { error: e }, reason: e });
      }
      return Promise.resolve(opEnv(req.operationId));
    },
    receipt(req) {
      calls.receipt.push(req.operationId);
      if (!server.journal.has(req.operationId)) return Promise.resolve({ operationId: req.operationId, contextRevision: server.ctx.contextRevision, state: 'uncertain', binding: null, receiptReference: null, result: null, reason: 'Operação não encontrada.' });
      if (modes.receipt === 'foreign-id') return Promise.resolve(Object.assign(opEnv(req.operationId), { operationId: FOREIGN_ID }));
      return Promise.resolve(opEnv(req.operationId));
    }
  };
  function setCtx(patch) { server.ctx = Object.assign({}, server.ctx, copy(patch)); }
  return { gateway, server, calls, modes, setCtx };
}

function setup() {
  const { dom, Organic } = real();
  const doc = new dom.Document();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const g = createGateway();
  const inst = Organic.create({ element: host, document: doc, gateway: g.gateway });
  const q = s => host.querySelector(s);
  const qa = s => host.querySelectorAll(s);
  const text = s => { const el = s ? q(s) : host; return el ? el.textContent : null; };
  const opPhase = () => q('[data-ov-op]').getAttribute('data-ov-op');
  const submitBtn = () => q('[data-ov-form="link-create"] button[type="submit"]');
  const capText = () => text('[data-ov-cap]');
  const draftValue = k => q('[data-ov-draft="' + k + '"]').value;
  async function settle() { for (let i = 0; i < 6; i++) await dom.flush(); }
  async function syncNow() { const p = inst.sync({ filters: { period: PERIOD } }); await settle(); await p; await settle(); }
  function draft(values) { for (const [k, v] of Object.entries(values)) dom.setValue(q('[data-ov-draft="' + k + '"]'), v); }
  async function review(values) { draft(values || DRAFT); dom.submit(q('[data-ov-form="link-create"]')); await settle(); }
  async function click(sel) { const el = typeof sel === 'string' ? q(sel) : sel; if (!el) throw new Error('não encontrado: ' + sel); el.click(); await settle(); }
  const receiptButtons = () => qa('[data-ov-action="receipt"]').map(b => b.getAttribute('data-ov-op'));
  return Object.assign({ doc, host, inst, q, qa, text, opPhase, submitBtn, capText, draftValue, syncNow, draft, review, click, receiptButtons }, g);
}
const count = (hay, needle) => hay.split(needle).length - 1;

// ---------- CR-C2-R4-3: permissão retirada + pendência ----------
test('CR3: capability retirada com operação preparada mostra pendência E razão pública; só receipt do ID original', async () => {
  const t = setup();
  try {
    await t.syncNow();
    await t.review();
    assert.equal(t.opPhase(), 'prepared');
    t.setCtx({ contextRevision: 'r2', role: 'master', capabilities: { 'link.create': { available: false, reason: 'Escrita não admitida para este papel.' }, 'link.archive': { available: true, reason: null } } });
    await t.syncNow();
    // guardas de gate (inalterados)
    assert.equal(t.opPhase(), '', 'projeção preparada do contexto anterior sai da tela');
    assert.equal(t.submitBtn().disabled, true);
    assert.ok(t.qa('[data-ov-action="archive"]').every(b => b.disabled), 'arquivar segue fechado pela pendência');
    assert.deepEqual(t.receiptButtons(), ['op-1'], 'só o ID original, para consulta');
    assert.equal(t.calls.beginMutation.length, 1);
    assert.equal(t.calls.submit.length, 0);
    // texto (R6)
    const cap = t.capText();
    assert.ok(cap.includes(CARRIED_BLOCK), 'razão principal de writeBlock preservada');
    assert.ok(cap.includes('Escrita não admitida para este papel.'), 'razão pública da capability também aparece');
    assert.equal(count(cap, 'Escrita não admitida para este papel.'), 1, 'sem duplicar a razão');
    assert.ok(cap.indexOf(CARRIED_BLOCK) < cap.indexOf('Escrita não admitida'), 'ordem: pendência primeiro');
    // receipt do original não concede permissão nem repete begin/submit
    await t.click('[data-ov-action="receipt"][data-ov-op="op-1"]');
    assert.deepEqual(t.calls.receipt, ['op-1']);
    assert.equal(t.calls.beginMutation.length, 1);
    assert.equal(t.calls.submit.length, 0);
    assert.equal(t.submitBtn().disabled, true);
  } finally { t.inst.dispose(); }
});

for (const [label, cap] of [
  ['razão ausente', { available: false }],
  ['razão malformada', { available: false, reason: 42 }],
  ['capability booleana legada', true]
]) {
  test('CR3: ' + label + ' junto da pendência mostra permissão não confirmada, sem ecoar valor bruto; Mestre não abre', async () => {
    const t = setup();
    try {
      await t.syncNow();
      await t.review();
      assert.equal(t.opPhase(), 'prepared');
      t.setCtx({ contextRevision: 'r2', role: 'master', capabilities: { 'link.create': cap, 'link.archive': { available: true, reason: null } } });
      await t.syncNow();
      assert.equal(t.submitBtn().disabled, true);
      assert.deepEqual(t.receiptButtons(), ['op-1']);
      assert.equal(t.calls.submit.length, 0);
      const c = t.capText();
      assert.ok(c.includes(CARRIED_BLOCK));
      assert.ok(c.includes(CAP_UNCONFIRMED_TEXT));
      assert.doesNotMatch(c, /42|true|\[object|undefined|null/);
    } finally { t.inst.dispose(); }
  });
}

test('controle: capability indisponível conhecida sem pendência local fica fechada, razão uma vez; leituras válidas não concedem escrita', async () => {
  const t = setup();
  try {
    t.setCtx({ capabilities: { 'link.create': { available: false, reason: 'Criação suspensa pelo integrador.' }, 'link.archive': { available: true, reason: null } } });
    await t.syncNow();
    assert.equal(t.q('[data-ov-section="posts"]').getAttribute('data-ov-state'), 'ready', 'leitura válida exibida');
    assert.equal(t.submitBtn().disabled, true);
    assert.equal(t.capText(), 'Criação indisponível: Criação suspensa pelo integrador.');
    assert.equal(t.calls.beginMutation.length, 0);
    t.setCtx({ contextRevision: 'r2', capabilities: { 'link.create': { available: false, reason: null }, 'link.archive': { available: true, reason: null } } });
    await t.syncNow();
    assert.equal(t.submitBtn().disabled, true);
    assert.equal(t.capText(), 'Criação indisponível: Operação não admitida pelo integrador para esta marca/papel.', 'sem acrescentar texto genérico duplicado');
  } finally { t.inst.dispose(); }
});

// ---------- CR-C2-R4-4: resposta de outra operação / inválida ----------
test('CR4: submit com operationId de outra operação fica incerto com frase pública; só receipt do original confirma', async () => {
  const t = setup();
  try {
    await t.syncNow();
    await t.review();
    t.modes.submit = 'foreign-id';
    await t.click('[data-ov-action="op-confirm"]');
    assert.equal(t.opPhase(), 'uncertain');
    assert.deepEqual(t.calls.submit, ['op-1']);
    assert.deepEqual(t.receiptButtons(), ['op-1']);
    const op = t.text('[data-ov-op]');
    assert.ok(op.includes(MISMATCH_TEXT));
    assert.doesNotMatch(op, /operation_id_mismatch|op-foreign|contrato 1\.0\.2 descartada/);
    await t.click('[data-ov-action="receipt"][data-ov-op="op-1"]');
    assert.deepEqual(t.calls.receipt, ['op-1']);
    assert.equal(t.opPhase(), 'confirmed');
    assert.match(t.text('[data-ov-op]'), /Recibo: rcpt-op-1\./);
    assert.equal(t.calls.beginMutation.length, 1);
    assert.equal(t.calls.submit.length, 1);
  } finally { t.inst.dispose(); }
});

test('CR4: receipt de outra operação também é descartado; recibo válido do original não apaga edição mais nova do rascunho', async () => {
  const t = setup();
  try {
    await t.syncNow();
    await t.review();
    t.modes.submit = 'lose-ack';
    await t.click('[data-ov-action="op-confirm"]');
    assert.equal(t.opPhase(), 'uncertain');
    t.draft({ campaign: 'kit_editado' }); // edição posterior pertence à próxima intenção
    t.modes.receipt = 'foreign-id';
    await t.click('[data-ov-action="receipt"][data-ov-op="op-1"]');
    assert.equal(t.opPhase(), 'uncertain');
    assert.deepEqual(t.calls.receipt, ['op-1']);
    assert.deepEqual(t.receiptButtons(), ['op-1']);
    assert.ok(t.text('[data-ov-op]').includes(MISMATCH_TEXT));
    t.modes.receipt = 'journal';
    await t.click('[data-ov-action="receipt"][data-ov-op="op-1"]');
    assert.deepEqual(t.calls.receipt, ['op-1', 'op-1']);
    assert.equal(t.opPhase(), 'confirmed');
    assert.equal(t.draftValue('campaign'), 'kit_editado', 'confirmação só fecha o rascunho original inalterado');
    assert.equal(t.calls.beginMutation.length, 1);
    assert.equal(t.calls.submit.length, 1);
  } finally { t.inst.dispose(); }
});

test('CR4: resultado inválido com Error/stack/markup usa texto fixo genérico, sem eco; ID original mantido', async () => {
  const t = setup();
  try {
    await t.syncNow();
    await t.review();
    t.modes.submit = 'raw';
    await t.click('[data-ov-action="op-confirm"]');
    assert.equal(t.opPhase(), 'uncertain');
    assert.deepEqual(t.receiptButtons(), ['op-1']);
    assert.equal(t.calls.submit.length, 1);
    const op = t.text('[data-ov-op]');
    assert.ok(op.includes(GENERIC_INVALID_TEXT));
    assert.doesNotMatch(op, /secreta|script|detalhe interno|Error|stack|binding|_|<|\(/);
    assert.equal(t.calls.beginMutation.length, 1);
  } finally { t.inst.dispose(); }
});

// ---------- CR-C2-R4-5: preparação sem ACK/ID ----------
test('CR5: begin rejeitado sem ACK/ID exige recuperação; rascunho preservado; releitura completa e journal [] seguem fechados', async () => {
  const t = setup();
  try {
    await t.syncNow();
    t.modes.begin = 'throw';
    await t.review();
    assert.equal(t.calls.beginMutation.length, 1);
    assert.equal(t.calls.submit.length, 0);
    assert.equal(t.opPhase(), '');
    assert.equal(t.submitBtn().disabled, true);
    assert.equal(t.draftValue('campaign'), DRAFT.campaign, 'rascunho preservado');
    const msg = t.text('[data-ov-message]');
    assert.ok(msg.includes(PREPARE_LOST_TEXT));
    assert.doesNotMatch(msg, /atualize a leitura|tentar de novo/);
    t.modes.begin = 'prepared';
    await t.syncNow(); // leitura completa/fresca e pendingOperations [] com journal complete
    assert.equal(t.submitBtn().disabled, true, 'reler não libera nova preparação');
    assert.ok(t.capText().includes(LOST_BLOCK));
    await t.review();
    assert.equal(t.calls.beginMutation.length, 1, 'nenhuma nova intenção enviada');
    assert.equal(t.calls.submit.length, 0);
    assert.equal(t.calls.receipt.length, 0);
    assert.equal(t.draftValue('campaign'), DRAFT.campaign);
  } finally { t.inst.dispose(); }
});

test('CR5 negativo: preparação malformada sem ID segue perdida após reler; sem ID inventado; mensagem existente inalterada', async () => {
  const t = setup();
  try {
    await t.syncNow();
    t.modes.begin = 'no-id';
    await t.review();
    assert.equal(t.opPhase(), '');
    assert.equal(t.text('[data-ov-message]').includes(NO_ID_BEGIN_TEXT), true);
    t.modes.begin = 'prepared';
    await t.syncNow();
    assert.equal(t.submitBtn().disabled, true);
    assert.ok(t.capText().includes(LOST_BLOCK));
    assert.deepEqual(t.receiptButtons(), []);
    assert.equal(t.calls.beginMutation.length, 1);
    assert.equal(t.calls.receipt.length, 0);
  } finally { t.inst.dispose(); }
});
