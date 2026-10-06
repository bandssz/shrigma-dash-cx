/* Root mounting boundary. Injected reads only; no transport, storage or authority. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShrigmaAffiliatesMount = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function text(v) { return typeof v === 'string' && v.length > 0; }
  function bind(options) {
    var doc = options && options.document, element = options && options.element;
    var viewFactory = options && options.view;
    if (!doc || !element || typeof doc.createElement !== 'function' || typeof options.getSelection !== 'function' || typeof options.isActive !== 'function') throw new TypeError('Montagem requer documento, elemento e seleção explícitos.');
    var disposed = false, instance = null, installed = null, selection = null, generation = 0;
    function reset() {
      generation++;
      if (instance) instance.dispose();
      instance = null;
      element.textContent = '';
    }
    function closed(message) {
      if (instance) reset();
      element.textContent = '';
      var p = doc.createElement('p');
      p.setAttribute('role', 'status'); p.setAttribute('data-affiliates-mount-state', 'unavailable');
      p.textContent = message + ' Nenhum resultado foi interpretado como zero. Gravações não estão habilitadas nesta montagem.';
      element.appendChild(p);
    }
    function current(token, binding) {
      return !disposed && options.isActive() && generation === token && installed === binding && options.getSelection() === binding.selection;
    }
    function readGateway(binding, token) {
      return Object.freeze({
        context: function () {
          if (!current(token, binding)) return Promise.reject(new Error('Seleção mudou; leitura descartada.'));
          return Promise.resolve().then(function () {
            if (!current(token, binding)) throw new Error('Seleção ou seção mudou; leitura descartada.');
            return binding.gateway.context();
          }).then(function (ctx) {
            if (!current(token, binding) || !ctx || ctx.effectiveBrand !== binding.effectiveBrand) throw new Error('Marca efetiva não corresponde ao vínculo de leitura.');
            return ctx;
          });
        },
        read: function (query, callOptions) {
          if (!current(token, binding)) return Promise.reject(new Error('Seleção mudou; leitura descartada.'));
          return Promise.resolve().then(function () {
            if (!current(token, binding)) throw new Error('Seleção mudou; leitura descartada.');
            return binding.gateway.read(query, callOptions);
          }).then(function (response) {
            if (!current(token, binding)) throw new Error('Seleção mudou; leitura descartada.');
            return response;
          });
        }
      });
    }
    function sync() {
      if (disposed) return Promise.resolve();
      var next = options.getSelection();
      if (selection !== next) { reset(); selection = next; }
      if (!options.isActive()) { if (instance) reset(); return Promise.resolve(); }
      if (!text(next) || next === 'todas') { closed('Selecione uma marca para o CRM de afiliados.'); return Promise.resolve(); }
      if (!installed || installed.selection !== next) { closed('CRM de afiliados indisponível: leitura própria desta marca ainda não foi conectada.'); return Promise.resolve(); }
      if (!viewFactory || typeof viewFactory.create !== 'function') { closed('CRM de afiliados indisponível: módulo de apresentação não foi carregado.'); return Promise.resolve(); }
      if (!instance) {
        element.textContent = '';
        instance = viewFactory.create({ element: element, document: doc, gateway: readGateway(installed, generation) });
      }
      return instance.sync({ filters: typeof options.getFilters === 'function' ? options.getFilters() : {} });
    }
    function setGateway(gateway, binding) {
      if (disposed) return Promise.resolve();
      if (gateway !== null && (!gateway || typeof gateway.context !== 'function' || typeof gateway.read !== 'function' || !binding || !text(binding.selection) || binding.selection === 'todas' || !text(binding.effectiveBrand))) throw new TypeError('Gateway de leitura requer vínculo explícito entre seleção e marca efetiva.');
      if (gateway && installed && installed.gateway === gateway && installed.selection === binding.selection && installed.effectiveBrand === binding.effectiveBrand) return sync();
      reset();
      installed = gateway === null ? null : Object.freeze({ gateway: gateway, selection: binding.selection, effectiveBrand: binding.effectiveBrand });
      return sync();
    }
    function dispose() {
      if (disposed) return;
      disposed = true; reset(); installed = null;
    }
    closed('CRM de afiliados indisponível: leitura própria ainda não foi conectada.');
    return Object.freeze({ sync: sync, setGateway: setGateway, dispose: dispose });
  }
  return Object.freeze({ bind: bind });
}));
