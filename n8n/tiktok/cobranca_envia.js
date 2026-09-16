// Envia (ou simula) a cobrança de conteúdo. Dois passos por criador, porque a API separa
// o canal da mensagem:
//   POST /affiliate_seller/202412/conversations               {creator_id}        -> conversation_id
//   POST /affiliate_seller/202412/conversations/{id}/messages {msg_type,content}  -> entrega
// Em dry_run NADA disso é chamado: só grava o que teria mandado, com o texto final já montado,
// para o Felipe e a Marcela lerem a copy antes de qualquer criador receber alguma coisa.
const helpers = this.helpers;
const APP_KEY = '__APP_KEY__';
const APP_SECRET = '__APP_SECRET__';
const BASE = 'https://open-api.tiktokglobalshop.com';
const MAX_POR_EXECUCAO = 60;   // trava dura contra disparada; o controle real é crm_tts_regra.cobranca_max_dia (15/marca)
__HMAC__
const qs = p => Object.keys(p).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
function assinar(path, params, bodyStr) {
  const s = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort().map(k => `${k}${params[k]}`).join('');
  return hmacSha256Hex(APP_SECRET, APP_SECRET + path + s + (bodyStr || '') + APP_SECRET);
}
const CIPHER = { aristo: '__CIPHER_ARISTO__', fish: '__CIPHER_FISH__' };
const LOJA = { aristo: 'aristocrata', fish: 'fishermans' };
const q = s => (s === null || s === undefined || s === '') ? 'NULL' : "'" + String(s).split("'").join("''") + "'";

const tokens = {};
for (const it of $('Pegar tokens (Token Manager)').all()) {
  const j = it.json || {};
  if (j.loja && j.access_token) tokens[j.loja] = j.access_token;
}

async function chamar(marca, method, path, body) {
  const params = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: CIPHER[marca] };
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
const linhas = [], resumo = { simulado: 0, entregue: 0, erro: 0, porTentativa: {} };

for (const a of alvos.slice(0, MAX_POR_EXECUCAO)) {
  const seco = a.modo !== 'ativo';
  const t = Number(a.tentativa) || 1;
  resumo.porTentativa[t] = (resumo.porTentativa[t] || 0) + 1;
  if (seco) {
    resumo.simulado++;
    linhas.push(`(${q(a.marca)},${q(a.etapa)},${q(a.username)},${t},${q(a.creator_open_id)},${q(a.referencia)},NULL,${q(a.texto)},true,true,NULL,now())`);
    continue;
  }
  let conversa = null, erro = null;
  try {
    const c = await chamar(a.marca, 'POST', '/affiliate_seller/202412/conversations', { creator_id: a.creator_open_id });
    if (c.code === 0 && c.data) conversa = c.data.conversation_id || c.data.id || null;
    if (!conversa) erro = `abrir conversa: ${c.code} ${c.message || ''}`;
  } catch (e) { erro = 'abrir conversa: ' + String(e.message || e); }

  if (conversa && !erro) {
    try {
      const m = await chamar(a.marca, 'POST', `/affiliate_seller/202412/conversations/${conversa}/messages`,
                             { msg_type: 'TEXT', content: a.texto });
      if (m.code !== 0) erro = `entregar: ${m.code} ${m.message || ''}`;
    } catch (e) { erro = 'entregar: ' + String(e.message || e); }
  }
  if (erro) resumo.erro++; else resumo.entregue++;
  linhas.push(`(${q(a.marca)},${q(a.etapa)},${q(a.username)},${t},${q(a.creator_open_id)},${q(a.referencia)},${q(conversa)},${q(a.texto)},false,${erro ? 'false' : 'true'},${q(erro)},now())`);
  await new Promise(s => setTimeout(s, 900));   // a API limita QPS, e isto fala com gente: devagar
}

if (!linhas.length) return [{ json: { sql: 'SELECT 0 AS nada_a_cobrar', ...resumo, alvos: alvos.length } }];
// ON CONFLICT DO NOTHING é a trava real contra repetir a MESMA tentativa; a régua anda pelo número.
return [{ json: { ...resumo, alvos: alvos.length,
  sql: `INSERT INTO crm_tts_cobranca (marca, etapa, username, tentativa, creator_open_id, referencia, conversation_id, texto, dry_run, ok, erro, enviado_em)
VALUES ${linhas.join(',')}
ON CONFLICT (marca, etapa, username, tentativa) DO NOTHING
RETURNING marca, etapa, username, tentativa, dry_run, ok` } }];
