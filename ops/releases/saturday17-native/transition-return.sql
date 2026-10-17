-- Prepared return; preserve every native business record and receipt.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='8s';
DO $native_fence$ DECLARE p record;e record;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'NATIVE_INSTALLER_ROLE';END IF;
 FOR e IN SELECT * FROM jsonb_to_recordset('[{"signature":"public.shrigma_campaign_guard()","body_md5":"372ba227490e7956b0c06366957e3249","owner":"postgres","security_definer":false,"volatility":"v","proconfig":["search_path=pg_catalog, public"],"acl":"{postgres=X/postgres}"},{"signature":"public.shrigma_campaign_relation_guard()","body_md5":"aa26320f4262d3f31935118a4cbbe08b","owner":"postgres","security_definer":false,"volatility":"v","proconfig":["search_path=pg_catalog, public"],"acl":"{postgres=X/postgres}"},{"signature":"public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb)","body_md5":"0954cb49880fd4a36eba4281592d5888","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog, public"],"acl":"{postgres=X/postgres,crm_campaign_api=X/postgres}"},{"signature":"public.shrigma_campaign_store(text,jsonb)","body_md5":"ae8a364eef883a2ff702c3a306b6a58a","owner":"postgres","security_definer":false,"volatility":"v","proconfig":["search_path=pg_catalog, public","lock_timeout=3s"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_snapshot_v1(integer)","body_md5":"3773ee797b16c4990a3dbf3e70edf52d","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_snapshot_history_v1(integer)","body_md5":"f8d86671ff00768d413c69539ccc0f9e","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_live_v1(text,text)","body_md5":"e8a36bd637e194a0dbb4c0d4c5eb0b9c","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_effect_v1(text,jsonb,jsonb)","body_md5":"75fe9deb8fde5991ada015ddf40ab274","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_before_v1(public.campaigns,public.campaigns)","body_md5":"2a068778a10b69a192d4f742565773f4","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_after_v1()","body_md5":"21abc1f2ccc2f61edc9c5b192cd5d121","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_relation_v1(integer,jsonb,jsonb,text)","body_md5":"fd22c65380beac0cf54c5659b7312ee6","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"}]'::jsonb) AS x(signature text,body_md5 text,owner text,security_definer boolean,volatility text,proconfig jsonb,acl text) LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e.signature);
  IF md5(p.prosrc) IS DISTINCT FROM e.body_md5 OR pg_get_userbyid(p.proowner) IS DISTINCT FROM e.owner
   OR p.prosecdef IS DISTINCT FROM e.security_definer OR p.provolatile::text IS DISTINCT FROM e.volatility
   OR to_jsonb(p.proconfig) IS DISTINCT FROM e.proconfig OR p.proacl::text IS DISTINCT FROM e.acl
  THEN RAISE EXCEPTION 'NATIVE_ORIGINAL_OR_ACL_DRIFT';END IF;
 END LOOP;END $native_fence$;
DO $native_return$ DECLARE r record;o public.shrigma_campaign_operation%ROWTYPE;c public.campaigns%ROWTYPE;p jsonb;BEGIN
 -- Lock all owned campaigns before their operations; drain any native UPDATE.
 FOR r IN SELECT v.provider_id FROM public.shrigma_campaign_validation v WHERE v.validation ? '_native_internal' ORDER BY v.provider_id LOOP
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=r.provider_id FOR UPDATE;
  SELECT validation->'_native_internal' INTO STRICT p FROM public.shrigma_campaign_validation WHERE provider_id=c.id;
  SELECT * INTO STRICT o FROM public.shrigma_campaign_operation WHERE id=(p->>'operation_id')::uuid FOR UPDATE;
  IF p->>'contract' IS DISTINCT FROM 'crm-native-internal-transition-v1' OR o.provider_id IS DISTINCT FROM c.id
   OR o.actor IS DISTINCT FROM p->>'actor' OR o.request_hash IS DISTINCT FROM p->>'request_hash' OR o.lease::text IS DISTINCT FROM p->>'lease'
   OR crm_audience_v2.native_internal_snapshot_history_v1(c.id) IS NULL OR c.status::text NOT IN('draft','cancelled')
   OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL OR o.state NOT IN('pending','succeeded','rejected','outcome_unknown')
  THEN RAISE EXCEPTION 'NATIVE_RETURN_OPERATION_NOT_DRAINED';END IF;
  IF o.state='pending' THEN
   IF p->>'expires_at' IS NULL OR (p->>'expires_at')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'NATIVE_RETURN_OPERATION_NOT_DRAINED';END IF;
   -- Campaign then operation are locked. An unacknowledged native request can
   -- no longer pass the expired permit; retain its uncertainty in the SAME row.
   UPDATE public.shrigma_campaign_operation SET state='outcome_unknown',response=jsonb_build_object('status',502,'body',jsonb_build_object('error','OUTCOME_UNKNOWN','message','Retorno: intenção expirada sem confirmação; campanha conferida sem envio.','provider_id',c.id,'operation_id',o.id)),updated_at=clock_timestamp() WHERE id=o.id;
  END IF;
  -- Only metadata added to these NEW QA validation records is removed. Native
  -- campaigns, lists, subscribers and original operation receipts are retained.
  UPDATE public.shrigma_campaign_validation SET validation=validation-'_native_internal',updated_at=clock_timestamp() WHERE provider_id=c.id;
 END LOOP;END $native_return$;
DROP TRIGGER shrigma_native_internal_receipt_v1 ON public.campaigns;
CREATE OR REPLACE FUNCTION public.shrigma_campaign_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE managed boolean; writer boolean; o jsonb; n jsonb;
 runtime_fields text[]:=ARRAY['status','sent','to_send','last_subscriber_id','max_subscriber_id','started_at','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.shrigma_campaign_is_managed(NEW) AND
    (NEW.status::text<>'draft' OR NEW.send_at IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.sent<>0) THEN
   RAISE EXCEPTION 'CAMPAIGN_CREATE_DRAFT_ONLY';
  END IF;
  IF public.shrigma_campaign_is_managed(NEW) THEN
   PERFORM set_config('shrigma.campaign_created',
    (coalesce(nullif(current_setting('shrigma.campaign_created',true),''),'[]')::jsonb||to_jsonb(NEW.id))::text,true);
  END IF;
  RETURN NEW;
 END IF;
 managed:=public.shrigma_campaign_is_managed(OLD);
 IF TG_OP='DELETE' THEN
  IF managed THEN RAISE EXCEPTION 'CAMPAIGN_EDITOR_REQUIRED'; END IF;
  RETURN OLD;
 END IF;
 IF NOT managed THEN
  IF public.shrigma_campaign_is_managed(NEW) THEN RAISE EXCEPTION 'CAMPAIGN_ADOPTION_REQUIRED'; END IF;
  RETURN NEW;
 END IF;
 writer:=current_setting('shrigma.campaign_writer',true)=OLD.id::text;
 IF writer THEN RETURN NEW; END IF;
 o:=to_jsonb(OLD);n:=to_jsonb(NEW);
 IF (o-runtime_fields) IS DISTINCT FROM (n-runtime_fields) THEN RAISE EXCEPTION 'CAMPAIGN_EDITOR_REQUIRED'; END IF;
 -- The native worker may count deliveries and advance a due schedule. Operators
 -- retain stop/pause/resume. A draft cannot bypass review through native Send.
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status::text='scheduled' AND NEW.status::text='running' AND OLD.send_at<=clock_timestamp()) OR
   (OLD.status::text IN ('scheduled','running') AND NEW.status::text IN ('paused','cancelled')) OR
   (OLD.status::text='paused' AND NEW.status::text IN ('scheduled','cancelled')) OR
   (OLD.status::text='paused' AND NEW.status::text='running' AND OLD.send_at<=clock_timestamp()) OR
   (OLD.status::text='running' AND NEW.status::text='finished')) THEN
  RAISE EXCEPTION 'CAMPAIGN_REVIEW_REQUIRED';
 END IF;
 IF OLD.status::text='draft' AND (o-ARRAY['updated_at']) IS DISTINCT FROM (n-ARRAY['updated_at']) THEN
  RAISE EXCEPTION 'CAMPAIGN_REVIEW_REQUIRED';
 END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.shrigma_campaign_relation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE pid integer;c public.campaigns%ROWTYPE; created_here boolean;
BEGIN
 -- Check both parents: moving a relation must not remove an owned audience/media.
 FOR pid IN SELECT DISTINCT x FROM unnest(ARRAY[
   CASE WHEN TG_OP<>'INSERT' THEN OLD.campaign_id END,
   CASE WHEN TG_OP<>'DELETE' THEN NEW.campaign_id END]) x WHERE x IS NOT NULL ORDER BY x LOOP
  SELECT ca.* INTO c FROM public.campaigns ca WHERE ca.id=pid FOR UPDATE;
  IF NOT FOUND OR NOT public.shrigma_campaign_is_managed(c) THEN CONTINUE; END IF;
  IF current_setting('shrigma.campaign_writer',true)=pid::text THEN CONTINUE; END IF;
  -- Native create uses one SQL CTE for the draft and its initial relations.
  created_here:=coalesce(nullif(current_setting('shrigma.campaign_created',true),''),'[]')::jsonb @> to_jsonb(pid);
  IF TG_OP='INSERT' AND created_here AND c.status::text='draft' AND c.send_at IS NULL THEN CONTINUE; END IF;
  RAISE EXCEPTION 'CAMPAIGN_EDITOR_REQUIRED';
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.shrigma_crm_campaign_effect_v1(p_key text, p_envelope jsonb, p_effect jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
END $function$;
CREATE OR REPLACE FUNCTION public.shrigma_campaign_store(p_action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
 SET lock_timeout TO '3s'
AS $function$
DECLARE r public.shrigma_campaign_operation%ROWTYPE; got boolean; v jsonb; pid integer;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' THEN RAISE EXCEPTION 'CAMPAIGN_STORE_INPUT'; END IF;
 IF p_action IN ('claim','get') THEN
  IF coalesce(p->>'actor','')='' OR length(p->>'actor')>200 OR
     coalesce(p->>'key','') !~ '^[A-Za-z0-9_-]{16,100}$' THEN
   RAISE EXCEPTION 'CAMPAIGN_STORE_IDENTITY';
  END IF;
 END IF;
 IF p_action='claim' THEN
  IF coalesce(p->>'hash','') !~ '^[0-9a-f]{64}$' OR
     coalesce(p->>'brand','') NOT IN ('aristo','fish') OR
     coalesce(p->>'action','') NOT IN ('salvar','validar','agendar','cancelar','recuperar') THEN
   RAISE EXCEPTION 'CAMPAIGN_STORE_CLAIM';
  END IF;
  -- Serialize exactly one actor/key, including concurrent insertion. Never reclaim
  -- an old operation by time: its remote side effect may already have happened.
  PERFORM pg_advisory_xact_lock(hashtextextended('campaign-operation:'||jsonb_build_array(p->>'actor',p->>'key')::text,0));
  INSERT INTO public.shrigma_campaign_operation(actor,operation_key,request_hash,brand,action)
  VALUES(p->>'actor',p->>'key',p->>'hash',p->>'brand',p->>'action')
  ON CONFLICT(actor,operation_key) DO NOTHING RETURNING * INTO r;
  got:=FOUND;
  IF NOT got THEN
   SELECT * INTO STRICT r FROM public.shrigma_campaign_operation WHERE actor=p->>'actor' AND operation_key=p->>'key';
  END IF;
  RETURN jsonb_build_object('id',r.id,'lease',CASE WHEN got THEN r.lease ELSE NULL END,
   'hash',r.request_hash,'brand',r.brand,'action',r.action,'acquired',got,
   'state',r.state,'providerId',r.provider_id,'response',r.response);
 ELSIF p_action='get' THEN
  SELECT * INTO r FROM public.shrigma_campaign_operation WHERE actor=p->>'actor' AND operation_key=p->>'key';
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  -- Never expose the mutation token through operation polling.
  RETURN jsonb_build_object('id',r.id,'operation_key',r.operation_key,'brand',r.brand,'action',r.action,'state',r.state,
    'providerId',r.provider_id,'response',r.response,'created_at',r.created_at,'updated_at',r.updated_at);
 ELSIF p_action IN ('provider','finish') THEN
  SELECT * INTO r FROM public.shrigma_campaign_operation WHERE id=(p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND OR r.lease IS DISTINCT FROM (p->>'lease')::uuid THEN RAISE EXCEPTION 'CAMPAIGN_STORE_LEASE'; END IF;
  pid:=nullif(p->>'providerId','')::integer;
  IF pid IS NOT NULL AND pid<=0 THEN RAISE EXCEPTION 'CAMPAIGN_STORE_PROVIDER'; END IF;
  IF r.provider_id IS NOT NULL AND pid IS NOT NULL AND r.provider_id<>pid THEN RAISE EXCEPTION 'CAMPAIGN_STORE_PROVIDER_CONFLICT'; END IF;
  IF p_action='provider' THEN
   IF pid IS NULL OR r.state<>'pending' THEN RAISE EXCEPTION 'CAMPAIGN_STORE_STATE'; END IF;
   UPDATE public.shrigma_campaign_operation SET provider_id=pid,updated_at=clock_timestamp() WHERE id=r.id;
  ELSE
   IF coalesce(p->>'state','') NOT IN ('succeeded','rejected','outcome_unknown') OR
      jsonb_typeof(p->'response') IS DISTINCT FROM 'object' OR
      jsonb_typeof(p#>'{response,body}') IS DISTINCT FROM 'object' OR
      coalesce(p#>>'{response,status}','') !~ '^[1-5][0-9]{2}$' THEN
    RAISE EXCEPTION 'CAMPAIGN_STORE_RESULT';
   END IF;
   IF r.state<>'pending' THEN
    IF r.state=p->>'state' AND r.response=p->'response' AND r.provider_id IS NOT DISTINCT FROM coalesce(pid,r.provider_id) THEN RETURN '{"ok":true}'::jsonb; END IF;
    -- A late worker cannot overwrite an uncertain or completed result.
    RAISE EXCEPTION 'CAMPAIGN_STORE_FINALIZED';
   END IF;
   UPDATE public.shrigma_campaign_operation SET state=p->>'state',response=p->'response',
    provider_id=coalesce(pid,provider_id),updated_at=clock_timestamp() WHERE id=r.id;
  END IF;
  RETURN '{"ok":true}'::jsonb;
 ELSIF p_action IN ('validation_get','validation_set','validation_invalidate') THEN
  pid:=(p->>'providerId')::integer;
  IF pid IS NULL OR pid<=0 THEN RAISE EXCEPTION 'CAMPAIGN_STORE_PROVIDER'; END IF;
  IF p_action='validation_get' THEN
   SELECT validation INTO v FROM public.shrigma_campaign_validation WHERE provider_id=pid;
   RETURN coalesce(v-'_audience_fingerprint','null'::jsonb);
  ELSIF p_action='validation_invalidate' THEN
   DELETE FROM public.shrigma_campaign_validation WHERE provider_id=pid;
  ELSE
   v:=p->'validation';
   IF v ? 'audience' OR v ? '_audience_fingerprint' THEN RAISE EXCEPTION 'CAMPAIGN_STORE_VALIDATION'; END IF;
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR v->>'policy' IS DISTINCT FROM 'crm-campaign-v1' OR
      v->'ok' IS DISTINCT FROM 'true'::jsonb OR coalesce(v->>'version','')='' OR
      coalesce(v->>'validated_at','')='' THEN RAISE EXCEPTION 'CAMPAIGN_STORE_VALIDATION'; END IF;
   INSERT INTO public.shrigma_campaign_validation(provider_id,validation) VALUES(pid,v)
    ON CONFLICT(provider_id) DO UPDATE SET validation=excluded.validation,updated_at=clock_timestamp();
  END IF;
  RETURN '{"ok":true}'::jsonb;
 ELSE RAISE EXCEPTION 'CAMPAIGN_STORE_ACTION';
 END IF;
END $function$;
DROP FUNCTION crm_audience_v2.native_internal_relation_v1(integer,jsonb,jsonb,text);
DROP FUNCTION crm_audience_v2.native_internal_after_v1();
DROP FUNCTION crm_audience_v2.native_internal_before_v1(public.campaigns,public.campaigns);
DROP FUNCTION crm_audience_v2.native_internal_effect_v1(text,jsonb,jsonb);
DROP FUNCTION crm_audience_v2.native_internal_live_v1(text,text);
DROP FUNCTION crm_audience_v2.native_internal_snapshot_history_v1(integer);
DROP FUNCTION crm_audience_v2.native_internal_snapshot_v1(integer);
DO $native_fence$ DECLARE p record;e record;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'NATIVE_INSTALLER_ROLE';END IF;
 FOR e IN SELECT * FROM jsonb_to_recordset('[{"signature":"public.shrigma_campaign_guard()","body_md5":"fb84b97de9690b9ffcb1968c660f43cd","owner":"postgres","security_definer":false,"volatility":"v","proconfig":["search_path=pg_catalog, public"],"acl":"{postgres=X/postgres}"},{"signature":"public.shrigma_campaign_relation_guard()","body_md5":"8f860697e61d6a7e41a812d921f3078a","owner":"postgres","security_definer":false,"volatility":"v","proconfig":["search_path=pg_catalog, public"],"acl":"{postgres=X/postgres}"},{"signature":"public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb)","body_md5":"e4d3e3143e26cd186a31e8d21ed5b473","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog, public"],"acl":"{postgres=X/postgres,crm_campaign_api=X/postgres}"},{"signature":"public.shrigma_campaign_store(text,jsonb)","body_md5":"b77d960aca32c2c93dfe15e82922d7ff","owner":"postgres","security_definer":false,"volatility":"v","proconfig":["search_path=pg_catalog, public","lock_timeout=3s"],"acl":"{postgres=X/postgres}"}]'::jsonb) AS x(signature text,body_md5 text,owner text,security_definer boolean,volatility text,proconfig jsonb,acl text) LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e.signature);
  IF md5(p.prosrc) IS DISTINCT FROM e.body_md5 OR pg_get_userbyid(p.proowner) IS DISTINCT FROM e.owner
   OR p.prosecdef IS DISTINCT FROM e.security_definer OR p.provolatile::text IS DISTINCT FROM e.volatility
   OR to_jsonb(p.proconfig) IS DISTINCT FROM e.proconfig OR p.proacl::text IS DISTINCT FROM e.acl
  THEN RAISE EXCEPTION 'NATIVE_ORIGINAL_OR_ACL_DRIFT';END IF;
 END LOOP;END $native_fence$;
COMMIT;
