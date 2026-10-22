CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_claim(
 cid integer,sid integer,did uuid,worker_sha text,runtime_sha text,
 envelope_from text,envelope_to text,payload_sha text,subscriber_snapshot jsonb)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
 SET search_path=pg_catalog SET TimeZone='UTC' SET lock_timeout='500ms' AS $fn$
 #variable_conflict use_variable
 DECLARE c public.campaigns%ROWTYPE;e crm_audience_v2.regular_delivery_campaign%ROWTYPE;
 b crm_audience_v2.campaign_binding%ROWTYPE;s public.subscribers%ROWTYPE;
 ctx jsonb;d public.shrigma_email_dispatch%ROWTYPE;k text;piece text;token uuid;first_id integer;live_at timestamptz;valid_until timestamptz;
 timestamp_pattern text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?([+-][0-9]{2}:[0-9]{2}|Z)$';
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_BOUNDARY';
  END IF;
  IF cid IS NULL OR cid<=0 OR sid IS NULL OR sid<=0 OR did IS NULL
   OR worker_sha IS NULL OR worker_sha !~ '^[0-9a-f]{64}$'
   OR runtime_sha IS NULL OR runtime_sha !~ '^[0-9a-f]{64}$'
   OR payload_sha IS NULL OR payload_sha !~ '^[0-9a-f]{64}$'
   OR nullif(envelope_from,'') IS NULL OR nullif(envelope_to,'') IS NULL
   OR jsonb_typeof(subscriber_snapshot) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_INPUT';
  END IF;
  PERFORM crm_audience_v2.ab_regular_fence(cid,sid);
  -- One campaign lock serializes attempts across processes as well as workers.
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
  SELECT * INTO STRICT e FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
  SELECT * INTO STRICT b FROM crm_audience_v2.campaign_binding_effective(cid);
  IF NOT e.enabled OR e.suspended OR c.status::text<>'running'
   OR c.sent IS DISTINCT FROM e.acknowledged_sent OR c.last_subscriber_id IS DISTINCT FROM e.acknowledged_subscriber_id
   OR e.binding_version IS DISTINCT FROM b.binding_version OR e.binding_hash IS DISTINCT FROM b.binding_hash
   OR e.worker_sha256 IS DISTINCT FROM worker_sha OR e.runtime_sha256 IS DISTINCT FROM runtime_sha
   OR e.envelope_from IS DISTINCT FROM envelope_from THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_UNAVAILABLE';
  END IF;
  -- Stabilize every declared dependency and the live selector before comparing.
  PERFORM 1 FROM crm_audience_v2.selection_runtime FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.config WHERE brand=b.brand FOR SHARE;
  -- Freeze the source pointer until the durable claim commits.
  PERFORM 1 FROM crm_audience_v2.shopify_source WHERE brand=b.brand FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.audience WHERE id=b.audience_id FOR SHARE;
  PERFORM 1 FROM public.campaign_lists WHERE campaign_id=cid ORDER BY list_id FOR SHARE;
  PERFORM 1 FROM public.campaign_media WHERE campaign_id=cid ORDER BY media_id FOR SHARE;
  PERFORM 1 FROM public.templates WHERE id=c.template_id FOR SHARE;
  PERFORM 1 FROM public.lists WHERE id IN(SELECT list_id FROM public.campaign_lists WHERE campaign_id=cid) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.media WHERE id IN(SELECT media_id FROM public.campaign_media WHERE campaign_id=cid) ORDER BY id FOR SHARE;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  PERFORM 1 FROM public.lists WHERE id IN(SELECT (value->>'list_id')::integer FROM jsonb_array_elements(ctx->'list_pins')) ORDER BY id FOR SHARE;
  -- The leaf locks may wait. Read the context again under a fresh READ COMMITTED
  -- command snapshot before treating the earlier source/pin check as current.
  ctx:=crm_audience_v2.selection_worker_context(cid);
  IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb
   OR e.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(cid) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_MATERIAL_DRIFT';
  END IF;
  piece:='audience-regular-v1:'||cid::text;
  k:=jsonb_build_array(cid,b.binding_version,sid)::text;
  -- A disposition never gives transport authority, even after cursor/binding drift.
  IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_permanent_exclusion x
    WHERE x.campaign_id=cid AND x.subscriber_id=sid) THEN
   IF NOT crm_audience_v2.regular_delivery_permanently_excluded(
       '0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'::uuid,cid) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='REGULAR_PERMANENT_EXCLUSION_DRIFT';
   END IF;
   RETURN jsonb_build_object('should_send',false,'reason','already_checkpointed',
    'dispatch_id','0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'::uuid,'claim_token',NULL);
  END IF;
  SELECT * INTO d FROM public.shrigma_email_dispatch x
   WHERE x.brand=b.brand AND x.flow='campaign' AND x.piece=piece AND x.dedupe_key=k FOR UPDATE;
  IF FOUND THEN
   RETURN jsonb_build_object('should_send',false,'reason',d.transport_state,'dispatch_id',d.dispatch_id,'claim_token',NULL);
  END IF;
  IF EXISTS(SELECT 1 FROM public.shrigma_email_dispatch x WHERE x.brand=b.brand
   AND x.flow='campaign' AND x.piece=piece AND x.transport_state IN('in_flight','outcome_unknown')
   AND NOT crm_audience_v2.regular_delivery_permanently_excluded(x.dispatch_id,cid)) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_RECONCILIATION_REQUIRED';
  END IF;
  IF sid<=c.last_subscriber_id THEN
   RETURN jsonb_build_object('should_send',false,'reason','already_checkpointed','dispatch_id',NULL,'claim_token',NULL);
  END IF;
  IF sid>c.max_subscriber_id THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_CURSOR'; END IF;
  SELECT * INTO STRICT s FROM public.subscribers WHERE id=sid FOR UPDATE;
  PERFORM 1 FROM public.subscriber_lists WHERE subscriber_id=sid ORDER BY list_id FOR SHARE;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  -- Never jump over another currently eligible recipient; a mutex alone cannot
  -- guarantee ordering when several native workers dequeue concurrently.
  SELECT min(sl.subscriber_id) INTO first_id FROM public.subscriber_lists sl
   WHERE sl.list_id=b.base_list_id AND sl.subscriber_id>c.last_subscriber_id AND sl.subscriber_id<=sid
    AND crm_audience_v2.selection_regular_matches(ctx,sl.subscriber_id);
  IF first_id IS NOT NULL AND first_id<>sid THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_ORDER'; END IF;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  -- Selector snapshots intentionally use statement_timestamp for count/batch
  -- consistency. Delivery must additionally recheck the wall clock after waits.
  live_at:=clock_timestamp();
  SELECT least(cfg.expires_at,rt.verified_at+interval '5 minutes',(ctx->>'shopify_expires_at')::timestamptz) INTO valid_until
   FROM crm_audience_v2.config cfg CROSS JOIN crm_audience_v2.selection_runtime rt
   WHERE cfg.brand=b.brand AND cfg.enabled AND rt.enabled;
  IF valid_until IS NULL OR NOT isfinite(valid_until) OR valid_until<=live_at THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SOURCE_EXPIRED';
  END IF;
  IF NOT crm_audience_v2.selection_regular_matches(ctx,sid) THEN
   UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_subscriber_id=sid WHERE campaign_id=cid;
   UPDATE public.campaigns SET last_subscriber_id=sid,updated_at=clock_timestamp() WHERE id=cid;
   RETURN jsonb_build_object('should_send',false,'reason','ineligible','dispatch_id',NULL,'claim_token',NULL);
  END IF;
  -- The native batch may use a different session timezone. Preserve every
  -- other raw field exactly, but compare the two native timestamptz columns
  -- as instants (including microseconds), never as formatted JSON strings.
  IF (to_jsonb(s)-ARRAY['created_at','updated_at']) IS DISTINCT FROM (subscriber_snapshot-ARRAY['created_at','updated_at'])
   OR NOT(subscriber_snapshot ?& ARRAY['created_at','updated_at'])
   OR jsonb_typeof(subscriber_snapshot->'created_at') NOT IN('string','null')
   OR jsonb_typeof(subscriber_snapshot->'updated_at') NOT IN('string','null')
   OR lower(s.email) IS DISTINCT FROM lower(envelope_to) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
  END IF;
  BEGIN
   IF (subscriber_snapshot->>'created_at') !~ timestamp_pattern
    OR (subscriber_snapshot->>'updated_at') !~ timestamp_pattern
    OR (subscriber_snapshot->>'created_at')::timestamptz IS DISTINCT FROM s.created_at
    OR (subscriber_snapshot->>'updated_at')::timestamptz IS DISTINCT FROM s.updated_at THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
   END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
  END;
  token:=gen_random_uuid();
  INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,
   account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
  SELECT did,b.brand,'campaign',piece,k,payload_sha,e.account_id,e.region,e.configuration_set,
   r.recipient_key,r.key_version,false,'in_flight',clock_timestamp(),token FROM public.shrigma_email_recipient_key(envelope_to) r;
  IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_RECIPIENT_KEY'; END IF;
  live_at:=clock_timestamp();
  IF valid_until<=live_at THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SOURCE_EXPIRED'; END IF;
  RETURN jsonb_build_object('should_send',true,'reason','claimed','dispatch_id',did,'claim_token',token,
   'checked_at',live_at,'valid_until',valid_until);
 END
$fn$;
