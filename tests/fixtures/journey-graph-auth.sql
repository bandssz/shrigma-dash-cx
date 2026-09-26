-- Disposable tests only. Install the unmodified manager helper against synthetic rows.
CREATE TABLE public.crm_dash_chave (
 chave text PRIMARY KEY, painel text NOT NULL, dono text NOT NULL,
 ativo boolean NOT NULL DEFAULT true, revogada_em timestamptz,
 expira_em timestamptz, chave_hash text, chave_hash_curta text
);
-- The legacy fallback is deliberately tempting; the draft API must not call it.
CREATE FUNCTION public.shrigma_template_auth_v2(text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT '{"who":"legacy-writer","caps":["draft","read_content"]}'::jsonb
$$;
