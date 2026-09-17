// Envia (ou simula) a cobrança de conteúdo. Três passos por criador:
//   POST /affiliate_seller/202508/conversations                 {creator_open_id}   -> conversation_id (+ creator_im_id, is_new, unread_count)
//   GET  /affiliate_seller/202412/conversation/{id}/messages    page_size 20        -> últimas mensagens da conversa
//   POST /affiliate_seller/202412/conversations/{id}/messages   {msg_type,content}  -> entrega
// A 202412 de abrir conversa exigia id NUMÉRICO (creator_id) que nenhum payload nosso tem — foi o que
// travou tudo em 16/09. A 202508 aceita o creator_open_id que já guardamos.
// Ler a conversa antes é o que faz a régua ser "se não respondeu, manda outra", e não "manda de novo":
//   - última palavra é do criador (ou há não lidas)     -> PULA 'respondeu'      (a bola está com a Marcela)
//   - alguém falou nos últimos DIAS_QUIETOS dias         -> PULA 'conversa_ativa' (não empilhar robô em conversa humana)
// Pulo vai para crm_tts_cobranca_pulo e NÃO conta como toque da régua.
// Em dry_run NADA disso é chamado: só grava o que teria mandado, com o texto final já montado,
// para o Felipe e a Marcela lerem a copy antes de qualquer criador receber alguma coisa.
const helpers = this.helpers;
const APP_KEY = '6ks1ed1nu6tke';
const APP_SECRET = '28756b9cdbbfb5d1f830ca41c352508832660af8';
const BASE = 'https://open-api.tiktokglobalshop.com';
const MAX_POR_EXECUCAO = 60;   // trava dura contra disparada; o controle real é crm_tts_regra.cobranca_max_dia (15/marca)
const DIAS_QUIETOS = 7;        // conversa com mensagem (de qualquer lado) mais nova que isto é conversa humana: o robô não entra
const DIAS_RESPOSTA = 30;      // resposta do criador mais velha que isto (e já lida) não segura a régua: a conversa morreu, pode tocar
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
const CIPHER = { aristo: 'ROW_ClybuQAAAADyU2UHVmE1Tp9Bh09-VkFd', fish: 'ROW_zJ-uoAAAAAAaYEj8VRveXGiGC8P_ChU_' };
const LOJA = { aristo: 'aristocrata', fish: 'fishermans' };
const q = s => (s === null || s === undefined || s === '') ? 'NULL' : "'" + String(s).split("'").join("''") + "'";

const tokens = {};
for (const it of $('Pegar tokens (Token Manager)').all()) {
  const j = it.json || {};
  if (j.loja && j.access_token) tokens[j.loja] = j.access_token;
}

async function chamar(marca, method, pathComQuery, body) {
  const [path, extra] = pathComQuery.split('?');
  const params = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: CIPHER[marca] };
  if (extra) for (const kv of extra.split('&')) { const [k, v] = kv.split('='); params[k] = decodeURIComponent(v); }
  const bodyStr = body ? JSON.stringify(body) : '';
  params.sign = assinar(path, params, bodyStr);
  // ignoreHttpStatusErrors: sem isto o n8n lança exceção e o corpo com a mensagem de erro se perde
  const opt = { method, url: `${BASE}${path}?${qs(params)}`, json: false,
                returnFullResponse: true, ignoreHttpStatusErrors: true,
                headers: { 'x-tts-access-token': tokens[LOJA[marca]], 'content-type': 'application/json' } };
  if (bodyStr) opt.body = bodyStr;
  const resp = await helpers.httpRequest(opt);
  const corpo = (resp && resp.body !== undefined) ? resp.body : resp;
  return typeof corpo === 'string' ? JSON.parse(corpo) : corpo;
}

const alvos = $input.all().map(i => i.json).filter(a => a && a.username);
const linhas = [], pulos = [], resumo = { simulado: 0, entregue: 0, erro: 0, pulado: 0, porTentativa: {} };

for (const a of alvos.slice(0, MAX_POR_EXECUCAO)) {
  const seco = a.modo !== 'ativo';
  const t = Number(a.tentativa) || 1;
  resumo.porTentativa[t] = (resumo.porTentativa[t] || 0) + 1;
  if (seco) {
    resumo.simulado++;
    linhas.push(`(${q(a.marca)},${q(a.etapa)},${q(a.username)},${t},${q(a.creator_open_id)},${q(a.referencia)},NULL,${q(a.texto)},true,true,NULL,now(),NULL)`);
    continue;
  }
  let conversa = null, imId = null, erro = null, pulo = null;
  try {
    const c = await chamar(a.marca, 'POST', '/affiliate_seller/202508/conversations', { creator_open_id: a.creator_open_id, only_need_conversation_id: false });
    if (c.code === 0 && c.data) { conversa = c.data.conversation_id || null; imId = c.data.creator_im_id || null; }
    if (!conversa) erro = `abrir conversa: ${c.code} ${c.message || ''}`;
    else if (c.data.is_new === false) {
      // conversa já existia: olha o que rolou antes de falar
      const m = await chamar(a.marca, 'GET', `/affiliate_seller/202412/conversation/${conversa}/messages?page_size=20`);
      const msgs = ((m.data || {}).messages || []).map(x => x.message_body || {}).filter(x => x.type === 'TEXT' || x.type === 'IMAGE' || x.type === 'EMOTICONS')
        .sort((x, y) => Number(y.create_time) - Number(x.create_time));
      const ult = msgs[0];
      if (ult) {
        const doCriador = String(ult.sender_id) === String(imId);
        let texto = ''; try { texto = String(JSON.parse(ult.content || '{}').content || ult.type); } catch (e) { texto = ult.type; }
        const em = new Date(Number(ult.create_time) * 1000);
        const naoLidas = Number(c.data.unread_count) || 0;
        const idadeDias = (Date.now() - em.getTime()) / 864e5;
        // não lida = pendência da loja, qualquer idade; lida e recente = bola com a Marcela; lida e velha = conversa morreu
        if (naoLidas > 0 || (doCriador && idadeDias <= DIAS_RESPOSTA)) pulo = { motivo: 'respondeu', em, de: doCriador ? 'criador' : 'loja', texto, naoLidas };
        else if (idadeDias < DIAS_QUIETOS) pulo = { motivo: 'conversa_ativa', em, de: 'loja', texto, naoLidas };
      }
    }
  } catch (e) { erro = 'abrir conversa: ' + String(e.message || e); }

  if (pulo) {
    resumo.pulado = (resumo.pulado || 0) + 1;
    pulos.push(`(${q(a.marca)},${q(a.etapa)},${q(a.username)},${t},${q(pulo.motivo)},${q(conversa)},${q(imId)},${pulo.naoLidas},${q(pulo.em.toISOString())}::timestamptz,${q(pulo.de)},${q(pulo.texto.slice(0, 160))},now())`);
    await new Promise(s => setTimeout(s, 400));
    continue;
  }
  if (conversa && !erro) {
    try {
      const m = await chamar(a.marca, 'POST', `/affiliate_seller/202412/conversations/${conversa}/messages`,
                             { msg_type: 'TEXT', content: a.texto });
      if (m.code !== 0) erro = `entregar: ${m.code} ${m.message || ''}`;
    } catch (e) { erro = 'entregar: ' + String(e.message || e); }
  }
  if (erro) resumo.erro++; else resumo.entregue++;
  linhas.push(`(${q(a.marca)},${q(a.etapa)},${q(a.username)},${t},${q(a.creator_open_id)},${q(a.referencia)},${q(conversa)},${q(a.texto)},false,${erro ? 'false' : 'true'},${q(erro)},now(),${q(imId)})`);
  await new Promise(s => setTimeout(s, 900));   // a API limita QPS, e isto fala com gente: devagar
}

const stmts = [];
if (linhas.length) stmts.push(`INSERT INTO crm_tts_cobranca (marca, etapa, username, tentativa, creator_open_id, referencia, conversation_id, texto, dry_run, ok, erro, enviado_em, creator_im_id)
VALUES ${linhas.join(',')}
ON CONFLICT (marca, etapa, username, tentativa) DO NOTHING`);   // a trava real contra repetir a MESMA tentativa; a régua anda pelo número
if (pulos.length) stmts.push(`INSERT INTO crm_tts_cobranca_pulo (marca, etapa, username, tentativa, motivo, conversation_id, creator_im_id, nao_lidas, ultima_msg_em, ultima_msg_de, ultimo_texto, visto_em)
VALUES ${pulos.join(',')}
ON CONFLICT (marca, etapa, username) DO UPDATE SET tentativa = EXCLUDED.tentativa, motivo = EXCLUDED.motivo, conversation_id = EXCLUDED.conversation_id,
  creator_im_id = EXCLUDED.creator_im_id, nao_lidas = EXCLUDED.nao_lidas, ultima_msg_em = EXCLUDED.ultima_msg_em, ultima_msg_de = EXCLUDED.ultima_msg_de,
  ultimo_texto = EXCLUDED.ultimo_texto, visto_em = now()`);
if (!stmts.length) return [{ json: { sql: 'SELECT 0 AS nada_a_cobrar', ...resumo, alvos: alvos.length } }];
return stmts.map(sql => ({ json: { ...resumo, alvos: alvos.length, sql } }));
