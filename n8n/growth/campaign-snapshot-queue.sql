-- CRM-22: refresh only the state of never-sent Growth snapshots.
-- Keep every row, its attribution and recorded metrics; never write to native campaigns.
-- The patcher supplies the collector's unchanged brand expression.
WITH native_state AS (
  SELECT c.id, c.status::text AS status, c.sent, c.started_at, c.send_at,
         /* CURRENT_BRAND_EXPRESSION */ AS marca
  FROM public.campaigns c
  WHERE EXISTS (
    SELECT 1 FROM public.crm_campanha s
    WHERE s.marca IN ('fish','aristo') AND s.canal='email'
      AND s.tipo IN ('agendada','rascunho','pausada','cancelada','indisponivel')
      AND s.enviados=0 AND s.campanha_id=c.id
  )
), state AS (
  SELECT s.marca, s.canal, s.campanha_id, n.send_at,
    CASE
      WHEN n.id IS NULL OR n.marca IS DISTINCT FROM s.marca THEN 'indisponivel'
      WHEN n.started_at IS NOT NULL OR n.sent IS DISTINCT FROM 0 THEN 'indisponivel'
      WHEN n.status='draft' THEN 'rascunho'
      WHEN n.status='paused' THEN 'pausada'
      WHEN n.status IN ('cancelled','canceled') THEN 'cancelada'
      WHEN n.status='scheduled' AND n.send_at IS NOT NULL THEN 'agendada'
      ELSE 'indisponivel'
    END AS tipo
  FROM public.crm_campanha s
  LEFT JOIN native_state n ON n.id=s.campanha_id
  WHERE s.marca IN ('fish','aristo') AND s.canal='email'
    AND s.tipo IN ('agendada','rascunho','pausada','cancelada','indisponivel')
    AND s.enviados=0
)
UPDATE public.crm_campanha s
SET tipo=t.tipo,
    enviado_em=CASE WHEN t.tipo='agendada' THEN t.send_at ELSE s.enviado_em END,
    coletado_em=now()
FROM state t
WHERE s.marca=t.marca AND s.canal=t.canal AND s.campanha_id=t.campanha_id;
