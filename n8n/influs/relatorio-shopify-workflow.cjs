'use strict';
// Relatório Shopify por cupom (ShopifyQL, dataset sales) — workflow novo, 26/09/2026.
//
// Guarda por dia de Brasília e código o mesmo número que a Shopify mostra em "Vendas por código de
// desconto": pedidos, vendas brutas, descontos, devoluções e vendas líquidas. Serve de lado
// independente da conferência: o painel conta pedido pago; a Shopify conta o pedido na criação.
// Não soma nada com o ledger — a função crm_influ_conciliacao_v1 põe os dois lado a lado.
//
// Janela padrão: 45 dias até ONTEM. Hoje ainda está acontecendo; fica como "relatório parcial".
// Backfill: POST com { k, desde, ate }. Mesmos segredos e credenciais já usados pelo coletor.
const NAME = 'CRM — Influs · Relatório Shopify por cupom (diário 04:35)';
const SHOPS = {
  aristo: { host: 'gwx20u-vw.myshopify.com', credential: { id: 'CkOtCPF6b7FIyTjx', name: 'Shopify Admin — Aristocrata (header)' } },
  fish: { host: 'c0kfm1-qt.myshopify.com', credential: { id: 'Xv9XgNyJ1wyJFCTJ', name: 'Shopify Admin — Fishermans (header)' } },
};
const POSTGRES = { id: 'uALf0AHnEuLCgOtx', name: 'Postgres account 2' };
const API_VERSION = '2026-07';
const LIMITE = 5000;

function janelaCode(chave) {
  if (!/^[a-z0-9-]{16,64}$/.test(chave || '')) throw Error('chave do webhook invalida');
  return `// Janela do relatório. Agendado: 45 dias até ontem (Brasília). Manual: { k, desde, ate }.
const DATA = /^\\d{4}-\\d{2}-\\d{2}$/;
const b = $json.body;
if (b !== undefined && String((b || {}).k || '') !== ${JSON.stringify(chave)}) throw new Error('chave invalida');
const hojeBR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dia = (s, n) => { const x = new Date(s + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const ontem = dia(hojeBR, -1);
let desde = dia(hojeBR, -45), ate = ontem;
if (b && DATA.test(String(b.desde || '')) && DATA.test(String(b.ate || ''))) { desde = b.desde; ate = b.ate < ontem ? b.ate : ontem; }
if (desde > ate) throw new Error('janela invalida');
return [{ json: { desde, ate } }];`;
}

function consulta() {
  return `FROM sales SHOW orders, gross_sales, discounts, returns, net_sales WHERE discount_code IS NOT NULL GROUP BY discount_code TIMESERIES day SINCE ' + $json.desde + ' UNTIL ' + $json.ate + ' LIMIT ${LIMITE}`;
}
function jsonBody() {
  return "={{ JSON.stringify({ query: 'query($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }', variables: { q: '"
    + consulta() + "' } }) }}";
}

function montaCode(marca) {
  return `// Relatório Shopify por cupom → crm_influ_shopify_relatorio. Falha vira saúde ok=false, nunca zero.
const MARCA = '${marca}';
const J = $('Janela').first().json;
const src = $('ShopifyQL ${marca}').first().json;
const q = s => "'" + String(s ?? '').split("'").join("''") + "'";
const n = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? 'NULL' : Number(v);
const saude = (ok, det, itens) => \`INSERT INTO crm_influ_saude (lane,marca,ok,detalhe,em,itens)
VALUES ('relatorio_shopify',\${q(MARCA)},\${ok},\${q(String(det).slice(0,300))},now(),\${n(itens)})
ON CONFLICT (lane,marca) DO UPDATE SET ok=EXCLUDED.ok, detalhe=EXCLUDED.detalhe, em=EXCLUDED.em, itens=EXCLUDED.itens\`;
const r = src?.data?.shopifyqlQuery;
const erros = src?.errors || r?.parseErrors;
if ((Array.isArray(erros) && erros.length) || (erros && !Array.isArray(erros)) || !Array.isArray(r?.tableData?.rows)) {
  const msg = erros ? JSON.stringify(erros[0]?.message || erros[0] || erros) : 'resposta sem tableData';
  return [{ json: { sql: saude(false, msg, null) + '; SELECT 0 AS gravados' } }];
}
const rows = r.tableData.rows;
if (rows.length >= ${LIMITE}) return [{ json: { sql: saude(false, 'limite de ${LIMITE} linhas atingido; janela precisa ser dividida', rows.length) + '; SELECT 0 AS gravados' } }];
const vals = [];
for (const x of rows) {
  const codigo = String(x.discount_code || '').trim().toUpperCase();
  const dia = String(x.day || '').slice(0, 10);
  if (!codigo || !/^\\d{4}-\\d{2}-\\d{2}$/.test(dia)) continue;
  vals.push(\`(\${q(MARCA)},\${q(dia)}::date,\${q(codigo)},\${n(x.orders)},\${n(x.gross_sales)},\${n(x.discounts)},\${n(x.returns)},\${n(x.net_sales)})\`);
}
const det = vals.length + ' linha(s) dia×cupom, janela ' + J.desde + ' a ' + J.ate;
const cob = \`INSERT INTO crm_influ_shopify_relatorio_cobertura (marca,dia,coletado_em)
SELECT \${q(MARCA)}, d::date, now() FROM generate_series(\${q(J.desde)}::date, \${q(J.ate)}::date, interval '1 day') d
ON CONFLICT (marca,dia) DO UPDATE SET coletado_em=now()\`;
const base = saude(true, det, vals.length) + ';\\n' + cob + ';\\n';
if (!vals.length) return [{ json: { sql: base + \`DELETE FROM crm_influ_shopify_relatorio WHERE marca=\${q(MARCA)} AND dia BETWEEN \${q(J.desde)}::date AND \${q(J.ate)}::date; SELECT 0 AS gravados\` } }];
const sql = base + \`WITH v (marca,dia,codigo,pedidos,vendas_brutas,descontos,devolucoes,vendas_liquidas) AS (VALUES \${vals.join(',')}),
velhos AS (
  DELETE FROM crm_influ_shopify_relatorio r
  WHERE r.marca=\${q(MARCA)} AND r.dia BETWEEN \${q(J.desde)}::date AND \${q(J.ate)}::date
    AND NOT EXISTS (SELECT 1 FROM v WHERE v.dia=r.dia AND v.codigo=r.codigo)
  RETURNING 1
),
gravados AS (
  INSERT INTO crm_influ_shopify_relatorio (marca,dia,codigo,pedidos,vendas_brutas,descontos,devolucoes,vendas_liquidas,coletado_em)
  SELECT marca,dia,codigo,pedidos,vendas_brutas,descontos,devolucoes,vendas_liquidas,now() FROM v
  ON CONFLICT (marca,dia,codigo) DO UPDATE SET pedidos=EXCLUDED.pedidos, vendas_brutas=EXCLUDED.vendas_brutas,
    descontos=EXCLUDED.descontos, devolucoes=EXCLUDED.devolucoes, vendas_liquidas=EXCLUDED.vendas_liquidas, coletado_em=now()
  RETURNING 1
)
SELECT (SELECT count(*) FROM gravados) AS gravados, (SELECT count(*) FROM velhos) AS removidos\`;
return [{ json: { sql } }];`;
}

function buildWorkflow({ chave, webhookPath }) {
  if (!/^crm-influ-relatorio-shopify-[a-f0-9]{8,}$/.test(webhookPath || '')) throw Error('caminho do webhook invalido');
  const nodes = [
    { name: 'Diario 04:35', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: '35 4 * * *' }] } } },
    { name: 'POST backfill', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 200], webhookId: webhookPath,
      parameters: { path: webhookPath, httpMethod: 'POST', responseMode: 'onReceived', options: {} } },
    { name: 'Janela', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 100], parameters: { jsCode: janelaCode(chave) } },
  ];
  const connections = {
    'Diario 04:35': { main: [[{ node: 'Janela', type: 'main', index: 0 }]] },
    'POST backfill': { main: [[{ node: 'Janela', type: 'main', index: 0 }]] },
    Janela: { main: [[]] },
  };
  let y = 0;
  for (const [marca, shop] of Object.entries(SHOPS)) {
    const http = 'ShopifyQL ' + marca, monta = 'Monta ' + marca, grava = 'Grava ' + marca;
    nodes.push(
      { name: http, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [440, y], credentials: { httpHeaderAuth: shop.credential },
        parameters: { method: 'POST', url: `https://${shop.host}/admin/api/${API_VERSION}/graphql.json`, authentication: 'genericCredentialType',
          genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: jsonBody(), options: { timeout: 60000 } } },
      { name: monta, type: 'n8n-nodes-base.code', typeVersion: 2, position: [660, y], parameters: { jsCode: montaCode(marca) } },
      { name: grava, type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [880, y], credentials: { postgres: POSTGRES },
        parameters: { operation: 'executeQuery', query: '={{ $json.sql }}', options: {} } });
    connections.Janela.main[0].push({ node: http, type: 'main', index: 0 });
    connections[http] = { main: [[{ node: monta, type: 'main', index: 0 }]] };
    connections[monta] = { main: [[{ node: grava, type: 'main', index: 0 }]] };
    y += 220;
  }
  return { name: NAME, nodes, connections, settings: { timezone: 'America/Sao_Paulo', executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' } };
}

module.exports = { NAME, SHOPS, API_VERSION, LIMITE, janelaCode, jsonBody, montaCode, buildWorkflow };
