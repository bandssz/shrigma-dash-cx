'use strict';
// Root CI only: a fixed pinned driver and the existing isolated PG17 CI service.
// Importing this file creates no client and never attests a native proof.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const SCENARIOS = ['roundtrip-outcome', 'capacity-race', 'facts-revocation', 'partial-rollback', 'fence-ack', 'reservation-ack'];

async function main() {
  if (process.env.CRM_ATOMIC_NATIVE_CI !== '1' || process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'bandssz/shrigma-dash-cx' || process.version !== 'v22.23.3') throw Error('CRM_ATOMIC_NATIVE_CI_REFUSED');
  const repository = fs.realpathSync(process.env.GITHUB_WORKSPACE), temp = fs.realpathSync(process.env.RUNNER_TEMP);
  assert.equal(fs.realpathSync(process.cwd()), repository);
  assert.equal(process.env.CRM_ATOMIC_SOURCE_MODE, 'candidate');
  assert.equal(process.env.CRM_ATOMIC_SOURCE_ROOT, repository);
  assert.equal(process.env.CRM_ATOMIC_PUBLIC_CONTEXT, path.join(repository, 'deliverables/mvp-tres-frentes-cowork-20261006/staging/B1/ROOT-WORK/20261006-r1/context/source'));
  const driver = path.join(temp, 'borrowed-pg-driver/node_modules/pg');
  assert.equal(fs.realpathSync(driver), driver);
  const pkg = JSON.parse(fs.readFileSync(path.join(driver, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'pg'); assert.equal(pkg.version, '8.13.1');
  const {Client} = require(driver), D = require('../../tests/crm-atomic-reservation/inputs.cjs').load();
  assert.equal(typeof Client, 'function');
  const receipt = await require('./fixture.cjs').run({
    enabled: true, D,
    makeClient: () => new Client({host: '127.0.0.1', port: 5432, user: 'crm_test', password: 'crm_test_only', database: 'crm_borrowed_source_test', connectionTimeoutMillis: 10000, query_timeout: 15000}),
    admitIsolatedCI: async () => ({isolated: true, database: 'crm_borrowed_source_test', engineMajor: 17, sourceOnly: true, production: false})
  });
  assert.equal(receipt.executed, true); assert.match(receipt.engine, /^17[0-9]{4}$/);
  assert.equal(receipt.scenarios, 6); assert.equal(receipt.created, 12); assert.equal(receipt.endCalls, 12); assert.equal(receipt.closed, 12);
  assert.equal(receipt.fixtureScope, 'Root-borrowed-existing-CI-service');
  assert.equal(receipt.nativePG17Proof, false); assert.equal(receipt.nativeNetworkAckProof, false);
  assert.equal(receipt.sourceOnly, true); assert.equal(receipt.operational, false);
  assert.equal(receipt.productionInstalled, false); assert.equal(receipt.productionDurabilityProved, false);
  assert.deepEqual(receipt.results.map(r => r.scenario), SCENARIOS);
  for (const r of receipt.results) {
    assert.equal(r.passed, true); assert.equal(r.engine, receipt.engine);
    assert.equal(r.created, 2); assert.equal(r.endCalls, 2);
    assert.equal(r.pids.length, 2); assert(r.pids.every(Number.isSafeInteger)); assert.notEqual(r.pids[0], r.pids[1]);
    assert.equal(r.operational, false); assert.equal(r.nativePG17Proof, false); assert.equal(r.nativeNetworkAckProof, false);
  }
  console.log(JSON.stringify({...receipt, code: 'CRM_ATOMIC_NATIVE_PG17_SOURCE_PASSED', nativePG17Proof: true, driver: 'pg8.13.1', proofScope: 'six-new-isolated-source-scenarios', faultHooksSynthetic: true}));
}

if (require.main === module) main().catch(() => {console.error('CRM_ATOMIC_NATIVE_CI_REFUSED'); process.exitCode = 1;});
module.exports = Object.freeze({ENABLED: false, sourceOnly: true, operational: false, nativePG17Proof: false});
