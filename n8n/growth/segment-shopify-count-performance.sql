-- Guarded additive upgrade for the PR187 aggregate count implementation.
-- It replaces only the internal compiler and aggregate wrapper. No source,
-- fact, identity, catalog, selection, delivery, or permission data is changed.
DO $boundary$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)'))
    IS DISTINCT FROM '0ff3dec0fccd2954f1a3fa652c1b1caf'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)'))
    IS DISTINCT FROM '9c84c481046870b19c2603901168fe3c' THEN
  RAISE EXCEPTION 'SHOPIFY_COUNT_PERFORMANCE_BASE_DRIFT';
 END IF;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime WHERE enabled) THEN
  RAISE EXCEPTION 'SHOPIFY_COUNT_PERFORMANCE_REQUIRES_WORKER_OFF';
 END IF;
END $boundary$;

-- All emitted fragments still come from validated fields/operators and quoted
-- scalar values. Shopify leaves now read typed columns prepared by the wrapper.
CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_count_rule_sql(rule jsonb,ready_leaves jsonb,depth integer DEFAULT 1)
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
    target:=quote_literal(jsonb_build_array(jsonb_build_object('id',rule->>'value'))::text)||'::jsonb';
    RETURN '(CASE WHEN sf.subscriber_id IS NULL OR sf.product_ready IS DISTINCT FROM true OR jsonb_typeof(sf.products) IS DISTINCT FROM ''array'' THEN NULL '
     ||'WHEN sf.products @> '||target||' THEN '
     ||CASE WHEN rule->>'operator'='purchased' THEN 'true ' ELSE 'false ' END||'WHEN sf.history_complete IS DISTINCT FROM true THEN NULL ELSE '
     ||CASE WHEN rule->>'operator'='not_purchased' THEN 'true' ELSE 'false' END||' END)';
   END IF;
   IF rule->>'field'='purchase.last_date' THEN
    cmp:=CASE rule->>'operator' WHEN 'eq' THEN '=' WHEN 'before' THEN '<' WHEN 'on_or_before' THEN '<=' WHEN 'after' THEN '>' ELSE '>=' END;
    RETURN '(CASE WHEN sf.subscriber_id IS NULL OR (sf.orders_count=0 AND (sf.last_order_date IS NOT NULL OR sf.amount_spent>0)) THEN NULL '
     ||'WHEN sf.last_order_date IS NULL THEN CASE WHEN sf.orders_count=0 THEN false ELSE NULL END '
     ||'ELSE sf.last_order_date '||cmp||' '||quote_literal(rule->>'value')||'::date END)';
   END IF;
   cmp:=CASE rule->>'operator' WHEN 'eq' THEN '=' WHEN 'gt' THEN '>' WHEN 'gte' THEN '>=' WHEN 'lt' THEN '<' ELSE '<=' END;
   target:=CASE rule->>'field' WHEN 'purchase.count' THEN 'sf.orders_count' ELSE 'sf.amount_spent' END;
   RETURN '(CASE WHEN sf.subscriber_id IS NULL OR (sf.orders_count=0 AND (sf.last_order_date IS NOT NULL OR sf.amount_spent>0)) THEN NULL '
    ||'ELSE '||target||' '||cmp||' '||quote_literal(rule->>'value')||'::numeric END)';
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
 FOR child IN SELECT x.value FROM jsonb_array_elements(rule->'rules') x LOOP
  parts:=array_append(parts,'('||crm_audience_v2.shopify_count_rule_sql(child,ready_leaves,depth+1)||')');
 END LOOP;
 RETURN array_to_string(parts,CASE rule->>'op' WHEN 'and' THEN ' AND ' ELSE ' OR ' END);
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer) FROM PUBLIC,crm_audience_api;

CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_count_for_rule(rule jsonb,b text,base_list_id integer,catalog jsonb)
RETURNS TABLE(source_confirmed boolean,eligible_count bigint,checked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE n record;node_count integer:=0;op text;field text;key text;pin text;expected text;expression text;statement text;
 list_ids integer[]:=ARRAY[base_list_id];lid integer;native_optin text;catalog_ready boolean;needs_product boolean:=false;
 shopify_rules jsonb:='{}'::jsonb;ready_leaves jsonb:='{}'::jsonb;product_columns text:='';product_joins text:='';
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
   ready_leaves:=ready_leaves||jsonb_build_object(key,true);
   needs_product:=needs_product OR field='purchase.product';CONTINUE;
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
 IF needs_product THEN
  product_columns:=',p.products,p.history_complete,coalesce(t.ready,false) AS product_ready';
  product_joins:=' LEFT JOIN crm_audience_v2.shopify_customer_product p ON p.brand=f.brand AND p.operation_id=f.operation_id AND p.customer_gid=f.customer_gid
  LEFT JOIN crm_audience_v2.shopify_product_batch t ON t.brand=p.brand AND t.operation_id=p.operation_id';
 END IF;
 statement:='WITH eligible_base AS MATERIALIZED (
  SELECT s.id,s.uuid,lower(btrim(s.email)) AS email FROM public.subscribers s
  JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$2::integer
  JOIN public.lists l ON l.id=sl.list_id AND l.status::text=''active'' AND public.shrigma_campaign_list_brand(l)=$1::text
   AND l.optin::text IN(''single'',''double'')
  WHERE s.status::text=''enabled'' AND ((l.optin::text=''double'' AND sl.status::text=''confirmed'')
   OR (l.optin::text=''single'' AND sl.status::text IN(''confirmed'',''unconfirmed'')))
 ), shopify_facts AS MATERIALIZED (
  SELECT f.subscriber_id,f.orders_count,f.amount_spent,
   CASE WHEN f.last_order_at IS NULL THEN NULL ELSE (f.last_order_at AT TIME ZONE cfg.timezone)::date END AS last_order_date'
   ||product_columns||'
  FROM eligible_base native
  JOIN crm_audience_v2.shopify_source cfg ON cfg.brand=$1::text
  JOIN crm_audience_v2.shopify_customer_fact f ON f.brand=cfg.brand AND f.operation_id=cfg.current_operation
   AND f.identity_state=''resolved'' AND f.subscriber_id=native.id AND f.subscriber_uuid=native.uuid AND f.email=native.email
  JOIN crm_audience_v2.shopify_identity i ON i.brand=f.brand AND i.customer_gid=f.customer_gid
   AND i.subscriber_id=f.subscriber_id AND i.subscriber_uuid=f.subscriber_uuid'
   ||product_joins||'
  WHERE $3::jsonb<>''{}''::jsonb
 ), evaluated AS MATERIALIZED (
  SELECT ('||expression||') AS matched FROM eligible_base s LEFT JOIN shopify_facts sf ON sf.subscriber_id=s.id
 ), summary AS (
  SELECT count(*) FILTER(WHERE matched IS TRUE)::bigint AS matched_count,
   count(*) FILTER(WHERE matched IS NULL)::bigint AS unknown_count FROM evaluated
 ) SELECT summary.unknown_count=0,CASE WHEN summary.unknown_count=0 THEN summary.matched_count ELSE NULL::bigint END,
  statement_timestamp() FROM summary';
 RETURN QUERY EXECUTE statement USING b,base_list_id,shopify_rules;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb) TO crm_audience_api;
