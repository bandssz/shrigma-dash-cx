'use strict';
// C2 · organic-links-persistence · store transacional (DAL) de links próprios do Orgânico.
// DEFAULT OFF. Não conecta, não cria pool/broker/retry, não chama end/connect/release: recebe por chamada uma sessão
// {client, lease} já conectada e com lease EXCLUSIVA de Root. Autorização só via authorizeIntent privada de Root
// (identidade/Mestre ou WRITE individual da marca, contexto atual e intento ORIGINAL); DTO válido ou boolean do caller
// nunca autoriza. Falta de dependência, lease ou autoridade recusa ANTES de qualquer SQL.
// Escrita: uma transação grava link + histórico + operação original (hash do intento, vínculo/revisões, resultado,
// recibo). Repetição idêntica devolve o MESMO resultado; reuso divergente do operationId fecha. Arquivamento por CAS
// marca+id+revisão; arquivado nunca reabre. COMMIT sem ACK => uncertain com o operationId ORIGINAL, lease envenenada,
// sem replay. Erros nunca são ecoados (motivos fechados em codec.PUBLIC_REASONS); o módulo não escreve logs.
const { SQL } = require('./sql.cjs');
const codec = require('./codec.cjs');

const WRITE_KINDS = ['link.create', 'link.archive'];
const WRITE_ROLES = ['master', 'write'];
const READ_ROLES = ['master', 'write', 'read'];

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function refuse(reason, extra) { return Object.assign({ outcome: 'refused', reason }, extra || {}); }

function createOrganicLinksStore(options) {
  const o = isObj(options) ? options : {};
  const enabled = o.enabled === true; // somente o literal true liga
  const N = o.normalizer;
  const authorizeIntent = o.authorizeIntent;
  const busy = new WeakSet();
  const poisoned = new WeakSet();

  function depsOk() {
    return !!N && N.version === '1.0.2-proposed' && typeof N.normalizeOperation === 'function' && typeof authorizeIntent === 'function';
  }
  function sessionCheck(session) {
    if (!isObj(session) || !isObj(session.client) || typeof session.client.query !== 'function') return 'session_invalid';
    const lease = session.lease;
    if (!isObj(lease) || typeof lease.held !== 'function' || typeof lease.poison !== 'function' || lease.client !== session.client) return 'session_invalid';
    if (poisoned.has(session.client)) return 'session_poisoned';
    if (busy.has(session.client)) return 'session_busy';
    let held = false;
    try { held = lease.held() === true; } catch (_) { held = false; }
    return held ? null : 'lease_not_held';
  }
  function poison(session, code) {
    poisoned.add(session.client);
    try { session.lease.poison(code); } catch (_) { /* contrato de Root; nada é ecoado */ }
  }
  async function q(session, st, values) {
    const v = values || [];
    if (v.length !== st.arity) throw Object.assign(new Error('arity'), { olpInternal: true });
    return session.client.query({ name: st.name, text: st.text, values: v });
  }

  // Concessão de Root precisa casar EXATAMENTE com o pedido: decisão allow, marca, contexto, intento e papel.
  async function authorize(request, roles) {
    let grant;
    try { grant = await authorizeIntent(Object.freeze(Object.assign({}, request))); } catch (_) { return { reason: 'authority_unavailable' }; }
    if (!isObj(grant) || grant.decision !== 'allow') return { reason: 'authority_denied' };
    if (grant.action !== request.action || grant.effectiveBrand !== request.effectiveBrand || grant.contextRevision !== request.contextRevision) return { reason: 'authority_denied' };
    if (request.intentHash !== undefined && grant.intentHash !== request.intentHash) return { reason: 'authority_denied' };
    if (request.operationId !== undefined && grant.operationId !== request.operationId) return { reason: 'authority_denied' };
    if (!roles.includes(grant.role) || typeof grant.actorReference !== 'string' || grant.actorReference === '' || grant.actorReference.length > 200) return { reason: 'authority_denied' };
    return { grant: { role: grant.role, actorReference: grant.actorReference } };
  }

  // Intento ORIGINAL: validado pelo normalizador REAL 1.0.2 e pelas regras do módulo. Nada é inferido.
  function prepareIntent(req) {
    if (!isObj(req) || !isObj(req.intent) || !isObj(req.context)) return { reason: 'intent_invalid' };
    if (!codec.persistableId(req.operationId)) return { reason: 'operation_id_invalid' };
    const it = req.intent;
    if (!WRITE_KINDS.includes(it.kind)) return { reason: 'intent_invalid' };
    const ni = N.normalizeOperation({ kind: it.kind, contextRevision: it.contextRevision, effectiveBrand: it.effectiveBrand, payload: it.payload,
      recordId: it.recordId, expectedRecordRevision: it.expectedRecordRevision });
    if (!ni || ni.state !== 'valid' || !isObj(ni.value) || !isObj(ni.value.intent)) return { reason: 'intent_invalid' };
    const intent = ni.value.intent;
    if (!Object.prototype.hasOwnProperty.call(codec.BRANDS, intent.effectiveBrand)) return { reason: 'brand_not_admitted' };
    if (typeof req.context.contextRevision !== 'string' || req.context.contextRevision !== intent.contextRevision) return { reason: 'intent_invalid' };
    let recordId, built = null;
    if (intent.kind === 'link.create') {
      if (!codec.persistableId(req.newRecordId)) return { reason: 'record_id_invalid' };
      recordId = req.newRecordId;
      const b = codec.buildLink({ brand: intent.effectiveBrand, destination: intent.payload.destination, origin: intent.payload.origin,
        surface: intent.payload.surface, campaign: intent.payload.campaign, date: intent.payload.date });
      if (!b.ok) return { reason: b.reason };
      built = b.value;
    } else {
      if (req.newRecordId !== undefined && req.newRecordId !== null) return { reason: 'intent_invalid' };
      if (!codec.persistableId(intent.recordId)) return { reason: 'record_id_invalid' };
      if (!codec.realRevision(intent.expectedRecordRevision)) return { reason: 'intent_invalid' };
      recordId = intent.recordId;
    }
    const hashInput = { kind: intent.kind, effectiveBrand: intent.effectiveBrand, recordId, expectedRecordRevision: intent.expectedRecordRevision, payload: intent.payload };
    return {
      value: {
        operationId: req.operationId, kind: intent.kind, brand: intent.effectiveBrand, recordId, built,
        expectedRecordRevision: intent.kind === 'link.archive' ? intent.expectedRecordRevision : null,
        contextRevision: intent.contextRevision,
        sessionRevision: typeof req.context.sessionRevision === 'string' && req.context.sessionRevision !== '' ? req.context.sessionRevision : null,
        principalReference: typeof req.context.principalReference === 'string' ? req.context.principalReference : null,
        intentHash: codec.intentHash(hashInput),
        binding: { effectiveBrand: intent.effectiveBrand, kind: intent.kind, recordId: intent.recordId, expectedRecordRevision: intent.expectedRecordRevision, payload: Object.assign({}, intent.payload) }
      }
    };
  }

  function resultFromStored(row, x, link) {
    if (row.brand !== x.brand || row.kind !== x.kind || row.intent_hash !== x.intentHash || row.record_id !== x.recordId) {
      return { outcome: 'refused', reason: 'operation_id_reused', operationId: x.operationId };
    }
    return {
      outcome: row.outcome, operationId: row.operation_id, brand: row.brand, kind: row.kind, recordId: row.record_id,
      receiptReference: row.receipt_reference, reason: row.reason, resultRevision: row.result_revision,
      link: row.outcome === 'confirmed' ? link : null, binding: x.binding, replayed: true
    };
  }

  async function execute(session, request) {
    if (!enabled) return refuse('store_disabled');
    if (!depsOk()) return refuse('dependency_missing');
    const s = sessionCheck(session);
    if (s) return refuse(s);
    const p = prepareIntent(request);
    if (p.reason) return refuse(p.reason);
    const x = p.value;
    const a = await authorize({ action: x.kind, operationId: x.operationId, effectiveBrand: x.brand, contextRevision: x.contextRevision,
      sessionRevision: x.sessionRevision, principalReference: x.principalReference, intentHash: x.intentHash,
      intent: { kind: x.kind, effectiveBrand: x.brand, recordId: x.binding.recordId, expectedRecordRevision: x.binding.expectedRecordRevision, payload: Object.assign({}, x.binding.payload) },
      newRecordId: x.kind === 'link.create' ? x.recordId : null }, WRITE_ROLES);
    if (a.reason) return refuse(a.reason, { operationId: x.operationId });
    const again = sessionCheck(session); // a autorização é assíncrona: lease/sessão reconferidas antes do SQL
    if (again) return refuse(again, { operationId: x.operationId });
    busy.add(session.client);
    try { return await runWrite(session, x, a.grant); } finally { busy.delete(session.client); }
  }

  async function runWrite(session, x, grant) {
    let phase = 'begin';
    try {
      await q(session, SQL.begin);
      phase = 'body';
      const prior = await q(session, SQL.opGet, [x.operationId]);
      if (prior.rows.length) {
        phase = 'recovery';
        await q(session, SQL.rollback);
        return await storedOutcome(session, x, prior.rows[0]);
      }
      let outcome, reason = null, link = null, resultRevision = null;
      if (x.kind === 'link.create') {
        const b = x.built;
        const ins = await q(session, SQL.linkInsert, [x.brand, x.recordId, b.destination, b.origin, b.surface, b.campaign, b.campaignDate, b.utmCampaign, b.url, x.operationId]);
        if (ins.rows.length === 1) {
          await q(session, SQL.historyInsert, [x.brand, x.recordId, 'created', x.operationId]);
          outcome = 'confirmed'; link = codec.publicLink(ins.rows[0]); resultRevision = ins.rows[0].revision;
        } else {
          const c = await q(session, SQL.linkConflict, [x.brand, x.recordId, b.url]);
          const kind = c.rows.length ? c.rows[0].conflict : null;
          outcome = 'rejected';
          reason = kind === 'record_id' ? 'record_id_conflict' : kind === 'url_archived' ? 'url_conflict_archived' : kind === 'url_active' ? 'url_conflict_active' : 'storage_error';
          if (reason === 'storage_error') throw Object.assign(new Error('conflict unresolved'), { olpInternal: true });
        }
      } else {
        const up = await q(session, SQL.linkArchiveCas, [x.brand, x.recordId, x.expectedRecordRevision, x.operationId]);
        if (up.rows.length === 1) {
          await q(session, SQL.historyInsert, [x.brand, x.recordId, 'archived', x.operationId]);
          outcome = 'confirmed'; link = codec.publicLink(up.rows[0]); resultRevision = up.rows[0].revision;
        } else {
          const pr = await q(session, SQL.linkProbe, [x.brand, x.recordId]);
          outcome = 'rejected';
          reason = !pr.rows.length ? 'record_not_found' : pr.rows[0].state === 'archived' ? 'already_archived' : 'revision_conflict';
        }
      }
      const receipt = codec.receiptReference({ operationId: x.operationId, brand: x.brand, kind: x.kind, intentHash: x.intentHash, outcome, reason, resultRevision });
      const opIns = await q(session, SQL.opInsert, [x.operationId, x.brand, x.kind, x.intentHash, x.recordId, x.expectedRecordRevision, outcome, reason,
        resultRevision, receipt, x.contextRevision, x.sessionRevision, grant.actorReference, grant.role]);
      if (opIns.rows.length !== 1) {
        // Outra transação gravou o MESMO operationId primeiro: desfaz tudo e devolve o resultado dela (ou fecha).
        phase = 'recovery';
        await q(session, SQL.rollback);
        const again = await q(session, SQL.opGet, [x.operationId]);
        if (!again.rows.length) throw Object.assign(new Error('op vanished'), { olpInternal: true });
        return await storedOutcome(session, x, again.rows[0]);
      }
      let held = false;
      try { held = session.lease.held() === true; } catch (_) { held = false; }
      if (!held) {
        await q(session, SQL.rollback);
        poison(session, 'lease_lost_before_commit');
        return refuse('lease_not_held', { operationId: x.operationId });
      }
      phase = 'commit';
      await q(session, SQL.commit);
      phase = 'done';
      return { outcome, operationId: x.operationId, brand: x.brand, kind: x.kind, recordId: x.recordId, receiptReference: receipt, reason,
        resultRevision, link, binding: x.binding, replayed: false };
    } catch (_) {
      if (phase === 'recovery') {
        // A operação histórica pode estar gravada: falha de leitura nunca prova ausência do efeito original.
        poison(session, 'receipt_failed');
        return { outcome: 'uncertain', reason: 'storage_error', operationId: x.operationId, brand: x.brand, kind: x.kind, binding: x.binding };
      }
      if (phase === 'commit') {
        // COMMIT enviado sem ACK: pode ter gravado. Mantém o ID ORIGINAL; nada de replay; sessão envenenada.
        poison(session, 'commit_unacknowledged');
        return { outcome: 'uncertain', reason: 'commit_unacknowledged', operationId: x.operationId, brand: x.brand, kind: x.kind, binding: x.binding };
      }
      if (phase === 'begin') {
        poison(session, 'begin_failed');
        return { outcome: 'not_committed', reason: 'storage_error', operationId: x.operationId };
      }
      if (phase === 'body') {
        try { await q(session, SQL.rollback); } catch (__) { /* sessão inutilizável */ }
      }
      poison(session, 'statement_failed');
      return { outcome: 'not_committed', reason: 'not_committed', operationId: x.operationId };
    }
  }

  async function storedOutcome(session, x, row) {
    let link = null;
    if (row.outcome === 'confirmed' && row.brand === x.brand && row.intent_hash === x.intentHash) {
      const r = await q(session, SQL.opReceipt, [x.operationId, x.brand]);
      link = r.rows.length ? receiptLink(r.rows[0]) : null;
      if (!link || link.id !== row.record_id || link.brandId !== row.brand || link.revision !== row.result_revision) {
        throw Object.assign(new Error('receipt snapshot unavailable'), { olpInternal: true });
      }
    }
    return resultFromStored(row, x, link);
  }

  function receiptLink(r) {
    if (r.h_link_id == null) return null;
    return codec.publicLink({ link_id: r.h_link_id, brand: r.brand, destination: r.h_destination, url: r.h_url, origin: r.h_origin, surface: r.h_surface,
      campaign: r.h_campaign, campaign_date: r.h_campaign_date, utm_campaign: r.h_utm_campaign, state: r.h_state, revision: r.h_revision, created_at: r.h_created_at });
  }

  // Recibo / lookup read-only da operação ORIGINAL (sessão Root nova admitida). Não reserva, não executa, não fabrica.
  async function receipt(session, request) {
    if (!enabled) return refuse('store_disabled');
    if (!depsOk()) return refuse('dependency_missing');
    const s = sessionCheck(session);
    if (s) return refuse(s);
    if (!isObj(request) || !codec.persistableId(request.operationId) || !isObj(request.context)) return refuse('intent_invalid');
    const brand = request.effectiveBrand;
    if (typeof brand !== 'string' || !Object.prototype.hasOwnProperty.call(codec.BRANDS, brand)) return refuse('brand_not_admitted');
    if (typeof request.context.contextRevision !== 'string' || request.context.contextRevision === '') return refuse('intent_invalid');
    const a = await authorize({ action: 'link.receipt', operationId: request.operationId, effectiveBrand: brand, contextRevision: request.context.contextRevision,
      sessionRevision: request.context.sessionRevision, principalReference: request.context.principalReference }, READ_ROLES);
    if (a.reason) return refuse(a.reason, { operationId: request.operationId });
    const again = sessionCheck(session);
    if (again) return refuse(again, { operationId: request.operationId });
    busy.add(session.client);
    try {
      const r = await q(session, SQL.opReceipt, [request.operationId, brand]);
      if (!r.rows.length) return { outcome: 'not_found', reason: 'not_found', operationId: request.operationId };
      const row = r.rows[0];
      const link = row.outcome === 'confirmed' ? receiptLink(row) : null;
      if (row.outcome === 'confirmed' && (!link || link.id !== row.record_id || link.brandId !== row.brand || link.revision !== row.result_revision)) {
        poison(session, 'receipt_failed');
        return { outcome: 'uncertain', reason: 'storage_error', operationId: request.operationId };
      }
      return { outcome: row.outcome, operationId: row.operation_id, brand: row.brand, kind: row.kind, recordId: row.record_id, receiptReference: row.receipt_reference,
        reason: row.reason, resultRevision: row.result_revision, link, intentHash: row.intent_hash };
    } catch (_) {
      poison(session, 'receipt_failed');
      return refuse('storage_error', { operationId: request.operationId });
    } finally { busy.delete(session.client); }
  }

  // Lista por marca. Arquivados só com includeArchived === true. Escopo: linhas deste módulo (o legado não entra).
  async function listLinks(session, request) {
    if (!enabled) return refuse('store_disabled');
    if (!depsOk()) return refuse('dependency_missing');
    const s = sessionCheck(session);
    if (s) return refuse(s);
    if (!isObj(request) || !isObj(request.context)) return refuse('intent_invalid');
    const brand = request.effectiveBrand;
    if (typeof brand !== 'string' || !Object.prototype.hasOwnProperty.call(codec.BRANDS, brand)) return refuse('brand_not_admitted');
    if (typeof request.context.contextRevision !== 'string' || request.context.contextRevision === '') return refuse('intent_invalid');
    const includeArchived = request.includeArchived === true;
    const a = await authorize({ action: 'link.list', effectiveBrand: brand, contextRevision: request.context.contextRevision,
      sessionRevision: request.context.sessionRevision, principalReference: request.context.principalReference }, READ_ROLES);
    if (a.reason) return refuse(a.reason);
    const again = sessionCheck(session);
    if (again) return refuse(again);
    busy.add(session.client);
    try {
      const r = await q(session, SQL.linksList, [brand, includeArchived]);
      return { outcome: 'listed', brand, includeArchived, scope: 'organic_links_v1_only', coverageClaimed: false, items: r.rows.map(codec.publicLink) };
    } catch (_) {
      poison(session, 'list_failed');
      return refuse('storage_error');
    } finally { busy.delete(session.client); }
  }

  return Object.freeze({ enabled, execute, receipt, listLinks });
}

module.exports = { createOrganicLinksStore };
