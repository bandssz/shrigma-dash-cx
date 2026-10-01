-- Candidate only: versioned RFM source, OFF until a guarded rollout installs
-- exact Customer and paid-order query pins plus historical-access evidence.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='20s';
DO $guard$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR current_setting('server_version_num')::integer<170000 THEN RAISE EXCEPTION 'RFM_INSTALL_CONTEXT'; END IF;
 IF to_regclass('crm_audience_v2.shopify_identity') IS NULL OR to_regclass('public.subscribers') IS NULL
  OR to_regrole('crm_shopify_sync') IS NULL OR to_regrole('crm_audience_api') IS NULL THEN RAISE EXCEPTION 'RFM_INSTALL_PREREQUISITE'; END IF;
END $guard$;
CREATE TABLE crm_audience_v2.rfm_source(
 brand text PRIMARY KEY CHECK(brand IN('fish','aristo')),
 shop_id text NOT NULL CHECK(shop_id~'^gid://shopify/Shop/[1-9][0-9]{0,19}$'),
 customer_query_sha256 text NOT NULL CHECK(customer_query_sha256~'^[0-9a-f]{64}$'),
 paid_orders_query_sha256 text NOT NULL CHECK(paid_orders_query_sha256~'^[0-9a-f]{64}$'),
 workflow_id text NOT NULL CHECK(length(workflow_id) BETWEEN 1 AND 128),
 producer_revision text NOT NULL CHECK(producer_revision~'^[0-9a-f]{7,64}$'),
 algorithm_sha256 text NOT NULL CHECK(algorithm_sha256~'^[0-9a-f]{64}$'),
 source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
 current_operation uuid,
 max_age_seconds integer NOT NULL DEFAULT 93600 CHECK(max_age_seconds=93600),
 ingestion_enabled boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT false,
 CHECK(NOT enabled OR ingestion_enabled)
);
CREATE TABLE crm_audience_v2.rfm_batch(
 brand text NOT NULL REFERENCES crm_audience_v2.rfm_source(brand),operation_id uuid NOT NULL,
 customer_bulk_gid text NOT NULL CHECK(customer_bulk_gid~'^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$'),
 paid_orders_bulk_gid text NOT NULL CHECK(paid_orders_bulk_gid~'^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$'),
 customer_payload_sha256 text NOT NULL CHECK(customer_payload_sha256~'^[0-9a-f]{64}$'),
 paid_orders_payload_sha256 text NOT NULL CHECK(paid_orders_payload_sha256~'^[0-9a-f]{64}$'),
 started_at timestamptz NOT NULL,observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 expected_customers integer NOT NULL CHECK(expected_customers BETWEEN 0 AND 250000),
 resolved_customers integer NOT NULL CHECK(resolved_customers BETWEEN 0 AND expected_customers),
 history_complete boolean NOT NULL CHECK(history_complete),access_scopes text[] NOT NULL,
 status text NOT NULL CHECK(status IN('ready')),
 category_counts jsonb NOT NULL DEFAULT '{"campeao":0,"leal":0,"um_x":0,"um_x_lapsando":0,"dormant":0,"needs_attention":0,"ex_campeao_at_risk":0}'::jsonb,
 CHECK(jsonb_typeof(category_counts)='object' AND category_counts ?& ARRAY['campeao','leal','um_x','um_x_lapsando','dormant','needs_attention','ex_campeao_at_risk']
  AND category_counts-'campeao'-'leal'-'um_x'-'um_x_lapsando'-'dormant'-'needs_attention'-'ex_campeao_at_risk'='{}'::jsonb
  AND jsonb_typeof(category_counts->'campeao')='number' AND category_counts->>'campeao'~'^(0|[1-9][0-9]{0,5})$'
  AND jsonb_typeof(category_counts->'leal')='number' AND category_counts->>'leal'~'^(0|[1-9][0-9]{0,5})$'
  AND jsonb_typeof(category_counts->'um_x')='number' AND category_counts->>'um_x'~'^(0|[1-9][0-9]{0,5})$'
  AND jsonb_typeof(category_counts->'um_x_lapsando')='number' AND category_counts->>'um_x_lapsando'~'^(0|[1-9][0-9]{0,5})$'
  AND jsonb_typeof(category_counts->'dormant')='number' AND category_counts->>'dormant'~'^(0|[1-9][0-9]{0,5})$'
  AND jsonb_typeof(category_counts->'needs_attention')='number' AND category_counts->>'needs_attention'~'^(0|[1-9][0-9]{0,5})$'
  AND jsonb_typeof(category_counts->'ex_campeao_at_risk')='number' AND category_counts->>'ex_campeao_at_risk'~'^(0|[1-9][0-9]{0,5})$'
  AND ((category_counts->>'campeao')::numeric + (category_counts->>'leal')::numeric + (category_counts->>'um_x')::numeric + (category_counts->>'um_x_lapsando')::numeric + (category_counts->>'dormant')::numeric + (category_counts->>'needs_attention')::numeric + (category_counts->>'ex_campeao_at_risk')::numeric)<=expected_customers),
 PRIMARY KEY(brand,operation_id),UNIQUE(brand,customer_bulk_gid),UNIQUE(brand,paid_orders_bulk_gid),
 CHECK(customer_bulk_gid<>paid_orders_bulk_gid AND isfinite(started_at) AND isfinite(observed_at) AND isfinite(expires_at)
  AND started_at<=observed_at AND observed_at<expires_at AND expires_at<=started_at+interval '26 hours'),
 CHECK(access_scopes @> ARRAY['read_customers','read_orders','read_all_orders']::text[])
);
CREATE TABLE crm_audience_v2.rfm_fact(
 brand text NOT NULL,operation_id uuid NOT NULL,customer_gid text NOT NULL,
 subscriber_id integer,subscriber_uuid uuid,paid_orders integer NOT NULL CHECK(paid_orders BETWEEN 0 AND 2147483647),
 R smallint,M smallint,F smallint,rfm_tag text,
 PRIMARY KEY(brand,operation_id,customer_gid),
 FOREIGN KEY(brand,operation_id) REFERENCES crm_audience_v2.rfm_batch(brand,operation_id),
 CHECK(customer_gid~'^gid://shopify/Customer/[1-9][0-9]{0,24}$'),
 CHECK((subscriber_id IS NULL)=(subscriber_uuid IS NULL)),
 CHECK((paid_orders=0 AND R IS NULL AND M IS NULL AND F IS NULL AND rfm_tag IS NULL)
  OR (paid_orders>0 AND R BETWEEN 1 AND 5 AND M BETWEEN 1 AND 5 AND F IN(1,3,5)
   AND rfm_tag IN('campeao','leal','um_x','um_x_lapsando','dormant','needs_attention','ex_campeao_at_risk')))
);
CREATE UNIQUE INDEX rfm_fact_native_unique ON crm_audience_v2.rfm_fact(brand,operation_id,subscriber_uuid) WHERE subscriber_uuid IS NOT NULL;
CREATE INDEX rfm_fact_match ON crm_audience_v2.rfm_fact(brand,operation_id,subscriber_id,rfm_tag);
REVOKE ALL ON crm_audience_v2.rfm_source,crm_audience_v2.rfm_batch,crm_audience_v2.rfm_fact FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.rfm_rule_valid(rule jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT jsonb_typeof(rule)='object' AND rule ?& ARRAY['op','field','operator','value']
  AND rule-'op'-'field'-'operator'-'value'='{}'::jsonb
  AND rule->>'op'='condition' AND rule->>'field'='relationship.rfm' AND rule->>'operator'='is'
  AND jsonb_typeof(rule->'value')='string'
  AND rule->>'value' IN('campeao','leal','um_x','um_x_lapsando','dormant','needs_attention','ex_campeao_at_risk')
$fn$;
CREATE FUNCTION crm_audience_v2.rfm_snapshot(b text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT coalesce((SELECT CASE WHEN s.enabled AND s.ingestion_enabled AND t.status='ready'
   AND t.history_complete AND t.observed_at<=clock_timestamp()
   AND t.expires_at>clock_timestamp() AND t.operation_id=s.current_operation
  THEN jsonb_build_object('brand',s.brand,'current',true,'history_complete',true,
   'source_hash',s.source_hash,'operation_id',t.operation_id,'started_at',t.started_at,
   'observed_at',t.observed_at,'expires_at',t.expires_at,'customers',t.expected_customers,
   'resolved',t.resolved_customers,'unresolved',t.expected_customers-t.resolved_customers,
   'category_counts',t.category_counts,'category_scope','shopify_customers','semantics_version','shopify-customer-rfm-v4')
  ELSE jsonb_build_object('brand',b,'current',false,'history_complete',false) END
 FROM crm_audience_v2.rfm_source s JOIN crm_audience_v2.shopify_source p ON p.brand=s.brand AND p.shop_id=s.shop_id
 JOIN crm_audience_v2.rfm_batch t ON t.brand=s.brand AND t.operation_id=s.current_operation
 WHERE s.brand=b),jsonb_build_object('brand',b,'current',false,'history_complete',false))
$fn$;
CREATE FUNCTION crm_audience_v2.rfm_source_current(b text,pin text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT coalesce((SELECT s.enabled AND s.ingestion_enabled AND s.source_hash=pin
  AND t.status='ready' AND t.history_complete AND t.observed_at<=clock_timestamp()
  AND t.expires_at>clock_timestamp() AND t.operation_id=s.current_operation
 FROM crm_audience_v2.rfm_source s
 JOIN crm_audience_v2.shopify_source p ON p.brand=s.brand AND p.shop_id=s.shop_id
 JOIN crm_audience_v2.rfm_batch t ON t.brand=s.brand AND t.operation_id=s.current_operation
 WHERE s.brand=b),false)
$fn$;
CREATE FUNCTION crm_audience_v2.rfm_match(rule jsonb,sid integer,b text,pin text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT (SELECT coalesce(f.rfm_tag=(rule->>'value'),false)
  FROM crm_audience_v2.rfm_source cfg
  JOIN crm_audience_v2.shopify_source p ON p.brand=cfg.brand AND p.shop_id=cfg.shop_id
  JOIN crm_audience_v2.rfm_batch t ON t.brand=cfg.brand AND t.operation_id=cfg.current_operation
  JOIN crm_audience_v2.rfm_fact f ON f.brand=cfg.brand AND f.operation_id=cfg.current_operation AND f.subscriber_id=sid
  JOIN public.subscribers s ON s.id=f.subscriber_id AND s.uuid=f.subscriber_uuid
  JOIN crm_audience_v2.shopify_identity i ON i.brand=f.brand AND i.customer_gid=f.customer_gid
   AND i.subscriber_id=f.subscriber_id AND i.subscriber_uuid=f.subscriber_uuid AND lower(btrim(s.email))=i.email
  WHERE crm_audience_v2.rfm_rule_valid(rule) AND sid IS NOT NULL AND sid>=1 AND b IN('fish','aristo')
   AND cfg.brand=b AND cfg.enabled AND cfg.ingestion_enabled AND cfg.source_hash=pin
   AND t.status='ready' AND t.history_complete AND t.observed_at<=clock_timestamp()
   AND t.expires_at>clock_timestamp() AND t.operation_id=cfg.current_operation)
$fn$;
CREATE FUNCTION crm_audience_v2.rfm_selection_match(rule jsonb,sid integer,b text,pin text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT crm_audience_v2.rfm_match(rule,sid,b,pin)
$fn$;
CREATE FUNCTION crm_audience_v2.rfm_count_for_rule(rule jsonb,b text,base_list_id integer,pin text) RETURNS TABLE(source_confirmed boolean,eligible_count bigint,checked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 WITH current_source AS MATERIALIZED(
  SELECT s.current_operation,crm_audience_v2.rfm_source_current(b,pin) source_ok
  FROM crm_audience_v2.rfm_source s WHERE s.brand=b
 ),scope AS MATERIALIZED(
  SELECT coalesce((SELECT source_ok FROM current_source),false) source_ok,
   (SELECT current_operation FROM current_source) operation_id,
   crm_audience_v2.rfm_rule_valid(rule) rule_ok,
   (SELECT count(*)=1 FROM public.lists l WHERE l.id=base_list_id
    AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=b
    AND l.optin::text IN('single','double')) base_ok
 ),eligible AS MATERIALIZED(
  SELECT CASE WHEN NOT scope.source_ok OR NOT scope.rule_ok OR NOT scope.base_ok OR s.id<1 THEN NULL
   WHEN f.customer_gid IS NULL OR i.customer_gid IS NULL THEN NULL
   ELSE coalesce(f.rfm_tag=(rule->>'value'),false) END matched
  FROM public.subscribers s
  JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id JOIN public.lists l ON l.id=sl.list_id
  CROSS JOIN scope
  LEFT JOIN crm_audience_v2.rfm_fact f ON scope.source_ok AND scope.rule_ok AND scope.base_ok
   AND f.brand=b AND f.operation_id=scope.operation_id AND f.subscriber_id=s.id AND f.subscriber_uuid=s.uuid
  LEFT JOIN crm_audience_v2.shopify_identity i ON scope.source_ok AND scope.rule_ok
   AND i.brand=f.brand AND i.customer_gid=f.customer_gid AND i.subscriber_id=f.subscriber_id
   AND i.subscriber_uuid=f.subscriber_uuid AND lower(btrim(s.email))=i.email
  WHERE l.id=base_list_id AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=b
   AND s.status::text='enabled' AND ((l.optin::text='double' AND sl.status::text='confirmed')
    OR (l.optin::text='single' AND sl.status::text IN('confirmed','unconfirmed')))
 ),summary AS(SELECT count(*) FILTER(WHERE matched IS TRUE)::bigint yes,count(*) FILTER(WHERE matched IS NULL)::bigint unknown FROM eligible),
 ready AS(SELECT source_ok AND rule_ok AND base_ok ok FROM scope)
 SELECT ready.ok AND summary.unknown=0,CASE WHEN ready.ok AND summary.unknown=0 THEN summary.yes END,statement_timestamp() FROM ready CROSS JOIN summary
$fn$;

CREATE FUNCTION crm_audience_v2.rfm_native_context_fast(ctx jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT ctx IS NOT NULL AND ctx->'bound'='true'::jsonb
  AND crm_audience_v2.rfm_rule_valid(ctx#>'{definition,rule}')
  AND NOT(ctx ?| ARRAY['ab_test_id','ab_arm','ab_scope_hash'])
$fn$;

-- Native Listmonk fast path for an exact root relationship.rfm rule. These
-- helpers are deliberately not granted to the panel API. They validate the
-- same current source, native base consent and identity evidence as the
-- canonical matcher, but evaluate the eligible base as a set instead of
-- reopening source/configuration state once per subscriber.
CREATE FUNCTION crm_audience_v2.rfm_native_scope(ctx jsonb)
RETURNS TABLE(brand text,operation_id uuid,base_list_id integer,tag text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE cfg crm_audience_v2.rfm_source%ROWTYPE;batch crm_audience_v2.rfm_batch%ROWTYPE;base public.lists%ROWTYPE;rule jsonb;at_time timestamptz;
BEGIN
 at_time:=clock_timestamp();rule:=ctx#>'{definition,rule}';
 IF NOT coalesce(crm_audience_v2.rfm_native_context_fast(ctx),false)
  OR ctx->>'brand' NOT IN('fish','aristo') OR ctx->>'base_list_id' IS NULL OR ctx->>'base_list_id'!~'^[1-9][0-9]{0,9}$' THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
 END IF;
 SELECT * INTO cfg FROM crm_audience_v2.rfm_source s WHERE s.brand=ctx->>'brand';
 IF NOT FOUND OR NOT cfg.enabled OR NOT cfg.ingestion_enabled OR cfg.current_operation IS NULL THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.shopify_source p WHERE p.brand=cfg.brand AND p.shop_id=cfg.shop_id) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
 END IF;
 SELECT * INTO batch FROM crm_audience_v2.rfm_batch t WHERE t.brand=cfg.brand AND t.operation_id=cfg.current_operation;
 IF NOT FOUND OR batch.status<>'ready' OR NOT batch.history_complete OR batch.observed_at>at_time OR batch.expires_at<=at_time THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
 END IF;
 SELECT * INTO base FROM public.lists l WHERE l.id=(ctx->>'base_list_id')::integer;
 IF NOT FOUND OR base.status::text<>'active' OR public.shrigma_campaign_list_brand(base) IS DISTINCT FROM cfg.brand
  OR base.optin::text NOT IN('single','double') THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
 END IF;
 IF jsonb_typeof(ctx->'list_pins') IS DISTINCT FROM 'array'
  OR (SELECT count(*) FROM jsonb_array_elements(ctx->'list_pins') pin
      WHERE pin->'list_id'=to_jsonb(base.id) AND pin->>'optin'=base.optin::text)<>1 THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
 END IF;
 RETURN QUERY SELECT cfg.brand,cfg.current_operation,base.id,rule->>'value';
END $fn$;

CREATE FUNCTION crm_audience_v2.rfm_native_count(ctx jsonb)
RETURNS TABLE(to_send bigint,max_subscriber_id integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE scope record;yes_count bigint;max_id integer;unknown_count bigint;
BEGIN
 IF coalesce(crm_audience_v2.rfm_native_context_fast(ctx),false) IS NOT TRUE THEN RETURN; END IF;
 SELECT * INTO STRICT scope FROM crm_audience_v2.rfm_native_scope(ctx);
 WITH eligible AS MATERIALIZED(
  SELECT s.id,f.rfm_tag,(f.customer_gid IS NOT NULL AND i.customer_gid IS NOT NULL) known
  FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id
  LEFT JOIN crm_audience_v2.rfm_fact f ON f.brand=scope.brand AND f.operation_id=scope.operation_id
   AND f.subscriber_id=s.id AND f.subscriber_uuid=s.uuid
  LEFT JOIN crm_audience_v2.shopify_identity i ON i.brand=f.brand AND i.customer_gid=f.customer_gid
   AND i.subscriber_id=f.subscriber_id AND i.subscriber_uuid=f.subscriber_uuid AND lower(btrim(s.email))=i.email
  WHERE sl.list_id=scope.base_list_id AND s.status::text='enabled'
   AND ((SELECT l.optin::text FROM public.lists l WHERE l.id=scope.base_list_id)='double' AND sl.status::text='confirmed'
    OR (SELECT l.optin::text FROM public.lists l WHERE l.id=scope.base_list_id)='single' AND sl.status::text IN('confirmed','unconfirmed'))
 )
 SELECT count(*) FILTER(WHERE known AND rfm_tag=scope.tag),max(id) FILTER(WHERE known AND rfm_tag=scope.tag),count(*) FILTER(WHERE NOT known)
 INTO yes_count,max_id,unknown_count FROM eligible;
 IF unknown_count<>0 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
 PERFORM 1 FROM crm_audience_v2.rfm_native_scope(ctx);
 RETURN QUERY SELECT yes_count,coalesce(max_id,0);
END $fn$;

CREATE FUNCTION crm_audience_v2.rfm_native_subscriber_ids(ctx jsonb,campaign_type text,list_ids integer[],after_id integer,max_id integer,batch_limit integer)
RETURNS TABLE(id integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE scope record;ignored record;
BEGIN
 IF coalesce(crm_audience_v2.rfm_native_context_fast(ctx),false) IS NOT TRUE THEN RETURN; END IF;
 SELECT * INTO STRICT scope FROM crm_audience_v2.rfm_native_scope(ctx);
 IF campaign_type IS DISTINCT FROM 'regular' OR list_ids IS DISTINCT FROM ARRAY[scope.base_list_id]
  OR after_id IS NULL OR after_id<0 OR max_id IS NULL OR max_id<after_id OR batch_limit IS NULL OR batch_limit<1 THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
 END IF;
 -- This full-base validation preserves NULL/unknown semantics before any page
 -- is returned. A sparse/zero category cannot silently discard an unresolved
 -- eligible subscriber through an inner join.
 SELECT * INTO STRICT ignored FROM crm_audience_v2.rfm_native_count(ctx);
 RETURN QUERY
  SELECT s.id FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id
  JOIN crm_audience_v2.rfm_fact f ON f.brand=scope.brand AND f.operation_id=scope.operation_id
   AND f.subscriber_id=s.id AND f.subscriber_uuid=s.uuid AND f.rfm_tag=scope.tag
  JOIN crm_audience_v2.shopify_identity i ON i.brand=f.brand AND i.customer_gid=f.customer_gid
   AND i.subscriber_id=f.subscriber_id AND i.subscriber_uuid=f.subscriber_uuid AND lower(btrim(s.email))=i.email
  WHERE sl.list_id=scope.base_list_id AND s.status::text='enabled'
   AND ((SELECT l.optin::text FROM public.lists l WHERE l.id=scope.base_list_id)='double' AND sl.status::text='confirmed'
    OR (SELECT l.optin::text FROM public.lists l WHERE l.id=scope.base_list_id)='single' AND sl.status::text IN('confirmed','unconfirmed'))
   AND s.id>after_id AND s.id<=max_id ORDER BY s.id LIMIT batch_limit;
 PERFORM 1 FROM crm_audience_v2.rfm_native_scope(ctx);
END $fn$;

-- One full, versioned snapshot per brand. ingestion_enabled is the stable
-- collector gate; enabled publishes the first successful operation and remains
-- true while later operations are validated and swapped atomically.
CREATE FUNCTION crm_audience_v2.rfm_ingest_snapshot(meta jsonb,customers jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
#variable_conflict use_variable
DECLARE cfg crm_audience_v2.rfm_source%ROWTYPE;prior crm_audience_v2.rfm_batch%ROWTYPE;parent_shop_id text;
 source_brand text;source_operation uuid;expected integer;resolved integer;
 new_started timestamptz;new_observed timestamptz;new_expires timestamptz;at_time timestamptz;
BEGIN
 IF jsonb_typeof(meta)<>'object' OR meta-'brand'-'operation_id'-'shop_id'-'customer_bulk_gid'-'paid_orders_bulk_gid'
  -'customer_query_sha256'-'paid_orders_query_sha256'-'customer_payload_sha256'-'paid_orders_payload_sha256'
  -'workflow_id'-'producer_revision'-'algorithm_sha256'-'access_scopes'-'history_complete'-'started_at'-'observed_at'-'expires_at'-'expected_customers'<>'{}'::jsonb
  OR NOT(meta ?& ARRAY['brand','operation_id','shop_id','customer_bulk_gid','paid_orders_bulk_gid','customer_query_sha256','paid_orders_query_sha256','customer_payload_sha256','paid_orders_payload_sha256','workflow_id','producer_revision','algorithm_sha256','access_scopes','history_complete','started_at','observed_at','expires_at','expected_customers'])
  OR jsonb_typeof(customers)<>'array' OR jsonb_array_length(customers)>250000 THEN RAISE EXCEPTION 'RFM_INGEST_SHAPE'; END IF;
 source_brand:=meta->>'brand';source_operation:=(meta->>'operation_id')::uuid;expected:=(meta->>'expected_customers')::integer;
 new_started:=(meta->>'started_at')::timestamptz;new_observed:=(meta->>'observed_at')::timestamptz;new_expires:=(meta->>'expires_at')::timestamptz;
 SELECT shop_id INTO parent_shop_id FROM crm_audience_v2.shopify_source WHERE brand=source_brand FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RFM_INGEST_GUARD'; END IF;
 SELECT * INTO STRICT cfg FROM crm_audience_v2.rfm_source WHERE brand=source_brand FOR UPDATE;
 IF NOT cfg.ingestion_enabled OR cfg.shop_id<>parent_shop_id OR cfg.shop_id<>meta->>'shop_id'
  OR parent_shop_id<>meta->>'shop_id' OR cfg.customer_query_sha256<>meta->>'customer_query_sha256'
  OR cfg.paid_orders_query_sha256<>meta->>'paid_orders_query_sha256' OR cfg.workflow_id<>meta->>'workflow_id'
  OR cfg.producer_revision<>meta->>'producer_revision' OR cfg.algorithm_sha256<>meta->>'algorithm_sha256'
  OR meta->'history_complete'<>'true'::jsonb OR NOT ARRAY(SELECT jsonb_array_elements_text(meta->'access_scopes')) @> ARRAY['read_customers','read_orders','read_all_orders']::text[]
  OR source_operation IS NULL OR expected<>jsonb_array_length(customers)
  OR NOT isfinite(new_started) OR NOT isfinite(new_observed) OR NOT isfinite(new_expires)
  OR new_started>new_observed OR new_expires>new_started+make_interval(secs=>cfg.max_age_seconds)
  THEN RAISE EXCEPTION 'RFM_INGEST_GUARD'; END IF;
 IF cfg.current_operation IS NOT NULL AND NOT cfg.enabled THEN RAISE EXCEPTION 'RFM_INGEST_DISABLED'; END IF;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.rfm_batch b WHERE b.brand=source_brand
   AND (b.operation_id=source_operation OR b.customer_bulk_gid=meta->>'customer_bulk_gid'
    OR b.paid_orders_bulk_gid=meta->>'paid_orders_bulk_gid')) THEN
  RAISE EXCEPTION 'RFM_INGEST_REPLAY';
 END IF;
 IF cfg.current_operation IS NOT NULL THEN
  SELECT * INTO STRICT prior FROM crm_audience_v2.rfm_batch b
   WHERE b.brand=source_brand AND b.operation_id=cfg.current_operation;
  IF new_started<=prior.started_at OR new_observed<=prior.observed_at THEN RAISE EXCEPTION 'RFM_INGEST_STALE'; END IF;
 END IF;
 at_time:=clock_timestamp();
 IF new_observed>at_time OR at_time>=new_expires THEN RAISE EXCEPTION 'RFM_INGEST_EXPIRED'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(customers) e(value)
  WHERE jsonb_typeof(value)<>'object'
   OR NOT(value ?& ARRAY['customer_gid','paid_orders','amount_spent','last_paid_order_at','identity_email_sha256'])
   OR value-'customer_gid'-'paid_orders'-'amount_spent'-'last_paid_order_at'-'identity_email_sha256'<>'{}'::jsonb
   OR (value->'identity_email_sha256'<>'null'::jsonb AND (jsonb_typeof(value->'identity_email_sha256')<>'string' OR value->>'identity_email_sha256'!~'^[a-f0-9]{64}$')))
  OR EXISTS(SELECT 1 FROM jsonb_to_recordset(customers) x(customer_gid text,paid_orders integer,amount_spent numeric,last_paid_order_at timestamptz,identity_email_sha256 text)
  WHERE customer_gid IS NULL OR customer_gid!~'^gid://shopify/Customer/[1-9][0-9]{0,24}$' OR paid_orders IS NULL OR paid_orders<0
   OR amount_spent IS NULL OR amount_spent<0 OR (paid_orders=0 AND (amount_spent<>0 OR last_paid_order_at IS NOT NULL))
   OR (paid_orders>0 AND (last_paid_order_at IS NULL OR last_paid_order_at>(meta->>'observed_at')::timestamptz)))
  OR (SELECT count(DISTINCT x.customer_gid) FROM jsonb_to_recordset(customers) x(customer_gid text))<>expected THEN RAISE EXCEPTION 'RFM_INGEST_CUSTOMERS'; END IF;
 INSERT INTO crm_audience_v2.rfm_batch(brand,operation_id,customer_bulk_gid,paid_orders_bulk_gid,customer_payload_sha256,paid_orders_payload_sha256,started_at,observed_at,expires_at,expected_customers,resolved_customers,history_complete,access_scopes,status)
 VALUES(source_brand,source_operation,meta->>'customer_bulk_gid',meta->>'paid_orders_bulk_gid',meta->>'customer_payload_sha256',meta->>'paid_orders_payload_sha256',(meta->>'started_at')::timestamptz,(meta->>'observed_at')::timestamptz,(meta->>'expires_at')::timestamptz,expected,0,true,ARRAY(SELECT jsonb_array_elements_text(meta->'access_scopes')),'ready');
 WITH raw AS MATERIALIZED(
  SELECT x.customer_gid,x.paid_orders,x.amount_spent,x.last_paid_order_at,x.identity_email_sha256
  FROM jsonb_to_recordset(customers) x(customer_gid text,paid_orders integer,amount_spent numeric,last_paid_order_at timestamptz,identity_email_sha256 text)
 ),buyers AS MATERIALIZED(
  SELECT r.*,ceil(cume_dist() OVER(ORDER BY extract(epoch FROM ((meta->>'observed_at')::timestamptz-r.last_paid_order_at))) * 5)::integer q_r,
   ceil(cume_dist() OVER(ORDER BY r.amount_spent) * 5)::integer q_m FROM raw r WHERE paid_orders>0
 ),scored AS(
  SELECT r.customer_gid,r.identity_email_sha256,r.paid_orders,CASE WHEN r.paid_orders=0 THEN NULL ELSE 6-b.q_r END R,
   CASE WHEN r.paid_orders=0 THEN NULL ELSE b.q_m END M,CASE WHEN r.paid_orders=0 THEN NULL WHEN r.paid_orders=1 THEN 1 WHEN r.paid_orders>=4 THEN 5 ELSE 3 END F
  FROM raw r LEFT JOIN buyers b USING(customer_gid)
 ),resolved_rows AS(
  SELECT s.*,i.subscriber_id,i.subscriber_uuid FROM scored s LEFT JOIN crm_audience_v2.shopify_identity i ON i.brand=source_brand AND i.customer_gid=s.customer_gid
   AND s.identity_email_sha256 IS NOT NULL
   AND s.identity_email_sha256=encode(pg_catalog.sha256(pg_catalog.convert_to(i.email,'UTF8')),'hex')
   AND EXISTS(SELECT 1 FROM public.subscribers native WHERE native.id=i.subscriber_id AND native.uuid=i.subscriber_uuid AND lower(btrim(native.email))=i.email)
 )
 INSERT INTO crm_audience_v2.rfm_fact(brand,operation_id,customer_gid,subscriber_id,subscriber_uuid,paid_orders,R,M,F,rfm_tag)
 SELECT source_brand,source_operation,customer_gid,subscriber_id,subscriber_uuid,paid_orders,R,M,F,CASE WHEN paid_orders=0 THEN NULL WHEN paid_orders=1 THEN CASE WHEN R<=2 THEN 'um_x_lapsando' ELSE 'um_x' END
  WHEN R>=4 AND paid_orders>=4 THEN 'campeao' WHEN R>=3 THEN 'leal' WHEN paid_orders>=4 OR M>=4 THEN 'ex_campeao_at_risk'
  WHEN R<=1 THEN 'dormant' ELSE 'needs_attention' END FROM resolved_rows;
 GET DIAGNOSTICS resolved=ROW_COUNT;
 SELECT count(*) INTO resolved FROM crm_audience_v2.rfm_fact WHERE brand=source_brand AND operation_id=source_operation AND subscriber_uuid IS NOT NULL;
 -- Compute once during the atomic swap; current/match never aggregate the
 -- customer table for every eligible contact. Counts describe Shopify GIDs,
 -- including unresolved identities, and never authorize campaign delivery.
 UPDATE crm_audience_v2.rfm_batch SET resolved_customers=resolved,category_counts=(
  SELECT jsonb_object_agg(tags.tag,coalesce(totals.n,0))
  FROM unnest(ARRAY['campeao','leal','um_x','um_x_lapsando','dormant','needs_attention','ex_campeao_at_risk']) tags(tag)
  LEFT JOIN(SELECT rfm_tag,count(*)::bigint n FROM crm_audience_v2.rfm_fact
   WHERE brand=source_brand AND operation_id=source_operation AND rfm_tag IS NOT NULL GROUP BY rfm_tag) totals ON totals.rfm_tag=tags.tag
 ) WHERE brand=source_brand AND operation_id=source_operation;
 IF clock_timestamp()>=new_expires THEN RAISE EXCEPTION 'RFM_INGEST_EXPIRED'; END IF;
 UPDATE crm_audience_v2.rfm_source SET current_operation=source_operation,enabled=true WHERE brand=source_brand;
 PERFORM crm_audience_v2.refresh_native_catalog(source_brand);
 RETURN jsonb_build_object('operation_id',source_operation,'state','committed','customers',expected,
  'resolved',resolved,'unresolved',expected-resolved,'source_hash',cfg.source_hash,'sends',0);
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.rfm_rule_valid(jsonb),crm_audience_v2.rfm_snapshot(text),crm_audience_v2.rfm_source_current(text,text),crm_audience_v2.rfm_match(jsonb,integer,text,text),crm_audience_v2.rfm_selection_match(jsonb,integer,text,text),crm_audience_v2.rfm_count_for_rule(jsonb,text,integer,text),crm_audience_v2.rfm_native_context_fast(jsonb),crm_audience_v2.rfm_native_scope(jsonb),crm_audience_v2.rfm_native_count(jsonb),crm_audience_v2.rfm_native_subscriber_ids(jsonb,text,integer[],integer,integer,integer),crm_audience_v2.rfm_ingest_snapshot(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_audience_v2.rfm_snapshot(text),crm_audience_v2.rfm_source_current(text,text),crm_audience_v2.rfm_match(jsonb,integer,text,text),crm_audience_v2.rfm_count_for_rule(jsonb,text,integer,text) TO crm_audience_api;
GRANT EXECUTE ON FUNCTION crm_audience_v2.rfm_ingest_snapshot(jsonb,jsonb) TO crm_shopify_sync;
COMMIT;

-- Additive native-selection extension. The source remains unconfigured and OFF
-- after installation; only a complete guarded RFM ingest can publish its exact
-- source pin into the existing catalog. Existing ACLs survive each replacement.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='20s';
DO $selection_boundary$
BEGIN
 IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) THEN
  RAISE EXCEPTION 'RFM_SELECTION_REQUIRES_WORKER_OFF';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_catalog_valid(jsonb,text)')) IS DISTINCT FROM 'c455fa8f696de33064803b699855f9ea'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_rule(jsonb,integer,text,integer,jsonb)')) IS DISTINCT FROM 'c104e2e29b7b71d65d1a2373108f6253'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_regular_rule_match(jsonb,integer[],integer,text)')) IS DISTINCT FROM '4be69a72affbe4adc81684015b1708ab'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.refresh_native_catalog(text)')) IS DISTINCT FROM '3a44cc093b8a8d773561f724a026e264' THEN
  RAISE EXCEPTION 'RFM_SELECTION_BASE_DRIFT';
 END IF;
END $selection_boundary$;

CREATE FUNCTION crm_audience_v2.rfm_catalog(b text,native jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE cfg crm_audience_v2.rfm_source%ROWTYPE;fields jsonb;configured boolean:=false;ready boolean:=false;
BEGIN
 IF b NOT IN('fish','aristo') OR jsonb_typeof(native->'fields') IS DISTINCT FROM 'array'
  OR (SELECT count(*) FROM jsonb_array_elements(native->'fields') f WHERE f->>'key'='relationship.rfm')<>1 THEN
  RAISE EXCEPTION 'RFM_CATALOG_SHAPE';
 END IF;
 SELECT * INTO cfg FROM crm_audience_v2.rfm_source WHERE brand=b;
 configured:=FOUND;
 ready:=configured AND crm_audience_v2.rfm_source_current(b,cfg.source_hash);
 SELECT jsonb_agg(CASE WHEN f->>'key'='relationship.rfm' THEN
   f||jsonb_build_object('available',ready,'source_hash',CASE WHEN ready THEN cfg.source_hash END)
  ELSE f END ORDER BY n) INTO fields
 FROM jsonb_array_elements(native->'fields') WITH ORDINALITY x(f,n);
 RETURN native||jsonb_build_object('fields',fields);
END $fn$;
CREATE FUNCTION crm_audience_v2.rfm_strip(catalog jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT jsonb_set(catalog,'{fields}',coalesce((SELECT jsonb_agg(f ORDER BY n)
  FROM jsonb_array_elements(catalog->'fields') WITH ORDINALITY x(f,n)
  WHERE f->>'key'<>'relationship.rfm'),'[]'::jsonb))
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.rfm_catalog(text,jsonb),crm_audience_v2.rfm_strip(jsonb) FROM PUBLIC;

DO $selection_patch$
DECLARE d text;old text;replacement text;n integer;
BEGIN
 d:=pg_get_functiondef('crm_audience_v2.selection_catalog_valid(jsonb,text)'::regprocedure);
 old:='jsonb_array_length(raw->''fields'')>8';replacement:='jsonb_array_length(raw->''fields'')>9';
 n:=(length(d)-length(replace(d,old,'')))/length(old);IF n<>1 THEN RAISE EXCEPTION 'RFM_SELECTION_PATCH_CATALOG_LIMIT';END IF;d:=replace(d,old,replacement);
 old:='''signup.recorded_origin'',''email.opened'',''email.clicked'')';replacement:='''signup.recorded_origin'',''relationship.rfm'',''email.opened'',''email.clicked'')';
 n:=(length(d)-length(replace(d,old,'')))/length(old);IF n<>1 THEN RAISE EXCEPTION 'RFM_SELECTION_PATCH_CATALOG_FIELD';END IF;d:=replace(d,old,replacement);EXECUTE d;

 d:=pg_get_functiondef('crm_audience_v2.selection_rule(jsonb,integer,text,integer,jsonb)'::regprocedure);
 old:=$old$  IF rule->>'field'='signup.recorded_origin' THEN RETURN crm_audience_v2.selection_recorded_origin_rule(rule,sid,brand,source_config); END IF;
  source_hash:=crm_audience_v2.selection_engagement_source_hash(brand,rule->>'field');$old$;
 replacement:=$new$  IF rule->>'field'='signup.recorded_origin' THEN RETURN crm_audience_v2.selection_recorded_origin_rule(rule,sid,brand,source_config); END IF;
  IF rule->>'field'='relationship.rfm' THEN
   IF NOT crm_audience_v2.rfm_rule_valid(rule)
    OR (SELECT count(*) FROM jsonb_array_elements(source_config->'fields') f WHERE f->>'key'='relationship.rfm'
     AND f->'available'='true'::jsonb AND jsonb_typeof(f->'source_hash')='string')<>1 THEN RETURN NULL; END IF;
   SELECT f->>'source_hash' INTO source_hash FROM jsonb_array_elements(source_config->'fields') f
    WHERE f->>'key'='relationship.rfm' AND f->'available'='true'::jsonb;
   IF NOT crm_audience_v2.rfm_source_current(brand,source_hash) THEN RETURN NULL; END IF;
   matches:=CASE WHEN sid=0 THEN false ELSE crm_audience_v2.rfm_selection_match(rule,sid,brand,source_hash) END;
   IF matches IS NULL THEN RETURN NULL; END IF;
   RETURN jsonb_build_object('match',matches,'nodes',1,'pins',jsonb_build_array(jsonb_build_object(
    'rule_key','{"op":"condition","field":"relationship.rfm","operator":"is","value":'||to_jsonb(rule->>'value')::text||'}',
    'source','rfm','source_hash',source_hash)));
  END IF;
  source_hash:=crm_audience_v2.selection_engagement_source_hash(brand,rule->>'field');$new$;
 n:=(length(d)-length(replace(d,old,'')))/length(old);IF n<>1 THEN RAISE EXCEPTION 'RFM_SELECTION_PATCH_RULE';END IF;d:=replace(d,old,replacement);EXECUTE d;

 d:=pg_get_functiondef('crm_audience_v2.selection_regular_rule_match(jsonb,integer[],integer,text)'::regprocedure);
 old:=$old$   IF rule->>'field'='signup.recorded_origin' THEN
    SELECT crm_audience_v2.recorded_origin_descriptor(s)->>'provenance_hash' INTO pin FROM crm_audience_v2.recorded_origin_source s WHERE s.brand=selection_regular_rule_match.brand AND s.canonical_origin=rule->>'value' AND s.enabled;
    RETURN crm_audience_v2.recorded_origin_match(rule,sid,brand,pin);
   END IF;
   matched:=crm_audience_v2.selection_engagement_match(rule,sid,brand);$old$;
 replacement:=$new$   IF rule->>'field'='signup.recorded_origin' THEN
    SELECT crm_audience_v2.recorded_origin_descriptor(s)->>'provenance_hash' INTO pin FROM crm_audience_v2.recorded_origin_source s WHERE s.brand=selection_regular_rule_match.brand AND s.canonical_origin=rule->>'value' AND s.enabled;
    RETURN crm_audience_v2.recorded_origin_match(rule,sid,brand,pin);
   END IF;
   IF rule->>'field'='relationship.rfm' THEN
    SELECT source_hash INTO pin FROM crm_audience_v2.rfm_source WHERE rfm_source.brand=selection_regular_rule_match.brand;
    RETURN crm_audience_v2.rfm_selection_match(rule,sid,brand,pin);
   END IF;
   matched:=crm_audience_v2.selection_engagement_match(rule,sid,brand);$new$;
 n:=(length(d)-length(replace(d,old,'')))/length(old);IF n<>1 THEN RAISE EXCEPTION 'RFM_SELECTION_PATCH_REGULAR';END IF;d:=replace(d,old,replacement);EXECUTE d;

 d:=pg_get_functiondef('crm_audience_v2.refresh_native_catalog(text)'::regprocedure);
 old:=' native:=expected; composed:=crm_audience_v2.shopify_catalog(b,native);';
 replacement:=' native:=jsonb_set(expected,''{fields}'',(expected->''fields'')||jsonb_build_array(jsonb_build_object(''key'',''relationship.rfm'',''available'',false,''source_hash'',NULL))); composed:=crm_audience_v2.shopify_catalog(b,native);';
 n:=(length(d)-length(replace(d,old,'')))/length(old);IF n<>1 THEN RAISE EXCEPTION 'RFM_SELECTION_PATCH_REFRESH_NATIVE';END IF;d:=replace(d,old,replacement);
 old:=' expected:=crm_audience_v2.recorded_origin_catalog(b,expected);';replacement:=old||' expected:=crm_audience_v2.rfm_catalog(b,expected);';
 n:=(length(d)-length(replace(d,old,'')))/length(old);IF n<>2 THEN RAISE EXCEPTION 'RFM_SELECTION_PATCH_REFRESH_CATALOG';END IF;d:=replace(d,old,replacement);
 old:=' PERFORM 1 FROM crm_audience_v2.recorded_origin_source WHERE brand=b ORDER BY canonical_origin FOR SHARE;';replacement:=old||' PERFORM 1 FROM crm_audience_v2.rfm_source WHERE brand=b FOR SHARE;';
 n:=(length(d)-length(replace(d,old,'')))/length(old);IF n<>1 THEN RAISE EXCEPTION 'RFM_SELECTION_PATCH_REFRESH_LOCK';END IF;d:=replace(d,old,replacement);
 old:='crm_audience_v2.shopify_catalog_trusted(b,crm_audience_v2.recorded_origin_strip(c.catalog),native,composed)';
 replacement:='crm_audience_v2.shopify_catalog_trusted(b,crm_audience_v2.rfm_strip(crm_audience_v2.recorded_origin_strip(c.catalog)),crm_audience_v2.rfm_strip(native),crm_audience_v2.rfm_strip(composed))';
 n:=(length(d)-length(replace(d,old,'')))/length(old);IF n<>2 THEN RAISE EXCEPTION 'RFM_SELECTION_PATCH_REFRESH_TRUST';END IF;d:=replace(d,old,replacement);EXECUTE d;
END $selection_patch$;
COMMIT;
