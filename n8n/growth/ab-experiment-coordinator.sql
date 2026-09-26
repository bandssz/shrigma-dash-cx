-- Growth A/B candidate. Install only with the complete disabled adapter.
-- Reuses CRM campaign validation; never compiles or sends an email here.
BEGIN;
CREATE TABLE public.crm_ab_review_v2(
 test_id uuid PRIMARY KEY REFERENCES public.crm_ab_experiment_v2(test_id),review_id uuid NOT NULL UNIQUE,
 actor text NOT NULL,experiment_version integer NOT NULL,checked_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 evidence jsonb NOT NULL, CHECK(expires_at=checked_at+interval '5 minutes')
);
REVOKE ALL ON public.crm_ab_review_v2 FROM PUBLIC;

CREATE FUNCTION public.crm_ab_review_evidence_v2(tid uuid,source_reviews jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $fn$
DECLARE e public.crm_ab_experiment_v2%ROWTYPE;a public.crm_ab_arm_v2%ROWTYPE;c public.campaigns%ROWTYPE;
 current_row jsonb;v jsonb;aud jsonb;all_evidence jsonb:='[]';counts jsonb;send_at timestamptz;checked timestamptz;expiry timestamptz;
BEGIN
 SELECT * INTO STRICT e FROM public.crm_ab_experiment_v2 WHERE test_id=tid;
 IF e.state<>'prepared' THEN RAISE EXCEPTION 'AB_V2_STATE';END IF;
 IF jsonb_typeof(source_reviews) IS DISTINCT FROM 'object' OR (source_reviews-ARRAY['a','b'])<>'{}'
  OR NOT(source_reviews ?& ARRAY['a','b']) THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_REVIEW_REQUIRED';END IF;
 -- Same locking order as allocation and the standard campaign provider.
 PERFORM c0.id FROM public.campaigns c0 JOIN public.crm_ab_arm_v2 a0 ON a0.campaign_id=c0.id WHERE a0.test_id=tid ORDER BY c0.id FOR UPDATE OF c0;
 PERFORM l.id FROM public.lists l WHERE l.id=ANY(e.source_list_ids) ORDER BY l.id FOR SHARE;
 PERFORM t.id FROM public.templates t WHERE t.id IN (SELECT c0.template_id FROM public.campaigns c0 JOIN public.crm_ab_arm_v2 a0 ON a0.campaign_id=c0.id WHERE a0.test_id=tid) ORDER BY t.id FOR SHARE;
 PERFORM m.id FROM public.media m WHERE m.id IN (SELECT cm.media_id FROM public.campaign_media cm JOIN public.crm_ab_arm_v2 a0 ON a0.campaign_id=cm.campaign_id WHERE a0.test_id=tid) ORDER BY m.id FOR SHARE;
 PERFORM s.id FROM public.subscribers s JOIN public.crm_ab_member_v2 m ON m.subscriber_id=s.id WHERE m.test_id=tid ORDER BY s.id FOR SHARE OF s;
 PERFORM sl.subscriber_id FROM public.subscriber_lists sl JOIN public.crm_ab_member_v2 m ON m.subscriber_id=sl.subscriber_id WHERE m.test_id=tid AND sl.list_id=ANY(e.source_list_ids) ORDER BY sl.subscriber_id,sl.list_id FOR SHARE OF sl;
 PERFORM key FROM public.settings WHERE key IN ('privacy.disable_tracking','privacy.individual_tracking') ORDER BY key FOR SHARE;
 IF (SELECT value FROM public.settings WHERE key='privacy.disable_tracking') IS DISTINCT FROM 'false'::jsonb
  OR (SELECT value FROM public.settings WHERE key='privacy.individual_tracking') IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'AB_V2_TRACKING_REQUIRED';END IF;
 FOR a IN SELECT * FROM public.crm_ab_arm_v2 WHERE test_id=tid ORDER BY arm LOOP
  SELECT * INTO c FROM public.campaigns WHERE id=a.campaign_id;
  current_row:=public.shrigma_campaign_current(a.campaign_id);
  IF current_row->>'version' IS DISTINCT FROM a.campaign_version THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_VERSION';END IF;
  IF c.status::text<>'draft' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL OR c.content_type::text<>'html'
   OR c.body_source IS NOT NULL OR c.send_at IS NULL OR c.send_at<clock_timestamp()+interval '15 minutes' THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_STATE';END IF;
  IF send_at IS NULL THEN send_at:=c.send_at;ELSIF send_at IS DISTINCT FROM c.send_at THEN RAISE EXCEPTION 'AB_V2_SCHEDULE_DIFFERS';END IF;
  SELECT validation INTO v FROM public.shrigma_campaign_validation WHERE provider_id=c.id FOR SHARE;
  IF v->>'policy' IS DISTINCT FROM 'crm-campaign-v1' OR v->>'version' IS DISTINCT FROM a.campaign_version OR v->'ok' IS DISTINCT FROM 'true'::jsonb
   OR v#>>'{audience,review_id}' IS DISTINCT FROM source_reviews->>a.arm
   OR v#>>'{audience,campaign_id}' IS DISTINCT FROM c.id::text OR v#>>'{audience,campaign_version}' IS DISTINCT FROM a.campaign_version
   OR v#>>'{audience,brand}' IS DISTINCT FROM e.brand OR v#>'{audience,list_ids}' IS DISTINCT FROM to_jsonb(e.source_list_ids)
   OR coalesce(v#>>'{audience,checked_at}','')!~'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
   OR coalesce(v#>>'{audience,expires_at}','')!~'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_REVIEW_REQUIRED';END IF;
  checked:=(v#>>'{audience,checked_at}')::timestamptz;expiry:=(v#>>'{audience,expires_at}')::timestamptz;
  IF checked>clock_timestamp() OR expiry<=clock_timestamp() OR expiry-checked<>interval '5 minutes' THEN RAISE EXCEPTION 'AB_V2_REVIEW_EXPIRED';END IF;
  aud:=public.shrigma_campaign_audience(c.id);
  IF aud->>'_fingerprint' IS DISTINCT FROM v->>'_audience_fingerprint'
   OR (aud-'_fingerprint') IS DISTINCT FROM ((v->'audience')-ARRAY['review_id','campaign_id','campaign_version','checked_at','expires_at','frozen']) THEN RAISE EXCEPTION 'AB_V2_AUDIENCE_CHANGED';END IF;
  IF (aud->>'native_disabled_count')::bigint>0 THEN RAISE EXCEPTION 'AB_V2_DISABLED_SUBSCRIBERS';END IF;
  WITH eligible AS (
   SELECT m.subscriber_id FROM public.crm_ab_member_v2 m JOIN public.subscribers s ON s.id=m.subscriber_id
   WHERE m.test_id=tid AND m.arm=a.arm AND m.revoked_at IS NULL AND s.status::text='enabled' AND EXISTS(
    SELECT 1 FROM public.subscriber_lists sl JOIN public.lists l ON l.id=sl.list_id WHERE sl.subscriber_id=m.subscriber_id AND sl.list_id=ANY(e.source_list_ids)
     AND ((l.optin::text='double' AND sl.status::text='confirmed') OR (l.optin::text='single' AND sl.status::text IN ('confirmed','unconfirmed'))))
  ) SELECT jsonb_build_object('allocated',a.allocated_count,'eligible',count(*),
    'excluded',a.allocated_count-count(*),'_cohort_fingerprint',encode(sha256(convert_to(coalesce(string_agg(subscriber_id::text,',' ORDER BY subscriber_id),''),'UTF8')),'hex')) INTO counts FROM eligible;
  IF (counts->>'eligible')::integer<(e.protocol#>>'{rule,minimum_per_arm}')::integer THEN RAISE EXCEPTION 'AB_V2_MINIMUM_NOT_REACHED';END IF;
  IF a.allocated_count<>(SELECT count(*) FROM public.crm_ab_member_v2 WHERE test_id=tid AND arm=a.arm)
   OR EXISTS(SELECT 1 FROM public.crm_ab_member_v2 m LEFT JOIN public.subscribers s ON s.id=m.subscriber_id WHERE m.test_id=tid AND m.arm=a.arm AND s.id IS NULL) THEN RAISE EXCEPTION 'AB_V2_SOURCE_INCOMPLETE';END IF;
  all_evidence:=all_evidence||jsonb_build_array(jsonb_build_object('arm',a.arm,'campaign_id',c.id,'campaign_version',a.campaign_version,
   'source_review_id',source_reviews->>a.arm,'source_expires_at',expiry,'_source_fingerprint',aud->>'_fingerprint','counts',counts));
 END LOOP;
 IF jsonb_array_length(all_evidence)<>2 THEN RAISE EXCEPTION 'AB_V2_SOURCE_INCOMPLETE';END IF;
 RETURN jsonb_build_object('source_reviews',source_reviews,'send_at',send_at,'arms',all_evidence);
END $fn$;

CREATE FUNCTION public.crm_ab_public_review_v2(tid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('review_id',r.review_id,'version',r.experiment_version,'checked_at',r.checked_at,'expires_at',r.expires_at,
  'send_at',r.evidence->'send_at','arms',(SELECT jsonb_agg((a-ARRAY['_source_fingerprint','counts'])||jsonb_build_object('counts',(a->'counts')-'_cohort_fingerprint') ORDER BY a->>'arm') FROM jsonb_array_elements(r.evidence->'arms') a))
 FROM public.crm_ab_review_v2 r WHERE r.test_id=tid
$$;

CREATE FUNCTION public.crm_ab_control_v2(actor text,caps jsonb,oid uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $fn$
DECLARE action text;required_cap text;prior public.crm_ab_action_v2%ROWTYPE;e public.crm_ab_experiment_v2%ROWTYPE;
 review public.crm_ab_review_v2%ROWTYPE;current_evidence jsonb;result jsonb;tid uuid;b text;c public.campaigns%ROWTYPE;
 checked timestamptz;prev_ab text;prev_campaign text;error_code text;allowed_keys text[];
BEGIN
 IF coalesce(actor,'')!~'^panel:.+' OR jsonb_typeof(caps) IS DISTINCT FROM 'array' OR oid IS NULL THEN RAISE EXCEPTION 'AB_V2_ACCESS';END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR length(p::text)>32768 THEN RAISE EXCEPTION 'AB_V2_PROTOCOL';END IF;
 action:=CASE WHEN p ? 'allocation' THEN 'prepare' ELSE p->>'action' END;
 required_cap:=CASE action WHEN 'prepare' THEN 'draft' WHEN 'review' THEN 'validate' WHEN 'schedule' THEN 'submit' WHEN 'cancel' THEN 'submit' WHEN 'close' THEN 'draft' END;
 IF required_cap IS NULL THEN RAISE EXCEPTION 'AB_V2_ACCESS';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-ab-v2-operation:'||oid,0));
 SELECT * INTO prior FROM public.crm_ab_action_v2 WHERE operation_id=oid;
 IF FOUND THEN
  IF prior.actor IS DISTINCT FROM actor OR prior.request_payload IS DISTINCT FROM p THEN RAISE EXCEPTION 'AB_V2_IDENTITY';END IF;
  RETURN prior.response;
 END IF;
 IF NOT(caps ? required_cap) THEN
  result:=jsonb_build_object('status',403,'body',jsonb_build_object('error','AB_V2_CAPABILITY'));
  INSERT INTO public.crm_ab_action_v2(operation_id,actor,request_payload,response) VALUES(oid,actor,p,result);RETURN result;
 END IF;
 BEGIN
  -- Lock runtime before experiment/campaign rows. A concurrent OFF transition
  -- either commits before this check or invalidates the committed experiment.
  PERFORM singleton FROM public.crm_ab_runtime_v2 WHERE singleton FOR SHARE;
  -- Settings triggers also preserve evidence on the experiment. Acquire their
  -- source rows before that row, including during review/cancel/close.
  PERFORM key FROM public.settings WHERE key IN ('privacy.disable_tracking','privacy.individual_tracking') ORDER BY key FOR SHARE;
  IF action='prepare' THEN
   IF NOT EXISTS(SELECT 1 FROM public.crm_ab_runtime_v2 WHERE singleton AND enabled
     AND native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9' AND isfinite(verified_at) AND verified_at<=clock_timestamp()) THEN RAISE EXCEPTION 'AB_V2_TRANSPORT_UNAVAILABLE';END IF;
   result:=public.crm_ab_prepare_v2(actor,caps,oid,p);
   RETURN jsonb_build_object('status',200,'body',jsonb_build_object('experiment',result));
  END IF;
  allowed_keys:=ARRAY['contract','action','test_id','brand','expected_version']||CASE action WHEN 'review' THEN ARRAY['source_reviews'] WHEN 'schedule' THEN ARRAY['review_id','confirm'] ELSE ARRAY['confirm'] END;
  IF (p-allowed_keys)<>'{}' OR p->>'contract' IS DISTINCT FROM 'crm-ab-email-v2' OR coalesce(p->>'test_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR coalesce(p->>'brand','') NOT IN ('fish','aristo') OR jsonb_typeof(p->'expected_version') IS DISTINCT FROM 'number' OR coalesce(p->>'expected_version','')!~'^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'AB_V2_PROTOCOL';END IF;
  tid:=(p->>'test_id')::uuid;b:=p->>'brand';
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-ab-v2-brand:'||b,0));
  SELECT * INTO e FROM public.crm_ab_experiment_v2 WHERE test_id=tid AND brand=b FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AB_V2_NOT_FOUND';END IF;
  IF e.version<>(p->>'expected_version')::integer THEN RAISE EXCEPTION 'AB_V2_VERSION';END IF;
  IF action='review' THEN
   current_evidence:=public.crm_ab_review_evidence_v2(tid,p->'source_reviews');checked:=clock_timestamp();
   INSERT INTO public.crm_ab_review_v2(test_id,review_id,actor,experiment_version,checked_at,expires_at,evidence)
   VALUES(tid,gen_random_uuid(),actor,e.version,checked,checked+interval '5 minutes',current_evidence)
   ON CONFLICT(test_id) DO UPDATE SET review_id=excluded.review_id,actor=excluded.actor,experiment_version=excluded.experiment_version,checked_at=excluded.checked_at,expires_at=excluded.expires_at,evidence=excluded.evidence;
   result:=jsonb_build_object('status',200,'body',jsonb_build_object('experiment',public.crm_ab_snapshot_v2(tid),'review',public.crm_ab_public_review_v2(tid)));
  ELSIF action='schedule' THEN
   IF p->>'confirm' IS DISTINCT FROM 'schedule_both' THEN RAISE EXCEPTION 'AB_V2_CONFIRM';END IF;
   IF e.state<>'prepared' THEN RAISE EXCEPTION 'AB_V2_STATE';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.crm_ab_runtime_v2 WHERE singleton AND enabled
     AND native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9' AND isfinite(verified_at) AND verified_at<=clock_timestamp()) THEN RAISE EXCEPTION 'AB_V2_TRANSPORT_UNAVAILABLE';END IF;
   SELECT * INTO review FROM public.crm_ab_review_v2 WHERE test_id=tid FOR UPDATE;
   IF NOT FOUND OR review.actor IS DISTINCT FROM actor OR review.review_id::text IS DISTINCT FROM p->>'review_id'
    OR review.experiment_version<>e.version OR review.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'AB_V2_REVIEW_EXPIRED';END IF;
   current_evidence:=public.crm_ab_review_evidence_v2(tid,review.evidence->'source_reviews');
   IF current_evidence IS DISTINCT FROM review.evidence THEN RAISE EXCEPTION 'AB_V2_AUDIENCE_CHANGED';END IF;
   checked:=clock_timestamp();
   IF review.expires_at<=checked OR (current_evidence->>'send_at')::timestamptz<checked+interval '15 minutes' THEN RAISE EXCEPTION 'AB_V2_REVIEW_EXPIRED';END IF;
   prev_ab:=current_setting('shrigma.ab_schedule_v2',true);prev_campaign:=current_setting('shrigma.campaign_writer',true);
   PERFORM set_config('shrigma.ab_schedule_v2',tid::text,true);
   FOR c IN SELECT c0.* FROM public.campaigns c0 JOIN public.crm_ab_arm_v2 a ON a.campaign_id=c0.id WHERE a.test_id=tid ORDER BY c0.id FOR UPDATE OF c0 LOOP
    PERFORM set_config('shrigma.campaign_writer',c.id::text,true);
    UPDATE public.campaigns SET status='scheduled',updated_at=checked WHERE id=c.id;
   END LOOP;
   PERFORM set_config('shrigma.ab_schedule_v2',coalesce(prev_ab,''),true);PERFORM set_config('shrigma.campaign_writer',coalesce(prev_campaign,''),true);
   UPDATE public.crm_ab_experiment_v2 SET state='scheduled',version=version+1,transport_bound=true,tracking_continuous=true,
    window_start=(current_evidence->>'send_at')::timestamptz,window_end=(current_evidence->>'send_at')::timestamptz+make_interval(hours=>(protocol#>>'{rule,window_hours}')::integer) WHERE test_id=tid;
   result:=jsonb_build_object('status',200,'body',jsonb_build_object('experiment',public.crm_ab_snapshot_v2(tid),'review',public.crm_ab_public_review_v2(tid)));
  ELSIF action='cancel' THEN
   IF p->>'confirm' IS DISTINCT FROM 'cancel_both' THEN RAISE EXCEPTION 'AB_V2_CONFIRM';END IF;
   IF e.state NOT IN ('prepared','scheduled') THEN RAISE EXCEPTION 'AB_V2_STATE';END IF;
   PERFORM c0.id FROM public.campaigns c0 JOIN public.crm_ab_arm_v2 a ON a.campaign_id=c0.id WHERE a.test_id=tid ORDER BY c0.id FOR UPDATE OF c0;
   IF (SELECT count(*) FROM public.campaigns c0 JOIN public.crm_ab_arm_v2 a ON a.campaign_id=c0.id WHERE a.test_id=tid AND c0.sent=0 AND c0.started_at IS NULL
    AND (c0.status::text='draft' OR c0.status::text='scheduled' AND c0.send_at>clock_timestamp()))<>2 THEN RAISE EXCEPTION 'AB_V2_ALREADY_STARTED';END IF;
   prev_ab:=current_setting('shrigma.ab_schedule_v2',true);prev_campaign:=current_setting('shrigma.campaign_writer',true);PERFORM set_config('shrigma.ab_schedule_v2',tid::text,true);
   FOR c IN SELECT c0.* FROM public.campaigns c0 JOIN public.crm_ab_arm_v2 a ON a.campaign_id=c0.id WHERE a.test_id=tid ORDER BY c0.id LOOP
    PERFORM set_config('shrigma.campaign_writer',c.id::text,true);UPDATE public.campaigns SET status='cancelled',updated_at=clock_timestamp() WHERE id=c.id;
   END LOOP;
   PERFORM set_config('shrigma.ab_schedule_v2',coalesce(prev_ab,''),true);PERFORM set_config('shrigma.campaign_writer',coalesce(prev_campaign,''),true);
   UPDATE public.crm_ab_experiment_v2 SET state='cancelled',version=version+1 WHERE test_id=tid;
   result:=jsonb_build_object('status',200,'body',jsonb_build_object('experiment',public.crm_ab_snapshot_v2(tid)));
  ELSE
   IF p->>'confirm' IS DISTINCT FROM 'close_measurement' THEN RAISE EXCEPTION 'AB_V2_CONFIRM';END IF;
   IF e.state<>'scheduled' OR e.window_end IS NULL OR e.window_end>clock_timestamp() THEN RAISE EXCEPTION 'AB_V2_WINDOW_OPEN';END IF;
   UPDATE public.crm_ab_experiment_v2 SET state='closed',version=version+1 WHERE test_id=tid;
   result:=jsonb_build_object('status',200,'body',jsonb_build_object('experiment',public.crm_ab_snapshot_v2(tid)));
  END IF;
 EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS error_code=MESSAGE_TEXT;
  IF error_code!~'^AB_V2_[A-Z_]+$' THEN RAISE;END IF;
  result:=jsonb_build_object('status',CASE WHEN error_code IN ('AB_V2_PROTOCOL','AB_V2_CONFIRM') THEN 422 ELSE 409 END,'body',jsonb_build_object('error',error_code));
 END;
 INSERT INTO public.crm_ab_action_v2(operation_id,actor,request_payload,response) VALUES(oid,actor,p,result);
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.crm_ab_review_evidence_v2(uuid,jsonb),public.crm_ab_public_review_v2(uuid),public.crm_ab_control_v2(text,jsonb,uuid,jsonb) FROM PUBLIC;
COMMIT;
