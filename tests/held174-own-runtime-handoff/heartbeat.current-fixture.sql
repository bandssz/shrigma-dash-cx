CREATE OR REPLACE FUNCTION crm_audience_v2.regular_worker_heartbeat(instance uuid,worker_sha text,runtime_sha text)
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
  BEGIN
   SELECT * INTO lease FROM crm_audience_v2.regular_worker_lease WHERE singleton FOR UPDATE;
  EXCEPTION WHEN lock_not_available THEN
   -- A committed claim can hold the lease SHARE lock while its guarded work runs.
   -- Keep only a previously committed grant. Never renew, refresh or mutate here.
   SELECT * INTO lease FROM crm_audience_v2.regular_worker_lease WHERE singleton;
   PERFORM 1 FROM crm_audience_v2.selection_runtime WHERE singleton FOR SHARE;
   at:=clock_timestamp();
   IF approved.enabled AND approved.approved_at<=at
    AND approved.worker_sha256 IS NOT DISTINCT FROM worker_sha
    AND approved.runtime_sha256 IS NOT DISTINCT FROM runtime_sha
    AND approved.database_role IS NOT DISTINCT FROM session_user::name
    AND lease.instance_id IS NOT DISTINCT FROM instance AND NOT lease.suspended
    AND lease.worker_sha256 IS NOT DISTINCT FROM worker_sha
    AND lease.runtime_sha256 IS NOT DISTINCT FROM runtime_sha
    AND lease.database_role IS NOT DISTINCT FROM session_user::name
    AND lease.heartbeat_at<=at AND lease.expires_at>at
    AND EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime r
     WHERE r.singleton AND r.enabled AND r.candidate_query_sha256=approved.query_sha256
      AND r.verified_at<=at AND r.verified_at>at-interval '5 minutes') THEN
    RETURN jsonb_build_object('ready',true,'reason','ready','instance_id',instance,
     'checked_at',at,'expires_at',lease.expires_at);
   END IF;
   RETURN jsonb_build_object('ready',false,'reason','lease_unavailable');
  END;
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
