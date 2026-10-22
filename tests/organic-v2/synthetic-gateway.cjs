'use strict';
// Gateway SINTÉTICO, só em memória, para testes de comportamento da UI. Sem transporte, sem store
// persistente e sem valor de prova: confirmações aqui não são confirmações de produção.
// Simula o lado servidor do contrato 1.0.1-proposed: contextRevision atual, marca efetiva,
// capabilities, journal de operações (begin/submit/receipt) e envelopes de leitura.

const SYNTHETIC = true;

function day(n) { return new Date(Date.UTC(2026, 9, 1 + n, 15)).toISOString(); }

function defaultFixtures() {
  const ready = (data, extra) => Object.assign({ state: 'ready', source: 'own_verified', coverage: 'complete', freshness: 'fresh', collectedAt: day(4), cacheAt: day(5), data }, extra || {});
  const mk = brand => ({
    posts: req => ready({ items: [
      { id: brand + '-p1', provider: 'instagram', brandId: brand, title: 'Post ' + brand + ' ' + req.filters.period.to, publishedAt: day(1), kind: 'reel', source: 'own_verified', metrics: { reach: 1200, likes: 80, saves: null } }
    ] }),
    stories: () => ready({ items: [
      { id: brand + '-s1', provider: 'instagram', brandId: brand, publishedAt: day(1), expiresAt: day(2), source: 'own_verified', metrics: { reach: 300, linkClicks: null } }
    ] }),
    'attribution-aggregate': req => ready({
      period: req.filters.period, model: req.filters.model, currency: 'BRL', window: '30 dias',
      daily: [{ day: '2026-10-02', channel: 'editorial', orders: req.filters.model === 'last_click' ? 3 : 5, revenueMinor: req.filters.model === 'last_click' ? 12345 : 22222, pieceId: null }],
      quality: { ordersRead: 40, unknownOrigin: 7 }, coverage: [{ day: '2026-10-02', checkedAt: day(4) }]
    }),
    'attribution-order-if-admitted': () => ({ state: 'unavailable', source: 'unknown', coverage: 'unknown', freshness: 'unknown', collectedAt: null, cacheAt: null, data: null, error: 'DTO por pedido não admitido para ' + brand }),
    links: () => null // calculado a partir do store em memória
  });
  return { aristo: mk('aristo'), fish: mk('fish') };
}

function createGateway(options) {
  const opt = options || {};
  const server = {
    ctx: Object.assign({
      contextRevision: 'r1', effectiveBrand: 'aristo', sessionRevision: 's1', principalReference: 'p-ana', role: 'write',
      capabilities: { 'link.create': { available: true }, 'link.archive': { available: true } }, sourceRevision: 'src-1', pendingOperations: []
    }, opt.ctx || {}),
    fixtures: defaultFixtures(),
    links: {
      aristo: [{ id: 'l1', brandId: 'aristo', destination: 'https://oaristocrata.com/products/x', url: 'https://oaristocrata.com/products/x?utm_source=instagram_social&utm_medium=story&utm_campaign=20261001_x', origin: 'instagram_social', surface: 'story', state: 'active', revision: 3, createdAt: day(0) }],
      fish: [{ id: 'f1', brandId: 'fish', destination: 'https://fishermans.com.br/', url: 'https://fishermans.com.br/?utm_source=instagram_social&utm_medium=linktree&utm_campaign=bio', origin: 'instagram_social', surface: 'linktree', state: 'active', revision: 1, createdAt: day(0) }]
    },
    linksEnvelope: null, // sobrescreve metadados do envelope de links
    journal: new Map(), opSeq: 0, linkSeq: 0
  };
  const calls = { context: 0, read: [], beginMutation: [], submit: [], receipt: [] };
  const modes = { begin: 'prepared', submit: 'ack', receipt: 'journal', read: {} };
  const held = new Map(); // chave -> fila de resolvedores

  function gate(key, compute) {
    if (!held.has(key)) {
      try { return Promise.resolve(compute()); } catch (e) { return Promise.reject(e); }
    }
    if (eager.has(key)) {
      // Servidor já executou; só a entrega da resposta ao cliente atrasa.
      let done; try { done = { value: compute() }; } catch (e) { done = { error: e }; }
      return new Promise((resolve, reject) => held.get(key).push({ resolve, reject, compute: () => { if (done.error) throw done.error; return done.value; } }));
    }
    return new Promise((resolve, reject) => held.get(key).push({ resolve, reject, compute }));
  }
  const eager = new Set();
  function hold(key, opts) { if (!held.has(key)) held.set(key, []); if (opts && opts.eager) eager.add(key); else eager.delete(key); }
  function release(key, how) {
    const q = held.get(key) || []; held.delete(key); eager.delete(key);
    for (const w of q) {
      if (how && how.throw) w.reject(Object.assign(new Error('falha sintética interna com detalhe secreto'), how.publicReason ? { publicReason: how.publicReason } : {}));
      else { try { w.resolve(w.compute()); } catch (e) { w.reject(e); } }
    }
    return q.length;
  }
  function err(msg) { return new Error(msg); }

  function envelopeFor(req) {
    const ctx = server.ctx;
    if (req.expectedContextRevision !== ctx.contextRevision) {
      return { state: 'unavailable', contextRevision: ctx.contextRevision, brandId: ctx.effectiveBrand, source: 'unknown', coverage: 'unknown', freshness: 'unknown', collectedAt: null, cacheAt: null, data: null, error: 'Contexto alterado; releia.' };
    }
    const mode = modes.read[req.resource];
    if (mode === 'throw') throw err('leitura sintética falhou com detalhe interno');
    const brand = ctx.effectiveBrand;
    let env;
    if (req.resource === 'links') {
      env = Object.assign({ state: 'ready', source: 'own_verified', coverage: 'complete', freshness: 'fresh', collectedAt: day(4), cacheAt: null, data: { items: (server.links[brand] || []).map(l => Object.assign({}, l)) } }, server.linksEnvelope || {});
    } else {
      const f = (server.fixtures[brand] || {})[req.resource];
      env = f ? f(req) : { state: 'unavailable', data: null, error: 'sem fixture' };
    }
    return Object.assign({ contextRevision: ctx.contextRevision, brandId: brand }, env);
  }

  function opEnvelope(id) {
    const j = server.journal.get(id);
    return { operationId: id, contextRevision: server.ctx.contextRevision, state: j.state, binding: j.binding, receiptReference: j.state === 'confirmed' ? 'rcpt-' + id : null, result: j.state === 'confirmed' ? j.result : null, reason: j.reason || null };
  }
  function execute(j) {
    const brand = j.binding.effectiveBrand;
    if (j.binding.kind === 'link.create') {
      const p = j.binding.payload;
      const id = 'new-' + (++server.linkSeq);
      const camp = p.date ? p.date.replace(/-/g, '') + '_' + p.campaign : p.campaign;
      const url = p.destination + '?utm_source=' + p.origin + '&utm_medium=' + p.surface + '&utm_campaign=' + camp;
      // Mesmo endereço final não duplica nem reativa: devolve o registro existente como está.
      const existing = (server.links[brand] || []).find(x => x.url === url);
      if (existing) { j.result = Object.assign({}, existing); j.state = 'confirmed'; return; }
      const link = { id, brandId: brand, destination: p.destination, url, origin: p.origin, surface: p.surface, state: 'active', revision: 1, createdAt: day(5) };
      (server.links[brand] = server.links[brand] || []).push(link);
      j.result = Object.assign({}, link);
    } else if (j.binding.kind === 'link.archive') {
      const l = (server.links[brand] || []).find(x => x.id === j.binding.recordId);
      if (!l || l.revision !== j.binding.expectedRecordRevision) { j.state = 'rejected'; j.reason = 'Revisão do registro mudou.'; return; }
      l.state = 'archived'; l.revision++;
      j.result = Object.assign({}, l);
    }
    j.state = 'confirmed';
  }

  const gateway = {
    context() {
      calls.context++;
      return gate('context', () => JSON.parse(JSON.stringify(server.ctx)));
    },
    read(req, init) {
      calls.read.push({ req: JSON.parse(JSON.stringify(req)), signal: init && init.signal });
      return gate('read:' + req.resource, () => envelopeFor(req));
    },
    beginMutation(req) {
      calls.beginMutation.push(JSON.parse(JSON.stringify(req)));
      return gate('beginMutation', () => {
        if (modes.begin === 'throw') throw err('begin sintético falhou');
        const ctx = server.ctx;
        if (req.expectedContextRevision !== ctx.contextRevision) return { operationId: 'x', contextRevision: ctx.contextRevision, state: 'rejected', binding: null, reason: 'Contexto alterado.' };
        const cap = ctx.capabilities && ctx.capabilities[req.kind];
        const id = 'op-' + (++server.opSeq);
        const binding = { kind: req.kind, effectiveBrand: ctx.effectiveBrand, recordId: req.recordId ?? null, expectedRecordRevision: req.expectedRecordRevision ?? null, payload: req.payload, version: ctx.sourceRevision };
        if (!cap || cap.available !== true || modes.begin === 'reject') {
          server.journal.set(id, { state: 'rejected', binding, reason: 'Sem permissão de escrita para esta marca.' });
        } else server.journal.set(id, { state: 'prepared', binding });
        return opEnvelope(id);
      });
    },
    submit(req) {
      calls.submit.push(JSON.parse(JSON.stringify(req)));
      return gate('submit', () => {
        const j = server.journal.get(req.operationId);
        if (!j || req.expectedContextRevision !== server.ctx.contextRevision) return { operationId: req.operationId, contextRevision: server.ctx.contextRevision, state: 'rejected', binding: null, reason: 'Operação ou contexto inválido.' };
        if (j.state === 'prepared') {
          if (modes.submit === 'pending') j.state = 'pending';
          else if (modes.submit === 'reject') { j.state = 'rejected'; j.reason = 'Destino recusado pelo servidor.'; }
          else execute(j);
        }
        if (modes.submit === 'lose-ack') throw err('ACK perdido');
        if (modes.submit === 'foreign-id') return Object.assign(opEnvelope(req.operationId), { operationId: 'op-outra' });
        return opEnvelope(req.operationId);
      });
    },
    receipt(req) {
      calls.receipt.push(JSON.parse(JSON.stringify(req)));
      return gate('receipt', () => {
        if (modes.receipt === 'throw') throw err('recibo sintético indisponível');
        const j = server.journal.get(req.operationId);
        if (!j) return { operationId: req.operationId, contextRevision: server.ctx.contextRevision, state: 'uncertain', binding: null, reason: 'Operação não encontrada.' };
        return opEnvelope(req.operationId);
      });
    }
  };

  function setCtx(patch) { Object.assign(server.ctx, patch); }
  function settle(id, fn) { const j = server.journal.get(id); fn(j, execute); }
  function mutationCalls() { return calls.beginMutation.length + calls.submit.length + calls.receipt.length; }
  return { gateway, server, calls, modes, hold, release, setCtx, settle, mutationCalls, SYNTHETIC };
}

module.exports = { createGateway, SYNTHETIC };
