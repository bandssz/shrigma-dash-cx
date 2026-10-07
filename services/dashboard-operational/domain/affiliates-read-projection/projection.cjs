'use strict';
// Projeção READ pura de Afiliados (frente C1, fonte apenas) — contrato de saída 1.0.3-proposed.
// Converte a leitura legada existente (POST /api/influ, acao=listar) em ReadEnvelope 1.0.3
// para creators/creator-profile, e um snapshot próprio de tarefas entregue por Root em tasks.
// Sem I/O: nenhum request, callback, env, banco, cache, relógio, credencial ou gravação.
// Identidade do criador em modo EXPLÍCITO escolhido por Root a cada chamada (identityMode):
//  - own_candidate_record: cadastro próprio crm_partner_candidate_v1 (UUID + version literais);
//    provider/providerId ficam null — não é conta social nem indica plataforma conectada;
//  - provider_bound: vínculo persistido provider/providerId entregue por Root (identityBindings).
// Sem modo não há leitura; um modo nunca cai no outro. Nada é inferido de nome, handle, cupom,
// anúncio, mídia ou situação do piloto. Metadados da leitura e tarefas vêm só de entradas de Root.

const NORMALIZER_VERSION = '1.0.3-proposed';
const IDENTITY_MODES = ['own_candidate_record', 'provider_bound'];
const BRANDS = ['aristo', 'fish'];
const LEGACY_RESOURCES = ['creators', 'creator-profile'];
const KNOWN_RESOURCES = ['creators', 'creator-profile', 'samples', 'products', 'content', 'tasks', 'own-performance'];
const SOURCES = ['own_verified', 'own_declared', 'derived', 'market_estimated', 'unknown'];
const COVERAGES = ['complete', 'partial', 'unknown'];
const FRESHNESS = ['fresh', 'stale', 'unknown'];
const SOURCE_KIND = 'crm_partner_candidate_v1';
const PILOT_SCHEMA = 'creator_pilot_v1';
const OBSERVATION_KEYS = ['contextRevision', 'brandId', 'period', 'coverage', 'freshness', 'collectedAt', 'cacheAt'];
const BINDING_KEYS = ['sourceKind', 'sourceRecordId', 'sourceRecordRevision', 'creatorId', 'provider', 'providerId'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Limite da função legada crm_creator_pilot_read_v1 (partner-link.sql:64): até 367 dias civis.
const LEGACY_MAX_SPAN_DAYS = 366;

// Mensagens públicas fixas: nunca ecoam erro bruto, stack, linha de dados ou credencial.
const REASONS = Object.freeze({
  PROJECTION_FAILED: 'Leitura indisponível: a projeção não pôde ser concluída.',
  CONTEXT_INVALID: 'Leitura indisponível: contexto Root ausente ou inválido.',
  BRAND_UNSUPPORTED: 'Leitura indisponível: marca efetiva sem projeção individual admitida.',
  QUERY_INVALID: 'Leitura indisponível: consulta, filtros ou período fora do contrato.',
  CONTEXT_MISMATCH: 'Leitura indisponível: revisão de contexto divergente.',
  RESOURCE_UNSUPPORTED: 'Leitura indisponível: recurso sem fonte própria nesta projeção.',
  TASKS_SOURCE_ABSENT: 'Tarefas indisponíveis: Root ainda não entregou leitura própria de tarefas.',
  PERIOD_UNSUPPORTED: 'Leitura indisponível: período acima do limite da leitura legada.',
  OBSERVATION_INVALID: 'Leitura indisponível: metadados da leitura ausentes ou divergentes.',
  SOURCE_INVALID: 'Leitura indisponível: fonte legada sem janela, marca ou registros íntegros.',
  IDENTITY_MODE_INVALID: 'Leitura indisponível: modo de identidade do criador ausente, desconhecido ou em conflito.',
  BINDING_INVALID: 'Leitura indisponível: vínculo persistido de identidade ausente ou divergente.',
  CREATOR_UNKNOWN: 'Perfil indisponível: criador não encontrado na leitura desta marca.',
  EMPTY_UNPROVEN: 'Leitura indisponível: ausência de registros não confirmada por leitura completa e atual.',
  TASKS_INVALID: 'Tarefas indisponíveis: snapshot próprio sem marca, período ou registros íntegros.',
  TASKS_UNAVAILABLE: 'Tarefas indisponíveis na fonte própria de Root.',
  TASKS_FORBIDDEN: 'Tarefas não autorizadas para este contexto.',
  NORMALIZER_REJECTED: 'Leitura indisponível: resultado recusado pelo normalizador 1.0.3.'
});

const metadata = deepFreeze({
  schema: 'shrigma-affiliates-read-projection-v1',
  contractVersion: '1.1.0-source-proposed',
  normalizerVersion: NORMALIZER_VERSION,
  identityModes: IDENTITY_MODES.slice(),
  sourceOnly: true,
  operational: false,
  readAdmission: false,
  writeAuthorized: false,
  sendAuthorized: false
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && Object.prototype.toString.call(v) === '[object Object]';
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const ref = (v) => text(v) || (Number.isSafeInteger(v) && v >= 0);
const rev = (v) => text(v) || (Number.isSafeInteger(v) && v > 0);
const oneOf = (v, list) => list.indexOf(v) >= 0;
const isoOrNull = (v) => v === null || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)));
const exactKeys = (o, keys) => { const k = Object.keys(o); return k.length === keys.length && keys.every((x) => own(o, x)); };
// Chave conservadora de unicidade: 7 e '7' colidem (fecham), nunca são reunidos.
const uniqueKey = (v) => String(v);

function dense(a) {
  if (!Array.isArray(a)) return false;
  for (let i = 0; i < a.length; i++) if (!own(a, i)) return false; // índice herdado/buraco fecha
  return true;
}

function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.keys(v).forEach((k) => deepFreeze(v[k]));
  }
  return v;
}

function daysBetween(start, end) {
  const ms = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8)) - Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8));
  return ms / 86400000;
}

function closed(code, scope) {
  return deepFreeze({
    state: 'unavailable',
    brandId: scope ? scope.brandId : null,
    contextRevision: scope ? scope.contextRevision : null,
    source: 'unknown', coverage: 'unknown', freshness: 'unknown',
    collectedAt: null, cacheAt: null, data: null, error: REASONS[code]
  });
}

function planClosed(code, scope) {
  return deepFreeze({
    state: 'unavailable', request: null,
    brandId: scope ? scope.brandId : null,
    contextRevision: scope ? scope.contextRevision : null,
    period: null, sourceOnly: true, operational: false, error: REASONS[code]
  });
}

function createProjection(options) {
  const normalizer = isObj(options) ? options.normalizer : null;
  if (!normalizer || typeof normalizer !== 'object' || normalizer.version !== NORMALIZER_VERSION) throw new TypeError('Projeção requer o normalizador Root 1.0.3-proposed injetado.');
  const N = {};
  ['context', 'filters', 'envelope', 'period', 'samePeriod', 'civilDate'].forEach((name) => {
    if (typeof normalizer[name] !== 'function') throw new TypeError('Projeção requer o normalizador Root 1.0.3-proposed injetado.');
    N[name] = normalizer[name];
  });

  // Valida contexto, marca e consulta exata. Retorna {scope} ou {code, scope}.
  function scopeOf(args, allowed) {
    if (!isObj(args)) return { code: 'QUERY_INVALID', scope: null };
    const rawContext = args.context;
    const cc = N.context(rawContext);
    if (!cc || cc.error || !isObj(cc.context)) return { code: 'CONTEXT_INVALID', scope: null };
    const ctx = cc.context;
    const scope = { brandId: ctx.effectiveBrand, contextRevision: ctx.contextRevision };
    if (!oneOf(ctx.effectiveBrand, BRANDS)) return { code: 'BRAND_UNSUPPORTED', scope };
    const query = args.query;
    if (!isObj(query) || !exactKeys(query, ['resource', 'filters', 'expectedContextRevision']) || !oneOf(query.resource, KNOWN_RESOURCES)) return { code: 'QUERY_INVALID', scope };
    if (query.expectedContextRevision !== ctx.contextRevision) return { code: 'CONTEXT_MISMATCH', scope };
    if (!oneOf(query.resource, allowed)) return { code: query.resource === 'tasks' ? 'TASKS_SOURCE_ABSENT' : 'RESOURCE_UNSUPPORTED', scope };
    const ff = N.filters(query.filters, query.resource);
    // A leitura legada exige ini/fim: período civil exato é obrigatório também em creators.
    if (!ff || ff.error || !isObj(ff.filters) || !N.period(ff.filters.period)) return { code: 'QUERY_INVALID', scope };
    const period = { start: ff.filters.period.start, end: ff.filters.period.end };
    return { scope, ctx, rawContext, query, filters: ff.filters, period };
  }

  function validEnvelope(dto, s) {
    const r = N.envelope(dto, s.rawContext, s.query.resource, s.query.filters);
    return !!(r && r.env && !r.error);
  }

  // ---------- planLegacyRead ----------
  function planLegacyRead(args) {
    try {
      const s = scopeOf(args, LEGACY_RESOURCES);
      if (s.code) return planClosed(s.code, s.scope);
      if (daysBetween(s.period.start, s.period.end) > LEGACY_MAX_SPAN_DAYS) return planClosed('PERIOD_UNSUPPORTED', s.scope);
      return deepFreeze({
        state: 'planned',
        request: { route: 'influ', method: 'POST', fields: { acao: 'listar', ini: s.period.start, fim: s.period.end, pilot: true, marca: s.scope.brandId } },
        contextRevision: s.scope.contextRevision,
        brandId: s.scope.brandId,
        period: { start: s.period.start, end: s.period.end },
        sourceOnly: true,
        operational: false
      });
    } catch (_) {
      return planClosed('PROJECTION_FAILED', null);
    }
  }

  // Metadados privados da leitura capturados por Root; nada é sintetizado aqui.
  function observationOf(o, s) {
    if (!isObj(o) || !exactKeys(o, OBSERVATION_KEYS)) return null;
    if (o.contextRevision !== s.scope.contextRevision || o.brandId !== s.scope.brandId || !N.samePeriod(o.period, s.period)) return null;
    if (!oneOf(o.coverage, COVERAGES) || !oneOf(o.freshness, FRESHNESS) || !isoOrNull(o.collectedAt) || !isoOrNull(o.cacheAt)) return null;
    return { coverage: o.coverage, freshness: o.freshness, collectedAt: o.collectedAt, cacheAt: o.cacheAt };
  }

  // Fonte legada: janela e eco do piloto exatos; todos os candidatos legíveis, densos e únicos.
  function candidatesOf(legacy, s) {
    if (!isObj(legacy) || own(legacy, 'erro')) return null;
    const j = legacy.janela, p = legacy.pilot;
    if (!isObj(j) || j.ini !== s.period.start || j.fim !== s.period.end) return null;
    if (!isObj(p) || own(p, 'erro') || p.schema !== PILOT_SCHEMA || p.since !== s.period.start || p.until !== s.period.end) return null;
    const rows = p.candidates;
    if (!dense(rows)) return null;
    const ids = new Set(), out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // UUID igual em caixa diferente é o mesmo cadastro: duplicata fecha (o literal nunca é reescrito).
      if (!isObj(r) || typeof r.id !== 'string' || !UUID.test(r.id) || ids.has(r.id.toLowerCase())) return null;
      if (!text(r.marca) || !text(r.name) || typeof r.handle !== 'string' || !text(r.state) || !Number.isSafeInteger(r.version) || r.version <= 0) return null;
      ids.add(r.id.toLowerCase());
      out.push({ id: r.id, marca: r.marca, name: r.name, handle: r.handle, state: r.state, version: r.version });
    }
    return out;
  }

  // Vínculos persistidos privados de Root: únicos por fonte, creatorId e provider+providerId.
  function bindingsOf(b, s) {
    if (!isObj(b) || !exactKeys(b, ['revision', 'brandId', 'items']) || !rev(b.revision) || b.brandId !== s.scope.brandId || !dense(b.items)) return null;
    const bySource = new Map(), creators = new Set(), accounts = new Set();
    for (let i = 0; i < b.items.length; i++) {
      const x = b.items[i];
      if (!isObj(x) || !exactKeys(x, BINDING_KEYS) || x.sourceKind !== SOURCE_KIND) return null;
      if (typeof x.sourceRecordId !== 'string' || !UUID.test(x.sourceRecordId) || !Number.isSafeInteger(x.sourceRecordRevision) || x.sourceRecordRevision <= 0) return null;
      if (!ref(x.creatorId) || !text(x.provider) || !ref(x.providerId)) return null;
      const account = x.provider + '\u0000' + uniqueKey(x.providerId);
      if (bySource.has(x.sourceRecordId) || creators.has(uniqueKey(x.creatorId)) || accounts.has(account)) return null;
      bySource.set(x.sourceRecordId, x); creators.add(uniqueKey(x.creatorId)); accounts.add(account);
    }
    return bySource;
  }

  function creatorsOf(rows, bySource, brand) {
    const rowById = new Map(rows.map((r) => [r.id, r]));
    // Vínculo deve apontar para linha existente da mesma marca, na mesma revisão.
    for (const [sourceId, x] of bySource) {
      const r = rowById.get(sourceId);
      if (!r || r.marca !== brand || r.version !== x.sourceRecordRevision) return null;
    }
    const items = [];
    for (const r of rows) {
      if (r.marca !== brand) continue; // outra marca: validada acima, nunca retornada
      const x = bySource.get(r.id);
      if (!x) return null; // linha selecionada sem vínculo fecha a coleção inteira
      items.push({
        id: x.creatorId, identityKind: 'provider_bound', provider: x.provider, brandId: brand, providerId: x.providerId,
        displayName: r.name, handle: r.handle === '' ? null : r.handle,
        ownerReference: null, stage: r.state, revision: r.version
      });
    }
    return items;
  }

  // Cadastro próprio: identidade = UUID e version persistidos da linha, literais. Sem conta social.
  function ownCreatorsOf(rows, brand) {
    return rows.filter((r) => r.marca === brand).map((r) => ({
      id: r.id, identityKind: 'own_candidate_record', identitySource: SOURCE_KIND,
      sourceRecordId: r.id, sourceRecordRevision: r.version,
      provider: null, brandId: brand, providerId: null,
      displayName: r.name, handle: r.handle === '' ? null : r.handle,
      ownerReference: null, stage: r.state, revision: r.version
    }));
  }

  // Modo vem somente do argumento explícito de Root; payload, contexto e linhas nunca o escolhem.
  function identityModeOf(args) {
    const mode = args.identityMode;
    if (!oneOf(mode, IDENTITY_MODES)) return null;
    if (mode === 'own_candidate_record' && own(args, 'identityBindings')) return null; // colisão entre modos
    return mode;
  }

  // ---------- projectLegacyRead ----------
  function projectLegacyRead(args) {
    try {
      const s = scopeOf(args, LEGACY_RESOURCES);
      if (s.code) return closed(s.code, s.scope);
      if (daysBetween(s.period.start, s.period.end) > LEGACY_MAX_SPAN_DAYS) return closed('PERIOD_UNSUPPORTED', s.scope);
      const mode = identityModeOf(args);
      if (!mode) return closed('IDENTITY_MODE_INVALID', s.scope);
      const obs = observationOf(args.observation, s);
      if (!obs) return closed('OBSERVATION_INVALID', s.scope);
      const rows = candidatesOf(args.legacy, s);
      if (!rows) return closed('SOURCE_INVALID', s.scope);
      let items;
      if (mode === 'own_candidate_record') {
        items = ownCreatorsOf(rows, s.scope.brandId);
      } else {
        // provider_bound nunca recorre ao cadastro próprio quando o vínculo falta ou diverge.
        const bySource = bindingsOf(args.identityBindings, s);
        if (!bySource) return closed('BINDING_INVALID', s.scope);
        items = creatorsOf(rows, bySource, s.scope.brandId);
        if (!items) return closed('BINDING_INVALID', s.scope);
      }

      const base = {
        brandId: s.scope.brandId, contextRevision: s.scope.contextRevision, source: 'own_declared',
        coverage: obs.coverage, freshness: obs.freshness, collectedAt: obs.collectedAt, cacheAt: obs.cacheAt, error: null
      };
      let dto;
      if (s.query.resource === 'creators') {
        if (items.length === 0 && !(obs.coverage === 'complete' && obs.freshness === 'fresh')) return closed('EMPTY_UNPROVEN', s.scope);
        dto = Object.assign({ state: items.length ? 'ready' : 'empty' }, base, { data: { items } });
      } else {
        const creator = items.filter((c) => c.id === s.filters.creatorId)[0];
        if (!creator) return closed('CREATOR_UNKNOWN', s.scope);
        dto = Object.assign({ state: 'ready' }, base, {
          data: { period: { start: s.period.start, end: s.period.end }, creator, references: { samples: null, products: null, content: null, tasks: null } }
        });
      }
      if (!validEnvelope(dto, s)) return closed('NORMALIZER_REJECTED', s.scope);
      return deepFreeze(dto);
    } catch (_) {
      return closed('PROJECTION_FAILED', null);
    }
  }

  // ---------- projectTaskRead ----------
  // Criadores já projetados (um único modo explícito). Mesmas regras de identidade da saída 1.0.3.
  function creatorKind(c, brand) {
    if (!isObj(c) || !ref(c.id) || c.brandId !== brand || !text(c.displayName) || !rev(c.revision)) return null;
    if (c.identityKind === 'own_candidate_record') {
      const ok = c.identitySource === SOURCE_KIND && typeof c.sourceRecordId === 'string' && UUID.test(c.sourceRecordId) && c.id === c.sourceRecordId &&
        Number.isSafeInteger(c.sourceRecordRevision) && c.sourceRecordRevision > 0 && c.revision === c.sourceRecordRevision &&
        own(c, 'provider') && own(c, 'providerId') && c.provider === null && c.providerId === null;
      return ok ? c.identityKind : null;
    }
    if (c.identityKind === 'provider_bound') {
      const ok = text(c.provider) && ref(c.providerId) && !own(c, 'identitySource') && !own(c, 'sourceRecordId') && !own(c, 'sourceRecordRevision');
      return ok ? c.identityKind : null;
    }
    return null;
  }
  function knownCreatorIds(list, brand) {
    if (!dense(list)) return null;
    const ids = new Map(), kinds = new Set();
    for (let i = 0; i < list.length; i++) {
      const c = list[i], kind = creatorKind(c, brand);
      if (!kind || ids.has(uniqueKey(c.id))) return null;
      kinds.add(kind);
      if (kinds.size > 1) return null; // modos misturados fecham
      ids.set(uniqueKey(c.id), c.id);
    }
    return ids;
  }

  function projectTaskRead(args) {
    try {
      const s = scopeOf(args, ['tasks']);
      if (s.code) return closed(s.code, s.scope);
      const snap = args.snapshot;
      if (snap === null || snap === undefined) return closed('TASKS_SOURCE_ABSENT', s.scope);
      const known = knownCreatorIds(args.knownCreators, s.scope.brandId);
      if (!known) return closed('TASKS_INVALID', s.scope);
      if (!isObj(snap) || !oneOf(snap.state, ['ready', 'empty', 'unavailable', 'forbidden'])) return closed('TASKS_INVALID', s.scope);
      if (snap.brandId !== s.scope.brandId || snap.contextRevision !== s.scope.contextRevision) return closed('TASKS_INVALID', s.scope);
      if (snap.state === 'forbidden') {
        return deepFreeze({ state: 'forbidden', brandId: s.scope.brandId, contextRevision: s.scope.contextRevision, source: 'unknown', coverage: 'unknown', freshness: 'unknown', collectedAt: null, cacheAt: null, data: null, error: REASONS.TASKS_FORBIDDEN });
      }
      if (snap.state === 'unavailable') return closed('TASKS_UNAVAILABLE', s.scope);
      if (!oneOf(snap.source, SOURCES) || !oneOf(snap.coverage, COVERAGES) || !oneOf(snap.freshness, FRESHNESS) || !isoOrNull(snap.collectedAt) || !isoOrNull(snap.cacheAt)) return closed('TASKS_INVALID', s.scope);
      const d = snap.data;
      if (!isObj(d) || !N.samePeriod(d.period, s.period) || !dense(d.items)) return closed('TASKS_INVALID', s.scope);

      const catalog = s.ctx.taskStateCatalog; // normalizado por Root; null quando ausente/malformado
      const seen = new Set(), items = [];
      for (let i = 0; i < d.items.length; i++) {
        const t = d.items[i];
        if (!isObj(t) || !ref(t.id) || seen.has(uniqueKey(t.id))) return closed('TASKS_INVALID', s.scope);
        if (t.brandId !== s.scope.brandId || !ref(t.creatorId) || known.get(uniqueKey(t.creatorId)) !== t.creatorId) return closed('TASKS_INVALID', s.scope);
        if (!text(t.label) || !text(t.state) || !rev(t.revision)) return closed('TASKS_INVALID', s.scope);
        const dueAt = own(t, 'dueAt') ? t.dueAt : null, ownerReference = own(t, 'ownerReference') ? t.ownerReference : null;
        if (!(dueAt === null || N.civilDate(dueAt)) || !(ownerReference === null || typeof ownerReference === 'string')) return closed('TASKS_INVALID', s.scope);
        const rowSource = own(t, 'source') ? t.source : snap.source;
        if (!oneOf(rowSource, SOURCES)) return closed('TASKS_INVALID', s.scope);
        seen.add(uniqueKey(t.id));
        // Flags só do catálogo Root; booleanos brutos do snapshot são ignorados.
        const entry = catalog ? catalog.items.filter((c) => c.value === t.state)[0] : undefined;
        items.push({
          id: t.id, brandId: t.brandId, creatorId: t.creatorId, label: t.label, state: t.state,
          dueAt, ownerReference, revision: t.revision, source: rowSource,
          open: entry ? entry.open : null, terminal: entry ? entry.terminal : null
        });
      }
      let state;
      if (items.length === 0) {
        if (snap.state !== 'empty' || snap.coverage !== 'complete' || snap.freshness !== 'fresh') return closed('EMPTY_UNPROVEN', s.scope);
        state = 'empty';
      } else {
        if (snap.state !== 'ready') return closed('TASKS_INVALID', s.scope);
        state = 'ready';
      }
      const dto = {
        state, brandId: s.scope.brandId, contextRevision: s.scope.contextRevision, source: snap.source,
        coverage: snap.coverage, freshness: snap.freshness, collectedAt: snap.collectedAt, cacheAt: snap.cacheAt,
        data: { period: { start: s.period.start, end: s.period.end }, items }, error: null
      };
      if (!validEnvelope(dto, s)) return closed('NORMALIZER_REJECTED', s.scope);
      return deepFreeze(dto);
    } catch (_) {
      return closed('PROJECTION_FAILED', null);
    }
  }

  return Object.freeze({ planLegacyRead, projectLegacyRead, projectTaskRead });
}

module.exports = Object.freeze({ createProjection, metadata });
