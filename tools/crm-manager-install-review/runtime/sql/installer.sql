-- OFFLINE POLICY REVIEW V3: not approved or executed on any database.
-- Both new roles are NOLOGIN; no password, issuer or runtime activation.
-- One transaction owns all 4 new tables, 2 explicit indexes, 7 functions, 2 roles.
-- Implicit PK/UNIQUE indexes, FK triggers and composite types are also NEW.
-- Existing definitions/rows/owners/PUBLIC/default ACL entries stay unchanged.
-- Additive exception: new NOLOGIN owner's narrow grants on two legacy tables.
-- No password, issuer, domain, credential, worker, scheduler or activation.
-- PostgreSQL16/17 are recognized. Applying on17 requires native CI17 PASS
-- recorded separately; compatibility metadata does not prove that CI result.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='4s';
SET LOCAL lock_timeout='500ms';
SET LOCAL idle_in_transaction_session_timeout='5s';
DO $manager_install_guard$
DECLARE proof jsonb;item jsonb;report jsonb;installation jsonb;hba jsonb;auth_scope jsonb;
BEGIN
 IF current_database()<>'listmonk' OR current_user<>'postgres' OR session_user<>'postgres'
  OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
 IF NOT pg_try_advisory_xact_lock(1609296685,1) THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
WITH execution_context AS MATERIALIZED (
 SELECT current_database()='listmonk' AND current_user='postgres' AND session_user='postgres'
  AND current_setting('transaction_read_only')='off' AS verified
), targets AS MATERIALIZED (
 SELECT v.* FROM (VALUES ('crm_dash_chave'),('shrigma_panel_permission_v1')) v(target)
 CROSS JOIN execution_context x WHERE x.verified
), expected_columns(target,column_name,type_name,required_not_null,requires_nullable) AS (
 VALUES ('crm_dash_chave','chave','text',true,false),('crm_dash_chave','painel','text',false,false),
 ('crm_dash_chave','dono','text',false,false),('crm_dash_chave','ativo','boolean',false,false),
 ('crm_dash_chave','revogada_em','timestamp with time zone',false,true),
 ('crm_dash_chave','ultimo_uso','timestamp with time zone',false,true),
 ('crm_dash_chave','usos','integer',false,false),('crm_dash_chave','chave_hash','text',false,false),
 ('crm_dash_chave','chave_hash_curta','text',false,true),('crm_dash_chave','expira_em','timestamp with time zone',false,false),
 ('crm_dash_chave','criado_em','timestamp with time zone',true,false),
 ('shrigma_panel_permission_v1','principal_id','text',true,false),
 ('shrigma_panel_permission_v1','area','text',true,false),('shrigma_panel_permission_v1','caps','jsonb',true,false)
), column_checks AS MATERIALIZED (
 SELECT e.target,e.column_name,
  a.attnum IS NOT NULL AS present,
  coalesce(a.atttypid=to_regtype(e.type_name)::oid
   OR e.target='crm_dash_chave' AND e.column_name IN ('chave','painel','dono') AND a.atttypid='character varying'::regtype::oid
    AND (a.atttypmod=-1 OR a.atttypmod>=CASE e.column_name WHEN 'chave' THEN 41 WHEN 'painel' THEN 10 ELSE 258 END)
   OR e.column_name='usos' AND a.atttypid='bigint'::regtype::oid,false) AS type_matches,
  coalesce(t.typtype='b' AND a.attidentity='' AND a.attgenerated='' AND a.attinhcount=0
   AND (a.attcollation=0 OR EXISTS(SELECT 1 FROM pg_collation k WHERE k.oid=a.attcollation AND k.collisdeterministic)),false) AS plain_column,
  coalesce((NOT e.required_not_null OR a.attnotnull) AND (NOT e.requires_nullable OR NOT a.attnotnull),false) AS nullability_matches,
  CASE WHEN a.attnum IS NULL THEN false WHEN d.oid IS NULL THEN e.column_name<>'criado_em'
   WHEN pg_get_expr(d.adbin,d.adrelid,true) ~ '^NULL(::[A-Za-z0-9_ ]+)?$' THEN e.column_name<>'criado_em'
   WHEN e.target='crm_dash_chave' AND e.column_name='ativo' THEN pg_get_expr(d.adbin,d.adrelid,true)='true'
   WHEN e.target='crm_dash_chave' AND e.column_name='usos' THEN pg_get_expr(d.adbin,d.adrelid,true) IN ('0','0::integer')
   WHEN e.target='crm_dash_chave' AND e.column_name IN ('ultimo_uso','criado_em') THEN pg_get_expr(d.adbin,d.adrelid,true) IN ('now()','CURRENT_TIMESTAMP')
   ELSE false END AS default_safe
 FROM expected_columns e JOIN targets z ON z.target=e.target
 LEFT JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||e.target) AND a.attname=e.column_name AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
), constraint_checks AS MATERIALIZED (
 SELECT z.target,c.conname,
 CASE WHEN c.contype='p' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred THEN
  c.conname=CASE z.target WHEN 'crm_dash_chave' THEN 'crm_dash_chave_pkey' ELSE 'shrigma_panel_permission_v1_pkey' END
  AND c.conkey=(SELECT array_agg(a.attnum ORDER BY array_position(CASE z.target WHEN 'crm_dash_chave' THEN ARRAY['chave'] ELSE ARRAY['principal_id','area'] END,a.attname::text))::smallint[] FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname=ANY(CASE z.target WHEN 'crm_dash_chave' THEN ARRAY['chave'] ELSE ARRAY['principal_id','area'] END))
 WHEN c.contype='f' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred THEN
  z.target='shrigma_panel_permission_v1' AND c.conname='shrigma_panel_permission_v1_principal_id_fkey'
  AND c.confrelid=to_regclass('public.crm_dash_chave') AND c.confmatchtype='s' AND c.confupdtype='a' AND c.confdeltype='a'
  AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname='principal_id')]::smallint[]
  AND c.confkey=ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=c.confrelid AND a.attname='chave')]::smallint[]
 WHEN c.contype='c' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred THEN
  CASE WHEN z.target='crm_dash_chave' THEN
   regexp_replace(pg_get_expr(c.conbin,c.conrelid,true),'[[:space:]()]|::text','','g') ~ '^painel=ANYARRAY\[''[a-z]+''(,''[a-z]+'')*\]$'
   AND (SELECT array_agg(v[1] ORDER BY v[1] COLLATE "C") FROM regexp_matches(pg_get_expr(c.conbin,c.conrelid,true),'''([a-z]+)''','g') v)=ARRAY['cx','growth','influs','organico','todos']
  WHEN c.conname='shrigma_panel_permission_v1_area_check' THEN regexp_replace(pg_get_expr(c.conbin,c.conrelid,true),'[[:space:]]|::text','','g') IN ('(area=ANY(ARRAY[''growth'',''influs'']))','area=ANY(ARRAY[''growth'',''influs''])')
  WHEN c.conname='shrigma_panel_permission_v1_caps_check' THEN regexp_replace(pg_get_expr(c.conbin,c.conrelid,true),'[[:space:]]|::text','','g') IN ('(jsonb_typeof(caps)=''array'')','jsonb_typeof(caps)=''array''') ELSE false END
 ELSE false END AS matches
 FROM targets z JOIN pg_constraint c ON c.conrelid=to_regclass('public.'||z.target)
), index_checks AS MATERIALIZED (
 SELECT z.target,i.indexrelid,
 i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indexprs IS NULL AND i.indnatts=i.indnkeyatts
 AND ic.relam=(SELECT oid FROM pg_am WHERE amname='btree')
 AND NOT EXISTS(SELECT 1 FROM unnest(i.indclass::oid[]) o(oid) LEFT JOIN pg_opclass p ON p.oid=o.oid LEFT JOIN pg_namespace n ON n.oid=p.opcnamespace WHERE n.nspname IS DISTINCT FROM 'pg_catalog' OR p.opcname IS DISTINCT FROM 'text_ops')
 AND NOT EXISTS(SELECT 1 FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indcollation[(k.n-1)::int]<>a.attcollation)
 AND CASE WHEN i.indisprimary THEN i.indpred IS NULL
  AND (z.target='crm_dash_chave' AND ic.relname='crm_dash_chave_pkey' AND i.indnkeyatts=1 AND i.indkey[0]=(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=i.indrelid AND a.attname='chave')
   OR z.target='shrigma_panel_permission_v1' AND ic.relname='shrigma_panel_permission_v1_pkey' AND i.indnkeyatts=2 AND i.indkey[0]=(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=i.indrelid AND a.attname='principal_id') AND i.indkey[1]=(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=i.indrelid AND a.attname='area'))
 ELSE z.target='crm_dash_chave' AND ic.relname IN ('crm_dash_chave_hash_uq','crm_dash_chave_curta_uq') AND i.indnkeyatts=1
  AND i.indkey[0]=(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=i.indrelid AND a.attname=CASE ic.relname WHEN 'crm_dash_chave_hash_uq' THEN 'chave_hash' ELSE 'chave_hash_curta' END)
  AND regexp_replace(pg_get_expr(i.indpred,i.indrelid,true),'[[:space:]()]','','g')=CASE ic.relname WHEN 'crm_dash_chave_hash_uq' THEN 'chave_hashISNOTNULL' ELSE 'chave_hash_curtaISNOTNULL' END END AS matches
 FROM targets z JOIN pg_index i ON i.indrelid=to_regclass('public.'||z.target) JOIN pg_class ic ON ic.oid=i.indexrelid
), legacy AS MATERIALIZED (
 SELECT z.target,c.oid IS NOT NULL AS present,coalesce(c.relkind='r' AND c.relpersistence='p' AND c.relam=(SELECT oid FROM pg_am WHERE amname='heap') AND pg_get_userbyid(c.relowner)='postgres',false) AS ordinary_owned,
  coalesce(NOT c.relrowsecurity AND NOT c.relforcerowsecurity,false) AS rls_off,
  coalesce(NOT c.relispartition AND NOT EXISTS(SELECT 1 FROM pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid),false) AS no_inheritance,
  (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal) AS user_triggers,
  (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgisinternal) AS internal_triggers,
  (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgisinternal AND g.tgconstraint=(SELECT x.oid FROM pg_constraint x WHERE x.conrelid=to_regclass('public.shrigma_panel_permission_v1') AND x.conname='shrigma_panel_permission_v1_principal_id_fkey') AND g.tgenabled='O' AND NOT g.tgdeferrable AND NOT g.tginitdeferred
   AND (z.target='shrigma_panel_permission_v1' AND ((g.tgfoid=to_regprocedure('pg_catalog."RI_FKey_check_ins"()') AND g.tgtype=5) OR (g.tgfoid=to_regprocedure('pg_catalog."RI_FKey_check_upd"()') AND g.tgtype=17)) OR z.target='crm_dash_chave' AND ((g.tgfoid=to_regprocedure('pg_catalog."RI_FKey_noaction_del"()') AND g.tgtype=9) OR (g.tgfoid=to_regprocedure('pg_catalog."RI_FKey_noaction_upd"()') AND g.tgtype=17)))) AS known_internal_triggers,
  (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgenabled<>'O') AS disabled_triggers,
  (SELECT count(*) FROM pg_rewrite r WHERE r.ev_class=c.oid) AS rewrite_rules,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
  (SELECT count(*) FROM pg_publication_tables p WHERE p.schemaname='public' AND p.tablename=z.target) AS publications,
  (SELECT count(*) FROM pg_constraint fk WHERE fk.confrelid=c.oid AND fk.contype='f' AND NOT(fk.conrelid=to_regclass('public.shrigma_panel_permission_v1') AND fk.conname='shrigma_panel_permission_v1_principal_id_fkey')) AS unknown_inbound_fks,
  (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND NOT EXISTS(SELECT 1 FROM expected_columns e WHERE e.target=z.target AND e.column_name=a.attname)) AS unknown_columns,
  NOT EXISTS(SELECT 1 FROM column_checks a WHERE a.target=z.target AND NOT(a.present AND a.type_matches AND a.plain_column AND a.nullability_matches AND a.default_safe)) AS columns_ok,
  (SELECT count(*) FROM constraint_checks a WHERE a.target=z.target)=CASE z.target WHEN 'crm_dash_chave' THEN 2 ELSE 4 END AND NOT EXISTS(SELECT 1 FROM constraint_checks a WHERE a.target=z.target AND a.matches IS DISTINCT FROM true) AS constraints_ok,
  (SELECT count(*) FROM index_checks a WHERE a.target=z.target)=CASE z.target WHEN 'crm_dash_chave' THEN 3 ELSE 1 END AND NOT EXISTS(SELECT 1 FROM index_checks a WHERE a.target=z.target AND a.matches IS DISTINCT FROM true) AS indexes_ok,
  NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_relation_acl_clear,
  NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(a.attacl)>0 THEN a.attacl END) p WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND p.grantee=0) AS public_column_acl_clear
 FROM targets z LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||z.target)
), expected_functions(target,signature,body_md5,definer,volatility,path) AS (
 VALUES ('shrigma_panel_auth_v1','public.shrigma_panel_auth_v1(text,text,text)','488ee373b461fd61418c0489c42e3df7',false,'v','search_path=pg_catalog, public'),
 ('shrigma_panel_operator_v1','public.shrigma_panel_operator_v1(text,text)','2092629644f901de260051084d2fb2c2',false,'s','search_path=pg_catalog, public'),
 ('shrigma_crm_read_fast_v1','public.shrigma_crm_read_fast_v1(text,text,jsonb)','0c3b2e1b3094cccae44fa2b89fbfb18b',true,'v','search_path=pg_catalog, public')
), auth_functions AS MATERIALIZED (
 SELECT e.target,p.oid IS NOT NULL AS present,coalesce(md5(p.prosrc)=e.body_md5,false) AS body_matches,
  coalesce(p.prosecdef=e.definer AND p.provolatile::text=e.volatility,false) AS mode_matches,
  coalesce(pg_get_userbyid(p.proowner)='postgres',false) AS owner_matches,
  coalesce(p.proconfig=ARRAY[e.path],false) AS search_path_matches,
  coalesce(l.lanname=CASE WHEN e.definer THEN 'plpgsql' ELSE 'sql' END,false) AS language_matches,
  coalesce(CASE e.target WHEN 'shrigma_panel_operator_v1' THEN p.prorettype='jsonb'::regtype AND NOT p.proretset AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames=ARRAY['k','a']::text[]
   WHEN 'shrigma_panel_auth_v1' THEN p.prorettype='record'::regtype AND p.proretset AND p.proallargtypes=ARRAY['text'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid]::oid[] AND p.proargmodes=ARRAY['i','i','i','t','t','t']::"char"[] AND p.proargnames=ARRAY['p_key','p_requested','p_transport','painel','dono','efetivo']::text[]
   ELSE p.prorettype='record'::regtype AND p.proretset AND p.proallargtypes=ARRAY['text'::regtype::oid,'text'::regtype::oid,'jsonb'::regtype::oid,'integer'::regtype::oid,'jsonb'::regtype::oid]::oid[] AND p.proargmodes=ARRAY['i','i','i','t','t']::"char"[] AND p.proargnames=ARRAY['p_authorization','p_origin','p_query','status_code','body']::text[] END,false) AS signature_matches,
  NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_execute
 FROM expected_functions e CROSS JOIN execution_context x LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature) LEFT JOIN pg_language l ON l.oid=p.prolang WHERE x.verified
), applicable_hba AS MATERIALIZED (
 SELECT h.type,h.auth_method FROM pg_hba_file_rules h CROSS JOIN execution_context x WHERE x.verified AND h.error IS NULL
  AND ('all'=ANY(h.database) OR 'listmonk'=ANY(h.database)) AND ('all'=ANY(h.user_name) OR 'crm_manager_provisioner'=ANY(h.user_name))
), hba AS MATERIALIZED (
 SELECT 'provisioner_hba'::text AS target,
  (SELECT count(*) FROM pg_hba_file_rules h CROSS JOIN execution_context x WHERE x.verified AND h.error IS NOT NULL) AS rule_errors,
  count(*) AS applicable_rules,count(*) FILTER(WHERE type='local') AS local_rules,count(*) FILTER(WHERE type='host') AS host_rules,
  count(*) FILTER(WHERE type='hostssl') AS hostssl_rules,count(*) FILTER(WHERE type='hostnossl') AS hostnossl_rules,
  count(*) FILTER(WHERE auth_method='trust') AS trust_rules,count(*) FILTER(WHERE auth_method='password') AS password_rules,
  count(*) FILTER(WHERE auth_method='md5') AS md5_rules,count(*) FILTER(WHERE auth_method='scram-sha-256') AS scram_rules,
  count(*) FILTER(WHERE auth_method='reject') AS reject_rules,count(*) FILTER(WHERE auth_method NOT IN ('trust','password','md5','scram-sha-256','reject')) AS other_methods
 FROM applicable_hba
), installation AS MATERIALIZED (
 SELECT 'manager_install_v1'::text AS target,
  NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('crm_manager_function_owner_v1','crm_manager_provisioner')) AS roles_absent,
  NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1','shrigma_crm_manager_one_prepared_v1','shrigma_crm_manager_one_active_v1'])) AS relations_absent,
  NOT EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=ANY(ARRAY['shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1'])) AS types_absent,
  NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shrigma_crm_manager_canonical_v1','shrigma_crm_manager_error_v1','shrigma_crm_manager_apply_v1','shrigma_crm_manager_prepare_v1','shrigma_crm_manager_commit_v1','shrigma_crm_manager_revoke_v1','shrigma_crm_manager_status_v1'])) AS functions_absent,
  (SELECT count(*) FROM pg_event_trigger WHERE evtenabled<>'D') AS enabled_event_triggers,
  (SELECT count(*) FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname NOT LIKE 'pg_%' AND a.grantee=0 AND a.privilege_type='CREATE') AS public_schema_create,
  (SELECT count(*) FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CREATE') AS public_database_create,
  (SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(d.defaclacl)>0 THEN d.defaclacl END) a WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='postgres') AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace) AND d.defaclobjtype='r' AND a.grantee NOT IN (0,d.defaclrole)) AS default_table_extra_grants,
  (SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(d.defaclacl)>0 THEN d.defaclacl END) a WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='postgres') AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace) AND d.defaclobjtype='f' AND a.grantee NOT IN (0,d.defaclrole)) AS default_function_extra_grants,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_function_execute,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND a.grantee=0 AND a.privilege_type='EXECUTE' AND p.provolatile='v') AS public_function_volatile,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND a.grantee=0 AND a.privilege_type='EXECUTE' AND p.prosecdef) AS public_function_definer,
  (SELECT EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='TEMPORARY')) AS public_temporary,
  current_setting('ssl',true)='on' AS ssl_enabled,current_setting('password_encryption',true)='scram-sha-256' AS scram_configured,
  current_setting('log_statement',true)='none' AS log_statement_disabled,
  current_setting('log_min_error_statement',true) IN ('fatal','panic') AS log_error_statement_disabled,
  current_setting('log_parameter_max_length',true)='0' AS log_parameters_disabled,
  current_setting('log_parameter_max_length_on_error',true)='0' AS log_error_parameters_disabled,
  current_setting('log_min_duration_statement',true)='-1' AS log_duration_statement_disabled,
  current_setting('log_min_duration_sample',true)='-1' AS log_duration_sample_disabled,
  current_setting('log_transaction_sample_rate',true)::numeric=0 AS log_transaction_sample_disabled,
  current_setting('log_statement',true) IN ('none','ddl','mod','all')
   AND current_setting('log_min_error_statement',true) IN ('debug5','debug4','debug3','debug2','debug1','info','notice','warning','error','log','fatal','panic')
   AND current_setting('log_parameter_max_length',true) ~ '^(-1|[0-9]+)$'
   AND current_setting('log_parameter_max_length_on_error',true) ~ '^(-1|[0-9]+)$'
   AND current_setting('log_min_duration_statement',true) ~ '^(-1|[0-9]+)$'
   AND current_setting('log_min_duration_sample',true) ~ '^(-1|[0-9]+)$' AS log_settings_recognized,
  coalesce(current_setting('shared_preload_libraries',true),'')<>'' AS shared_preload_present,
  position('pgaudit' IN lower(coalesce(current_setting('shared_preload_libraries',true),'')))>0 OR current_setting('pgaudit.log',true) IS NOT NULL AS pgaudit_present,
  -- These flags classify compatibility, never claim that CI17 already passed.
  current_setting('server_version_num')::int/10000 IN (16,17) AS native_supported_family,
  current_setting('server_version_num')::int/10000=16 AS native_major16,
  current_setting('server_version_num')::int/10000=17 AS native_major17
 FROM execution_context x WHERE x.verified
)
SELECT jsonb_build_object('schema','crm-manager-install-preflight-v1','contextVerified',(SELECT verified FROM execution_context),'reports',
 CASE WHEN (SELECT verified FROM execution_context) THEN jsonb_build_array(
  jsonb_build_object('section','installation','rows',(SELECT jsonb_agg(to_jsonb(i)) FROM installation i)),
  jsonb_build_object('section','legacy','rows',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.target) FROM legacy i)),
  jsonb_build_object('section','columns','rows',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.target,i.column_name) FROM column_checks i)),
  jsonb_build_object('section','auth_functions','rows',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.target) FROM auth_functions i)),
  jsonb_build_object('section','hba','rows',(SELECT jsonb_agg(to_jsonb(i)) FROM hba i))) ELSE '[]'::jsonb END) INTO proof;

 IF proof->>'contextVerified' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
 installation:=proof#>'{reports,0,rows,0}';hba:=proof#>'{reports,4,rows,0}';
 IF NOT coalesce((installation->>'roles_absent')::boolean AND (installation->>'relations_absent')::boolean
  AND (installation->>'types_absent')::boolean AND (installation->>'functions_absent')::boolean AND (installation->>'native_supported_family')::boolean
  AND (installation->>'enabled_event_triggers')::int=0 AND (installation->>'public_schema_create')::int=0
  AND (installation->>'public_database_create')::int=0 AND (installation->>'default_table_extra_grants')::int=1
  AND NOT EXISTS(SELECT 1 FROM pg_default_acl d
   CROSS JOIN LATERAL aclexplode(d.defaclacl) a
   WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='postgres')
    AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
    AND d.defaclobjtype='r' AND a.grantee NOT IN (0,d.defaclrole)
    AND NOT coalesce(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='central_leitor')
     AND a.grantor=d.defaclrole AND a.privilege_type='SELECT' AND NOT a.is_grantable,false))
  AND (installation->>'default_function_extra_grants')::int=0,false)
  THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(proof#>'{reports,1,rows}') LOOP
  IF NOT coalesce((item->>'present')::boolean AND (item->>'ordinary_owned')::boolean AND (item->>'rls_off')::boolean
   AND (item->>'no_inheritance')::boolean AND (item->>'columns_ok')::boolean AND (item->>'constraints_ok')::boolean AND (item->>'indexes_ok')::boolean
   AND (item->>'public_relation_acl_clear')::boolean AND (item->>'public_column_acl_clear')::boolean
   AND (item->>'user_triggers')::int=0 AND (item->>'internal_triggers')::int=2 AND (item->>'known_internal_triggers')::int=2
   AND (item->>'disabled_triggers')::int=0 AND (item->>'rewrite_rules')::int=0 AND (item->>'policies')::int=0
   AND (item->>'publications')::int=0 AND (item->>'unknown_inbound_fks')::int=0 AND (item->>'unknown_columns')::int=0,false)
   THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(proof#>'{reports,3,rows}') LOOP
  IF NOT coalesce((item->>'present')::boolean AND (item->>'body_matches')::boolean AND (item->>'mode_matches')::boolean
   AND (item->>'owner_matches')::boolean AND (item->>'search_path_matches')::boolean AND (item->>'language_matches')::boolean
   AND (item->>'signature_matches')::boolean AND (item->>'no_public_execute')::boolean,false)
   THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
 END LOOP;
 -- Existing local/loopback trust is classified, never changed or
 -- treated as proof of the application's origin, TLS or authentication.
 -- The service role below remains NOLOGIN; LOGIN activation is a separate gate.
WITH execution_context AS MATERIALIZED (
 SELECT current_database()='listmonk' AND current_user='postgres' AND session_user='postgres'
  AND current_setting('transaction_read_only')='off' AS verified
), candidate_hba AS MATERIALIZED (
 SELECT h.type,h.auth_method,h.address,h.netmask FROM pg_hba_file_rules h
 CROSS JOIN execution_context x WHERE x.verified AND h.error IS NULL
  AND ('all'=ANY(h.database) OR 'listmonk'=ANY(h.database))
  AND ('all'=ANY(h.user_name) OR 'crm_manager_provisioner'=ANY(h.user_name))
), classified_hba AS MATERIALIZED (
 SELECT auth_method,CASE
  WHEN type='local' THEN 'local'
  WHEN type NOT IN ('host','hostssl','hostnossl') THEN 'unclassified'
  WHEN address='all' THEN 'non_loopback'
  WHEN NOT coalesce(pg_input_is_valid(address,'inet') AND pg_input_is_valid(netmask,'inet'),false) THEN 'unclassified'
  WHEN family(address::inet)<>family(netmask::inet) THEN 'unclassified'
  WHEN family(address::inet)=4 AND host(address::inet)::inet <<= '127.0.0.0/8'::inet
   AND (netmask::inet & '255.0.0.0'::inet)='255.0.0.0'::inet THEN 'loopback_only'
  WHEN family(address::inet)=6 AND host(address::inet)::inet='::1'::inet
   AND netmask::inet='ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'::inet THEN 'loopback_only'
  ELSE 'non_loopback' END AS scope
 FROM candidate_hba
), scopes AS (
 SELECT v.* FROM (VALUES(1,'local'),(2,'loopback_only'),(3,'non_loopback'),(4,'unclassified')) v(ord,target)
), hba_scopes AS MATERIALIZED (
 SELECT s.ord,s.target,count(h.scope) AS total,
  count(h.scope) FILTER(WHERE h.auth_method='trust') AS trust,
  count(h.scope) FILTER(WHERE h.auth_method='password') AS password,
  count(h.scope) FILTER(WHERE h.auth_method='md5') AS md5,
  count(h.scope) FILTER(WHERE h.auth_method='scram-sha-256') AS scram,
  count(h.scope) FILTER(WHERE h.auth_method='reject') AS reject,
  count(h.scope) FILTER(WHERE h.auth_method NOT IN ('trust','password','md5','scram-sha-256','reject')) AS other
 FROM scopes s LEFT JOIN classified_hba h ON h.scope=s.target CROSS JOIN execution_context x
 WHERE x.verified GROUP BY s.ord,s.target
), hba_summary AS MATERIALIZED (
 SELECT 'provisioner_hba'::text AS target,
  (SELECT count(*) FROM pg_hba_file_rules h CROSS JOIN execution_context x WHERE x.verified AND h.error IS NOT NULL) AS rule_errors,
  (SELECT count(*) FROM candidate_hba) AS candidate_rules,
  (SELECT count(*) FROM pg_hba_file_rules h CROSS JOIN execution_context x WHERE x.verified AND h.error IS NULL AND (
   EXISTS(SELECT 1 FROM unnest(h.database) t(v) WHERE v LIKE '@%' OR v LIKE '/%' OR v IN ('sameuser','samerole','samegroup'))
   OR EXISTS(SELECT 1 FROM unnest(h.user_name) t(v) WHERE v LIKE '+%' OR v LIKE '@%' OR v LIKE '/%'))) AS ambiguous_selector_rules
 FROM execution_context x WHERE x.verified
), extra_defaults AS MATERIALIZED (
 SELECT a.grantee=(SELECT oid FROM pg_roles WHERE rolname='central_leitor') AS central_leitor,
  CASE WHEN a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
   THEN a.privilege_type ELSE 'OTHER' END AS privilege,
  d.defaclnamespace=0 AS global_scope,a.is_grantable,a.grantor<>d.defaclrole AS foreign_grantor
 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a CROSS JOIN execution_context x
 WHERE x.verified AND d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='postgres')
  AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
  AND d.defaclobjtype='r' AND a.grantee NOT IN (0,d.defaclrole)
), privilege_classes AS (
 SELECT v.* FROM (VALUES(1,'SELECT'),(2,'INSERT'),(3,'UPDATE'),(4,'DELETE'),(5,'TRUNCATE'),(6,'REFERENCES'),(7,'TRIGGER'),(8,'MAINTAIN'),(9,'OTHER')) v(ord,privilege)
), default_acl AS MATERIALIZED (
 SELECT c.central_leitor,p.ord,p.privilege,count(d.privilege) AS entry_count,
  count(d.privilege) FILTER(WHERE d.global_scope) AS global_count,
  count(d.privilege) FILTER(WHERE NOT d.global_scope) AS public_schema_count,
  count(d.privilege) FILTER(WHERE d.is_grantable) AS grant_option_count,
  count(d.privilege) FILTER(WHERE d.foreign_grantor) AS foreign_grantor_count
 FROM (VALUES(true),(false)) c(central_leitor) CROSS JOIN privilege_classes p
 CROSS JOIN execution_context x LEFT JOIN extra_defaults d
 ON coalesce(d.central_leitor,false)=c.central_leitor AND d.privilege=p.privilege
 WHERE x.verified GROUP BY c.central_leitor,p.ord,p.privilege
)
SELECT jsonb_build_object('schema','crm-manager-auth-scope-metadata-v1',
 'contextVerified',(SELECT verified FROM execution_context),'reports',
 CASE WHEN (SELECT verified FROM execution_context) THEN jsonb_build_array(
  jsonb_build_object('section','hba_summary','rows',(SELECT jsonb_agg(to_jsonb(h)) FROM hba_summary h)),
  jsonb_build_object('section','hba_scopes','rows',(SELECT jsonb_agg(to_jsonb(h)-'ord' ORDER BY h.ord) FROM hba_scopes h)),
  jsonb_build_object('section','default_acl','rows',(SELECT jsonb_agg(to_jsonb(d)-'ord' ORDER BY d.central_leitor DESC,d.ord) FROM default_acl d)))
 ELSE '[]'::jsonb END) INTO auth_scope;

 IF auth_scope IS DISTINCT FROM '{"schema":"crm-manager-auth-scope-metadata-v1","contextVerified":true,"reports":[{"section":"hba_summary","rows":[{"target":"provisioner_hba","rule_errors":0,"candidate_rules":4,"ambiguous_selector_rules":0}]},{"section":"hba_scopes","rows":[{"target":"local","total":1,"trust":1,"password":0,"md5":0,"scram":0,"reject":0,"other":0},{"target":"loopback_only","total":2,"trust":2,"password":0,"md5":0,"scram":0,"reject":0,"other":0},{"target":"non_loopback","total":1,"trust":0,"password":0,"md5":0,"scram":1,"reject":0,"other":0},{"target":"unclassified","total":0,"trust":0,"password":0,"md5":0,"scram":0,"reject":0,"other":0}]},{"section":"default_acl","rows":[{"central_leitor":true,"privilege":"SELECT","entry_count":1,"global_count":0,"public_schema_count":1,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":true,"privilege":"INSERT","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":true,"privilege":"UPDATE","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":true,"privilege":"DELETE","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":true,"privilege":"TRUNCATE","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":true,"privilege":"REFERENCES","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":true,"privilege":"TRIGGER","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":true,"privilege":"MAINTAIN","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":true,"privilege":"OTHER","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"SELECT","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"INSERT","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"UPDATE","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"DELETE","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"TRUNCATE","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"REFERENCES","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"TRIGGER","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"MAINTAIN","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0},{"central_leitor":false,"privilege":"OTHER","entry_count":0,"global_count":0,"public_schema_count":0,"grant_option_count":0,"foreign_grantor_count":0}]}]}'::jsonb
  THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
END
$manager_install_guard$;

-- Original reviewed namespace body, stripped only of external transaction frame.
-- OFFLINE PROPOSAL. Never applied to production by this task.
-- Additive objects only. Installation intentionally refuses existing v1 names.
-- No issuer registration, login creation, credential or production GRANT here.
SET LOCAL search_path=pg_catalog;

CREATE TABLE public.shrigma_crm_manager_issuer_v1 (
 issuer_id uuid PRIMARY KEY,namespace_id uuid NOT NULL UNIQUE,login_role name NOT NULL UNIQUE,
 allowed_email_domains text[] NOT NULL CHECK(cardinality(allowed_email_domains) BETWEEN 1 AND 8),
 active boolean NOT NULL DEFAULT false
);
CREATE TABLE public.shrigma_crm_manager_subject_v1 (
 namespace_id uuid NOT NULL REFERENCES public.shrigma_crm_manager_issuer_v1(namespace_id),
 user_id uuid NOT NULL,lifecycle_id uuid NOT NULL,owner text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','revoked')),active_generation integer NOT NULL DEFAULT 0 CHECK(active_generation BETWEEN 0 AND 999999999),
 revoked_at timestamptz,PRIMARY KEY(namespace_id,user_id,lifecycle_id)
);
CREATE TABLE public.shrigma_crm_manager_operation_v1 (
 namespace_id uuid NOT NULL REFERENCES public.shrigma_crm_manager_issuer_v1(namespace_id),
 operation_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('prepare_read','renew_read','commit_read','revoke_read')),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 response jsonb,PRIMARY KEY(namespace_id,operation_id)
);
CREATE TABLE public.shrigma_crm_manager_generation_v1 (
 namespace_id uuid NOT NULL,user_id uuid NOT NULL,lifecycle_id uuid NOT NULL,prepare_operation_id uuid NOT NULL,
 generation integer NOT NULL CHECK(generation BETWEEN 1 AND 999999999),
 expected_generation integer NOT NULL CHECK(expected_generation=generation-1),
 principal_id text NOT NULL UNIQUE REFERENCES public.crm_dash_chave(chave),
 state text NOT NULL CHECK(state IN ('prepared','active','revoked','expired')),
 issued_at_ms bigint NOT NULL,candidate_expires_at_ms bigint NOT NULL,expires_at_ms bigint NOT NULL,
 commit_operation_id uuid,committed_at_ms bigint,
 PRIMARY KEY(namespace_id,prepare_operation_id),
 FOREIGN KEY(namespace_id,user_id,lifecycle_id) REFERENCES public.shrigma_crm_manager_subject_v1(namespace_id,user_id,lifecycle_id),
 FOREIGN KEY(namespace_id,prepare_operation_id) REFERENCES public.shrigma_crm_manager_operation_v1(namespace_id,operation_id),
 CHECK(candidate_expires_at_ms=issued_at_ms+600000),
 CHECK(expires_at_ms=issued_at_ms+1209600000)
);
CREATE UNIQUE INDEX shrigma_crm_manager_one_prepared_v1 ON public.shrigma_crm_manager_generation_v1(namespace_id,user_id,lifecycle_id) WHERE state='prepared';
CREATE UNIQUE INDEX shrigma_crm_manager_one_active_v1 ON public.shrigma_crm_manager_generation_v1(namespace_id,user_id,lifecycle_id) WHERE state='active';
REVOKE ALL ON public.shrigma_crm_manager_issuer_v1,public.shrigma_crm_manager_subject_v1,public.shrigma_crm_manager_operation_v1,public.shrigma_crm_manager_generation_v1 FROM PUBLIC;

-- Canonical JSON matches the client's sorted-key serializer for the closed
-- ASCII/integer request schema. No pgcrypto extension or secret is required.
CREATE FUNCTION public.shrigma_crm_manager_canonical_v1(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE result text;kind text:=jsonb_typeof(v);
BEGIN
 IF kind='object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||public.shrigma_crm_manager_canonical_v1(val),',' ORDER BY k COLLATE "C"),'')||'}'
   INTO result FROM jsonb_each(v) item(k,val);
 ELSIF kind='array' THEN
  SELECT '['||coalesce(string_agg(public.shrigma_crm_manager_canonical_v1(val),',' ORDER BY n),'')||']'
   INTO result FROM jsonb_array_elements(v) WITH ORDINALITY item(val,n);
 ELSE result:=coalesce(v::text,'null'); END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.shrigma_crm_manager_error_v1(req jsonb,issuer uuid,ns uuid,code text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schema','crm-manager-provision-error-v1','issuerId',issuer,'namespaceId',ns,
  'operationId',CASE WHEN coalesce(req->>'operationId','') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN req->>'operationId' ELSE NULL END,
  'requestSha256',encode(sha256(convert_to(public.shrigma_crm_manager_canonical_v1(req),'UTF8')),'hex'),'code',code)
$$;

-- Private implementation. Four wrappers below are the only proposed RPCs.
CREATE FUNCTION public.shrigma_crm_manager_apply_v1(req jsonb,rpc text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 issuer public.shrigma_crm_manager_issuer_v1%ROWTYPE;
 subject public.shrigma_crm_manager_subject_v1%ROWTYPE;
 op public.shrigma_crm_manager_operation_v1%ROWTYPE;
 candidate public.shrigma_crm_manager_generation_v1%ROWTYPE;
 role_ok boolean;action text;expected_keys text[];actual_keys text[];ns uuid;opid uuid;uid uuid;life uuid;
 principal text;owner_email text;hash_value text;fp text;gen integer;previous integer;prepare_id uuid;
 now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;issued bigint;candidate_until bigint;final_until bigint;
 result jsonb;code text;revoked_count integer;
BEGIN
 SELECT * INTO issuer FROM public.shrigma_crm_manager_issuer_v1 WHERE login_role=session_user AND active;
 IF NOT FOUND THEN RETURN public.shrigma_crm_manager_error_v1(req,NULL,NULL,'ISSUER_DENIED'); END IF;
 ns:=issuer.namespace_id;
 SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
  AND NOT r.rolbypassrls AND NOT r.rolreplication AND NOT r.rolinherit
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
  INTO role_ok FROM pg_roles r WHERE r.rolname=session_user;
 IF role_ok IS DISTINCT FROM true THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'ISSUER_DENIED'); END IF;
 IF jsonb_typeof(req) IS DISTINCT FROM 'object' OR octet_length(req::text)>4096
  THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 action:=req->>'action';
 IF rpc='prepare' AND action IN ('prepare_read','renew_read') THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner','principalId','keySha256','generation','expectedGeneration','area','slot','role','caps','candidateTtlMs','lifetimeMs'];
 ELSIF rpc='commit' AND action='commit_read' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner','principalId','keySha256','generation','expectedGeneration','area','slot','role','caps','candidateTtlMs','lifetimeMs','prepareOperationId','issuedAt','candidateExpiresAt','expiresAt'];
 ELSIF rpc='revoke' AND action='revoke_read' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner'];
 ELSIF rpc='status' AND action='status' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','expectedRequestSha256'];
 ELSE RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO actual_keys FROM jsonb_object_keys(req) k;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO expected_keys FROM unnest(expected_keys) k;
 IF actual_keys IS DISTINCT FROM expected_keys OR req->>'schema' IS DISTINCT FROM 'crm-manager-provision-request-v1'
  OR req->>'issuerId' IS DISTINCT FROM issuer.issuer_id::text OR req->>'namespaceId' IS DISTINCT FROM ns::text
  OR coalesce(req->>'operationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 opid:=(req->>'operationId')::uuid;
 fp:=encode(sha256(convert_to(public.shrigma_crm_manager_canonical_v1(req),'UTF8')),'hex');
 IF rpc='status' THEN
  IF jsonb_typeof(req->'expectedRequestSha256') IS DISTINCT FROM 'string' OR coalesce(req->>'expectedRequestSha256','') !~ '^[a-f0-9]{64}$'
   THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  SELECT * INTO op FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id=ns AND operation_id=opid;
  IF NOT FOUND THEN
   RETURN jsonb_build_object('schema','crm-manager-provision-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',false);
  END IF;
  IF op.request_sha256<>req->>'expectedRequestSha256' THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'IDEMPOTENCY_CONFLICT'); END IF;
  IF op.response IS NULL THEN
   RETURN jsonb_build_object('schema','crm-manager-provision-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',false);
  END IF;
  IF op.response->>'schema'='crm-manager-provision-error-v1' THEN
   RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,op.response->>'code');
  END IF;
  IF op.action<>'revoke_read' AND EXISTS(SELECT 1 FROM public.shrigma_crm_manager_subject_v1 s WHERE s.namespace_id=ns
   AND s.user_id=(op.response->>'userId')::uuid AND s.lifecycle_id=(op.response->>'lifecycleId')::uuid AND s.state='revoked') THEN
   RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED');
  END IF;
  -- An expired prepare/renew receipt is historical proof, not a live lease.
  -- Lost-ACK reconciliation needs its fixed dates to close the local operation
  -- and issue a new candidate. Status never extends TTL or reactivates a key;
  -- direct prepare replay/commit still reject expiry, and tombstones dominate.
  RETURN jsonb_build_object('schema','crm-manager-provision-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',true,'receipt',op.response);
 END IF;
 IF coalesce(req->>'userId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR coalesce(req->>'lifecycleId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(req->'owner') IS DISTINCT FROM 'string'
  OR coalesce(req->>'owner','') !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9-]+\.)+[a-z]{2,63}$'
  OR length(req->>'owner')>254 OR req->>'owner'<>lower(req->>'owner')
  OR NOT(split_part(req->>'owner','@',2)=ANY(issuer.allowed_email_domains))
  THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 uid:=(req->>'userId')::uuid;life:=(req->>'lifecycleId')::uuid;owner_email:=req->>'owner';
 IF rpc IN ('prepare','commit') THEN
  IF coalesce(req->>'principalId','') !~ '^dcrm-[a-f0-9]{32}$'
   OR jsonb_typeof(req->'keySha256') IS DISTINCT FROM 'string' OR coalesce(req->>'keySha256','') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(req->'generation') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'expectedGeneration') IS DISTINCT FROM 'number'
   OR coalesce(req->>'generation','') !~ '^[0-9]{1,9}$' OR coalesce(req->>'expectedGeneration','') !~ '^[0-9]{1,9}$'
   OR req->>'area' IS DISTINCT FROM 'growth' OR req->>'slot' IS DISTINCT FROM 'crm-panel-read' OR req->>'role' IS DISTINCT FROM 'manager'
   OR req->'caps' IS DISTINCT FROM '["read_content","list_history","submission"]'::jsonb
   OR req->'candidateTtlMs' IS DISTINCT FROM '600000'::jsonb OR req->'lifetimeMs' IS DISTINCT FROM '1209600000'::jsonb
   THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  gen:=(req->>'generation')::integer;previous:=(req->>'expectedGeneration')::integer;
  IF gen<>previous+1 OR (action='prepare_read' AND (gen<>1 OR previous<>0)) OR (action='renew_read' AND previous<1)
   THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  principal:=req->>'principalId';hash_value:=req->>'keySha256';
 END IF;
 IF rpc='commit' THEN
  IF coalesce(req->>'prepareOperationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR req->>'prepareOperationId'=opid::text
   OR jsonb_typeof(req->'issuedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'candidateExpiresAt') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'expiresAt') IS DISTINCT FROM 'number'
   OR coalesce(req->>'issuedAt','') !~ '^[0-9]{1,16}$' OR coalesce(req->>'candidateExpiresAt','') !~ '^[0-9]{1,16}$' OR coalesce(req->>'expiresAt','') !~ '^[0-9]{1,16}$'
   THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  prepare_id:=(req->>'prepareOperationId')::uuid;
 END IF;
 -- Idempotency record is claimed before subject mutations. Different operations
 -- then serialize on the same subject row; a response becomes visible atomically.
 INSERT INTO public.shrigma_crm_manager_operation_v1(namespace_id,operation_id,action,request_sha256)
  VALUES(ns,opid,action,fp) ON CONFLICT(namespace_id,operation_id) DO NOTHING;
 SELECT * INTO op FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id=ns AND operation_id=opid FOR UPDATE;
 IF op.request_sha256<>fp OR op.action<>action THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'IDEMPOTENCY_CONFLICT'); END IF;
 SELECT * INTO subject FROM public.shrigma_crm_manager_subject_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life FOR UPDATE;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF FOUND AND subject.owner<>owner_email THEN
  result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
 ELSIF FOUND AND subject.state='revoked' AND rpc<>'revoke' THEN
  result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED');
 ELSIF op.response IS NOT NULL THEN
  IF rpc='prepare' THEN
   SELECT * INTO candidate FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=ns AND prepare_operation_id=opid;
   IF FOUND AND (candidate.state IN ('expired','revoked') OR candidate.candidate_expires_at_ms<=now_ms AND candidate.state='prepared')
    THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CANDIDATE_EXPIRED'); END IF;
  END IF;
  RETURN op.response;
 END IF;
 IF result IS NULL AND rpc IN ('prepare','revoke') AND subject.namespace_id IS NULL THEN
  INSERT INTO public.shrigma_crm_manager_subject_v1(namespace_id,user_id,lifecycle_id,owner,state)
   VALUES(ns,uid,life,owner_email,CASE WHEN rpc='revoke' THEN 'revoked' ELSE 'active' END) ON CONFLICT DO NOTHING;
  SELECT * INTO subject FROM public.shrigma_crm_manager_subject_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life FOR UPDATE;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF subject.owner<>owner_email THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT'); END IF;
  IF subject.state='revoked' AND rpc<>'revoke' THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED'); END IF;
 END IF;
 IF result IS NULL AND subject.namespace_id IS NULL THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'SUBJECT_NOT_FOUND'); END IF;
 IF result IS NULL AND rpc='prepare' THEN
  IF subject.active_generation<>previous THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
  ELSE
   -- Reconcile only expired pending candidates. Active predecessor is untouched.
   UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=clock_timestamp()
    FROM public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life
    AND g.state='prepared' AND g.candidate_expires_at_ms<=now_ms AND c.chave=g.principal_id;
   DELETE FROM public.shrigma_panel_permission_v1 p USING public.shrigma_crm_manager_generation_v1 g
    WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='prepared' AND g.candidate_expires_at_ms<=now_ms AND p.principal_id=g.principal_id;
   UPDATE public.shrigma_crm_manager_generation_v1 SET state='expired'
    WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='prepared' AND candidate_expires_at_ms<=now_ms;
   IF EXISTS(SELECT 1 FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='prepared') THEN
    result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
   ELSE
    issued:=now_ms;candidate_until:=issued+600000;final_until:=issued+1209600000;
    BEGIN
     INSERT INTO public.crm_dash_chave(chave,painel,dono,ativo,revogada_em,ultimo_uso,usos,chave_hash,chave_hash_curta,expira_em)
      VALUES(principal,'growth',owner_email,true,NULL,NULL,0,hash_value,NULL,to_timestamp(candidate_until/1000.0));
     INSERT INTO public.shrigma_panel_permission_v1(principal_id,area,caps) VALUES(principal,'growth','["read_content","list_history","submission"]'::jsonb);
     INSERT INTO public.shrigma_crm_manager_generation_v1(namespace_id,user_id,lifecycle_id,prepare_operation_id,generation,expected_generation,principal_id,state,issued_at_ms,candidate_expires_at_ms,expires_at_ms)
      VALUES(ns,uid,life,opid,gen,previous,principal,'prepared',issued,candidate_until,final_until);
    EXCEPTION WHEN unique_violation THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT'); END;
    IF result IS NULL THEN result:=jsonb_build_object('schema','crm-manager-provision-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
     'state','prepared','principalId',principal,'generation',gen,'expectedGeneration',previous,'area','growth','slot','crm-panel-read','role','manager','caps','["read_content","list_history","submission"]'::jsonb,
     'issuedAt',issued,'candidateExpiresAt',candidate_until,'expiresAt',final_until); END IF;
   END IF;
  END IF;
 ELSIF result IS NULL AND rpc='commit' THEN
  SELECT * INTO candidate FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=ns AND prepare_operation_id=prepare_id FOR UPDATE;
  -- Keep the verified key and existing grants stable during promotion. The
  -- parent key lock also serializes FK-backed concurrent grant insertion.
  PERFORM c.chave FROM public.crm_dash_chave c WHERE c.chave=candidate.principal_id FOR UPDATE;
  PERFORM p.principal_id FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=candidate.principal_id FOR UPDATE;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF candidate.namespace_id IS NULL OR candidate.user_id<>uid OR candidate.lifecycle_id<>life OR candidate.principal_id<>principal OR candidate.generation<>gen OR candidate.expected_generation<>previous THEN
   result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
  ELSIF candidate.state IN ('expired','revoked') OR candidate.candidate_expires_at_ms<=now_ms THEN
   result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CANDIDATE_EXPIRED');
  ELSIF candidate.issued_at_ms<>(req->>'issuedAt')::bigint OR candidate.candidate_expires_at_ms<>(req->>'candidateExpiresAt')::bigint OR candidate.expires_at_ms<>(req->>'expiresAt')::bigint
   OR NOT EXISTS(SELECT 1 FROM public.crm_dash_chave c WHERE c.chave=principal AND c.chave_hash=hash_value AND c.painel='growth' AND c.dono=owner_email AND c.chave_hash_curta IS NULL
    AND c.ativo AND c.revogada_em IS NULL AND c.expira_em=to_timestamp(candidate.candidate_expires_at_ms/1000.0))
   OR NOT EXISTS(SELECT 1 FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=principal AND p.area='growth' AND p.caps='["read_content","list_history","submission"]'::jsonb)
   OR EXISTS(SELECT 1 FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=principal AND p.area<>'growth') THEN
   result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
  ELSIF candidate.state<>'prepared' OR subject.active_generation<>previous THEN
   result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
  ELSE
   UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=clock_timestamp()
    FROM public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='active' AND c.chave=g.principal_id;
   DELETE FROM public.shrigma_panel_permission_v1 p USING public.shrigma_crm_manager_generation_v1 g
    WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='active' AND p.principal_id=g.principal_id;
   UPDATE public.shrigma_crm_manager_generation_v1 SET state='revoked' WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='active';
   UPDATE public.crm_dash_chave SET expira_em=to_timestamp(candidate.expires_at_ms/1000.0) WHERE chave=principal;
   UPDATE public.shrigma_crm_manager_generation_v1 SET state='active',commit_operation_id=opid,committed_at_ms=now_ms WHERE namespace_id=ns AND prepare_operation_id=prepare_id;
   UPDATE public.shrigma_crm_manager_subject_v1 SET active_generation=gen WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
   result:=jsonb_build_object('schema','crm-manager-provision-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
    'state','committed','principalId',principal,'generation',gen,'expectedGeneration',previous,'area','growth','slot','crm-panel-read','role','manager','caps','["read_content","list_history","submission"]'::jsonb,
    'issuedAt',candidate.issued_at_ms,'candidateExpiresAt',candidate.candidate_expires_at_ms,'expiresAt',candidate.expires_at_ms,'prepareOperationId',prepare_id,'committedAt',now_ms,'revokedGeneration',CASE WHEN previous=0 THEN NULL ELSE previous END);
  END IF;
 ELSIF result IS NULL AND rpc='revoke' THEN
  SELECT count(*)::integer INTO revoked_count FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state IN ('prepared','active');
  UPDATE public.shrigma_crm_manager_subject_v1 SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
  UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=coalesce(c.revogada_em,clock_timestamp())
   FROM public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND c.chave=g.principal_id;
  DELETE FROM public.shrigma_panel_permission_v1 p USING public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND p.principal_id=g.principal_id;
  UPDATE public.shrigma_crm_manager_generation_v1 SET state='revoked' WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
  result:=jsonb_build_object('schema','crm-manager-provision-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
   'state','revoked','revocationMode','lifecycle','allGenerationsRevoked',true,'effectiveAt',now_ms,'revokedCount',revoked_count);
 END IF;
 UPDATE public.shrigma_crm_manager_operation_v1 SET response=result WHERE namespace_id=ns AND operation_id=opid AND response IS NULL;
 RETURN result;
END $$;

CREATE FUNCTION public.shrigma_crm_manager_prepare_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.shrigma_crm_manager_apply_v1($1,'prepare') $$;
CREATE FUNCTION public.shrigma_crm_manager_commit_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.shrigma_crm_manager_apply_v1($1,'commit') $$;
CREATE FUNCTION public.shrigma_crm_manager_revoke_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.shrigma_crm_manager_apply_v1($1,'revoke') $$;
CREATE FUNCTION public.shrigma_crm_manager_status_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.shrigma_crm_manager_apply_v1($1,'status') $$;
REVOKE ALL ON FUNCTION public.shrigma_crm_manager_canonical_v1(jsonb),public.shrigma_crm_manager_error_v1(jsonb,uuid,uuid,text),public.shrigma_crm_manager_apply_v1(jsonb,text),
 public.shrigma_crm_manager_prepare_v1(jsonb),public.shrigma_crm_manager_commit_v1(jsonb),public.shrigma_crm_manager_revoke_v1(jsonb),public.shrigma_crm_manager_status_v1(jsonb) FROM PUBLIC;

-- REVIEW FRAGMENT ONLY. Insert AFTER the pinned namespace body and BEFORE
-- the pinned role/ownership body, inside the SAME outer transaction.
-- Admission must already have accepted exactly one default ACL entry:
-- central_leitor SELECT, grantor postgres, without grant option.
-- This changes only relations created by that transaction. No legacy/default ACL.
DO $manager_new_table_acl_guard$
DECLARE target oid;name text;
BEGIN
 IF current_database()<>'listmonk' OR current_user<>'postgres' OR session_user<>'postgres'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED';
 END IF;
 FOREACH name IN ARRAY ARRAY['shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1'] LOOP
  target:=to_regclass('public.'||name);
  IF target IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=target AND c.relkind='r'
   AND c.relpersistence='p' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='postgres'))
   OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid=target AND a.grantee<>c.relowner AND NOT coalesce(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='central_leitor')
     AND a.grantor=c.relowner AND a.privilege_type='SELECT' AND NOT a.is_grantable,false))
   OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) p
    WHERE a.attrelid=target AND a.attnum>0 AND NOT a.attisdropped AND p.grantee<>(SELECT oid FROM pg_roles WHERE rolname='postgres'))
   THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
 END LOOP;
END
$manager_new_table_acl_guard$;
REVOKE SELECT ON TABLE public.shrigma_crm_manager_issuer_v1,
 public.shrigma_crm_manager_subject_v1,public.shrigma_crm_manager_operation_v1,
 public.shrigma_crm_manager_generation_v1 FROM central_leitor;
DO $manager_new_table_acl_closed$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE n.nspname='public' AND c.relname=ANY(ARRAY['shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1'])
   AND a.grantee<>c.relowner) THEN RAISE EXCEPTION USING MESSAGE='MANAGER_INSTALL_REFUSED'; END IF;
END
$manager_new_table_acl_closed$;

-- Original reviewed ownership/role body, same transaction (no intermediate COMMIT).
-- OFFLINE PROPOSAL. Never applied to production by this task.
-- Complement to crm-manager-provision-v1.sql SHA-256
-- be6d670b90cd30977bc0ad2ffd8e7bd2e1d67d58727ef9fa616c2d07c2b813b4.
-- No password, issuer registration, domain, candidate, scheduler or deployment.
-- PUBLIC TEMP / EXECUTE on legacy functions are deliberately preserved. This
-- is scoped RPC authority, not a promise of absolute SQL isolation from PUBLIC.
-- Service remains disabled until its private credential and issuer are admitted.
SET LOCAL search_path=pg_catalog;
DO $$
DECLARE creator oid;target record;item record;object_name text;relation oid;
BEGIN
 SELECT oid INTO creator FROM pg_roles WHERE rolname=current_user AND rolsuper;
 IF creator IS NULL OR current_user<>session_user OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('crm_manager_function_owner_v1','crm_manager_provisioner'))
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 -- Refuse inherited CREATE or direct access instead of changing legacy ACLs.
 IF EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname NOT LIKE 'pg_%' AND a.grantee=0 AND a.privilege_type='CREATE')
  OR EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CREATE')
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 FOREACH object_name IN ARRAY ARRAY['crm_dash_chave','shrigma_panel_permission_v1','shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1'] LOOP
  SELECT c.oid,c.relowner,c.relkind,c.relpersistence INTO target FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=object_name;
  IF NOT FOUND OR target.relkind<>'r' OR target.relpersistence<>'p' THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
  relation:=target.oid;
  IF object_name LIKE 'shrigma_crm_manager_%' AND (target.relowner<>creator OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation AND NOT tgisinternal))
   THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=relation AND a.grantee=0)
   OR EXISTS(SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(c.attacl)>0 THEN c.attacl END) a WHERE c.attrelid=relation AND c.attnum>0 AND NOT c.attisdropped AND a.grantee=0)
   THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('shrigma_crm_manager_one_prepared_v1','prepared'),('shrigma_crm_manager_one_active_v1','active')
 ) v(name,state) LOOP
  SELECT c.oid,c.relowner,c.relkind,i.indrelid,i.indisunique,i.indisvalid,i.indisready,pg_get_expr(i.indpred,i.indrelid) AS predicate,
   (SELECT array_agg(a.attname::text ORDER BY u.n) FROM unnest(i.indkey::smallint[]) WITH ORDINALITY u(attnum,n) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=u.attnum) AS columns
   INTO target FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid WHERE n.nspname='public' AND c.relname=item.name;
  IF NOT FOUND OR target.relowner<>creator OR target.relkind<>'i' OR target.indrelid<>to_regclass('public.shrigma_crm_manager_generation_v1')
   OR NOT target.indisunique OR NOT target.indisvalid OR NOT target.indisready OR target.columns IS DISTINCT FROM ARRAY['namespace_id','user_id','lifecycle_id']
   OR target.predicate IS DISTINCT FROM format('(state = %L::text)',item.state)
   THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 END LOOP;
 -- Match the exact reviewed function bodies, signatures and safe search_path.
 -- Hashes are of public source text, not credentials or database rows.
 FOR item IN SELECT * FROM (VALUES
  ('public.shrigma_crm_manager_canonical_v1(jsonb)','text','plpgsql',false,'i','df2d60c5e39ac10051d4a71c0227be342a07a3da7f0691914d9f8c4cbd4867f7'),
  ('public.shrigma_crm_manager_error_v1(jsonb,uuid,uuid,text)','jsonb','sql',false,'i','a2e92afeaef24a814c2bb688119236b817fae30cf491f362d2c8864a4c78be95'),
  ('public.shrigma_crm_manager_apply_v1(jsonb,text)','jsonb','plpgsql',false,'v','90d6981a955d281b3081996117aeb20fe5b3fc31db5a18b5f8f56d3808a6be2c'),
  ('public.shrigma_crm_manager_prepare_v1(jsonb)','jsonb','sql',true,'v','216adf1b068c0730ebec154e112d1ad6acf359891830fc279098a53e2b68ea27'),
  ('public.shrigma_crm_manager_commit_v1(jsonb)','jsonb','sql',true,'v','f752955042bcbb70018a04d89e6557c5331224ae69f9305162ba78fe0729c832'),
  ('public.shrigma_crm_manager_revoke_v1(jsonb)','jsonb','sql',true,'v','e9e6812207b1636288a6a9e189dcaa4c18a4cadfb490d5b5ebff13892989274e'),
  ('public.shrigma_crm_manager_status_v1(jsonb)','jsonb','sql',true,'v','29eaa69ae2633319c4cc6b33c8ccf520cc35e3321227f3c20679e3b619a54b6e')
 ) v(signature,returns,language,definer,volatility,body_sha256) LOOP
  SELECT p.oid,p.proowner,p.prorettype,p.prosecdef,p.provolatile,p.proconfig,l.lanname,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
   INTO target FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure(item.signature);
  IF NOT FOUND OR target.proowner<>creator OR target.prorettype<>to_regtype('pg_catalog.'||item.returns) OR target.prosecdef<>item.definer
   OR target.provolatile::text<>item.volatility OR target.lanname<>item.language OR target.body_sha256<>item.body_sha256
   OR target.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=target.oid AND a.grantee=0)
   THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 END LOOP;
END $$;

CREATE ROLE crm_manager_function_owner_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE crm_manager_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
GRANT USAGE,CREATE ON SCHEMA public TO crm_manager_function_owner_v1;
GRANT USAGE ON SCHEMA public TO crm_manager_provisioner;
ALTER TABLE public.shrigma_crm_manager_issuer_v1 OWNER TO crm_manager_function_owner_v1;
ALTER TABLE public.shrigma_crm_manager_subject_v1 OWNER TO crm_manager_function_owner_v1;
ALTER TABLE public.shrigma_crm_manager_operation_v1 OWNER TO crm_manager_function_owner_v1;
ALTER TABLE public.shrigma_crm_manager_generation_v1 OWNER TO crm_manager_function_owner_v1;
ALTER FUNCTION public.shrigma_crm_manager_canonical_v1(jsonb) OWNER TO crm_manager_function_owner_v1;
ALTER FUNCTION public.shrigma_crm_manager_error_v1(jsonb,uuid,uuid,text) OWNER TO crm_manager_function_owner_v1;
ALTER FUNCTION public.shrigma_crm_manager_apply_v1(jsonb,text) OWNER TO crm_manager_function_owner_v1;
ALTER FUNCTION public.shrigma_crm_manager_prepare_v1(jsonb) OWNER TO crm_manager_function_owner_v1;
ALTER FUNCTION public.shrigma_crm_manager_commit_v1(jsonb) OWNER TO crm_manager_function_owner_v1;
ALTER FUNCTION public.shrigma_crm_manager_revoke_v1(jsonb) OWNER TO crm_manager_function_owner_v1;
ALTER FUNCTION public.shrigma_crm_manager_status_v1(jsonb) OWNER TO crm_manager_function_owner_v1;
REVOKE CREATE ON SCHEMA public FROM crm_manager_function_owner_v1;
GRANT SELECT,INSERT,UPDATE ON TABLE public.crm_dash_chave TO crm_manager_function_owner_v1;
GRANT SELECT,INSERT,DELETE ON TABLE public.shrigma_panel_permission_v1 TO crm_manager_function_owner_v1;
-- The reviewed commit locks a permission row with SELECT FOR UPDATE. PostgreSQL
-- requires UPDATE on at least one column for that lock. Grant only its identity
-- column to the NOLOGIN owner, never caps/area or any column to the service login.
GRANT UPDATE(principal_id) ON TABLE public.shrigma_panel_permission_v1 TO crm_manager_function_owner_v1;
GRANT EXECUTE ON FUNCTION public.shrigma_crm_manager_prepare_v1(jsonb),public.shrigma_crm_manager_commit_v1(jsonb),public.shrigma_crm_manager_revoke_v1(jsonb),public.shrigma_crm_manager_status_v1(jsonb) TO crm_manager_provisioner;

DO $$
DECLARE owner_role oid;login_role oid;
BEGIN
 SELECT oid INTO owner_role FROM pg_roles WHERE rolname='crm_manager_function_owner_v1' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls;
 SELECT oid INTO login_role FROM pg_roles WHERE rolname='crm_manager_provisioner' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=2;
 IF owner_role IS NULL OR login_role IS NULL OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN (owner_role,login_role))
  OR has_schema_privilege(owner_role,'public','CREATE') OR has_schema_privilege(login_role,'public','CREATE')
  OR EXISTS(SELECT 1 FROM pg_authid WHERE oid IN (owner_role,login_role) AND rolpassword IS NOT NULL)
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
END $$;

COMMIT;
