-- Private operational integration candidate. No grants, deployment approval,
-- campaign admission, scheduler or production guard replacement is supplied.
-- The approved deployment row is an administrative trust boundary: never let
-- an HTTP client, scheduler or heartbeat approve its own executable/config.
DO $install$
BEGIN
 IF to_regprocedure('crm_audience_v2.regular_delivery_claim(integer,integer,uuid,text,text,text,text,text,jsonb)') IS NULL
 OR to_regprocedure('crm_audience_v2.refresh_native_catalog(text)') IS NULL
 OR to_regclass('crm_audience_v2.regular_worker_deployment') IS NOT NULL
 OR to_regclass('crm_audience_v2.regular_worker_lease') IS NOT NULL THEN
  RAISE EXCEPTION 'SEGMENT_WORKER_LEASE_DEPENDENCY_OR_COLLISION';
 END IF;
END $install$;

CREATE TABLE crm_audience_v2.regular_worker_deployment (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 worker_sha256 text CHECK(worker_sha256 ~ '^[0-9a-f]{64}$'),
 runtime_sha256 text CHECK(runtime_sha256 ~ '^[0-9a-f]{64}$'),
 query_sha256 text CHECK(query_sha256='3dc9433187c4ee16f0516503c6cc3efae63e9a607f9a15748e52a43217c6f7de'),
 database_role name,
 approved_at timestamptz,
 approved_by text,
 topology_receipt_sha256 text CHECK(topology_receipt_sha256 ~ '^[0-9a-f]{64}$'),
 CHECK(NOT enabled OR (worker_sha256 IS NOT NULL AND runtime_sha256 IS NOT NULL
  AND query_sha256 IS NOT NULL AND database_role IS NOT NULL
  AND approved_at IS NOT NULL AND isfinite(approved_at)
  AND approved_by IS NOT NULL AND length(approved_by)>0 AND topology_receipt_sha256 IS NOT NULL))
);
INSERT INTO crm_audience_v2.regular_worker_deployment(singleton) VALUES(true);
CREATE TABLE crm_audience_v2.regular_worker_lease (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 instance_id uuid NOT NULL,
 worker_sha256 text NOT NULL CHECK(worker_sha256 ~ '^[0-9a-f]{64}$'),
 runtime_sha256 text NOT NULL CHECK(runtime_sha256 ~ '^[0-9a-f]{64}$'),
 database_role name NOT NULL,
 heartbeat_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 suspended boolean NOT NULL DEFAULT false,
 suspension_reason text CHECK(suspension_reason IN('competing_instance','identity_changed','deployment_off')),
 CHECK(isfinite(heartbeat_at) AND isfinite(expires_at) AND expires_at>=heartbeat_at),
 CHECK(suspended=(suspension_reason IS NOT NULL))
);
REVOKE ALL ON crm_audience_v2.regular_worker_deployment,crm_audience_v2.regular_worker_lease FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.regular_worker_heartbeat(instance uuid,worker_sha text,runtime_sha text)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
 SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
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

-- Locks stay held until the caller confirms COMMIT. It is a private DB boundary,
-- not proof that a supplied identity came from an executable; the native store
-- must compute hashes and process UUID itself, never accept them from HTTP.
CREATE FUNCTION crm_audience_v2.regular_worker_require(instance uuid,worker_sha text,runtime_sha text)
 RETURNS timestamptz LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE approved crm_audience_v2.regular_worker_deployment%ROWTYPE;
 lease crm_audience_v2.regular_worker_lease%ROWTYPE;at timestamptz;
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_WORKER_LEASE_BOUNDARY';
  END IF;
  SELECT * INTO STRICT approved FROM crm_audience_v2.regular_worker_deployment WHERE singleton FOR SHARE;
  SELECT * INTO lease FROM crm_audience_v2.regular_worker_lease WHERE singleton FOR SHARE;
  at:=clock_timestamp();
  IF NOT approved.enabled OR approved.database_role IS DISTINCT FROM session_user::name
   OR approved.approved_at>at OR approved.worker_sha256 IS DISTINCT FROM worker_sha
   OR approved.runtime_sha256 IS DISTINCT FROM runtime_sha
   OR lease.instance_id IS NULL OR lease.suspended OR lease.instance_id IS DISTINCT FROM instance
   OR lease.worker_sha256 IS DISTINCT FROM worker_sha OR lease.runtime_sha256 IS DISTINCT FROM runtime_sha
   OR lease.database_role IS DISTINCT FROM session_user::name OR lease.heartbeat_at>at OR lease.expires_at<=at THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_WORKER_LEASE_UNAVAILABLE';
  END IF;
  RETURN lease.expires_at;
 END
$fn$;

CREATE FUNCTION crm_audience_v2.regular_delivery_claim_live(
 instance uuid,cid integer,sid integer,did uuid,worker_sha text,runtime_sha text,
 envelope_from text,envelope_to text,payload_sha text,subscriber_snapshot jsonb,actual_configuration_set text)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
 SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE until_at timestamptz;result jsonb;
 BEGIN
  until_at:=crm_audience_v2.regular_worker_require(instance,worker_sha,runtime_sha);
  result:=crm_audience_v2.regular_delivery_claim(cid,sid,did,worker_sha,runtime_sha,envelope_from,envelope_to,payload_sha,subscriber_snapshot);
  IF actual_configuration_set IS NULL OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign c
   WHERE c.campaign_id=cid AND c.configuration_set=actual_configuration_set) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_CONFIGURATION_SET_MISMATCH';
  END IF;
  -- The inner claim can wait on campaign/subscriber locks. Lease lifetime is
  -- checked again afterwards; failure rolls back its receipt/cursor effects.
  IF until_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_WORKER_LEASE_EXPIRED'; END IF;
  IF result->'should_send'='true'::jsonb THEN
   result:=jsonb_set(result,'{valid_until}',to_jsonb(least(until_at,(result->>'valid_until')::timestamptz)));
  END IF;
  RETURN result;
 END
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.regular_worker_heartbeat(uuid,text,text),
 crm_audience_v2.regular_worker_require(uuid,text,text),
 crm_audience_v2.regular_delivery_claim_live(uuid,integer,integer,uuid,text,text,text,text,text,jsonb,text) FROM PUBLIC;
