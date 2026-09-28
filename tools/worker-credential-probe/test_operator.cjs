'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pgp = require('openpgp');
const operator = require('./operator.cjs');
let parent, directory, publicInfo, receipt;
before(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-pgp-node-synthetic-'));
  await fs.chmod(parent, 0o700);
  directory = path.join(parent, 'operator');
  publicInfo = await operator.generate(directory);
  const publicKey = await pgp.readKey({ binaryKey: Buffer.from(publicInfo.public_key_b64, 'base64') });
  const plaintext = JSON.stringify({ nonce: publicInfo.nonce, role: 'crm_pgp_probe_worker', database: 'crm_pgp_prototype', password: 'a'.repeat(64) });
  const ciphertext = await pgp.encrypt({ message: await pgp.createMessage({ text: plaintext }), encryptionKeys: publicKey, format: 'binary', config: operator.CONFIG });
  receipt = { nonce: publicInfo.nonce, key_sha256: publicInfo.key_sha256, ciphertext: Buffer.from(ciphertext).toString('base64') };
});
after(async () => { if (parent) await fs.rm(parent, { recursive: true, force: true }); });
test('pins exact reviewed dependency and unmodified standard OpenPGP', async () => {
  const manifest = require('./package.json'); const lock = require('./package-lock.json');
  assert.equal(manifest.dependencies.openpgp, '6.3.1');
  assert.equal(lock.packages['node_modules/openpgp'].version, '6.3.1');
  assert.equal(lock.packages['node_modules/openpgp'].integrity, 'sha512-7oSPvmlKPojxFoyelT5DWPIAVmqWZh4qU/5pO6bdoShEtRpCw9Sye9IXUQj6EFM3XpgGssqccAr705YtTcLNQw==');
  assert.equal(operator.CONFIG.v6Keys, false); assert.equal(operator.CONFIG.aeadProtect, false);
  assert.equal(operator.CONFIG.allowUnauthenticatedMessages, false);
  assert.equal(operator.CONFIG.allowUnauthenticatedStream, false);
});
test('durable key can be reopened and has restrictive filesystem modes', async () => {
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const name of ['private-key.bin','public-key.bin','manifest.json']) assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  assert.deepEqual(await operator.publicEnvelope(directory), publicInfo);
  const key = await pgp.readKey({ binaryKey: Buffer.from(publicInfo.public_key_b64, 'base64') });
  assert.equal(key.keyPacket.version, 4); assert.equal(key.subkeys.length, 1);
  assert.equal(key.subkeys[0].keyPacket.version, 4);
  assert.equal(key.getAlgorithmInfo().bits, 3072); assert.equal(key.subkeys[0].getAlgorithmInfo().bits, 3072);
});
test('generation refuses existing state and never replaces its key or nonce', async () => {
  await assert.rejects(operator.generate(directory));
  assert.deepEqual(await operator.publicEnvelope(directory), publicInfo);
});
test('RSA v4 MDC roundtrip recovers only envelope bound to local intent', async () => {
  const payload = await operator.decrypt(directory, receipt);
  assert.equal(payload.password === 'a'.repeat(64), true);
  assert.equal(payload.nonce, publicInfo.nonce);
  await assert.rejects(operator.decrypt(directory, { ...receipt, nonce: '0'.repeat(36) }));
  await assert.rejects(operator.decrypt(directory, { ...receipt, key_sha256: '0'.repeat(64) }));
  await assert.rejects(operator.decrypt(directory, { ...receipt, unexpected: true }));
});
test('MDC corruption and truncated message are rejected', async () => {
  const altered = Buffer.from(receipt.ciphertext, 'base64'); altered[altered.length - 1] ^= 1;
  await assert.rejects(operator.decrypt(directory, { ...receipt, ciphertext: altered.toString('base64') }));
  await assert.rejects(operator.decrypt(directory, { ...receipt, ciphertext: 'YQ==' }));
});
test('valid cryptography with wrong role or personal fields is still rejected', async () => {
  const key = await pgp.readKey({ binaryKey: Buffer.from(publicInfo.public_key_b64, 'base64') });
  for (const value of [
    { nonce: publicInfo.nonce, role: 'crm_graph_worker', database: 'crm_pgp_prototype', password: 'a'.repeat(64) },
    { nonce: publicInfo.nonce, role: 'crm_pgp_probe_worker', database: 'crm_pgp_prototype', password: 'a'.repeat(64), email: 'probe@example.invalid' }
  ]) {
    const bytes = await pgp.encrypt({ message: await pgp.createMessage({ text: JSON.stringify(value) }), encryptionKeys: key, format: 'binary', config: operator.CONFIG });
    await assert.rejects(operator.decrypt(directory, { ...receipt, ciphertext: Buffer.from(bytes).toString('base64') }));
  }
});
test('insecure mode and symbolic link fail closed', async () => {
  const keyPath = path.join(directory, 'private-key.bin');
  await fs.chmod(keyPath, 0o644);
  try { await assert.rejects(operator.publicEnvelope(directory)); } finally { await fs.chmod(keyPath, 0o600); }
  const link = path.join(parent, 'linked'); await fs.symlink(directory, link);
  await assert.rejects(operator.publicEnvelope(link));
});
test('CLI requires captured output and sanitizes all failures', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'operator.cjs'), 'public', '--directory', directory], { env: { ...process.env, CRM_PGP_PROTOTYPE_CAPTURE: '' }, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'PGP_OPERATOR_UNCONFIRMED\n');
});
test('CLI public resume returns public metadata only', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'operator.cjs'), 'public', '--directory', directory], { env: { ...process.env, CRM_PGP_PROTOTYPE_CAPTURE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stderr, '');
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result, publicInfo);
  assert.equal('password' in result || 'privateKey' in result, false);
});
