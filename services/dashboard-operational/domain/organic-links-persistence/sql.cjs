'use strict';
// C2 · organic-links-persistence · SQL fixo e parametrizado (nenhuma concatenação de valor em texto SQL).
// Cada instrução tem nome estável (query config {name, text, values} compatível com node-postgres) e usa só as três
// tabelas exclusivas do namespace existente dashboard_crm_controls. Sem DDL, sem função/procedimento novo além do
// schema-v1.sql (aplicado por Root), sem acesso a tabelas legadas.

const NS = 'dashboard_crm_controls';
const T = Object.freeze({
  links: NS + '.organic_links_v1',
  ops: NS + '.organic_link_operations_v1',
  history: NS + '.organic_link_history_v1'
});

// Projeção pública: sem ator, sem IDs de operação, datas em ISO UTC estável.
const LINK_PUBLIC = [
  'l.link_id', 'l.brand', 'l.destination', 'l.url', 'l.origin', 'l.surface', 'l.campaign',
  "to_char(l.campaign_date, 'YYYY-MM-DD') AS campaign_date", 'l.utm_campaign', 'l.state', 'l.revision',
  "to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at"
].join(', ');

const SQL = Object.freeze({
  begin: { name: 'olp_v1_begin', text: 'BEGIN ISOLATION LEVEL READ COMMITTED', arity: 0 },
  commit: { name: 'olp_v1_commit', text: 'COMMIT', arity: 0 },
  rollback: { name: 'olp_v1_rollback', text: 'ROLLBACK', arity: 0 },

  // Operação original já persistida (idempotência / reuso divergente).
  opGet: {
    name: 'olp_v1_op_get', arity: 1,
    text: 'SELECT o.operation_id, o.brand, o.kind, o.intent_hash, o.record_id, o.expected_record_revision, o.outcome, o.reason, ' +
      'o.result_revision, o.receipt_reference FROM ' + T.ops + ' o WHERE o.operation_id = $1::text'
  },

  // Criação nova: revisão 1, estado active. Qualquer conflito (link_id, marca+url) devolve zero linhas.
  linkInsert: {
    name: 'olp_v1_link_insert', arity: 10,
    text: 'INSERT INTO ' + T.links + ' AS l (brand, link_id, destination, origin, surface, campaign, campaign_date, utm_campaign, url, state, revision, created_operation_id) ' +
      "VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::date, $8::text, $9::text, 'active', 1, $10::text) " +
      'ON CONFLICT DO NOTHING RETURNING ' + LINK_PUBLIC
  },
  // Classificação do conflito sem devolver o registro alheio.
  linkConflict: {
    name: 'olp_v1_link_conflict', arity: 3,
    text: "SELECT CASE WHEN l.link_id = $2::text THEN 'record_id' WHEN l.state = 'archived' THEN 'url_archived' ELSE 'url_active' END AS conflict " +
      'FROM ' + T.links + ' l WHERE l.link_id = $2::text OR (l.brand = $1::text AND l.url = $3::text) ' +
      "ORDER BY CASE WHEN l.link_id = $2::text THEN 0 ELSE 1 END LIMIT 1"
  },

  // Arquivamento por CAS de marca + id + revisão + estado active. Atualização cruzada de marca não casa.
  linkArchiveCas: {
    name: 'olp_v1_link_archive_cas', arity: 4,
    text: 'UPDATE ' + T.links + " AS l SET state = 'archived', revision = l.revision + 1, archived_operation_id = $4::text, archived_at = now() " +
      "WHERE l.brand = $1::text AND l.link_id = $2::text AND l.revision = $3::integer AND l.state = 'active' RETURNING " + LINK_PUBLIC
  },
  linkProbe: {
    name: 'olp_v1_link_probe', arity: 2,
    text: 'SELECT l.state, l.revision FROM ' + T.links + ' l WHERE l.brand = $1::text AND l.link_id = $2::text'
  },

  historyInsert: {
    name: 'olp_v1_history_insert', arity: 4,
    text: 'INSERT INTO ' + T.history + ' (brand, link_id, revision, event, state, operation_id, destination, origin, surface, campaign, campaign_date, utm_campaign, url) ' +
      'SELECT l.brand, l.link_id, l.revision, $3::text, l.state, $4::text, l.destination, l.origin, l.surface, l.campaign, l.campaign_date, l.utm_campaign, l.url ' +
      'FROM ' + T.links + ' l WHERE l.brand = $1::text AND l.link_id = $2::text RETURNING revision'
  },

  // Registro da operação original (resultado + recibo). Conflito = outra transação gravou o mesmo operation_id.
  opInsert: {
    name: 'olp_v1_op_insert', arity: 14,
    text: 'INSERT INTO ' + T.ops + ' (operation_id, brand, kind, intent_hash, record_id, expected_record_revision, outcome, reason, result_revision, receipt_reference, ' +
      'context_revision, session_revision, actor_reference, actor_role) VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, $7::text, $8::text, ' +
      '$9::integer, $10::text, $11::text, $12::text, $13::text, $14::text) ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id'
  },

  // Recibo / lookup read-only da operação original, limitado à marca autorizada; snapshot do histórico da revisão.
  opReceipt: {
    name: 'olp_v1_op_receipt', arity: 2,
    text: 'SELECT o.operation_id, o.brand, o.kind, o.intent_hash, o.record_id, o.expected_record_revision, o.outcome, o.reason, o.result_revision, o.receipt_reference, ' +
      "h.link_id AS h_link_id, h.destination AS h_destination, h.url AS h_url, h.origin AS h_origin, h.surface AS h_surface, h.campaign AS h_campaign, " +
      "to_char(h.campaign_date, 'YYYY-MM-DD') AS h_campaign_date, h.utm_campaign AS h_utm_campaign, h.state AS h_state, h.revision AS h_revision, " +
      "to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS h_created_at " +
      'FROM ' + T.ops + ' o LEFT JOIN ' + T.history + ' h ON h.brand = o.brand AND h.link_id = o.record_id AND h.revision = o.result_revision ' +
      'LEFT JOIN ' + T.links + ' l ON l.brand = o.brand AND l.link_id = o.record_id ' +
      'WHERE o.operation_id = $1::text AND o.brand = $2::text'
  },

  // Lista por marca; arquivados só com filtro explícito. Só linhas deste módulo (não é cobertura do legado).
  linksList: {
    name: 'olp_v1_links_list', arity: 2,
    text: 'SELECT ' + LINK_PUBLIC + ' FROM ' + T.links + " l WHERE l.brand = $1::text AND (l.state = 'active' OR $2::boolean) ORDER BY l.created_at, l.link_id"
  }
});

module.exports = { NS, TABLES: T, SQL };
