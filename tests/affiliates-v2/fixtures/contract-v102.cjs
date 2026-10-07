/* Pure consumer of the proposed Root DTO. No I/O, authority, defaults or journal store. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else root.ShrigmaAffiliatesContractV102 = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var version = '1.0.2-proposed';
  var kinds = ['creator.create', 'creator.update', 'creator.archive', 'sample.record-manual', 'sample.update-manual', 'task.create', 'task.update', 'content.record-manual', 'content.update-manual'];
  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var obj = function (v) { return v !== null && Object.prototype.toString.call(v) === '[object Object]'; };
  var text = function (v) { return typeof v === 'string' && v.trim().length > 0; };
  var ref = function (v) { return text(v) || (Number.isSafeInteger(v) && v >= 0); };
  var rev = function (v) { return text(v) || (Number.isSafeInteger(v) && v > 0); };
  var dense = function (a) { if (!Array.isArray(a)) return false; for (var i = 0; i < a.length; i++) if (!own(a, i)) return false; return true; };
  var oneOf = function (v, list) { return list.indexOf(v) >= 0; };
  var nullableText = function (v) { return v === null || typeof v === 'string'; };
  function date(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8));
    if (y < 1 || m < 1 || m > 12 || d < 1) return false;
    var days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= days[m - 1];
  }
  function period(v) { return obj(v) && Object.keys(v).length === 2 && own(v, 'start') && own(v, 'end') && date(v.start) && date(v.end) && v.start <= v.end; }
  function samePeriod(a, b) { return period(a) && period(b) && a.start === b.start && a.end === b.end; }
  function catalog(c, kind) {
    if (!obj(c) || !rev(c.revision) || !dense(c.items)) return null;
    var values = new Set(), orders = new Set(), out = [];
    for (var i = 0; i < c.items.length; i++) {
      var x = c.items[i];
      if (!obj(x) || !text(x.value) || !text(x.label) || values.has(x.value)) return null;
      values.add(x.value);
      if (kind === 'stage') {
        if (!Number.isSafeInteger(x.order) || orders.has(x.order) || !(x.terminal === null || typeof x.terminal === 'boolean')) return null;
        orders.add(x.order); out.push({ value: x.value, label: x.label, order: x.order, terminal: x.terminal });
      } else {
        if (typeof x.open !== 'boolean' || typeof x.terminal !== 'boolean' || (x.open && x.terminal)) return null;
        out.push({ value: x.value, label: x.label, open: x.open, terminal: x.terminal });
      }
    }
    if (kind === 'stage') out.sort(function (a, b) { return a.order - b.order; });
    return { revision: c.revision, items: out };
  }
  function pending(p) {
    if (!Array.isArray(p)) return { ids: [], unreadable: true };
    var ids = [], seen = new Set(), bad = false;
    for (var i = 0; i < p.length; i++) {
      if (!own(p, i)) { bad = true; continue; }
      var id = obj(p[i]) ? p[i].operationId : p[i];
      if (!ref(id) || seen.has(String(id))) { bad = true; continue; }
      seen.add(String(id)); ids.push(id);
    }
    return { ids: ids, unreadable: bad };
  }
  function journal(ctx) {
    var j = ctx && ctx.operationJournal, p = pending(ctx && ctx.pendingOperations);
    if (!obj(j) || j.state !== 'complete' || !rev(j.revision) || !oneOf(j.preparationRecovery, ['quiescent', 'pending', 'unknown']) || !nullableText(j.reason) || p.unreadable)
      return { state: 'unavailable', revision: null, preparationRecovery: 'unknown', reason: 'Journal integral não confirmado.', ids: p.ids };
    return { state: 'complete', revision: j.revision, preparationRecovery: j.preparationRecovery, reason: j.reason, ids: p.ids };
  }
  function context(c) {
    if (!obj(c) || !text(c.contextRevision) || !text(c.effectiveBrand) || !ref(c.principalReference) || !oneOf(c.role, ['read', 'write', 'master'])) return { error: 'Contexto sem identidade, marca, papel ou revisão válidos.' };
    var out = Object.assign({}, c);
    out.capabilities = {};
    kinds.forEach(function (k) {
      var cap = obj(c.capabilities) ? c.capabilities[k] : undefined;
      if (typeof cap === 'boolean') out.capabilities[k] = { available: cap, reason: null };
      else if (obj(cap) && typeof cap.available === 'boolean' && nullableText(cap.reason)) out.capabilities[k] = { available: cap.available, reason: cap.reason };
      else out.capabilities[k] = { available: false, reason: 'Capacidade ausente ou malformada.' };
    });
    out.effectiveBrandLabel = text(c.effectiveBrandLabel) ? c.effectiveBrandLabel : null;
    out.stageCatalog = catalog(c.stageCatalog, 'stage'); out.taskStateCatalog = catalog(c.taskStateCatalog, 'task');
    out.operationJournal = journal(c);
    // Original IDs remain available for read-only receipt when the journal is unavailable.
    out.pendingOperations = out.operationJournal.ids;
    return { context: out };
  }
  function filters(f, resource) {
    if (!oneOf(resource, ['creators', 'creator-profile', 'samples', 'products', 'content', 'tasks', 'own-performance'])) return { error: 'Recurso fora do contrato 1.0.2.' };
    if (!obj(f) || Object.keys(f).some(function (k) { return !oneOf(k, ['period', 'creatorId']); })) return { error: 'Filtros fora do contrato 1.0.2.' };
    var temporal = resource !== 'creators' && resource !== 'products';
    if ((own(f, 'period') && !period(f.period)) || (temporal && !period(f.period))) return { error: 'Janela civil exata não informada ou inválida.' };
    if (own(f, 'creatorId') && (!oneOf(resource, ['creator-profile', 'own-performance']) || !ref(f.creatorId))) return { error: 'Filtro de criador inválido para este recurso.' };
    if (resource === 'creator-profile' && !ref(f.creatorId)) return { error: 'Perfil sem ID persistido.' };
    var out = {}; if (period(f.period)) out.period = { start: f.period.start, end: f.period.end };
    if (own(f, 'creatorId')) out.creatorId = f.creatorId;
    return { filters: out };
  }
  function creator(c, brand) {
    return obj(c) && ref(c.id) && c.brandId === brand && text(c.provider) && ref(c.providerId) && text(c.displayName) && rev(c.revision) && ['handle', 'ownerReference', 'stage'].every(function (k) { return !own(c, k) || nullableText(c[k]); });
  }
  function references(p) {
    if (p === null || p === undefined) return null;
    if (!obj(p) || !oneOf(p.state, ['ready', 'empty', 'unavailable', 'forbidden']) || !oneOf(p.coverage, ['complete', 'partial', 'unknown']) || !nullableText(p.reason)) return null;
    if (p.state === 'unavailable' || p.state === 'forbidden') return { state: p.state, items: null, coverage: p.coverage, reason: p.reason };
    if (!dense(p.items)) return null;
    var seen = new Set();
    for (var i = 0; i < p.items.length; i++) { if (!ref(p.items[i]) || seen.has(String(p.items[i]))) return null; seen.add(String(p.items[i])); }
    if (p.state === 'empty' && (p.items.length !== 0 || p.coverage !== 'complete')) return null;
    if (p.state === 'ready' && p.items.length === 0 && p.coverage === 'complete') return null;
    return { state: p.state, items: p.items.slice(), coverage: p.coverage, reason: p.reason };
  }
  function lens(l, f) {
    if (!obj(l) || !text(l.lens) || !text(l.label) || !(l.creatorId === null || ref(l.creatorId)) || (own(f, 'creatorId') ? l.creatorId !== f.creatorId : l.creatorId !== null)) return null;
    var nullable = ['provider', 'attributionModel', 'timezone', 'currency', 'settlementProof', 'policyVersion'];
    if (nullable.some(function (k) { return !nullableText(l[k]); })) return null;
    if (!(l.period === null || period(l.period)) || !oneOf(l.source, ['own_verified', 'own_declared', 'derived', 'market_estimated', 'unknown']) || !oneOf(l.coverage, ['complete', 'partial', 'unknown']) || !oneOf(l.freshness, ['fresh', 'stale', 'unknown'])) return null;
    if (['collectedAt', 'cacheAt'].some(function (k) { return !(l[k] === null || (typeof l[k] === 'string' && /^\d{4}-\d\d-\d\dT/.test(l[k]) && Number.isFinite(Date.parse(l[k])))); })) return null;
    if (['estimatedMinor', 'accruedMinor', 'settledMinor', 'returnsMinor'].some(function (k) { return !(l[k] === null || Number.isSafeInteger(l[k])); })) return null;
    if (!(l.metrics === null || obj(l.metrics))) return null;
    var out = Object.assign({}, l);
    out.period = l.period === null ? null : { start: l.period.start, end: l.period.end };
    // A differently declared lens window remains isolated and explicitly incompatible.
    out.windowMatches = samePeriod(l.period, f.period);
    return out;
  }
  function envelope(env, ctx, resource, f) {
    var cc = context(ctx), ff = filters(f, resource);
    if (cc.error || ff.error) return { error: cc.error || ff.error };
    ctx = cc.context; f = ff.filters;
    if (!obj(env) || !oneOf(env.state, ['ready', 'empty', 'unavailable', 'forbidden'])) return { error: 'Envelope/estado malformado.' };
    if (env.state === 'forbidden') return { env: { state: 'forbidden', error: typeof env.error === 'string' ? env.error : null } };
    if (env.contextRevision !== ctx.contextRevision || env.brandId !== ctx.effectiveBrand) return { error: 'Resposta de marca/contexto divergente.', discarded: true };
    var out = { state: env.state, brandId: env.brandId, contextRevision: env.contextRevision,
      source: oneOf(env.source, ['own_verified', 'own_declared', 'derived', 'market_estimated', 'unknown']) ? env.source : 'unknown',
      coverage: oneOf(env.coverage, ['complete', 'partial', 'unknown']) ? env.coverage : 'unknown',
      freshness: oneOf(env.freshness, ['fresh', 'stale', 'unknown']) ? env.freshness : 'unknown',
      collectedAt: typeof env.collectedAt === 'string' ? env.collectedAt : null, cacheAt: typeof env.cacheAt === 'string' ? env.cacheAt : null,
      error: typeof env.error === 'string' ? env.error : null, data: null, items: null, malformed: 0, refreshFailed: false };
    if (env.state === 'unavailable') return { env: out };
    var d = env.data, temporal = resource !== 'creators' && resource !== 'products';
    if (temporal && (!obj(d) || !samePeriod(d.period, f.period))) return { error: 'Resposta sem confirmação do período pedido.' };
    if (oneOf(resource, ['creators', 'samples', 'products', 'content', 'tasks'])) {
      if (!obj(d) || !dense(d.items)) return { error: 'Coleção malformada ou não informada.' };
      if (env.state === 'empty' && (d.items.length || out.coverage !== 'complete')) return { error: 'Vazio sem prova de coleção completa.' };
      if (env.state === 'ready' && d.items.length === 0 && out.coverage === 'complete') return { error: 'Vazio exige estado empty explícito no contrato 1.0.2.' };
      var seen = new Set(), items = [];
      for (var i = 0; i < d.items.length; i++) {
        var it = d.items[i];
        if (!obj(it) || !ref(it.id) || seen.has(String(it.id))) return { error: 'Identidade de registro inválida ou duplicada.' };
        seen.add(String(it.id));
        if (resource === 'creators' && !creator(it, ctx.effectiveBrand)) return { error: 'Criador sem vínculo persistido de marca/provedor/revisão.' };
        if (resource !== 'creators' && own(it, 'brandId') && it.brandId !== ctx.effectiveBrand) return { error: 'Registro de outra marca.' };
        if (oneOf(resource, ['samples', 'content', 'tasks']) && (!ref(it.creatorId) || !rev(it.revision))) return { error: 'Registro sem associação/revisão persistidas.' };
        if (resource === 'products' && (!text(it.sku) || !text(it.label))) return { error: 'Produto sem SKU/rótulo próprios.' };
        if (resource === 'samples' && (!text(it.sku) || !text(it.manualStatus))) return { error: 'Amostra sem SKU/status declarado.' };
        if (resource === 'content' && (!text(it.provider) || !text(it.kind))) return { error: 'Conteúdo sem provedor/tipo.' };
        if (resource === 'tasks' && (!text(it.label) || !text(it.state))) return { error: 'Tarefa sem rótulo/situação.' };
        var row = Object.assign({}, it);
        if (resource === 'tasks') {
          var c = ctx.taskStateCatalog && ctx.taskStateCatalog.items.filter(function (x) { return x.value === it.state; })[0];
          var flags = c && typeof it.open === 'boolean' && typeof it.terminal === 'boolean' && !(it.open && it.terminal) && it.open === c.open && it.terminal === c.terminal;
          row.open = flags ? it.open : null; row.terminal = flags ? it.terminal : null;
        }
        items.push(row);
      }
      out.items = items; out.data = { items: items, period: temporal ? { start: f.period.start, end: f.period.end } : null };
      return { env: out };
    }
    if (resource === 'creator-profile') {
      if (env.state !== 'ready' || !obj(d.references) || !creator(d.creator, ctx.effectiveBrand) || d.creator.id !== f.creatorId) return { error: 'Perfil sem DTO canônico/vínculo persistido.' };
      var r = {}; ['samples', 'products', 'content', 'tasks'].forEach(function (k) { r[k] = references(d.references[k]); });
      out.creator = Object.assign({}, d.creator); out.data = { creator: out.creator, references: r, period: { start: f.period.start, end: f.period.end } };
      return { env: out };
    }
    if (resource !== 'own-performance' || !dense(d.lenses)) return { error: 'Desempenho sem lentes tipadas.' };
    if (env.state === 'empty' && (d.lenses.length || out.coverage !== 'complete')) return { error: 'Lentes vazias sem catálogo completo.' };
    if (env.state === 'ready' && !d.lenses.length && out.coverage === 'complete') return { error: 'Catálogo vazio exige estado empty.' };
    var lenses = [], names = new Set();
    for (var n = 0; n < d.lenses.length; n++) { var l = lens(d.lenses[n], f); if (!l || names.has(l.lens)) return { error: 'Lente sem tipos/escopo individual válidos.' }; names.add(l.lens); lenses.push(l); }
    out.data = { period: { start: f.period.start, end: f.period.end }, lenses: lenses };
    return { env: out };
  }
  function nextStep(env, creatorId) {
    if (!ref(creatorId)) return { state: 'unavailable', task: null };
    if (!env || !oneOf(env.state, ['ready', 'empty']) || env.coverage !== 'complete' || env.freshness !== 'fresh' || env.refreshFailed || !dense(env.items)) return { state: 'unavailable', task: null };
    if (env.items.some(function (t) { return !obj(t) || !ref(t.id) || !ref(t.creatorId) || !text(t.label); })) return { state: 'unavailable', task: null };
    var tasks = env.items.filter(function (t) { return t.creatorId === creatorId; });
    if (tasks.some(function (t) { return typeof t.open !== 'boolean' || typeof t.terminal !== 'boolean' || (t.open && t.terminal) || !(t.dueAt == null || date(t.dueAt)); })) return { state: 'unavailable', task: null };
    tasks = tasks.filter(function (t) { return t.open && !t.terminal; });
    tasks.sort(function (a, b) { var x = a.dueAt || '', y = b.dueAt || ''; if (x !== y) return !x ? 1 : !y ? -1 : x < y ? -1 : 1; var ka = String(a.id), kb = String(b.id); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    return { state: tasks.length ? 'ready' : 'empty', task: tasks[0] || null };
  }
  function operation(env, ctxRev, brand, id, expected) {
    if (!text(ctxRev) || !text(brand) || !obj(env) || !ref(env.operationId) || !oneOf(env.state, ['prepared', 'confirmed', 'pending', 'uncertain', 'rejected']) || env.contextRevision !== ctxRev || (id !== undefined && env.operationId !== id) || !obj(env.binding)) return false;
    var b = env.binding, found = false;
    for (var i = 0; i < 3; i++) { var k = ['effectiveBrand', 'brandId', 'brand'][i]; if (own(b, k)) { if (b[k] !== brand) return false; found = true; } }
    if (!found || b.contextRevision !== ctxRev || !oneOf(b.kind, kinds) || !(b.recordId === null || ref(b.recordId)) || !(b.expectedRecordRevision === null || rev(b.expectedRecordRevision))) return false;
    return !expected || (b.kind === expected.kind && b.recordId === expected.recordId && b.expectedRecordRevision === expected.expectedRecordRevision);
  }
  // Causal observation is supplied only by the trusted Root journal; this grants no write/send.
  function recovery(before, current) {
    var j = journal(current), ids = j.ids.slice();
    var result = { state: 'blocked', mayClearPreparationUnknown: false, receiptReferences: ids, writeAuthorized: false, sendAuthorized: false, reason: 'Prova causal do journal ainda indisponível.' };
    if (!obj(before) || context(current).error || !ref(before.principalReference) || !text(before.effectiveBrand) || !text(before.sessionRevision) || !text(current.sessionRevision) || !rev(before.journalRevision)) return result;
    if (before.principalReference !== current.principalReference || before.effectiveBrand !== current.effectiveBrand || before.sessionRevision !== current.sessionRevision) { result.reason = 'Observação de outro ator, marca ou sessão.'; return result; }
    if (j.state === 'complete' && j.preparationRecovery === 'quiescent' && j.revision !== before.journalRevision) {
      result.state = 'quiescent'; result.mayClearPreparationUnknown = true; result.reason = null;
    } else if (ids.length) { result.state = 'receipt-only'; result.reason = 'IDs originais disponíveis somente para consulta de recibo.'; }
    return result;
  }
  return Object.freeze({ version: version, reference: ref, revision: rev, civilDate: date, period: period, samePeriod: samePeriod, context: context, filters: filters, envelope: envelope, pending: pending, journal: journal, nextStep: nextStep, operation: operation, recovery: recovery });
});
