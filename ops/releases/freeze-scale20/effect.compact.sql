CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_effect_v1(k text, envelope jsonb, effect jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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

 -- Private read used by the existing consent task. It never changes consent,
 -- campaign state or the schedule guards. All members remain in Postgres.
 IF kind='nativeContext' AND payload->>'purpose'='consent_scope' THEN
  IF cmd->>'acao' IS DISTINCT FROM 'campanha_nativa_contexto' OR operation IS DISTINCT FROM 'null'::jsonb
   OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(cmd)x) IS DISTINCT FROM ARRAY['acao','brand','id']
   OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(effect)x) IS DISTINCT FROM ARRAY['kind','payload']
   OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(payload)x) IS DISTINCT FROM
    (CASE WHEN payload ? 'subscriberId' THEN ARRAY['createKey','freezeKey','id','purpose','subscriberId'] ELSE ARRAY['createKey','freezeKey','id','purpose'] END)
   OR payload->>'id' IS DISTINCT FROM cid::text
   OR coalesce(payload->>'freezeKey','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR coalesce(payload->>'createKey','')!~'^bff-[a-f0-9]{64}$'
   OR payload ? 'subscriberId' AND coalesce(payload->>'subscriberId','')!~'^[1-9][0-9]{0,9}$'
  THEN RAISE EXCEPTION 'CONSENT_SCOPE_INPUT';END IF;
  SELECT req.response->'_body' INTO STRICT snapshot
  FROM public.campaigns cc
  JOIN public.shrigma_campaign_operation created ON created.id::text=cc.attribs#>>'{crm,created_operation_id}'
  JOIN crm_audience_v2.request req ON req.actor=created.actor AND req.brand=created.brand AND req.operation_key=effect#>>'{payload,freezeKey}'
  WHERE cc.id=cid AND cc.id NOT IN(185,188,189,190,191,198,207,208)
   AND cc.created_at>='2026-10-17T18:00:00Z'::timestamptz
   AND cc.type::text='regular' AND cc.messenger='email'
   AND cc.attribs#>>'{crm,policy}'='crm-campaign-v1' AND cc.attribs#>>'{crm,brand}'=cmd->>'brand'
   AND created.actor=auth->>'actor' AND created.operation_key=effect#>>'{payload,createKey}'
   AND created.brand=cmd->>'brand' AND created.action='salvar' AND created.state='succeeded' AND created.provider_id=cc.id
   AND created.response->'status'='201'::jsonb AND created.response#>>'{body,campaign,id}'=cc.id::text
   AND created.response#>'{body,campaign,definition,list_ids}'=jsonb_build_array((req.response#>>'{_body,list_id}')::integer)
   AND req.payload->>'acao'='segmento_congelar_nativo_interno' AND req.payload->>'brand'=req.brand
   AND req.payload->>'idempotency_key'=req.operation_key AND req.response->'_http'='200'::jsonb
   AND req.response#>>'{_body,contract}'='crm-native-frozen-list-v3' AND req.response#>>'{_body,brand}'=req.brand
   AND req.response#>>'{_body,audience_id}'=req.payload->>'id'
   AND req.response#>'{_body,audience_version}'=req.payload->'expected_version'
   AND req.response#>>'{_body,definition_hash}'=req.payload->>'expected_definition_hash'
   AND req.payload_hash=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(req.payload)e(k,v)),'UTF8')),'hex');
  IF (snapshot->>'eligible_count')::bigint<1 OR snapshot#>>'{base,id}' IS DISTINCT FROM (CASE cmd->>'brand' WHEN 'aristo' THEN '16' ELSE '17' END)
   OR NOT EXISTS(SELECT 1 FROM public.campaign_lists cl JOIN public.lists l ON l.id=cl.list_id
    WHERE cl.campaign_id=cid AND l.id=(snapshot->>'list_id')::integer AND l.uuid::text=snapshot->>'list_uuid'
     AND l.type::text='private' AND l.status::text='active' AND l.optin::text=snapshot->>'list_optin' AND public.shrigma_campaign_list_brand(l)=cmd->>'brand')
   OR (SELECT count(*) FROM public.campaign_lists cl WHERE cl.campaign_id=cid)<>1
   OR EXISTS(SELECT 1 FROM public.campaign_lists cl WHERE cl.list_id=(snapshot->>'list_id')::integer AND cl.campaign_id<>cid)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'origins') origin
    LEFT JOIN public.lists l ON l.id=(origin->>'id')::integer
    WHERE l.id IS NULL OR l.uuid::text IS DISTINCT FROM origin->>'uuid' OR l.optin::text IS DISTINCT FROM origin->>'optin'
     OR l.status::text IS DISTINCT FROM origin->>'status' OR public.shrigma_campaign_list_brand(l) IS DISTINCT FROM cmd->>'brand')
  THEN RAISE EXCEPTION 'CONSENT_SCOPE_CHANGED';END IF;
  SELECT jsonb_build_object('eligible_count',count(*),
   'members_sha256',encode(sha256(convert_to('['||string_agg(sl.subscriber_id::text,',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex'),
   'members_state_sha256',encode(sha256(convert_to('['||string_agg('['||sl.subscriber_id::text||','||to_json(sl.status::text)::text||']',',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex'),
   'members_identity_sha256',encode(sha256(convert_to('['||string_agg('['||s.id::text||','||to_json(s.uuid::text)::text||']',',' ORDER BY s.id)||']','UTF8')),'hex'),
   'members_meta_sha256',encode(sha256(convert_to(jsonb_agg(jsonb_build_array(sl.subscriber_id,sl.meta) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex'),
   'member_uuid',max(s.uuid::text) FILTER(WHERE sl.subscriber_id=(effect#>>'{payload,subscriberId}')::integer))
  INTO v FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id WHERE sl.list_id=(snapshot->>'list_id')::integer;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['eligible_count','members_sha256','members_identity_sha256','members_meta_sha256'])field WHERE v->field IS DISTINCT FROM snapshot->field)
  THEN RAISE EXCEPTION 'CONSENT_SCOPE_CHANGED';END IF;
  h:=v->>'member_uuid';
  IF payload ? 'subscriberId' AND h IS NULL THEN RAISE EXCEPTION 'CONSENT_MEMBER_SCOPE';END IF;
  RETURN v||jsonb_build_object('confirmed',true,'list_id',snapshot->'list_id','list_uuid',snapshot->'list_uuid',
   'campaign_uuid',(SELECT uuid FROM public.campaigns WHERE id=cid),'created_operation_id',(SELECT attribs#>>'{crm,created_operation_id}' FROM public.campaigns WHERE id=cid),
   'freeze_key',payload->>'freezeKey','member_uuid',h);
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
   AND (left(name,char_length('[QA SAB17] Agenda nativa '))='[QA SAB17] Agenda nativa ' OR crm_audience_v2.native_internal_snapshot_history_v1(cid)->>'freeze_contract'='crm-native-frozen-list-v3')) THEN
   RETURN jsonb_build_object('schema','crm-native-internal-context-v1','brand',cmd->>'brand','campaign_id',cid,'eligible',false,'internal_test',true,'commercial',false,'list_id',NULL,'acceptance_proved',proved);
  END IF;
  snapshot:=CASE WHEN EXISTS(SELECT 1 FROM public.campaigns WHERE id=cid AND status::text='scheduled') THEN crm_audience_v2.native_internal_snapshot_history_v1(cid) ELSE crm_audience_v2.native_internal_snapshot_v1(cid) END;
  RETURN jsonb_build_object('schema','crm-native-internal-context-v1','brand',cmd->>'brand','campaign_id',cid,
   'eligible',snapshot IS NOT NULL AND EXISTS(SELECT 1 FROM public.campaigns WHERE id=cid AND attribs#>>'{crm,brand}'=cmd->>'brand'),
   'internal_test',snapshot->>'freeze_contract' IS DISTINCT FROM 'crm-native-frozen-list-v3','commercial',snapshot->>'freeze_contract' IS NOT DISTINCT FROM 'crm-native-frozen-list-v3','list_id',snapshot->'list_id','acceptance_proved',proved)||CASE WHEN snapshot->>'freeze_contract'='crm-native-frozen-list-v3' THEN jsonb_build_object('freeze_contract',snapshot->>'freeze_contract','eligible_count',snapshot->'eligible_count','audience_id',snapshot->'audience_id','audience_version',snapshot->'audience_version','base',snapshot->'base','origins',snapshot->'origins') ELSE '{}'::jsonb END;
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
   IF coalesce(v->>'_audience_fingerprint','')!~'^[a-f0-9]{64}$' OR private_audience->>'_fingerprint' IS DISTINCT FROM v->>'_audience_fingerprint' OR private_audience->'eligible_count' IS DISTINCT FROM (CASE WHEN snapshot->>'freeze_contract'='crm-native-frozen-list-v3' THEN snapshot->'eligible_count' ELSE '1'::jsonb END)
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
END $function$

