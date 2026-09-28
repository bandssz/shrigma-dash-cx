'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { sha } = require('../tools/maintenance-cart-deploy/deploy.cjs');
const operator = require('../tools/graph-worker-credential/operator.cjs');
const localRequire = createRequire(require.resolve('../tools/graph-worker-credential/package.json'));
const pgp = localRequire('openpgp');
const crypto = require('node:crypto');
const CONFIG = { v6Keys: false, aeadProtect: false, preferredSymmetricAlgorithm: pgp.enums.symmetric.aes256, preferredCompressionAlgorithm: pgp.enums.compression.uncompressed };
const FAKE = 'a'.repeat(64);
const PREFIX = /^GRAPH_WORKER_CREDENTIAL_OPERATOR_[A-Z_]+$/;
let parent, directory, publicInfo, receipt, publicKey;
const projection = value => Object.fromEntries(['nonce','key_sha256','key_fingerprint','validation_receipt_hash'].map(key => [key, value[key]]));
async function encrypted(payload, config = CONFIG) {
  return Buffer.from(await pgp.encrypt({ message: await pgp.createMessage({ text: JSON.stringify(payload) }), encryptionKeys: publicKey, format: 'binary', config })).toString('base64');
}
const payload = () => ({ nonce: publicInfo.nonce, role: 'crm_graph_worker', database: 'listmonk', password: FAKE });
async function refused(promise) {
  await assert.rejects(promise, error => PREFIX.test(error.message) && !Object.hasOwn(error, 'cause'));
}
before(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-credential-operator-test-'));
  await fs.chmod(parent, 0o700); directory = path.join(parent, 'operator');
  publicInfo = await operator.generate(directory);
  publicKey = await pgp.readKey({ binaryKey: Buffer.from(publicInfo.public_key_b64, 'base64') });
  receipt = { ...projection(publicInfo), ciphertext: await encrypted(payload()) };
});
after(async () => { if (parent) await fs.rm(parent, { recursive: true, force: true }); });
test('exact dependency version/integrity and public API boundary', () => {
  const manifest = localRequire('./package.json'), lock = localRequire('./package-lock.json');
  assert.equal(manifest.dependencies.openpgp, '6.3.1');
  assert.equal(lock.packages['node_modules/openpgp'].version, '6.3.1');
  assert.equal(lock.packages['node_modules/openpgp'].integrity, 'sha512-7oSPvmlKPojxFoyelT5DWPIAVmqWZh4qU/5pO6bdoShEtRpCw9Sye9IXUQj6EFM3XpgGssqccAr705YtTcLNQw==');
  assert.deepEqual(Object.keys(operator).sort(), ['decryptReceipt','generate','publicEnvelope']);
});
test('canonical receipt hash matches the preparer and pins exact public bytes', async () => {
  assert.deepEqual(Object.keys(publicInfo).sort(), ['key_fingerprint','key_sha256','nonce','public_key_b64','validation_receipt_hash']);
  assert.equal(publicInfo.key_sha256, crypto.createHash('sha256').update(Buffer.from(publicInfo.public_key_b64, 'base64')).digest('hex'));
  assert.equal(publicInfo.validation_receipt_hash, sha({ contract: 'crm-graph-worker-public-key-v1', version: 1, role: 'crm_graph_worker', database: 'listmonk', nonce: publicInfo.nonce, key_sha256: publicInfo.key_sha256, key_fingerprint: publicInfo.key_fingerprint }));
  assert.deepEqual(await operator.publicEnvelope(directory), publicInfo);
});
test('key files are exclusive, 0600, and key directory is 0700', async () => {
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const name of ['private-key.bin','public-key.bin','manifest.json']) assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  const previous = await fs.readFile(path.join(directory, 'private-key.bin'));
  await refused(operator.generate(directory));
  assert.equal((await fs.readFile(path.join(directory, 'private-key.bin'))).equals(previous), true);
  assert.deepEqual(await operator.publicEnvelope(directory), publicInfo);
});
test('RSA v4 single encryption subkey has no deadline for day-two recovery', async () => {
  assert.equal(publicKey.keyPacket.version, 4); assert.equal(publicKey.subkeys.length, 1);
  assert.equal(publicKey.subkeys[0].keyPacket.version, 4);
  assert.equal(publicKey.getAlgorithmInfo().bits, 3072); assert.equal(publicKey.subkeys[0].getAlgorithmInfo().bits, 3072);
  assert.equal(await publicKey.getExpirationTime(), Infinity);
  assert.equal(await publicKey.subkeys[0].getExpirationTime(), Infinity);
  const future = new Date(publicKey.getCreationTime().getTime() + 365 * 86400000);
  await publicKey.verifyPrimaryKey(future); await publicKey.subkeys[0].verify(future);
  assert.equal((await publicKey.getEncryptionKey(undefined, future)).getFingerprint(), publicKey.subkeys[0].getFingerprint());
  assert.deepEqual(await operator.publicEnvelope(directory), publicInfo);
  assert.equal((await operator.decryptReceipt(directory, receipt)).password === FAKE, true);
});
test('reopening in a separate process preserves key and intent without outputting secret', () => {
  const modulePath = require.resolve('../tools/graph-worker-credential/operator.cjs');
  const r = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).publicEnvelope(process.argv[2]).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>process.exitCode=1)', modulePath, directory], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stderr, ''); assert.deepEqual(JSON.parse(r.stdout), publicInfo);
  assert.equal(r.stdout.includes(FAKE), false);
});
test('memory-only decryption checks all public receipt pins', async () => {
  const recovered = await operator.decryptReceipt(directory, receipt);
  assert.equal(recovered.password === FAKE, true); assert.equal(recovered.role, 'crm_graph_worker'); assert.equal(recovered.database, 'listmonk');
  for (const key of ['nonce','key_sha256','key_fingerprint','validation_receipt_hash']) await refused(operator.decryptReceipt(directory, { ...receipt, [key]: 'wrong' }));
  await refused(operator.decryptReceipt(directory, { ...receipt, unexpected: true }));
});
test('MDC tampering, truncation, malformed base64 and non-MDC inputs fail closed', async () => {
  const corrupted = Buffer.from(receipt.ciphertext, 'base64'); corrupted[corrupted.length - 1] ^= 1;
  for (const ciphertext of [corrupted.toString('base64'), 'YQ==', receipt.ciphertext + '?', '']) await refused(operator.decryptReceipt(directory, { ...receipt, ciphertext }));
  const literal = await pgp.createMessage({ text: JSON.stringify(payload()) });
  await refused(operator.decryptReceipt(directory, { ...receipt, ciphertext: Buffer.from(literal.write()).toString('base64') }));
});
test('valid ciphertext with other identity, plaintext type or unknown personal field is rejected', async () => {
  for (const value of [
    { ...payload(), role: 'postgres' }, { ...payload(), database: 'other' },
    { ...payload(), nonce: crypto.randomUUID() }, { ...payload(), password: 'not-a-credential' },
    { ...payload(), email: 'synthetic@example.invalid' }, 'not an envelope'
  ]) await refused(operator.decryptReceipt(directory, { ...receipt, ciphertext: await encrypted(value) }));
});
test('partial state is never repaired or replaced automatically', async () => {
  const partial = path.join(parent, 'partial'); await fs.mkdir(partial, { mode: 0o700 });
  await fs.writeFile(path.join(partial, 'private-key.bin'), 'synthetic-partial', { flag: 'wx', mode: 0o600 });
  await refused(operator.publicEnvelope(partial)); await refused(operator.generate(partial));
  assert.equal((await fs.readFile(path.join(partial, 'private-key.bin'))).toString(), 'synthetic-partial');
});
test('weak directory or file modes are rejected', async () => {
  await fs.chmod(directory, 0o755);
  try { await refused(operator.publicEnvelope(directory)); } finally { await fs.chmod(directory, 0o700); }
  const file = path.join(directory, 'private-key.bin'); await fs.chmod(file, 0o644);
  try { await refused(operator.publicEnvelope(directory)); } finally { await fs.chmod(file, 0o600); }
  const weakParent = path.join(parent, 'weak'); await fs.mkdir(weakParent, { mode: 0o755 });
  await refused(operator.generate(path.join(weakParent, 'operator')));
});
test('directory symlink, private key symlink, and hardlink are rejected', async () => {
  const directoryLink = path.join(parent, 'linked'); await fs.symlink(directory, directoryLink);
  await refused(operator.publicEnvelope(directoryLink));
  const file = path.join(directory, 'private-key.bin'), backup = path.join(directory, 'private-key.saved');
  await fs.rename(file, backup);
  try {
    await fs.symlink(backup, file); await refused(operator.publicEnvelope(directory)); await fs.unlink(file);
    await fs.link(backup, file); await refused(operator.publicEnvelope(directory)); await fs.unlink(file);
  } finally { await fs.rename(backup, file); }
});
test('public key and manifest drift cannot be blessed by reopening', async () => {
  for (const name of ['public-key.bin','manifest.json']) {
    const file = path.join(directory, name), original = await fs.readFile(file);
    try {
      if (name === 'public-key.bin') { const corrupt = Buffer.from(original); corrupt[100] ^= 1; await fs.writeFile(file, corrupt); }
      else { const manifest = JSON.parse(original.toString()); manifest.nonce = crypto.randomUUID(); await fs.writeFile(file, JSON.stringify(manifest)); }
      await refused(operator.publicEnvelope(directory));
    } finally { await fs.writeFile(file, original); }
  }
});
test('a valid private key from another intent is rejected', async () => {
  const other = path.join(parent, 'other'); await operator.generate(other);
  const file = path.join(directory, 'private-key.bin'), original = await fs.readFile(file);
  try {
    await fs.writeFile(file, await fs.readFile(path.join(other, 'private-key.bin')));
    await refused(operator.publicEnvelope(directory));
  } finally { await fs.writeFile(file, original); }
});
test('module execution cannot decrypt or reveal a credential through stdout', () => {
  const r = spawnSync(process.execPath, [require.resolve('../tools/graph-worker-credential/operator.cjs'), 'decrypt', '--directory', directory], { input: JSON.stringify(receipt), encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'GRAPH_WORKER_CREDENTIAL_OPERATOR_API_ONLY\n');
});
