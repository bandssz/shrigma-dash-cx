'use strict';
// Effective privileges, including inherited/PUBLIC and SET ROLE powers. No
// credential values, rows, mutations or grants are part of this preflight.
const matrix=require('./runtime-grants.cjs').describe(),tableNames=matrix.map(x=>"'"+x.table+"'").join(',');
const relationPrivileges=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
const requiredValues=matrix.map(x=>"('"+x.table+"','"+x.privileges.join(',')+"','"+relationPrivileges.filter(p=>!x.privileges.includes(p)).join(',')+"')").join(',');
const privilegeColumns=`
 NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS least_role,
 coalesce(NOT pg_catalog.has_schema_privilege(current_user,(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='dashboard_identity'),'CREATE'),false)
  AND NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) AS no_ddl,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles p WHERE (p.rolsuper OR p.rolcreatedb OR p.rolcreaterole OR p.rolreplication OR p.rolbypassrls
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=p.oid AND n.nspname!~'^pg_' AND n.nspname<>'information_schema')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=p.oid AND n.nspname!~'^pg_' AND n.nspname<>'information_schema')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid=f.pronamespace WHERE f.proowner=p.oid AND n.nspname!~'^pg_' AND n.nspname<>'information_schema')
  OR pg_catalog.pg_has_role(p.oid,'pg_database_owner','USAGE')) AND pg_catalog.pg_has_role(current_user,p.oid,'SET')) AS no_set_owner,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_'
  AND n.nspname NOT IN('information_schema','dashboard_identity') AND c.relkind IN('r','p','v','m','f')
  AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') AND (pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_other_app_tables,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname!~'^pg_'
  AND n.nspname<>'information_schema' AND p.prosecdef
  AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) AS no_other_security_definer,
 NOT EXISTS(SELECT 1 FROM (VALUES ${requiredValues}) admitted(table_name,required,forbidden)
  WHERE pg_catalog.to_regclass('dashboard_identity.'||admitted.table_name) IS NULL
  OR EXISTS(SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(admitted.required,',')) needed(privilege) WHERE NOT pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('dashboard_identity.'||admitted.table_name),needed.privilege))
  OR pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('dashboard_identity.'||admitted.table_name),admitted.forbidden)
  OR EXISTS(SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(admitted.forbidden,',')) denied(privilege) WHERE denied.privilege IN('SELECT','INSERT','UPDATE','REFERENCES') AND pg_catalog.has_any_column_privilege(current_user,pg_catalog.to_regclass('dashboard_identity.'||admitted.table_name),denied.privilege))
  OR pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('dashboard_identity.'||admitted.table_name),'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION,MAINTAIN WITH GRANT OPTION')
  OR pg_catalog.has_any_column_privilege(current_user,pg_catalog.to_regclass('dashboard_identity.'||admitted.table_name),'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION')) AS runtime_dml_bounded,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dashboard_identity'
  AND c.relkind IN('r','p','v','m','f') AND c.relname NOT IN(${tableNames},'_migration_v1','_sqlite_row_order_v1')
  AND (pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_extra_identity_tables,
 coalesce(pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._migration_v1'),'SELECT')
  AND NOT pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._migration_v1'),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION')
  AND NOT pg_catalog.has_any_column_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._migration_v1'),'INSERT,UPDATE,REFERENCES,SELECT WITH GRANT OPTION'),false) AS receipt_read_only,
 coalesce(pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._sqlite_row_order_v1'),'SELECT')
  AND pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._sqlite_row_order_v1'),'INSERT')
  AND NOT pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._sqlite_row_order_v1'),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION')
  AND NOT pg_catalog.has_any_column_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._sqlite_row_order_v1'),'UPDATE,REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION'),false) AS ledger_append_only,
 coalesce(pg_catalog.has_sequence_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._writer_rowid_seq_v1'),'USAGE')
  AND NOT pg_catalog.has_sequence_privilege(current_user,pg_catalog.to_regclass('dashboard_identity._writer_rowid_seq_v1'),'SELECT,UPDATE,USAGE WITH GRANT OPTION'),false) AS ordinal_usage_only`;
const loggingColumns="current_setting('log_statement')='none' AND current_setting('log_min_messages')='panic' AND current_setting('log_min_error_statement')='panic' AND current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0' AND current_setting('log_min_duration_statement')='-1' AND current_setting('log_min_duration_sample')='-1' AND current_setting('log_transaction_sample_rate')::numeric=0 AS private_logs";
const contextSQL="SELECT current_database()='listmonk' AS database_ok,current_user=session_user AND current_user=$1 AS actor_ok,current_setting('server_version_num')::integer/10000=17 AS version_ok,current_setting('transaction_read_only')='off' AS writable,current_setting('search_path')='pg_catalog' AS path_ok,"+loggingColumns+","+privilegeColumns+" FROM pg_catalog.pg_roles r WHERE r.rolname=current_user";
const readOnlySQL="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL search_path=pg_catalog;SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='500ms';\nSELECT current_database()='listmonk' AS database_ok,current_setting('server_version_num')::integer/10000=17 AS pg17,current_setting('transaction_read_only')='on' AS read_only,current_setting('search_path')='pg_catalog' AS catalog_path,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(current_user::text,'UTF8')),'hex') AS actor_sha256,"+loggingColumns+","+privilegeColumns+" FROM pg_catalog.pg_roles r WHERE r.rolname=current_user;\nROLLBACK;\n";
module.exports={privilegeColumns,loggingColumns,contextSQL,readOnlySQL};
if(require.main===module)require('node:fs').writeFileSync(require('node:path').join(__dirname,'runtime-profile-ro.sql'),readOnlySQL);
