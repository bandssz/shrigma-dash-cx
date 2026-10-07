'use strict';
// Cenários do store independentes de backend: rodam no motor SINTÉTICO (store-synthetic.test.cjs) e, sem mudança, no
// runner PG de Root com DOIS clientes emprestados (pg17-runner.cjs). Cada cenário usa literais próprios (prefixo sNN)
// para não colidir numa mesma instância de teste vazia. Autorização abaixo é FALSA de teste (papel de Root), em RAM.
const assert = require('node:assert/strict');
const path = require('node:path');
const MOD = path.join(__dirname, '..', '..', 'services', 'dashboard-operational', 'domain', 'organic-links-persistence');
const { createOrganicLinksStore } = require(path.join(MOD, 'store.cjs'));
const codec = require(path.join(MOD, 'codec.cjs'));

const CTX = 'ctx-r1';
// Principais sintéticos (Root decide de verdade): Mestre, WRITE individual por marca, leitura, revogado.
const PRINCIPALS = Object.freeze({
  'p-mestre': { role: 'master', brands: ['aristo', 'fish'], actor: 'actor-mestre' },
  'p-ana-aristo': { role: 'write', brands: ['aristo'], actor: 'actor-ana' },
  'p-leitor': { role: 'read', brands: ['aristo', 'fish'], actor: 'actor-leitor' },
  'p-revogado': null
});
function makeAuthorize(log, override) {
  return async function authorizeIntent(req) {
    log.push(req.action);
    if (override) return override(req);
    const p = PRINCIPALS[req.principalReference];
    if (!p || req.contextRevision !== CTX || !p.brands.includes(req.effectiveBrand)) return { decision: 'deny' };
    return { decision: 'allow', action: req.action, effectiveBrand: req.effectiveBrand, contextRevision: req.contextRevision, operationId: req.operationId,
      intentHash: req.intentHash, role: p.role, actorReference: p.actor };
  };
}
function context(principal) { return { contextRevision: CTX, sessionRevision: 's1', principalReference: principal || 'p-mestre' }; }
function payload(brand, extra) {
  return Object.assign({ destination: brand === 'fish' ? 'https://fishermans.com.br/products/kit-duas-aguas' : 'https://oaristocrata.com/products/alma-da-roca',
    origin: 'instagram_social', surface: 'story', campaign: 'kit_novo', date: '2026-10-05' }, extra || {});
}
function createReq(op, recordId, brand, extra, principal) {
  return { operationId: op, newRecordId: recordId, context: context(principal),
    intent: { kind: 'link.create', contextRevision: CTX, effectiveBrand: brand, payload: payload(brand, extra), recordId: null, expectedRecordRevision: null } };
}
function archiveReq(op, recordId, brand, rev, principal) {
  return { operationId: op, context: context(principal),
    intent: { kind: 'link.archive', contextRevision: CTX, effectiveBrand: brand, payload: {}, recordId, expectedRecordRevision: rev } };
}

// Sessão de teste: wrapper de cliente (falhas/pausa injetadas) + lease sintética ligada ao cliente.
function gate(name) {
  let reached, open;
  const g = { name, reachedP: new Promise(r => { reached = r; }), openP: new Promise(r => { open = r; }) };
  g.reached = reached; g.open = open;
  return g;
}
function wrapSession(base, opts) {
  const o = opts || {};
  const sent = [], poisoned = [];
  let held = o.held === undefined ? true : o.held;
  const client = {
    async query(cfg) {
      sent.push(cfg.name);
      if (o.gate && o.gate.name === cfg.name) { o.gate.reached(); await o.gate.openP; }
      if (o.failBefore === cfg.name) throw Object.assign(new Error('falha sintética <detalhe secreto> antes de ' + cfg.name), { code: '08006' });
      const r = await base.query(cfg);
      if (o.failAfter === cfg.name) throw Object.assign(new Error('ACK perdido sintético <detalhe secreto>'), { code: '08006' });
      if (o.dropLeaseAfter === cfg.name) held = false;
      return r;
    }
  };
  const lease = { client, held: () => held, poison: code => { poisoned.push(code); held = false; } };
  return { client, lease, sent, poisoned };
}
function storeOf(env, extra) {
  const authLog = [];
  const store = createOrganicLinksStore(Object.assign({ enabled: true, normalizer: env.N, authorizeIntent: makeAuthorize(authLog) }, extra || {}));
  return { store, authLog };
}
function envelopeValid(env, req, result) {
  const expected = Object.assign({ operationId: req.operationId }, req.intent);
  const n = env.N.normalizeOperation(expected, codec.toOperationEnvelope(result, CTX));
  return n;
}
const settled = async (p, env) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await env.idle(); return done; };

const scenarios = [
  {
    name: 's01 criação original: revisão 1 active, URL montada no backend, recibo e envelope 1.0.2 válido no normalizador real',
    async run(env) {
      const { store } = storeOf(env);
      const s = wrapSession(env.base('A'));
      const req = createReq('s01-op-1', 's01-link-1', 'aristo');
      const r = await store.execute(s, req);
      assert.equal(r.outcome, 'confirmed');
      assert.equal(r.link.revision, 1);
      assert.equal(r.link.state, 'active');
      assert.equal(r.link.url, 'https://oaristocrata.com/products/alma-da-roca?utm_source=instagram_social&utm_medium=story&utm_campaign=20261005_kit_novo');
      assert.match(r.receiptReference, /^olr1-[0-9a-f]{40}$/);
      assert.deepEqual(s.sent, ['olp_v1_begin', 'olp_v1_op_get', 'olp_v1_link_insert', 'olp_v1_history_insert', 'olp_v1_op_insert', 'olp_v1_commit']);
      const n = envelopeValid(env, req, r);
      assert.equal(n.state, 'valid');
      assert.equal(n.value.opState, 'confirmed');
      assert.equal(n.value.resultState, 'active');
      assert.equal(n.value.result.archiveEligible, true);
      assert.deepEqual(s.poisoned, []);
    }
  },
  {
    name: 's02 repetição idêntica devolve o MESMO resultado e recibo, sem segunda linha',
    async run(env) {
      const { store } = storeOf(env);
      const req = createReq('s02-op-1', 's02-link-1', 'fish', { date: null, campaign: 'bio_fixa', destination: 'https://fishermans.com.br/?ref=x' });
      const a = await store.execute(wrapSession(env.base('A')), req);
      assert.equal(a.outcome, 'confirmed');
      assert.equal(a.link.url, 'https://fishermans.com.br/?ref=x&utm_source=instagram_social&utm_medium=story&utm_campaign=bio_fixa');
      const s2 = wrapSession(env.base('B'));
      const b = await store.execute(s2, req);
      assert.equal(b.outcome, 'confirmed');
      assert.equal(b.replayed, true);
      assert.equal(b.receiptReference, a.receiptReference);
      assert.deepEqual(b.link, a.link);
      assert.ok(!s2.sent.includes('olp_v1_link_insert') && !s2.sent.includes('olp_v1_op_insert'), 'sem nova escrita');
      const list = await store.listLinks(wrapSession(env.base('A')), { effectiveBrand: 'fish', context: context() });
      assert.equal(list.items.filter(l => l.id === 's02-link-1').length, 1);
    }
  },
  {
    name: 's03 reuso divergente do operationId fecha sem escrever',
    async run(env) {
      const { store } = storeOf(env);
      await store.execute(wrapSession(env.base('A')), createReq('s03-op-1', 's03-link-1', 'aristo', { campaign: 's03_kit' }));
      const s = wrapSession(env.base('B'));
      for (const req of [createReq('s03-op-1', 's03-link-1', 'aristo', { campaign: 's03_outro' }), createReq('s03-op-1', 's03-link-2', 'aristo', { campaign: 's03_kit' }),
        archiveReq('s03-op-1', 's03-link-1', 'aristo', 1)]) {
        const r = await store.execute(s, req);
        assert.equal(r.outcome, 'refused');
        assert.equal(r.reason, 'operation_id_reused');
        assert.equal(r.operationId, 's03-op-1');
      }
      assert.ok(!s.sent.includes('olp_v1_link_insert') && !s.sent.includes('olp_v1_link_archive_cas'));
      const list = await store.listLinks(wrapSession(env.base('A')), { effectiveBrand: 'aristo', context: context(), includeArchived: true });
      assert.deepEqual(list.items.filter(l => l.id.startsWith('s03-')).map(l => [l.id, l.state, l.revision]), [['s03-link-1', 'active', 1]]);
    }
  },
  {
    name: 's04 conflito de URL ativa ou de ID recusa sem devolver o registro alheio',
    async run(env) {
      const { store } = storeOf(env);
      const a = await store.execute(wrapSession(env.base('A')), createReq('s04-op-1', 's04-link-1', 'aristo', { campaign: 's04_kit' }));
      assert.equal(a.outcome, 'confirmed');
      const b = await store.execute(wrapSession(env.base('B')), createReq('s04-op-2', 's04-link-2', 'aristo', { campaign: 's04_kit' }));
      assert.equal(b.outcome, 'rejected');
      assert.equal(b.reason, 'url_conflict_active');
      assert.equal(b.link, null);
      const c = await store.execute(wrapSession(env.base('B')), createReq('s04-op-3', 's04-link-1', 'fish', { campaign: 's04_outro' }));
      assert.equal(c.outcome, 'rejected');
      assert.equal(c.reason, 'record_id_conflict', 'link_id de outra marca não é sobrescrito nem revelado');
      assert.equal(c.link, null);
      const replay = await store.execute(wrapSession(env.base('A')), createReq('s04-op-2', 's04-link-2', 'aristo', { campaign: 's04_kit' }));
      assert.equal(replay.outcome, 'rejected', 'a recusa original também é o resultado estável da operação');
      assert.equal(replay.receiptReference, b.receiptReference);
      const n = envelopeValid(env, createReq('s04-op-2', 's04-link-2', 'aristo', { campaign: 's04_kit' }), b);
      assert.equal(n.state, 'valid');
      assert.equal(n.value.opState, 'rejected');
    }
  },
  {
    name: 's05 arquivar por CAS: revisão 2 archived, histórico, lista padrão sem arquivados e filtro explícito com eles',
    async run(env) {
      const { store } = storeOf(env);
      await store.execute(wrapSession(env.base('A')), createReq('s05-op-1', 's05-link-1', 'fish', { campaign: 's05_kit' }));
      const req = archiveReq('s05-op-2', 's05-link-1', 'fish', 1);
      const r = await store.execute(wrapSession(env.base('A')), req);
      assert.equal(r.outcome, 'confirmed');
      assert.equal(r.link.state, 'archived');
      assert.equal(r.link.revision, 2);
      const n = envelopeValid(env, req, r);
      assert.equal(n.state, 'valid');
      assert.equal(n.value.resultState, 'archived');
      assert.equal(n.value.result.archiveEligible, false);
      const s = wrapSession(env.base('B'));
      const def = await store.listLinks(s, { effectiveBrand: 'fish', context: context() });
      assert.equal(def.items.some(l => l.id === 's05-link-1'), false);
      assert.equal(def.coverageClaimed, false);
      assert.equal(def.scope, 'organic_links_v1_only');
      const all = await store.listLinks(s, { effectiveBrand: 'fish', context: context(), includeArchived: true });
      assert.deepEqual(all.items.filter(l => l.id === 's05-link-1').map(l => [l.state, l.revision]), [['archived', 2]]);
      const rc = await store.receipt(s, { operationId: 's05-op-1', effectiveBrand: 'fish', context: context() });
      assert.equal(rc.outcome, 'confirmed');
      assert.deepEqual([rc.link.state, rc.link.revision], ['active', 1], 'recibo da criação mostra o resultado original (revisão 1)');
    }
  },
  {
    name: 's06 arquivado nunca reabre: recriar a mesma URL recusa; arquivar de novo recusa',
    async run(env) {
      const { store } = storeOf(env);
      await store.execute(wrapSession(env.base('A')), createReq('s06-op-1', 's06-link-1', 'aristo', { campaign: 's06_kit' }));
      await store.execute(wrapSession(env.base('A')), archiveReq('s06-op-2', 's06-link-1', 'aristo', 1));
      const again = await store.execute(wrapSession(env.base('B')), createReq('s06-op-3', 's06-link-2', 'aristo', { campaign: 's06_kit' }));
      assert.equal(again.outcome, 'rejected');
      assert.equal(again.reason, 'url_conflict_archived');
      assert.equal(again.link, null);
      const twice = await store.execute(wrapSession(env.base('B')), archiveReq('s06-op-4', 's06-link-1', 'aristo', 2));
      assert.equal(twice.outcome, 'rejected');
      assert.equal(twice.reason, 'already_archived');
      const list = await store.listLinks(wrapSession(env.base('A')), { effectiveBrand: 'aristo', context: context(), includeArchived: true });
      assert.deepEqual(list.items.filter(l => l.id.startsWith('s06-')).map(l => [l.id, l.state, l.revision]), [['s06-link-1', 'archived', 2]]);
    }
  },
  {
    name: 's07 CAS com revisão velha recusa revision_conflict sem mudar a linha',
    async run(env) {
      const { store } = storeOf(env);
      await store.execute(wrapSession(env.base('A')), createReq('s07-op-1', 's07-link-1', 'fish', { campaign: 's07_kit' }));
      const r = await store.execute(wrapSession(env.base('A')), archiveReq('s07-op-2', 's07-link-1', 'fish', 5));
      assert.equal(r.outcome, 'rejected');
      assert.equal(r.reason, 'revision_conflict');
      const list = await store.listLinks(wrapSession(env.base('B')), { effectiveBrand: 'fish', context: context() });
      assert.deepEqual(list.items.filter(l => l.id === 's07-link-1').map(l => [l.state, l.revision]), [['active', 1]]);
    }
  },
  {
    name: 's08 CAS concorrente em duas sessões: a segunda espera o COMMIT da primeira e recusa',
    async run(env) {
      const { store } = storeOf(env);
      await store.execute(wrapSession(env.base('A')), createReq('s08-op-1', 's08-link-1', 'aristo', { campaign: 's08_kit' }));
      const g = gate('olp_v1_commit');
      const a = wrapSession(env.base('A'), { gate: g });
      const b = wrapSession(env.base('B'));
      const pa = store.execute(a, archiveReq('s08-op-2', 's08-link-1', 'aristo', 1));
      await g.reachedP; // A segura a linha antes do COMMIT
      const pb = store.execute(b, archiveReq('s08-op-3', 's08-link-1', 'aristo', 1));
      await env.until(() => b.sent.includes('olp_v1_link_archive_cas'));
      assert.equal(await settled(pb, env), false, 'B bloqueada pela linha de A');
      g.open();
      const [ra, rb] = await Promise.all([pa, pb]);
      assert.equal(ra.outcome, 'confirmed');
      assert.equal(ra.link.revision, 2);
      assert.equal(rb.outcome, 'rejected');
      assert.equal(rb.reason, 'already_archived');
    }
  },
  {
    name: 's09 criação concorrente da mesma URL: a segunda espera; recusa se A confirma, confirma se A falha antes do COMMIT',
    async run(env) {
      const { store } = storeOf(env);
      const g = gate('olp_v1_commit');
      const a = wrapSession(env.base('A'), { gate: g });
      const b = wrapSession(env.base('B'));
      const pa = store.execute(a, createReq('s09-op-1', 's09-link-1', 'fish', { campaign: 's09_kit' }));
      await g.reachedP;
      const pb = store.execute(b, createReq('s09-op-2', 's09-link-2', 'fish', { campaign: 's09_kit' }));
      await env.until(() => b.sent.includes('olp_v1_link_insert'));
      assert.equal(await settled(pb, env), false);
      g.open();
      const [ra, rb] = await Promise.all([pa, pb]);
      assert.equal(ra.outcome, 'confirmed');
      assert.equal(rb.outcome, 'rejected');
      assert.equal(rb.reason, 'url_conflict_active');
      // variação: A falha depois do INSERT e antes do COMMIT -> rollback -> B cria.
      const g2 = gate('olp_v1_history_insert');
      const a2 = wrapSession(env.base('A'), { gate: g2, failBefore: 'olp_v1_history_insert' });
      const b2 = wrapSession(env.base('B'));
      const pa2 = store.execute(a2, createReq('s09-op-3', 's09-link-3', 'fish', { campaign: 's09_outro' }));
      await g2.reachedP;
      const pb2 = store.execute(b2, createReq('s09-op-4', 's09-link-4', 'fish', { campaign: 's09_outro' }));
      await env.until(() => b2.sent.includes('olp_v1_link_insert'));
      assert.equal(await settled(pb2, env), false);
      g2.open();
      const [ra2, rb2] = await Promise.all([pa2, pb2]);
      assert.equal(ra2.outcome, 'not_committed');
      assert.deepEqual(a2.poisoned, ['statement_failed']);
      assert.equal(rb2.outcome, 'confirmed');
      assert.equal(rb2.link.id, 's09-link-4');
    }
  },
  {
    name: 's10 mesma operação em duas sessões concorrentes: um único efeito, segunda devolve o resultado original',
    async run(env) {
      const { store } = storeOf(env);
      const g = gate('olp_v1_commit');
      const a = wrapSession(env.base('A'), { gate: g });
      const b = wrapSession(env.base('B'));
      const req = createReq('s10-op-1', 's10-link-1', 'aristo', { campaign: 's10_kit' });
      const pa = store.execute(a, req);
      await g.reachedP;
      const pb = store.execute(b, req);
      await env.until(() => b.sent.includes('olp_v1_link_insert'));
      g.open();
      const [ra, rb] = await Promise.all([pa, pb]);
      assert.equal(ra.outcome, 'confirmed');
      assert.equal(rb.outcome, 'confirmed');
      assert.equal(rb.replayed, true);
      assert.equal(rb.receiptReference, ra.receiptReference);
      assert.deepEqual(rb.link, ra.link);
      assert.ok(b.sent.includes('olp_v1_rollback'), 'transação da segunda sessão desfeita');
      const list = await store.listLinks(wrapSession(env.base('A')), { effectiveBrand: 'aristo', context: context() });
      assert.equal(list.items.filter(l => l.id.startsWith('s10-')).length, 1);
    }
  },
  {
    name: 's11 isolamento de marca: CAS cruzado, recibo e lista de outra marca não veem nada; WRITE de uma marca não grava na outra',
    async run(env) {
      const { store } = storeOf(env);
      await store.execute(wrapSession(env.base('A')), createReq('s11-op-1', 's11-link-1', 'aristo', { campaign: 's11_kit' }));
      const s = wrapSession(env.base('B'));
      const cross = await store.execute(s, archiveReq('s11-op-2', 's11-link-1', 'fish', 1));
      assert.equal(cross.outcome, 'rejected');
      assert.equal(cross.reason, 'record_not_found');
      const rc = await store.receipt(s, { operationId: 's11-op-1', effectiveBrand: 'fish', context: context() });
      assert.equal(rc.outcome, 'not_found');
      const lf = await store.listLinks(s, { effectiveBrand: 'fish', context: context(), includeArchived: true });
      assert.equal(lf.items.some(l => l.id === 's11-link-1'), false);
      const s2 = wrapSession(env.base('B'));
      const w = await store.execute(s2, createReq('s11-op-3', 's11-link-3', 'fish', { campaign: 's11_fish' }, 'p-ana-aristo'));
      assert.equal(w.outcome, 'refused');
      assert.equal(w.reason, 'authority_denied');
      assert.deepEqual(s2.sent, [], 'recusa antes de qualquer SQL');
      const ok = await store.execute(wrapSession(env.base('A')), createReq('s11-op-4', 's11-link-4', 'aristo', { campaign: 's11_ana' }, 'p-ana-aristo'));
      assert.equal(ok.outcome, 'confirmed');
      const la = await store.listLinks(wrapSession(env.base('A')), { effectiveBrand: 'aristo', context: context() });
      assert.equal(la.items.find(l => l.id === 's11-link-1').state, 'active', 'CAS cruzado não alterou a linha');
    }
  },
  {
    name: 's12 COMMIT sem ACK: uncertain com ID original, lease envenenada, sem replay; sessão nova reconsulta a operação original',
    async run(env) {
      const { store } = storeOf(env);
      const a = wrapSession(env.base('A'), { failAfter: 'olp_v1_commit' });
      const req = createReq('s12-op-1', 's12-link-1', 'fish', { campaign: 's12_kit' });
      const r = await store.execute(a, req);
      assert.equal(r.outcome, 'uncertain');
      assert.equal(r.operationId, 's12-op-1');
      assert.deepEqual(a.poisoned, ['commit_unacknowledged']);
      assert.equal(a.sent.filter(n => n === 'olp_v1_commit').length, 1, 'sem novo COMMIT/replay');
      assert.doesNotMatch(JSON.stringify(r), /secreto|ACK perdido|08006/);
      const n = envelopeValid(env, req, r);
      assert.equal(n.state, 'valid');
      assert.equal(n.value.opState, 'uncertain');
      const before = a.sent.length;
      const reuse = await store.execute(a, req);
      assert.equal(reuse.reason, 'session_poisoned');
      assert.equal(a.sent.length, before, 'cliente envenenado não recebe SQL');
      const b = wrapSession(env.base('B'));
      const rc = await store.receipt(b, { operationId: 's12-op-1', effectiveBrand: 'fish', context: context('p-leitor') });
      assert.equal(rc.outcome, 'confirmed');
      assert.equal(rc.link.id, 's12-link-1');
      assert.deepEqual(b.sent, ['olp_v1_op_receipt'], 'recibo é só leitura');
      const again = await store.execute(wrapSession(env.base('B')), req);
      assert.equal(again.outcome, 'confirmed');
      assert.equal(again.replayed, true);
      assert.equal(again.receiptReference, rc.receiptReference);
    }
  },
  {
    name: 's13 falha parcial antes do COMMIT: rollback, nenhum recibo confirmado, nada visível; nova sessão pode concluir a MESMA operação',
    async run(env) {
      const { store } = storeOf(env);
      const a = wrapSession(env.base('A'), { failBefore: 'olp_v1_op_insert' });
      const req = createReq('s13-op-1', 's13-link-1', 'aristo', { campaign: 's13_kit' });
      const r = await store.execute(a, req);
      assert.equal(r.outcome, 'not_committed');
      assert.equal(r.receiptReference, undefined);
      assert.ok(a.sent.includes('olp_v1_rollback'));
      assert.deepEqual(a.poisoned, ['statement_failed']);
      assert.doesNotMatch(JSON.stringify(r), /secreto|08006/);
      const b = wrapSession(env.base('B'));
      const rc = await store.receipt(b, { operationId: 's13-op-1', effectiveBrand: 'aristo', context: context() });
      assert.equal(rc.outcome, 'not_found');
      const list = await store.listLinks(b, { effectiveBrand: 'aristo', context: context(), includeArchived: true });
      assert.equal(list.items.some(l => l.id === 's13-link-1'), false);
      const done = await store.execute(wrapSession(env.base('B')), req);
      assert.equal(done.outcome, 'confirmed');
      assert.equal(done.replayed, false);
    }
  },
  {
    name: 's14 sem autoridade/lease/dependência ou com boolean do caller: recusa antes de qualquer SQL',
    async run(env) {
      const req = createReq('s14-op-1', 's14-link-1', 'aristo', { campaign: 's14_kit' });
      const cases = [];
      const off = createOrganicLinksStore({ normalizer: env.N, authorizeIntent: makeAuthorize([]) });
      cases.push(['default OFF', off, wrapSession(env.base('A')), req, 'store_disabled']);
      const noAuth = createOrganicLinksStore({ enabled: true, normalizer: env.N });
      cases.push(['sem authorizeIntent', noAuth, wrapSession(env.base('A')), Object.assign({ authorized: true }, req), 'dependency_missing']);
      const noNorm = createOrganicLinksStore({ enabled: true, authorizeIntent: makeAuthorize([]) });
      cases.push(['sem normalizador', noNorm, wrapSession(env.base('A')), req, 'dependency_missing']);
      const boolAuth = createOrganicLinksStore({ enabled: true, normalizer: env.N, authorizeIntent: makeAuthorize([], () => true) });
      cases.push(['concessão booleana', boolAuth, wrapSession(env.base('A')), Object.assign({ authorized: true, role: 'master' }, req), 'authority_denied']);
      const wrongHash = createOrganicLinksStore({ enabled: true, normalizer: env.N, authorizeIntent: makeAuthorize([], q => ({ decision: 'allow', action: q.action, effectiveBrand: q.effectiveBrand,
        contextRevision: q.contextRevision, operationId: q.operationId, intentHash: '0'.repeat(64), role: 'master', actorReference: 'actor-mestre' })) });
      cases.push(['concessão de outro intento', wrongHash, wrapSession(env.base('A')), req, 'authority_denied']);
      for (const [label, patch] of [['outra marca', { effectiveBrand: 'fish' }], ['outro contexto', { contextRevision: 'ctx-r0' }], ['outra ação', { action: 'link.archive' }],
        ['outra operação', { operationId: 's14-op-x' }], ['papel desconhecido', { role: 'admin' }], ['sem ator', { actorReference: '' }]]) {
        const st = createOrganicLinksStore({ enabled: true, normalizer: env.N, authorizeIntent: makeAuthorize([], q => Object.assign({ decision: 'allow', action: q.action,
          effectiveBrand: q.effectiveBrand, contextRevision: q.contextRevision, operationId: q.operationId, intentHash: q.intentHash, role: 'master', actorReference: 'actor-mestre' }, patch)) });
        cases.push(['concessão com ' + label, st, wrapSession(env.base('A')), req, 'authority_denied']);
      }
      const throws = createOrganicLinksStore({ enabled: true, normalizer: env.N, authorizeIntent: makeAuthorize([], () => { throw new Error('IAM <segredo>'); }) });
      cases.push(['autoridade indisponível', throws, wrapSession(env.base('A')), req, 'authority_unavailable']);
      const { store } = storeOf(env);
      cases.push(['leitura não grava', store, wrapSession(env.base('A')), createReq('s14-op-2', 's14-link-2', 'aristo', { campaign: 's14_kit' }, 'p-leitor'), 'authority_denied']);
      cases.push(['revogado não grava', store, wrapSession(env.base('A')), createReq('s14-op-3', 's14-link-3', 'aristo', { campaign: 's14_kit' }, 'p-revogado'), 'authority_denied']);
      cases.push(['contexto não atual', store, wrapSession(env.base('A')), Object.assign({}, req, { intent: Object.assign({}, req.intent, { contextRevision: 'ctx-velho' }), context: Object.assign(context(), { contextRevision: 'ctx-velho' }) }), 'authority_denied']);
      cases.push(['lease não mantida', store, wrapSession(env.base('A'), { held: false }), req, 'lease_not_held']);
      const s = wrapSession(env.base('A'));
      cases.push(['lease de outro cliente', store, { client: s.client, lease: wrapSession(env.base('B')).lease }, req, 'session_invalid']);
      cases.push(['sem sessão', store, null, req, 'session_invalid']);
      for (const [label, st, sess, rq, reason] of cases) {
        const r = await st.execute(sess, rq);
        assert.equal(r.outcome, 'refused', label);
        assert.equal(r.reason, reason, label);
        assert.doesNotMatch(JSON.stringify(r), /segredo|actor-/, label);
        if (sess && sess.sent) assert.deepEqual(sess.sent, [], label + ': nenhum SQL');
      }
      const rcv = wrapSession(env.base('A'));
      assert.equal((await off.receipt(rcv, { operationId: 's14-op-1', effectiveBrand: 'aristo', context: context() })).reason, 'store_disabled');
      assert.equal((await off.listLinks(rcv, { effectiveBrand: 'aristo', context: context() })).reason, 'store_disabled');
      assert.equal((await store.listLinks(rcv, { effectiveBrand: 'aristo', context: context('p-revogado') })).reason, 'authority_denied');
      assert.deepEqual(rcv.sent, []);
    }
  },
  {
    name: 's15 entradas adversariais de URL/data/origem/campanha/IDs recusam antes de qualquer SQL',
    async run(env) {
      const { store, authLog } = storeOf(env);
      const bad = [
        [{ destination: 'http://oaristocrata.com/x' }, ['intent_invalid', 'destination_invalid']],
        [{ destination: 'https://user:pw@oaristocrata.com/x' }, ['destination_credentials']],
        [{ destination: 'https://oaristocrata.com@evil.example/x' }, ['destination_credentials', 'destination_host_not_admitted']],
        [{ destination: 'https://oaristocrata.com.evil.example/x' }, ['destination_host_not_admitted']],
        [{ destination: 'https://evil-oaristocrata.com/x' }, ['destination_host_not_admitted']],
        [{ destination: 'https://loja.oaristocrata.com/x' }, ['destination_host_not_admitted']],
        [{ destination: 'https://fishermans.com.br/x' }, ['destination_host_not_admitted']],
        [{ destination: 'https://oaristocrata.com:8443/x' }, ['destination_host_not_admitted']],
        [{ destination: 'https://oaristocrata.com/x#frag' }, ['destination_invalid']],
        [{ destination: 'https://OARISTOCRATA.com/x' }, ['destination_not_canonical']],
        [{ destination: 'https://oaristocrata.com/x?' }, ['destination_not_canonical']],
        [{ destination: 'https://oaristocrata.com/x?a=1&&b=2' }, ['destination_not_canonical']],
        [{ destination: 'https://oaristocrata.com/x?utm_source=a' }, ['intent_invalid', 'destination_has_utm']],
        [{ destination: 'https://oaristocrata.com/x?%75tm_source=a' }, ['destination_has_utm']],
        [{ destination: 'https://oaristocrata.com/x y' }, ['destination_invalid', 'destination_not_canonical']],
        [{ destination: 'https://oaristocrata.com/x\\y' }, ['destination_invalid']],
        [{ destination: 'https://oaristocrata.com/"><script>' }, ['destination_invalid']],
        [{ origin: 'google' }, ['origin_invalid']],
        [{ surface: 'cpc' }, ['surface_invalid']],
        [{ campaign: 'com espaço' }, ['campaign_invalid']],
        [{ campaign: 'a&utm_source=x' }, ['campaign_invalid']],
        [{ campaign: 'x' }, ['campaign_invalid']],
        [{ date: '2026-02-30' }, ['intent_invalid', 'date_invalid']],
        [{ date: '30/09/2026' }, ['intent_invalid', 'date_invalid']],
        [{ date: '' }, ['intent_invalid', 'date_invalid']],
        [{ date: '1999-12-31' }, ['date_invalid']]
      ];
      for (const [extra, reasons] of bad) {
        const s = wrapSession(env.base('A'));
        const r = await store.execute(s, createReq('s15-op-1', 's15-link-1', 'aristo', extra));
        assert.equal(r.outcome, 'refused', JSON.stringify(extra));
        assert.ok(reasons.includes(r.reason), JSON.stringify(extra) + ' -> ' + r.reason);
        assert.deepEqual(s.sent, [], JSON.stringify(extra) + ': nenhum SQL');
      }
      const ids = [
        [createReq('s15 op', 's15-link-1', 'aristo'), 'operation_id_invalid'],
        [createReq('s15-op-2', undefined, 'aristo'), 'record_id_invalid'],
        [createReq('s15-op-3', 'x;DROP', 'aristo'), 'record_id_invalid'],
        [createReq('s15-op-4', 's15-link-4', 'olivas', { destination: 'https://olivasdocampo.com.br/x' }), 'brand_not_admitted'],
        [archiveReq('s15-op-5', 's15-link-1', 'aristo', 0), 'intent_invalid'],
        [Object.assign(archiveReq('s15-op-6', 's15-link-1', 'aristo', 1), { newRecordId: 'outro' }), 'intent_invalid']
      ];
      for (const [rq, reason] of ids) {
        const s = wrapSession(env.base('A'));
        const r = await store.execute(s, rq);
        assert.equal(r.reason, reason, rq.operationId);
        assert.deepEqual(s.sent, []);
      }
      assert.deepEqual(authLog, [], 'intento inválido nem chega à autorização');
    }
  },
  {
    name: 's16 lease perdida antes do COMMIT: rollback, nada gravado, sessão envenenada',
    async run(env) {
      const { store } = storeOf(env);
      const a = wrapSession(env.base('A'), { dropLeaseAfter: 'olp_v1_op_insert' });
      const r = await store.execute(a, createReq('s16-op-1', 's16-link-1', 'fish', { campaign: 's16_kit' }));
      assert.equal(r.outcome, 'refused');
      assert.equal(r.reason, 'lease_not_held');
      assert.ok(a.sent.includes('olp_v1_rollback') && !a.sent.includes('olp_v1_commit'));
      assert.deepEqual(a.poisoned, ['lease_lost_before_commit']);
      const rc = await store.receipt(wrapSession(env.base('B')), { operationId: 's16-op-1', effectiveBrand: 'fish', context: context() });
      assert.equal(rc.outcome, 'not_found');
    }
  },
  {
    name: 's17 projeção pública sem ator/operação/PII em lista e recibo',
    async run(env) {
      const { store } = storeOf(env);
      const r = await store.execute(wrapSession(env.base('A')), createReq('s17-op-1', 's17-link-1', 'aristo', { campaign: 's17_kit' }, 'p-ana-aristo'));
      const s = wrapSession(env.base('B'));
      const list = await store.listLinks(s, { effectiveBrand: 'aristo', context: context('p-leitor') });
      const rc = await store.receipt(s, { operationId: 's17-op-1', effectiveBrand: 'aristo', context: context('p-leitor') });
      const item = list.items.find(l => l.id === 's17-link-1');
      assert.deepEqual(Object.keys(item).sort(), ['brandId', 'campaign', 'createdAt', 'date', 'destination', 'id', 'origin', 'revision', 'state', 'surface', 'url', 'utmCampaign']);
      for (const blob of [JSON.stringify(list), JSON.stringify(rc.link), JSON.stringify(r.link)]) assert.doesNotMatch(blob, /actor|p-ana|principal|s17-op|session/);
      assert.equal(env.N.normalizeLink(item, 'aristo').state, 'valid');
    }
  }
];

module.exports = { scenarios, wrapSession, gate, makeAuthorize, createReq, archiveReq, context, CTX };
