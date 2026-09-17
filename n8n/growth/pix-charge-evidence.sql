CREATE TABLE IF NOT EXISTS public.shrigma_pix_charge_evidence(
 log_id bigint PRIMARY KEY REFERENCES public.shrigma_send_log(id) ON DELETE CASCADE,
 brand text NOT NULL CHECK(brand IN('aristo','fish')),
 ref text NOT NULL,template_id text NOT NULL,
 code_sha256 text NOT NULL CHECK(code_sha256 ~ '^[a-f0-9]{64}$'),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),expires_at timestamptz NOT NULL,
 reference_id text NOT NULL,captured_at timestamptz NOT NULL DEFAULT now(),accepted_at timestamptz
);
REVOKE ALL ON public.shrigma_pix_charge_evidence FROM PUBLIC;

-- Positive Appmax payment proof, keyed by exact EMV fingerprint. A webhook
-- is not a final reconciliation of outstanding payments or future refunds.
CREATE OR REPLACE VIEW public.crm_pix_charge_evidence_v1 AS
WITH paid AS (
 SELECT e.brand,encode(sha256(convert_to(e.payload#>>'{data,pix_emv}','UTF8')),'hex') code_sha256,
  e.order_id,public.crm_pix_appmax_time(e.payload#>>'{data,paid_at}') paid_at,
  CASE WHEN e.payload#>>'{data,full_payment_amount}' ~ '^\d+(\.\d+)?$'
   THEN round((e.payload#>>'{data,full_payment_amount}')::numeric*100)::bigint END amount_cents,
  nullif(e.payload#>>'{data,pix_end_to_end_id}','') end_to_end,
  e.recebido_em
 FROM public.shrigma_appmax_evento e
 WHERE e.evento='OrderPaidByPix' AND nullif(e.payload#>>'{data,pix_emv}','') IS NOT NULL
), matched AS (
 SELECT c.*,l.sent_at,l.wamid,
  p.order_id appmax_order_id,p.paid_at,p.end_to_end,p.recebido_em,
  EXISTS(SELECT 1 FROM shrigma_appmax_evento r WHERE r.brand=c.brand AND r.order_id=p.order_id
   AND r.evento IN('OrderRefund','OrderChargeBack','OrderChargeBackInTreatment','OrderCanceled')) reversed
 FROM public.shrigma_pix_charge_evidence c JOIN public.shrigma_send_log l ON l.id=c.log_id
 LEFT JOIN LATERAL(SELECT p.* FROM paid p WHERE p.brand=c.brand AND p.code_sha256=c.code_sha256
  AND p.amount_cents=c.amount_cents AND p.end_to_end IS NOT NULL
  AND (c.brand<>'aristo' OR c.ref='appmax:'||p.order_id)
  AND p.paid_at>c.accepted_at AND p.paid_at<=c.expires_at
  ORDER BY p.paid_at LIMIT 1)p ON true
)
SELECT *,((paid_at IS NOT NULL AND NOT reversed AND nullif(wamid,'') IS NOT NULL) IS TRUE) paid_original_charge
FROM matched;

CREATE OR REPLACE VIEW public.crm_pix_charge_daily_v1 AS
WITH orders AS (
 SELECT brand,ref,min(sent_at) first_sent,
 bool_or(nullif(wamid,'') IS NOT NULL) accepted,
 bool_or(paid_original_charge) paid_original_charge,
 max(recebido_em) received_at
 FROM public.crm_pix_charge_evidence_v1 GROUP BY brand,ref
)
SELECT brand marca,(first_sent AT TIME ZONE 'America/Sao_Paulo')::date dia,
 count(*) FILTER(WHERE accepted)::int pedidos_com_cobranca_registrada,
 count(*) FILTER(WHERE paid_original_charge)::int pedidos_cobranca_original_paga,
 count(*) FILTER(WHERE accepted AND NOT paid_original_charge)::int sem_confirmacao_cobranca,
 max(received_at) ultimo_evento_pagamento,
 false AS comprova_incrementalidade,false AS conciliacao_final
FROM orders GROUP BY 1,2;
REVOKE ALL ON public.crm_pix_charge_evidence_v1,public.crm_pix_charge_daily_v1 FROM PUBLIC;
