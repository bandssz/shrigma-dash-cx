-- Extend attribution to the existing Olivas operation. Historical two-brand batches remain valid.
-- Coverage is recorded only for the complete brands explicitly present in each scope.
ALTER TABLE public.crm_attribution_order_v2 DROP CONSTRAINT crm_attribution_order_v2_brand_check;
ALTER TABLE public.crm_attribution_order_v2 ADD CONSTRAINT crm_attribution_order_v2_brand_check CHECK(brand IN ('fish','aristo','olivas'));
CREATE OR REPLACE FUNCTION public.crm_attribution_ingest_v2(p_rows jsonb, scope jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE n integer;b text;from_day date;until_day date;read_at timestamptz;rid text;
BEGIN
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>20000
  OR scope->>'complete' IS DISTINCT FROM 'true' OR coalesce(scope->>'mode','') NOT IN ('created','updated')
  OR coalesce(scope->'brands','null'::jsonb) NOT IN ('["aristo","fish"]'::jsonb,'["aristo","fish","olivas"]'::jsonb,'["olivas"]'::jsonb) THEN RAISE EXCEPTION 'ATTRIBUTION_BATCH_INVALID';END IF;
 rid=scope->>'execution_id';read_at=(scope->>'read_at')::timestamptz;
 from_day=(scope->>'coverage_from')::date;until_day=(scope->>'coverage_until')::date;
 IF coalesce(rid,'')='' OR read_at IS NULL OR from_day IS NULL OR until_day IS NULL
  OR from_day>until_day OR until_day>public.hoje_br() OR until_day-from_day>7 THEN RAISE EXCEPTION 'ATTRIBUTION_SCOPE_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM public.crm_attribution_run_v2 WHERE execution_id=rid) THEN RETURN 0;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) x WHERE coalesce(x->>'brand','') NOT IN ('fish','aristo','olivas') OR NOT ((scope->'brands') ? (x->>'brand'))
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
 FOR b IN SELECT jsonb_array_elements_text(scope->'brands') LOOP
  INSERT INTO public.crm_attribution_coverage_v2(brand,day,checked_at,execution_id)
  SELECT b,from_day+i,read_at,rid FROM generate_series(0,until_day-from_day)i
  ON CONFLICT(brand,day) DO UPDATE SET checked_at=EXCLUDED.checked_at,execution_id=EXCLUDED.execution_id
  WHERE EXCLUDED.checked_at>crm_attribution_coverage_v2.checked_at;
 END LOOP;
 RETURN n;
END;$function$;

CREATE OR REPLACE VIEW public.crm_growth_campaign_members_v2 AS
 WITH c AS (
         SELECT c.id,
            c.uuid,
            c.name,
            c.subject,
            c.from_email,
            c.body,
            c.body_source,
            c.altbody,
            c.content_type,
            c.send_at,
            c.headers,
            c.status,
            c.tags,
            c.type,
            c.messenger,
            c.template_id,
            c.to_send,
            c.sent,
            c.max_subscriber_id,
            c.last_subscriber_id,
            c.archive,
            c.archive_slug,
            c.archive_template_id,
            c.archive_meta,
            c.started_at,
            c.created_at,
            c.updated_at,
            c.attribs,
                CASE
                    WHEN (c.from_email ~~* '%oaristocrata.com%'::text) THEN 'aristo'::text
                    WHEN (c.from_email ~~* '%fishermans.com.br%'::text) THEN 'fish'::text
                    WHEN (c.from_email ~~* '%olivasdocampo.com%'::text) THEN 'olivas'::text
                    ELSE NULL::text
                END AS emissor
           FROM campaigns c
          WHERE ((c.status <> 'draft'::campaign_status) AND (COALESCE(c.started_at, c.send_at, c.created_at) >= (now() - '120 days'::interval)))
        ), meta AS (
         SELECT c.id,
            c.uuid,
            c.name,
            c.subject,
            c.from_email,
            c.body,
            c.body_source,
            c.altbody,
            c.content_type,
            c.send_at,
            c.headers,
            c.status,
            c.tags,
            c.type,
            c.messenger,
            c.template_id,
            c.to_send,
            c.sent,
            c.max_subscriber_id,
            c.last_subscriber_id,
            c.archive,
            c.archive_slug,
            c.archive_template_id,
            c.archive_meta,
            c.started_at,
            c.created_at,
            c.updated_at,
            c.attribs,
            c.emissor,
                CASE
                    WHEN ((c.id = 114) AND ((c.tags)::text[] @> ARRAY['desodorante'::text, 'cross'::text])) THEN 'aristo'::text
                    ELSE c.emissor
                END AS marca,
            ( SELECT jsonb_agg(x.*) AS jsonb_agg
                   FROM ( SELECT DISTINCT COALESCE(u.utm_source, ''::text) AS source,
                            COALESCE(u.utm_medium, ''::text) AS medium,
                            COALESCE(u.utm_campaign, ''::text) AS campaign,
                            COALESCE(u.utm_content, ''::text) AS content,
                            COALESCE(u.utm_term, ''::text) AS term
                           FROM crm_campanha_utm u
                          WHERE ((u.campanha_id = c.id) AND (u.canal = 'email'::text) AND ((COALESCE(u.cliques, 0) > 0) OR (NOT (EXISTS ( SELECT 1
                                   FROM crm_growth_campaign_links_v2 current_links
                                  WHERE (current_links.campanha_id = c.id))))))
                        UNION
                         SELECT l.source,
                            l.medium,
                            l.campaign,
                            l.content,
                            l.term
                           FROM crm_growth_campaign_links_v2 l
                          WHERE (l.campanha_id = c.id)) x) AS utms,
            ( SELECT array_agg(DISTINCT l.name ORDER BY l.name) AS array_agg
                   FROM (campaign_lists cl
                     JOIN lists l ON ((l.id = cl.list_id)))
                  WHERE (cl.campaign_id = c.id)) AS segmentos
           FROM c
          WHERE (c.emissor IS NOT NULL)
        )
 SELECT m.marca,
    m.emissor,
    'email'::text AS canal,
    m.id AS campanha_id,
    m.name AS nome,
    (m.status)::text AS status,
        CASE
            WHEN ((m.tags)::text[] @> ARRAY['semana-cliente'::text]) THEN 'semana-do-cliente-2026'::text
            WHEN (((m.tags)::text[] @> ARRAY['desodorante'::text]) OR (m.name ~~* 'DESODORANTE%'::text)) THEN 'desodorante-frescor'::text
            WHEN (( SELECT count(DISTINCT crm_attribution_family_v2(m.marca, (x.value ->> 'campaign'::text))) AS count
               FROM jsonb_array_elements(m.utms) x(value)) = 1) THEN ( SELECT min(crm_attribution_family_v2(m.marca, (x.value ->> 'campaign'::text))) AS min
               FROM jsonb_array_elements(m.utms) x(value))
            ELSE ('dispatch:'::text || (m.id)::text)
        END AS familia,
    m.segmentos,
    m.tags,
    m.utms,
    m.started_at AS enviado_em,
    m.send_at AS agendado_em,
    m.sent AS enviados,
    m.to_send AS publico,
    s.entregues,
    s.abriram,
    s.clicaram,
    s.hard,
    s.complaints,
    s.coletado_em
   FROM (meta m
     LEFT JOIN crm_campanha s ON (((s.marca = m.emissor) AND (s.canal = 'email'::text) AND (s.campanha_id = m.id))));