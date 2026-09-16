// Executa a ação validada. 'revisar' chama o TikTok (review de 1 pedido) e grava a decisão manual;
// 'regra' só monta o UPDATE de crm_tts_regra. Sempre devolve { ok, mensagem, sql }.
const helpers = this.helpers;
const APP_KEY = '6ks1ed1nu6tke';
const APP_SECRET = '28756b9cdbbfb5d1f830ca41c352508832660af8';
const BASE = 'https://open-api.tiktokglobalshop.com';
const CIPHER = { aristo: 'ROW_ClybuQAAAADyU2UHVmE1Tp9Bh09-VkFd', fish: 'ROW_zJ-uoAAAAAAaYEj8VRveXGiGC8P_ChU_' };
const LOJA = { aristo: 'aristocrata', fish: 'fishermans' };
// ---- HMAC-SHA256 em JS puro (o Code node do n8n não permite o módulo crypto). Saída em hex. ----
// Implementação padrão FIPS 180-4; validada contra o módulo crypto do Node antes de ir pro n8n.
function sha256Bytes(msg) { // msg: Uint8Array → Uint8Array(32)
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const len = msg.length, bitLen = len * 8;
  const padLen = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen); buf.set(msg); buf[len] = 0x80;
  buf[padLen - 4] = (bitLen >>> 24) & 255; buf[padLen - 3] = (bitLen >>> 16) & 255; buf[padLen - 2] = (bitLen >>> 8) & 255; buf[padLen - 1] = bitLen & 255;
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = (buf[off + i*4] << 24) | (buf[off + i*4+1] << 16) | (buf[off + i*4+2] << 8) | buf[off + i*4+3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3);
      const s1 = rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[i*4] = H[i] >>> 24; out[i*4+1] = (H[i] >>> 16) & 255; out[i*4+2] = (H[i] >>> 8) & 255; out[i*4+3] = H[i] & 255; }
  return out;
}
function utf8(s) { // o sandbox do n8n nao tem codificador nativo: codifica UTF-8 na mao
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}
function hmacSha256Hex(key, msg) {
  let k = utf8(key); if (k.length > 64) k = sha256Bytes(k);
  const kp = new Uint8Array(64); kp.set(k);
  const ipad = kp.map(x => x ^ 0x36), opad = kp.map(x => x ^ 0x5c);
  const m = utf8(msg);
  const inner = new Uint8Array(64 + m.length); inner.set(ipad); inner.set(m, 64);
  const ih = sha256Bytes(inner);
  const outer = new Uint8Array(96); outer.set(opad); outer.set(ih, 64);
  return Array.from(sha256Bytes(outer)).map(x => x.toString(16).padStart(2, '0')).join('');
}

const qs = p => Object.keys(p).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
function assinar(path, params, bodyStr) {
  const sorted = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort().map(k => `${k}${params[k]}`).join('');
  return hmacSha256Hex(APP_SECRET, APP_SECRET + path + sorted + (bodyStr || '') + APP_SECRET);
}
const q = s => (s === null || s === undefined) ? 'NULL' : "'" + String(s).split("'").join("''") + "'";

const a = $('Valida').first().json;
const tokens = {};
for (const it of $input.all()) if (it.json.loja && it.json.access_token) tokens[it.json.loja] = it.json.access_token;

if (a.acao === 'regra') {
  const sets = Object.entries(a.regra).map(([k, v]) => `${k} = ${typeof v === 'number' ? v : q(v)}`);
  sets.push(`atualizado_em = now()`, `atualizado_por = ${q(a.autor + ' (painel)')}`);
  return [{ json: { ok: true, mensagem: `regra da marca ${a.marca} atualizada: ${Object.keys(a.regra).join(', ')}`,
    sql: `UPDATE crm_tts_regra SET ${sets.join(', ')} WHERE marca = ${q(a.marca)} RETURNING *` } }];
}

// revisar
const token = tokens[LOJA[a.marca]];
if (!token) return [{ json: { ok: false, mensagem: 'Token Manager não devolveu token da loja', sql: 'SELECT 0' } }];
// Medido em 16/09/2026: o caminho /202507/sample_applications/review NÃO existe (36009009 Invalid path)
// e o id NÃO vai no corpo. O endpoint vivo é /202409/sample_applications/{id}/review, com o id no
// CAMINHO e só o review_result no corpo (a API confirma: "ReviewResult is required, allowed: APPROVE, REJECT").
// Este era o motivo de a ação do painel nunca ter funcionado — nunca tinha sido exercitada de verdade.
const path = `/affiliate_seller/202409/sample_applications/${a.application_id}/review`;
const body = { review_result: a.resultado };
if (a.resultado === 'REJECT') body.reject_reason = a.motivo_rejeicao;
const bodyStr = JSON.stringify(body);
const params = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: CIPHER[a.marca] };
params.sign = assinar(path, params, bodyStr);
let r;
try {
  r = await helpers.httpRequest({ method: 'POST', url: `${BASE}${path}?${qs(params)}`, json: false, body: bodyStr,
    headers: { 'x-tts-access-token': token, 'content-type': 'application/json' } });
  if (typeof r === 'string') r = JSON.parse(r);
} catch (e) { r = { code: -1, message: e.message }; }
if (r.code !== 0) {
  return [{ json: { ok: false, mensagem: `TikTok recusou: ${r.code} ${r.message}`,
    sql: `INSERT INTO crm_tts_coleta_log (marca, fonte, terminado_em, linhas, ok, erro) VALUES (${q(a.marca)}, 'acao_painel', now(), 0, false, ${q(a.resultado + ' ' + a.application_id + ': ' + r.code + ' ' + r.message)})` } }];
}
const aprovou = a.resultado === 'APPROVE';
const sql = `WITH l AS (INSERT INTO crm_tts_coleta_log (marca, fonte, terminado_em, linhas, ok) VALUES (${q(a.marca)}, 'acao_painel', now(), 1, true) RETURNING 1)
UPDATE crm_tts_amostra SET
  decisao = ${q(aprovou ? 'manual_aprovada' : 'manual_rejeitada')},
  decisao_motivo = ${q((a.observacao ? a.observacao + ' · ' : '') + 'decidido no painel por ' + a.autor + (aprovou ? '' : ' · ' + a.motivo_rejeicao))},
  decidido_em = now(), decidido_por = ${q(a.autor + ' (painel)')}, dry_run = false,
  status = ${q(aprovou ? 'AWAITING_SHIPMENT' : 'REJECT_CANCELLED')}, atualizado_em = now()
WHERE marca = ${q(a.marca)} AND application_id = ${q(a.application_id)}
RETURNING application_id, username, status, decisao`;
return [{ json: { ok: true, mensagem: `${aprovou ? 'Aprovada' : 'Rejeitada'} no TikTok (request ${r.request_id || ''})`, sql } }];
