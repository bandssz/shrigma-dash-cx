LOCK TABLE crm_audience_v2.regular_delivery_permanent_exclusion IN SHARE MODE;
 IF plan#>>'{scope,decision}' IS DISTINCT FROM 'permanent_no_resend'
 OR plan#>>'{scope,heldDispatchId}' IS DISTINCT FROM '0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'
 OR e#>>'{privateAdmission,binaryExclusionSupportVerified}' IS DISTINCT FROM 'true'
 OR e#>>'{privateAdmission,measuredWorkerSha256}' IS DISTINCT FROM plan#>>'{candidate,workerSha256}'
 OR e#>>'{privateAdmission,exclusionSourceSha256}' IS DISTINCT FROM plan#>>'{sourcePins,files/tools/listmonk-regular-build/overlay/listmonk/cmd/manager_store_regular.go}'
 OR NOT crm_audience_v2.regular_delivery_permanently_excluded('0d8c77b2-18e7-474f-b9b7-bbfc733bac2f',174)
 OR (SELECT count(*) FROM crm_audience_v2.regular_delivery_permanent_exclusion)<>1 THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_BINARY_AND_DISPOSITION_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.shrigma_email_dispatch x WHERE x.flow='campaign' AND x.brand='fish' AND x.piece IN('audience-regular-v1:171','audience-regular-v1:174') AND x.transport_state='outcome_unknown'
 AND NOT crm_audience_v2.regular_delivery_permanently_excluded(x.dispatch_id,174)) THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_OTHER_UNKNOWN_REQUIRED'; END IF;
 SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid;
 SELECT * INTO STRICT ctl FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid;
 IF c.status::text<>'paused' OR ctl.suspended IS DISTINCT FROM true OR c.send_at>at OR c.send_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.campaigns WHERE id=CASE WHEN cid=174 THEN 171 ELSE 174 END AND status::text IN('paused','finished')) THEN
 RAISE EXCEPTION 'PERMANENT_EXCLUSION_SEQUENTIAL_SCOPE'; END IF;
 initial_context:=crm_audience_v2.selection_worker_context(cid);
 UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=false WHERE campaign_id=cid AND suspended;
 GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_RESUME_CAS'; END IF;
 UPDATE public.campaigns SET status='scheduled' WHERE id=cid AND status::text='paused';
 GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_RESUME_CAS'; END IF;
 expected:=jsonb_set(expected,'{controls}',(SELECT jsonb_agg(CASE WHEN (x->>'campaign_id')::integer=cid THEN jsonb_set(x,'{suspended}','false'::jsonb) ELSE x END ORDER BY (x->>'campaign_id')::integer) FROM jsonb_array_elements(expected->'controls')x));
 expected:=jsonb_set(expected,'{campaigns}',(SELECT jsonb_agg(CASE WHEN (x->>'id')::integer=cid THEN jsonb_set(x,'{status}','"scheduled"'::jsonb) ELSE x END ORDER BY (x->>'id')::integer) FROM jsonb_array_elements(expected->'campaigns')x));
