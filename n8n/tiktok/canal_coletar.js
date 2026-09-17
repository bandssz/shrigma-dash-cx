// ============================================================
// COLETOR DE CANAL — Shop Analytics, 2 lojas. Devolve 1 item por (marca, fonte) com linhas já
// normalizadas para crm_tts_canal_dia / crm_tts_live_dia / crm_tts_video_dia. Quem monta o SQL é o nó seguinte.
//   canal  : /analytics/202509/shop/performance   (granularity 1D → 1 linha 'total' + live/video/vitrine por dia)
//   lives  : /analytics/202509/shop_lives/performance  (por SESSÃO; inclui lives de afiliados vendendo a loja)
//   videos : /analytics/202509/shop_videos/performance (acumulado da janela; retrato top N por GMV)
// A API NÃO separa afiliado x próprio no total do dia — essa fatia vem de crm_tts_pedido, na view.
// Em lives/vídeos separa-se por username: conta da loja = 'proprio', o resto = 'afiliado'.
// ============================================================
const helpers = this.helpers;
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

const APP_KEY = '6ks1ed1nu6tke';
const APP_SECRET = '28756b9cdbbfb5d1f830ca41c352508832660af8';
const BASE = 'https://open-api.tiktokglobalshop.com';
const TOP_VIDEOS = 200;              // 2 páginas de 100; abaixo disso é GMV zero na prática
const LOJAS = {
  aristocrata: { marca: 'aristo', cipher: 'ROW_ClybuQAAAADyU2UHVmE1Tp9Bh09-VkFd', proprio: ['oaristocrata.com'] },
  fishermans:  { marca: 'fish',   cipher: 'ROW_zJ-uoAAAAAAaYEj8VRveXGiGC8P_ChU_', proprio: ['fishermans.com.br'] },
};
const janela = $('Janela').first().json;
const tokens = {};
for (const it of $input.all()) if (it.json.loja && it.json.access_token) tokens[it.json.loja] = it.json.access_token;

// ---------- chamada assinada, com backoff em 429 ----------
function assinar(path, params, bodyStr) {
  const sorted = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort().map(k => `${k}${params[k]}`).join('');
  return hmacSha256Hex(APP_SECRET, APP_SECRET + path + sorted + (bodyStr || '') + APP_SECRET);
}
const qs = p => Object.keys(p).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
const dorme = ms => new Promise(r => setTimeout(r, ms));
async function chamar(token, cipher, path, query) {
  const params = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: cipher, ...(query || {}) };
  params.sign = assinar(path, params, '');
  const opts = { method: 'GET', url: `${BASE}${path}?${qs(params)}`, json: false, returnFullResponse: true, ignoreHttpStatusErrors: true,
    headers: { 'x-tts-access-token': token, 'content-type': 'application/json' } };
  let ultimoErro;
  for (let tent = 0; tent < 4; tent++) {
    try {
      let r = await helpers.httpRequest(opts);
      let corpo = (r && r.body !== undefined) ? r.body : r;
      if (typeof corpo === 'string') corpo = JSON.parse(corpo);
      if (corpo.code !== 0) throw new Error(`${path} → ${corpo.code} ${corpo.message}`);
      return corpo.data || {};
    } catch (e) {
      ultimoErro = e;
      if (!/429|too many|rate limit|50[0-4]/i.test(String(e.message || e))) throw e;
      await dorme(1500 * Math.pow(2, tent));
      params.timestamp = String(Math.floor(Date.now() / 1000)); params.sign = assinar(path, params, '');
      opts.url = `${BASE}${path}?${qs(params)}`;
    }
  }
  throw ultimoErro;
}

// ---------- conversores ----------
const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace('%', '').replace(',', '.')); return Number.isNaN(n) ? null : n; };
const amt = v => (v && typeof v === 'object') ? num(v.amount) : num(v);      // {amount,currency} → número
const pctStr = v => num(v);                                                   // "4.09%" → 4.09
const pctFrac = v => (num(v) === null ? null : Math.round(num(v) * 10000) / 100);  // "0.3462" → 34.62
const tsEpoch = v => (num(v) ? new Date(num(v) * 1000).toISOString() : null);
const diaBR = iso => (iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) : null);
const addDias = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const origem = (loja, username) => (LOJAS[loja].proprio.includes(String(username || '').toLowerCase()) ? 'proprio' : 'afiliado');

// A API aceita no máximo ~30 dias por chamada de 1D; fatia a janela pedida.
function fatias(dias) {
  const fim = addDias(janela.hoje, 1);            // end_date_lt é exclusivo: inclui hoje (parcial) — o cron de amanhã corrige
  const ini = addDias(janela.hoje, -(dias - 1));
  const out = []; let a = ini;
  while (a < fim) { const b = addDias(a, 30) < fim ? addDias(a, 30) : fim; out.push([a, b]); a = b; }
  return out;
}

// ---------- fontes ----------
async function coletarCanal(loja) {
  const { marca, cipher } = LOJAS[loja]; const rows = []; let paginas = 0;
  for (const [a, b] of fatias(janela.dias)) {
    const d = await chamar(tokens[loja], cipher, '/analytics/202509/shop/performance',
      { start_date_ge: a, end_date_lt: b, granularity: '1D', currency: 'LOCAL' });
    paginas++;
    for (const it of ((d.performance || {}).intervals || [])) {
      const dia = it.start_date || addDias(it.end_date, -1);
      const s = it.sales || {}, t = it.traffic || {};
      const gmvTipo = {}; for (const bd of ((s.gmv || {}).breakdowns || [])) gmvTipo[bd.type] = amt(bd.gmv);
      const rev = {}; for (const bd of ((s.gross_revenue || {}).breakdowns || [])) rev[bd.type] = pctFrac(bd.percentage);
      const base = { marca, dia, origem: 'todos' };
      rows.push({ ...base, superficie: 'total',
        gmv: amt((s.gmv || {}).overall), receita_bruta: amt((s.gross_revenue || {}).overall), gmv_max_pct: rev.GMV_MAX,
        gmv_ads: (amt((s.gross_revenue || {}).overall) !== null && rev.GMV_MAX !== null) ? Math.round(amt(s.gross_revenue.overall) * rev.GMV_MAX) / 100 : null,
        pedidos: num(s.orders_count), sku_pedidos: num(s.sku_orders_count), unidades: num(s.items_sold), compradores: num(s.avg_customers_count),
        reembolso: amt(s.refunds), visitantes: num(t.avg_visitors), visualizacoes: num(t.avg_page_views), conversao_pct: pctFrac(t.avg_conversation_rate) });
      for (const [tipo, sup] of [['LIVE', 'live'], ['VIDEO', 'video'], ['PRODUCT_CARD', 'vitrine']])
        rows.push({ ...base, superficie: sup, gmv: gmvTipo[tipo] === undefined ? 0 : gmvTipo[tipo] });
    }
    await dorme(300);
  }
  return { rows, paginas, latest: null };
}

async function coletarLives(loja) {
  const { marca, cipher } = LOJAS[loja]; const rows = []; let paginas = 0, latest = null;
  const fim = addDias(janela.hoje, 1), ini = addDias(janela.hoje, -(janela.dias - 1));
  let token = '';
  for (let i = 0; i < 40; i++) {
    const q = { start_date_ge: ini, end_date_lt: fim, currency: 'LOCAL', page_size: '50', sort_field: 'gmv', sort_order: 'DESC' };
    if (token) q.page_token = token;
    const d = await chamar(tokens[loja], cipher, '/analytics/202509/shop_lives/performance', q);
    paginas++; latest = d.latest_available_date || latest;
    for (const l of (d.live_stream_sessions || [])) {
      const sp = l.sales_performance || {}, ip = l.interaction_performance || {};
      const ini_iso = tsEpoch(l.start_time), fim_iso = tsEpoch(l.end_time);
      const g24 = amt(sp['24h_live_gmv']);
      rows.push({ marca, live_id: String(l.id), dia: diaBR(ini_iso), username: l.username || null, origem: origem(loja, l.username), titulo: l.title || null,
        inicio_em: ini_iso, fim_em: fim_iso, duracao_min: (ini_iso && fim_iso) ? Math.round((num(l.end_time) - num(l.start_time)) / 60) : null,
        gmv: amt(sp.gmv), gmv_24h: (g24 === null || g24 < 0) ? null : g24, ticket_medio: amt(sp.avg_price),
        pedidos: num(sp.sku_orders), unidades: num(sp.items_sold), compradores: num(sp.customers), produtos_vendidos: num(sp.different_products_sold),
        clique_pedido_pct: pctStr(sp.click_to_order_rate),
        visualizacoes: num(ip.views), espectadores: num(ip.viewers), cliques: num(ip.product_clicks), impressoes_produto: num(ip.product_impressions),
        ctr_pct: pctStr(ip.click_through_rate), curtidas: num(ip.likes), comentarios: num(ip.comments), novos_seguidores: num(ip.new_followers),
        tempo_medio_s: num(ip.avg_viewing_duration) });
    }
    token = d.next_page_token || '';
    // a lista vem ordenada por GMV desc: depois de uma página inteira de zero, o resto é ruído de afiliado sem venda
    const ultimas = (d.live_stream_sessions || []).map(l => amt((l.sales_performance || {}).gmv) || 0);
    if (!token || (ultimas.length && ultimas.every(g => g === 0) && rows.length >= 50)) break;
    await dorme(300);
  }
  return { rows, paginas, latest };
}

async function coletarVideos(loja) {
  const { marca, cipher } = LOJAS[loja]; const rows = []; let paginas = 0, latest = null;
  const fim = addDias(janela.hoje, 1), ini = addDias(janela.hoje, -29);
  let token = '';
  while (rows.length < TOP_VIDEOS) {
    const q = { start_date_ge: ini, end_date_lt: fim, currency: 'LOCAL', page_size: '100', sort_field: 'gmv', sort_order: 'DESC' };
    if (token) q.page_token = token;
    const d = await chamar(tokens[loja], cipher, '/analytics/202509/shop_videos/performance', q);
    paginas++; latest = d.latest_available_date || latest;
    for (const v of (d.videos || [])) {
      rows.push({ marca, video_id: String(v.id), username: v.username || null, origem: origem(loja, v.username), titulo: (v.title || '').slice(0, 300) || null,
        publicado_em: v.video_post_time ? v.video_post_time.replace(' ', 'T') + '-03:00' : null,
        gmv: amt(v.gmv), gpm: amt(v.gpm), pedidos: num(v.sku_orders), unidades: num(v.items_sold), compradores: num(v.avg_customers),
        visualizacoes: num(v.views), ctr_pct: pctFrac(v.click_through_rate), duracao_s: num(v.duration),
        produtos: JSON.stringify((v.products || []).map(p => ({ id: String(p.id), nome: p.name }))), hashtags: (v.hash_tags || []).map(String), janela_dias: 30 });
    }
    token = d.next_page_token || '';
    const ultimas = (d.videos || []).map(v => amt(v.gmv) || 0);
    if (!token || (ultimas.length && ultimas.every(g => g === 0))) break;
    await dorme(300);
  }
  // 'dia' do retrato = último dia disponível na API (o dado de hoje ainda não fechou)
  const dia = latest || addDias(janela.hoje, -1);
  for (const r of rows) r.dia = dia;
  return { rows, paginas, latest };
}

// ---------- roda tudo, serial por loja (QPS) ----------
const out = [];
for (const loja of Object.keys(LOJAS)) {
  const marca = LOJAS[loja].marca;
  if (!tokens[loja]) { for (const f of ['canal', 'lives', 'videos']) out.push({ json: { marca, fonte: f, rows: [], paginas: 0, erro: 'sem token no Token Manager', iniciado_em: new Date().toISOString() } }); continue; }
  for (const [fonte, fn] of [['canal', coletarCanal], ['lives', coletarLives], ['videos', coletarVideos]]) {
    const iniciado_em = new Date().toISOString();
    try { const r = await fn(loja); out.push({ json: { marca, fonte, rows: r.rows, paginas: r.paginas, latest: r.latest, erro: null, iniciado_em } }); }
    catch (e) { out.push({ json: { marca, fonte, rows: [], paginas: 0, erro: String(e.message || e).slice(0, 500), iniciado_em } }); }
    await dorme(400);
  }
}
return out;
