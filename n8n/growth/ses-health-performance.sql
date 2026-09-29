-- Growth read-only health query: no transport, data or permission change.
DO $health_performance$
DECLARE previous text;
BEGIN
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 PERFORM pg_catalog.set_config('search_path','pg_catalog,public',true);
 IF pg_catalog.to_regclass('public.shrigma_growth_email_ses_health_v1') IS NULL THEN RAISE EXCEPTION 'SES_HEALTH_VIEW_MISSING'; END IF;
 -- Acquire the view's normal read lock without evaluating its payload. It lasts
 -- through this transaction, preventing DDL drift between hash check and replace;
 -- underlying source tables only receive read locks, compatible with writes.
 PERFORM 1 FROM public.shrigma_growth_email_ses_health_v1 LIMIT 0;
 SELECT pg_catalog.pg_get_viewdef('public.shrigma_growth_email_ses_health_v1'::regclass,true) INTO previous;
 IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(previous,'UTF8')),'hex') IS DISTINCT FROM '039880495056b8e0d52ccdee53d42e47d852a5fc3e9f903ee427736d8075e260' THEN
  RAISE EXCEPTION 'SES_HEALTH_SOURCE_DRIFT';
 END IF;
 EXECUTE $health_view$CREATE OR REPLACE VIEW public.shrigma_growth_email_ses_health_v1 AS WITH candidates AS MATERIALIZED (
 SELECT d.dispatch_id, d.brand, d.flow, d.piece, d.configuration_set, d.transport_state, d.started_at
 FROM shrigma_email_dispatch d
          WHERE NOT d.is_test AND (d.brand = ANY (ARRAY['fish'::text, 'aristo'::text, 'olivas'::text])) AND (d.started_at > (now() - '24:00:00'::interval) OR (d.transport_state = ANY (ARRAY['in_flight'::text, 'outcome_unknown'::text])))
), recent AS (
 SELECT d.brand, d.configuration_set, d.transport_state, d.started_at,
 (EXISTS ( SELECT 1
                   FROM shrigma_email_status s
                  WHERE s.dispatch_id = d.dispatch_id AND NOT s.is_test AND s.reconciliation_status = 'matched'::text AND s.status = 'delivery'::text)) AS delivered,
            (EXISTS ( SELECT 1
                   FROM shrigma_email_status s
                  WHERE s.dispatch_id = d.dispatch_id AND NOT s.is_test AND s.reconciliation_status = 'matched'::text AND (s.status = ANY (ARRAY['bounce'::text, 'reject'::text, 'rendering_failure'::text])))) AS failed,
            (EXISTS ( SELECT 1
                   FROM shrigma_email_status s
                  WHERE s.dispatch_id = d.dispatch_id AND NOT s.is_test AND s.reconciliation_status = 'matched'::text AND s.status = 'complaint'::text AND COALESCE(s.complaint_type, 'unknown'::text) <> 'not-spam'::text)) AS complained
           FROM candidates d
 WHERE (d.brand = 'olivas'::text AND d.configuration_set = 'unconfigured'::text OR (EXISTS ( SELECT 1
                   FROM shrigma_email_coverage c
                  WHERE c.brand = d.brand AND c.flow = d.flow AND c.piece = d.piece AND NOT c.is_test AND d.started_at >= c.starts_at AND (c.ends_at IS NULL OR d.started_at < c.ends_at))))
        ), brands AS (
         SELECT recent.brand AS marca,
            count(*) FILTER (WHERE recent.transport_state = 'in_flight'::text AND recent.started_at < (now() - '00:15:00'::interval)) AS finalizacao_pendente,
            count(*) FILTER (WHERE (recent.transport_state = ANY (ARRAY['in_flight'::text, 'outcome_unknown'::text])) AND recent.delivered) AS entregue_sem_gravacao,
            count(*) FILTER (WHERE recent.transport_state = 'outcome_unknown'::text) AS resultado_incerto,
            count(*) FILTER (WHERE recent.configuration_set <> 'unconfigured'::text AND recent.transport_state = 'accepted'::text AND recent.started_at < (now() - '00:15:00'::interval) AND NOT recent.delivered AND NOT recent.failed) AS sem_confirmacao_15min,
            count(*) FILTER (WHERE recent.started_at > (now() - '24:00:00'::interval) AND (recent.failed OR recent.transport_state = 'rejected'::text)) AS falhas_24h,
            count(*) FILTER (WHERE recent.started_at > (now() - '24:00:00'::interval) AND recent.complained) AS reclamacoes_24h
           FROM recent
          GROUP BY recent.brand
        )
 SELECT jsonb_build_object('schema_version', 1, 'checked_at', clock_timestamp(), 'collector', jsonb_build_object('last_poll_ok_at', h.last_poll_ok_at, 'last_poll_count', h.last_poll_count, 'last_error_at', h.last_error_at, 'last_error_code', h.last_error_code), 'queue', jsonb_build_object('checked_at', h.queue_checked_at, 'visible', h.queue_visible, 'inflight', h.queue_inflight, 'delayed', h.queue_delayed, 'error_at', h.queue_error_at), 'pending_ingest_15min', ( SELECT count(*) AS count
           FROM shrigma_email_event_ingest
          WHERE shrigma_email_event_ingest.result = 'pending'::text AND shrigma_email_event_ingest.received_at < (now() - '00:15:00'::interval)), 'conflicts', ( SELECT count(*) AS count
           FROM shrigma_email_status
          WHERE NOT shrigma_email_status.is_test AND shrigma_email_status.reconciliation_status = 'conflict'::text), 'brands', ( SELECT jsonb_agg(jsonb_build_object('marca', b.marca, 'finalizacao_pendente', COALESCE(r.finalizacao_pendente, 0::bigint), 'entregue_sem_gravacao', COALESCE(r.entregue_sem_gravacao, 0::bigint), 'resultado_incerto', COALESCE(r.resultado_incerto, 0::bigint), 'sem_confirmacao_15min', COALESCE(r.sem_confirmacao_15min, 0::bigint), 'falhas_24h', COALESCE(r.falhas_24h, 0::bigint), 'reclamacoes_24h', COALESCE(r.reclamacoes_24h, 0::bigint)) ORDER BY CASE b.marca WHEN 'fish'::text THEN 0 WHEN 'aristo'::text THEN 1 ELSE 2 END) AS jsonb_agg
           FROM ( VALUES ('fish'::text), ('aristo'::text), ('olivas'::text)) b(marca)
             LEFT JOIN brands r USING (marca))) AS payload
   FROM ( SELECT 1 AS "?column?") one
     LEFT JOIN shrigma_email_consumer_health h ON h.key = 'ses-events'::text;$health_view$;
END $health_performance$;
