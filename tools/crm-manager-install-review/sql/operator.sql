-- Explicit area grants. Existing read credentials and legacy writer identities stay valid.
CREATE TABLE IF NOT EXISTS public.shrigma_panel_permission_v1 (
 principal_id text NOT NULL REFERENCES public.crm_dash_chave(chave),
 area text NOT NULL CHECK(area IN ('growth','influs')),
 caps jsonb NOT NULL CHECK(jsonb_typeof(caps)='array'),
 PRIMARY KEY(principal_id,area)
);
REVOKE ALL ON public.shrigma_panel_permission_v1 FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('who','panel:'||c.chave,'label',c.dono,'caps',p.caps)
 FROM public.crm_dash_chave c JOIN public.shrigma_panel_permission_v1 p ON p.principal_id=c.chave
 WHERE p.area=a AND c.painel IN (a,'todos') AND c.ativo AND c.revogada_em IS NULL
 AND (c.expira_em IS NULL OR c.expira_em>now()) AND c.chave_hash IS NOT NULL
 AND k ~ '^[a-z0-9-]{8,128}$' AND c.chave_hash=encode(sha256(convert_to(k,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;
-- Separate name avoids a late historical read-auth migration replacing operator grants.
CREATE OR REPLACE FUNCTION public.shrigma_crm_operator_auth_v1(k text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(public.shrigma_panel_operator_v1(k,'growth'),public.shrigma_template_auth_v2(k))
$$;
REVOKE ALL ON FUNCTION public.shrigma_crm_operator_auth_v1(text) FROM PUBLIC;
