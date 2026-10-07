/*!
 * ShrigmaAffiliatesV103 — leitor do contrato de afiliados 1.0.3-proposed (frente C1).
 * Derivado do leitor tipado 1.0.2 (reader v2 + ação de perfil na primeira coluna, entrega r5).
 * 1.0.3: criador com identidade explícita — cadastro próprio (own_candidate_record, plataforma
 * não vinculada) ou vínculo de provedor (provider_bound). Lista e perfil precisam do mesmo modo,
 * ID e revisão; mudança de modo descarta perfil e seleção anteriores.
 * Apresentação pura. O normalizador ShrigmaAffiliatesContractV103 é injetado por Codex Root e é a
 * única fonte de validação de contexto, filtros, envelopes, próximo passo, journal e recibos.
 * Gravações deste incremento ficam DESLIGADAS: o módulo nunca acessa beginMutation nem submit,
 * não gera IDs, não guarda journal/store, não tem transporte nem credencial.
 * Métodos do gateway usados: context, read e (somente leitura do ID original) receipt.
 * Revisão 2 (política Root C1-r3-pre-invocation-lifetime-policy): cada callback agendado confere o ciclo
 * de vida imediatamente antes de invocar o gateway e não é invocado após dispose; chamada já iniciada não é
 * cancelada nem repetida; rejeição bruta de callback vira mensagem pública genérica.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ShrigmaAffiliatesV103 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.3-proposed';
  var NORMALIZER_API = ['reference', 'revision', 'civilDate', 'period', 'samePeriod', 'context', 'filters', 'envelope', 'pending', 'journal', 'nextStep', 'operation', 'recovery'];
  var WRITES_ENABLED = false;
  var READ_UNAVAILABLE = 'Leitura indisponível no momento.';
  var RECEIPT_UNAVAILABLE = 'Não foi possível consultar o recibo agora. Nada foi reenviado.';
  var WRITES_OFF_REASON = 'Gravações desligadas neste incremento 1.0.3: a tela não chama beginMutation nem submit.';
  var UNLINKED = 'Plataforma não vinculada';
  var UNLINKED_TITLE = 'Cadastro próprio (crm_partner_candidate_v1): nenhuma conta de plataforma vinculada; não indica TikTok ou outra rede conectada.';
  var PROFILE_INCOHERENT = 'Perfil incoerente com a lista atual (modo de identidade, ID ou revisão); resposta descartada.';
  var MODE_CHANGED = 'O modo de identidade dos criadores mudou nesta leitura; perfil, formulário e filtro de plataforma anteriores foram descartados.';
  var RESOURCES = ['creators', 'samples', 'products', 'content', 'tasks', 'own-performance'];
  var COLLECTIONS = { creators: 1, samples: 1, products: 1, content: 1, tasks: 1 };
  var SOURCE_LABEL = { own_verified: 'Própria verificada', own_declared: 'Própria declarada', derived: 'Derivada', market_estimated: 'Estimativa de mercado', unknown: 'Origem desconhecida' };
  var COVERAGE_LABEL = { complete: 'completa', partial: 'parcial', unknown: 'desconhecida' };
  var FRESHNESS_LABEL = { fresh: 'atual', stale: 'antiga', unknown: 'desconhecida' };
  var RESOURCE_LABEL = { creators: 'Criadores', samples: 'Amostras', products: 'Produtos', content: 'Conteúdos', tasks: 'Tarefas', 'own-performance': 'Desempenho próprio', 'creator-profile': 'Perfil' };
  var OP_LABEL = { prepared: 'preparada', pending: 'pendente no servidor', uncertain: 'resultado desconhecido', confirmed: 'confirmada', rejected: 'recusada' };

  // Allowlist 1.0.2/1.0.3 (mutationPayloads, inalterada). Só alimenta a prévia; nada é enviado neste incremento.
  var MUTATIONS = {
    'creator.create': { title: 'Novo criador', resource: 'creators', record: null, fields: [
      { name: 'provider', label: 'Provedor', type: 'text', required: true },
      { name: 'providerId', label: 'ID persistido no provedor', type: 'text', required: true },
      { name: 'displayName', label: 'Nome', type: 'text', required: true },
      { name: 'handle', label: '@handle', type: 'text', clearable: true },
      { name: 'ownerReference', label: 'Responsável', type: 'text', clearable: true },
      { name: 'stage', label: 'Etapa', type: 'stage', clearable: true }],
      warn: 'Identidade = provedor + marca efetiva + ID persistido no provedor. O @handle não é ID do provedor nem une contas.' },
    'creator.update': { title: 'Editar criador', resource: 'creators', record: 'creators', fields: [
      { name: 'displayName', label: 'Nome', type: 'text', requiredWhenPresent: true },
      { name: 'handle', label: '@handle', type: 'text', clearable: true },
      { name: 'ownerReference', label: 'Responsável', type: 'text', clearable: true },
      { name: 'stage', label: 'Etapa', type: 'stage', clearable: true }] },
    'creator.archive': { title: 'Arquivar criador', resource: 'creators', record: 'creators', fields: [],
      warn: 'Root arquiva preservando identidade, histórico e revisões. Nada é apagado por esta tela.' },
    'sample.record-manual': { title: 'Registrar amostra manual', resource: 'samples', record: null, scoped: true, fields: [
      { name: 'sku', label: 'SKU', type: 'sku', required: true },
      { name: 'manualStatus', label: 'Status manual', type: 'text', required: true },
      { name: 'dueAt', label: 'Prazo', type: 'date', clearable: true }],
      warn: 'Registro manual declarado. Não aciona TikTok, estoque, envio nem aprovação.' },
    'sample.update-manual': { title: 'Atualizar amostra manual', resource: 'samples', record: 'samples', fields: [
      { name: 'manualStatus', label: 'Status manual', type: 'text', requiredWhenPresent: true },
      { name: 'dueAt', label: 'Prazo', type: 'date', clearable: true }],
      warn: 'Registro manual declarado. Criador e SKU da amostra são imutáveis.' },
    'task.create': { title: 'Nova tarefa', resource: 'tasks', record: null, scoped: true, fields: [
      { name: 'label', label: 'Próximo passo', type: 'text', required: true },
      { name: 'dueAt', label: 'Prazo', type: 'date', clearable: true },
      { name: 'ownerReference', label: 'Responsável', type: 'text', clearable: true }],
      blocked: 'Estado inicial e responsável padrão de tarefa não foram admitidos por Root.' },
    'task.update': { title: 'Editar tarefa', resource: 'tasks', record: 'tasks', fields: [
      { name: 'label', label: 'Próximo passo', type: 'text', requiredWhenPresent: true },
      { name: 'state', label: 'Situação', type: 'task-state', requiredWhenPresent: true },
      { name: 'dueAt', label: 'Prazo', type: 'date', clearable: true },
      { name: 'ownerReference', label: 'Responsável', type: 'text', clearable: true }] },
    'content.record-manual': { title: 'Registrar conteúdo manual', resource: 'content', record: null, scoped: true, fields: [
      { name: 'provider', label: 'Provedor', type: 'text', required: true },
      { name: 'kind', label: 'Tipo', type: 'text', required: true },
      { name: 'url', label: 'Endereço (http/https)', type: 'url', clearable: true },
      { name: 'publishedAt', label: 'Publicado em', type: 'date', clearable: true }],
      warn: 'Conteúdo declarado. Endereço não prova publicação, autoria nem métrica.' },
    'content.update-manual': { title: 'Editar conteúdo manual', resource: 'content', record: 'content', fields: [
      { name: 'kind', label: 'Tipo', type: 'text', requiredWhenPresent: true },
      { name: 'url', label: 'Endereço (http/https)', type: 'url', clearable: true },
      { name: 'publishedAt', label: 'Publicado em', type: 'date', clearable: true }] }
  };

  // ---------------------------------------------------------------- utilidades de apresentação
  function isObj(v) { return v !== null && Object.prototype.toString.call(v) === '[object Object]'; }
  function str(v) { return v == null ? '' : String(v); }
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function keyOf(id) { return (typeof id) + ':' + String(id); }
  function ownRecord(c) { return !!c && c.identityKind === 'own_candidate_record'; }
  function civilText(s) { return s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4); }
  function checkNormalizer(N) {
    if (!N || (typeof N !== 'object' && typeof N !== 'function')) return 'Normalizador ' + VERSION + ' não injetado por Root.';
    if (N.version !== VERSION) return 'Normalizador com versão divergente (' + str(N.version) + '); esperado ' + VERSION + '.';
    for (var i = 0; i < NORMALIZER_API.length; i++) if (typeof N[NORMALIZER_API[i]] !== 'function') return 'Normalizador sem a função ' + NORMALIZER_API[i] + ' da INTERFACE ' + VERSION + '.';
    return null;
  }

  function create(options) {
    var element = options && options.element, doc = options && options.document, gateway = options && options.gateway, N = options && options.normalizer;
    if (!element || !doc || typeof doc.createElement !== 'function') throw new TypeError('ShrigmaAffiliatesV103.create requer {element, document, gateway, normalizer}.');
    var closedReason = checkNormalizer(N) || ((!gateway || typeof gateway.context !== 'function' || typeof gateway.read !== 'function') ? 'Gateway sem context/read do contrato.' : null);
    var canReceipt = !closedReason && typeof gateway.receipt === 'function';

    function fmtDate(v) {
      if (v == null || v === '') return null;
      var s = String(v);
      if (N && !closedReason && N.civilDate(s)) return civilText(s);
      var d = new Date(s);
      if (!/^\d{4}-\d\d-\d\dT/.test(s) || isNaN(d.getTime())) return 'data inválida';
      try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d) + ' (Brasília)'; } catch (_) { return s; }
    }
    function periodText(p) { return N && !closedReason && N.period(p) ? civilText(p.start) + ' a ' + civilText(p.end) : null; }
    function fmtMinor(minor, currency) {
      if (minor === null || minor === undefined) return { kind: 'missing', text: 'Indisponível' };
      if (!Number.isSafeInteger(minor)) return { kind: 'malformed', text: 'Valor malformado — não exibido' };
      if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return { kind: 'nocurrency', text: 'Sem moeda informada — valor não exibido' };
      try {
        var nf = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency });
        return { kind: 'ok', text: nf.format(minor / Math.pow(10, nf.resolvedOptions().maximumFractionDigits)) };
      } catch (_) { return { kind: 'nocurrency', text: 'Moeda inválida — valor não exibido' }; }
    }

    var S = {
      disposed: false, generation: 0, inflight: null,
      filters: {}, filtersKey: stable({}), loading: false,
      ctx: null, rawCtx: null, ctxError: null, scopeKey: null, draftScope: null, revoked: null,
      envs: {}, profile: null, identityKind: null, view: 'table', ui: { search: '', stage: '', owner: '', provider: '' },
      drafts: new Map(), form: null, ops: new Map(), opOrder: [], receiptBusy: new Set(), notices: [], focusKey: null, returnFocus: null
    };
    var rootEl = doc.createElement('div');
    rootEl.setAttribute('class', 'saf3');
    rootEl.setAttribute('data-saf3-root', '');
    element.appendChild(rootEl);


    // -------------------------------------------------------------- escopo
    function clearProjection(keepProfile) {
      S.envs = {};
      S.profile = keepProfile && S.profile ? { creatorId: S.profile.creatorId, token: {}, env: null, perf: null, loading: true } : null;
    }
    function clearScope() {
      clearProjection(false); S.drafts.clear(); S.form = null; S.ops.clear(); S.opOrder = []; S.receiptBusy.clear();
      S.ui = { search: '', stage: '', owner: '', provider: '' }; S.identityKind = null;
    }
    function applyContext(ctx, raw) {
      var scope = [ctx.principalReference, ctx.effectiveBrand, ctx.sessionRevision == null ? '' : ctx.sessionRevision].map(function (x) { return keyOf(x); }).join('|');
      if (S.scopeKey !== null && S.scopeKey !== scope) clearScope();
      // Rascunho vale só para o mesmo ator/marca/sessão/revisão de contexto (capacidades incluídas).
      var draftScope = scope + '|' + keyOf(ctx.contextRevision);
      if (S.draftScope !== null && S.draftScope !== draftScope) { S.drafts.clear(); S.form = null; }
      S.scopeKey = scope; S.draftScope = draftScope; S.ctx = ctx; S.rawCtx = raw; S.ctxError = null; S.revoked = null; S.notices = [];
      var listed = {};
      (ctx.pendingOperations || []).forEach(function (id) {
        listed[keyOf(id)] = 1;
        if (!S.ops.has(keyOf(id))) track({ operationId: id, state: 'pending', origin: 'server', receiptReference: null, reason: null });
      });
      // IDs conhecidos não somem por lista vazia ou ausente: seguem somente para recibo.
      S.ops.forEach(function (op, k) { op.listed = !!listed[k]; });
    }
    function revoke(reason) {
      clearScope(); S.ctx = null; S.rawCtx = null; S.scopeKey = null; S.draftScope = null;
      S.revoked = reason || 'Acesso recusado.';
      S.notices = [{ tone: 'bad', text: 'Acesso recusado pelo servidor: dados desta área removidos da tela e ações fechadas.' }];
    }
    function track(op) {
      var k = keyOf(op.operationId);
      if (!S.ops.has(k)) S.opOrder.push(k);
      S.ops.set(k, Object.assign(S.ops.get(k) || {}, op));
      return S.ops.get(k);
    }

    // -------------------------------------------------------------- sync
    function sync(opts) {
      if (S.disposed) return Promise.resolve();
      if (closedReason) { render(); return Promise.resolve(); }
      var filters = opts && isObj(opts.filters) ? opts.filters : S.filters;
      startSync(filters, false);
      return S.inflight ? S.inflight.voided : Promise.resolve();
    }
    function startSync(filters, force) {
      var key = stable(filters);
      if (!force && S.inflight && S.inflight.key === key) return S.inflight.promise;
      var gen = ++S.generation;
      // Leitura já iniciada não é cancelada: geração antiga só tem a resposta descartada.
      if (key !== S.filtersKey) clearProjection(true);
      S.filters = filters; S.filtersKey = key; S.loading = true; render();
      var p = run(gen, filters).then(function (ok) {
        if (S.inflight && S.inflight.gen === gen) S.inflight = null;
        return ok;
      });
      S.inflight = { key: key, gen: gen, promise: p, voided: p.then(function () {}) };
      return p;
    }
    function stale(gen) { return S.disposed || gen !== S.generation; }
    function run(gen, filters) {
      var raw, failed = false, skipped = false;
      return Promise.resolve().then(function () {
        // Guarda pré-invocação: após dispose (ou geração superada) o callback agendado não chama o gateway.
        if (stale(gen)) { skipped = true; return; }
        return gateway.context();
      }).then(function (c) { raw = c; }, function () { failed = true; })
        .then(function () {
          if (skipped || stale(gen)) return false;
          if (failed) {
            clearProjection(false); S.ctx = null; S.rawCtx = null; S.loading = false;
            S.ctxError = 'Não foi possível confirmar sessão, marca e papel. Dados retirados da tela; nada foi interpretado como zero.';
            render(); return false;
          }
          var cr = N.context(raw);
          if (cr.error) { clearScope(); S.ctx = null; S.rawCtx = null; S.scopeKey = null; S.draftScope = null; S.ctxError = cr.error; S.loading = false; render(); return false; }
          applyContext(cr.context, raw); render();
          return Promise.all(RESOURCES.map(function (r) { return readOne(r, filters, raw, cr.context, function () { return !stale(gen); }); })).then(function (results) {
            if (stale(gen)) return false;
            var forbidden = null, ok = true;
            results.forEach(function (r) { if (r.env && r.env.state === 'forbidden') forbidden = forbidden || r.env.error || 'Acesso recusado.'; });
            if (forbidden) { revoke(forbidden); S.loading = false; render(); return false; }
            results.forEach(function (r) {
              if (r.env) { S.envs[r.resource] = r.env; return; }
              ok = false;
              var prev = S.envs[r.resource];
              if (prev && (prev.state === 'ready' || prev.state === 'empty')) { prev.refreshFailed = true; prev.refreshError = r.error; }
              else S.envs[r.resource] = { state: 'error', error: r.error };
            });
            noteIdentityKind();
            S.loading = false; render();
            if (S.profile) return loadProfile(gen, S.profile.creatorId).then(function (p) { return ok && p; });
            return ok;
          });
        });
    }
    // alive(): ciclo de vida capturado pelo chamador, conferido imediatamente antes de invocar read.
    function readOne(resource, syncFilters, rawCtx, ctx, alive, extra) {
      var raw = {};
      Object.keys(syncFilters || {}).forEach(function (k) { raw[k] = syncFilters[k]; });
      if (extra) Object.keys(extra).forEach(function (k) { raw[k] = extra[k]; });
      var vf = N.filters(raw, resource);
      if (vf.error) return Promise.resolve({ resource: resource, error: 'Filtro recusado: ' + vf.error });
      var skipped = false;
      return Promise.resolve().then(function () {
        if (!alive()) { skipped = true; return; }
        return gateway.read({ resource: resource, filters: vf.filters, expectedContextRevision: ctx.contextRevision }, {});
      }).then(function (env) {
        if (skipped) return { resource: resource, error: READ_UNAVAILABLE, skipped: true };
        var r = N.envelope(env, rawCtx, resource, vf.filters);
        return r.env ? { resource: resource, env: r.env } : { resource: resource, error: r.error };
      }, function () {
        // Rejeição bruta não é motivo público: nada do objeto/mensagem/stack é inspecionado ou projetado.
        return { resource: resource, error: READ_UNAVAILABLE };
      });
    }
    // Modo de identidade da coleção (uniforme, garantido pelo normalizador). Troca de modo descarta seleção antiga.
    function noteIdentityKind() {
      var env = S.envs.creators;
      var kind = env && env.state === 'ready' && env.items && env.items.length ? env.items[0].identityKind : null;
      if (!kind) return;
      if (S.identityKind !== null && S.identityKind !== kind) {
        S.profile = null; S.form = null; S.ui.provider = '';
        S.notices.push({ tone: 'warn', text: MODE_CHANGED });
      }
      S.identityKind = kind;
    }
    // Perfil só vale com o mesmo modo, ID, revisão e identidade do registro listado.
    function coherentProfile(c) {
      if (!c || (S.identityKind !== null && c.identityKind !== S.identityKind)) return false;
      if (!usable(S.envs.creators)) return true;
      var listed = findIn('creators', c.id);
      if (!listed) return false;
      return ['identityKind', 'brandId', 'revision', 'provider', 'providerId', 'identitySource', 'sourceRecordId', 'sourceRecordRevision'].every(function (k) { return listed[k] === c[k]; });
    }
    function loadProfile(gen, creatorId) {
      if (!S.ctx || closedReason) return Promise.resolve(false);
      var token = {}, same = S.profile && S.profile.creatorId === creatorId;
      S.profile = { creatorId: creatorId, token: token, env: same ? S.profile.env : null, perf: same ? S.profile.perf : null, loading: true };
      render();
      var ctx = S.ctx, raw = S.rawCtx;
      var alive = function () { return !stale(gen) && !!S.profile && S.profile.token === token; };
      return Promise.all([
        readOne('creator-profile', S.filters, raw, ctx, alive, { creatorId: creatorId }),
        readOne('own-performance', S.filters, raw, ctx, alive, { creatorId: creatorId })
      ]).then(function (r) {
        if (stale(gen) || !S.profile || S.profile.token !== token) return false;
        var forbidden = r.filter(function (x) { return x.env && x.env.state === 'forbidden'; })[0];
        if (forbidden) { revoke(forbidden.env.error); render(); return false; }
        var penv = r[0].env, perr = r[0].error;
        if (penv && penv.state === 'ready' && !coherentProfile(penv.creator)) { penv = null; perr = PROFILE_INCOHERENT; }
        S.profile.env = penv || { state: 'error', error: perr };
        S.profile.perf = r[1].env || { state: 'error', error: r[1].error };
        S.profile.loading = false; render();
        return !!(penv && r[1].env);
      });
    }

    // -------------------------------------------------------------- recibo (somente leitura do ID original)
    function consultReceipt(k) {
      var op = S.ops.get(k);
      if (!op || !S.ctx || !canReceipt || S.receiptBusy.has(k)) return Promise.resolve();
      var scope = S.scopeKey, ctxRev = S.ctx.contextRevision, brand = S.ctx.effectiveBrand;
      var skipped = false;
      S.receiptBusy.add(k); render();
      return Promise.resolve().then(function () {
        // Mesma guarda pré-invocação para receipt: sem invocação após dispose ou mudança de escopo/revisão.
        if (S.disposed || S.scopeKey !== scope || !S.ctx || S.ctx.contextRevision !== ctxRev) { skipped = true; return; }
        return gateway.receipt({ operationId: op.operationId, expectedContextRevision: ctxRev });
      }).then(function (res) {
        if (S.disposed || S.scopeKey !== scope) return;
        if (skipped) { op.reason = 'Consulta não iniciada: o contexto mudou. Nada foi enviado.'; return; }
        if (!S.ctx || S.ctx.contextRevision !== ctxRev) return;
        if (!N.operation(res, ctxRev, brand, op.operationId)) { op.reason = 'Recibo sem vínculo válido com marca, contexto e operação original; a operação continua pendente.'; return; }
        op.receiptReference = res.receiptReference == null ? null : res.receiptReference;
        op.reason = typeof res.reason === 'string' ? res.reason : null;
        if (res.state === 'confirmed' || res.state === 'rejected') {
          op.state = res.state;
          if (res.state === 'confirmed') { op.refresh = 'running'; render(); return startSync(S.filters, true).then(function (ok) { if (!S.disposed && S.ops.get(k) === op) op.refresh = ok ? 'done' : 'pending'; }); }
        } else { op.state = res.state === 'prepared' ? 'pending' : res.state; op.reason = op.reason || 'Ainda sem resultado final no servidor. Nada foi reenviado.'; }
      }, function () {
        if (S.disposed || S.scopeKey !== scope) return;
        op.reason = RECEIPT_UNAVAILABLE;
      }).then(function () { S.receiptBusy.delete(k); if (!S.disposed) { S.focusKey = 'status'; render(); } });
    }

    // -------------------------------------------------------------- projeção
    function usable(env) { return !!env && (env.state === 'ready' || env.state === 'empty') && Array.isArray(env.items); }
    function confirmedEmpty(env) { return !!env && env.state === 'empty' && env.coverage === 'complete' && env.freshness === 'fresh' && !env.refreshFailed; }
    function writableReason(env, label) {
      if (!env) return label + ': fonte ainda não carregada.';
      if (env.state === 'error') return label + ': leitura com erro.';
      if (env.state !== 'ready' && env.state !== 'empty') return label + ': fonte indisponível.';
      if (env.refreshFailed) return label + ': última leitura falhou; somente leitura.';
      if (env.freshness !== 'fresh') return label + ': fonte antiga ou com frescor desconhecido.';
      if (env.coverage !== 'complete') return label + ': cobertura parcial ou desconhecida.';
      return null;
    }
    function findIn(resource, id) {
      var env = S.envs[resource]; if (!env || !env.items) return null;
      for (var i = 0; i < env.items.length; i++) if (env.items[i].id === id) return env.items[i];
      return null;
    }
    function creatorByKey(k) {
      var env = S.envs.creators; if (!env || !env.items) return null;
      for (var i = 0; i < env.items.length; i++) if (keyOf(env.items[i].id) === k) return env.items[i];
      return null;
    }
    function stageInfo(value) {
      var cat = S.ctx && S.ctx.stageCatalog;
      if (value == null || value === '') return { label: 'Sem etapa', catalogued: false, literal: true };
      if (cat) for (var i = 0; i < cat.items.length; i++) if (cat.items[i].value === value) return { label: cat.items[i].label, catalogued: true, terminal: cat.items[i].terminal };
      return { label: String(value), catalogued: false, literal: true };
    }
    function taskStateLabel(value) {
      var cat = S.ctx && S.ctx.taskStateCatalog;
      if (cat) for (var i = 0; i < cat.items.length; i++) if (cat.items[i].value === value) return cat.items[i].label;
      return str(value) + (cat ? ' (fora do catálogo)' : ' (sem catálogo)');
    }
    function nextStepView(creatorId) {
      var r = N.nextStep(S.envs.tasks, creatorId);
      if (r.state === 'ready') return { state: 'ready', text: str(r.task.label) + ' · ' + taskStateLabel(r.task.state), due: r.task.dueAt ? fmtDate(r.task.dueAt) : 'Sem prazo' };
      if (r.state === 'empty') return { state: 'empty', text: 'Sem próximo passo registrado', due: '—' };
      return { state: 'unavailable', text: 'Indisponível', due: '—', title: 'Exige tarefas completas, atuais, com catálogo de situação e prazo civil válidos.' };
    }
    function gate(kind, recordId, creatorId) {
      var spec = MUTATIONS[kind], ctx = S.ctx, reasons = [WRITES_OFF_REASON];
      if (!ctx) return { open: false, canView: false, reasons: reasons.concat('Contexto não confirmado.') };
      var canView = ctx.role === 'write' || ctx.role === 'master';
      if (!canView) reasons.push('Papel sem escrita (' + ctx.role + ').');
      var cap = ctx.capabilities[kind];
      if (!cap || cap.available !== true) reasons.push(cap && cap.reason ? cap.reason : 'Capacidade indisponível para esta marca/papel.');
      var j = ctx.operationJournal;
      if (j.state !== 'complete') reasons.push('Journal integral não confirmado; IDs conhecidos ficam somente para recibo.');
      else if (j.preparationRecovery !== 'quiescent') reasons.push('Recuperação de preparação ' + j.preparationRecovery + ': sem prova causal Root de quiescência.');
      var open = []; S.ops.forEach(function (op) { if (op.state !== 'confirmed' && op.state !== 'rejected') open.push(op); });
      if (open.length) reasons.push('Há operação sem resultado final; somente consulta de recibo.');
      var w = writableReason(S.envs[spec.resource], RESOURCE_LABEL[spec.resource]); if (w) reasons.push(w);
      if (spec.blocked) reasons.push(spec.blocked);
      if (spec.record) {
        var rec = findIn(spec.record, recordId);
        if (!rec) { reasons.push('Registro não encontrado na leitura atual.'); canView = false; }
      }
      if (spec.scoped && !findIn('creators', creatorId)) { reasons.push('Criador não encontrado na leitura atual.'); canView = false; }
      return { open: WRITES_ENABLED && reasons.length === 0, canView: canView, reasons: reasons };
    }

    // -------------------------------------------------------------- formulários (prévia, sem envio)
    function fieldsOf(form) {
      var f = MUTATIONS[form.kind].fields;
      return form.variant === 'move' ? f.filter(function (x) { return x.name === 'stage'; }) : f;
    }
    function fieldClosed(f) {
      if (f.type === 'stage' && !(S.ctx && S.ctx.stageCatalog)) return 'Catálogo de etapas não informado por Root: campo fechado.';
      if (f.type === 'task-state' && !(S.ctx && S.ctx.taskStateCatalog)) return 'Catálogo de situações não informado por Root: campo fechado.';
      return null;
    }
    function draftFor(form) {
      var d = S.drafts.get(form.key); if (d) return d;
      var spec = MUTATIONS[form.kind], rec = spec.record ? findIn(spec.record, form.recordId) : null, values = {};
      fieldsOf(form).forEach(function (f) {
        var v = rec ? rec[f.name] : null;
        values[f.name] = v == null ? '' : f.type === 'date' ? (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '') : String(v);
      });
      d = { values: values, base: Object.assign({}, values) };
      S.drafts.set(form.key, d); return d;
    }
    function buildIntent(form) {
      var spec = MUTATIONS[form.kind], d = draftFor(form), payload = {}, errors = [];
      fieldsOf(form).forEach(function (f) {
        if (fieldClosed(f)) return;
        var v = str(d.values[f.name]).trim(), changed = v !== str(d.base[f.name]).trim();
        if (v && f.type === 'date' && !N.civilDate(v)) errors.push(f.label + ': data civil inválida.');
        if (v && f.type === 'url' && !/^https?:\/\/[^\s<>"']+$/i.test(v)) errors.push(f.label + ': use http(s).');
        if (spec.record) {
          if (!changed) return;
          if (v === '') { if (f.clearable) payload[f.name] = null; else errors.push(f.label + ' não pode ser limpo.'); }
          else payload[f.name] = v;
        } else {
          if (f.required && !v) errors.push(f.label + ' é obrigatório.');
          if (v) payload[f.name] = v;
        }
      });
      var intent = { kind: form.kind, payload: payload, expectedContextRevision: S.ctx ? S.ctx.contextRevision : null };
      if (spec.scoped) payload.creatorId = form.creatorId;
      if (spec.record) {
        var rec = findIn(spec.record, form.recordId);
        intent.recordId = rec ? rec.id : null; intent.expectedRecordRevision = rec ? rec.revision : null;
        if (form.kind !== 'creator.archive' && !Object.keys(payload).length) errors.push('Nenhuma alteração para registrar.');
      } else { intent.recordId = null; intent.expectedRecordRevision = null; }
      return { intent: intent, errors: errors };
    }
    function openForm(kind, recordId, creatorId, variant, profileId) {
      var g = gate(kind, recordId, creatorId); if (!g.canView) return;
      var key = kind + ':' + keyOf(recordId) + ':' + keyOf(creatorId) + (variant ? ':' + variant : '');
      S.form = { key: key, kind: kind, recordId: recordId, creatorId: creatorId, variant: variant || null, profileId: profileId, mode: fieldsOf({ kind: kind, variant: variant }).length ? 'edit' : 'review', error: null };
      draftFor(S.form); S.focusKey = S.form.mode === 'edit' ? 'form-first' : 'form-back'; render();
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
      (function add(list) { list.forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        if (Array.isArray(c)) add(c); else if (typeof c === 'string' || typeof c === 'number') el.appendChild(doc.createTextNode(String(c))); else el.appendChild(c);
      }); })(kids);
      if (value !== undefined) el.value = value;
      return el;
    }
    function select(attrs, options, current) {
      var el = h('select', attrs, options.map(function (o) { return h('option', { value: o.value, selected: String(o.value) === String(current) ? true : null, text: o.label }); }));
      el.value = str(current); return el;
    }
    function tag(text, tone, title) { return h('span', { class: 'saf3-tag saf3-tag--' + (tone || 'neutral'), title: title || null, text: text }); }
    function reasonsLine(gates) {
      var seen = {}, list = [];
      gates.forEach(function (g) { g.reasons.forEach(function (r) { if (!seen[r]) { seen[r] = 1; list.push(r); } }); });
      // Ressalva compacta: um resumo de uma linha, motivos completos ao expandir (teclado: Enter/Espaço no summary).
      return list.length ? h('details', { class: 'saf3-closed' }, h('summary', { text: 'Gravação fechada · ' + list.length + (list.length > 1 ? ' motivos' : ' motivo') }), h('ul', null, list.map(function (r) { return h('li', { text: r }); }))) : null;
    }
    function formButton(label, kind, recordId, creatorId, profileId, g) {
      return h('button', { type: 'button', class: 'saf3-btn', 'data-saf3-act': 'open-form', 'data-kind': kind, 'data-record': recordId == null ? null : keyOf(recordId), 'data-creator': creatorId == null ? null : keyOf(creatorId), 'data-profile': profileId == null ? null : keyOf(profileId), 'data-saf3-key': 'form:' + kind + ':' + keyOf(recordId) + ':' + keyOf(creatorId), disabled: !g.canView, title: g.reasons.join(' ') }, label);
    }
    function sourceLine(env, resource, extraPeriod) {
      if (!env || env.state === 'error' || env.state === 'forbidden') return null;
      var bits = [
        h('span', { text: 'Origem: ' + SOURCE_LABEL[env.source] }),
        h('span', { text: 'Marca: ' + brandLabel() }),
        h('span', { text: 'Cobertura: ' + COVERAGE_LABEL[env.coverage] }),
        h('span', { text: 'Frescor: ' + FRESHNESS_LABEL[env.freshness] }),
        h('span', { text: 'Coletado: ' + (fmtDate(env.collectedAt) || 'não informado') }),
        env.cacheAt ? h('span', { text: 'Cache: ' + fmtDate(env.cacheAt) }) : null
      ];
      var per = env.data && env.data.period ? periodText(env.data.period) : (extraPeriod ? periodText(S.filters.period) : null);
      if (per) bits.push(h('span', { text: 'Período confirmado: ' + per }));
      var tags = [];
      if (env.coverage === 'partial') tags.push(tag('Coleta parcial — não é o universo completo', 'warn'));
      if (env.coverage === 'unknown') tags.push(tag('Cobertura desconhecida', 'warn'));
      if (env.freshness !== 'fresh') tags.push(tag(env.freshness === 'stale' ? 'Dados antigos — somente leitura' : 'Frescor desconhecido', 'warn'));
      if (env.refreshFailed) tags.push(tag('Última atualização falhou — leitura anterior, somente leitura', 'bad', env.refreshError));
      return h('div', { class: 'saf3-source', 'data-saf3-source': resource }, bits, tags);
    }
    function stateBlock(env, resource, loading) {
      var label = RESOURCE_LABEL[resource];
      if (!env) return loading ? h('p', { class: 'saf3-state', 'data-saf3-state': 'loading', 'aria-busy': 'true', text: 'Carregando ' + label.toLowerCase() + '…' }) : h('p', { class: 'saf3-state', 'data-saf3-state': 'idle', text: label + ': ainda não lido.' });
      if (env.state === 'error') return h('p', { class: 'saf3-state saf3-state--bad', 'data-saf3-state': 'error', text: label + ': ' + env.error + ' Nada foi interpretado como zero.' });
      if (env.state === 'unavailable') return h('p', { class: 'saf3-state saf3-state--warn', 'data-saf3-state': 'unavailable', text: label + ': fonte indisponível' + (env.error ? ' (' + env.error + ')' : '') + '. Nada foi interpretado como zero.' });
      if (env.state === 'empty') return confirmedEmpty(env)
        ? h('p', { class: 'saf3-state', 'data-saf3-state': 'empty-confirmed', text: label + ': nenhum registro (vazio confirmado pela fonte).' })
        : h('p', { class: 'saf3-state saf3-state--warn', 'data-saf3-state': 'empty-unconfirmed', text: label + ': vazio informado, mas a leitura não está atual — não confirma ausência.' });
      if (env.items && env.items.length === 0) return h('p', { class: 'saf3-state saf3-state--warn', 'data-saf3-state': 'empty-unconfirmed', text: label + ': nenhum registro nesta leitura parcial — não confirma ausência.' });
      return null;
    }
    function brandLabel() { return S.ctx && S.ctx.effectiveBrandLabel ? S.ctx.effectiveBrandLabel : 'Marca não informada'; }
    function countCell(resource, creatorId) {
      var env = S.envs[resource];
      if (!usable(env)) return h('span', { class: 'saf3-muted', title: RESOURCE_LABEL[resource] + ' indisponível', text: '—' });
      var n = env.items.filter(function (x) { return x.creatorId === creatorId; }).length;
      var qualified = env.coverage !== 'complete' || env.freshness !== 'fresh' || env.refreshFailed;
      return h('span', { text: String(n) + (qualified ? ' (parcial/antigo)' : '') });
    }
    function filteredCreators() {
      var env = S.envs.creators; if (!env || !env.items) return [];
      var q = S.ui.search.trim().toLowerCase();
      return env.items.filter(function (c) {
        if (S.ui.stage && keyOf(c.stage == null ? '' : c.stage) !== S.ui.stage) return false;
        if (S.ui.owner && str(c.ownerReference) !== S.ui.owner) return false;
        if (S.ui.provider && str(c.provider) !== S.ui.provider) return false;
        if (q && (str(c.displayName) + ' ' + str(c.handle)).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }
    function distinct(items, field) {
      var seen = {}, out = [];
      (items || []).forEach(function (x) { var v = str(x[field]); if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
      return out.sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
    }
    function stageOptions(items) {
      var cat = S.ctx && S.ctx.stageCatalog, out = [], seen = {};
      if (cat) cat.items.forEach(function (s) { seen[keyOf(s.value)] = 1; out.push({ value: keyOf(s.value), label: s.label }); });
      var rest = {};
      (items || []).forEach(function (c) { var k = keyOf(c.stage == null ? '' : c.stage); if (!seen[k]) rest[k] = c.stage == null || c.stage === '' ? 'Sem etapa' : String(c.stage) + (cat ? ' (fora do catálogo)' : ''); });
      Object.keys(rest).sort(function (a, b) { return rest[a].localeCompare(rest[b], 'pt-BR'); }).forEach(function (k) { out.push({ value: k, label: rest[k] }); });
      return out;
    }
    function dupHandles() {
      var count = {}, dup = {}, env = S.envs.creators;
      (env && env.items || []).forEach(function (c) { var k = str(c.handle).replace(/^@/, '').toLowerCase(); if (k) count[k] = (count[k] || 0) + 1; });
      Object.keys(count).forEach(function (k) { if (count[k] > 1) dup[k] = 1; });
      return dup;
    }
    function platformCell(c) {
      if (ownRecord(c)) return h('span', { class: 'saf3-tag saf3-tag--neutral', 'data-saf3-platform': 'unlinked', title: UNLINKED_TITLE, text: UNLINKED });
      return [h('span', { text: str(c.provider) }), h('span', { class: 'saf3-muted', text: ' · ' + str(c.providerId) })];
    }
    function dupTitle(c) { return 'Mesmo @handle em registros distintos: identidade é ' + (ownRecord(c) ? 'o cadastro próprio (UUID + marca + versão)' : 'provedor + marca + ID persistido') + '.'; }
    function creatorName(c) { return h('span', { class: 'saf3-name' }, h('strong', { text: str(c.displayName) }), c.handle ? h('span', { class: 'saf3-muted', text: ' @' + str(c.handle).replace(/^@/, '') }) : null); }
    function stageCell(c) {
      var s = stageInfo(c.stage);
      return [h('span', { text: s.label }), s.literal && c.stage ? tag(S.ctx && S.ctx.stageCatalog ? 'fora do catálogo' : 'sem catálogo', 'neutral', 'Etapa literal informada pela fonte; ordem e terminalidade não inferidas.') : null, s.terminal === true ? tag('terminal', 'neutral') : null];
    }
    function openProfileButton(c, prefix, label) {
      return h('button', { type: 'button', class: 'saf3-btn saf3-btn--ghost', 'data-saf3-act': 'open-profile', 'data-id': keyOf(c.id), 'data-saf3-key': prefix + keyOf(c.id), 'aria-label': 'Abrir perfil de ' + str(c.displayName) }, label);
    }
    function renderTable(list) {
      var dup = dupHandles();
      return h('div', { class: 'saf3-table-wrap', role: 'region', 'aria-label': 'Tabela de criadores', tabindex: '0', 'data-saf3-key': 'table-region' },
        h('table', { class: 'saf3-table', 'data-saf3-view': 'table' },
          h('caption', { class: 'saf3-sr', text: 'Criadores da marca ' + brandLabel() }),
          h('thead', null, h('tr', null, ['Criador', 'Provedor', 'Etapa', 'Responsável', 'Próximo passo', 'Prazo', 'Amostras', 'Conteúdos'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, list.map(function (c) {
            var n = nextStepView(c.id);
            return h('tr', { 'data-saf3-creator-id': keyOf(c.id) },
              // Ação de perfil junto da identidade (primeira coluna, fixa à esquerda na região rolável).
              h('td', null, creatorName(c), dup[str(c.handle).replace(/^@/, '').toLowerCase()] ? tag('handle repetido · não unido', 'neutral', dupTitle(c)) : null, openProfileButton(c, 'open:', 'Abrir perfil')),
              h('td', null, platformCell(c)),
              h('td', null, stageCell(c)),
              h('td', { text: str(c.ownerReference) || '—' }),
              h('td', { 'data-saf3-next': n.state, title: n.title || null, text: n.text }),
              h('td', { text: n.due }),
              h('td', null, countCell('samples', c.id)),
              h('td', null, countCell('content', c.id)));
          }))));
    }
    function renderKanban(list) {
      var cat = S.ctx && S.ctx.stageCatalog, cols = [];
      if (cat) cat.items.forEach(function (s) { cols.push({ key: 'cat:' + keyOf(s.value), title: s.label, terminal: s.terminal, items: list.filter(function (c) { return c.stage === s.value; }) }); });
      var rest = list.filter(function (c) { return !cat || !cat.items.some(function (s) { return s.value === c.stage; }); });
      if (rest.length || !cat) cols.push({ key: 'rest', title: cat ? 'Fora do catálogo ou sem etapa' : 'Sem catálogo de etapas', note: 'Etapas literais; nenhuma ordem de funil inferida.', items: rest });
      return h('div', { class: 'saf3-kanban', 'data-saf3-view': 'kanban', role: 'region', 'aria-label': 'Funil de criadores' }, cols.map(function (col) {
        return h('section', { class: 'saf3-col', 'data-saf3-col': col.key, 'aria-label': col.title + ', ' + col.items.length + ' criador(es)' },
          h('h4', { class: 'saf3-col-title' }, col.title, h('span', { class: 'saf3-muted', text: ' ' + col.items.length }), col.terminal === true ? tag('terminal', 'neutral') : null),
          col.note ? h('p', { class: 'saf3-muted saf3-small', text: col.note }) : null,
          h('ul', { class: 'saf3-cards' }, col.items.map(function (c) {
            var n = nextStepView(c.id), g = gate('creator.update', c.id);
            var targets = cat ? cat.items.filter(function (s) { return s.value !== c.stage; }) : [];
            return h('li', { class: 'saf3-card', 'data-saf3-creator-id': keyOf(c.id) },
              creatorName(c),
              h('p', { class: 'saf3-muted', text: [ownRecord(c) ? UNLINKED : str(c.provider), c.ownerReference ? 'resp. ' + str(c.ownerReference) : '', col.key === 'rest' ? 'etapa: ' + stageInfo(c.stage).label : ''].filter(Boolean).join(' · ') }),
              h('p', { class: 'saf3-next', 'data-saf3-next': n.state, text: 'Próximo: ' + n.text + (n.state === 'ready' ? ' · ' + n.due : '') }),
              h('div', { class: 'saf3-card-actions' },
                openProfileButton(c, 'kopen:', 'Perfil'),
                targets.length && g.canView ? [
                  h('label', { class: 'saf3-sr', for: 'saf3-move-' + keyOf(c.id), text: 'Mover ' + str(c.displayName) + ' para' }),
                  select({ id: 'saf3-move-' + keyOf(c.id), class: 'saf3-select', 'data-saf3-move-target': keyOf(c.id), 'data-saf3-key': 'move-target:' + keyOf(c.id) }, targets.map(function (s) { return { value: keyOf(s.value), label: s.label }; }), keyOf(targets[0].value)),
                  h('button', { type: 'button', class: 'saf3-btn', 'data-saf3-act': 'move-review', 'data-id': keyOf(c.id), 'data-saf3-key': 'move:' + keyOf(c.id) }, 'Prévia de movimento')
                ] : null),
              cat ? null : h('p', { class: 'saf3-closed saf3-small', text: 'Movimento fechado: catálogo de etapas não informado por Root.' }));
          })));
      }));
    }
    function renderForm() {
      var form = S.form; if (!form) return null;
      var spec = MUTATIONS[form.kind], d = draftFor(form), g = gate(form.kind, form.recordId, form.creatorId);
      var who = form.creatorId != null ? findIn('creators', form.creatorId) : form.kind.indexOf('creator.') === 0 && form.recordId != null ? findIn('creators', form.recordId) : null;
      var body;
      if (form.mode === 'edit') {
        body = h('div', { class: 'saf3-fields' }, fieldsOf(form).map(function (f, i) {
          var id = 'saf3-f-' + f.name, key = 'field:' + form.key + ':' + f.name, closed = fieldClosed(f), opts = null, input;
          if (f.type === 'stage' && !closed) opts = S.ctx.stageCatalog.items.map(function (s) { return { value: s.value, label: s.label }; });
          if (f.type === 'task-state' && !closed) opts = S.ctx.taskStateCatalog.items.map(function (s) { return { value: s.value, label: s.label }; });
          if (f.type === 'sku' && usable(S.envs.products)) opts = distinct(S.envs.products.items, 'sku').map(function (v) { return { value: v, label: v }; });
          if (closed) input = h('input', { id: id, class: 'saf3-input', type: 'text', disabled: true, value: d.values[f.name], 'data-saf3-key': key, 'aria-describedby': id + '-closed' });
          else if (opts) {
            var cur = d.values[f.name];
            if (cur && !opts.some(function (o) { return o.value === cur; })) opts = [{ value: cur, label: cur + ' (valor atual fora do catálogo)' }].concat(opts);
            input = select({ id: id, class: 'saf3-select', 'data-saf3-field': f.name, 'data-saf3-key': key }, [{ value: '', label: f.required || f.requiredWhenPresent ? 'Selecione' : '(vazio)' }].concat(opts), cur);
          } else input = h('input', { id: id, class: 'saf3-input', type: f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text', 'data-saf3-field': f.name, 'data-saf3-key': key, value: d.values[f.name], autocomplete: 'off' });
          if (i === 0 && S.focusKey === 'form-first') S.focusKey = key;
          return h('div', { class: 'saf3-field' }, h('label', { for: id, text: f.label + (f.required ? ' *' : '') }), input, closed ? h('span', { id: id + '-closed', class: 'saf3-muted saf3-small', text: closed }) : null);
        }));
      } else {
        var b = buildIntent(form), p = b.intent.payload;
        body = h('div', { class: 'saf3-review' },
          h('p', { text: 'Prévia da intenção conforme allowlist 1.0.2/1.0.3 — NÃO enviada:' }),
          h('dl', { class: 'saf3-dl', 'data-saf3-preview': form.kind },
            h('dt', { text: 'Ação' }), h('dd', { text: form.kind }),
            h('dt', { text: 'Registro / revisão' }), h('dd', { text: b.intent.recordId == null ? 'novo (ID e revisão serão do servidor)' : str(b.intent.recordId) + ' / ' + str(b.intent.expectedRecordRevision) }),
            Object.keys(p).filter(function (k) { return k !== 'creatorId'; }).map(function (k) {
              var f = spec.fields.filter(function (x) { return x.name === k; })[0];
              return [h('dt', { text: f ? f.label : k }), h('dd', { 'data-saf3-payload': k, text: p[k] === null ? '(limpar)' : str(p[k]) })];
            })),
          b.errors.length ? h('p', { class: 'saf3-state saf3-state--bad', role: 'alert', text: b.errors.join(' ') }) : null);
      }
      var actions = form.mode === 'edit'
        ? [h('button', { type: 'button', class: 'saf3-btn', 'data-saf3-act': 'form-review', 'data-saf3-key': 'form-review' }, 'Ver prévia'),
           h('button', { type: 'button', class: 'saf3-btn saf3-btn--ghost', 'data-saf3-act': 'form-cancel', 'data-saf3-key': 'form-cancel' }, 'Fechar (mantém rascunho)')]
        : [h('button', { type: 'button', class: 'saf3-btn saf3-btn--primary', 'data-saf3-act': 'form-confirm', 'data-saf3-key': 'form-confirm', disabled: true, 'aria-describedby': 'saf3-form-closed' }, 'Confirmar (desligado)'),
           h('button', { type: 'button', class: 'saf3-btn saf3-btn--ghost', 'data-saf3-act': 'form-back', 'data-saf3-key': 'form-back' }, form.variant === 'move' || !fieldsOf(form).length ? 'Fechar' : 'Voltar')];
      var closedLine = reasonsLine([g]); if (closedLine) closedLine.setAttribute('id', 'saf3-form-closed');
      return h('section', { class: 'saf3-form', 'data-saf3-form': form.kind, 'aria-labelledby': 'saf3-form-title' },
        h('h4', { id: 'saf3-form-title', text: (form.variant === 'move' ? 'Mudar etapa' : spec.title) + (who ? ' — ' + str(who.displayName) : '') }),
        spec.warn ? h('p', { class: 'saf3-warn', text: spec.warn }) : null,
        form.error ? h('p', { class: 'saf3-state saf3-state--bad', role: 'alert', text: form.error }) : null,
        body, h('div', { class: 'saf3-actions' }, actions), closedLine);
    }
    function renderOps() {
      if (!S.ctx) return null;
      var j = S.ctx.operationJournal;
      var jText = j.state === 'complete' ? 'Journal Root completo (revisão ' + str(j.revision) + ') · recuperação de preparação: ' + j.preparationRecovery : 'Journal integral não confirmado — novas gravações fechadas; IDs conhecidos só para recibo.';
      return h('section', { class: 'saf3-ops', 'aria-label': 'Operações e journal', 'data-saf3-journal': j.state, 'data-saf3-recovery': j.preparationRecovery },
        h('h3', { text: 'Operações' }),
        h('p', { class: 'saf3-muted', text: jText + (j.reason ? ' (' + j.reason + ')' : '') }),
        S.opOrder.length ? h('ul', null, S.opOrder.map(function (k) {
          var op = S.ops.get(k); if (!op) return null;
          var needs = op.state !== 'confirmed' && op.state !== 'rejected';
          return h('li', { 'data-saf3-op': k, 'data-saf3-op-state': op.state },
            h('span', { text: 'Operação ' + str(op.operationId) + ' · ' + (OP_LABEL[op.state] || op.state) }),
            op.listed === false && needs ? tag('não listada na última leitura — continua só para recibo', 'warn') : null,
            op.receiptReference ? h('span', { class: 'saf3-muted', text: ' · recibo ' + str(op.receiptReference) }) : null,
            op.reason ? h('span', { class: 'saf3-muted', text: ' · ' + op.reason }) : null,
            op.state === 'confirmed' && op.refresh === 'pending' ? tag('Confirmada. Atualização da leitura pendente (falhou)', 'warn') : null,
            needs ? h('button', { type: 'button', class: 'saf3-btn saf3-btn--ghost', 'data-saf3-act': 'receipt', 'data-op': k, 'data-saf3-key': 'receipt:' + k, disabled: !canReceipt || S.receiptBusy.has(k), title: canReceipt ? null : 'Gateway sem receipt: consulta indisponível.' }, S.receiptBusy.has(k) ? 'Consultando…' : 'Consultar recibo') : null);
        })) : h('p', { class: 'saf3-muted', text: 'Nenhuma operação conhecida neste escopo.' }));
    }
    function renderLens(l) {
      var market = l.source === 'market_estimated';
      var settledProved = l.source === 'own_verified' && Number.isSafeInteger(l.settledMinor) && typeof l.settlementProof === 'string' && l.settlementProof.trim() !== '' && typeof l.currency === 'string' && /^[A-Z]{3}$/.test(l.currency);
      function cell(key, title, note, minor, extra) {
        var f = fmtMinor(minor, l.currency);
        return h('div', { class: 'saf3-stat', 'data-saf3-commission': key, 'data-saf3-value-kind': f.kind },
          h('span', { class: 'saf3-stat-label', text: title }), h('strong', { class: 'saf3-stat-value', text: f.text }), h('span', { class: 'saf3-muted', text: note }), extra || null);
      }
      var settledTag = settledProved ? tag('Liquidação comprovada (' + l.settlementProof + ')', 'good') : l.settledMinor != null ? tag('Sem prova própria de liquidação — não é “paga”', 'warn') : null;
      var metrics = isObj(l.metrics) ? Object.keys(l.metrics).filter(function (k) { var v = l.metrics[k]; return v === null || ['string', 'number', 'boolean'].indexOf(typeof v) >= 0; }) : [];
      return h('article', { class: 'saf3-lens', 'data-saf3-lens': l.lens, 'data-saf3-lens-source': l.source },
        h('h4', null, l.label, ' ', tag(SOURCE_LABEL[l.source], market ? 'warn' : 'neutral'), l.windowMatches ? null : tag('Janela própria da lente difere do período pedido — não comparar', 'warn')),
        h('p', { class: 'saf3-meta' },
          h('span', { text: 'Lente: ' + l.lens }),
          h('span', { text: 'Criador: ' + (l.creatorId == null ? 'programa/marca (não individual)' : str(l.creatorId)) }),
          h('span', { text: 'Provedor: ' + (l.provider || 'não informado') }),
          h('span', { text: 'Atribuição: ' + (l.attributionModel || 'não informada') }),
          h('span', { text: 'Janela: ' + (periodText(l.period) || 'não informada') }),
          h('span', { text: 'Fuso: ' + (l.timezone || 'não informado') }),
          h('span', { text: 'Moeda: ' + (l.currency || 'não informada') }),
          h('span', { text: 'Cobertura: ' + COVERAGE_LABEL[l.coverage] }),
          h('span', { text: 'Frescor: ' + FRESHNESS_LABEL[l.freshness] }),
          h('span', { text: 'Coletado: ' + (fmtDate(l.collectedAt) || 'não informado') }),
          h('span', { text: 'Política: ' + (l.policyVersion ? 'versão ' + l.policyVersion + ' (servidor)' : 'indisponível') })),
        market ? h('p', { class: 'saf3-warn', text: 'Estimativa de mercado: não é receita própria, comissão devida nem pagamento.' }) : null,
        h('div', { class: 'saf3-stats' },
          cell('estimated', market ? 'Estimativa (mercado)' : 'Comissão ESTIMADA', 'Estimativa — inclusive quando informada pelo próprio seller.', l.estimatedMinor),
          market ? null : cell('accrued', 'Comissão APURADA', 'Apurada pela fonte; não é pagamento.', l.accruedMinor),
          market ? null : cell('settled', 'Comissão LIQUIDADA', 'Só é “paga” com prova própria de liquidação.', l.settledMinor, settledTag),
          cell('returns', 'Devoluções', 'Valor separado; nada é descontado ou somado.', l.returnsMinor)),
        metrics.length ? h('dl', { class: 'saf3-dl saf3-small', 'data-saf3-metrics': l.lens }, h('dt', { text: 'Métricas da fonte' }), h('dd', { text: 'sem soma, conversão ou interpretação' }), metrics.map(function (k) { return [h('dt', { text: k }), h('dd', { text: l.metrics[k] === null ? 'indisponível' : String(l.metrics[k]) })]; })) : null);
    }
    function renderPerf(env, scope, loading) {
      var wrap = h('section', { class: 'saf3-perf', 'data-saf3-perf': scope },
        h('h3', { text: scope === 'program' ? 'Desempenho próprio do programa (marca)' : 'Desempenho próprio do criador' }),
        sourceLine(env, 'own-performance'), stateBlock(env, 'own-performance', loading));
      if (env && env.state === 'ready' && env.data && Array.isArray(env.data.lenses)) {
        wrap.appendChild(h('div', { class: 'saf3-lenses' }, env.data.lenses.map(renderLens)));
        wrap.appendChild(h('p', { class: 'saf3-muted', text: 'Lentes alternativas: nunca somadas, completadas ou clonadas. Agregado da marca não preenche criador.' }));
      }
      return wrap;
    }
    function refSection(P, key, collection, title, renderItem) {
      var sec = h('section', { class: 'saf3-sub', 'data-saf3-ref': key }, h('h4', { text: title }));
      var env = P.env;
      if (!env) { sec.appendChild(h('p', { class: 'saf3-state', 'data-saf3-state': 'loading', 'aria-busy': 'true', text: 'Carregando referências…' })); return sec; }
      if (env.state !== 'ready') { sec.appendChild(h('p', { class: 'saf3-state saf3-state--warn', 'data-saf3-state': 'unavailable', text: 'Referências indisponíveis: perfil sem leitura canônica válida.' })); return sec; }
      var rp = env.data.references[key];
      if (rp === null || rp === undefined) { sec.appendChild(h('p', { class: 'saf3-state saf3-state--warn', 'data-saf3-state': 'unavailable', text: 'Sem vínculo persistido informado por Root — indisponível, não é vazio.' })); return sec; }
      if (rp.state === 'unavailable' || rp.state === 'forbidden') { sec.appendChild(h('p', { class: 'saf3-state saf3-state--warn', 'data-saf3-state': 'unavailable', text: 'Referências ' + (rp.state === 'forbidden' ? 'recusadas' : 'indisponíveis') + (rp.reason ? ' (' + rp.reason + ')' : '') + '.' })); return sec; }
      if (rp.coverage !== 'complete') sec.appendChild(tag('Referências com cobertura ' + COVERAGE_LABEL[rp.coverage] + ' — podem faltar registros', 'warn'));
      if (rp.state === 'empty') {
        var ok = env.freshness === 'fresh' && !env.refreshFailed;
        sec.appendChild(h('p', { class: 'saf3-state' + (ok ? '' : ' saf3-state--warn'), 'data-saf3-state': ok ? 'empty-confirmed' : 'empty-unconfirmed', text: ok ? 'Nenhum registro vinculado (vazio confirmado).' : 'Nenhum registro vinculado nesta leitura antiga — não confirma ausência.' }));
        return sec;
      }
      sec.appendChild(h('ul', { class: 'saf3-list' }, rp.items.map(function (id) {
        var rec = findIn(collection, id);
        return h('li', { 'data-saf3-ref-id': keyOf(id) }, rec ? renderItem(rec) : h('span', { class: 'saf3-muted', text: 'Registro ' + str(id) + ' não está na leitura atual de ' + RESOURCE_LABEL[collection].toLowerCase() + ' (indisponível nesta janela).' }));
      })));
      return sec;
    }
    function renderProfile() {
      var P = S.profile; if (!P) return null;
      var id = P.creatorId, c = (P.env && P.env.state === 'ready' && P.env.creator) || findIn('creators', id), n = nextStepView(id);
      var gU = gate('creator.update', id), gA = gate('creator.archive', id), gS = gate('sample.record-manual', null, id), gT = gate('task.create', null, id), gC = gate('content.record-manual', null, id);
      var formHere = S.form && S.form.profileId != null && keyOf(S.form.profileId) === keyOf(id);
      return h('aside', { class: 'saf3-profile', 'aria-labelledby': 'saf3-profile-title', 'data-saf3-profile': keyOf(id) },
        h('div', { class: 'saf3-profile-head' },
          h('h3', { id: 'saf3-profile-title', tabindex: '-1', 'data-saf3-key': 'profile-title' }, c ? str(c.displayName) : 'Perfil'),
          h('button', { type: 'button', class: 'saf3-btn saf3-btn--ghost', 'data-saf3-act': 'close-profile', 'data-saf3-key': 'close-profile' }, 'Fechar perfil')),
        P.env ? sourceLine(P.env, 'creator-profile') : null,
        P.env ? stateBlock(P.env, 'creator-profile') : h('p', { class: 'saf3-state', 'data-saf3-state': 'loading', 'aria-busy': 'true', text: 'Carregando perfil…' }),
        c ? h('dl', { class: 'saf3-dl' },
          h('dt', { text: ownRecord(c) ? 'ID do cadastro próprio' : 'ID persistido' }), h('dd', { 'data-saf3-identity': c.identityKind, text: str(c.id) + ' (revisão ' + str(c.revision) + ')' }),
          ownRecord(c) ? [h('dt', { text: 'Plataforma' }), h('dd', { 'data-saf3-platform': 'unlinked', title: UNLINKED_TITLE, text: UNLINKED + ' — cadastro próprio, sem conta social vinculada.' })]
            : [h('dt', { text: 'Provedor / ID no provedor' }), h('dd', { text: str(c.provider) + ' / ' + str(c.providerId) })],
          h('dt', { text: '@handle' }), h('dd', { text: str(c.handle) || '—' }),
          h('dt', { text: 'Etapa' }), h('dd', { text: stageInfo(c.stage).label + (stageInfo(c.stage).literal && c.stage ? ' (literal)' : '') }),
          h('dt', { text: 'Responsável' }), h('dd', { text: str(c.ownerReference) || '—' }),
          h('dt', { text: 'Próximo passo' }), h('dd', { 'data-saf3-next': n.state, title: n.title || null, text: n.text }),
          h('dt', { text: 'Prazo' }), h('dd', { 'data-saf3-due': '', text: n.due }),
          h('dt', { text: 'Marca' }), h('dd', { text: brandLabel() })) : null,
        h('div', { class: 'saf3-actions' },
          formButton('Editar', 'creator.update', id, null, id, gU), formButton('Arquivar', 'creator.archive', id, null, id, gA),
          formButton('Registrar amostra', 'sample.record-manual', null, id, id, gS), formButton('Nova tarefa', 'task.create', null, id, id, gT),
          formButton('Registrar conteúdo', 'content.record-manual', null, id, id, gC)),
        reasonsLine([gU, gA, gS, gT, gC]),
        formHere ? renderForm() : null,
        refSection(P, 'samples', 'samples', 'Amostras vinculadas (registro manual ≠ envio no TikTok)', function (s) {
          return [h('span', { text: str(s.sku) + ' · ' + str(s.manualStatus) + (s.dueAt ? ' · prazo ' + fmtDate(s.dueAt) : '') }), tag(SOURCE_LABEL[s.source] || 'Origem desconhecida', 'neutral'),
            formButton('Atualizar', 'sample.update-manual', s.id, null, id, gate('sample.update-manual', s.id))];
        }),
        refSection(P, 'products', 'products', 'Produtos vinculados', function (p) { return [h('span', { text: str(p.label) }), h('span', { class: 'saf3-muted', text: ' · SKU ' + str(p.sku) })]; }),
        refSection(P, 'content', 'content', 'Conteúdos vinculados', function (x) {
          var u = typeof x.url === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(x.url) ? x.url : null;
          return [h('span', { text: [str(x.provider), str(x.kind), x.publishedAt ? fmtDate(x.publishedAt) : ''].filter(Boolean).join(' · ') }),
            u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: 'saf3-link' }, ' abrir') : null,
            tag(SOURCE_LABEL[x.source] || 'Origem desconhecida', 'neutral'), formButton('Editar', 'content.update-manual', x.id, null, id, gate('content.update-manual', x.id))];
        }),
        refSection(P, 'tasks', 'tasks', 'Tarefas vinculadas', function (t) {
          var flag = t.open === true ? 'aberta' : t.terminal === true ? 'encerrada' : t.open === false ? 'não aberta' : 'abertura desconhecida';
          return [h('span', { text: str(t.label) + ' · ' + taskStateLabel(t.state) + (t.dueAt ? ' · prazo ' + fmtDate(t.dueAt) : '') }), tag(flag, t.open == null ? 'warn' : 'neutral'),
            formButton('Editar', 'task.update', t.id, null, id, gate('task.update', t.id))];
        }),
        renderPerf(P.perf, 'creator', P.loading));
    }
    function render() {
      if (S.disposed) return;
      var active = doc.activeElement, prevKey = active && rootEl.contains(active) && active.getAttribute ? active.getAttribute('data-saf3-key') : null;
      while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
      var ctx = S.ctx;
      rootEl.appendChild(h('header', { class: 'saf3-head' },
        h('div', null, h('h2', { class: 'saf3-title', text: 'CRM de afiliados' }),
          ctx ? h('p', { class: 'saf3-meta' }, h('span', { 'data-saf3-brand': '', text: 'Marca: ' + brandLabel() }), h('span', { class: 'saf3-muted', text: 'ID ' + str(ctx.effectiveBrand) }), h('span', { text: 'Papel: ' + ctx.role }), h('span', { text: 'Período: ' + (periodText(S.filters.period) || 'não informado ou inválido') })) : null),
        h('div', { class: 'saf3-refresh' },
          h('button', { type: 'button', class: 'saf3-btn', 'data-saf3-act': 'refresh', 'data-saf3-key': 'refresh', disabled: !!closedReason, 'aria-describedby': 'saf3-refresh-note' }, S.loading ? 'Atualizando…' : 'Atualizar leitura'),
          h('span', { id: 'saf3-refresh-note', class: 'saf3-muted', text: 'Relê o servidor; não dispara nova coleta.' }))));
      rootEl.appendChild(h('div', { class: 'saf3-status', role: 'status', 'aria-live': 'polite', tabindex: '-1', 'data-saf3-key': 'status' },
        closedReason ? h('p', { class: 'saf3-notice saf3-notice--bad', 'data-saf3-state': 'unsupported', text: closedReason + ' Nenhuma leitura foi feita; fontes e ações fechadas.' }) : null,
        S.notices.map(function (n) { return h('p', { class: 'saf3-notice saf3-notice--' + n.tone, text: n.text }); }),
        S.ctxError ? h('p', { class: 'saf3-notice saf3-notice--bad', 'data-saf3-state': 'context-error', text: S.ctxError }) : null,
        S.revoked ? h('p', { class: 'saf3-notice saf3-notice--bad', 'data-saf3-state': 'revoked', text: 'Motivo público: ' + S.revoked }) : null));
      if (!ctx) {
        if (!closedReason) rootEl.appendChild(h('p', { class: 'saf3-state', 'data-saf3-state': S.loading ? 'loading' : 'idle', 'aria-busy': S.loading ? 'true' : null, text: S.loading ? 'Confirmando sessão e marca…' : 'Aguardando leitura.' }));
        finishFocus(prevKey); return;
      }
      rootEl.appendChild(renderOps());
      var envC = S.envs.creators, all = envC && envC.items || [], list = filteredCreators(), gNew = gate('creator.create');
      var formInCrm = S.form && !(S.profile && S.form.profileId != null && keyOf(S.form.profileId) === keyOf(S.profile.creatorId));
      var crm = h('section', { class: 'saf3-crm', 'aria-label': 'Criadores' },
        sourceLine(envC, 'creators'),
        h('div', { class: 'saf3-toolbar' },
          h('div', { role: 'tablist', 'aria-label': 'Visualização', class: 'saf3-tabs' }, ['table', 'kanban'].map(function (v) {
            return h('button', { type: 'button', role: 'tab', id: 'saf3-tab-' + v, 'aria-selected': S.view === v ? 'true' : 'false', tabindex: S.view === v ? '0' : '-1', 'data-saf3-act': 'view', 'data-view': v, 'data-saf3-key': 'tab-' + v, 'aria-controls': 'saf3-panel' }, v === 'table' ? 'Tabela' : 'Kanban');
          })),
          h('div', { class: 'saf3-filters', role: 'group', 'aria-label': 'Filtros de apresentação' },
            h('label', { class: 'saf3-sr', for: 'saf3-search', text: 'Buscar por nome ou @handle' }),
            h('input', { id: 'saf3-search', class: 'saf3-input', type: 'search', placeholder: 'Buscar nome ou @handle', 'data-saf3-filter': 'search', 'data-saf3-key': 'filter-search', value: S.ui.search }),
            h('label', { class: 'saf3-sr', for: 'saf3-filter-stage', text: 'Etapa' }),
            select({ id: 'saf3-filter-stage', class: 'saf3-select', 'data-saf3-filter': 'stage', 'data-saf3-key': 'filter-stage' }, [{ value: '', label: 'Todas as etapas' }].concat(stageOptions(all)), S.ui.stage),
            [['ownerReference', 'owner', 'Todos os responsáveis', 'Responsável'], ['provider', 'provider', 'Todos os provedores', 'Provedor']].map(function (f) {
              return [h('label', { class: 'saf3-sr', for: 'saf3-filter-' + f[1], text: f[3] }),
                select({ id: 'saf3-filter-' + f[1], class: 'saf3-select', 'data-saf3-filter': f[1], 'data-saf3-key': 'filter-' + f[1] }, [{ value: '', label: f[2] }].concat(distinct(all, f[0]).map(function (v) { return { value: v, label: v }; })), S.ui[f[1]])];
            })),
          formButton('Novo criador', 'creator.create', null, null, null, gNew)),
        reasonsLine([gNew]),
        formInCrm ? renderForm() : null,
        h('div', { id: 'saf3-panel', role: 'tabpanel', 'aria-labelledby': 'saf3-tab-' + S.view, class: 'saf3-panel' },
          stateBlock(envC, 'creators', S.loading) || (list.length ? (S.view === 'table' ? renderTable(list) : renderKanban(list)) : h('p', { class: 'saf3-state', 'data-saf3-state': 'filtered-empty', text: 'Nenhum criador com estes filtros (' + all.length + ' na leitura).' }))));
      rootEl.appendChild(h('div', { class: 'saf3-body' + (S.profile ? ' saf3-body--profile' : '') }, crm, renderProfile()));
      rootEl.appendChild(renderPerf(S.envs['own-performance'], 'program', S.loading));
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
      var el = byAttr('data-saf3-key', want);
      if (el && typeof el.focus === 'function') el.focus();
    }

    // -------------------------------------------------------------- eventos (delegados no próprio container)
    function closeProfile() {
      S.profile = null; if (S.form && S.form.profileId != null) S.form = null;
      S.focusKey = S.returnFocus || 'tab-' + S.view; render();
    }
    function onClick(ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-saf3-act]') : null;
      if (!t || !rootEl.contains(t) || t.disabled) return;
      var act = t.getAttribute('data-saf3-act');
      if (act === 'refresh') { if (!closedReason) startSync(S.filters, false); return; }
      if (act === 'view') { S.view = t.getAttribute('data-view'); S.focusKey = 'tab-' + S.view; render(); return; }
      if (act === 'open-profile') {
        var c = creatorByKey(t.getAttribute('data-id')); if (!c) return;
        S.returnFocus = t.getAttribute('data-saf3-key'); S.focusKey = 'profile-title';
        if (S.form && S.form.profileId != null) S.form = null;
        loadProfile(S.generation, c.id); return;
      }
      if (act === 'close-profile') { closeProfile(); return; }
      if (act === 'open-form') {
        var rec = t.getAttribute('data-record'), cre = t.getAttribute('data-creator'), prof = t.getAttribute('data-profile'), kind = t.getAttribute('data-kind');
        var spec = MUTATIONS[kind]; if (!spec) return;
        var recObj = rec && spec.record ? (S.envs[spec.record] && S.envs[spec.record].items || []).filter(function (x) { return keyOf(x.id) === rec; })[0] : null;
        var creObj = cre ? creatorByKey(cre) : null, profObj = prof ? creatorByKey(prof) : null;
        openForm(kind, recObj ? recObj.id : null, creObj ? creObj.id : null, null, profObj ? profObj.id : null); return;
      }
      if (act === 'move-review') {
        var mc = creatorByKey(t.getAttribute('data-id')), sel = byAttr('data-saf3-move-target', t.getAttribute('data-id'));
        if (!mc || !sel || !S.ctx.stageCatalog) return;
        var target = S.ctx.stageCatalog.items.filter(function (s) { return keyOf(s.value) === sel.value; })[0]; if (!target) return;
        openForm('creator.update', mc.id, null, 'move', S.profile && S.profile.creatorId === mc.id ? mc.id : null);
        if (!S.form) return;
        draftFor(S.form).values.stage = target.value; S.form.mode = 'review'; S.focusKey = 'form-back'; render(); return;
      }
      if (act === 'form-review' && S.form) { var b = buildIntent(S.form); S.form.error = b.errors.length ? b.errors.join(' ') : null; if (!b.errors.length) { S.form.mode = 'review'; S.focusKey = 'form-back'; } else S.focusKey = 'form-first'; render(); return; }
      if (act === 'form-back' && S.form) { if (S.form.variant === 'move' || !fieldsOf(S.form).length) { S.drafts.delete(S.form.key); S.form = null; } else { S.form.mode = 'edit'; S.focusKey = 'form-first'; } render(); return; }
      if (act === 'form-cancel') { S.form = null; render(); return; }
      if (act === 'receipt') consultReceipt(t.getAttribute('data-op'));
      // form-confirm: sempre desabilitado neste incremento; nenhum caminho de envio existe.
    }
    function onInput(ev) {
      var t = ev.target; if (!t || !t.getAttribute || !rootEl.contains(t)) return;
      var field = t.getAttribute('data-saf3-field'), filter = t.getAttribute('data-saf3-filter');
      if (field && S.form) { draftFor(S.form).values[field] = t.value; return; }
      if (filter) { S.ui[filter] = t.value; S.focusKey = t.getAttribute('data-saf3-key'); render(); }
    }
    function onKey(ev) {
      var t = ev.target; if (!t || !t.getAttribute || !rootEl.contains(t)) return;
      if (t.getAttribute('role') === 'tab' && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].indexOf(ev.key) >= 0) {
        S.view = ev.key === 'Home' ? 'table' : ev.key === 'End' ? 'kanban' : S.view === 'table' ? 'kanban' : 'table';
        S.focusKey = 'tab-' + S.view; if (ev.preventDefault) ev.preventDefault(); render(); return;
      }
      if (ev.key === 'Escape') {
        if (S.form) { S.form = null; S.focusKey = S.profile ? 'profile-title' : 'tab-' + S.view; render(); if (ev.preventDefault) ev.preventDefault(); }
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
      // Não cancela leitura/recibo já invocados; apenas impede novas invocações e descarta respostas.
      S.disposed = true; S.generation++;
      rootEl.removeEventListener('click', onClick);
      rootEl.removeEventListener('input', onInput);
      rootEl.removeEventListener('change', onInput);
      rootEl.removeEventListener('keydown', onKey);
      S.drafts.clear(); S.ops.clear(); S.envs = {}; S.profile = null; S.ctx = null; S.rawCtx = null; S.form = null; S.inflight = null;
      if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    }
    return { sync: sync, dispose: dispose };
  }

  return { create: create, contractVersion: VERSION, writesEnabled: WRITES_ENABLED };
});
