-- Catalog-only second audit: primitive classification of effective extra EXECUTE grants.
-- Fixed outputs only; no unknown function/extension/owner/language names are returned.
-- No prosrc/function bodies, keys, business rows, application calls, DDL or grant changes.
-- Extension membership, volatility and invoker flags do NOT prove semantic read-only behavior.
-- The first audit's count 71 is a comparison, not an admission rule or assumption.
\set ON_ERROR_STOP on
\pset pager off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL search_path TO pg_catalog;
SET LOCAL statement_timeout TO '5s';
SET LOCAL lock_timeout TO '250ms';
SET LOCAL idle_in_transaction_session_timeout TO '15s';
SELECT current_database()='listmonk'
 AND current_user='postgres' AND session_user='postgres'
 AND current_setting('transaction_read_only')='on' AS catalog_audit_target_ok
\gset
\if :catalog_audit_target_ok
\else
\quit 7
\endif

WITH role_context AS (
 SELECT r.oid AS reader_oid FROM pg_catalog.pg_roles r WHERE r.rolname='crm_panel_reader'
), extra AS (
 SELECT p.oid,p.proname,p.prosecdef,p.provolatile,p.proowner,p.prokind,
        l.lanname,n.nspname,r.reader_oid,
        ext.extension_memberships,ext.extension_name,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 CROSS JOIN role_context r
 LEFT JOIN LATERAL (
   SELECT count(DISTINCT e.oid)::integer AS extension_memberships,min(e.extname) AS extension_name
   FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
 ) ext ON true
 WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
   AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
   AND pg_catalog.has_function_privilege(r.reader_oid,p.oid,'EXECUTE')
), classified AS (
 SELECT extra.*,
   CASE WHEN extension_memberships=0 THEN 'non_extension'
        WHEN extension_memberships<>1 THEN 'extension_ambiguous'
        WHEN extension_name IN ('vector','pgcrypto','plpgsql','uuid-ossp','pg_trgm','citext','hstore','btree_gin','btree_gist')
          THEN 'extension_'||replace(extension_name,'-','_')
        ELSE 'extension_unknown' END AS extension_bucket,
   CASE WHEN prosecdef THEN 'extra_security_definer' ELSE 'extra_security_invoker' END AS security_bucket,
   CASE provolatile WHEN 'i' THEN 'extra_immutable' WHEN 's' THEN 'extra_stable' WHEN 'v' THEN 'extra_volatile' ELSE 'extra_volatility_unknown' END AS volatility_bucket,
   CASE WHEN extension_memberships=0 AND left(proname,8)='shrigma_' THEN 'non_extension_shrigma'
        WHEN extension_memberships=0 THEN 'non_extension_other'
        WHEN left(proname,8)='shrigma_' THEN 'extension_shrigma' ELSE 'extension_other' END AS prefix_bucket,
   CASE WHEN proowner=pg_catalog.to_regrole('postgres')::oid THEN 'owner_postgres'
        WHEN proowner=reader_oid THEN 'owner_reader' ELSE 'owner_other' END AS owner_bucket,
   CASE lanname WHEN 'c' THEN 'language_c' WHEN 'sql' THEN 'language_sql' WHEN 'plpgsql' THEN 'language_plpgsql' ELSE 'language_other' END AS language_bucket
 FROM extra
)
SELECT pg_catalog.jsonb_build_object('section','baseline','rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(classification_row)),'[]'::jsonb)) FROM (
SELECT 'crm_panel_reader_extra_classification' AS alvo,
 EXISTS(SELECT 1 FROM role_context) AS reader_exists,
 pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)') IS NOT NULL AS dedicated_reader_function_exists,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*)=71 FROM classified) END AS same_count_as_first_audit,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN pg_catalog.has_database_privilege((SELECT reader_oid FROM role_context),current_database(),'TEMP') END AS reader_temp_capability,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified) END AS extra_count
) classification_row;

WITH role_context AS (
 SELECT r.oid AS reader_oid FROM pg_catalog.pg_roles r WHERE r.rolname='crm_panel_reader'
), extra AS (
 SELECT p.oid,p.proname,p.prosecdef,p.provolatile,p.proowner,p.prokind,
        l.lanname,n.nspname,r.reader_oid,
        ext.extension_memberships,ext.extension_name,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 CROSS JOIN role_context r
 LEFT JOIN LATERAL (
   SELECT count(DISTINCT e.oid)::integer AS extension_memberships,min(e.extname) AS extension_name
   FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
 ) ext ON true
 WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
   AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
   AND pg_catalog.has_function_privilege(r.reader_oid,p.oid,'EXECUTE')
), classified AS (
 SELECT extra.*,
   CASE WHEN extension_memberships=0 THEN 'non_extension'
        WHEN extension_memberships<>1 THEN 'extension_ambiguous'
        WHEN extension_name IN ('vector','pgcrypto','plpgsql','uuid-ossp','pg_trgm','citext','hstore','btree_gin','btree_gist')
          THEN 'extension_'||replace(extension_name,'-','_')
        ELSE 'extension_unknown' END AS extension_bucket,
   CASE WHEN prosecdef THEN 'extra_security_definer' ELSE 'extra_security_invoker' END AS security_bucket,
   CASE provolatile WHEN 'i' THEN 'extra_immutable' WHEN 's' THEN 'extra_stable' WHEN 'v' THEN 'extra_volatile' ELSE 'extra_volatility_unknown' END AS volatility_bucket,
   CASE WHEN extension_memberships=0 AND left(proname,8)='shrigma_' THEN 'non_extension_shrigma'
        WHEN extension_memberships=0 THEN 'non_extension_other'
        WHEN left(proname,8)='shrigma_' THEN 'extension_shrigma' ELSE 'extension_other' END AS prefix_bucket,
   CASE WHEN proowner=pg_catalog.to_regrole('postgres')::oid THEN 'owner_postgres'
        WHEN proowner=reader_oid THEN 'owner_reader' ELSE 'owner_other' END AS owner_bucket,
   CASE lanname WHEN 'c' THEN 'language_c' WHEN 'sql' THEN 'language_sql' WHEN 'plpgsql' THEN 'language_plpgsql' ELSE 'language_other' END AS language_bucket
 FROM extra
)
SELECT pg_catalog.jsonb_build_object('section','extension_registry','rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(classification_row)),'[]'::jsonb)) FROM (
SELECT e.alvo,
 CASE WHEN e.extname IS NOT NULL THEN EXISTS(SELECT 1 FROM pg_catalog.pg_extension x WHERE x.extname=e.extname) END AS extension_installed,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (true)) END AS extra_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.prosecdef)) END AS security_definer_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (NOT c.prosecdef)) END AS invoker_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.provolatile='v')) END AS volatile_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.provolatile='i')) END AS immutable_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.provolatile='s')) END AS stable_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.owner_bucket='owner_postgres')) END AS postgres_owner_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.owner_bucket<>'owner_postgres')) END AS non_postgres_owner_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.public_execute)) END AS public_execute_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.language_bucket='language_c')) END AS c_language_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.language_bucket='language_sql')) END AS sql_language_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.language_bucket='language_plpgsql')) END AS plpgsql_language_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.extension_bucket=e.alvo AND (c.language_bucket='language_other')) END AS other_language_count
FROM (VALUES (1,'extension_vector','vector'),
 (2,'extension_pgcrypto','pgcrypto'),
 (3,'extension_plpgsql','plpgsql'),
 (4,'extension_uuid_ossp','uuid-ossp'),
 (5,'extension_pg_trgm','pg_trgm'),
 (6,'extension_citext','citext'),
 (7,'extension_hstore','hstore'),
 (8,'extension_btree_gin','btree_gin'),
 (9,'extension_btree_gist','btree_gist'),
 (10,'extension_unknown',NULL::text),
 (11,'extension_ambiguous',NULL::text),
 (12,'non_extension',NULL::text)) e(ord,alvo,extname) ORDER BY e.ord
) classification_row;

WITH role_context AS (
 SELECT r.oid AS reader_oid FROM pg_catalog.pg_roles r WHERE r.rolname='crm_panel_reader'
), extra AS (
 SELECT p.oid,p.proname,p.prosecdef,p.provolatile,p.proowner,p.prokind,
        l.lanname,n.nspname,r.reader_oid,
        ext.extension_memberships,ext.extension_name,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 CROSS JOIN role_context r
 LEFT JOIN LATERAL (
   SELECT count(DISTINCT e.oid)::integer AS extension_memberships,min(e.extname) AS extension_name
   FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
 ) ext ON true
 WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
   AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
   AND pg_catalog.has_function_privilege(r.reader_oid,p.oid,'EXECUTE')
), classified AS (
 SELECT extra.*,
   CASE WHEN extension_memberships=0 THEN 'non_extension'
        WHEN extension_memberships<>1 THEN 'extension_ambiguous'
        WHEN extension_name IN ('vector','pgcrypto','plpgsql','uuid-ossp','pg_trgm','citext','hstore','btree_gin','btree_gist')
          THEN 'extension_'||replace(extension_name,'-','_')
        ELSE 'extension_unknown' END AS extension_bucket,
   CASE WHEN prosecdef THEN 'extra_security_definer' ELSE 'extra_security_invoker' END AS security_bucket,
   CASE provolatile WHEN 'i' THEN 'extra_immutable' WHEN 's' THEN 'extra_stable' WHEN 'v' THEN 'extra_volatile' ELSE 'extra_volatility_unknown' END AS volatility_bucket,
   CASE WHEN extension_memberships=0 AND left(proname,8)='shrigma_' THEN 'non_extension_shrigma'
        WHEN extension_memberships=0 THEN 'non_extension_other'
        WHEN left(proname,8)='shrigma_' THEN 'extension_shrigma' ELSE 'extension_other' END AS prefix_bucket,
   CASE WHEN proowner=pg_catalog.to_regrole('postgres')::oid THEN 'owner_postgres'
        WHEN proowner=reader_oid THEN 'owner_reader' ELSE 'owner_other' END AS owner_bucket,
   CASE lanname WHEN 'c' THEN 'language_c' WHEN 'sql' THEN 'language_sql' WHEN 'plpgsql' THEN 'language_plpgsql' ELSE 'language_other' END AS language_bucket
 FROM extra
)
SELECT pg_catalog.jsonb_build_object('section','security_modes','rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(classification_row)),'[]'::jsonb)) FROM (
SELECT e.alvo,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.security_bucket=e.alvo AND (true)) END AS extra_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.security_bucket=e.alvo AND (c.public_execute)) END AS public_execute_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.security_bucket=e.alvo AND (c.provolatile='v')) END AS volatile_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.security_bucket=e.alvo AND (c.owner_bucket='owner_postgres')) END AS postgres_owner_count
FROM (VALUES (1,'extra_security_definer'), (2,'extra_security_invoker')) e(ord,alvo) ORDER BY e.ord
) classification_row;

WITH role_context AS (
 SELECT r.oid AS reader_oid FROM pg_catalog.pg_roles r WHERE r.rolname='crm_panel_reader'
), extra AS (
 SELECT p.oid,p.proname,p.prosecdef,p.provolatile,p.proowner,p.prokind,
        l.lanname,n.nspname,r.reader_oid,
        ext.extension_memberships,ext.extension_name,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 CROSS JOIN role_context r
 LEFT JOIN LATERAL (
   SELECT count(DISTINCT e.oid)::integer AS extension_memberships,min(e.extname) AS extension_name
   FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
 ) ext ON true
 WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
   AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
   AND pg_catalog.has_function_privilege(r.reader_oid,p.oid,'EXECUTE')
), classified AS (
 SELECT extra.*,
   CASE WHEN extension_memberships=0 THEN 'non_extension'
        WHEN extension_memberships<>1 THEN 'extension_ambiguous'
        WHEN extension_name IN ('vector','pgcrypto','plpgsql','uuid-ossp','pg_trgm','citext','hstore','btree_gin','btree_gist')
          THEN 'extension_'||replace(extension_name,'-','_')
        ELSE 'extension_unknown' END AS extension_bucket,
   CASE WHEN prosecdef THEN 'extra_security_definer' ELSE 'extra_security_invoker' END AS security_bucket,
   CASE provolatile WHEN 'i' THEN 'extra_immutable' WHEN 's' THEN 'extra_stable' WHEN 'v' THEN 'extra_volatile' ELSE 'extra_volatility_unknown' END AS volatility_bucket,
   CASE WHEN extension_memberships=0 AND left(proname,8)='shrigma_' THEN 'non_extension_shrigma'
        WHEN extension_memberships=0 THEN 'non_extension_other'
        WHEN left(proname,8)='shrigma_' THEN 'extension_shrigma' ELSE 'extension_other' END AS prefix_bucket,
   CASE WHEN proowner=pg_catalog.to_regrole('postgres')::oid THEN 'owner_postgres'
        WHEN proowner=reader_oid THEN 'owner_reader' ELSE 'owner_other' END AS owner_bucket,
   CASE lanname WHEN 'c' THEN 'language_c' WHEN 'sql' THEN 'language_sql' WHEN 'plpgsql' THEN 'language_plpgsql' ELSE 'language_other' END AS language_bucket
 FROM extra
)
SELECT pg_catalog.jsonb_build_object('section','volatility','rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(classification_row)),'[]'::jsonb)) FROM (
SELECT e.alvo,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.volatility_bucket=e.alvo AND (true)) END AS extra_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.volatility_bucket=e.alvo AND (c.prosecdef)) END AS security_definer_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.volatility_bucket=e.alvo AND (c.public_execute)) END AS public_execute_count
FROM (VALUES (1,'extra_immutable'), (2,'extra_stable'), (3,'extra_volatile'), (4,'extra_volatility_unknown')) e(ord,alvo) ORDER BY e.ord
) classification_row;

WITH role_context AS (
 SELECT r.oid AS reader_oid FROM pg_catalog.pg_roles r WHERE r.rolname='crm_panel_reader'
), extra AS (
 SELECT p.oid,p.proname,p.prosecdef,p.provolatile,p.proowner,p.prokind,
        l.lanname,n.nspname,r.reader_oid,
        ext.extension_memberships,ext.extension_name,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 CROSS JOIN role_context r
 LEFT JOIN LATERAL (
   SELECT count(DISTINCT e.oid)::integer AS extension_memberships,min(e.extname) AS extension_name
   FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
 ) ext ON true
 WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
   AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
   AND pg_catalog.has_function_privilege(r.reader_oid,p.oid,'EXECUTE')
), classified AS (
 SELECT extra.*,
   CASE WHEN extension_memberships=0 THEN 'non_extension'
        WHEN extension_memberships<>1 THEN 'extension_ambiguous'
        WHEN extension_name IN ('vector','pgcrypto','plpgsql','uuid-ossp','pg_trgm','citext','hstore','btree_gin','btree_gist')
          THEN 'extension_'||replace(extension_name,'-','_')
        ELSE 'extension_unknown' END AS extension_bucket,
   CASE WHEN prosecdef THEN 'extra_security_definer' ELSE 'extra_security_invoker' END AS security_bucket,
   CASE provolatile WHEN 'i' THEN 'extra_immutable' WHEN 's' THEN 'extra_stable' WHEN 'v' THEN 'extra_volatile' ELSE 'extra_volatility_unknown' END AS volatility_bucket,
   CASE WHEN extension_memberships=0 AND left(proname,8)='shrigma_' THEN 'non_extension_shrigma'
        WHEN extension_memberships=0 THEN 'non_extension_other'
        WHEN left(proname,8)='shrigma_' THEN 'extension_shrigma' ELSE 'extension_other' END AS prefix_bucket,
   CASE WHEN proowner=pg_catalog.to_regrole('postgres')::oid THEN 'owner_postgres'
        WHEN proowner=reader_oid THEN 'owner_reader' ELSE 'owner_other' END AS owner_bucket,
   CASE lanname WHEN 'c' THEN 'language_c' WHEN 'sql' THEN 'language_sql' WHEN 'plpgsql' THEN 'language_plpgsql' ELSE 'language_other' END AS language_bucket
 FROM extra
)
SELECT pg_catalog.jsonb_build_object('section','application_prefix','rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(classification_row)),'[]'::jsonb)) FROM (
SELECT e.alvo,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.prefix_bucket=e.alvo AND (true)) END AS extra_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.prefix_bucket=e.alvo AND (c.prosecdef)) END AS security_definer_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.prefix_bucket=e.alvo AND (c.provolatile='v')) END AS volatile_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.prefix_bucket=e.alvo AND (c.public_execute)) END AS public_execute_count
FROM (VALUES (1,'non_extension_shrigma'), (2,'non_extension_other'), (3,'extension_shrigma'), (4,'extension_other')) e(ord,alvo) ORDER BY e.ord
) classification_row;

WITH role_context AS (
 SELECT r.oid AS reader_oid FROM pg_catalog.pg_roles r WHERE r.rolname='crm_panel_reader'
), extra AS (
 SELECT p.oid,p.proname,p.prosecdef,p.provolatile,p.proowner,p.prokind,
        l.lanname,n.nspname,r.reader_oid,
        ext.extension_memberships,ext.extension_name,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 CROSS JOIN role_context r
 LEFT JOIN LATERAL (
   SELECT count(DISTINCT e.oid)::integer AS extension_memberships,min(e.extname) AS extension_name
   FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
 ) ext ON true
 WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
   AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
   AND pg_catalog.has_function_privilege(r.reader_oid,p.oid,'EXECUTE')
), classified AS (
 SELECT extra.*,
   CASE WHEN extension_memberships=0 THEN 'non_extension'
        WHEN extension_memberships<>1 THEN 'extension_ambiguous'
        WHEN extension_name IN ('vector','pgcrypto','plpgsql','uuid-ossp','pg_trgm','citext','hstore','btree_gin','btree_gist')
          THEN 'extension_'||replace(extension_name,'-','_')
        ELSE 'extension_unknown' END AS extension_bucket,
   CASE WHEN prosecdef THEN 'extra_security_definer' ELSE 'extra_security_invoker' END AS security_bucket,
   CASE provolatile WHEN 'i' THEN 'extra_immutable' WHEN 's' THEN 'extra_stable' WHEN 'v' THEN 'extra_volatile' ELSE 'extra_volatility_unknown' END AS volatility_bucket,
   CASE WHEN extension_memberships=0 AND left(proname,8)='shrigma_' THEN 'non_extension_shrigma'
        WHEN extension_memberships=0 THEN 'non_extension_other'
        WHEN left(proname,8)='shrigma_' THEN 'extension_shrigma' ELSE 'extension_other' END AS prefix_bucket,
   CASE WHEN proowner=pg_catalog.to_regrole('postgres')::oid THEN 'owner_postgres'
        WHEN proowner=reader_oid THEN 'owner_reader' ELSE 'owner_other' END AS owner_bucket,
   CASE lanname WHEN 'c' THEN 'language_c' WHEN 'sql' THEN 'language_sql' WHEN 'plpgsql' THEN 'language_plpgsql' ELSE 'language_other' END AS language_bucket
 FROM extra
)
SELECT pg_catalog.jsonb_build_object('section','owners','rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(classification_row)),'[]'::jsonb)) FROM (
SELECT e.alvo,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.owner_bucket=e.alvo AND (true)) END AS extra_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.owner_bucket=e.alvo AND (c.prosecdef)) END AS security_definer_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.owner_bucket=e.alvo AND (c.public_execute)) END AS public_execute_count
FROM (VALUES (1,'owner_postgres'), (2,'owner_reader'), (3,'owner_other')) e(ord,alvo) ORDER BY e.ord
) classification_row;

WITH role_context AS (
 SELECT r.oid AS reader_oid FROM pg_catalog.pg_roles r WHERE r.rolname='crm_panel_reader'
), extra AS (
 SELECT p.oid,p.proname,p.prosecdef,p.provolatile,p.proowner,p.prokind,
        l.lanname,n.nspname,r.reader_oid,
        ext.extension_memberships,ext.extension_name,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 CROSS JOIN role_context r
 LEFT JOIN LATERAL (
   SELECT count(DISTINCT e.oid)::integer AS extension_memberships,min(e.extname) AS extension_name
   FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
 ) ext ON true
 WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
   AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
   AND pg_catalog.has_function_privilege(r.reader_oid,p.oid,'EXECUTE')
), classified AS (
 SELECT extra.*,
   CASE WHEN extension_memberships=0 THEN 'non_extension'
        WHEN extension_memberships<>1 THEN 'extension_ambiguous'
        WHEN extension_name IN ('vector','pgcrypto','plpgsql','uuid-ossp','pg_trgm','citext','hstore','btree_gin','btree_gist')
          THEN 'extension_'||replace(extension_name,'-','_')
        ELSE 'extension_unknown' END AS extension_bucket,
   CASE WHEN prosecdef THEN 'extra_security_definer' ELSE 'extra_security_invoker' END AS security_bucket,
   CASE provolatile WHEN 'i' THEN 'extra_immutable' WHEN 's' THEN 'extra_stable' WHEN 'v' THEN 'extra_volatile' ELSE 'extra_volatility_unknown' END AS volatility_bucket,
   CASE WHEN extension_memberships=0 AND left(proname,8)='shrigma_' THEN 'non_extension_shrigma'
        WHEN extension_memberships=0 THEN 'non_extension_other'
        WHEN left(proname,8)='shrigma_' THEN 'extension_shrigma' ELSE 'extension_other' END AS prefix_bucket,
   CASE WHEN proowner=pg_catalog.to_regrole('postgres')::oid THEN 'owner_postgres'
        WHEN proowner=reader_oid THEN 'owner_reader' ELSE 'owner_other' END AS owner_bucket,
   CASE lanname WHEN 'c' THEN 'language_c' WHEN 'sql' THEN 'language_sql' WHEN 'plpgsql' THEN 'language_plpgsql' ELSE 'language_other' END AS language_bucket
 FROM extra
)
SELECT pg_catalog.jsonb_build_object('section','languages','rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(classification_row)),'[]'::jsonb)) FROM (
SELECT e.alvo,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.language_bucket=e.alvo AND (true)) END AS extra_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.language_bucket=e.alvo AND (c.prosecdef)) END AS security_definer_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.language_bucket=e.alvo AND (c.provolatile='v')) END AS volatile_count,
 CASE WHEN EXISTS(SELECT 1 FROM role_context) THEN (SELECT count(*) FROM classified c WHERE c.language_bucket=e.alvo AND (c.public_execute)) END AS public_execute_count
FROM (VALUES (1,'language_c'), (2,'language_sql'), (3,'language_plpgsql'), (4,'language_other')) e(ord,alvo) ORDER BY e.ord
) classification_row;

WITH role_context AS (
 SELECT r.oid AS reader_oid FROM pg_catalog.pg_roles r WHERE r.rolname='crm_panel_reader'
), extra AS (
 SELECT p.oid,p.proname,p.prosecdef,p.provolatile,p.proowner,p.prokind,
        l.lanname,n.nspname,r.reader_oid,
        ext.extension_memberships,ext.extension_name,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 CROSS JOIN role_context r
 LEFT JOIN LATERAL (
   SELECT count(DISTINCT e.oid)::integer AS extension_memberships,min(e.extname) AS extension_name
   FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0
     AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
 ) ext ON true
 WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
   AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
   AND pg_catalog.has_function_privilege(r.reader_oid,p.oid,'EXECUTE')
), classified AS (
 SELECT extra.*,
   CASE WHEN extension_memberships=0 THEN 'non_extension'
        WHEN extension_memberships<>1 THEN 'extension_ambiguous'
        WHEN extension_name IN ('vector','pgcrypto','plpgsql','uuid-ossp','pg_trgm','citext','hstore','btree_gin','btree_gist')
          THEN 'extension_'||replace(extension_name,'-','_')
        ELSE 'extension_unknown' END AS extension_bucket,
   CASE WHEN prosecdef THEN 'extra_security_definer' ELSE 'extra_security_invoker' END AS security_bucket,
   CASE provolatile WHEN 'i' THEN 'extra_immutable' WHEN 's' THEN 'extra_stable' WHEN 'v' THEN 'extra_volatile' ELSE 'extra_volatility_unknown' END AS volatility_bucket,
   CASE WHEN extension_memberships=0 AND left(proname,8)='shrigma_' THEN 'non_extension_shrigma'
        WHEN extension_memberships=0 THEN 'non_extension_other'
        WHEN left(proname,8)='shrigma_' THEN 'extension_shrigma' ELSE 'extension_other' END AS prefix_bucket,
   CASE WHEN proowner=pg_catalog.to_regrole('postgres')::oid THEN 'owner_postgres'
        WHEN proowner=reader_oid THEN 'owner_reader' ELSE 'owner_other' END AS owner_bucket,
   CASE lanname WHEN 'c' THEN 'language_c' WHEN 'sql' THEN 'language_sql' WHEN 'plpgsql' THEN 'language_plpgsql' ELSE 'language_other' END AS language_bucket
 FROM extra
)
SELECT pg_catalog.jsonb_build_object('section','known_signatures','rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(classification_row)),'[]'::jsonb)) FROM (
SELECT e.assinatura AS alvo,p.oid IS NOT NULL AS existe,
 CASE WHEN p.oid IS NOT NULL AND EXISTS(SELECT 1 FROM role_context) THEN pg_catalog.has_function_privilege((SELECT reader_oid FROM role_context),p.oid,'EXECUTE') END AS reader_pode_executar,
 CASE WHEN p.oid IS NOT NULL AND EXISTS(SELECT 1 FROM role_context) THEN EXISTS(SELECT 1 FROM classified c WHERE c.oid=p.oid) END AS included_in_extra,
 CASE WHEN p.oid IS NOT NULL THEN p.prosecdef END AS security_definer,
 CASE WHEN p.oid IS NOT NULL THEN p.proowner=pg_catalog.to_regrole('postgres')::oid END AS owner_postgres,
 CASE WHEN p.oid IS NOT NULL THEN EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') END AS public_pode_executar,
 CASE WHEN p.oid IS NOT NULL THEN p.provolatile='v' END AS is_volatile,
 CASE WHEN p.oid IS NOT NULL THEN p.provolatile='s' END AS is_stable,
 CASE WHEN p.oid IS NOT NULL THEN p.provolatile='i' END AS is_immutable,
 CASE WHEN p.oid IS NOT NULL THEN l.lanname='sql' END AS is_sql,
 CASE WHEN p.oid IS NOT NULL THEN l.lanname='plpgsql' END AS is_plpgsql,
 CASE WHEN p.oid IS NOT NULL THEN p.proconfig=ARRAY[e.expected_path]::text[] END AS search_path_expected_matches,
 CASE WHEN p.oid IS NOT NULL THEN EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.objsubid=0 AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e') END AS member_of_extension,
 CASE WHEN p.oid IS NOT NULL THEN p.prorettype='pg_catalog.jsonb'::regtype END AS returns_jsonb,
 CASE WHEN p.oid IS NOT NULL THEN p.proretset END AS set_returning
FROM (VALUES (1,'public.shrigma_crm_read_fast_v1(text,text,jsonb)','search_path=pg_catalog, public'),
 (2,'public.shrigma_panel_auth_v1(text,text,text)','search_path=pg_catalog, public'),
 (3,'public.shrigma_panel_operator_v1(text,text)','search_path=pg_catalog, public'),
 (4,'public.shrigma_crm_operator_auth_v1(text)','search_path=pg_catalog, public'),
 (5,'public.shrigma_template_auth_v2(text)','search_path=public, pg_catalog')) e(ord,assinatura,expected_path)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(e.assinatura)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang ORDER BY e.ord
) classification_row;

ROLLBACK;
