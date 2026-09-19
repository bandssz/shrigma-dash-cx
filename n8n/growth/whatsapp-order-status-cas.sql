-- Prepared migration only. Install separately after review; it does not activate
-- a stage by itself. Invocation requires the existing publish credential, six
-- current provider approvals, three verified runtimes and four exact snapshots.
-- Execute the COMPLETE migration on one pinned connection/transaction. Never
-- split CREATE and REVOKE into separately committed or pooled requests.
BEGIN;
CREATE OR REPLACE FUNCTION public.shrigma_wa_order_status_activate_v1(p_key text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp
SET lock_timeout = '3s'
AS $function$
DECLARE
 auth jsonb; v_actor text; v_idem text; previous public.shrigma_flow_request%ROWTYPE;
 u jsonb; c jsonb; t jsonb; src jsonb; r jsonb; f public.shrigma_flow_definition%ROWTYPE;
 step_before jsonb; binding_before jsonb; expected_next jsonb; fields jsonb;
 normalized jsonb; checked_at timestamptz; field_name text; target_name text;
 target_ids text[] := ARRAY[]::text[]; stage_keys text[] := ARRAY[]::text[];
 flow_keys text[] := ARRAY['aristo:pedido-recebido','aristo:rastreio','fish:pedido-recebido','fish:rastreio'];
 target_names text[] := ARRAY['aristocrata_pedido_pago_claro_v2','aristocrata_rastreio_claro_v2','aristocrata_rastreio_criado_claro_v2','fishermans_pedido_pago_claro_v2','fishermans_rastreio_claro_v2','fishermans_rastreio_criado_claro_v2'];
 runtime_roles text[] := ARRAY[]::text[]; count_locked integer := 0; validation_flow text; flows_result jsonb := '[]'::jsonb; result jsonb;
BEGIN
 auth := public.shrigma_template_auth_v2(p_key);
 v_actor := auth->>'who';
 IF v_actor IS NULL OR NOT coalesce((auth->'caps') ? 'submit',false) THEN
  RETURN jsonb_build_object('_http',403,'_body',jsonb_build_object('error','publish_capability_required','nothing_changed',true));
 END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>2097152 THEN
  RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('error','invalid_request','nothing_changed',true));
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('idempotency_key','catalog_checked_at','catalog','contracts','updates','runtime')) THEN
  RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('error','unexpected_request_field','nothing_changed',true));
 END IF;
 v_idem:=p->>'idempotency_key';
 IF coalesce(v_idem,'') !~ '^[A-Za-z0-9_.:-]{8,128}$' THEN
  RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('error','idempotency_required','nothing_changed',true));
 END IF;
 -- Same lock namespace as the existing journey API. Intent is recorded by the
 -- private operator before the call; this receipt is committed with all changes.
 PERFORM pg_advisory_xact_lock(hashtextextended('flow-idem:'||v_idem,0));
 SELECT * INTO previous FROM public.shrigma_flow_request WHERE shrigma_flow_request.idem=v_idem FOR UPDATE;
 IF FOUND THEN
  IF previous.actor IS DISTINCT FROM v_actor OR previous.payload IS DISTINCT FROM p THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','idempotency_replay_mismatch','nothing_changed',true));
  END IF;
  RETURN previous.response; -- exact original receipt, even after the proof ages.
 END IF;
 IF jsonb_typeof(p->'updates') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'updates')<>4
  OR jsonb_typeof(p->'contracts') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'contracts')<>6
  OR jsonb_typeof(p->'catalog') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'catalog')<>12
  OR jsonb_typeof(p->'runtime') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'runtime')<>3 THEN
  RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('error','exact_rollout_scope_required','nothing_changed',true));
 END IF;
 IF (SELECT array_agg(x->>'key' ORDER BY x->>'key') FROM jsonb_array_elements(p->'updates') x) IS DISTINCT FROM flow_keys
  OR (SELECT array_agg(x->'target'->>'name' ORDER BY x->'target'->>'name') FROM jsonb_array_elements(p->'contracts') x) IS DISTINCT FROM target_names THEN
  RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('error','rollout_scope_changed','nothing_changed',true));
 END IF;
 IF coalesce(p->>'catalog_checked_at','') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T' THEN
  RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('error','catalog_timestamp_required','nothing_changed',true));
 END IF;
 checked_at:=(p->>'catalog_checked_at')::timestamptz;
 IF checked_at>clock_timestamp()+interval '30 seconds' OR checked_at<clock_timestamp()-interval '15 minutes' THEN
  RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','catalog_proof_not_current','nothing_changed',true));
 END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'runtime') LOOP
  IF r->>'role'=ANY(runtime_roles) OR coalesce(r->>'role','') NOT IN ('caller:aristo','caller:fish','motor')
   OR (r->>'workflow_id') IS DISTINCT FROM (CASE r->>'role' WHEN 'caller:aristo' THEN '54waQbYEjCHDLwgA' WHEN 'caller:fish' THEN 'EfSf4rTJb3krbBV2' WHEN 'motor' THEN 'xobYQ1VfScmUHVeV' END)
   OR r->'active' IS DISTINCT FROM 'true'::jsonb OR r->'readback_exact' IS DISTINCT FROM 'true'::jsonb
   OR coalesce(r->>'version_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR (r->>'active_version_id') IS DISTINCT FROM (r->>'version_id')
   OR coalesce(r->>'expected_code_sha256','') !~ '^[0-9a-f]{64}$'
   OR (r->>'code_sha256') IS DISTINCT FROM (r->>'expected_code_sha256')
   OR coalesce(r->>'checked_at','') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T' THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','runtime_proof_incomplete','nothing_changed',true));
  END IF;
  IF (r->>'checked_at')::timestamptz>clock_timestamp()+interval '30 seconds' OR (r->>'checked_at')::timestamptz<clock_timestamp()-interval '15 minutes' THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','runtime_proof_not_current','nothing_changed',true));
  END IF;
  IF r->>'role'='motor' AND r->'contracts' IS DISTINCT FROM p->'contracts' THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','active_motor_contract_differs','nothing_changed',true));
  END IF;
  runtime_roles:=array_append(runtime_roles,r->>'role');
 END LOOP;
 -- Lock all four targets in stable order. No data mutation occurs during checks.
 FOR f IN SELECT * FROM public.shrigma_flow_definition WHERE key=ANY(flow_keys) ORDER BY key FOR UPDATE LOOP
  count_locked:=count_locked+1;
  SELECT x INTO u FROM jsonb_array_elements(p->'updates') x WHERE x->>'key'=f.key;
  IF to_jsonb(f) IS DISTINCT FROM u->'expected' THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','snapshot_conflict','flow_key',f.key,'nothing_changed',true));
  END IF;
  IF f.draft IS DISTINCT FROM f.published OR f.version IS DISTINCT FROM f.published_version OR f.runtime_ready IS DISTINCT FROM true THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','unpublished_or_unready_flow','flow_key',f.key,'nothing_changed',true));
  END IF;
  IF jsonb_typeof(u->'steps') IS DISTINCT FROM 'array' OR
   (SELECT jsonb_agg(x->>'step_key' ORDER BY x->>'step_key') FROM jsonb_array_elements(p->'contracts') x WHERE x->>'flow_key'=f.key)
   IS DISTINCT FROM (SELECT jsonb_agg(x ORDER BY x) FROM jsonb_array_elements(u->'steps') x) THEN
   RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('error','audit_steps_mismatch','nothing_changed',true));
  END IF;
  expected_next:=to_jsonb(f)||jsonb_build_object('version',f.version+1,'published_version',f.version+1);
  FOR c IN SELECT value FROM jsonb_array_elements(p->'contracts') WHERE value->>'flow_key'=f.key LOOP
   target_name:=c->'target'->>'name';
   IF c->>'brand' IS DISTINCT FROM f.brand OR c->>'source_version' IS DISTINCT FROM f.version::text
    OR (target_name LIKE 'fishermans_%') IS DISTINCT FROM (f.brand='fish')
    OR coalesce(c->>'caller_template_id','') !~ '^[0-9]+$'
    OR coalesce(c->>'source_template_id','') !~ '^[0-9]+$'
    OR coalesce(c->'target'->>'id','') !~ '^[0-9]+$'
    OR c->'target'->>'id'=ANY(target_ids) OR (f.key||'|'||(c->>'step_key'))=ANY(stage_keys)
    OR (c->>'piece') IS DISTINCT FROM (CASE WHEN target_name LIKE '%_pedido_pago_claro_v2' THEN 'pedido-pago' ELSE 'rastreio-criado' END)
    OR f.key IS DISTINCT FROM f.brand||(CASE WHEN c->>'piece'='pedido-pago' THEN ':pedido-recebido' ELSE ':rastreio' END) THEN
    RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('error','contract_scope_invalid','nothing_changed',true));
   END IF;
   target_ids:=array_append(target_ids,c->'target'->>'id');stage_keys:=array_append(stage_keys,f.key||'|'||(c->>'step_key'));
   SELECT x INTO t FROM jsonb_array_elements(p->'catalog') x WHERE x->>'brand'=f.brand AND x->>'id'=c->'target'->>'id';
   SELECT x INTO src FROM jsonb_array_elements(p->'catalog') x WHERE x->>'brand'=f.brand AND x->>'id'=c->>'source_template_id';
   IF (SELECT count(*) FROM jsonb_array_elements(p->'catalog') x WHERE x->>'id'=c->'target'->>'id')<>1
    OR (SELECT count(*) FROM jsonb_array_elements(p->'catalog') x WHERE x->>'id'=c->>'source_template_id')<>1
    OR t->>'name' IS DISTINCT FROM target_name OR t->>'status' IS DISTINCT FROM 'APPROVED'
    OR t->>'category' IS DISTINCT FROM 'UTILITY' OR t->>'language' IS DISTINCT FROM 'pt_BR'
    OR c->'target'->>'status' IS DISTINCT FROM 'APPROVED' OR c->'target'->>'category' IS DISTINCT FROM 'UTILITY' OR c->'target'->>'language' IS DISTINCT FROM 'pt_BR'
    OR public.shrigma_wa_review_content(t->'components') IS DISTINCT FROM public.shrigma_wa_review_content(c->'target'->'components')
    OR src->>'name' IS DISTINCT FROM c->>'source_template_name' OR src->>'status' IS DISTINCT FROM 'APPROVED'
    OR src->>'category' IS DISTINCT FROM 'UTILITY' OR src->>'language' IS DISTINCT FROM 'pt_BR'
    OR replace(src->>'name','_claro_v1','_claro_v2') IS DISTINCT FROM target_name THEN
    RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','provider_approval_or_content_changed','nothing_changed',true));
   END IF;
   normalized:=public.shrigma_wa_review_content(src->'components');
   IF normalized->'buttons'->0->>'type' IS DISTINCT FROM 'URL'
    OR coalesce(normalized->'buttons'->0->>'url','') NOT LIKE 'https://conta.'||(CASE f.brand WHEN 'fish' THEN 'fishermans.com.br' ELSE 'oaristocrata.com' END)||'/%'
    OR jsonb_array_length(normalized->'buttons')<>2 THEN
    RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','source_button_changed','nothing_changed',true));
   END IF;
   normalized:=jsonb_set(normalized,'{buttons,0,url}',to_jsonb('https://'||CASE f.brand WHEN 'fish' THEN 'fishermans.com.br' ELSE 'oaristocrata.com' END||'/{{1}}'));
   IF normalized IS DISTINCT FROM public.shrigma_wa_review_content(t->'components') THEN
    RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','only_order_url_may_change','nothing_changed',true));
   END IF;
   SELECT x INTO binding_before FROM jsonb_array_elements(f.binding->'steps') x WHERE x->>'key'=c->>'step_key';
   IF coalesce(binding_before->>'source_template_id','')<>'' AND binding_before->>'source_template_id' IS DISTINCT FROM c->>'caller_template_id' THEN
    RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','caller_selector_changed','nothing_changed',true));
   END IF;
   fields:=jsonb_build_object('template_id',c->'target'->>'id','template_name',target_name,'category','UTILITY','signature',public.shrigma_wa_signature(t->'components'));
   FOREACH field_name IN ARRAY ARRAY['binding','draft','published'] LOOP
    IF (SELECT count(*) FROM jsonb_array_elements(to_jsonb(f)->field_name->'steps') x WHERE x->>'key'=c->>'step_key')<>1 THEN
     RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','stage_missing_or_duplicated','nothing_changed',true));
    END IF;
    SELECT x INTO step_before FROM jsonb_array_elements(to_jsonb(f)->field_name->'steps') x WHERE x->>'key'=c->>'step_key';
    IF step_before->>'template_id' IS DISTINCT FROM c->>'source_template_id' OR step_before->>'template_name' IS DISTINCT FROM c->>'source_template_name'
     OR step_before->>'channel' IS DISTINCT FROM 'whatsapp' OR step_before->>'flow' IS DISTINCT FROM 'transacional' OR step_before->>'piece' IS DISTINCT FROM c->>'piece' THEN
     RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','stage_source_changed','nothing_changed',true));
    END IF;
    expected_next:=jsonb_set(expected_next,ARRAY[field_name,'steps'],(SELECT jsonb_agg(CASE WHEN x->>'key'=c->>'step_key' THEN x||fields ELSE x END ORDER BY ord) FROM jsonb_array_elements(expected_next->field_name->'steps') WITH ORDINALITY a(x,ord)));
   END LOOP;
  END LOOP;
  IF expected_next IS DISTINCT FROM u->'next' THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','unexpected_stage_change','flow_key',f.key,'nothing_changed',true));
  END IF;
  IF EXISTS(SELECT 1 FROM public.shrigma_flow_revision WHERE flow_key=f.key AND version=f.version+1) THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','revision_already_exists','flow_key',f.key,'nothing_changed',true));
  END IF;
 END LOOP;
 IF count_locked<>4 OR cardinality(stage_keys)<>6 THEN
  RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','rollout_targets_missing','nothing_changed',true));
 END IF;
 -- Registry must be visible to the EXISTING stage validator. Keep its upserts
 -- and every later write inside one subtransaction: even a validation rejection
 -- rolls them back. Unexpected SQL errors propagate and abort the whole call.
 BEGIN
 FOR c IN SELECT value FROM jsonb_array_elements(p->'contracts') LOOP
  SELECT x INTO t FROM jsonb_array_elements(p->'catalog') x WHERE x->>'brand'=c->>'brand' AND x->>'id'=c->'target'->>'id';
  INSERT INTO public.shrigma_flow_template(brand,id,data) VALUES(c->>'brand',c->'target'->>'id',t)
   ON CONFLICT(brand,id) DO UPDATE SET data=excluded.data;
 END LOOP;
 FOR u IN SELECT value FROM jsonb_array_elements(p->'updates') ORDER BY value->>'key' LOOP
  IF public.shrigma_flow_validate(u->'next'->'published',u->'next'->'binding') IS DISTINCT FROM '[]'::jsonb THEN
   validation_flow:=u->>'key';
   RAISE EXCEPTION USING ERRCODE='PWA01',MESSAGE='stage_validation_failed';
  END IF;
 END LOOP;
 FOR u IN SELECT value FROM jsonb_array_elements(p->'updates') ORDER BY value->>'key' LOOP
  UPDATE public.shrigma_flow_definition SET binding=u->'next'->'binding',draft=u->'next'->'draft',published=u->'next'->'published',version=(u->'next'->>'version')::bigint,published_version=(u->'next'->>'published_version')::bigint,updated_by=v_actor,updated_at=clock_timestamp()
   WHERE key=u->>'key' RETURNING * INTO f;
  INSERT INTO public.shrigma_flow_revision(flow_key,version,definition,actor) VALUES(f.key,f.version,f.published,v_actor);
  INSERT INTO public.shrigma_flow_audit(flow_key,actor,action,version,detail) VALUES(f.key,v_actor,'order_status_rollout_v1',f.version,jsonb_build_object('operation_key',v_idem,'steps',u->'steps'));
  flows_result:=flows_result||jsonb_build_array(jsonb_build_object('key',f.key,'version',f.version,'published_version',f.published_version));
 END LOOP;
 result:=jsonb_build_object('_http',200,'_body',jsonb_build_object('state','activated','operation_key',v_idem,'flows',flows_result,'template_ids',to_jsonb(target_ids),'activated_at',clock_timestamp(),'recipients',0,'messages',0));
 INSERT INTO public.shrigma_flow_request(idem,actor,payload,response) VALUES(v_idem,v_actor,p,result);
 RETURN result;
 EXCEPTION WHEN SQLSTATE 'PWA01' THEN
  RETURN jsonb_build_object('_http',422,'_body',jsonb_build_object('error','stage_validation_failed','flow_key',validation_flow,'nothing_changed',true));
 END;
END;
$function$;
-- Ownership/privileges are unchanged for existing services. Only the installing
-- DB owner can call the new function until a separately reviewed grant is made.
REVOKE ALL ON FUNCTION public.shrigma_wa_order_status_activate_v1(text,jsonb) FROM PUBLIC;
COMMIT;
