/* Patch puro e reversível do node Monta SQL em export fresco da API TikTok.
 * Sem I/O, credenciais, DDL ou envio. Campos originais são preservados.
 * A conciliação compara fontes/modelos; saldo não comprova origem atribuída. */
'use strict';
const ORIGINAL = String.raw`canal AS (  -- Canal (Shop Analytics) na janela: total da loja por dia, fatia por superfície e por origem
  SELECT v.marca, v.dia, v.gmv, v.gmv_live, v.gmv_video, v.gmv_vitrine, v.gmv_afiliado, v.gmv_proprio, v.gmv_ads, v.pedidos, v.visitantes, v.reembolso
  FROM crm_tts_canal_v v, j WHERE v.dia BETWEEN j.ini AND j.fim
),
canal_tot AS (  -- resumo da janela por marca (o que vai nos cartões da aba Canal)
  SELECT marca, count(*)::int AS dias, round(sum(gmv),2) AS gmv, round(sum(gmv_live),2) AS gmv_live, round(sum(gmv_video),2) AS gmv_video,
         round(sum(gmv_vitrine),2) AS gmv_vitrine, round(sum(gmv_afiliado),2) AS gmv_afiliado, round(sum(gmv_proprio),2) AS gmv_proprio,
         round(sum(gmv_ads),2) AS gmv_ads, sum(pedidos)::int AS pedidos, sum(visitantes)::bigint AS visitantes, round(sum(reembolso),2) AS reembolso,
         round(100.0 * sum(gmv_afiliado) / NULLIF(sum(gmv),0), 1) AS pct_afiliado,
         round(100.0 * sum(gmv_live) / NULLIF(sum(gmv),0), 1) AS pct_live,
         round(100.0 * sum(gmv_video) / NULLIF(sum(gmv),0), 1) AS pct_video,
         round(100.0 * sum(gmv_vitrine) / NULLIF(sum(gmv),0), 1) AS pct_vitrine,
         round(100.0 * sum(gmv_ads) / NULLIF(sum(gmv),0), 1) AS pct_gmv_max,
         round(100.0 * sum(pedidos) / NULLIF(sum(visitantes),0), 2) AS conversao_pct,
         round(sum(gmv) / NULLIF(sum(pedidos),0), 2) AS ticket_medio,
         max(dia) AS ultimo_dia
  FROM canal GROUP BY 1
),
`;
const RECONCILED = String.raw`canal AS (  -- Mesmos valores originais; saldo calculado não é venda própria atribuída.
  SELECT v.marca, v.dia, v.gmv, v.gmv_live, v.gmv_video, v.gmv_vitrine, v.gmv_afiliado, v.gmv_proprio, v.gmv_ads, v.pedidos, v.visitantes, v.reembolso,
         CASE WHEN v.gmv IS NULL OR v.gmv_afiliado IS NULL OR v.gmv_proprio IS NULL THEN 'indisponivel'
              WHEN v.gmv_afiliado > v.gmv OR v.gmv <> v.gmv_afiliado + v.gmv_proprio THEN 'divergente'
              ELSE 'saldo_calculado' END AS origem_estado,
         'analytics_total_menos_pedidos_afiliados'::text AS origem_modelo,
         CASE WHEN v.gmv >= v.gmv_afiliado AND v.gmv = v.gmv_afiliado + v.gmv_proprio
              THEN v.gmv - v.gmv_afiliado ELSE NULL END AS gmv_saldo_nao_afiliado,
         v.gmv - v.gmv_afiliado - v.gmv_proprio AS gmv_ajuste_origem,
         abs(v.gmv - v.gmv_afiliado - v.gmv_proprio) AS gmv_ajuste_origem_absoluto
  FROM crm_tts_canal_v v, j WHERE v.dia BETWEEN j.ini AND j.fim
),
canal_tot AS (  -- Compatibilidade avaliada por dia antes de agregar; nenhum desvio se compensa.
  SELECT marca, count(*)::int AS dias, round(sum(gmv),2) AS gmv, round(sum(gmv_live),2) AS gmv_live, round(sum(gmv_video),2) AS gmv_video,
         round(sum(gmv_vitrine),2) AS gmv_vitrine, round(sum(gmv_afiliado),2) AS gmv_afiliado, round(sum(gmv_proprio),2) AS gmv_proprio,
         round(sum(gmv_ads),2) AS gmv_ads, sum(pedidos)::int AS pedidos, sum(visitantes)::bigint AS visitantes, round(sum(reembolso),2) AS reembolso,
         round(100.0 * sum(gmv_afiliado) / NULLIF(sum(gmv),0), 1) AS pct_afiliado,
         round(100.0 * sum(gmv_live) / NULLIF(sum(gmv),0), 1) AS pct_live,
         round(100.0 * sum(gmv_video) / NULLIF(sum(gmv),0), 1) AS pct_video,
         round(100.0 * sum(gmv_vitrine) / NULLIF(sum(gmv),0), 1) AS pct_vitrine,
         round(100.0 * sum(gmv_ads) / NULLIF(sum(gmv),0), 1) AS pct_gmv_max,
         round(100.0 * sum(pedidos) / NULLIF(sum(visitantes),0), 2) AS conversao_pct,
         round(sum(gmv) / NULLIF(sum(pedidos),0), 2) AS ticket_medio,
         max(dia) AS ultimo_dia,
         CASE WHEN bool_or(origem_estado = 'divergente') THEN 'divergente'
              WHEN bool_or(origem_estado = 'indisponivel') THEN 'indisponivel'
              ELSE 'saldo_calculado' END AS origem_estado,
         'analytics_total_menos_pedidos_afiliados'::text AS origem_modelo,
         CASE WHEN bool_and(origem_estado = 'saldo_calculado') THEN round(sum(gmv_saldo_nao_afiliado),2)
              ELSE NULL END AS gmv_saldo_nao_afiliado,
         CASE WHEN bool_and(gmv_ajuste_origem IS NOT NULL) THEN round(sum(gmv_ajuste_origem),2)
              ELSE NULL END AS gmv_ajuste_origem,
         CASE WHEN bool_and(gmv_ajuste_origem IS NOT NULL) THEN round(sum(gmv_ajuste_origem_absoluto),2)
              ELSE NULL END AS gmv_ajuste_origem_absoluto,
         count(*) FILTER (WHERE origem_estado = 'divergente')::int AS origem_dias_divergentes,
         count(*) FILTER (WHERE origem_estado = 'indisponivel')::int AS origem_dias_indisponiveis
  FROM canal GROUP BY 1
),
`;

const count=(text,part)=>text.split(part).length-1;
function patchCode(code,{remove=false}={}){
 if(typeof code!=='string')throw Error('Monta SQL deve conter jsCode');
 const expected=remove?RECONCILED:ORIGINAL,replacement=remove?ORIGINAL:RECONCILED;
 if(count(code,replacement)===1&&count(code,expected)===0)return code;
 if(count(code,expected)!==1||count(code,replacement)!==0)throw Error('CTEs de Canal divergiram; revisar o export fresco');
 return code.replace(expected,replacement);
}
function patchWorkflow(fresh,{remove=false,expectedVersion}={}){
 if(!fresh||!Array.isArray(fresh.nodes)||!fresh.versionId)throw Error('Export fresco com versionId obrigatório');
 if(expectedVersion&&fresh.versionId!==expectedVersion)throw Error('Versão do workflow mudou');
 const workflow=JSON.parse(JSON.stringify(fresh));
 const nodes=workflow.nodes.filter(n=>n.name==='Monta SQL');
 if(nodes.length!==1)throw Error('Esperado exatamente um node Monta SQL');
 const node=nodes[0],before=node.parameters?.jsCode,after=patchCode(before,{remove});
 if(before!==after)node.parameters.jsCode=after;
 return {workflow,changes:before===after?[]:[{node:node.name,field:'jsCode'}]};
}
module.exports={ORIGINAL,RECONCILED,patchCode,patchWorkflow};
