-- Original internal17 cohort projection/freeze; same existing request, no business rows.
BEGIN;
-- Candidate only: private IDs remain in the database; no sends or new journal.

SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $pre$ BEGIN
 IF current_user<>'postgres' OR (WITH expected(signature,digest,volatility) AS (VALUES
 ('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)','3d8b7d13f82477ce803a27dc7db9b74e','i'),
 ('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)','4adcbdd47bcb8d731c2d35bd60ea0ff9','s'))
 SELECT count(*)=2 AND bool_and(md5(p.prosrc)=e.digest AND p.provolatile::text=e.volatility
 AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres'
 AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
 AND has_function_privilege('crm_audience_api',p.oid,'EXECUTE')=(p.proname='shopify_count_for_rule')) AS ok
 FROM expected e JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'MEMBER_ORIGINAL_SOURCE_DRIFT';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule_flat_20261017(jsonb,text,integer,jsonb)')
  AND md5(p.prosrc)='a7617e55eea4d2adb0304fe77c57cf1b' AND p.provolatile='s' AND p.prosecdef
  AND pg_get_userbyid(p.proowner)='postgres' AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog']::text[])
 THEN RAISE EXCEPTION 'MEMBER_ADMITTED_COUNTER_DRIFT';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='crm_audience_v2'::regnamespace AND p.proname IN ('shopify_native_members_20261017','shopify_native_flat_members_20261017'))
 THEN RAISE EXCEPTION 'MEMBER_NAME_COLLISION_RECONCILE';END IF;
END $pre$;
CREATE FUNCTION crm_audience_v2.shopify_native_members_20261017(rule jsonb, b text, base_list_id integer, catalog jsonb)
 RETURNS TABLE(source_confirmed boolean, eligible_count bigint, checked_at timestamp with time zone, member_ids jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
    IF n.is_confirmed THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp(),NULL::jsonb;RETURN; END IF;
    CONTINUE;
   END IF;
   IF NOT crm_audience_v2.shopify_source_current(b,field,pin) THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp(),NULL::jsonb;RETURN; END IF;
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
  IF NOT coalesce(catalog_ready,false) OR NOT FOUND THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp(),NULL::jsonb;RETURN; END IF;
 END LOOP;

 expression:=crm_audience_v2.shopify_count_rule_sql(rule,ready_leaves,1);
 IF needs_product THEN
  product_columns:=',p.products,(p.history_complete AND g.customer_gid IS NULL AND NOT (f.orders_count=0 AND (f.last_order_at IS NOT NULL OR f.amount_spent>0))) AS history_complete,coalesce(t.ready,false) AS product_ready';
  product_joins:=' LEFT JOIN crm_audience_v2.shopify_customer_product p ON p.brand=f.brand AND p.operation_id=f.operation_id AND p.customer_gid=f.customer_gid
  LEFT JOIN crm_audience_v2.shopify_product_batch t ON t.brand=p.brand AND t.operation_id=p.operation_id LEFT JOIN crm_audience_v2.shopify_product_history_gap g ON g.brand=p.brand AND g.operation_id=p.operation_id AND g.customer_gid=p.customer_gid';
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
  SELECT s.id,('||expression||') AS matched FROM eligible_base s LEFT JOIN shopify_facts sf ON sf.subscriber_id=s.id
 ), summary AS (
  SELECT count(*) FILTER(WHERE matched IS TRUE)::bigint AS matched_count,
   count(*) FILTER(WHERE matched IS NULL)::bigint AS unknown_count,
   coalesce(jsonb_agg(id ORDER BY id) FILTER(WHERE matched IS TRUE),''[]''::jsonb) AS member_ids FROM evaluated
 ) SELECT summary.unknown_count=0,CASE WHEN summary.unknown_count=0 THEN summary.matched_count ELSE NULL::bigint END,
  statement_timestamp(),CASE WHEN summary.unknown_count=0 THEN summary.member_ids ELSE NULL::jsonb END FROM summary';
 RETURN QUERY EXECUTE statement USING b,base_list_id,shopify_rules;
END $function$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_native_members_20261017(jsonb,text,integer,jsonb) FROM PUBLIC,crm_audience_api;
CREATE FUNCTION crm_audience_v2.shopify_native_flat_members_20261017(rule jsonb, b text, base_list_id integer, catalog jsonb)
 RETURNS TABLE(source_confirmed boolean, eligible_count bigint, checked_at timestamp with time zone, member_ids jsonb)
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
  RETURN QUERY SELECT * FROM crm_audience_v2.shopify_native_members_20261017(rule,b,base_list_id,catalog);RETURN;
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
    IF n.is_confirmed THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp(),NULL::jsonb;RETURN; END IF;
    CONTINUE;
   END IF;
   IF NOT crm_audience_v2.shopify_source_current(b,field,pin) THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp(),NULL::jsonb;RETURN; END IF;
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
  IF NOT coalesce(catalog_ready,false) OR NOT FOUND THEN RETURN QUERY SELECT false,NULL::bigint,statement_timestamp(),NULL::jsonb;RETURN; END IF;
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
  SELECT s.id,('||expression||') AS matched FROM eligible_base s LEFT JOIN shopify_facts sf ON sf.subscriber_id=s.id AND sf.subscriber_uuid=s.uuid AND sf.email=s.email AND sf.identity_current IS TRUE
 ), summary AS (
  SELECT count(*) FILTER(WHERE matched IS TRUE)::bigint AS matched_count,
   count(*) FILTER(WHERE matched IS NULL)::bigint AS unknown_count,
   coalesce(jsonb_agg(id ORDER BY id) FILTER(WHERE matched IS TRUE),''[]''::jsonb) AS member_ids FROM evaluated
 ) SELECT summary.unknown_count=0,CASE WHEN summary.unknown_count=0 THEN summary.matched_count ELSE NULL::bigint END,
  statement_timestamp(),CASE WHEN summary.unknown_count=0 THEN summary.member_ids ELSE NULL::jsonb END FROM summary';
 RETURN QUERY EXECUTE statement USING b,base_list_id,shopify_rules;
END $function$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_native_flat_members_20261017(jsonb,text,integer,jsonb) FROM PUBLIC,crm_audience_api;
DO $post$ DECLARE expected record;p record;BEGIN
 FOR expected IN SELECT * FROM (VALUES ('shopify_native_members_20261017','7e189747ece488031da6173487b2aaea'),('shopify_native_flat_members_20261017','513d1b470a3313c1367e8a9fc363ad2e'))x(name,digest) LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.'||expected.name||'(jsonb,text,integer,jsonb)');
  IF md5(p.prosrc)<>expected.digest OR p.provolatile<>'s' OR NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>'postgres'
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
   OR pg_get_function_result(p.oid)<>'TABLE(source_confirmed boolean, eligible_count bigint, checked_at timestamp with time zone, member_ids jsonb)'
   OR pg_get_function_identity_arguments(p.oid)<>'rule jsonb, b text, base_list_id integer, catalog jsonb'
   OR has_function_privilege('crm_audience_api',p.oid,'EXECUTE')
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
    WHERE a.privilege_type<>'EXECUTE' OR a.grantee<>p.proowner)
  THEN RAISE EXCEPTION 'MEMBER_INSTALLED_PROFILE_DRIFT';END IF;
 END LOOP;
END $post$;

-- Candidate only. Native Listmonk objects, using the original append-only
-- audience request receipt. No new journal/table/worker/claim/lease.

SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $pre$ DECLARE expected record;p record;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_MEMBER_SOURCE_DRIFT';END IF;
 FOR expected IN SELECT * FROM (VALUES ('shopify_native_members_20261017','7e189747ece488031da6173487b2aaea'),('shopify_native_flat_members_20261017','513d1b470a3313c1367e8a9fc363ad2e'))x(name,digest) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.'||expected.name||'(jsonb,text,integer,jsonb)');
  IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM expected.digest OR p.prosecdef IS DISTINCT FROM true OR p.provolatile IS DISTINCT FROM 's'
   OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
   OR has_function_privilege('crm_audience_api',p.oid,'EXECUTE')
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE a.privilege_type<>'EXECUTE' OR a.grantee<>p.proowner)
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_MEMBER_SOURCE_DRIFT';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname='freeze_native_internal_saved_audience_20261017')
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_COLLISION_RECONCILE';END IF;
END $pre$;
CREATE FUNCTION crm_audience_v2.freeze_native_internal_saved_audience_20261017(
 access_key text, b text, audience_id uuid, expected_version integer,
 expected_definition_hash text, expected_context_hash text, expected_catalog_hash text,
 catalog_input jsonb, current_context jsonb, request_key text, payload_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $fn$
DECLARE auth record; prior record; saved record; cfg record; cohort record;
 actor_id text; ids integer[]; n integer; inserted integer; new_id integer;
 new_uuid uuid; members_hash text; payload jsonb; receipt jsonb; canonical_payload text; aggregate_catalog jsonb; source_operation text; internal_list_id integer;
BEGIN
 IF b IS NULL OR b NOT IN('fish','aristo') OR audience_id IS NULL
  OR expected_version IS NULL OR expected_version<1
  OR expected_definition_hash IS NULL OR expected_definition_hash!~'^[a-f0-9]{64}$'
  OR expected_context_hash IS NULL OR expected_context_hash!~'^[a-f0-9]{64}$'
  OR expected_catalog_hash IS NULL OR expected_catalog_hash!~'^[a-f0-9]{64}$'
  OR payload_hash IS NULL OR payload_hash!~'^[a-f0-9]{64}$'
  OR request_key IS NULL OR request_key!~'^[A-Za-z0-9_.:-]{8,128}$'
  OR jsonb_typeof(catalog_input) IS DISTINCT FROM 'object'
  OR catalog_input->>'brand' IS DISTINCT FROM b
  OR catalog_input->'current' IS DISTINCT FROM 'true'::jsonb
  OR catalog_input->>'catalog_hash' IS DISTINCT FROM expected_catalog_hash
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_INPUT'; END IF;
 SELECT * INTO STRICT auth FROM crm_audience_v2.authenticate(access_key);
 actor_id:=auth.operator->>'who';
 IF auth.live_count IS DISTINCT FROM 1 OR actor_id IS NULL
  OR auth.live_actor IS DISTINCT FROM actor_id
  OR jsonb_typeof(auth.operator->'caps') IS DISTINCT FROM 'array'
  OR (auth.operator->'caps' ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_DENIED'; END IF;
 payload:=jsonb_build_object('acao','segmento_congelar_nativo_interno','brand',b,
  'id',audience_id,'expected_version',expected_version,
  'expected_definition_hash',expected_definition_hash,
  'expected_context_hash',expected_context_hash,'expected_catalog_hash',expected_catalog_hash,
  'idempotency_key',request_key);
 -- This exact payload has only flat ASCII keys and scalar string/integer
 -- values, so this ordering is the original JS canonical serializer's output.
 SELECT '{'||string_agg(to_json(k)::text||':'||v::text,',' ORDER BY k COLLATE "C")||'}'
 INTO canonical_payload FROM jsonb_each(payload) e(k,v);
 IF encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')<>payload_hash
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_PAYLOAD_HASH'; END IF;
 -- Same lock and original receipt used by existing audience operations.
 PERFORM pg_advisory_xact_lock(hashtextextended(
  'crm-audience-v2-request:'||jsonb_build_array(actor_id,request_key)::text,0));
 SELECT * INTO STRICT auth FROM crm_audience_v2.authenticate(access_key);
 IF auth.live_count IS DISTINCT FROM 1 OR auth.live_actor IS DISTINCT FROM actor_id
  OR auth.operator->>'who' IS DISTINCT FROM actor_id
  OR jsonb_typeof(auth.operator->'caps') IS DISTINCT FROM 'array'
  OR (auth.operator->'caps' ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ACCESS_CHANGED'; END IF;
 SELECT * INTO prior FROM crm_audience_v2.request r
  WHERE r.actor=actor_id AND r.operation_key=request_key;
 IF FOUND THEN
  IF prior.brand IS DISTINCT FROM b OR prior.payload IS DISTINCT FROM payload
   OR prior.payload_hash IS DISTINCT FROM payload_hash
  THEN RAISE EXCEPTION 'NATIVE_FREEZE_REQUEST_CONFLICT'; END IF;
  RETURN prior.response;
 END IF;
 SELECT * INTO STRICT saved FROM crm_audience_v2.audience a
  WHERE a.id=audience_id AND a.brand=b FOR SHARE;
 IF saved.archived OR saved.version<>expected_version
  OR saved.definition_hash<>expected_definition_hash
  OR saved.context_hash<>expected_context_hash
  OR saved.context IS DISTINCT FROM current_context
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_AUDIENCE_CHANGED'; END IF;
 SELECT * INTO STRICT cfg FROM crm_audience_v2.config_snapshot(b);
 IF cfg.enabled IS DISTINCT FROM true OR cfg.base_list_id IS DISTINCT FROM (CASE WHEN b='aristo' THEN 16 ELSE 17 END)
  OR current_context#>>'{base,id}' IS DISTINCT FROM cfg.base_list_id::text
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_SOURCE_UNAVAILABLE'; END IF;
 -- A customer cannot enter this rehearsal even if the caller passes a broad
 -- saved audience. The same original base/consent predicates still apply.
 internal_list_id:=CASE WHEN b='aristo' THEN 176 ELSE 175 END;
 PERFORM 1 FROM public.lists l WHERE l.id=internal_list_id AND l.status::text='active'
  AND l.optin::text IN ('single','double') AND public.shrigma_campaign_list_brand(l)=b FOR SHARE OF l;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_INTERNAL_LIST_UNCONFIRMED';END IF;
 PERFORM 1 FROM public.subscribers s WHERE s.id=26948228 AND s.status::text='enabled'
  AND lower(s.email)='felipebandeira+codex@oaristocrata.com' FOR SHARE OF s;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_INTERNAL_IDENTITY_UNCONFIRMED';END IF;
 PERFORM 1 FROM public.subscriber_lists sl WHERE sl.subscriber_id=26948228
  AND sl.list_id IN (cfg.base_list_id,internal_list_id) AND sl.status::text='confirmed' FOR SHARE OF sl;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>2
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_CONSENT_UNCONFIRMED';END IF;
 -- Protect the chosen export from promotion until this atomic list/receipt
 -- commits. No source value is changed and no snapshot is fabricated.
 SELECT s.current_operation INTO source_operation FROM crm_audience_v2.shopify_source s
  WHERE s.brand=b FOR SHARE OF s;
 -- Same aggregate projection as Source76. Recorded-origin rules require the
 -- existing inline resolver and are deliberately not admitted by this helper.
 IF jsonb_path_exists(saved.definition,'$.rule.** ? (@.field == "signup.recorded_origin")')
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_RULE_UNSUPPORTED'; END IF;
 aggregate_catalog:=catalog_input-'recorded_origins';
 aggregate_catalog:=jsonb_set(aggregate_catalog,'{fields}',coalesce((
  SELECT jsonb_agg(f) FROM jsonb_array_elements(catalog_input->'fields') f
  WHERE f->>'key'<>'signup.recorded_origin'),'[]'::jsonb));
 SELECT * INTO STRICT cohort FROM crm_audience_v2.shopify_native_flat_members_20261017(
  saved.definition->'rule',b,cfg.base_list_id,aggregate_catalog);
 IF cohort.source_confirmed IS DISTINCT FROM true OR cohort.member_ids IS NULL
  OR cohort.eligible_count IS NULL OR cohort.eligible_count<1
  OR cohort.eligible_count<>1 OR jsonb_typeof(cohort.member_ids)<>'array'
  OR jsonb_array_length(cohort.member_ids)<>cohort.eligible_count
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_MEMBERS_UNCONFIRMED'; END IF;
 SELECT array_agg(v::integer ORDER BY v::integer) INTO ids
  FROM jsonb_array_elements_text(cohort.member_ids) e(v);
 IF (SELECT count(DISTINCT v) FROM unnest(ids) u(v))<>cardinality(ids)
  OR EXISTS(SELECT 1 FROM unnest(ids) u(v) WHERE v IS NULL OR v<1)
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_MEMBER_GRAIN'; END IF;
 n:=cardinality(ids);
 IF n<>1 OR ids[1]<>26948228 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_RECIPIENT_REFUSED';END IF;
 members_hash:=encode(sha256(convert_to('['||array_to_string(ids,',')||']','UTF8')),'hex');
 -- No source-list/subscriber/global-status update. Every inserted object is new.
 new_uuid:=gen_random_uuid();
 INSERT INTO public.lists(uuid,name,type,optin,status,tags,description)
 VALUES(new_uuid,'CRM · '||b||' · público '||audience_id::text||' · '||left(request_key,16),
  'private','double','active',ARRAY[b,'crm-frozen-snapshot'],
  'crm-native-frozen-v1; audience='||audience_id::text||'; revision='||expected_version||'; members_sha256='||members_hash)
 RETURNING id INTO new_id;
 INSERT INTO public.subscriber_lists(subscriber_id,list_id,status)
 SELECT id,new_id,'confirmed' FROM unnest(ids) u(id);
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>n THEN RAISE EXCEPTION 'NATIVE_FREEZE_INSERT_MISMATCH'; END IF;
 SELECT * INTO STRICT auth FROM crm_audience_v2.authenticate(access_key);
 IF auth.live_count IS DISTINCT FROM 1 OR auth.live_actor IS DISTINCT FROM actor_id
  OR auth.operator->>'who' IS DISTINCT FROM actor_id
  OR jsonb_typeof(auth.operator->'caps') IS DISTINCT FROM 'array'
  OR (auth.operator->'caps' ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ACCESS_CHANGED'; END IF;
 receipt:=jsonb_build_object('_http',200,'_body',jsonb_build_object(
  'contract','crm-native-frozen-internal-list-v2','brand',b,'audience_id',audience_id,
  'audience_version',saved.version,'definition_hash',saved.definition_hash,
  'list_id',new_id,'list_uuid',new_uuid,'eligible_count',n,
  'members_sha256',members_hash,'checked_at',cohort.checked_at,
  'internal_test',true,'source_operation_sha256',CASE WHEN source_operation IS NULL THEN NULL ELSE encode(sha256(convert_to(source_operation,'UTF8')),'hex') END,
  'schedules',false,'sends',false));
 INSERT INTO crm_audience_v2.request(actor,operation_key,brand,payload,payload_hash,response)
 VALUES(actor_id,request_key,b,payload,payload_hash,receipt);
 RETURN receipt;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.freeze_native_internal_saved_audience_20261017(text,text,uuid,integer,text,text,text,jsonb,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_audience_v2.freeze_native_internal_saved_audience_20261017(text,text,uuid,integer,text,text,text,jsonb,jsonb,text,text) TO crm_audience_api;
DO $post$ DECLARE p record;BEGIN
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='crm_audience_v2.freeze_native_internal_saved_audience_20261017(text,text,uuid,integer,text,text,text,jsonb,jsonb,text,text)'::regprocedure;
 IF md5(p.prosrc)<>'bd6a5bf2891da92212422a54ee12b6f9' OR p.provolatile<>'v' OR NOT p.prosecdef
  OR pg_get_userbyid(p.proowner)<>'postgres' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
  OR pg_get_function_result(p.oid)<>'jsonb' OR NOT has_function_privilege('crm_audience_api',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
   WHERE a.privilege_type<>'EXECUTE' OR a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='crm_audience_api') OR a.is_grantable))
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_PROFILE_DRIFT';END IF;
END $post$;

COMMIT;
