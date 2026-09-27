'use strict';
// Escopo dos creators (27/09/2026): dois workflows.
//  coleta  — diário 06:10: lista as contas do Instagram das marcas e lê GET /{ig}/tags (reels e posts em que alguém
//            marcou a conta da marca). Grava em crm_influ_conteudo_v1 casando pelo @ do creator. Só leitura na Meta.
//  painel  — POST com a chave de Influs: ler, escopo_salvar, conteudo_marcar (story à mão), conteudo_ignorar.
const POSTGRES = { id: 'uALf0AHnEuLCgOtx', name: 'Postgres account 2' };
const META = { id: '4GdnUtcDaMLS0am5', name: 'Meta WA — token permanente (Bearer)' };
const CONTAS = { 'oaristocrata.br': 'aristo', oaristocratareserva: 'aristo', 'fishermans.com.br': 'fish', fishermansreserva: 'fish' };
const ORIGEM = 'https://bandssz.github.io';
const G = 'https://graph.facebook.com/v22.0';

const SEPARA = `const CONTAS = ${JSON.stringify(CONTAS)};
return ($json.data || []).map(p => p.instagram_business_account).filter(ig => ig && CONTAS[ig.username])
  .map(ig => ({ json: { id: ig.id, conta: ig.username, marca: CONTAS[ig.username] } }));`;
const MONTA_COLETA = `const contas = $('Separa contas').all().map(i => i.json);
return $input.all().map((it, k) => ({ json: { args: [JSON.stringify({ marca: contas[k].marca, conta: contas[k].conta,
  midias: Array.isArray(it.json && it.json.data) ? it.json.data : [] })] } }));`;

function buildColeta() {
  const http = (name, url, pos) => ({ name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: { httpHeaderAuth: META },
    parameters: { url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {} } });
  const nodes = [
    { name: 'Diário 06:10', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '10 6 * * *' }] } } },
    http('Contas', `${G}/me/accounts?fields=instagram_business_account{id,username}&limit=50`, [220, 0]),
    { name: 'Separa contas', type: 'n8n-nodes-base.code', typeVersion: 2, position: [440, 0], parameters: { jsCode: SEPARA } },
    http('Marcações', `=${G}/{{ $json.id }}/tags?fields=id,media_type,media_product_type,timestamp,username,permalink,thumbnail_url,media_url&limit=50`, [660, 0]),
    { name: 'Monta', type: 'n8n-nodes-base.code', typeVersion: 2, position: [880, 0], parameters: { jsCode: MONTA_COLETA } },
    { name: 'Grava', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1100, 0], credentials: { postgres: POSTGRES },
      parameters: { operation: 'executeQuery', query: 'SELECT public.crm_influ_conteudo_ingest_v1($1::jsonb) AS r', options: { queryReplacement: '={{ $json.args }}' } } },
  ];
  const c = (a, b) => ({ [a]: { main: [[{ node: b, type: 'main', index: 0 }]] } });
  return { name: 'Influs — escopo · marcações no Instagram (diário 06:10)', nodes,
    connections: { ...c('Diário 06:10', 'Contas'), ...c('Contas', 'Separa contas'), ...c('Separa contas', 'Marcações'), ...c('Marcações', 'Monta'), ...c('Monta', 'Grava') },
    settings: { timezone: 'America/Sao_Paulo', executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', callerPolicy: 'workflowsFromSameOwner' } };
}

const MONTA_PAINEL = `const b = $json.body;
if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('corpo invalido');
if (!['ler', 'escopo_salvar', 'vincular', 'conteudo_marcar', 'conteudo_ignorar'].includes(b.acao)) throw new Error('acao invalida');
const txt = JSON.stringify(b);
if (txt.length > 4000) throw new Error('corpo grande demais');
return [{ json: { sql: 'SELECT public.crm_influ_escopo_painel_v1($1::jsonb) AS r', args: [txt] } }];`;
function buildPainel({ webhookPath }) {
  if (!/^influs-escopo-[a-f0-9]{16}$/.test(webhookPath || '')) throw Error('caminho do webhook invalido');
  const headers = { entries: [
    { name: 'Access-Control-Allow-Origin', value: ORIGEM }, { name: 'Access-Control-Allow-Headers', value: 'content-type' },
    { name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store, private' }, { name: 'X-Content-Type-Options', value: 'nosniff' }] };
  const nodes = [
    { name: 'POST escopo', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: webhookPath, parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'responseNode', options: {} } },
    { name: 'Monta SQL', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: MONTA_PAINEL } },
    { name: 'Executa', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [440, 0], credentials: { postgres: POSTGRES },
      parameters: { operation: 'executeQuery', query: '={{ $json.sql }}', options: { queryReplacement: '={{ $json.args }}' } } },
    { name: '200', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [660, 0],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.r || {erro:"sem resposta"}) }}', options: { responseHeaders: headers } } },
  ];
  const c = (a, b) => ({ [a]: { main: [[{ node: b, type: 'main', index: 0 }]] } });
  return { name: 'Influs — escopo (painel, chave de Influs)', nodes, connections: { ...c('POST escopo', 'Monta SQL'), ...c('Monta SQL', 'Executa'), ...c('Executa', '200') },
    settings: { timezone: 'America/Sao_Paulo', executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', callerPolicy: 'workflowsFromSameOwner' } };
}
module.exports = { CONTAS, SEPARA, MONTA_COLETA, MONTA_PAINEL, buildColeta, buildPainel };
