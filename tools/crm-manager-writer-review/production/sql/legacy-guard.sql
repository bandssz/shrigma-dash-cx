-- Derived narrowly from pinned READ33a guard; READ state/profile checked separately.
DO $manager_install_guard$
DECLARE proof jsonb;item jsonb;report jsonb;installation jsonb;hba jsonb;auth_scope jsonb;
BEGIN
 IF current_database()<>'listmonk' OR current_user<>'postgres' OR session_user<>'postgres'
  OR current_setting('server_version_num')::int/10000<>17 OR current_setting('transaction_timeout')<>'500ms' THEN RAISE EXCEPTION USING MESSAGE='WRITER_PRODUCTION_REFUSED'; END IF;

WITH execution_context AS MATERIALIZED (
 SELECT current_database()='listmonk' AND current_user='postgres' AND session_user='postgres'
  AND current_setting('transaction_read_only') IN ('off','on') AS verified
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
  (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgisinternal AND g.tgconstraint IN (SELECT x.oid FROM pg_constraint x WHERE (x.conrelid=to_regclass('public.shrigma_panel_permission_v1') AND x.conname='shrigma_panel_permission_v1_principal_id_fkey') OR (z.target='crm_dash_chave' AND x.conrelid IN (to_regclass('public.shrigma_crm_manager_generation_v1'),to_regclass('public.crm_manager_writer_generation_v1')) AND x.conname IN ('shrigma_crm_manager_generation_v1_principal_id_fkey','crm_manager_writer_generation_v1_principal_id_fkey'))) AND g.tgenabled='O' AND NOT g.tgdeferrable AND NOT g.tginitdeferred
   AND (z.target='shrigma_panel_permission_v1' AND ((g.tgfoid=to_regprocedure('pg_catalog."RI_FKey_check_ins"()') AND g.tgtype=5) OR (g.tgfoid=to_regprocedure('pg_catalog."RI_FKey_check_upd"()') AND g.tgtype=17)) OR z.target='crm_dash_chave' AND ((g.tgfoid=to_regprocedure('pg_catalog."RI_FKey_noaction_del"()') AND g.tgtype=9) OR (g.tgfoid=to_regprocedure('pg_catalog."RI_FKey_noaction_upd"()') AND g.tgtype=17)))) AS known_internal_triggers,
  (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgenabled<>'O') AS disabled_triggers,
  (SELECT count(*) FROM pg_rewrite r WHERE r.ev_class=c.oid) AS rewrite_rules,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
  (SELECT count(*) FROM pg_publication_tables p WHERE p.schemaname='public' AND p.tablename=z.target) AS publications,
  (SELECT count(*) FROM pg_constraint fk WHERE fk.confrelid=c.oid AND fk.contype='f' AND NOT coalesce((fk.conrelid=to_regclass('public.shrigma_panel_permission_v1') AND fk.conname='shrigma_panel_permission_v1_principal_id_fkey') OR (z.target='crm_dash_chave' AND fk.conrelid IN (to_regclass('public.shrigma_crm_manager_generation_v1'),to_regclass('public.crm_manager_writer_generation_v1')) AND fk.conname IN ('shrigma_crm_manager_generation_v1_principal_id_fkey','crm_manager_writer_generation_v1_principal_id_fkey')),false)) AS unknown_inbound_fks,
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
  AND ('all'=ANY(h.database) OR 'listmonk'=ANY(h.database)) AND ('all'=ANY(h.user_name) OR 'crm_manager_writer_service_v1'=ANY(h.user_name))
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
  NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')) AS roles_absent,
  NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['crm_manager_writer_issuer_v1','crm_manager_writer_subject_v1','crm_manager_writer_operation_v1','crm_manager_writer_generation_v1','crm_manager_writer_one_prepared_v1','crm_manager_writer_one_active_v1'])) AS relations_absent,
  NOT EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=ANY(ARRAY['crm_manager_writer_issuer_v1','crm_manager_writer_subject_v1','crm_manager_writer_operation_v1','crm_manager_writer_generation_v1'])) AS types_absent,
  NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['crm_manager_writer_canonical_v1','crm_manager_writer_error_v1','crm_manager_writer_apply_v1','crm_manager_writer_prepare_v1','crm_manager_writer_commit_v1','crm_manager_writer_revoke_v1','crm_manager_writer_status_v1'])) AS functions_absent,
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
  current_setting('server_version_num')::int/10000 =17 AS native_supported_family,
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

 IF proof->>'contextVerified' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING MESSAGE='WRITER_PRODUCTION_REFUSED'; END IF;
 installation:=proof#>'{reports,0,rows,0}';hba:=proof#>'{reports,4,rows,0}';
 IF NOT coalesce( (installation->>'native_supported_family')::boolean
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
  THEN RAISE EXCEPTION USING MESSAGE='WRITER_PRODUCTION_REFUSED'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(proof#>'{reports,1,rows}') LOOP
  IF NOT coalesce((item->>'present')::boolean AND (item->>'ordinary_owned')::boolean AND (item->>'rls_off')::boolean
   AND (item->>'no_inheritance')::boolean AND (item->>'columns_ok')::boolean AND (item->>'constraints_ok')::boolean AND (item->>'indexes_ok')::boolean
   AND (item->>'public_relation_acl_clear')::boolean AND (item->>'public_column_acl_clear')::boolean
   AND (item->>'user_triggers')::int=0 AND (item->>'internal_triggers')::int=CASE WHEN item->>'target'='crm_dash_chave' THEN 4+CASE WHEN to_regclass('public.crm_manager_writer_generation_v1') IS NULL THEN 0 ELSE 2 END ELSE 2 END AND (item->>'known_internal_triggers')::int=(item->>'internal_triggers')::int
   AND (item->>'disabled_triggers')::int=0 AND (item->>'rewrite_rules')::int=0 AND (item->>'policies')::int=0
   AND (item->>'publications')::int=0 AND (item->>'unknown_inbound_fks')::int=0 AND (item->>'unknown_columns')::int=0,false)
   THEN RAISE EXCEPTION USING MESSAGE='WRITER_PRODUCTION_REFUSED'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(proof#>'{reports,3,rows}') LOOP
  IF NOT coalesce((item->>'present')::boolean AND (item->>'body_matches')::boolean AND (item->>'mode_matches')::boolean
   AND (item->>'owner_matches')::boolean AND (item->>'search_path_matches')::boolean AND (item->>'language_matches')::boolean
   AND (item->>'signature_matches')::boolean AND (item->>'no_public_execute')::boolean,false)
   THEN RAISE EXCEPTION USING MESSAGE='WRITER_PRODUCTION_REFUSED'; END IF;
 END LOOP;
 -- Existing local/loopback trust is classified, never changed or
 -- treated as proof of the application's origin, TLS or authentication.
 -- The service role below remains NOLOGIN; LOGIN activation is a separate gate.
WITH execution_context AS MATERIALIZED (
 SELECT current_database()='listmonk' AND current_user='postgres' AND session_user='postgres'
  AND current_setting('transaction_read_only') IN ('off','on') AS verified
), candidate_hba AS MATERIALIZED (
 SELECT h.type,h.auth_method,h.address,h.netmask FROM pg_hba_file_rules h
 CROSS JOIN execution_context x WHERE x.verified AND h.error IS NULL
  AND ('all'=ANY(h.database) OR 'listmonk'=ANY(h.database))
  AND ('all'=ANY(h.user_name) OR 'crm_manager_writer_service_v1'=ANY(h.user_name))
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
  THEN RAISE EXCEPTION USING MESSAGE='WRITER_PRODUCTION_REFUSED'; END IF;
END
$manager_install_guard$;
