-- Order identity prevents stale aggregate keys and duplicate purchase credit.
CREATE TABLE public.crm_attribution_order_v2(
 brand text NOT NULL CHECK(brand IN ('fish','aristo')),order_id text NOT NULL,
 payload jsonb NOT NULL,source_updated_at timestamptz NOT NULL,checked_at timestamptz NOT NULL,
 PRIMARY KEY(brand,order_id)
);
CREATE TABLE public.crm_attribution_run_v2(
 execution_id text PRIMARY KEY,scope jsonb NOT NULL,orders integer NOT NULL,applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.crm_attribution_coverage_v2(
 brand text NOT NULL,day date NOT NULL,checked_at timestamptz NOT NULL,execution_id text NOT NULL,
 PRIMARY KEY(brand,day)
);
REVOKE ALL ON public.crm_attribution_order_v2,public.crm_attribution_run_v2,public.crm_attribution_coverage_v2 FROM PUBLIC;
CREATE FUNCTION public.crm_attribution_ingest_v2(p_rows jsonb,scope jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE n integer;b text;from_day date;until_day date;read_at timestamptz;rid text;
BEGIN
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>20000
  OR scope->>'complete' IS DISTINCT FROM 'true' OR scope->>'mode' NOT IN ('created','updated')
  OR scope->'brands' IS DISTINCT FROM '["aristo","fish"]'::jsonb THEN RAISE EXCEPTION 'ATTRIBUTION_BATCH_INVALID';END IF;
 rid=scope->>'execution_id';read_at=(scope->>'read_at')::timestamptz;
 from_day=(scope->>'coverage_from')::date;until_day=(scope->>'coverage_until')::date;
 IF coalesce(rid,'')='' OR read_at IS NULL OR from_day IS NULL OR until_day IS NULL
  OR from_day>until_day OR until_day>public.hoje_br() OR until_day-from_day>7 THEN RAISE EXCEPTION 'ATTRIBUTION_SCOPE_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM public.crm_attribution_run_v2 WHERE execution_id=rid) THEN RETURN 0;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) x WHERE x->>'brand' NOT IN ('fish','aristo')
  OR coalesce(x->>'order_id','')!~'^gid://shopify/Order/[0-9]+$' OR x->>'model_version' IS DISTINCT FROM 'last-non-direct-30d-v2'
  OR x->>'created_at' IS NULL OR x->>'updated_at' IS NULL)
  OR (SELECT count(*) FROM jsonb_array_elements(p_rows))<>(SELECT count(DISTINCT (x->>'brand',x->>'order_id')) FROM jsonb_array_elements(p_rows)x) THEN
  RAISE EXCEPTION 'ATTRIBUTION_ROWS_INVALID';END IF;
 INSERT INTO public.crm_attribution_order_v2(brand,order_id,payload,source_updated_at,checked_at)
 SELECT x->>'brand',x->>'order_id',x,(x->>'updated_at')::timestamptz,read_at FROM jsonb_array_elements(p_rows)x
 ON CONFLICT(brand,order_id) DO UPDATE SET payload=EXCLUDED.payload,source_updated_at=EXCLUDED.source_updated_at,checked_at=EXCLUDED.checked_at
 WHERE EXCLUDED.source_updated_at>=crm_attribution_order_v2.source_updated_at AND EXCLUDED.checked_at>=crm_attribution_order_v2.checked_at;
 GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO public.crm_attribution_run_v2(execution_id,scope,orders) VALUES(rid,scope,n);
 FOREACH b IN ARRAY ARRAY['aristo','fish'] LOOP
  INSERT INTO public.crm_attribution_coverage_v2(brand,day,checked_at,execution_id)
  SELECT b,from_day+i,read_at,rid FROM generate_series(0,until_day-from_day)i
  ON CONFLICT(brand,day) DO UPDATE SET checked_at=EXCLUDED.checked_at,execution_id=EXCLUDED.execution_id
  WHERE EXCLUDED.checked_at>crm_attribution_coverage_v2.checked_at;
 END LOOP;
 RETURN n;
END;$f$;
REVOKE ALL ON FUNCTION public.crm_attribution_ingest_v2(jsonb,jsonb) FROM PUBLIC;

CREATE VIEW public.crm_attribution_order_model_v2 AS
SELECT o.brand,o.order_id,((o.payload->>'created_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date AS day,
 extract(hour FROM ((o.payload->>'created_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo'))::integer AS hour,
 (o.payload->>'net_amount')::numeric amount,(o.payload->>'customer_order_index')::int customer_index,
 m.model,o.payload->m.field winner,o.payload->'touches' touches,o.checked_at
FROM public.crm_attribution_order_v2 o CROSS JOIN (VALUES('last_non_direct','last_non_direct','non_direct_known'),('last_click','last_click','strict_known'))m(model,field,known)
WHERE o.payload->>'eligible'='true' AND o.payload->>m.known='true'
 AND EXISTS(SELECT 1 FROM public.crm_attribution_coverage_v2 c WHERE c.brand=o.brand
 AND c.day=((o.payload->>'created_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date);

CREATE FUNCTION public.crm_attribution_family_v2(brand text,campaign text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
 SELECT coalesce((SELECT f.familia FROM public.crm_familia_campanha f WHERE f.marca=$1 AND f.utm_campaign=$2),nullif($2,''),'(sem campanha)');
$f$;
REVOKE ALL ON FUNCTION public.crm_attribution_family_v2(text,text) FROM PUBLIC;

CREATE VIEW public.crm_attribution_credit_v2 AS
WITH touches AS (
 SELECT o.*,v.touch,v.role FROM public.crm_attribution_order_model_v2 o
 CROSS JOIN LATERAL (SELECT o.winner touch,'last'::text role UNION ALL SELECT x,'assist' FROM jsonb_array_elements(o.touches)x) v
 WHERE v.touch->>'channel' IN ('email','whatsapp')
), dimensions AS (
 SELECT t.*,g.grain,
 CASE g.grain WHEN 'total' THEN '["crm"]'::jsonb WHEN 'channel' THEN jsonb_build_array(t.touch->>'channel')
  WHEN 'family' THEN jsonb_build_array(public.crm_attribution_family_v2(t.brand,t.touch->>'campaign'))
  WHEN 'family_channel' THEN jsonb_build_array(public.crm_attribution_family_v2(t.brand,t.touch->>'campaign'),t.touch->>'channel')
  WHEN 'flow_piece' THEN jsonb_build_array(t.touch->>'channel',t.touch->>'campaign',t.touch->>'content') WHEN 'campaign_channel' THEN jsonb_build_array(t.touch->>'campaign',t.touch->>'channel') WHEN 'campaign' THEN jsonb_build_array(t.touch->>'campaign')
  ELSE jsonb_build_array(t.touch->>'channel',t.touch->>'medium',t.touch->>'campaign',t.touch->>'content',t.touch->>'term',t.touch->>'source') END dimension,
 CASE g.grain WHEN 'total' THEN jsonb_build_array(CASE WHEN t.winner->>'channel' IN ('email','whatsapp') THEN 'crm' ELSE 'other' END) WHEN 'channel' THEN jsonb_build_array(t.winner->>'channel')
  WHEN 'family' THEN jsonb_build_array(public.crm_attribution_family_v2(t.brand,t.winner->>'campaign'))
  WHEN 'family_channel' THEN jsonb_build_array(public.crm_attribution_family_v2(t.brand,t.winner->>'campaign'),t.winner->>'channel')
  WHEN 'flow_piece' THEN jsonb_build_array(t.winner->>'channel',t.winner->>'campaign',t.winner->>'content') WHEN 'campaign_channel' THEN jsonb_build_array(t.winner->>'campaign',t.winner->>'channel') WHEN 'campaign' THEN jsonb_build_array(t.winner->>'campaign')
  ELSE jsonb_build_array(t.winner->>'channel',t.winner->>'medium',t.winner->>'campaign',t.winner->>'content',t.winner->>'term',t.winner->>'source') END winner_dimension
 FROM touches t CROSS JOIN (VALUES('total'),('channel'),('family'),('family_channel'),('campaign'),('campaign_channel'),('flow_piece'),('piece'))g(grain)
)
SELECT DISTINCT brand,order_id,day,hour,amount,customer_index,model,grain,dimension,role
FROM dimensions WHERE role='last' OR winner->>'channel' IS NULL OR dimension IS DISTINCT FROM winner_dimension;

CREATE VIEW public.crm_attribution_daily_v2 AS
SELECT brand AS marca,day AS dia,model,grain,dimension,
 count(*) FILTER(WHERE role='last')::int pedidos,sum(amount) FILTER(WHERE role='last') receita,
 count(*) FILTER(WHERE role='assist')::int assistidos,sum(amount) FILTER(WHERE role='assist') receita_assistida,
 count(*) FILTER(WHERE role='last' AND customer_index=1)::int novos,
 count(*) FILTER(WHERE role='last' AND customer_index>1)::int recorrentes
FROM public.crm_attribution_credit_v2 GROUP BY 1,2,3,4,5;

CREATE VIEW public.crm_attribution_quality_v2 AS
SELECT o.brand AS marca,((o.payload->>'created_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date dia,
 count(*)::int pedidos_lidos,count(*) FILTER(WHERE o.payload->>'eligible'='true')::int pagos_elegiveis,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'ready'<>'true')::int jornada_pendente,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'ready'='true' AND o.payload->>'complete'<>'true')::int jornada_parcial,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'non_direct_known'='true' AND o.payload#>>'{last_non_direct,channel}' IN ('email','whatsapp'))::int atribuidos_crm,
 sum((o.payload->>'net_amount')::numeric) FILTER(WHERE o.payload->>'eligible'='true') receita_elegivel,
 min(o.checked_at) leitura_mais_antiga,max(o.checked_at) coletado_em
FROM public.crm_attribution_order_v2 o GROUP BY 1,2;

-- Explicit initiative mapping; unrelated mappings are preserved.
INSERT INTO public.crm_familia_campanha(marca,utm_campaign,familia)
VALUES('aristo','aristo-semana-cliente','semana-do-cliente-2026')
ON CONFLICT(marca,utm_campaign) DO NOTHING;

CREATE VIEW public.crm_growth_campaign_members_v2 AS
WITH c AS (
 SELECT c.*,CASE WHEN c.from_email ILIKE '%oaristocrata.com%' THEN 'aristo' WHEN c.from_email ILIKE '%fishermans.com.br%' THEN 'fish' END emissor
 FROM public.campaigns c WHERE c.status<>'draft' AND coalesce(c.started_at,c.send_at,c.created_at)>=now()-interval '120 days'
), meta AS (
 SELECT c.*,CASE WHEN c.id=114 AND c.tags::text[] @> ARRAY['desodorante','cross'] THEN 'aristo' ELSE c.emissor END marca,
 (SELECT jsonb_agg(x) FROM(SELECT DISTINCT u.utm_source source,u.utm_medium medium,u.utm_campaign campaign,u.utm_content content,u.utm_term term
  FROM public.crm_campanha_utm u WHERE u.campanha_id=c.id AND u.canal='email')x) utms,
 (SELECT array_agg(DISTINCT l.name ORDER BY l.name) FROM public.campaign_lists cl JOIN public.lists l ON l.id=cl.list_id WHERE cl.campaign_id=c.id) segmentos
 FROM c WHERE c.emissor IS NOT NULL
)
SELECT m.marca,m.emissor,'email'::text canal,m.id campanha_id,m.name nome,m.status::text status,
 CASE WHEN m.tags::text[] @> ARRAY['semana-cliente'] THEN 'semana-do-cliente-2026'
  WHEN m.tags::text[] @> ARRAY['desodorante'] OR m.name ILIKE 'DESODORANTE%' THEN 'desodorante-frescor'
  WHEN (SELECT count(DISTINCT public.crm_attribution_family_v2(m.marca,x->>'campaign')) FROM jsonb_array_elements(m.utms)x)=1
   THEN (SELECT min(public.crm_attribution_family_v2(m.marca,x->>'campaign')) FROM jsonb_array_elements(m.utms)x)
  ELSE 'dispatch:'||m.id::text END familia,
 m.segmentos,m.tags,m.utms,m.started_at enviado_em,m.send_at agendado_em,m.sent enviados,m.to_send publico,
 s.entregues,s.abriram,s.clicaram,s.hard,s.complaints,s.coletado_em
FROM meta m LEFT JOIN public.crm_campanha s ON s.marca=m.emissor AND s.canal='email' AND s.campanha_id=m.id;

CREATE VIEW public.crm_attribution_payload_v2 AS
SELECT jsonb_build_object('schema_version',2,'window_days',30,'default_model','last_non_direct',
 'money_basis','net_payment_brl','generated_at',now(),
 'daily',coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM public.crm_attribution_daily_v2 d),'[]'::jsonb),
 'quality',coalesce((SELECT jsonb_agg(to_jsonb(q)) FROM public.crm_attribution_quality_v2 q),'[]'::jsonb),
 'coverage',coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM public.crm_attribution_coverage_v2 c),'[]'::jsonb),
 'campaigns',coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM public.crm_growth_campaign_members_v2 c),'[]'::jsonb),
 'hourly',coalesce((SELECT jsonb_agg(x) FROM(SELECT brand marca,day dia,hour hora,model,winner->>'channel' canal,count(*)::int pedidos,sum(amount) receita
   FROM public.crm_attribution_order_model_v2 WHERE winner->>'channel' IN ('email','whatsapp') GROUP BY 1,2,3,4,5)x),'[]'::jsonb)
) payload;
