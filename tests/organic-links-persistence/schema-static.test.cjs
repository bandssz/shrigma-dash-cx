'use strict';
// Conferência estática do pacote: schema aditivo só no namespace existente, SQL fixo parametrizado só nas três tabelas,
// módulo sem conexão/pool/log/rede/arquivo/ambiente e sem tocar o cliente de Root além de query().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DIR = path.join(__dirname, '..', '..', 'services', 'dashboard-operational', 'domain', 'organic-links-persistence');
const { SQL, TABLES } = require(path.join(DIR, 'sql.cjs'));
const TABLE_NAMES = ['organic_links_v1', 'organic_link_operations_v1', 'organic_link_history_v1'];

test('schema-v1.sql: aditivo, só dashboard_crm_controls, três tabelas exclusivas, sem schema/role/grant/drop/dado', () => {
  const raw = fs.readFileSync(path.join(DIR, 'schema-v1.sql'), 'utf8');
  const sql = raw.replace(/--[^\n]*/g, '');
  for (const re of [/\bCREATE\s+(SCHEMA|ROLE|USER|DATABASE|EXTENSION)\b/i, /\b(GRANT|REVOKE|TRUNCATE|COPY|VACUUM)\b/i, /\bDROP\b/i, /\bALTER\s+(TABLE|ROLE|SCHEMA|DATABASE|SYSTEM)\b/i,
    /\bINSERT\s+INTO\b/i, /\bSECURITY\s+DEFINER\b/i, /\bpublic\./i, /organico_link_utm/i]) assert.doesNotMatch(sql, re, String(re));
  const created = [...sql.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|INDEX|FUNCTION|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)(?:\s+ON\s+([A-Za-z0-9_.]+))?/gi)];
  assert.ok(created.length >= 8);
  for (const m of created) {
    if (m[1].toUpperCase() === 'TRIGGER' || m[1].toUpperCase() === 'INDEX') continue;
    assert.match(m[2], /^dashboard_crm_controls\./, m[0]);
  }
  for (const m of sql.matchAll(/\bON\s+([A-Za-z0-9_.]+)\s*(\(|\n|FOR)/gi)) assert.match(m[1], /^dashboard_crm_controls\./, m[0]);
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS dashboard_crm_controls\.(\w+)/g)].map(m => m[1]).sort();
  assert.deepEqual(tables, TABLE_NAMES.slice().sort());
  assert.match(sql, /UNIQUE \(brand, url\)/);
  assert.match(sql, /PRIMARY KEY \(operation_id\)/);
});

test('SQL fixo: nomes estáveis, placeholders == aridade, só as três tabelas, nada interpolado', () => {
  const names = new Set();
  for (const [k, st] of Object.entries(SQL)) {
    assert.match(st.name, /^olp_v1_[a-z_]+$/, k);
    assert.ok(!names.has(st.name), 'nome repetido ' + st.name); names.add(st.name);
    const ph = new Set([...st.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    assert.equal(ph.size, st.arity, k);
    for (let i = 1; i <= st.arity; i++) assert.ok(ph.has(i), k + ' $' + i);
    for (const m of st.text.matchAll(/dashboard_crm_controls\.(\w+)/g)) assert.ok(TABLE_NAMES.includes(m[1]), k + ' ' + m[1]);
    assert.doesNotMatch(st.text, /\bpublic\.|organico_link_utm|crm_dash_chave|\$\{|;\s*\S/, k);
  }
  assert.deepEqual(Object.values(TABLES).map(t => t.split('.')[1]).sort(), TABLE_NAMES.slice().sort());
});

test('módulo: sem conexão/pool/log/rede/arquivo/ambiente; só query() no cliente de Root', () => {
  for (const f of ['store.cjs', 'codec.cjs', 'sql.cjs']) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\/\/[^\n]*/g, '');
    for (const re of [/console\./, /\.end\(/, /\.release\(/, /\.connect\(/, /process\.env/, /\bfetch\(/, /require\('(?!\.\/|node:crypto)/, /Math\.random/, /Date\.now|new Date\(\)/, /randomUUID/, /setTimeout|setInterval/])
      assert.doesNotMatch(src, re, f + ' ' + re);
  }
  const store = fs.readFileSync(path.join(DIR, 'store.cjs'), 'utf8');
  assert.match(store, /o\.enabled === true/, 'liga só com o literal true');
});
