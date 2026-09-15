-- Current operational health is independent of the historical dashboard date filter.
CREATE TABLE IF NOT EXISTS public.shrigma_email_consumer_health (
 key text PRIMARY KEY CHECK(key='ses-events'),last_poll_ok_at timestamptz,
 last_poll_count integer,last_error_at timestamptz,last_error_code text,
 queue_checked_at timestamptz,queue_visible integer,queue_inflight integer,queue_delayed integer,queue_error_at timestamptz
);
CREATE OR REPLACE FUNCTION public.shrigma_email_consumer_poll(r jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE x jsonb=r;
BEGIN
 IF jsonb_typeof(r->'data')='string' THEN x=(r->>'data')::jsonb;END IF;
 IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR x ? '__type' OR x ? 'Error'
 OR (x ? 'Messages' AND jsonb_typeof(x->'Messages') IS DISTINCT FROM 'array') THEN RAISE EXCEPTION 'SQS_RESPONSE_INVALID';END IF;
 INSERT INTO public.shrigma_email_consumer_health(key,last_poll_ok_at,last_poll_count)
 VALUES('ses-events',clock_timestamp(),jsonb_array_length(coalesce(x->'Messages','[]')))
 ON CONFLICT(key) DO UPDATE SET last_poll_ok_at=excluded.last_poll_ok_at,last_poll_count=excluded.last_poll_count;
 RETURN r;
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_email_consumer_poll(jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.shrigma_email_consumer_error(r jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
BEGIN
 INSERT INTO public.shrigma_email_consumer_health(key,last_error_at,last_error_code)
 VALUES('ses-events',clock_timestamp(),CASE WHEN r->>'error_code' ~ '^[A-Z_]{1,80}$' THEN r->>'error_code' ELSE 'UNCLASSIFIED_RUNTIME_ERROR' END)
 ON CONFLICT(key) DO UPDATE SET last_error_at=excluded.last_error_at,last_error_code=excluded.last_error_code;
 RETURN r;
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_email_consumer_error(jsonb) FROM PUBLIC;
CREATE OR REPLACE VIEW public.shrigma_growth_email_ses_health_v1 AS
WITH recent AS (
 SELECT d.*,
 EXISTS(SELECT 1 FROM public.shrigma_email_status s WHERE s.dispatch_id=d.dispatch_id AND NOT s.is_test AND s.reconciliation_status='matched' AND s.status='delivery') delivered,
 EXISTS(SELECT 1 FROM public.shrigma_email_status s WHERE s.dispatch_id=d.dispatch_id AND NOT s.is_test AND s.reconciliation_status='matched' AND s.status IN ('bounce','reject','rendering_failure')) failed,
 EXISTS(SELECT 1 FROM public.shrigma_email_status s WHERE s.dispatch_id=d.dispatch_id AND NOT s.is_test AND s.reconciliation_status='matched' AND s.status='complaint' AND coalesce(s.complaint_type,'unknown')<>'not-spam') complained
 FROM public.shrigma_email_dispatch d WHERE NOT d.is_test AND d.brand IN ('fish','aristo')
 AND (d.started_at>now()-interval '24 hours' OR d.transport_state IN ('in_flight','outcome_unknown'))
 AND EXISTS(SELECT 1 FROM public.shrigma_email_coverage c WHERE c.brand=d.brand AND c.flow=d.flow AND c.piece=d.piece AND NOT c.is_test AND d.started_at>=c.starts_at AND (c.ends_at IS NULL OR d.started_at<c.ends_at))
), brands AS (
 SELECT brand marca,count(*) FILTER(WHERE transport_state='in_flight' AND started_at<now()-interval '15 minutes') finalizacao_pendente,
 count(*) FILTER(WHERE transport_state IN ('in_flight','outcome_unknown') AND delivered) entregue_sem_gravacao,
 count(*) FILTER(WHERE transport_state='outcome_unknown') resultado_incerto,
 count(*) FILTER(WHERE transport_state='accepted' AND started_at<now()-interval '15 minutes' AND NOT delivered AND NOT failed) sem_confirmacao_15min,
 count(*) FILTER(WHERE started_at>now()-interval '24 hours' AND (failed OR transport_state='rejected')) falhas_24h,
 count(*) FILTER(WHERE started_at>now()-interval '24 hours' AND complained) reclamacoes_24h
 FROM recent GROUP BY brand
)
SELECT jsonb_build_object('schema_version',1,'checked_at',clock_timestamp(),
 'collector',jsonb_build_object('last_poll_ok_at',h.last_poll_ok_at,'last_poll_count',h.last_poll_count,'last_error_at',h.last_error_at,'last_error_code',h.last_error_code),
 'queue',jsonb_build_object('checked_at',h.queue_checked_at,'visible',h.queue_visible,'inflight',h.queue_inflight,'delayed',h.queue_delayed,'error_at',h.queue_error_at),
 'pending_ingest_15min',(SELECT count(*) FROM public.shrigma_email_event_ingest WHERE result='pending' AND received_at<now()-interval '15 minutes'),
 'conflicts',(SELECT count(*) FROM public.shrigma_email_status WHERE NOT is_test AND reconciliation_status='conflict'),
 'brands',(SELECT jsonb_agg(jsonb_build_object('marca',b.marca,'finalizacao_pendente',coalesce(r.finalizacao_pendente,0),'entregue_sem_gravacao',coalesce(r.entregue_sem_gravacao,0),'resultado_incerto',coalesce(r.resultado_incerto,0),'sem_confirmacao_15min',coalesce(r.sem_confirmacao_15min,0),'falhas_24h',coalesce(r.falhas_24h,0),'reclamacoes_24h',coalesce(r.reclamacoes_24h,0))) FROM (VALUES ('fish'),('aristo')) b(marca) LEFT JOIN brands r USING(marca))) payload
FROM (SELECT 1) one LEFT JOIN public.shrigma_email_consumer_health h ON h.key='ses-events';
