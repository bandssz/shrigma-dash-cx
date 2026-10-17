-- OFFLINE PROPOSAL. Never applied to production by this task.
-- Complement to crm-manager-provision-v1.sql SHA-256
-- be6d670b90cd30977bc0ad2ffd8e7bd2e1d67d58727ef9fa616c2d07c2b813b4.
-- No password, issuer registration, domain, candidate, scheduler or deployment.
-- PUBLIC TEMP / EXECUTE on legacy functions are deliberately preserved. This
-- is scoped RPC authority, not a promise of absolute SQL isolation from PUBLIC.
-- Service remains disabled until its private credential and issuer are admitted.
BEGIN;
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
CREATE ROLE crm_manager_provisioner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
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
 SELECT oid INTO login_role FROM pg_roles WHERE rolname='crm_manager_provisioner' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=2;
 IF owner_role IS NULL OR login_role IS NULL OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN (owner_role,login_role))
  OR has_schema_privilege(owner_role,'public','CREATE') OR has_schema_privilege(login_role,'public','CREATE')
  OR EXISTS(SELECT 1 FROM pg_authid WHERE oid IN (owner_role,login_role) AND rolpassword IS NOT NULL)
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
END $$;
COMMIT;
