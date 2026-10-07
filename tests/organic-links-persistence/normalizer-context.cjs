'use strict';
// Carrega o normalizador REAL 1.0.2 (a53fc473…) por require comum a partir do contexto pinado em
// CRM_C2_ORGANIC_LINKS_CONTEXT (ROOT-WORK/20261006-r6/context/current/files). Ausente/divergente FALHA, nunca skip.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NORMALIZER_SHA256 = 'a53fc473eb2afec76259dea7f157aea69da8c2990f86b025874cd146450b3bb8';
function loadNormalizer() {
  const dir = process.env.CRM_C2_ORGANIC_LINKS_CONTEXT;
  assert.ok(typeof dir === 'string' && dir !== '', 'CRM_C2_ORGANIC_LINKS_CONTEXT ausente: normalizador real pinado é obrigatório (falha, não skip)');
  const p = path.join(path.resolve(dir), 'ui', 'organic-v2', 'organic-contract-v1-0-2.js');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), NORMALIZER_SHA256, 'normalizador fora do pin');
  const N = require(p);
  assert.equal(N.version, '1.0.2-proposed');
  return N;
}
module.exports = { loadNormalizer, NORMALIZER_SHA256 };
