BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='8s';
DO $fence$ DECLARE p record;e record;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'NATIVE_INSTALLER_ROLE';END IF;
 FOR e IN SELECT * FROM jsonb_to_recordset('[{"signature":"crm_audience_v2.native_internal_effect_v1(text,jsonb,jsonb)","body_md5":"75fe9deb8fde5991ada015ddf40ab274","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_before_v1(public.campaigns,public.campaigns)","body_md5":"2a068778a10b69a192d4f742565773f4","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_after_v1()","body_md5":"21abc1f2ccc2f61edc9c5b192cd5d121","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_relation_v1(integer,jsonb,jsonb,text)","body_md5":"fd22c65380beac0cf54c5659b7312ee6","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb)","body_md5":"0954cb49880fd4a36eba4281592d5888","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog, public"],"acl":"{postgres=X/postgres,crm_campaign_api=X/postgres}"}]'::jsonb) AS x(signature text,body_md5 text,owner text,security_definer boolean,volatility text,proconfig jsonb,acl text) LOOP
 SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e.signature);
 IF md5(p.prosrc) IS DISTINCT FROM e.body_md5 OR pg_get_userbyid(p.proowner) IS DISTINCT FROM e.owner OR p.prosecdef IS DISTINCT FROM e.security_definer OR p.provolatile::text IS DISTINCT FROM e.volatility OR to_jsonb(p.proconfig) IS DISTINCT FROM e.proconfig OR p.proacl::text IS DISTINCT FROM e.acl THEN RAISE EXCEPTION 'NATIVE_RECOVERY_FUNCTION_DRIFT';END IF;
 END LOOP;END $fence$;
CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_effect_v1(k text,envelope jsonb,effect jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $effect$
DECLARE previous jsonb;recovery jsonb;auth jsonb;cmd jsonb;operation jsonb;kind text;action text;payload jsonb;cid integer;oid uuid;olease uuid;
 c public.campaigns%ROWTYPE;op public.shrigma_campaign_operation%ROWTYPE;v jsonb;p jsonb;snapshot jsonb;
 current_row jsonb;h text;credential_hash text;at timestamptz;expiry timestamptz;checked timestamptz;audience jsonb;private_audience jsonb;proved boolean;
BEGIN
 auth:=public.shrigma_crm_campaign_auth_v1(k);cmd:=envelope->'command';operation:=envelope->'operation';kind:=effect->>'kind';action:=effect->>'action';payload:=effect->'payload';
 IF jsonb_typeof(envelope) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(envelope))<>3
  OR NOT(envelope ?& ARRAY['command','actor','operation']) OR jsonb_typeof(cmd) IS DISTINCT FROM 'object'
  OR auth->>'actor' IS NULL OR envelope->>'actor' IS DISTINCT FROM auth->>'actor'
  OR coalesce(cmd->>'brand','') NOT IN('fish','aristo') OR ((auth->'caps') ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
  OR jsonb_typeof(effect) IS DISTINCT FROM 'object' OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_AUTH_REFUSED';END IF;
 credential_hash:=encode(sha256(convert_to(k,'UTF8')),'hex');
 IF NOT crm_audience_v2.native_internal_live_v1(auth->>'actor',credential_hash) THEN RAISE EXCEPTION 'NATIVE_INTERNAL_AUTH_REFUSED';END IF;
 IF coalesce(cmd->>'id','')!~'^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_INPUT';END IF;cid:=(cmd->>'id')::integer;
 -- Explicit POST continuation of the SAME uncertain cancel; never a new claim.
 IF kind='nativeCancelRecovery' THEN
  IF operation IS DISTINCT FROM 'null'::jsonb OR cmd->>'acao' IS DISTINCT FROM 'campanha_cancelar'
   OR cmd->>'confirm' IS DISTINCT FROM 'cancelar'
   OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(cmd)x) IS DISTINCT FROM ARRAY['acao','brand','confirm','expected_version','id','idempotency_key']
   OR effect IS DISTINCT FROM jsonb_build_object('kind','nativeCancelRecovery','payload',jsonb_build_object('id',cid))
  THEN RAISE EXCEPTION 'NATIVE_RECOVERY_INPUT';END IF;
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
  SELECT * INTO STRICT op FROM public.shrigma_campaign_operation WHERE actor=auth->>'actor' AND operation_key=cmd->>'idempotency_key' FOR UPDATE;
  SELECT validation INTO v FROM public.shrigma_campaign_validation WHERE provider_id=cid FOR UPDATE;p:=v->'_native_internal';
  h:=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(cmd)e(k,v)),'UTF8')),'hex');
  snapshot:=crm_audience_v2.native_internal_snapshot_history_v1(cid);
  IF op.action IS DISTINCT FROM 'cancelar' OR op.brand IS DISTINCT FROM cmd->>'brand' OR op.provider_id IS DISTINCT FROM cid
   OR op.request_hash IS DISTINCT FROM h OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM op.brand
   OR p->>'contract' IS DISTINCT FROM 'crm-native-internal-transition-v1' OR p->>'operation_id' IS DISTINCT FROM op.id::text
   OR p->>'lease' IS DISTINCT FROM op.lease::text OR p->>'actor' IS DISTINCT FROM op.actor OR p->>'brand' IS DISTINCT FROM op.brand
   OR p->>'action' IS DISTINCT FROM 'cancelar' OR p->>'request_hash' IS DISTINCT FROM h
   OR p->>'credential_sha256' IS DISTINCT FROM credential_hash OR snapshot IS NULL OR p->'snapshot' IS DISTINCT FROM snapshot
   OR c.status::text IS DISTINCT FROM 'draft' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL
   OR p->>'current_version' IS DISTINCT FROM public.shrigma_campaign_current(cid)->>'version'
   OR p->>'material_sha256' IS DISTINCT FROM encode(sha256(convert_to((to_jsonb(c)-ARRAY['status','send_at','updated_at'])::text,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'NATIVE_RECOVERY_CHANGED';END IF;
  recovery:=p->'recovery';
  IF op.state='succeeded' AND p->>'stage'='complete' AND c.send_at IS NULL
   AND recovery->>'contract'='crm-native-cancel-recovery-v1' AND recovery->>'operation_id'=op.id::text
   AND recovery->>'request_hash'=h AND op.response#>'{body,campaign}'=public.shrigma_campaign_current(cid)
  THEN previous:=recovery->'previous_operation';
  ELSE
   IF op.state<>'outcome_unknown' OR p->>'stage' IS DISTINCT FROM 'clear_send_at'
    OR c.send_at IS NULL OR c.send_at IS DISTINCT FROM (p->>'send_at')::timestamptz
   THEN RAISE EXCEPTION 'NATIVE_RECOVERY_UNAVAILABLE';END IF;
   previous:=public.shrigma_campaign_store('get',jsonb_build_object('actor',op.actor,'key',op.operation_key));
   IF previous->>'id' IS DISTINCT FROM op.id::text OR previous->>'state' IS DISTINCT FROM 'outcome_unknown'
    OR previous->'response' IS DISTINCT FROM op.response THEN RAISE EXCEPTION 'NATIVE_RECOVERY_RECEIPT_CHANGED';END IF;
   IF recovery IS NOT NULL AND (recovery->>'contract' IS DISTINCT FROM 'crm-native-cancel-recovery-v1'
    OR recovery->'previous_operation' IS DISTINCT FROM previous) THEN RAISE EXCEPTION 'NATIVE_RECOVERY_CHANGED';END IF;
   recovery:=jsonb_build_object('contract','crm-native-cancel-recovery-v1','operation_id',op.id,'request_hash',h,'previous_operation',previous);
   p:=p||jsonb_build_object('recovery',recovery,'expires_at',clock_timestamp()+interval '2 minutes');
   UPDATE public.shrigma_campaign_validation SET validation=jsonb_set(validation,'{_native_internal}',p),updated_at=clock_timestamp() WHERE provider_id=cid;
  END IF;
  RETURN jsonb_build_object('contract','crm-native-internal-plan-v1','campaign_id',cid,'campaign_uuid',c.uuid,'list_id',snapshot->'list_id',
   'send_at',p->'send_at','stage','clear_send_at','completed',op.state='succeeded','operation',jsonb_build_object('id',op.id,'lease',op.lease),'previous_operation',previous);
 END IF;

 IF kind='nativeContext' THEN
  IF cmd->>'acao' IS DISTINCT FROM 'campanha_nativa_contexto' OR operation IS DISTINCT FROM 'null'::jsonb
   OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(cmd)x) IS DISTINCT FROM ARRAY['acao','brand','id'] OR effect IS DISTINCT FROM jsonb_build_object('kind','nativeContext','payload',jsonb_build_object('id',cid))
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_INPUT';END IF;
  -- Release admission comes from historical native receipts in the ORIGINAL
  -- intentions. A later schedule must not hide its own cancellation control.
  SELECT NOT EXISTS(SELECT 1 FROM unnest(ARRAY['aristo','fish'])b WHERE NOT EXISTS(
   SELECT 1 FROM public.campaigns cc JOIN public.shrigma_campaign_operation cancelop ON cancelop.provider_id=cc.id
   WHERE cc.attribs#>>'{crm,brand}'=b AND crm_audience_v2.native_internal_snapshot_history_v1(cc.id) IS NOT NULL
    AND cancelop.actor=auth->>'actor' AND cancelop.brand=b AND cancelop.action='cancelar' AND cancelop.state='succeeded'
    AND cancelop.response->'status'='200'::jsonb AND cancelop.response#>'{body,native_internal}'='true'::jsonb
    AND cancelop.response#>>'{body,campaign,status}'='draft' AND cancelop.response#>'{body,campaign,sent}'='0'::jsonb
    AND cancelop.response#>'{body,campaign,started_at}'='null'::jsonb
    AND cancelop.response#>'{body,campaign,send_at}'='null'::jsonb
    AND EXISTS(SELECT 1 FROM public.shrigma_campaign_operation scheduleop WHERE scheduleop.provider_id=cc.id
     AND scheduleop.actor=cancelop.actor AND scheduleop.brand=b AND scheduleop.action='agendar' AND scheduleop.state='succeeded'
     AND scheduleop.response->'status'='200'::jsonb AND scheduleop.response#>'{body,native_internal}'='true'::jsonb
     AND scheduleop.created_at<cancelop.created_at AND scheduleop.response#>>'{body,campaign,status}'='scheduled'
     AND scheduleop.response#>'{body,campaign,sent}'='0'::jsonb AND scheduleop.response#>'{body,campaign,started_at}'='null'::jsonb)
  )) INTO proved;
  IF NOT EXISTS(SELECT 1 FROM public.campaigns WHERE id=cid AND attribs#>>'{crm,brand}'=cmd->>'brand'
   AND left(name,char_length('[QA SAB17] Agenda nativa '))='[QA SAB17] Agenda nativa ') THEN
   RETURN jsonb_build_object('schema','crm-native-internal-context-v1','brand',cmd->>'brand','campaign_id',cid,'eligible',false,'internal_test',true,'commercial',false,'list_id',NULL,'acceptance_proved',proved);
  END IF;
  snapshot:=CASE WHEN EXISTS(SELECT 1 FROM public.campaigns WHERE id=cid AND status::text='scheduled') THEN crm_audience_v2.native_internal_snapshot_history_v1(cid) ELSE crm_audience_v2.native_internal_snapshot_v1(cid) END;
  RETURN jsonb_build_object('schema','crm-native-internal-context-v1','brand',cmd->>'brand','campaign_id',cid,
   'eligible',snapshot IS NOT NULL AND EXISTS(SELECT 1 FROM public.campaigns WHERE id=cid AND attribs#>>'{crm,brand}'=cmd->>'brand'),
   'internal_test',true,'commercial',false,'list_id',snapshot->'list_id','acceptance_proved',proved);
 END IF;
 IF cmd->>'acao' NOT IN('campanha_agendar','campanha_cancelar') OR cmd->>'confirm' IS DISTINCT FROM replace(cmd->>'acao','campanha_','')
  OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(cmd)x) IS DISTINCT FROM
   (CASE WHEN cmd->>'acao'='campanha_agendar' THEN ARRAY['acao','audience_review_id','brand','confirm','expected_version','id','idempotency_key'] ELSE ARRAY['acao','brand','confirm','expected_version','id','idempotency_key'] END)
  OR jsonb_typeof(operation) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(operation))<>2 OR NOT(operation ?& ARRAY['id','lease'])
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_INPUT';END IF;
 oid:=(operation->>'id')::uuid;olease:=(operation->>'lease')::uuid;
 -- Every native path uses campaign -> operation -> validation, including finish.
 SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
 SELECT * INTO STRICT op FROM public.shrigma_campaign_operation WHERE id=oid FOR UPDATE;
 h:=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(cmd)e(k,v)),'UTF8')),'hex');
 IF op.lease IS DISTINCT FROM olease OR op.actor IS DISTINCT FROM auth->>'actor' OR op.brand IS DISTINCT FROM cmd->>'brand'
  OR op.action IS DISTINCT FROM replace(cmd->>'acao','campanha_','') OR op.operation_key IS DISTINCT FROM cmd->>'idempotency_key'
  OR op.request_hash IS DISTINCT FROM h OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM op.brand
  OR op.provider_id IS NOT NULL AND op.provider_id<>cid
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_OPERATION_CHANGED';END IF;
 snapshot:=CASE WHEN op.action='cancelar' THEN crm_audience_v2.native_internal_snapshot_history_v1(cid) ELSE crm_audience_v2.native_internal_snapshot_v1(cid) END;IF snapshot IS NULL THEN RAISE EXCEPTION 'NATIVE_INTERNAL_SNAPSHOT_REFUSED';END IF;
 SELECT validation INTO v FROM public.shrigma_campaign_validation WHERE provider_id=cid FOR UPDATE;
 p:=v->'_native_internal';at:=clock_timestamp();
 IF kind='provider' AND action='native_prepare' THEN
  IF effect<>jsonb_build_object('kind','provider','action','native_prepare','payload',jsonb_build_object('id',cid,'operationId',oid,'expectedVersion',cmd->>'expected_version')||CASE WHEN op.action='agendar' THEN jsonb_build_object('audienceReviewId',cmd->>'audience_review_id') ELSE '{}'::jsonb END)
   OR op.state<>'pending' OR public.shrigma_campaign_current(cid)->>'version' IS DISTINCT FROM cmd->>'expected_version'
   OR c.sent<>0 OR c.started_at IS NOT NULL OR c.send_at IS NULL OR c.send_at<=at
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_PREPARE_REFUSED';END IF;
  IF p IS NOT NULL AND p->>'stage'<>'complete' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_TRANSITION_PENDING';END IF;
  IF op.action='agendar' THEN
   IF c.status::text<>'draft' OR c.send_at<at+interval '15 minutes' OR v->>'version' IS DISTINCT FROM cmd->>'expected_version'
    OR v->>'policy' IS DISTINCT FROM 'crm-campaign-v1' OR v->'ok' IS DISTINCT FROM 'true'::jsonb
    OR v#>>'{audience,review_id}' IS DISTINCT FROM cmd->>'audience_review_id'
    OR v#>>'{audience,campaign_version}' IS DISTINCT FROM cmd->>'expected_version'
    OR v#>>'{audience,brand}' IS DISTINCT FROM op.brand OR v#>'{audience,list_ids}' IS DISTINCT FROM jsonb_build_array(snapshot->'list_id')
   THEN RAISE EXCEPTION 'NATIVE_INTERNAL_REVIEW_REFUSED';END IF;
   expiry:=(v#>>'{audience,expires_at}')::timestamptz;checked:=(v#>>'{audience,checked_at}')::timestamptz;
   IF expiry IS NULL OR checked IS NULL OR checked>at OR expiry<=at OR expiry-checked<>interval '5 minutes' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_REVIEW_EXPIRED';END IF;
   private_audience:=public.shrigma_campaign_audience(cid);
   IF coalesce(v->>'_audience_fingerprint','')!~'^[a-f0-9]{64}$' OR private_audience->>'_fingerprint' IS DISTINCT FROM v->>'_audience_fingerprint' OR private_audience->'eligible_count' IS DISTINCT FROM '1'::jsonb
    OR private_audience->'native_disabled_count' IS DISTINCT FROM '0'::jsonb THEN RAISE EXCEPTION 'NATIVE_INTERNAL_AUDIENCE_CHANGED';END IF;
   audience:=(v->'audience')||jsonb_build_object('rechecked_at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  ELSE
   IF c.status::text<>'scheduled' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_CANCEL_REFUSED';END IF;
   expiry:=at+interval '2 minutes';audience:=NULL;
  END IF;
  p:=jsonb_build_object('contract','crm-native-internal-transition-v1','operation_id',oid,'lease',olease,'actor',op.actor,
   'request_hash',h,'credential_sha256',credential_hash,'brand',op.brand,'campaign_id',cid,'action',op.action,
   'stage',CASE WHEN op.action='agendar' THEN 'schedule' ELSE 'to_draft' END,'snapshot',snapshot,
   'material_sha256',encode(sha256(convert_to((to_jsonb(c)-ARRAY['status','send_at','updated_at'])::text,'UTF8')),'hex'),
   'current_version',cmd->>'expected_version','send_at',c.send_at,'expires_at',least(expiry,at+interval '2 minutes'),'audience',audience);
  INSERT INTO public.shrigma_campaign_validation(provider_id,validation) VALUES(cid,coalesce(v,'{}'::jsonb)||jsonb_build_object('_native_internal',p))
   ON CONFLICT(provider_id) DO UPDATE SET validation=excluded.validation,updated_at=clock_timestamp();
  UPDATE public.shrigma_campaign_operation SET provider_id=cid,updated_at=clock_timestamp() WHERE id=oid;
  RETURN jsonb_build_object('contract','crm-native-internal-plan-v1','campaign_id',cid,'campaign_uuid',c.uuid,'list_id',snapshot->'list_id','send_at',public.shrigma_campaign_current(cid)->'send_at','stage',p->>'stage');
 END IF;
 IF p->>'contract' IS DISTINCT FROM 'crm-native-internal-transition-v1' OR p->>'operation_id' IS DISTINCT FROM oid::text
  OR p->>'lease' IS DISTINCT FROM olease::text OR p->>'request_hash' IS DISTINCT FROM h OR p->>'credential_sha256' IS DISTINCT FROM credential_hash
  OR p->'snapshot' IS DISTINCT FROM snapshot OR p->>'actor' IS DISTINCT FROM op.actor
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_PERMIT_CHANGED';END IF;
 IF kind='provider' AND action='native_result' THEN
  IF effect<>jsonb_build_object('kind','provider','action','native_result','payload',jsonb_build_object('id',cid,'operationId',oid))
   OR op.state<>'succeeded' OR p->>'stage'<>'complete' OR op.response#>'{body,campaign}' IS DISTINCT FROM public.shrigma_campaign_current(cid)
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_RESULT_UNCONFIRMED';END IF;
  RETURN (op.response#>'{body,campaign}')||jsonb_build_object('native_internal',true)||CASE WHEN op.action='agendar' THEN jsonb_build_object('audience',op.response#>'{body,audience}') ELSE '{}'::jsonb END;
 END IF;
 IF effect ? 'action' OR (SELECT count(*) FROM jsonb_object_keys(effect))<>3 OR effect->>'idCampaign' IS DISTINCT FROM cid::text
  OR kind NOT IN('nativeStatus','nativeClear','nativeRead') THEN RAISE EXCEPTION 'NATIVE_INTERNAL_EFFECT_REFUSED';END IF;
 IF kind='nativeRead' THEN
  IF payload<>'{}'::jsonb OR op.state NOT IN('pending','succeeded','outcome_unknown') THEN RAISE EXCEPTION 'NATIVE_INTERNAL_EFFECT_REFUSED';END IF;
 ELSE
  IF (op.state='pending' OR (op.state='outcome_unknown' AND op.action='cancelar' AND p->>'stage'='clear_send_at' AND p#>>'{recovery,contract}'='crm-native-cancel-recovery-v1' AND p#>>'{recovery,operation_id}'=op.id::text AND p#>>'{recovery,request_hash}'=op.request_hash)) IS DISTINCT FROM true OR p->>'expires_at' IS NULL OR (p->>'expires_at')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'NATIVE_INTERNAL_PERMIT_EXPIRED';END IF;
  IF (kind='nativeStatus' AND NOT((p->>'stage'='schedule' AND payload=jsonb_build_object('status','scheduled')) OR(p->>'stage'='to_draft' AND payload=jsonb_build_object('status','draft')))
   OR kind='nativeClear' AND (p->>'stage'<>'clear_send_at' OR payload IS DISTINCT FROM jsonb_build_object('send_at',NULL,'lists',jsonb_build_array(snapshot->'list_id'),'attribs',c.attribs))) IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_EFFECT_REFUSED';END IF;
 END IF;
 RETURN jsonb_build_object('ok',true,'kind',kind,'operation_id',oid,'campaign_id',cid,'checked_at',clock_timestamp());
END $effect$;
CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_before_v1(oldc public.campaigns,newc public.campaigns) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $before$
DECLARE p jsonb;op public.shrigma_campaign_operation%ROWTYPE;snapshot jsonb;stage text;
BEGIN
 -- Preserve the exact status-only halt already admitted by the original guard.
 -- A stale bridge must never prevent an operator from stopping delivery.
 IF oldc.status::text IN('scheduled','running','paused') AND newc.status::text IN('paused','cancelled')
  AND (to_jsonb(newc)-ARRAY['status','updated_at'])=(to_jsonb(oldc)-ARRAY['status','updated_at']) THEN RETURN false;END IF;
 SELECT validation->'_native_internal' INTO p FROM public.shrigma_campaign_validation WHERE provider_id=oldc.id;
 IF p IS NULL OR p->>'stage'='complete' THEN RETURN false;END IF;
 SELECT * INTO STRICT op FROM public.shrigma_campaign_operation WHERE id=(p->>'operation_id')::uuid FOR UPDATE;
 SELECT validation->'_native_internal' INTO p FROM public.shrigma_campaign_validation WHERE provider_id=oldc.id FOR UPDATE;
 snapshot:=CASE WHEN op.action='cancelar' THEN crm_audience_v2.native_internal_snapshot_history_v1(oldc.id) ELSE crm_audience_v2.native_internal_snapshot_v1(oldc.id) END;stage:=p->>'stage';
 IF p->>'contract' IS DISTINCT FROM 'crm-native-internal-transition-v1' OR (op.state='pending' OR (op.state='outcome_unknown' AND op.action='cancelar' AND p->>'stage'='clear_send_at' AND p#>>'{recovery,contract}'='crm-native-cancel-recovery-v1' AND p#>>'{recovery,operation_id}'=op.id::text AND p#>>'{recovery,request_hash}'=op.request_hash)) IS DISTINCT FROM true OR op.provider_id IS DISTINCT FROM oldc.id OR op.lease::text IS DISTINCT FROM p->>'lease'
  OR op.actor IS DISTINCT FROM p->>'actor' OR op.brand IS DISTINCT FROM p->>'brand' OR op.action IS DISTINCT FROM p->>'action'
  OR op.request_hash IS DISTINCT FROM p->>'request_hash' OR snapshot IS NULL OR p->'snapshot' IS DISTINCT FROM snapshot
  OR NOT crm_audience_v2.native_internal_live_v1(op.actor,p->>'credential_sha256') OR p->>'expires_at' IS NULL OR (p->>'expires_at')::timestamptz<=clock_timestamp()
  OR p->>'current_version' IS DISTINCT FROM public.shrigma_campaign_current(oldc.id)->>'version'
  OR p->>'material_sha256' IS DISTINCT FROM encode(sha256(convert_to((to_jsonb(oldc)-ARRAY['status','send_at','updated_at'])::text,'UTF8')),'hex')
  OR (to_jsonb(newc)-ARRAY['status','send_at','updated_at']) IS DISTINCT FROM (to_jsonb(oldc)-ARRAY['status','send_at','updated_at'])
  OR oldc.send_at IS NULL OR (stage<>'clear_send_at' AND oldc.send_at<=clock_timestamp()) OR oldc.send_at IS DISTINCT FROM (p->>'send_at')::timestamptz OR newc.sent<>0 OR newc.started_at IS NOT NULL
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_TRANSITION_REFUSED';END IF;
 IF ((stage='schedule' AND op.action='agendar' AND oldc.status::text='draft' AND newc.status::text='scheduled'
   AND oldc.send_at>=clock_timestamp()+interval '15 minutes' AND newc.send_at IS NOT DISTINCT FROM oldc.send_at)
  OR(stage='to_draft' AND op.action='cancelar' AND oldc.status::text='scheduled' AND newc.status::text='draft' AND newc.send_at IS NOT DISTINCT FROM oldc.send_at)
  OR(stage='clear_send_at' AND op.action='cancelar' AND oldc.status::text='draft' AND newc.status::text='draft' AND newc.send_at IS NULL)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_TRANSITION_REFUSED';END IF;
 PERFORM set_config('shrigma.native_internal_operation',op.id::text,true);
 PERFORM set_config('shrigma.native_internal_xid',pg_current_xact_id()::text,true);RETURN true;
END $before$;
CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_after_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $after$
DECLARE p jsonb;op public.shrigma_campaign_operation%ROWTYPE;row jsonb;result_response jsonb;stage text;
BEGIN
 IF nullif(current_setting('shrigma.native_internal_operation',true),'') IS NULL THEN RETURN NEW;END IF;
 SELECT validation->'_native_internal' INTO p FROM public.shrigma_campaign_validation WHERE provider_id=NEW.id FOR UPDATE;
 IF p->>'operation_id' IS DISTINCT FROM current_setting('shrigma.native_internal_operation',true) OR p->>'stage'='complete' THEN RETURN NEW;END IF;
 SELECT * INTO STRICT op FROM public.shrigma_campaign_operation WHERE id=(p->>'operation_id')::uuid FOR UPDATE;
 IF (op.state='pending' OR (op.state='outcome_unknown' AND op.action='cancelar' AND p->>'stage'='clear_send_at' AND p#>>'{recovery,contract}'='crm-native-cancel-recovery-v1' AND p#>>'{recovery,operation_id}'=op.id::text AND p#>>'{recovery,request_hash}'=op.request_hash)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'NATIVE_INTERNAL_RECEIPT_REFUSED';END IF;
 row:=public.shrigma_campaign_current(NEW.id);stage:=p->>'stage';
 IF row->>'status' IS DISTINCT FROM NEW.status::text OR row->'sent' IS DISTINCT FROM '0'::jsonb OR row->'started_at' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'NATIVE_INTERNAL_READBACK_REFUSED';END IF;
 IF stage='to_draft' AND NEW.status::text='draft' AND NEW.send_at IS NOT NULL THEN
  p:=p||jsonb_build_object('stage','clear_send_at','current_version',row->>'version');
 ELSIF(stage='schedule' AND NEW.status::text='scheduled' AND NEW.send_at IS NOT NULL)
  OR(stage='clear_send_at' AND NEW.status::text='draft' AND NEW.send_at IS NULL) THEN
  result_response:=jsonb_build_object('status',200,'body',jsonb_build_object('campaign',row,'operation_id',op.id,'native_internal',true)||CASE WHEN op.action='agendar' THEN jsonb_build_object('audience',p->'audience') ELSE '{}'::jsonb END);
  IF op.state='outcome_unknown' THEN result_response:=jsonb_set(result_response,'{body}',(result_response->'body')||jsonb_build_object('reconciliation',p->'recovery'));END IF;
  UPDATE public.shrigma_campaign_operation SET state='succeeded',response=result_response,provider_id=NEW.id,updated_at=clock_timestamp() WHERE id=op.id;
  p:=p||jsonb_build_object('stage','complete','current_version',row->>'version','completion_xid',pg_current_xact_id()::text);
 ELSE RAISE EXCEPTION 'NATIVE_INTERNAL_READBACK_REFUSED';END IF;
 UPDATE public.shrigma_campaign_validation SET validation=jsonb_set(validation,'{_native_internal}',p),updated_at=clock_timestamp() WHERE provider_id=NEW.id;
 RETURN NEW;
END $after$;
CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_relation_v1(cid integer,oldrow jsonb,newrow jsonb,operation text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $relation$
DECLARE p jsonb;op public.shrigma_campaign_operation%ROWTYPE;c public.campaigns%ROWTYPE;snapshot jsonb;
BEGIN
 SELECT * INTO c FROM public.campaigns WHERE id=cid FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT validation->'_native_internal' INTO p FROM public.shrigma_campaign_validation WHERE provider_id=cid;
 IF p IS NULL THEN RETURN false;END IF;
 IF operation='DELETE' OR newrow->>'campaign_id' IS DISTINCT FROM cid::text OR newrow->>'list_id' IS DISTINCT FROM p#>>'{snapshot,list_id}' THEN RETURN false;END IF;
 IF operation='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM public.campaign_lists cl WHERE cl.campaign_id=cid AND cl.list_id=(newrow->>'list_id')::integer AND cl.list_name IS NOT DISTINCT FROM newrow->>'list_name') THEN RETURN false;END IF;
 ELSIF operation='UPDATE' THEN IF newrow IS DISTINCT FROM oldrow THEN RETURN false;END IF;
 ELSE RETURN false;END IF;
 SELECT * INTO STRICT op FROM public.shrigma_campaign_operation WHERE id=(p->>'operation_id')::uuid FOR UPDATE;
 SELECT validation->'_native_internal' INTO p FROM public.shrigma_campaign_validation WHERE provider_id=cid FOR UPDATE;
 snapshot:=crm_audience_v2.native_internal_snapshot_history_v1(cid);
 IF p->>'contract' IS DISTINCT FROM 'crm-native-internal-transition-v1' OR op.action IS DISTINCT FROM 'cancelar'
  OR op.provider_id IS DISTINCT FROM cid OR op.id::text IS DISTINCT FROM p->>'operation_id'
  OR op.lease::text IS DISTINCT FROM p->>'lease' OR op.actor IS DISTINCT FROM p->>'actor'
  OR op.brand IS DISTINCT FROM p->>'brand' OR op.action IS DISTINCT FROM p->>'action'
  OR op.request_hash IS DISTINCT FROM p->>'request_hash' OR snapshot IS NULL OR p->'snapshot' IS DISTINCT FROM snapshot
 THEN RETURN false;END IF;
 -- Preserve both existing orders once the campaign BEFORE / AFTER trigger ran.
 IF p->>'operation_id'=nullif(current_setting('shrigma.native_internal_operation',true),'')
  AND ((op.state='succeeded' AND p->>'stage'='complete' AND p->>'completion_xid'=pg_current_xact_id()::text)
   OR((op.state='pending' OR (op.state='outcome_unknown' AND op.action='cancelar' AND p->>'stage'='clear_send_at' AND p#>>'{recovery,contract}'='crm-native-cancel-recovery-v1' AND p#>>'{recovery,operation_id}'=op.id::text AND p#>>'{recovery,request_hash}'=op.request_hash)) AND p->>'stage'='clear_send_at' AND nullif(current_setting('shrigma.native_internal_xid',true),'')=pg_current_xact_id()::text))
 THEN RETURN true;END IF;
 -- Before UPDATE: only an already present, byte-identical relation is admitted.
 -- This does not set transition markers or finalize the original operation.
 RETURN (op.state='pending' OR (op.state='outcome_unknown' AND op.action='cancelar' AND p->>'stage'='clear_send_at' AND p#>>'{recovery,contract}'='crm-native-cancel-recovery-v1' AND p#>>'{recovery,operation_id}'=op.id::text AND p#>>'{recovery,request_hash}'=op.request_hash)) AND p->>'stage'='clear_send_at' AND c.status::text='draft'
  AND c.sent=0 AND c.started_at IS NULL AND c.send_at IS NOT NULL
  AND c.send_at=(p->>'send_at')::timestamptz
  AND p->>'expires_at' IS NOT NULL AND (p->>'expires_at')::timestamptz>clock_timestamp()
  AND crm_audience_v2.native_internal_live_v1(op.actor,p->>'credential_sha256')
  AND p->>'current_version'=public.shrigma_campaign_current(cid)->>'version'
  AND p->>'material_sha256'=encode(sha256(convert_to((to_jsonb(c)-ARRAY['status','send_at','updated_at'])::text,'UTF8')),'hex');
END $relation$;
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
 IF p_effect->>'kind' IN('nativeContext','nativeStatus','nativeRead','nativeClear','nativeCancelRecovery') OR(p_effect->>'kind'='provider' AND p_effect->>'action' IN('native_prepare','native_result')) THEN
  RETURN crm_audience_v2.native_internal_effect_v1(p_key,p_envelope,p_effect);
 END IF;
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

 -- Native timeout/finish follows the trigger's campaign -> operation order.
 IF kind_name='store' AND effect_action='finish' THEN
  PERFORM c.id FROM public.campaigns c JOIN public.shrigma_campaign_validation v ON v.provider_id=c.id
  JOIN public.shrigma_campaign_operation o ON o.id::text=v.validation#>>'{_native_internal,operation_id}'
  WHERE o.id::text=operation->>'id' AND o.lease::text=operation->>'lease' AND o.actor=actor_name
   AND o.brand=brand_name AND o.action=action_name AND o.provider_id=c.id
  FOR UPDATE OF c;
 END IF;
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
DO $fence$ DECLARE p record;e record;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'NATIVE_INSTALLER_ROLE';END IF;
 FOR e IN SELECT * FROM jsonb_to_recordset('[{"signature":"crm_audience_v2.native_internal_effect_v1(text,jsonb,jsonb)","body_md5":"ec6870b3b1004528fc0c1406157d0a83","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_before_v1(public.campaigns,public.campaigns)","body_md5":"7bcf0ec3fc832f427a9b4237dc0b4750","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_after_v1()","body_md5":"a36cabda732c65d0e1bd0fc7baf26577","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"crm_audience_v2.native_internal_relation_v1(integer,jsonb,jsonb,text)","body_md5":"9a7bbf35e85e1e919cec93b4a30502ac","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog"],"acl":"{postgres=X/postgres}"},{"signature":"public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb)","body_md5":"035f998fa67c8849f597bf76f4bafb72","owner":"postgres","security_definer":true,"volatility":"v","proconfig":["search_path=pg_catalog, public"],"acl":"{postgres=X/postgres,crm_campaign_api=X/postgres}"}]'::jsonb) AS x(signature text,body_md5 text,owner text,security_definer boolean,volatility text,proconfig jsonb,acl text) LOOP
 SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e.signature);
 IF md5(p.prosrc) IS DISTINCT FROM e.body_md5 OR pg_get_userbyid(p.proowner) IS DISTINCT FROM e.owner OR p.prosecdef IS DISTINCT FROM e.security_definer OR p.provolatile::text IS DISTINCT FROM e.volatility OR to_jsonb(p.proconfig) IS DISTINCT FROM e.proconfig OR p.proacl::text IS DISTINCT FROM e.acl THEN RAISE EXCEPTION 'NATIVE_RECOVERY_FUNCTION_DRIFT';END IF;
 END LOOP;END $fence$;
COMMIT;
