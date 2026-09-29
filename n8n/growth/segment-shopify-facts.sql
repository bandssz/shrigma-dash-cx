-- Candidate migration, private nightly-source evidence only. Every source starts OFF.
-- Never infer a Customer, purchase count or consent from an absent row.
DO $shopify_install$
BEGIN
 IF to_regclass('crm_audience_v2.config') IS NULL
  OR to_regclass('crm_audience_v2.shopify_source') IS NOT NULL THEN
  RAISE EXCEPTION 'SHOPIFY_SOURCE_INSTALL_BOUNDARY';
 END IF;
END $shopify_install$;
CREATE TABLE crm_audience_v2.shopify_source (
 brand text PRIMARY KEY CHECK(brand IN('fish','aristo')),
 shop_id text NOT NULL CHECK(shop_id ~ '^gid://shopify/Shop/[1-9][0-9]{0,19}$'),
 domain text NOT NULL CHECK(domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 timezone text NOT NULL CHECK(timezone='America/Sao_Paulo'),
 query_sha256 text NOT NULL CHECK(query_sha256 ~ '^[0-9a-f]{64}$'),
 workflow_id text NOT NULL CHECK(length(workflow_id) BETWEEN 1 AND 80),
 producer_revision text NOT NULL CHECK(length(producer_revision) BETWEEN 1 AND 128),
 field_hashes jsonb NOT NULL CHECK(jsonb_typeof(field_hashes)='object'),
 ingestion_enabled boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT false,
 current_operation text,
 max_age_seconds integer NOT NULL DEFAULT 93600 CHECK(max_age_seconds=93600)
);
CREATE TABLE crm_audience_v2.shopify_batch (
 brand text NOT NULL REFERENCES crm_audience_v2.shopify_source(brand),
 operation_id text NOT NULL CHECK(operation_id ~ '^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$'),
 provenance jsonb NOT NULL,
 provenance_sha256 text NOT NULL CHECK(provenance_sha256 ~ '^[0-9a-f]{64}$'),
 expected_customers integer NOT NULL CHECK(expected_customers BETWEEN 0 AND 1000000),
 expected_chunks integer NOT NULL CHECK(expected_chunks BETWEEN 1 AND 200),
 started_at timestamptz NOT NULL,
 completed_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'staging' CHECK(status IN('staging','ready')),
 finalized_at timestamptz,
 mapped_customers integer,
 unresolved_customers integer,
 PRIMARY KEY(brand,operation_id),
 CHECK(isfinite(started_at) AND isfinite(completed_at) AND isfinite(observed_at)
  AND started_at<=completed_at AND completed_at<=observed_at),
 CHECK((status='staging' AND finalized_at IS NULL AND mapped_customers IS NULL AND unresolved_customers IS NULL)
  OR (status='ready' AND finalized_at IS NOT NULL AND mapped_customers>=0 AND unresolved_customers>=0
   AND mapped_customers+unresolved_customers=expected_customers))
);
CREATE TABLE crm_audience_v2.shopify_chunk (
 brand text NOT NULL, operation_id text NOT NULL, chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 199),
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 customer_count integer NOT NULL CHECK(customer_count BETWEEN 0 AND 5000),
 PRIMARY KEY(brand,operation_id,chunk_index),
 FOREIGN KEY(brand,operation_id) REFERENCES crm_audience_v2.shopify_batch(brand,operation_id)
);
CREATE TABLE crm_audience_v2.shopify_identity (
 brand text NOT NULL REFERENCES crm_audience_v2.shopify_source(brand),
 customer_gid text NOT NULL CHECK(customer_gid ~ '^gid://shopify/Customer/[1-9][0-9]{0,24}$'),
 subscriber_id integer NOT NULL,
 subscriber_uuid uuid NOT NULL,
 email text NOT NULL,
 first_operation text NOT NULL,
 mapped_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(brand,customer_gid),
 UNIQUE(brand,subscriber_uuid),
 CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 320)
);
-- No FK to native contacts: deletion must preserve the evidence and cannot
-- accidentally block a native operation. Readers require the current UUID.
CREATE TABLE crm_audience_v2.shopify_customer_fact (
 brand text NOT NULL,operation_id text NOT NULL,customer_gid text NOT NULL,
 email text,orders_count numeric NOT NULL,amount_spent numeric NOT NULL,currency text NOT NULL,
 last_order_at timestamptz,customer_created_at timestamptz NOT NULL,customer_updated_at timestamptz NOT NULL,
 identity_ambiguous boolean NOT NULL, identity_resolvable boolean NOT NULL,
 subscriber_id integer,subscriber_uuid uuid,
 identity_state text NOT NULL DEFAULT 'pending' CHECK(identity_state IN
  ('pending','resolved','missing_email','unsupported_email','duplicate_customer_email','missing_contact','ambiguous_contact','identity_changed')),
 PRIMARY KEY(brand,operation_id,customer_gid),
 FOREIGN KEY(brand,operation_id) REFERENCES crm_audience_v2.shopify_batch(brand,operation_id),
 CHECK(customer_gid ~ '^gid://shopify/Customer/[1-9][0-9]{0,24}$'),
 CHECK(orders_count>=0 AND orders_count<=18446744073709551615 AND scale(orders_count)=0),
 CHECK(amount_spent>=0 AND amount_spent::text !~ '[NnIi]'),
 CHECK(currency ~ '^[A-Z]{3}$'),
 CHECK((identity_state='resolved' AND subscriber_id IS NOT NULL AND subscriber_uuid IS NOT NULL)
  OR (identity_state<>'resolved' AND subscriber_id IS NULL AND subscriber_uuid IS NULL))
);
CREATE INDEX shopify_fact_email_lookup ON crm_audience_v2.shopify_customer_fact(brand,operation_id,email);
CREATE INDEX shopify_fact_native_lookup ON crm_audience_v2.shopify_customer_fact(brand,operation_id,subscriber_id)
 WHERE identity_state='resolved';
CREATE UNIQUE INDEX shopify_fact_native_unique ON crm_audience_v2.shopify_customer_fact(brand,operation_id,subscriber_uuid)
 WHERE identity_state='resolved';
REVOKE ALL ON crm_audience_v2.shopify_source,crm_audience_v2.shopify_batch,crm_audience_v2.shopify_chunk,
 crm_audience_v2.shopify_identity,crm_audience_v2.shopify_customer_fact FROM PUBLIC;

-- Called only by the existing, reviewed nightly workflow. No HTTP/API grant.
-- Chunks are immutable/idempotent; only a complete reconciled batch becomes current.
CREATE FUNCTION crm_audience_v2.shopify_ingest_chunk(meta jsonb,part integer,customers jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
DECLARE cfg crm_audience_v2.shopify_source%ROWTYPE;batch crm_audience_v2.shopify_batch%ROWTYPE;
 b text;op text;expected integer;parts integer;count_rows integer;meta_hash text;chunk_hash text;
 r jsonb;old_hash text;started timestamptz;completed timestamptz;observed timestamptz;
 mapped integer;missing integer;
BEGIN
 IF jsonb_typeof(meta) IS DISTINCT FROM 'object' OR octet_length(meta::text)>16000
  OR NOT(meta ?& ARRAY['version','brand','shop','operation_id','started_at','completed_at','observed_at',
   'query_sha256','workflow_id','workflow_version','source_sha256','counts','bulk'])
  OR meta-'version'-'brand'-'shop'-'operation_id'-'started_at'-'completed_at'-'observed_at'-'query_sha256'
   -'workflow_id'-'workflow_version'-'source_sha256'-'counts'-'bulk'<>'{}'::jsonb
  OR meta->'version' IS DISTINCT FROM '1'::jsonb
  OR jsonb_typeof(customers) IS DISTINCT FROM 'array' OR jsonb_array_length(customers)>5000
  OR octet_length(customers::text)>16777216 THEN RAISE EXCEPTION 'SHOPIFY_INGEST_SHAPE'; END IF;
 b:=meta->>'brand';op:=meta->>'operation_id';
 IF b IS NULL OR b NOT IN('fish','aristo') OR op IS NULL OR op !~ '^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$'
  OR meta->>'source_sha256' IS NULL OR meta->>'source_sha256' !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(meta->'counts') IS DISTINCT FROM 'object'
  OR jsonb_typeof(meta->'bulk') IS DISTINCT FROM 'object'
  OR jsonb_typeof(meta#>'{counts,customers}') IS DISTINCT FROM 'number'
  OR meta#>>'{counts,customers}' !~ '^(0|[1-9][0-9]{0,6})$'
  OR (meta#>>'{counts,customers}')::numeric>250000 THEN RAISE EXCEPTION 'SHOPIFY_INGEST_META'; END IF;
 expected:=(meta#>>'{counts,customers}')::integer;parts:=greatest(1,(expected+4999)/5000);
 count_rows:=jsonb_array_length(customers);
 IF part IS NULL OR part<0 OR part>=parts OR count_rows<>least(5000,greatest(0,expected-part*5000))
  OR meta#>>'{counts,object_count}' IS DISTINCT FROM expected::text
  OR meta#>>'{counts,root_object_count}' IS DISTINCT FROM expected::text
  OR meta#>'{bulk,partial_data}' IS DISTINCT FROM 'false'::jsonb
  OR meta#>>'{bulk,required_scope}' IS DISTINCT FROM 'read_customers'
  OR meta#>>'{bulk,file_size}' IS DISTINCT FROM meta#>>'{counts,bytes}' THEN RAISE EXCEPTION 'SHOPIFY_INGEST_COMPLETENESS'; END IF;
 started:=(meta->>'started_at')::timestamptz;completed:=(meta->>'completed_at')::timestamptz;observed:=(meta->>'observed_at')::timestamptz;
 IF started IS NULL OR completed IS NULL OR observed IS NULL OR NOT isfinite(started) OR NOT isfinite(completed)
  OR NOT isfinite(observed) OR started>completed OR completed>observed OR observed>clock_timestamp()+interval '15 seconds'
  OR started<=clock_timestamp()-interval '26 hours' THEN RAISE EXCEPTION 'SHOPIFY_INGEST_DATE'; END IF;
 SELECT * INTO STRICT cfg FROM crm_audience_v2.shopify_source WHERE brand=b FOR UPDATE;
 IF NOT cfg.ingestion_enabled OR cfg.domain IS DISTINCT FROM meta->>'shop'
  OR cfg.shop_id IS DISTINCT FROM meta#>>'{bulk,shop_gid}' OR cfg.currency IS DISTINCT FROM meta#>>'{bulk,shop_currency}'
  OR cfg.timezone IS DISTINCT FROM meta#>>'{bulk,shop_timezone}' OR cfg.query_sha256 IS DISTINCT FROM meta->>'query_sha256'
  OR cfg.workflow_id IS DISTINCT FROM meta->>'workflow_id' OR cfg.producer_revision IS DISTINCT FROM meta->>'workflow_version' THEN
  RAISE EXCEPTION 'SHOPIFY_INGEST_PRODUCER';
 END IF;
 -- Re-reading the identical completed export may have a later observation time.
 -- Preserve the first observation; every source, producer and content pin must match.
 meta_hash:=encode(sha256(convert_to((meta-'observed_at')::text,'UTF8')),'hex');
 chunk_hash:=encode(sha256(convert_to(customers::text,'UTF8')),'hex');
 INSERT INTO crm_audience_v2.shopify_batch(brand,operation_id,provenance,provenance_sha256,expected_customers,expected_chunks,started_at,completed_at,observed_at)
 VALUES(b,op,meta,meta_hash,expected,parts,started,completed,observed) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT batch FROM crm_audience_v2.shopify_batch WHERE brand=b AND operation_id=op FOR UPDATE;
 IF batch.provenance-'observed_at' IS DISTINCT FROM meta-'observed_at' OR batch.provenance_sha256<>meta_hash OR observed<batch.observed_at THEN RAISE EXCEPTION 'SHOPIFY_INGEST_REPLAY_CONFLICT'; END IF;
 SELECT payload_sha256 INTO old_hash FROM crm_audience_v2.shopify_chunk WHERE brand=b AND operation_id=op AND chunk_index=part;
 IF FOUND THEN
  IF old_hash<>chunk_hash THEN RAISE EXCEPTION 'SHOPIFY_INGEST_REPLAY_CONFLICT'; END IF;
  RETURN jsonb_build_object('status',batch.status,'replayed',true,'customers',batch.expected_customers,
   'mapped',batch.mapped_customers,'unresolved',batch.unresolved_customers,'authorizes_send',false);
 END IF;
 IF batch.status<>'staging' THEN RAISE EXCEPTION 'SHOPIFY_INGEST_FINALIZED'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(customers) LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object'
   OR NOT(r ?& ARRAY['customer_gid','email','orders_count','amount_spent','currency','last_order_at','created_at','updated_at','identity_ambiguous','identity_resolvable'])
   OR r-'customer_gid'-'email'-'orders_count'-'amount_spent'-'currency'-'last_order_at'-'created_at'-'updated_at'-'identity_ambiguous'-'identity_resolvable'<>'{}'::jsonb
   OR jsonb_typeof(r->'customer_gid') IS DISTINCT FROM 'string' OR r->>'customer_gid' !~ '^gid://shopify/Customer/[1-9][0-9]{0,24}$'
   OR jsonb_typeof(r->'orders_count') IS DISTINCT FROM 'string' OR r->>'orders_count' !~ '^(0|[1-9][0-9]{0,19})$'
   OR (r->>'orders_count')::numeric>18446744073709551615
   OR jsonb_typeof(r->'amount_spent') IS DISTINCT FROM 'string' OR length(r->>'amount_spent')>96
   OR r->>'amount_spent' !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
   OR r->>'currency' IS DISTINCT FROM cfg.currency
   OR jsonb_typeof(r->'identity_ambiguous') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(r->'identity_resolvable') IS DISTINCT FROM 'boolean'
   OR (r->'email'<>'null'::jsonb AND (jsonb_typeof(r->'email')<>'string'
     OR length(r->>'email') NOT BETWEEN 3 AND 320 OR r->>'email' !~ '^[^ @[:cntrl:]]+@[^ @[:cntrl:]]+$'))
   OR (r->>'identity_resolvable')::boolean IS DISTINCT FROM (r->'email'<>'null'::jsonb
     AND octet_length(r->>'email')=length(r->>'email') AND NOT (r->>'identity_ambiguous')::boolean)
   OR ((r->>'identity_resolvable')::boolean AND r->>'email'<>lower(btrim(r->>'email')))
   OR (r->>'created_at')::timestamptz IS NULL OR (r->>'updated_at')::timestamptz IS NULL
   OR NOT isfinite((r->>'created_at')::timestamptz) OR NOT isfinite((r->>'updated_at')::timestamptz)
   OR (r->>'created_at')::timestamptz>(r->>'updated_at')::timestamptz OR (r->>'updated_at')::timestamptz>completed
   OR (r->'last_order_at'<>'null'::jsonb AND (NOT isfinite((r->>'last_order_at')::timestamptz)
    OR (r->>'last_order_at')::timestamptz>completed)) THEN
   RAISE EXCEPTION 'SHOPIFY_INGEST_CUSTOMER';
  END IF;
 END LOOP;
 INSERT INTO crm_audience_v2.shopify_customer_fact(brand,operation_id,customer_gid,email,orders_count,amount_spent,currency,
  last_order_at,customer_created_at,customer_updated_at,identity_ambiguous,identity_resolvable)
 SELECT b,op,entry.value->>'customer_gid',entry.value->>'email',(entry.value->>'orders_count')::numeric,
  (entry.value->>'amount_spent')::numeric,entry.value->>'currency',(entry.value->>'last_order_at')::timestamptz,
  (entry.value->>'created_at')::timestamptz,(entry.value->>'updated_at')::timestamptz,(entry.value->>'identity_ambiguous')::boolean,(entry.value->>'identity_resolvable')::boolean
 FROM jsonb_array_elements(customers) AS entry(value);
 INSERT INTO crm_audience_v2.shopify_chunk VALUES(b,op,part,chunk_hash,count_rows);
 IF (SELECT count(*) FROM crm_audience_v2.shopify_chunk WHERE brand=b AND operation_id=op)<parts THEN
  RETURN jsonb_build_object('status','staging','replayed',false,'customers',expected,'authorizes_send',false);
 END IF;
 IF (SELECT count(*) FROM crm_audience_v2.shopify_customer_fact WHERE brand=b AND operation_id=op)<>expected THEN
  RAISE EXCEPTION 'SHOPIFY_INGEST_FINAL_COUNT';
 END IF;
 -- Bulk-loaded private facts need current cardinalities before resolving the
 -- whole snapshot. Do not depend on asynchronous autovacuum after the last chunk.
 ANALYZE crm_audience_v2.shopify_customer_fact;
 ANALYZE crm_audience_v2.shopify_identity;
 -- Recompute ambiguity across the entire source, including different chunks.
 WITH duplicates AS MATERIALIZED (
  SELECT email FROM crm_audience_v2.shopify_customer_fact
  WHERE brand=b AND operation_id=op AND email IS NOT NULL GROUP BY email HAVING count(*)>1
 ) UPDATE crm_audience_v2.shopify_customer_fact f SET identity_state=CASE WHEN email IS NULL THEN 'missing_email'
  WHEN identity_ambiguous OR email IN(SELECT email FROM duplicates) THEN 'duplicate_customer_email'
  WHEN NOT identity_resolvable THEN 'unsupported_email' ELSE 'pending' END
 WHERE f.brand=b AND f.operation_id=op;
 -- Match from the current committed native contacts AFTER the legacy insert.
 -- Never enroll, unblock, alter native data or choose among duplicate addresses.
 WITH native_contacts AS MATERIALIZED (
  SELECT lower(btrim(s.email)) AS email,count(*)::integer AS matches,min(s.id) AS sid
  FROM public.subscribers s WHERE s.email IS NOT NULL GROUP BY lower(btrim(s.email))
 ), candidates AS MATERIALIZED (
  SELECT f.customer_gid,coalesce(n.matches,0) AS matches,n.sid
  FROM crm_audience_v2.shopify_customer_fact f LEFT JOIN native_contacts n ON n.email=f.email
  WHERE f.brand=b AND f.operation_id=op AND f.identity_state='pending'
 ), classified AS MATERIALIZED (
  SELECT c.*,s.uuid,
   CASE WHEN c.matches=0 THEN 'missing_contact' WHEN c.matches>1 THEN 'ambiguous_contact'
    WHEN EXISTS(SELECT 1 FROM crm_audience_v2.shopify_identity i WHERE i.brand=b
     AND ((i.customer_gid=c.customer_gid AND (i.subscriber_id<>s.id OR i.subscriber_uuid<>s.uuid))
       OR (i.subscriber_uuid=s.uuid AND i.customer_gid<>c.customer_gid))) THEN 'identity_changed'
    ELSE 'resolved' END AS state
  FROM candidates c LEFT JOIN public.subscribers s ON s.id=c.sid
 ) UPDATE crm_audience_v2.shopify_customer_fact f SET identity_state=c.state,
  subscriber_id=CASE WHEN c.state='resolved' THEN c.sid END,subscriber_uuid=CASE WHEN c.state='resolved' THEN c.uuid END
 FROM classified c WHERE f.brand=b AND f.operation_id=op AND f.customer_gid=c.customer_gid;
 INSERT INTO crm_audience_v2.shopify_identity(brand,customer_gid,subscriber_id,subscriber_uuid,email,first_operation)
 SELECT brand,customer_gid,subscriber_id,subscriber_uuid,email,operation_id FROM crm_audience_v2.shopify_customer_fact
 WHERE brand=b AND operation_id=op AND identity_state='resolved' ON CONFLICT(brand,customer_gid) DO NOTHING;
 SELECT count(*) FILTER(WHERE identity_state='resolved'),count(*) FILTER(WHERE identity_state<>'resolved')
 INTO mapped,missing FROM crm_audience_v2.shopify_customer_fact WHERE brand=b AND operation_id=op;
 UPDATE crm_audience_v2.shopify_batch SET status='ready',finalized_at=clock_timestamp(),mapped_customers=mapped,unresolved_customers=missing
 WHERE brand=b AND operation_id=op;
 -- A slower older execution cannot replace a newer completed snapshot.
 IF cfg.current_operation IS NULL OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.shopify_batch old
  WHERE old.brand=b AND old.operation_id=cfg.current_operation AND old.started_at>=started) THEN
  UPDATE crm_audience_v2.shopify_source SET current_operation=op WHERE brand=b;
 END IF;
 -- Keep only seven days of duplicate customer payloads. Aggregate provenance
 -- and the immutable identity history remain; the current snapshot is excluded.
 DELETE FROM crm_audience_v2.shopify_customer_fact f USING crm_audience_v2.shopify_batch old
 WHERE old.brand=b AND old.started_at<clock_timestamp()-interval '7 days'
  AND old.operation_id IS DISTINCT FROM (SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand=b)
  AND f.brand=old.brand AND f.operation_id=old.operation_id;
 DELETE FROM crm_audience_v2.shopify_chunk x USING crm_audience_v2.shopify_batch old
 WHERE old.brand=b AND old.started_at<clock_timestamp()-interval '7 days'
  AND old.operation_id IS DISTINCT FROM (SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand=b)
  AND x.brand=old.brand AND x.operation_id=old.operation_id;
 RETURN jsonb_build_object('status','ready','replayed',false,'customers',expected,'mapped',mapped,'unresolved',missing,'authorizes_send',false);
END
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_ingest_chunk(jsonb,integer,jsonb) FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.shopify_snapshot(b text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT coalesce((SELECT jsonb_build_object('current',s.enabled AND t.status='ready'
   AND t.started_at<=statement_timestamp() AND t.observed_at<=clock_timestamp()
   AND t.started_at+make_interval(secs=>s.max_age_seconds)>clock_timestamp()
   AND t.provenance->>'query_sha256'=s.query_sha256 AND t.provenance->>'workflow_id'=s.workflow_id
   AND t.provenance->>'workflow_version'=s.producer_revision
   AND t.provenance#>>'{bulk,shop_gid}'=s.shop_id AND t.provenance->>'shop'=s.domain
   AND t.provenance#>>'{bulk,shop_currency}'=s.currency AND t.provenance#>>'{bulk,shop_timezone}'=s.timezone,
   'started_at',t.started_at,'observed_at',t.observed_at,
   'expires_at',t.started_at+make_interval(secs=>s.max_age_seconds),
   'customers',t.expected_customers,'mapped',t.mapped_customers,'unresolved',t.unresolved_customers)
  FROM crm_audience_v2.shopify_source s JOIN crm_audience_v2.shopify_batch t ON t.brand=s.brand AND t.operation_id=s.current_operation
  WHERE s.brand=b),jsonb_build_object('current',false))
$fn$;
CREATE FUNCTION crm_audience_v2.shopify_source_current(b text,field text,pin text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT coalesce((SELECT s.enabled AND pin IS NOT NULL AND s.field_hashes->>field=pin
  AND crm_audience_v2.shopify_snapshot(b)->'current'='true'::jsonb
  FROM crm_audience_v2.shopify_source s WHERE s.brand=b),false)
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_source_current(text,text,text) FROM PUBLIC;
CREATE FUNCTION crm_audience_v2.shopify_rule_valid(rule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN
 IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR rule->>'op' IS DISTINCT FROM 'condition'
  OR NOT(rule ?& ARRAY['op','field','operator','value']) OR rule-'op'-'field'-'operator'-'value'<>'{}'::jsonb THEN RETURN false; END IF;
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

-- The count provider and native selector use this exact predicate. An unresolved
-- or stale source is SQL NULL. A literal zero comes only from a completed Customer.
CREATE FUNCTION crm_audience_v2.shopify_customer_match(rule jsonb,sid integer,b text,pin text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE cfg crm_audience_v2.shopify_source%ROWTYPE;f crm_audience_v2.shopify_customer_fact%ROWTYPE;
 value_number numeric;target_number numeric;value_date date;target_date date;
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
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_snapshot(text),crm_audience_v2.shopify_rule_valid(jsonb),
 crm_audience_v2.shopify_customer_match(jsonb,integer,text,text) FROM PUBLIC;
