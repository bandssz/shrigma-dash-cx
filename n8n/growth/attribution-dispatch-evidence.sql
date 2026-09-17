-- Dispatch credit is checked per paid order, before aggregation. Reused UTMs
-- cannot give a later dispatch credit for an earlier visit.
CREATE OR REPLACE VIEW public.crm_attribution_dispatch_candidates_v3 AS
WITH links AS MATERIALIZED (
 SELECT DISTINCT c.marca,c.campanha_id,c.enviado_em,u
 FROM public.crm_growth_campaign_members_v2 c CROSS JOIN LATERAL jsonb_array_elements(c.utms)u
 WHERE c.enviados>0 AND c.canal='email'
), orders AS MATERIALIZED (
 SELECT * FROM public.crm_attribution_order_model_v2 WHERE winner->>'channel'='email'
)
SELECT DISTINCT o.brand,o.order_id,o.day,o.model,o.amount,o.customer_index,
 (o.winner->>'at')::timestamptz visit_at,c.campanha_id,c.enviado_em,
 c.enviado_em <= (o.winner->>'at')::timestamptz AS chronological
FROM orders o JOIN links c ON c.marca=o.brand
 AND coalesce(c.u->>'source','')=coalesce(o.winner->>'source','')
 AND coalesce(c.u->>'medium','')=coalesce(o.winner->>'medium','')
 AND coalesce(c.u->>'campaign','')=coalesce(o.winner->>'campaign','')
 AND coalesce(c.u->>'content','')=coalesce(o.winner->>'content','')
 AND coalesce(c.u->>'term','')=coalesce(o.winner->>'term','');

CREATE OR REPLACE VIEW public.crm_attribution_dispatch_order_v3 AS
SELECT o.brand,o.order_id,o.day,o.model,o.amount,o.customer_index,
 coalesce(c.eligible,0) eligible_dispatches,coalesce(c.unknown_time,0) unknown_time,
 coalesce(c.too_late,0) visits_before_dispatch,
 CASE WHEN c.unknown_time>0 THEN 'send_time_unknown'
  WHEN c.eligible=1 THEN 'exclusive'
  WHEN c.eligible>1 THEN 'shared'
  WHEN c.too_late>0 THEN 'visit_before_dispatch'
  ELSE 'no_dispatch' END evidence,
 CASE WHEN c.eligible=1 AND c.unknown_time=0 THEN c.dispatch_id END campanha_id
FROM public.crm_attribution_order_model_v2 o
LEFT JOIN (
 SELECT x.brand,x.order_id,x.model,count(*) FILTER(WHERE x.chronological) eligible,
  count(*) FILTER(WHERE x.chronological IS NULL) unknown_time,
  count(*) FILTER(WHERE x.chronological=false) too_late,
  min(x.campanha_id) FILTER(WHERE x.chronological) dispatch_id
 FROM public.crm_attribution_dispatch_candidates_v3 x GROUP BY x.brand,x.order_id,x.model
)c ON c.brand=o.brand AND c.order_id=o.order_id AND c.model=o.model
WHERE o.winner->>'channel'='email'
 AND (o.winner->>'medium'='campanha' OR c.eligible+c.unknown_time+c.too_late>0);

-- Reuse one order-level snapshot for reports; never repeat the expensive
-- customer-journey/link join for every dashboard aggregate.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.crm_attribution_dispatch_cache_v3 AS
 SELECT o.*,statement_timestamp() AS checked_at FROM public.crm_attribution_dispatch_order_v3 o;
CREATE UNIQUE INDEX IF NOT EXISTS crm_attribution_dispatch_cache_v3_key
 ON public.crm_attribution_dispatch_cache_v3(brand,order_id,model);
CREATE OR REPLACE FUNCTION public.crm_attribution_refresh_dispatch_v3() RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT pg_try_advisory_xact_lock(173920260917) THEN RETURN false;END IF;
 REFRESH MATERIALIZED VIEW CONCURRENTLY public.crm_attribution_dispatch_cache_v3;
 RETURN true;
END $$;
REVOKE ALL ON public.crm_attribution_dispatch_cache_v3 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_attribution_refresh_dispatch_v3() FROM PUBLIC;

CREATE OR REPLACE VIEW public.crm_attribution_dispatch_daily_v3 AS
SELECT brand marca,day dia,model,campanha_id,count(*)::int pedidos,
 sum(amount) receita,count(*) FILTER(WHERE customer_index=1)::int novos,
 count(*) FILTER(WHERE customer_index>1)::int recorrentes
FROM public.crm_attribution_dispatch_cache_v3 WHERE evidence='exclusive'
GROUP BY 1,2,3,4;

CREATE OR REPLACE VIEW public.crm_attribution_dispatch_quality_v3 AS
SELECT brand marca,day dia,model,evidence,count(*)::int pedidos,sum(amount) receita,
 sum(visits_before_dispatch)::int candidatos_posteriores_a_visita
FROM public.crm_attribution_dispatch_cache_v3 GROUP BY 1,2,3,4;

CREATE OR REPLACE VIEW public.crm_attribution_reconciliation_v3 AS
SELECT o.brand marca,((o.payload->>'created_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date dia,
 m.model,count(*)::int pagos_elegiveis,
 count(*) FILTER(WHERE o.payload->>m.known IS DISTINCT FROM 'true')::int origem_desconhecida,
 count(*) FILTER(WHERE o.payload->>m.known='true' AND o.payload->m.field->>'channel' IN('email','whatsapp'))::int credito_crm,
 count(*) FILTER(WHERE o.payload->>m.known='true' AND (o.payload->m.field->>'channel' IN('email','whatsapp')) IS NOT TRUE)::int direto_outros,
 sum((o.payload->>'net_amount')::numeric) receita_elegivel
FROM public.crm_attribution_order_v2 o
CROSS JOIN (VALUES('last_click','last_click','strict_known'),('last_non_direct','last_non_direct','non_direct_known'))m(model,field,known)
WHERE o.payload->>'eligible'='true' AND EXISTS(SELECT 1 FROM crm_attribution_coverage_v2 c WHERE c.brand=o.brand
 AND c.day=((o.payload->>'created_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date)
GROUP BY 1,2,3;

REVOKE ALL ON public.crm_attribution_dispatch_candidates_v3,public.crm_attribution_dispatch_order_v3,
 public.crm_attribution_dispatch_daily_v3,public.crm_attribution_dispatch_quality_v3,
 public.crm_attribution_reconciliation_v3 FROM PUBLIC;
