CREATE OR REPLACE FUNCTION crm_audience_v2.freeze_native_internal_saved_audience_20261017(access_key text, b text, audience_id uuid, expected_version integer, expected_definition_hash text, expected_context_hash text, expected_catalog_hash text, catalog_input jsonb, current_context jsonb, request_key text, payload_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE copy_readback record; auth record; prior record; saved record; cfg record; cohort record;
 actor_id text; ids integer[]; n integer; inserted integer; new_id integer;
 new_uuid uuid; members_hash text; payload jsonb; receipt jsonb; canonical_payload text; aggregate_catalog jsonb; source_operation text; internal_list_id integer; is_v3 boolean; origin_ids integer[]; origins jsonb; base_row public.lists%ROWTYPE; states_wire text; identity_wire text; states_hash text; identity_hash text; meta_hash text;
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
 -- Absence is checked only under the original actor/key advisory lock.
 -- A list without its atomic receipt must never be silently duplicated.
 IF EXISTS(SELECT 1 FROM public.lists l WHERE l.type::text='private' AND l.tags @> ARRAY[b,'crm-frozen-snapshot']::varchar[]
  AND l.name='CRM · '||b||' · público '||audience_id::text||' · '||left(request_key,16)
  AND l.description LIKE '%audience='||audience_id::text||';%')
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ORPHAN_UNCONFIRMED';END IF;
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
 is_v3:=audience_id IS DISTINCT FROM (CASE b WHEN 'aristo' THEN '23b3132a-a00b-41d3-ac31-0216a37f6100' ELSE '6b034a75-a02f-4a0e-9b18-43c4be87881b' END)::uuid;
 IF is_v3 THEN
 -- Origins come from the saved definition and its pinned context, never input.
 SELECT array_agg(id ORDER BY id) INTO origin_ids FROM (
  SELECT cfg.base_list_id id UNION
  SELECT (rule->>'list_id')::integer FROM jsonb_path_query(saved.definition,'strict $.rule.** ? (@.op == "in_list")') rule
 ) selected;
 IF origin_ids IS NULL OR cardinality(origin_ids)<1 OR jsonb_typeof(current_context->'rules') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ORIGINS_UNCONFIRMED';END IF;
 PERFORM l.id FROM public.lists l WHERE l.id=ANY(origin_ids) ORDER BY l.id FOR SHARE OF l;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>cardinality(origin_ids) THEN RAISE EXCEPTION 'NATIVE_FREEZE_ORIGINS_UNCONFIRMED';END IF;
 SELECT * INTO STRICT base_row FROM public.lists l WHERE l.id=cfg.base_list_id;
 SELECT jsonb_agg(jsonb_build_object('id',l.id,'uuid',l.uuid,'optin',l.optin::text,'status',l.status::text) ORDER BY l.id)
 INTO origins FROM public.lists l WHERE l.id=ANY(origin_ids) AND l.status::text='active'
  AND l.optin::text IN('single','double') AND public.shrigma_campaign_list_brand(l)=b;
 IF jsonb_array_length(origins) IS DISTINCT FROM cardinality(origin_ids)
  OR current_context#>>'{base,optin}' IS DISTINCT FROM base_row.optin::text
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(current_context->'rules') c
   LEFT JOIN public.lists l ON l.id=(c->>'list_id')::integer
   WHERE c ? 'list_id' AND (l.id IS NULL OR NOT(l.id=ANY(origin_ids)) OR c->>'optin' IS DISTINCT FROM l.optin::text))
  OR EXISTS(SELECT 1 FROM unnest(origin_ids) x(id) WHERE id<>cfg.base_list_id
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(current_context->'rules') c WHERE c->>'list_id'=id::text))
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ORIGIN_CONTEXT_CHANGED';END IF;
 ELSE
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
 END IF;
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
 IF is_v3 THEN
 new_uuid:=gen_random_uuid();
 <<bulk_selection>>
 DECLARE rule_node record;node_count integer:=0;op text;field text;key text;pin text;expected text;expression text;statement text;
 list_ids integer[]:=ARRAY[cfg.base_list_id];lid integer;native_optin text;catalog_ready boolean;needs_product boolean:=false;
 shopify_rules jsonb:='{}'::jsonb;ready_leaves jsonb:='{}'::jsonb;product_columns text:='';product_joins text:='';
 rule jsonb:=saved.definition->'rule'; catalog jsonb:=aggregate_catalog; base_list_id integer:=cfg.base_list_id;
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
  RAISE EXCEPTION 'NATIVE_FREEZE_TYPE_DRIFT';
 END IF;
 IF b IS NULL OR b NOT IN('fish','aristo') OR base_list_id IS NULL OR base_list_id<1
  OR jsonb_typeof(rule) IS DISTINCT FROM 'object' OR jsonb_typeof(catalog) IS DISTINCT FROM 'object'
  OR catalog->>'brand' IS DISTINCT FROM b OR catalog->'current' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(catalog->'lists') IS DISTINCT FROM 'array' OR jsonb_array_length(catalog->'lists')>1000
  OR jsonb_typeof(catalog->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(catalog->'fields')>7
  OR jsonb_typeof(catalog->'products') IS DISTINCT FROM 'array' OR jsonb_typeof(catalog->'origins') IS DISTINCT FROM 'array'
  OR octet_length(catalog::text)>16777216 THEN RAISE EXCEPTION 'SEGMENT_COUNT_INPUT'; END IF;

 FOR rule_node IN WITH RECURSIVE tree(node,depth,is_confirmed) AS (
  SELECT rule,1,false
  UNION ALL
  SELECT c.node,t.depth+1,t.node->>'op'='confirmed' FROM tree t
  CROSS JOIN LATERAL (SELECT value AS node FROM jsonb_array_elements(CASE
   WHEN t.node->>'op' IN('and','or') AND jsonb_typeof(t.node->'rules')='array' THEN t.node->'rules'
   WHEN t.node->>'op'='confirmed' THEN jsonb_build_array(t.node->'rule') ELSE '[]'::jsonb END)) c)
  SELECT node,depth,is_confirmed FROM tree
 LOOP
  node_count:=node_count+1;op:=rule_node.node->>'op';
  IF rule_node.depth>4 OR node_count>32 OR jsonb_typeof(rule_node.node) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
  IF op='in_list' THEN
   IF NOT(rule_node.node ?& ARRAY['op','list_id']) OR rule_node.node-'op'-'list_id'<>'{}'::jsonb
    OR jsonb_typeof(rule_node.node->'list_id') IS DISTINCT FROM 'number' OR rule_node.node->>'list_id' !~ '^[1-9][0-9]{0,9}$'
    OR (rule_node.node->>'list_id')::numeric>2147483647 THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   list_ids:=array_append(list_ids,(rule_node.node->>'list_id')::integer);CONTINUE;
  END IF;
  IF op IN('and','or') THEN
   IF NOT(rule_node.node ?& ARRAY['op','rules']) OR rule_node.node-'op'-'rules'<>'{}'::jsonb
    OR jsonb_typeof(rule_node.node->'rules') IS DISTINCT FROM 'array' OR jsonb_array_length(rule_node.node->'rules') NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   CONTINUE;
  END IF;
  IF op='confirmed' THEN
   IF NOT(rule_node.node ?& ARRAY['op','rule']) OR rule_node.node-'op'-'rule'<>'{}'::jsonb
    OR jsonb_typeof(rule_node.node->'rule') IS DISTINCT FROM 'object' OR rule_node.node#>>'{rule,op}' IS DISTINCT FROM 'condition'
    OR NOT crm_audience_v2.shopify_rule_valid(rule_node.node->'rule') THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   CONTINUE;
  END IF;
  IF op IS DISTINCT FROM 'condition' OR NOT(rule_node.node ?& ARRAY['op','field','operator','value'])
   OR rule_node.node-'op'-'field'-'operator'-'value'<>'{}'::jsonb THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
  field:=rule_node.node->>'field';key:=rule_node.node::text;
  IF field IN('purchase.count','purchase.amount','purchase.last_date','purchase.product') THEN
   IF NOT crm_audience_v2.shopify_rule_valid(rule_node.node) THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   SELECT count(*)=1 AND bool_and(f->'available'='true'::jsonb AND f->>'source_hash' ~ '^[a-f0-9]{64}$'),max(f->>'source_hash')
    INTO catalog_ready,pin FROM jsonb_array_elements(catalog->'fields') f WHERE f->>'key'=field;
   IF field='purchase.amount' AND coalesce(catalog->>'currency','') !~ '^[A-Z]{3}$' THEN catalog_ready:=false; END IF;
   IF field='purchase.product' AND (SELECT count(*) FROM jsonb_array_elements(catalog->'products') p
    WHERE p->>'id'=rule_node.node->>'value' AND p->>'brand'=b AND p->'available'='true'::jsonb)<>1 THEN catalog_ready:=false; END IF;
   IF NOT coalesce(catalog_ready,false) THEN
    IF rule_node.is_confirmed THEN RAISE EXCEPTION 'NATIVE_FREEZE_SOURCE_UNCONFIRMED'; END IF;
    CONTINUE;
   END IF;
   IF NOT crm_audience_v2.shopify_source_current(b,field,pin) THEN RAISE EXCEPTION 'NATIVE_FREEZE_SOURCE_UNCONFIRMED'; END IF;
   shopify_rules:=shopify_rules||jsonb_build_object(key,jsonb_build_object('rule',rule_node.node,'pin',pin));
   ready_leaves:=ready_leaves||jsonb_build_object(key,true);
   needs_product:=needs_product OR field='purchase.product';CONTINUE;
  END IF;
  IF field IN('email.opened','email.clicked') THEN
   IF rule_node.node->>'operator' NOT IN('within_last_days','not_within_last_days') OR jsonb_typeof(rule_node.node->'value') IS DISTINCT FROM 'number'
    OR rule_node.node->>'value' !~ '^[1-9][0-9]{0,3}$' OR (rule_node.node->>'value')::numeric>3650 THEN RAISE EXCEPTION 'SEGMENT_COUNT_RULE'; END IF;
   expected:=crm_audience_v2.selection_engagement_source_hash(b,field);
   SELECT count(*)=1 AND bool_and(f->'available'='true'::jsonb AND f->>'source_hash'=expected)
    INTO catalog_ready FROM jsonb_array_elements(catalog->'fields') f WHERE f->>'key'=field;
   IF coalesce(catalog_ready,false) THEN ready_leaves:=ready_leaves||jsonb_build_object(key,true); END IF;CONTINUE;
  END IF;
  IF field='signup.origin' AND rule_node.node->>'operator' IN('is','is_not') AND jsonb_typeof(rule_node.node->'value')='string'
   AND rule_node.node->>'value' IN('popup','vip_alma','vip_desodorante') THEN CONTINUE; END IF;
  RAISE EXCEPTION 'SEGMENT_COUNT_RULE';
 END LOOP;

 FOR lid IN SELECT DISTINCT unnest(list_ids) LOOP
  SELECT count(*)=1 AND bool_and(x->>'brand'=b AND x->'available'='true'::jsonb) INTO catalog_ready
   FROM jsonb_array_elements(catalog->'lists') x WHERE x->>'id'=lid::text;
  SELECT l.optin::text INTO native_optin FROM public.lists l WHERE l.id=lid AND l.status::text='active'
   AND public.shrigma_campaign_list_brand(l)=b AND l.optin::text IN('single','double');
  IF NOT coalesce(catalog_ready,false) OR NOT FOUND THEN RAISE EXCEPTION 'NATIVE_FREEZE_SOURCE_UNCONFIRMED'; END IF;
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
  SELECT s.id,s.uuid,sl.status,sl.meta,lower(btrim(s.email)) AS email FROM public.subscribers s
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
  SELECT s.id,s.uuid,s.status,s.meta,('||expression||') AS matched FROM eligible_base s LEFT JOIN shopify_facts sf ON sf.subscriber_id=s.id AND sf.subscriber_uuid=s.uuid AND sf.email=s.email AND sf.identity_current IS TRUE

 ), locked AS MATERIALIZED (
  SELECT s.id,s.uuid,sl.status,sl.meta,
   s.uuid IS NOT NULL AND s.uuid=e.uuid AND s.status::text=''enabled'' AND sl.status=e.status AND sl.meta IS NOT DISTINCT FROM e.meta
    AND (sl.status::text=''confirmed'' OR l.optin::text=''single'' AND sl.status::text=''unconfirmed'') AS unchanged
  FROM evaluated e JOIN public.subscribers s ON s.id=e.id
  JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$2::integer
  JOIN public.lists l ON l.id=sl.list_id
  WHERE e.matched IS TRUE ORDER BY s.id FOR SHARE OF s,sl
 ), locked_summary AS MATERIALIZED (
  SELECT count(*)::bigint AS locked_count,bool_and(unchanged IS TRUE) AS unchanged FROM locked
 ), summary AS MATERIALIZED (
  SELECT count(*) FILTER(WHERE matched IS TRUE)::bigint AS matched_count,
   count(*) FILTER(WHERE matched IS NULL)::bigint AS unknown_count,
   count(DISTINCT id) FILTER(WHERE matched IS TRUE)::bigint AS unique_count,
   encode(sha256(convert_to(''[''||string_agg(id::text,'','' ORDER BY id) FILTER(WHERE matched IS TRUE)||'']'',''UTF8'')),''hex'') AS members_hash,
   encode(sha256(convert_to(''[''||string_agg(''[''||id::text||'',''||to_json(status::text)::text||'']'','','' ORDER BY id) FILTER(WHERE matched IS TRUE)||'']'',''UTF8'')),''hex'') AS states_hash,
   encode(sha256(convert_to(''[''||string_agg(''[''||id::text||'',''||to_json(uuid::text)::text||'']'','','' ORDER BY id) FILTER(WHERE matched IS TRUE)||'']'',''UTF8'')),''hex'') AS identity_hash,
   encode(sha256(convert_to((jsonb_agg(jsonb_build_array(id,meta) ORDER BY id) FILTER(WHERE matched IS TRUE))::text,''UTF8'')),''hex'') AS meta_hash
  FROM evaluated
 ), frozen AS (
  INSERT INTO public.lists(uuid,name,type,optin,status,tags,description)
  SELECT $4::uuid,''CRM · ''||$1||'' · público ''||$5::text||'' · ''||left($7::text,16),
   ''private'',l.optin,''active'',ARRAY[$1::text,''crm-frozen-snapshot''],
   ''crm-native-frozen-list-v3; audience=''||$5::text||''; revision=''||$6::text||''; members_sha256=''||summary.members_hash
  FROM summary CROSS JOIN locked_summary JOIN public.lists l ON l.id=$2::integer
  WHERE summary.unknown_count=0 AND summary.matched_count>0 AND summary.unique_count=summary.matched_count
   AND locked_summary.locked_count=summary.matched_count AND locked_summary.unchanged IS TRUE
  RETURNING id,uuid
 ), copied AS (
  INSERT INTO public.subscriber_lists(subscriber_id,list_id,status,meta)
  SELECT e.id,f.id,e.status,e.meta FROM locked e CROSS JOIN frozen f
  RETURNING subscriber_id,list_id,status,meta
 ), copied_summary AS (
  SELECT count(*)::bigint AS copied_count,bool_and(list_id=(SELECT id FROM frozen)) AS right_list,
   encode(sha256(convert_to(''[''||string_agg(subscriber_id::text,'','' ORDER BY subscriber_id)||'']'',''UTF8'')),''hex'') AS members_hash,
   encode(sha256(convert_to(''[''||string_agg(''[''||subscriber_id::text||'',''||to_json(status::text)::text||'']'','','' ORDER BY subscriber_id)||'']'',''UTF8'')),''hex'') AS states_hash,
   encode(sha256(convert_to(jsonb_agg(jsonb_build_array(subscriber_id,meta) ORDER BY subscriber_id)::text,''UTF8'')),''hex'') AS meta_hash
  FROM copied
 ) SELECT summary.*,copied_summary.copied_count,
  summary.members_hash IS NOT DISTINCT FROM copied_summary.members_hash AND summary.states_hash IS NOT DISTINCT FROM copied_summary.states_hash
   AND summary.meta_hash IS NOT DISTINCT FROM copied_summary.meta_hash AND copied_summary.right_list IS TRUE AS copy_same,
  frozen.id AS list_id,frozen.uuid AS list_uuid,statement_timestamp() AS checked_at
 FROM summary CROSS JOIN copied_summary LEFT JOIN frozen ON true';
 EXECUTE statement INTO STRICT cohort USING b,cfg.base_list_id,shopify_rules,new_uuid,audience_id,expected_version,request_key;
 IF cohort.unknown_count<>0 OR cohort.matched_count<1 OR cohort.unique_count<>cohort.matched_count
  OR cohort.copied_count<>cohort.matched_count OR cohort.copy_same IS DISTINCT FROM true OR cohort.list_id IS NULL
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_COPY_UNCONFIRMED';END IF;
 new_id:=cohort.list_id;n:=cohort.matched_count;members_hash:=cohort.members_hash;
 states_hash:=cohort.states_hash;identity_hash:=cohort.identity_hash;meta_hash:=cohort.meta_hash;

END bulk_selection;

 SELECT count(*)::bigint AS n,
  encode(sha256(convert_to('['||string_agg(sl.subscriber_id::text,',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex') AS members_hash,
  encode(sha256(convert_to('['||string_agg('['||sl.subscriber_id::text||','||to_json(sl.status::text)::text||']',',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex') AS states_hash,
  encode(sha256(convert_to('['||string_agg('['||s.id::text||','||to_json(s.uuid::text)::text||']',',' ORDER BY s.id)||']','UTF8')),'hex') AS identity_hash,
  encode(sha256(convert_to(jsonb_agg(jsonb_build_array(sl.subscriber_id,sl.meta) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex') AS meta_hash
 INTO copy_readback FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id WHERE sl.list_id=new_id;
 IF copy_readback.n<>n OR copy_readback.members_hash IS DISTINCT FROM members_hash OR copy_readback.states_hash IS DISTINCT FROM states_hash
  OR copy_readback.identity_hash IS DISTINCT FROM identity_hash OR copy_readback.meta_hash IS DISTINCT FROM meta_hash
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_COPY_CHANGED';END IF;
 ELSE
 SELECT * INTO STRICT cohort FROM crm_audience_v2.shopify_native_flat_members_20261017(
  saved.definition->'rule',b,cfg.base_list_id,aggregate_catalog);
 IF cohort.source_confirmed IS DISTINCT FROM true OR cohort.member_ids IS NULL
  OR cohort.eligible_count IS NULL OR cohort.eligible_count<1
  OR (NOT is_v3 AND cohort.eligible_count<>1) OR jsonb_typeof(cohort.member_ids)<>'array'
  OR jsonb_array_length(cohort.member_ids)<>cohort.eligible_count
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_MEMBERS_UNCONFIRMED'; END IF;
 SELECT array_agg(v::integer ORDER BY v::integer) INTO ids
  FROM jsonb_array_elements_text(cohort.member_ids) e(v);
 IF (SELECT count(DISTINCT v) FROM unnest(ids) u(v))<>cardinality(ids)
  OR EXISTS(SELECT 1 FROM unnest(ids) u(v) WHERE v IS NULL OR v<1)
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_MEMBER_GRAIN'; END IF;
 n:=cardinality(ids);
 IF is_v3 THEN
 -- Narrow ordered locks protect only this new cohort while its list is copied.
 PERFORM s.id FROM public.subscribers s WHERE s.id=ANY(ids) ORDER BY s.id FOR SHARE OF s;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>n OR EXISTS(SELECT 1 FROM public.subscribers s WHERE s.id=ANY(ids) AND (s.status::text<>'enabled' OR s.uuid IS NULL))
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_MEMBER_CHANGED';END IF;
 PERFORM sl.subscriber_id FROM public.subscriber_lists sl WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids)
  ORDER BY sl.subscriber_id FOR SHARE OF sl;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>n OR EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids)
  AND NOT(sl.status::text='confirmed' OR base_row.optin::text='single' AND sl.status::text='unconfirmed'))
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_CONSENT_CHANGED';END IF;
 SELECT '['||string_agg('['||sl.subscriber_id::text||','||to_json(sl.status::text)::text||']',',' ORDER BY sl.subscriber_id)||']'
 INTO states_wire FROM public.subscriber_lists sl WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids);
 SELECT '['||string_agg('['||s.id::text||','||to_json(s.uuid::text)::text||']',',' ORDER BY s.id)||']'
 INTO identity_wire FROM public.subscribers s WHERE s.id=ANY(ids);
 states_hash:=encode(sha256(convert_to(states_wire,'UTF8')),'hex');
 identity_hash:=encode(sha256(convert_to(identity_wire,'UTF8')),'hex');
 -- Metadata hash is deliberately SQL-opaque; JS never hashes jsonb::text.
 SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(sl.subscriber_id,sl.meta) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex')
 INTO meta_hash FROM public.subscriber_lists sl WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids);
 ELSE
 IF n<>1 OR ids[1]<>26948228 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_RECIPIENT_REFUSED';END IF;
 END IF;
 members_hash:=encode(sha256(convert_to('['||array_to_string(ids,',')||']','UTF8')),'hex');
 IF is_v3 THEN
 new_uuid:=gen_random_uuid();
 INSERT INTO public.lists(uuid,name,type,optin,status,tags,description)
 VALUES(new_uuid,'CRM · '||b||' · público '||audience_id::text||' · '||left(request_key,16),
  'private',base_row.optin,'active',ARRAY[b,'crm-frozen-snapshot'],
  'crm-native-frozen-list-v3; audience='||audience_id::text||'; revision='||expected_version||'; members_sha256='||members_hash)
 RETURNING id INTO new_id;
 INSERT INTO public.subscriber_lists(subscriber_id,list_id,status,meta)
 SELECT sl.subscriber_id,new_id,sl.status,sl.meta FROM public.subscriber_lists sl
 WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids);
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>n OR states_hash IS DISTINCT FROM (
  SELECT encode(sha256(convert_to('['||string_agg('['||sl.subscriber_id::text||','||to_json(sl.status::text)::text||']',',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex')
  FROM public.subscriber_lists sl WHERE sl.list_id=new_id)
 OR meta_hash IS DISTINCT FROM (
  SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(sl.subscriber_id,sl.meta) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex')
  FROM public.subscriber_lists sl WHERE sl.list_id=new_id)
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_COPY_CHANGED';END IF;
 ELSE
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
 END IF;
 END IF;
 SELECT * INTO STRICT auth FROM crm_audience_v2.authenticate(access_key);
 IF auth.live_count IS DISTINCT FROM 1 OR auth.live_actor IS DISTINCT FROM actor_id
  OR auth.operator->>'who' IS DISTINCT FROM actor_id
  OR jsonb_typeof(auth.operator->'caps') IS DISTINCT FROM 'array'
  OR (auth.operator->'caps' ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ACCESS_CHANGED'; END IF;
 IF is_v3 THEN
 receipt:=jsonb_build_object('_http',200,'_body',jsonb_build_object(
  'contract','crm-native-frozen-list-v3','brand',b,'audience_id',audience_id,'audience_version',saved.version,
  'definition_hash',saved.definition_hash,'list_id',new_id,'list_uuid',new_uuid,'list_optin',base_row.optin::text,
  'eligible_count',n,'members_sha256',members_hash,'members_state_sha256',states_hash,
  'members_identity_sha256',identity_hash,'members_meta_sha256',meta_hash,
  'base',jsonb_build_object('id',base_row.id,'uuid',base_row.uuid,'optin',base_row.optin::text,'status',base_row.status::text),
  'origins',origins,'checked_at',cohort.checked_at,'frozen_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'source_operation_sha256',CASE WHEN source_operation IS NULL THEN NULL ELSE encode(sha256(convert_to(source_operation,'UTF8')),'hex') END,
  'sends',false,'schedules',false));
 ELSE
 receipt:=jsonb_build_object('_http',200,'_body',jsonb_build_object(
  'contract','crm-native-frozen-internal-list-v2','brand',b,'audience_id',audience_id,
  'audience_version',saved.version,'definition_hash',saved.definition_hash,
  'list_id',new_id,'list_uuid',new_uuid,'eligible_count',n,
  'members_sha256',members_hash,'checked_at',cohort.checked_at,
  'internal_test',true,'source_operation_sha256',CASE WHEN source_operation IS NULL THEN NULL ELSE encode(sha256(convert_to(source_operation,'UTF8')),'hex') END,
  'schedules',false,'sends',false));
 END IF;
 INSERT INTO crm_audience_v2.request(actor,operation_key,brand,payload,payload_hash,response)
 VALUES(actor_id,request_key,b,payload,payload_hash,receipt);
 RETURN receipt;
END $function$

