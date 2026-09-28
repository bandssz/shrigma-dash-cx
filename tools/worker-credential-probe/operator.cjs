'use strict';
// Synthetic interoperability proof only. No LOGIN transition or production role.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const openpgp = require('openpgp');
const ROLE = 'crm_pgp_probe_worker';
const DATABASE = 'crm_pgp_prototype';
const CONFIG = Object.freeze({ v6Keys: false, aeadProtect: false,
  preferredSymmetricAlgorithm: openpgp.enums.symmetric.aes256,
  preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed,
  allowUnauthenticatedMessages: false, allowUnauthenticatedStream: false });
const FILES = ['private-key.bin', 'public-key.bin', 'manifest.json'];
const MAX = 65536;
function requireThat(ok, code) { if (!ok) throw new Error('PGP_OPERATOR_' + code); }
function exactKeys(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function privateDirectory(directory) {
  requireThat(typeof directory === 'string' && path.isAbsolute(directory), 'DIRECTORY');
  const stat = await fs.lstat(directory);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid(), 'DIRECTORY_MODE');
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
    requireThat(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid() && stat.size > 0 && stat.size <= MAX, 'FILE_MODE');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function validateKey(key) {
  requireThat(key.keyPacket.version === 4 && key.subkeys.length === 1 && key.subkeys[0].keyPacket.version === 4, 'KEY_VERSION');
  requireThat(key.getAlgorithmInfo().algorithm === 'rsaEncryptSign' && key.getAlgorithmInfo().bits === 3072 && key.subkeys[0].getAlgorithmInfo().algorithm === 'rsaEncryptSign' && key.subkeys[0].getAlgorithmInfo().bits === 3072, 'KEY_ALGORITHM');
  await key.verifyPrimaryKey(); await key.subkeys[0].verify();
  requireThat((await key.getEncryptionKey()).getFingerprint() === key.subkeys[0].getFingerprint(), 'ENCRYPTION_SUBKEY');
}
async function generate(directory) {
  requireThat(typeof directory === 'string' && path.isAbsolute(directory), 'DIRECTORY');
  await privateDirectory(path.dirname(directory));
  // Existing or partial state is never replaced: it may already bind a DB write.
  await fs.mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
  const pair = await openpgp.generateKey({ type: 'rsa', rsaBits: 3072,
    userIDs: [{ name: 'CRM synthetic probe', email: 'probe@example.invalid' }],
    subkeys: [{ sign: false, rsaBits: 3072 }], keyExpirationTime: 86400,
    format: 'object', config: CONFIG });
  await validateKey(pair.publicKey);
  const publicBytes = Buffer.from(pair.publicKey.write());
  const manifest = { version: 1, library: 'openpgp@6.3.1', nonce: crypto.randomUUID(),
    role: ROLE, database: DATABASE, key_sha256: sha256(publicBytes),
    key_fingerprint: pair.publicKey.getFingerprint() };
  await writePrivate(directory, FILES[0], pair.privateKey.write());
  await writePrivate(directory, FILES[1], publicBytes);
  await writePrivate(directory, FILES[2], JSON.stringify(manifest));
  await syncDirectory(directory); await syncDirectory(path.dirname(directory));
  return publicEnvelope(directory);
}
async function load(directory) {
  await privateDirectory(directory);
  const manifest = JSON.parse((await readPrivate(directory, FILES[2])).toString('utf8'));
  requireThat(exactKeys(manifest, ['version','library','nonce','role','database','key_sha256','key_fingerprint']) && manifest.version === 1 && manifest.library === 'openpgp@6.3.1' && manifest.role === ROLE && manifest.database === DATABASE && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(manifest.nonce) && /^[a-f0-9]{64}$/.test(manifest.key_sha256) && /^[a-f0-9]{40}$/.test(manifest.key_fingerprint), 'MANIFEST');
  const publicBytes = await readPrivate(directory, FILES[1]);
  requireThat(sha256(publicBytes) === manifest.key_sha256, 'KEY_HASH');
  const publicKey = await openpgp.readKey({ binaryKey: publicBytes, config: CONFIG });
  await validateKey(publicKey);
  requireThat(publicKey.getFingerprint() === manifest.key_fingerprint, 'KEY_FINGERPRINT');
  const privateKey = await openpgp.readPrivateKey({ binaryKey: await readPrivate(directory, FILES[0]), config: CONFIG });
  requireThat(privateKey.toPublic().getFingerprint() === manifest.key_fingerprint && Buffer.from(privateKey.toPublic().write()).equals(publicBytes), 'PRIVATE_KEY_BINDING');
  return { manifest, publicBytes, privateKey };
}
async function publicEnvelope(directory) {
  const { manifest, publicBytes } = await load(directory);
  return { ...manifest, public_key_b64: publicBytes.toString('base64') };
}
async function decrypt(directory, receipt) {
  requireThat(exactKeys(receipt, ['ciphertext','key_sha256','nonce']) && typeof receipt.ciphertext === 'string' && receipt.ciphertext.length > 0 && receipt.ciphertext.length <= MAX && /^[A-Za-z0-9+/=\r\n]+$/.test(receipt.ciphertext), 'RECEIPT');
  const { manifest, privateKey } = await load(directory);
  requireThat(receipt.key_sha256 === manifest.key_sha256 && receipt.nonce === manifest.nonce, 'RECEIPT_BINDING');
  const encoded = receipt.ciphertext.replace(/[\r\n]/g, '');
  const binaryMessage = Buffer.from(encoded, 'base64');
  requireThat(binaryMessage.toString('base64') === encoded, 'CIPHERTEXT_ENCODING');
  const message = await openpgp.readMessage({ binaryMessage, config: CONFIG });
  const packets = [...message.packets];
  requireThat(packets.length === 2 && packets[0].constructor.tag === openpgp.enums.packet.publicKeyEncryptedSessionKey && packets[1].constructor.tag === openpgp.enums.packet.symEncryptedIntegrityProtectedData && packets[1].version === 1, 'MDC_REQUIRED');
  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey, format: 'utf8', config: CONFIG });
  requireThat(typeof data === 'string' && data.length <= 4096, 'PLAINTEXT_SIZE');
  const envelope = JSON.parse(data);
  requireThat(exactKeys(envelope, ['nonce','role','database','password']) && envelope.nonce === manifest.nonce && envelope.role === ROLE && envelope.database === DATABASE && typeof envelope.password === 'string' && /^[a-f0-9]{64}$/.test(envelope.password), 'PLAINTEXT_BINDING');
  return envelope;
}
async function main() {
  requireThat(process.env.CRM_PGP_PROTOTYPE_CAPTURE === '1' && !process.stdout.isTTY, 'CAPTURE_REQUIRED');
  const [command, flag, directory, ...extra] = process.argv.slice(2);
  requireThat(['generate','public','decrypt'].includes(command) && flag === '--directory' && !extra.length, 'ARGUMENTS');
  let result;
  if (command === 'generate') result = await generate(directory);
  else if (command === 'public') result = await publicEnvelope(directory);
  else {
    let input = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      requireThat(input.length + chunk.length <= MAX, 'INPUT_LIMIT');
      input = Buffer.concat([input, chunk]);
    }
    result = await decrypt(directory, JSON.parse(input.toString('utf8')));
  }
  // This pipe is consumed in memory by the synthetic Python proof. Never log it.
  process.stdout.write(JSON.stringify(result));
}
module.exports = { CONFIG, generate, publicEnvelope, decrypt };
if (require.main === module) main().catch(() => { process.stderr.write('PGP_OPERATOR_UNCONFIRMED\n'); process.exitCode = 1; });
