/* ShrigmaOrganicV2 — interface nova do Orgânico (frente C2, pacote organico-mvp-20261006-v2).
   Fonte de interface PREPARADA, não operacional. Contrato: GATEWAY-ORGANICO-v1 1.0.1-proposed.
   O gateway injetado é a única fronteira de leitura/operação. Este módulo não usa transporte,
   armazenamento local, credenciais nem gera IDs de operação. Autorização, idempotência,
   persistência e confirmação ficam no servidor (Root). */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.ShrigmaOrganicV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONTRACT_VERSION = '1.0.1-proposed';
  var RESOURCES = ['posts', 'stories', 'attribution-aggregate', 'attribution-order-if-admitted', 'links'];
  var MODELS = { last_click: 'Último clique', last_non_direct: 'Último clique não direto' };
  var DEFAULT_MODEL = 'last_click';
  var READ_STATES = ['ready', 'empty', 'unavailable', 'forbidden'];
  var OPEN_OP_PHASES = ['preparing', 'prepared', 'submitting', 'uncertain', 'checking'];
  var SOURCE_LABEL = {
    own_verified: 'Próprio verificado', own_declared: 'Próprio declarado', derived: 'Derivado',
    market_estimated: 'Estimativa de mercado', unknown: 'Origem desconhecida'
  };
  var BRAND_LABEL = {
    aristo: 'O Aristocrata', aristocrata: 'O Aristocrata', fish: 'Fishermans', fishermans: 'Fishermans',
    olivas: 'Olivas do Campo'
  };
  var ROLE_LABEL = { read: 'Leitura', write: 'Escrita', master: 'Mestre' };
  var KIND_LABEL = { 'link.create': 'Criar link', 'link.archive': 'Arquivar link' };
  var TITLES = {
    posts: 'Posts', stories: 'Stories', 'attribution-aggregate': 'Atribuição',
    'attribution-order-if-admitted': 'Pedidos atribuídos', links: 'Links UTM'
  };
  // Sugestões de preenchimento herdadas do painel atual; o servidor valida e pode recusar.
  var ORIGINS = ['instagram_social', 'facebook_social', 'tiktok_social', 'youtube', 'whatsapp'];
  var SURFACES = { story: 'Story', linktree: 'Bio / Linktree', dm: 'Direct (DM)', feed: 'Feed', reels: 'Reels', comunidade: 'Comunidade', grupo: 'Grupo' };
  var METRIC_LABEL = {
    reach: 'alcance', impressions: 'impressões', views: 'visualizações', plays: 'reproduções', likes: 'curtidas',
    comments: 'comentários', saves: 'salvos', shares: 'compartilhamentos', replies: 'respostas',
    linkClicks: 'cliques no link', link_clicks: 'cliques no link', exits: 'saídas', follows: 'seguidores'
  };
  // Rótulos de apresentação para campos comuns; campo desconhecido aparece com o nome original.
  var FIELD_LABEL = {
    day: 'Dia', date: 'Data', dia: 'Dia', channel: 'Canal', classification: 'Classificação', orders: 'Pedidos', pedidos: 'Pedidos',
    revenueMinor: 'Receita', amountMinor: 'Valor', netRevenueMinor: 'Receita líquida', pieceId: 'Peça', piece: 'Peça',
    postId: 'Post', storyId: 'Story', surface: 'Superfície', origin: 'Origem', source: 'Fonte', model: 'Modelo', window: 'Janela',
    ordersRead: 'Pedidos lidos', paidEligible: 'Pagos elegíveis', unknownOrigin: 'Origem desconhecida', knownSession: 'Sessão conhecida',
    pendingJourney: 'Jornada pendente', partialJourney: 'Jornada parcial', checkedAt: 'Verificado em', collectedAt: 'Coletado em',
    covered: 'Dias cobertos', expected: 'Dias esperados', complete: 'Completo',
    marca: 'Marca', detail_level: 'Detalhe', rede: 'Rede', superficie: 'Superfície', source_system: 'Sistema', currency: 'Moeda',
    rule_version: 'Regra', rule_reason: 'Motivo da regra', utm_source: 'utm_source', utm_medium: 'utm_medium', utm_campaign: 'utm_campaign',
    utm_content: 'utm_content', utm_term: 'utm_term', utm_raw_available: 'UTM original', utm_provenance: 'Proveniência UTM', piece_status: 'Peça',
    receita_liquida: 'Receita líquida', receita_elegivel: 'Receita elegível', pedidos_lidos: 'Pedidos lidos', pagos_elegiveis: 'Pagos elegíveis',
    jornada_pendente: 'Jornada pendente', jornada_parcial: 'Jornada parcial', ultima_sessao_conhecida: 'Última sessão conhecida',
    ultima_sessao_desconhecida: 'Última sessão desconhecida', origem_nao_direta_desconhecida: 'Origem não direta desconhecida',
    checked_at: 'Verificado em', coletado_em: 'Coletado em', leitura_mais_antiga: 'Leitura mais antiga'
  };
  // Contrato 1.0.2: texto público para os motivos fechados do normalizador (sem ecoar objetos recebidos).
  var C102_TEXT = {
    per_order_not_admitted: 'DTO por pedido não admitido no contrato 1.0.2; nenhum pedido ou peça é derivado do agregado.',
    model_mismatch: 'O gateway devolveu outro modelo de atribuição; nada exibido para não misturar modelos.',
    period_mismatch: 'O gateway devolveu outro período; nada exibido.',
    state_unavailable: 'Fonte indisponível nesta leitura.',
    brand_mismatch: 'Resposta de outra marca descartada.'
  };
  // R6 — apresentação apenas: textos públicos fixos. Nenhum enum, Error, stack, markup ou objeto recebido é ecoado.
  var OP_INVALID_TEXT = { operation_id_mismatch: 'A resposta não corresponde à operação original; foi descartada.' };
  var OP_INVALID_GENERIC = 'Resposta inconsistente descartada; o resultado da operação original continua desconhecido.';
  var CAP_CREATE_UNCONFIRMED = 'Permissão para criar links não confirmada.';
  var CAP_DEFAULT_BLOCK = 'Operação não admitida pelo integrador para esta marca/papel.';
  var PREPARE_LOST_TEXT = 'Preparação não confirmada. Esta tela não enviou confirmação para execução. Sem o identificador original, uma nova preparação permanece bloqueada até recuperação comprovada.';
  function opInvalidText(reason) {
    return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(OP_INVALID_TEXT, reason) ? OP_INVALID_TEXT[reason] : OP_INVALID_GENERIC;
  }
  var CHANNEL_SUMMARY_FIELDS = ['rede', 'superficie', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var LINK_STATE = { active: 'Ativo', archived: 'Arquivado' };
  var instanceCount = 0;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return typeof v === 'string' && v.trim() !== ''; }
  function revOk(v) { return (typeof v === 'string' && v !== '') || (typeof v === 'number' && isFinite(v)); }
  function oneOf(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }
  function validDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var t = Date.parse(v + 'T12:00:00Z');
    return isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }
  function stamp(v) {
    var t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (!isFinite(t)) return null;
    try {
      return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(t));
    } catch (_) { return new Date(t).toISOString(); }
  }
  function dayBR(v) {
    if (!validDay(v)) return String(v);
    return v.slice(8, 10) + '/' + v.slice(5, 7) + '/' + v.slice(0, 4);
  }
  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v.toLocaleString('pt-BR') : 'indisponível';
  }
  function decimalMajor(text, currency) {
    var m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!m) return 'indisponível';
    var body = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (m[3] ? ',' + m[3] : '');
    return m[1] + (currency === 'BRL' ? 'R$ ' + body : body + (str(currency) ? ' ' + currency : ' (moeda não informada)'));
  }
  function money(minor, currency) {
    if (typeof minor !== 'number' || !isFinite(minor)) return 'indisponível';
    var major = minor / 100;
    if (!str(currency)) return major.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' (moeda não informada)';
    try { return major.toLocaleString('pt-BR', { style: 'currency', currency: currency }); }
    catch (_) { return major.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ' ' + currency; }
  }
  function brandName(id) { return BRAND_LABEL[id] || String(id); }
  function publicReason(e) {
    // Mensagens de exceção podem carregar detalhes internos; só uma razão pública declarada é exibida.
    return e && str(e.publicReason) ? String(e.publicReason).slice(0, 240) : 'Falha de leitura pelo gateway.';
  }
  function todaySP() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); }
    catch (_) { return new Date().toISOString().slice(0, 10); }
  }
  function shiftDay(day, n) { return new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  function defaultFilters() { var t = todaySP(); return { from: shiftDay(t, -29), to: t, model: DEFAULT_MODEL }; }
  function normalizeFilters(input, base) {
    var f = { from: base.from, to: base.to, model: base.model };
    if (isObj(input)) {
      var p = isObj(input.period) ? input.period : null;
      if (p && validDay(p.from) && validDay(p.to) && p.from <= p.to) { f.from = p.from; f.to = p.to; }
      if (MODELS[input.model]) f.model = input.model;
    }
    return f;
  }
  function filtersKey(f) { return f.from + '|' + f.to + '|' + f.model; }
  function capability(ctx, kind) {
    var caps = ctx && isObj(ctx.capabilities) ? ctx.capabilities : null;
    var c = caps ? caps[kind] : undefined;
    if (c === true || (isObj(c) && c.available === true)) return { available: true, reason: null };
    return { available: false, reason: isObj(c) && str(c.reason) ? String(c.reason) : null };
  }
  function capsSignature(ctx) {
    var caps = ctx && isObj(ctx.capabilities) ? ctx.capabilities : {};
    return Object.keys(caps).sort().map(function (k) { return k + '=' + capability(ctx, k).available; }).join(',');
  }
  function checkContext(ctx) {
    if (!isObj(ctx)) return { ok: false, reason: 'Contexto inválido recebido do gateway.' };
    if (!revOk(ctx.contextRevision)) return { ok: false, reason: 'Contexto sem revisão; leitura bloqueada.' };
    if (!str(ctx.effectiveBrand)) return { ok: false, reason: 'Nenhuma marca admitida para esta sessão.' };
    return { ok: true };
  }
  function bindingBrand(binding) {
    if (!isObj(binding)) return undefined;
    if (binding.effectiveBrand != null) return binding.effectiveBrand;
    if (binding.brandId != null) return binding.brandId;
    return binding.brand;
  }
  function envMeta(env) {
    return {
      source: oneOf(env.source, Object.keys(SOURCE_LABEL), 'unknown'),
      coverage: oneOf(env.coverage, ['complete', 'partial', 'unknown'], 'unknown'),
      freshness: oneOf(env.freshness, ['fresh', 'stale', 'unknown'], 'unknown'),
      collectedAt: str(env.collectedAt) ? env.collectedAt : null,
      cacheAt: str(env.cacheAt) ? env.cacheAt : null,
      error: str(env.error) ? String(env.error) : null
    };
  }

  function create(options) {
    var o = options || {};
    var element = o.element, doc = o.document, gw = o.gateway;
    if (!element || typeof element.appendChild !== 'function') throw new TypeError('ShrigmaOrganicV2.create: element é obrigatório.');
    if (!doc || typeof doc.createElement !== 'function') throw new TypeError('ShrigmaOrganicV2.create: document é obrigatório.');
    if (!(gw && (typeof gw === 'object' || typeof gw === 'function'))) gw = null;
    function has(name) { return !!gw && typeof gw[name] === 'function'; }
    var C102 = (doc.defaultView && doc.defaultView.ShrigmaOrganicContractV102) || (typeof globalThis !== 'undefined' && globalThis.ShrigmaOrganicContractV102) || null;
    if (!C102 || typeof C102.normalizeContext !== 'function' || C102.version !== '1.0.2-proposed') C102 = null;
    var uid = 'sov2-' + (++instanceCount);
    var win = doc.defaultView || null;
    var AbortCtl = (win && win.AbortController) || (typeof AbortController !== 'undefined' ? AbortController : null);

    var st = {
      disposed: false, gen: 0, inflight: null, syncing: false, ctx: null, blocked: null,
      filters: defaultFilters(), views: {}, op: null, pending: [], pendingKnown: false,
      writeLock: false, message: '', draft: emptyDraft(), draftToken: {}, draftOwner: null, lastSync: null,
      nctx: null, holds: null
    };
    RESOURCES.forEach(function (r) { st.views[r] = { status: 'idle' }; });

    function emptyDraft() { return { destination: '', origin: '', surface: '', campaign: '', date: '' }; }
    function alive(g) { return !st.disposed && g === st.gen; }

    // ---------- DOM helpers (somente dentro do element recebido) ----------
    function append(el, children) {
      if (children == null || children === false) return;
      if (!Array.isArray(children)) children = [children];
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c == null || c === false) continue;
        if (Array.isArray(c)) append(el, c);
        else if (typeof c === 'string' || typeof c === 'number') el.appendChild(doc.createTextNode(String(c)));
        else el.appendChild(c);
      }
    }
    function h(tag, attrs, children) {
      var el = doc.createElement(tag);
      if (attrs) Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') el.textContent = String(v);
        else if (k === 'value') el.value = String(v);
        else if (k === 'disabled') el.disabled = true;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
      append(el, children);
      return el;
    }
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function tag(kind, label, title) {
      return h('span', { class: 'sov2-tag sov2-tag--' + kind, 'data-ov-tag': kind, title: title || null, tabindex: title ? '0' : null, text: label });
    }
    function inside(node) {
      for (var n = node; n; n = n.parentNode) if (n === rootEl) return true;
      return false;
    }
    function focusedKey() {
      var a = doc.activeElement;
      return a && inside(a) && a.getAttribute ? a.getAttribute('data-ov-focus') : null;
    }
    function refocus(key) {
      if (!key) return;
      var list = rootEl.querySelectorAll('[data-ov-focus]');
      for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-ov-focus') === key) { if (typeof list[i].focus === 'function') list[i].focus(); return; }
    }
    function scrollTable(label, head, rows) {
      return h('div', { class: 'sov2-scroll', tabindex: '0', role: 'region', 'aria-label': label }, h('table', { class: 'sov2-table' }, [
        h('thead', null, h('tr', null, head.map(function (c) { return h('th', { scope: 'col', text: c }); }))),
        h('tbody', null, rows)
      ]));
    }

    // ---------- Esqueleto persistente ----------
    var rootEl = h('div', { class: 'sov2', 'data-ov-root': CONTRACT_VERSION });
    var top = {};
    top.brand = h('strong', { class: 'sov2-brand', 'data-ov-brand': '', text: 'Marca não confirmada' });
    top.role = h('span', { class: 'sov2-role', 'data-ov-role': '' });
    top.from = h('input', { id: uid + '-from', type: 'date', 'data-ov-period': 'from', value: st.filters.from, required: true });
    top.to = h('input', { id: uid + '-to', type: 'date', 'data-ov-period': 'to', value: st.filters.to, required: true });
    top.summary = h('ul', { class: 'sov2-summary', 'aria-label': 'Métricas disponíveis' });
    top.source = h('p', { class: 'sov2-source', 'data-ov-source': '' });
    top.refresh = h('button', { type: 'button', class: 'sov2-btn sov2-btn--sec', 'data-ov-action': 'refresh', 'data-ov-focus': 'refresh', text: 'Atualizar leitura' });
    top.status = h('p', { class: 'sov2-status', role: 'status', 'aria-live': 'polite', 'data-ov-message': '' });
    var header = h('header', { class: 'sov2-top', 'aria-label': 'Resumo do Orgânico' }, [
      h('div', { class: 'sov2-top-id' }, [h('h2', { class: 'sov2-title', text: 'Orgânico' }), top.brand, top.role]),
      h('form', { class: 'sov2-period', 'data-ov-form': 'period', novalidate: true }, [
        h('label', { for: uid + '-from' }, ['De', top.from]),
        h('label', { for: uid + '-to' }, ['Até', top.to]),
        h('button', { type: 'submit', class: 'sov2-btn', 'data-ov-focus': 'period-apply', text: 'Aplicar período' })
      ]),
      top.summary, top.source, h('div', { class: 'sov2-top-actions' }, top.refresh), top.status
    ]);
    append(rootEl, header);

    var sec = {};
    function shell(resource) {
      var hid = uid + '-' + resource;
      var s = {
        tags: h('div', { class: 'sov2-tags' }),
        body: h('div', { class: 'sov2-body' })
      };
      s.el = h('section', { class: 'sov2-section', 'data-ov-section': resource, 'data-ov-state': 'idle', 'aria-labelledby': hid }, [
        h('div', { class: 'sov2-head' }, [h('h3', { id: hid, text: TITLES[resource] }), s.tags]), s.body
      ]);
      sec[resource] = s;
      append(rootEl, s.el);
      return s;
    }
    RESOURCES.forEach(shell);

    // Links: formulário persistente (rascunho não se perde ao reler) + áreas atualizáveis.
    var lk = {};
    function field(name, label, control) {
      control.setAttribute('id', uid + '-l-' + name);
      control.setAttribute('data-ov-draft', name);
      return h('label', { for: uid + '-l-' + name, class: 'sov2-field' }, [h('span', { text: label }), control]);
    }
    lk.cap = h('p', { id: uid + '-cap', class: 'sov2-cap', 'data-ov-cap': 'link.create' });
    lk.submit = h('button', { type: 'submit', class: 'sov2-btn', 'data-ov-focus': 'link-review', 'aria-describedby': uid + '-cap', text: 'Revisar link' });
    lk.form = h('form', { class: 'sov2-form', 'data-ov-form': 'link-create', novalidate: true, autocomplete: 'off' }, [
      field('destination', 'Destino (página do site)', h('input', { type: 'url', inputmode: 'url', placeholder: 'https://…', maxlength: '500' })),
      field('origin', 'Origem', h('select', null, [h('option', { value: '', text: 'Escolha' })].concat(ORIGINS.map(function (v) { return h('option', { value: v, text: v }); })))),
      field('surface', 'Superfície', h('select', null, [h('option', { value: '', text: 'Escolha' })].concat(Object.keys(SURFACES).map(function (k) { return h('option', { value: k, text: SURFACES[k] }); })))),
      field('campaign', 'Campanha', h('input', { maxlength: '60', placeholder: 'ex.: kit_duas_aguas' })),
      field('date', 'Data (opcional)', h('input', { type: 'date' })),
      h('div', { class: 'sov2-form-end' }, [lk.submit, lk.cap])
    ]);
    lk.op = h('div', { class: 'sov2-op', role: 'status', 'aria-live': 'polite', 'data-ov-op': '' });
    lk.pending = h('div', { class: 'sov2-pending', 'data-ov-pending': '' });
    lk.list = h('div', { class: 'sov2-list', 'data-ov-list': '' });
    append(sec.links.body, [lk.form, lk.op, lk.pending, lk.list]);

    element.appendChild(rootEl);

    // ---------- Estado de leitura ----------
    function setView(resource, view) { st.views[resource] = view; }
    function hasData(v) { return v && (v.status === 'ready' || v.status === 'empty'); }
    function clearDraft() {
      st.draft = emptyDraft();
      st.draftToken = {};
      var list = lk.form.querySelectorAll('[data-ov-draft]');
      for (var i = 0; i < list.length; i++) list[i].value = '';
    }
    function adoptContext(ctx) {
      var prev = st.ctx;
      var changed = !prev || prev.contextRevision !== ctx.contextRevision || prev.effectiveBrand !== ctx.effectiveBrand ||
        prev.role !== ctx.role || prev.sourceRevision !== ctx.sourceRevision || prev.principalReference !== ctx.principalReference ||
        prev.sessionRevision !== ctx.sessionRevision ||
        capsSignature(prev) !== capsSignature(ctx);
      var owner = String(ctx.effectiveBrand) + '|' + String(ctx.principalReference);
      if (st.draftOwner !== null && st.draftOwner !== owner) clearDraft();
      st.draftOwner = owner;
      st.blocked = null;
      if (changed) {
        // Contexto anterior invalidado: dados, operação local e leituras pendentes não valem para o novo.
        RESOURCES.forEach(function (r) { setView(r, { status: 'loading' }); });
        if (C102 && st.nctx && st.op) {
          var held = holdOf(st.nctx.effectiveBrand, st.nctx.principalReference, true), cop = st.op;
          if (cop.operationId != null && OPEN_OP_PHASES.indexOf(cop.phase) >= 0) {
            if (!held.carried.some(function (c) { return c.operationId === cop.operationId; })) held.carried.push({ operationId: cop.operationId, kind: cop.kind || null, intent: cop.intent || null });
          } else if (cop.phase === 'preparing') held.lost = true;
        }
        st.op = null;
        st.writeLock = false;
        st.message = prev && prev.effectiveBrand !== ctx.effectiveBrand ? 'Marca alterada; dados da marca anterior removidos.' : st.message;
      } else {
        RESOURCES.forEach(function (r) { if (!hasData(st.views[r])) setView(r, { status: 'loading' }); });
      }
      st.ctx = ctx;
      var journal = ctx.pendingOperations;
      st.pendingKnown = Array.isArray(journal);
      st.pending = [];
      if (Array.isArray(journal)) {
        // An unreadable entry cannot prove an empty journal. Keep valid IDs for receipt-only recovery.
        for (var i = 0; i < journal.length; i++) {
          var p = journal[i], entry = null;
          if (revOk(p)) entry = { operationId: p, kind: null };
          else if (isObj(p) && revOk(p.operationId)) entry = { operationId: p.operationId, kind: str(p.kind) ? p.kind : null };
          if (entry) st.pending.push(entry);
          else st.pendingKnown = false;
        }
      }
      if (C102) {
        // 1.0.2: só journal complete com revisão real abre gravação; IDs válidos ficam só para receipt.
        var nc = C102.normalizeContext(ctx);
        st.nctx = nc.state === 'valid' ? nc.value : null;
        st.pendingKnown = !!st.nctx && st.nctx.journal.state === 'complete';
        st.pending = st.nctx ? st.nctx.journal.pending.map(function (q) { return { operationId: q.operationId, kind: q.kind }; }) : [];
      }
    }
    function blockAll(reason, status) {
      st.ctx = null; st.op = null; st.pending = []; st.pendingKnown = false; st.blocked = reason;
      if (st.draftOwner !== null) clearDraft();
      st.draftOwner = null;
      RESOURCES.forEach(function (r) { setView(r, { status: status || 'forbidden', reason: reason }); });
    }
    function readFilters(resource, f) {
      var filters = { period: { from: f.from, to: f.to } };
      if (resource === 'attribution-aggregate' || resource === 'attribution-order-if-admitted') filters.model = f.model;
      return filters;
    }
    function readOne(resource, ctx, f, ctl) {
      var req = { resource: resource, filters: readFilters(resource, f), expectedContextRevision: ctx.contextRevision };
      var p;
      try { p = Promise.resolve(gw.read(req, ctl ? { signal: ctl.signal } : {})); } catch (e) { p = Promise.reject(e); }
      return p.then(function (env) {
        if (isObj(env) && env.contextRevision !== ctx.contextRevision) return { resource: resource, mismatch: true };
        return { resource: resource, env: env, model: f.model, filters: req.filters };
      }, function (e) { return { resource: resource, error: e }; });
    }
    function itemsOf(env, ctx, view) {
      var d = env.data;
      if (!isObj(d) || !Array.isArray(d.items)) return null;
      var kept = d.items.filter(function (it) { return isObj(it) && it.brandId === ctx.effectiveBrand; });
      view.dropped = d.items.length - kept.length;
      return kept;
    }
    function applyRead102(x, ctx) {
      var r = x.resource, rev = ctx.contextRevision;
      var n = C102.normalizeRead({ resource: r, filters: x.filters }, x.env, st.nctx);
      var m = n.value && n.value.meta;
      var meta = m ? { source: m.source, coverage: m.coverage, freshness: m.freshness, collectedAt: m.collectedAt, cacheAt: m.cacheAt, error: m.publicError } : undefined;
      if (n.state === 'forbidden') { setView(r, { status: 'forbidden', ctxRev: rev, reason: (m && m.publicError) || 'Acesso recusado pelo servidor para esta marca/papel.' }); return; }
      if (n.state !== 'valid') {
        if (n.reason === 'brand_mismatch') setView(r, { status: 'discarded', ctxRev: rev, reason: C102_TEXT.brand_mismatch });
        else if (C102_TEXT[n.reason]) setView(r, { status: 'unavailable', ctxRev: rev, meta: meta, reason: (n.reason === 'state_unavailable' && m && m.publicError) || C102_TEXT[n.reason] });
        else setView(r, { status: 'error', ctxRev: rev, reason: 'Resposta fora do contrato 1.0.2 (' + n.reason + '); nada exibido.' });
        return;
      }
      var v = n.value;
      var view = { status: v.readState === 'empty' ? 'empty' : 'ready', ctxRev: rev, meta: meta, items: [], data: null, dropped: v.dropped, model: x.model, typed102: true };
      if (r === 'attribution-aggregate') view.data = v.data;
      else if (v.data) view.items = v.data.items;
      setView(r, view);
    }
    function applyRead(x, ctx) {
      var r = x.resource, prev = st.views[r];
      if (C102 && st.nctx && !x.error) { applyRead102(x, ctx); return; }
      var base = { ctxRev: ctx.contextRevision };
      if (x.error) {
        if (hasData(prev) && prev.ctxRev === ctx.contextRevision) {
          prev.refreshFailed = true; prev.refreshReason = publicReason(x.error);
        } else setView(r, { status: 'error', ctxRev: ctx.contextRevision, reason: publicReason(x.error) });
        return;
      }
      var env = x.env;
      if (!isObj(env) || READ_STATES.indexOf(env.state) < 0) { setView(r, { status: 'error', ctxRev: base.ctxRev, reason: 'Resposta fora do contrato do gateway; nada exibido.' }); return; }
      if (env.brandId != null && env.brandId !== ctx.effectiveBrand) { setView(r, { status: 'discarded', ctxRev: base.ctxRev, reason: 'Resposta de outra marca descartada.' }); return; }
      var meta = envMeta(env);
      if (env.state === 'forbidden') { setView(r, { status: 'forbidden', ctxRev: base.ctxRev, reason: meta.error || 'Acesso recusado pelo servidor para esta marca/papel.' }); return; }
      if (env.state === 'unavailable') { setView(r, { status: 'unavailable', ctxRev: base.ctxRev, meta: meta, reason: meta.error || (r === 'attribution-order-if-admitted' ? 'DTO por pedido ainda não admitido pelo RootGateway para esta marca.' : 'Fonte indisponível nesta leitura.') }); return; }
      if (env.brandId == null) { setView(r, { status: 'discarded', ctxRev: base.ctxRev, reason: 'Resposta sem marca confirmada descartada.' }); return; }
      var view = { status: env.state, ctxRev: base.ctxRev, meta: meta, items: [], data: null, dropped: 0, model: x.model };
      if (env.state === 'ready') {
        if (r === 'attribution-aggregate') {
          if (!isObj(env.data)) { setView(r, { status: 'error', ctxRev: base.ctxRev, reason: 'Resposta fora do contrato do gateway; nada exibido.' }); return; }
          if (env.data.model !== x.model) { setView(r, { status: 'unavailable', ctxRev: base.ctxRev, meta: meta, reason: 'O gateway devolveu outro modelo de atribuição; nada exibido para não misturar modelos.' }); return; }
          view.data = env.data;
        } else if (r === 'attribution-order-if-admitted') {
          var d = env.data;
          if (!isObj(d) || !Array.isArray(d.items)) { setView(r, { status: 'error', ctxRev: base.ctxRev, reason: 'Resposta fora do contrato do gateway; nada exibido.' }); return; }
          // Somente campos admitidos pelo contrato; qualquer outro campo (inclusive PII) é ignorado.
          view.currency = str(d.currency) ? d.currency : null;
          view.items = d.items.filter(function (it) { return isObj(it) && it.model === x.model; }).map(function (it) {
            return { orderReference: it.orderReference, model: it.model, amountMinor: it.amountMinor, source: it.source, window: it.window };
          });
        } else {
          var items = itemsOf(env, ctx, view);
          if (!items) { setView(r, { status: 'error', ctxRev: base.ctxRev, reason: 'Resposta fora do contrato do gateway; nada exibido.' }); return; }
          view.items = items;
        }
      }
      setView(r, view);
    }

    // ---------- sync / dispose ----------
    function sync(opts) {
      if (st.disposed) return Promise.resolve();
      if (C102 && opts && opts.filters !== undefined) {
        var nf = C102.normalizeFilters({ filters: opts.filters });
        if (nf.state !== 'valid') {
          st.gen++;
          if (st.inflight && st.inflight.ctl) { try { st.inflight.ctl.abort(); } catch (_) { /* ignore */ } }
          st.inflight = null; st.syncing = false;
          RESOURCES.forEach(function (r) { setView(r, { status: 'unavailable', reason: 'Filtro inválido (' + nf.reason + '); nada foi lido.' }); });
          st.message = 'Filtro inválido (' + nf.reason + '); nada foi lido nem reaproveitado.';
          renderAll();
          return Promise.resolve();
        }
        return startSync({ from: nf.value.filters.period.from, to: nf.value.filters.period.to, model: nf.value.filters.model || st.filters.model }, false);
      }
      var f = normalizeFilters(opts && opts.filters, st.filters);
      return startSync(f, false);
    }
    function startSync(f, force) {
      if (st.disposed) return Promise.resolve();
      var key = filtersKey(f);
      if (!force && st.inflight && st.inflight.key === key) return st.inflight.promise;
      if (st.inflight && st.inflight.ctl) { try { st.inflight.ctl.abort(); } catch (_) { /* ignore */ } }
      st.filters = f;
      // Não sobrescreve um campo de período que a pessoa está editando.
      if (doc.activeElement !== top.from) top.from.value = f.from;
      if (doc.activeElement !== top.to) top.to.value = f.to;
      var g = ++st.gen;
      var ctl = AbortCtl ? new AbortCtl() : null;
      var entry = { key: key, gen: g, ctl: ctl, promise: null };
      st.inflight = entry;
      entry.promise = run(g, f, ctl).then(function () { if (st.inflight === entry) st.inflight = null; }, function () { if (st.inflight === entry) st.inflight = null; });
      return entry.promise;
    }
    function run(g, f, ctl) {
      st.syncing = true; renderAll();
      var attempt = 0;
      function finish() {
        if (!alive(g)) return;
        st.syncing = false;
        // Gravação confirmada continua confirmada; aqui só se registra se a leitura posterior funcionou.
        if (st.op && st.op.phase === 'confirmed') { var lv = st.views.links; st.op.refresh = hasData(lv) && !lv.refreshFailed ? 'ok' : 'failed'; }
        renderAll();
      }
      function once() {
        if (!has('context') || !has('read')) { blockAll('Gateway do Orgânico não instalado pelo integrador; leitura e ações fechadas.', 'unavailable'); return Promise.resolve(); }
        var cp;
        try { cp = Promise.resolve(gw.context()); } catch (e) { cp = Promise.reject(e); }
        return cp.then(function (ctx) {
          if (!alive(g)) return null;
          var chk = checkContext(ctx);
          if (!chk.ok) { blockAll(chk.reason, 'forbidden'); return null; }
          adoptContext(ctx);
          renderAll();
          return Promise.all(RESOURCES.map(function (r) { return readOne(r, ctx, f, ctl); })).then(function (res) {
            if (!alive(g)) return null;
            if (res.some(function (x) { return x.mismatch; })) {
              if (attempt === 0) { attempt++; return once(); }
              RESOURCES.forEach(function (r) { setView(r, { status: 'discarded', reason: 'O contexto mudou durante a leitura; nada foi exibido. Atualize a leitura.' }); });
              st.lastSync = { ok: false };
              return null;
            }
            res.forEach(function (x) { applyRead(x, ctx); });
            st.lastSync = { ok: res.every(function (x) { return !x.error; }) };
            var lv = st.views.links;
            if (st.writeLock && st.pendingKnown && st.pending.length === 0 && hasData(lv) && !lv.refreshFailed) st.writeLock = false;
            return null;
          });
        }, function (e) {
          if (!alive(g)) return null;
          // Falha ao ler o contexto: não há prova de acesso atual. Dados anteriores ficam só como leitura marcada.
          RESOURCES.forEach(function (r) {
            var v = st.views[r];
            if (hasData(v)) { v.refreshFailed = true; v.refreshReason = publicReason(e); }
            else setView(r, { status: 'error', reason: 'Contexto não confirmado: ' + publicReason(e) });
          });
          st.lastSync = { ok: false };
          return null;
        });
      }
      return once().then(finish, finish);
    }
    function dispose() {
      if (st.disposed) return;
      st.disposed = true;
      st.gen++;
      if (st.inflight && st.inflight.ctl) { try { st.inflight.ctl.abort(); } catch (_) { /* ignore */ } }
      st.inflight = null; st.op = null;
      rootEl.removeEventListener('click', onClick);
      rootEl.removeEventListener('submit', onSubmit);
      rootEl.removeEventListener('input', onDraft);
      rootEl.removeEventListener('change', onDraft);
      if (rootEl.parentNode === element) element.removeChild(rootEl);
    }

    // ---------- Gravação (somente via operação do gateway) ----------
    function opOpen() { return !!st.op && OPEN_OP_PHASES.indexOf(st.op.phase) >= 0; }
    function writeBlock(kind) {
      if (!has('beginMutation') || !has('submit')) return 'Gravação não instalada no gateway; operação indisponível.';
      if (!st.ctx) return st.blocked || 'Sem contexto confirmado.';
      if (!C102) return 'Normalizador do contrato 1.0.2 ausente; gravação indisponível.';
      if (!st.nctx) return 'Contexto fora do contrato 1.0.2; gravação indisponível.';
      var hd = holdOf(st.nctx.effectiveBrand, st.nctx.principalReference, false);
      if (hd && hd.lost) return 'Uma preparação anterior desta marca ficou sem confirmação e sem ID; gravação fechada até Root comprovar a recuperação.';
      if (hd && hd.carried.length) return 'Há operação anterior desta marca aguardando consulta de resultado; gravação fechada.';
      var c = st.nctx.capabilities[kind];
      if (!c.available) return c.reason || 'Operação não admitida pelo integrador para esta marca/papel.';
      if (!st.pendingKnown) return 'O contexto não informou o journal de operações; gravação bloqueada.';
      if (st.pending.length) return 'Há operação pendente no journal; consulte o resultado antes de gravar de novo.';
      if (opOpen()) return 'Há uma operação em andamento ou com resultado desconhecido.';
      if (st.op && st.op.phase === 'confirmed' && st.op.refresh !== 'ok') return 'Gravação confirmada; atualize a leitura antes de outra gravação.';
      if (st.writeLock) return 'Preparação anterior sem confirmação; atualize a leitura antes de tentar de novo.';
      if (st.syncing) return 'Atualizando leitura…';
      var lv = st.views.links;
      if (!hasData(lv) || lv.refreshFailed) return 'Lista de links sem leitura atual; atualize antes de gravar.';
      if (lv.meta && lv.meta.freshness === 'stale') return 'Retrato antigo é somente leitura; atualize antes de gravar.';
      if (C102 && !linksCurrent()) return 'Leitura de links sem cobertura completa e frescor atual; gravação fechada.';
      return null;
    }
    function linksCurrent() {
      var lv = st.views.links;
      return !!(st.ctx && hasData(lv) && lv.typed102 && !lv.refreshFailed && lv.ctxRev === st.ctx.contextRevision && lv.meta && lv.meta.coverage === 'complete' && lv.meta.freshness === 'fresh');
    }
    // Bloqueios causais em memória por escopo exato marca/principal, na vida da instância (sem store, relógio ou ID).
    function holdOf(brand, principal, create) {
      if (!st.holds) st.holds = Object.create(null);
      var key = JSON.stringify([String(brand), principal == null ? null : String(principal)]);
      if (!st.holds[key] && create) st.holds[key] = { lost: false, carried: [] };
      return st.holds[key] || null;
    }
    function carriedNow() {
      var hd = st.nctx ? holdOf(st.nctx.effectiveBrand, st.nctx.principalReference, false) : null;
      return hd ? hd.carried : [];
    }
    function submitGate(op) {
      var c = st.nctx && st.nctx.capabilities[op.kind];
      if (!c || !c.available) return 'Permissão retirada: a operação ' + op.operationId + ' fica preparada e não é executada.';
      if (!st.pendingKnown) return 'Journal indisponível: a operação ' + op.operationId + ' fica preparada e não é executada.';
      if (!linksCurrent()) return 'Leitura de links sem cobertura completa e frescor atual: a operação ' + op.operationId + ' fica preparada e não é executada.';
      return null;
    }
    function canCopy() {
      var lv = st.views.links;
      return hasData(lv) && !lv.refreshFailed && lv.meta && lv.meta.freshness !== 'stale' && (!C102 || linksCurrent());
    }
    function opStale(op) { return st.disposed || st.op !== op || !st.ctx || st.ctx.contextRevision !== op.ctxRev; }
    function begin(kind, args, summary) {
      var block = writeBlock(kind);
      if (block) { st.message = block; renderAll(); return Promise.resolve(); }
      var ctx = st.ctx;
      var ic = C102.normalizeOperation({ kind: kind, contextRevision: ctx.contextRevision, effectiveBrand: ctx.effectiveBrand, payload: args.payload, recordId: args.recordId, expectedRecordRevision: args.expectedRecordRevision });
      if (ic.state !== 'valid') { st.message = 'Pedido fora do contrato 1.0.2; nada foi preparado.'; renderAll(); return Promise.resolve(); }
      var op = { kind: kind, phase: 'preparing', ctxRev: ctx.contextRevision, brand: ctx.effectiveBrand, summary: summary, operationId: null, refresh: null, draftToken: kind === 'link.create' ? st.draftToken : null, intent: ic.value.intent, principal: st.nctx.principalReference };
      st.op = op; st.message = ''; renderAll();
      var req = { kind: kind, payload: args.payload, expectedContextRevision: op.ctxRev };
      if (args.recordId != null) req.recordId = args.recordId;
      if (args.expectedRecordRevision != null) req.expectedRecordRevision = args.expectedRecordRevision;
      var p;
      try { p = Promise.resolve(gw.beginMutation(req)); } catch (e) { p = Promise.reject(e); }
      return p.then(function (env) {
        if (opStale(op)) return;
        if (C102) { applyBegin102(op, env); return; }
        if (!isObj(env) || !revOk(env.operationId) || env.contextRevision !== op.ctxRev || (bindingBrand(env.binding) !== undefined && bindingBrand(env.binding) !== op.brand)) {
          if (isObj(env) && revOk(env.operationId) && env.contextRevision === op.ctxRev) {
            op.operationId = env.operationId; op.phase = 'uncertain'; op.reason = 'Preparação com vínculo inconsistente; consulte o resultado.';
          } else { st.op = null; st.writeLock = true; st.message = 'Preparação sem confirmação válida. Nada foi executado; atualize a leitura antes de tentar de novo.'; }
          renderAll(); return;
        }
        op.operationId = env.operationId; op.binding = isObj(env.binding) ? env.binding : null;
        if (env.state === 'prepared') op.phase = 'prepared';
        else if (env.state === 'rejected') { op.phase = 'rejected'; op.reason = str(env.reason) ? env.reason : 'Recusada pelo servidor.'; }
        else if (env.state === 'confirmed') { op.phase = 'uncertain'; op.reason = 'Estado inesperado na preparação; consulte o resultado.'; }
        else { op.phase = 'uncertain'; op.reason = str(env.reason) ? env.reason : 'Resultado não confirmado.'; }
        renderAll();
        if (op.phase === 'prepared') refocus('op-confirm');
      }, function () {
        if (opStale(op)) return;
        st.op = null; st.writeLock = true;
        if (C102) holdOf(op.brand, op.principal, true).lost = true;
        st.message = PREPARE_LOST_TEXT;
        renderAll();
      });
    }
    function applyBegin102(op, env) {
      var n = C102.normalizeOperation(op.intent, env);
      if (n.state === 'valid') {
        op.operationId = n.value.operationId; op.binding = n.value.binding;
        if (n.value.opState === 'prepared') op.phase = 'prepared';
        else if (n.value.opState === 'rejected') { op.phase = 'rejected'; op.reason = n.value.publicReason || 'Recusada pelo servidor.'; }
        else { op.phase = 'uncertain'; op.reason = n.value.publicReason || 'Estado inesperado na preparação; consulte o resultado.'; }
      } else if (isObj(env) && revOk(env.operationId) && env.contextRevision === op.ctxRev) {
        op.operationId = env.operationId; op.phase = 'uncertain'; op.reason = 'Preparação com vínculo inválido (' + n.reason + '); só a consulta do resultado é permitida.';
      } else {
        st.op = null; holdOf(op.brand, op.principal, true).lost = true;
        st.message = 'Preparação sem resposta válida e sem ID. Nada foi executado por esta tela; gravação fechada até Root comprovar a recuperação.';
      }
      renderAll();
      if (op.phase === 'prepared' && st.op === op) refocus('op-confirm');
    }
    function applyOp102(op, env, via) {
      var expected = op.intent ? Object.assign({ operationId: op.operationId }, op.intent) : { operationId: op.operationId, kind: op.kind || null, contextRevision: op.ctxRev, effectiveBrand: op.brand };
      var n = C102.normalizeOperation(expected, env);
      if (n.state !== 'valid') { op.phase = 'uncertain'; op.reason = opInvalidText(n.reason); return; }
      var v = n.value;
      op.receiptReference = v.receiptReference;
      if (!op.kind) op.kind = v.binding.kind;
      if (v.opState === 'confirmed') { op.phase = 'confirmed'; op.result = v.result; op.resultState = v.resultState; op.refresh = 'pending'; op.reason = null; }
      else if (v.opState === 'rejected') { op.phase = 'rejected'; op.reason = v.publicReason || 'Recusada pelo servidor.'; }
      else { op.phase = 'uncertain'; op.reason = v.publicReason || (via === 'receipt' ? 'Ainda sem resultado final.' : 'Sem confirmação final.'); }
    }
    function applyOpEnvelope(op, env, via) {
      if (C102) { applyOp102(op, env, via); return; }
      if (!isObj(env) || env.operationId !== op.operationId) { op.phase = 'uncertain'; op.reason = 'Resposta não corresponde à operação original; descartada.'; return; }
      if (env.contextRevision !== op.ctxRev) { op.phase = 'uncertain'; op.reason = 'Resposta de outro contexto descartada.'; return; }
      var bb = bindingBrand(env.binding);
      var rb = isObj(env.result) ? env.result.brandId : undefined;
      if ((bb !== undefined && bb !== op.brand) || (rb !== undefined && rb !== null && rb !== op.brand)) { op.phase = 'uncertain'; op.reason = 'Resposta de outra marca descartada.'; return; }
      op.receiptReference = revOk(env.receiptReference) ? env.receiptReference : null;
      if (env.state === 'confirmed') { op.phase = 'confirmed'; op.result = isObj(env.result) ? env.result : null; op.refresh = 'pending'; op.reason = null; }
      else if (env.state === 'rejected') { op.phase = 'rejected'; op.reason = str(env.reason) ? env.reason : 'Recusada pelo servidor.'; }
      else { op.phase = 'uncertain'; op.reason = str(env.reason) ? env.reason : (via === 'receipt' ? 'Ainda sem resultado final.' : 'Sem confirmação final.'); }
    }
    function afterConfirmed(op) {
      // Fecha apenas o rascunho original; uma edição posterior pertence à próxima intenção.
      if (op.kind === 'link.create' && !op.fromJournal && op.draftToken === st.draftToken) clearDraft();
      renderAll();
      // ACK confirmado: só a leitura é atualizada. Falha de leitura não desfaz a confirmação.
      return startSync(st.filters, true);
    }
    function confirmOp() {
      var op = st.op;
      if (!op || op.phase !== 'prepared') return Promise.resolve();
      if (opStale(op)) { st.op = null; renderAll(); return Promise.resolve(); }
      if (C102 && submitGate(op)) { st.message = submitGate(op); renderAll(); return Promise.resolve(); }
      op.phase = 'submitting'; renderAll();
      var p;
      try { p = Promise.resolve(gw.submit({ operationId: op.operationId, expectedContextRevision: op.ctxRev })); } catch (e) { p = Promise.reject(e); }
      return p.then(function (env) {
        if (opStale(op)) return null;
        applyOpEnvelope(op, env, 'submit');
        if (op.phase === 'confirmed') return afterConfirmed(op);
        renderAll(); refocus('op-receipt');
        return null;
      }, function () {
        if (opStale(op)) return null;
        op.phase = 'uncertain'; op.reason = 'Confirmação não recebida (ACK ausente). A gravação pode ter ocorrido.';
        renderAll(); refocus('op-receipt');
        return null;
      });
    }
    function checkReceipt(operationId) {
      if (!has('receipt')) { st.message = 'Consulta de resultado não instalada no gateway; gravação segue bloqueada.'; renderAll(); return Promise.resolve(); }
      if (!st.ctx) return Promise.resolve();
      var op = st.op && st.op.operationId === operationId ? st.op : null;
      if (!op) {
        var entry = st.pending.filter(function (p) { return p.operationId === operationId; })[0];
        var carried = C102 ? carriedNow().filter(function (c) { return c.operationId === operationId; })[0] : null;
        if ((!entry && !carried) || opOpen()) return Promise.resolve();
        op = { kind: (carried || entry).kind, phase: 'uncertain', ctxRev: st.ctx.contextRevision, brand: st.ctx.effectiveBrand, operationId: operationId, fromJournal: !(carried && carried.intent) };
        if (carried && carried.intent) { op.intent = Object.assign({}, carried.intent, { contextRevision: st.ctx.contextRevision }); op.principal = st.nctx.principalReference; }
        st.op = op;
      }
      if (op.phase !== 'uncertain') return Promise.resolve();
      op.phase = 'checking'; renderAll();
      var p;
      try { p = Promise.resolve(gw.receipt({ operationId: op.operationId, expectedContextRevision: op.ctxRev })); } catch (e) { p = Promise.reject(e); }
      return p.then(function (env) {
        if (opStale(op)) return null;
        applyOpEnvelope(op, env, 'receipt');
        if (op.phase === 'confirmed' || op.phase === 'rejected') {
          st.pending = st.pending.filter(function (x) { return x.operationId !== op.operationId; });
          if (C102 && st.nctx) { var hc = holdOf(st.nctx.effectiveBrand, st.nctx.principalReference, false); if (hc) hc.carried = hc.carried.filter(function (c) { return c.operationId !== op.operationId; }); }
        }
        if (op.phase === 'confirmed') return afterConfirmed(op);
        renderAll(); refocus('op-receipt');
        return null;
      }, function () {
        if (opStale(op)) return null;
        op.phase = 'uncertain'; op.reason = 'A consulta não respondeu. Nada foi reenviado; consulte de novo.';
        renderAll(); refocus('op-receipt');
        return null;
      });
    }
    function copyText(text, input) {
      var clip = win && win.navigator && win.navigator.clipboard;
      function manual() {
        if (input && typeof input.select === 'function') { try { input.focus(); input.select(); } catch (_) { /* ignore */ } }
        st.message = 'Não foi possível copiar automaticamente. O link está selecionado: use Ctrl+C (Cmd+C no Mac).';
        renderTop();
      }
      if (!clip || typeof clip.writeText !== 'function') { manual(); return Promise.resolve(); }
      var p;
      try { p = Promise.resolve(clip.writeText(text)); } catch (e) { p = Promise.reject(e); }
      return p.then(function () { if (st.disposed) return; st.message = 'Link copiado.'; renderTop(); }, function () { if (st.disposed) return; manual(); });
    }
    function linkById(id) {
      var lv = st.views.links;
      if (!hasData(lv)) return null;
      return lv.items.filter(function (l) { return String(l.id) === id; })[0] || null;
    }

    // ---------- Eventos (delegados no root próprio) ----------
    function actionTarget(node) {
      for (var n = node; n && n !== rootEl.parentNode; n = n.parentNode) {
        if (n.getAttribute && n.getAttribute('data-ov-action')) return n;
        if (n === rootEl) break;
      }
      return null;
    }
    function onClick(ev) {
      var t = actionTarget(ev.target);
      if (!t || t.disabled) return;
      var a = t.getAttribute('data-ov-action');
      if (a === 'refresh') { sync({ filters: { period: { from: st.filters.from, to: st.filters.to }, model: st.filters.model } }); return; }
      if (a === 'model') {
        var m = t.getAttribute('data-ov-model');
        if (MODELS[m] && m !== st.filters.model) sync({ filters: { period: { from: st.filters.from, to: st.filters.to }, model: m } });
        return;
      }
      if (a === 'op-confirm') { confirmOp(); return; }
      if (a === 'op-cancel') { if (st.op && st.op.phase === 'prepared') { st.op = null; st.message = 'Revisão cancelada; nada foi gravado.'; renderAll(); refocus('link-review'); } return; }
      if (a === 'op-dismiss') { if (st.op && (st.op.phase === 'rejected' || (st.op.phase === 'confirmed' && st.op.refresh === 'ok'))) { st.op = null; renderAll(); } return; }
      if (a === 'receipt') { var id = t.getAttribute('data-ov-op'); var op = st.op && String(st.op.operationId) === id ? st.op.operationId : (st.pending.concat(C102 ? carriedNow() : []).filter(function (p) { return String(p.operationId) === id; })[0] || {}).operationId; if (op != null) checkReceipt(op); return; }
      if (a === 'copy') {
        var l = linkById(t.getAttribute('data-ov-link'));
        if (!l || !canCopy() || l.state !== 'active' || !str(l.url) || (C102 && l.copyEligible !== true)) return;
        var inp = null, list = rootEl.querySelectorAll('[data-ov-url]');
        for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-ov-url') === String(l.id)) inp = list[i];
        copyText(l.url, inp); return;
      }
      if (a === 'copy-result') {
        if (st.op && st.op.phase === 'confirmed' && st.op.result && st.op.result.state !== 'archived' && str(st.op.result.url) && (!C102 || st.op.resultState === 'active')) copyText(st.op.result.url, rootEl.querySelector('[data-ov-result-url]'));
        return;
      }
      if (a === 'archive') {
        var al = linkById(t.getAttribute('data-ov-link'));
        if (!al || al.state !== 'active' || (C102 && al.archiveEligible !== true)) return;
        begin('link.archive', { recordId: al.id, payload: {}, expectedRecordRevision: al.revision }, { 'Link': al.url, 'Destino': al.destination });
      }
    }
    function onSubmit(ev) {
      var f = ev.target;
      var name = f && f.getAttribute ? f.getAttribute('data-ov-form') : null;
      if (!name || !inside(f)) return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (name === 'period') {
        var from = String(top.from.value || ''), to = String(top.to.value || '');
        if (!validDay(from) || !validDay(to) || from > to) { st.message = 'Período inválido: use datas completas e “De” antes de “Até”.'; renderTop(); return; }
        sync({ filters: { period: { from: from, to: to }, model: st.filters.model } });
        return;
      }
      if (name === 'link-create') {
        var d = {};
        Object.keys(st.draft).forEach(function (k) { d[k] = String(st.draft[k] || '').trim(); });
        if (!d.destination || !d.origin || !d.surface || !d.campaign) { st.message = 'Preencha destino, origem, superfície e campanha. A validação final é do servidor.'; renderTop(); return; }
        if (!/^https:\/\//i.test(d.destination)) { st.message = 'O destino precisa começar com https://.'; renderTop(); return; }
        if (d.date && !validDay(d.date)) { st.message = 'Data inválida.'; renderTop(); return; }
        var payload = { destination: d.destination, origin: d.origin, surface: d.surface, campaign: d.campaign, date: d.date || null };
        begin('link.create', { payload: payload }, { 'Destino': d.destination, 'Origem': d.origin, 'Superfície': SURFACES[d.surface] || d.surface, 'Campanha': d.campaign, 'Data': d.date ? dayBR(d.date) : 'sem data' });
      }
    }
    function onDraft(ev) {
      var t = ev.target;
      var k = t && t.getAttribute ? t.getAttribute('data-ov-draft') : null;
      if (k && Object.prototype.hasOwnProperty.call(st.draft, k)) {
        var value = String(t.value == null ? '' : t.value);
        if (value !== st.draft[k]) st.draftToken = {};
        st.draft[k] = value;
      }
    }
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('submit', onSubmit);
    rootEl.addEventListener('input', onDraft);
    rootEl.addEventListener('change', onDraft);

    // ---------- Renderização ----------
    function shortState(v) {
      switch (v.status) {
        case 'idle': return 'aguardando leitura';
        case 'loading': return 'carregando';
        case 'forbidden': return 'sem acesso';
        case 'unavailable': return 'indisponível';
        case 'error': return 'desconhecido (falha de leitura)';
        case 'discarded': return 'descartado';
      }
      var m = v.meta || {};
      var parts = [];
      if (v.refreshFailed) parts.push('leitura anterior (falha ao atualizar)');
      if (v.status === 'empty' || (v.items && !v.items.length && !v.data)) parts.push(m.coverage === 'complete' && !v.dropped ? 'vazio confirmado' : 'sem itens, cobertura incompleta');
      parts.push(m.freshness === 'stale' ? 'retrato antigo' : m.freshness === 'fresh' ? 'atual' : 'frescor desconhecido');
      if (m.coverage === 'partial' || v.dropped) parts.push('parcial');
      else if (m.coverage === 'unknown') parts.push('cobertura desconhecida');
      return parts.join(' · ');
    }
    function viewTags(v) {
      var t = [];
      if (v.status === 'loading') return [tag('loading', 'Carregando…')];
      if (v.status === 'idle') return [tag('idle', 'Aguardando leitura')];
      if (v.status === 'forbidden') return [tag('forbidden', 'Sem acesso', v.reason)];
      if (v.status === 'unavailable') return [tag('unavailable', 'Indisponível', v.reason)];
      if (v.status === 'error') return [tag('unknown', 'Desconhecido', v.reason)];
      if (v.status === 'discarded') return [tag('discarded', 'Descartado', v.reason)];
      var m = v.meta;
      if (v.refreshFailed) t.push(tag('refresh-failed', 'Falha ao atualizar', 'Mostrando a leitura anterior desta mesma marca e contexto, somente leitura. ' + (v.refreshReason || '')));
      var noItems = v.status === 'empty' || (Array.isArray(v.items) && v.items.length === 0 && !v.data);
      if (noItems) t.push(m.coverage === 'complete' && !v.dropped ? tag('empty-confirmed', 'Vazio confirmado', 'Coleção completa e válida sem itens no período.') : tag('empty-incomplete', 'Sem itens · cobertura incompleta', 'Ausência de itens não significa zero.'));
      if (m.freshness === 'stale') t.push(tag('stale', 'Retrato antigo', 'Somente leitura; atualize antes de agir.'));
      else if (m.freshness === 'fresh') t.push(tag('fresh', 'Atual'));
      else t.push(tag('freshness-unknown', 'Frescor desconhecido'));
      if (m.coverage === 'partial') t.push(tag('partial', 'Parcial', 'Cobertura parcial: valores existentes não representam o período inteiro.'));
      else if (m.coverage === 'unknown') t.push(tag('coverage-unknown', 'Cobertura desconhecida'));
      if (v.dropped) t.push(tag('brand-dropped', v.dropped + ' item(ns) de outra marca descartado(s)', 'Itens com marca diferente da efetiva não são exibidos; leitura tratada como parcial.'));
      t.push(tag('source', SOURCE_LABEL[m.source], 'Origem declarada pelo gateway.'));
      t.push(tag('collected', m.collectedAt ? 'Coleta: ' + (stamp(m.collectedAt) || m.collectedAt) : 'Coleta sem data', 'Data da coleta na fonte.'));
      if (m.cacheAt) t.push(tag('cache', 'Cache: ' + (stamp(m.cacheAt) || m.cacheAt), 'Momento do cache; não é a data da coleta.'));
      return t;
    }
    function statusBlock(v) {
      var text = v.status === 'loading' ? 'Carregando…' : v.status === 'idle' ? 'Aguardando a primeira leitura.' : v.reason || 'Sem dados.';
      return h('p', { class: 'sov2-note', 'data-ov-note': v.status, text: text });
    }
    function paintSection(resource, bodyFn) {
      var s = sec[resource], v = st.views[resource];
      s.el.setAttribute('data-ov-state', v.status + (v.refreshFailed ? ' refresh-failed' : ''));
      clear(s.tags); append(s.tags, viewTags(v));
      bodyFn(s.body, v);
    }
    function metricsText(m) {
      if (!isObj(m)) return 'métricas indisponíveis';
      var keys = Object.keys(m).filter(function (k) { var x = m[k]; return x === null || typeof x === 'number' || x === undefined; });
      if (!keys.length) return 'métricas indisponíveis';
      return keys.map(function (k) { return (METRIC_LABEL[k] || k) + ': ' + num(m[k]); }).join(' · ');
    }
    function emptyText(v, what) {
      return v.meta && v.meta.coverage === 'complete' && !v.dropped ? 'Nenhum ' + what + ' no período (vazio confirmado).' : 'Nenhum ' + what + ' nesta leitura; cobertura incompleta — ausência não significa zero.';
    }
    function paintPosts(body, v) {
      clear(body);
      if (!hasData(v)) { append(body, statusBlock(v)); return; }
      append(body, h('div', { class: 'sov2-tags' }, tag('no-piece-revenue', 'Sem receita por peça', 'Receita não é distribuída por alcance, clique, nome ou data de campanha.')));
      if (!v.items.length) { append(body, h('p', { class: 'sov2-note', 'data-ov-note': 'empty', text: emptyText(v, 'post') })); return; }
      append(body, scrollTable('Posts da marca; role para ver mais', ['Publicado em', 'Título', 'Tipo', 'Rede', 'Origem', 'Métricas'], v.items.map(function (p) {
        return h('tr', { 'data-ov-item': String(p.id) }, [
          h('td', { text: stamp(p.publishedAt) || 'data desconhecida' }), h('td', { text: str(p.title) ? p.title : 'sem título' }),
          h('td', { text: str(p.kind) ? p.kind : '—' }), h('td', { text: str(p.provider) ? p.provider : 'rede desconhecida' }),
          h('td', { text: SOURCE_LABEL[p.source] || SOURCE_LABEL.unknown }), h('td', { class: 'sov2-metrics', text: metricsText(p.metrics) })
        ]);
      })));
    }
    function paintStories(body, v) {
      clear(body);
      if (!hasData(v)) { append(body, statusBlock(v)); return; }
      append(body, h('div', { class: 'sov2-tags' }, [
        tag('no-piece-revenue', 'Sem receita por peça', 'Receita não é distribuída por alcance, clique, nome ou data de campanha.'),
        tag('expired-kept', 'Expiradas mantidas', 'Stories expiradas continuam na cobertura do período.')
      ]));
      if (!v.items.length) { append(body, h('p', { class: 'sov2-note', 'data-ov-note': 'empty', text: emptyText(v, 'story') })); return; }
      var now = Date.now();
      append(body, scrollTable('Stories da marca; role para ver mais', ['Publicada em', 'Expira em', 'Rede', 'Origem', 'Métricas'], v.items.map(function (s) {
        var exp = typeof s.expiresAt === 'string' ? Date.parse(s.expiresAt) : NaN;
        return h('tr', { 'data-ov-item': String(s.id) }, [
          h('td', { text: stamp(s.publishedAt) || 'data desconhecida' }),
          h('td', { text: isFinite(exp) ? stamp(s.expiresAt) + (exp < now ? ' · expirada (mantida)' : '') : 'desconhecida' }),
          h('td', { text: str(s.provider) ? s.provider : 'rede desconhecida' }),
          h('td', { text: SOURCE_LABEL[s.source] || SOURCE_LABEL.unknown }), h('td', { class: 'sov2-metrics', text: metricsText(s.metrics) })
        ]);
      })));
    }
    function cell(key, value, currency) {
      if (value === null || value === undefined) return /piece|peca/i.test(key) || /^(post|story)_?id$/i.test(key) ? 'desconhecida (sem vínculo)' : 'indisponível';
      if (typeof value === 'number') return !isFinite(value) ? 'indisponível' : /minor$/i.test(key) ? money(value, currency) : value.toLocaleString('pt-BR');
      if (typeof value === 'boolean') return value ? 'sim' : 'não';
      if (typeof value === 'string') {
        if (/^receita_/.test(key)) return decimalMajor(value, currency);
        if (validDay(value)) return dayBR(value);
        if (/^\d{4}-\d{2}-\d{2}T/.test(value) && stamp(value)) return stamp(value);
        return value;
      }
      var s = JSON.stringify(value); return s.length > 200 ? s.slice(0, 200) + '…' : s;
    }
    function generic(label, value, currency, pick) {
      if (value === null || value === undefined) return h('p', { class: 'sov2-note', text: label + ': não fornecido pelo gateway.' });
      if (Array.isArray(value)) {
        var rows = value.filter(isObj);
        if (!rows.length) return h('p', { class: 'sov2-note', text: label + ': ' + (value.length ? value.map(function (x) { return cell('', x, currency); }).join(' · ') : 'nenhuma linha') });
        var cols = Array.isArray(pick) ? pick.slice() : [];
        if (!Array.isArray(pick)) rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0 && cols.length < 12) cols.push(k); }); });
        return h('div', { class: 'sov2-block', 'data-ov-block': label }, [h('h4', { text: label }), scrollTable(label + '; role para ver mais', cols.map(function (k) { return FIELD_LABEL[k] || k; }), rows.map(function (r) {
          return h('tr', null, cols.map(function (k) { return h('td', { text: r.detail_level === 'channel_summary' && r[k] === null && CHANNEL_SUMMARY_FIELDS.indexOf(k) >= 0 ? 'não transmitido (resumo de canal)' : cell(k, r[k], currency) }); }));
        }))]);
      }
      if (isObj(value)) {
        return h('div', { class: 'sov2-block', 'data-ov-block': label }, [h('h4', { text: label }), h('dl', { class: 'sov2-dl' }, Object.keys(value).map(function (k) {
          return [h('dt', { text: FIELD_LABEL[k] || k }), h('dd', { text: cell(k, value[k], currency) })];
        }))]);
      }
      return h('p', { class: 'sov2-note', text: label + ': ' + cell(label, value, currency) });
    }
    function periodText(p) {
      if (isObj(p) && validDay(p.from) && validDay(p.to)) return dayBR(p.from) + ' a ' + dayBR(p.to);
      return str(p) ? p : 'período não informado';
    }
    function paintAttribution(body, v) {
      clear(body);
      var model = st.filters.model;
      append(body, h('div', { class: 'sov2-models', role: 'group', 'aria-label': 'Modelo de atribuição (alternativas, não somar)' }, Object.keys(MODELS).map(function (k) {
        return h('button', { type: 'button', class: 'sov2-btn sov2-btn--seg', 'data-ov-action': 'model', 'data-ov-model': k, 'data-ov-focus': 'model-' + k, 'aria-pressed': k === model ? 'true' : 'false', text: MODELS[k] });
      })));
      append(body, h('div', { class: 'sov2-tags' }, [
        tag('models-alternative', 'Modelos alternativos — não somar', 'Último clique e último clique não direto são leituras alternativas do mesmo pedido.'),
        tag('sources-not-additive', 'Fontes não se somam', 'Editorial, Bio, DM, Ads, CRM, cupom e TikTok nativo não são parcelas somáveis entre fontes.'),
        tag('no-causality', 'Atribuição ≠ causalidade', 'Crédito de atribuição não prova que a peça causou a venda.'),
        tag('piece-unknown', 'Peça sem vínculo = desconhecida', 'Sem vínculo comprovado com post/story, a peça permanece desconhecida.')
      ]));
      if (!hasData(v)) { append(body, statusBlock(v)); return; }
      if (v.status === 'empty' || !v.data) { append(body, h('p', { class: 'sov2-note', 'data-ov-note': 'empty', text: v.meta.coverage === 'complete' ? 'Nenhum pedido atribuído no período e modelo (vazio confirmado).' : 'Sem dados de atribuição nesta leitura; cobertura incompleta — não é zero.' })); return; }
      var d = v.data, cur = str(d.currency) ? d.currency : null;
      append(body, h('dl', { class: 'sov2-dl sov2-dl--inline', 'data-ov-attr-meta': '' }, [
        h('dt', { text: 'Modelo' }), h('dd', { 'data-ov-attr-model': d.model, text: MODELS[d.model] }),
        h('dt', { text: 'Período' }), h('dd', { text: periodText(d.period) }),
        h('dt', { text: 'Janela' }), h('dd', { text: v.typed102 ? (d.window && d.window.days !== null ? d.window.days + ' dias' : 'não informada pelo gateway') + (d.window && d.window.sourceSystem ? ' · ' + d.window.sourceSystem : '') + (d.window && d.window.ruleVersion ? ' · regra ' + d.window.ruleVersion : '') : d.window != null ? cell('window', d.window) : 'não informada pelo gateway' }),
        h('dt', { text: 'Moeda' }), h('dd', { text: cur || 'não informada' }),
        h('dt', { text: 'Fonte' }), h('dd', { text: SOURCE_LABEL[v.meta.source] })
      ]));
      if (v.typed102) append(body, [
        generic('Por dia', d.daily, cur, ['dia', 'classification', 'detail_level', 'rede', 'superficie', 'utm_source', 'utm_medium', 'utm_campaign', 'piece_status', 'pedidos', 'receita_liquida']),
        generic('Qualidade', d.quality, cur, ['dia', 'pedidos_lidos', 'pagos_elegiveis', 'receita_elegivel', 'jornada_pendente', 'jornada_parcial', d.model === 'last_click' ? 'ultima_sessao_desconhecida' : 'origem_nao_direta_desconhecida']),
        generic('Cobertura', d.coverage, cur, ['dia', 'checked_at'])
      ]);
      else append(body, [generic('Por dia', d.daily, cur), generic('Qualidade', d.quality, cur), generic('Cobertura', d.coverage, cur)]);
    }
    function paintOrders(body, v) {
      clear(body);
      append(body, h('div', { class: 'sov2-tags' }, tag('not-derived', 'Não derivado do agregado', 'Pedidos individuais nunca são deduzidos do agregado UTM.')));
      if (v.status === 'ready' && v.items.length) {
        append(body, scrollTable('Pedidos atribuídos admitidos; role para ver mais', ['Pedido', 'Modelo', 'Valor', 'Fonte', 'Janela'], v.items.map(function (it) {
          return h('tr', null, [h('td', { text: cell('orderReference', it.orderReference) }), h('td', { text: MODELS[it.model] || String(it.model) }),
            h('td', { text: money(it.amountMinor, v.currency) }), h('td', { text: cell('source', it.source) }), h('td', { text: cell('window', it.window) })]);
        })));
        return;
      }
      if (hasData(v)) { append(body, h('p', { class: 'sov2-note', 'data-ov-note': 'empty', text: emptyText(v, 'pedido') })); return; }
      if (v.status === 'loading' || v.status === 'idle') { append(body, statusBlock(v)); return; }
      append(body, h('p', { class: 'sov2-note', 'data-ov-note': 'orders-blocked', text: 'Detalhe por pedido bloqueado/desconhecido: ' + (v.reason || 'DTO por pedido ainda não admitido pelo RootGateway.') }));
    }
    function kv(obj) {
      return h('dl', { class: 'sov2-dl' }, Object.keys(obj).filter(function (k) { var x = obj[k]; return x === null || typeof x !== 'object'; }).map(function (k) {
        return [h('dt', { text: k }), h('dd', { text: cell(k, obj[k]) })];
      }));
    }
    function paintOp() {
      clear(lk.op);
      var op = st.op;
      lk.op.setAttribute('data-ov-op', op ? op.phase : '');
      if (!op) return;
      var kind = KIND_LABEL[op.kind] || 'Operação';
      var idText = op.operationId != null ? 'Operação ' + String(op.operationId) : null;
      var out = [h('h4', { text: kind })];
      if (op.phase === 'preparing') out.push(h('p', { text: 'Preparando a operação no gateway… nada foi gravado.' }));
      if (op.phase === 'prepared') {
        out.push(h('p', { text: 'Revise antes de confirmar. Nada foi gravado ainda. Marca: ' + brandName(op.brand) + '.' }));
        if (op.summary) out.push(kv(op.summary));
        if (op.binding) out.push(h('details', null, [h('summary', { text: 'Vínculo registrado pelo servidor' }), kv(op.binding)]));
        out.push(h('div', { class: 'sov2-actions' }, [
          h('button', { type: 'button', class: 'sov2-btn', 'data-ov-action': 'op-confirm', 'data-ov-focus': 'op-confirm', disabled: !!(C102 && submitGate(op)), title: (C102 && submitGate(op)) || null, text: op.kind === 'link.archive' ? 'Confirmar arquivamento' : 'Confirmar criação' }),
          h('button', { type: 'button', class: 'sov2-btn sov2-btn--sec', 'data-ov-action': 'op-cancel', 'data-ov-focus': 'op-cancel', text: 'Cancelar' })
        ]));
      }
      if (op.phase === 'submitting') out.push(h('p', { text: 'Enviando a confirmação… não repita a ação.' }));
      if (op.phase === 'checking') out.push(h('p', { text: 'Consultando o resultado da mesma operação…' }));
      if (op.phase === 'uncertain') {
        out.push(h('p', { 'data-ov-op-state': 'uncertain', text: 'Resultado desconhecido. ' + (op.reason || '') + ' Nova gravação bloqueada até o resultado desta mesma operação ser consultado.' }));
        out.push(h('button', { type: 'button', class: 'sov2-btn', 'data-ov-action': 'receipt', 'data-ov-op': String(op.operationId), 'data-ov-focus': 'op-receipt', disabled: !has('receipt'), text: 'Consultar resultado' }));
        if (!has('receipt')) out.push(h('p', { class: 'sov2-note', text: 'Consulta de resultado não instalada no gateway.' }));
      }
      if (op.phase === 'rejected') {
        out.push(h('p', { 'data-ov-op-state': 'rejected', text: 'Recusada pelo servidor: ' + (op.reason || 'sem motivo informado') + '. Nada foi gravado.' }));
        out.push(h('button', { type: 'button', class: 'sov2-btn sov2-btn--sec', 'data-ov-action': 'op-dismiss', 'data-ov-focus': 'op-dismiss', text: 'Fechar aviso' }));
      }
      if (op.phase === 'confirmed') {
        out.push(h('p', { 'data-ov-op-state': 'confirmed', text: (op.kind === 'link.archive' ? 'Arquivamento confirmado pelo servidor (histórico preservado).' : 'Criação confirmada pelo servidor.') + (op.receiptReference != null ? ' Recibo: ' + op.receiptReference + '.' : '') }));
        if (op.kind === 'link.create' && op.result && op.result.state === 'archived') {
          out.push(h('p', { 'data-ov-op-state': 'archived-existing', text: 'O servidor devolveu um link já arquivado com o mesmo endereço. Ele não foi reativado e não deve ser divulgado.' }));
        } else if (C102 && op.kind === 'link.create' && op.resultState !== 'active') {
          // 1.0.2: resultado confirmado sem projeção ativa (null/unknown) não oferece cópia; arquivado segue o ramo Root2 acima.
          out.push(h('p', { 'data-ov-op-state': 'result-unknown', text: 'Confirmado, mas sem projeção utilizável do link; nada para copiar até a releitura.' }));
        } else if (op.kind === 'link.create' && op.result && str(op.result.url)) {
          out.push(h('div', { class: 'sov2-url' }, [
            h('input', { type: 'text', readonly: true, value: op.result.url, 'data-ov-result-url': '', 'aria-label': 'Link confirmado' }),
            h('button', { type: 'button', class: 'sov2-btn sov2-btn--sec', 'data-ov-action': 'copy-result', 'data-ov-focus': 'copy-result', text: 'Copiar' })
          ]));
        }
        if (op.refresh === 'pending') out.push(h('p', { 'data-ov-refresh': 'pending', text: 'Atualizando a lista…' }));
        if (op.refresh === 'ok') out.push(h('p', { 'data-ov-refresh': 'ok', text: 'Lista atualizada.' }), h('button', { type: 'button', class: 'sov2-btn sov2-btn--sec', 'data-ov-action': 'op-dismiss', 'data-ov-focus': 'op-dismiss', text: 'Fechar aviso' }));
        if (op.refresh === 'failed') out.push(h('p', { 'data-ov-refresh': 'failed', text: 'A lista não pôde ser atualizada; a gravação continua confirmada. Só a leitura pode ser repetida.' }),
          h('button', { type: 'button', class: 'sov2-btn', 'data-ov-action': 'refresh', 'data-ov-focus': 'op-refresh', text: 'Atualizar leitura' }));
      }
      if (idText) out.push(h('p', { class: 'sov2-mini', text: idText }));
      append(lk.op, out);
    }
    // R6 — só texto: com a capability link.create normalizada indisponível, a razão pública dela aparece junto da razão
    // principal devolvida por writeBlock (que não muda de ordem nem de efeito). Ausente/malformada: texto fixo.
    function capCreateNote(block) {
      if (!C102 || !block || !st.nctx || !st.nctx.capabilities) return '';
      var c = st.nctx.capabilities['link.create'];
      if (!c || c.available === true) return '';
      var note = c.known === true && str(c.reason) ? c.reason : CAP_CREATE_UNCONFIRMED;
      if (block === note || block === CAP_DEFAULT_BLOCK || block.indexOf(note) >= 0) return '';
      return ' ' + note;
    }
    function paintLinks(body, v) {
      var block = writeBlock('link.create');
      lk.submit.disabled = !!block;
      lk.cap.textContent = block ? 'Criação indisponível: ' + block + capCreateNote(block) : 'Criação disponível. O servidor valida destino, marca, origem, superfície e autoria.';
      lk.cap.setAttribute('data-ov-cap-state', block ? 'closed' : 'open');
      paintOp();
      clear(lk.pending);
      var pend = st.pending.concat((C102 ? carriedNow() : []).filter(function (c) { return !st.pending.some(function (p) { return p.operationId === c.operationId; }); }).map(function (c) { return { operationId: c.operationId, kind: c.kind }; })).filter(function (p) { return !st.op || p.operationId !== st.op.operationId; });
      if (pend.length) append(lk.pending, [h('h4', { text: 'Operações pendentes no journal' }), h('ul', null, pend.map(function (p) {
        return h('li', null, [(KIND_LABEL[p.kind] || 'Operação') + ' ' + String(p.operationId) + ' ',
          h('button', { type: 'button', class: 'sov2-btn sov2-btn--sec', 'data-ov-action': 'receipt', 'data-ov-op': String(p.operationId), disabled: !has('receipt') || opOpen(), text: 'Consultar resultado' })]);
      }))]);
      clear(lk.list);
      if (!hasData(v)) { append(lk.list, statusBlock(v)); return; }
      var active = v.items.filter(function (l) { return l.state === 'active'; });
      var archived = v.items.filter(function (l) { return l.state === 'archived'; });
      var unknownState = v.items.filter(function (l) { return l.state !== 'active' && l.state !== 'archived'; });
      var archBlock = writeBlock('link.archive'), copyOk = canCopy();
      if (!active.length) append(lk.list, h('p', { class: 'sov2-note', 'data-ov-note': 'empty', text: emptyText(v, 'link ativo') }));
      else append(lk.list, scrollTable('Links UTM ativos; role para ver mais', ['Criado em', 'Superfície', 'Origem', 'Destino', 'Link', 'Estado', 'Ações'], active.map(function (l) {
        var id = String(l.id);
        return h('tr', { 'data-ov-link-row': id }, [
          h('td', { text: stamp(l.createdAt) || 'data desconhecida' }), h('td', { text: SURFACES[l.surface] || cell('surface', l.surface) }),
          h('td', { text: cell('origin', l.origin) }), h('td', { class: 'sov2-wrap', text: cell('destination', l.destination) }),
          h('td', null, h('input', { type: 'text', readonly: true, value: str(l.url) ? l.url : '', 'data-ov-url': id, 'aria-label': 'Link completo' })),
          h('td', { text: LINK_STATE[l.state] || cell('state', l.state) }),
          h('td', { class: 'sov2-actions' }, [
            h('button', { type: 'button', class: 'sov2-btn sov2-btn--sec', 'data-ov-action': 'copy', 'data-ov-link': id, 'data-ov-focus': 'copy-' + id, disabled: !copyOk || !str(l.url) || (C102 && l.copyEligible !== true), title: copyOk ? null : 'Leitura não atual; atualize antes de copiar.', text: 'Copiar' }),
            h('button', { type: 'button', class: 'sov2-btn sov2-btn--sec', 'data-ov-action': 'archive', 'data-ov-link': id, 'data-ov-focus': 'archive-' + id, disabled: !!archBlock || (C102 && l.archiveEligible !== true), title: archBlock || (C102 && l.archiveEligible !== true ? 'Registro sem revisão real; arquivamento indisponível.' : 'Arquiva preservando o histórico.'), text: 'Arquivar' })
          ])
        ]);
      })));
      if (archived.length) append(lk.list, h('details', { class: 'sov2-archive' }, [h('summary', { text: 'Histórico arquivado (' + archived.length + ')' }),
        scrollTable('Links arquivados; somente leitura', ['Criado em', 'Superfície', 'Origem', 'Destino', 'Link'], archived.map(function (l) {
          return h('tr', { 'data-ov-archived-row': String(l.id) }, [h('td', { text: stamp(l.createdAt) || 'data desconhecida' }), h('td', { text: SURFACES[l.surface] || cell('surface', l.surface) }),
            h('td', { text: cell('origin', l.origin) }), h('td', { class: 'sov2-wrap', text: cell('destination', l.destination) }), h('td', { class: 'sov2-wrap', text: cell('url', l.url) })]);
        }))]));
      if (unknownState.length) append(lk.list, h('details', { class: 'sov2-archive', 'data-ov-unknown-links': '' }, [h('summary', { text: 'Estado desconhecido (' + unknownState.length + ') · sem ações' }),
        scrollTable('Links com estado desconhecido; somente leitura', ['Criado em', 'Superfície', 'Origem', 'Destino', 'Link'], unknownState.map(function (l) {
          return h('tr', { 'data-ov-unknown-row': String(l.id) }, [h('td', { text: stamp(l.createdAt) || 'data desconhecida' }), h('td', { text: SURFACES[l.surface] || cell('surface', l.surface) }),
            h('td', { text: cell('origin', l.origin) }), h('td', { class: 'sov2-wrap', text: cell('destination', l.destination) }), h('td', { class: 'sov2-wrap', text: cell('url', l.url) })]);
        }))]));
    }
    function renderTop() {
      var ctx = st.ctx;
      top.brand.textContent = ctx ? brandName(ctx.effectiveBrand) : 'Marca não confirmada';
      top.brand.setAttribute('data-ov-brand', ctx ? String(ctx.effectiveBrand) : '');
      top.role.textContent = ctx ? 'Papel: ' + (ROLE_LABEL[ctx.role] || 'não informado') + ' · ações dependem da permissão do servidor' : '';
      clear(top.summary);
      append(top.summary, RESOURCES.map(function (r) {
        return h('li', { 'data-ov-summary': r }, [h('strong', { text: TITLES[r] + ': ' }), shortState(st.views[r])]);
      }));
      top.source.textContent = ctx ? 'Revisão da fonte: ' + (revOk(ctx.sourceRevision) ? String(ctx.sourceRevision) : 'não informada') + (st.syncing ? ' · atualizando…' : '') : (st.blocked || (st.syncing ? 'Lendo contexto…' : 'Sem leitura ainda.'));
      top.refresh.disabled = st.disposed;
      top.status.textContent = st.message || '';
    }
    function renderAll() {
      if (st.disposed) return;
      var key = focusedKey();
      renderTop();
      paintSection('posts', paintPosts);
      paintSection('stories', paintStories);
      paintSection('attribution-aggregate', paintAttribution);
      paintSection('attribution-order-if-admitted', paintOrders);
      paintSection('links', paintLinks);
      refocus(key);
    }
    renderAll();

    return { sync: sync, dispose: dispose };
  }

  return { create: create, contractVersion: CONTRACT_VERSION };
});
