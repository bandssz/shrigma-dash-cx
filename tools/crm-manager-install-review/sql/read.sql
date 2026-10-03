-- CRM-only identity/cache reader. Installing this function does not expose it.
-- A separately reviewed workflow role must receive only EXECUTE on this function.
DO $install$
DECLARE auth record; opmeta record;
BEGIN
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 IF current_user <> 'postgres' THEN RAISE EXCEPTION 'CRM_READ_FAST_OWNER_REQUIRED'; END IF;
 SELECT p.proowner::regrole::text owner,p.prosecdef,p.provolatile,p.proconfig,md5(p.prosrc) body_md5,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE') public_execute
 INTO auth FROM pg_proc p WHERE p.oid='public.shrigma_panel_auth_v1(text,text,text)'::regprocedure;
 SELECT p.proowner::regrole::text owner,p.prosecdef,p.provolatile,p.proconfig,md5(p.prosrc) body_md5,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE') public_execute
 INTO opmeta FROM pg_proc p WHERE p.oid='public.shrigma_panel_operator_v1(text,text)'::regprocedure;
 IF auth IS NULL OR auth.owner <> 'postgres' OR auth.prosecdef OR auth.provolatile <> 'v'
    OR auth.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR auth.body_md5 <> '488ee373b461fd61418c0489c42e3df7' OR auth.public_execute THEN
  RAISE EXCEPTION 'CRM_READ_FAST_AUTH_DRIFT';
 END IF;
 IF opmeta IS NULL OR opmeta.owner <> 'postgres' OR opmeta.prosecdef OR opmeta.provolatile <> 's'
    OR opmeta.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR opmeta.body_md5 <> '2092629644f901de260051084d2fb2c2' OR opmeta.public_execute THEN
  RAISE EXCEPTION 'CRM_READ_FAST_OPERATOR_DRIFT';
 END IF;
 IF to_regclass('public.dash_payload_cache') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.dash_payload_cache'::regclass AND c.relkind='r' AND c.relowner::regrole::text='postgres' AND NOT c.relrowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.dash_payload_cache'::regclass AND attname='painel' AND atttypid='text'::regtype AND attnum>0 AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.dash_payload_cache'::regclass AND attname='payload' AND atttypid='jsonb'::regtype AND attnum>0 AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.dash_payload_cache'::regclass AND attname='gerado_em' AND atttypid='timestamp with time zone'::regtype AND attnum>0 AND NOT attisdropped)
    OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
              WHERE c.oid='public.dash_payload_cache'::regclass AND x.grantee=0 AND x.privilege_type='SELECT') THEN
  RAISE EXCEPTION 'CRM_READ_FAST_CACHE_DRIFT';
 END IF;
EXECUTE $ddl$CREATE FUNCTION public.shrigma_crm_read_fast_v1(
 p_authorization text,
 p_origin text,
 p_query jsonb
) RETURNS TABLE(status_code integer,body jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE
 k text;
 action text;
 a record;
 cached record;
 permissions jsonb;
BEGIN
 IF p_origin IS NOT NULL AND p_origin NOT IN ('','https://bandssz.github.io') THEN
  RETURN QUERY SELECT 403,jsonb_build_object('erro','origem não permitida'); RETURN;
 END IF;
 IF p_authorization IS NULL OR p_authorization !~ '^Bearer [a-z0-9-]{8,128}$' THEN
  RETURN QUERY SELECT 401,jsonb_build_object('erro','chave de acesso ausente ou incorreta'); RETURN;
 END IF;
 IF p_query IS NULL OR p_query='null'::jsonb OR jsonb_typeof(p_query) IS DISTINCT FROM 'object' THEN
  RETURN QUERY SELECT 400,jsonb_build_object('erro','consulta inválida'); RETURN;
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_query)) <> 2
    OR NOT (p_query ?& ARRAY['action','painel']) OR p_query->>'painel' IS DISTINCT FROM 'growth'
    OR NOT (coalesce(p_query->>'action','') = ANY(ARRAY['identity','cache_growth'])) THEN
  RETURN QUERY SELECT 400,jsonb_build_object('erro','consulta inválida'); RETURN;
 END IF;
 k:=substr(p_authorization,8); action:=p_query->>'action';
 SELECT * INTO a FROM public.shrigma_panel_auth_v1(k,'growth','header');
 IF NOT FOUND OR a.painel NOT IN ('growth','todos') OR a.efetivo <> 'growth' THEN
  RETURN QUERY SELECT 401,jsonb_build_object('erro','chave de acesso ausente ou incorreta'); RETURN;
 END IF;
 IF action='identity' THEN
  permissions:=jsonb_build_object(
   'growth',public.shrigma_panel_operator_v1(k,'growth'),
   'influs',public.shrigma_panel_operator_v1(k,'influs')
  );
  RETURN QUERY SELECT 200,jsonb_build_object(
   'schema','shrigma_access_identity_v1',
   'role',CASE WHEN a.painel='todos' THEN 'master' ELSE 'manager' END,
   'panel',a.painel,
   'owner',a.dono,
   'permissions',permissions,
   'allowedPanels',CASE WHEN a.painel='todos' THEN jsonb_build_array('cx','growth','organico','influs') ELSE jsonb_build_array('growth') END
  ); RETURN;
 END IF;
 SELECT c.payload,c.gerado_em INTO cached FROM public.dash_payload_cache c WHERE c.painel='growth';
 IF NOT FOUND OR jsonb_typeof(cached.payload) <> 'object' THEN
  RETURN QUERY SELECT 503,jsonb_build_object('erro','cache indisponível'); RETURN;
 END IF;
 RETURN QUERY SELECT 200,cached.payload || jsonb_build_object('_painel',a.painel,'_cache_gerado_em',cached.gerado_em);
END $function$;$ddl$;
REVOKE ALL ON FUNCTION public.shrigma_crm_read_fast_v1(text,text,jsonb) FROM PUBLIC;

END $install$;
