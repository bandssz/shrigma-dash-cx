LOCK TABLE crm_audience_v2.regular_delivery_permanent_exclusion IN SHARE ROW EXCLUSIVE MODE;
 IF plan->'scope' IS DISTINCT FROM '{"heldCampaignId":174,"heldDispatchId":"0d8c77b2-18e7-474f-b9b7-bbfc733bac2f","decision":"permanent_no_resend"}'::jsonb
 OR before_state->'permanentExclusions' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_DISPOSITION_SCOPE'; END IF;
 SELECT * INTO STRICT c FROM public.campaigns WHERE id=174;
 SELECT * INTO STRICT ctl FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=174;
 SELECT * INTO STRICT binding FROM crm_audience_v2.campaign_binding_effective(174);
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f' FOR UPDATE;
 sid:=(d.dedupe_key::jsonb->>2)::integer;
 IF c.status::text<>'paused' OR ctl.suspended IS DISTINCT FROM true
 OR d.transport_state IS DISTINCT FROM 'outcome_unknown' OR d.accepted_at IS NOT NULL
 OR d.error_code IS DISTINCT FROM 'NATIVE_REGULAR_OUTCOME_UNKNOWN'
 OR d.outcome_at IS NULL OR NOT isfinite(d.outcome_at) OR d.outcome_at>at
 OR d.flow IS DISTINCT FROM 'campaign' OR d.brand IS DISTINCT FROM 'fish'
 OR d.piece IS DISTINCT FROM 'audience-regular-v1:174' OR d.is_test IS DISTINCT FROM false
 OR d.claim_token IS NULL OR d.dedupe_key IS DISTINCT FROM jsonb_build_array(174,ctl.binding_version,sid)::text
 OR sid IS NULL OR sid<=c.last_subscriber_id OR sid>c.max_subscriber_id
 OR EXISTS(SELECT 1 FROM public.shrigma_email_dispatch WHERE flow='campaign' AND brand='fish' AND piece IN('audience-regular-v1:171','audience-regular-v1:174') AND transport_state='outcome_unknown' AND dispatch_id<>d.dispatch_id)
 THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_DISPATCH_OR_CURSOR_DRIFT'; END IF;
 initial_context:=crm_audience_v2.selection_worker_context(174);
 IF initial_context IS NULL OR initial_context->'bound' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_CONTEXT_REQUIRED'; END IF;
 -- Cannot skip an earlier still-eligible recipient. Unknown is never treated as unsent.
 SELECT min(sl.subscriber_id) INTO first_id FROM public.subscriber_lists sl
 WHERE sl.list_id=binding.base_list_id AND sl.subscriber_id>c.last_subscriber_id AND sl.subscriber_id<=sid
 AND crm_audience_v2.selection_regular_matches(initial_context,sl.subscriber_id);
 IF first_id IS NOT NULL AND first_id<>sid THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_ORDER_DRIFT'; END IF;
 INSERT INTO crm_audience_v2.regular_delivery_permanent_exclusion(dispatch_id,campaign_id,binding_version,binding_hash,
 subscriber_id,dedupe_key,dispatch_snapshot,operation_id,disposition,created_at)
 VALUES(d.dispatch_id,174,ctl.binding_version,ctl.binding_hash,sid,d.dedupe_key,to_jsonb(d),(plan->>'operationId')::uuid,'human_permanent_no_resend',at);
 -- The disposition is durable in this same transaction BEFORE the sole cursor advance.
 UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_subscriber_id=sid WHERE campaign_id=174 AND acknowledged_subscriber_id=c.last_subscriber_id;
 GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_CURSOR_CAS'; END IF;
 UPDATE public.campaigns SET last_subscriber_id=sid WHERE id=174 AND last_subscriber_id=c.last_subscriber_id;
 GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_CURSOR_CAS'; END IF;
 expected:=jsonb_set(expected,'{controls}',(SELECT jsonb_agg(CASE WHEN (x->>'campaign_id')::integer=174 THEN jsonb_set(x,'{acknowledged_subscriber_id}',to_jsonb(sid)) ELSE x END ORDER BY (x->>'campaign_id')::integer) FROM jsonb_array_elements(expected->'controls')x));
 expected:=jsonb_set(expected,'{campaigns}',(SELECT jsonb_agg(CASE WHEN (x->>'id')::integer=174 THEN jsonb_set(x,'{last_subscriber_id}',to_jsonb(sid)) ELSE x END ORDER BY (x->>'id')::integer) FROM jsonb_array_elements(expected->'campaigns')x));
 expected:=jsonb_set(expected,'{permanentExclusions}',(SELECT jsonb_agg(to_jsonb(x) ORDER BY dispatch_id) FROM crm_audience_v2.regular_delivery_permanent_exclusion x));
