-- Per-Customer order-parity evidence for product absence.
-- This upgrade starts from the PR194 quarantine and keeps product unavailable
-- until the current operation has an append-only v2 attestation.
BEGIN;

DO $guard$
BEGIN
 IF current_user<>'postgres' OR current_setting('server_version_num')<>'170010' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_CONTEXT'; END IF;
 LOCK TABLE crm_audience_v2.regular_worker_deployment,crm_audience_v2.regular_delivery_campaign,crm_audience_v2.selection_runtime,
  crm_audience_v2.config,crm_audience_v2.shopify_source,crm_audience_v2.shopify_batch,crm_audience_v2.shopify_chunk,
  crm_audience_v2.shopify_customer_fact,crm_audience_v2.shopify_identity,crm_audience_v2.shopify_product_batch,
  crm_audience_v2.shopify_product_chunk,crm_audience_v2.shopify_customer_product,crm_audience_v2.shopify_sync_operation,
  crm_audience_v2.shopify_sync_mutex IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_operation WHERE state NOT IN('completed','blocked'))
  OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_mutex WHERE operation_id IS NOT NULL OR lease_token IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REQUIRES_OFF'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_ingest_product_chunk(jsonb,integer,jsonb)')) IS DISTINCT FROM 'd9fd4af63d3cf43ae769765437af1a4f'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_ingest_chunk(jsonb,integer,jsonb)')) IS DISTINCT FROM 'a1471e5c44bcb571e6a930160be7a1bf'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_source_hash(text,text,jsonb)')) IS DISTINCT FROM 'bea3e1d48b2e44aa751ad873c6b106f9'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_catalog(text,jsonb)')) IS DISTINCT FROM '8c385b6d5ddbc90e4af56bed02684aa0'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_source_current(text,text,text)')) IS DISTINCT FROM '33999797ec2eac41bd3a6df5f830afb8'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_customer_match(jsonb,integer,text,text)')) IS DISTINCT FROM 'c59bea13c63c5130fa2fd9d9c6a94765'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)')) IS DISTINCT FROM '3d8b7d13f82477ce803a27dc7db9b74e'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')) IS DISTINCT FROM '3f037e001887923c953521334697ba9e' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_BASE_DRIFT'; END IF;
 IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='crm_audience_v2.shopify_customer_product'::regclass AND conname='shopify_customer_product_check') IS DISTINCT FROM 'CHECK ((history_complete = (unresolved_items = 0)))' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_CONSTRAINT_DRIFT'; END IF;
END $guard$;

ALTER TABLE crm_audience_v2.shopify_customer_product DROP CONSTRAINT shopify_customer_product_check;
ALTER TABLE crm_audience_v2.shopify_customer_product ADD CONSTRAINT shopify_customer_product_check CHECK (NOT history_complete OR unresolved_items=0);

CREATE TABLE crm_audience_v2.shopify_product_history_gap(
 brand text NOT NULL,operation_id text NOT NULL,customer_gid text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256~'^[0-9a-f]{64}$'),query_sha256 text NOT NULL CHECK(query_sha256='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086'),
 expected_orders numeric NOT NULL CHECK(expected_orders>=0 AND expected_orders<=18446744073709551615 AND scale(expected_orders)=0),
 observed_orders numeric NOT NULL CHECK(observed_orders>=0 AND observed_orders<=18446744073709551615 AND scale(observed_orders)=0),
 proof_sha256 text NOT NULL CHECK(proof_sha256~'^[0-9a-f]{64}$'),correction_sha256 text NOT NULL CHECK(correction_sha256~'^[0-9a-f]{64}$'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(brand,operation_id,customer_gid),
 FOREIGN KEY(brand,operation_id,customer_gid) REFERENCES crm_audience_v2.shopify_customer_product(brand,operation_id,customer_gid),
 CHECK(expected_orders<>observed_orders)
);
CREATE TABLE crm_audience_v2.shopify_product_history_attestation(
 brand text NOT NULL,operation_id text NOT NULL,source_sha256 text NOT NULL CHECK(source_sha256~'^[0-9a-f]{64}$'),
 query_sha256 text NOT NULL CHECK(query_sha256='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086'),
 producer_revision text NOT NULL CHECK(length(producer_revision) BETWEEN 1 AND 128),semantics text NOT NULL CHECK(semantics='customer-order-parity-v2'),
 mode text NOT NULL CHECK(mode IN('native_v2','derived_v1')),customer_count integer NOT NULL CHECK(customer_count BETWEEN 0 AND 250000),
 incomplete_count integer NOT NULL CHECK(incomplete_count BETWEEN 0 AND customer_count),proof_sha256 text NOT NULL CHECK(proof_sha256~'^[0-9a-f]{64}$'),
 attestation_sha256 text NOT NULL CHECK(attestation_sha256~'^[0-9a-f]{64}$'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(brand,operation_id),FOREIGN KEY(brand,operation_id) REFERENCES crm_audience_v2.shopify_product_batch(brand,operation_id)
);
CREATE TABLE crm_audience_v2.shopify_product_history_transition(
 brand text PRIMARY KEY REFERENCES crm_audience_v2.shopify_source(brand),current_operation text NOT NULL,
 from_revision text NOT NULL CHECK(length(from_revision) BETWEEN 1 AND 128),to_revision text NOT NULL CHECK(length(to_revision) BETWEEN 1 AND 128),
 proof_sha256 text NOT NULL CHECK(proof_sha256~'^[0-9a-f]{64}$'),prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(from_revision<>to_revision)
);
REVOKE ALL ON crm_audience_v2.shopify_product_history_gap,crm_audience_v2.shopify_product_history_attestation,crm_audience_v2.shopify_product_history_transition FROM PUBLIC,crm_audience_api,crm_shopify_sync;

CREATE FUNCTION crm_audience_v2.shopify_product_history_attested(b text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT coalesce((SELECT a.source_sha256=t.provenance->>'source_sha256' AND a.query_sha256=t.provenance->>'query_sha256'
  AND a.producer_revision=t.provenance->>'workflow_version' AND a.customer_count=(t.provenance#>>'{counts,customers}')::integer
  AND ((a.mode='native_v2' AND a.incomplete_count=(t.provenance#>>'{counts,product_history_incomplete}')::integer)
   OR (a.mode='derived_v1' AND a.incomplete_count=(t.provenance#>>'{counts,product_history_incomplete}')::integer+
    (SELECT count(*) FROM crm_audience_v2.shopify_product_history_gap g WHERE g.brand=a.brand AND g.operation_id=a.operation_id)))
  FROM crm_audience_v2.shopify_source s JOIN crm_audience_v2.shopify_product_batch t ON t.brand=s.brand AND t.operation_id=s.current_operation AND t.ready
  JOIN crm_audience_v2.shopify_product_history_attestation a ON a.brand=t.brand AND a.operation_id=t.operation_id
  WHERE s.brand=b AND s.enabled AND s.producer_revision=t.provenance->>'workflow_version'),false)
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_product_history_attested(text) FROM PUBLIC,crm_audience_api,crm_shopify_sync;

CREATE FUNCTION crm_audience_v2.shopify_prepare_product_history_transition(meta jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
DECLARE s crm_audience_v2.shopify_source%ROWTYPE;b text;op text;old_revision text;new_revision text;proof text;n integer;
BEGIN
 IF session_user<>'postgres' OR jsonb_typeof(meta) IS DISTINCT FROM 'object' OR NOT(meta ?& ARRAY['brand','current_operation','from_revision','to_revision','proof_sha256'])
  OR meta-'brand'-'current_operation'-'from_revision'-'to_revision'-'proof_sha256'<>'{}'::jsonb THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_TRANSITION_INPUT'; END IF;
 b:=meta->>'brand';op:=meta->>'current_operation';old_revision:=meta->>'from_revision';new_revision:=meta->>'to_revision';proof:=meta->>'proof_sha256';
 IF b NOT IN('fish','aristo') OR op!~'^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$' OR length(old_revision) NOT BETWEEN 1 AND 128
  OR length(new_revision) NOT BETWEEN 1 AND 128 OR old_revision=new_revision OR proof!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_TRANSITION_INPUT'; END IF;
 LOCK TABLE crm_audience_v2.regular_worker_deployment,crm_audience_v2.regular_delivery_campaign,crm_audience_v2.selection_runtime,
  crm_audience_v2.shopify_sync_operation,crm_audience_v2.shopify_sync_mutex IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled) OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime WHERE enabled) OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_operation WHERE state NOT IN('completed','blocked'))
  OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_mutex WHERE operation_id IS NOT NULL OR lease_token IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_TRANSITION_BUSY'; END IF;
 SELECT * INTO STRICT s FROM crm_audience_v2.shopify_source WHERE brand=b FOR UPDATE;
 IF NOT s.enabled OR s.current_operation IS DISTINCT FROM op OR s.producer_revision IS DISTINCT FROM old_revision
  OR NOT crm_audience_v2.shopify_product_history_attested(b) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_TRANSITION_SOURCE'; END IF;
 INSERT INTO crm_audience_v2.shopify_product_history_transition(brand,current_operation,from_revision,to_revision,proof_sha256)
 VALUES(b,op,old_revision,new_revision,proof) ON CONFLICT DO NOTHING;GET DIAGNOSTICS n=ROW_COUNT;
 IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_history_transition t WHERE t.brand=b AND t.current_operation=op
  AND t.from_revision=old_revision AND t.to_revision=new_revision AND t.proof_sha256=proof) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_TRANSITION_CONFLICT'; END IF;
 RETURN jsonb_build_object('brand',b,'from_revision',old_revision,'to_revision',new_revision,'replayed',n=0,'authorizes_send',false);
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_prepare_product_history_transition(jsonb) FROM PUBLIC,crm_audience_api,crm_shopify_sync;

CREATE FUNCTION crm_audience_v2.shopify_apply_product_history_attestation(meta jsonb,gaps jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
DECLARE cfg crm_audience_v2.shopify_source%ROWTYPE;batch crm_audience_v2.shopify_product_batch%ROWTYPE;item jsonb;
 b text;op text;raw text;proof text;producer text;correction text;attestation text;inserted integer:=0;attested_inserted integer:=0;n integer;customers integer;incomplete integer;
BEGIN
 IF session_user<>'postgres' OR jsonb_typeof(meta) IS DISTINCT FROM 'object' OR NOT(meta ?& ARRAY['brand','operation_id','source_sha256','query_sha256','producer_revision','customer_count','incomplete_count','proof_sha256'])
  OR meta-'brand'-'operation_id'-'source_sha256'-'query_sha256'-'producer_revision'-'customer_count'-'incomplete_count'-'proof_sha256'<>'{}'::jsonb
  OR jsonb_typeof(gaps) IS DISTINCT FROM 'array' OR jsonb_array_length(gaps)>1000 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_INPUT'; END IF;
 b:=meta->>'brand';op:=meta->>'operation_id';raw:=meta->>'source_sha256';proof:=meta->>'proof_sha256';producer:=meta->>'producer_revision';
 IF b NOT IN('fish','aristo') OR op!~'^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$' OR raw!~'^[0-9a-f]{64}$' OR proof!~'^[0-9a-f]{64}$'
  OR length(producer) NOT BETWEEN 1 AND 128 OR meta->>'query_sha256'<>'bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086'
  OR jsonb_typeof(meta->'customer_count')<>'number' OR meta->>'customer_count'!~'^(0|[1-9][0-9]{0,6})$'
  OR jsonb_typeof(meta->'incomplete_count')<>'number' OR meta->>'incomplete_count'!~'^(0|[1-9][0-9]{0,6})$' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_INPUT'; END IF;
 customers:=(meta->>'customer_count')::integer;incomplete:=(meta->>'incomplete_count')::integer;
 IF customers>250000 OR incomplete>customers THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_INPUT'; END IF;
 LOCK TABLE crm_audience_v2.regular_worker_deployment,crm_audience_v2.regular_delivery_campaign,crm_audience_v2.selection_runtime,
  crm_audience_v2.shopify_sync_operation,crm_audience_v2.shopify_sync_mutex IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO STRICT cfg FROM crm_audience_v2.shopify_source WHERE brand=b FOR UPDATE;
 SELECT * INTO STRICT batch FROM crm_audience_v2.shopify_product_batch WHERE brand=b AND operation_id=op FOR UPDATE;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled) OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime WHERE enabled) OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_operation WHERE state NOT IN('completed','blocked'))
  OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_mutex WHERE operation_id IS NOT NULL OR lease_token IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_BUSY'; END IF;
 IF cfg.current_operation IS DISTINCT FROM op OR NOT cfg.enabled OR cfg.producer_revision IS DISTINCT FROM producer OR NOT batch.ready
  OR batch.provenance->>'source_sha256' IS DISTINCT FROM raw OR batch.provenance->>'query_sha256' IS DISTINCT FROM meta->>'query_sha256'
  OR batch.provenance->>'workflow_version' IS DISTINCT FROM producer OR batch.provenance#>>'{counts,customers}' IS DISTINCT FROM customers::text
  OR (SELECT count(*) FROM crm_audience_v2.shopify_customer_product p WHERE p.brand=b AND p.operation_id=op)<>customers THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_SOURCE'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(gaps) x GROUP BY x->>'customer_gid' HAVING count(*)<>1) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_DUPLICATE'; END IF;
 correction:=encode(sha256(convert_to(jsonb_build_object('meta',meta,'gaps',gaps)::text,'UTF8')),'hex');
 FOR item IN SELECT x.value FROM jsonb_array_elements(gaps) x LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT(item ?& ARRAY['customer_gid','expected_orders','observed_orders']) OR item-'customer_gid'-'expected_orders'-'observed_orders'<>'{}'::jsonb
   OR item->>'customer_gid'!~'^gid://shopify/Customer/[1-9][0-9]{0,24}$' OR item->>'expected_orders'!~'^(0|[1-9][0-9]{0,19})$' OR item->>'observed_orders'!~'^(0|[1-9][0-9]{0,19})$'
   OR (item->>'expected_orders')::numeric>18446744073709551615 OR (item->>'observed_orders')::numeric>18446744073709551615 OR item->>'expected_orders'=item->>'observed_orders'
   OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.shopify_customer_fact f JOIN crm_audience_v2.shopify_customer_product p USING(brand,operation_id,customer_gid)
    WHERE f.brand=b AND f.operation_id=op AND f.customer_gid=item->>'customer_gid' AND f.orders_count=(item->>'expected_orders')::numeric AND p.history_complete AND p.unresolved_items=0) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_GAP'; END IF;
  INSERT INTO crm_audience_v2.shopify_product_history_gap(brand,operation_id,customer_gid,source_sha256,query_sha256,expected_orders,observed_orders,proof_sha256,correction_sha256)
  VALUES(b,op,item->>'customer_gid',raw,meta->>'query_sha256',(item->>'expected_orders')::numeric,(item->>'observed_orders')::numeric,proof,correction) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;inserted:=inserted+n;
  IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_history_gap g WHERE g.brand=b AND g.operation_id=op AND g.customer_gid=item->>'customer_gid'
   AND g.source_sha256=raw AND g.query_sha256=meta->>'query_sha256' AND g.expected_orders=(item->>'expected_orders')::numeric
   AND g.observed_orders=(item->>'observed_orders')::numeric AND g.proof_sha256=proof AND g.correction_sha256=correction) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_CONFLICT'; END IF;
 END LOOP;
 IF incomplete<>(SELECT count(*) FROM crm_audience_v2.shopify_customer_product p WHERE p.brand=b AND p.operation_id=op AND NOT p.history_complete)
   +(SELECT count(*) FROM crm_audience_v2.shopify_product_history_gap g WHERE g.brand=b AND g.operation_id=op) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_COUNT'; END IF;
 attestation:=encode(sha256(convert_to(jsonb_build_object('brand',b,'operation_id',op,'source_sha256',raw,'query_sha256',meta->>'query_sha256',
  'producer_revision',producer,'semantics','customer-order-parity-v2','mode','derived_v1','customer_count',customers,'incomplete_count',incomplete,'proof_sha256',proof,'correction_sha256',correction)::text,'UTF8')),'hex');
 INSERT INTO crm_audience_v2.shopify_product_history_attestation(brand,operation_id,source_sha256,query_sha256,producer_revision,semantics,mode,customer_count,incomplete_count,proof_sha256,attestation_sha256)
 VALUES(b,op,raw,meta->>'query_sha256',producer,'customer-order-parity-v2','derived_v1',customers,incomplete,proof,attestation) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS attested_inserted=ROW_COUNT;
 IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_history_attestation a WHERE a.brand=b AND a.operation_id=op AND a.source_sha256=raw
  AND a.query_sha256=meta->>'query_sha256' AND a.producer_revision=producer AND a.semantics='customer-order-parity-v2' AND a.mode='derived_v1'
  AND a.customer_count=customers AND a.incomplete_count=incomplete AND a.proof_sha256=proof AND a.attestation_sha256=attestation) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_ATTEST_CONFLICT'; END IF;
 RETURN jsonb_build_object('brand',b,'operation_id',op,'gaps',jsonb_array_length(gaps),'replayed',inserted=0 AND attested_inserted=0,'attestation_sha256',attestation,'authorizes_send',false);
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_apply_product_history_attestation(jsonb,jsonb) FROM PUBLIC,crm_audience_api,crm_shopify_sync;

DO $rewrite$
DECLARE d text;needle text;replacement text;n integer;
BEGIN
 d:=pg_get_functiondef('crm_audience_v2.shopify_ingest_chunk(jsonb,integer,jsonb)'::regprocedure);
 needle:='OR cfg.workflow_id IS DISTINCT FROM meta->>''workflow_id'' OR cfg.producer_revision IS DISTINCT FROM meta->>''workflow_version'' THEN';
 replacement:='OR cfg.workflow_id IS DISTINCT FROM meta->>''workflow_id'' OR (cfg.producer_revision IS DISTINCT FROM meta->>''workflow_version'' AND NOT EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_history_transition tr WHERE tr.brand=b AND tr.current_operation=cfg.current_operation AND tr.from_revision=cfg.producer_revision AND tr.to_revision=meta->>''workflow_version'' AND meta#>>''{bulk,product_history_semantics}''=''customer-order-parity-v2'')) THEN';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_SCALAR_PRODUCER';END IF;d:=replace(d,needle,replacement);
 needle:='UPDATE crm_audience_v2.shopify_source SET current_operation=op WHERE brand=b;';replacement:='UPDATE crm_audience_v2.shopify_source SET current_operation=op,producer_revision=meta->>''workflow_version'' WHERE brand=b;'||E'\n  '||'DELETE FROM crm_audience_v2.shopify_product_history_transition WHERE brand=b AND to_revision=meta->>''workflow_version'';';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_SCALAR_SWITCH';END IF;EXECUTE replace(d,needle,replacement);

 d:=pg_get_functiondef('crm_audience_v2.shopify_ingest_product_chunk(jsonb,integer,jsonb)'::regprocedure);
 needle:='OR meta#>''{bulk,required_scopes}'' IS DISTINCT FROM ''["read_customers","read_orders","read_all_orders","read_products"]''::jsonb THEN';
 replacement:='OR meta#>''{bulk,required_scopes}'' IS DISTINCT FROM ''["read_customers","read_orders","read_all_orders","read_products"]''::jsonb'||E'\n  '||'OR meta#>>''{bulk,product_history_semantics}'' IS DISTINCT FROM ''customer-order-parity-v2'' THEN';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_INGEST_MARKER';END IF;d:=replace(d,needle,replacement);
 needle:='(meta#>>''{counts,product_history_incomplete}'')::integer>least(expected,missing)';replacement:='(meta#>>''{counts,product_history_incomplete}'')::integer>expected';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_INGEST_COUNT';END IF;d:=replace(d,needle,replacement);
 needle:='(customer_row->>''product_history_complete'')::boolean IS DISTINCT FROM ((customer_row->>''unresolved_product_items'')::integer=0)';replacement:='((customer_row->>''product_history_complete'')::boolean AND (customer_row->>''unresolved_product_items'')::integer<>0)';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_INGEST_CUSTOMER';END IF;d:=replace(d,needle,replacement);
 needle:=E') WHERE brand=b AND operation_id=op;\n END IF;';
 replacement:=E') WHERE brand=b AND operation_id=op;\n  INSERT INTO crm_audience_v2.shopify_product_history_attestation(brand,operation_id,source_sha256,query_sha256,producer_revision,semantics,mode,customer_count,incomplete_count,proof_sha256,attestation_sha256)\n  VALUES(b,op,meta->>''source_sha256'',meta->>''query_sha256'',meta->>''workflow_version'',''customer-order-parity-v2'',''native_v2'',expected,(meta#>>''{counts,product_history_incomplete}'')::integer,meta_hash,\n   encode(sha256(convert_to(jsonb_build_object(''brand'',b,''operation_id'',op,''source_sha256'',meta->>''source_sha256'',''query_sha256'',meta->>''query_sha256'',''producer_revision'',meta->>''workflow_version'',''semantics'',''customer-order-parity-v2'',''mode'',''native_v2'',''customer_count'',expected,''incomplete_count'',(meta#>>''{counts,product_history_incomplete}'')::integer,''proof_sha256'',meta_hash)::text,''UTF8'')),''hex''));\n END IF;';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_INGEST_ATTEST';END IF;EXECUTE replace(d,needle,replacement);

 d:=pg_get_functiondef('crm_audience_v2.shopify_source_hash(text,text,jsonb)'::regprocedure);
 needle:='complete Customer export with all accessible orders and line items; read_all_orders required';replacement:='complete Customer export with all accessible orders and line items; read_all_orders required; each Customer Order-node count equals Customer.numberOfOrders';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_HASH';END IF;d:=replace(d,needle,replacement);
 needle:='shopify-customer-products-v1';replacement:='shopify-customer-products-v2';n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_HASH';END IF;EXECUTE replace(d,needle,replacement);

 d:=pg_get_functiondef('crm_audience_v2.shopify_customer_match(jsonb,integer,text,text)'::regprocedure);
 needle:=E'\n IF b=''aristo'' AND rule->>''field''=''purchase.product'' THEN RETURN NULL; END IF;';n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_MATCH';END IF;d:=replace(d,needle,'');
 needle:='IF NOT product_fact.history_complete THEN RETURN NULL; END IF;';replacement:='IF NOT product_fact.history_complete OR (f.orders_count=0 AND (f.last_order_at IS NOT NULL OR f.amount_spent>0)) OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_history_gap g WHERE g.brand=product_fact.brand AND g.operation_id=product_fact.operation_id AND g.customer_gid=product_fact.customer_gid) THEN RETURN NULL; END IF;';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_MATCH';END IF;EXECUTE replace(d,needle,replacement);

 d:=pg_get_functiondef('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)'::regprocedure);
 needle:='product_columns:='',p.products,p.history_complete,coalesce(t.ready,false) AS product_ready'';';replacement:='product_columns:='',p.products,(p.history_complete AND g.customer_gid IS NULL AND NOT (f.orders_count=0 AND (f.last_order_at IS NOT NULL OR f.amount_spent>0))) AS history_complete,coalesce(t.ready,false) AS product_ready'';';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_COUNT';END IF;d:=replace(d,needle,replacement);
 needle:='LEFT JOIN crm_audience_v2.shopify_product_batch t ON t.brand=p.brand AND t.operation_id=p.operation_id'';';replacement:='LEFT JOIN crm_audience_v2.shopify_product_batch t ON t.brand=p.brand AND t.operation_id=p.operation_id LEFT JOIN crm_audience_v2.shopify_product_history_gap g ON g.brand=p.brand AND g.operation_id=p.operation_id AND g.customer_gid=p.customer_gid'';';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_COUNT';END IF;EXECUTE replace(d,needle,replacement);

 d:=pg_get_functiondef('crm_audience_v2.shopify_catalog(text,jsonb)'::regprocedure);
 needle:='product_ready:=coalesce(b<>''aristo'' AND cfg.field_hashes->>''purchase.product''=crm_audience_v2.shopify_source_hash(b,''purchase.product'',composed)';replacement:='product_ready:=coalesce(cfg.field_hashes->>''purchase.product''=crm_audience_v2.shopify_source_hash(b,''purchase.product'',composed) AND crm_audience_v2.shopify_product_history_attested(b)';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_CATALOG';END IF;EXECUTE replace(d,needle,replacement);

 d:=pg_get_functiondef('crm_audience_v2.shopify_source_current(text,text,text)'::regprocedure);
 needle:='SELECT coalesce((SELECT NOT (b=''aristo'' AND field=''purchase.product'') AND s.enabled AND pin IS NOT NULL';replacement:='SELECT coalesce((SELECT s.enabled AND pin IS NOT NULL';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_CURRENT';END IF;d:=replace(d,needle,replacement);
 needle:='AND EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_batch t WHERE t.brand=b AND t.operation_id=s.current_operation AND t.ready)))';replacement:='AND EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_batch t WHERE t.brand=b AND t.operation_id=s.current_operation AND t.ready) AND crm_audience_v2.shopify_product_history_attested(b)))';
 n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_HISTORY_REWRITE_CURRENT';END IF;EXECUTE replace(d,needle,replacement);
END $rewrite$;

-- Rotate only the product semantic pin. Scalars and saved definitions retain their bytes.
UPDATE crm_audience_v2.shopify_source s SET field_hashes=jsonb_set(s.field_hashes,'{purchase.product}',to_jsonb(crm_audience_v2.shopify_source_hash(s.brand,'purchase.product',jsonb_build_object('shop_id',s.shop_id,'currency',s.currency,'timezone',s.timezone))));
DO $catalog$
DECLARE c crm_audience_v2.config%ROWTYPE;native jsonb;fields jsonb;
BEGIN
 FOR c IN SELECT * FROM crm_audience_v2.config ORDER BY brand LOOP
  IF NOT c.enabled OR c.catalog IS NULL THEN CONTINUE; END IF;
  SELECT jsonb_agg(CASE WHEN f->>'key' IN('purchase.count','purchase.last_date','purchase.amount','purchase.product') THEN jsonb_build_object('key',f->>'key','available',false,'source_hash',NULL) ELSE f END ORDER BY n) INTO fields FROM jsonb_array_elements(c.catalog->'fields') WITH ORDINALITY x(f,n);
  native:=c.catalog||jsonb_build_object('currency',NULL,'timezone',NULL,'shop_id',NULL,'fields',fields,'products','[]'::jsonb);
  UPDATE crm_audience_v2.config SET catalog=crm_audience_v2.shopify_catalog(c.brand,native),checked_at=clock_timestamp(),expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=c.brand;
 END LOOP;
END $catalog$;

COMMIT;
