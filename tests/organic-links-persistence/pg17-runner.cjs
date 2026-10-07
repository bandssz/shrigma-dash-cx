'use strict';
// Runner PG para Root (alvo PG17 do CI/instância de teste existente): executa os MESMOS cenários do store e as guardas
// do schema-v1.sql com DOIS clientes JÁ CONECTADOS emprestados por Root ({query(config)} compatível com node-postgres).
// Não conecta, não cria pool/conn factory/retry, não chama end/release/connect, não cria schema/role/banco, não apaga.
// Pré-condições (responsabilidade de Root): namespace dashboard_crm_controls existente numa instância de TESTE,
// schema-v1.sql aplicado e as três tabelas VAZIAS (o runner confere e recusa caso contrário).
// Não é arquivo *.test.cjs: não roda no glob padrão sem os clientes; Root chama runAll() com o contexto explícito.
const assert = require('node:assert/strict');
const { scenarios } = require('./scenarios.cjs');

const T = ['dashboard_crm_controls.organic_links_v1', 'dashboard_crm_controls.organic_link_operations_v1', 'dashboard_crm_controls.organic_link_history_v1'];

async function expectSqlError(client, statements, code) {
  await client.query({ name: 'olp_v1_runner_begin', text: 'BEGIN', values: [] });
  let err = null;
  try {
    for (const st of statements) await client.query(st);
    await client.query({ name: 'olp_v1_runner_commit', text: 'COMMIT', values: [] });
  } catch (e) { err = e; }
  if (err) await client.query({ name: 'olp_v1_runner_rollback', text: 'ROLLBACK', values: [] });
  assert.ok(err, 'o banco deveria recusar');
  assert.equal(err.code, code);
}

// Guardas do schema, executadas só no PostgreSQL real (o motor sintético apenas as imita).
function schemaGuards() {
  const L = T[0], O = T[1], H = T[2];
  return [
    {
      name: 'pg · arquivado não reabre e link não é apagado (trigger)',
      async run(env) {
        const c = env.base('A');
        const st = (name, text, values) => ({ name, text, values });
        await expectSqlError(c, [st('olp_v1_runner_reopen', 'UPDATE ' + L + " SET state = 'active', revision = revision + 1, archived_operation_id = NULL, archived_at = NULL WHERE link_id = $1::text", ['s05-link-1'])], 'P0001');
        await expectSqlError(c, [st('olp_v1_runner_delete', 'DELETE FROM ' + L + ' WHERE link_id = $1::text', ['s01-link-1'])], 'P0001');
        await expectSqlError(c, [st('olp_v1_runner_edit', 'UPDATE ' + L + ' SET url = url WHERE link_id = $1::text', ['s01-link-1'])], 'P0001');
      }
    },
    {
      name: 'pg · operações e histórico só inserção (trigger)',
      async run(env) {
        const c = env.base('A');
        await expectSqlError(c, [{ name: 'olp_v1_runner_op_upd', text: 'UPDATE ' + O + " SET reason = 'x_y_z' WHERE operation_id = $1::text", values: ['s01-op-1'] }], 'P0001');
        await expectSqlError(c, [{ name: 'olp_v1_runner_hist_del', text: 'DELETE FROM ' + H + ' WHERE link_id = $1::text', values: ['s01-link-1'] }], 'P0001');
      }
    },
    {
      name: 'pg · CHECKs: marca não admitida, archived sem operação, utm_campaign divergente',
      async run(env) {
        const c = env.base('B');
        const ins = 'INSERT INTO ' + L + ' (brand, link_id, destination, origin, surface, campaign, campaign_date, utm_campaign, url, state, revision, created_operation_id) ' +
          'VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::date, $8::text, $9::text, $10::text, $11::integer, $12::text)';
        const v = (o) => Object.assign(['aristo', 'pg-chk-1', 'https://oaristocrata.com/x', 'instagram_social', 'story', 'kit', '2026-10-05', '20261005_kit',
          'https://oaristocrata.com/x?utm_source=instagram_social&utm_medium=story&utm_campaign=20261005_kit', 'active', 1, 'pg-chk-op'], o);
        await expectSqlError(c, [{ name: 'olp_v1_runner_chk1', text: ins, values: v({ 0: 'olivas' }) }], '23514');
        await expectSqlError(c, [{ name: 'olp_v1_runner_chk2', text: ins, values: v({ 9: 'archived', 10: 2 }) }], '23514');
        await expectSqlError(c, [{ name: 'olp_v1_runner_chk3', text: ins, values: v({ 7: '20261006_kit' }) }], '23514');
      }
    },
    {
      name: 'pg · histórico sem operação original falha no COMMIT (FK diferida)',
      async run(env) {
        const c = env.base('B');
        await expectSqlError(c, [{ name: 'olp_v1_runner_hist_orphan', text: 'INSERT INTO ' + H + " (brand, link_id, revision, event, state, operation_id, destination, origin, surface, campaign, campaign_date, utm_campaign, url) " +
          "SELECT brand, link_id, 9, 'archived', 'archived', $2::text, destination, origin, surface, campaign, campaign_date, utm_campaign, url FROM " + L + ' WHERE link_id = $1::text', values: ['s01-link-1', 'pg-sem-operacao'] }], '23503');
      }
    }
  ];
}

// clientA/clientB: emprestados por Root; normalizer: real a53fc473…; idleMs: espera para afirmar bloqueio de lock.
async function runAll({ clientA, clientB, normalizer, idleMs }) {
  assert.ok(clientA && typeof clientA.query === 'function' && clientB && typeof clientB.query === 'function' && clientA !== clientB, 'dois clientes distintos emprestados por Root');
  assert.ok(normalizer && normalizer.version === '1.0.2-proposed', 'normalizador real obrigatório');
  for (const t of T) {
    const r = await clientA.query({ name: 'olp_v1_runner_count_' + t.split('.')[1], text: 'SELECT count(*)::integer AS n FROM ' + t, values: [] });
    assert.equal(r.rows[0].n, 0, t + ' precisa estar vazia (instância de teste)');
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const env = {
    N: normalizer,
    base: slot => (slot === 'A' ? clientA : clientB),
    idle: () => wait(idleMs || 300),
    until: async pred => { for (let i = 0; i < 500; i++) { if (pred()) return; await wait(10); } throw new Error('condição não atingida'); }
  };
  const results = [];
  for (const s of scenarios.concat(schemaGuards())) {
    try { await s.run(env); results.push({ name: s.name, ok: true }); } catch (e) { results.push({ name: s.name, ok: false, error: String(e && e.message).slice(0, 300) }); }
  }
  return results;
}

module.exports = { runAll };
