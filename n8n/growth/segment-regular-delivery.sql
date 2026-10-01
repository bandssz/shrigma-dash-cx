-- PRIVATE CANDIDATE ONLY. Install in a disposable fixture, never independently
-- activate. The existing production draft-only guard is deliberately untouched.
-- No activation API or grants are supplied. The reviewed scheduler/worker must
-- still establish material/runtime/role admission before these pins can be used.
DO $install$
BEGIN
 IF to_regprocedure('crm_audience_v2.selection_worker_context(integer)') IS NULL
 OR to_regclass('public.shrigma_email_dispatch') IS NULL
 OR to_regprocedure('public.shrigma_email_recipient_key(text)') IS NULL
 OR to_regclass('crm_audience_v2.regular_delivery_campaign') IS NOT NULL THEN
  RAISE EXCEPTION 'SEGMENT_REGULAR_DELIVERY_DEPENDENCY_OR_COLLISION';
 END IF;
END $install$;

CREATE TABLE crm_audience_v2.regular_delivery_campaign (
 campaign_id integer PRIMARY KEY REFERENCES public.campaigns(id),
 binding_version integer NOT NULL CHECK(binding_version>0),
 binding_hash text NOT NULL CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
 material jsonb NOT NULL CHECK(jsonb_typeof(material)='object'),
 worker_sha256 text NOT NULL CHECK(worker_sha256 ~ '^[0-9a-f]{64}$'),
 runtime_sha256 text NOT NULL CHECK(runtime_sha256 ~ '^[0-9a-f]{64}$'),
 envelope_from text NOT NULL CHECK(length(envelope_from)>3),
 account_id text NOT NULL CHECK(account_id ~ '^[0-9]{12}$'),
 region text NOT NULL CHECK(length(region)>0),
 configuration_set text NOT NULL CHECK(length(configuration_set)>0),
 acknowledged_sent integer NOT NULL DEFAULT 0 CHECK(acknowledged_sent>=0),
 acknowledged_subscriber_id integer NOT NULL DEFAULT 0 CHECK(acknowledged_subscriber_id>=0),
 enabled boolean NOT NULL DEFAULT false,
 suspended boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON crm_audience_v2.regular_delivery_campaign FROM PUBLIC;

-- Same declared snapshot as ab-audience-material.normalize().snapshot, without
-- the seven native progress fields. Admission must use the existing strict
-- parser/contract; this equality check is not a substitute for that admission.
CREATE FUNCTION crm_audience_v2.regular_delivery_material(cid integer) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog SET TimeZone='UTC' AS $fn$
 SELECT jsonb_build_object(
  'campaign',to_jsonb(c)-ARRAY['status','sent','to_send','max_subscriber_id','last_subscriber_id','started_at','updated_at'],
  'template',to_jsonb(t),
  'lists',coalesce((SELECT jsonb_agg(jsonb_build_object('relation',to_jsonb(cl),'list',to_jsonb(l)) ORDER BY cl.list_id)
   FROM public.campaign_lists cl LEFT JOIN public.lists l ON l.id=cl.list_id WHERE cl.campaign_id=c.id),'[]'::jsonb),
  'media',coalesce((SELECT jsonb_agg(jsonb_build_object('relation',to_jsonb(cm),'media',to_jsonb(m)) ORDER BY cm.media_id)
   FROM public.campaign_media cm LEFT JOIN public.media m ON m.id=cm.media_id WHERE cm.campaign_id=c.id),'[]'::jsonb))
 FROM public.campaigns c LEFT JOIN public.templates t ON t.id=c.template_id WHERE c.id=cid
$fn$;

-- Called by the native guarded SMTP callback only after a connection and the
-- final immutable bytes exist. A confirmed reply is required before MAIL.
-- SQL response loss never permits transport or a new claim identity.
CREATE FUNCTION crm_audience_v2.regular_delivery_claim(
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
  SELECT * INTO d FROM public.shrigma_email_dispatch x
   WHERE x.brand=b.brand AND x.flow='campaign' AND x.piece=piece AND x.dedupe_key=k FOR UPDATE;
  IF FOUND THEN
   RETURN jsonb_build_object('should_send',false,'reason',d.transport_state,'dispatch_id',d.dispatch_id,'claim_token',NULL);
  END IF;
  IF EXISTS(SELECT 1 FROM public.shrigma_email_dispatch x WHERE x.brand=b.brand
   AND x.flow='campaign' AND x.piece=piece AND x.transport_state IN('in_flight','outcome_unknown')) THEN
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
  SELECT least(cfg.expires_at,rt.verified_at+interval '5 minutes') INTO valid_until
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

-- Record what actually happened even if paused/OFF/revoked after claim. This
-- never grants another attempt; unknown is irreversible without reconciliation.
CREATE FUNCTION crm_audience_v2.regular_delivery_finish(cid integer,sid integer,did uuid,token uuid,outcome text)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE c public.campaigns%ROWTYPE;e crm_audience_v2.regular_delivery_campaign%ROWTYPE;d public.shrigma_email_dispatch%ROWTYPE;
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_BOUNDARY';
  END IF;
  IF outcome IS NULL OR outcome NOT IN('accepted','outcome_unknown') OR token IS NULL THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_FINISH_INPUT'; END IF;
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
  SELECT * INTO STRICT e FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
  SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=did FOR UPDATE;
  IF d.claim_token IS DISTINCT FROM token OR d.flow<>'campaign' OR d.brand IS DISTINCT FROM c.attribs#>>'{crm,brand}'
   OR d.piece IS DISTINCT FROM 'audience-regular-v1:'||cid::text
   OR d.dedupe_key IS DISTINCT FROM jsonb_build_array(cid,e.binding_version,sid)::text OR d.is_test THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_FINISH_MISMATCH';
  END IF;
  IF d.transport_state<>'in_flight' THEN
   IF d.transport_state IS DISTINCT FROM outcome THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_OUTCOME_CONFLICT'; END IF;
   RETURN jsonb_build_object('dispatch_id',did,'outcome',d.transport_state);
  END IF;
  UPDATE public.shrigma_email_dispatch SET transport_state=outcome,outcome_at=clock_timestamp(),
   accepted_at=CASE WHEN outcome='accepted' THEN clock_timestamp() END,
   error_code=CASE WHEN outcome='outcome_unknown' THEN 'NATIVE_REGULAR_OUTCOME_UNKNOWN' END WHERE dispatch_id=did;
  IF outcome='accepted' THEN
   IF c.last_subscriber_id>=sid THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_FINISH_CURSOR'; END IF;
   IF c.sent IS DISTINCT FROM e.acknowledged_sent OR c.last_subscriber_id IS DISTINCT FROM e.acknowledged_subscriber_id THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_FINISH_PROGRESS'; END IF;
   UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=c.sent+1,acknowledged_subscriber_id=sid WHERE campaign_id=cid;
   UPDATE public.campaigns SET sent=sent+1,last_subscriber_id=sid,updated_at=clock_timestamp() WHERE id=cid;
  ELSE
   UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=cid;
  END IF;
  RETURN jsonb_build_object('dispatch_id',did,'outcome',outcome);
 END
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.regular_delivery_material(integer),
 crm_audience_v2.regular_delivery_claim(integer,integer,uuid,text,text,text,text,text,jsonb),
 crm_audience_v2.regular_delivery_finish(integer,integer,uuid,uuid,text) FROM PUBLIC;

-- Isolate expected per-campaign failures before the shared native scan. An
-- unavailable source never becomes a zero recipient count, nor may it keep
-- unrelated legacy campaigns from being scanned forever. Active local pipes
-- handle their own errors; a row busy in another claim is left for that owner.
CREATE FUNCTION crm_audience_v2.regular_delivery_quarantine(current_ids integer[])
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
 SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE cid integer;e crm_audience_v2.regular_delivery_campaign%ROWTYPE;ctx jsonb;
 reason text;result jsonb:='[]'::jsonb;
 BEGIN
  IF current_ids IS NULL OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_QUARANTINE_BOUNDARY';
  END IF;
  FOR cid IN SELECT c.id FROM public.campaigns c
   JOIN LATERAL crm_audience_v2.campaign_binding_effective(c.id) b ON true
   WHERE NOT(c.id=ANY(current_ids))
    AND (c.status::text='running' OR (c.status::text='scheduled' AND c.send_at<=clock_timestamp()))
   ORDER BY c.id FOR UPDATE OF c SKIP LOCKED
  LOOP
   reason:=NULL;
   SELECT * INTO e FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
   IF NOT FOUND OR NOT e.enabled OR e.suspended THEN
    reason:='control_unavailable';
   ELSE
    BEGIN
     ctx:=crm_audience_v2.selection_worker_context(cid);
     IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb
      OR e.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(cid) THEN
      reason:='material_unavailable';
     END IF;
    EXCEPTION WHEN SQLSTATE '55000' THEN reason:='source_unavailable'; END;
   END IF;
   IF reason IS NOT NULL THEN
    UPDATE public.campaigns SET status='paused',updated_at=clock_timestamp() WHERE id=cid;
    UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=cid;
    result:=result||jsonb_build_array(jsonb_build_object('campaign_id',cid,'reason',reason));
   END IF;
  END LOOP;
  RETURN result;
 END
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.regular_delivery_quarantine(integer[]) FROM PUBLIC;
