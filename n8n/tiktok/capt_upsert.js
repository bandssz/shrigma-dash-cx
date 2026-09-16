// Grava o refresh token na tabela crm_tts_token, uma linha por loja desta autorização.
// O de-para shop_id → loja é fixo: são as duas lojas do grupo.
const LOJA_POR_SHOP = {
  '7494118898942707364': { loja: 'aristocrata', marca: 'aristo' },
  '7496187684176366275': { loja: 'fishermans', marca: 'fish' },
};
const q = s => (s === null || s === undefined || s === '') ? 'NULL' : "'" + String(s).split("'").join("''") + "'";
// escopos como array literal do Postgres; vazio vira '{}' (autorização sem nenhum escopo é estado válido de erro)
const qarr = a => "'{" + (a || []).map(x => '"' + String(x).split('\\').join('\\\\').split('"').join('\\"') + '"').join(',') + "}'";
const t = $('Assinar Get Shops').first().json;
const r = $input.first().json || {};
const shops = (r.data && r.data.shops) || [];
const linhas = [], avisos = [];
for (const s of shops) {
  const m = LOJA_POR_SHOP[String(s.id)];
  if (!m) { avisos.push(`loja desconhecida: ${s.name} (${s.id}) — some ao de-para no nó "Monta upsert de tokens"`); continue; }
  linhas.push(`(${q(m.loja)},${q(m.marca)},${q(s.id)},${q(s.cipher)},${q(t.refresh_token)},${t.refresh_token_expira_em ? q(t.refresh_token_expira_em) + '::timestamptz' : 'NULL'},${q(t.seller_name)},${q(t.open_id)},${qarr(t.granted_scopes)},now(),now())`);
}
if (!linhas.length) return [{ json: { sql: 'SELECT 0 AS gravados', gravados: 0, avisos: avisos.concat(shops.length ? [] : ['Get Authorized Shops não devolveu loja: ' + (r.message || '?')]) } }];
return [{ json: {
  avisos,
  lojas: shops.map(s => s.name),
  sql: `INSERT INTO crm_tts_token (loja, marca, shop_id, shop_cipher, refresh_token, refresh_expira_em, seller_name, open_id, granted_scopes, autorizado_em, atualizado_em)
VALUES ${linhas.join(',')}
ON CONFLICT (loja) DO UPDATE SET marca=EXCLUDED.marca, shop_id=EXCLUDED.shop_id, shop_cipher=EXCLUDED.shop_cipher,
  refresh_token=EXCLUDED.refresh_token, refresh_expira_em=EXCLUDED.refresh_expira_em, seller_name=EXCLUDED.seller_name,
  open_id=EXCLUDED.open_id, granted_scopes=EXCLUDED.granted_scopes, autorizado_em=now(), atualizado_em=now()
RETURNING loja, marca, shop_id, granted_scopes, autorizado_em` } }];
