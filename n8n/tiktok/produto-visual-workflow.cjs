'use strict';
// Workflow "TikTok — fotos dos produtos (diário 05:40)": lê o catálogo público das duas lojas (products.json,
// sem credencial) e reclassifica os produtos da TikTok já vistos (produto-visual.sql). Não escreve nas lojas.
const NAME = 'TikTok — fotos dos produtos para o painel (diário 05:40)';
const POSTGRES = { id: 'uALf0AHnEuLCgOtx', name: 'Postgres account 2' };
const LOJAS = { aristo: 'https://oaristocrata.com', fish: 'https://fishermans.com.br' };
const BUSCA = `const LOJAS = ${JSON.stringify(LOJAS)};
const out = {};
for (const [marca, base] of Object.entries(LOJAS)) {
  const r = await this.helpers.httpRequest({ method: 'GET', url: base + '/products.json?limit=250', json: true, timeout: 30000 });
  if (!r || !Array.isArray(r.products)) throw new Error('catálogo inválido: ' + marca);
  out[marca] = JSON.stringify({ marca, produtos: r.products.map(p => ({ handle: p.handle, titulo: p.title,
    imagem_url: p.images && p.images[0] ? p.images[0].src : null, url: base + '/products/' + p.handle })) });
}
return [{ json: { args: [out.aristo, out.fish] } }];`;
function buildWorkflow() {
  const nodes = [
    { name: 'Diário 05:40', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '40 5 * * *' }] } } },
    { name: 'Busca catálogos', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: BUSCA } },
    { name: 'Grava e classifica', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [440, 0], credentials: { postgres: POSTGRES },
      parameters: { operation: 'executeQuery', query: 'SELECT public.crm_tts_loja_produto_upsert_v1($1::jsonb) AS aristo, public.crm_tts_loja_produto_upsert_v1($2::jsonb) AS fish, public.crm_tts_produto_sync_v1() AS tiktok',
        options: { queryReplacement: '={{ $json.args }}' } } },
  ];
  const connections = { 'Diário 05:40': { main: [[{ node: 'Busca catálogos', type: 'main', index: 0 }]] }, 'Busca catálogos': { main: [[{ node: 'Grava e classifica', type: 'main', index: 0 }]] } };
  return { name: NAME, nodes, connections, settings: { timezone: 'America/Sao_Paulo', executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', callerPolicy: 'workflowsFromSameOwner' } };
}
module.exports = { NAME, BUSCA, LOJAS, buildWorkflow };
