// Captura da autorização do TikTok for Business (Marketing API v1.3).
// O Felipe (ou o admin do Ads Manager) abre a URL de autorização do app; a TikTok redireciona para este
// webhook com ?auth_code=...; aqui o código vira access_token (não expira, só por revogação), descobrimos
// as contas de anúncio autorizadas e casamos cada uma com a loja (shop_id) para virar 'marca'.
const helpers = this.helpers;
const APP_ID = '7634837098909941761';
const SECRET = 'd017e3b38c0adcc8e4c9f2d96ae52e1f4ce33dd5';
const BASE = 'https://business-api.tiktok.com/open_api/v1.3';
const SHOP_MARCA = { '7496187684176366275': 'fish', '7494118898942707364': 'aristo' };   // shop_id da Shop API → marca
const q = s => (s === null || s === undefined) ? 'NULL' : "'" + String(s).split("'").join("''") + "'";
const arr = v => Array.isArray(v) && v.length ? 'ARRAY[' + v.map(q).join(',') + ']::text[]' : 'NULL';

const query = $json.query || {};
const code = query.auth_code || query.code;
if (!code) return [{ json: { ok: false, html: '<h2>Faltou o auth_code na URL.</h2><p>Abra a URL de autorização de novo.</p>', sql: 'SELECT 0' } }];

async function api(method, path, body, token) {
  const opt = { method, url: BASE + path, json: false, returnFullResponse: true, ignoreHttpStatusErrors: true,
    headers: { 'content-type': 'application/json', ...(token ? { 'Access-Token': token } : {}) } };
  if (body) opt.body = JSON.stringify(body);
  const r = await helpers.httpRequest(opt);
  let corpo = (r && r.body !== undefined) ? r.body : r;
  return typeof corpo === 'string' ? JSON.parse(corpo) : corpo;
}

const t = await api('POST', '/oauth2/access_token/', { app_id: APP_ID, secret: SECRET, auth_code: code });
if (t.code !== 0) return [{ json: { ok: false, html: `<h2>TikTok recusou o código</h2><pre>${t.code} ${t.message}</pre><p>O auth_code vale 1 hora e só uma vez: abra a URL de autorização de novo.</p>`, sql: 'SELECT 0' } }];
const token = t.data.access_token, escopos = (t.data.scope || []).map(String);

const adv = await api('GET', `/oauth2/advertiser/get/?app_id=${APP_ID}&secret=${SECRET}`, null, token);
const contas = ((adv.data || {}).list || []);
const linhas = [], resumo = [];
for (const c of contas) {
  const id = String(c.advertiser_id);
  let moeda = null, marca = null, lojas = [];
  try { const i = await api('GET', `/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([id]))}`, null, token);
        moeda = (((i.data || {}).list || [])[0] || {}).currency || null; } catch (e) {}
  try { const s = await api('GET', `/gmv_max/store/list/?advertiser_id=${id}`, null, token);
        lojas = (((s.data || {}).stores) || ((s.data || {}).list) || []);
        for (const l of lojas) { const m = SHOP_MARCA[String(l.store_id || l.shop_id || '')]; if (m) marca = marca && marca !== m ? 'ambas' : m; } } catch (e) {}
  linhas.push(`(${q(id)},${q(c.advertiser_name)},${q(marca)},${q(moeda)},${q(token)},${arr(escopos)},now(),now())`);
  resumo.push(`${c.advertiser_name} (${id}) → ${marca || 'loja não casada'}${lojas.length ? ' · lojas: ' + lojas.map(l => l.store_name || l.store_id).join(', ') : ''}`);
}
const sql = linhas.length ? `INSERT INTO crm_tts_ads_token (advertiser_id, nome, marca, moeda, access_token, escopos, autorizado_em, atualizado_em)
VALUES ${linhas.join(',')}
ON CONFLICT (advertiser_id) DO UPDATE SET nome = EXCLUDED.nome, marca = COALESCE(EXCLUDED.marca, crm_tts_ads_token.marca), moeda = EXCLUDED.moeda,
  access_token = EXCLUDED.access_token, escopos = EXCLUDED.escopos, autorizado_em = now(), ultimo_erro = NULL, atualizado_em = now()` : 'SELECT 0';
return [{ json: { ok: contas.length > 0, sql,
  html: `<h2>${contas.length ? 'Autorizado ✔' : 'Autorizou, mas nenhuma conta de anúncio veio junto'}</h2><ul>${resumo.map(r => `<li>${r}</li>`).join('')}</ul><p>Escopos: ${escopos.join(', ') || '—'}</p><p>Pode fechar esta aba. O coletor de ads roda às 04:30.</p>` } }];
