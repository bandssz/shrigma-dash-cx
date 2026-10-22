/*!
 * ShrigmaAffiliatesV2 — CRM próprio de afiliados (frente C1).
 * Contrato: contr/GATEWAY-AFILIADOS-v1.json 1.0.1-proposed (proposed-not-production-admitted).
 * Somente apresentação. O gateway é injetado por Codex Root; este módulo não tem transporte,
 * credencial, armazenamento, cálculo financeiro nem identificador de operação próprio.
 * Os únicos métodos chamados no gateway são: context, read, beginMutation, submit, receipt.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ShrigmaAffiliatesV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONTRACT_VERSION = '1.0.1-proposed';
  var LIST_RESOURCES = ['creators', 'samples', 'products', 'content', 'tasks', 'own-performance'];
  var COLLECTIONS = { creators: 1, samples: 1, products: 1, content: 1, tasks: 1 };
  var READ_STATES = ['ready', 'empty', 'unavailable', 'forbidden'];
  var OP_STATES = ['prepared', 'confirmed', 'pending', 'uncertain', 'rejected'];
  var SOURCE_LABEL = {
    own_verified: 'Própria verificada', own_declared: 'Própria declarada', derived: 'Derivada',
    market_estimated: 'Estimativa de mercado', unknown: 'Origem desconhecida'
  };
  var COVERAGE_LABEL = { complete: 'completa', partial: 'parcial', unknown: 'desconhecida' };
  var FRESHNESS_LABEL = { fresh: 'atual', stale: 'antiga', unknown: 'desconhecida' };
  var RESOURCE_LABEL = {
    creators: 'Criadores', samples: 'Amostras', products: 'Produtos', content: 'Conteúdos',
    tasks: 'Tarefas', 'own-performance': 'Desempenho próprio', 'creator-profile': 'Perfil'
  };

  // Ações = mutationKinds do contrato. Campos espelham resourceFields; o servidor valida tudo.
  var MUTATIONS = {
    'creator.create': {
      title: 'Novo criador', resource: 'creators', record: null,
      fields: [
        { name: 'provider', label: 'Provedor', type: 'text', required: true },
        { name: 'providerId', label: 'ID persistido no provedor', type: 'text', required: true },
        { name: 'displayName', label: 'Nome', type: 'text', required: true },
        { name: 'handle', label: '@handle', type: 'text' },
        { name: 'ownerReference', label: 'Responsável', type: 'text' },
        { name: 'stage', label: 'Etapa', type: 'stage' }
      ],
      warn: 'Identidade = provedor + marca efetiva + ID persistido no provedor. O @handle sozinho não une contas.'
    },
    'creator.update': {
      title: 'Editar criador', resource: 'creators', record: 'creator',
      fields: [
        { name: 'displayName', label: 'Nome', type: 'text', required: true },
        { name: 'handle', label: '@handle', type: 'text' },
        { name: 'ownerReference', label: 'Responsável', type: 'text' },
        { name: 'stage', label: 'Etapa', type: 'stage' }
      ]
    },
    'creator.archive': {
      title: 'Arquivar criador', resource: 'creators', record: 'creator', fields: [],
      warn: 'O servidor decide e registra o arquivamento. Nada é apagado por esta tela.'
    },
    'sample.record-manual': {
      title: 'Registrar amostra manual', resource: 'samples', record: null, scoped: true,
      fields: [
        { name: 'sku', label: 'SKU', type: 'sku', required: true },
        { name: 'manualStatus', label: 'Status manual', type: 'text', required: true },
        { name: 'dueAt', label: 'Prazo', type: 'date' }
      ],
      warn: 'Registro manual próprio. Não confirma envio, aprovação ou amostra no TikTok.'
    },
    'sample.update-manual': {
      title: 'Atualizar amostra manual', resource: 'samples', record: 'sample',
      fields: [
        { name: 'manualStatus', label: 'Status manual', type: 'text', required: true },
        { name: 'dueAt', label: 'Prazo', type: 'date' }
      ],
      warn: 'Registro manual próprio. Não confirma envio, aprovação ou amostra no TikTok.'
    },
    'task.create': {
      title: 'Nova tarefa', resource: 'tasks', record: null, scoped: true,
      fields: [
        { name: 'label', label: 'Próximo passo', type: 'text', required: true },
        { name: 'dueAt', label: 'Prazo', type: 'date' },
        { name: 'ownerReference', label: 'Responsável', type: 'text' }
      ]
    },
    'task.update': {
      title: 'Editar tarefa', resource: 'tasks', record: 'task',
      fields: [
        { name: 'label', label: 'Próximo passo', type: 'text', required: true },
        { name: 'state', label: 'Situação', type: 'task-state' },
        { name: 'dueAt', label: 'Prazo', type: 'date' },
        { name: 'ownerReference', label: 'Responsável', type: 'text' }
      ]
    },
    'content.record-manual': {
      title: 'Registrar conteúdo manual', resource: 'content', record: null, scoped: true,
      fields: [
        { name: 'provider', label: 'Provedor', type: 'text', required: true },
        { name: 'kind', label: 'Tipo', type: 'text', required: true },
        { name: 'url', label: 'Endereço (https)', type: 'url' },
        { name: 'publishedAt', label: 'Publicado em', type: 'date' }
      ],
      warn: 'Registro manual próprio. Métricas não são inferidas.'
    },
    'content.update-manual': {
      title: 'Editar conteúdo manual', resource: 'content', record: 'content',
      fields: [
        { name: 'kind', label: 'Tipo', type: 'text', required: true },
        { name: 'url', label: 'Endereço (https)', type: 'url' },
        { name: 'publishedAt', label: 'Publicado em', type: 'date' }
      ]
    }
  };
  var RECORD_RESOURCE = { creator: 'creators', sample: 'samples', task: 'tasks', content: 'content' };

  // ---------------------------------------------------------------- utilidades puras
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function hasId(v) { return (typeof v === 'string' && v !== '') || (typeof v === 'number' && isFinite(v)); }
  function str(v) { return v == null ? '' : String(v); }
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function enumOr(v, map) { return Object.prototype.hasOwnProperty.call(map, v) ? v : 'unknown'; }
  function fmtDate(v) {
    if (v == null || v === '') return null;
    var s = String(v);
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return m[3] + '/' + m[2] + '/' + m[1];
    var d = new Date(s);
    if (isNaN(d.getTime())) return 'data inválida';
    try {
      return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
    } catch (_) { return s; }
  }
  function dateInputValue(v) { var s = str(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; }
  // Formatação de unidade menor. Não soma, não converte moeda, não calcula taxa.
  function fmtMinor(minor, currency) {
    if (minor === undefined || minor === null) return { kind: 'missing', text: 'Indisponível' };
    if (typeof minor !== 'number' || !Number.isInteger(minor)) return { kind: 'malformed', text: 'Valor malformado — não exibido' };
    if (typeof currency !== 'string' || !currency) return { kind: 'nocurrency', text: 'Moeda não informada — valor não exibido' };
    try {
      var nf = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency });
      var digits = nf.resolvedOptions().maximumFractionDigits;
      return { kind: 'ok', text: nf.format(minor / Math.pow(10, digits)) };
    } catch (_) { return { kind: 'nocurrency', text: 'Moeda inválida — valor não exibido' }; }
  }
  function periodText(p) {
    if (p == null || p === '') return null;
    if (typeof p === 'string') return p;
    if (isObj(p) && (p.start || p.end)) return (fmtDate(p.start) || '…') + ' a ' + (fmtDate(p.end) || '…');
    return null;
  }
  function safeHttpUrl(u) { return typeof u === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null; }
  function capability(ctx, kind) {
    var caps = ctx && ctx.capabilities;
    if (!isObj(caps)) return { available: false, reason: 'Capacidades não informadas pelo servidor.' };
    var c = caps[kind];
    if (c === true) return { available: true };
    if (isObj(c) && c.available === true) return { available: true };
    if (c === undefined) return { available: false, reason: 'Capacidade não informada pelo servidor para esta ação.' };
    return { available: false, reason: (isObj(c) && typeof c.reason === 'string' && c.reason) || 'Capacidade indisponível para esta marca/papel.' };
  }
  function pendingIds(ctx) {
    var p = ctx && ctx.pendingOperations;
    if (p === undefined || p === null) return { ids: [], unreadable: true };
    if (!Array.isArray(p)) return { ids: [], unreadable: true };
    var ids = [], unreadable = false;
    for (var i = 0; i < p.length; i++) {
      var x = p[i];
      if (hasId(x)) ids.push(String(x));
      else if (isObj(x) && hasId(x.operationId)) ids.push(String(x.operationId));
      else unreadable = true;
    }
    return { ids: ids, unreadable: unreadable };
  }
  function validateContext(c) {
    if (!isObj(c)) return 'Contexto ausente ou malformado.';
    if (!hasId(c.contextRevision)) return 'Contexto sem revisão (contextRevision).';
    if (!hasId(c.effectiveBrand)) return 'Contexto sem marca efetiva.';
    if (!hasId(c.principalReference)) return 'Contexto sem referência do ator.';
    if (typeof c.role !== 'string' || !c.role) return 'Contexto sem papel.';
    return null;
  }
  function validOperationEnvelope(env, contextRevision, brand, operationId) {
    if (!isObj(env) || !hasId(env.operationId) || OP_STATES.indexOf(env.state) < 0 || env.contextRevision !== contextRevision) return false;
    if (operationId !== undefined && String(env.operationId) !== operationId) return false;
    if (!isObj(env.binding)) return false;
    var foundBrand = false;
    for (var i = 0; i < 3; i++) {
      var field = ['effectiveBrand', 'brandId', 'brand'][i];
      if (Object.prototype.hasOwnProperty.call(env.binding, field)) {
        if (env.binding[field] !== brand) return false;
        foundBrand = true;
      }
    }
    return foundBrand;
  }
  // Valida o envelope do contrato. Malformado/divergente vira erro explícito, nunca zero.
  function validateEnvelope(env, ctx, resource, opts) {
    if (!isObj(env)) return { error: 'Resposta malformada (envelope ausente).' };
    if (READ_STATES.indexOf(env.state) < 0) return { error: 'Resposta malformada (estado desconhecido).' };
    // Recusa sempre limpa (direção segura), mesmo com revisão nova; respostas de geração antiga já foram descartadas.
    if (env.state === 'forbidden') return { env: { state: 'forbidden', error: str(env.error) } };
    if (env.contextRevision !== ctx.contextRevision) return { error: 'Resposta de outro contexto descartada.', discarded: true };
    if (env.brandId !== ctx.effectiveBrand) return { error: 'Resposta de outra marca descartada.', discarded: true };
    var out = {
      state: env.state, brandId: env.brandId, contextRevision: env.contextRevision,
      source: enumOr(env.source, SOURCE_LABEL), coverage: enumOr(env.coverage, COVERAGE_LABEL),
      freshness: enumOr(env.freshness, FRESHNESS_LABEL), collectedAt: env.collectedAt == null ? null : env.collectedAt,
      cacheAt: env.cacheAt == null ? null : env.cacheAt, error: env.error == null ? null : str(env.error),
      data: null, items: null, malformed: 0, refreshFailed: false
    };
    if (env.state === 'unavailable') return { env: out };
    var data = env.data;
    if (COLLECTIONS[resource]) {
      if (env.state === 'empty') {
        if (data != null && !(isObj(data) && (data.items === undefined || (Array.isArray(data.items) && data.items.length === 0))))
          return { error: 'Resposta malformada (vazio com itens).' };
        out.items = []; out.data = isObj(data) ? data : null; return { env: out };
      }
      if (!isObj(data) || !Array.isArray(data.items)) return { error: 'Resposta malformada (coleção sem itens).' };
      var items = [];
      for (var i = 0; i < data.items.length; i++) {
        var it = data.items[i];
        if (!isObj(it) || !hasId(it.id)) { out.malformed++; continue; }
        if (resource === 'creators' && it.brandId !== ctx.effectiveBrand) return { error: 'Criador de outra marca na resposta — leitura descartada.', discarded: true };
        items.push(it);
      }
      out.items = items; out.data = data;
      if (out.malformed > 0 && out.coverage === 'complete') out.coverage = 'partial';
      return { env: out };
    }
    if (env.state === 'empty') { out.data = isObj(data) ? data : null; return { env: out }; }
    if (!isObj(data)) return { error: 'Resposta malformada (dados ausentes).' };
    if (resource === 'creator-profile') {
      var creator = isObj(data.creator) ? data.creator : data;
      if (!hasId(creator.id) || (opts && String(creator.id) !== String(opts.creatorId))) return { error: 'Perfil malformado ou de outro criador.' };
      if (creator.brandId !== undefined && creator.brandId !== ctx.effectiveBrand) return { error: 'Perfil de outra marca descartado.', discarded: true };
      out.data = data; out.creator = creator; return { env: out };
    }
    out.data = data; return { env: out };
  }
  function usable(env) { return !!env && (env.state === 'ready' || env.state === 'empty') && Array.isArray(env.items || []); }
  function writable(env) {
    if (!env) return 'Fonte ainda não carregada.';
    if (env.state === 'unavailable') return 'Fonte indisponível.';
    if (env.state !== 'ready' && env.state !== 'empty') return 'Fonte sem leitura válida.';
    if (env.refreshFailed) return 'A última leitura falhou; dados anteriores são somente leitura.';
    if (env.freshness !== 'fresh') return 'Fonte antiga ou com frescor desconhecido; somente leitura.';
    if (env.coverage !== 'complete') return 'Fonte parcial ou com cobertura desconhecida; somente leitura.';
    return null;
  }

  // ---------------------------------------------------------------- fábrica
  function create(options) {
    var element = options && options.element, doc = options && options.document, gateway = options && options.gateway;
    if (!element || !doc || typeof doc.createElement !== 'function') throw new TypeError('ShrigmaAffiliatesV2.create requer {element, document, gateway}.');
    if (!gateway || typeof gateway.context !== 'function' || typeof gateway.read !== 'function') throw new TypeError('Gateway sem context/read do contrato ' + CONTRACT_VERSION + '.');
    var canWrite = typeof gateway.beginMutation === 'function' && typeof gateway.submit === 'function' && typeof gateway.receipt === 'function';

    var S = {
      disposed: false, generation: 0, inflight: null, abort: null,
      filters: {}, filtersKey: stable({}), loading: false,
      ctx: null, ctxError: null, scopeKey: null, revoked: null,
      envs: {}, profile: null,
      view: 'table', ui: { search: '', stage: '', owner: '', provider: '' },
      drafts: new Map(), form: null, ops: new Map(), opOrder: [], resolved: new Set(),
      busy: false, prepareUnknown: false, receiptBusy: new Set(), notices: [], focusKey: null
    };

    var rootEl = doc.createElement('div');
    rootEl.setAttribute('class', 'saf2');
    rootEl.setAttribute('data-saf2-root', '');
    element.appendChild(rootEl);

    function makeAbort() {
      var AC = (doc.defaultView && doc.defaultView.AbortController) || (typeof AbortController !== 'undefined' ? AbortController : null);
      return AC ? new AC() : null;
    }
    function notice(text, tone) { S.notices = [{ text: text, tone: tone || 'info' }]; }

    // -------------------------------------------------------------- contexto e escopo
    // keepProfile: troca de período/filtro mantém o perfil aberto, mas sem nenhum dado do período anterior.
    function clearProjection(keepProfile) {
      S.envs = {};
      S.profile = keepProfile && S.profile ? { creatorId: S.profile.creatorId, token: {}, env: null, perf: null, loading: true } : null;
    }
    function clearScope() {
      clearProjection(); S.drafts.clear(); S.form = null; S.ops.clear(); S.opOrder = []; S.resolved.clear();
      S.prepareUnknown = false; S.busy = false; S.ui = { search: '', stage: '', owner: '', provider: '' };
    }
    function applyContext(ctx, gen) {
      var key = [ctx.principalReference, ctx.effectiveBrand, ctx.sessionRevision == null ? '' : ctx.sessionRevision].map(str).join('\u0001');
      if (S.scopeKey !== null && S.scopeKey !== key) clearScope();
      S.scopeKey = key; S.ctx = ctx; S.ctxError = null; S.revoked = null; S.notices = [];
      // Pendências do journal de Root viram operações a conferir por recibo; nada é persistido aqui.
      var pend = pendingIds(ctx), listed = {};
      pend.ids.forEach(function (id) {
        listed[id] = 1;
        if (!S.ops.has(id) && !S.resolved.has(id)) track({ operationId: id, kind: null, state: 'pending', origin: 'server' });
      });
      if (!pend.unreadable) {
        S.ops.forEach(function (op, id) {
          if (op.origin === 'server' && op.state === 'pending' && !listed[id]) { S.ops.delete(id); S.opOrder = S.opOrder.filter(function (x) { return x !== id; }); }
        });
        // Preparação sem resposta só é liberada por um contexto lido DEPOIS dela (o journal de Root já a mostraria).
        if (S.prepareUnknown && gen > S.prepareUnknownGen) S.prepareUnknown = false;
      }
    }
    function revoke(reason) {
      clearScope(); S.ctx = null; S.scopeKey = null;
      S.revoked = reason || 'Acesso recusado pelo servidor.';
      notice('Acesso recusado: os dados desta área foram removidos da tela e as ações foram fechadas.', 'bad');
    }

    // -------------------------------------------------------------- sync
    function sync(opts) {
      if (S.disposed) return Promise.resolve();
      var filters = opts && isObj(opts.filters) ? opts.filters : S.filters;
      startSync(filters, false);
      return S.inflight ? S.inflight.voided : Promise.resolve();
    }
    function startSync(filters, force) {
      var key = stable(filters);
      if (!force && S.inflight && S.inflight.key === key) return S.inflight.promise;
      var gen = ++S.generation;
      if (S.abort) { try { S.abort.abort(); } catch (_) {} }
      S.abort = makeAbort();
      if (key !== S.filtersKey) clearProjection(true); // não misturar períodos/filtros
      S.filters = filters; S.filtersKey = key; S.loading = true; render();
      var signal = S.abort ? S.abort.signal : undefined;
      var p = run(gen, filters, signal).then(function (ok) {
        if (S.inflight && S.inflight.gen === gen) S.inflight = null;
        return ok;
      });
      S.inflight = { key: key, gen: gen, promise: p, voided: p.then(function () {}) };
      return p;
    }
    function stale(gen) { return S.disposed || gen !== S.generation; }
    function run(gen, filters, signal) {
      var ctx;
      return Promise.resolve().then(function () { return gateway.context(); }).then(function (c) { ctx = c; }, function (e) { ctx = { __error: e }; })
        .then(function () {
          if (stale(gen)) return false;
          if (ctx && ctx.__error) {
            clearProjection(); S.ctx = null; S.loading = false;
            S.ctxError = 'Não foi possível confirmar sessão, marca e papel. Dados retirados da tela; nada foi interpretado como zero.';
            render(); return false;
          }
          var bad = validateContext(ctx);
          if (bad) { clearScope(); S.ctx = null; S.scopeKey = null; S.ctxError = bad; S.loading = false; render(); return false; }
          applyContext(ctx, gen); render();
          return Promise.all(LIST_RESOURCES.map(function (r) { return readOne(r, filters, ctx, signal); }))
            .then(function (results) {
              if (stale(gen)) return false;
              var ok = true, forbidden = null;
              results.forEach(function (res) {
                if (res.env && res.env.state === 'forbidden') forbidden = forbidden || res.env.error || 'Acesso recusado.';
              });
              if (forbidden) { revoke(forbidden); S.loading = false; render(); return false; }
              results.forEach(function (res) {
                if (res.env) { S.envs[res.resource] = res.env; return; }
                ok = false;
                var prev = S.envs[res.resource];
                if (prev && prev.state !== 'error' && prev.contextRevision !== undefined) {
                  prev.refreshFailed = true; prev.refreshError = res.error;
                } else S.envs[res.resource] = { state: 'error', error: res.error };
              });
              S.loading = false; render();
              if (S.profile) return loadProfile(gen, S.profile.creatorId).then(function (p) { return ok && p; });
              return ok;
            });
        });
    }
    function readOne(resource, filters, ctx, signal, extra) {
      var f = {}; Object.keys(filters || {}).forEach(function (k) { f[k] = filters[k]; });
      if (extra) Object.keys(extra).forEach(function (k) { f[k] = extra[k]; });
      return Promise.resolve().then(function () {
        return gateway.read({ resource: resource, filters: f, expectedContextRevision: ctx.contextRevision }, signal ? { signal: signal } : {});
      }).then(function (env) {
        var v = validateEnvelope(env, ctx, resource, extra);
        return v.env ? { resource: resource, env: v.env } : { resource: resource, error: v.error };
      }, function (e) {
        var msg = isObj(e) && typeof e.message === 'string' && e.name !== 'AbortError' ? e.message : 'Leitura não concluída.';
        return { resource: resource, error: 'Erro na leitura: ' + msg };
      });
    }
    function loadProfile(gen, creatorId) {
      var ctx = S.ctx; if (!ctx) return Promise.resolve(false);
      var token = {}; S.profile = { creatorId: creatorId, token: token, env: S.profile && S.profile.creatorId === creatorId ? S.profile.env : null, perf: S.profile && S.profile.creatorId === creatorId ? S.profile.perf : null, loading: true };
      render();
      var signal = S.abort ? S.abort.signal : undefined;
      return Promise.all([
        readOne('creator-profile', S.filters, ctx, signal, { creatorId: creatorId }),
        readOne('own-performance', S.filters, ctx, signal, { creatorId: creatorId })
      ]).then(function (r) {
        if (stale(gen) || !S.profile || S.profile.token !== token) return false;
        var forbidden = r.filter(function (x) { return x.env && x.env.state === 'forbidden'; })[0];
        if (forbidden) { revoke(forbidden.env.error); render(); return false; }
        S.profile.env = r[0].env || { state: 'error', error: r[0].error };
        S.profile.perf = r[1].env || { state: 'error', error: r[1].error };
        S.profile.loading = false; render();
        return !!(r[0].env && r[1].env);
      });
    }

    // -------------------------------------------------------------- operações
    function track(op) {
      if (!S.ops.has(op.operationId)) S.opOrder.push(op.operationId);
      S.ops.set(op.operationId, Object.assign(S.ops.get(op.operationId) || {}, op));
      return S.ops.get(op.operationId);
    }
    function unresolved() {
      var list = [];
      S.ops.forEach(function (op) { if (op.state === 'pending' || op.state === 'uncertain' || op.state === 'prepared' || op.state === 'submitting') list.push(op); });
      return list;
    }
    function recordOf(kind, id) {
      var spec = MUTATIONS[kind]; if (!spec || !spec.record) return null;
      var env = S.envs[RECORD_RESOURCE[spec.record]];
      if (!env || !env.items) return null;
      for (var i = 0; i < env.items.length; i++) if (String(env.items[i].id) === String(id)) return env.items[i];
      return null;
    }
    function creatorById(id) {
      var env = S.envs.creators; if (!env || !env.items) return null;
      for (var i = 0; i < env.items.length; i++) if (String(env.items[i].id) === String(id)) return env.items[i];
      return null;
    }
    function gate(kind, recordId, creatorId) {
      var reasons = [], spec = MUTATIONS[kind], ctx = S.ctx;
      if (S.disposed || !ctx) return { open: false, reasons: ['Contexto não confirmado.'] };
      if (!canWrite) reasons.push('Adapter de escrita do integrador não instalado.');
      if (ctx.role !== 'write' && ctx.role !== 'master') reasons.push('Papel sem escrita (' + ctx.role + ').');
      var cap = capability(ctx, kind); if (!cap.available) reasons.push(cap.reason);
      var w = writable(S.envs[spec.resource]); if (w) reasons.push(RESOURCE_LABEL[spec.resource] + ': ' + w);
      if (spec.resource !== 'creators' && (spec.scoped || spec.record)) { var wc = writable(S.envs.creators); if (wc) reasons.push('Criadores: ' + wc); }
      if (spec.record) {
        var rec = recordOf(kind, recordId);
        if (!rec) reasons.push('Registro não encontrado na leitura atual.');
        else if (!hasId(rec.revision)) reasons.push('Registro sem revisão; o servidor não pode conferir a versão.');
      }
      if (spec.scoped && !creatorById(creatorId)) reasons.push('Criador não encontrado na leitura atual.');
      var pend = pendingIds(ctx);
      if (pend.unreadable) reasons.push('Pendências do servidor indisponíveis ou ilegíveis; peça conciliação ao integrador.');
      if (unresolved().length || S.prepareUnknown) reasons.push('Há operação sem resultado confirmado. Consulte o recibo antes de outra gravação.');
      if (S.busy) reasons.push('Outra operação em andamento.');
      return { open: reasons.length === 0, reasons: reasons };
    }
    function draftFor(form) {
      var d = S.drafts.get(form.key);
      if (d) return d;
      var spec = MUTATIONS[form.kind], rec = spec.record ? recordOf(form.kind, form.recordId) : null, values = {};
      fieldsOf(form).forEach(function (f) { values[f.name] = rec ? (f.type === 'date' ? dateInputValue(rec[f.name]) : str(rec[f.name])) : ''; });
      d = { values: values, base: Object.assign({}, values), dirty: false };
      S.drafts.set(form.key, d);
      return d;
    }
    function fieldsOf(form) {
      var spec = MUTATIONS[form.kind];
      if (form.variant === 'move') return spec.fields.filter(function (f) { return f.name === 'stage'; });
      return spec.fields;
    }
    function buildPayload(form) {
      var spec = MUTATIONS[form.kind], d = draftFor(form), payload = {}, errors = [];
      fieldsOf(form).forEach(function (f) {
        var v = str(d.values[f.name]).trim();
        if (f.required && !v) errors.push(f.label + ' é obrigatório.');
        if (v && f.type === 'url' && !safeHttpUrl(v)) errors.push(f.label + ': use um endereço http(s) válido.');
        if (v && f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(f.label + ': data inválida.');
        if (spec.record) { if (v !== str(d.base[f.name]).trim()) payload[f.name] = v === '' ? null : v; }
        else if (v) payload[f.name] = v;
      });
      if (spec.scoped) payload.creatorId = form.creatorId;
      if (spec.record && form.kind !== 'creator.archive' && Object.keys(payload).length === 0) errors.push('Nenhuma alteração para registrar.');
      return { payload: payload, errors: errors };
    }
    function opDone(op, res) {
      op.state = res.state; op.receiptReference = res.receiptReference == null ? null : res.receiptReference;
      op.reason = res.reason == null ? null : str(res.reason);
      if (res.state === 'confirmed' || res.state === 'rejected') S.resolved.add(op.operationId);
    }
    function mutate(form) {
      var spec = MUTATIONS[form.kind], g = gate(form.kind, form.recordId, form.creatorId);
      if (!g.open) { form.error = g.reasons.join(' '); render(); return Promise.resolve(); }
      var built = buildPayload(form);
      if (built.errors.length) { form.error = built.errors.join(' '); form.mode = 'edit'; render(); return Promise.resolve(); }
      var rec = spec.record ? recordOf(form.kind, form.recordId) : null;
      var ctxRev = S.ctx.contextRevision, brand = S.ctx.effectiveBrand, scope = S.scopeKey, op = null;
      var intent = { kind: form.kind, payload: built.payload, expectedContextRevision: ctxRev };
      if (rec) { intent.recordId = rec.id; intent.expectedRecordRevision = rec.revision; }
      function outOfScope() { return S.disposed || S.scopeKey !== scope; }
      S.busy = true; form.mode = 'busy'; form.error = null; render();
      return Promise.resolve().then(function () { return gateway.beginMutation(intent); }).then(function (prep) {
        if (outOfScope()) return;
        if (!validOperationEnvelope(prep, ctxRev, brand)) throw { prepareUnknown: true };
        op = track({ operationId: String(prep.operationId), kind: form.kind, recordId: rec ? rec.id : null, state: prep.state === 'prepared' ? 'submitting' : prep.state, origin: 'local', formKey: form.key });
        if (!S.ctx || S.ctx.contextRevision !== ctxRev) { op.state = 'uncertain'; op.reason = 'Contexto mudou após a preparação; consulte o recibo da mesma operação.'; return; }
        if (prep.state === 'rejected') { opDone(op, prep); return; }
        if (prep.state !== 'prepared') { opDone(op, prep); if (prep.state === 'confirmed') return afterConfirmed(op, form); return; }
        return Promise.resolve().then(function () {
          if (outOfScope()) return;
          if (!S.ctx || S.ctx.contextRevision !== ctxRev) { op.state = 'uncertain'; op.reason = 'Contexto mudou antes da submissão; consulte o recibo da mesma operação.'; return; }
          return gateway.submit({ operationId: prep.operationId, expectedContextRevision: ctxRev });
        })
          .then(function (res) {
            if (outOfScope()) return;
            if (!S.ctx || S.ctx.contextRevision !== ctxRev) { op.state = 'uncertain'; op.reason = 'Resposta chegou após mudança de contexto; consulte o recibo.'; return; }
            if (!validOperationEnvelope(res, ctxRev, brand, op.operationId)) { op.state = 'uncertain'; op.reason = 'Resposta sem vínculo válido com a marca, contexto e operação original. Consulte o mesmo recibo.'; return; }
            opDone(op, res);
            if (res.state === 'prepared') op.state = 'uncertain';
            if (res.state === 'confirmed') return afterConfirmed(op, form);
          }, function () {
            if (outOfScope()) return;
            op.state = 'uncertain'; op.reason = 'Sem resposta do servidor. Não repita: consulte o recibo da mesma operação.';
          });
      }).then(null, function (e) {
        if (outOfScope()) return;
        if (!op) { S.prepareUnknown = true; S.prepareUnknownGen = S.generation; notice('A preparação não teve resposta legível. Nada foi submetido por esta tela. Atualize a leitura para ver as operações pendentes do servidor antes de tentar de novo.', 'warn'); }
        else if (op.state === 'submitting') op.state = 'uncertain';
      }).then(function () {
        if (outOfScope()) return;
        S.busy = false;
        if (op && op.state === 'rejected') { form.mode = 'edit'; form.error = 'Recusada pelo servidor: ' + (op.reason || 'sem motivo público.'); }
        else if (op && op.state !== 'confirmed') { form.mode = 'waiting'; form.opId = op.operationId; }
        else if (!op) form.mode = 'edit';
        S.focusKey = 'status'; render();
      });
    }
    function afterConfirmed(op, form) {
      S.drafts.delete(op.formKey || (form && form.key));
      if (S.form && form && S.form.key === form.key) S.form = null;
      op.refresh = 'running'; render();
      return startSync(S.filters, true).then(function (ok) {
        if (S.disposed || !S.ops.has(op.operationId)) return;
        op.refresh = ok ? 'done' : 'pending'; render();
      });
    }
    function consultReceipt(opId) {
      var op = S.ops.get(opId); if (!op || !S.ctx || !canWrite || S.receiptBusy.has(opId)) return Promise.resolve();
      var scope = S.scopeKey, ctxRev = S.ctx.contextRevision, brand = S.ctx.effectiveBrand; S.receiptBusy.add(opId); render();
      return Promise.resolve().then(function () {
        if (S.disposed || S.scopeKey !== scope || !S.ctx || S.ctx.contextRevision !== ctxRev) return;
        return gateway.receipt({ operationId: op.operationId, expectedContextRevision: ctxRev });
      })
        .then(function (res) {
          if (S.disposed || S.scopeKey !== scope) return;
          if (!S.ctx || S.ctx.contextRevision !== ctxRev || !validOperationEnvelope(res, ctxRev, brand, op.operationId)) { op.reason = 'Recibo sem vínculo válido com a marca, contexto e operação original; a operação continua pendente.'; return; }
          if (res.state === 'confirmed' || res.state === 'rejected') {
            opDone(op, res);
            if (S.form && S.form.opId === opId) { if (res.state === 'rejected') { S.form.mode = 'edit'; S.form.error = 'Recusada pelo servidor: ' + (op.reason || 'sem motivo público.'); } else S.form = null; }
            if (res.state === 'confirmed') return afterConfirmed(op, null);
          } else { op.reason = 'Ainda sem resultado final no servidor. Nada foi reenviado.'; }
        }, function () {
          if (S.disposed || S.scopeKey !== scope) return;
          op.reason = 'Não foi possível consultar o recibo agora. Nada foi reenviado.';
        }).then(function () { S.receiptBusy.delete(opId); if (!S.disposed) { S.focusKey = 'status'; render(); } });
    }

    // -------------------------------------------------------------- DOM
    function h(tag, attrs) {
      var el = doc.createElement(tag), value, kids = Array.prototype.slice.call(arguments, 2);
      if (attrs) Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') el.textContent = String(v);
        else if (k === 'value') value = String(v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
      (function add(list) {
        list.forEach(function (c) {
          if (c === null || c === undefined || c === false) return;
          if (Array.isArray(c)) add(c);
          else if (typeof c === 'string' || typeof c === 'number') el.appendChild(doc.createTextNode(String(c)));
          else el.appendChild(c);
        });
      })(kids);
      if (value !== undefined) el.value = value;
      return el;
    }
    function select(attrs, options, current) {
      var el = h('select', attrs, options.map(function (o) {
        return h('option', { value: o.value, selected: String(o.value) === String(current) ? true : null, text: o.label });
      }));
      el.value = str(current);
      return el;
    }
    function tag(text, tone, title) { return h('span', { class: 'saf2-tag saf2-tag--' + (tone || 'neutral'), title: title || null, text: text }); }
    function gatedButton(label, act, data, g) {
      var attrs = { type: 'button', class: 'saf2-btn', 'data-saf2-act': act, 'data-saf2-key': act + ':' + stable(data), disabled: !g.open, title: g.open ? null : g.reasons.join(' ') };
      Object.keys(data).forEach(function (k) { attrs['data-' + k] = data[k]; });
      return h('button', attrs, label);
    }
    function reasonsLine(gates) {
      var seen = {}, list = [];
      gates.forEach(function (g) { if (!g.open) g.reasons.forEach(function (r) { if (!seen[r]) { seen[r] = 1; list.push(r); } }); });
      return list.length ? h('p', { class: 'saf2-closed' }, h('strong', { text: 'Ações fechadas: ' }), list.join(' ')) : null;
    }
    function sourceLine(env, resource) {
      if (!env || env.state === 'error' || env.state === 'forbidden') return null;
      var bits = [
        h('span', { text: 'Origem: ' + SOURCE_LABEL[env.source] }),
        h('span', { text: 'Marca: ' + str(env.brandId) }),
        h('span', { text: 'Cobertura: ' + COVERAGE_LABEL[env.coverage] }),
        h('span', { text: 'Frescor: ' + FRESHNESS_LABEL[env.freshness] }),
        h('span', { text: 'Coletado: ' + (fmtDate(env.collectedAt) || 'não informado') }),
        env.cacheAt ? h('span', { text: 'Cache: ' + fmtDate(env.cacheAt) }) : null
      ];
      var per = periodText(S.filters.period); if (per) bits.push(h('span', { text: 'Período: ' + per }));
      var tags = [];
      if (env.coverage === 'partial') tags.push(tag('Coleta parcial — não é o universo completo', 'warn'));
      if (env.coverage === 'unknown') tags.push(tag('Cobertura desconhecida', 'warn'));
      if (env.freshness === 'stale') tags.push(tag('Dados antigos — somente leitura', 'warn'));
      if (env.refreshFailed) tags.push(tag('Última atualização falhou — leitura anterior, somente leitura', 'bad', env.refreshError));
      if (env.malformed) tags.push(tag(env.malformed + ' registro(s) malformado(s) omitido(s)', 'bad'));
      if (resource === 'creators' && env.data && env.data.completeness != null && typeof env.data.completeness !== 'object') tags.push(tag('Completude: ' + str(env.data.completeness), 'neutral'));
      return h('div', { class: 'saf2-source', 'data-saf2-source': resource }, bits, tags);
    }
    function stateBlock(env, resource) {
      var label = RESOURCE_LABEL[resource];
      if (!env) return S.loading || (S.profile && S.profile.loading) ? h('p', { class: 'saf2-state', 'data-saf2-state': 'loading', 'aria-busy': 'true', text: 'Carregando ' + label.toLowerCase() + '…' }) : h('p', { class: 'saf2-state', 'data-saf2-state': 'idle', text: label + ': ainda não lido.' });
      if (env.state === 'error') return h('p', { class: 'saf2-state saf2-state--bad', 'data-saf2-state': 'error', text: label + ': ' + env.error + ' Nada foi interpretado como zero.' });
      if (env.state === 'unavailable') return h('p', { class: 'saf2-state saf2-state--warn', 'data-saf2-state': 'unavailable', text: label + ': fonte indisponível' + (env.error ? ' (' + env.error + ')' : '') + '. Nada foi interpretado como zero.' });
      if (env.state === 'empty' || (env.items && env.items.length === 0 && !env.malformed)) {
        var confirmed = env.coverage === 'complete' && env.freshness === 'fresh' && !env.refreshFailed;
        return confirmed
          ? h('p', { class: 'saf2-state', 'data-saf2-state': 'empty-confirmed', text: label + ': nenhum registro (vazio confirmado pela fonte).' })
          : h('p', { class: 'saf2-state saf2-state--warn', 'data-saf2-state': 'empty-unconfirmed', text: label + ': nenhum registro nesta leitura ' + (env.freshness !== 'fresh' ? 'antiga' : 'parcial') + ' — não confirma ausência.' });
      }
      return null;
    }
    function countCell(resource, creatorId) {
      var env = S.envs[resource];
      if (!usable(env)) return h('span', { class: 'saf2-muted', title: RESOURCE_LABEL[resource] + ' indisponível', text: '—' });
      var n = env.items.filter(function (x) { return String(x.creatorId) === String(creatorId); }).length;
      var partial = env.coverage !== 'complete' || env.freshness !== 'fresh' || env.refreshFailed;
      return h('span', { text: String(n) + (partial ? ' (parcial)' : '') });
    }
    function nextStep(creatorId) {
      var env = S.envs.tasks; if (!usable(env)) return null;
      var list = env.items.filter(function (t) { return String(t.creatorId) === String(creatorId); });
      list.sort(function (a, b) { var x = str(a.dueAt), y = str(b.dueAt); return x === y ? 0 : !x ? 1 : !y ? -1 : x < y ? -1 : 1; });
      return list[0] || null;
    }
    function filteredCreators() {
      var env = S.envs.creators; if (!env || !env.items) return [];
      var q = S.ui.search.trim().toLowerCase();
      return env.items.filter(function (c) {
        if (S.ui.stage && str(c.stage) !== S.ui.stage) return false;
        if (S.ui.owner && str(c.ownerReference) !== S.ui.owner) return false;
        if (S.ui.provider && str(c.provider) !== S.ui.provider) return false;
        if (q && (str(c.displayName) + ' ' + str(c.handle)).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }
    function distinct(items, field) {
      var seen = {}, out = [];
      (items || []).forEach(function (x) { var v = str(x[field]); if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
      return out;
    }
    function creatorName(c) { return h('span', { class: 'saf2-name' }, h('strong', { text: str(c.displayName) || '(sem nome)' }), c.handle ? h('span', { class: 'saf2-muted', text: ' @' + str(c.handle).replace(/^@/, '') }) : null); }
    function duplicateHandles() {
      var env = S.envs.creators, count = {}, dup = {};
      (env && env.items || []).forEach(function (c) { var k = str(c.handle).replace(/^@/, '').toLowerCase(); if (k) count[k] = (count[k] || 0) + 1; });
      Object.keys(count).forEach(function (k) { if (count[k] > 1) dup[k] = 1; });
      return dup;
    }
    function renderTable(list) {
      var dup = duplicateHandles();
      return h('div', { class: 'saf2-table-wrap', role: 'region', 'aria-label': 'Tabela de criadores', tabindex: '0', 'data-saf2-key': 'table-region' },
        h('table', { class: 'saf2-table', 'data-saf2-view': 'table' },
          h('caption', { class: 'saf2-sr', text: 'Criadores da marca ' + str(S.ctx && S.ctx.effectiveBrand) }),
          h('thead', null, h('tr', null, ['Criador', 'Provedor', 'Etapa', 'Responsável', 'Próximo passo', 'Prazo', 'Amostras', 'Conteúdos', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, list.map(function (c) {
            var t = nextStep(c.id);
            return h('tr', { 'data-saf2-creator-id': str(c.id) },
              h('td', null, creatorName(c), dup[str(c.handle).replace(/^@/, '').toLowerCase()] ? tag('handle repetido · não unido', 'neutral', 'Mesmo @handle em registros distintos — não unidos: identidade = provedor + marca + ID persistido.') : null),
              h('td', { text: str(c.provider) || '—' }),
              h('td', { text: str(c.stage) || 'Sem etapa' }),
              h('td', { text: str(c.ownerReference) || '—' }),
              h('td', null, t ? [h('span', { text: str(t.label) }), t.state ? h('span', { class: 'saf2-muted', text: ' · ' + str(t.state) }) : null] : (usable(S.envs.tasks) ? '—' : h('span', { class: 'saf2-muted', title: 'Tarefas indisponíveis', text: 'indisponível' }))),
              h('td', { text: t && t.dueAt ? fmtDate(t.dueAt) : '—' }),
              h('td', null, countCell('samples', c.id)),
              h('td', null, countCell('content', c.id)),
              h('td', null, h('button', { type: 'button', class: 'saf2-btn saf2-btn--ghost', 'data-saf2-act': 'open-profile', 'data-id': str(c.id), 'data-saf2-key': 'open:' + str(c.id), 'aria-label': 'Abrir perfil de ' + str(c.displayName) }, 'Abrir perfil'))
            );
          }))
        ));
    }
    function renderKanban(list) {
      var stages = distinct(S.envs.creators && S.envs.creators.items, 'stage'), cols = {}, order = [];
      stages.forEach(function (s) { cols[s] = []; order.push(s); });
      list.forEach(function (c) { var s = str(c.stage); if (!s) { if (!cols['']) { cols[''] = []; order.push(''); } } cols[s].push(c); });
      return h('div', { class: 'saf2-kanban', 'data-saf2-view': 'kanban', role: 'region', 'aria-label': 'Funil de criadores' }, order.map(function (s) {
        return h('section', { class: 'saf2-col', 'aria-label': (s || 'Sem etapa') + ', ' + cols[s].length + ' criador(es)' },
          h('h4', { class: 'saf2-col-title' }, s || 'Sem etapa', h('span', { class: 'saf2-muted', text: ' ' + cols[s].length })),
          h('ul', { class: 'saf2-cards' }, cols[s].map(function (c) {
            var t = nextStep(c.id), g = gate('creator.update', c.id), targets = stages.filter(function (x) { return x !== s; });
            return h('li', { class: 'saf2-card', 'data-saf2-creator-id': str(c.id) },
              creatorName(c),
              h('p', { class: 'saf2-muted', text: [str(c.provider), str(c.ownerReference) ? 'resp. ' + str(c.ownerReference) : ''].filter(Boolean).join(' · ') }),
              t ? h('p', { class: 'saf2-next', text: 'Próximo: ' + str(t.label) + (t.dueAt ? ' · ' + fmtDate(t.dueAt) : '') }) : null,
              h('div', { class: 'saf2-card-actions' },
                h('button', { type: 'button', class: 'saf2-btn saf2-btn--ghost', 'data-saf2-act': 'open-profile', 'data-id': str(c.id), 'data-saf2-key': 'kopen:' + str(c.id), 'aria-label': 'Abrir perfil de ' + str(c.displayName) }, 'Perfil'),
                targets.length ? [
                  h('label', { class: 'saf2-sr', for: 'saf2-move-' + str(c.id), text: 'Mover ' + str(c.displayName) + ' para' }),
                  select({ id: 'saf2-move-' + str(c.id), class: 'saf2-select', 'data-saf2-move-target': str(c.id), 'data-saf2-key': 'move-target:' + str(c.id), disabled: !g.open }, targets.map(function (x) { return { value: x, label: x }; }), targets[0]),
                  gatedButton('Mover', 'move-review', { id: str(c.id) }, g)
                ] : null
              ),
              g.open ? null : h('p', { class: 'saf2-closed saf2-closed--compact', text: 'Mover fechado: ' + g.reasons[0] })
            );
          }))
        );
      }));
    }
    function renderForm() {
      var form = S.form; if (!form) return null;
      var spec = MUTATIONS[form.kind], d = draftFor(form), g = gate(form.kind, form.recordId, form.creatorId);
      var who = form.creatorId ? creatorById(form.creatorId) : form.kind.indexOf('creator.') === 0 && form.recordId ? creatorById(form.recordId) : null;
      var title = (form.variant === 'move' ? 'Mudar etapa' : spec.title) + (who ? ' — ' + str(who.displayName) : '');
      var body;
      if (form.mode === 'edit') {
        body = h('div', { class: 'saf2-fields' }, fieldsOf(form).map(function (f, i) {
          var id = 'saf2-f-' + f.name, key = 'field:' + form.key + ':' + f.name, input, opts = null;
          if (f.type === 'stage') opts = distinct(S.envs.creators && S.envs.creators.items, 'stage');
          if (f.type === 'task-state') opts = distinct(S.envs.tasks && S.envs.tasks.items, 'state');
          if (f.type === 'sku' && usable(S.envs.products)) opts = distinct(S.envs.products.items, 'sku');
          if (opts && opts.length) {
            var cur = d.values[f.name];
            if (cur && opts.indexOf(cur) < 0) opts = [cur].concat(opts);
            input = select({ id: id, class: 'saf2-select', 'data-saf2-field': f.name, 'data-saf2-key': key, required: f.required || null }, [{ value: '', label: f.required ? 'Selecione' : '(manter vazio)' }].concat(opts.map(function (o) { return { value: o, label: o }; })), cur);
          } else {
            input = h('input', { id: id, class: 'saf2-input', type: f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text', 'data-saf2-field': f.name, 'data-saf2-key': key, required: f.required || null, value: d.values[f.name], autocomplete: 'off' });
          }
          if (i === 0 && S.focusKey === 'form-first') S.focusKey = key;
          return h('div', { class: 'saf2-field' }, h('label', { for: id, text: f.label + (f.required ? ' *' : '') }), input);
        }), fieldsOf(form).length === 0 ? h('p', { text: 'Sem campos: revise e confirme.' }) : null);
      } else if (form.mode === 'review' || form.mode === 'busy') {
        var built = buildPayload(form);
        body = h('div', { class: 'saf2-review' },
          h('p', { text: 'Revise o que será registrado no servidor:' }),
          h('dl', { class: 'saf2-dl' }, Object.keys(built.payload).filter(function (k) { return k !== 'creatorId'; }).map(function (k) {
            var f = spec.fields.filter(function (x) { return x.name === k; })[0];
            return [h('dt', { text: f ? f.label : k }), h('dd', { text: built.payload[k] === null ? '(limpar)' : str(built.payload[k]) })];
          })));
        if (S.focusKey === 'form-first') S.focusKey = 'form-confirm';
      } else if (form.mode === 'waiting') {
        body = h('p', { class: 'saf2-state saf2-state--warn', text: 'Operação sem resultado final. O rascunho foi preservado; nada será reenviado. Use "Consultar recibo" em Operações.' });
      }
      var actions;
      if (form.mode === 'edit') actions = [
        h('button', { type: 'button', class: 'saf2-btn', 'data-saf2-act': 'form-review', 'data-saf2-key': 'form-review' }, 'Revisar'),
        h('button', { type: 'button', class: 'saf2-btn saf2-btn--ghost', 'data-saf2-act': 'form-cancel', 'data-saf2-key': 'form-cancel' }, 'Fechar (mantém rascunho)')
      ];
      else if (form.mode === 'review' || form.mode === 'busy') actions = [
        h('button', { type: 'button', class: 'saf2-btn saf2-btn--primary', 'data-saf2-act': 'form-confirm', 'data-saf2-key': 'form-confirm', disabled: !g.open || form.mode === 'busy', title: g.open ? null : g.reasons.join(' ') }, form.mode === 'busy' ? 'Registrando…' : 'Confirmar registro'),
        h('button', { type: 'button', class: 'saf2-btn saf2-btn--ghost', 'data-saf2-act': 'form-back', 'data-saf2-key': 'form-back', disabled: form.mode === 'busy' }, form.variant === 'move' || !fieldsOf(form).length ? 'Cancelar' : 'Voltar')
      ];
      else actions = [h('button', { type: 'button', class: 'saf2-btn saf2-btn--ghost', 'data-saf2-act': 'form-cancel', 'data-saf2-key': 'form-cancel' }, 'Fechar (mantém rascunho)')];
      return h('section', { class: 'saf2-form', 'data-saf2-form': form.kind, 'aria-labelledby': 'saf2-form-title' },
        h('h4', { id: 'saf2-form-title', text: title }),
        spec.warn ? h('p', { class: 'saf2-warn', text: spec.warn }) : null,
        form.error ? h('p', { class: 'saf2-state saf2-state--bad', role: 'alert', text: form.error }) : null,
        body,
        h('div', { class: 'saf2-actions' }, actions),
        form.mode !== 'waiting' ? reasonsLine([g]) : null);
    }
    function renderOps() {
      if (!S.opOrder.length && !S.prepareUnknown) return null;
      return h('section', { class: 'saf2-ops', 'aria-label': 'Operações desta sessão' },
        h('h3', { text: 'Operações' }),
        h('ul', null, S.opOrder.map(function (id) {
          var op = S.ops.get(id); if (!op) return null;
          var label = { submitting: 'em envio', prepared: 'preparada', pending: 'pendente no servidor', uncertain: 'resultado desconhecido', confirmed: 'confirmada', rejected: 'recusada' }[op.state] || op.state;
          var needs = op.state === 'pending' || op.state === 'uncertain';
          return h('li', { 'data-saf2-op': id, 'data-saf2-op-state': op.state },
            h('span', { text: (op.kind ? op.kind : 'Operação do servidor') + ' · ' + label }),
            op.receiptReference ? h('span', { class: 'saf2-muted', text: ' · recibo ' + str(op.receiptReference) }) : null,
            op.reason ? h('span', { class: 'saf2-muted', text: ' · ' + op.reason }) : null,
            op.state === 'confirmed' && op.refresh === 'pending' ? tag('Confirmada. Atualização da leitura pendente (falhou)', 'warn') : null,
            op.state === 'confirmed' && op.refresh === 'running' ? tag('Confirmada. Atualizando leitura…', 'neutral') : null,
            needs ? h('button', { type: 'button', class: 'saf2-btn saf2-btn--ghost', 'data-saf2-act': 'receipt', 'data-op': id, 'data-saf2-key': 'receipt:' + id, disabled: !canWrite || S.receiptBusy.has(id) || !S.ctx }, S.receiptBusy.has(id) ? 'Consultando…' : 'Consultar recibo') : null);
        })),
        S.prepareUnknown ? h('p', { class: 'saf2-state saf2-state--warn', text: 'Uma preparação ficou sem resposta. Atualize a leitura: as pendências do servidor aparecem aqui com recibo.' }) : null);
    }
    function renderPerf(env, scopeLabel) {
      var wrap = h('section', { class: 'saf2-perf', 'data-saf2-perf': scopeLabel },
        h('h3', { text: scopeLabel === 'program' ? 'Desempenho próprio do programa' : 'Desempenho próprio do criador' }),
        sourceLine(env, 'own-performance'), stateBlock(env, 'own-performance'));
      if (!env || env.state !== 'ready' || !isObj(env.data)) return wrap;
      var d = env.data, lens = enumOr(d.source || env.source, SOURCE_LABEL), market = lens === 'market_estimated';
      var paid = lens === 'own_verified' && Number.isInteger(d.settledMinor) && !!d.settlementProof && typeof d.currency === 'string' && !!d.currency;
      wrap.appendChild(h('p', { class: 'saf2-meta' },
        h('span', { text: 'Período: ' + (periodText(d.period) || 'não informado') }),
        h('span', { text: 'Moeda: ' + (str(d.currency) || 'não informada') }),
        h('span', { text: 'Lente: ' + SOURCE_LABEL[lens] }),
        h('span', { text: 'Cobertura: ' + COVERAGE_LABEL[enumOr(d.coverage || env.coverage, COVERAGE_LABEL)] }),
        h('span', { text: 'Política: ' + (d.policyVersion != null && d.policyVersion !== '' ? 'versão ' + str(d.policyVersion) + ' (servidor)' : 'indisponível') })));
      if (market) wrap.appendChild(h('p', { class: 'saf2-warn', text: 'Estimativa de mercado: não é receita própria, comissão devida nem pagamento.' }));
      function cell(key, title, note, minor, extra) {
        var f = fmtMinor(minor, d.currency);
        return h('div', { class: 'saf2-stat', 'data-saf2-commission': key, 'data-saf2-value-kind': f.kind },
          h('span', { class: 'saf2-stat-label', text: title }),
          h('strong', { class: 'saf2-stat-value', text: f.text }),
          h('span', { class: 'saf2-muted', text: note }), extra || null);
      }
      var settledNote;
      if (paid) settledNote = tag('Paga — liquidação comprovada' + (typeof d.settlementProof === 'string' ? ' (' + d.settlementProof + ')' : ''), 'good');
      else if (d.settledMinor != null) settledNote = tag('Sem prova de liquidação própria — não é “paga”', 'warn');
      wrap.appendChild(h('div', { class: 'saf2-stats' },
        cell('estimated', market ? 'Estimativa (mercado)' : 'Comissão ESTIMADA', 'Estimativa — inclusive quando informada pelo próprio seller.', d.estimatedMinor),
        market ? null : cell('accrued', 'Comissão APURADA', 'Apurada pelo servidor; ainda não é pagamento.', d.accruedMinor),
        market ? null : cell('settled', 'Comissão LIQUIDADA', 'Só é “paga” com prova de liquidação.', d.settledMinor, settledNote),
        cell('returns', 'Devoluções', 'Valor separado; nada é descontado ou somado aqui.', d.returnsMinor)));
      wrap.appendChild(h('p', { class: 'saf2-muted', text: 'Lentes, canais e fontes não são somados. Taxa e regra vêm do servidor.' }));
      return wrap;
    }
    function renderProfile() {
      var P = S.profile; if (!P) return null;
      var c = (P.env && P.env.creator) || creatorById(P.creatorId);
      var id = P.creatorId, next = nextStep(id);
      var gUpd = gate('creator.update', id), gArc = gate('creator.archive', id), gS = gate('sample.record-manual', null, id), gT = gate('task.create', null, id), gC = gate('content.record-manual', null, id);
      function sub(resource, title, rows, emptyTxt) {
        var env = S.envs[resource];
        return h('section', { class: 'saf2-sub', 'data-saf2-sub': resource }, h('h4', { text: title }), sourceLine(env, resource),
          stateBlock(env, resource) || (rows.length ? h('ul', { class: 'saf2-list' }, rows) : h('p', { class: 'saf2-state', 'data-saf2-state': usable(env) && env.coverage === 'complete' && env.freshness === 'fresh' && !env.refreshFailed ? 'empty-confirmed' : 'empty-unconfirmed', text: usable(env) && env.coverage === 'complete' && env.freshness === 'fresh' && !env.refreshFailed ? emptyTxt : emptyTxt + ' (leitura parcial/antiga — não confirma ausência)' })));
      }
      function mine(resource) { var env = S.envs[resource]; return usable(env) ? env.items.filter(function (x) { return String(x.creatorId) === String(id); }) : []; }
      var samples = mine('samples'), contents = mine('content'), tasks = mine('tasks');
      var skus = {}; samples.forEach(function (s) { skus[str(s.sku)] = 1; });
      var products = usable(S.envs.products) ? S.envs.products.items.filter(function (p) { return skus[str(p.sku)]; }) : [];
      return h('aside', { class: 'saf2-profile', 'aria-labelledby': 'saf2-profile-title', 'data-saf2-profile': str(id) },
        h('div', { class: 'saf2-profile-head' },
          h('h3', { id: 'saf2-profile-title', tabindex: '-1', 'data-saf2-key': 'profile-title' }, c ? str(c.displayName) || '(sem nome)' : 'Perfil'),
          h('button', { type: 'button', class: 'saf2-btn saf2-btn--ghost', 'data-saf2-act': 'close-profile', 'data-saf2-key': 'close-profile' }, 'Fechar perfil')),
        P.env ? sourceLine(P.env, 'creator-profile') : null,
        P.env ? stateBlock(P.env, 'creator-profile') : h('p', { class: 'saf2-state', 'data-saf2-state': 'loading', 'aria-busy': 'true', text: 'Carregando perfil…' }),
        c ? h('dl', { class: 'saf2-dl' },
          h('dt', { text: 'ID' }), h('dd', { text: str(c.id) }),
          h('dt', { text: 'Provedor / ID no provedor' }), h('dd', { text: (str(c.provider) || '—') + ' / ' + (str(c.providerId) || '—') }),
          h('dt', { text: '@handle' }), h('dd', { text: str(c.handle) || '—' }),
          h('dt', { text: 'Etapa' }), h('dd', { text: str(c.stage) || 'Sem etapa' }),
          h('dt', { text: 'Responsável' }), h('dd', { text: str(c.ownerReference) || '—' }),
          h('dt', { text: 'Próximo passo' }), h('dd', { 'data-saf2-next': '' }, next ? str(next.label) + (next.state ? ' · ' + str(next.state) : '') : (usable(S.envs.tasks) && writable(S.envs.tasks) === null && !S.envs.tasks.malformed ? 'Nenhuma tarefa' : 'Indisponível (tarefas sem leitura completa e atual)')),
          h('dt', { text: 'Prazo' }), h('dd', { 'data-saf2-due': '' }, next && next.dueAt ? fmtDate(next.dueAt) : '—'),
          h('dt', { text: 'Marca' }), h('dd', { text: str(c.brandId) || str(S.ctx && S.ctx.effectiveBrand) })) : null,
        h('div', { class: 'saf2-actions' },
          gatedButton('Editar', 'open-form', { kind: 'creator.update', record: str(id) }, gUpd),
          gatedButton('Arquivar', 'open-form', { kind: 'creator.archive', record: str(id) }, gArc),
          gatedButton('Registrar amostra', 'open-form', { kind: 'sample.record-manual', creator: str(id) }, gS),
          gatedButton('Nova tarefa', 'open-form', { kind: 'task.create', creator: str(id) }, gT),
          gatedButton('Registrar conteúdo', 'open-form', { kind: 'content.record-manual', creator: str(id) }, gC)),
        reasonsLine([gUpd, gArc, gS, gT, gC]),
        S.form && (String(S.form.creatorId) === String(id) || String(S.form.recordId) === String(id) || S.form.profileId === id) ? renderForm() : null,
        sub('samples', 'Amostras (registro manual ≠ envio no TikTok)', samples.map(function (s) {
          var g = gate('sample.update-manual', s.id);
          return h('li', { 'data-saf2-sample': str(s.id) }, h('span', { text: str(s.sku) + ' · ' + (str(s.manualStatus) || 'sem status') + (s.dueAt ? ' · prazo ' + fmtDate(s.dueAt) : '') }), tag(SOURCE_LABEL[enumOr(s.source, SOURCE_LABEL)] || 'Origem desconhecida', 'neutral'), gatedButton('Atualizar', 'open-form', { kind: 'sample.update-manual', record: str(s.id), profile: str(id) }, g));
        }), 'Nenhuma amostra registrada.'),
        sub('products', 'Produtos das amostras', products.map(function (p) { return h('li', null, h('span', { text: str(p.label) || str(p.sku) }), h('span', { class: 'saf2-muted', text: ' · SKU ' + str(p.sku) })); }), 'Nenhum produto vinculado às amostras lidas.'),
        sub('content', 'Conteúdos', contents.map(function (x) {
          var u = safeHttpUrl(x.url), g = gate('content.update-manual', x.id);
          return h('li', { 'data-saf2-content': str(x.id) }, h('span', { text: [str(x.provider), str(x.kind), x.publishedAt ? fmtDate(x.publishedAt) : ''].filter(Boolean).join(' · ') }),
            u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: 'saf2-link' }, ' abrir') : null,
            tag(SOURCE_LABEL[enumOr(x.source, SOURCE_LABEL)], 'neutral'), h('span', { class: 'saf2-muted', text: ' · métricas indisponíveis' }),
            gatedButton('Editar', 'open-form', { kind: 'content.update-manual', record: str(x.id), profile: str(id) }, g));
        }), 'Nenhum conteúdo registrado.'),
        sub('tasks', 'Tarefas', tasks.map(function (t) {
          var g = gate('task.update', t.id);
          return h('li', { 'data-saf2-task': str(t.id) }, h('span', { text: str(t.label) + ' · ' + (str(t.state) || 'sem situação') + (t.dueAt ? ' · prazo ' + fmtDate(t.dueAt) : '') + (t.ownerReference ? ' · resp. ' + str(t.ownerReference) : '') }), gatedButton('Editar', 'open-form', { kind: 'task.update', record: str(t.id), profile: str(id) }, g));
        }), 'Nenhuma tarefa.'),
        renderPerf(P.perf, 'creator'));
    }
    function render() {
      if (S.disposed) return;
      var active = doc.activeElement, prevKey = active && rootEl.contains(active) && active.getAttribute ? active.getAttribute('data-saf2-key') : null;
      while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
      var ctx = S.ctx;
      var head = h('header', { class: 'saf2-head' },
        h('div', null, h('h2', { class: 'saf2-title', text: 'CRM de afiliados' }),
          ctx ? h('p', { class: 'saf2-meta' }, h('span', { text: 'Marca efetiva: ' + str(ctx.effectiveBrand) }), h('span', { text: 'Papel: ' + str(ctx.role) }), ctx.sourceRevision != null ? h('span', { text: 'Revisão da fonte: ' + str(ctx.sourceRevision) }) : null) : null),
        h('div', { class: 'saf2-refresh' },
          h('button', { type: 'button', class: 'saf2-btn', 'data-saf2-act': 'refresh', 'data-saf2-key': 'refresh', 'aria-describedby': 'saf2-refresh-note' }, S.loading ? 'Atualizando…' : 'Atualizar leitura'),
          h('span', { id: 'saf2-refresh-note', class: 'saf2-muted', text: 'Relê o servidor; não dispara nova coleta.' })));
      rootEl.appendChild(head);
      var status = h('div', { class: 'saf2-status', role: 'status', 'aria-live': 'polite', tabindex: '-1', 'data-saf2-key': 'status' },
        S.notices.map(function (n) { return h('p', { class: 'saf2-notice saf2-notice--' + n.tone, text: n.text }); }),
        S.ctxError ? h('p', { class: 'saf2-notice saf2-notice--bad', 'data-saf2-state': 'context-error', text: S.ctxError }) : null,
        S.revoked ? h('p', { class: 'saf2-notice saf2-notice--bad', 'data-saf2-state': 'revoked', text: 'Motivo público: ' + S.revoked }) : null);
      rootEl.appendChild(status);
      var ops = renderOps(); if (ops) rootEl.appendChild(ops);
      if (!ctx) {
        if (S.loading) rootEl.appendChild(h('p', { class: 'saf2-state', 'data-saf2-state': 'loading', 'aria-busy': 'true', text: 'Confirmando sessão e marca…' }));
        else if (!S.ctxError && !S.revoked) rootEl.appendChild(h('p', { class: 'saf2-state', 'data-saf2-state': 'idle', text: 'Aguardando a primeira leitura.' }));
        finishFocus(prevKey); return;
      }
      var envC = S.envs.creators, list = filteredCreators(), all = envC && envC.items || [];
      var gNew = gate('creator.create');
      var toolbar = h('div', { class: 'saf2-toolbar' },
        h('div', { role: 'tablist', 'aria-label': 'Visualização', class: 'saf2-tabs' },
          h('button', { type: 'button', role: 'tab', id: 'saf2-tab-table', 'aria-selected': S.view === 'table' ? 'true' : 'false', tabindex: S.view === 'table' ? '0' : '-1', 'data-saf2-act': 'view', 'data-view': 'table', 'data-saf2-key': 'tab-table', 'aria-controls': 'saf2-panel' }, 'Tabela'),
          h('button', { type: 'button', role: 'tab', id: 'saf2-tab-kanban', 'aria-selected': S.view === 'kanban' ? 'true' : 'false', tabindex: S.view === 'kanban' ? '0' : '-1', 'data-saf2-act': 'view', 'data-view': 'kanban', 'data-saf2-key': 'tab-kanban', 'aria-controls': 'saf2-panel' }, 'Kanban')),
        h('div', { class: 'saf2-filters', role: 'group', 'aria-label': 'Filtros' },
          h('label', { class: 'saf2-sr', for: 'saf2-search', text: 'Buscar por nome ou @handle' }),
          h('input', { id: 'saf2-search', class: 'saf2-input', type: 'search', placeholder: 'Buscar nome ou @handle', 'data-saf2-filter': 'search', 'data-saf2-key': 'filter-search', value: S.ui.search }),
          [['stage', 'Etapa', 'Todas as etapas'], ['ownerReference', 'Responsável', 'Todos os responsáveis'], ['provider', 'Provedor', 'Todos os provedores']].map(function (f) {
            var k = f[0] === 'ownerReference' ? 'owner' : f[0];
            return [h('label', { class: 'saf2-sr', for: 'saf2-filter-' + k, text: f[1] }),
              select({ id: 'saf2-filter-' + k, class: 'saf2-select', 'data-saf2-filter': k, 'data-saf2-key': 'filter-' + k }, [{ value: '', label: f[2] }].concat(distinct(all, f[0]).map(function (v) { return { value: v, label: v }; })), S.ui[k])];
          })),
        gatedButton('Novo criador', 'open-form', { kind: 'creator.create' }, gNew));
      var crm = h('section', { class: 'saf2-crm', 'aria-label': 'Criadores' },
        sourceLine(envC, 'creators'), toolbar, reasonsLine([gNew]),
        S.form && !S.profile ? renderForm() : (S.form && S.profile && !(String(S.form.creatorId) === String(S.profile.creatorId) || String(S.form.recordId) === String(S.profile.creatorId) || S.form.profileId === S.profile.creatorId) ? renderForm() : null),
        h('div', { id: 'saf2-panel', role: 'tabpanel', 'aria-labelledby': S.view === 'table' ? 'saf2-tab-table' : 'saf2-tab-kanban', class: 'saf2-panel' },
          stateBlock(envC, 'creators') || (list.length ? (S.view === 'table' ? renderTable(list) : renderKanban(list)) : h('p', { class: 'saf2-state', 'data-saf2-state': 'filtered-empty', text: 'Nenhum criador com estes filtros (' + all.length + ' na leitura).' }))));
      var body = h('div', { class: 'saf2-body' + (S.profile ? ' saf2-body--profile' : '') }, crm, renderProfile());
      rootEl.appendChild(body);
      rootEl.appendChild(renderPerf(S.envs['own-performance'], 'program'));
      finishFocus(prevKey);
    }
    function byAttr(name, value) {
      var all = rootEl.querySelectorAll('[' + name + ']');
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute(name) === String(value)) return all[i];
      return null;
    }
    function finishFocus(prevKey) {
      var want = S.focusKey || prevKey; S.focusKey = null;
      if (!want) return;
      var el = byAttr('data-saf2-key', want);
      if (el && typeof el.focus === 'function') el.focus();
    }

    // -------------------------------------------------------------- eventos (delegados no próprio container)
    function openForm(kind, recordId, creatorId, variant, profileId) {
      if (!MUTATIONS[kind]) return;
      var key = kind + ':' + str(recordId) + ':' + str(creatorId) + (variant ? ':' + variant : '');
      S.form = { key: key, kind: kind, recordId: recordId || null, creatorId: creatorId || null, variant: variant || null, profileId: profileId || null, mode: MUTATIONS[kind].fields.length ? 'edit' : 'review', error: null };
      draftFor(S.form);
      S.focusKey = 'form-first';
      render();
    }
    function onClick(ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-saf2-act]') : null;
      if (!t || !rootEl.contains(t) || t.disabled) return;
      var act = t.getAttribute('data-saf2-act');
      if (act === 'refresh') { startSync(S.filters, false); return; }
      if (act === 'view') { S.view = t.getAttribute('data-view'); S.focusKey = 'tab-' + S.view; render(); return; }
      if (act === 'open-profile') {
        var id = t.getAttribute('data-id'); S.returnFocus = t.getAttribute('data-saf2-key');
        S.focusKey = 'profile-title'; loadProfile(S.generation, id); return;
      }
      if (act === 'close-profile') { closeProfile(); return; }
      if (act === 'open-form') { openForm(t.getAttribute('data-kind'), t.getAttribute('data-record'), t.getAttribute('data-creator'), null, t.getAttribute('data-profile')); return; }
      if (act === 'move-review') {
        var cid = t.getAttribute('data-id'), sel = byAttr('data-saf2-move-target', cid);
        if (!sel) return;
        openForm('creator.update', cid, null, 'move');
        var d = draftFor(S.form); d.values.stage = sel.value; d.dirty = true; S.form.mode = 'review'; S.focusKey = 'form-confirm'; render(); return;
      }
      if (act === 'form-review' && S.form) {
        var b = buildPayload(S.form);
        if (b.errors.length) { S.form.error = b.errors.join(' '); S.focusKey = 'form-first'; }
        else { S.form.error = null; S.form.mode = 'review'; S.focusKey = 'form-confirm'; }
        render(); return;
      }
      if (act === 'form-back' && S.form) {
        if (S.form.variant === 'move' || !fieldsOf(S.form).length) { S.drafts.delete(S.form.key); S.form = null; }
        else { S.form.mode = 'edit'; S.focusKey = 'form-first'; }
        render(); return;
      }
      if (act === 'form-cancel') { S.form = null; render(); return; }
      if (act === 'form-confirm' && S.form && S.form.mode === 'review') { mutate(S.form); return; }
      if (act === 'receipt') { consultReceipt(t.getAttribute('data-op')); }
    }
    function closeProfile() {
      S.profile = null; if (S.form && S.form.mode !== 'busy') S.form = null;
      S.focusKey = S.returnFocus || 'tab-' + S.view; render();
    }
    function onInput(ev) {
      var t = ev.target; if (!t || !t.getAttribute || !rootEl.contains(t)) return;
      var field = t.getAttribute('data-saf2-field'), filter = t.getAttribute('data-saf2-filter');
      if (field && S.form) { var d = draftFor(S.form); d.values[field] = t.value; d.dirty = true; return; }
      if (filter) { S.ui[filter] = t.value; S.focusKey = t.getAttribute('data-saf2-key'); render(); }
    }
    function onKey(ev) {
      var t = ev.target; if (!t || !t.getAttribute || !rootEl.contains(t)) return;
      if (t.getAttribute('role') === 'tab' && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft' || ev.key === 'Home' || ev.key === 'End')) {
        S.view = S.view === 'table' ? 'kanban' : 'table';
        if (ev.key === 'Home') S.view = 'table'; if (ev.key === 'End') S.view = 'kanban';
        S.focusKey = 'tab-' + S.view; if (ev.preventDefault) ev.preventDefault(); render(); return;
      }
      if (ev.key === 'Escape') {
        if (S.form && S.form.mode !== 'busy') { S.form = null; S.focusKey = S.profile ? 'profile-title' : 'tab-' + S.view; render(); if (ev.preventDefault) ev.preventDefault(); }
        else if (S.profile) { closeProfile(); if (ev.preventDefault) ev.preventDefault(); }
      }
    }
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('input', onInput);
    rootEl.addEventListener('change', onInput);
    rootEl.addEventListener('keydown', onKey);
    render();

    function dispose() {
      if (S.disposed) return;
      S.disposed = true; S.generation++;
      if (S.abort) { try { S.abort.abort(); } catch (_) {} }
      rootEl.removeEventListener('click', onClick);
      rootEl.removeEventListener('input', onInput);
      rootEl.removeEventListener('change', onInput);
      rootEl.removeEventListener('keydown', onKey);
      S.drafts.clear(); S.ops.clear(); S.envs = {}; S.profile = null; S.ctx = null; S.form = null; S.inflight = null;
      if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    }
    return { sync: sync, dispose: dispose };
  }

  return { create: create, contractVersion: CONTRACT_VERSION };
});
