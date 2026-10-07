'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../../services/dashboard-operational/domain/crm-mvp-controls-integration/domain-session.cjs');

const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const raw = override => ({calls: [], async query(text, params) {
  this.calls.push({text, params});
  if (override) return override(text, params);
  return {command: text.startsWith('BEGIN') ? 'BEGIN' : text, rows: [], rowCount: 0};
}});
const begin = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
const code = expected => error => error.code === expected;

test('disabled injection cannot invoke a client or claim authority', async () => {
  const c = raw(), owner = create({client: c});
  await assert.rejects(owner.withDomainSession(() => owner.client.query('SELECT')), code('CRM_DOMAIN_SESSION_OFF'));
  assert.equal(c.calls.length, 0);
  assert.equal(owner.status().authorityProved, false);
  assert.equal(owner.authorizesSend, false);
});

test('queries require an active lease even when source enabled', async () => {
  const c = raw(), owner = create({enabled: true, client: c});
  await assert.rejects(owner.client.query('SELECT'), code('CRM_DOMAIN_SESSION_LEASE_REQUIRED'));
  assert.equal(c.calls.length, 0);
});

test('falsey callback failures propagate without becoming successful results', async () => {
  const owner = create({enabled: true, client: raw()});
  for (const original of [undefined, null, false, 0, '']) {
    let rejected = false;
    try {await owner.withDomainSession(() => {throw original;});}
    catch (error) {rejected = true; assert.equal(error, original);}
    assert.equal(rejected, true);
  }
  assert.equal(await owner.withDomainSession(() => 'usable'), 'usable');
});

test('one callback preserves exact result after a closed transaction', async () => {
  const owner = create({enabled: true, client: raw()}), result = Object.freeze({receipt: 'original'});
  let count = 0;
  const got = await owner.withDomainSession(async () => {
    count++; await owner.client.query(begin); await owner.client.query('SELECT'); await owner.client.query('COMMIT'); return result;
  });
  assert.equal(count, 1); assert.equal(got, result); assert.equal(owner.status().poisoned, false);
});

test('two modules on the same raw client cannot overlap or nest their leases', async () => {
  const c = raw(), a = create({enabled: true, client: c}), b = create({enabled: true, client: c});
  const hold = deferred(), entered = deferred();
  const first = a.withDomainSession(async () => {entered.resolve(); await hold.promise; return 'original';});
  await entered.promise;
  await assert.rejects(b.withDomainSession(() => 'other'), code('CRM_DOMAIN_SESSION_BUSY'));
  hold.resolve(); assert.equal(await first, 'original');
  await a.withDomainSession(async () => assert.rejects(b.withDomainSession(() => 'nested'), code('CRM_DOMAIN_SESSION_BUSY')));
});

test('queries cannot overlap on a client inside the same lease', async () => {
  const hold = deferred(), entered = deferred();
  const c = raw(async text => {entered.resolve(); await hold.promise; return {command: text, rows: []};});
  const owner = create({enabled: true, client: c});
  await owner.withDomainSession(async () => {
    const first = owner.client.query('SELECT'); await entered.promise;
    await assert.rejects(owner.client.query('SELECT'), code('CRM_DOMAIN_SESSION_QUERY_BUSY'));
    hold.resolve(); await first;
  });
  assert.equal(c.calls.length, 1);
});

test('nested BEGIN is refused before reaching PostgreSQL', async () => {
  const c = raw(), owner = create({enabled: true, client: c});
  await owner.withDomainSession(async () => {
    await owner.client.query(begin);
    await assert.rejects(owner.client.query(begin), code('CRM_DOMAIN_SESSION_TRANSACTION_REFUSED'));
    await owner.client.query('ROLLBACK');
  });
  assert.equal(c.calls.length, 2);
});

test('an ordinary SQL failure permits explicit rollback and later reuse', async () => {
  const c = raw(text => {
    if (text === 'SELECT') throw Object.assign(new Error('private SQL / credential / detail'), {code: '23514'});
    return {command: text.startsWith('BEGIN') ? 'BEGIN' : text, rows: []};
  }), owner = create({enabled: true, client: c});
  await owner.withDomainSession(async () => {
    await owner.client.query(begin);
    await assert.rejects(owner.client.query('SELECT'), error => error.code === 'CRM_DOMAIN_SESSION_QUERY_FAILED' && error.sqlstate === '23514' && !error.message.includes('private'));
    await owner.client.query('ROLLBACK');
  });
  assert.equal(owner.status().poisoned, false);
  await owner.withDomainSession(() => 'usable');
});

test('lost COMMIT acknowledgment poisons every owner and never retries', async () => {
  const c = raw(text => {
    if (text === 'COMMIT') throw Object.assign(new Error('private network message'), {code: 'ECONNRESET'});
    return {command: 'BEGIN', rows: []};
  }), a = create({enabled: true, client: c}), b = create({enabled: true, client: c});
  await assert.rejects(a.withDomainSession(async () => {await a.client.query(begin); await a.client.query('COMMIT');}));
  assert.equal(a.status().poisoned, true);
  await assert.rejects(b.withDomainSession(() => 'retry'), code('CRM_DOMAIN_SESSION_POISONED'));
  assert.equal(c.calls.filter(x => x.text === 'COMMIT').length, 1);
});

test('malformed transaction acknowledgment cannot return a receipt', async () => {
  const c = raw(text => ({command: text.startsWith('BEGIN') ? 'BEGIN' : 'SELECT', rows: []}));
  const owner = create({enabled: true, client: c});
  await assert.rejects(owner.withDomainSession(async () => {await owner.client.query(begin); await owner.client.query('COMMIT'); return 'false receipt';}));
  assert.equal(owner.status().poisoned, true);
});

test('callback exit with an open transaction permanently fences the client', async () => {
  const owner = create({enabled: true, client: raw()});
  await assert.rejects(owner.withDomainSession(async () => {await owner.client.query(begin); return 'unfinished';}), code('CRM_DOMAIN_SESSION_UNCLOSED_TRANSACTION'));
  await assert.rejects(owner.withDomainSession(() => 'other'), code('CRM_DOMAIN_SESSION_POISONED'));
});

test('unawaited query cannot release its client to another callback', async () => {
  const hold = deferred(), c = raw(async () => {await hold.promise; return {command: 'SELECT', rows: []};});
  const owner = create({enabled: true, client: c}); let pending;
  await assert.rejects(owner.withDomainSession(() => {pending = owner.client.query('SELECT'); return 'too early';}), code('CRM_DOMAIN_SESSION_PENDING_QUERY'));
  hold.resolve(); await pending;
  await assert.rejects(owner.withDomainSession(() => 'other'), code('CRM_DOMAIN_SESSION_POISONED'));
});

test('a delayed task from a finished callback cannot use its old lease', async () => {
  const hold = deferred(), c = raw(), owner = create({enabled: true, client: c}); let later;
  await owner.withDomainSession(() => {later = (async () => {await hold.promise; return owner.client.query('SELECT');})(); return 'done';});
  hold.resolve(); await assert.rejects(later, code('CRM_DOMAIN_SESSION_LEASE_REQUIRED'));
  assert.equal(c.calls.length, 0);
});

test('fatal query errors and explicit poison propagate across module instances', async () => {
  const c = raw(() => {throw Object.assign(new Error('secret'), {code: '40001'});});
  const a = create({enabled: true, client: c}), b = create({enabled: true, client: c});
  await assert.rejects(a.withDomainSession(() => a.client.query('SELECT')));
  assert.equal(b.status().poisoned, true);
  await assert.rejects(b.withDomainSession(() => 'other'), code('CRM_DOMAIN_SESSION_POISONED'));
  const d = raw(), x = create({enabled: true, client: d}), y = create({enabled: true, client: d});
  x.poison(); await assert.rejects(y.withDomainSession(() => 'other'), code('CRM_DOMAIN_SESSION_POISONED'));
});

test('a failed rollback and untracked transaction commands are fenced', async () => {
  const c = raw(text => {if (text === 'ROLLBACK') throw Object.assign(new Error('private'), {code: '08006'}); return {command: 'BEGIN', rows: []};});
  const owner = create({enabled: true, client: c});
  await assert.rejects(owner.withDomainSession(async () => {await owner.client.query(begin); await owner.client.query('ROLLBACK');}));
  assert.equal(owner.status().poisoned, true);
  const fresh = raw(), a = create({enabled: true, client: fresh});
  await a.withDomainSession(async () => {
    await assert.rejects(a.client.query('SAVEPOINT hidden'), code('CRM_DOMAIN_SESSION_TRANSACTION_REFUSED'));
    await assert.rejects(a.client.query('COMMIT'), code('CRM_DOMAIN_SESSION_TRANSACTION_REFUSED'));
  });
  assert.equal(fresh.calls.length, 0);
});

test('comments and multiple statements cannot hide transaction controls', async () => {
  const c = raw(), owner = create({enabled: true, client: c});
  await owner.withDomainSession(async () => {
    await owner.client.query(begin);
    for (const text of ['/* annotation */ SAVEPOINT hidden', '-- annotation\nCOMMIT', 'SET /* annotation */ TRANSACTION READ ONLY', 'SELECT 1; COMMIT', 'BEGIN;']) {
      await assert.rejects(owner.client.query(text), code('CRM_DOMAIN_SESSION_QUERY_REFUSED'));
    }
    await owner.client.query('ROLLBACK');
  });
  assert.deepEqual(c.calls.map(x => x.text), [begin, 'ROLLBACK']);
  assert.equal(owner.status().poisoned, false);
});

test('a client error with an internal-looking code never exposes its message', async () => {
  const secret = 'private driver detail', c = raw(() => {throw Object.assign(new Error(secret), {code: 'CRM_DOMAIN_SESSION_UPSTREAM'});});
  const owner = create({enabled: true, client: c});
  await assert.rejects(owner.withDomainSession(() => owner.client.query('SELECT')), error => {
    assert.equal(error.code, 'CRM_DOMAIN_SESSION_QUERY_FAILED');
    assert.equal(error.message, error.code);
    assert.equal(error.sqlstate, null);
    assert.equal(String(error.stack).includes(secret), false);
    return true;
  });
  assert.equal(owner.status().poisoned, false);
});
