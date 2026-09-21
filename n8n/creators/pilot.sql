-- Internal pilot. No storefront tracking, payable balance, payout or campaign write.
CREATE TABLE IF NOT EXISTS public.crm_partner_program_v1(
 marca text PRIMARY KEY CHECK(marca IN ('aristo','fish')),
 rate numeric NOT NULL DEFAULT 0.07 CHECK(rate=0.07),
 basis text NOT NULL DEFAULT 'produtos_apos_descontos_sem_frete_cancelados_estornos',
 payment_day integer NOT NULL DEFAULT 5 CHECK(payment_day=5),
 state text NOT NULL DEFAULT 'piloto_interno' CHECK(state='piloto_interno'),
 minimum_withdrawal numeric CHECK(minimum_withdrawal>=0),
 daily_limit numeric CHECK(daily_limit>=0),
 version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.crm_partner_program_v1(marca) VALUES('aristo'),('fish') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.crm_partner_candidate_v1(
 id uuid PRIMARY KEY,marca text NOT NULL REFERENCES public.crm_partner_program_v1(marca),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120),handle text NOT NULL DEFAULT '' CHECK(length(handle)<=120),
 source text NOT NULL CHECK(source IN ('formulario_site','manual')),
 source_reference text NOT NULL DEFAULT '' CHECK(length(source_reference)<=100),
 state text NOT NULL CHECK(state IN ('novo','em_analise','aprovado_piloto','pausado','recusado')),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
 version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),actor text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.crm_creator_meta_source_v1(
 account_id text PRIMARY KEY CHECK(account_id ~ '^[0-9]+$'),marca text NOT NULL CHECK(marca IN ('aristo','fish')),
 account_name text NOT NULL,currency text NOT NULL,timezone text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ok','error','partial')),
 since date,until date,last_success timestamptz,last_attempt timestamptz,error text,
 collection_mode text NOT NULL DEFAULT 'manual_pilot',rows_count integer
);
CREATE TABLE IF NOT EXISTS public.crm_creator_meta_day_v1(
 account_id text NOT NULL REFERENCES public.crm_creator_meta_source_v1(account_id),ad_id text NOT NULL CHECK(ad_id ~ '^[0-9]+$'),
 day date NOT NULL,ad_name text NOT NULL,adset_name text NOT NULL,campaign_name text NOT NULL,
 model text NOT NULL CHECK(model='7d_click_conversion'),
 spend numeric NOT NULL CHECK(spend>=0),impressions bigint NOT NULL CHECK(impressions>=0),clicks bigint NOT NULL CHECK(clicks>=0),
 purchases numeric CHECK(purchases>=0),purchase_value numeric CHECK(purchase_value>=0),
 collected_at timestamptz NOT NULL,PRIMARY KEY(account_id,ad_id,day,model)
);
CREATE INDEX IF NOT EXISTS crm_creator_meta_day_window_v1 ON public.crm_creator_meta_day_v1(day,account_id);
CREATE TABLE IF NOT EXISTS public.crm_creator_meta_link_v1(
 account_id text NOT NULL REFERENCES public.crm_creator_meta_source_v1(account_id),ad_id text NOT NULL,
 marca text NOT NULL,influ text,version integer NOT NULL,actor text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,ad_id),FOREIGN KEY(marca,influ) REFERENCES public.crm_influ(marca,influ)
);
CREATE TABLE IF NOT EXISTS public.crm_creator_pilot_operation_v1(
 actor text NOT NULL,request_id uuid NOT NULL,request jsonb NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor,request_id)
);
REVOKE ALL ON public.crm_partner_program_v1,public.crm_partner_candidate_v1,public.crm_creator_meta_source_v1,public.crm_creator_meta_day_v1,public.crm_creator_meta_link_v1,public.crm_creator_pilot_operation_v1 FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.crm_creator_pilot_read_v1(d1 date,d2 date) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF d1 IS NULL OR d2 IS NULL OR d2<d1 OR d2-d1>366 THEN RETURN jsonb_build_object('schema','creator_pilot_v1','erro','Período inválido (máximo 367 dias).'); END IF;
 RETURN jsonb_build_object('schema','creator_pilot_v1','since',d1,'until',d2,
 'programs',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY marca),'[]') FROM public.crm_partner_program_v1 p),
 'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(p)-'actor' ORDER BY updated_at DESC),'[]') FROM public.crm_partner_candidate_v1 p),
 'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('covers_period',s.state='ok' AND s.since<=d1 AND s.until>=d2) ORDER BY marca,account_name),'[]') FROM public.crm_creator_meta_source_v1 s),
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
  FROM public.crm_creator_meta_day_v1 x JOIN public.crm_creator_meta_source_v1 s USING(account_id)
  LEFT JOIN public.crm_creator_meta_link_v1 l ON l.account_id=x.account_id AND l.ad_id=x.ad_id
  WHERE x.day BETWEEN d1 AND d2 GROUP BY x.account_id,x.ad_id,s.marca,s.currency,s.timezone,x.model,l.influ,l.version
 ) a),'coupon_by_creator',(SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM (SELECT marca,influ,count(*) FILTER(WHERE pago)::integer AS paid_orders,sum(receita_base) FILTER(WHERE pago) AS receita_cupom FROM public.crm_influ_pedido WHERE dia BETWEEN d1 AND d2 AND via='cupom' AND influ IS NOT NULL GROUP BY marca,influ) c),'tracking_active',false,'payout_active',false);
END $$;

CREATE OR REPLACE FUNCTION public.crm_creator_pilot_write_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE op jsonb; actor_id text; rid uuid; clean jsonb; oldop record; data jsonb; kind text; brand text; expected integer; current_version integer; result jsonb; cid uuid; account text; aid text; person text;
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
  IF NOT EXISTS(SELECT 1 FROM public.crm_creator_meta_source_v1 WHERE account_id=account AND marca=brand) OR NOT EXISTS(SELECT 1 FROM public.crm_creator_meta_day_v1 WHERE account_id=account AND ad_id=aid) THEN RETURN jsonb_build_object('erro','Anúncio não pertence à marca consultada.'); END IF;
  IF person IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.crm_influ WHERE marca=brand AND influ=person) THEN RETURN jsonb_build_object('erro','Criador não pertence à marca.'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('creator-link:'||account||':'||aid,0));
  SELECT version INTO current_version FROM public.crm_creator_meta_link_v1 WHERE account_id=account AND ad_id=aid FOR UPDATE;
  IF coalesce(current_version,0)<>expected THEN RETURN jsonb_build_object('erro','Vínculo mudou. Atualize antes de salvar.'); END IF;
  INSERT INTO public.crm_creator_meta_link_v1(account_id,ad_id,marca,influ,version,actor) VALUES(account,aid,brand,person,expected+1,actor_id)
  ON CONFLICT(account_id,ad_id) DO UPDATE SET influ=excluded.influ,version=excluded.version,actor=excluded.actor,updated_at=now();
  result:=jsonb_build_object('ok',true,'kind',kind,'account_id',account,'ad_id',aid,'version',expected+1,'request_id',rid);
 ELSE RETURN jsonb_build_object('erro','Tipo de edição inválido.'); END IF;
 INSERT INTO public.crm_creator_pilot_operation_v1(actor,request_id,request,response) VALUES(actor_id,rid,clean,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.crm_creator_pilot_read_v1(date,date),public.crm_creator_pilot_write_v1(jsonb) FROM PUBLIC;

-- Collector-only entry point, never exposed as a browser action. Atomic snapshot replacement.
CREATE OR REPLACE FUNCTION public.crm_creator_meta_ingest_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE account text:=p->>'account_id';started timestamptz:=(p->>'started_at')::timestamptz;d1 date:=(p->>'since')::date;d2 date:=(p->>'until')::date;s public.crm_creator_meta_source_v1%ROWTYPE;v jsonb;n integer;
BEGIN
 SELECT * INTO s FROM public.crm_creator_meta_source_v1 WHERE account_id=account FOR UPDATE;
 IF NOT FOUND OR started IS NULL OR d1 IS NULL OR d2 IS NULL OR d1>d2 OR d2-d1>62 THEN RAISE EXCEPTION 'Invalid collector scope'; END IF;
 IF s.last_attempt IS NOT NULL AND s.last_attempt>started THEN RETURN jsonb_build_object('ok',true,'ignored_older',true); END IF;
 IF p->>'complete' IS DISTINCT FROM 'true' THEN
  UPDATE public.crm_creator_meta_source_v1 SET state='error',last_attempt=started,error=left(coalesce(p->>'error','Coleta incompleta.'),250) WHERE account_id=account;
  RETURN jsonb_build_object('ok',true,'collected',false);
 END IF;
 IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid rows'; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'rows') LOOP
  IF v->>'account_id' IS DISTINCT FROM account OR v->>'account_currency' IS DISTINCT FROM s.currency OR v->>'date_start' IS DISTINCT FROM v->>'date_stop' OR (v->>'date_start')::date NOT BETWEEN d1 AND d2 OR coalesce(v->>'ad_id','') !~ '^[0-9]+$' OR v->>'model' IS DISTINCT FROM '7d_click_conversion' THEN RAISE EXCEPTION 'Collector row outside scope'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'rows') r GROUP BY r->>'ad_id',r->>'date_start' HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate collector grain'; END IF;
 DELETE FROM public.crm_creator_meta_day_v1 WHERE account_id=account AND day BETWEEN d1 AND d2 AND model='7d_click_conversion';
 INSERT INTO public.crm_creator_meta_day_v1(account_id,ad_id,day,ad_name,adset_name,campaign_name,model,spend,impressions,clicks,purchases,purchase_value,collected_at)
 SELECT account,r->>'ad_id',(r->>'date_start')::date,coalesce(r->>'ad_name',''),coalesce(r->>'adset_name',''),coalesce(r->>'campaign_name',''),'7d_click_conversion',(r->>'spend')::numeric,(r->>'impressions')::bigint,(r->>'clicks')::bigint,(r->>'purchases')::numeric,(r->>'purchase_value')::numeric,started FROM jsonb_array_elements(p->'rows') r;
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE public.crm_creator_meta_source_v1 SET state='ok',since=d1,until=d2,last_success=started,last_attempt=started,error=NULL,rows_count=n WHERE account_id=account;
 RETURN jsonb_build_object('ok',true,'collected',true,'rows',n,'account_id',account);
END $$;
REVOKE ALL ON FUNCTION public.crm_creator_meta_ingest_v1(jsonb) FROM PUBLIC;
