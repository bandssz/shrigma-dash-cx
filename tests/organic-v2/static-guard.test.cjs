'use strict';
// Guardas estáticas de fronteira: sem transporte, armazenamento, credencial ou ID gerado no cliente;
// CSS confinado a .sov2. Complementa (não substitui) a revisão do integrador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'ui', 'organic-v2');
const js = fs.readFileSync(path.join(dir, 'organic-v2.js'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'organic-v2.css'), 'utf8');
const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('módulo não usa transporte, armazenamento, cookies nem gera IDs', () => {
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /localStorage/, /sessionStorage/, /indexedDB/, /\.cookie\b/, /randomUUID/, /Math\.random/, /\beval\s*\(/, /new Function/, /innerHTML/, /setInterval/, /\bimport\s*\(/, /require\s*\(/]) {
    assert.doesNotMatch(code, banned, 'proibido: ' + banned);
  }
});

test('UMD exporta ShrigmaOrganicV2 com create e versão do contrato', () => {
  assert.match(js, /root\.ShrigmaOrganicV2 = api/);
  const m = require(path.join(dir, 'organic-v2.js'));
  assert.equal(typeof m.create, 'function');
  assert.equal(m.contractVersion, '1.0.1-proposed');
});

test('usa só os métodos do contrato do gateway', () => {
  const used = new Set([...code.matchAll(/\bgw\.(\w+)\s*\(/g)].map(m => m[1]));
  assert.deepEqual([...used].sort(), ['beginMutation', 'context', 'read', 'receipt', 'submit']);
});

test('CSS confinado a .sov2, sem :root/body/html nem seletor global', () => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(noComments, /:root|\bbody\b|\bhtml\b/);
  const selectors = [];
  const re = /([^{}]+)\{/g; let m;
  while ((m = re.exec(noComments))) {
    const s = m[1].trim();
    if (s.startsWith('@media') || /^[\w-]+:/.test(s) || s === '') continue;
    selectors.push(...s.split(',').map(x => x.trim()));
  }
  assert.ok(selectors.length > 20);
  for (const s of selectors) assert.match(s, /^\.sov2(\b|$)/, 'seletor fora do escopo: ' + s);
});
