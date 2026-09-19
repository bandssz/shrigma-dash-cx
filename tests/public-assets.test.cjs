const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Pages excludes server code and private operational artifacts', () => {
  const config = read('_config.yml');
  for (const directory of ['n8n', 'tools', 'tests', 'docs', '.private', 'private', 'artifacts']) {
    assert.ok(config.split('\n').includes(`  - ${directory}`), `Missing exclusion: ${directory}`);
  }
});

test('every local dashboard script remains publishable', () => {
  for (const file of fs.readdirSync(root).filter(file => file.endsWith('.html'))) {
    for (const [, src] of read(file).matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
      if (/^(?:https?:)?\/\//.test(src)) continue;
      const local = src.split('?')[0].replace(/^\.\//, '');
      assert.ok(!/^(?:n8n|tools|tests|docs|private|artifacts)\//.test(local), `${file} references excluded asset ${local}`);
      assert.ok(fs.existsSync(path.join(root, local)), `${file} references missing asset ${local}`);
    }
  }
});

test('public campaign contract matches the shared server contract', () => {
  assert.equal(read('campaign-contract.js'), read('n8n/growth/campaign-contract.js'));
});

test('TikTok source placeholders stop before transport or mutation', async () => {
  for (const file of ['acao_exec.js', 'sonda_escopos.js', 'cobranca_envia.js', 'canal_coletar.js', 'ads_capt.js', 'acao_valida.js', 'canal_valida.js']) {
    const code = read(`n8n/tiktok/${file}`);
    let transported = false;
    const run = vm.runInNewContext(`(async function () { ${code}\n })`, {
      $json: { body: { k: '__SERVER_ONLY_TIKTOK_WRITE_KEY__' } },
      $input: { all: () => [] },
    });
    await assert.rejects(run.call({ helpers: { httpRequest() { transported = true; throw Error('transport reached'); } } }), /Configure a credencial no servidor/);
    assert.equal(transported, false, file);
  }
});
