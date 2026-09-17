-- Isolate Shopify PIX snapshots by store before joining order IDs.
CREATE OR REPLACE VIEW public.crm_pix_conversao_pedido AS
WITH logs AS (
         SELECT l.brand,
            l.ref,
            min(l.sent_at) AS first_record,
            min(l.sent_at) FILTER (WHERE (NULLIF(l.wamid, ''::text) IS NOT NULL)) AS first_sent,
            count(*) FILTER (WHERE (NULLIF(l.wamid, ''::text) IS NOT NULL)) AS accepted,
            bool_or((EXISTS ( SELECT 1
                   FROM shrigma_wa_status ws
                  WHERE ((ws.wamid = l.wamid) AND (ws.status = ANY (ARRAY['delivered'::text, 'read'::text])))))) AS delivered
           FROM shrigma_send_log l
          WHERE ((l.channel = 'whatsapp'::text) AND (((l.brand = 'fish'::text) AND (l.flow = 'transacional'::text) AND (l.piece = 'pix-15min'::text) AND (l.ref ~ '^[0-9]+$'::text)) OR ((l.brand = 'aristo'::text) AND (l.flow = 'pix'::text) AND (l.piece = ANY (ARRAY['pix-3min'::text, 'pix-vencido'::text])) AND (l.ref ~ '^appmax:[0-9]+$'::text))))
          GROUP BY l.brand, l.ref
        ), tx AS (
         SELECT s.order_id,
            s.checked_at,
            s.available,
            s.complete,
            s.financial_status,
            s.cancelled_at,
            s.currency,
            min(((t.value ->> 'processed_at'::text))::timestamp with time zone) FILTER (WHERE (((t.value ->> 'kind'::text) = 'TIMELINE'::text) AND ((t.value ->> 'action'::text) = ANY (ARRAY['sale_success'::text, 'capture_success'::text])))) AS paid_at,
            sum(
                CASE
                    WHEN ((t.value ->> 'kind'::text) = ANY (ARRAY['SALE'::text, 'CAPTURE'::text])) THEN ((t.value ->> 'amount'::text))::numeric
                    WHEN ((t.value ->> 'kind'::text) = 'REFUND'::text) THEN (- ((t.value ->> 'amount'::text))::numeric)
                    ELSE (0)::numeric
                END) FILTER (WHERE (((t.value ->> 'status'::text) = 'SUCCESS'::text) AND ((t.value ->> 'test'::text) = 'false'::text) AND ((t.value ->> 'currency'::text) = s.currency))) AS net_amount,
            count(*) FILTER (WHERE (((t.value ->> 'status'::text) = 'SUCCESS'::text) AND ((t.value ->> 'kind'::text) = ANY (ARRAY['SALE'::text, 'CAPTURE'::text])) AND ((t.value ->> 'test'::text) = 'false'::text) AND (((t.value ->> 'processed_at'::text) IS NULL) OR ((t.value ->> 'currency'::text) IS DISTINCT FROM s.currency)))) AS ambiguous
           FROM (crm_pix_shopify_snapshot s
             LEFT JOIN LATERAL jsonb_array_elements(s.transactions) t(value) ON (true))
          WHERE s.brand = 'fish'::text
          GROUP BY s.order_id, s.checked_at, s.available, s.complete, s.financial_status, s.cancelled_at, s.currency
        ), ap AS (
         SELECT shrigma_appmax_evento.order_id,
            min(crm_pix_appmax_time((shrigma_appmax_evento.payload #>> '{data,paid_at}'::text[]))) FILTER (WHERE (shrigma_appmax_evento.evento = 'OrderPaidByPix'::text)) AS paid_at,
            max(((shrigma_appmax_evento.payload #>> '{data,full_payment_amount}'::text[]))::numeric) FILTER (WHERE ((shrigma_appmax_evento.evento = 'OrderPaidByPix'::text) AND ((shrigma_appmax_evento.payload #>> '{data,full_payment_amount}'::text[]) ~ '^\d+(\.\d+)?$'::text))) AS amount,
            bool_or((shrigma_appmax_evento.evento = ANY (ARRAY['OrderRefund'::text, 'OrderChargeBack'::text, 'OrderChargeBackInTreatment'::text, 'OrderCanceled'::text]))) AS reversed,
            max(shrigma_appmax_evento.recebido_em) AS checked_at
           FROM shrigma_appmax_evento
          WHERE (shrigma_appmax_evento.brand = 'aristo'::text)
          GROUP BY shrigma_appmax_evento.order_id
        ), joined AS (
         SELECT l.brand,
            l.ref,
            l.first_record,
            l.first_sent,
            l.accepted,
            l.delivered,
                CASE
                    WHEN (l.brand = 'fish'::text) THEN tx.paid_at
                    ELSE ap.paid_at
                END AS paid_at,
                CASE
                    WHEN (l.brand = 'fish'::text) THEN tx.net_amount
                    ELSE ap.amount
                END AS net_amount,
                CASE
                    WHEN (l.brand = 'fish'::text) THEN tx.currency
                    ELSE 'BRL'::text
                END AS currency,
                CASE
                    WHEN (l.brand = 'fish'::text) THEN COALESCE((tx.available AND tx.complete AND (tx.ambiguous = 0) AND ((tx.financial_status <> ALL (ARRAY['PAID'::text, 'PARTIALLY_REFUNDED'::text])) OR (tx.paid_at IS NOT NULL))), false)
                    ELSE (ap.order_id IS NOT NULL)
                END AS checked,
                CASE
                    WHEN (l.brand = 'fish'::text) THEN tx.checked_at
                    ELSE ap.checked_at
                END AS checked_at,
                CASE
                    WHEN (l.brand = 'fish'::text) THEN COALESCE(((tx.cancelled_at IS NOT NULL) OR (tx.financial_status = ANY (ARRAY['REFUNDED'::text, 'VOIDED'::text]))), false)
                    ELSE COALESCE(ap.reversed, false)
                END AS reversed,
                CASE
                    WHEN (l.brand = 'fish'::text) THEN (tx.financial_status = ANY (ARRAY['PAID'::text, 'PARTIALLY_REFUNDED'::text]))
                    ELSE (ap.paid_at IS NOT NULL)
                END AS is_paid
           FROM ((logs l
             LEFT JOIN tx ON (((l.brand = 'fish'::text) AND (tx.order_id = l.ref))))
             LEFT JOIN ap ON (((l.brand = 'aristo'::text) AND (ap.order_id = SUBSTRING(l.ref FROM 8)))))
        )
 SELECT brand,
    ref,
    first_record,
    first_sent,
    accepted,
    delivered,
    paid_at,
    net_amount,
    currency,
    checked,
    checked_at,
    reversed,
    is_paid,
    ((COALESCE(first_sent, first_record) AT TIME ZONE 'America/Sao_Paulo'::text))::date AS dia,
    (((first_sent IS NOT NULL) AND checked AND is_paid AND (NOT reversed) AND (paid_at > first_sent) AND (paid_at <= (first_sent + '7 days'::interval)) AND (net_amount > (0)::numeric)) IS TRUE) AS paid_after,
    ((first_sent IS NOT NULL) AND (now() >= (first_sent + '7 days'::interval))) AS window_closed
   FROM joined;

-- Add explicit tracking quality without changing the configured credit model.
CREATE OR REPLACE VIEW public.crm_attribution_quality_v2 AS
SELECT o.brand AS marca,((o.payload->>'created_at')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date dia,
 count(*)::int pedidos_lidos,count(*) FILTER(WHERE o.payload->>'eligible'='true')::int pagos_elegiveis,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'ready' IS DISTINCT FROM 'true')::int jornada_pendente,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'ready'='true' AND o.payload->>'complete' IS DISTINCT FROM 'true')::int jornada_parcial,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'non_direct_known'='true' AND o.payload#>>'{last_non_direct,channel}' IN ('email','whatsapp'))::int atribuidos_crm,
 sum((o.payload->>'net_amount')::numeric) FILTER(WHERE o.payload->>'eligible'='true') receita_elegivel,
 min(o.checked_at) leitura_mais_antiga,max(o.checked_at) coletado_em,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'strict_known'='true')::int pagos_com_ultima_sessao,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'strict_known' IS DISTINCT FROM 'true')::int pagos_sem_ultima_sessao,
 sum((o.payload->>'net_amount')::numeric) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'strict_known' IS DISTINCT FROM 'true') receita_sem_ultima_sessao,
 count(*) FILTER(WHERE o.payload->>'eligible'='true' AND o.payload->>'non_direct_known' IS DISTINCT FROM 'true')::int pagos_sem_origem_nao_direta
FROM public.crm_attribution_order_v2 o GROUP BY 1,2;

-- Preserve historical same-order association, but separate mature cohorts.
-- This view does not claim an observed click on the native copy-PIX button,
-- a match to the original charge, or incremental impact of the reminder.
CREATE OR REPLACE VIEW public.crm_pix_conversao AS
SELECT brand AS marca,dia,
 count(*) FILTER(WHERE first_sent IS NOT NULL) pedidos_avisados,
 count(*) FILTER(WHERE first_sent IS NULL) pedidos_somente_internos,
 coalesce(sum(accepted),0::numeric) mensagens_aceitas,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND delivered) pedidos_entregues,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND checked) pedidos_consultados,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND NOT checked) sem_leitura_pagamento,
 count(*) FILTER(WHERE paid_after) pagos_apos_aviso,
 coalesce(sum(net_amount) FILTER(WHERE paid_after AND currency='BRL'),0::numeric) valor_pago_brl,
 count(*) FILTER(WHERE paid_after AND currency IS DISTINCT FROM 'BRL') pagos_outra_moeda,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND paid_at<=first_sent) pagos_antes_aviso,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND reversed) cancelados_estornados,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND NOT window_closed) janela_aberta,
 min(checked_at) FILTER(WHERE first_sent IS NOT NULL) leitura_mais_antiga,
 max(checked_at) coletado_em,7 janela_dias,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND window_closed) pedidos_janela_encerrada,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND window_closed AND checked) pedidos_encerrados_consultados,
 count(*) FILTER(WHERE first_sent IS NOT NULL AND window_closed AND checked AND brand='fish' AND checked_at>=first_sent+interval '7 days') pedidos_encerrados_reconsultados,
 count(*) FILTER(WHERE paid_after AND window_closed) pagos_janela_encerrada,
 'mesmo_pedido_7d'::text base_medicao,
 false AS comprova_cobranca_original,
 false AS comprova_incrementalidade,
 CASE WHEN brand='aristo' THEN 'webhook_appmax' ELSE 'shopify_transacoes' END AS fonte_pagamento,
 brand='fish' AS permite_conciliacao_fechamento
FROM public.crm_pix_conversao_pedido GROUP BY brand,dia;
