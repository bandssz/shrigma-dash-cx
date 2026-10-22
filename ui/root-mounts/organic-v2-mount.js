/* Root-owned presentation host. No adapter, credential, endpoint or store is supplied here. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShrigmaOrganicRootMount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function day(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var t = Date.parse(v + 'T12:00:00Z');
    return isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }
  function filters(value) {
    var p = value && value.period, model = value && value.model;
    if (!p || !day(p.from) || !day(p.to) || p.from > p.to) return null;
    if (model !== undefined && model !== 'last_click' && model !== 'last_non_direct') return null;
    return { period: { from: p.from, to: p.to }, model: model || 'last_click' };
  }
  function refusal() {
    var e = new Error('ORGANIC_ROOT_SCOPE_UNAVAILABLE');
    e.publicReason = 'A marca ou o acesso mudou. Aguarde uma leitura autorizada para esta área.';
    return e;
  }
  function create(options) {
    var o = options || {}, el = o.element, doc = o.document, component = o.component;
    if (!el || !doc || typeof doc.createElement !== 'function' || typeof o.getScopeHint !== 'function') throw new TypeError('ORGANIC_ROOT_HOST_INVALID');
    var disposed = false, active = false, generation = 0, gateway = null, installedHint = null, view = null, requestedFilters = null;
    function hint() { return o.getScopeHint(); }
    function clear() { while (el.firstChild) el.removeChild(el.firstChild); }
    function message(text) {
      clear();
      var box = doc.createElement('section'), title = doc.createElement('h2'), note = doc.createElement('p');
      box.setAttribute('class', 'painel'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
      title.textContent = 'Orgânico integrado'; note.textContent = text;
      box.appendChild(title); box.appendChild(note); el.appendChild(box);
    }
    function release() {
      generation++;
      var old = view; view = null;
      if (old) { try { old.dispose(); } catch (_) {} }
      clear();
    }
    function withdraw(text) {
      release(); gateway = null; installedHint = null;
      if (!disposed) message(text);
    }
    function facade(raw, turn, scope) {
      // Forward only an explicitly injected Root adapter, without constructing any DTO.
      // The presentation hint can withdraw access; it cannot grant or change the server brand.
      var admitted = {};
      ['context', 'read', 'beginMutation', 'submit', 'receipt'].forEach(function (name) {
        if (typeof raw[name] !== 'function') return;
        admitted[name] = function () {
          var args = arguments;
          if (disposed || !active || generation !== turn || hint() !== scope) return Promise.reject(refusal());
          return Promise.resolve().then(function () {
            if (disposed || !active || generation !== turn || hint() !== scope) throw refusal();
            return raw[name].apply(raw, args);
          }).then(function (result) {
            if (disposed || !active || generation !== turn || hint() !== scope) throw refusal();
            if (name === 'context' && (!result || result.effectiveBrand !== scope)) throw refusal();
            return result;
          });
        };
      });
      return admitted;
    }
    function sync(options) {
      if (disposed) return Promise.resolve();
      var explicitFilters = options && Object.prototype.hasOwnProperty.call(options, 'filters');
      if (explicitFilters) requestedFilters = filters(options.filters);
      if (gateway && hint() !== installedHint) withdraw('A marca mudou. Esta área aguarda um acesso autorizado para a nova marca.');
      if (!active) return Promise.resolve();
      if (!gateway) { message('Dados indisponíveis. O acesso desta área ainda não foi habilitado.'); return Promise.resolve(); }
      if (!requestedFilters) { release(); message('Período indisponível. Selecione uma janela válida antes de consultar.'); return Promise.resolve(); }
      if (!component || typeof component.create !== 'function') { release(); message('Esta área está indisponível. Preserve as consultas das outras seções.'); return Promise.resolve(); }
      var turn = generation, created = false;
      if (!view) {
        try { clear(); view = component.create({ element: el, document: doc, gateway: facade(gateway, turn, installedHint) }); created = true; }
        catch (_) { release(); message('Não foi possível abrir esta área. Nenhuma operação foi enviada.'); return Promise.resolve(); }
      }
      var current = view, copy = filters(requestedFilters);
      return Promise.resolve().then(function () {
        if (disposed || !active || generation !== turn || view !== current) return;
        // A legacy refresh cannot overwrite filters selected inside the new view.
        return current.sync(explicitFilters || created ? { filters: copy } : undefined);
      }).catch(function () {
        if (disposed || !active || generation !== turn || view !== current) return;
        release(); message('Não foi possível atualizar esta área. Nenhuma operação será repetida.');
      });
    }
    function setGateway(value) {
      if (disposed) return Promise.resolve();
      release();
      gateway = value && typeof value.context === 'function' && typeof value.read === 'function' ? value : null;
      installedHint = gateway ? hint() : null;
      if (!gateway) message('Dados indisponíveis. O acesso desta área ainda não foi habilitado.');
      return sync();
    }
    function activate(options) { if (disposed) return Promise.resolve(); active = true; return sync(options); }
    function leave() { if (disposed) return; active = false; release(); }
    function dispose() { if (disposed) return; disposed = true; active = false; gateway = null; installedHint = null; release(); }
    message('Dados indisponíveis. O acesso desta área ainda não foi habilitado.');
    return Object.freeze({ setGateway: setGateway, activate: activate, sync: sync, leave: leave, dispose: dispose });
  }
  return Object.freeze({ create: create });
});
