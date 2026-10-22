CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_recover(cid integer,sid integer,did uuid,dry_run boolean DEFAULT true)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE c public.campaigns%ROWTYPE;ctl crm_audience_v2.regular_delivery_campaign%ROWTYPE;
 d public.shrigma_email_dispatch%ROWTYPE;a crm_audience_v2.regular_delivery_recovery%ROWTYPE;
 e record;q record;envelope jsonb;verified boolean;recipient text;key text;key_version text;
 message text;sent_at timestamptz;delivered_at timestamptz;statuses text[]='{}';evidence jsonb='[]';
 result text;
 BEGIN
  IF cid IS NULL OR sid IS NULL OR did IS NULL OR dry_run IS NULL
   OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_RECOVERY_BOUNDARY';
  END IF;
  BEGIN
   PERFORM crm_audience_v2.ab_regular_fence(cid,sid);
   SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
   SELECT * INTO STRICT ctl FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
   SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=did FOR UPDATE;
   IF d.flow IS DISTINCT FROM 'campaign' OR d.brand NOT IN('fish','aristo') OR d.brand IS NULL
    OR d.brand IS DISTINCT FROM c.attribs#>>'{crm,brand}'
    OR d.piece IS DISTINCT FROM 'audience-regular-v1:'||cid::text
    OR d.dedupe_key IS DISTINCT FROM jsonb_build_array(cid,ctl.binding_version,sid)::text
    OR d.is_test IS DISTINCT FROM false OR d.claim_token IS NULL THEN
    RAISE EXCEPTION 'SEGMENT_RECOVERY_SCOPE';
   END IF;
   SELECT * INTO a FROM crm_audience_v2.regular_delivery_recovery WHERE dispatch_id=did;
   IF FOUND THEN
    IF a.campaign_id IS DISTINCT FROM cid OR a.subscriber_id IS DISTINCT FROM sid
     OR d.transport_state IS DISTINCT FROM 'accepted' OR c.last_subscriber_id<sid
     OR d.error_code IS DISTINCT FROM 'REGULAR_RECONCILED_SES_DELIVERY'
     OR d.accepted_at IS DISTINCT FROM (a.evidence->0->>'send_at')::timestamptz
     OR (to_jsonb(d)-ARRAY['transport_state','outcome_at','accepted_at','error_code'])
      IS DISTINCT FROM (a.before_state-ARRAY['transport_state','outcome_at','accepted_at','error_code']) THEN
     RAISE EXCEPTION 'SEGMENT_RECOVERY_AUDIT_DRIFT';
    END IF;
   ELSIF d.transport_state NOT IN('in_flight','outcome_unknown') OR d.transport_state IS NULL
    OR d.started_at IS NULL OR d.started_at>clock_timestamp()-interval '15 minutes'
    OR d.send_log_id IS NOT NULL OR d.payload_sha256 !~ '^[0-9a-f]{64}$' OR d.payload_sha256 IS NULL
    OR d.account_id IS DISTINCT FROM ctl.account_id OR d.region IS DISTINCT FROM ctl.region
    OR d.configuration_set IS DISTINCT FROM ctl.configuration_set
    OR c.last_subscriber_id>=sid THEN
    RAISE EXCEPTION 'SEGMENT_RECOVERY_STATE';
   END IF;
   -- Lock and check the ingest, normalized event and original archived SNS body.
   -- Other event types are allowed, but conflicts and multiple message identities
   -- attached to this dispatch are never ignored on first reconciliation.
   IF a.dispatch_id IS NULL AND EXISTS(SELECT 1 FROM public.shrigma_email_status s
    WHERE (s.dispatch_id=did OR s.dispatch_id_claim=did)
     AND (s.reconciliation_status IS DISTINCT FROM 'matched' OR s.dispatch_id IS DISTINCT FROM did
      OR s.dispatch_id_claim IS DISTINCT FROM did OR s.is_test IS DISTINCT FROM false OR s.is_test_claim IS DISTINCT FROM false)) THEN
    RAISE EXCEPTION 'SEGMENT_RECOVERY_CONFLICT';
   END IF;
   FOR e IN SELECT s.*,i.event_payload,i.message_sha256,i.sns_message_id,i.topic_arn,i.result AS ingest_result
    FROM public.shrigma_email_status s JOIN public.shrigma_email_event_ingest i ON i.ingest_id=s.first_ingest_id
    WHERE (a.dispatch_id IS NULL AND (s.dispatch_id=did OR s.dispatch_id_claim=did) AND s.status IN('send','delivery'))
     OR (a.dispatch_id IS NOT NULL AND s.event_key IN(SELECT value->>'event_key' FROM jsonb_array_elements(a.evidence)))
    ORDER BY s.event_key FOR SHARE OF s,i NOWAIT
   LOOP
    IF e.status NOT IN('send','delivery') OR e.status=ANY(statuses)
     OR e.reconciliation_status IS DISTINCT FROM 'matched' OR e.dispatch_id IS DISTINCT FROM did OR e.dispatch_id_claim IS DISTINCT FROM did
     OR e.is_test IS DISTINCT FROM false OR e.is_test_claim IS DISTINCT FROM false
     OR e.account_id IS DISTINCT FROM d.account_id OR e.region IS DISTINCT FROM d.region
     OR e.recipient_key IS DISTINCT FROM d.recipient_key OR e.recipient_key_version IS DISTINCT FROM d.recipient_key_version
     OR e.ingest_result IS DISTINCT FROM 'processed'
     OR e.topic_arn IS DISTINCT FROM 'arn:aws:sns:'||d.region||':'||d.account_id||':shrigma-ses-events'
     OR e.event_payload->>'eventType' IS DISTINCT FROM (CASE e.status WHEN 'send' THEN 'Send' ELSE 'Delivery' END)
     OR e.event_payload#>>'{mail,sendingAccountId}' IS DISTINCT FROM d.account_id
     OR e.event_payload#>'{mail,tags,crm_dispatch_id}' IS DISTINCT FROM jsonb_build_array(did::text)
     OR e.event_payload#>'{mail,tags,crm_test}' IS DISTINCT FROM '["false"]'::jsonb
     OR e.event_payload#>'{mail,tags,ses:configuration-set}' IS DISTINCT FROM jsonb_build_array(d.configuration_set)
     OR e.event_payload#>>'{mail,messageId}' IS DISTINCT FROM e.message_id
     OR jsonb_typeof(e.event_payload#>'{mail,destination}') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'SEGMENT_RECOVERY_PROOF';
    END IF;
    IF jsonb_array_length(e.event_payload#>'{mail,destination}')<>1 THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_RECIPIENT'; END IF;
    IF recipient IS NULL THEN
     recipient:=e.event_payload#>>'{mail,destination,0}';
     IF recipient IS NULL OR recipient='' OR recipient<>btrim(recipient) THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_RECIPIENT'; END IF;
     IF a.dispatch_id IS NULL THEN
      SELECT r.recipient_key,r.key_version INTO STRICT key,key_version FROM public.shrigma_email_recipient_key(recipient) r;
      IF key IS DISTINCT FROM d.recipient_key OR key_version IS DISTINCT FROM d.recipient_key_version THEN
       RAISE EXCEPTION 'SEGMENT_RECOVERY_RECIPIENT';
      END IF;
     END IF;
    ELSIF e.event_payload#>'{mail,destination}' IS DISTINCT FROM jsonb_build_array(recipient) THEN
     RAISE EXCEPTION 'SEGMENT_RECOVERY_RECIPIENT';
    END IF;
    PERFORM 1 FROM public.shrigma_email_message_link m WHERE m.dispatch_id=did
     AND m.account_id=d.account_id AND m.region=d.region AND m.message_id=e.message_id FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_MESSAGE_LINK'; END IF;
    verified:=false;
    FOR q IN SELECT * FROM public.shrigma_email_queue_receipt WHERE ingest_id=e.first_ingest_id FOR SHARE NOWAIT LOOP
     BEGIN
      envelope:=q.body_raw::jsonb;
      IF q.body_sha256=encode(public.digest(convert_to(q.body_raw,'UTF8'),'sha256'),'hex')
       AND q.body_sha256=e.message_sha256 AND envelope->>'TopicArn'=e.topic_arn
       AND envelope->>'MessageId'=e.sns_message_id AND (envelope->>'Message')::jsonb=e.event_payload THEN
       verified:=true;
      END IF;
     EXCEPTION WHEN invalid_text_representation THEN NULL; END;
    END LOOP;
    IF NOT verified THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_ARCHIVE'; END IF;
    IF message IS NULL THEN
     message:=e.message_id;sent_at:=(e.event_payload#>>'{mail,timestamp}')::timestamptz;
     IF message IS NULL OR sent_at IS NULL OR sent_at<d.started_at OR sent_at>d.started_at+interval '5 minutes'
      OR sent_at>clock_timestamp() THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_TIME'; END IF;
    ELSIF e.message_id IS DISTINCT FROM message OR (e.event_payload#>>'{mail,timestamp}')::timestamptz IS DISTINCT FROM sent_at THEN
     RAISE EXCEPTION 'SEGMENT_RECOVERY_MESSAGE_CONFLICT';
    END IF;
    IF e.status='delivery' THEN
     delivered_at:=(e.event_payload#>>'{delivery,timestamp}')::timestamptz;
     IF delivered_at IS NULL OR delivered_at<sent_at OR delivered_at>clock_timestamp()
      OR e.event_payload#>'{delivery,recipients}' IS DISTINCT FROM jsonb_build_array(recipient) THEN
      RAISE EXCEPTION 'SEGMENT_RECOVERY_DELIVERY';
     END IF;
    END IF;
    statuses:=array_append(statuses,e.status);
    evidence:=evidence||jsonb_build_array(jsonb_build_object('event_key',e.event_key,'status',e.status,
     'ingest_id',e.first_ingest_id,'message_id',e.message_id,'message_sha256',e.message_sha256,
     'send_at',sent_at,'delivery_at',CASE WHEN e.status='delivery' THEN delivered_at END));
   END LOOP;
   IF cardinality(statuses)<>2 OR NOT statuses @> ARRAY['send','delivery'] OR delivered_at IS NULL THEN
    RAISE EXCEPTION 'SEGMENT_RECOVERY_SEND_AND_DELIVERY_REQUIRED';
   END IF;
   IF a.dispatch_id IS NOT NULL THEN
    IF evidence IS DISTINCT FROM a.evidence THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_AUDIT_PROOF_DRIFT'; END IF;
    result:='already_reconciled';
   ELSE
    IF EXISTS(SELECT 1 FROM public.shrigma_email_status s WHERE (s.dispatch_id=did OR s.dispatch_id_claim=did)
     AND s.message_id IS DISTINCT FROM message) THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_MESSAGE_CONFLICT'; END IF;
    INSERT INTO crm_audience_v2.regular_delivery_recovery(dispatch_id,campaign_id,subscriber_id,before_state,evidence)
     VALUES(did,cid,sid,to_jsonb(d),evidence);
    UPDATE public.shrigma_email_dispatch SET transport_state='accepted',accepted_at=sent_at,
     outcome_at=clock_timestamp(),error_code='REGULAR_RECONCILED_SES_DELIVERY' WHERE dispatch_id=did;
    IF c.sent IS DISTINCT FROM ctl.acknowledged_sent OR c.last_subscriber_id IS DISTINCT FROM ctl.acknowledged_subscriber_id THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_PROGRESS'; END IF;
    UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=c.sent+1,acknowledged_subscriber_id=sid WHERE campaign_id=cid;
    UPDATE public.campaigns SET sent=sent+1,last_subscriber_id=sid,updated_at=clock_timestamp() WHERE id=cid;
    UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=cid;
    result:='reconciled';
    IF dry_run THEN RAISE EXCEPTION USING ERRCODE='Z9918',MESSAGE='SEGMENT_RECOVERY_DRY_ROLLBACK'; END IF;
   END IF;
  EXCEPTION WHEN SQLSTATE 'Z9918' THEN result:='would_reconcile'; END;
  RETURN jsonb_build_object('dispatch_id',did,'result',result,'authorizes_send',false,'authorizes_resume',false);
 END
$fn$;
