-- Additive count reader. Seven comparisons keep native types; all business predicates remain.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR (WITH expected(signature,digest,volatility) AS (VALUES
 ('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)','3d8b7d13f82477ce803a27dc7db9b74e','i'),
 ('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)','4adcbdd47bcb8d731c2d35bd60ea0ff9','s'))
 SELECT count(*)=2 AND bool_and(md5(p.prosrc)=e.digest AND p.provolatile::text=e.volatility
 AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres'
 AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
 AND has_function_privilege('crm_audience_api',p.oid,'EXECUTE')=(p.proname='shopify_count_for_rule')) AS ok
 FROM expected e JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'TYPED_BASE_DRIFT';END IF;
 IF (WITH needed(relation,column_name,labels) AS (VALUES
 ('public.lists','status',ARRAY['active']::text[]),
 ('public.lists','optin',ARRAY['single','double']::text[]),
 ('public.subscribers','status',ARRAY['enabled']::text[]),
 ('public.subscriber_lists','status',ARRAY['confirmed','unconfirmed']::text[]))
 SELECT count(*)=4 AND bool_and(
  (t.typnamespace='pg_catalog'::regnamespace AND t.typname='text')
  OR (t.typtype='e' AND NOT EXISTS(SELECT 1 FROM unnest(required_column.labels) required_label(label)
    WHERE NOT EXISTS(SELECT 1 FROM pg_enum e WHERE e.enumtypid=t.oid AND e.enumlabel=required_label.label)))) AS ok
 FROM needed required_column JOIN pg_attribute a ON a.attrelid=to_regclass(required_column.relation) AND a.attname=required_column.column_name
 AND a.attnum>0 AND NOT a.attisdropped JOIN pg_type t ON t.oid=a.atttypid) IS DISTINCT FROM true THEN RAISE EXCEPTION 'TYPED_TYPES_UNCONFIRMED';END IF;
END $guard$;
CREATE FUNCTION crm_audience_v2.shopify_count_for_rule_flat_20261017(rule jsonb, b text, base_list_id integer, catalog jsonb)
 RETURNS TABLE(source_confirmed boolean, eligible_count bigint, checked_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE n record;node_count integer:=0;op text;field text;key text;pin text;expected text;expression text;statement text;
 list_ids integer[]:=ARRAY[base_list_id];lid integer;native_optin text;catalog_ready boolean;needs_product boolean:=false;
 shopify_rules jsonb:='{}'::jsonb;ready_leaves jsonb:='{}'::jsonb;product_columns text:='';product_joins text:='';
BEGIN
 IF (WITH needed(relation,column_name,labels) AS (VALUES
 ('public.lists','status',ARRAY['active']::text[]),
 ('public.lists','optin',ARRAY['single','double']::text[]),
 ('public.subscribers','status',ARRAY['enabled']::text[]),
 ('public.subscriber_lists','status',ARRAY['confirmed','unconfirmed']::text[]))
 SELECT count(*)=4 AND bool_and(
  (t.typnamespace='pg_catalog'::regnamespace AND t.typname='text')
  OR (t.typtype='e' AND NOT EXISTS(SELECT 1 FROM unnest(required_column.labels) required_label(label)
    WHERE NOT EXISTS(SELECT 1 FROM pg_enum e WHERE e.enumtypid=t.oid AND e.enumlabel=required_label.label)))) AS ok
 FROM needed required_column JOIN pg_attribute a ON a.attrelid=to_regclass(required_column.relation) AND a.attname=required_column.column_name
 AND a.attnum>0 AND NOT a.attisdropped JOIN pg_type t ON t.oid=a.atttypid) IS DISTINCT FROM true THEN
  RETURN QUERY SELECT * FROM crm_audience_v2.shopify_count_for_rule(rule,b,base_list_id,catalog);RETURN;
 END IF;
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
  product_columns:=',p.products,(p.history_complete AND g.customer_gid IS NULL AND NOT (f.orders_count=0 AND (f.last_order_at IS NOT NULL OR f.amount_spent>0))) AS history_complete,coalesce(t.ready,false) AS product_ready';
  product_joins:=' LEFT JOIN source_products p ON p.brand=f.brand AND p.operation_id=f.operation_id AND p.customer_gid=f.customer_gid
  LEFT JOIN source_batches t ON t.brand=p.brand AND t.operation_id=p.operation_id LEFT JOIN source_gaps g ON g.brand=p.brand AND g.operation_id=p.operation_id AND g.customer_gid=p.customer_gid';
 END IF;
 statement:='WITH source_config AS MATERIALIZED (
  SELECT brand,current_operation,timezone FROM crm_audience_v2.shopify_source WHERE brand=$1::text
 ), source_identities AS MATERIALIZED (
  SELECT brand,customer_gid,subscriber_id,subscriber_uuid FROM crm_audience_v2.shopify_identity WHERE brand=$1::text
 ), source_products AS MATERIALIZED (
  SELECT p.brand,p.operation_id,p.customer_gid,p.products,p.history_complete FROM crm_audience_v2.shopify_customer_product p
  JOIN source_config cfg ON cfg.brand=p.brand AND cfg.current_operation=p.operation_id
 ), source_batches AS MATERIALIZED (
  SELECT t.brand,t.operation_id,t.ready FROM crm_audience_v2.shopify_product_batch t
  JOIN source_config cfg ON cfg.brand=t.brand AND cfg.current_operation=t.operation_id
 ), source_gaps AS MATERIALIZED (
  SELECT g.brand,g.operation_id,g.customer_gid FROM crm_audience_v2.shopify_product_history_gap g
  JOIN source_config cfg ON cfg.brand=g.brand AND cfg.current_operation=g.operation_id
 ), source_facts AS MATERIALIZED (
  SELECT f.brand,f.operation_id,f.customer_gid,f.subscriber_id,f.subscriber_uuid,f.email,f.orders_count,f.amount_spent,
   CASE WHEN f.last_order_at IS NULL THEN NULL ELSE (f.last_order_at AT TIME ZONE cfg.timezone)::date END AS last_order_date,
   f.last_order_at
  FROM source_config cfg JOIN crm_audience_v2.shopify_customer_fact f
   ON f.brand=cfg.brand AND f.operation_id=cfg.current_operation AND f.identity_state=''resolved''
 ), eligible_base AS MATERIALIZED (
  SELECT s.id,s.uuid,lower(btrim(s.email)) AS email FROM public.subscribers s
  JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$2::integer
  JOIN public.lists l ON l.id=sl.list_id AND l.status=''active'' AND public.shrigma_campaign_list_brand(l)=$1::text
   AND l.optin IN(''single'',''double'')
  WHERE s.status=''enabled'' AND ((l.optin=''double'' AND sl.status=''confirmed'')
   OR (l.optin=''single'' AND sl.status IN(''confirmed'',''unconfirmed'')))
 ), shopify_facts AS MATERIALIZED (
  SELECT f.subscriber_id,f.subscriber_uuid,f.email,f.orders_count,f.amount_spent,f.last_order_date,
   (i.subscriber_id=f.subscriber_id AND i.subscriber_uuid=f.subscriber_uuid) AS identity_current'
   ||product_columns||'
  FROM source_facts f
  JOIN source_identities i ON i.brand=f.brand AND i.customer_gid=f.customer_gid'
   ||product_joins||'
  WHERE $3::jsonb<>''{}''::jsonb
 ), evaluated AS MATERIALIZED (
  SELECT ('||expression||') AS matched FROM eligible_base s LEFT JOIN shopify_facts sf ON sf.subscriber_id=s.id AND sf.subscriber_uuid=s.uuid AND sf.email=s.email AND sf.identity_current IS TRUE
 ), summary AS (
  SELECT count(*) FILTER(WHERE matched IS TRUE)::bigint AS matched_count,
   count(*) FILTER(WHERE matched IS NULL)::bigint AS unknown_count FROM evaluated
 ) SELECT summary.unknown_count=0,CASE WHEN summary.unknown_count=0 THEN summary.matched_count ELSE NULL::bigint END,
  statement_timestamp() FROM summary';
 RETURN QUERY EXECUTE statement USING b,base_list_id,shopify_rules;
END $function$;

REVOKE ALL ON FUNCTION crm_audience_v2.shopify_count_for_rule_flat_20261017(jsonb,text,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_audience_v2.shopify_count_for_rule_flat_20261017(jsonb,text,integer,jsonb) TO crm_audience_api;
DO $acl$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid='crm_audience_v2.shopify_count_for_rule_flat_20261017(jsonb,text,integer,jsonb)'::regprocedure AND (pg_get_userbyid(p.proowner)<>'postgres' OR a.privilege_type<>'EXECUTE'
 OR a.grantee<>p.proowner AND (a.is_grantable OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='crm_audience_api'))))
 THEN RAISE EXCEPTION 'TYPED_NEW_ACL_DRIFT';END IF;
END $acl$;
COMMIT;
