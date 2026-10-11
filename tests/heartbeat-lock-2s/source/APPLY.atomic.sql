-- Root binds an authentic fresh admission separately. No actor/grant factory.
-- Expected full CURRENT function metadata is bound only in RAM by fixed $1 setter.
DO $heartbeat_lock_2s$
DECLARE e jsonb:=current_setting('shrigma.heartbeat_lock_2s_expected',true)::jsonb;
 before_metadata jsonb;after_metadata jsonb;target_metadata jsonb;configs jsonb;
BEGIN
 IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR e->>'schema' IS DISTINCT FROM 'heartbeat-lock-2s-expected-v1'
 OR e->>'stage' IS DISTINCT FROM 'apply' OR jsonb_typeof(e->'functionMetadata') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'HEARTBEAT_LOCK_FRESH_EXPECTATION_REQUIRED'; END IF;
 IF current_database()<>'listmonk' OR current_setting('server_version_num')<>'170010'
 OR session_user IS DISTINCT FROM current_user OR current_setting('TimeZone')<>'Etc/UTC'
 OR current_setting('transaction_isolation')<>'read committed'
 OR current_setting('statement_timeout')::interval<>interval '5 seconds'
 OR current_setting('lock_timeout')::interval<>interval '500 milliseconds' THEN
  RAISE EXCEPTION 'HEARTBEAT_LOCK_ORIGINAL_BOUNDARY_REFUSED'; END IF;
 SELECT to_jsonb(p) INTO before_metadata FROM pg_catalog.pg_proc p
  WHERE p.oid=pg_catalog.to_regprocedure('crm_audience_v2.regular_worker_heartbeat(uuid,text,text)');
 IF before_metadata IS NULL OR before_metadata IS DISTINCT FROM e->'functionMetadata' THEN
  RAISE EXCEPTION 'HEARTBEAT_LOCK_METADATA_DRIFT'; END IF;
 IF md5(before_metadata->>'prosrc')<>'985e4c706fd8eb9326414cbc0d1eb89c'
 OR octet_length(before_metadata->>'prosrc')<>4143
 OR before_metadata->>'prosecdef' IS DISTINCT FROM 'false'
 OR before_metadata->>'provolatile' IS DISTINCT FROM 'v'
 OR before_metadata->>'prorettype' IS DISTINCT FROM '3802'
 OR before_metadata->>'pronargs' IS DISTINCT FROM '3'
 OR jsonb_array_length(before_metadata->'proconfig')<>2
 OR NOT (before_metadata->'proconfig' @> '["search_path=pg_catalog","lock_timeout=500ms"]'::jsonb) THEN
  RAISE EXCEPTION 'HEARTBEAT_LOCK_SOURCE_OR_CONFIG_REFUSED'; END IF;
 ALTER FUNCTION crm_audience_v2.regular_worker_heartbeat(uuid,text,text) SET lock_timeout='2s';
 SELECT jsonb_agg(CASE WHEN v='lock_timeout=500ms' THEN 'lock_timeout=2s' ELSE v END ORDER BY ord)
  INTO configs FROM jsonb_array_elements_text(before_metadata->'proconfig') WITH ORDINALITY c(v,ord);
 target_metadata:=jsonb_set(before_metadata,'{proconfig}',configs);
 SELECT to_jsonb(p) INTO after_metadata FROM pg_catalog.pg_proc p
  WHERE p.oid=pg_catalog.to_regprocedure('crm_audience_v2.regular_worker_heartbeat(uuid,text,text)');
 IF after_metadata IS DISTINCT FROM target_metadata THEN RAISE EXCEPTION 'HEARTBEAT_LOCK_AFTER_METADATA_DRIFT'; END IF;
END $heartbeat_lock_2s$;
