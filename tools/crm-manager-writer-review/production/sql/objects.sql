-- Catalog-only bounded observation. No credential/verifier/value is selected.
SELECT
 current_database()='listmonk' AND current_user='postgres' AND session_user='postgres'
 AND current_setting('server_version_num')::int/10000=17 AS context_verified,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'crm_manager_writer_%' AND c.relkind IN ('r','p','v','m','S','f')) AS tables,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'crm_manager_writer_%') AS relations,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i' AND c.relname IN ('crm_manager_writer_one_prepared_v1','crm_manager_writer_one_active_v1')) AS indexes,
 (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'crm_manager_writer_%') AS functions,
 (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND (t.typname LIKE 'crm_manager_writer_%' OR t.typname LIKE '_crm_manager_writer_%')) AS types,
 (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')) AS roles,
 (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1') AND NOT rolcanlogin) AS no_login_roles,
 (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1') AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=CASE rolname WHEN 'crm_manager_writer_service_v1' THEN 2 ELSE -1 END) AS restricted_roles,
 (SELECT count(*)::int FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')) OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1'))) AS membership_edges,
 (SELECT count(*)::int FROM pg_authid WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1') AND rolpassword IS NOT NULL) AS passworded_roles;
