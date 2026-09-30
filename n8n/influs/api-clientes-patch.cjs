'use strict';
// API de Influs (SVM6ojSUrFZkZd0L), acao=listar — revisão de 30/09/2026.
// Acrescenta ao payload, sem mudar nenhum campo existente:
//   clientes   por creator no período: pedidos, novos (1º pedido na loja), recorrentes e sem_indice
//              (crm_influ_clientes_v1, n8n/influs/clientes-novos.sql). Base do CAC por cliente novo.
// A autorização continua a mesma de listar (leitura). Nenhuma escrita nova.
const WORKFLOW_ID = 'SVM6ojSUrFZkZd0L';
const ANCORA = "  'janela', jsonb_build_object('ini','${ini}','fim','${fim}'),\n";
const BLOCO = ANCORA
  + "  -- Clientes novos por creator (1º pedido do cliente na loja). Sem índice fica à parte, nunca vira novo.\n"
  + "  'clientes', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.marca, c.novos DESC, c.influ)\n"
  + "     FROM public.crm_influ_clientes_v1('${ini}'::date,'${fim}'::date) c), '[]'::jsonb),\n";

function patchWorkflow(fresh, { expectedVersionId } = {}) {
  if (fresh?.id !== WORKFLOW_ID) throw Error('Workflow errado');
  if (!expectedVersionId || fresh.versionId !== expectedVersionId || fresh.activeVersionId !== expectedVersionId)
    throw Error('Versao da API mudou desde a revisao');
  const w = structuredClone(fresh);
  const n = w.nodes.find(x => x.name === 'Monta SQL');
  const code = n?.parameters?.jsCode || '';
  if (code.split(ANCORA).length !== 2) throw Error('Ancora de listar divergente');
  if (code.includes("'clientes'")) throw Error('Patch ja aplicado');
  n.parameters.jsCode = code.replace(ANCORA, BLOCO);
  return w;
}

module.exports = { WORKFLOW_ID, ANCORA, BLOCO, patchWorkflow };
