'use strict';
// Workflow "Parceiros — aprovação (painel)" (28/09/2026). Chave de Influs; aprovar e envio pedem creators_edit.
//   ler      → parceiros aprovados (cupom, link, envio)
//   envio    → pendente / enviado + rastreio
//   aprovar  → preparar (SQL valida e reserva o código) → busca o código na Shopify da marca
//              → se não existe, cria (mesmo padrão dos cupons de influ) → concluir (SQL grava tudo numa transação)
// Repetir o mesmo request_id é seguro: se o cupom já foi criado, a busca acha e só confere a regra.
// Toda regra de negócio fica em partner-aprovacao.sql. Não guarda execução (tem dado pessoal).
const NAME = 'Parceiros — aprovação (painel: cupom + link + envio)';
const POSTGRES = { id: 'uALf0AHnEuLCgOtx', name: 'Postgres account 2' };
const SHOPS = {
  aristo: { host: 'gwx20u-vw.myshopify.com', credential: { id: 'CkOtCPF6b7FIyTjx', name: 'Shopify Admin — Aristocrata (header)' } },
  fish: { host: 'c0kfm1-qt.myshopify.com', credential: { id: 'Xv9XgNyJ1wyJFCTJ', name: 'Shopify Admin — Fishermans (header)' } },
};
const API_VERSION = '2026-07';
const ORIGEM = 'https://bandssz.github.io';
const MARCA_NOME = { aristo: 'O Aristocrata', fish: 'Fishermans' };

const BUSCA = `query($code:String!){ codeDiscountNodeByCode(code:$code){ id codeDiscount{ __typename
 ... on DiscountCodeBasic{ status combinesWith{orderDiscounts productDiscounts shippingDiscounts}
  customerGets{ value{ __typename ... on DiscountPercentage{percentage} } items{ __typename ... on AllDiscountItems{allItems} } } } } } }`;
const CRIA = `mutation($d:DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$d){ codeDiscountNode{ id } userErrors{ field code message } } }`;

const MONTA = `const b = $json.body;
if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('corpo invalido');
if (!['ler', 'aprovar', 'envio'].includes(b.acao)) throw new Error('acao invalida');
const txt = JSON.stringify(b);
if (txt.length > 4000) throw new Error('corpo grande demais');
const corpo = b.acao === 'aprovar' ? { k: b.k, acao: 'preparar', request_id: b.request_id, data: b.data } : b;
// k0: a chave segue só dentro do corpo das consultas ao banco, nunca para a Shopify.
return [{ json: { k0: b.k, etapa: b.acao, args: [JSON.stringify(corpo)] } }];`;

// Depois do preparar: segue para a Shopify só se preparou agora (não se já estava concluído).
const SEGUE = `={{ $('Monta').first().json.etapa === 'aprovar' && $json.r && $json.r.ok === true && !$json.r.repetido && !!$json.r.codigo }}`;

const DECIDE = `const prep = $('Executa').first().json.r, res = $json || {};
const MARCA = ${JSON.stringify(MARCA_NOME)};
const pct = v => (Math.round(Number(v) * 1000) / 10).toString().replace('.', ',') + '%';
const conclui = data => ({ json: { criar: false, args: [JSON.stringify({ k: $('Monta').first().json.k0, acao: 'concluir', request_id: prep.request_id, data })] } });
if (res.errors && res.errors.length) return [conclui({ erro: 'A Shopify não respondeu a busca do cupom. Tente de novo em instantes.' })];
const node = res.data && res.data.codeDiscountNodeByCode;
if (!node) return [{ json: { criar: true, prep } }];
const d = node.codeDiscount || {}, g = d.customerGets || {}, v = g.value || {}, it = g.items || {};
const bate = d.__typename === 'DiscountCodeBasic' && v.__typename === 'DiscountPercentage' && Math.abs(Number(v.percentage) - Number(prep.desconto)) < 1e-9 && it.allItems === true;
if (!bate) return [conclui({ erro: 'O cupom ' + prep.codigo + ' já existe na loja ' + MARCA[prep.marca] + ' com outra regra. Escolha outro código ou ajuste o cupom para ' + pct(prep.desconto) + ' em todos os produtos.', campo: 'codigo' })];
return [conclui({ node_id: node.id, origem: 'existente' })];`;

const CONFERE = `const prep = $('Decide').first().json.prep, res = $json || {};
const MARCA = ${JSON.stringify(MARCA_NOME)};
const pct = v => (Math.round(Number(v) * 1000) / 10).toString().replace('.', ',') + '%';
const conclui = data => ({ json: { args: [JSON.stringify({ k: $('Monta').first().json.k0, acao: 'concluir', request_id: prep.request_id, data })] } });
const negado = (res.errors || []).some(e => e && e.extensions && e.extensions.code === 'ACCESS_DENIED');
if (negado) return [conclui({ erro: 'A loja ' + MARCA[prep.marca] + ' ainda não deixa o sistema criar cupom. Crie o cupom ' + prep.codigo + ' na Shopify (' + pct(prep.desconto) + ' em todos os produtos, sem combinar com outros descontos) e clique em Aprovar de novo: o sistema confere e cadastra.', campo: 'codigo' })];
if (res.errors && res.errors.length) return [conclui({ erro: 'A Shopify recusou criar o cupom. Tente de novo em instantes.' })];
const out = (res.data && res.data.discountCodeBasicCreate) || {};
const ue = out.userErrors || [];
if (ue.length) return [conclui({ erro: 'Shopify: ' + ue.map(e => e.message).join(' ').slice(0, 300), campo: 'codigo' })];
if (!out.codeDiscountNode || !out.codeDiscountNode.id) return [conclui({ erro: 'A Shopify não confirmou o cupom. Clique em Aprovar de novo: se ele foi criado, o sistema acha e segue.' })];
return [conclui({ node_id: out.codeDiscountNode.id, origem: 'criado' })];`;

const corpoBusca = `={{ JSON.stringify({ query: ${JSON.stringify(BUSCA)}, variables: { code: $json.r.codigo } }) }}`;
const corpoCria = `={{ JSON.stringify({ query: ${JSON.stringify(CRIA)}, variables: { d: {
  title: $json.prep.codigo, code: $json.prep.codigo, startsAt: new Date().toISOString(), context: { all: 'ALL' },
  customerGets: { value: { percentage: Number($json.prep.desconto) }, items: { all: true }, appliesOnOneTimePurchase: true, appliesOnSubscription: false },
  combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false }, appliesOncePerCustomer: false } } }) }}`;

function buildWorkflow({ webhookPath }) {
  if (!/^parceiros-aprovacao-[a-f0-9]{16}$/.test(webhookPath || '')) throw Error('caminho do webhook invalido');
  const headers = { entries: [
    { name: 'Access-Control-Allow-Origin', value: ORIGEM }, { name: 'Access-Control-Allow-Headers', value: 'content-type' },
    { name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store, private' }, { name: 'X-Content-Type-Options', value: 'nosniff' }] };
  const pg = (name, pos) => ({ name, type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: pos, credentials: { postgres: POSTGRES },
    parameters: { operation: 'executeQuery', query: 'SELECT public.crm_partner_aprovacao_v1($1::jsonb) AS r', options: { queryReplacement: '={{ $json.args }}' } } });
  const ifNode = (name, pos, expr) => ({ name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: require('node:crypto').createHash('md5').update(name).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } });
  const shop = (name, marca, body, pos) => ({ name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: { httpHeaderAuth: SHOPS[marca].credential },
    parameters: { method: 'POST', url: `https://${SHOPS[marca].host}/admin/api/${API_VERSION}/graphql.json`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, specifyBody: 'json', jsonBody: body, options: { response: { response: { neverError: true } }, timeout: 20000 } } });
  const code = (name, js, pos) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { jsCode: js } });
  const respond = (name, pos) => ({ name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: pos,
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.r || {erro:"sem resposta"}) }}', options: { responseHeaders: headers } } });
  const nodes = [
    { name: 'POST aprovação', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: webhookPath,
      parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'responseNode', options: { allowedOrigins: ORIGEM } } },
    code('Monta', MONTA, [200, 0]),
    pg('Executa', [400, 0]),
    ifNode('Vai à Shopify?', [600, 0], SEGUE),
    respond('Responde', [800, 160]),
    ifNode('Busca: Aristo?', [800, -120], `={{ $json.r.marca === 'aristo' }}`),
    shop('Busca Aristo', 'aristo', corpoBusca, [1000, -200]),
    shop('Busca Fish', 'fish', corpoBusca, [1000, -40]),
    code('Decide', DECIDE, [1200, -120]),
    ifNode('Criar?', [1400, -120], '={{ $json.criar === true }}'),
    ifNode('Cria: Aristo?', [1600, -200], `={{ $json.prep.marca === 'aristo' }}`),
    shop('Cria Aristo', 'aristo', corpoCria, [1800, -280]),
    shop('Cria Fish', 'fish', corpoCria, [1800, -120]),
    code('Confere', CONFERE, [2000, -200]),
    pg('Conclui', [2200, -40]),
    respond('Responde aprovação', [2400, -40]),
  ];
  const m = (a, ...b) => ({ [a]: { main: b.map(x => x ? [{ node: x, type: 'main', index: 0 }] : []) } });
  const connections = {
    ...m('POST aprovação', 'Monta'), ...m('Monta', 'Executa'), ...m('Executa', 'Vai à Shopify?'),
    ...m('Vai à Shopify?', 'Busca: Aristo?', 'Responde'),
    ...m('Busca: Aristo?', 'Busca Aristo', 'Busca Fish'), ...m('Busca Aristo', 'Decide'), ...m('Busca Fish', 'Decide'),
    ...m('Decide', 'Criar?'), ...m('Criar?', 'Cria: Aristo?', 'Conclui'),
    ...m('Cria: Aristo?', 'Cria Aristo', 'Cria Fish'), ...m('Cria Aristo', 'Confere'), ...m('Cria Fish', 'Confere'),
    ...m('Confere', 'Conclui'), ...m('Conclui', 'Responde aprovação'),
  };
  return { name: NAME, nodes, connections,
    settings: { timezone: 'America/Sao_Paulo', executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, callerPolicy: 'workflowsFromSameOwner' } };
}
module.exports = { NAME, SHOPS, API_VERSION, BUSCA, CRIA, MONTA, DECIDE, CONFERE, buildWorkflow };
