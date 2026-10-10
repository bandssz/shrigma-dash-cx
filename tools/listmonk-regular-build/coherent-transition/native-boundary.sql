DO $native_transition_boundary$
BEGIN
 IF current_setting('server_version_num')::integer<>170010
 OR current_user<>'postgres' OR session_user<>'postgres'
 OR current_setting('transaction_isolation')<>'read committed'
 OR current_setting('statement_timeout')<>'5s' OR current_setting('lock_timeout')<>'500ms' THEN
  RAISE EXCEPTION 'COHERENT_TRANSITION_NATIVE_BOUNDARY_REQUIRED';
 END IF;
END $native_transition_boundary$;
