'use strict';
// SINTÉTICO, só em RAM, exclusivo de teste: motor de referência das instruções nomeadas de sql.cjs com semântica
// READ COMMITTED (cada instrução vê o confirmado + a própria transação), locks de linha e de chave única que fazem a
// segunda sessão ESPERAR a primeira terminar (como no PostgreSQL), ON CONFLICT DO NOTHING, FK diferida checada no
// COMMIT e as guardas do schema (arquivado não reabre; operações/histórico só inserção).
// Não é banco, driver, pool nem prova de produção: a prova real é o runner PG de Root com dois clientes emprestados.
// now() é um instante literal fixo do motor (sem relógio atual).

class TxAborted extends Error { constructor() { super('current transaction is aborted'); this.code = '25P02'; } }
const sqlErr = (code, msg) => Object.assign(new Error(msg), { code });

function createEngine(options) {
  const NOW = (options && options.now) || '2026-10-06T12:00:00.000Z';
  const committed = { links: new Map(), ops: new Map(), history: new Map() };
  const locks = new Map(); // chave -> tx
  const waiters = new Map(); // chave -> [fn]
  const stats = { statements: [], waits: [] };

  async function acquire(tx, key) {
    for (;;) {
      const holder = locks.get(key);
      if (holder === undefined || holder === tx) { locks.set(key, tx); tx.locks.add(key); return; }
      stats.waits.push({ session: tx.session, key });
      await new Promise(res => { const l = waiters.get(key) || []; l.push(res); waiters.set(key, l); });
    }
  }
  function release(tx) {
    for (const key of tx.locks) {
      if (locks.get(key) === tx) locks.delete(key);
      const l = waiters.get(key) || [];
      waiters.delete(key);
      l.forEach(fn => fn());
    }
    tx.locks.clear();
  }
  const linkKey = (b, id) => b + '|' + id;
  // Visão READ COMMITTED: confirmado + overlay da própria transação.
  function viewLinks(tx) { const m = new Map(committed.links); if (tx) for (const [k, v] of tx.links) m.set(k, v); return m; }
  function viewOps(tx) { const m = new Map(committed.ops); if (tx) for (const [k, v] of tx.ops) m.set(k, v); return m; }
  function viewHistory(tx) { const m = new Map(committed.history); if (tx) for (const [k, v] of tx.history) m.set(k, v); return m; }
  const pub = r => ({ link_id: r.link_id, brand: r.brand, destination: r.destination, url: r.url, origin: r.origin, surface: r.surface, campaign: r.campaign,
    campaign_date: r.campaign_date, utm_campaign: r.utm_campaign, state: r.state, revision: r.revision, created_at: r.created_at });

  const handlers = {
    async olp_v1_op_get(tx, [id]) {
      const r = viewOps(tx).get(id);
      return r ? [{ operation_id: r.operation_id, brand: r.brand, kind: r.kind, intent_hash: r.intent_hash, record_id: r.record_id, expected_record_revision: r.expected_record_revision,
        outcome: r.outcome, reason: r.reason, result_revision: r.result_revision, receipt_reference: r.receipt_reference }] : [];
    },
    async olp_v1_link_insert(tx, v) {
      const [brand, id, destination, origin, surface, campaign, date, utm, url, opId] = v;
      const keys = ['linkid:' + id, 'url:' + brand + '|' + url];
      const before = new Set(tx.locks);
      for (const k of keys) await acquire(tx, k);
      const view = viewLinks(tx);
      const conflict = [...view.values()].some(l => l.link_id === id || (l.brand === brand && l.url === url));
      if (conflict) { for (const k of keys) if (!before.has(k)) { locks.delete(k); tx.locks.delete(k); const l = waiters.get(k) || []; waiters.delete(k); l.forEach(fn => fn()); } return []; }
      await acquire(tx, 'link:' + linkKey(brand, id));
      const row = { brand, link_id: id, destination, origin, surface, campaign, campaign_date: date, utm_campaign: utm, url, state: 'active', revision: 1,
        created_operation_id: opId, created_at: NOW, archived_operation_id: null, archived_at: null };
      tx.links.set(linkKey(brand, id), row);
      return [pub(row)];
    },
    async olp_v1_link_conflict(tx, [brand, id, url]) {
      const rows = [...viewLinks(tx).values()].filter(l => l.link_id === id || (l.brand === brand && l.url === url));
      rows.sort((a, b) => (a.link_id === id ? 0 : 1) - (b.link_id === id ? 0 : 1));
      return rows.slice(0, 1).map(l => ({ conflict: l.link_id === id ? 'record_id' : l.state === 'archived' ? 'url_archived' : 'url_active' }));
    },
    async olp_v1_link_archive_cas(tx, [brand, id, rev, opId]) {
      const k = linkKey(brand, id);
      if (!viewLinks(tx).has(k)) return [];
      await acquire(tx, 'link:' + k); // espera a outra sessão terminar; reavalia o WHERE depois (READ COMMITTED)
      const cur = viewLinks(tx).get(k);
      if (!cur || cur.revision !== rev || cur.state !== 'active') return [];
      const row = Object.assign({}, cur, { state: 'archived', revision: cur.revision + 1, archived_operation_id: opId, archived_at: NOW });
      tx.links.set(k, row);
      return [pub(row)];
    },
    async olp_v1_link_probe(tx, [brand, id]) {
      const r = viewLinks(tx).get(linkKey(brand, id));
      return r ? [{ state: r.state, revision: r.revision }] : [];
    },
    async olp_v1_history_insert(tx, [brand, id, event, opId]) {
      const l = viewLinks(tx).get(linkKey(brand, id));
      if (!l) return [];
      const hk = brand + '|' + id + '|' + l.revision;
      if (viewHistory(tx).has(hk)) throw sqlErr('23505', 'duplicate history');
      const okEvent = (event === 'created' && l.state === 'active' && l.revision === 1) || (event === 'archived' && l.state === 'archived' && l.revision >= 2);
      if (!okEvent) throw sqlErr('23514', 'history event check');
      tx.history.set(hk, { brand, link_id: id, revision: l.revision, event, state: l.state, operation_id: opId, destination: l.destination, origin: l.origin,
        surface: l.surface, campaign: l.campaign, campaign_date: l.campaign_date, utm_campaign: l.utm_campaign, url: l.url, recorded_at: NOW });
      return [{ revision: l.revision }];
    },
    async olp_v1_op_insert(tx, v) {
      const [operation_id, brand, kind, intent_hash, record_id, expected_record_revision, outcome, reason, result_revision, receipt_reference,
        context_revision, session_revision, actor_reference, actor_role] = v;
      await acquire(tx, 'op:' + operation_id);
      if (viewOps(tx).has(operation_id)) { if (!tx.ownedOps.has(operation_id)) { locks.delete('op:' + operation_id); tx.locks.delete('op:' + operation_id); } return []; }
      if (!((outcome === 'confirmed' && reason === null && result_revision !== null) || (outcome === 'rejected' && reason !== null && result_revision === null))) throw sqlErr('23514', 'outcome check');
      tx.ops.set(operation_id, { operation_id, brand, kind, intent_hash, record_id, expected_record_revision, outcome, reason, result_revision, receipt_reference,
        context_revision, session_revision, actor_reference, actor_role, created_at: NOW });
      tx.ownedOps.add(operation_id);
      return [{ operation_id }];
    },
    async olp_v1_op_receipt(tx, [id, brand]) {
      const o = viewOps(tx).get(id);
      if (!o || o.brand !== brand) return [];
      const h = o.result_revision == null ? null : viewHistory(tx).get(o.brand + '|' + o.record_id + '|' + o.result_revision);
      const l = viewLinks(tx).get(linkKey(o.brand, o.record_id));
      return [{ operation_id: o.operation_id, brand: o.brand, kind: o.kind, intent_hash: o.intent_hash, record_id: o.record_id, expected_record_revision: o.expected_record_revision,
        outcome: o.outcome, reason: o.reason, result_revision: o.result_revision, receipt_reference: o.receipt_reference,
        h_link_id: h ? h.link_id : null, h_destination: h ? h.destination : null, h_url: h ? h.url : null, h_origin: h ? h.origin : null, h_surface: h ? h.surface : null,
        h_campaign: h ? h.campaign : null, h_campaign_date: h ? h.campaign_date : null, h_utm_campaign: h ? h.utm_campaign : null, h_state: h ? h.state : null,
        h_revision: h ? h.revision : null, h_created_at: l ? l.created_at : null }];
    },
    async olp_v1_links_list(tx, [brand, includeArchived]) {
      return [...viewLinks(tx).values()].filter(l => l.brand === brand && (l.state === 'active' || includeArchived === true))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.link_id < b.link_id ? -1 : a.link_id > b.link_id ? 1 : 0)).map(pub);
    }
  };

  function commitTx(tx) {
    // FK diferida histórico -> operação.
    const ops = viewOps(tx);
    for (const h of tx.history.values()) if (!ops.has(h.operation_id)) throw sqlErr('23503', 'history operation fk');
    for (const [k, v] of tx.links) {
      const old = committed.links.get(k);
      if (old && !(old.state === 'active' && v.state === 'archived' && v.revision === old.revision + 1)) throw sqlErr('P0001', 'link guard');
      committed.links.set(k, v);
    }
    for (const [k, v] of tx.ops) { if (committed.ops.has(k)) throw sqlErr('P0001', 'append-only'); committed.ops.set(k, v); }
    for (const [k, v] of tx.history) { if (committed.history.has(k)) throw sqlErr('P0001', 'append-only'); committed.history.set(k, v); }
  }

  function client(session) {
    let tx = null;
    return {
      async query(cfg) {
        if (!cfg || typeof cfg.name !== 'string' || typeof cfg.text !== 'string' || !Array.isArray(cfg.values)) throw sqlErr('08P01', 'query config required');
        stats.statements.push({ session, name: cfg.name });
        await Promise.resolve();
        if (cfg.name === 'olp_v1_begin') { if (tx) throw sqlErr('25001', 'already in transaction'); tx = { session, links: new Map(), ops: new Map(), history: new Map(), locks: new Set(), ownedOps: new Set(), aborted: false }; return { rows: [] }; }
        if (cfg.name === 'olp_v1_rollback') { if (tx) release(tx); tx = null; return { rows: [] }; }
        if (cfg.name === 'olp_v1_commit') {
          if (!tx) return { rows: [] };
          const t = tx; tx = null;
          if (t.aborted) { release(t); return { rows: [] }; }
          try { commitTx(t); } finally { release(t); }
          return { rows: [] };
        }
        const h = handlers[cfg.name];
        if (!h) throw sqlErr('42P01', 'unknown statement');
        if (tx && tx.aborted) throw new TxAborted();
        const own = tx || { session, links: new Map(), ops: new Map(), history: new Map(), locks: new Set(), ownedOps: new Set(), autocommit: true };
        try {
          const rows = await h(own, cfg.values);
          if (own.autocommit) { try { commitTx(own); } finally { release(own); } }
          return { rows };
        } catch (e) {
          if (tx) tx.aborted = true; else release(own);
          throw e;
        }
      }
    };
  }

  return { client, stats, committed, NOW };
}

module.exports = { createEngine };
