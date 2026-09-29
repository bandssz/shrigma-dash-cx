-- Least-privilege database boundary for the CRM campaign HTTP gateway.
-- This migration creates no campaign, schedule, transport or service login.
-- The application role is NOLOGIN until a separate deployment provisions it.
DO $install$
DECLARE r record;
BEGIN
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 IF current_user <> 'postgres' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OWNER_REQUIRED'; END IF;

 SELECT p.proowner::regrole::text owner,p.prosecdef,p.provolatile,p.proconfig,md5(p.prosrc) body_md5,
  EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE') public_execute
 INTO r FROM pg_proc p WHERE p.oid=to_regprocedure('public.shrigma_crm_operator_auth_v1(text)');
 IF r IS NULL OR r.owner<>'postgres' OR r.prosecdef OR r.provolatile<>'s'
  OR r.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
  OR r.body_md5<>'6f15c1643c303c8c1eee99f57bc65c66' OR r.public_execute THEN
  RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_AUTH_DRIFT';
 END IF;
 FOR r IN
  SELECT p.proname,p.proowner::regrole::text owner,p.prosecdef,p.provolatile,p.proconfig,md5(p.prosrc) body_md5,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE') public_execute
  FROM pg_proc p WHERE p.oid=ANY(ARRAY[
   to_regprocedure('public.shrigma_campaign_store(text,jsonb)'),
   to_regprocedure('public.shrigma_campaign_provider(text,jsonb)'),
   to_regprocedure('public.shrigma_campaign_recovery(text,jsonb)')])
 LOOP
  IF r.owner<>'postgres' OR r.prosecdef OR r.provolatile<>'v'
   OR r.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public','lock_timeout=3s']::text[]
   OR r.body_md5 IS DISTINCT FROM (CASE r.proname
    WHEN 'shrigma_campaign_store' THEN 'b77d960aca32c2c93dfe15e82922d7ff'
    WHEN 'shrigma_campaign_provider' THEN 'fe3a35e75c8d0830f1b289fa806e52fc'
    WHEN 'shrigma_campaign_recovery' THEN '1e2c0a2bacd82f4dcf8d6797cbf1842c' END)
   OR r.public_execute THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_DEPENDENCY_DRIFT %',r.proname; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_proc p WHERE p.oid=ANY(ARRAY[
   to_regprocedure('public.shrigma_campaign_store(text,jsonb)'),
   to_regprocedure('public.shrigma_campaign_provider(text,jsonb)'),
   to_regprocedure('public.shrigma_campaign_recovery(text,jsonb)')]))<>3
  OR to_regclass('public.shrigma_campaign_operation') IS NULL
  OR to_regclass('public.shrigma_campaign_validation') IS NULL
  OR to_regclass('public.campaigns') IS NULL THEN
  RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_DEPENDENCY_MISSING';
 END IF;
 IF to_regprocedure('public.shrigma_crm_campaign_auth_v1(text)') IS NOT NULL
  OR to_regprocedure('public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_ALREADY_INSTALLED';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_campaign_api') THEN
  CREATE ROLE crm_campaign_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
 ELSE
  SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit INTO r
  FROM pg_roles WHERE rolname='crm_campaign_api';
  IF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls OR r.rolconnlimit<>4
   OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.member JOIN pg_roles b ON b.oid=m.roleid WHERE a.rolname='crm_campaign_api' OR b.rolname='crm_campaign_api')
  THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_ROLE_DRIFT'; END IF;
 END IF;
 IF has_table_privilege('crm_campaign_api','public.shrigma_campaign_operation','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_table_privilege('crm_campaign_api','public.shrigma_campaign_validation','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_table_privilege('crm_campaign_api','public.campaigns','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_any_column_privilege('crm_campaign_api','public.shrigma_campaign_operation','SELECT,INSERT,UPDATE,REFERENCES')
  OR has_any_column_privilege('crm_campaign_api','public.shrigma_campaign_validation','SELECT,INSERT,UPDATE,REFERENCES')
  OR has_any_column_privilege('crm_campaign_api','public.campaigns','SELECT,INSERT,UPDATE,REFERENCES')
  OR has_function_privilege('crm_campaign_api','public.shrigma_crm_operator_auth_v1(text)','EXECUTE')
  OR has_function_privilege('crm_campaign_api','public.shrigma_campaign_store(text,jsonb)','EXECUTE')
  OR has_function_privilege('crm_campaign_api','public.shrigma_campaign_provider(text,jsonb)','EXECUTE')
  OR has_function_privilege('crm_campaign_api','public.shrigma_campaign_recovery(text,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_ROLE_PRIVILEGE_DRIFT';
 END IF;
END $install$;

CREATE FUNCTION public.shrigma_crm_campaign_auth_v1(p_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE a jsonb;
BEGIN
 a:=public.shrigma_crm_operator_auth_v1(p_key);
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR jsonb_typeof(a->'caps') IS DISTINCT FROM 'array'
  OR coalesce(a->>'who','')='' OR length(a->>'who')>200
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'caps') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string')
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('actor',a->>'who','caps',a->'caps');
END $fn$;

CREATE FUNCTION public.shrigma_crm_campaign_effect_v1(p_key text,p_envelope jsonb,p_effect jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE
 auth jsonb; command jsonb; operation jsonb; actor_name text; brand_name text; command_name text; action_name text; capability text;
 kind_name text; effect_action text; payload jsonb; result jsonb; op public.shrigma_campaign_operation%ROWTYPE;
 source_op public.shrigma_campaign_operation%ROWTYPE;
 campaign public.campaigns%ROWTYPE; operation_id uuid; operation_lease uuid; provider_id integer; checked timestamptz;
BEGIN
 auth:=public.shrigma_crm_campaign_auth_v1(p_key);
 IF auth IS NULL THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_UNAUTHORIZED'; END IF;
 IF jsonb_typeof(p_envelope) IS DISTINCT FROM 'object' OR jsonb_typeof(p_effect) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_INPUT';
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_envelope))<>3 OR NOT (p_envelope ?& ARRAY['command','actor','operation']) THEN
  RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_ENVELOPE';
 END IF;
 command:=p_envelope->'command';operation:=p_envelope->'operation';actor_name:=p_envelope->>'actor';
 IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR actor_name IS DISTINCT FROM auth->>'actor'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(command) k WHERE k<>ALL(ARRAY['acao','brand','id','definition','expected_version','idempotency_key','confirm','audience_review_id','source_operation_id']))
 THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_ENVELOPE'; END IF;
 command_name:=command->>'acao';brand_name:=command->>'brand';
 IF command_name IS NULL OR brand_name IS NULL OR command_name !~ '^campanha_(catalogo|listar|obter|operacao|salvar|validar|agendar|cancelar|recuperar)$'
  OR brand_name NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_COMMAND'; END IF;
 action_name:=regexp_replace(command_name,'^campanha_','');
 capability:=CASE action_name WHEN 'catalogo' THEN 'read_content' WHEN 'listar' THEN 'read_content' WHEN 'obter' THEN 'read_content'
  WHEN 'operacao' THEN 'read_content' WHEN 'salvar' THEN 'draft' WHEN 'recuperar' THEN 'draft' WHEN 'validar' THEN 'validate'
  WHEN 'agendar' THEN 'submit' WHEN 'cancelar' THEN 'submit' END;
 IF NOT (auth->'caps' ? capability) THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_FORBIDDEN'; END IF;
 kind_name:=p_effect->>'kind';effect_action:=p_effect->>'action';payload:=p_effect->'payload';
 IF kind_name IS NULL OR kind_name NOT IN ('store','provider','nativeCreate','preview') OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_effect) k WHERE k<>ALL(ARRAY['kind','action','payload','idCampaign']))
 THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_EFFECT'; END IF;

 IF operation IS NOT NULL AND operation<>'null'::jsonb THEN
  IF jsonb_typeof(operation) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(operation))<>2
   OR NOT (operation ?& ARRAY['id','lease']) THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
  BEGIN operation_id:=(operation->>'id')::uuid;operation_lease:=(operation->>'lease')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END;
  SELECT * INTO op FROM public.shrigma_campaign_operation WHERE id=operation_id FOR SHARE;
  IF NOT FOUND OR op.lease IS DISTINCT FROM operation_lease OR op.actor IS DISTINCT FROM actor_name OR op.brand IS DISTINCT FROM brand_name
   OR op.action IS DISTINCT FROM action_name THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
 ELSE operation_id:=NULL;operation_lease:=NULL; END IF;

 IF kind_name='store' THEN
  IF effect_action IS NULL OR effect_action NOT IN ('claim','get','provider','finish','validation_get','validation_set','validation_invalidate') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_EFFECT'; END IF;
  IF effect_action='claim' THEN
   IF operation_id IS NOT NULL OR action_name NOT IN ('salvar','validar','agendar','cancelar','recuperar')
    OR payload->>'actor' IS DISTINCT FROM actor_name OR payload->>'key' IS DISTINCT FROM command->>'idempotency_key'
    OR payload->>'brand' IS DISTINCT FROM brand_name OR payload->>'action' IS DISTINCT FROM action_name THEN
    RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_CLAIM'; END IF;
  ELSIF effect_action='get' THEN
   IF operation_id IS NOT NULL OR action_name<>'operacao' OR payload->>'actor' IS DISTINCT FROM actor_name
    OR payload->>'key' IS DISTINCT FROM command->>'idempotency_key' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_READ'; END IF;
  ELSE
   IF operation_id IS NULL OR payload->>'id' IS DISTINCT FROM operation_id::text OR payload->>'lease' IS DISTINCT FROM operation_lease::text THEN
    IF effect_action IN ('provider','finish') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
   END IF;
   IF operation_id IS NULL OR (effect_action<>'finish' AND op.state<>'pending') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
   IF effect_action='provider' THEN
    BEGIN provider_id:=(payload->>'providerId')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
    SELECT * INTO campaign FROM public.campaigns WHERE id=provider_id FOR SHARE;
    IF NOT FOUND OR provider_id IS NULL OR provider_id<=0 OR op.provider_id IS NOT NULL OR action_name<>'salvar' OR command ? 'id'
     OR campaign.status::text<>'draft' OR campaign.sent<>0 OR campaign.started_at IS NOT NULL
     OR campaign.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
     OR campaign.attribs#>>'{crm,brand}' IS DISTINCT FROM brand_name
     OR campaign.attribs#>>'{crm,created_operation_id}' IS DISTINCT FROM operation_id::text THEN
     RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';
    END IF;
   ELSIF effect_action='finish' THEN
    provider_id:=nullif(payload->>'providerId','')::integer;
    IF provider_id IS NOT NULL AND provider_id IS DISTINCT FROM op.provider_id
     AND (coalesce(command->>'id','') !~ '^[1-9][0-9]*$' OR provider_id IS DISTINCT FROM (command->>'id')::integer)
    THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER'; END IF;
    IF provider_id IS NOT NULL THEN
     SELECT * INTO campaign FROM public.campaigns WHERE id=provider_id FOR SHARE;
     IF NOT FOUND OR campaign.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
      OR campaign.attribs#>>'{crm,brand}' IS DISTINCT FROM brand_name THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER'; END IF;
    END IF;
   END IF;
   IF effect_action LIKE 'validation_%' THEN
    BEGIN provider_id:=(payload->>'providerId')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
    IF provider_id IS NULL OR provider_id<=0 OR provider_id IS DISTINCT FROM coalesce(op.provider_id,(command->>'id')::integer)
     OR (effect_action='validation_get' AND action_name<>'agendar')
     OR (effect_action='validation_invalidate' AND action_name<>'salvar')
     OR effect_action='validation_set' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.campaigns c WHERE c.id=provider_id AND c.attribs#>>'{crm,brand}'=brand_name AND c.attribs#>>'{crm,policy}'='crm-campaign-v1') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_SCOPE'; END IF;
   END IF;
  END IF;
  result:=public.shrigma_campaign_store(effect_action,payload);
 ELSIF kind_name='provider' THEN
  IF effect_action IS NULL OR effect_action NOT IN ('catalog','list','get','update','schedule','cancel','review','recovery_inspect','recover') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_EFFECT'; END IF;
  IF effect_action IN ('catalog','list') THEN
   IF payload->>'brand' IS DISTINCT FROM brand_name OR (effect_action='list' AND action_name<>'listar')
    OR (effect_action='catalog' AND action_name NOT IN ('catalogo','salvar','validar','agendar')) THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_SCOPE'; END IF;
  ELSIF effect_action='get' THEN
   BEGIN provider_id:=(payload->>'id')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
   IF action_name NOT IN ('obter','salvar','validar','agendar','cancelar') OR provider_id<=0
    OR (command->>'id' IS NOT NULL AND provider_id IS DISTINCT FROM (command->>'id')::integer)
    OR (op.id IS NOT NULL AND op.provider_id IS NOT NULL AND provider_id IS DISTINCT FROM op.provider_id) THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER'; END IF;
  ELSIF effect_action='recovery_inspect' THEN
   IF action_name<>'operacao' OR payload->>'actor' IS DISTINCT FROM actor_name
    THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_RECOVERY'; END IF;
   SELECT * INTO source_op FROM public.shrigma_campaign_operation
    WHERE actor=actor_name AND operation_key=command->>'idempotency_key' FOR SHARE;
   IF NOT FOUND OR source_op.id::text IS DISTINCT FROM payload->>'sourceOperationId'
    OR source_op.brand IS DISTINCT FROM brand_name THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_RECOVERY'; END IF;
  ELSE
   IF operation_id IS NULL OR op.state<>'pending' OR payload->>'operationId' IS DISTINCT FROM operation_id::text
    OR effect_action IS DISTINCT FROM (CASE action_name WHEN 'salvar' THEN 'update' WHEN 'validar' THEN 'review' WHEN 'agendar' THEN 'schedule' WHEN 'cancelar' THEN 'cancel' WHEN 'recuperar' THEN 'recover' END)
   THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
   BEGIN provider_id:=(payload->>'id')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
   IF provider_id<=0 OR (command ? 'id' AND provider_id IS DISTINCT FROM (command->>'id')::integer)
    OR (NOT (command ? 'id') AND NOT (action_name='salvar' AND effect_action='update' AND provider_id IS NOT DISTINCT FROM op.provider_id))
    OR (op.provider_id IS NOT NULL AND provider_id IS DISTINCT FROM op.provider_id)
   OR (NOT (effect_action='update' AND NOT (command ? 'id')) AND payload->>'expectedVersion' IS DISTINCT FROM command->>'expected_version')
   OR (effect_action='update' AND NOT (command ? 'id') AND coalesce(payload->>'expectedVersion','')='')
    OR (effect_action='schedule' AND (payload->>'audienceReviewId' IS DISTINCT FROM command->>'audience_review_id' OR command->>'confirm' IS DISTINCT FROM 'agendar'))
    OR (effect_action='cancel' AND command->>'confirm' IS DISTINCT FROM 'cancelar')
    OR (effect_action='recover' AND command->>'confirm' IS DISTINCT FROM 'recuperar')
    OR (effect_action='recover' AND payload->>'sourceOperationId' IS DISTINCT FROM command->>'source_operation_id')
   THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_SCOPE'; END IF;
  END IF;
  result:=public.shrigma_campaign_provider(effect_action,payload);
  IF effect_action='get' AND result IS NOT NULL AND result#>>'{definition,brand}' IS DISTINCT FROM brand_name THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_SCOPE'; END IF;
  IF effect_action='get' AND action_name='salvar' AND NOT (command ? 'id')
   AND (operation_id IS NULL OR result#>>'{definition,brand}' IS DISTINCT FROM brand_name
    OR NOT EXISTS(SELECT 1 FROM public.campaigns c WHERE c.id=(result->>'id')::integer
     AND c.attribs#>>'{crm,created_operation_id}'=operation_id::text)) THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';
  END IF;
 ELSIF kind_name='nativeCreate' THEN
  IF operation_id IS NULL OR op.state<>'pending' OR action_name<>'salvar' OR command ? 'id' OR op.provider_id IS NOT NULL
   OR effect_action IS NOT NULL OR p_effect ? 'idCampaign' OR payload->'send_at' IS DISTINCT FROM 'null'::jsonb
   OR payload->>'type' IS DISTINCT FROM 'regular' OR payload->>'content_type' IS DISTINCT FROM 'html'
   OR payload->'body_source' IS DISTINCT FROM 'null'::jsonb OR payload->>'messenger' IS DISTINCT FROM 'email'
   OR payload#>>'{attribs,crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
   OR payload#>>'{attribs,crm,brand}' IS DISTINCT FROM brand_name
   OR payload#>>'{attribs,crm,created_operation_id}' IS DISTINCT FROM operation_id::text THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_NATIVE_CREATE'; END IF;
  checked:=clock_timestamp();result:=jsonb_build_object('ok',true,'kind','nativeCreate','operation_id',operation_id,'checked_at',checked);
 ELSE
  BEGIN provider_id:=(p_effect->>'idCampaign')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
  IF operation_id IS NULL OR op.state<>'pending' OR action_name<>'salvar' OR effect_action IS NOT NULL OR provider_id<=0
   OR payload->>'content_type' IS DISTINCT FROM 'html' OR coalesce(payload->>'template_id','') !~ '^[1-9][0-9]*$'
   OR (op.provider_id IS NOT NULL AND provider_id IS DISTINCT FROM op.provider_id)
   OR (op.provider_id IS NULL AND (command->>'id')::integer IS DISTINCT FROM provider_id)
   OR (command#>>'{definition,template_id}')::integer IS DISTINCT FROM (payload->>'template_id')::integer THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PREVIEW'; END IF;
  SELECT * INTO campaign FROM public.campaigns WHERE id=provider_id FOR SHARE;
  IF NOT FOUND OR campaign.status::text<>'draft' OR campaign.sent<>0 OR campaign.started_at IS NOT NULL
   OR campaign.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1' OR campaign.attribs#>>'{crm,brand}' IS DISTINCT FROM brand_name THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PREVIEW'; END IF;
  checked:=clock_timestamp();result:=jsonb_build_object('ok',true,'kind','preview','operation_id',operation_id,'campaign_id',provider_id,'checked_at',checked);
 END IF;
 RETURN result;
END $fn$;

REVOKE ALL ON FUNCTION public.shrigma_crm_campaign_auth_v1(text),public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shrigma_crm_campaign_auth_v1(text),public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) TO crm_campaign_api;
ALTER ROLE crm_campaign_api SET statement_timeout='12s';
ALTER ROLE crm_campaign_api SET lock_timeout='500ms';
ALTER ROLE crm_campaign_api SET idle_in_transaction_session_timeout='15s';
