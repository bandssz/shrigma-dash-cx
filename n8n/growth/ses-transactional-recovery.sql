-- Explicit reconciliation of a transactional send whose HTTP response was lost.
-- Requires archived, matching SES Send AND Delivery. Does not send or retry mail.
-- Template and HTTP response remain unknown; never reconstruct them from current settings.
CREATE TABLE public.shrigma_email_tx_recovery (
 dispatch_id uuid PRIMARY KEY REFERENCES public.shrigma_email_dispatch(dispatch_id),
 send_log_id bigint NOT NULL UNIQUE REFERENCES public.shrigma_send_log(id),
 before_state jsonb NOT NULL,
 evidence jsonb NOT NULL,
 reason text NOT NULL CHECK(reason='SES_SEND_AND_DELIVERY_HTTP_NOT_CAPTURED'),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.shrigma_email_tx_recovery FROM PUBLIC;

CREATE FUNCTION public.shrigma_email_recover_tx_delivery(p_id uuid)
RETURNS TABLE(result text,send_log_id bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE d public.shrigma_email_dispatch%ROWTYPE;a public.shrigma_email_tx_recovery%ROWTYPE;
 e record;v_ref text;v_email text;v_message text;v_at timestamptz;v_delivery timestamptz;
 v_log bigint;v_evidence jsonb='[]'::jsonb;n int=0;v_recipient text;v_version text;
BEGIN
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id;
 -- Keep the same lock order as the reservation functions: advisory, then row.
 PERFORM pg_advisory_xact_lock(hashtextextended('r4-claim:'||d.brand||':transacional:'||d.piece||':'||d.dedupe_key,0));
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
 SELECT * INTO a FROM public.shrigma_email_tx_recovery x WHERE x.dispatch_id=p_id;
 IF FOUND THEN
  IF d.transport_state<>'accepted' OR d.send_log_id IS DISTINCT FROM a.send_log_id
   OR NOT EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.id=a.send_log_id
    AND l.brand=d.brand AND l.flow=d.flow AND l.piece=d.piece AND l.channel='email'
    AND l.ref=d.dedupe_key::jsonb->>1 AND l.template_id IS NULL) THEN
   RAISE EXCEPTION 'TX_RECOVERY_AUDIT_MISMATCH';
  END IF;
  RETURN QUERY SELECT 'already_applied'::text,a.send_log_id;RETURN;
 END IF;
 IF d.brand NOT IN ('fish','aristo') OR d.flow<>'transacional' OR d.is_test
  OR d.transport_state NOT IN ('in_flight','outcome_unknown') OR d.send_log_id IS NOT NULL
  OR d.started_at IS NULL OR d.started_at>now()-interval '15 minutes'
  OR d.piece NOT IN ('pedido-recebido','pedido-confirmado','pedido-preparando','pedido-enviado','pedido-em_rota','pedido-entregue','pedido-cancelado') THEN
  RAISE EXCEPTION 'TX_RECOVERY_SCOPE_INVALID';
 END IF;
 v_ref=d.dedupe_key::jsonb->>1;
 IF coalesce(v_ref,'')='' OR d.dedupe_key<>jsonb_build_array('email',v_ref,0,false)::text THEN
  RAISE EXCEPTION 'TX_RECOVERY_REF_INVALID';
 END IF;
 IF EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.brand=d.brand AND l.flow=d.flow
  AND l.piece=d.piece AND l.ref=v_ref AND l.channel='email' AND coalesce(l.subscriber_id,0)=0) THEN
  RAISE EXCEPTION 'TX_RECOVERY_EXISTING_LOG';
 END IF;
 IF (SELECT count(DISTINCT s.message_id) FROM public.shrigma_email_status s WHERE s.dispatch_id_claim=p_id)<>1
  OR EXISTS(SELECT 1 FROM public.shrigma_email_status s WHERE s.dispatch_id_claim=p_id
   AND (s.reconciliation_status<>'matched' OR s.dispatch_id IS DISTINCT FROM p_id OR s.is_test IS DISTINCT FROM false)) THEN
  RAISE EXCEPTION 'TX_RECOVERY_IDENTITY_CONFLICT';
 END IF;
 FOR e IN
  SELECT s.*,i.event_payload,i.message_sha256,i.sns_message_id,i.topic_arn,i.result AS ingest_result
  FROM public.shrigma_email_status s JOIN public.shrigma_email_event_ingest i ON i.ingest_id=s.first_ingest_id
  WHERE s.dispatch_id=p_id AND s.status IN ('send','delivery') ORDER BY s.status DESC
 LOOP
  IF e.reconciliation_status<>'matched' OR e.dispatch_id_claim IS DISTINCT FROM p_id
   OR e.is_test IS DISTINCT FROM false OR e.is_test_claim IS DISTINCT FROM false
   OR e.account_id<>d.account_id OR e.region<>d.region
   OR e.recipient_key<>d.recipient_key OR e.recipient_key_version<>d.recipient_key_version
   OR e.ingest_result<>'processed' OR e.event_payload->>'eventType' IS DISTINCT FROM (CASE e.status WHEN 'send' THEN 'Send' ELSE 'Delivery' END)
   OR e.event_payload#>>'{mail,sendingAccountId}' IS DISTINCT FROM d.account_id
   OR e.event_payload#>'{mail,tags,crm_dispatch_id}' IS DISTINCT FROM jsonb_build_array(p_id::text)
   OR e.event_payload#>'{mail,tags,crm_test}' IS DISTINCT FROM '["false"]'::jsonb
   OR e.event_payload#>'{mail,tags,ses:configuration-set}' IS DISTINCT FROM jsonb_build_array(d.configuration_set)
   OR e.event_payload#>>'{mail,messageId}' IS DISTINCT FROM e.message_id
   OR jsonb_typeof(e.event_payload#>'{mail,destination}') IS DISTINCT FROM 'array'
   OR jsonb_array_length(e.event_payload#>'{mail,destination}')<>1
   OR NOT EXISTS(SELECT 1 FROM public.shrigma_email_message_link m WHERE m.dispatch_id=p_id
    AND m.account_id=d.account_id AND m.region=d.region AND m.message_id=e.message_id)
   OR NOT EXISTS(SELECT 1 FROM public.shrigma_email_queue_receipt q WHERE q.ingest_id=e.first_ingest_id
    AND q.body_sha256=encode(digest(convert_to(q.body_raw,'UTF8'),'sha256'),'hex')
    AND q.body_raw::jsonb->>'TopicArn'=e.topic_arn AND q.body_raw::jsonb->>'MessageId'=e.sns_message_id
    -- Ingestion fingerprints the complete archived SNS envelope, not only Message.
    AND q.body_sha256=e.message_sha256
    AND (q.body_raw::jsonb->>'Message')::jsonb=e.event_payload) THEN
   RAISE EXCEPTION 'TX_RECOVERY_PROOF_INVALID';
  END IF;
  IF n=0 THEN
   v_message=e.message_id;v_email=e.event_payload#>>'{mail,destination,0}';
   v_at=(e.event_payload#>>'{mail,timestamp}')::timestamptz;
   SELECT r.recipient_key,r.key_version INTO v_recipient,v_version FROM public.shrigma_email_recipient_key(v_email) r;
   IF v_recipient IS DISTINCT FROM d.recipient_key OR v_version IS DISTINCT FROM d.recipient_key_version
    OR v_at IS NULL OR v_at<d.started_at OR v_at>d.started_at+interval '15 minutes' OR v_at>now() THEN
    RAISE EXCEPTION 'TX_RECOVERY_RECIPIENT_OR_TIME_INVALID';
   END IF;
  ELSIF e.message_id<>v_message OR e.event_payload#>>'{mail,destination,0}' IS DISTINCT FROM v_email
   OR (e.event_payload#>>'{mail,timestamp}')::timestamptz IS DISTINCT FROM v_at THEN
   RAISE EXCEPTION 'TX_RECOVERY_EVENT_MISMATCH';
  END IF;
  IF e.status='delivery' THEN
   v_delivery=(e.event_payload#>>'{delivery,timestamp}')::timestamptz;
   IF v_delivery IS NULL OR v_delivery<v_at OR v_delivery>now()
    OR e.event_payload#>'{delivery,recipients}' IS DISTINCT FROM jsonb_build_array(v_email) THEN
    RAISE EXCEPTION 'TX_RECOVERY_DELIVERY_INVALID';
   END IF;
  END IF;
  v_evidence=v_evidence||jsonb_build_array(jsonb_build_object('event_key',e.event_key,'status',e.status,
   'ingest_id',e.first_ingest_id,'message_id',e.message_id,'message_sha256',e.message_sha256));
  n=n+1;
 END LOOP;
 IF n<>2 OR v_delivery IS NULL OR NOT v_evidence @> '[{"status":"send"}]'::jsonb THEN
  RAISE EXCEPTION 'TX_RECOVERY_SEND_AND_DELIVERY_REQUIRED';
 END IF;
 INSERT INTO public.shrigma_send_log(email,brand,kind,flow,channel,piece,ref,sent_at,template_id)
 VALUES(v_email,d.brand,'tx',d.flow,'email',d.piece,v_ref,v_at,NULL) RETURNING id INTO v_log;
 INSERT INTO public.shrigma_email_tx_recovery(dispatch_id,send_log_id,before_state,evidence,reason)
 VALUES(p_id,v_log,to_jsonb(d),v_evidence,'SES_SEND_AND_DELIVERY_HTTP_NOT_CAPTURED');
 UPDATE public.shrigma_email_dispatch x SET transport_state='accepted',accepted_at=v_at,
  outcome_at=clock_timestamp(),send_log_id=v_log,error_code='RECONCILED_SES_DELIVERY_HTTP_NOT_CAPTURED'
 WHERE x.dispatch_id=p_id;
 RETURN QUERY SELECT 'reconciled'::text,v_log;
END;$f$;
REVOKE ALL ON FUNCTION public.shrigma_email_recover_tx_delivery(uuid) FROM PUBLIC;
