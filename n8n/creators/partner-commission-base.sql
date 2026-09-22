-- Commission base for partner orders. Additive; touches no existing table.
--
-- WHY THIS EXISTS AND WHY IT IS NOT currentSubtotalPriceSet
-- The program pays 7% of products after discounts, excluding shipping, with refunds reducing the
-- base. The obvious candidate, currentSubtotalPriceSet, was tested against real refunded orders and
-- FAILS: order #46978 is fully REFUNDED (R$ 47.10 = 34.90 products + 12.20 shipping) and still
-- reports currentSubtotalPriceSet = 34.90 with currentQuantity unchanged, because the money was
-- refunded without a return. F30536 behaves the same. That field tracks returns and cancellations,
-- not refunds, so paying on it would pay commission on money that went back to the customer.
--
-- refundLineItems is exact when present, but on those same two orders it is EMPTY: the refund was
-- recorded as an order adjustment. So neither field alone is enough, and the base is computed as:
--
--   reembolso_produtos = max(reembolso_itens, reembolso_total - frete)   -- refunds hit shipping first
--   base_elegivel      = max(0, subtotal_apos_descontos - reembolso_produtos)
--
-- Checked against every refunded order of both brands: #71083, #43421, #15873, #2580, F30519,
-- F26587, F26585, F26579 (itemized) and #46978, F30536 (adjustment-only) all reach base 0, which is
-- correct — they were fully refunded. The formula never overpays; when a refund is not fully
-- itemized it can only understate. base_exata records which of the two cases produced the number,
-- so a partner disputing a value can be answered with the truth instead of a guess.

CREATE TABLE IF NOT EXISTS public.crm_partner_commission_base_v1(
 marca text NOT NULL REFERENCES public.crm_partner_program_v1(marca),
 order_id text NOT NULL,
 pedido_nome text NOT NULL DEFAULT '',
 dia date NOT NULL,
 moeda text NOT NULL,
 subtotal_apos_descontos numeric NOT NULL CHECK(subtotal_apos_descontos>=0),
 frete numeric NOT NULL DEFAULT 0 CHECK(frete>=0),
 reembolso_total numeric NOT NULL DEFAULT 0 CHECK(reembolso_total>=0),
 reembolso_itens numeric NOT NULL DEFAULT 0 CHECK(reembolso_itens>=0),
 base_elegivel numeric NOT NULL CHECK(base_elegivel>=0),
 base_exata boolean NOT NULL,
 cancelado boolean NOT NULL DEFAULT false,
 status_financeiro text NOT NULL DEFAULT '',
 itens_truncados boolean NOT NULL DEFAULT false,
 coletado_em timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(marca,order_id)
);
CREATE INDEX IF NOT EXISTS crm_partner_commission_base_dia_v1 ON public.crm_partner_commission_base_v1(dia,marca);
REVOKE ALL ON public.crm_partner_commission_base_v1 FROM PUBLIC;

-- Which partner orders still have no base row. The collector reads exactly this and nothing else,
-- so it never walks the whole store: only orders a partner link actually brought in.
CREATE OR REPLACE FUNCTION public.crm_partner_base_pendente_v1(d1 date,d2 date) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('marca',a.marca,'order_id',a.order_id,'dia',a.dia) ORDER BY a.dia DESC),'[]')
 FROM public.crm_organico_attribution_order_v2 a
 WHERE a.utm_source='parceiro' AND a.model='last_click' AND a.dia BETWEEN d1 AND d2
   AND a.utm_content IN (SELECT ref FROM public.crm_partner_link_v1)
   AND NOT EXISTS(SELECT 1 FROM public.crm_partner_commission_base_v1 b WHERE b.marca=a.marca AND b.order_id=a.order_id)
$$;

-- Collector entry point. Never a browser action. One order per row, replaced in place; an older
-- reading never overwrites a newer one.
CREATE OR REPLACE FUNCTION public.crm_partner_base_ingest_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE v jsonb; n integer:=0; brand text; sub numeric; frete numeric; rtot numeric; ritens numeric; prod numeric; base numeric; exata boolean;
BEGIN
 IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid rows'; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'rows') LOOP
  brand:=v->>'marca';
  IF brand NOT IN ('aristo','fish') OR coalesce(v->>'order_id','')='' OR (v->>'dia') IS NULL OR coalesce(v->>'moeda','')='' THEN RAISE EXCEPTION 'Collector row outside scope'; END IF;
  sub:=greatest(coalesce((v->>'subtotal_apos_descontos')::numeric,0),0);
  frete:=greatest(coalesce((v->>'frete')::numeric,0),0);
  rtot:=greatest(coalesce((v->>'reembolso_total')::numeric,0),0);
  ritens:=greatest(coalesce((v->>'reembolso_itens')::numeric,0),0);
  -- reembolso atinge o frete primeiro; o que passar disso saiu de produto
  prod:=greatest(ritens,rtot-frete,0);
  base:=greatest(sub-prod,0);
  -- exata quando não houve reembolso, ou quando o reembolso está inteiramente itemizado
  exata:=(rtot=0) OR (abs((ritens+least(rtot,frete))-rtot)<0.01);
  IF coalesce((v->>'cancelado')::boolean,false) THEN base:=0; END IF;
  INSERT INTO public.crm_partner_commission_base_v1(marca,order_id,pedido_nome,dia,moeda,subtotal_apos_descontos,frete,
    reembolso_total,reembolso_itens,base_elegivel,base_exata,cancelado,status_financeiro,itens_truncados,coletado_em)
  VALUES(brand,v->>'order_id',coalesce(v->>'pedido_nome',''),(v->>'dia')::date,v->>'moeda',sub,frete,rtot,ritens,base,exata,
    coalesce((v->>'cancelado')::boolean,false),coalesce(v->>'status_financeiro',''),coalesce((v->>'itens_truncados')::boolean,false),now())
  ON CONFLICT(marca,order_id) DO UPDATE SET pedido_nome=excluded.pedido_nome,dia=excluded.dia,moeda=excluded.moeda,
    subtotal_apos_descontos=excluded.subtotal_apos_descontos,frete=excluded.frete,reembolso_total=excluded.reembolso_total,
    reembolso_itens=excluded.reembolso_itens,base_elegivel=excluded.base_elegivel,base_exata=excluded.base_exata,
    cancelado=excluded.cancelado,status_financeiro=excluded.status_financeiro,itens_truncados=excluded.itens_truncados,
    coletado_em=excluded.coletado_em
  WHERE public.crm_partner_commission_base_v1.coletado_em<=excluded.coletado_em;
  n:=n+1;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'rows',n);
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_base_pendente_v1(date,date),public.crm_partner_base_ingest_v1(jsonb) FROM PUBLIC;

-- Read: the commission per partner, and — just as important — what is still missing before it can
-- be paid. A partner whose orders are not all collected shows the gap instead of a smaller number.
CREATE OR REPLACE FUNCTION public.crm_partner_link_read_v1(d1 date,d2 date) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE taxa numeric;
BEGIN
 SELECT max(rate) INTO taxa FROM public.crm_partner_program_v1;
 RETURN jsonb_build_object(
 'links',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC),'[]') FROM (
   SELECT l.ref,l.candidate_id,l.marca,l.state,l.version,l.created_at,l.updated_at,
    c.name AS candidate_name,c.state AS candidate_state,
    CASE WHEN l.state='ativo' THEN public.crm_partner_link_url_v1(l.marca,l.ref) END AS url
   FROM public.crm_partner_link_v1 l JOIN public.crm_partner_candidate_v1 c ON c.id=l.candidate_id) x),
 'partner_orders',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.pedidos DESC),'[]') FROM (
   SELECT a.utm_content AS ref,a.marca,count(*)::integer AS pedidos,sum(a.receita_liquida) AS receita_liquida_com_frete,
    min(a.dia) AS primeiro_dia,max(a.dia) AS ultimo_dia,
    count(b.order_id)::integer AS pedidos_com_base,
    count(*) FILTER(WHERE b.order_id IS NULL)::integer AS pedidos_sem_base,
    count(*) FILTER(WHERE b.order_id IS NOT NULL AND NOT b.base_exata)::integer AS pedidos_base_estimada,
    sum(b.base_elegivel) AS base_elegivel,
    CASE WHEN count(*) FILTER(WHERE b.order_id IS NULL)=0
      THEN round(coalesce(sum(b.base_elegivel),0)*taxa,2) END AS comissao,
    count(*) FILTER(WHERE b.order_id IS NULL)=0 AS comissao_fechada
   FROM public.crm_organico_attribution_order_v2 a
   LEFT JOIN public.crm_partner_commission_base_v1 b ON b.marca=a.marca AND b.order_id=a.order_id
   WHERE a.utm_source='parceiro' AND a.model='last_click' AND a.dia BETWEEN d1 AND d2
     AND a.utm_content IN (SELECT ref FROM public.crm_partner_link_v1)
   GROUP BY a.utm_content,a.marca) o),
 'partner_orders_basis','produtos_apos_descontos_sem_frete_menos_reembolso',
 'commission_rate',taxa,
 -- pagamento continua desligado: valor calculado não é ordem de pagamento
 'commission_payable',false);
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_link_read_v1(date,date) FROM PUBLIC;
