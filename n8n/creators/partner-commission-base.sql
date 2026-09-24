-- Growth: financial snapshots of attributed partner orders. No payout is enabled.
-- Unknown refunds reduce the provisional product base; only explicit refunded shipping/tax is
-- excluded. The former "shipping first" assumption could overstate partial refunds.
CREATE TABLE IF NOT EXISTS public.crm_partner_commission_base_v1(
 marca text NOT NULL REFERENCES public.crm_partner_program_v1(marca), order_id text NOT NULL,
 pedido_nome text NOT NULL DEFAULT '', dia date NOT NULL, moeda text NOT NULL,
 subtotal_apos_descontos numeric NOT NULL CHECK(subtotal_apos_descontos>=0),
 frete numeric NOT NULL DEFAULT 0 CHECK(frete>=0),
 reembolso_total numeric NOT NULL DEFAULT 0 CHECK(reembolso_total>=0),
 reembolso_itens numeric NOT NULL DEFAULT 0 CHECK(reembolso_itens>=0),
 base_elegivel numeric NOT NULL CHECK(base_elegivel>=0), base_exata boolean NOT NULL,
 cancelado boolean NOT NULL DEFAULT false, status_financeiro text NOT NULL DEFAULT '',
 itens_truncados boolean NOT NULL DEFAULT false, coletado_em timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(marca,order_id)
);
-- Idempotent additive migration. Legacy rows stay visible but cannot be called reconciled.
ALTER TABLE public.crm_partner_commission_base_v1
 ADD COLUMN IF NOT EXISTS reembolso_frete numeric NOT NULL DEFAULT 0 CHECK(reembolso_frete>=0),
 ADD COLUMN IF NOT EXISTS reembolso_imposto_itens numeric NOT NULL DEFAULT 0 CHECK(reembolso_imposto_itens>=0),
 ADD COLUMN IF NOT EXISTS reembolso_imposto_frete numeric NOT NULL DEFAULT 0 CHECK(reembolso_imposto_frete>=0),
 ADD COLUMN IF NOT EXISTS impostos_inclusos boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS pedido_teste boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS detalhes_completos boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS fonte_atualizada_em timestamptz,
 ADD COLUMN IF NOT EXISTS itens jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN IF NOT EXISTS fretes jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN IF NOT EXISTS reembolsos jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN IF NOT EXISTS partner_ref text,
 ADD COLUMN IF NOT EXISTS receita_atribuida numeric;
-- Recover ownership only from a unique, registered attribution. Legacy unowned snapshots remain
-- refreshable but never acquire a made-up partner.
UPDATE public.crm_partner_commission_base_v1 b SET partner_ref=a.utm_content,receita_atribuida=a.receita_liquida
FROM public.crm_organico_attribution_order_v2 a
WHERE b.partner_ref IS NULL AND b.marca=a.marca AND b.order_id=a.order_id AND b.dia=a.dia
 AND a.utm_source='parceiro' AND a.model='last_click'
 AND EXISTS(SELECT 1 FROM public.crm_partner_link_v1 l WHERE l.ref=a.utm_content AND l.marca=a.marca)
 AND 1=(SELECT count(*) FROM public.crm_organico_attribution_order_v2 x WHERE x.marca=a.marca AND x.order_id=a.order_id AND x.model='last_click' AND x.utm_source='parceiro');
CREATE INDEX IF NOT EXISTS crm_partner_commission_base_dia_v1 ON public.crm_partner_commission_base_v1(dia,marca);
REVOKE ALL ON public.crm_partner_commission_base_v1 FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.crm_partner_base_attempt_v1(
 marca text NOT NULL REFERENCES public.crm_partner_program_v1(marca),order_id text NOT NULL,
 last_attempt timestamptz NOT NULL,failed boolean NOT NULL,PRIMARY KEY(marca,order_id)
);
REVOKE ALL ON public.crm_partner_base_attempt_v1 FROM PUBLIC;

-- Refresh existing orders too: a later refund must replace yesterday's paid snapshot.
-- Limit each invocation; oldest/missing reads go first so backlog cannot starve old orders.
CREATE OR REPLACE FUNCTION public.crm_partner_base_pendente_v1(d1 date,d2 date) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF d1 IS NULL OR d2 IS NULL OR d2<d1 OR d2-d1>366 THEN RAISE EXCEPTION 'Invalid collection window'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(q) - 'ultima_coleta' ORDER BY q.ultima_coleta NULLS FIRST,q.dia,q.marca,q.order_id),'[]') FROM (
  SELECT a.marca,a.order_id,a.dia,coalesce(t.last_attempt,b.coletado_em) AS ultima_coleta
  FROM (
   SELECT a.marca,a.order_id,a.dia FROM public.crm_organico_attribution_order_v2 a
   WHERE a.utm_source='parceiro' AND a.model='last_click' AND a.dia BETWEEN d1 AND d2
    AND EXISTS(SELECT 1 FROM public.crm_partner_link_v1 l WHERE l.ref=a.utm_content AND l.marca=a.marca)
   UNION
   SELECT b.marca,b.order_id,b.dia FROM public.crm_partner_commission_base_v1 b WHERE b.dia BETWEEN d1 AND d2
  ) a LEFT JOIN public.crm_partner_commission_base_v1 b ON b.marca=a.marca AND b.order_id=a.order_id
  LEFT JOIN public.crm_partner_base_attempt_v1 t ON t.marca=a.marca AND t.order_id=a.order_id
  WHERE b.order_id IS NULL OR b.fonte_atualizada_em IS NULL OR b.coletado_em<now()-interval '24 hours'
  ORDER BY coalesce(t.last_attempt,b.coletado_em) NULLS FIRST,a.dia,a.marca,a.order_id LIMIT 200
 ) q);
END $$;

CREATE OR REPLACE FUNCTION public.crm_partner_base_ingest_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE v jsonb; n integer:=0; changed integer; ignored integer:=0; brand text; k text;
 sub numeric; frete numeric; rtot numeric; ri numeric; rf numeric; ti numeric; tf numeric;
 owner text; revenue numeric; existing record; prod numeric; base numeric; exata boolean; complete boolean; inclusive boolean; collected timestamptz; revision timestamptz;
BEGIN
 IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'rows')>200 THEN RAISE EXCEPTION 'Invalid rows'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'rows') r GROUP BY r->>'marca',r->>'order_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate collector row'; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'rows') LOOP
  brand:=v->>'marca';
  IF brand IS NULL OR brand NOT IN ('aristo','fish') OR coalesce(v->>'order_id','') !~ '^(gid://shopify/Order/)?[0-9]+$'
   OR v->>'moeda' IS DISTINCT FROM 'BRL' OR v->>'dia' IS NULL THEN RAISE EXCEPTION 'Collector row outside scope'; END IF;
  SELECT * INTO existing FROM public.crm_partner_commission_base_v1 b WHERE b.marca=brand AND b.order_id=v->>'order_id';
  SELECT a.utm_content,a.receita_liquida INTO owner,revenue FROM public.crm_organico_attribution_order_v2 a
   JOIN public.crm_partner_link_v1 l ON l.ref=a.utm_content AND l.marca=a.marca
   WHERE a.marca=brand AND a.order_id=v->>'order_id' AND a.dia=(v->>'dia')::date AND a.model='last_click' AND a.utm_source='parceiro';
  IF existing.order_id IS NULL AND owner IS NULL THEN RAISE EXCEPTION 'Order not attributed to a registered partner'; END IF;
  IF existing.order_id IS NOT NULL AND existing.dia IS DISTINCT FROM (v->>'dia')::date THEN RAISE EXCEPTION 'Snapshot day cannot change'; END IF;
  IF existing.partner_ref IS NOT NULL AND owner IS NOT NULL AND existing.partner_ref<>owner THEN RAISE EXCEPTION 'Snapshot partner cannot change'; END IF;
  owner:=coalesce(existing.partner_ref,owner);revenue:=coalesce(existing.receita_atribuida,revenue);
  FOREACH k IN ARRAY ARRAY['subtotal_apos_descontos','frete','reembolso_total','reembolso_itens','reembolso_frete','reembolso_imposto_itens','reembolso_imposto_frete'] LOOP
   IF coalesce(v->>k,'') !~ '^[0-9]+([.][0-9]{1,2})?$' THEN RAISE EXCEPTION 'Invalid financial amount'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['cancelado','itens_truncados','detalhes_completos','impostos_inclusos','pedido_teste'] LOOP
   IF jsonb_typeof(v->k) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Missing financial flag'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['itens','fretes','reembolsos'] LOOP
   IF jsonb_typeof(v->k) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Missing financial detail'; END IF;
  END LOOP;
  collected:=(v->>'coletado_em')::timestamptz;revision:=(v->>'fonte_atualizada_em')::timestamptz;
  IF collected IS NULL OR revision IS NULL OR collected>now()+interval '5 minutes' OR revision>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid snapshot timestamp'; END IF;
  sub:=(v->>'subtotal_apos_descontos')::numeric;frete:=(v->>'frete')::numeric;rtot:=(v->>'reembolso_total')::numeric;
  ri:=(v->>'reembolso_itens')::numeric;rf:=(v->>'reembolso_frete')::numeric;
  ti:=(v->>'reembolso_imposto_itens')::numeric;tf:=(v->>'reembolso_imposto_frete')::numeric;
  inclusive:=(v->>'impostos_inclusos')::boolean;complete:=(v->>'detalhes_completos')::boolean;
  prod:=greatest(ri+CASE WHEN inclusive THEN ti ELSE 0 END,rtot-rf-tf-CASE WHEN inclusive THEN 0 ELSE ti END,0);
  base:=greatest(sub-prod,0);
  exata:=complete AND NOT (v->>'itens_truncados')::boolean AND ri+rf+ti+tf=rtot
   AND sub=(SELECT coalesce(sum((j->>'subtotal_apos_descontos')::numeric),0) FROM jsonb_array_elements(v->'itens') j)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'reembolsos') r
    WHERE (r->>'itens')::numeric+(r->>'frete')::numeric+(r->>'imposto_itens')::numeric+(r->>'imposto_frete')::numeric IS DISTINCT FROM (r->>'transacoes_confirmadas')::numeric)
   AND rtot=(SELECT coalesce(sum((j->>'transacoes_confirmadas')::numeric),0) FROM jsonb_array_elements(v->'reembolsos') j);
  IF (v->>'cancelado')::boolean OR (v->>'pedido_teste')::boolean OR coalesce(v->>'status_financeiro','') NOT IN ('PAID','PARTIALLY_REFUNDED') THEN base:=0; END IF;
  INSERT INTO public.crm_partner_commission_base_v1 AS old(marca,order_id,pedido_nome,dia,moeda,subtotal_apos_descontos,frete,
   reembolso_total,reembolso_itens,reembolso_frete,reembolso_imposto_itens,reembolso_imposto_frete,impostos_inclusos,pedido_teste,
   base_elegivel,base_exata,cancelado,status_financeiro,itens_truncados,detalhes_completos,coletado_em,fonte_atualizada_em,itens,fretes,reembolsos,partner_ref,receita_atribuida)
  VALUES(brand,v->>'order_id',coalesce(v->>'pedido_nome',''),(v->>'dia')::date,'BRL',sub,frete,rtot,ri,rf,ti,tf,inclusive,(v->>'pedido_teste')::boolean,
   base,exata,(v->>'cancelado')::boolean,coalesce(v->>'status_financeiro',''),(v->>'itens_truncados')::boolean,complete,collected,revision,v->'itens',v->'fretes',v->'reembolsos',owner,revenue)
  ON CONFLICT(marca,order_id) DO UPDATE SET pedido_nome=excluded.pedido_nome,dia=excluded.dia,moeda=excluded.moeda,
   subtotal_apos_descontos=excluded.subtotal_apos_descontos,frete=excluded.frete,reembolso_total=excluded.reembolso_total,
   reembolso_itens=excluded.reembolso_itens,reembolso_frete=excluded.reembolso_frete,reembolso_imposto_itens=excluded.reembolso_imposto_itens,
   reembolso_imposto_frete=excluded.reembolso_imposto_frete,impostos_inclusos=excluded.impostos_inclusos,pedido_teste=excluded.pedido_teste,
   base_elegivel=excluded.base_elegivel,base_exata=excluded.base_exata,cancelado=excluded.cancelado,status_financeiro=excluded.status_financeiro,
   itens_truncados=excluded.itens_truncados,detalhes_completos=excluded.detalhes_completos,coletado_em=excluded.coletado_em,
   fonte_atualizada_em=excluded.fonte_atualizada_em,itens=excluded.itens,fretes=excluded.fretes,reembolsos=excluded.reembolsos,
   partner_ref=coalesce(old.partner_ref,excluded.partner_ref),receita_atribuida=coalesce(old.receita_atribuida,excluded.receita_atribuida)
  WHERE old.fonte_atualizada_em IS NULL OR excluded.fonte_atualizada_em>old.fonte_atualizada_em
   OR (excluded.fonte_atualizada_em=old.fonte_atualizada_em AND excluded.coletado_em>old.coletado_em);
  GET DIAGNOSTICS changed=ROW_COUNT;n:=n+changed;ignored:=ignored+(1-changed);
  INSERT INTO public.crm_partner_base_attempt_v1 AS t VALUES(brand,v->>'order_id',collected,false)
   ON CONFLICT(marca,order_id) DO UPDATE SET last_attempt=excluded.last_attempt,failed=false WHERE t.last_attempt<=excluded.last_attempt;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'rows',n,'ignored_older',ignored,'commission_payable',false);
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_base_pendente_v1(date,date),public.crm_partner_base_ingest_v1(jsonb) FROM PUBLIC;

-- Records only identity/time/state; never a provider body or customer data. Failed attempts move
-- behind never-attempted orders, so 200 inaccessible old orders cannot starve newer orders.
CREATE OR REPLACE FUNCTION public.crm_partner_base_failure_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE brand text:=p->>'marca';oid text:=p->>'order_id';
BEGIN
 IF brand IS NULL OR brand NOT IN ('aristo','fish') OR coalesce(oid,'') !~ '^(gid://shopify/Order/)?[0-9]+$' THEN RAISE EXCEPTION 'Failure outside collector scope'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_partner_commission_base_v1 b WHERE b.marca=brand AND b.order_id=oid)
  AND NOT EXISTS(SELECT 1 FROM public.crm_organico_attribution_order_v2 a JOIN public.crm_partner_link_v1 l ON l.ref=a.utm_content AND l.marca=a.marca
   WHERE a.marca=brand AND a.order_id=oid AND a.model='last_click' AND a.utm_source='parceiro') THEN RAISE EXCEPTION 'Failure outside collector scope'; END IF;
 INSERT INTO public.crm_partner_base_attempt_v1 VALUES(brand,oid,clock_timestamp(),true)
 ON CONFLICT(marca,order_id) DO UPDATE SET last_attempt=excluded.last_attempt,failed=true;
 RETURN jsonb_build_object('failed',true,'commission_payable',false);
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_base_failure_v1(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.crm_partner_link_read_v1(d1 date,d2 date) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE taxa numeric;
BEGIN
 SELECT max(rate) INTO taxa FROM public.crm_partner_program_v1;
 RETURN jsonb_build_object(
 'links',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC),'[]') FROM (
  SELECT l.ref,l.candidate_id,l.marca,l.state,l.version,l.created_at,l.updated_at,c.name AS candidate_name,c.state AS candidate_state,
   CASE WHEN l.state='ativo' THEN public.crm_partner_link_url_v1(l.marca,l.ref) END AS url
  FROM public.crm_partner_link_v1 l JOIN public.crm_partner_candidate_v1 c ON c.id=l.candidate_id) x),
 'partner_orders',( SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.pedidos DESC),'[]') FROM (
  SELECT a.utm_content AS ref,a.marca,count(*)::integer AS pedidos,sum(a.receita_liquida) AS receita_liquida_com_frete,
   min(a.dia) AS primeiro_dia,max(a.dia) AS ultimo_dia,count(b.order_id)::integer AS pedidos_com_base,
   count(*) FILTER(WHERE b.order_id IS NULL)::integer AS pedidos_sem_base,
   count(*) FILTER(WHERE b.order_id IS NOT NULL AND (NOT b.base_exata OR NOT b.detalhes_completos))::integer AS pedidos_base_estimada,
   count(*) FILTER(WHERE b.order_id IS NOT NULL AND b.coletado_em<now()-interval '24 hours')::integer AS pedidos_base_desatualizada,
   sum(b.base_elegivel) AS base_elegivel,
   CASE WHEN bool_and(b.order_id IS NOT NULL AND b.base_exata AND b.detalhes_completos AND b.coletado_em>=now()-interval '24 hours')
    THEN round(coalesce(sum(b.base_elegivel),0)*max(p.rate),2) END AS comissao,
   bool_and(b.order_id IS NOT NULL AND b.base_exata AND b.detalhes_completos AND b.coletado_em>=now()-interval '24 hours') AS comissao_fechada
  FROM public.crm_organico_attribution_order_v2 a
  JOIN public.crm_partner_program_v1 p ON p.marca=a.marca
  LEFT JOIN public.crm_partner_commission_base_v1 b ON b.marca=a.marca AND b.order_id=a.order_id
   AND (b.partner_ref IS NULL OR b.partner_ref=a.utm_content)
  WHERE a.utm_source='parceiro' AND a.model='last_click' AND a.dia BETWEEN d1 AND d2
   AND EXISTS(SELECT 1 FROM public.crm_partner_link_v1 l WHERE l.ref=a.utm_content AND l.marca=a.marca)
  GROUP BY a.utm_content,a.marca) o),
 'partner_orders_basis','produtos_apos_descontos_sem_frete_menos_reembolso','commission_rate',taxa,'commission_payable',false);
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_link_read_v1(date,date) FROM PUBLIC;
