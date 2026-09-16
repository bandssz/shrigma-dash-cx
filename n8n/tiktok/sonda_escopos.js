// Sonda de escopos. Bate 1 endpoint barato por família de API e classifica a resposta.
// Existe porque o 105005 do TikTok tem DOIS significados, e eles pedem ações diferentes:
//   "this app has not been granted"      -> a permissão não está no app          -> estado 'falta_no_app'
//   "the access token does not include"  -> está no app, não chegou no token     -> estado 'reautorizar'
//   code 0 (ou erro de parâmetro)        -> passou da checagem de escopo         -> estado 'ok'
// O pulo do gato: quando a TikTok APROVA uma permissão que estava em análise, a mensagem vira
// de 'falta_no_app' para 'reautorizar'. É esse instante que o painel precisa flagrar — é a
// única deixa de que reautorizar as lojas vale a pena agora.
const helpers = this.helpers;
const APP_KEY = '6ks1ed1nu6tke';
const APP_SECRET = '28756b9cdbbfb5d1f830ca41c352508832660af8';
const BASE = 'https://open-api.tiktokglobalshop.com';
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
  const s = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort().map(k => `${k}${params[k]}`).join('');
  return hmacSha256Hex(APP_SECRET, APP_SECRET + path + s + (bodyStr || '') + APP_SECRET);
}
const q = s => (s === null || s === undefined || s === '') ? 'NULL' : "'" + String(s).split("'").join("''") + "'";

// 1 alvo por família. page_size vai na QUERY: em vários destes a validação de parâmetro
// roda ANTES da checagem de escopo, e aí a resposta não diz nada sobre permissão.
const FAMILIAS = [
  { fam: 'analytics',  rot: 'Shop Analytics',       m: 'GET',  path: '/analytics/202509/shop/performance', q: { start_date_ge: '2026-09-01', end_date_lt: '2026-09-02', granularity: 'ALL' } },
  { fam: 'order',      rot: 'Order Information',    m: 'POST', path: '/order/202309/orders/search',        q: { page_size: '1' }, body: '{}' },
  { fam: 'product',    rot: 'Product Information',  m: 'POST', path: '/product/202312/products/search',    q: { page_size: '1' }, body: '{}' },
  { fam: 'finance',    rot: 'Finance',              m: 'GET',  path: '/finance/202309/statements',         q: { page_size: '1', sort_field: 'statement_time' } },
  { fam: 'fulfillment',rot: 'Fulfillment',          m: 'POST', path: '/fulfillment/202309/packages/search',q: { page_size: '1' }, body: '{}' },
  { fam: 'return',     rot: 'Return & Refund',      m: 'POST', path: '/return_refund/202309/returns/search',q: { page_size: '1' }, body: '{}' },
  // promotion é a exceção: ela exige page_size INTEIRO, o que só cabe no corpo. Com page_size na
  // query ela falha na validação de tipo ANTES de checar escopo, e a sonda leria isso como 'ok'.
  { fam: 'promotion',  rot: 'Promotion',            m: 'POST', path: '/promotion/202309/activities/search',q: {}, body: '{"page_size":1}' },
];
const CIPHER = { aristocrata: 'ROW_ClybuQAAAADyU2UHVmE1Tp9Bh09-VkFd', fishermans: 'ROW_zJ-uoAAAAAAaYEj8VRveXGiGC8P_ChU_' };
const MARCA = { aristocrata: 'aristo', fishermans: 'fish' };

function classificar(r) {
  const m = String((r && r.message) || '');
  if (!r || r.code === null || r.code === undefined) return 'desconhecido';  // sonda não chegou a medir
  if (r.code === 0) return 'ok';
  if (/app has not been granted/i.test(m)) return 'falta_no_app';
  if (/access token does not include/i.test(m)) return 'reautorizar';
  if (r.code === 105005) return 'reautorizar';        // 105005 sem mensagem conhecida: o caso mais brando
  if (/^3600/.test(String(r.code))) return 'ok';      // 36009xxx = erro de parâmetro: passou da checagem de escopo
  return 'desconhecido';                              // nunca chutar 'ok': estado não medido tem que aparecer
}

const linhas = [];
for (const it of $input.all()) {
  const loja = it.json.loja, token = it.json.access_token;
  if (!loja || !token) continue;
  for (const f of FAMILIAS) {
    const params = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: CIPHER[loja], ...f.q };
    params.sign = assinar(f.path, params, f.body || '');
    // ignoreHttpStatusErrors: o 105005 volta como HTTP 401 e, sem isso, o n8n lança uma exceção
    // cujo texto é só "Request failed with status code 401" — o corpo com a mensagem se perde,
    // e a sonda classificaria tudo errado. Precisamos do CORPO, não do status.
    const opt = { method: f.m, url: `${BASE}${f.path}?${qs(params)}`, json: false,
                  returnFullResponse: true, ignoreHttpStatusErrors: true,
                  headers: { 'x-tts-access-token': token, 'content-type': 'application/json' } };
    if (f.body) opt.body = f.body;
    let r;
    try {
      const resp = await helpers.httpRequest(opt);
      const corpo = (resp && resp.body !== undefined) ? resp.body : resp;
      r = typeof corpo === 'string' ? JSON.parse(corpo) : corpo;
    } catch (e) { r = { code: null, message: 'sonda falhou: ' + String(e.message || e) }; }
    linhas.push(`(${q(MARCA[loja])},${q(loja)},${q(f.fam)},${q(f.rot)},${q(classificar(r))},${q(String(r.message || '').slice(0, 200))},now())`);
    await new Promise(s => setTimeout(s, 350));   // a API limita QPS; 7 famílias x 2 lojas em rajada dá 429
  }
}
if (!linhas.length) return [{ json: { sql: 'SELECT 0 AS nada' } }];
return [{ json: { sql: `INSERT INTO crm_tts_escopo (marca, loja, familia, rotulo, estado, mensagem, verificado_em)
VALUES ${linhas.join(',')}
ON CONFLICT (loja, familia) DO UPDATE SET
  estado = EXCLUDED.estado, mensagem = EXCLUDED.mensagem, rotulo = EXCLUDED.rotulo, verificado_em = now(),
  -- guarda QUANDO mudou de estado: é o carimbo de "a TikTok aprovou nesta hora"
  mudou_em = CASE WHEN crm_tts_escopo.estado IS DISTINCT FROM EXCLUDED.estado THEN now() ELSE crm_tts_escopo.mudou_em END
RETURNING loja, familia, estado` } }];
