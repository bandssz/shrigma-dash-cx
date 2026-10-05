-- Additive corporate audience boundary; PREPARED ONLY, no activation/secret.
-- The original native Writer lifecycle and panel permissions remain authority.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='4s';
SET LOCAL lock_timeout='500ms';
DO $admit$
BEGIN
 IF current_user<>session_user OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
  OR to_regprocedure('crm_audience_v2.authenticate_corporate_v1(text,text)') IS NOT NULL
  OR to_regprocedure('public.shrigma_crm_campaign_auth_v1(text)') IS NULL
  OR to_regclass('public.crm_manager_writer_generation_v1') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_audience_api' AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls)
 THEN RAISE EXCEPTION 'CORPORATE_AUDIENCE_AUTH_DEPENDENCY_OR_COLLISION'; END IF;
END $admit$;
CREATE FUNCTION crm_audience_v2.authenticate_corporate_v1(k text,b text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE a jsonb; c public.crm_dash_chave%ROWTYPE; actor text;
BEGIN
 IF b IS NULL OR b NOT IN ('fish','aristo') OR k IS NULL THEN RETURN NULL; END IF;
 a:=public.shrigma_crm_campaign_auth_v1(k);
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR jsonb_typeof(a->'caps') IS DISTINCT FROM 'array'
  OR jsonb_array_length(a->'caps')<>4 OR NOT a->'caps' @> '["read_content","draft","validate","submit"]'::jsonb
  OR coalesce(a->>'actor','') !~ '^panel:[A-Za-z0-9_.:-]{1,194}$' THEN RETURN NULL; END IF;
 -- The live clock must be checked at every call, including after row/advisory
 -- waits. Only one current exact principal is admitted; no owner/ID fallback.
 IF (SELECT count(*) FROM public.crm_dash_chave x WHERE 'panel:'||x.chave=a->>'actor'
  AND x.ativo AND x.revogada_em IS NULL AND (x.expira_em IS NULL OR x.expira_em>clock_timestamp())
  AND (encode(sha256(convert_to(k,'UTF8')),'hex') IN(x.chave_hash,x.chave_hash_curta)
   OR x.chave_hash IS NULL AND x.chave=k))<>1 THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.crm_dash_chave WHERE 'panel:'||chave=a->>'actor';
 IF c.painel='todos' THEN
  -- A legacy Master principal may equal the bearer. Persist only its opaque
  -- namespaced digest in audience rows/receipts; the raw identity stays in RAM.
  actor:='panel:audience-master-'||encode(sha256(convert_to(a->>'actor','UTF8')),'hex');
 ELSE
  IF c.painel<>'growth' OR (SELECT count(*) FROM public.crm_manager_writer_generation_v1 g
   JOIN public.crm_manager_writer_subject_v1 s USING(namespace_id,user_id,lifecycle_id)
   JOIN public.crm_manager_writer_issuer_v1 i USING(namespace_id)
   WHERE g.principal_id=c.chave AND g.state='active' AND s.state='active' AND i.active
    AND s.active_generation=g.generation AND g.brand=b AND s.brand=b
    AND c.dono=s.owner AND g.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint)<>1
   THEN RETURN NULL; END IF;
  actor:=a->>'actor';
 END IF;
 RETURN jsonb_build_object('actor',actor,'caps',a->'caps','brand',b);
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.authenticate_corporate_v1(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_audience_v2.authenticate_corporate_v1(text,text) TO crm_audience_api;
COMMIT;
