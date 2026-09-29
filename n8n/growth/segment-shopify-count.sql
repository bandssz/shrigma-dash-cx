-- Existing strict definitions retain their semantics. 'confirmed' is an
-- explicit per-condition choice to exclude individual unknown records. Source
-- context/expiry failures still block the entire operation.
DO $boundary$ BEGIN
 IF to_regprocedure('crm_audience_v2.shopify_matches_for_rule(jsonb,text,text)') IS NOT NULL
  OR to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)') IS NOT NULL
  OR to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'SHOPIFY_COUNT_COLLISION'; END IF;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled) OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) THEN RAISE EXCEPTION 'SHOPIFY_COUNT_REQUIRES_WORKER_OFF'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_rule(jsonb,integer,text,integer,jsonb)')) IS DISTINCT FROM '69ef34187d59bd4116a28b71f6d8a5b2' THEN RAISE EXCEPTION 'SHOPIFY_COUNT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_regular_rule_match(jsonb,integer[],integer,text)')) IS DISTINCT FROM 'b9353e83deb0f5540f958b17814fb1f4' THEN RAISE EXCEPTION 'SHOPIFY_COUNT_BASE_DRIFT'; END IF;
END $boundary$;

-- Additive count helper. It returns only native IDs and rule results, never
-- Customer data. One source check and one set of joins replace per-person reads.
CREATE FUNCTION crm_audience_v2.shopify_matches_for_rule(rule jsonb,b text,pin text)
RETURNS TABLE(subscriber_id integer,matched boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE cfg crm_audience_v2.shopify_source%ROWTYPE;field text;op text;
BEGIN
 IF NOT crm_audience_v2.shopify_rule_valid(rule) OR b IS NULL OR b NOT IN('fish','aristo') THEN RETURN; END IF;
 field:=rule->>'field';op:=rule->>'operator';
 IF NOT crm_audience_v2.shopify_source_current(b,field,pin) THEN RETURN; END IF;
 SELECT * INTO STRICT cfg FROM crm_audience_v2.shopify_source WHERE brand=b;
 RETURN QUERY
 SELECT f.subscriber_id,
 CASE
  WHEN field='purchase.product' THEN CASE
   WHEN p.customer_gid IS NULL OR NOT coalesce(t.ready,false) THEN NULL
   WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p.products) item WHERE item->>'id'=rule->>'value') THEN op='purchased'
   WHEN NOT p.history_complete THEN NULL ELSE op='not_purchased' END
  WHEN f.orders_count=0 AND (f.last_order_at IS NOT NULL OR f.amount_spent>0) THEN NULL
  WHEN field='purchase.last_date' THEN CASE
   WHEN f.last_order_at IS NULL THEN CASE WHEN f.orders_count=0 THEN false ELSE NULL END
   ELSE CASE op WHEN 'eq' THEN (f.last_order_at AT TIME ZONE cfg.timezone)::date=(rule->>'value')::date
    WHEN 'before' THEN (f.last_order_at AT TIME ZONE cfg.timezone)::date<(rule->>'value')::date
    WHEN 'on_or_before' THEN (f.last_order_at AT TIME ZONE cfg.timezone)::date<=(rule->>'value')::date
    WHEN 'after' THEN (f.last_order_at AT TIME ZONE cfg.timezone)::date>(rule->>'value')::date
    WHEN 'on_or_after' THEN (f.last_order_at AT TIME ZONE cfg.timezone)::date>=(rule->>'value')::date END END
  ELSE CASE op
   WHEN 'eq' THEN (CASE WHEN field='purchase.count' THEN f.orders_count ELSE f.amount_spent END)=(rule->>'value')::numeric
   WHEN 'gt' THEN (CASE WHEN field='purchase.count' THEN f.orders_count ELSE f.amount_spent END)>(rule->>'value')::numeric
   WHEN 'gte' THEN (CASE WHEN field='purchase.count' THEN f.orders_count ELSE f.amount_spent END)>=(rule->>'value')::numeric
   WHEN 'lt' THEN (CASE WHEN field='purchase.count' THEN f.orders_count ELSE f.amount_spent END)<(rule->>'value')::numeric
   WHEN 'lte' THEN (CASE WHEN field='purchase.count' THEN f.orders_count ELSE f.amount_spent END)<=(rule->>'value')::numeric END
 END
 FROM crm_audience_v2.shopify_customer_fact f
 JOIN public.subscribers s ON s.id=f.subscriber_id AND s.uuid=f.subscriber_uuid AND lower(btrim(s.email))=f.email
 JOIN crm_audience_v2.shopify_identity i ON i.brand=f.brand AND i.customer_gid=f.customer_gid
  AND i.subscriber_id=f.subscriber_id AND i.subscriber_uuid=f.subscriber_uuid
 LEFT JOIN crm_audience_v2.shopify_customer_product p ON field='purchase.product' AND p.brand=f.brand AND p.operation_id=f.operation_id AND p.customer_gid=f.customer_gid
 LEFT JOIN crm_audience_v2.shopify_product_batch t ON t.brand=p.brand AND t.operation_id=p.operation_id
 WHERE f.brand=b AND f.operation_id=cfg.current_operation AND f.identity_state='resolved';
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_matches_for_rule(jsonb,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_matches_for_rule(jsonb,text,text) FROM crm_audience_api;

-- Internal compiler. It accepts no identifiers or SQL from its caller: every
-- emitted fragment comes from the validated allowlist and quoted scalar values.
CREATE FUNCTION crm_audience_v2.shopify_count_rule_sql(rule jsonb,ready_leaves jsonb,depth integer DEFAULT 1)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE child jsonb;parts text[]:='{}';expression text;key text;relation text;cmp text;target text;
BEGIN
 IF depth<1 OR depth>4 THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
 IF rule->>'op'='confirmed' THEN RETURN 'coalesce(('||crm_audience_v2.shopify_count_rule_sql(rule->'rule',ready_leaves,depth+1)||'),false)'; END IF;
 IF rule->>'op'='in_list' THEN
  RETURN 'EXISTS(SELECT 1 FROM public.subscriber_lists xsl JOIN public.lists xl ON xl.id=xsl.list_id WHERE xsl.subscriber_id=s.id AND xsl.list_id='||(rule->>'list_id')::integer||
   ' AND xl.status::text=''active'' AND public.shrigma_campaign_list_brand(xl)=$1::text AND ((xl.optin::text=''double'' AND xsl.status::text=''confirmed'') OR (xl.optin::text=''single'' AND xsl.status::text IN(''confirmed'',''unconfirmed''))))';
 END IF;
 IF rule->>'op'='condition' THEN
  key:=rule::text;
  IF rule->>'field' IN('purchase.count','purchase.amount','purchase.last_date','purchase.product') THEN
   IF ready_leaves->>key IS DISTINCT FROM 'true' THEN RETURN 'NULL::boolean'; END IF;
   IF rule->>'field'='purchase.product' THEN
    RETURN '(CASE WHEN sf.fact IS NULL OR sf.fact->>''product_ready'' IS DISTINCT FROM ''true'' OR jsonb_typeof(sf.fact->''products'') IS DISTINCT FROM ''array'' THEN NULL '
     ||'WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(sf.fact->''products'') p WHERE p->>''id''='||quote_literal(rule->>'value')||') THEN '
     ||CASE WHEN rule->>'operator'='purchased' THEN 'true ' ELSE 'false ' END||'WHEN sf.fact->>''history_complete'' IS DISTINCT FROM ''true'' THEN NULL ELSE '
     ||CASE WHEN rule->>'operator'='not_purchased' THEN 'true' ELSE 'false' END||' END)';
   END IF;
   IF rule->>'field'='purchase.last_date' THEN
    cmp:=CASE rule->>'operator' WHEN 'eq' THEN '=' WHEN 'before' THEN '<' WHEN 'on_or_before' THEN '<=' WHEN 'after' THEN '>' ELSE '>=' END;
    RETURN '(CASE WHEN sf.fact IS NULL OR ((sf.fact->>''orders_count'')::numeric=0 AND (sf.fact->>''last_order_date'' IS NOT NULL OR (sf.fact->>''amount_spent'')::numeric>0)) THEN NULL '
     ||'WHEN sf.fact->>''last_order_date'' IS NULL THEN CASE WHEN (sf.fact->>''orders_count'')::numeric=0 THEN false ELSE NULL END '
     ||'ELSE (sf.fact->>''last_order_date'')::date '||cmp||' '||quote_literal(rule->>'value')||'::date END)';
   END IF;
   cmp:=CASE rule->>'operator' WHEN 'eq' THEN '=' WHEN 'gt' THEN '>' WHEN 'gte' THEN '>=' WHEN 'lt' THEN '<' ELSE '<=' END;
   target:=CASE rule->>'field' WHEN 'purchase.count' THEN 'sf.fact->>''orders_count''' ELSE 'sf.fact->>''amount_spent''' END;
   RETURN '(CASE WHEN sf.fact IS NULL OR ((sf.fact->>''orders_count'')::numeric=0 AND (sf.fact->>''last_order_date'' IS NOT NULL OR (sf.fact->>''amount_spent'')::numeric>0)) THEN NULL '
    ||'ELSE ('||target||')::numeric '||cmp||' '||quote_literal(rule->>'value')||'::numeric END)';
  END IF;
  IF rule->>'field' IN('email.opened','email.clicked') THEN
   IF ready_leaves->>key IS DISTINCT FROM 'true' THEN RETURN 'NULL::boolean'; END IF;
   relation:=CASE rule->>'field' WHEN 'email.opened' THEN 'campaign_views' ELSE 'link_clicks' END;
   expression:='EXISTS(SELECT 1 FROM public.'||relation||' ev JOIN public.campaigns ec ON ec.id=ev.campaign_id WHERE ev.subscriber_id=s.id '
    ||'AND ec.attribs#>>''{crm,policy}''=''crm-campaign-v1'' AND ec.attribs#>>''{crm,brand}''=$1::text AND ec.messenger::text=''email'' AND ec.type::text=''regular'' '
    ||'AND ev.created_at>=statement_timestamp()-('||(rule->>'value')::integer||'::double precision*86400*interval ''1 second'') AND ev.created_at<=statement_timestamp())';
   RETURN CASE rule->>'operator' WHEN 'within_last_days' THEN expression ELSE 'NOT ('||expression||')' END;
  END IF;
  RETURN 'NULL::boolean';
 END IF;
 FOR child IN SELECT x.value FROM jsonb_array_elements(rule->'rules') x LOOP parts:=array_append(parts,'('||crm_audience_v2.shopify_count_rule_sql(child,ready_leaves,depth+1)||')');END LOOP;
 RETURN array_to_string(parts,CASE rule->>'op' WHEN 'and' THEN ' AND ' ELSE ' OR ' END);
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer) FROM PUBLIC,crm_audience_api;

-- The sole API entry point returns one aggregate row. Inputs are declarative;
-- every node, list, source hash and catalog pin is revalidated server-side.
CREATE FUNCTION crm_audience_v2.shopify_count_for_rule(rule jsonb,b text,base_list_id integer,catalog jsonb)
RETURNS TABLE(source_confirmed boolean,eligible_count bigint,checked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE n record;node_count integer:=0;op text;field text;key text;pin text;expected text;expression text;statement text;
 list_ids integer[]:=ARRAY[base_list_id];lid integer;native_optin text;catalog_ready boolean;
 shopify_rules jsonb:='{}'::jsonb;ready_leaves jsonb:='{}'::jsonb;
BEGIN
 IF b IS NULL OR b NOT IN('fish','aristo') OR base_list_id IS NULL OR base_list_id<1
  OR jsonb_typeof(rule) IS DISTINCT FROM 'object' OR jsonb_typeof(catalog) IS DISTINCT FROM 'object'
  OR catalog->>'brand' IS DISTINCT FROM b OR catalog->'current' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(catalog->'lists') IS DISTINCT FROM 'array' OR jsonb_array_length(catalog->'lists')>1000
  OR jsonb_typeof(catalog->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(catalog->'fields')>7
  OR jsonb_typeof(catalog->'products') IS DISTINCT FROM 'array' OR jsonb_typeof(catalog->'origins') IS DISTINCT FROM 'array'
  OR octet_length(catalog::text)>16777216 THEN RAISE EXCEPTION 'SEGMENT_COUNT_INPUT'; END IF;

 FOR n IN WITH RECURSIVE tree(node,depth,is_confirmed) AS (
  SELECT rule,1,false
  UNION ALL
  SELECT c.node,t.depth+1,t.node->>'op'='confirmed' FROM tree t
  CROSS JOIN LATERAL (SELECT value AS node FROM jsonb_array_elements(CASE
   WHEN t.node->>'op' IN('and','or') AND jsonb_typeof(t.node->'rules')='array' THEN t.node->'rules'
   WHEN t.node->>'op'='confirmed' THEN jsonb_build_array(t.node->'rule') ELSE '[]'::jsonb END)) c)
  SELECT node,depth,is_confirmed FROM tree
 LOOP
  node_count:=node_count+1;op:=n.node->>'op';
  IF n.depth>4 OR node_count>32 OR jsonb_typeof(n.node) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
  IF op='in_list' THEN
   IF NOT(n.node ?& ARRAY['op','list_id']) OR n.node-'op'-'list_id'<>'{}'::jsonb
    OR jsonb_typeof(n.node->'list_id') IS DISTINCT FROM 'number' OR n.node->>'list_id' !~ '^[1-9][0-9]{0,9}$'
    OR (n.node->>'list_id')::numeric>2147483647 THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   list_ids:=array_append(list_ids,(n.node->>'list_id')::integer);CONTINUE;
  END IF;
  IF op IN('and','or') THEN
   IF NOT(n.node ?& ARRAY['op','rules']) OR n.node-'op'-'rules'<>'{}'::jsonb
    OR jsonb_typeof(n.node->'rules') IS DISTINCT FROM 'array' OR jsonb_array_length(n.node->'rules') NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   CONTINUE;
  END IF;
  IF op='confirmed' THEN
   IF NOT(n.node ?& ARRAY['op','rule']) OR n.node-'op'-'rule'<>'{}'::jsonb
    OR jsonb_typeof(n.node->'rule') IS DISTINCT FROM 'object' OR n.node#>>'{rule,op}' IS DISTINCT FROM 'condition'
    OR NOT crm_audience_v2.shopify_rule_valid(n.node->'rule') THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   CONTINUE;
  END IF;
  IF op IS DISTINCT FROM 'condition' OR NOT(n.node ?& ARRAY['op','field','operator','value'])
   OR n.node-'op'-'field'-'operator'-'value'<>'{}'::jsonb THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
  field:=n.node->>'field';key:=n.node::text;
  IF field IN('purchase.count','purchase.amount','purchase.last_date','purchase.product') THEN
   IF NOT crm_audience_v2.shopify_rule_valid(n.node) THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   SELECT count(*)=1 AND bool_and(f->'available'='true'::jsonb AND f->>'source_hash' ~ '^[a-f0-9]{64}$'),max(f->>'source_hash')
    INTO catalog_ready,pin FROM jsonb_array_elements(catalog->'fields') f WHERE f->>'key'=field;
   IF field='purchase.amount' AND coalesce(catalog->>'currency','') !~ '^[A-Z]{3}$' THEN catalog_ready:=false; END IF;
   IF field='purchase.product' AND (SELECT count(*) FROM jsonb_array_elements(catalog->'products') p
    WHERE p->>'id'=n.node->>'value' AND p->>'brand'=b AND p->'available'='true'::jsonb)<>1 THEN catalog_ready:=false; END IF;
   IF NOT coalesce(catalog_ready,false) THEN
    IF n.is_confirmed THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp();RETURN; END IF;
    CONTINUE;
   END IF;
   IF NOT crm_audience_v2.shopify_source_current(b,field,pin) THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp();RETURN; END IF;
   shopify_rules:=shopify_rules||jsonb_build_object(key,jsonb_build_object('rule',n.node,'pin',pin));
   ready_leaves:=ready_leaves||jsonb_build_object(key,true);CONTINUE;
  END IF;
  IF field IN('email.opened','email.clicked') THEN
   IF n.node->>'operator' NOT IN('within_last_days','not_within_last_days') OR jsonb_typeof(n.node->'value') IS DISTINCT FROM 'number'
    OR n.node->>'value' !~ '^[1-9][0-9]{0,3}$' OR (n.node->>'value')::numeric>3650 THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   expected:=crm_audience_v2.selection_engagement_source_hash(b,field);
   SELECT count(*)=1 AND bool_and(f->'available'='true'::jsonb AND f->>'source_hash'=expected)
    INTO catalog_ready FROM jsonb_array_elements(catalog->'fields') f WHERE f->>'key'=field;
   IF coalesce(catalog_ready,false) THEN ready_leaves:=ready_leaves||jsonb_build_object(key,true); END IF;CONTINUE;
  END IF;
  IF field='signup.origin' AND n.node->>'operator' IN('is','is_not') AND jsonb_typeof(n.node->'value')='string'
   AND n.node->>'value' IN('popup','vip_alma','vip_desodorante') THEN CONTINUE; END IF;
  RAISE EXCEPTION 'SEGMENT_COUNT_RULE';
 END LOOP;

 FOR lid IN SELECT DISTINCT unnest(list_ids) LOOP
  SELECT count(*)=1 AND bool_and(x->>'brand'=b AND x->'available'='true'::jsonb) INTO catalog_ready
   FROM jsonb_array_elements(catalog->'lists') x WHERE x->>'id'=lid::text;
  SELECT l.optin::text INTO native_optin FROM public.lists l WHERE l.id=lid AND l.status::text='active'
   AND public.shrigma_campaign_list_brand(l)=b AND l.optin::text IN('single','double');
  IF NOT coalesce(catalog_ready,false) OR NOT FOUND THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp();RETURN; END IF;
 END LOOP;

 expression:=crm_audience_v2.shopify_count_rule_sql(rule,ready_leaves,1);
 statement:='WITH shopify_facts AS MATERIALIZED (
  SELECT f.subscriber_id,jsonb_build_object(''orders_count'',f.orders_count,''amount_spent'',f.amount_spent,
   ''last_order_date'',CASE WHEN f.last_order_at IS NULL THEN NULL ELSE to_jsonb((f.last_order_at AT TIME ZONE cfg.timezone)::date) END,
   ''products'',p.products,''history_complete'',p.history_complete,''product_ready'',coalesce(t.ready,false)) AS fact
  FROM crm_audience_v2.shopify_source cfg
  JOIN crm_audience_v2.shopify_customer_fact f ON f.brand=cfg.brand AND f.operation_id=cfg.current_operation AND f.identity_state=''resolved''
  JOIN public.subscribers native ON native.id=f.subscriber_id AND native.uuid=f.subscriber_uuid AND lower(btrim(native.email))=f.email
  JOIN crm_audience_v2.shopify_identity i ON i.brand=f.brand AND i.customer_gid=f.customer_gid
   AND i.subscriber_id=f.subscriber_id AND i.subscriber_uuid=f.subscriber_uuid
  LEFT JOIN crm_audience_v2.shopify_customer_product p ON p.brand=f.brand AND p.operation_id=f.operation_id AND p.customer_gid=f.customer_gid
  LEFT JOIN crm_audience_v2.shopify_product_batch t ON t.brand=p.brand AND t.operation_id=p.operation_id
  WHERE cfg.brand=$1::text AND $3::jsonb<>''{}''::jsonb
 ), evaluated AS MATERIALIZED (
  SELECT ('||expression||') AS matched FROM public.subscribers s
  JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$2::integer
  JOIN public.lists l ON l.id=sl.list_id AND l.status::text=''active'' AND public.shrigma_campaign_list_brand(l)=$1::text
   AND l.optin::text IN(''single'',''double'')
  LEFT JOIN shopify_facts sf ON sf.subscriber_id=s.id
  WHERE s.status::text=''enabled'' AND ((l.optin::text=''double'' AND sl.status::text=''confirmed'')
   OR (l.optin::text=''single'' AND sl.status::text IN(''confirmed'',''unconfirmed'')))
 ), summary AS (
  SELECT count(*) FILTER(WHERE matched IS TRUE)::bigint AS matched_count,
   count(*) FILTER(WHERE matched IS NULL)::bigint AS unknown_count FROM evaluated
 ) SELECT summary.unknown_count=0,CASE WHEN summary.unknown_count=0 THEN summary.matched_count ELSE NULL::bigint END,
  statement_timestamp() FROM summary';
 RETURN QUERY EXECUTE statement USING b,base_list_id,shopify_rules;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb) TO crm_audience_api;


CREATE OR REPLACE FUNCTION crm_audience_v2.selection_rule(rule jsonb,sid integer,brand text,depth integer DEFAULT 1,source_config jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE child jsonb; result jsonb; matches boolean; nodes integer:=1;
 pins jsonb:='[]'::jsonb; selected_list_id integer; native_optin text; source_hash text;
BEGIN
 IF depth<1 OR depth>4 OR jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF rule->>'op'='confirmed' THEN
  IF rule-'op'-'rule'<>'{}'::jsonb OR NOT(rule ?& ARRAY['op','rule']) OR NOT crm_audience_v2.shopify_rule_valid(rule->'rule') THEN RETURN NULL; END IF;
  result:=crm_audience_v2.selection_rule(rule->'rule',sid,brand,depth+1,source_config);
  IF result IS NULL OR (result->>'nodes')::integer+1>32 THEN RETURN NULL; END IF;
  RETURN result||jsonb_build_object('match',coalesce((result->>'match')::boolean,false),'nodes',(result->>'nodes')::integer+1);
 END IF;
 IF rule->>'op'='in_list' THEN
  IF rule-'op'-'list_id'<>'{}'::jsonb OR NOT(rule ?& ARRAY['op','list_id'])
   OR jsonb_typeof(rule->'list_id') IS DISTINCT FROM 'number'
   OR (rule->>'list_id') !~ '^[1-9][0-9]{0,9}$'
   OR (rule->>'list_id')::numeric>2147483647 THEN RETURN NULL; END IF;
  selected_list_id:=(rule->>'list_id')::integer;
  SELECT l.optin::text INTO native_optin FROM public.lists l
   WHERE l.id=selected_list_id AND l.status::text='active'
   AND public.shrigma_campaign_list_brand(l)=brand AND l.optin::text IN('single','double');
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.subscriber_id=sid AND sl.list_id=selected_list_id
   AND ((native_optin='double' AND sl.status::text='confirmed')
    OR (native_optin='single' AND sl.status::text IN('confirmed','unconfirmed')))) INTO matches;
  RETURN jsonb_build_object('match',matches,'nodes',1,'pins',jsonb_build_array(jsonb_build_object(
   'rule_key','{"op":"in_list","list_id":'||selected_list_id||'}','list_id',selected_list_id,'optin',native_optin)));
 END IF;
 IF rule->>'op'='condition' THEN
  -- Legacy combined callers pass no source configuration and stay list-only.
  IF source_config IS NULL THEN RETURN NULL; END IF;
  IF rule->>'field' IN('purchase.count','purchase.amount','purchase.last_date','purchase.product') THEN
   RETURN crm_audience_v2.selection_shopify_rule(rule,sid,brand,source_config);
  END IF;
  source_hash:=crm_audience_v2.selection_engagement_source_hash(brand,rule->>'field');
  IF source_hash IS NULL OR (SELECT count(*) FROM jsonb_array_elements(source_config->'fields') f
   WHERE f->>'key'=rule->>'field' AND f->'available'='true'::jsonb AND f->>'source_hash'=source_hash)<>1 THEN RETURN NULL; END IF;
  matches:=crm_audience_v2.selection_engagement_match(rule,sid,brand);
  IF matches IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('match',matches,'nodes',1,'pins',jsonb_build_array(jsonb_build_object(
   'rule_key','{"op":"condition","field":'||to_jsonb(rule->>'field')::text||',"operator":'||to_jsonb(rule->>'operator')::text||',"value":'||(rule->>'value')||'}',
   'source','email','source_hash',source_hash)));
 END IF;
 IF rule->>'op' NOT IN('and','or') OR rule->>'op' IS NULL
  OR rule-'op'-'rules'<>'{}'::jsonb OR jsonb_typeof(rule->'rules') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 IF jsonb_array_length(rule->'rules')<1 OR jsonb_array_length(rule->'rules')>16 THEN RETURN NULL; END IF;
 matches:=rule->>'op'='and';
 FOR child IN SELECT value FROM jsonb_array_elements(rule->'rules') LOOP
  result:=crm_audience_v2.selection_rule(child,sid,brand,depth+1,source_config);
  IF result IS NULL THEN RETURN NULL; END IF;
  nodes:=nodes+(result->>'nodes')::integer; IF nodes>32 THEN RETURN NULL; END IF;
  pins:=pins||(result->'pins');
  IF rule->>'op'='and' THEN matches:=matches AND (result->>'match')::boolean;
  ELSE matches:=matches OR (result->>'match')::boolean; END IF;
 END LOOP;
 RETURN jsonb_build_object('match',matches,'nodes',nodes,'pins',pins);
END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.selection_regular_rule_match(rule jsonb,consented integer[],sid integer,brand text) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE child jsonb; matched boolean; result boolean; pin text;
 BEGIN
  IF rule->>'op'='confirmed' THEN
   IF rule-'op'-'rule'<>'{}'::jsonb OR NOT(rule ?& ARRAY['op','rule']) OR NOT crm_audience_v2.shopify_rule_valid(rule->'rule') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
   SELECT field_hashes->>(rule#>>'{rule,field}') INTO pin FROM crm_audience_v2.shopify_source WHERE shopify_source.brand=selection_regular_rule_match.brand;
   IF NOT crm_audience_v2.shopify_source_current(brand,rule#>>'{rule,field}',pin) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
   RETURN coalesce(crm_audience_v2.shopify_customer_match(rule->'rule',sid,brand,pin),false);
  END IF;
  IF rule->>'op'='in_list' THEN RETURN (rule->>'list_id')::integer=ANY(consented); END IF;
  IF rule->>'op'='condition' THEN
   IF rule->>'field' IN('purchase.count','purchase.amount','purchase.last_date','purchase.product') THEN
    SELECT field_hashes->>(rule->>'field') INTO pin FROM crm_audience_v2.shopify_source WHERE shopify_source.brand=selection_regular_rule_match.brand;
    RETURN crm_audience_v2.shopify_customer_match(rule,sid,brand,pin);
   END IF;
   matched:=crm_audience_v2.selection_engagement_match(rule,sid,brand);
   IF matched IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
   RETURN matched;
  END IF;
  IF rule->>'op' NOT IN('and','or') OR rule->>'op' IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
  END IF;
  result:=rule->>'op'='and';
  FOR child IN SELECT value FROM jsonb_array_elements(rule->'rules') LOOP
   matched:=crm_audience_v2.selection_regular_rule_match(child,consented,sid,brand);
   IF rule->>'op'='and' THEN result:=result AND matched; ELSE result:=result OR matched; END IF;
  END LOOP;
  RETURN result;
 END $fn$;
