'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, validateStatus, validateResults, SECTIONS } = require('./dashboard-catalog-classification-reader-20261002.cjs');
const token = '9'.repeat(64); // Synthetic test value, never a deployment credential.
const okStatus = JSON.stringify({ schema: 'dashboard-catalog-audit-status-v1', state: 'ok', sections: 8 });
function fixtureReports() {
  return SECTIONS.map((section) => ({
    section: section.name,
    rows: section.targets.map((alvo) => ({
      alvo,
      ...Object.fromEntries(section.booleans.map((key) => [key, true])),
      ...Object.fromEntries(section.counts.map((key) => [key, 0])),
    })),
  }));
}
function jsonl(reports) { return reports.map((report) => JSON.stringify(report)).join('\n') + '\n'; }
async function request(handler, { method = 'GET', url = '/result', auth = `Bearer ${token}`, rawHeaders } = {}) {
  const res = {
    status: null, headers: null, body: null, headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = JSON.parse(body); },
    destroy() { this.destroyed = true; },
  };
  await handler({ method, url, headers: auth ? { authorization: auth } : {}, rawHeaders }, res);
  return res;
}

test('anonymous health exposes only a boolean and reads no file', async () => {
  let reads = 0;
  const handler = createHandler({ token, readFile: async () => { reads++; throw new Error('never'); } });
  const res = await request(handler, { url: '/healthz', auth: null });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(reads, 0);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
});

test('result requires the sole exact Bearer token before any file read', async () => {
  let reads = 0;
  const handler = createHandler({ token, readFile: async () => { reads++; throw new Error('never'); } });
  for (const auth of [null, 'Bearer ' + '8'.repeat(64), 'Bearer too-short']) {
    const res = await request(handler, { auth });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  }
  const duplicate = await request(handler, { rawHeaders: ['Authorization', `Bearer ${token}`, 'authorization', `Bearer ${token}`] });
  assert.equal(duplicate.status, 401);
  assert.equal(reads, 0);
});

test('valid completed audit returns exactly eight sections and 35 fixed targets', async () => {
  const paths = [];
  const handler = createHandler({ token, readFile: async (path) => {
    paths.push(path);
    if (path === '/audit-state/status.json') return okStatus;
    if (path === '/audit-state/result.jsonl') return jsonl(fixtureReports());
    throw new Error('arbitrary path');
  } });
  const res = await request(handler);
  assert.equal(res.status, 200);
  assert.deepEqual(paths, ['/audit-state/status.json', '/audit-state/result.jsonl']);
  assert.equal(res.body.reports.length, 8);
  assert.equal(res.body.reports.reduce((sum, section) => sum + section.rows.length, 0), 35);
});

test('failure status exposes only an approved fixed reason and does not read results', async () => {
  const paths = [];
  const handler = createHandler({ token, readFile: async (path) => {
    paths.push(path);
    return JSON.stringify({ schema: 'dashboard-catalog-audit-status-v1', state: 'failed', reason: 'query_failed' });
  } });
  const res = await request(handler);
  assert.equal(res.status, 200);
  assert.equal(res.body.reports, null);
  assert.equal(res.body.status.reason, 'query_failed');
  assert.deepEqual(paths, ['/audit-state/status.json']);
  assert.throws(() => validateStatus(JSON.stringify({ schema: 'dashboard-catalog-audit-status-v1', state: 'failed', reason: 'unapproved-secret' })));
});

test('unexpected fields, targets, negative counts, scalar strings, sections and oversize fail closed', () => {
  for (const mutate of [
    (r) => { r[0].rows[0].password = 'unapproved-secret'; },
    (r) => { r[0].rows[0].alvo = 'unapproved-secret'; },
    (r) => { r[0].rows[0].extra_count = -1; },
    (r) => { r[0].rows[0].extra_count = '123'; },
    (r) => { r[0].rows[0].reader_exists = 'true'; },
    (r) => { [r[0], r[1]] = [r[1], r[0]]; },
    (r) => { r[1] = r[0]; },
  ]) {
    const reports = fixtureReports(); mutate(reports);
    assert.throws(() => validateResults(jsonl(reports)));
  }
  assert.throws(() => validateResults(' '.repeat(65537)));
});

test('malformed or inaccessible files produce generic response with no raw error or data', async () => {
  const reports = fixtureReports(); reports[0].rows[0].password = 'unapproved-secret';
  for (const readFile of [
    async (path) => path.endsWith('status.json') ? okStatus : jsonl(reports),
    async () => { throw new Error('unapproved-secret'); },
  ]) {
    const handler = createHandler({ token, readFile });
    const res = await request(handler);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: 'audit_unavailable' });
    assert.equal(JSON.stringify(res).includes('unapproved-secret'), false);
  }
});

test('only fixed GET paths are served and configuration must use a 32-byte hex token', async () => {
  assert.throws(() => createHandler({ token: 'too-short' }));
  let reads = 0;
  const handler = createHandler({ token, readFile: async () => { reads++; throw new Error('never'); } });
  for (const url of ['/result?path=/etc/passwd', '/etc/passwd', '/result/../status.json']) {
    assert.equal((await request(handler, { url })).status, 404);
  }
  assert.equal((await request(handler, { method: 'POST' })).status, 405);
  assert.equal(reads, 0);
});
