-- Additive Shopify projection. Apply separately after reviewing the current runtime.
-- Existing attribution views, ingestion, collectors and legacy assistance stay unchanged.
-- Eligibility, net BRL, purchase day BRT and the 30-day winner come from attribution v2.
-- UTM values below are exactly what the ledger retained; its collector already normalizes
-- case/whitespace. They are NOT a reconstruction of the original link parameters.

CREATE OR REPLACE VIEW public.crm_organico_attribution_order_v2 AS
WITH observed AS (
 SELECT o.brand AS marca,o.order_id,o.day AS dia,o.model,o.amount AS receita_liquida,o.checked_at,
   o.winner->>'source' AS utm_source,o.winner->>'medium' AS utm_medium,
   o.winner->>'campaign' AS utm_campaign,o.winner->>'content' AS utm_content,o.winner->>'term' AS utm_term,
   lower(btrim(coalesce(o.winner->>'source',''))) AS source_norm,
   lower(btrim(coalesce(o.winner->>'medium',''))) AS medium_norm,
   o.winner->>'channel' AS winner_channel,
   (o.winner IS NULL OR o.winner='null'::jsonb) AS sem_toque
 FROM public.crm_attribution_order_model_v2 o
 WHERE o.model IN ('last_click','last_non_direct')
   AND o.amount>0
   AND o.order_id ~ '^gid://shopify/Order/[0-9]+$'
   -- A known model without a non-direct touch remains in reconciliation, never organic.
   -- Malformed non-null winners are not promoted to conversion credit.
   AND (o.winner IS NULL OR o.winner='null'::jsonb
        OR (jsonb_typeof(o.winner)='object' AND nullif(o.winner->>'at','') IS NOT NULL))
), classified AS (
 SELECT o.*,
 CASE
   WHEN medium_norm IN ('paid','cpc','ppc','cpm','paid_social','paid-social','paid_search','display','ads')
     OR source_norm IN ('facebook_ads','instagram_ads','meta_ads','google_ads','googleads','tiktok_ads','fb_ads','ig_ads') THEN 'midia_paga'
   WHEN source_norm='instagram_social' AND medium_norm='story' THEN 'editorial'
   WHEN source_norm='instagram_social' AND medium_norm='linktree' THEN 'bio'
   WHEN source_norm IN ('instagram_social','instagram') AND medium_norm IN ('dm','dm-automation') THEN 'automacao_dm'
   WHEN source_norm IN ('instagram','linktree','ig','igshopping','facebook') AND medium_norm='social' THEN 'legado_ambiguo'
   WHEN winner_channel IN ('email','whatsapp') THEN 'crm'
   ELSE 'nao_classificado'
 END AS classification
 FROM observed o
)
SELECT marca,order_id,dia,model,'shopify'::text AS source_system,'BRL'::text AS currency,
 classification,'organico-utm-20260919-v1'::text AS rule_version,
 CASE classification
   WHEN 'editorial' THEN 'controle_utm_instagram_story'
   WHEN 'bio' THEN 'controle_utm_instagram_linktree'
   WHEN 'automacao_dm' THEN 'controle_utm_ou_alias_dm_documentado'
   WHEN 'legado_ambiguo' THEN 'social_legado_sem_distincao_paid'
   WHEN 'midia_paga' THEN 'medium_ou_source_paid_explicito'
   WHEN 'crm' THEN 'canal_crm_do_ledger'
   ELSE CASE WHEN sem_toque THEN 'modelo_conhecido_sem_toque'
             WHEN source_norm='' AND medium_norm='' THEN 'toque_sem_utm_de_canal'
             ELSE 'combinacao_sem_regra_comprovada' END
 END AS rule_reason,
 CASE WHEN source_norm IN ('instagram_social','instagram','linktree','ig','igshopping','instagram_ads','ig_ads') THEN 'instagram'
      WHEN source_norm IN ('facebook','facebook_ads','fb_ads') THEN 'facebook'
      WHEN source_norm IN ('tiktok','tiktok_social','tiktok_ads') THEN 'tiktok'
      ELSE NULL END AS rede,
 CASE WHEN classification='editorial' THEN 'story'
      WHEN classification='bio' THEN 'bio'
      WHEN classification='automacao_dm' THEN 'dm'
      ELSE NULL END AS superficie,
 utm_source,utm_medium,utm_campaign,utm_content,utm_term,
 false AS utm_raw_available,'ledger_normalized'::text AS utm_provenance,
 'nao_identificada'::text AS piece_status,
 receita_liquida,checked_at
FROM classified;

-- The model is part of the grain. Never sum the two alternative models.
-- No post/story lookup is joined: channel credit does not require piece identity.
CREATE OR REPLACE VIEW public.crm_organico_attribution_daily_v2 AS
SELECT marca,dia,model,source_system,currency,classification,rule_version,rule_reason,rede,superficie,
 utm_source,utm_medium,utm_campaign,utm_content,utm_term,utm_raw_available,utm_provenance,piece_status,
 count(*)::integer AS pedidos,sum(receita_liquida) AS receita_liquida,
 min(checked_at) AS leitura_mais_antiga,max(checked_at) AS coletado_em
FROM public.crm_organico_attribution_order_v2
GROUP BY marca,dia,model,source_system,currency,classification,rule_version,rule_reason,rede,superficie,
 utm_source,utm_medium,utm_campaign,utm_content,utm_term,utm_raw_available,utm_provenance,piece_status;

-- Keep population quality separate from daily/model attribution, so consumers cannot
-- multiply its denominator when joining UTM rows or the two models.
CREATE OR REPLACE VIEW public.crm_organico_attribution_quality_v2 AS
WITH flags AS (
 SELECT o.brand AS marca,((o.payload->>'created_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'strict_known'='true')::integer AS ultima_sessao_conhecida,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'strict_known' IS DISTINCT FROM 'true')::integer AS ultima_sessao_desconhecida,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'non_direct_known' IS DISTINCT FROM 'true')::integer AS origem_nao_direta_desconhecida
 FROM public.crm_attribution_order_v2 o GROUP BY 1,2
)
SELECT q.marca,q.dia,q.pedidos_lidos,q.pagos_elegiveis,q.jornada_pendente,q.jornada_parcial,
 q.receita_elegivel,q.leitura_mais_antiga,q.coletado_em,
 f.ultima_sessao_conhecida,f.ultima_sessao_desconhecida,f.origem_nao_direta_desconhecida
FROM public.crm_attribution_quality_v2 q JOIN flags f ON f.marca=q.marca AND f.dia=q.dia;

CREATE OR REPLACE FUNCTION public.crm_organico_attribution_payload_v2(p_ini date,p_fim date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public AS $function$
BEGIN
 IF p_ini IS NULL OR p_fim IS NULL OR p_ini>p_fim THEN RAISE EXCEPTION 'ORGANICO_WINDOW_INVALID'; END IF;
 RETURN jsonb_build_object(
  'schema_version',1,'rule_version','organico-utm-20260919-v1','default_model','last_click',
  'window_days',30,'source_system','shopify','currency','BRL',
  'utm_raw_available',false,'assistance_available',false,'piece_identity_available',false,
  'janela',jsonb_build_object('ini',p_ini,'fim',p_fim),'gerado_em',now(),
  'daily',coalesce((
    WITH scoped AS MATERIALIZED (
      SELECT * FROM public.crm_organico_attribution_daily_v2 WHERE dia BETWEEN p_ini AND p_fim
    ), display_rows AS (
      -- UTM details belong to the organic/DM/ambiguous lenses. Other channels
      -- retain their exact daily totals without exporting every campaign UTM.
      SELECT d.*,'utm'::text AS detail_level FROM scoped d
      WHERE classification IN ('editorial','bio','automacao_dm','legado_ambiguo')
      UNION ALL
      SELECT marca,dia,model,'shopify'::text AS source_system,'BRL'::text AS currency,
        classification,'organico-utm-20260919-v1'::text AS rule_version,
        'resumo_diario_canal'::text AS rule_reason,
        NULL::text AS rede,NULL::text AS superficie,
        NULL::text AS utm_source,NULL::text AS utm_medium,NULL::text AS utm_campaign,
        NULL::text AS utm_content,NULL::text AS utm_term,
        false AS utm_raw_available,'channel_summary'::text AS utm_provenance,
        'nao_aplicavel_resumo'::text AS piece_status,
        sum(pedidos)::integer AS pedidos,sum(receita_liquida) AS receita_liquida,
        min(leitura_mais_antiga) AS leitura_mais_antiga,max(coletado_em) AS coletado_em,
        'channel_summary'::text AS detail_level
      FROM scoped WHERE classification IN ('midia_paga','crm','nao_classificado')
      GROUP BY marca,dia,model,classification
    )
    SELECT jsonb_agg(d ORDER BY d.dia,d.marca,d.model,d.classification,d.utm_source,d.utm_medium,d.utm_campaign)
    FROM display_rows d),'[]'::jsonb),
  'quality',coalesce((SELECT jsonb_agg(q ORDER BY q.dia,q.marca)
    FROM public.crm_organico_attribution_quality_v2 q WHERE q.dia BETWEEN p_ini AND p_fim),'[]'::jsonb),
  'coverage',coalesce((SELECT jsonb_agg(c ORDER BY c.dia,c.marca) FROM (
    SELECT brand AS marca,day AS dia,checked_at FROM public.crm_attribution_coverage_v2
    WHERE day BETWEEN p_ini AND p_fim) c),'[]'::jsonb)
 );
END;$function$;

REVOKE ALL ON public.crm_organico_attribution_order_v2,public.crm_organico_attribution_daily_v2,
 public.crm_organico_attribution_quality_v2 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_organico_attribution_payload_v2(date,date) FROM PUBLIC;
