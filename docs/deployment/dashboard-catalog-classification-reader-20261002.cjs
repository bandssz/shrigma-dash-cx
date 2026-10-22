'use strict';

// Fixed-file reader for one isolated audit volume. No SQL or outbound requests.
const http = require('node:http');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash, timingSafeEqual } = require('node:crypto');

const MAX_BYTES = 65536;
const STATUS_FILE = '/audit-state/status.json';
const RESULTS_FILE = '/audit-state/result.jsonl';
const STATUS_SCHEMA = 'dashboard-catalog-audit-status-v1';
const RESULT_SCHEMA = 'dashboard-catalog-classification-result-v1';

const SECTIONS = Object.freeze([
  {
    "name": "baseline",
    "targets": [
      "crm_panel_reader_extra_classification"
    ],
    "booleans": [
      "reader_exists",
      "dedicated_reader_function_exists",
      "same_count_as_first_audit",
      "reader_temp_capability"
    ],
    "counts": [
      "extra_count"
    ]
  },
  {
    "name": "extension_registry",
    "targets": [
      "extension_vector",
      "extension_pgcrypto",
      "extension_plpgsql",
      "extension_uuid_ossp",
      "extension_pg_trgm",
      "extension_citext",
      "extension_hstore",
      "extension_btree_gin",
      "extension_btree_gist",
      "extension_unknown",
      "extension_ambiguous",
      "non_extension"
    ],
    "booleans": [
      "extension_installed"
    ],
    "counts": [
      "extra_count",
      "security_definer_count",
      "invoker_count",
      "volatile_count",
      "immutable_count",
      "stable_count",
      "postgres_owner_count",
      "non_postgres_owner_count",
      "public_execute_count",
      "c_language_count",
      "sql_language_count",
      "plpgsql_language_count",
      "other_language_count"
    ]
  },
  {
    "name": "security_modes",
    "targets": [
      "extra_security_definer",
      "extra_security_invoker"
    ],
    "booleans": [],
    "counts": [
      "extra_count",
      "public_execute_count",
      "volatile_count",
      "postgres_owner_count"
    ]
  },
  {
    "name": "volatility",
    "targets": [
      "extra_immutable",
      "extra_stable",
      "extra_volatile",
      "extra_volatility_unknown"
    ],
    "booleans": [],
    "counts": [
      "extra_count",
      "security_definer_count",
      "public_execute_count"
    ]
  },
  {
    "name": "application_prefix",
    "targets": [
      "non_extension_shrigma",
      "non_extension_other",
      "extension_shrigma",
      "extension_other"
    ],
    "booleans": [],
    "counts": [
      "extra_count",
      "security_definer_count",
      "volatile_count",
      "public_execute_count"
    ]
  },
  {
    "name": "owners",
    "targets": [
      "owner_postgres",
      "owner_reader",
      "owner_other"
    ],
    "booleans": [],
    "counts": [
      "extra_count",
      "security_definer_count",
      "public_execute_count"
    ]
  },
  {
    "name": "languages",
    "targets": [
      "language_c",
      "language_sql",
      "language_plpgsql",
      "language_other"
    ],
    "booleans": [],
    "counts": [
      "extra_count",
      "security_definer_count",
      "volatile_count",
      "public_execute_count"
    ]
  },
  {
    "name": "known_signatures",
    "targets": [
      "public.shrigma_crm_read_fast_v1(text,text,jsonb)",
      "public.shrigma_panel_auth_v1(text,text,text)",
      "public.shrigma_panel_operator_v1(text,text)",
      "public.shrigma_crm_operator_auth_v1(text)",
      "public.shrigma_template_auth_v2(text)"
    ],
    "booleans": [
      "existe",
      "reader_pode_executar",
      "included_in_extra",
      "security_definer",
      "owner_postgres",
      "public_pode_executar",
      "is_volatile",
      "is_stable",
      "is_immutable",
      "is_sql",
      "is_plpgsql",
      "search_path_expected_matches",
      "member_of_extension",
      "returns_jsonb",
      "set_returning"
    ],
    "counts": []
  }
]);

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function parseBounded(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('invalid');
  return JSON.parse(text);
}

function validateStatus(text) {
  const status = parseBounded(text);
  if (!status || status.schema !== STATUS_SCHEMA) throw new Error('invalid');
  if (status.state === 'ok' && exactKeys(status, ['schema', 'state', 'sections']) && status.sections === 8) {
    return { schema: STATUS_SCHEMA, state: 'ok', sections: 8 };
  }
  if ((status.state === 'claimed' || status.state === 'already_attempted') && exactKeys(status, ['schema', 'state'])) {
    return { schema: STATUS_SCHEMA, state: status.state };
  }
  const reasons = ['query_failed', 'output_shape', 'output_characters', 'output_sections'];
  if (status.state === 'failed' && exactKeys(status, ['schema', 'state', 'reason']) && reasons.includes(status.reason)) {
    return { schema: STATUS_SCHEMA, state: 'failed', reason: status.reason };
  }
  throw new Error('invalid');
}

function validateResults(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('invalid');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length !== SECTIONS.length || lines.some((line) => !line)) throw new Error('invalid');
  return lines.map((line, sectionIndex) => {
    const spec = SECTIONS[sectionIndex];
    const report = parseBounded(line);
    if (!exactKeys(report, ['section', 'rows']) || report.section !== spec.name
      || !Array.isArray(report.rows) || report.rows.length !== spec.targets.length) throw new Error('invalid');
    const rows = report.rows.map((row, rowIndex) => {
      const keys = ['alvo', ...spec.booleans, ...spec.counts];
      if (!exactKeys(row, keys) || row.alvo !== spec.targets[rowIndex]) throw new Error('invalid');
      const clean = { alvo: spec.targets[rowIndex] };
      for (const key of spec.booleans) {
        if (row[key] !== null && typeof row[key] !== 'boolean') throw new Error('invalid');
        clean[key] = row[key];
      }
      for (const key of spec.counts) {
        if (row[key] !== null && (!Number.isSafeInteger(row[key]) || row[key] < 0)) throw new Error('invalid');
        clean[key] = row[key];
      }
      return clean;
    });
    return { section: spec.name, rows };
  });
}

async function readFixedFile(file) {
  if (file !== STATUS_FILE && file !== RESULTS_FILE) throw new Error('invalid');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('invalid');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_BYTES) throw new Error('invalid');
    return buffer.subarray(0, used).toString('utf8');
  } finally {
    await handle.close();
  }
}

function respond(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(body));
}

function createHandler({ token, readFile = readFixedFile } = {}) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('configuration');
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  let inFlight = 0;
  return async (req, res) => {
    try {
      if (req.method !== 'GET') return respond(res, 405, { error: 'request_denied' });
      if (req.url === '/healthz') return respond(res, 200, { ok: true });
      if (req.url !== '/result') return respond(res, 404, { error: 'not_found' });
      const authorization = req.headers && req.headers.authorization;
      const duplicates = Array.isArray(req.rawHeaders)
        ? req.rawHeaders.filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === 'authorization').length
        : 1;
      if (duplicates !== 1 || typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)
        || !timingSafeEqual(createHash('sha256').update(authorization).digest(), expected)) {
        return respond(res, 401, { error: 'unauthorized' });
      }
      if (inFlight >= 2) return respond(res, 503, { error: 'audit_unavailable' });
      inFlight++;
      try {
        const status = validateStatus(await readFile(STATUS_FILE));
        const reports = status.state === 'ok' ? validateResults(await readFile(RESULTS_FILE)) : null;
        return respond(res, 200, { schema: RESULT_SCHEMA, status, reports });
      } finally {
        inFlight--;
      }
    } catch {
      if (!res.headersSent) respond(res, 503, { error: 'audit_unavailable' });
      else res.destroy();
    }
  };
}

function createServer({ token } = {}) {
  const server = http.createServer(createHandler({ token }));
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 12;
  server.maxConnections = 8;
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  server.on('error', () => { process.exitCode = 1; server.close(); });
  return server;
}

if (require.main === module) {
  try {
    const token = process.env.AUDIT_READ_TOKEN;
    delete process.env.AUDIT_READ_TOKEN;
    createServer({ token }).listen(8080, '0.0.0.0');
  } catch {
    process.exitCode = 1;
  }
}

module.exports = { createHandler, createServer, validateStatus, validateResults, SECTIONS };
