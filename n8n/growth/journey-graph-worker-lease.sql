-- Health evidence for the existing crm-flows process. This does not authorize
-- activation, enrollment, claims or transport. Administrative approval is a
-- separate boundary and no grants are installed here.
DO $install$
BEGIN
 IF to_regnamespace('crm_graph_candidate') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_graph_worker'
   AND rolsuper=false AND rolcreaterole=false AND rolcreatedb=false
   AND rolreplication=false AND rolbypassrls=false AND rolinherit=false)
  OR to_regclass('crm_graph_candidate.graph_worker_deployment_v1') IS NOT NULL
  OR to_regclass('crm_graph_candidate.graph_worker_lease_v1') IS NOT NULL
  OR to_regprocedure('crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text)') IS NOT NULL
  OR to_regprocedure('crm_graph_candidate.graph_worker_readiness_v1()') IS NOT NULL
  OR to_regprocedure('crm_graph_candidate.graph_worker_lease_status_v1()') IS NOT NULL THEN
  RAISE EXCEPTION 'GRAPH_WORKER_LEASE_DEPENDENCY_OR_COLLISION';
 END IF;
END $install$;

CREATE TABLE crm_graph_candidate.graph_worker_deployment_v1(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 worker_sha256 text CHECK(worker_sha256~'^[0-9a-f]{64}$'),
 runtime_sha256 text CHECK(runtime_sha256~'^[0-9a-f]{64}$'),
 database_role name,
 cache_target text CHECK(cache_target~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 cache_approval_sha256 text CHECK(cache_approval_sha256~'^[0-9a-f]{64}$'),
 topology_receipt_sha256 text CHECK(topology_receipt_sha256~'^[0-9a-f]{64}$'),
 approved_at timestamptz,
 approved_by text,
 CHECK(NOT enabled OR (worker_sha256 IS NOT NULL AND runtime_sha256 IS NOT NULL
  AND database_role='crm_graph_worker'::name AND cache_target IS NOT NULL AND cache_approval_sha256 IS NOT NULL
  AND topology_receipt_sha256 IS NOT NULL AND approved_at IS NOT NULL
  AND isfinite(approved_at) AND approved_by IS NOT NULL AND approved_by~'^admin:.{1,193}$'))
);
INSERT INTO crm_graph_candidate.graph_worker_deployment_v1(singleton) VALUES(true);

CREATE TABLE crm_graph_candidate.graph_worker_lease_v1(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 instance_id uuid NOT NULL,
 worker_sha256 text NOT NULL CHECK(worker_sha256~'^[0-9a-f]{64}$'),
 runtime_sha256 text NOT NULL CHECK(runtime_sha256~'^[0-9a-f]{64}$'),
 database_role name NOT NULL CHECK(database_role='crm_graph_worker'::name),
 heartbeat_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 suspended boolean NOT NULL DEFAULT false,
 suspension_reason text CHECK(suspension_reason IN('competing_instance','identity_changed','deployment_off')),
 CHECK(isfinite(heartbeat_at) AND isfinite(expires_at) AND expires_at>=heartbeat_at),
 CHECK(suspended=(suspension_reason IS NOT NULL))
);
REVOKE ALL ON crm_graph_candidate.graph_worker_deployment_v1,
 crm_graph_candidate.graph_worker_lease_v1 FROM PUBLIC;

CREATE FUNCTION crm_graph_candidate.graph_worker_heartbeat_v1(instance uuid,worker_sha text,runtime_sha text)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
#variable_conflict use_variable
DECLARE approved crm_graph_candidate.graph_worker_deployment_v1%ROWTYPE;
 lease crm_graph_candidate.graph_worker_lease_v1%ROWTYPE;at timestamptz;until_at timestamptz;
BEGIN
 IF session_user::name IS DISTINCT FROM 'crm_graph_worker'::name
  OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 10000) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='GRAPH_WORKER_LEASE_BOUNDARY';
 END IF;
 IF instance IS NULL OR instance='00000000-0000-0000-0000-000000000000'::uuid
  OR worker_sha IS NULL OR worker_sha!~'^[0-9a-f]{64}$'
  OR runtime_sha IS NULL OR runtime_sha!~'^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='GRAPH_WORKER_LEASE_INPUT';
 END IF;
 SELECT * INTO STRICT approved FROM crm_graph_candidate.graph_worker_deployment_v1 WHERE singleton FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-graph-worker-lease-v1',0));
 SELECT * INTO lease FROM crm_graph_candidate.graph_worker_lease_v1 WHERE singleton FOR UPDATE;
 at:=clock_timestamp();
 IF NOT approved.enabled OR approved.approved_at>at OR approved.database_role IS DISTINCT FROM session_user::name THEN
  IF lease.instance_id IS NOT NULL THEN
   UPDATE crm_graph_candidate.graph_worker_lease_v1 SET suspended=true,suspension_reason='deployment_off' WHERE singleton;
  END IF;
  RETURN jsonb_build_object('ready',false,'reason','deployment_unavailable','authorizes_activate',false);
 END IF;
 IF approved.worker_sha256 IS DISTINCT FROM worker_sha OR approved.runtime_sha256 IS DISTINCT FROM runtime_sha THEN
  IF lease.instance_id=instance THEN
   UPDATE crm_graph_candidate.graph_worker_lease_v1 SET suspended=true,suspension_reason='identity_changed' WHERE singleton;
  END IF;
  RETURN jsonb_build_object('ready',false,'reason','identity_unavailable','authorizes_activate',false);
 END IF;
 IF lease.suspended THEN
  RETURN jsonb_build_object('ready',false,'reason','lease_suspended','authorizes_activate',false);
 END IF;
 IF lease.instance_id IS NOT NULL AND lease.instance_id<>instance AND lease.expires_at>at THEN
  UPDATE crm_graph_candidate.graph_worker_lease_v1 SET suspended=true,suspension_reason='competing_instance' WHERE singleton;
  RETURN jsonb_build_object('ready',false,'reason','competing_instance','authorizes_activate',false);
 END IF;
 at:=clock_timestamp();until_at:=at+interval '60 seconds';
 INSERT INTO crm_graph_candidate.graph_worker_lease_v1(singleton,instance_id,worker_sha256,runtime_sha256,database_role,heartbeat_at,expires_at)
 VALUES(true,instance,worker_sha,runtime_sha,session_user::name,at,until_at)
 ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,worker_sha256=excluded.worker_sha256,
  runtime_sha256=excluded.runtime_sha256,database_role=excluded.database_role,
  heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at;
 RETURN jsonb_build_object('ready',true,'reason','executor_ready','checked_at',at,'expires_at',until_at,
  'authorizes_activate',false,'cache_identity_live_verified',false);
END $fn$;

-- Private readiness contract for a future API definer/review. Pins contain no
-- personal data or secrets. cache_approval_sha256 is explicitly administrative
-- evidence; it never means that the live physical cache binding was verified.
CREATE FUNCTION crm_graph_candidate.graph_worker_readiness_v1()
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE d crm_graph_candidate.graph_worker_deployment_v1%ROWTYPE;
 l crm_graph_candidate.graph_worker_lease_v1%ROWTYPE;at timestamptz;executor boolean;reason text;blockers jsonb;
BEGIN
 SELECT * INTO STRICT d FROM crm_graph_candidate.graph_worker_deployment_v1 WHERE singleton;
 SELECT * INTO l FROM crm_graph_candidate.graph_worker_lease_v1 WHERE singleton;at:=clock_timestamp();
 executor:=coalesce(d.enabled AND d.approved_at<=at AND NOT l.suspended AND l.heartbeat_at<=at AND l.expires_at>at
  AND l.worker_sha256=d.worker_sha256 AND l.runtime_sha256=d.runtime_sha256 AND l.database_role=d.database_role,false);
 reason:=CASE WHEN NOT d.enabled THEN 'deployment_off' WHEN d.approved_at>at THEN 'approval_not_current' WHEN l.instance_id IS NULL THEN 'lease_missing'
  WHEN l.suspended THEN coalesce(l.suspension_reason,'lease_suspended') WHEN l.expires_at<=at THEN 'lease_expired'
  WHEN l.heartbeat_at>at THEN 'lease_clock_invalid'
  WHEN l.worker_sha256 IS DISTINCT FROM d.worker_sha256 OR l.runtime_sha256 IS DISTINCT FROM d.runtime_sha256
   OR l.database_role IS DISTINCT FROM d.database_role THEN 'identity_changed' ELSE 'executor_ready' END;
 blockers:=jsonb_build_array(reason) || CASE WHEN d.cache_approval_sha256 IS NULL THEN jsonb_build_array('cache_approval_missing') ELSE '[]'::jsonb END
  || jsonb_build_array('cache_identity_live_unverified');
 IF executor THEN blockers:=blockers-'executor_ready';END IF;
 RETURN jsonb_build_object('contract','journey_graph_worker_readiness_v1','state',CASE WHEN executor THEN 'executor_ready' ELSE 'blocked' END,
  'blockers',blockers,'checked_at',l.heartbeat_at,'expires_at',l.expires_at,'activation_ready',false,'authorizes_activate',false,
  'pins',jsonb_build_object('deployment_worker_sha256',d.worker_sha256,'deployment_runtime_sha256',d.runtime_sha256,
   'deployment_database_role',d.database_role,'cache_target',d.cache_target,'cache_approval_sha256',d.cache_approval_sha256,
   'topology_receipt_sha256',d.topology_receipt_sha256,'lease_instance_id',l.instance_id,
   'lease_worker_sha256',l.worker_sha256,'lease_runtime_sha256',l.runtime_sha256,'lease_database_role',l.database_role,
   'cache_identity_live_verified',false));
END $fn$;

-- Aggregate read contract proposed for crm-audience. It deliberately exposes
-- neither hashes nor the process UUID and never treats administrative cache
-- approval as proof of a live physical cache binding.
CREATE FUNCTION crm_graph_candidate.graph_worker_lease_status_v1()
 RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object(
  'contract','journey_graph_worker_lease_status_v1',
  'deployment_enabled',d.enabled,
  'executor_ready',coalesce(d.enabled AND d.approved_at<=clock_timestamp() AND NOT l.suspended
   AND l.heartbeat_at<=clock_timestamp() AND l.expires_at>clock_timestamp()
   AND l.worker_sha256=d.worker_sha256 AND l.runtime_sha256=d.runtime_sha256
   AND l.database_role=d.database_role,false),
  'reason',CASE WHEN NOT d.enabled THEN 'deployment_off' WHEN d.approved_at>clock_timestamp() THEN 'approval_not_current' WHEN l.instance_id IS NULL THEN 'lease_missing'
   WHEN l.suspended THEN coalesce(l.suspension_reason,'lease_suspended')
   WHEN l.expires_at<=clock_timestamp() THEN 'lease_expired'
   WHEN l.heartbeat_at>clock_timestamp() THEN 'lease_clock_invalid'
   WHEN l.worker_sha256 IS DISTINCT FROM d.worker_sha256 OR l.runtime_sha256 IS DISTINCT FROM d.runtime_sha256
    OR l.database_role IS DISTINCT FROM d.database_role THEN 'identity_changed' ELSE 'executor_ready' END,
  'heartbeat_at',l.heartbeat_at,'expires_at',l.expires_at,
  'cache_approval_present',d.cache_approval_sha256 IS NOT NULL,
  'topology_approval_present',d.topology_receipt_sha256 IS NOT NULL,
  'cache_identity_live_verified',false,
  'activation_ready',false,'authorizes_activate',false)
 FROM crm_graph_candidate.graph_worker_deployment_v1 d
 LEFT JOIN crm_graph_candidate.graph_worker_lease_v1 l ON l.singleton
 WHERE d.singleton
$fn$;

REVOKE ALL ON FUNCTION crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text),
 crm_graph_candidate.graph_worker_readiness_v1(),
 crm_graph_candidate.graph_worker_lease_status_v1() FROM PUBLIC;
