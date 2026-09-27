'use strict';
// Foto do produto direto da TikTok (27/09/2026, pedido do Felipe: "veja a foto no TikTok e reaproveita").
// Acrescenta ao workflow do sender (37W8obVhxFccuHgv) uma cadeia separada, diária às 05:50:
//   Fotos 05:50 → Produtos sem foto (SQL) → Tokens (fotos) → Fotos TikTok → Grava fotos (SQL)
// Reaproveita a assinatura que já está no node "Envia" do mesmo workflow; a chave não sai do workflow.
// Só leitura na TikTok: GET /product/202309/products/{id}. Não toca na cadeia da cobrança.
const WORKFLOW_ID = '37W8obVhxFccuHgv';
const FONTE = 'Envia', FRONTEIRA = '\nconst espera = ms =>';
const NOVOS = ['Fotos 05:50', 'Produtos sem foto (SQL)', 'Tokens (fotos)', 'Fotos TikTok', 'Grava fotos (SQL)'];
const LISTA = "SELECT marca, product_id FROM public.crm_tts_produto_v1 WHERE foto_em IS NULL OR foto_em < now() - interval '30 days' ORDER BY foto_em NULLS FIRST, marca, product_id LIMIT 120";
const corpo = prefix => `${prefix.split("$('Pegar tokens (Token Manager)')").join("$('Tokens (fotos)')")}
const espera = ms => new Promise(s => setTimeout(s, ms));
const fotos = [];
for (const it of $('Produtos sem foto (SQL)').all()) {
  const p = it.json || {};
  if (!['aristo', 'fish'].includes(p.marca) || !/^\\d{10,25}$/.test(String(p.product_id || ''))) continue;
  let url = null, ok = false;
  try {
    const r = await chamar(p.marca, 'GET', '/product/202309/products/' + p.product_id);
    const im = r && r.code === 0 && r.data && Array.isArray(r.data.main_images) ? r.data.main_images[0] : null;
    const u = im && Array.isArray(im.urls) ? im.urls.find(x => /^https:\\/\\//.test(x)) : null;
    ok = !!(r && r.code === 0); url = u || null;
  } catch (e) { ok = false; }
  if (ok) fotos.push({ marca: p.marca, product_id: String(p.product_id), imagem: url });
  await espera(250);
}
return [{ json: { args: [JSON.stringify({ fotos })] } }];`;

function addFotoChain(fresh, { expectedVersionId } = {}) {
  if (!fresh || fresh.id !== WORKFLOW_ID || !expectedVersionId || fresh.versionId !== expectedVersionId || fresh.activeVersionId !== expectedVersionId) throw Error('export fresco e ativo esperado');
  if (fresh.nodes.some(n => NOVOS.includes(n.name))) throw Error('cadeia de fotos já existe');
  const envia = fresh.nodes.find(n => n.name === FONTE), tok = fresh.nodes.find(n => n.name === 'Pegar tokens (Token Manager)'), pg = fresh.nodes.find(n => n.name === 'Prepara fila (SQL)');
  if (!envia || !tok || !pg) throw Error('nodes de referência ausentes');
  const code = envia.parameters.jsCode;
  if (code.split(FRONTEIRA).length !== 2) throw Error('fronteira do Envia mudou');
  const prefix = code.split(FRONTEIRA)[0];
  if (!prefix.includes('async function chamar(') || !prefix.includes("$('Pegar tokens (Token Manager)').all()") || /const APP_SECRET = '__SERVER_ONLY_/.test(prefix)) throw Error('prefixo de assinatura mudou');
  const w = JSON.parse(JSON.stringify({ name: fresh.name, nodes: fresh.nodes, connections: fresh.connections, settings: fresh.settings }));
  const cred = JSON.parse(JSON.stringify(pg.credentials));
  w.nodes.push(
    { id: 'foto-1', name: 'Fotos 05:50', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 1200], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '50 5 * * *' }] } } },
    { id: 'foto-2', name: 'Produtos sem foto (SQL)', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [240, 1200], credentials: cred, alwaysOutputData: false, parameters: { operation: 'executeQuery', query: LISTA, options: {} } },
    { id: 'foto-3', name: 'Tokens (fotos)', type: tok.type, typeVersion: tok.typeVersion, position: [480, 1200], parameters: { ...JSON.parse(JSON.stringify(tok.parameters)), mode: 'once' } },
    { id: 'foto-4', name: 'Fotos TikTok', type: 'n8n-nodes-base.code', typeVersion: 2, position: [720, 1200], parameters: { jsCode: corpo(prefix) } },
    { id: 'foto-5', name: 'Grava fotos (SQL)', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [960, 1200], credentials: cred, parameters: { operation: 'executeQuery', query: 'SELECT public.crm_tts_produto_foto_v1($1::jsonb) AS r', options: { queryReplacement: '={{ $json.args }}' } } },
  );
  const link = (a, b) => { w.connections[a] = { main: [[{ node: b, type: 'main', index: 0 }]] }; };
  link('Fotos 05:50', 'Produtos sem foto (SQL)'); link('Produtos sem foto (SQL)', 'Tokens (fotos)'); link('Tokens (fotos)', 'Fotos TikTok'); link('Fotos TikTok', 'Grava fotos (SQL)');
  return w;
}
module.exports = { WORKFLOW_ID, NOVOS, LISTA, corpo, addFotoChain };
