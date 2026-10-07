'use strict';
// Uma regressão nova, dois ramos de recuperação. Engine/normalizador/helpers reais de fonte C2,
// transport fault exclusivamente sintético. Não conecta PG nem substitui o loader/compila fonte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = process.env.CRM_C2_ORGANIC_LINKS_SOURCE
  ? path.resolve(process.env.CRM_C2_ORGANIC_LINKS_SOURCE) : path.resolve(__dirname, '../..');
const relativeStore = 'services/dashboard-operational/domain/organic-links-persistence/store.cjs';
const selectedStore = process.env.CRM_C2_ORGANIC_LINKS_STORE
  ? path.resolve(process.env.CRM_C2_ORGANIC_LINKS_STORE) : path.join(source, relativeStore);
const helpers = require(path.join(source, 'tests/organic-links-persistence/scenarios.cjs'));
const { createEngine } = require(path.join(source, 'tests/organic-links-persistence/synthetic-sessions.cjs'));
const { loadNormalizer } = require(path.join(source, 'tests/organic-links-persistence/normalizer-context.cjs'));

test('falha de leitura após rollback mantém operação original uncertain e fecha ambos os caminhos de recuperação', async () => {
  // Espelho transitório somente para dependências normais do único store overlay local.
  // Na CI o store e os dois módulos já compõem a mesma árvore; os helpers não são duplicados.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'organic-recovery-qa-'));
  try {
    fs.copyFileSync(selectedStore, path.join(scratch, 'store.cjs'));
    for (const name of ['sql.cjs', 'codec.cjs']) {
      fs.symlinkSync(path.join(source, path.dirname(relativeStore), name), path.join(scratch, name));
    }
    const { createOrganicLinksStore } = require(path.join(scratch, 'store.cjs'));
    const N = loadNormalizer();
    const observations = [];
    for (const branch of ['prior', 'operation-id-race']) {
      const engine = createEngine();
      const store = createOrganicLinksStore({ enabled: true, normalizer: N, authorizeIntent: helpers.makeAuthorize([]) });
      const req = helpers.createReq('qa-recovery-' + branch, 'qa-link-' + branch, 'aristo', { campaign: 'qa_recovery' });
      let first;
      let failed;
      let observed;
      if (branch === 'prior') {
        failed = helpers.wrapSession(engine.client('B'), { failBefore: 'olp_v1_op_receipt' });
        first = await store.execute(helpers.wrapSession(engine.client('A')), req);
        observed = await Promise.allSettled([store.execute(failed, req)]);
      } else {
        const insertGate = helpers.gate('olp_v1_op_insert');
        const waitingGate = helpers.gate('olp_v1_link_insert');
        const a = helpers.wrapSession(engine.client('A'), { gate: insertGate });
        // Pause B só para comprovar que seu opGet terminou sem ver a operação de A.
        const b = helpers.wrapSession(engine.client('B'), { gate: waitingGate, failBefore: 'olp_v1_op_receipt' });
        const firstPromise = store.execute(a, req);
        await insertGate.reachedP;
        const secondPromise = Promise.allSettled([store.execute(b, req)]);
        await waitingGate.reachedP;
        insertGate.open();
        first = await firstPromise;
        waitingGate.open();
        observed = await secondPromise;
        failed = b;
      }
      assert.equal(first.outcome, 'confirmed', branch + ': efeito original comprovado no engine sintético');
      const future = helpers.wrapSession(engine.client('C'));
      const readback = await store.receipt(future, {
        operationId: req.operationId, effectiveBrand: 'aristo', context: helpers.context()
      });
      assert.equal(readback.outcome, 'confirmed');
      assert.equal(readback.receiptReference, first.receiptReference);
      assert.equal(engine.committed.links.size, 1);
      assert.equal(engine.committed.ops.size, 1);
      assert.equal(engine.committed.history.size, 1);
      observations.push({ branch, req, observed, failed, readback, store });
    }
    // O produtor original rejeita ambas as Promises com o erro sintético bruto.
    assert.deepEqual(observations.map(x => x.observed[0].status), ['fulfilled', 'fulfilled']);
    for (const { branch, req, observed, failed, store } of observations) {
      const result = observed[0].value;
      assert.deepEqual(result, {
        outcome: 'uncertain', reason: 'storage_error', operationId: req.operationId,
        brand: 'aristo', kind: 'link.create', binding: {
          effectiveBrand: 'aristo', kind: 'link.create', recordId: null,
          expectedRecordRevision: null, payload: req.intent.payload
        }
      }, branch + ': sem alegar ausência do efeito histórico nem erro bruto');
      assert.deepEqual(failed.poisoned, ['receipt_failed']);
      const before = failed.sent.length;
      const again = await store.execute(failed, req);
      assert.equal(again.outcome, 'refused');
      assert.equal(again.reason, 'session_poisoned');
      assert.equal(failed.sent.length, before, 'nenhum replay em sessão envenenada');
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('snapshot de operação confirmada ausente ou divergente permanece uncertain no replay e no recibo read-only', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'organic-snapshot-qa-'));
  try {
    fs.copyFileSync(selectedStore, path.join(scratch, 'store.cjs'));
    for (const name of ['sql.cjs', 'codec.cjs']) {
      fs.symlinkSync(path.join(source, path.dirname(relativeStore), name), path.join(scratch, name));
    }
    const { createOrganicLinksStore } = require(path.join(scratch, 'store.cjs'));
    const N = loadNormalizer();
    const observations = [];
    for (const variant of ['missing', 'wrong-id', 'wrong-revision']) {
      const engine = createEngine();
      const store = createOrganicLinksStore({ enabled: true, normalizer: N, authorizeIntent: helpers.makeAuthorize([]) });
      const req = helpers.createReq('qa-snapshot-' + variant, 'qa-snapshot-link-' + variant, 'fish', { campaign: 'qa_snapshot' });
      const original = await store.execute(helpers.wrapSession(engine.client('A')), req);
      assert.equal(original.outcome, 'confirmed');
      function unavailableSession(name) {
        const base = engine.client(name);
        const poisoned = [], sent = [];
        let held = true;
        const client = { async query(cfg) {
          sent.push(cfg.name);
          const r = await base.query(cfg);
          if (cfg.name !== 'olp_v1_op_receipt') return r;
          return { ...r, rows: r.rows.map(row => ({ ...row,
            ...(variant === 'missing' ? { h_link_id: null } :
              variant === 'wrong-id' ? { h_link_id: 'qa-other-link' } : { h_revision: row.result_revision + 1 })
          })) };
        } };
        return { client, lease: { client, held: () => held, poison: code => { poisoned.push(code); held = false; } }, poisoned, sent };
      }
      const replaySession = unavailableSession('B');
      const replay = await store.execute(replaySession, req);
      const readSession = unavailableSession('C');
      const read = await store.receipt(readSession, {
        operationId: req.operationId, effectiveBrand: 'fish', context: helpers.context()
      });
      observations.push({ variant, req, replay, read, replaySession, readSession });
      assert.equal(engine.committed.links.size, 1);
      assert.equal(engine.committed.ops.size, 1);
      assert.equal(engine.committed.history.size, 1);
      assert.ok(!replaySession.sent.includes('olp_v1_link_insert') && !readSession.sent.includes('olp_v1_begin'));
      // O snapshot original continua recuperável por nova leitura íntegra, sem reexecutar o intento.
      const actual = await store.receipt(helpers.wrapSession(engine.client('D')), {
        operationId: req.operationId, effectiveBrand: 'fish', context: helpers.context()
      });
      assert.equal(actual.outcome, 'confirmed');
      assert.deepEqual(actual.link, original.link);
    }
    for (const { variant, req, replay, read, replaySession, readSession } of observations) {
      assert.equal(replay.outcome, 'uncertain', variant + ': snapshot não confirma replay');
      assert.equal(replay.reason, 'storage_error');
      assert.equal(replay.operationId, req.operationId);
      assert.equal(replay.binding.effectiveBrand, 'fish');
      assert.equal(replay.binding.recordId, null);
      assert.equal(replay.link, undefined);
      assert.deepEqual(read, { outcome: 'uncertain', reason: 'storage_error', operationId: req.operationId });
      assert.deepEqual(replaySession.poisoned, ['receipt_failed']);
      assert.deepEqual(readSession.poisoned, ['receipt_failed']);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('ACK de ROLLBACK perdido após observar operação histórica preserva uncertain nos dois ramos', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'organic-rollback-qa-'));
  try {
    fs.copyFileSync(selectedStore, path.join(scratch, 'store.cjs'));
    for (const name of ['sql.cjs', 'codec.cjs']) {
      fs.symlinkSync(path.join(source, path.dirname(relativeStore), name), path.join(scratch, name));
    }
    const { createOrganicLinksStore } = require(path.join(scratch, 'store.cjs'));
    const N = loadNormalizer();
    const observations = [];
    for (const branch of ['prior', 'operation-id-race']) {
      const engine = createEngine();
      const store = createOrganicLinksStore({ enabled: true, normalizer: N, authorizeIntent: helpers.makeAuthorize([]) });
      const req = helpers.createReq('qa-rollback-' + branch, 'qa-rollback-link-' + branch, 'aristo', { campaign: 'qa_rollback' });
      let first, failed, result;
      if (branch === 'prior') {
        first = await store.execute(helpers.wrapSession(engine.client('A')), req);
        // O ROLLBACK é executado no engine; somente seu ACK de transporte se perde.
        failed = helpers.wrapSession(engine.client('B'), { failAfter: 'olp_v1_rollback' });
        result = await store.execute(failed, req);
      } else {
        const insertGate = helpers.gate('olp_v1_op_insert');
        const waitingGate = helpers.gate('olp_v1_link_insert');
        const a = helpers.wrapSession(engine.client('A'), { gate: insertGate });
        failed = helpers.wrapSession(engine.client('B'), { gate: waitingGate, failAfter: 'olp_v1_rollback' });
        const firstPromise = store.execute(a, req);
        await insertGate.reachedP;
        const secondPromise = store.execute(failed, req);
        await waitingGate.reachedP;
        insertGate.open();
        first = await firstPromise;
        waitingGate.open();
        result = await secondPromise;
      }
      assert.equal(first.outcome, 'confirmed');
      const readback = await store.receipt(helpers.wrapSession(engine.client('C')), {
        operationId: req.operationId, effectiveBrand: 'aristo', context: helpers.context()
      });
      assert.equal(readback.outcome, 'confirmed');
      assert.equal(readback.receiptReference, first.receiptReference);
      assert.equal(engine.committed.links.size, 1);
      assert.equal(engine.committed.ops.size, 1);
      assert.equal(engine.committed.history.size, 1);
      observations.push({ branch, req, result, failed, store });
    }
    // Root overlay v1 respondia not_committed embora o READ comprovesse o efeito original.
    for (const { branch, req, result, failed, store } of observations) {
      assert.equal(result.outcome, 'uncertain', branch + ': falha de rollback não prova ausência histórica');
      assert.equal(result.reason, 'storage_error');
      assert.equal(result.operationId, req.operationId);
      assert.equal(result.brand, 'aristo');
      assert.equal(result.kind, 'link.create');
      assert.deepEqual(result.binding.payload, req.intent.payload);
      assert.equal(result.link, undefined);
      assert.equal(result.receiptReference, undefined);
      assert.deepEqual(failed.poisoned, ['receipt_failed']);
      assert.equal(failed.sent.filter(x => x === 'olp_v1_rollback').length, 1, 'sem retry automático de rollback');
      assert.ok(!failed.sent.includes('olp_v1_op_receipt'));
      const before = failed.sent.length;
      assert.equal((await store.execute(failed, req)).reason, 'session_poisoned');
      assert.equal(failed.sent.length, before, 'sem replay em sessão descartada');
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
