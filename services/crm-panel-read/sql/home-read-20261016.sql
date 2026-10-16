BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
CREATE FUNCTION public.shrigma_crm_home_read_20261016_v1(p_authorization text,p_origin text,p_query jsonb)
RETURNS TABLE(status_code integer,body jsonb)
LANGUAGE plpgsql VOLATILE
SET search_path=pg_catalog AS $home$
DECLARE r record; compact jsonb;
BEGIN
 -- Delegate once: preserve the installed authentication, revocation and cache.
 FOR r IN SELECT f.status_code,f.body FROM public.shrigma_crm_read_fast_v1(p_authorization,p_origin,p_query) f LOOP
  IF r.status_code<>200 OR jsonb_typeof(r.body) IS DISTINCT FROM 'object' OR p_query->>'action' IS DISTINCT FROM 'cache_growth' THEN
   RETURN QUERY SELECT r.status_code,r.body;
  ELSE
   -- Existing keys only. Missing, null and [] keep their distinct meanings.
   -- Keep whole daily rows across every model, channel and grain: the gateway
   -- validates the complete brand relation before choosing its displayed grain.
   SELECT coalesce(jsonb_object_agg(e.key,
    CASE WHEN e.key='crm_attribution' AND jsonb_typeof(e.value)='object' THEN
     (SELECT coalesce(jsonb_object_agg(a.key,a.value),'{}'::jsonb)
      FROM jsonb_each(e.value) a
      WHERE a.key IN ('schema_version','default_model','money_basis','generated_at','window_days','daily','quality','coverage'))
    ELSE e.value END),'{}'::jsonb)
   INTO compact FROM jsonb_each(r.body) e
   WHERE e.key IN ('gerado_em','_cache_gerado_em','crm_diario','crm_attribution','crm_collection_receipt','crm_fontes','crm_campanha');
   RETURN QUERY SELECT r.status_code,compact;
  END IF;
 END LOOP;
END $home$;
REVOKE ALL ON FUNCTION public.shrigma_crm_home_read_20261016_v1(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shrigma_crm_home_read_20261016_v1(text,text,jsonb) TO crm_panel_reader;
COMMIT;
