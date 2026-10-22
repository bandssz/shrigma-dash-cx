'use strict';
// Reuse the seven pinned V1 payloads from the published presentation parent.
// Write only six additional panel replacements and an explicit thirteen-file
// manifest. No runtime, image pack, identity, provider or authority is created.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const release = require('./release.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const PREVIOUS_MANIFEST = 'c8de73c9f4afcc31eb9040f44850ad07dd8de3ca7ed8af95a5daf10b7df1aa1b';
const PREVIOUS_FILES = Object.freeze(['assets/panels/growth.js', 'creators/index.html', 'crm/index.html', 'entry.js', 'gestao/index.html', 'growth.html', 'organico/index.html']);
const SOURCE_PINS = Object.freeze({
  'assets/panels/influs.css': '86f46577e9c72d36b23f599de45b049ebda134bbf339607d81f39d58e69a2406',
  'assets/panels/influs.js': 'e662c04812a1505e4178eaa589a9f83b57e688faebffd9877497eda643f98bae',
  'assets/panels/organico.css': 'ef89318de87830f0e79b905a2617edd6685b567ac7156b67c0d444af3a9a9a75',
  'assets/panels/organico.js': '645ed968912efc86ff86b06167d63d775fb19bb662e61238a70d9827ddb03259',
  'influs.html': '9884e1b18bfc06f3137027965d50f2c099432808cf2b86fecb4a623cd15bce16',
  'organico.html': '83ac63e49955bba801e1321ce4252708aefb97fdbb5ed63f07acfa4699c025ba'
});
const BUILD_HELPERS = Object.freeze({
  'services/dashboard-operational/build.cjs': '4bb955d96644f1a4472a81210a644cbd4a0b15e23d67c614e78062c2d2b99c2c',
  'services/dashboard-operational/public/entry.js': 'e3dd53afd7ab70d71c4b82478829c8edd99eb08894837d51f98f5068d92959eb'
});
const refuse = () => { throw Error('PRESENTATION_V2_BUILD_REFUSED'); };
const same = (a, b) => ['dev', 'ino', 'size', 'nlink', 'uid', 'gid', 'mode', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]);
function read(file, expected) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || fs.realpathSync(file) !== file || s.size < 1 || s.size > 2 * 1024 * 1024) refuse();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!same(s, fs.fstatSync(fd))) refuse();
    const b = fs.readFileSync(fd);
    if (b.length !== s.size || !same(s, fs.fstatSync(fd)) || !same(s, fs.lstatSync(file)) || expected && sha(b) !== expected) refuse();
    return b;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function buildRelease({ sourceRoot, imageDir, previousReleaseDir, output }) {
  for (const dir of [sourceRoot, imageDir, previousReleaseDir]) if (typeof dir !== 'string' || !path.isAbsolute(dir) || fs.realpathSync(dir) !== dir) refuse();
  if (typeof output !== 'string' || !path.isAbsolute(output) || fs.existsSync(output) || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) refuse();
  for (const [file, pin] of Object.entries(release.IMAGE_FILES)) read(path.join(imageDir, file), pin);
  const policy = require(path.join(imageDir, 'artifact-policy.cjs'));
  const original = policy.decodePack(read(path.join(imageDir, 'runtime-pack.json'), release.IMAGE_FILES['runtime-pack.json']).toString('utf8'), release.BASE_PACK);
  if (original.files.length !== 58 || original.files.filter(f => f.path.startsWith('public/')).length !== 30 || original.files.filter(f => f.path.startsWith('runtime/')).length !== 28) refuse();
  const originals = new Map(original.files.map(f => [f.path, Buffer.from(f.content, f.encoding)]));
  const previous = JSON.parse(read(path.join(previousReleaseDir, 'manifest.json'), PREVIOUS_MANIFEST).toString('utf8'));
  if (previous.schema !== 'crm-presentation-release-v1' || previous.baseImageDigest !== release.BASE_IMAGE || previous.baseSourceRevision !== release.BASE_SOURCE || previous.basePackSha256 !== release.BASE_PACK || JSON.stringify(previous.files.map(f => f.path)) !== JSON.stringify(PREVIOUS_FILES)) refuse();
  const reused = new Map();
  for (const f of previous.files) {
    const before = originals.get('public/' + f.path), after = read(path.join(previousReleaseDir, 'public', f.path), f.afterSha256);
    if (!before || sha(before) !== f.beforeSha256 || before.length !== f.beforeBytes || after.length !== f.afterBytes) refuse();
    reused.set(f.path, after);
  }
  for (const [file, pin] of Object.entries(BUILD_HELPERS)) read(path.join(sourceRoot, file), pin);
  const builder = require(path.join(sourceRoot, 'services/dashboard-operational/build.cjs'));
  const changed = new Map();
  for (const [file, pin] of Object.entries(SOURCE_PINS)) {
    const before = originals.get('public/' + file), after = Buffer.from(builder.transform(read(path.join(sourceRoot, file), pin).toString('utf8'), file));
    if (!before || before.equals(after) || after.length < 1 || after.length > 2 * 1024 * 1024) refuse();
    changed.set(file, after);
  }
  if (JSON.stringify([...reused.keys(), ...changed.keys()].sort()) !== JSON.stringify(release.FILES)) refuse();
  const manifest = { schema: 'crm-presentation-release-v2', baseImageDigest: release.BASE_IMAGE, baseSourceRevision: release.BASE_SOURCE, basePackSha256: release.BASE_PACK, files: release.FILES.map(file => {
    const before = originals.get('public/' + file), after = reused.get(file) || changed.get(file);
    return { path: file, beforeSha256: sha(before), beforeBytes: before.length, afterSha256: sha(after), afterBytes: after.length };
  }) };
  fs.mkdirSync(output, { mode: 0o755 });
  for (const [file, bytes] of changed) {
    const target = path.join(output, 'public', file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o444 });
  }
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(output, 'manifest.json'), raw, { flag: 'wx', mode: 0o444 });
  const protect = dir => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.lstatSync(file).isDirectory()) protect(file); else fs.chmodSync(file, 0o444); } fs.chmodSync(dir, 0o555); };
  protect(output);
  return { schema: 'crm-presentation-build-receipt-v2', manifestSha256: sha(Buffer.from(raw)), changedFilesWritten: 6, previousFilesReused: 7, originalPublicFiles: 30, originalRuntimeFiles: 28, originalArtifactFiles: 58, files: manifest.files, basePackUnchanged: true, operational: false };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 6) refuse();
    console.log(JSON.stringify(buildRelease({ sourceRoot: path.resolve(process.argv[2]), imageDir: path.resolve(process.argv[3]), previousReleaseDir: path.resolve(process.argv[4]), output: path.resolve(process.argv[5]) })));
  } catch { console.error('PRESENTATION_V2_BUILD_REFUSED'); process.exitCode = 1; }
}
module.exports = { buildRelease, PREVIOUS_MANIFEST, PREVIOUS_FILES, SOURCE_PINS, BUILD_HELPERS };
