/* ShrigmaOrganicContractV102 — normalizador de consumo do contrato Orgânico 1.0.2-proposed (C2).
   Fonte preparada, default OFF, não operacional. Funções puras: sem rede, armazenamento, DOM,
   gateway, callbacks, relógio ou geração de IDs/revisões. Validade estrutural NÃO é autenticação,
   admissão nem prova de operação: este módulo nunca emite "ready"/"operational".
   Toda função devolve {state:'valid'|'unavailable'|'forbidden', value:objeto|null, reason:enum|null}
   e não lança nem ecoa objetos/erros recebidos. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.ShrigmaOrganicContractV102 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.2-proposed';
  var RESOURCES = ['posts', 'stories', 'attribution-aggregate', 'links', 'attribution-order-if-admitted'];
  var ATTRIBUTION = ['attribution-aggregate', 'attribution-order-if-admitted'];
  var MODELS = ['last_click', 'last_non_direct'];
  var KINDS = ['link.create', 'link.archive'];
  var READ_STATES = ['ready', 'empty', 'unavailable', 'forbidden'];
  var OP_STATES = ['prepared', 'confirmed', 'pending', 'uncertain', 'rejected'];
  var COVERAGE = ['complete', 'partial', 'unknown'];
  var FRESHNESS = ['fresh', 'stale', 'unknown'];
  var SOURCES = ['own_verified', 'own_declared', 'derived', 'market_estimated', 'unknown'];
  var ROLES = ['read', 'write', 'master'];
  var CREATE_KEYS = ['campaign', 'date', 'destination', 'origin', 'surface'];
  var ENVELOPE_REQUIRED = ['state', 'contextRevision', 'brandId', 'source', 'coverage', 'collectedAt', 'cacheAt', 'freshness', 'data', 'error'];
  var OP_REQUIRED = ['operationId', 'contextRevision', 'state', 'binding', 'receiptReference', 'result', 'reason'];
  var DAILY_STRING = ['source_system', 'currency', 'classification', 'rule_version', 'rule_reason', 'rede', 'superficie', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_provenance', 'piece_status'];
  var QUALITY_INT = ['pedidos_lidos', 'pagos_elegiveis', 'jornada_pendente', 'jornada_parcial', 'ultima_sessao_conhecida', 'ultima_sessao_desconhecida', 'origem_nao_direta_desconhecida'];
  var REASONS = [
    'input_invalid', 'resource_unknown',
    'filter_missing', 'filter_unknown_field', 'filter_brand_not_client', 'filter_invalid_period', 'filter_period_inverted',
    'filter_model_required', 'filter_invalid_model', 'filter_model_not_applicable',
    'context_malformed', 'context_revision_missing', 'brand_missing',
    'envelope_malformed', 'context_mismatch', 'brand_mismatch', 'state_unavailable', 'state_forbidden',
    'data_malformed', 'model_mismatch', 'period_mismatch', 'per_order_not_admitted',
    'intent_invalid', 'operation_malformed', 'operation_id_mismatch', 'binding_missing', 'binding_alias_rejected',
    'binding_brand_missing', 'binding_brand_mismatch', 'binding_kind_mismatch', 'binding_record_mismatch',
    'binding_revision_mismatch', 'binding_payload_mismatch',
    'link_malformed', 'link_brand_mismatch'
  ];

  function out(state, value, reason) { return { state: state, value: value === undefined ? null : value, reason: reason || null }; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return typeof v === 'string' && v.trim() !== ''; }
  function opaque(v) { return (typeof v === 'string' && v !== '') || (typeof v === 'number' && isFinite(v)); }
  // Revisão "real": opaca não vazia; 0 numérico ou "0" não são aceitos (nunca revisão fabricada).
  function realRevision(v) { return (typeof v === 'string' && v.trim() !== '' && v !== '0') || (typeof v === 'number' && isFinite(v) && v > 0); }
  function strOrNull(v, max) { return typeof v === 'string' ? v.slice(0, max || 500) : null; }
  function boolOrNull(v) { return typeof v === 'boolean' ? v : null; }
  function intOrNull(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null; }
  function finiteOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function isoOrNull(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && isFinite(Date.parse(v)) ? v : null; }
  // Decimal exato em unidade MAIOR, como string; preservado literalmente (sem Number, sem arredondar).
  function decimalOrNull(v) { return typeof v === 'string' && /^-?\d{1,15}(\.\d{1,6})?$/.test(v) ? v : null; }
  function civilDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var t = Date.parse(v + 'T12:00:00Z');
    return isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }
  function oneOf(v, list) { return list.indexOf(v) >= 0; }
  // Denso = todo índice 0..length-1 é PRÓPRIO; índice herdado do protótipo conta como buraco.
  function dense(arr) {
    if (!Array.isArray(arr)) return false;
    for (var i = 0; i < arr.length; i++) if (!has(arr, i)) return false;
    return true;
  }
  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (_) { return out('unavailable', null, 'input_invalid'); }
    };
  }

  // ---------- Filtros ----------
  function normalizeFilters(query) {
    if (!isObj(query)) return out('unavailable', null, 'input_invalid');
    var resource = has(query, 'resource') ? query.resource : null;
    if (resource !== null && !oneOf(resource, RESOURCES)) return out('unavailable', null, 'resource_unknown');
    var f = query.filters;
    if (!isObj(f)) return out('unavailable', null, 'filter_missing');
    var keys = Object.keys(f);
    for (var i = 0; i < keys.length; i++) {
      if (/^(brand|brandId|effectiveBrand|marca)$/.test(keys[i])) return out('unavailable', null, 'filter_brand_not_client');
      if (keys[i] !== 'period' && keys[i] !== 'model') return out('unavailable', null, 'filter_unknown_field');
    }
    var p = f.period;
    if (!isObj(p) || !civilDay(p.from) || !civilDay(p.to) || Object.keys(p).some(function (k) { return k !== 'from' && k !== 'to'; })) return out('unavailable', null, 'filter_invalid_period');
    if (p.from > p.to) return out('unavailable', null, 'filter_period_inverted');
    var value = { resource: resource, filters: { period: { from: p.from, to: p.to } } };
    var attr = resource === null ? null : oneOf(resource, ATTRIBUTION);
    if (has(f, 'model')) {
      if (!oneOf(f.model, MODELS)) return out('unavailable', null, 'filter_invalid_model');
      if (attr === false) return out('unavailable', null, 'filter_model_not_applicable');
      value.filters.model = f.model;
    } else if (attr === true) return out('unavailable', null, 'filter_model_required');
    return out('valid', value, null);
  }

  // ---------- Contexto ----------
  function normCapability(c) {
    if (isObj(c) && typeof c.available === 'boolean' && has(c, 'reason') && (c.reason === null || typeof c.reason === 'string')) {
      return { available: c.available, reason: c.reason === null ? null : c.reason.slice(0, 240), known: true };
    }
    return { available: false, reason: null, known: false };
  }
  function normJournal(pending, journal) {
    var ok = true, list = [], seen = {};
    if (!Array.isArray(pending)) ok = false;
    else {
      if (!dense(pending)) ok = false;
      for (var i = 0; i < pending.length; i++) {
        if (!has(pending, i)) continue; // nunca ler índice herdado
        var e = pending[i], id = null, kind = null;
        if (isObj(e) && opaque(e.operationId) && oneOf(e.kind, KINDS)) { id = e.operationId; kind = e.kind; }
        else {
          ok = false;
          // Referência 1.0.1 (ID solto) ou entrada com kind inválido: ID válido fica só para receipt.
          if (opaque(e)) id = e;
          else if (isObj(e) && opaque(e.operationId)) id = e.operationId;
        }
        if (id === null) continue;
        var key = typeof id + ':' + String(id);
        if (seen[key]) { ok = false; continue; }
        seen[key] = true;
        list.push({ operationId: id, kind: kind });
      }
    }
    var state = 'unavailable', revision = null;
    if (isObj(journal) && journal.state === 'complete' && realRevision(journal.revision) && ok) { state = 'complete'; revision = journal.revision; }
    return { state: state, revision: revision, pending: list };
  }
  function normalizeContext(context) {
    if (!isObj(context)) return out('unavailable', null, 'context_malformed');
    if (!opaque(context.contextRevision)) return out('unavailable', null, 'context_revision_missing');
    if (!str(context.effectiveBrand)) return out('forbidden', null, 'brand_missing');
    var caps = isObj(context.capabilities) ? context.capabilities : {};
    return out('valid', {
      contractVersion: VERSION,
      contextRevision: context.contextRevision,
      sessionRevision: opaque(context.sessionRevision) ? context.sessionRevision : null,
      effectiveBrand: context.effectiveBrand,
      principalReference: opaque(context.principalReference) ? context.principalReference : null,
      role: oneOf(context.role, ROLES) ? context.role : null,
      sourceRevision: opaque(context.sourceRevision) ? context.sourceRevision : null,
      capabilities: { 'link.create': normCapability(caps['link.create']), 'link.archive': normCapability(caps['link.archive']) },
      journal: normJournal(context.pendingOperations, context.operationJournal)
    }, null);
  }

  // ---------- Links ----------
  function normalizeLink(item, effectiveBrand) {
    if (!isObj(item) || !opaque(item.id)) return out('unavailable', null, 'link_malformed');
    if (!str(effectiveBrand) || item.brandId !== effectiveBrand) return out('unavailable', null, 'link_brand_mismatch');
    var state = item.state === 'active' || item.state === 'archived' ? item.state : 'unknown';
    var url = strOrNull(item.url, 2000), revision = realRevision(item.revision) ? item.revision : null;
    return out('valid', {
      id: item.id, brandId: item.brandId, destination: strOrNull(item.destination, 2000), url: url,
      origin: strOrNull(item.origin, 120), surface: strOrNull(item.surface, 120), state: state, revision: revision,
      createdAt: isoOrNull(item.createdAt),
      // Elegibilidade estrutural apenas; leitura atual, capability e journal continuam sendo checados pelo consumidor.
      copyEligible: state === 'active' && str(url),
      archiveEligible: state === 'active' && revision !== null
    }, null);
  }

  // ---------- Leituras ----------
  function meta(env) {
    return {
      source: oneOf(env.source, SOURCES) ? env.source : 'unknown',
      coverage: oneOf(env.coverage, COVERAGE) ? env.coverage : 'unknown',
      freshness: oneOf(env.freshness, FRESHNESS) ? env.freshness : 'unknown',
      collectedAt: isoOrNull(env.collectedAt),
      cacheAt: isoOrNull(env.cacheAt),
      publicError: typeof env.error === 'string' ? env.error.slice(0, 240) : null
    };
  }
  function metricsOf(m) {
    if (!isObj(m)) return null;
    var o = {};
    Object.keys(m).forEach(function (k) { if (/^[A-Za-z_][\w]{0,40}$/.test(k)) o[k] = finiteOrNull(m[k]); });
    return o;
  }
  function itemCommon(it) {
    return { id: it.id, provider: strOrNull(it.provider, 60), brandId: it.brandId, publishedAt: isoOrNull(it.publishedAt), source: oneOf(it.source, SOURCES) ? it.source : 'unknown', metrics: metricsOf(it.metrics) };
  }
  function rowsOf(arr, brand, from, to, fn) {
    if (arr === null || arr === undefined) return { rows: null, dropped: 0 };
    if (!dense(arr)) return null;
    var rows = [], dropped = 0;
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!isObj(r) || r.marca !== brand || !civilDay(r.dia) || r.dia < from || r.dia > to) { dropped++; continue; }
      var n = fn(r);
      if (n === null) { dropped++; continue; }
      rows.push(n);
    }
    return { rows: rows, dropped: dropped };
  }
  function dailyRow(model) {
    return function (r) {
      if (r.model !== model) return null; // modelos são lentes alternativas: nunca mesclar
      var o = { marca: r.marca, dia: r.dia, model: r.model };
      DAILY_STRING.forEach(function (k) { o[k] = strOrNull(r[k], 300); });
      o.detail_level = r.detail_level === 'utm' || r.detail_level === 'channel_summary' ? r.detail_level : null;
      o.utm_raw_available = boolOrNull(r.utm_raw_available);
      o.pedidos = intOrNull(r.pedidos);
      o.receita_liquida = decimalOrNull(r.receita_liquida);
      o.leitura_mais_antiga = isoOrNull(r.leitura_mais_antiga);
      o.coletado_em = isoOrNull(r.coletado_em);
      return o;
    };
  }
  function qualityRow(r) {
    var o = { marca: r.marca, dia: r.dia };
    QUALITY_INT.forEach(function (k) { o[k] = intOrNull(r[k]); });
    o.receita_elegivel = decimalOrNull(r.receita_elegivel);
    o.leitura_mais_antiga = isoOrNull(r.leitura_mais_antiga);
    o.coletado_em = isoOrNull(r.coletado_em);
    return o;
  }
  function coverageRow(r) { return { marca: r.marca, dia: r.dia, checked_at: isoOrNull(r.checked_at) }; }
  function attributionData(d, q, brand) {
    if (!isObj(d)) return { reason: 'data_malformed' };
    if (d.model !== q.filters.model) return { reason: 'model_mismatch' };
    if (!isObj(d.period) || d.period.from !== q.filters.period.from || d.period.to !== q.filters.period.to) return { reason: 'period_mismatch' };
    var from = q.filters.period.from, to = q.filters.period.to;
    var daily = rowsOf(d.daily, brand, from, to, dailyRow(d.model));
    var quality = rowsOf(d.quality, brand, from, to, qualityRow);
    var coverage = rowsOf(d.coverage, brand, from, to, coverageRow);
    if (!daily || !quality || !coverage) return { reason: 'data_malformed' };
    var w = isObj(d.window) ? d.window : {};
    return {
      value: {
        period: { from: from, to: to }, model: d.model,
        currency: typeof d.currency === 'string' && /^[A-Z]{3}$/.test(d.currency) ? d.currency : null,
        window: {
          days: intOrNull(w.days), ruleVersion: strOrNull(w.ruleVersion, 120), sourceSystem: strOrNull(w.sourceSystem, 120),
          utmRawAvailable: boolOrNull(w.utmRawAvailable), assistanceAvailable: boolOrNull(w.assistanceAvailable), pieceIdentityAvailable: boolOrNull(w.pieceIdentityAvailable)
        },
        daily: daily.rows, quality: quality.rows, coverage: coverage.rows,
        perOrder: null
      },
      dropped: daily.dropped + quality.dropped + coverage.dropped
    };
  }
  function normalizeRead(query, envelope, context) {
    var q = normalizeFilters(query);
    if (q.state !== 'valid') return q;
    if (q.value.resource === null) return out('unavailable', null, 'resource_unknown');
    var ctx = isObj(context) ? context : null;
    if (!ctx || !opaque(ctx.contextRevision) || !str(ctx.effectiveBrand)) return out('unavailable', null, 'context_malformed');
    if (!isObj(envelope) || !oneOf(envelope.state, READ_STATES)) return out('unavailable', null, 'envelope_malformed');
    if (envelope.contextRevision !== ctx.contextRevision) return out('unavailable', null, 'context_mismatch');
    var brand = ctx.effectiveBrand;
    if (envelope.brandId !== undefined && envelope.brandId !== null && envelope.brandId !== brand) return out('unavailable', null, 'brand_mismatch');
    var m = meta(envelope);
    var base = { resource: q.value.resource, filters: q.value.filters, readState: envelope.state, meta: m, data: null, dropped: 0, emptyConfirmed: false };
    if (envelope.state === 'forbidden') return out('forbidden', base, 'state_forbidden');
    if (envelope.state === 'unavailable') return out('unavailable', base, 'state_unavailable');
    for (var i = 0; i < ENVELOPE_REQUIRED.length; i++) if (!has(envelope, ENVELOPE_REQUIRED[i])) return out('unavailable', null, 'envelope_malformed');
    if (envelope.brandId !== brand) return out('unavailable', null, 'brand_mismatch');
    if (!oneOf(envelope.source, SOURCES) || !oneOf(envelope.coverage, COVERAGE) || !oneOf(envelope.freshness, FRESHNESS)) return out('unavailable', null, 'envelope_malformed');
    if (q.value.resource === 'attribution-order-if-admitted') return out('unavailable', base, 'per_order_not_admitted');
    if (envelope.state === 'empty') {
      if (envelope.data !== null && !(isObj(envelope.data) && Array.isArray(envelope.data.items) && envelope.data.items.length === 0)) return out('unavailable', null, 'data_malformed');
      base.emptyConfirmed = m.coverage === 'complete';
      return out('valid', base, null);
    }
    var r = q.value.resource, d = envelope.data;
    if (r === 'attribution-aggregate') {
      var a = attributionData(d, q.value, brand);
      if (a.reason) return out('unavailable', null, a.reason);
      base.data = a.value; base.dropped = a.dropped;
    } else {
      if (!isObj(d) || !dense(d.items)) return out('unavailable', null, 'data_malformed');
      var items = [];
      for (var j = 0; j < d.items.length; j++) {
        var it = d.items[j];
        if (r === 'links') {
          var l = normalizeLink(it, brand);
          if (l.state === 'valid') items.push(l.value); else base.dropped++;
        } else if (isObj(it) && opaque(it.id) && it.brandId === brand) {
          var c = itemCommon(it);
          if (r === 'posts') { c.title = strOrNull(it.title, 300); c.kind = strOrNull(it.kind, 60); }
          else c.expiresAt = isoOrNull(it.expiresAt);
          items.push(c);
        } else base.dropped++;
      }
      base.data = { items: items };
    }
    // Descartes (marca/linha inválida) tornam a cobertura incompleta: nunca vazio confirmado.
    if (base.dropped > 0 && m.coverage === 'complete') m.coverage = 'partial';
    var n = r === 'attribution-aggregate' ? null : base.data.items.length;
    base.emptyConfirmed = n === 0 && m.coverage === 'complete';
    return out('valid', base, null);
  }

  // ---------- Operações ----------
  // Payload canônico de link.create: só as 5 chaves próprias, com tipos reais; cópia nova, nunca o objeto recebido.
  function createPayload(p) {
    if (!isObj(p) || Object.keys(p).sort().join(',') !== CREATE_KEYS.join(',')) return null;
    for (var i = 0; i < CREATE_KEYS.length; i++) if (!has(p, CREATE_KEYS[i])) return null;
    var d = p.destination, o = p.origin, s = p.surface, c = p.campaign, t = p.date;
    if (!str(d) || d.length > 2000 || !/^https:\/\/[^\s/?#]+/i.test(d) || /[?&]utm_/i.test(d)) return null;
    if (!str(o) || o.length > 120 || !str(s) || s.length > 120 || !str(c) || c.length > 120) return null;
    if (!(t === null || civilDay(t))) return null;
    return { destination: d, origin: o, surface: s, campaign: c, date: t };
  }
  function archivePayload(p) { return isObj(p) && Object.keys(p).length === 0 ? {} : null; }
  function normalizeIntent(e) {
    if (!isObj(e) || !oneOf(e.kind, KINDS) || !opaque(e.contextRevision) || !str(e.effectiveBrand)) return null;
    var p = e.payload;
    if (!isObj(p)) return null;
    if (e.kind === 'link.create') {
      var cp = createPayload(p);
      if (!cp) return null;
      if (has(e, 'recordId') && e.recordId !== null && e.recordId !== undefined) return null;
      if (has(e, 'expectedRecordRevision') && e.expectedRecordRevision !== null && e.expectedRecordRevision !== undefined) return null;
      return { kind: e.kind, contextRevision: e.contextRevision, effectiveBrand: e.effectiveBrand, recordId: null, expectedRecordRevision: null, payload: cp };
    }
    if (!archivePayload(p) || !opaque(e.recordId) || !realRevision(e.expectedRecordRevision)) return null;
    return { kind: e.kind, contextRevision: e.contextRevision, effectiveBrand: e.effectiveBrand, recordId: e.recordId, expectedRecordRevision: e.expectedRecordRevision, payload: {} };
  }
  function samePayload(kind, a, b) {
    if (!isObj(a) || !isObj(b)) return false;
    var ka = Object.keys(a).sort().join(','), kb = Object.keys(b).sort().join(',');
    if (ka !== kb) return false;
    if (kind === 'link.archive') return ka === '';
    if (ka !== CREATE_KEYS.join(',')) return false;
    return CREATE_KEYS.every(function (k) { return a[k] === b[k]; });
  }
  function failOp(expected, reason) {
    // Só o ID ORIGINAL (já conhecido pelo consumidor) é devolvido para recuperação read-only.
    var id = isObj(expected) && opaque(expected.operationId) ? expected.operationId : null;
    return out('unavailable', { operationId: id, receiptOnly: id !== null }, reason);
  }
  function normalizeOperation(expected, envelope) {
    var exp = isObj(expected) ? expected : null;
    if (!exp || !opaque(exp.contextRevision) || !str(exp.effectiveBrand)) return out('unavailable', null, 'intent_invalid');
    var fromJournal = exp.payload === undefined && !has(exp, 'payload');
    var intent = null;
    if (!fromJournal) {
      intent = normalizeIntent(exp);
      if (!intent) return failOp(exp, 'intent_invalid');
    } else if (exp.kind !== undefined && exp.kind !== null && !oneOf(exp.kind, KINDS)) return failOp(exp, 'intent_invalid');
    if (envelope === undefined) {
      // Modo de verificação de intenção (antes de beginMutation): nenhuma resposta envolvida.
      return intent ? out('valid', { intent: intent }, null) : failOp(exp, 'intent_invalid');
    }
    if (!isObj(envelope)) return failOp(exp, 'operation_malformed');
    for (var i = 0; i < OP_REQUIRED.length; i++) if (!has(envelope, OP_REQUIRED[i])) return failOp(exp, 'operation_malformed');
    if (!oneOf(envelope.state, OP_STATES) || !opaque(envelope.operationId)) return failOp(exp, 'operation_malformed');
    if (opaque(exp.operationId) && envelope.operationId !== exp.operationId) return failOp(exp, 'operation_id_mismatch');
    if (envelope.contextRevision !== exp.contextRevision) return failOp(exp, 'context_mismatch');
    var b = envelope.binding;
    if (!isObj(b)) return failOp(exp, 'binding_missing');
    if (has(b, 'brand') || has(b, 'brandId')) return failOp(exp, 'binding_alias_rejected');
    if (!str(b.effectiveBrand)) return failOp(exp, 'binding_brand_missing');
    if (b.effectiveBrand !== exp.effectiveBrand) return failOp(exp, 'binding_brand_mismatch');
    if (!oneOf(b.kind, KINDS)) return failOp(exp, 'binding_kind_mismatch');
    var kind = intent ? intent.kind : (exp.kind || null);
    if (kind !== null && b.kind !== kind) return failOp(exp, 'binding_kind_mismatch');
    var bRecord = has(b, 'recordId') ? b.recordId : undefined, bRev = has(b, 'expectedRecordRevision') ? b.expectedRecordRevision : undefined;
    if (b.kind === 'link.create') {
      if (bRecord !== null || bRev !== null) return failOp(exp, 'binding_record_mismatch');
    } else {
      if (!opaque(bRecord)) return failOp(exp, 'binding_record_mismatch');
      if (!realRevision(bRev)) return failOp(exp, 'binding_revision_mismatch');
    }
    // Recibo do journal (sem intenção conhecida) também exige payload tipado; nada recebido é ecoado.
    var typedPayload = b.kind === 'link.archive' ? archivePayload(b.payload) : createPayload(b.payload);
    if (!typedPayload) return failOp(exp, 'binding_payload_mismatch');
    if (intent) {
      if (bRecord !== intent.recordId) return failOp(exp, 'binding_record_mismatch');
      if (bRev !== intent.expectedRecordRevision) return failOp(exp, 'binding_revision_mismatch');
      if (!samePayload(intent.kind, typedPayload, intent.payload)) return failOp(exp, 'binding_payload_mismatch');
    }
    var result = null, resultState = 'none';
    if (envelope.state === 'confirmed') {
      var l = normalizeLink(envelope.result, exp.effectiveBrand);
      if (l.state === 'valid') { result = l.value; resultState = l.value.state; } else resultState = 'unknown';
    }
    var binding = { effectiveBrand: b.effectiveBrand, kind: b.kind, recordId: b.kind === 'link.create' ? null : bRecord, expectedRecordRevision: b.kind === 'link.create' ? null : bRev,
      payload: typedPayload };
    return out('valid', {
      operationId: envelope.operationId, contextRevision: envelope.contextRevision, opState: envelope.state, binding: binding,
      receiptReference: opaque(envelope.receiptReference) ? envelope.receiptReference : null,
      result: result, resultState: resultState,
      publicReason: typeof envelope.reason === 'string' ? envelope.reason.slice(0, 240) : null
    }, null);
  }

  return {
    version: VERSION,
    REASONS: REASONS.slice(),
    normalizeFilters: safe(normalizeFilters),
    normalizeContext: safe(normalizeContext),
    normalizeRead: safe(normalizeRead),
    normalizeOperation: safe(normalizeOperation),
    normalizeLink: safe(normalizeLink)
  };
});
