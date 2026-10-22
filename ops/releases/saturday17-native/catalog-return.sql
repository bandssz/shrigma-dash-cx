-- Prepared only; fixed function, no customer/list/campaign writes.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $fence$ DECLARE p record;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'CATALOG_INSTALLER_ROLE_REFUSED';END IF;
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='crm_audience_v2.catalog_lists(text)'::regprocedure;
 IF md5(p.prosrc)<>'6fe4bb26f69541310f986f2a7fb459bd' OR p.provolatile<>'v' OR NOT p.prosecdef
  OR pg_get_userbyid(p.proowner)<>'postgres' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
  OR pg_get_function_result(p.oid)<>'TABLE(id integer, name text, status text, optin text)'
  OR NOT has_function_privilege('crm_audience_api',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
   WHERE a.privilege_type<>'EXECUTE' OR a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='crm_audience_api') OR a.is_grantable))
 THEN RAISE EXCEPTION 'CATALOG_SOURCE_OR_ACL_DRIFT';END IF;
END $fence$;
CREATE OR REPLACE FUNCTION crm_audience_v2.catalog_lists(b text)
 RETURNS TABLE(id integer, name text, status text, optin text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT l.id,l.name::text,l.status::text,l.optin::text FROM public.lists l
 WHERE b IN ('fish','aristo') AND public.shrigma_campaign_list_brand(l)=b
 ORDER BY l.id LIMIT 1001 FOR SHARE OF l
 $function$;
DO $fence$ DECLARE p record;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'CATALOG_INSTALLER_ROLE_REFUSED';END IF;
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='crm_audience_v2.catalog_lists(text)'::regprocedure;
 IF md5(p.prosrc)<>'595fec51aecb7633872d451dc0f0b56f' OR p.provolatile<>'v' OR NOT p.prosecdef
  OR pg_get_userbyid(p.proowner)<>'postgres' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
  OR pg_get_function_result(p.oid)<>'TABLE(id integer, name text, status text, optin text)'
  OR NOT has_function_privilege('crm_audience_api',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
   WHERE a.privilege_type<>'EXECUTE' OR a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='crm_audience_api') OR a.is_grantable))
 THEN RAISE EXCEPTION 'CATALOG_SOURCE_OR_ACL_DRIFT';END IF;
END $fence$;
COMMIT;
