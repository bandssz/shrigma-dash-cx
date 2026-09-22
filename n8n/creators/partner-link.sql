-- Partner tracking link. Additive over creators/pilot.sql; no payout, no balance, no coupon.
-- Issuing a link is now allowed because persistence to the paid order is measured, not assumed:
-- 18,165 paid orders in 90 days carried a piece-level utm_content from the winning session
-- (78.4% Aristo / 82.6% Fish of orders whose winning session came from a tagged link).
-- The commission VALUE is deliberately absent: the order grain only has net_amount, which is
-- money received minus refunded WITH shipping, and the program pays on products after discounts
-- without shipping. Until the Shopify collector stores line items and refunds, this layer reports
-- attributed orders, never an amount payable.

-- STEP 1 — schema only. Install apart from the functions: the SQL utility returns an empty body
-- when ALTER TABLE and CREATE OR REPLACE FUNCTION travel in the same call.
ALTER TABLE public.crm_partner_program_v1 ADD COLUMN IF NOT EXISTS link_base text;
UPDATE public.crm_partner_program_v1 SET link_base='https://www.oaristocrata.com.br/' WHERE marca='aristo' AND link_base IS NULL;
UPDATE public.crm_partner_program_v1 SET link_base='https://fishermans.com.br/' WHERE marca='fish' AND link_base IS NULL;

CREATE TABLE IF NOT EXISTS public.crm_partner_link_v1(
 ref text PRIMARY KEY CHECK(ref ~ '^p-[0-9a-f]{8}$'),
 candidate_id uuid NOT NULL REFERENCES public.crm_partner_candidate_v1(id),
 marca text NOT NULL REFERENCES public.crm_partner_program_v1(marca),
 state text NOT NULL DEFAULT 'pausado' CHECK(state IN ('pausado','ativo','revogado')),
 version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),actor text NOT NULL
);
-- one live link per partner; a revoked one keeps its ref so past orders stay attributable
CREATE UNIQUE INDEX IF NOT EXISTS crm_partner_link_vigente_v1 ON public.crm_partner_link_v1(candidate_id) WHERE state<>'revogado';
CREATE INDEX IF NOT EXISTS crm_partner_link_marca_v1 ON public.crm_partner_link_v1(marca,state);
REVOKE ALL ON public.crm_partner_link_v1 FROM PUBLIC;

-- No index is added on crm_organico_attribution_order_v2: the SQL utility refuses DDL on the
-- attribution ledger (a plain CREATE INDEX on it returns an empty body and applies nothing, in 0.1s,
-- while the same statement on our own table returns success). That guard is there on purpose and is
-- not worked around. Measured cost without it: the partner slice is a 79.9 ms aggregate over 56k rows,
-- and the whole pilot read is 0.95-1.28 s — the slice is not what makes that payload expensive.

-- STEP 2 — read. Same shape as before plus `links` and `partner_orders`; every previous key kept.
CREATE OR REPLACE FUNCTION public.crm_partner_link_url_v1(brand text,r text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT p.link_base||'?utm_source=parceiro&utm_medium=parceiro-site&utm_campaign='||p.marca||'-parceiros&utm_content='||r
 FROM public.crm_partner_program_v1 p WHERE p.marca=brand AND p.link_base IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.crm_partner_link_read_v1(d1 date,d2 date) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
 RETURN jsonb_build_object(
 'links',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC),'[]') FROM (
   SELECT l.ref,l.candidate_id,l.marca,l.state,l.version,l.created_at,l.updated_at,
    c.name AS candidate_name,c.state AS candidate_state,
    CASE WHEN l.state='ativo' THEN public.crm_partner_link_url_v1(l.marca,l.ref) END AS url
   FROM public.crm_partner_link_v1 l JOIN public.crm_partner_candidate_v1 c ON c.id=l.candidate_id) x),
 -- pedidos atribuídos ao link, pelas mesmas regras do painel: pago, não cancelado, líquido positivo,
 -- último clique em 30 dias. Valor é receita líquida COM frete — não é base de comissão.
 'partner_orders',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.pedidos DESC),'[]') FROM (
   SELECT a.utm_content AS ref,a.marca,count(*)::integer AS pedidos,sum(a.receita_liquida) AS receita_liquida_com_frete,
    min(a.dia) AS primeiro_dia,max(a.dia) AS ultimo_dia
   FROM public.crm_organico_attribution_order_v2 a
   WHERE a.utm_source='parceiro' AND a.model='last_click' AND a.dia BETWEEN d1 AND d2
     AND a.utm_content IN (SELECT ref FROM public.crm_partner_link_v1)
   GROUP BY a.utm_content,a.marca) o),
 'partner_orders_basis','receita_liquida_com_frete',
 'commission_payable',false);
END $$;

CREATE OR REPLACE FUNCTION public.crm_creator_pilot_read_v1(d1 date,d2 date) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF d1 IS NULL OR d2 IS NULL OR d2<d1 OR d2-d1>366 THEN RETURN jsonb_build_object('schema','creator_pilot_v1','erro','Período inválido (máximo 367 dias).'); END IF;
 RETURN jsonb_build_object('schema','creator_pilot_v1','since',d1,'until',d2,
 'programs',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY marca),'[]') FROM public.crm_partner_program_v1 p),
 'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(p)-'actor' ORDER BY updated_at DESC),'[]') FROM public.crm_partner_candidate_v1 p),
 'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('covers_period',s.state='ok' AND s.since<=d1 AND s.until>=d2) ORDER BY marca,account_name),'[]') FROM public.crm_creator_meta_source_v2 s),
 'ads',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY spend DESC),'[]') FROM (
  SELECT x.account_id,x.ad_id,s.marca,s.currency,s.timezone,x.model,
   (array_agg(x.ad_name ORDER BY x.day DESC))[1] AS ad_name,
   (array_agg(x.adset_name ORDER BY x.day DESC))[1] AS adset_name,
   (array_agg(x.campaign_name ORDER BY x.day DESC))[1] AS campaign_name,
   sum(x.spend) AS spend,sum(x.impressions) AS impressions,sum(x.clicks) AS clicks,
   CASE WHEN count(x.purchases)=count(*) THEN sum(x.purchases) END AS purchases,
   CASE WHEN count(x.purchase_value)=count(*) THEN sum(x.purchase_value) END AS purchase_value,
   sum(x.purchases) AS reported_purchases,sum(x.purchase_value) AS reported_purchase_value,
   count(x.purchases)::integer AS purchase_days_reported,count(x.purchase_value)::integer AS value_days_reported,
   count(*)::integer AS observed_days,min(x.day) AS first_day,max(x.day) AS last_day,
   max(x.collected_at) AS collected_at,l.influ,coalesce(l.version,0) AS link_version
  FROM public.crm_creator_meta_day_v2 x JOIN public.crm_creator_meta_source_v2 s USING(account_id)
  LEFT JOIN public.crm_creator_meta_link_v1 l ON l.account_id=x.account_id AND l.ad_id=x.ad_id
  WHERE x.day BETWEEN d1 AND d2 GROUP BY x.account_id,x.ad_id,s.marca,s.currency,s.timezone,x.model,l.influ,l.version
 ) a),'coupon_by_creator',(SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM (SELECT marca,influ,count(*) FILTER(WHERE pago)::integer AS paid_orders,sum(receita_base) FILTER(WHERE pago) AS receita_cupom FROM public.crm_influ_pedido WHERE dia BETWEEN d1 AND d2 AND via='cupom' AND influ IS NOT NULL GROUP BY marca,influ) c),'tracking_active',(SELECT EXISTS(SELECT 1 FROM public.crm_partner_link_v1 WHERE state='ativo')),'payout_active',false)
 || public.crm_partner_link_read_v1(d1,d2);
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_link_url_v1(text,text),public.crm_partner_link_read_v1(date,date) FROM PUBLIC;

-- STEP 3 — write. Same function as pilot.sql plus kind='link'; the candidate and vínculo branches
-- are byte-identical to the version running today (exported and compared before replacing).
CREATE OR REPLACE FUNCTION public.crm_creator_pilot_write_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE op jsonb; actor_id text; rid uuid; clean jsonb; oldop record; data jsonb; kind text; brand text; expected integer; current_version integer; result jsonb; cid uuid; account text; aid text; person text; novo_ref text; ref_atual text; estado text; tentativa integer;
BEGIN
 op:=public.shrigma_panel_operator_v1(p->>'k','influs');
 IF op IS NULL OR NOT (op->'caps' ? 'creators_edit') THEN RETURN jsonb_build_object('erro','Acesso de operação de Creators necessário.'); END IF;
 actor_id:=op->>'who';
 IF coalesce(p->>'request_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Identidade da operação inválida.'); END IF;
 rid:=(p->>'request_id')::uuid;
 IF p->>'acao'='piloto_operacao' THEN
  SELECT response INTO result FROM public.crm_creator_pilot_operation_v1 WHERE actor=actor_id AND request_id=rid;
  RETURN jsonb_build_object('ok',true,'state',CASE WHEN result IS NULL THEN 'not_found' ELSE 'confirmed' END,'receipt',result);
 END IF;
 IF p->>'acao' IS DISTINCT FROM 'piloto_salvar' THEN RETURN jsonb_build_object('erro','Operação inválida.'); END IF;
 clean:=p-'k'-'autor';
 PERFORM pg_advisory_xact_lock(hashtextextended('creator-pilot:'||actor_id||':'||rid,0));
 SELECT * INTO oldop FROM public.crm_creator_pilot_operation_v1 WHERE actor=actor_id AND request_id=rid;
 IF FOUND THEN
  IF oldop.request IS DISTINCT FROM clean THEN RETURN jsonb_build_object('erro','A mesma operação não pode receber dados diferentes.'); END IF;
  RETURN oldop.response;
 END IF;
 kind:=p->>'kind';data:=p->'data';brand:=data->>'marca';
 IF brand IS NULL OR brand NOT IN ('aristo','fish') OR jsonb_typeof(data) IS DISTINCT FROM 'object' OR coalesce(p->>'expected_version','') !~ '^[0-9]{1,8}$' THEN RETURN jsonb_build_object('erro','Marca, dados ou versão inválidos.'); END IF;
 expected:=(p->>'expected_version')::integer;
 IF kind='candidato' THEN
  IF coalesce(data->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR length(trim(coalesce(data->>'name','')))<2 OR length(data->>'name')>120 OR length(coalesce(data->>'handle',''))>120 OR length(coalesce(data->>'note',''))>1000 OR length(coalesce(data->>'source_reference',''))>100 OR coalesce(data->>'source','') NOT IN ('formulario_site','manual') OR coalesce(data->>'state','') NOT IN ('novo','em_analise','aprovado_piloto','pausado','recusado') THEN RETURN jsonb_build_object('erro','Confira nome, origem e situação do candidato.'); END IF;
  cid:=(data->>'id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('creator-candidate:'||cid,0));
  SELECT version INTO current_version FROM public.crm_partner_candidate_v1 WHERE id=cid FOR UPDATE;
  IF coalesce(current_version,0)<>expected THEN RETURN jsonb_build_object('erro','Cadastro mudou. Atualize antes de salvar.'); END IF;
  IF EXISTS(SELECT 1 FROM public.crm_partner_candidate_v1 WHERE id=cid AND marca<>brand) THEN RETURN jsonb_build_object('erro','A marca de um cadastro existente não pode mudar.'); END IF;
  INSERT INTO public.crm_partner_candidate_v1(id,marca,name,handle,source,source_reference,state,note,version,actor)
  VALUES(cid,brand,trim(data->>'name'),coalesce(data->>'handle',''),data->>'source',coalesce(data->>'source_reference',''),data->>'state',coalesce(data->>'note',''),expected+1,actor_id)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,handle=excluded.handle,source=excluded.source,source_reference=excluded.source_reference,state=excluded.state,note=excluded.note,version=excluded.version,actor=excluded.actor,updated_at=now();
  result:=jsonb_build_object('ok',true,'kind',kind,'id',cid,'version',expected+1,'request_id',rid);
 ELSIF kind='vinculo' THEN
  account:=data->>'account_id';aid:=data->>'ad_id';person:=nullif(data->>'influ','');
  IF NOT EXISTS(SELECT 1 FROM public.crm_creator_meta_source_v2 WHERE account_id=account AND marca=brand) OR NOT EXISTS(SELECT 1 FROM public.crm_creator_meta_day_v2 WHERE account_id=account AND ad_id=aid) THEN RETURN jsonb_build_object('erro','Anúncio não pertence à marca consultada.'); END IF;
  IF person IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.crm_influ WHERE marca=brand AND influ=person) THEN RETURN jsonb_build_object('erro','Criador não pertence à marca.'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('creator-link:'||account||':'||aid,0));
  SELECT version INTO current_version FROM public.crm_creator_meta_link_v1 WHERE account_id=account AND ad_id=aid FOR UPDATE;
  IF coalesce(current_version,0)<>expected THEN RETURN jsonb_build_object('erro','Vínculo mudou. Atualize antes de salvar.'); END IF;
  INSERT INTO public.crm_creator_meta_link_v1(account_id,ad_id,marca,influ,version,actor) VALUES(account,aid,brand,person,expected+1,actor_id)
  ON CONFLICT(account_id,ad_id) DO UPDATE SET influ=excluded.influ,version=excluded.version,actor=excluded.actor,updated_at=now();
  result:=jsonb_build_object('ok',true,'kind',kind,'account_id',account,'ad_id',aid,'version',expected+1,'request_id',rid);
 ELSIF kind='link' THEN
  IF coalesce(data->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(data->>'state','') NOT IN ('pausado','ativo','revogado') THEN RETURN jsonb_build_object('erro','Confira o parceiro e a situação do link.'); END IF;
  cid:=(data->>'candidate_id')::uuid;estado:=data->>'state';
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-link:'||cid,0));
  IF NOT EXISTS(SELECT 1 FROM public.crm_partner_candidate_v1 WHERE id=cid AND marca=brand) THEN RETURN jsonb_build_object('erro','Parceiro não pertence à marca consultada.'); END IF;
  SELECT version,ref INTO current_version,ref_atual FROM public.crm_partner_link_v1 WHERE candidate_id=cid AND state<>'revogado' FOR UPDATE;
  IF coalesce(current_version,0)<>expected THEN RETURN jsonb_build_object('erro','Link mudou. Atualize antes de salvar.'); END IF;
  IF ref_atual IS NULL THEN
   IF estado='revogado' THEN RETURN jsonb_build_object('erro','Não há link vigente para revogar.'); END IF;
   -- só parceiro aprovado recebe link; pausado, recusado ou em análise não gera rastreio
   IF NOT EXISTS(SELECT 1 FROM public.crm_partner_candidate_v1 WHERE id=cid AND state='aprovado_piloto') THEN RETURN jsonb_build_object('erro','Só parceiro aprovado no piloto recebe link.'); END IF;
   IF NOT EXISTS(SELECT 1 FROM public.crm_partner_program_v1 WHERE marca=brand AND link_base IS NOT NULL) THEN RETURN jsonb_build_object('erro','A marca não tem endereço de link configurado.'); END IF;
   tentativa:=0;
   LOOP
    tentativa:=tentativa+1;
    novo_ref:='p-'||substr(md5(cid::text||':'||clock_timestamp()::text||':'||tentativa::text),1,8);
    EXIT WHEN NOT EXISTS(SELECT 1 FROM public.crm_partner_link_v1 WHERE ref=novo_ref);
    IF tentativa>=8 THEN RETURN jsonb_build_object('erro','Não foi possível gerar um código único agora.'); END IF;
   END LOOP;
   INSERT INTO public.crm_partner_link_v1(ref,candidate_id,marca,state,version,actor) VALUES(novo_ref,cid,brand,estado,expected+1,actor_id);
   ref_atual:=novo_ref;
  ELSE
   UPDATE public.crm_partner_link_v1 SET state=estado,version=expected+1,actor=actor_id,updated_at=now() WHERE ref=ref_atual;
  END IF;
  result:=jsonb_build_object('ok',true,'kind',kind,'candidate_id',cid,'ref',ref_atual,'state',estado,'version',expected+1,'request_id',rid,
   'url',CASE WHEN estado='ativo' THEN public.crm_partner_link_url_v1(brand,ref_atual) END,'commission_payable',false);
 ELSE RETURN jsonb_build_object('erro','Tipo de edição inválido.'); END IF;
 INSERT INTO public.crm_creator_pilot_operation_v1(actor,request_id,request,response) VALUES(actor_id,rid,clean,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.crm_creator_pilot_write_v1(jsonb) FROM PUBLIC;
