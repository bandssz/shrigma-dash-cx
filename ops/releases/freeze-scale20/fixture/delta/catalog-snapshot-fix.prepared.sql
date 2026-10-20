-- Prepared only; fixed function, no customer/list/campaign writes.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
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
CREATE OR REPLACE FUNCTION crm_audience_v2.catalog_lists(b text)
RETURNS TABLE(id integer,name text,status text,optin text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $catalog_snapshot$
 SELECT l.id,l.name::text,l.status::text,l.optin::text FROM public.lists l
 WHERE b IN ('fish','aristo') AND public.shrigma_campaign_list_brand(l)=b
 AND NOT EXISTS (
  SELECT 1 FROM crm_audience_v2.request r
  CROSS JOIN LATERAL (SELECT r.response->'_body' v) x
  WHERE r.brand=b AND r.payload->>'acao'='segmento_congelar_nativo_interno'
   AND r.payload->>'brand'=b AND r.payload->>'idempotency_key'=r.operation_key
   AND r.response->'_http'='200'::jsonb
   AND x.v->>'contract'='crm-native-frozen-internal-list-v2'
   AND x.v->>'brand'=b AND x.v->'internal_test'='true'::jsonb
   AND x.v->'schedules'='false'::jsonb AND x.v->'sends'='false'::jsonb
   AND x.v->'eligible_count'='1'::jsonb
   AND x.v->>'list_id'=l.id::text AND x.v->>'list_uuid'=l.uuid::text
   AND x.v->>'audience_id'=r.payload->>'id'
   AND x.v->'audience_version'=r.payload->'expected_version'
   AND x.v->>'definition_hash'=r.payload->>'expected_definition_hash'
   AND x.v->>'definition_hash'~'^[a-f0-9]{64}$'
   AND r.payload->>'expected_context_hash'~'^[a-f0-9]{64}$'
   AND r.payload->>'expected_catalog_hash'~'^[a-f0-9]{64}$'
   AND r.payload_hash=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((
    SELECT '{'||pg_catalog.string_agg(pg_catalog.to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}'
    FROM pg_catalog.jsonb_each(r.payload)e(k,v)
   ),'UTF8')),'hex')
   AND x.v->>'members_sha256'=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('[26948228]','UTF8')),'hex')
   AND l.type::text='private' AND l.optin::text='double' AND l.status::text='active'
   AND (SELECT pg_catalog.count(*) FROM public.subscriber_lists sl WHERE sl.list_id=l.id)=1
   AND EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.list_id=l.id AND sl.subscriber_id=26948228 AND sl.status::text='confirmed')
 )
 ORDER BY l.id LIMIT 1001 FOR SHARE OF l
 $catalog_snapshot$;
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
COMMIT;
