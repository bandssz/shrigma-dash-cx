-- CRM · Wrapper do gateway para campanha_operacao_abandonar (DESLIGADO).
-- PROPOSTA. Aplicar só DEPOIS de crm-campaign-gateway-role.sql e
-- campaign-pending-recovery.sql; nunca fora da sequência do documento
-- docs/crm/RECUPERACAO-TENTATIVAS-PENDENTES-20261003.md.
-- Não altera shrigma_crm_campaign_effect_v1 nem shrigma_crm_campaign_auth_v1.
-- crm_campaign_api recebe só EXECUTE neste wrapper; nada de tabela.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $check$ BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_OWNER_REQUIRED'; END IF;
 IF to_regprocedure('public.shrigma_crm_campaign_auth_v1(text)') IS NULL OR to_regprocedure('public.shrigma_campaign_abandon(jsonb)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_campaign_api') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_DEPENDENCY_MISSING'; END IF;
END $check$;

CREATE OR REPLACE FUNCTION public.shrigma_crm_campaign_abandon_v1(p_key text,p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE auth jsonb;
BEGIN
 auth:=public.shrigma_crm_campaign_auth_v1(p_key);
 IF auth IS NULL THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_UNAUTHORIZED'; END IF;
 -- Mesma capability de agendar/cancelar; ator vem da chave, nunca do corpo.
 IF NOT (auth->'caps' ? 'submit') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_FORBIDDEN'; END IF;
 IF jsonb_typeof(p_command) IS DISTINCT FROM 'object'
  OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_command) k) IS DISTINCT FROM ARRAY['acao','brand','confirm','idempotency_key','operation_action']
  OR p_command->>'acao' IS DISTINCT FROM 'campanha_operacao_abandonar' OR p_command->>'confirm' IS DISTINCT FROM 'abandonar'
  OR jsonb_typeof(p_command->'idempotency_key') IS DISTINCT FROM 'string' OR jsonb_typeof(p_command->'brand') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_command->'operation_action') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'ABANDON_INPUT'; END IF;
 RETURN public.shrigma_campaign_abandon(jsonb_build_object('actor',auth->>'actor','key',p_command->>'idempotency_key',
  'brand',p_command->>'brand','action',p_command->>'operation_action'));
END $fn$;
REVOKE ALL ON FUNCTION public.shrigma_crm_campaign_abandon_v1(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shrigma_crm_campaign_abandon_v1(text,jsonb) TO crm_campaign_api;
COMMIT;
