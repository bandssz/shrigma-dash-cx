'use strict';
// Workflow "Orgânico — Links UTM (POST)": listar, salvar e arquivar links do registro.
// A regra inteira (chave, validação, montagem do link) mora em organico_link_utm_v1 (links-utm.sql);
// o workflow só repassa o corpo como parâmetro nativo do PostgreSQL e devolve a resposta com CORS do painel.
const NAME = 'Orgânico — Links UTM (POST, chave do painel)';
const POSTGRES = { id: 'uALf0AHnEuLCgOtx', name: 'Postgres account 2' };
const ORIGEM = 'https://bandssz.github.io';

const MONTA = `// Corpo vira um único parâmetro JSON; nada é interpolado no SQL.
const b = $json.body;
if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('corpo invalido');
const txt = JSON.stringify(b);
if (txt.length > 4000) throw new Error('corpo grande demais');
if (!['listar', 'salvar', 'arquivar'].includes(b.acao)) throw new Error('acao invalida');
return [{ json: { sql: 'SELECT public.organico_link_utm_v1($1::jsonb) AS r', args: [txt] } }];`;

const headers = () => ({ entries: [
  { name: 'Access-Control-Allow-Origin', value: ORIGEM },
  { name: 'Access-Control-Allow-Headers', value: 'content-type' },
  { name: 'Content-Type', value: 'application/json' },
  { name: 'Cache-Control', value: 'no-store, private' },
  { name: 'Referrer-Policy', value: 'no-referrer' },
  { name: 'X-Content-Type-Options', value: 'nosniff' },
] });

function buildWorkflow({ webhookPath }) {
  if (!/^organico-links-utm-[a-f0-9]{8,}$/.test(webhookPath || '')) throw Error('caminho do webhook invalido');
  const nodes = [
    { name: 'POST links', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: webhookPath,
      parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'responseNode', options: {} } },
    { name: 'Monta SQL', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: MONTA } },
    { name: 'Executa', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [440, 0], credentials: { postgres: POSTGRES },
      parameters: { operation: 'executeQuery', query: '={{ $json.sql }}', options: { queryReplacement: '={{ $json.args }}' } } },
    { name: '200', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [660, 0],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.r || {erro:"sem resposta"}) }}', options: { responseHeaders: headers() } } },
  ];
  const connections = {
    'POST links': { main: [[{ node: 'Monta SQL', type: 'main', index: 0 }]] },
    'Monta SQL': { main: [[{ node: 'Executa', type: 'main', index: 0 }]] },
    Executa: { main: [[{ node: '200', type: 'main', index: 0 }]] },
  };
  return { name: NAME, nodes, connections, settings: { timezone: 'America/Sao_Paulo', executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', callerPolicy: 'workflowsFromSameOwner' } };
}

module.exports = { NAME, MONTA, buildWorkflow };
