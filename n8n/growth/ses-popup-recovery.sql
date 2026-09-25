-- One-off evidence reconciliation. Never calls transport or reconstructs HTTP/template data.
-- Default dry run exercises writes inside a rolled-back subtransaction (sequences may advance).
CREATE TABLE public.shrigma_email_popup_recovery_v1 (
 dispatch_id uuid PRIMARY KEY REFERENCES public.shrigma_email_dispatch(dispatch_id),
 send_log_id bigint NOT NULL UNIQUE REFERENCES public.shrigma_send_log(id),
 before_state jsonb NOT NULL,
 evidence jsonb NOT NULL,
 reason text NOT NULL CHECK(reason='SES_SEND_AND_DELIVERY_HTTP_NOT_CAPTURED'),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.shrigma_email_popup_recovery_v1 FROM PUBLIC;

CREATE FUNCTION public.shrigma_email_recover_popup_delivery_v1(p_id uuid,p_dry_run boolean DEFAULT true)
RETURNS TABLE(result text,send_log_id bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE d public.shrigma_email_dispatch%ROWTYPE;initial public.shrigma_email_dispatch%ROWTYPE;
 a public.shrigma_email_popup_recovery_v1%ROWTYPE;e record;q record;
 v_ref text;v_email text;v_message text;v_at timestamptz;v_delivery timestamptz;
 v_recipient text;v_key_version text;v_log bigint;v_evidence jsonb='[]'::jsonb;
 v_envelope jsonb;v_archive_verified boolean;v_statuses text[]='{}';v_result text;
BEGIN
 IF p_id IS NULL OR p_dry_run IS NULL THEN RAISE EXCEPTION 'POPUP_RECOVERY_ARGUMENT_INVALID';END IF;
 BEGIN
  SELECT * INTO STRICT initial FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id;
  IF coalesce(initial.brand,'') NOT IN ('fish','aristo') OR initial.flow IS DISTINCT FROM 'popup'
   OR initial.piece IS DISTINCT FROM 'cupom-boas-vindas' OR initial.is_test IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'POPUP_RECOVERY_SCOPE_INVALID';
  END IF;
  BEGIN
   v_ref=initial.dedupe_key::jsonb->>1;v_email=initial.dedupe_key::jsonb->>2;
   IF v_ref IS NULL OR v_ref !~ '^popup-execution:[0-9]+$' OR octet_length(v_ref)>256
    OR v_email IS NULL OR v_email<>lower(btrim(v_email)) OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR initial.dedupe_key IS DISTINCT FROM jsonb_build_array('email',v_ref,v_email,false)::text THEN
    RAISE EXCEPTION 'POPUP_RECOVERY_REF_INVALID';
   END IF;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'POPUP_RECOVERY_REF_INVALID';END;
  -- Same acquisition order as shrigma_email_claim_engagement; no subscriber write.
  PERFORM pg_advisory_xact_lock(hashtextextended('engagement:'||initial.brand||':popup:'||v_email,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('engagement-ref:'||initial.brand||':popup:cupom-boas-vindas:'||v_ref,0));
  SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
  IF (to_jsonb(d)-ARRAY['transport_state','outcome_at','accepted_at','send_log_id','error_code'])
   IS DISTINCT FROM (to_jsonb(initial)-ARRAY['transport_state','outcome_at','accepted_at','send_log_id','error_code']) THEN
   RAISE EXCEPTION 'POPUP_RECOVERY_IDENTITY_CHANGED';
  END IF;
  SELECT * INTO a FROM public.shrigma_email_popup_recovery_v1 x WHERE x.dispatch_id=p_id;
  IF FOUND THEN
   IF jsonb_typeof(a.evidence) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'POPUP_RECOVERY_AUDIT_MISMATCH';END IF;
   IF jsonb_array_length(a.evidence)<>2 THEN RAISE EXCEPTION 'POPUP_RECOVERY_AUDIT_MISMATCH';END IF;
   IF d.transport_state IS DISTINCT FROM 'accepted' OR d.send_log_id IS DISTINCT FROM a.send_log_id
    OR d.error_code IS DISTINCT FROM 'RECONCILED_SES_DELIVERY_HTTP_NOT_CAPTURED'
    OR a.reason IS DISTINCT FROM 'SES_SEND_AND_DELIVERY_HTTP_NOT_CAPTURED'
    OR d.accepted_at IS DISTINCT FROM (a.evidence->0->>'send_at')::timestamptz
    OR (to_jsonb(d)-ARRAY['transport_state','outcome_at','accepted_at','send_log_id','error_code'])
     IS DISTINCT FROM (a.before_state-ARRAY['transport_state','outcome_at','accepted_at','send_log_id','error_code'])
    OR NOT EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.id=a.send_log_id
     AND l.email=v_email AND l.brand=d.brand AND l.kind='tx' AND l.flow='popup' AND l.channel='email'
     AND l.piece='cupom-boas-vindas' AND l.ref=v_ref AND l.template_id IS NULL
     AND l.subscriber_id IS NULL AND l.sent_at=d.accepted_at)
    OR (SELECT count(*) FROM public.shrigma_send_log l WHERE l.brand=d.brand AND l.flow='popup'
     AND l.piece='cupom-boas-vindas' AND l.channel='email' AND l.ref=v_ref)<>1 THEN
    RAISE EXCEPTION 'POPUP_RECOVERY_AUDIT_MISMATCH';
   END IF;
   v_result='already_applied';v_log=a.send_log_id;
  ELSE
   IF coalesce(d.transport_state,'') NOT IN ('in_flight','outcome_unknown') OR d.send_log_id IS NOT NULL
    OR d.claim_token IS NULL OR d.started_at IS NULL OR d.started_at>now()-interval '15 minutes'
    OR d.account_id IS DISTINCT FROM '379757086665' OR d.region IS DISTINCT FROM 'us-east-2'
    OR d.configuration_set IS DISTINCT FROM (CASE d.brand WHEN 'fish' THEN 'cs-fishermans-tx' ELSE 'cs-aristocrata-tx' END)
    OR d.payload_sha256 IS NULL THEN RAISE EXCEPTION 'POPUP_RECOVERY_STATE_INVALID';END IF;
   IF EXISTS(SELECT 1 FROM public.shrigma_email_transport_evidence t WHERE t.dispatch_id=p_id) THEN
    RAISE EXCEPTION 'POPUP_RECOVERY_HTTP_EVIDENCE_PRESENT';
   END IF;
   IF EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.brand=d.brand AND l.flow='popup'
    AND l.piece='cupom-boas-vindas' AND l.channel='email' AND l.ref=v_ref) THEN
    RAISE EXCEPTION 'POPUP_RECOVERY_EXISTING_LOG';
   END IF;
   SELECT r.recipient_key,r.key_version INTO STRICT v_recipient,v_key_version FROM public.shrigma_email_recipient_key(v_email) r;
   IF v_recipient IS DISTINCT FROM d.recipient_key OR v_key_version IS DISTINCT FROM d.recipient_key_version THEN
    RAISE EXCEPTION 'POPUP_RECOVERY_RECIPIENT_INVALID';
   END IF;
  END IF;
   -- First application checks every claimed status. Replay checks only its audited proofs,
   -- without demanding fresh events or the currently active HMAC key version.
   FOR e IN SELECT s.*,i.event_payload,i.message_sha256,i.sns_message_id,i.topic_arn,i.result AS ingest_result
    FROM public.shrigma_email_status s JOIN public.shrigma_email_event_ingest i ON i.ingest_id=s.first_ingest_id
    WHERE (a.dispatch_id IS NULL AND (s.dispatch_id_claim=p_id OR s.dispatch_id=p_id))
     OR (a.dispatch_id IS NOT NULL AND s.event_key IN (SELECT x->>'event_key' FROM jsonb_array_elements(a.evidence) x))
    ORDER BY s.event_key FOR SHARE OF s,i NOWAIT
   LOOP
    IF e.status NOT IN ('send','delivery') OR e.status=ANY(v_statuses)
     OR e.reconciliation_status IS DISTINCT FROM 'matched' OR e.dispatch_id IS DISTINCT FROM p_id
     OR e.dispatch_id_claim IS DISTINCT FROM p_id OR e.is_test IS DISTINCT FROM false OR e.is_test_claim IS DISTINCT FROM false
     OR e.account_id IS DISTINCT FROM d.account_id OR e.region IS DISTINCT FROM d.region
     OR e.recipient_key IS DISTINCT FROM d.recipient_key OR e.recipient_key_version IS DISTINCT FROM d.recipient_key_version
     OR e.ingest_result IS DISTINCT FROM 'processed'
     OR e.topic_arn IS DISTINCT FROM 'arn:aws:sns:us-east-2:379757086665:shrigma-ses-events'
     OR e.event_payload->>'eventType' IS DISTINCT FROM (CASE e.status WHEN 'send' THEN 'Send' ELSE 'Delivery' END)
     OR e.event_payload#>>'{mail,sendingAccountId}' IS DISTINCT FROM d.account_id
     OR e.event_payload#>'{mail,tags,crm_dispatch_id}' IS DISTINCT FROM jsonb_build_array(p_id::text)
     OR e.event_payload#>'{mail,tags,crm_test}' IS DISTINCT FROM '["false"]'::jsonb
     OR e.event_payload#>'{mail,tags,ses:configuration-set}' IS DISTINCT FROM jsonb_build_array(d.configuration_set)
     OR e.event_payload#>>'{mail,messageId}' IS DISTINCT FROM e.message_id
     OR e.event_payload#>'{mail,destination}' IS DISTINCT FROM jsonb_build_array(v_email) THEN
     RAISE EXCEPTION 'POPUP_RECOVERY_PROOF_INVALID';
    END IF;
    PERFORM 1 FROM public.shrigma_email_message_link m WHERE m.dispatch_id=p_id
     AND m.account_id=d.account_id AND m.region=d.region AND m.message_id=e.message_id FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'POPUP_RECOVERY_MESSAGE_LINK_INVALID';END IF;
    v_archive_verified=false;
    FOR q IN SELECT * FROM public.shrigma_email_queue_receipt qr WHERE qr.ingest_id=e.first_ingest_id FOR SHARE NOWAIT LOOP
     BEGIN v_envelope=q.body_raw::jsonb;
      IF q.body_sha256=encode(digest(convert_to(q.body_raw,'UTF8'),'sha256'),'hex')
       AND q.body_sha256=e.message_sha256 AND v_envelope->>'TopicArn'=e.topic_arn
       AND v_envelope->>'MessageId'=e.sns_message_id AND (v_envelope->>'Message')::jsonb=e.event_payload THEN
       v_archive_verified=true;
      END IF;
     EXCEPTION WHEN invalid_text_representation THEN NULL;END;
    END LOOP;
    IF NOT v_archive_verified THEN RAISE EXCEPTION 'POPUP_RECOVERY_ARCHIVE_INVALID';END IF;
    IF v_message IS NULL THEN
     v_message=e.message_id;v_at=(e.event_payload#>>'{mail,timestamp}')::timestamptz;
     IF v_message IS NULL OR v_at IS NULL OR v_at<d.started_at OR v_at>d.started_at+interval '15 minutes' OR v_at>now() THEN
      RAISE EXCEPTION 'POPUP_RECOVERY_TIME_INVALID';
     END IF;
    ELSIF e.message_id IS DISTINCT FROM v_message OR (e.event_payload#>>'{mail,timestamp}')::timestamptz IS DISTINCT FROM v_at THEN
     RAISE EXCEPTION 'POPUP_RECOVERY_EVENT_MISMATCH';
    END IF;
    IF e.status='delivery' THEN
     v_delivery=(e.event_payload#>>'{delivery,timestamp}')::timestamptz;
     IF v_delivery IS NULL OR v_delivery<v_at OR v_delivery>now()
      OR e.event_payload#>'{delivery,recipients}' IS DISTINCT FROM jsonb_build_array(v_email) THEN
      RAISE EXCEPTION 'POPUP_RECOVERY_DELIVERY_INVALID';
     END IF;
    END IF;
    v_statuses=array_append(v_statuses,e.status);
    v_evidence=v_evidence||jsonb_build_array(jsonb_build_object('event_key',e.event_key,'status',e.status,
     'ingest_id',e.first_ingest_id,'message_id',e.message_id,'message_sha256',e.message_sha256,
     'send_at',v_at,'delivery_at',CASE WHEN e.status='delivery' THEN v_delivery END));
   END LOOP;
   IF cardinality(v_statuses)<>2 OR NOT (v_statuses @> ARRAY['send','delivery']) OR v_delivery IS NULL
    OR (a.dispatch_id IS NULL AND (SELECT count(*) FROM public.shrigma_email_status s WHERE s.dispatch_id_claim=p_id OR s.dispatch_id=p_id)<>2) THEN
    RAISE EXCEPTION 'POPUP_RECOVERY_SEND_AND_DELIVERY_REQUIRED';
   END IF;
  IF a.dispatch_id IS NOT NULL THEN
   IF v_evidence IS DISTINCT FROM a.evidence THEN RAISE EXCEPTION 'POPUP_RECOVERY_AUDIT_PROOF_MISMATCH';END IF;
  ELSE
   INSERT INTO public.shrigma_send_log(email,brand,kind,flow,channel,piece,ref,sent_at,template_id)
   VALUES(v_email,d.brand,'tx','popup','email','cupom-boas-vindas',v_ref,v_at,NULL) RETURNING id INTO v_log;
   INSERT INTO public.shrigma_email_popup_recovery_v1(dispatch_id,send_log_id,before_state,evidence,reason)
   VALUES(p_id,v_log,to_jsonb(d),v_evidence,'SES_SEND_AND_DELIVERY_HTTP_NOT_CAPTURED');
   UPDATE public.shrigma_email_dispatch x SET transport_state='accepted',accepted_at=v_at,
    outcome_at=clock_timestamp(),send_log_id=v_log,error_code='RECONCILED_SES_DELIVERY_HTTP_NOT_CAPTURED'
   WHERE x.dispatch_id=p_id;
   v_result='reconciled';
   IF p_dry_run THEN RAISE EXCEPTION USING ERRCODE='Z9919',MESSAGE='POPUP_RECOVERY_DRY_RUN_ROLLBACK';END IF;
  END IF;
 EXCEPTION WHEN SQLSTATE 'Z9919' THEN v_result='would_reconcile';v_log=NULL;END;
 RETURN QUERY SELECT v_result,v_log;
END;$f$;
REVOKE ALL ON FUNCTION public.shrigma_email_recover_popup_delivery_v1(uuid,boolean) FROM PUBLIC;
