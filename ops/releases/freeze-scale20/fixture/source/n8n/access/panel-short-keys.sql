-- Optional shorter bearer, same principal/grants/receipts. Existing keys stay valid during transition.
ALTER TABLE public.crm_dash_chave ADD COLUMN IF NOT EXISTS chave_hash_curta text;
CREATE UNIQUE INDEX IF NOT EXISTS crm_dash_chave_curta_uq ON public.crm_dash_chave(chave_hash_curta) WHERE chave_hash_curta IS NOT NULL;

CREATE OR REPLACE FUNCTION public.shrigma_panel_auth_v1(p_key text,p_requested text,p_transport text)
RETURNS TABLE(painel text,dono text,efetivo text)
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 WITH accepted AS (
  UPDATE public.crm_dash_chave c SET ultimo_uso=now(),usos=coalesce(c.usos,0)+1
  WHERE c.ativo AND c.revogada_em IS NULL AND (c.expira_em IS NULL OR c.expira_em>now())
    AND p_key ~ '^[a-z0-9-]{8,128}$'
    AND p_requested IN ('','cx','growth','organico','influs','todos')
    AND c.painel IN ('cx','growth','organico','influs','todos')
    AND (p_requested='' OR c.painel='todos' OR c.painel=p_requested)
    AND ((c.chave_hash IS NOT NULL AND p_transport='header'
          AND encode(sha256(convert_to(p_key,'UTF8')),'hex') IN (c.chave_hash,c.chave_hash_curta))
      OR (c.chave_hash IS NULL AND c.chave=p_key))
  RETURNING c.painel,c.dono,CASE WHEN c.painel='todos' AND p_requested<>'' THEN p_requested ELSE c.painel END AS efetivo
 )
 SELECT a.painel,a.dono,a.efetivo FROM accepted a;
$$;
REVOKE ALL ON FUNCTION public.shrigma_panel_auth_v1(text,text,text) FROM PUBLIC;


CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('who','panel:'||c.chave,'label',c.dono,'caps',p.caps)
 FROM public.crm_dash_chave c JOIN public.shrigma_panel_permission_v1 p ON p.principal_id=c.chave
 WHERE p.area=a AND c.painel IN (a,'todos') AND c.ativo AND c.revogada_em IS NULL
 AND (c.expira_em IS NULL OR c.expira_em>now()) AND c.chave_hash IS NOT NULL
 AND k ~ '^[a-z0-9-]{8,128}$' AND encode(sha256(convert_to(k,'UTF8')),'hex') IN (c.chave_hash,c.chave_hash_curta)
$$;
REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shrigma_template_auth_v2(k text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
 SELECT auth FROM (
  SELECT jsonb_build_object('who',actor,'caps',capabilities) AS auth,1 AS priority
  FROM shrigma_template_key_v2 WHERE active AND key_hash=encode(sha256(convert_to(k,'UTF8')),'hex')
  UNION ALL
  SELECT jsonb_build_object('who','growth:'||coalesce(dono,'leitura'),'caps',jsonb_build_array('read_content','list_history','submission')),2
  FROM crm_dash_chave WHERE ativo AND revogada_em IS NULL AND (expira_em IS NULL OR expira_em>now()) AND painel IN ('growth','todos') AND ((chave_hash IS NULL AND chave=k) OR (chave_hash IS NOT NULL AND encode(sha256(convert_to(k,'UTF8')),'hex') IN (chave_hash,chave_hash_curta)))
 ) a ORDER BY priority LIMIT 1
$function$
;
