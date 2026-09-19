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
