CREATE OR REPLACE VIEW public.crm_attribution_payload_v2 AS  SELECT jsonb_build_object('schema_version', 2, 'window_days', 30, 'default_model', 'last_click', 'money_basis', 'net_payment_brl', 'generated_at', now(), 'daily', COALESCE(( SELECT jsonb_agg(to_jsonb(d.*)) AS jsonb_agg
           FROM crm_attribution_daily_v2 d), '[]'::jsonb), 'quality', COALESCE(( SELECT jsonb_agg(to_jsonb(q.*)) AS jsonb_agg
           FROM crm_attribution_quality_v2 q), '[]'::jsonb), 'coverage', COALESCE(( SELECT jsonb_agg(to_jsonb(c.*)) AS jsonb_agg
           FROM crm_attribution_coverage_v2 c), '[]'::jsonb), 'campaigns', COALESCE(( SELECT jsonb_agg(to_jsonb(c.*)) AS jsonb_agg
           FROM crm_growth_campaign_members_v2 c), '[]'::jsonb), 'dispatch_evidence', jsonb_build_object('schema_version', 1, 'checked_at', (SELECT min(checked_at) FROM public.crm_attribution_dispatch_cache_v3), 'basis', 'utm_and_chronology', 'daily', COALESCE(( SELECT jsonb_agg(x.*) AS jsonb_agg
           FROM crm_attribution_dispatch_daily_v3 x), '[]'::jsonb), 'quality', COALESCE(( SELECT jsonb_agg(x.*) AS jsonb_agg
           FROM crm_attribution_dispatch_quality_v3 x), '[]'::jsonb)), 'reconciliation', COALESCE(( SELECT jsonb_agg(x.*) AS jsonb_agg
           FROM crm_attribution_reconciliation_v3 x), '[]'::jsonb), 'pix_charge', jsonb_build_object('schema_version', 1, 'basis', 'original_emv_appmax_event', 'daily', COALESCE(( SELECT jsonb_agg(x.*) AS jsonb_agg
           FROM crm_pix_charge_daily_v1 x), '[]'::jsonb)), 'hourly', COALESCE(( SELECT jsonb_agg(x.*) AS jsonb_agg
           FROM ( SELECT crm_attribution_order_model_v2.brand AS marca,
                    crm_attribution_order_model_v2.day AS dia,
                    crm_attribution_order_model_v2.hour AS hora,
                    crm_attribution_order_model_v2.model,
                    crm_attribution_order_model_v2.winner ->> 'channel'::text AS canal,
                    count(*)::integer AS pedidos,
                    sum(crm_attribution_order_model_v2.amount) AS receita
                   FROM crm_attribution_order_model_v2
                  WHERE (crm_attribution_order_model_v2.winner ->> 'channel'::text) = ANY (ARRAY['email'::text, 'whatsapp'::text])
                  GROUP BY crm_attribution_order_model_v2.brand, crm_attribution_order_model_v2.day, crm_attribution_order_model_v2.hour, crm_attribution_order_model_v2.model, (crm_attribution_order_model_v2.winner ->> 'channel'::text)) x), '[]'::jsonb)) AS payload;