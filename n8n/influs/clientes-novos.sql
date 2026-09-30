-- Clientes novos por creator (30/09/2026). Base do CAC por cliente novo do painel Influs.
-- Novo = o pedido pago do cupom é o 1º pedido daquele cliente na loja (customer_order_index = 1),
-- como o ledger de atribuição da Shopify já grava (crm_attribution_order_v2.payload).
-- Pedido que não está no ledger, ou sem índice, fica em sem_indice: não vira novo nem recompra.
-- Mesmo grão e mesmo filtro dos pedidos do crm_influ_roi (pago, dia no período, por creator).
-- Só leitura. Idempotente.
CREATE OR REPLACE FUNCTION public.crm_influ_clientes_v1(p_ini date, p_fim date)
RETURNS TABLE(marca text, influ text, pedidos integer, novos integer, recorrentes integer, sem_indice integer)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH p AS (
    SELECT p.marca, p.influ, p.order_id,
      CASE WHEN o.payload->>'customer_order_index' ~ '^[0-9]+$' THEN (o.payload->>'customer_order_index')::int END AS idx
    FROM public.crm_influ_pedido p
    LEFT JOIN public.crm_attribution_order_v2 o
      ON o.brand = p.marca AND o.order_id = 'gid://shopify/Order/' || p.order_id
    WHERE p.pago AND p.influ IS NOT NULL AND p.dia BETWEEN p_ini AND p_fim
  )
  SELECT marca, influ,
    count(*)::int,
    count(*) FILTER (WHERE idx = 1)::int,
    count(*) FILTER (WHERE idx > 1)::int,
    count(*) FILTER (WHERE idx IS NULL OR idx < 1)::int
  FROM p GROUP BY 1, 2
$fn$;

REVOKE ALL ON FUNCTION public.crm_influ_clientes_v1(date, date) FROM PUBLIC;
