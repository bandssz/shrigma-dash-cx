-- Narrow runtime access for the already-installed graph worker lease boundary.
-- This migration does not enable the graph, approve a worker, create a lease or
-- expose private readiness. It is deliberately one-shot: the pre-install ACL
-- is part of the guarded base and a replay is rejected.
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '20s';

DO $install$
DECLARE
 heartbeat regprocedure := to_regprocedure('crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text)');
 status regprocedure := to_regprocedure('crm_graph_candidate.graph_worker_lease_status_v1()');
 readiness regprocedure := to_regprocedure('crm_graph_candidate.graph_worker_readiness_v1()');
BEGIN
 IF current_user IS DISTINCT FROM 'postgres' OR session_user IS DISTINCT FROM 'postgres'
  OR current_setting('server_version_num')::integer IS DISTINCT FROM 170010 THEN
  RAISE EXCEPTION 'GRAPH_WORKER_RUNTIME_ACCESS_CONTEXT';
 END IF;
 IF to_regnamespace('crm_graph_candidate') IS NULL
  OR to_regclass('crm_graph_candidate.control') IS NULL
  OR to_regclass('crm_graph_candidate.graph_worker_deployment_v1') IS NULL
  OR to_regclass('crm_graph_candidate.graph_worker_lease_v1') IS NULL
  OR heartbeat IS NULL OR status IS NULL OR readiness IS NULL THEN
  RAISE EXCEPTION 'GRAPH_WORKER_RUNTIME_ACCESS_PREREQUISITE';
 END IF;
 LOCK TABLE crm_graph_candidate.control,
  crm_graph_candidate.graph_worker_deployment_v1,
  crm_graph_candidate.graph_worker_lease_v1 IN SHARE ROW EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_graph_worker'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_audience_api'
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls)
  OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid
    WHERE r.rolname IN('crm_graph_worker','crm_audience_api')) THEN
  RAISE EXCEPTION 'GRAPH_WORKER_RUNTIME_ACCESS_ROLE';
 END IF;
 IF has_schema_privilege('public','crm_graph_candidate','USAGE')
  OR NOT has_schema_privilege('crm_graph_worker','crm_graph_candidate','USAGE')
  OR NOT has_schema_privilege('crm_audience_api','crm_graph_candidate','USAGE') THEN
  RAISE EXCEPTION 'GRAPH_WORKER_RUNTIME_ACCESS_SCHEMA';
 END IF;
 IF (SELECT count(*) FROM crm_graph_candidate.control WHERE singleton AND NOT enabled) IS DISTINCT FROM 1::bigint
  OR (SELECT count(*) FROM crm_graph_candidate.control) IS DISTINCT FROM 1::bigint
  OR (SELECT count(*) FROM crm_graph_candidate.graph_worker_deployment_v1 WHERE singleton AND NOT enabled
       AND worker_sha256 IS NULL AND runtime_sha256 IS NULL AND database_role IS NULL
       AND cache_target IS NULL AND cache_approval_sha256 IS NULL AND topology_receipt_sha256 IS NULL
       AND approved_at IS NULL AND approved_by IS NULL) IS DISTINCT FROM 1::bigint
  OR (SELECT count(*) FROM crm_graph_candidate.graph_worker_deployment_v1) IS DISTINCT FROM 1::bigint
  OR EXISTS(SELECT 1 FROM crm_graph_candidate.graph_worker_lease_v1) THEN
  RAISE EXCEPTION 'GRAPH_WORKER_RUNTIME_ACCESS_NOT_OFF';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=heartbeat) IS DISTINCT FROM '46a22d18750b78127edaa24aa628e082'
  OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid=heartbeat) IS DISTINCT FROM 'f1e59da2ebbe0f4b142a8dba34495556'
  OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=heartbeat) IS DISTINCT FROM 'postgres'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=status) IS DISTINCT FROM 'e500af476a5ecda9e5d910f507ab4707'
  OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid=status) IS DISTINCT FROM '6f2ee040a36f47c9c8a4e966f66ddd32'
  OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=status) IS DISTINCT FROM 'postgres'
  OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=readiness) IS DISTINCT FROM 'postgres' THEN
  RAISE EXCEPTION 'GRAPH_WORKER_RUNTIME_ACCESS_BASE_DRIFT';
 END IF;
 IF has_function_privilege('public',heartbeat,'EXECUTE')
  OR has_function_privilege('public',status,'EXECUTE')
  OR has_function_privilege('public',readiness,'EXECUTE')
  OR has_function_privilege('crm_graph_worker',heartbeat,'EXECUTE')
  OR has_function_privilege('crm_graph_worker',status,'EXECUTE')
  OR has_function_privilege('crm_graph_worker',readiness,'EXECUTE')
  OR has_function_privilege('crm_audience_api',heartbeat,'EXECUTE')
  OR has_function_privilege('crm_audience_api',status,'EXECUTE')
  OR has_function_privilege('crm_audience_api',readiness,'EXECUTE')
  OR (SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid IN(heartbeat,status,readiness) AND a.privilege_type='EXECUTE') IS DISTINCT FROM 3::bigint THEN
  RAISE EXCEPTION 'GRAPH_WORKER_RUNTIME_ACCESS_ACL_DRIFT';
 END IF;
END $install$;

GRANT EXECUTE ON FUNCTION crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text) TO crm_graph_worker;
GRANT EXECUTE ON FUNCTION crm_graph_candidate.graph_worker_lease_status_v1() TO crm_audience_api;

DO $verify$
DECLARE
 heartbeat regprocedure := 'crm_graph_candidate.graph_worker_heartbeat_v1(uuid,text,text)'::regprocedure;
 status regprocedure := 'crm_graph_candidate.graph_worker_lease_status_v1()'::regprocedure;
 readiness regprocedure := 'crm_graph_candidate.graph_worker_readiness_v1()'::regprocedure;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=heartbeat) IS DISTINCT FROM '46a22d18750b78127edaa24aa628e082'
  OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid=heartbeat) IS DISTINCT FROM 'f1e59da2ebbe0f4b142a8dba34495556'
  OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=heartbeat) IS DISTINCT FROM 'postgres'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=status) IS DISTINCT FROM 'e500af476a5ecda9e5d910f507ab4707'
  OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid=status) IS DISTINCT FROM '6f2ee040a36f47c9c8a4e966f66ddd32'
  OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=status) IS DISTINCT FROM 'postgres'
  OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=readiness) IS DISTINCT FROM 'postgres'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_graph_worker'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_audience_api'
    AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls)
  OR has_schema_privilege('public','crm_graph_candidate','USAGE')
  OR NOT has_schema_privilege('crm_graph_worker','crm_graph_candidate','USAGE')
  OR NOT has_schema_privilege('crm_audience_api','crm_graph_candidate','USAGE')
  OR has_function_privilege('public',heartbeat,'EXECUTE')
  OR has_function_privilege('public',status,'EXECUTE')
  OR has_function_privilege('public',readiness,'EXECUTE')
  OR NOT has_function_privilege('crm_graph_worker',heartbeat,'EXECUTE')
  OR has_function_privilege('crm_graph_worker',status,'EXECUTE')
  OR has_function_privilege('crm_graph_worker',readiness,'EXECUTE')
  OR has_function_privilege('crm_audience_api',heartbeat,'EXECUTE')
  OR NOT has_function_privilege('crm_audience_api',status,'EXECUTE')
  OR has_function_privilege('crm_audience_api',readiness,'EXECUTE')
  OR (SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid IN(heartbeat,status,readiness) AND a.privilege_type='EXECUTE') IS DISTINCT FROM 5::bigint
  OR (SELECT count(*) FROM crm_graph_candidate.control WHERE singleton AND NOT enabled) IS DISTINCT FROM 1::bigint
  OR (SELECT count(*) FROM crm_graph_candidate.graph_worker_deployment_v1 WHERE singleton AND NOT enabled
       AND worker_sha256 IS NULL AND runtime_sha256 IS NULL AND database_role IS NULL
       AND cache_target IS NULL AND cache_approval_sha256 IS NULL AND topology_receipt_sha256 IS NULL
       AND approved_at IS NULL AND approved_by IS NULL) IS DISTINCT FROM 1::bigint
  OR EXISTS(SELECT 1 FROM crm_graph_candidate.graph_worker_lease_v1) THEN
  RAISE EXCEPTION 'GRAPH_WORKER_RUNTIME_ACCESS_AFTER_DRIFT';
 END IF;
END $verify$;
COMMIT;
