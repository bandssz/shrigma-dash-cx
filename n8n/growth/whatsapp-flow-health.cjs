'use strict';

// Local deployment generator. Never calls n8n, SQL, Meta or ClickUp.
const { createHash } = require('node:crypto');
const WORKFLOW_ID = 'GXg7nONpRxwlQmas';
const MARKER = 'WA_FLOW_HEALTH_COHORTS_V1';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const fail = code => { throw new Error(code); };
function replaceOnce(text, before, after, code) {
  if (text.split(before).length !== 2) fail(code);
  return text.replace(before, after);
}

// These fragments are the reviewed query contract, not an old workflow export.
const ORIGINAL_ACCEPTANCE = `ace as (
  select l.brand, count(*)::int as n_aceites,
         count(*) filter (where exists (select 1 from shrigma_wa_status s where s.wamid=l.wamid))::int as n_status,
         count(*) filter (where exists (select 1 from shrigma_wa_status s where s.wamid=l.wamid and s.status='failed'))::int as n_falhas
  from shrigma_send_log l
  where l.channel='whatsapp' and l.brand in ('fish','aristo') and l.wamid is not null
    and l.sent_at between now() - interval '75 minutes' and now() - interval '15 minutes'
  group by 1),`;

const COHORT_ACCEPTANCE = `ace_cohort as (
  -- ${MARKER}: the existing explicit QA flow is the only exclusion.
  -- No mode is inferred: shrigma_send_log has no modo column.
  select l.brand, case when l.flow='teste-motor' then 'qa' else 'operacional' end as cohort,
         count(*)::int as n_aceites,
         count(*) filter (where exists (select 1 from shrigma_wa_status s where s.wamid=l.wamid))::int as n_status,
         count(*) filter (where exists (select 1 from shrigma_wa_status s where s.wamid=l.wamid and s.status='failed'))::int as n_falhas
  from shrigma_send_log l
  where l.channel='whatsapp' and l.brand in ('fish','aristo') and l.wamid is not null
    and l.sent_at between now() - interval '75 minutes' and now() - interval '15 minutes'
  group by 1,2),
ace as (
  -- Emit an explicit empty window; never leave an old QA alert looking current.
  -- Zero observed acceptances does not establish zero failures or healthy delivery.
  select b.brand, c.cohort, coalesce(a.n_aceites,0)::int as n_aceites,
         a.n_status, a.n_falhas
  from (values ('fish'),('aristo')) b(brand)
  cross join (values ('operacional'),('qa')) c(cohort)
  left join ace_cohort a on a.brand=b.brand and a.cohort=c.cohort),`;

const ORIGINAL_ROWS = `  select 'aceite:'||brand, brand, 'Aceite → status Meta · '||brand||' · transacional', null, null, n_aceites, n_status, n_falhas,
         case when n_aceites >= 5 and n_status = 0 then 'alerta'
              when n_aceites >= 10 and n_falhas::numeric / n_aceites > 0.2 then 'alerta' else 'ok' end,
         case when n_aceites >= 5 and n_status = 0 then n_aceites||' aceites (wamid) na última hora e nenhum status recebido da Meta'
              when n_aceites >= 10 and n_falhas::numeric / n_aceites > 0.2 then n_falhas||' falhas em '||n_aceites||' aceites ('||round(100*n_falhas::numeric/n_aceites)||'%)' end
  from ace),`;

const COHORT_ROWS = `  select case when cohort='qa' then 'qa:aceite:' else 'aceite:' end||brand, brand,
         'Aceite → status Meta · '||brand||case when cohort='qa' then ' · QA (teste-motor)' else ' · operacional (exceto teste-motor)' end,
         null, null, n_aceites, n_status, n_falhas,
         case when n_aceites = 0 then 'desconhecido'
              when n_aceites >= 5 and n_status = 0 then 'alerta'
              when n_aceites >= 10 and n_falhas::numeric / n_aceites > 0.2 then 'alerta' else 'ok' end,
         concat_ws(' | ',
           case when n_aceites = 0 then 'Sem aceites observados na janela de 75 a 15 minutos; entrega não avaliada'
                when n_aceites >= 5 and n_status = 0 then n_aceites||' aceites (wamid) na janela de 75 a 15 minutos e nenhum status recebido da Meta'
                when n_aceites >= 10 and n_falhas::numeric / n_aceites > 0.2 then n_falhas||' falhas em '||n_aceites||' aceites ('||round(100*n_falhas::numeric/n_aceites)||'%)' end,
           case when cohort='qa' then 'QA identificado pelo flow teste-motor; falhas preservadas, sem alerta operacional'
                else 'Demais flows, incluindo Marketing e flow não informado; modo de envio não inferido' end)
  from ace),`;

function patchQuery(query) {
  if (typeof query !== 'string' || query.includes(MARKER)) fail('HEALTH_QUERY_ALREADY_PATCHED_OR_INVALID');
  let result = replaceOnce(query, ORIGINAL_ACCEPTANCE, COHORT_ACCEPTANCE, 'HEALTH_ACCEPTANCE_SOURCE_DRIFT');
  result = replaceOnce(result, ORIGINAL_ROWS, COHORT_ROWS, 'HEALTH_ROWS_SOURCE_DRIFT');
  result = replaceOnce(result, '  on conflict (chave) do update set\n    verificado_em=excluded.verificado_em,',
    '  on conflict (chave) do update set\n    nome=excluded.nome, verificado_em=excluded.verificado_em,', 'HEALTH_UPSERT_SOURCE_DRIFT');
  return result;
}

function configQuery(source) {
  const matches = [...source.matchAll(/\bconst\s+sql\s*=\s*("(?:[^"\\]|\\.)*")/g)];
  if (matches.length !== 1) fail('HEALTH_CONFIG_SQL_LITERAL_REQUIRED');
  return { match: matches[0], query: JSON.parse(matches[0][1]) };
}

function patchConfig(source) {
  const { match, query } = configQuery(source);
  const offset = match.index + match[0].indexOf(match[1]);
  return source.slice(0, offset) + JSON.stringify(patchQuery(query)) + source.slice(offset + match[1].length);
}

function patchDecision(source) {
  if (source.includes(MARKER)) fail('HEALTH_DECISION_ALREADY_PATCHED');
  // Keep transition/cooldown/test-mode rules; QA is visible without creating an
  // operational ClickUp task. No existing task is closed, edited or deleted.
  return replaceOnce(source,
    "const disparar = r.estado === 'alerta' && (r.estado_antigo !== 'alerta' || repetir) && !teste;",
    `// ${MARKER}: only the explicit QA key is exempt from operational notification.\nconst qa = /^qa:aceite:(?:fish|aristo)$/.test(r.chave);\nconst disparar = r.estado === 'alerta' && (r.estado_antigo !== 'alerta' || repetir) && !teste && !qa;`,
    'HEALTH_DECISION_SOURCE_DRIFT');
}

function patchWorkflow(fresh, expected) {
  if (!fresh || fresh.id !== WORKFLOW_ID || fresh.active !== true || !expected?.versionId ||
      fresh.versionId !== expected.versionId || fresh.activeVersionId !== expected.versionId) fail('HEALTH_VERSION_DRIFT');
  const active = fresh.activeVersion;
  if (!active || active.workflowId !== WORKFLOW_ID || active.versionId !== expected.versionId ||
      JSON.stringify(active.nodes) !== JSON.stringify(fresh.nodes) ||
      JSON.stringify(active.connections) !== JSON.stringify(fresh.connections)) fail('HEALTH_ACTIVE_CONTENT_UNPROVEN');
  const out = structuredClone(fresh), changed = [];
  for (const [name, transform, key] of [['Config', patchConfig, 'configSha256'], ['Decide alerta', patchDecision, 'decisionSha256']]) {
    const nodes = out.nodes.filter(n => n.name === name);
    if (nodes.length !== 1 || nodes[0].type !== 'n8n-nodes-base.code') fail('HEALTH_NODE_IDENTITY_DRIFT');
    const node = nodes[0], before = node.parameters.jsCode;
    if (!/^[a-f0-9]{64}$/.test(expected[key] || '') || sha256(before) !== expected[key]) fail('HEALTH_NODE_SOURCE_DRIFT');
    node.parameters.jsCode = transform(before);
    changed.push({ name, beforeSha256: sha256(before), afterSha256: sha256(node.parameters.jsCode) });
  }
  // This is a candidate only. activeVersion intentionally remains the actual
  // unmodified readback, never a fabricated claim that the candidate is active.
  return { workflow: out, proof: { marker: MARKER, workflowId: WORKFLOW_ID, beforeVersion: expected.versionId,
    changed, candidateActive: false, sends: 0, runtimeWrites: 0,
    operationalKey: 'aceite:<brand>', qaKey: 'qa:aceite:<brand>', excludedFlow: 'teste-motor' } };
}

module.exports = { WORKFLOW_ID, MARKER, sha256, configQuery, patchQuery, patchConfig, patchDecision, patchWorkflow };
