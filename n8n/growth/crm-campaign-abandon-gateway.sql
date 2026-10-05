-- CRM · Wrapper do gateway para campanha_operacao_abandonar (DESLIGADO).
-- PROPOSTA. Aplicar só DEPOIS de crm-campaign-gateway-role.sql e
-- campaign-pending-recovery.sql; nunca fora da sequência do documento
-- docs/crm/RECUPERACAO-TENTATIVAS-PENDENTES-20261003.md.
-- Não altera shrigma_crm_campaign_effect_v1 nem shrigma_crm_campaign_auth_v1.
-- crm_campaign_api recebe só EXECUTE neste wrapper; nada de tabela.
-- Recusa qualquer desvio ANTES de qualquer DDL: auth_v1, effect_v1 e a função interna
-- shrigma_campaign_abandon precisam bater exatamente (md5 do corpo, dono, SECURITY,
-- volatilidade, linguagem, retorno, proconfig, ACL). Wrapper já existente só é aceito se
-- for exatamente este (reinstalação = no-op); homônimo alheio/divergente é recusado.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $install$
DECLARE d record; r record; present integer; pass integer;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_OWNER_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_campaign_api') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_DEPENDENCY_MISSING crm_campaign_api'; END IF;
 FOR pass IN 1..2 LOOP
  present:=0;
  FOR d IN SELECT * FROM (VALUES
    ('dep','public.shrigma_crm_campaign_auth_v1(text)','6195c421dedb3f63a0c933f5d90fddd9',true,ARRAY['search_path=pg_catalog, public'],'crm_campaign_api:EXECUTE,postgres:EXECUTE'),
    ('dep','public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb)','33ed94af3e5872454e4aa780780b9919',true,ARRAY['search_path=pg_catalog, public'],'crm_campaign_api:EXECUTE,postgres:EXECUTE'),
    ('dep','public.shrigma_campaign_abandon(jsonb)','72bd1f5ec9aba153f1bbc0b5848fb362',false,ARRAY['search_path=pg_catalog, public','lock_timeout=3s'],'postgres:EXECUTE'),
    ('own','public.shrigma_crm_campaign_abandon_v1(text,jsonb)','e0854d0a6555efac1d06e24e9d1a795e',true,ARRAY['search_path=pg_catalog, public'],'crm_campaign_api:EXECUTE,postgres:EXECUTE')
   ) v(kind,sig,body_md5,definer,config,acl)
  LOOP
   SELECT p.proowner::regrole::text AS owner,p.prosecdef,p.provolatile,p.prokind,l.lanname,p.prorettype::regtype::text AS ret,p.proconfig,md5(p.prosrc) AS body_md5,
    (SELECT string_agg(x.grantee::regrole::text||':'||x.privilege_type||CASE WHEN x.is_grantable THEN '*' ELSE '' END,',' ORDER BY x.grantee::regrole::text,x.privilege_type)
     FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x) AS acl
   INTO r FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure(d.sig);
   IF NOT FOUND THEN
    IF d.kind='dep' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_DEPENDENCY_MISSING %',d.sig; END IF;
    CONTINUE;
   END IF;
   IF (r.owner,r.prosecdef,r.provolatile,r.prokind,r.lanname,r.ret,r.proconfig,r.body_md5,r.acl)
    IS DISTINCT FROM ('postgres',d.definer,'v'::"char",'f'::"char",'plpgsql','jsonb',d.config,d.body_md5,d.acl) THEN
    IF d.kind='own' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_OBJECT_COLLISION %',d.sig; END IF;
    RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_DEPENDENCY_DRIFT %',d.sig;
   END IF;
   IF d.kind='own' THEN present:=present+1; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='shrigma_crm_campaign_abandon_v1')<>present THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_OBJECT_COLLISION overload'; END IF;
  IF pass=2 THEN
   IF present<>1 THEN RAISE EXCEPTION 'CRM_CAMPAIGN_ABANDON_POSTCHECK'; END IF;
   EXIT;
  END IF;
  IF present=1 THEN RAISE NOTICE 'CRM_CAMPAIGN_ABANDON_ALREADY_INSTALLED: nada alterado'; RETURN; END IF;
  EXECUTE $ddl$CREATE FUNCTION public.shrigma_crm_campaign_abandon_v1(p_key text,p_command jsonb) RETURNS jsonb
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
 IF auth ? 'brand' AND auth->>'brand' IS DISTINCT FROM p_command->>'brand' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_FORBIDDEN'; END IF;
 RETURN public.shrigma_campaign_abandon(jsonb_build_object('actor',auth->>'actor','key',p_command->>'idempotency_key',
  'brand',p_command->>'brand','action',p_command->>'operation_action'));
END $fn$$ddl$;
  EXECUTE $ddl$REVOKE ALL ON FUNCTION public.shrigma_crm_campaign_abandon_v1(text,jsonb) FROM PUBLIC$ddl$;
  EXECUTE $ddl$GRANT EXECUTE ON FUNCTION public.shrigma_crm_campaign_abandon_v1(text,jsonb) TO crm_campaign_api$ddl$;
 END LOOP;
END $install$;
COMMIT;
