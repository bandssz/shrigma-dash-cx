-- Source must be restored/drained before this guarded function-only return.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $freeze_return$ DECLARE e record;p record;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'FREEZE_RETURN_ROLE';END IF;
 FOR e IN SELECT * FROM jsonb_to_recordset('[{"signature":"crm_audience_v2.shopify_native_members_20261017(jsonb,text,integer,jsonb)","body_md5":"7e189747ece488031da6173487b2aaea","acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.shopify_native_flat_members_20261017(jsonb,text,integer,jsonb)","body_md5":"513d1b470a3313c1367e8a9fc363ad2e","acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.freeze_native_internal_saved_audience_20261017(text,text,uuid,integer,text,text,text,jsonb,jsonb,text,text)","body_md5":"bd6a5bf2891da92212422a54ee12b6f9","acl":"{postgres=X/postgres,crm_audience_api=X/postgres}"}]'::jsonb)x(signature text,body_md5 text,acl text) LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e.signature);
  IF md5(p.prosrc) IS DISTINCT FROM e.body_md5 OR p.proacl::text IS DISTINCT FROM e.acl OR pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] THEN RAISE EXCEPTION 'FREEZE_RETURN_DRIFT';END IF;
 END LOOP;END $freeze_return$;
DROP FUNCTION crm_audience_v2.freeze_native_internal_saved_audience_20261017(text,text,uuid,integer,text,text,text,jsonb,jsonb,text,text);
DROP FUNCTION crm_audience_v2.shopify_native_flat_members_20261017(jsonb,text,integer,jsonb);
DROP FUNCTION crm_audience_v2.shopify_native_members_20261017(jsonb,text,integer,jsonb);
COMMIT;
