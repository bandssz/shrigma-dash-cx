'use strict';
// C2 · organic-links-persistence · ponto de entrada. DEFAULT OFF; não operacional até Root comprovar gravação e
// releitura reais. Root integra sessão/IAM (authorizeIntent), cliente + lease exclusiva, DDL (schema-v1.sql), gateway e CI.
const { createOrganicLinksStore } = require('./store.cjs');
const codec = require('./codec.cjs');
const { SQL, TABLES, NS } = require('./sql.cjs');

module.exports = Object.freeze({
  MODULE: 'organic-links-persistence-v1',
  DEFAULT_ENABLED: false,
  OPERATIONAL: false,
  SCHEMA_FILE: 'schema-v1.sql',
  NAMESPACE: NS,
  TABLES,
  SQL,
  codec,
  createOrganicLinksStore
});
