'use strict';
// Sender da cobrança com as guardas v2 (26/09/2026). Troca o miolo do workflow 37W8obVhxFccuHgv
// ("TikTok Shop - Cobrança de conteúdo") a partir de um export FRESCO; o envio legado some do workflow.
//
// Fluxo, uma pessoa por volta do loop (cada passo de banco é um node PostgreSQL próprio, que confirma a
// transação antes do passo seguinte):
//   Prepara fila (SQL)  crm_tts_cobranca_prepara_v2  revisões do dia a partir do modelo aprovado
//   Simula (SQL)        crm_tts_cobranca_simulate_v2  quando a marca está em simulação: nada vai para a TikTok
//   Reserva (SQL)       crm_tts_cobranca_reserva_v2   claim_v2 + disjuntor da marca
//   Conversa            abre e lê a conversa inteira (paginada) e decide com evaluateConversation
//   Conclui (SQL)       crm_tts_cobranca_conclui_v2   bloqueado/incerto antes do transporte, ou aceito/incerto depois
//   Libera envio (SQL)  crm_tts_cobranca_dispatch_v2  em_transporte gravado ANTES da chamada de envio
//   Envia               POST da mensagem com o texto que veio da reserva; sem nova tentativa
// Erro de banco em qualquer passo para o workflow: a reserva fica como está e impede repetição.
//
// A assinatura TikTok (chave do app, segredo, cipher das lojas, `chamar`) é reaproveitada do node legado
// do próprio workflow, sem sair do servidor. O arquivo gerado nunca vai para o repositório.
const { evaluateOpening, evaluateConversation } = require('./cobranca-safety.cjs');

const WORKFLOW_ID = '37W8obVhxFccuHgv';
const KEEP = ['Dias úteis 13h20', 'POST cobranca', 'Valida chave', 'Pegar tokens (Token Manager)'];
const LEGACY = 'Cobra (dry_run até a regra dizer ativo)';
const BOUNDARY = 'const alvos = $input.all()';
const NAME = 'TikTok Shop - Cobrança de conteúdo (guardas v2 · modelo aprovado · envia só com a regra em ativo)';
const PAGE = 20, MAX_PAGES = 10;

const helpersSource = [
  "const nonempty=v=>typeof v==='string'&&v.trim().length>0;",
  "const id=v=>nonempty(v)?v:(typeof v==='number'&&Number.isSafeInteger(v)?String(v):null);",
  "const blocked=reason=>({allowed:false,reason});",
  evaluateOpening.toString(),
  evaluateConversation.toString(),
].join('\n');

const FILA = `// Uma linha por pessoa escolhida para hoje. Sem ninguém, segue um item vazio só para fechar a execução.
const xs = $input.all().map(i => i.json).filter(j => j && typeof j.review_id === 'string' && j.review_id);
if (!xs.length) return [{ json: { _route: 'vazio' } }];
return xs.map(j => ({ json: { review_id: j.review_id, dono: j.dono, marca: j.marca, etapa: j.etapa, username: j.username,
  tentativa: j.tentativa, ciente_ate: j.ciente_ate || null, _route: j.simular === true ? 'simula' : 'envia' } }));`;

const conversa = prefix => `${prefix}
${helpersSource}
const PAGE = ${PAGE}, MAX_PAGES = ${MAX_PAGES};
const espera = ms => new Promise(s => setTimeout(s, ms));
// Lê a conversa até o fim. Cobertura completa só quando a última página não traz próxima página e veio incompleta
// (menos de PAGE mensagens) ou declara has_more=false. Qualquer dúvida vira histórico incompleto, que bloqueia.
async function lerTudo(marca, conv) {
  const todas = []; let token = '';
  for (let pagina = 1; pagina <= MAX_PAGES; pagina++) {
    const q = 'page_size=' + PAGE + (token ? '&page_token=' + encodeURIComponent(token) : '');
    const r = await chamar(marca, 'GET', '/affiliate_seller/202412/conversation/' + encodeURIComponent(conv) + '/messages?' + q);
    if (!r || r.code !== 0 || !r.data || !Array.isArray(r.data.messages)) return r;
    todas.push(...r.data.messages);
    const prox = typeof r.data.next_page_token === 'string' ? r.data.next_page_token : '';
    if (!prox) return { code: 0, data: { messages: todas }, coverage: { complete: r.data.messages.length < PAGE || r.data.has_more === false, conversation_id: conv } };
    token = prox; await espera(300);
  }
  return { code: 0, data: { messages: todas }, coverage: { complete: false, conversation_id: conv } };
}
// Trecho da última mensagem, para a lista "Responderam" do painel.
function detalhe(open, read) {
  const c = (open && open.data) || {}, msgs = (read && read.data && Array.isArray(read.data.messages) ? read.data.messages : [])
    .map(m => m && m.message_body).filter(b => b && (typeof b.create_time === 'number' || /^\\d+(\\.\\d+)?$/.test(String(b.create_time || ''))))
    .sort((a, b) => Number(b.create_time) - Number(a.create_time));
  const u = msgs[0]; let texto = '';
  if (u) { try { texto = String(JSON.parse(u.content || '{}').content || u.type); } catch (_) { texto = String(u.type || ''); } }
  return { conversation_id: id(c.conversation_id), creator_im_id: id(c.creator_im_id), nao_lidas: Number.isInteger(c.unread_count) ? c.unread_count : 0,
    ultima_msg_em: u ? String(u.create_time) : null, ultima_msg_de: u ? (id(u.sender_id) === id(c.creator_im_id) ? 'criador' : 'loja') : null, ultimo_texto: texto.slice(0, 160) };
}
const out = [];
for (const it of $input.all()) {
  const claim = it.json.result, ctx = it.json.ctx || {};
  const base = { review_id: ctx.review_id, dono: ctx.dono, marca: ctx.marca, etapa: ctx.etapa, username: ctx.username, tentativa: ctx.tentativa };
  if (!claim || claim.allowed !== true) { out.push({ json: { ...base, _route: 'fim', estado: 'nao_reservado', motivo: (claim && claim.reason) || 'reserva_sem_resposta' } }); continue; }
  const conclui = (estado, motivo, det) => ({ json: { ...base, _route: 'conclui', estado, motivo, message_id: '', detalhe: det ? JSON.stringify(det) : '' } });
  if (claim.review_id !== ctx.review_id || claim.owner !== ctx.dono || claim.state !== 'reservado'
    || ![claim.brand, claim.username, claim.creator_open_id, claim.reference, claim.text].every(nonempty)
    || !['amostra_sem_video', 'vitrine_sem_video'].includes(claim.stage) || !Number.isInteger(claim.attempt) || claim.attempt < 1
    || claim.brand !== ctx.marca) { out.push(conclui('bloqueado', 'reserva_payload_invalido')); continue; }
  const ciente = ctx.ciente_ate ? Date.parse(ctx.ciente_ate) : NaN;
  const identity = { username: claim.username, creator_ack_until_ms: Number.isFinite(ciente) ? ciente : null };
  let open, read, opening;
  try {
    open = await chamar(claim.brand, 'POST', '/affiliate_seller/202508/conversations', { creator_open_id: claim.creator_open_id, only_need_conversation_id: false });
    opening = evaluateOpening(open, identity);
    // Não lidas bloqueiam, mas vale ler para mostrar à Marcela o que ficou sem resposta.
    if (!opening.allowed && opening.reason !== 'im_nao_lidas') { out.push(conclui('bloqueado', opening.reason)); continue; }
    read = await lerTudo(claim.brand, id(open.data.conversation_id));
  } catch (e) { out.push(conclui('incerto', 'preflight_resultado_incerto')); continue; }
  const decision = opening.allowed ? evaluateConversation(open, read, identity, Date.now()) : opening;
  if (!decision.allowed) { out.push(conclui('bloqueado', decision.reason, detalhe(open, read))); continue; }
  out.push({ json: { ...base, _route: 'libera', conversation_id: decision.conversation_id, texto: claim.text } });
  await espera(400);
}
return out;`;

const envia = prefix => `${prefix}
const espera = ms => new Promise(s => setTimeout(s, ms));
const out = [];
for (const it of $input.all()) {
  const d = it.json.result, ctx = it.json.ctx || {};
  const base = { review_id: ctx.review_id, dono: ctx.dono, marca: ctx.marca, etapa: ctx.etapa, username: ctx.username, tentativa: ctx.tentativa };
  if (!d || typeof d.allowed !== 'boolean') { out.push({ json: { ...base, _route: 'fim', estado: 'incerto', motivo: 'reserva_preservada_dispatch_sem_confirmacao' } }); continue; }
  if (d.allowed !== true) { out.push({ json: { ...base, _route: 'fim', estado: 'bloqueado', motivo: d.reason || 'dispatch_recusado' } }); continue; }
  if (d.state !== 'em_transporte' || d.review_id !== ctx.review_id || d.owner !== ctx.dono || typeof ctx.texto !== 'string' || !ctx.texto.trim() || !ctx.conversation_id) {
    out.push({ json: { ...base, _route: 'fim', estado: 'incerto', motivo: 'reserva_preservada_dispatch_sem_confirmacao' } }); continue; }
  // em_transporte já está gravado. Daqui em diante nada é repetido: sem aceite claro, fica incerto.
  let estado = 'incerto', motivo = 'transporte_resultado_incerto', mid = '';
  try {
    const r = await chamar(ctx.marca, 'POST', '/affiliate_seller/202412/conversations/' + encodeURIComponent(ctx.conversation_id) + '/messages',
      { msg_type: 'TEXT', content: JSON.stringify({ content: ctx.texto }) });
    if (r && r.code === 0) { estado = 'aceito'; motivo = 'api_aceitou'; mid = r.data && r.data.message_id != null ? String(r.data.message_id) : ''; }
    else motivo = 'transporte_sem_aceite_confirmado';
  } catch (e) { motivo = 'transporte_resultado_incerto'; }
  out.push({ json: { ...base, _route: 'conclui', estado, motivo, message_id: mid, detalhe: '' } });
  await espera(900);   // a API limita QPS, e isto fala com gente: devagar
}
return out;`;

const RESULTADO = `return $input.all().map(i => { const j = i.json || {}, c = j.ctx || {};
  const r = j.result || {};
  return { json: { marca: j.marca || c.marca || null, username: j.username || c.username || null, etapa: j.etapa || c.etapa || null,
    tentativa: j.tentativa || c.tentativa || null, estado: j.estado || (r.simulated ? 'simulado' : (r.state || null)) || (j._route === 'vazio' ? 'vazio' : null),
    motivo: j.motivo || r.reason || null, gravado: r.recorded === undefined ? null : r.recorded } }; });`;

const RESUMO = `const xs = $input.all().map(i => i.json).filter(j => j && j.estado && j.estado !== 'vazio');
const por = {}; for (const x of xs) { const k = (x.marca || '?') + ':' + x.estado; por[k] = (por[k] || 0) + 1; }
return [{ json: { pessoas: xs.length, por_estado: por, detalhes: xs.slice(0, 80) } }];`;

function ensure(ok, msg) { if (!ok) throw Error(msg); }

function signingPrefix(fresh) {
  const legacy = fresh.nodes.filter(n => n.name === LEGACY);
  ensure(legacy.length === 1 && legacy[0].type === 'n8n-nodes-base.code', 'node legado de envio ausente');
  const code = legacy[0].parameters.jsCode;
  ensure(code.split(BOUNDARY).length === 2, 'fronteira do node legado mudou');
  const prefix = code.split(BOUNDARY)[0];
  ensure(prefix.includes('async function chamar(') && prefix.includes('function assinar(') && prefix.includes("const BASE = 'https://open-api.tiktokglobalshop.com'")
    && prefix.includes("$('Pegar tokens (Token Manager)').all()") && prefix.includes('const helpers = this.helpers;'), 'prefixo de assinatura mudou');
  ensure(!/const APP_SECRET = '__SERVER_ONLY_/.test(prefix), 'segredo não configurado no servidor');
  return prefix;
}

function buildSender(fresh, { expectedVersionId } = {}) {
  ensure(fresh && fresh.id === WORKFLOW_ID, 'workflow errado');
  ensure(expectedVersionId && fresh.versionId === expectedVersionId && fresh.activeVersionId === expectedVersionId, 'export fresco e ativo esperado');
  for (const k of KEEP) ensure(fresh.nodes.filter(n => n.name === k).length === 1, 'node ausente: ' + k);
  const prefix = signingPrefix(fresh);
  const pg = fresh.nodes.find(n => n.name === 'Grava log').credentials;
  ensure(pg && pg.postgres && pg.postgres.id, 'credencial PostgreSQL ausente');
  const nodes = fresh.nodes.filter(n => KEEP.includes(n.name)).map(n => JSON.parse(JSON.stringify(n)));
  const connections = {};
  let seq = 0;
  const add = (name, type, parameters, extra = {}) => {
    ensure(!nodes.some(n => n.name === name), 'node duplicado: ' + name);
    const typeVersion = { code: 2, postgres: 2.4, switch: 3.2, splitInBatches: 3, respondToWebhook: 1 }[type];
    nodes.push({ id: 'cob-v2-' + (++seq), name, type: 'n8n-nodes-base.' + type, typeVersion, position: [(seq % 7) * 260, 400 + Math.floor(seq / 7) * 220], parameters, ...extra });
    return name;
  };
  const link = (from, to, index = 0) => { const c = connections[from] || (connections[from] = { main: [] }); while (c.main.length <= index) c.main.push([]); c.main[index].push({ node: to, type: 'main', index: 0 }); };
  const sql = (name, query, args) => add(name, 'postgres', { operation: 'executeQuery', query, options: { queryReplacement: args } }, { credentials: JSON.parse(JSON.stringify(pg)) });
  const route = (name, values) => add(name, 'switch', { rules: { values: values.map(v => ({ conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
    conditions: [{ leftValue: '={{ $json._route }}', rightValue: v, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: v })) }, options: {} });

  add('Uma vez', 'code', { jsCode: "// O Token Manager devolve uma linha por loja; a fila é montada uma vez só.\nreturn [{ json: {} }];" });
  sql('Prepara fila (SQL)', 'SELECT * FROM public.crm_tts_cobranca_prepara_v2(gen_random_uuid())', '');
  nodes[nodes.length - 1].alwaysOutputData = true;
  delete nodes[nodes.length - 1].parameters.options.queryReplacement;
  add('Fila', 'code', { jsCode: FILA });
  add('Loop', 'splitInBatches', { batchSize: 1, options: {} });
  route('Tipo', ['simula', 'envia', 'vazio']);
  sql('Simula (SQL)', 'SELECT public.crm_tts_cobranca_simulate_v2($1) AS result, $2::jsonb AS ctx', '={{ [$json.review_id, JSON.stringify($json)] }}');
  sql('Reserva (SQL)', 'SELECT public.crm_tts_cobranca_reserva_v2($1,$2::uuid) AS result, $3::jsonb AS ctx', '={{ [$json.review_id, $json.dono, JSON.stringify($json)] }}');
  add('Conversa', 'code', { jsCode: conversa(prefix) });
  route('Depois da conversa', ['conclui', 'libera', 'fim']);
  sql('Libera envio (SQL)', 'SELECT public.crm_tts_cobranca_dispatch_v2($1,$2::uuid) AS result, $3::jsonb AS ctx', '={{ [$json.review_id, $json.dono, JSON.stringify($json)] }}');
  add('Envia', 'code', { jsCode: envia(prefix) });
  route('Depois do envio', ['conclui', 'fim']);
  sql('Conclui (SQL)', "SELECT public.crm_tts_cobranca_conclui_v2($1,$2::uuid,$3,$4,nullif($5,''),nullif($6,'')::jsonb) AS result, $7::jsonb AS ctx",
    "={{ [$json.review_id, $json.dono, $json.estado, $json.motivo, $json.message_id || '', $json.detalhe || '', JSON.stringify($json)] }}");
  add('Resultado', 'code', { jsCode: RESULTADO });
  add('Resumo', 'code', { jsCode: RESUMO });
  add('200', 'respondToWebhook', { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} });

  link('Dias úteis 13h20', 'Pegar tokens (Token Manager)');
  link('POST cobranca', 'Valida chave');
  link('Valida chave', 'Pegar tokens (Token Manager)');
  link('Pegar tokens (Token Manager)', 'Uma vez');
  link('Uma vez', 'Prepara fila (SQL)');
  link('Prepara fila (SQL)', 'Fila');
  link('Fila', 'Loop');
  link('Loop', 'Resumo', 0);
  link('Loop', 'Tipo', 1);
  link('Tipo', 'Simula (SQL)', 0); link('Tipo', 'Reserva (SQL)', 1); link('Tipo', 'Resultado', 2);
  link('Simula (SQL)', 'Resultado');
  link('Reserva (SQL)', 'Conversa');
  link('Conversa', 'Depois da conversa');
  link('Depois da conversa', 'Conclui (SQL)', 0); link('Depois da conversa', 'Libera envio (SQL)', 1); link('Depois da conversa', 'Resultado', 2);
  link('Libera envio (SQL)', 'Envia');
  link('Envia', 'Depois do envio');
  link('Depois do envio', 'Conclui (SQL)', 0); link('Depois do envio', 'Resultado', 1);
  link('Conclui (SQL)', 'Resultado');
  link('Resultado', 'Loop');
  link('Resumo', '200');

  const settings = { ...fresh.settings };
  delete settings.availableInMCP;
  return { name: NAME, nodes, connections, settings };
}

module.exports = { WORKFLOW_ID, KEEP, LEGACY, BOUNDARY, NAME, FILA, RESULTADO, RESUMO, conversa, envia, signingPrefix, buildSender };
