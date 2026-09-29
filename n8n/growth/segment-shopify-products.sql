-- Add products to the existing nightly Customer source. Source and workers must
-- remain OFF during installation. No producer, gate or native contact is changed.
-- Apply this migration atomically AFTER the existing Shopify integration.
DO $boundary$
BEGIN
 IF to_regclass('crm_audience_v2.shopify_source') IS NULL
  OR to_regclass('crm_audience_v2.shopify_product_batch') IS NOT NULL THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_INSTALL_BOUNDARY'; END IF;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.shopify_source WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_REQUIRES_OFF'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_source_hash(text,text,jsonb)')) IS DISTINCT FROM 'df5639ad92678b1b4a51233999fe86e3' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_source_current(text,text,text)')) IS DISTINCT FROM 'b4804c3903ea38f2f2c42e0eba8ad70e' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_rule_valid(jsonb)')) IS DISTINCT FROM '7a3aa1c99347628423bd1ca749802c68' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_customer_match(jsonb,integer,text,text)')) IS DISTINCT FROM '58849bd469ad7446ece562469770d353' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_catalog(text,jsonb)')) IS DISTINCT FROM '689b712086714cfd66eb94058c1a5eb7' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_shopify_rule(jsonb,integer,text,jsonb)')) IS DISTINCT FROM 'a292b4547d155f6143edb53659301aff' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_rule(jsonb,integer,text,integer,jsonb)')) IS DISTINCT FROM 'f01959ec6743f6b660ae185bcb9f3d5d' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_regular_rule_match(jsonb,integer[],integer,text)')) IS DISTINCT FROM 'ffafc11ff6481dd871a9b44ddd41c83a' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.refresh_native_catalog(text)')) IS DISTINCT FROM 'be0fa424ea7ef6f4f9126e8f9e2483b6' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_BASE_DRIFT'; END IF;
END $boundary$;

CREATE TABLE crm_audience_v2.shopify_product_batch (
 brand text NOT NULL, operation_id text NOT NULL, provenance jsonb NOT NULL,
 provenance_sha256 text NOT NULL CHECK(provenance_sha256 ~ '^[a-f0-9]{64}$'),
 ready boolean NOT NULL DEFAULT false,
 catalog_products jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(catalog_products)='array'),
 PRIMARY KEY(brand,operation_id),
 FOREIGN KEY(brand,operation_id) REFERENCES crm_audience_v2.shopify_batch(brand,operation_id)
);
CREATE TABLE crm_audience_v2.shopify_customer_product (
 brand text NOT NULL, operation_id text NOT NULL, customer_gid text NOT NULL,
 products jsonb NOT NULL CHECK(jsonb_typeof(products)='array'),
 history_complete boolean NOT NULL,
 unresolved_items integer NOT NULL CHECK(unresolved_items>=0 AND unresolved_items<=1000000),
 PRIMARY KEY(brand,operation_id,customer_gid),
 FOREIGN KEY(brand,operation_id,customer_gid) REFERENCES crm_audience_v2.shopify_customer_fact(brand,operation_id,customer_gid) ON DELETE CASCADE,
 CHECK(history_complete=(unresolved_items=0))
);
CREATE TABLE crm_audience_v2.shopify_product_chunk (
 brand text NOT NULL, operation_id text NOT NULL, chunk_index integer NOT NULL,
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(brand,operation_id,chunk_index),
 FOREIGN KEY(brand,operation_id,chunk_index) REFERENCES crm_audience_v2.shopify_chunk(brand,operation_id,chunk_index) ON DELETE CASCADE
);
REVOKE ALL ON crm_audience_v2.shopify_product_batch,crm_audience_v2.shopify_customer_product,crm_audience_v2.shopify_product_chunk FROM PUBLIC;

-- One transaction extends the established scalar ingestion. The unmodified
-- scalar producer receives its exact projection and the real bulk totals remain
-- in private provenance. No pointer or product fact is visible before COMMIT.
CREATE FUNCTION crm_audience_v2.shopify_ingest_product_chunk(meta jsonb,part integer,customers jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
DECLARE cfg crm_audience_v2.shopify_source%ROWTYPE; batch crm_audience_v2.shopify_product_batch%ROWTYPE;
 b text;op text;v1 jsonb;scalar_customers jsonb;receipt jsonb;customer_row jsonb;product_row jsonb;
 meta_hash text;chunk_hash text;prior_hash text;expected integer;parts integer;missing integer;
BEGIN
 IF jsonb_typeof(meta) IS DISTINCT FROM 'object' OR octet_length(meta::text)>16000
  OR meta->'version' IS DISTINCT FROM '2'::jsonb
  OR jsonb_typeof(customers) IS DISTINCT FROM 'array' OR jsonb_array_length(customers)>5000
  OR octet_length(customers::text)>16777216
  OR meta->>'query_sha256' IS DISTINCT FROM 'bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086'
  OR jsonb_typeof(meta->'counts') IS DISTINCT FROM 'object'
  OR jsonb_typeof(meta->'bulk') IS DISTINCT FROM 'object'
  OR meta#>'{bulk,required_scopes}' IS DISTINCT FROM '["read_customers","read_orders","read_all_orders","read_products"]'::jsonb THEN
  RAISE EXCEPTION 'SHOPIFY_PRODUCT_INGEST_SHAPE';
 END IF;
 FOREACH prior_hash IN ARRAY ARRAY['customers','orders','line_items','product_missing','product_history_incomplete'] LOOP
  IF jsonb_typeof(meta#>ARRAY['counts',prior_hash]) IS DISTINCT FROM 'number'
   OR meta#>>ARRAY['counts',prior_hash] !~ '^(0|[1-9][0-9]{0,6})$'
   OR (meta#>>ARRAY['counts',prior_hash])::numeric>1000000 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_COUNTS'; END IF;
 END LOOP;
 expected:=(meta#>>'{counts,customers}')::integer;parts:=greatest(1,(expected+4999)/5000);
 missing:=(meta#>>'{counts,product_missing}')::integer;
 IF expected>250000 OR missing>(meta#>>'{counts,line_items}')::integer
  OR (meta#>>'{counts,product_history_incomplete}')::integer>least(expected,missing)
  OR (expected+(meta#>>'{counts,orders}')::integer+(meta#>>'{counts,line_items}')::integer)>1000000
  OR meta#>>'{counts,object_count}' IS DISTINCT FROM (expected+(meta#>>'{counts,orders}')::integer+(meta#>>'{counts,line_items}')::integer)::text
  OR meta#>>'{counts,root_object_count}' IS DISTINCT FROM expected::text THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_COUNTS'; END IF;
 b:=meta->>'brand';op:=meta->>'operation_id';
 SELECT * INTO STRICT cfg FROM crm_audience_v2.shopify_source WHERE brand=b FOR UPDATE;
 IF cfg.query_sha256 IS DISTINCT FROM meta->>'query_sha256' THEN RAISE EXCEPTION 'SHOPIFY_INGEST_PRODUCER'; END IF;
 FOR customer_row IN SELECT value FROM jsonb_array_elements(customers) LOOP
  IF jsonb_typeof(customer_row) IS DISTINCT FROM 'object' OR NOT(customer_row ?& ARRAY['products','product_history_complete','unresolved_product_items'])
   OR jsonb_typeof(customer_row->'products') IS DISTINCT FROM 'array' OR jsonb_array_length(customer_row->'products')>1000
   OR jsonb_typeof(customer_row->'product_history_complete') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(customer_row->'unresolved_product_items') IS DISTINCT FROM 'number'
   OR customer_row->>'unresolved_product_items' !~ '^(0|[1-9][0-9]{0,6})$'
   OR (customer_row->>'unresolved_product_items')::numeric>1000000
   OR (customer_row->>'product_history_complete')::boolean IS DISTINCT FROM ((customer_row->>'unresolved_product_items')::integer=0) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_CUSTOMER'; END IF;
  FOR product_row IN SELECT value FROM jsonb_array_elements(customer_row->'products') LOOP
   IF jsonb_typeof(product_row) IS DISTINCT FROM 'object' OR NOT(product_row ?& ARRAY['id','name']) OR product_row-'id'-'name'<>'{}'::jsonb
    OR jsonb_typeof(product_row->'id') IS DISTINCT FROM 'string' OR product_row->>'id' !~ '^gid://shopify/Product/[1-9][0-9]{0,19}$'
    OR jsonb_typeof(product_row->'name') IS DISTINCT FROM 'string' OR length(product_row->>'name') NOT BETWEEN 1 AND 500
    OR product_row->>'name' ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_VALUE'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(customer_row->'products') item)<>jsonb_array_length(customer_row->'products') THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_DUPLICATE'; END IF;
 END LOOP;
 meta_hash:=encode(sha256(convert_to((meta-'observed_at')::text,'UTF8')),'hex');
 chunk_hash:=encode(sha256(convert_to(customers::text,'UTF8')),'hex');
 SELECT coalesce(jsonb_agg(r-'products'-'product_history_complete'-'unresolved_product_items' ORDER BY n),'[]'::jsonb) INTO scalar_customers
 FROM jsonb_array_elements(customers) WITH ORDINALITY x(r,n);
 v1:=jsonb_set(jsonb_set(meta,'{version}','1'::jsonb),'{counts,object_count}',to_jsonb(expected::text));
 v1:=jsonb_set(v1,'{bulk}',(meta->'bulk')||jsonb_build_object('product_evidence_version',2,'product_object_count',meta#>'{counts,object_count}'));
 receipt:=crm_audience_v2.shopify_ingest_chunk(v1,part,scalar_customers);
 INSERT INTO crm_audience_v2.shopify_product_batch(brand,operation_id,provenance,provenance_sha256)
 VALUES(b,op,meta,meta_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT batch FROM crm_audience_v2.shopify_product_batch WHERE brand=b AND operation_id=op FOR UPDATE;
 IF batch.provenance_sha256<>meta_hash OR batch.provenance-'observed_at' IS DISTINCT FROM meta-'observed_at'
  OR (meta->>'observed_at')::timestamptz<(batch.provenance->>'observed_at')::timestamptz THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_REPLAY_CONFLICT'; END IF;
 SELECT payload_sha256 INTO prior_hash FROM crm_audience_v2.shopify_product_chunk WHERE brand=b AND operation_id=op AND chunk_index=part;
 IF FOUND THEN
  IF prior_hash<>chunk_hash OR receipt->'replayed' IS DISTINCT FROM 'true'::jsonb
   OR batch.ready IS DISTINCT FROM (receipt->>'status'='ready') THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_REPLAY_CONFLICT'; END IF;
  RETURN receipt;
 END IF;
 IF receipt->'replayed' IS DISTINCT FROM 'false'::jsonb OR batch.ready THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_REPLAY_MISSING'; END IF;
 INSERT INTO crm_audience_v2.shopify_customer_product(brand,operation_id,customer_gid,products,history_complete,unresolved_items)
 SELECT b,op,r->>'customer_gid',r->'products',(r->>'product_history_complete')::boolean,(r->>'unresolved_product_items')::integer FROM jsonb_array_elements(customers) r;
 INSERT INTO crm_audience_v2.shopify_product_chunk VALUES(b,op,part,chunk_hash);
 IF receipt->>'status'='ready' THEN
  IF (SELECT count(*) FROM crm_audience_v2.shopify_customer_product WHERE brand=b AND operation_id=op)<>expected
   OR (SELECT count(*) FROM crm_audience_v2.shopify_product_chunk WHERE brand=b AND operation_id=op)<>parts
   OR (SELECT count(*) FROM crm_audience_v2.shopify_customer_product WHERE brand=b AND operation_id=op AND NOT history_complete)<>(meta#>>'{counts,product_history_incomplete}')::integer
   OR (SELECT coalesce(sum(unresolved_items),0) FROM crm_audience_v2.shopify_customer_product WHERE brand=b AND operation_id=op)<>missing THEN
   RAISE EXCEPTION 'SHOPIFY_PRODUCT_FINAL_COUNT'; END IF;
  IF (SELECT count(DISTINCT p->>'id') FROM crm_audience_v2.shopify_customer_product f CROSS JOIN LATERAL jsonb_array_elements(f.products) p WHERE f.brand=b AND f.operation_id=op)>1000
   OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_customer_product f CROSS JOIN LATERAL jsonb_array_elements(f.products) p WHERE f.brand=b AND f.operation_id=op GROUP BY p->>'id' HAVING count(DISTINCT p->>'name')<>1) THEN
   RAISE EXCEPTION 'SHOPIFY_PRODUCT_CATALOG_CONFLICT'; END IF;
  UPDATE crm_audience_v2.shopify_product_batch SET ready=true,catalog_products=(
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'brand',b,'name',name,'available',true) ORDER BY id COLLATE "C"),'[]'::jsonb)
   FROM (SELECT DISTINCT p->>'id' id,p->>'name' name FROM crm_audience_v2.shopify_customer_product f
    CROSS JOIN LATERAL jsonb_array_elements(f.products) p WHERE f.brand=b AND f.operation_id=op) product_catalog
  ) WHERE brand=b AND operation_id=op;
 END IF;
 RETURN receipt;
END
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_ingest_product_chunk(jsonb,integer,jsonb) FROM PUBLIC;

-- A catalog can change after a nightly export. Accept the previous product
-- list only when it is an exact retained aggregate from a completed producer.
-- Scalar/engagement/base-list guards remain unchanged.
CREATE FUNCTION crm_audience_v2.shopify_catalog_trusted(b text,value jsonb,native jsonb,composed jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE scalar_value jsonb;scalar_composed jsonb;field jsonb;fields jsonb;pin text;
BEGIN
 IF value=native OR value=composed THEN RETURN true; END IF;
 IF jsonb_typeof(value->'fields') IS DISTINCT FROM 'array' OR jsonb_typeof(value->'products') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 SELECT jsonb_agg(CASE WHEN f->>'key'='purchase.product' THEN jsonb_build_object('key','purchase.product','available',false,'source_hash',NULL) ELSE f END ORDER BY n)
 INTO fields FROM jsonb_array_elements(value->'fields') WITH ORDINALITY x(f,n);
 scalar_value:=value||jsonb_build_object('fields',fields,'products','[]'::jsonb);
 SELECT jsonb_agg(CASE WHEN f->>'key'='purchase.product' THEN jsonb_build_object('key','purchase.product','available',false,'source_hash',NULL) ELSE f END ORDER BY n)
 INTO fields FROM jsonb_array_elements(composed->'fields') WITH ORDINALITY x(f,n);
 scalar_composed:=composed||jsonb_build_object('fields',fields,'products','[]'::jsonb);
 IF scalar_value IS DISTINCT FROM native AND scalar_value IS DISTINCT FROM scalar_composed THEN RETURN false; END IF;
 SELECT f INTO field FROM jsonb_array_elements(value->'fields') f WHERE f->>'key'='purchase.product';
 pin:=crm_audience_v2.shopify_source_hash(b,'purchase.product',composed);
 IF value->'products'='[]'::jsonb AND (field=jsonb_build_object('key','purchase.product','available',false,'source_hash',NULL)
  OR field=jsonb_build_object('key','purchase.product','available',false,'source_hash',pin)) THEN RETURN true; END IF;
 RETURN coalesce(field=jsonb_build_object('key','purchase.product','available',true,'source_hash',pin)
  AND EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_batch t WHERE t.brand=b AND t.ready
   AND t.provenance->>'query_sha256'='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086' AND t.catalog_products=value->'products'),false);
END
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_catalog_trusted(text,jsonb,jsonb,jsonb) FROM PUBLIC;


CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_source_hash(b text,field text,catalog jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT CASE WHEN field='purchase.product' THEN
 CASE WHEN b IN('fish','aristo') AND catalog->>'shop_id' ~ '^gid://shopify/Shop/[1-9][0-9]{0,19}$'
  AND catalog->>'currency' ~ '^[A-Z]{3}$' AND catalog->>'timezone'='America/Sao_Paulo' THEN
  encode(sha256(convert_to('{"brand":'||to_jsonb(b)::text||',"currency":'||(catalog->'currency')::text||',"field":'||to_jsonb(field)::text||
   ',"semantics":{"api":"2026-07","coverage":"complete Customer export with all accessible orders and line items; read_all_orders required","freshness":"snapshot observed during export; expires 26 hours after export start","history":"no payment filter; quantity includes refunded and removed items; no claim about deleted orders or another Customer identity","identity":"unique Customer GID and native subscriber UUID; no automatic reassignment","negative":"no matching Product GID only when every line item has a resolved product","positive":"Product GID in an Order line item with quantity greater than zero","query_sha256":"bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086","version":"shopify-customer-products-v1"},"shop_id":'||(catalog->'shop_id')::text||',"timezone":'||(catalog->'timezone')::text||'}','UTF8')),'hex') END
 ELSE (CASE WHEN b IN('fish','aristo') AND field IN('purchase.count','purchase.amount','purchase.last_date')
 AND catalog->>'shop_id' ~ '^gid://shopify/Shop/[1-9][0-9]{0,19}$' AND catalog->>'currency' ~ '^[A-Z]{3}$'
 AND catalog->>'timezone'='America/Sao_Paulo' THEN encode(sha256(convert_to(
 '{"brand":'||to_jsonb(b)::text||',"currency":'||(catalog->'currency')::text||',"field":'||to_jsonb(field)::text||
 ',"semantics":{"amount":"Customer.amountSpent in shop currency","api":"2026-07","count":"Customer.numberOfOrders","coverage":"completed reconciled customer export; missing and ambiguous identities unknown","freshness":"snapshot observed during export; expires 26 hours after export start","identity":"unique Customer GID and native subscriber UUID; no automatic reassignment","last_date":"Customer.lastOrder.createdAt in shop timezone","negative":"explicit Customer aggregate only; no claim about another Customer identity","query_sha256":"1ca989e8c1e9f00478e3e069f70a8fe3f0a20d1fb730022cdb766bf738a65b48","version":"shopify-customer-bulk-facts-v1"},"shop_id":'||(catalog->'shop_id')::text||',"timezone":'||(catalog->'timezone')::text||'}','UTF8')),'hex') END) END
$fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_source_current(b text,field text,pin text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT coalesce((SELECT s.enabled AND pin IS NOT NULL AND s.field_hashes->>field=pin
  AND crm_audience_v2.shopify_snapshot(b)->'current'='true'::jsonb
  AND (field<>'purchase.product' OR (s.query_sha256='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086'
   AND EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_batch t WHERE t.brand=b AND t.operation_id=s.current_operation AND t.ready)))
  FROM crm_audience_v2.shopify_source s WHERE s.brand=b),false)
$fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_rule_valid(rule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN
 IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR rule->>'op' IS DISTINCT FROM 'condition'
  OR NOT(rule ?& ARRAY['op','field','operator','value']) OR rule-'op'-'field'-'operator'-'value'<>'{}'::jsonb THEN RETURN false; END IF;
 IF rule->>'field'='purchase.product' THEN
  RETURN coalesce(jsonb_typeof(rule->'value')='string' AND rule->>'value' ~ '^gid://shopify/Product/[1-9][0-9]{0,19}$'
   AND rule->>'operator' IN('purchased','not_purchased'),false);
 END IF;
 IF rule->>'field' IN('purchase.count','purchase.amount') THEN
  IF rule->>'operator' IS NULL OR rule->>'operator' NOT IN('eq','gt','gte','lt','lte') THEN RETURN false; END IF;
  IF rule->>'field'='purchase.count' THEN
   RETURN jsonb_typeof(rule->'value')='number' AND rule->>'value' ~ '^(0|[1-9][0-9]{0,9})$'
    AND (rule->>'value')::numeric<=2147483647;
  END IF;
  RETURN jsonb_typeof(rule->'value')='string' AND rule->>'value' ~ '^(0|[1-9][0-9]{0,11})\.[0-9]{2}$';
 END IF;
 IF rule->>'field'='purchase.last_date' THEN
  IF jsonb_typeof(rule->'value') IS DISTINCT FROM 'string' OR rule->>'value' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   OR rule->>'value'<'2000-01-01' OR rule->>'value'>'2100-12-31' OR rule->>'operator' IS NULL
   OR rule->>'operator' NOT IN('eq','before','on_or_before','after','on_or_after') THEN RETURN false; END IF;
  PERFORM (rule->>'value')::date;RETURN true;
 END IF;
 RETURN false;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN false;
END
$fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_customer_match(rule jsonb,sid integer,b text,pin text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE cfg crm_audience_v2.shopify_source%ROWTYPE;f crm_audience_v2.shopify_customer_fact%ROWTYPE;
 value_number numeric;target_number numeric;value_date date;target_date date;product_fact crm_audience_v2.shopify_customer_product%ROWTYPE;
BEGIN
 IF NOT crm_audience_v2.shopify_rule_valid(rule) OR sid IS NULL OR sid<1 OR b IS NULL OR b NOT IN('fish','aristo') THEN RETURN NULL; END IF;
 SELECT * INTO cfg FROM crm_audience_v2.shopify_source WHERE brand=b;
 IF NOT FOUND OR NOT cfg.enabled OR pin IS NULL OR cfg.field_hashes->>(rule->>'field') IS DISTINCT FROM pin
  OR crm_audience_v2.shopify_snapshot(b)->'current' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL; END IF;
 SELECT x.* INTO f FROM crm_audience_v2.shopify_customer_fact x
 JOIN public.subscribers s ON s.id=x.subscriber_id AND s.uuid=x.subscriber_uuid AND lower(btrim(s.email))=x.email
 JOIN crm_audience_v2.shopify_identity i ON i.brand=x.brand AND i.customer_gid=x.customer_gid
  AND i.subscriber_id=x.subscriber_id AND i.subscriber_uuid=x.subscriber_uuid
 WHERE x.brand=b AND x.operation_id=cfg.current_operation AND x.subscriber_id=sid AND x.identity_state='resolved';
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF rule->>'field'='purchase.product' THEN
  SELECT p.* INTO product_fact FROM crm_audience_v2.shopify_customer_product p
  JOIN crm_audience_v2.shopify_product_batch t ON t.brand=p.brand AND t.operation_id=p.operation_id AND t.ready
  WHERE p.brand=b AND p.operation_id=cfg.current_operation AND p.customer_gid=f.customer_gid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(product_fact.products) p WHERE p->>'id'=rule->>'value') THEN
   RETURN rule->>'operator'='purchased';
  END IF;
  IF NOT product_fact.history_complete THEN RETURN NULL; END IF;
  RETURN rule->>'operator'='not_purchased';
 END IF;
 -- A contradictory zero cannot prove that no order exists. Historical orders
 -- may predate the surviving Customer after a merge or import.
 IF f.orders_count=0 AND (f.last_order_at IS NOT NULL OR f.amount_spent>0) THEN RETURN NULL; END IF;
 IF rule->>'field'='purchase.last_date' THEN
  IF f.last_order_at IS NULL THEN RETURN CASE WHEN f.orders_count=0 THEN false ELSE NULL END; END IF;
  value_date:=(f.last_order_at AT TIME ZONE cfg.timezone)::date;target_date:=(rule->>'value')::date;
  RETURN CASE rule->>'operator' WHEN 'eq' THEN value_date=target_date WHEN 'before' THEN value_date<target_date
   WHEN 'on_or_before' THEN value_date<=target_date WHEN 'after' THEN value_date>target_date WHEN 'on_or_after' THEN value_date>=target_date END;
 END IF;
 value_number:=CASE rule->>'field' WHEN 'purchase.count' THEN f.orders_count WHEN 'purchase.amount' THEN f.amount_spent END;
 target_number:=(rule->>'value')::numeric;
 RETURN CASE rule->>'operator' WHEN 'eq' THEN value_number=target_number WHEN 'gt' THEN value_number>target_number
  WHEN 'gte' THEN value_number>=target_number WHEN 'lt' THEN value_number<target_number WHEN 'lte' THEN value_number<=target_number END;
END
$fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_catalog(b text,native jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE cfg crm_audience_v2.shopify_source%ROWTYPE; composed jsonb; fields jsonb; k text;product_ready boolean;products jsonb;
BEGIN
 SELECT * INTO cfg FROM crm_audience_v2.shopify_source WHERE brand=b;
 IF NOT FOUND THEN RETURN native; END IF;
 composed:=native||jsonb_build_object('shop_id',cfg.shop_id,'currency',cfg.currency,'timezone',cfg.timezone);
 FOREACH k IN ARRAY ARRAY['purchase.count','purchase.amount','purchase.last_date'] LOOP
  IF cfg.field_hashes->>k IS DISTINCT FROM crm_audience_v2.shopify_source_hash(b,k,composed) THEN RAISE EXCEPTION 'SHOPIFY_SOURCE_PIN'; END IF;
 END LOOP;
 SELECT jsonb_agg(CASE WHEN f->>'key' IN('purchase.count','purchase.amount','purchase.last_date')
  THEN f||jsonb_build_object('available',true,'source_hash',cfg.field_hashes->>(f->>'key')) ELSE f END ORDER BY n)
 INTO fields FROM jsonb_array_elements(native->'fields') WITH ORDINALITY AS x(f,n);
 product_ready:=coalesce(cfg.field_hashes->>'purchase.product'=crm_audience_v2.shopify_source_hash(b,'purchase.product',composed)
  AND cfg.query_sha256='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086'
  AND crm_audience_v2.shopify_snapshot(b)->'current'='true'::jsonb
  AND EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_batch WHERE brand=b AND operation_id=cfg.current_operation AND ready),false);
 SELECT jsonb_agg(CASE WHEN f->>'key'='purchase.product' THEN f||jsonb_build_object('available',product_ready,'source_hash',cfg.field_hashes->>'purchase.product') ELSE f END ORDER BY n)
 INTO fields FROM jsonb_array_elements(fields) WITH ORDINALITY x(f,n);
 SELECT coalesce((SELECT catalog_products FROM crm_audience_v2.shopify_product_batch
  WHERE product_ready AND brand=b AND operation_id=cfg.current_operation AND ready),'[]'::jsonb) INTO products;
 RETURN composed||jsonb_build_object('fields',fields,'products',products);
END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.selection_shopify_rule(rule jsonb,sid integer,b text,source_config jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE pin text; cfg crm_audience_v2.shopify_source%ROWTYPE; matched boolean;
BEGIN
 IF NOT crm_audience_v2.shopify_rule_valid(rule) THEN RETURN NULL; END IF;
 pin:=crm_audience_v2.shopify_source_hash(b,rule->>'field',source_config);
 SELECT * INTO cfg FROM crm_audience_v2.shopify_source WHERE brand=b;
 IF NOT FOUND OR NOT cfg.enabled OR pin IS NULL OR cfg.field_hashes->>(rule->>'field') IS DISTINCT FROM pin
  OR crm_audience_v2.shopify_snapshot(b)->'current' IS DISTINCT FROM 'true'::jsonb
  OR (SELECT count(*) FROM jsonb_array_elements(source_config->'fields') f WHERE f->>'key'=rule->>'field'
   AND f->'available'='true'::jsonb AND f->>'source_hash'=pin)<>1 THEN RETURN NULL; END IF;
 IF rule->>'field'='purchase.product' AND (SELECT count(*) FROM jsonb_array_elements(source_config->'products') p
  WHERE p->>'id'=rule->>'value' AND p->>'brand'=b AND p->'available'='true'::jsonb)<>1 THEN RETURN NULL; END IF;
 -- sid=0 validates context only. Individual unknown facts never become false.
 matched:=CASE WHEN sid=0 THEN false ELSE crm_audience_v2.shopify_customer_match(rule,sid,b,pin) END;
 RETURN jsonb_build_object('match',matched,'nodes',1,'pins',jsonb_build_array(jsonb_build_object(
  'rule_key','{"op":"condition","field":'||to_jsonb(rule->>'field')::text||',"operator":'||to_jsonb(rule->>'operator')::text||',"value":'||(rule->'value')::text||'}',
  'source','shopify','source_hash',pin,'shop_id',cfg.shop_id,'currency',cfg.currency,'timezone',cfg.timezone)));
END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.selection_rule(rule jsonb,sid integer,brand text,depth integer DEFAULT 1,source_config jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE child jsonb; result jsonb; matches boolean; nodes integer:=1;
 pins jsonb:='[]'::jsonb; selected_list_id integer; native_optin text; source_hash text;
BEGIN
 IF depth<1 OR depth>4 OR jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
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

CREATE OR REPLACE FUNCTION crm_audience_v2.refresh_native_catalog(b text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE c crm_audience_v2.config%ROWTYPE; expected jsonb; native jsonb; composed jsonb; at timestamptz;
BEGIN
 IF b IS NULL OR b NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_BRAND'; END IF;
 expected:=CASE b
 WHEN 'fish' THEN '{"currency":null,"timezone":null,"shop_id":null,"fields":[{"key":"purchase.count","available":false,"source_hash":null},{"key":"purchase.last_date","available":false,"source_hash":null},{"key":"purchase.amount","available":false,"source_hash":null},{"key":"purchase.product","available":false,"source_hash":null},{"key":"signup.origin","available":false,"source_hash":null},{"key":"email.opened","available":true,"source_hash":"b9ec8cdafb47449f8001b1354cbef3e59db236fd91c9e6db3d817cdf8a6dd3f5"},{"key":"email.clicked","available":true,"source_hash":"640a55ed1c7bea3a7d7ee7b7ff0e2e2a250fa78af1018dedadd53cdf1dfc602d"}],"products":[],"origins":[]}'::jsonb
 WHEN 'aristo' THEN '{"currency":null,"timezone":null,"shop_id":null,"fields":[{"key":"purchase.count","available":false,"source_hash":null},{"key":"purchase.last_date","available":false,"source_hash":null},{"key":"purchase.amount","available":false,"source_hash":null},{"key":"purchase.product","available":false,"source_hash":null},{"key":"signup.origin","available":false,"source_hash":null},{"key":"email.opened","available":true,"source_hash":"090e2d886df88c1137c54bbe245006533f9ed4b01b25ef1e00f1ca5907c275a2"},{"key":"email.clicked","available":true,"source_hash":"59a67dadaa030a2cfb2a140e217ca0cface5b511dd385ac0a797db6dcee95572"}],"products":[],"origins":[]}'::jsonb
 END;
 native:=expected; composed:=crm_audience_v2.shopify_catalog(b,native);
 expected:=CASE WHEN EXISTS(SELECT 1 FROM crm_audience_v2.shopify_source WHERE brand=b AND enabled) THEN composed ELSE native END;
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_CONFIG'; END IF;
 IF NOT c.enabled THEN RETURN; END IF;
 IF NOT crm_audience_v2.shopify_catalog_trusted(b,c.catalog,native,composed) OR c.base_list_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.lists l WHERE l.id=c.base_list_id AND public.shrigma_campaign_list_brand(l)=b AND l.status::text='active' AND l.optin::text IN ('single','double')) THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_SOURCE'; END IF;
 -- Native TTL stays independent. Shopify source age is validated separately;
 -- enabling fields requires the private reviewed source configuration.
 PERFORM subscriber_id,campaign_id,created_at FROM public.campaign_views LIMIT 0;
 PERFORM subscriber_id,campaign_id,created_at FROM public.link_clicks LIMIT 0;
 at:=clock_timestamp();
 IF c.catalog=expected AND c.checked_at<=at AND c.expires_at>at+interval '2 minutes' THEN RETURN; END IF;
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b FOR UPDATE;
 PERFORM 1 FROM crm_audience_v2.shopify_source WHERE brand=b FOR SHARE;
 composed:=crm_audience_v2.shopify_catalog(b,native);
 expected:=CASE WHEN EXISTS(SELECT 1 FROM crm_audience_v2.shopify_source WHERE brand=b AND enabled) THEN composed ELSE native END;
 IF NOT c.enabled OR NOT crm_audience_v2.shopify_catalog_trusted(b,c.catalog,native,composed) THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_SOURCE'; END IF;
 UPDATE crm_audience_v2.config SET catalog=expected,checked_at=clock_timestamp(),expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=b;
END $fn$;
