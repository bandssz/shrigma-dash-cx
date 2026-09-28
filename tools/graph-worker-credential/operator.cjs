'use strict';
// Local API only: no SQL, network, environment secret, logger or plaintext CLI.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const openpgp = require('openpgp');
const ROLE = 'crm_graph_worker';
const DATABASE = 'listmonk';
const CONTRACT = 'crm-graph-worker-public-key-v1';
const LOCAL_CONTRACT = 'crm-graph-worker-local-key-v1';
const CONFIG = Object.freeze({ v6Keys: false, aeadProtect: false,
  preferredSymmetricAlgorithm: openpgp.enums.symmetric.aes256,
  preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed,
  allowUnauthenticatedMessages: false, allowUnauthenticatedStream: false });
const FILES = ['private-key.bin', 'public-key.bin', 'manifest.json'];
const MAX = 65536;
const ERROR_PREFIX = 'GRAPH_WORKER_CREDENTIAL_OPERATOR_';
function check(ok, code) { if (!ok) throw new Error(ERROR_PREFIX + code); }
function exact(value, keys) { return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
// This descriptor is flat. Alphabetical keys produce the same canonical JSON
// as maintenance-cart-deploy's recursive canonical() for its primitive values.
function validationRecord(value) { return { contract: CONTRACT, version: 1, role: ROLE, database: DATABASE, nonce: value.nonce, key_sha256: value.key_sha256, key_fingerprint: value.key_fingerprint }; }
function validationHash(value) { const record = validationRecord(value); return hash(JSON.stringify(Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]])))); }
async function safe(operation) {
  try { return await operation(); }
  catch (error) {
    const message = typeof error?.message === 'string' && /^GRAPH_WORKER_CREDENTIAL_OPERATOR_[A-Z_]+$/.test(error.message) ? error.message : ERROR_PREFIX + 'UNCONFIRMED';
    // No cause, OpenPGP diagnostic, path, submitted receipt or plaintext escapes.
    throw new Error(message);
  }
}
async function privateDirectory(directory) {
  check(typeof directory === 'string' && path.isAbsolute(directory), 'DIRECTORY');
  const stat = await fs.lstat(directory);
  check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid(), 'DIRECTORY_MODE');
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writePrivate(directory, name, bytes) {
  const handle = await fs.open(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function readPrivate(directory, name) {
  const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid() && stat.size > 0 && stat.size <= MAX, 'FILE_MODE');
    const buffer = Buffer.alloc(MAX + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    check(bytesRead === stat.size, 'FILE_CHANGED');
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function validateKey(key) {
  check(key.keyPacket.version === 4 && key.subkeys.length === 1 && key.subkeys[0].keyPacket.version === 4, 'KEY_VERSION');
  check(key.getAlgorithmInfo().algorithm === 'rsaEncryptSign' && key.getAlgorithmInfo().bits === 3072 && key.subkeys[0].getAlgorithmInfo().algorithm === 'rsaEncryptSign' && key.subkeys[0].getAlgorithmInfo().bits === 3072, 'KEY_ALGORITHM');
  await key.verifyPrimaryKey(); await key.subkeys[0].verify();
  check((await key.getEncryptionKey()).getFingerprint() === key.subkeys[0].getFingerprint() && (await key.getSigningKey()).getFingerprint() === key.getFingerprint(), 'KEY_USAGE');
  check(await key.getExpirationTime() === Infinity && await key.subkeys[0].getExpirationTime() === Infinity, 'KEY_EXPIRATION');
}
async function load(directory) {
  await privateDirectory(directory);
  const manifest = JSON.parse((await readPrivate(directory, FILES[2])).toString('utf8'));
  check(exact(manifest, ['contract','version','library','created_at','role','database','nonce','key_sha256','key_fingerprint','validation_receipt_hash']) && manifest.contract === LOCAL_CONTRACT && manifest.version === 1 && manifest.library === 'openpgp@6.3.1' && manifest.role === ROLE && manifest.database === DATABASE && typeof manifest.created_at === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/.test(manifest.created_at) && typeof manifest.nonce === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(manifest.nonce) && typeof manifest.key_sha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.key_sha256) && typeof manifest.key_fingerprint === 'string' && /^[a-f0-9]{40}$/.test(manifest.key_fingerprint), 'MANIFEST');
  check(manifest.validation_receipt_hash === validationHash(manifest), 'VALIDATION_HASH');
  const publicBytes = await readPrivate(directory, FILES[1]);
  check(hash(publicBytes) === manifest.key_sha256, 'KEY_HASH');
  const publicKey = await openpgp.readKey({ binaryKey: publicBytes, config: CONFIG });
  await validateKey(publicKey);
  check(publicKey.getFingerprint() === manifest.key_fingerprint && publicKey.getCreationTime().toISOString() === manifest.created_at, 'KEY_FINGERPRINT');
  const privateKey = await openpgp.readPrivateKey({ binaryKey: await readPrivate(directory, FILES[0]), config: CONFIG });
  check(privateKey.isDecrypted() && privateKey.toPublic().getFingerprint() === manifest.key_fingerprint && Buffer.from(privateKey.toPublic().write()).equals(publicBytes), 'PRIVATE_KEY_BINDING');
  await privateKey.keyPacket.validate(); await privateKey.subkeys[0].keyPacket.validate();
  return { manifest, publicBytes, privateKey };
}
function descriptor({ manifest, publicBytes }) {
  return Object.freeze({ public_key_b64: publicBytes.toString('base64'), key_sha256: manifest.key_sha256,
    key_fingerprint: manifest.key_fingerprint, nonce: manifest.nonce, validation_receipt_hash: manifest.validation_receipt_hash });
}
async function generate(directory) { return safe(async () => {
  check(typeof directory === 'string' && path.isAbsolute(directory), 'DIRECTORY');
  await privateDirectory(path.dirname(directory));
  // Partial state stays for explicit reconciliation. Never replace a key that
  // might already identify a committed preparation or an uncertain response.
  await fs.mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
  const pair = await openpgp.generateKey({ type: 'rsa', rsaBits: 3072,
    userIDs: [{ name: 'CRM graph worker credential recovery' }],
    subkeys: [{ sign: false, rsaBits: 3072 }], keyExpirationTime: 0,
    format: 'object', config: CONFIG });
  // Recovery must still work on day two and after a delayed acknowledgement.
  // Fresh database seals/admission govern preparation, not a key expiry timer.
  await validateKey(pair.publicKey);
  const publicBytes = Buffer.from(pair.publicKey.write());
  const manifest = { contract: LOCAL_CONTRACT, version: 1, library: 'openpgp@6.3.1',
    created_at: pair.publicKey.getCreationTime().toISOString(), role: ROLE, database: DATABASE,
    nonce: crypto.randomUUID(), key_sha256: hash(publicBytes), key_fingerprint: pair.publicKey.getFingerprint() };
  manifest.validation_receipt_hash = validationHash(manifest);
  await writePrivate(directory, FILES[0], pair.privateKey.write());
  await writePrivate(directory, FILES[1], publicBytes);
  await writePrivate(directory, FILES[2], JSON.stringify(manifest));
  await syncDirectory(directory); await syncDirectory(path.dirname(directory));
  return descriptor(await load(directory));
}); }
async function publicEnvelope(directory) { return safe(async () => descriptor(await load(directory))); }
async function decryptReceipt(directory, receipt) { return safe(async () => {
  check(exact(receipt, ['ciphertext','nonce','key_sha256','key_fingerprint','validation_receipt_hash']) && typeof receipt.ciphertext === 'string' && receipt.ciphertext.length > 0 && receipt.ciphertext.length <= MAX && /^[A-Za-z0-9+/=\r\n]+$/.test(receipt.ciphertext), 'RECEIPT');
  const { manifest, privateKey } = await load(directory);
  check(['nonce','key_sha256','key_fingerprint','validation_receipt_hash'].every(key => receipt[key] === manifest[key]), 'RECEIPT_BINDING');
  const encoded = receipt.ciphertext.replace(/[\r\n]/g, '');
  const binaryMessage = Buffer.from(encoded, 'base64');
  check(binaryMessage.toString('base64') === encoded, 'CIPHERTEXT_ENCODING');
  const message = await openpgp.readMessage({ binaryMessage, config: CONFIG });
  const packets = [...message.packets];
  check(packets.length === 2 && packets[0].constructor.tag === openpgp.enums.packet.publicKeyEncryptedSessionKey && packets[1].constructor.tag === openpgp.enums.packet.symEncryptedIntegrityProtectedData && packets[1].version === 1, 'MDC_REQUIRED');
  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey, format: 'utf8', config: CONFIG });
  check(typeof data === 'string' && data.length <= 4096, 'PLAINTEXT_SIZE');
  const envelope = JSON.parse(data);
  check(exact(envelope, ['nonce','role','database','password']) && envelope.nonce === manifest.nonce && envelope.role === ROLE && envelope.database === DATABASE && typeof envelope.password === 'string' && /^[a-f0-9]{64}$/.test(envelope.password), 'PLAINTEXT_BINDING');
  // The caller receives plaintext only in memory and owns its subsequent use.
  // It must first verify the authoritative DB receipt via the Preparer.
  return Object.freeze(envelope);
}); }
module.exports = { generate, publicEnvelope, decryptReceipt };
if (require.main === module) {
  process.stderr.write('GRAPH_WORKER_CREDENTIAL_OPERATOR_API_ONLY\n');
  process.exitCode = 1;
}
