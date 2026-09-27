'use strict';
// Workflow "Parceiros — candidatura pelo site" (27/09/2026).
// Público (LP das lojas): acao 'termo' (texto vigente) e 'enviar' (candidatura com prints).
// Painel (chave de Influs): acao 'ler' (candidaturas, sem imagens) e 'print' (uma imagem).
// Toda a regra mora no PostgreSQL (partner-candidatura.sql). O workflow só escolhe uma de duas consultas fixas,
// passa o corpo como parâmetro nativo, acrescenta IP e navegador vindos dos cabeçalhos e não guarda execução
// (a candidatura tem dado pessoal e imagem).
const NAME = 'Parceiros — candidatura pelo site (LP + painel)';
const POSTGRES = { id: 'uALf0AHnEuLCgOtx', name: 'Postgres account 2' };
const ORIGENS = ['https://oaristocrata.com', 'https://www.oaristocrata.com', 'https://fishermans.com.br', 'https://www.fishermans.com.br',
  'https://gwx20u-vw.myshopify.com', 'https://c0kfm1-qt.myshopify.com', 'https://bandssz.github.io'];

const MONTA = `// Corpo vira um único parâmetro JSON; nada é interpolado no SQL.
const req = $json, b = req.body, h = req.headers || {};
if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('corpo invalido');
const PUBLICO = ['termo', 'enviar'], PAINEL = ['ler', 'print'];
if (![...PUBLICO, ...PAINEL].includes(b.acao)) throw new Error('acao invalida');
const txt = JSON.stringify(b);
if (txt.length > (b.acao === 'enviar' ? 12000000 : 4000)) throw new Error('corpo grande demais');
if (PAINEL.includes(b.acao)) return [{ json: { sql: 'SELECT public.crm_partner_candidatura_painel_v1($1::jsonb) AS r', args: [txt] } }];
const d = b.data && typeof b.data === 'object' ? b.data : {};
// Campo-isca preenchido ou envio rápido demais: robô. Responde como recusa genérica, sem gravar.
if (b.acao === 'enviar' && ((typeof d.website === 'string' && d.website.trim()) || !(Number(d.t_ms) >= 3000)))
  return [{ json: { sql: "SELECT jsonb_build_object('erro','Não foi possível enviar agora. Recarregue a página e tente de novo.') AS r", args: [] } }];
const ip = String(h['cf-connecting-ip'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || '').trim().slice(0, 64);
const corpo = { acao: b.acao, marca: b.marca, request_id: b.request_id, data: { ...d, website: undefined, t_ms: undefined }, ip, navegador: String(h['user-agent'] || '').slice(0, 300) };
return [{ json: { sql: 'SELECT public.crm_partner_candidatura_v1($1::jsonb) AS r', args: [JSON.stringify(corpo)] } }];`;

const origemExpr = `={{ (${JSON.stringify(ORIGENS)}).includes(($('POST candidatura').first().json.headers || {}).origin) ? $('POST candidatura').first().json.headers.origin : ${JSON.stringify(ORIGENS[0])} }}`;
const headers = () => ({ entries: [
  { name: 'Access-Control-Allow-Origin', value: origemExpr },
  { name: 'Vary', value: 'Origin' },
  { name: 'Access-Control-Allow-Headers', value: 'content-type' },
  { name: 'Content-Type', value: 'application/json' },
  { name: 'Cache-Control', value: 'no-store, private' },
  { name: 'Referrer-Policy', value: 'no-referrer' },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
] });

function buildWorkflow({ webhookPath }) {
  if (!/^parceiros-candidatura-[a-f0-9]{16}$/.test(webhookPath || '')) throw Error('caminho do webhook invalido');
  const nodes = [
    { name: 'POST candidatura', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: webhookPath,
      parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'responseNode', options: { allowedOrigins: ORIGENS.join(',') } } },
    { name: 'Monta SQL', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: MONTA } },
    { name: 'Executa', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [440, 0], credentials: { postgres: POSTGRES },
      parameters: { operation: 'executeQuery', query: '={{ $json.sql }}', options: { queryReplacement: '={{ $json.args }}' } } },
    { name: '200', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [660, 0],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.r || {erro:"sem resposta"}) }}', options: { responseHeaders: headers() } } },
  ];
  const connections = {
    'POST candidatura': { main: [[{ node: 'Monta SQL', type: 'main', index: 0 }]] },
    'Monta SQL': { main: [[{ node: 'Executa', type: 'main', index: 0 }]] },
    Executa: { main: [[{ node: '200', type: 'main', index: 0 }]] },
  };
  return { name: NAME, nodes, connections, settings: { timezone: 'America/Sao_Paulo', executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, callerPolicy: 'workflowsFromSameOwner' } };
}

module.exports = { NAME, MONTA, ORIGENS, buildWorkflow };
