-- Accepted dispatch cohort, scoped to recorded telemetry intervals. No customer identifiers.
CREATE OR REPLACE VIEW public.shrigma_growth_email_ses_rows_v1 AS
WITH cohort AS (
 SELECT d.dispatch_id,d.brand,d.flow,d.piece,d.started_at
 FROM public.shrigma_email_dispatch d
 WHERE d.is_test=false AND d.transport_state='accepted'
 AND EXISTS(SELECT 1 FROM public.shrigma_email_coverage c
   WHERE c.brand=d.brand AND c.flow=d.flow AND c.piece=d.piece AND c.is_test=false
   AND d.started_at>=c.starts_at AND (c.ends_at IS NULL OR d.started_at<c.ends_at))
), observed AS (
 SELECT d.*,e.* FROM cohort d
 CROSS JOIN LATERAL (
  SELECT coalesce(bool_or(s.status='send'),false) sent,
   coalesce(bool_or(s.status='delivery'),false) delivered,
   coalesce(bool_or(s.status='bounce' AND s.tipo_bounce='Permanent'),false) hard,
   coalesce(bool_or(s.status='bounce' AND s.tipo_bounce='Transient'),false) soft,
   coalesce(bool_or(s.status IN ('reject','rendering_failure')),false) rejected,
   coalesce(bool_or(s.status='bounce' OR s.status IN ('reject','rendering_failure')),false) failed,
   coalesce(bool_or(s.status='complaint' AND coalesce(s.complaint_type,'unknown')<>'not-spam'),false) complained,
   coalesce(bool_or(s.status='delivery_delay'),false) delayed,
   max(s.recebido_em) last_event_at
  FROM public.shrigma_email_status s
  WHERE s.dispatch_id=d.dispatch_id AND s.is_test=false AND s.reconciliation_status='matched'
 ) e
)
SELECT (started_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,brand AS marca,flow,piece,
 count(*) AS aceitos,count(*) FILTER(WHERE sent) AS enviados_ses,
 count(*) FILTER(WHERE delivered) AS entregues,count(*) FILTER(WHERE hard) AS hard,
 count(*) FILTER(WHERE soft) AS soft,count(*) FILTER(WHERE rejected) AS recusados_ses,
 count(*) FILTER(WHERE failed) AS falhas,count(*) FILTER(WHERE complained) AS reclamacoes,
 count(*) FILTER(WHERE delayed) AS atrasos,
 count(*) FILTER(WHERE NOT delivered AND NOT failed) AS sem_confirmacao_final,
 max(last_event_at) AS ultimo_evento_em
FROM observed GROUP BY 1,2,3,4;

CREATE OR REPLACE VIEW public.shrigma_growth_email_ses_payload_v1 AS
SELECT jsonb_build_object('schema_version',1,'generated_at',clock_timestamp(),'timezone','America/Sao_Paulo',
 'rows',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.dia,r.marca,r.flow,r.piece) FROM public.shrigma_growth_email_ses_rows_v1 r),'[]'::jsonb),
 'coverage',coalesce((SELECT jsonb_agg(jsonb_build_object('marca',c.brand,'flow',c.flow,'piece',c.piece,
   'starts_at',c.starts_at,'ends_at',c.ends_at,'state',c.state,'checked_at',c.checked_at,'verified_through',c.verified_through)
   ORDER BY c.brand,c.flow,c.piece,c.starts_at) FROM public.shrigma_email_coverage c WHERE c.is_test=false),'[]'::jsonb)
) AS payload;
