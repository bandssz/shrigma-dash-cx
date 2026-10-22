'use strict';
// Catalog metadata only: never rows of auth/issuer, function bodies, passwords,
// connection strings, HBA file contents or raw log settings.
const INVENTORY=`SELECT jsonb_build_object(
 'database',current_database(),'sessionRole',session_user,'currentRole',current_user,
 'engine',current_setting('server_version_num')::integer,
 'runtimeInstallationRights',coalesce((SELECT has_database_privilege(v.oid,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND (n.nspowner=v.oid OR has_schema_privilege(v.oid,n.oid,'CREATE'))) FROM pg_roles v WHERE v.rolname=$4),true),
 'installerSuper',r.rolsuper,'installerCreateRole',r.rolcreaterole,
 'databaseCreate',has_database_privilege(current_user,current_database(),'CREATE'),
 'databaseOwner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
 'ownSchema',(SELECT jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'create',has_schema_privilege(current_user,n.oid,'CREATE'),
  'otherCreate',EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner AND a.privilege_type='CREATE')) FROM pg_namespace n WHERE n.nspname=$1),
 'publicCreate',has_schema_privilege(current_user,'public','CREATE'),
 'publicCreateExposed',EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname NOT LIKE 'pg_%' AND a.grantee=0 AND a.privilege_type='CREATE'),
 'databaseCreateExposed',EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CREATE'),
 'security',jsonb_build_object('tls',coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false),'statementLoggingOff',current_setting('log_statement')='none','parameterLoggingOff',current_setting('log_parameter_max_length')='0','errorParameterLoggingOff',current_setting('log_parameter_max_length_on_error')='0'),
 'relations',coalesce((SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'persistent',c.relpersistence='p','rls',c.relrowsecurity OR c.relforcerowsecurity,'partition',c.relispartition,
  'triggers',EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'inheritance',EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'publicAccess',EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0),
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) ORDER BY c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($2::text[])),'[]'::jsonb),
 'functions',coalesce((SELECT jsonb_agg(jsonb_build_object('name',p.proname,'argumentTypes',oidvectortypes(p.proargtypes),'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'safeSearchPath',coalesce(p.proconfig=ARRAY['search_path=pg_catalog, pg_temp'],false),'configSha256',encode(sha256(convert_to(coalesce(p.proconfig::text,''),'UTF8')),'hex'),
 'publicExecute',EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0)) ORDER BY p.proname,p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($2::text[])),'[]'::jsonb),
 'types',coalesce((SELECT jsonb_agg(t.typname ORDER BY t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=ANY($2::text[])),'[]'::jsonb),
 'roles',coalesce((SELECT jsonb_agg(jsonb_build_object('name',v.rolname,'login',v.rolcanlogin,'super',v.rolsuper,'createDB',v.rolcreatedb,'createRole',v.rolcreaterole,'inherit',v.rolinherit,'replication',v.rolreplication,'bypassRls',v.rolbypassrls,'memberships',(SELECT count(*) FROM pg_auth_members a WHERE a.member=v.oid)) ORDER BY v.rolname) FROM pg_roles v WHERE v.rolname=ANY($3::text[])),'[]'::jsonb),
 'defaultGrants',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',coalesce(n.nspname,'global'),'kind',d.defaclobjtype,'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY d.oid,a.grantee,a.privilege_type) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole=r.oid AND (d.defaclnamespace=0 OR n.nspname IN ('public',$1)) AND a.grantee<>d.defaclrole),'[]'::jsonb),
 'otherPublicRelationCount',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT c.relname=ANY($2::text[])),
 'ledger',(SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'persistent',c.relpersistence='p','rls',c.relrowsecurity OR c.relforcerowsecurity,
 'triggers',EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'inheritance',EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
 'otherAccess',EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner) OR EXISTS(SELECT 1 FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a WHERE at.attrelid=c.oid AND a.grantee<>c.relowner),
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('kind',k.contype,'sha256',encode(sha256(convert_to(pg_get_constraintdef(k.oid),'UTF8')),'hex')) ORDER BY k.contype,k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='migration_operation_v1')
 ) AS inventory FROM pg_roles r WHERE r.rolname=current_user`;
const BEGIN_WRITE='BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE',BEGIN_READ='BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY';
const LIMITS="SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL search_path=pg_catalog";
const LOCK='SELECT pg_advisory_xact_lock($1::integer,$2::integer) AS locked';
const quoted=s=>'"'+s+'"'; // called only after strict ASCII identifier validation
function ledger(schema){const name=quoted(schema)+'."migration_operation_v1"';return Object.freeze({
 create:`CREATE TABLE ${name} (operation_id uuid PRIMARY KEY,migration_id text NOT NULL UNIQUE,source_sha256 text NOT NULL,request_sha256 text NOT NULL,target_sha256 text NOT NULL,manifest_sha256 text NOT NULL,state text NOT NULL CHECK(state IN ('attempted','applied')),attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),applied_at timestamptz); REVOKE ALL ON TABLE ${name} FROM PUBLIC`,
 find:`SELECT operation_id::text,migration_id,source_sha256,request_sha256,target_sha256,manifest_sha256,state,floor(extract(epoch FROM attempted_at)*1000)::text AS attempted_at,CASE WHEN applied_at IS NULL THEN NULL ELSE floor(extract(epoch FROM applied_at)*1000)::text END AS applied_at FROM ${name} WHERE operation_id=$1::uuid OR migration_id=$2 ORDER BY operation_id FOR UPDATE`,
 status:`SELECT operation_id::text,migration_id,source_sha256,request_sha256,target_sha256,manifest_sha256,state,floor(extract(epoch FROM attempted_at)*1000)::text AS attempted_at,CASE WHEN applied_at IS NULL THEN NULL ELSE floor(extract(epoch FROM applied_at)*1000)::text END AS applied_at FROM ${name} WHERE operation_id=$1::uuid`,
 dependencies:`SELECT migration_id,source_sha256,state FROM ${name} WHERE migration_id=ANY($1::text[])`,
 insert:`INSERT INTO ${name}(operation_id,migration_id,source_sha256,request_sha256,target_sha256,manifest_sha256,state) VALUES($1::uuid,$2,$3,$4,$5,$6,'attempted') RETURNING operation_id::text,migration_id,source_sha256,request_sha256,target_sha256,manifest_sha256,state,floor(extract(epoch FROM attempted_at)*1000)::text AS attempted_at,CASE WHEN applied_at IS NULL THEN NULL ELSE floor(extract(epoch FROM applied_at)*1000)::text END AS applied_at`,
 applied:`UPDATE ${name} SET state='applied',applied_at=clock_timestamp() WHERE operation_id=$1::uuid AND request_sha256=$2 AND state='attempted' RETURNING operation_id::text,migration_id,source_sha256,request_sha256,target_sha256,manifest_sha256,state,floor(extract(epoch FROM attempted_at)*1000)::text AS attempted_at,CASE WHEN applied_at IS NULL THEN NULL ELSE floor(extract(epoch FROM applied_at)*1000)::text END AS applied_at`
 });}
module.exports=Object.freeze({INVENTORY,BEGIN_WRITE,BEGIN_READ,LIMITS,LOCK,ledger});
