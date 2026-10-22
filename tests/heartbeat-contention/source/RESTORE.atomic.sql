-- Root-only CURRENT admission and one-use journal are separate; no actor/grant factory.
DO $heartbeat_contention_restore$
DECLARE e jsonb:=current_setting('shrigma.heartbeat_contention_expected',true)::jsonb;
 before_metadata jsonb;after_metadata jsonb;target_metadata jsonb;
BEGIN
 IF jsonb_typeof(e) IS DISTINCT FROM 'object'
 OR e->>'schema' IS DISTINCT FROM 'heartbeat-contention-expected-v1'
 OR e->>'stage' IS DISTINCT FROM 'restore'
 OR jsonb_typeof(e->'functionMetadata') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'HEARTBEAT_CONTENTION_CURRENT_EXPECTATION_REQUIRED'; END IF;
 IF current_database()<>'listmonk' OR current_setting('server_version_num')<>'170010'
 OR session_user IS DISTINCT FROM current_user OR current_setting('TimeZone')<>'Etc/UTC'
 OR current_setting('transaction_isolation')<>'read committed'
 OR current_setting('statement_timeout')::interval<>interval '5 seconds'
 OR current_setting('lock_timeout')::interval<>interval '500 milliseconds' THEN
  RAISE EXCEPTION 'HEARTBEAT_CONTENTION_ORIGINAL_BOUNDARY_REFUSED'; END IF;
 SELECT to_jsonb(p) INTO before_metadata FROM pg_catalog.pg_proc p
 WHERE p.oid=pg_catalog.to_regprocedure('crm_audience_v2.regular_worker_heartbeat(uuid,text,text)');
 IF before_metadata IS NULL OR before_metadata IS DISTINCT FROM e->'functionMetadata' THEN
  RAISE EXCEPTION 'HEARTBEAT_CONTENTION_METADATA_DRIFT'; END IF;
 IF md5(before_metadata->>'prosrc')<>'2fb7f585e75826a8a3b813b76caf7c20'
 OR octet_length(before_metadata->>'prosrc')<>5580
 OR before_metadata->>'prosecdef' IS DISTINCT FROM 'false'
 OR before_metadata->>'provolatile' IS DISTINCT FROM 'v'
 OR before_metadata->>'prorettype' IS DISTINCT FROM '3802'
 OR before_metadata->>'pronargs' IS DISTINCT FROM '3'
 OR jsonb_array_length(before_metadata->'proconfig')<>2
 OR NOT(before_metadata->'proconfig' @> '["search_path=pg_catalog","lock_timeout=2s"]'::jsonb) THEN
  RAISE EXCEPTION 'HEARTBEAT_CONTENTION_SOURCE_OR_CONFIG_REFUSED'; END IF;
 EXECUTE $heartbeat_definition$CREATE OR REPLACE FUNCTION crm_audience_v2.regular_worker_heartbeat(instance uuid,worker_sha text,runtime_sha text)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
 SET search_path=pg_catalog SET lock_timeout='2s' AS $fn$
 #variable_conflict use_variable
 DECLARE approved crm_audience_v2.regular_worker_deployment%ROWTYPE;
 lease crm_audience_v2.regular_worker_lease%ROWTYPE;at timestamptz;until_at timestamptz;brand text;
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_WORKER_LEASE_BOUNDARY';
  END IF;
  IF instance IS NULL OR instance='00000000-0000-0000-0000-000000000000'::uuid
   OR worker_sha IS NULL OR worker_sha !~ '^[0-9a-f]{64}$'
   OR runtime_sha IS NULL OR runtime_sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'SEGMENT_WORKER_LEASE_INPUT'; END IF;
  -- Deployment first, then lease, catalog and selection runtime. Claims hold
  -- deployment/lease share locks before entering their campaign transaction.
  SELECT * INTO STRICT approved FROM crm_audience_v2.regular_worker_deployment WHERE singleton FOR SHARE;
  IF approved.database_role IS DISTINCT FROM session_user::name THEN
   RETURN jsonb_build_object('ready',false,'reason','deployment_unavailable');
  END IF;
  -- A transaction advisory lock also serializes the first lease INSERT.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-audience-v2-regular-worker-lease',0));
  SELECT * INTO lease FROM crm_audience_v2.regular_worker_lease WHERE singleton FOR UPDATE;
  at:=clock_timestamp();
  IF NOT approved.enabled OR approved.approved_at>at THEN
   UPDATE crm_audience_v2.selection_runtime SET enabled=false WHERE singleton;
   IF lease.instance_id IS NOT NULL THEN
    UPDATE crm_audience_v2.regular_worker_lease SET suspended=true,suspension_reason='deployment_off' WHERE singleton;
   END IF;
   RETURN jsonb_build_object('ready',false,'reason','deployment_unavailable');
  END IF;
  IF worker_sha IS DISTINCT FROM approved.worker_sha256 OR runtime_sha IS DISTINCT FROM approved.runtime_sha256 THEN
   IF lease.instance_id=instance THEN
    UPDATE crm_audience_v2.regular_worker_lease SET suspended=true,suspension_reason='identity_changed' WHERE singleton;
    UPDATE crm_audience_v2.selection_runtime SET enabled=false WHERE singleton;
   END IF;
   RETURN jsonb_build_object('ready',false,'reason','identity_unavailable');
  END IF;
  IF lease.suspended THEN RETURN jsonb_build_object('ready',false,'reason','lease_suspended'); END IF;
  IF lease.instance_id IS NOT NULL AND lease.instance_id<>instance AND lease.expires_at>at THEN
   UPDATE crm_audience_v2.regular_worker_lease SET suspended=true,suspension_reason='competing_instance' WHERE singleton;
   UPDATE crm_audience_v2.selection_runtime SET enabled=false WHERE singleton;
   RETURN jsonb_build_object('ready',false,'reason','competing_instance');
  END IF;
  -- Refresh only the installed native semantics; this function never invents
  -- Shopify coverage, enables a source or replaces the catalog definition.
  FOREACH brand IN ARRAY ARRAY['fish','aristo'] LOOP
   BEGIN
    PERFORM crm_audience_v2.refresh_native_catalog(brand);
   EXCEPTION WHEN raise_exception THEN
    -- An unavailable catalog stays unavailable to that brand's selector. It
    -- must not prevent a healthy brand from renewing the same native process.
    IF SQLERRM NOT IN('SEGMENT_RUNTIME_SOURCE','SEGMENT_RUNTIME_CONFIG') THEN RAISE; END IF;
   END;
  END LOOP;
  at:=clock_timestamp();until_at:=at+interval '60 seconds';
  INSERT INTO crm_audience_v2.regular_worker_lease(singleton,instance_id,worker_sha256,runtime_sha256,database_role,heartbeat_at,expires_at)
   VALUES(true,instance,worker_sha,runtime_sha,session_user::name,at,until_at)
   ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,
    worker_sha256=excluded.worker_sha256,runtime_sha256=excluded.runtime_sha256,
    database_role=excluded.database_role,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at;
  UPDATE crm_audience_v2.selection_runtime SET enabled=true,candidate_query_sha256=approved.query_sha256,verified_at=at WHERE singleton;
  RETURN jsonb_build_object('ready',true,'reason','ready','instance_id',instance,'checked_at',at,'expires_at',until_at);
 END
$fn$;
$heartbeat_definition$;
 target_metadata:=jsonb_set(before_metadata,'{prosrc}',to_jsonb($expected_body$
 #variable_conflict use_variable
 DECLARE approved crm_audience_v2.regular_worker_deployment%ROWTYPE;
 lease crm_audience_v2.regular_worker_lease%ROWTYPE;at timestamptz;until_at timestamptz;brand text;
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_WORKER_LEASE_BOUNDARY';
  END IF;
  IF instance IS NULL OR instance='00000000-0000-0000-0000-000000000000'::uuid
   OR worker_sha IS NULL OR worker_sha !~ '^[0-9a-f]{64}$'
   OR runtime_sha IS NULL OR runtime_sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'SEGMENT_WORKER_LEASE_INPUT'; END IF;
  -- Deployment first, then lease, catalog and selection runtime. Claims hold
  -- deployment/lease share locks before entering their campaign transaction.
  SELECT * INTO STRICT approved FROM crm_audience_v2.regular_worker_deployment WHERE singleton FOR SHARE;
  IF approved.database_role IS DISTINCT FROM session_user::name THEN
   RETURN jsonb_build_object('ready',false,'reason','deployment_unavailable');
  END IF;
  -- A transaction advisory lock also serializes the first lease INSERT.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-audience-v2-regular-worker-lease',0));
  SELECT * INTO lease FROM crm_audience_v2.regular_worker_lease WHERE singleton FOR UPDATE;
  at:=clock_timestamp();
  IF NOT approved.enabled OR approved.approved_at>at THEN
   UPDATE crm_audience_v2.selection_runtime SET enabled=false WHERE singleton;
   IF lease.instance_id IS NOT NULL THEN
    UPDATE crm_audience_v2.regular_worker_lease SET suspended=true,suspension_reason='deployment_off' WHERE singleton;
   END IF;
   RETURN jsonb_build_object('ready',false,'reason','deployment_unavailable');
  END IF;
  IF worker_sha IS DISTINCT FROM approved.worker_sha256 OR runtime_sha IS DISTINCT FROM approved.runtime_sha256 THEN
   IF lease.instance_id=instance THEN
    UPDATE crm_audience_v2.regular_worker_lease SET suspended=true,suspension_reason='identity_changed' WHERE singleton;
    UPDATE crm_audience_v2.selection_runtime SET enabled=false WHERE singleton;
   END IF;
   RETURN jsonb_build_object('ready',false,'reason','identity_unavailable');
  END IF;
  IF lease.suspended THEN RETURN jsonb_build_object('ready',false,'reason','lease_suspended'); END IF;
  IF lease.instance_id IS NOT NULL AND lease.instance_id<>instance AND lease.expires_at>at THEN
   UPDATE crm_audience_v2.regular_worker_lease SET suspended=true,suspension_reason='competing_instance' WHERE singleton;
   UPDATE crm_audience_v2.selection_runtime SET enabled=false WHERE singleton;
   RETURN jsonb_build_object('ready',false,'reason','competing_instance');
  END IF;
  -- Refresh only the installed native semantics; this function never invents
  -- Shopify coverage, enables a source or replaces the catalog definition.
  FOREACH brand IN ARRAY ARRAY['fish','aristo'] LOOP
   BEGIN
    PERFORM crm_audience_v2.refresh_native_catalog(brand);
   EXCEPTION WHEN raise_exception THEN
    -- An unavailable catalog stays unavailable to that brand's selector. It
    -- must not prevent a healthy brand from renewing the same native process.
    IF SQLERRM NOT IN('SEGMENT_RUNTIME_SOURCE','SEGMENT_RUNTIME_CONFIG') THEN RAISE; END IF;
   END;
  END LOOP;
  at:=clock_timestamp();until_at:=at+interval '60 seconds';
  INSERT INTO crm_audience_v2.regular_worker_lease(singleton,instance_id,worker_sha256,runtime_sha256,database_role,heartbeat_at,expires_at)
   VALUES(true,instance,worker_sha,runtime_sha,session_user::name,at,until_at)
   ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,
    worker_sha256=excluded.worker_sha256,runtime_sha256=excluded.runtime_sha256,
    database_role=excluded.database_role,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at;
  UPDATE crm_audience_v2.selection_runtime SET enabled=true,candidate_query_sha256=approved.query_sha256,verified_at=at WHERE singleton;
  RETURN jsonb_build_object('ready',true,'reason','ready','instance_id',instance,'checked_at',at,'expires_at',until_at);
 END
$expected_body$::text));
 SELECT to_jsonb(p) INTO after_metadata FROM pg_catalog.pg_proc p
 WHERE p.oid=pg_catalog.to_regprocedure('crm_audience_v2.regular_worker_heartbeat(uuid,text,text)');
 IF after_metadata IS DISTINCT FROM target_metadata THEN RAISE EXCEPTION 'HEARTBEAT_CONTENTION_AFTER_METADATA_DRIFT'; END IF;
END $heartbeat_contention_restore$;
