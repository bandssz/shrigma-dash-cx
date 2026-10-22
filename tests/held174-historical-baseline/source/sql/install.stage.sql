IF before_state->'exclusionObjects' IS DISTINCT FROM '{"table":null,"helper":null,"immutable":null}'::jsonb THEN
 RAISE EXCEPTION 'PERMANENT_EXCLUSION_OWN_NAME_COLLISION'; END IF;
EXECUTE $fixed_install_objects$-- SOURCE candidate only. Called inside the separately admitted/CAS transaction.
-- This record expresses an irreversible human disposition, never a transport outcome.
CREATE TABLE crm_audience_v2.regular_delivery_permanent_exclusion (
 dispatch_id uuid PRIMARY KEY REFERENCES public.shrigma_email_dispatch(dispatch_id),
 campaign_id integer NOT NULL CHECK(campaign_id=174),
 binding_version integer NOT NULL CHECK(binding_version>0),
 binding_hash text NOT NULL CHECK(binding_hash~'^[0-9a-f]{64}$'),
 subscriber_id integer NOT NULL CHECK(subscriber_id>0),
 dedupe_key text NOT NULL,
 dispatch_snapshot jsonb NOT NULL CHECK(jsonb_typeof(dispatch_snapshot)='object'),
 operation_id uuid NOT NULL UNIQUE,
 disposition text NOT NULL CHECK(disposition='human_permanent_no_resend'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'::uuid),
 CHECK(dedupe_key=jsonb_build_array(campaign_id,binding_version,subscriber_id)::text),
 CHECK((dispatch_snapshot->>'dispatch_id'=dispatch_id::text) IS TRUE),
 CHECK((dispatch_snapshot->>'transport_state'='outcome_unknown') IS TRUE),
 UNIQUE(campaign_id,subscriber_id)
);
REVOKE ALL ON crm_audience_v2.regular_delivery_permanent_exclusion FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.regular_delivery_exclusion_immutable() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $exclusion_immutable$
BEGIN
 RAISE EXCEPTION 'REGULAR_PERMANENT_EXCLUSION_IRREVERSIBLE';
END
$exclusion_immutable$;
REVOKE ALL ON FUNCTION crm_audience_v2.regular_delivery_exclusion_immutable() FROM PUBLIC;
CREATE TRIGGER regular_permanent_exclusion_immutable
 BEFORE UPDATE OR DELETE ON crm_audience_v2.regular_delivery_permanent_exclusion
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.regular_delivery_exclusion_immutable();
CREATE TRIGGER regular_permanent_exclusion_no_truncate
 BEFORE TRUNCATE ON crm_audience_v2.regular_delivery_permanent_exclusion
 FOR EACH STATEMENT EXECUTE FUNCTION crm_audience_v2.regular_delivery_exclusion_immutable();

CREATE FUNCTION crm_audience_v2.regular_delivery_permanently_excluded(did uuid,cid integer)
 RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $permanently_excluded$
 SELECT EXISTS(
  SELECT 1 FROM crm_audience_v2.regular_delivery_permanent_exclusion x
  JOIN public.shrigma_email_dispatch d ON d.dispatch_id=x.dispatch_id
  JOIN crm_audience_v2.regular_delivery_campaign ctl ON ctl.campaign_id=x.campaign_id
  JOIN crm_audience_v2.campaign_binding_effective(x.campaign_id) b ON true
  JOIN public.campaigns c ON c.id=x.campaign_id
  WHERE cid=174 AND did='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'::uuid
   AND x.dispatch_id=did AND x.campaign_id=cid
   AND x.disposition='human_permanent_no_resend'
   AND x.binding_version=b.binding_version AND x.binding_hash=b.binding_hash
   AND ctl.binding_version=x.binding_version AND ctl.binding_hash=x.binding_hash
   AND d.flow='campaign' AND d.brand='fish' AND b.brand='fish'
   AND d.piece='audience-regular-v1:174' AND d.transport_state='outcome_unknown'
   AND d.is_test IS FALSE AND d.dedupe_key=x.dedupe_key
   AND x.dedupe_key=jsonb_build_array(cid,x.binding_version,x.subscriber_id)::text
   AND to_jsonb(d)=x.dispatch_snapshot
   AND c.last_subscriber_id>=x.subscriber_id
   AND ctl.acknowledged_subscriber_id=c.last_subscriber_id
   AND ctl.acknowledged_sent=c.sent
 );
$permanently_excluded$;
REVOKE ALL ON FUNCTION crm_audience_v2.regular_delivery_permanently_excluded(uuid,integer) FROM PUBLIC;
$fixed_install_objects$;
EXECUTE $fixed_install_claim$CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_claim(
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
$fixed_install_claim$;
EXECUTE $fixed_install_recover$CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_recover(cid integer,sid integer,did uuid,dry_run boolean DEFAULT true)
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
   IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_permanent_exclusion x
     WHERE x.dispatch_id=did OR x.campaign_id=cid AND x.subscriber_id=sid) THEN
    RAISE EXCEPTION 'REGULAR_PERMANENT_EXCLUSION_RECOVERY_FORBIDDEN';
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
$fixed_install_recover$;
EXECUTE $fixed_install_guard$CREATE OR REPLACE FUNCTION crm_audience_v2.campaign_send_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE brand text;ctl crm_audience_v2.regular_delivery_campaign%ROWTYPE;
 deployment crm_audience_v2.regular_worker_deployment%ROWTYPE;lease crm_audience_v2.regular_worker_lease%ROWTYPE;
 ctx jsonb;at timestamptz;
 progress text[]:=ARRAY['status','sent','to_send','max_subscriber_id','last_subscriber_id','started_at','updated_at'];
 BEGIN
  SELECT b.brand INTO brand FROM crm_audience_v2.campaign_binding_effective(OLD.id) b;
  IF NOT FOUND THEN
   IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding WHERE campaign_id=OLD.id) THEN
    RAISE EXCEPTION 'SEGMENT_CAMPAIGN_HISTORY_RETAINED';
   END IF;
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id
   OR NEW.type::text IS DISTINCT FROM 'regular' OR NEW.messenger IS DISTINCT FROM 'email'
   OR NEW.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
   OR NEW.attribs#>>'{crm,brand}' IS DISTINCT FROM brand THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_REQUIRED';
  END IF;
  -- Preserve draft editing under the existing campaign editor guard. A change
  -- invalidates any previously captured material; it never refreshes approval.
  IF OLD.status::text='draft' AND NEW.status::text='draft' THEN
   IF NEW.sent IS DISTINCT FROM 0 OR NEW.started_at IS NOT NULL
    OR NEW.last_subscriber_id IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_REQUIRED'; END IF;
   RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-progress) IS DISTINCT FROM (to_jsonb(OLD)-progress) THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_MATERIAL_LOCKED';
  END IF;
  IF OLD.status::text='draft' AND NEW.status::text='cancelled'
   AND (to_jsonb(NEW)-ARRAY['status','updated_at'])=(to_jsonb(OLD)-ARRAY['status','updated_at'])
   AND EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 a JOIN public.crm_ab_experiment_v2 x ON x.test_id=a.test_id
    JOIN crm_audience_v2.ab_regular_lifecycle_intent i ON i.test_id=x.test_id AND i.version=x.version
    WHERE a.campaign_id=OLD.id AND x.state='prepared' AND i.action='cancel' AND i.created_xid=pg_current_xact_id()) THEN RETURN NEW; END IF;
  -- Halt is always possible, including when source, lease or control is lost.
  -- It cannot acknowledge recipients or alter count/max/start metadata.
  IF OLD.status::text IN('scheduled','running','paused') AND NEW.status::text IN('paused','cancelled')
   AND (to_jsonb(NEW)-ARRAY['status','updated_at'])=(to_jsonb(OLD)-ARRAY['status','updated_at']) THEN
   UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=OLD.id;
   RETURN NEW;
  END IF;
  SELECT * INTO ctl FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=OLD.id;
  IF NOT FOUND OR NEW.sent IS DISTINCT FROM ctl.acknowledged_sent
   OR NEW.last_subscriber_id IS DISTINCT FROM ctl.acknowledged_subscriber_id THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_RECEIPT_REQUIRED';
  END IF;
  -- Only private claim/finish/recovery can move that checkpoint. Legacy batch
  -- and cleanup updates cannot create progress by assigning native counters.
  -- Record completed history even after OFF/pause without creating authority.
  IF NEW.status=OLD.status AND NEW.to_send IS NOT DISTINCT FROM OLD.to_send
   AND NEW.max_subscriber_id IS NOT DISTINCT FROM OLD.max_subscriber_id
   AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at THEN RETURN NEW; END IF;
  IF NOT ctl.enabled OR ctl.suspended OR ctl.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(OLD.id)
   OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_effective(OLD.id) b
    WHERE b.binding_version=ctl.binding_version AND b.binding_hash=ctl.binding_hash) THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_UNAVAILABLE';
  END IF;
  -- Do not acquire deployment/lease row locks after the native campaign lock.
  -- The admission and SMTP paths own their stronger, ordered transaction locks.
  -- This trigger checks lifecycle state; it never authorizes transport.
  SELECT * INTO deployment FROM crm_audience_v2.regular_worker_deployment WHERE singleton;
  SELECT * INTO lease FROM crm_audience_v2.regular_worker_lease WHERE singleton;
  at:=clock_timestamp();
  IF deployment.singleton IS NULL OR NOT deployment.enabled OR deployment.approved_at>at
   OR deployment.worker_sha256 IS DISTINCT FROM ctl.worker_sha256
   OR deployment.runtime_sha256 IS DISTINCT FROM ctl.runtime_sha256
   OR lease.instance_id IS NULL OR lease.suspended OR lease.heartbeat_at>at OR lease.expires_at<=at
   OR lease.worker_sha256 IS DISTINCT FROM ctl.worker_sha256 OR lease.runtime_sha256 IS DISTINCT FROM ctl.runtime_sha256
   OR lease.database_role IS DISTINCT FROM deployment.database_role THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_WORKER_UNAVAILABLE';
  END IF;
  ctx:=crm_audience_v2.selection_worker_context(OLD.id);
  IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_UNAVAILABLE'; END IF;
  IF OLD.status::text='draft' AND NEW.status::text='scheduled'
   AND NEW.sent=0 AND NEW.last_subscriber_id=0 AND NEW.started_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.status::text IN('scheduled','running') AND NEW.status::text='running' AND OLD.send_at<=at THEN RETURN NEW; END IF;
  IF OLD.status::text='paused' AND NEW.status::text='scheduled' THEN RETURN NEW; END IF;
  IF OLD.status::text='running' AND NEW.status::text='finished' THEN
   IF EXISTS(SELECT 1 FROM public.shrigma_email_dispatch d WHERE d.flow='campaign'
    AND d.piece='audience-regular-v1:'||OLD.id::text AND d.transport_state IN('in_flight','outcome_unknown')
    AND NOT crm_audience_v2.regular_delivery_permanently_excluded(d.dispatch_id,OLD.id))
    OR EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.list_id=(ctx->>'base_list_id')::integer
     AND sl.subscriber_id>NEW.last_subscriber_id AND sl.subscriber_id<=NEW.max_subscriber_id
     AND crm_audience_v2.selection_regular_matches(ctx,sl.subscriber_id)) THEN
    RAISE EXCEPTION 'SEGMENT_CAMPAIGN_FINALIZE_UNAVAILABLE';
   END IF;
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_REQUIRED';
 END
 $fn$;
$fixed_install_guard$;
