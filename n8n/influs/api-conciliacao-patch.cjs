'use strict';
// API de Influs (SVM6ojSUrFZkZd0L), acao=listar — revisão de 26/09/2026.
// Acrescenta ao payload, sem mudar nenhum campo existente:
//   conciliacao          relatório Shopify × painel por cupom no período (crm_influ_conciliacao_v1)
//   saude                cada etapa por marca: última tentativa, último sucesso, detalhe
//   coleta               último horário de coleta do ledger por marca
//   conciliacao_pedidos  linhas por pedido, só quando o corpo pede { conciliacao_pedidos: true }
// A autorização continua a mesma de listar (leitura). Nenhuma escrita nova.
const WORKFLOW_ID = 'SVM6ojSUrFZkZd0L';
const ANCORA = "  'janela', jsonb_build_object('ini','${ini}','fim','${fim}'),\n";
const BLOCO = ANCORA
  + "  -- Conferência com o relatório da Shopify: cada lado com o seu número, nada somado entre fontes.\n"
  + "  'conciliacao', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.marca, c.relatorio_vendas_liquidas DESC NULLS LAST, c.codigo)\n"
  + "     FROM public.crm_influ_conciliacao_v1('${ini}'::date,'${fim}'::date) c), '[]'::jsonb),\n"
  + "  'saude', COALESCE((SELECT jsonb_agg(jsonb_build_object('lane',s.lane,'marca',s.marca,'ok',s.ok,'detalhe',s.detalhe,\n"
  + "       'em',s.em,'ultimo_ok_em',s.ultimo_ok_em,'itens',s.itens) ORDER BY s.marca, s.lane)\n"
  + "     FROM public.crm_influ_saude s), '[]'::jsonb),\n"
  + "  'coleta', COALESCE((SELECT jsonb_object_agg(x.marca, x.em)\n"
  + "     FROM (SELECT marca, max(atualizado_em) AS em FROM public.crm_influ_pedido GROUP BY 1) x), '{}'::jsonb),\n"
  + "  'conciliacao_pedidos', ${b.conciliacao_pedidos===true?\"COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.crm_influ_conciliacao_pedidos_v1('\"+ini+\"'::date,'\"+fim+\"'::date,\"+q(MARCAS.includes(b.marca)?b.marca:'todas')+\") p), '[]'::jsonb)\":'NULL'},\n";

function patchWorkflow(fresh, { expectedVersionId } = {}) {
  if (fresh?.id !== WORKFLOW_ID) throw Error('Workflow errado');
  if (!expectedVersionId || fresh.versionId !== expectedVersionId || fresh.activeVersionId !== expectedVersionId)
    throw Error('Versao da API mudou desde a revisao');
  const w = structuredClone(fresh);
  const n = w.nodes.find(x => x.name === 'Monta SQL');
  const code = n?.parameters?.jsCode || '';
  if (code.split(ANCORA).length !== 2) throw Error('Ancora de listar divergente');
  if (code.includes("'conciliacao'")) throw Error('Patch ja aplicado');
  if (!code.includes("const DATA = /^\\d{4}-\\d{2}-\\d{2}$/;") || !code.includes("const MARCAS = ['aristo','fish','olivas'];"))
    throw Error('Validacao de datas/marcas divergente');
  n.parameters.jsCode = code.replace(ANCORA, BLOCO);
  return w;
}

module.exports = { WORKFLOW_ID, ANCORA, BLOCO, patchWorkflow };
